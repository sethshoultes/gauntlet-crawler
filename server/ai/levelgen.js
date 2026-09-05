// AI level builder. Uses Claude (structured JSON output) when credentials are available,
// and falls back to the seeded procedural generator biased by the prompt otherwise.
import Anthropic from '@anthropic-ai/sdk';
import { T } from '../../shared/constants.js';
import { validateLevel, repairLevel, MIN_SIZE, MAX_SIZE } from '../../shared/level.js';
import { generateLevel, biasFromPrompt } from '../../shared/procgen.js';
import { hashSeed } from '../../shared/rng.js';

const MODEL = process.env.GAUNTLET_AI_MODEL || 'claude-opus-5';

let client = null;
function getClient() {
  if (client) return client;
  // The SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile itself.
  // We only gate on the two env vars so a missing profile fails fast into the procedural fallback.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && process.env.GAUNTLET_AI !== '1') return null;
  client = new Anthropic();
  return client;
}

export function aiAvailable() { return getClient() !== null; }
// Exported so server/ai/herogen.js shares this exact credential gate and Anthropic client instance
// instead of re-implementing (and potentially drifting from) the same env-var check.
export { getClient };

const SYSTEM = `You design levels for a Gauntlet (1985 arcade) style top-down dungeon crawler for 1-4 players.
Output a rectangular ASCII map. Every row must have the same length. Size between ${MIN_SIZE}x${MIN_SIZE} and ${MAX_SIZE}x${MAX_SIZE}; 28x22 is a good default.
Tile legend (use ONLY these characters):
  # wall     . floor     D door (locked, opened by a key)   K key
  F food (+100 health)   ! poison food (looks like food, -100 health — use sparingly, it's a trap)
  C cider (+50 health)   P magic potion   T treasure   E exit   8 skip-exit (jumps the party ahead 4 levels; rare, deep levels only)
  S player start (place 2-4 S tiles together)   X transporter (teleports to another X tile; always place exactly 2, or none)
  g grunt generator   h ghost generator   m demon generator   l lobber generator   s sorcerer generator   (generators spawn monsters until destroyed)
  1 ghost   2 grunt   3 demon   4 lobber (keeps its distance, lobs shots over walls)   5 sorcerer (blinks invisible)
  6 thief (steals a key/potion then flees; never placed by a generator)   Z Death (rare, only if asked)   W secret wall (crumbles when touched)
  I invisibility amulet (20s, monsters ignore the holder)   R reflective-shots amulet (20s, shots bounce off a wall once)
  O repulsiveness amulet (20s, pushes monsters away)   U super-shots amulet (20s, shots pierce monsters)
  V permanent speed boost   A permanent armor boost   B permanent shot-power boost   Q permanent shot-speed boost   N permanent magic-power boost
  (amulets/boosts are optional flavor: use at most 0-2 amulets and at most 1 boost tile, only on deeper/harder levels)
Rules: outer border is all #. There must be a walkable path from S to E (or 8) (doors are fine if there is a key before them).
Every door must have at least one key reachable before it. Put 2-6 food, 3-10 treasure, 1-2 potions, 2-8 generators depending on the requested difficulty.
Make rooms and corridors that are fun to fight in: choke points, side rooms with loot, generators guarding treasure.
Keep the map readable, avoid giant open squares, avoid unreachable pockets.`;

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short evocative level name (max 40 chars)' },
    description: { type: 'string', description: 'One sentence shown to players (max 200 chars)' },
    rows: { type: 'array', items: { type: 'string' }, description: 'The map rows, top to bottom, all the same length' },
  },
  required: ['name', 'description', 'rows'],
  additionalProperties: false,
};

/**
 * Generate a level from a text prompt.
 * @returns {Promise<{level:object, source:'ai'|'procedural', problems:string[], note?:string}>}
 */
export async function generateFromPrompt({ prompt, difficulty = 3, size = 'medium' }) {
  const cleanPrompt = String(prompt || '').slice(0, 600);
  const anthropic = getClient();
  if (anthropic) {
    try {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: `Design a level. Difficulty ${difficulty}/10. Size: ${size}.\nDesigner's request: ${cleanPrompt || 'Surprise me.'}`,
        }],
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      });
      if (response.stop_reason === 'refusal') {
        return fallback(cleanPrompt, difficulty, size, 'The AI declined this request, so a procedural level was generated instead.');
      }
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      let raw = JSON.parse(text);
      let problems = validateLevel(raw);
      if (problems.length) {
        raw = repairLevel(raw);
        problems = validateLevel(raw);
      }
      if (problems.length) return fallback(cleanPrompt, difficulty, size, `AI level failed validation (${problems[0]}); procedural fallback used.`);
      return { level: { name: raw.name, description: raw.description, rows: raw.rows }, source: 'ai', problems: [] };
    } catch (err) {
      const msg = err instanceof Anthropic.AuthenticationError ? 'AI credentials rejected' :
        err instanceof Anthropic.RateLimitError ? 'AI rate limited' :
        err instanceof Anthropic.APIError ? `AI error ${err.status}` : 'AI unavailable';
      console.warn('[levelgen]', msg, err.message);
      return fallback(cleanPrompt, difficulty, size, `${msg}; procedural fallback used.`);
    }
  }
  return fallback(cleanPrompt, difficulty, size, 'No AI credentials configured (set ANTHROPIC_API_KEY); procedural generator used.');
}

function fallback(prompt, difficulty, size, note) {
  const bias = biasFromPrompt(prompt);
  if (size === 'small') bias.size = -1; else if (size === 'large') bias.size = 1;
  const level = generateLevel({ seed: hashSeed(prompt + ':' + Date.now()), level: Math.max(1, Math.round(difficulty * 1.5)), bias });
  if (prompt) level.description = `"${prompt.slice(0, 120)}" — ${level.description}`;
  return { level, source: 'procedural', problems: validateLevel(level), note };
}

export { T };
