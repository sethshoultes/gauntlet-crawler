// AI level builder. Uses Claude (structured JSON output) when credentials are available,
// and falls back to the seeded procedural generator biased by the prompt otherwise.
import Anthropic from '@anthropic-ai/sdk';
import { T, GENERATOR_TILES, MONSTER_TILES, EXIT_TILES } from '../../shared/constants.js';
import { validateLevel, repairLevel, parseLevel, MIN_SIZE, MAX_SIZE } from '../../shared/level.js';
import { generateLevel, biasFromPrompt, nameForSeed } from '../../shared/procgen.js';
import { hashSeed } from '../../shared/rng.js';

const MODEL = process.env.GAUNTLET_AI_MODEL || 'claude-opus-5';
// The SDK's own default (10 minutes, and retried) is far too long for a request an HTTP client is
// blocked on -- every call below passes this explicitly so a slow/stuck upstream degrades into the
// procedural fallback instead of holding a request (and its rate-limit slot) open indefinitely.
const AI_TIMEOUT_MS = 30_000;

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
  % & * pressure plates, matched with = + ~ wall groups one-for-one (% opens =, & opens +, * opens ~): stepping
  on a plate dissolves every tile of its matching wall-group glyph anywhere on the map. Optional, rare, deeper
  levels only — use at most one pair, and only if you place at least one tile of the plate AND at least one
  tile of its matching wall glyph (an unmatched wall group can never open).
  ^ timed wall (turns to floor on its own after a countdown)   : timed wall that turns into an exit after a countdown
  (timed walls are optional, rare, deeper levels only — use at most 1-2, and never as the only route to the exit
  since their countdown takes time to fire)
  a acid puddle (damages any hero standing on it every tick; monsters are immune, walkable)
  t stun tile (freezes whoever touches it briefly, then a short immunity window; walkable)
  f force field (blocks shots but not movement — heroes and monsters walk straight through)
  (acid/stun/force-field are optional hazards, deeper levels only — a handful of acid in corridors,
  at most one stun tile, and force fields gating a generator's approach are plenty; never place them
  as the only route to the exit since acid/stun punish standing there, and force fields block nothing
  about movement anyway)
  H hidden exit (renders and behaves exactly like a wall # until revealed — use in place of E for a
  "mystery room")   L switch (a walkable floor tile, a lever: a hero stepping on it reveals every H
  in the level at once)
  (H is only ever revealable if the level also has at least one L switch tile OR at least one T
  treasure tile — collecting every last piece of treasure also reveals every hidden exit. Never use
  H without one of those, and never as the only exit unless that condition holds. Optional, rare,
  used for a deliberate "find the secret way out" room, not a normal level.)
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
        max_tokens: 8000,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: `Design a level. Difficulty ${difficulty}/10. Size: ${size}.\nDesigner's request: ${cleanPrompt || 'Surprise me.'}`,
        }],
        // The response is a bounded JSON map (at most ~64x64 rows); deep reasoning isn't needed
        // and the default effort took ~100s, which is longer than Cloudflare's proxy timeout in
        // front of production. `medium` is markedly faster while still validating cleanly.
        output_config: { format: { type: 'json_schema', schema: SCHEMA }, effort: 'medium' },
      }, { timeout: 150_000 }); // client-side cap: a hung request falls back to the procedural generator below instead of leaking a job forever
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

// ============================================================================================
// #17 AI assist: remix and tune existing levels, explain a level, and name procedural levels.
// Added at the end of the file (rather than interleaved above) to stay out of the way of any
// concurrent edits to generateFromPrompt()/SYSTEM/SCHEMA above.
// ============================================================================================

const REMIX_SCHEMA = SCHEMA; // same shape as generateFromPrompt: {name, description, rows}
const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: { explanation: { type: 'string', description: '3-5 sentences of strategy advice for a party about to play this level' } },
  required: ['explanation'],
  additionalProperties: false,
};
const NAME_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short evocative level name (max 40 chars)' },
    description: { type: 'string', description: 'One sentence shown to players (max 200 chars)' },
  },
  required: ['name', 'description'],
  additionalProperties: false,
};

const GEN_GLYPHS = [T.GEN_GRUNT, T.GEN_GHOST, T.GEN_DEMON, T.GEN_LOBBER, T.GEN_SORCERER];
const MONSTER_GLYPHS = [T.GHOST, T.GRUNT, T.DEMON, T.LOBBER, T.SORCERER];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** Coordinates + original glyph of every start/exit tile in a parsed level — captured before any
 *  AI call or procedural rewrite so they can be forced back afterward, no matter what the rewrite
 *  did elsewhere on the map. Exit glyph is preserved exactly (E vs the skip-exit 8), not
 *  normalized to a plain exit. */
function lockedTiles(parsed) {
  const locks = [];
  for (const [x, y] of parsed.starts) locks.push([x, y, parsed.rows[y][x]]);
  for (const [x, y] of parsed.exits) locks.push([x, y, parsed.rows[y][x]]);
  return locks;
}
/** Strip any start/exit tile that isn't one of the locked coordinates, turning it into floor.
 *  Needed because both generateLevel() (a fresh dungeon has its own S/E) and the AI (which might
 *  ignore the "keep these coordinates" instruction) can otherwise leave a second, unwanted
 *  start/exit behind once we force the original coordinates back — that would validate fine (BFS
 *  only needs *a* start and *an* exit reachable) but silently move where the party actually spawns
 *  or which exit tile they need to reach. */
function forceLocked(rows, locks) {
  const keep = new Set(locks.map(([x, y]) => `${x},${y}`));
  const grid = rows.map((r) => r.split(''));
  for (let y = 0; y < grid.length; y++) for (let x = 0; x < (grid[y]?.length || 0); x++) {
    const c = grid[y][x];
    if ((c === T.START || EXIT_TILES.has(c)) && !keep.has(`${x},${y}`)) grid[y][x] = T.FLOOR;
  }
  for (const [x, y, ch] of locks) if (grid[y]?.[x] !== undefined) grid[y][x] = ch;
  return grid.map((r) => r.join(''));
}

/** Pad/crop rows to an exact width/height, re-sealing the border afterward since a crop can shave
 *  off the far border row/column. Used so a procedural remix keeps the original level's footprint
 *  instead of whatever size generateLevel() happened to pick for the new seed. */
function fitToSize(rows, w, h) {
  let out = rows.map((r) => (r + T.WALL.repeat(w)).slice(0, w));
  while (out.length < h) out.push(T.WALL.repeat(w));
  out = out.slice(0, h);
  const grid = out.map((r) => r.split(''));
  for (let x = 0; x < w; x++) { grid[0][x] = T.WALL; grid[h - 1][x] = T.WALL; }
  for (let y = 0; y < h; y++) { grid[y][0] = T.WALL; grid[y][w - 1] = T.WALL; }
  return grid.map((r) => r.join(''));
}

/** Tile-count summary reused by explainLevel()'s templated fallback and describeLevel()'s
 *  procedural description. */
function countTiles(rows) {
  let monsters = 0, generators = 0, keys = 0, doors = 0, treasure = 0, exits = 0, poison = 0, thief = 0, death = 0;
  for (const row of rows) for (const c of row) {
    if (GENERATOR_TILES.has(c)) generators++;
    else if (MONSTER_TILES.has(c)) { monsters++; if (c === T.THIEF) thief++; if (c === T.DEATH) death++; }
    if (c === T.KEY) keys++;
    if (c === T.DOOR) doors++;
    if (c === T.TREASURE) treasure++;
    if (EXIT_TILES.has(c)) exits++;
    if (c === T.POISON_FOOD) poison++;
  }
  return { monsters, generators, keys, doors, treasure, exits, poison, thief, death };
}

/** Deterministic "make it harder/easier" rewrite of an existing level's rows: no RNG, so the same
 *  input always produces the same output (unlike the 'remix' path, which is meant to look
 *  different every time). Never touches cells within 3 tiles of a start tile, so the party never
 *  spawns on top of a fresh generator or monster. */
function tweakDifficulty(rows, mode) {
  const grid = rows.map((r) => r.split(''));
  const h = grid.length, w = grid[0]?.length || 0;
  const starts = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (grid[y][x] === T.START) starts.push([x, y]);
  const nearStart = (x, y) => starts.some(([sx, sy]) => Math.abs(sx - x) + Math.abs(sy - y) <= 3);
  const floorCells = [], genCells = [], monsterCells = [], foodCells = [], poisonCells = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const c = grid[y][x];
    if (c === T.FLOOR && !nearStart(x, y)) floorCells.push([x, y]);
    if (GENERATOR_TILES.has(c)) genCells.push([x, y]);
    if (MONSTER_TILES.has(c) && c !== T.THIEF) monsterCells.push([x, y]);
    if (c === T.FOOD) foodCells.push([x, y]);
    if (c === T.POISON_FOOD) poisonCells.push([x, y]);
  }
  if (mode === 'harder') {
    const addGen = Math.min(floorCells.length, Math.max(2, Math.round(genCells.length * 0.35)));
    const addMon = Math.min(floorCells.length - addGen, Math.max(2, Math.round(monsterCells.length * 0.35)));
    for (let i = 0; i < addGen; i++) { const [x, y] = floorCells.shift(); grid[y][x] = GEN_GLYPHS[i % GEN_GLYPHS.length]; }
    for (let i = 0; i < addMon; i++) { const [x, y] = floorCells.shift(); grid[y][x] = MONSTER_GLYPHS[i % MONSTER_GLYPHS.length]; }
    for (let i = 0; i < foodCells.length; i += 2) { const [x, y] = foodCells[i]; grid[y][x] = T.POISON_FOOD; } // every other food becomes a trap
  } else { // 'easier'
    const removeGen = Math.ceil(genCells.length * 0.4);
    const removeMon = Math.ceil(monsterCells.length * 0.4);
    for (let i = 0; i < removeGen; i++) { const [x, y] = genCells[i]; grid[y][x] = T.FLOOR; }
    for (let i = 0; i < removeMon; i++) { const [x, y] = monsterCells[i]; grid[y][x] = T.FLOOR; }
    for (const [x, y] of poisonCells) grid[y][x] = T.FOOD; // no more traps disguised as food
  }
  return grid.map((r) => r.join(''));
}

/** Procedural fallback for remixLevel(), used both when the AI is unavailable and when the AI's
 *  answer failed validation/repair. 'remix' regenerates a fresh dungeon of the same footprint from
 *  a new seed; 'harder'/'easier' tweak the existing rows in place. Either way start/exit stay put. */
function proceduralRemix(parsed, mode, locks) {
  if (mode === 'remix') {
    const counts = countTiles(parsed.rows);
    const diff = clamp(Math.round((counts.generators + counts.monsters) / 3) || 3, 1, 20);
    const seed = hashSeed(`remix:${parsed.rows.join('|')}:${Date.now()}:${Math.random()}`);
    const gen = generateLevel({ seed, level: diff });
    let lvl = { name: gen.name, description: gen.description, rows: forceLocked(fitToSize(gen.rows, parsed.w, parsed.h), locks) };
    lvl = repairLevel(lvl);
    lvl.rows = forceLocked(lvl.rows, locks);
    if (validateLevel(lvl).length) lvl = repairLevel(lvl); // best-effort second pass; repairLevel already fixes reachability
    return { level: lvl, source: 'procedural' };
  }
  let lvl = { name: parsed.name, description: parsed.description, rows: forceLocked(tweakDifficulty(parsed.rows, mode), locks) };
  lvl = repairLevel(lvl);
  lvl.rows = forceLocked(lvl.rows, locks);
  return { level: lvl, source: 'procedural' };
}

/**
 * Remix, harden or soften an existing level with the AI (procedural fallback otherwise). The
 * start and exit tile(s) always stay at their original coordinates.
 * @param {object} opts
 * @param {object} opts.level  {name, description, rows[]} — the level to vary
 * @param {'remix'|'harder'|'easier'} opts.mode
 * @returns {Promise<{level:object, source:'ai'|'procedural'}>}
 */
export async function remixLevel({ level, mode }) {
  const cleanMode = ['remix', 'harder', 'easier'].includes(mode) ? mode : 'remix';
  const parsed = parseLevel(level);
  const locks = lockedTiles(parsed);
  const anthropic = getClient();
  if (anthropic) {
    try {
      const instruction = cleanMode === 'harder'
        ? 'Make this level noticeably HARDER: more and nastier generators and monsters, less food, a bit more poison food, tighter choke points.'
        : cleanMode === 'easier'
        ? 'Make this level noticeably EASIER: fewer/weaker generators and monsters, more food, less poison food, a roomier layout.'
        : 'Remix this level: vary the room layout, monster placement and loot while keeping the same general size and spirit.';
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: `${instruction}\nThe start tile(s) and exit tile(s) MUST stay at exactly these coordinates (0-based x,y from the top-left): `
            + `${locks.map(([x, y, ch]) => `(${x},${y})=${ch}`).join(', ')}.\nCurrent level, top to bottom:\n${parsed.rows.join('\n')}`,
        }],
        output_config: { format: { type: 'json_schema', schema: REMIX_SCHEMA } },
      }, { timeout: AI_TIMEOUT_MS });
      if (response.stop_reason !== 'refusal') {
        const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        let raw = JSON.parse(text);
        raw = { ...raw, rows: forceLocked(raw.rows || [], locks) };
        let problems = validateLevel(raw);
        if (problems.length) {
          raw = repairLevel(raw);
          raw = { ...raw, rows: forceLocked(raw.rows, locks) };
          problems = validateLevel(raw);
        }
        if (!problems.length) return { level: { name: raw.name, description: raw.description, rows: raw.rows }, source: 'ai' };
      }
    } catch (err) {
      console.warn('[levelgen] remix AI call failed, using procedural fallback', err.message);
    }
  }
  return proceduralRemix(parsed, cleanMode, locks);
}

/** Templated ("no AI") strategy summary built purely from tile counts. */
function templatedExplanation(parsed) {
  const c = countTiles(parsed.rows);
  const bits = [];
  bits.push(`This ${parsed.w}×${parsed.h} level has ${c.generators} generator${c.generators === 1 ? '' : 's'} and ${c.monsters} loose monster${c.monsters === 1 ? '' : 's'} to clear or avoid.`);
  bits.push(c.doors > 0
    ? `${c.doors} locked door${c.doors === 1 ? '' : 's'} block the way, guarded by ${c.keys} key${c.keys === 1 ? '' : 's'} — grab a key before you need its door.`
    : 'There are no locked doors, so a straight push toward the exit works fine.');
  bits.push(`Along the way there${c.treasure === 1 ? "'s" : ' are'} ${c.treasure} treasure pile${c.treasure === 1 ? '' : 's'} to loot`
    + (c.poison ? `, but watch out for ${c.poison} poison food tile${c.poison === 1 ? '' : 's'} disguised as ordinary food.` : '.'));
  if (c.thief) bits.push('A thief is lurking — it will steal a key or potion and flee, so guard whoever is carrying one.');
  if (c.death) bits.push('Death itself stalks this level; it cannot be killed, so keep the party moving and spread its attention.');
  bits.push(c.exits > 1 ? `There are ${c.exits} possible exits once the level is under control.` : 'Focus on the single exit once the level is under control.');
  return bits.slice(0, 5).join(' ');
}

/**
 * Strategy advice for an existing level (AI, or a templated tile-count summary as a fallback).
 * @param {object} opts
 * @param {object} opts.level {name, description, rows[]}
 * @returns {Promise<{explanation:string}>}
 */
export async function explainLevel({ level }) {
  const parsed = parseLevel(level);
  const anthropic = getClient();
  if (anthropic) {
    try {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: `Write 3-5 sentences of strategy advice for a party of adventurers about to play this level: what to watch out for `
            + `(generators, doors/keys, poison food, a thief, Death) and how to approach it. Prose only, do not repeat the raw map.\n${parsed.rows.join('\n')}`,
        }],
        output_config: { format: { type: 'json_schema', schema: EXPLAIN_SCHEMA } },
      }, { timeout: AI_TIMEOUT_MS });
      if (response.stop_reason !== 'refusal') {
        const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        const raw = JSON.parse(text);
        if (raw.explanation && String(raw.explanation).trim()) return { explanation: String(raw.explanation).trim().slice(0, 1000) };
      }
    } catch (err) {
      console.warn('[levelgen] explain AI call failed, using templated summary', err.message);
    }
  }
  return { explanation: templatedExplanation(parsed) };
}

/**
 * AI-written (or deterministic seeded) name + one-sentence description for a procedurally
 * generated level. Used to give campaign/Death-mode levels a nicer name than "Forgotten Crypt"
 * without ever blocking level load on the network — callers fire this off for the *next* level
 * ahead of time and fall back to the level's own procedural name if it hasn't resolved yet.
 * @param {object} opts
 * @param {object} opts.level {rows[]} — the already-generated level to describe
 * @param {string|number} opts.seed   used only for the deterministic no-AI fallback name
 * @returns {Promise<{name:string, description:string}>}
 */
export async function describeLevel({ level, seed }) {
  const rows = Array.isArray(level?.rows) ? level.rows : [];
  const anthropic = getClient();
  if (anthropic && rows.length) {
    try {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 500,
        system: SYSTEM,
        messages: [{ role: 'user', content: `Write a short evocative name (max 40 chars) and a one-sentence description (max 200 chars) for this level.\n${rows.join('\n')}` }],
        output_config: { format: { type: 'json_schema', schema: NAME_SCHEMA } },
      }, { timeout: AI_TIMEOUT_MS });
      if (response.stop_reason !== 'refusal') {
        const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        const raw = JSON.parse(text);
        if (raw.name && raw.description) return { name: String(raw.name).slice(0, 40), description: String(raw.description).slice(0, 200) };
      }
    } catch (err) {
      console.warn('[levelgen] describe AI call failed, using seeded name', err.message);
    }
  }
  const name = nameForSeed(seed ?? 'level', 1);
  const c = countTiles(rows);
  const description = rows.length
    ? `A ${rows.length}-row dungeon with ${c.generators} generator${c.generators === 1 ? '' : 's'} and ${c.treasure} treasure to find.`
    : 'A freshly generated dungeon.';
  return { name, description };
}
