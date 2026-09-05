// AI Hero Builder assist: turn a one-line hero description into a full build — stats within the
// player's point budget, a weapon, a trait, name/title/motto, and an 8x8 pixel sprite — modelled on
// server/ai/levelgen.js's "call Claude with json_schema structured output, repair/validate, fall
// back deterministically when unavailable or invalid" pipeline. `getClient`/`aiAvailable` are
// imported from levelgen.js rather than re-implemented, so both AI features share one credential
// gate and one Anthropic client instance.
//
// Unlike levelgen's procedural fallback (which still runs the seeded generator), the fallback here
// never calls a generator at all: it deterministically picks one of shared/hero-builder.js's three
// presetHeroes(), keyed by a hash of the prompt, so the same description always suggests the same
// preset when no AI is available (or the AI's result didn't validate) — see test/herogen.test.js
// "preset fallback determinism".
import Anthropic from '@anthropic-ai/sdk';
import { getClient, aiAvailable } from './levelgen.js';
import {
  STATS, PALETTE, WEAPONS, TRAITS, budgetFor, unlockedBuilderItems, validateHero, presetHeroes,
} from '../../shared/hero-builder.js';
import { hashSeed } from '../../shared/rng.js';

export { aiAvailable };

const MODEL = process.env.GAUNTLET_AI_MODEL || 'claude-opus-5';
// See server/ai/levelgen.js's AI_TIMEOUT_MS comment: the SDK's default (10 minutes, retried) is far
// too long to hold an HTTP request open on -- fall back to the deterministic preset instead.
const AI_TIMEOUT_MS = 30_000;
const MAX_PROMPT = 300;
const PIXEL_ROW_RE = /^[.0-7]{8}$/;
const NAME_RE = /^[A-Za-z0-9 ]{2,12}$/;

// A plain, unmistakably humanoid 8x8 silhouette (two colors only) used whenever the model's pixel
// art is missing/malformed — never rejected outright, always coerced into something valid instead.
const DEFAULT_PIXELS = [
  '..2222..',
  '.222222.',
  '..2222..',
  '.222222.',
  '2222222.',
  '.222222.',
  '..22.22.',
  '..00.00.',
];

function buildSystem(budget, weaponIds, traitIds) {
  const weaponLines = weaponIds.map((id) => `  ${id}: ${WEAPONS[id].desc}`).join('\n');
  const traitLines = traitIds.length
    ? traitIds.map((id) => `  ${id}: ${TRAITS[id].desc}`).join('\n')
    : '  (none unlocked yet — omit the trait field)';
  const paletteLines = PALETTE.map((hex, i) => `  ${i}: ${hex}`).join('\n');
  return `You design a custom hero for a Gauntlet (1985 arcade) style top-down dungeon crawler for 1-4 players.
A hero has six stats, each a whole number "notch" from 0 to 5:
  speed: movement speed. shot: shot damage. fireRate: attacks per second (higher notch = faster shots).
  armor: damage reduction. magic: potion power. health: bonus max health.
The six notches added together must be AT MOST ${budget} (the player's current point-buy budget) — you may leave some unspent, never exceed it. Spend more notches on stats the request emphasizes.
Weapon — pick exactly one id:
${weaponLines}
Trait — pick at most one id, or omit it entirely for no trait:
${traitLines}
name: 2-12 characters, letters/digits/spaces only, no punctuation.
title: short epithet shown under the name in-game, at most 16 characters.
motto: one flavorful sentence, at most 60 characters.
pixels: exactly 8 rows of exactly 8 characters each, top row first. Each character is '.' (transparent) or a digit '0'-'7' selecting this fixed palette:
${paletteLines}
Paint a small heroic figure readable at 32x32px: a simple humanoid silhouette using 2-4 of the palette colors, left-right symmetric, at least 8 painted (non-'.') pixels. Reserve color 0 (black) for outline/boot details only, never as the main body color.`;
}

function schemaFor(weaponIds) {
  return {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Hero name, 2-12 characters, letters/digits/spaces only' },
      title: { type: 'string', description: 'Short title shown under the name in-game (max 16 chars)' },
      motto: { type: 'string', description: 'One-sentence flavor line (max 60 chars)' },
      stats: {
        type: 'object',
        properties: Object.fromEntries(STATS.map((k) => [k, { type: 'integer', minimum: 0, maximum: 5 }])),
        required: [...STATS],
        additionalProperties: false,
      },
      weapon: { type: 'string', enum: [...weaponIds] },
      trait: { type: 'string', description: 'One trait id from the system prompt list, or omit for none' },
      pixels: {
        type: 'array', minItems: 8, maxItems: 8,
        items: { type: 'string', pattern: '^[.0-7]{8}$' },
        description: '8 rows of 8 characters, top to bottom',
      },
    },
    required: ['name', 'stats', 'weapon', 'pixels'],
    additionalProperties: false,
  };
}

function sanitizeName(name) {
  const cleaned = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const candidate = cleaned.slice(0, 12);
  return NAME_RE.test(candidate) ? candidate : 'Hero';
}
function sanitizeShort(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Round/clamp every stat to 0-5, then deterministically trim the largest stat(s) down until the
 *  total fits `budget` — never throws, never leaves a stat negative. */
function repairStats(stats, budget) {
  const out = {};
  for (const k of STATS) {
    const n = Math.round(Number(stats?.[k]));
    out[k] = Number.isFinite(n) ? Math.max(0, Math.min(5, n)) : 0;
  }
  let total = STATS.reduce((sum, k) => sum + out[k], 0);
  while (total > budget) {
    let biggest = null;
    for (const k of STATS) if (out[k] > 0 && (biggest === null || out[k] > out[biggest])) biggest = k;
    if (biggest === null) break; // budget is negative or zero and every stat is already 0
    out[biggest] -= 1;
    total -= 1;
  }
  return out;
}

/** Coerce a `pixels` value into 8 valid 8-character rows, replacing only the rows that are
 *  malformed, then falling back to DEFAULT_PIXELS entirely if the result doesn't paint enough. */
function repairPixels(pixels) {
  const rows = Array.isArray(pixels) ? pixels.slice(0, 8) : [];
  const fixed = Array.from({ length: 8 }, (_, i) => (typeof rows[i] === 'string' && PIXEL_ROW_RE.test(rows[i]) ? rows[i] : DEFAULT_PIXELS[i]));
  const painted = fixed.reduce((n, row) => n + [...row].filter((c) => c !== '.').length, 0);
  return painted >= 8 ? fixed : DEFAULT_PIXELS.slice();
}

/** Coerce a raw (possibly malformed, possibly model-generated) hero-shaped object into one that
 *  passes `validateHero` for the given budget/unlocked weapon+trait ids — clamping/trimming stats,
 *  swapping an unknown weapon/trait for an allowed one, and replacing malformed pixel rows.
 *  Exported for test/herogen.test.js; also used internally by generateHeroFromPrompt. */
export function repairHero(raw, { budget, weaponIds, traitIds }) {
  const weapon = weaponIds.includes(raw?.weapon) ? raw.weapon : weaponIds[0];
  const trait = raw?.trait && traitIds.includes(raw.trait) ? raw.trait : null;
  return {
    name: sanitizeName(raw?.name),
    title: sanitizeShort(raw?.title, 16),
    motto: sanitizeShort(raw?.motto, 60),
    stats: repairStats(raw?.stats, budget),
    weapon, trait,
    pixels: repairPixels(raw?.pixels),
  };
}

/** Deterministic, AI-free suggestion: hash the prompt to pick one of the three built-in
 *  `presetHeroes()`, re-clamped to the caller's actual budget/unlocked weapon so it's valid at any
 *  rank (the presets themselves total 12 notches and use only always-unlocked weapons/traits, so
 *  this is a no-op for a fresh rank-3 player). */
function presetFallback(prompt, budget, weaponIds, traitIds, note) {
  const presets = presetHeroes();
  const pick = presets[hashSeed(prompt) % presets.length];
  const hero = {
    name: pick.name, title: pick.title || '', motto: pick.motto || '',
    stats: repairStats(pick.stats, budget),
    weapon: weaponIds.includes(pick.weapon) ? pick.weapon : weaponIds[0],
    trait: pick.trait && traitIds.includes(pick.trait) ? pick.trait : null,
    pixels: pick.pixels.slice(),
  };
  return { hero, source: 'preset', note };
}

/**
 * Generate a Hero Builder build from a text prompt, for a specific owner's rank/achievements
 * (the same profile shape `shared/hero-builder.js`'s `budgetFor`/`unlockedBuilderItems`/
 * `validateHero` take).
 * @returns {Promise<{hero:object, source:'ai'|'preset', note?:string}>}
 */
export async function generateHeroFromPrompt({ prompt, rank, achievements }) {
  const cleanPrompt = String(prompt || '').slice(0, MAX_PROMPT);
  const budget = budgetFor(rank, achievements);
  const { weapons: weaponIds, traits: traitIds } = unlockedBuilderItems(rank, achievements);
  const anthropic = budget > 0 ? getClient() : null;
  if (anthropic) {
    try {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2000,
        system: buildSystem(budget, weaponIds, traitIds),
        messages: [{ role: 'user', content: `Design a hero. Player's request: ${cleanPrompt || 'Surprise me.'}` }],
        output_config: { format: { type: 'json_schema', schema: schemaFor(weaponIds) } },
      }, { timeout: AI_TIMEOUT_MS });
      if (response.stop_reason === 'refusal') {
        return presetFallback(cleanPrompt, budget, weaponIds, traitIds, 'The AI declined this request, so a preset hero was suggested instead.');
      }
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const raw = JSON.parse(text);
      const hero = repairHero(raw, { budget, weaponIds, traitIds });
      const check = validateHero(hero, { rank, achievements });
      if (!check.ok) return presetFallback(cleanPrompt, budget, weaponIds, traitIds, `AI hero failed validation (${check.errors[0]}); preset used instead.`);
      return { hero, source: 'ai' };
    } catch (err) {
      const msg = err instanceof Anthropic.AuthenticationError ? 'AI credentials rejected' :
        err instanceof Anthropic.RateLimitError ? 'AI rate limited' :
        err instanceof Anthropic.APIError ? `AI error ${err.status}` : 'AI unavailable';
      console.warn('[herogen]', msg, err.message);
      return presetFallback(cleanPrompt, budget, weaponIds, traitIds, `${msg}; preset used instead.`);
    }
  }
  const note = budget <= 0
    ? 'Hero Builder unlocks at rank 3; a preset hero was suggested instead.'
    : 'No AI credentials configured (set ANTHROPIC_API_KEY); a preset hero was suggested instead.';
  return presetFallback(cleanPrompt, budget, weaponIds, traitIds, note);
}
