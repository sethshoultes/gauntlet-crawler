// Level format: parse/validate/auto-repair an ASCII level (array of equal-length strings) and the
// tile legend used by the editor and README. Used by both the server (level.js validation before
// save/publish) and the client (editor.js preview).
import { T, ALL_TILES, EXIT_TILES, EXIT_LIKE_TILES, TRAP_PLATES, GROUP_WALLS, TIMED_WALLS } from './constants.js';

export const MIN_SIZE = 12;
export const MAX_SIZE = 64;

/** Parse a level object {name, rows[]} into a validated structure. Throws on hard errors. */
export function parseLevel(raw) {
  if (!raw || !Array.isArray(raw.rows)) throw new Error('level.rows must be an array of strings');
  const rows = raw.rows.map((r) => String(r));
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  if (h < MIN_SIZE || w < MIN_SIZE) throw new Error(`level too small (min ${MIN_SIZE}x${MIN_SIZE})`);
  if (h > MAX_SIZE || w > MAX_SIZE) throw new Error(`level too large (max ${MAX_SIZE}x${MAX_SIZE})`);
  for (let y = 0; y < h; y++) {
    if (rows[y].length !== w) throw new Error(`row ${y} has length ${rows[y].length}, expected ${w}`);
    for (let x = 0; x < w; x++) {
      if (!ALL_TILES.has(rows[y][x])) throw new Error(`unknown tile '${rows[y][x]}' at ${x},${y}`);
    }
  }
  const starts = [];
  const exits = [];
  // EXIT_LIKE_TILES (not the narrower EXIT_TILES): a hidden exit (#13) still counts as an exit
  // having been placed for this structural check, even though it behaves like a wall until revealed.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rows[y][x] === T.START) starts.push([x, y]);
    if (EXIT_LIKE_TILES.has(rows[y][x])) exits.push([x, y]);
  }
  if (starts.length === 0) throw new Error('level has no start (S) tile');
  if (exits.length === 0) throw new Error('level has no exit tile (E, 8, or H)');
  return {
    name: String(raw.name || 'Untitled').slice(0, 40),
    description: String(raw.description || '').slice(0, 200),
    w, h, rows, starts, exits,
  };
}

/** Return a list of problems (strings). Empty list means the level is playable. */
export function validateLevel(raw) {
  let lvl;
  try { lvl = parseLevel(raw); } catch (e) { return [e.message]; }
  const problems = [];
  const { w, h, rows } = lvl;
  for (let x = 0; x < w; x++) {
    if (rows[0][x] !== T.WALL || rows[h - 1][x] !== T.WALL) { problems.push('border must be walls'); break; }
  }
  for (let y = 0; y < h; y++) {
    if (rows[y][0] !== T.WALL || rows[y][w - 1] !== T.WALL) { problems.push('border must be walls'); break; }
  }
  if (!exitReachable(lvl)) problems.push('exit is not reachable from the start (not enough keys are reachable to open the doors in the way)');
  return problems;
}

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** 4-connected clusters of door tiles, mirroring server/game/sim.js's dissolveGroup(): walking
 *  into any door tile of a cluster spends one key and opens every door tile in that cluster at
 *  once, so for reachability purposes a whole cluster is one all-or-nothing "lock" that costs one
 *  key. Returns an array of tile-index arrays (one per cluster); index order gives each cluster's
 *  bit position in exitReachable()'s door-state bitmask. */
function findDoorGroups(rows, w, h) {
  const seen = new Uint8Array(w * h);
  const groups = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rows[y][x] !== T.DOOR || seen[y * w + x]) continue;
    const group = [];
    const stack = [[x, y]];
    seen[y * w + x] = 1;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      group.push(cy * w + cx);
      for (const [dx, dy] of DIRS4) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const i = ny * w + nx;
        if (seen[i] || rows[ny][nx] !== T.DOOR) continue;
        seen[i] = 1;
        stack.push([nx, ny]);
      }
    }
    groups.push(group);
  }
  return groups;
}

/** Search over which door clusters have been opened to decide whether the exit can be reached at
 *  all: a hero only ever holds as many keys as they've actually walked over, and spending one on
 *  the wrong door (see server/game/sim.js dissolveGroup — one key opens a WHOLE 4-connected door
 *  cluster at once) can seal off a key needed elsewhere, so simply asking "does a key exist
 *  somewhere in the level" (the old rule) missed levels where the only key is unreachable, or
 *  reachable only behind the very door it would need to open. Instead this treats the set of
 *  opened door clusters as search state: for a given state, BFS the region reachable from the
 *  start with only those clusters open (everything else — walls, unopened doors, ungranted group
 *  walls — stays solid); if the exit condition is met in that region, the level is solvable. If
 *  not, for every door cluster adjacent to the region but not yet open, open it (spending one of
 *  the keys collected so far) and recurse, provided a key is actually left to spend. Cluster count
 *  is tiny in practice (a handful per level) so the state space (2^clusters) is cheap to exhaust.
 *
 *  A group wall (see GROUP_WALLS/TRAP_PLATES) is passable only if the level actually contains the
 *  plate that dissolves it — with no plate placed it can never open, so it stays solid for
 *  reachability purposes; unlike doors this isn't state-dependent (dissolving happens for free,
 *  triggered by standing on the plate, not by spending a key), so it's resolved once up front. A
 *  timed wall (TIMED_WALLS) is always treated as eventually passable: its timer fires
 *  unconditionally, converting it to floor or an exit (see server/game/sim.js stepTimedWalls). The
 *  secret wall (TRAP, `W`) crumbles on touch with no cost at all, so it is treated as ordinary
 *  floor here (never filtered out below).
 *
 *  Mystery treasure rooms (#13): a hidden exit behaves like a wall until revealed and like an exit
 *  afterwards, so it is never pathed *through* here — it only satisfies reachability when the
 *  player can stand next to it AND can actually trigger the reveal (server/game/sim.js
 *  revealHiddenExits): reach a switch tile, or reach every treasure tile (the "collect it all"
 *  condition needs all of them, so one unreachable treasure means the exit never opens). */
export function exitReachable(lvl) {
  const { w, h, rows, starts } = lvl;
  const openableGroups = new Set();
  for (const [plateGlyph, wallGlyph] of Object.entries(TRAP_PLATES)) {
    if (rows.some((r) => r.includes(plateGlyph))) openableGroups.add(wallGlyph);
  }
  const doorGroups = findDoorGroups(rows, w, h);
  const doorGroupOf = new Int32Array(w * h).fill(-1);
  doorGroups.forEach((tiles, gi) => { for (const i of tiles) doorGroupOf[i] = gi; });
  let treasureTotal = 0;
  for (const r of rows) for (const c of r) if (c === T.TREASURE) treasureTotal++;

  // BFS the region reachable from the start with door clusters in `openMask` passable and every
  // other door solid. Returns whether the exit condition is met plus what's needed to try opening
  // one more cluster: how many keys were actually collected in this region, and which not-yet-open
  // clusters border it.
  const exploreRegion = (openMask) => {
    const seen = new Uint8Array(w * h);
    const start = starts[0];
    const q = [start];
    seen[start[1] * w + start[0]] = 1;
    let exitFound = false, hiddenExitAdjacent = false, switchReached = false, treasureReached = 0, keysInRegion = 0;
    const adjacentClosedGroups = new Set();
    for (let head = 0; head < q.length; head++) {
      const [x, y] = q[head];
      const here = rows[y][x];
      if (EXIT_TILES.has(here)) exitFound = true;
      else if (here === T.SWITCH) switchReached = true;
      else if (here === T.TREASURE) treasureReached++;
      else if (here === T.KEY) keysInRegion++;
      for (const [dx, dy] of DIRS4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const c = rows[ny][nx];
        if (c === T.WALL) continue;
        if (c === T.HIDDEN_EXIT) { hiddenExitAdjacent = true; continue; } // terminal once revealed, never a corridor
        const i = ny * w + nx;
        if (c === T.DOOR) {
          const gi = doorGroupOf[i];
          if (!((openMask >> gi) & 1)) { adjacentClosedGroups.add(gi); continue; }
        } else if (GROUP_WALLS.has(c) && !openableGroups.has(c)) continue;
        if (seen[i]) continue;
        seen[i] = 1;
        q.push([nx, ny]);
      }
    }
    const exitSatisfied = exitFound || (hiddenExitAdjacent && (switchReached || (treasureTotal > 0 && treasureReached === treasureTotal)));
    return { exitSatisfied, keysInRegion, adjacentClosedGroups };
  };

  const popcount = (mask) => { let n = 0; for (let m = mask; m; m >>>= 1) n += m & 1; return n; };
  const visited = new Set([0]);
  const stack = [0];
  while (stack.length) {
    const mask = stack.pop();
    const { exitSatisfied, keysInRegion, adjacentClosedGroups } = exploreRegion(mask);
    if (exitSatisfied) return true;
    const keysLeftToSpend = keysInRegion - popcount(mask);
    if (keysLeftToSpend < 1) continue; // every key collected so far is already spent on an open cluster
    for (const gi of adjacentClosedGroups) {
      const next = mask | (1 << gi);
      if (visited.has(next)) continue;
      visited.add(next);
      stack.push(next);
    }
  }
  return false;
}

/** Try to fix common problems in a generated level: pad/crop rows, force border walls, carve a path to the exit. */
export function repairLevel(raw) {
  let rows = (raw.rows || []).map((r) => String(r).replace(/[^#.DKFPTESghm123ZW456lsXC!8IROUVABQN%&*=+~^:atfHL]/g, '.'));
  rows = rows.filter((r) => r.length > 0);
  let w = Math.max(...rows.map((r) => r.length), MIN_SIZE);
  w = Math.min(w, MAX_SIZE);
  rows = rows.map((r) => (r + T.WALL.repeat(w)).slice(0, w));
  while (rows.length < MIN_SIZE) rows.push(T.WALL.repeat(w));
  rows = rows.slice(0, MAX_SIZE);
  const h = rows.length;
  const grid = rows.map((r) => r.split(''));
  for (let x = 0; x < w; x++) { grid[0][x] = T.WALL; grid[h - 1][x] = T.WALL; }
  for (let y = 0; y < h; y++) { grid[y][0] = T.WALL; grid[y][w - 1] = T.WALL; }
  const find = (c) => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (grid[y][x] === c) return [x, y]; return null; };
  const floorSpot = () => {
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (grid[y][x] === T.FLOOR) return [x, y];
    grid[1][1] = T.FLOOR; return [1, 1];
  };
  if (!find(T.START)) { const [x, y] = floorSpot(); grid[y][x] = T.START; }
  // Any exit variant counts: a level that only uses the skip exit (8) must not get an extra E.
  const hasExit = grid.some((row) => row.some((c) => EXIT_TILES.has(c)));
  if (!hasExit) {
    let placed = false;
    for (let y = h - 2; y > 0 && !placed; y--) for (let x = w - 2; x > 0 && !placed; x--) if (grid[y][x] === T.FLOOR) { grid[y][x] = T.EXIT; placed = true; }
    if (!placed) { grid[h - 2][w - 2] = T.EXIT; }
  }
  let lvl = { name: raw.name, description: raw.description, rows: grid.map((r) => r.join('')) };
  const parsed = parseLevel(lvl);
  if (!exitReachable(parsed)) {
    // Carve an L-shaped corridor from start to an exit. Prefer a real exit (E/8) as the target
    // over a hidden one (H) — a hidden exit is only reachable once revealed, so if a real exit
    // exists elsewhere it's the safer thing to guarantee a path to. Either way, never carve over
    // the exit-like tile itself: it used to convert a HIDDEN_EXIT target straight to floor,
    // silently destroying the level's only exit (#27 review) — carving stops one tile short and
    // relies on exitReachable() already treating an openable H as passable once adjacent.
    const [sx, sy] = parsed.starts[0];
    const target = parsed.exits.find(([x, y]) => EXIT_TILES.has(grid[y][x])) || parsed.exits[0];
    const [ex, ey] = target;
    const carve = (x, y) => {
      const c = grid[y][x];
      if (EXIT_LIKE_TILES.has(c)) return;
      if (c === T.WALL || c === T.TRAP || c === T.DOOR || GROUP_WALLS.has(c) || TIMED_WALLS.has(c)) grid[y][x] = T.FLOOR;
    };
    for (let x = Math.min(sx, ex); x <= Math.max(sx, ex); x++) carve(x, sy);
    for (let y = Math.min(sy, ey); y <= Math.max(sy, ey); y++) carve(ex, y);
    lvl = { ...lvl, rows: grid.map((r) => r.join('')) };
  }
  return lvl;
}

export const LEGEND = [
  [T.WALL, 'Wall'], [T.FLOOR, 'Floor'], [T.DOOR, 'Door (needs key)'], [T.KEY, 'Key'], [T.FOOD, 'Food (+100 health)'],
  [T.POISON_FOOD, 'Poison food (-100 health, looks like food)'], [T.CIDER, 'Cider (+50 health)'],
  [T.POTION, 'Magic potion'], [T.TREASURE, 'Treasure'], [T.EXIT, 'Exit'], [T.EXIT_SKIP, 'Skip exit (jumps ahead 4 levels)'],
  [T.START, 'Player start'], [T.TRANSPORTER, 'Transporter (teleports to another one)'],
  [T.GEN_GRUNT, 'Grunt generator'], [T.GEN_GHOST, 'Ghost generator'], [T.GEN_DEMON, 'Demon generator'],
  [T.GEN_LOBBER, 'Lobber generator'], [T.GEN_SORCERER, 'Sorcerer generator'],
  [T.GHOST, 'Ghost'], [T.GRUNT, 'Grunt'], [T.DEMON, 'Demon'], [T.DEATH, 'Death'],
  [T.LOBBER, 'Lobber'], [T.SORCERER, 'Sorcerer'], [T.THIEF, 'Thief'],
  [T.TRAP, 'Secret wall (crumbles when a player touches it)'],
  [T.AMULET_INVIS, 'Invisibility amulet (20s: monsters ignore you)'],
  [T.AMULET_REFLECT, 'Reflective shots amulet (20s: shots bounce off a wall once)'],
  [T.AMULET_REPULSE, "Repulsiveness amulet (20s: pushes monsters away, they can't touch you)"],
  [T.AMULET_SUPER, 'Super shots amulet (20s: shots pierce through monsters)'],
  [T.BOOST_SPEED, 'Speed boost (permanent, rare)'],
  [T.BOOST_ARMOR, 'Armor boost (permanent, rare)'],
  [T.BOOST_SHOT, 'Shot power boost (permanent, rare)'],
  [T.BOOST_FIRE_RATE, 'Shot speed boost (permanent, rare)'],
  [T.BOOST_MAGIC, 'Magic power boost (permanent, rare)'],
  [T.TRAP_PLATE_A, 'Pressure plate A (dissolves all "=" wall-group A tiles when stepped on)'],
  [T.TRAP_PLATE_B, 'Pressure plate B (dissolves all "+" wall-group B tiles when stepped on)'],
  [T.TRAP_PLATE_C, 'Pressure plate C (dissolves all "~" wall-group C tiles when stepped on)'],
  [T.TRAP_WALL_A, 'Wall group A (solid until plate A is triggered)'],
  [T.TRAP_WALL_B, 'Wall group B (solid until plate B is triggered)'],
  [T.TRAP_WALL_C, 'Wall group C (solid until plate C is triggered)'],
  [T.TIMED_WALL, 'Timed wall (becomes floor after the level timer)'],
  [T.TIMED_WALL_EXIT, 'Timed exit wall (becomes an exit after the level timer)'],
  [T.ACID, 'Acid puddle (damages any hero standing on it; monsters immune)'],
  [T.STUN_TILE, 'Stun tile (freezes on contact, then a brief immunity window)'],
  [T.FORCE_FIELD, 'Force field (blocks shots; heroes and monsters walk through)'],
  [T.HIDDEN_EXIT, 'Hidden exit (solid like a wall until revealed by a switch or full treasure pickup)'],
  [T.SWITCH, 'Switch (reveals every hidden exit in the level when a hero steps on it)'],
];
