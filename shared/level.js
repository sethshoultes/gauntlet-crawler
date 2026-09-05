// Level format: parse/validate/auto-repair an ASCII level (array of equal-length strings) and the
// tile legend used by the editor and README. Used by both the server (level.js validation before
// save/publish) and the client (editor.js preview).
import { T, ALL_TILES, EXIT_TILES } from './constants.js';

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
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rows[y][x] === T.START) starts.push([x, y]);
    if (EXIT_TILES.has(rows[y][x])) exits.push([x, y]);
  }
  if (starts.length === 0) throw new Error('level has no start (S) tile');
  if (exits.length === 0) throw new Error('level has no exit (E) tile');
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
  if (!exitReachable(lvl)) problems.push('exit is not reachable from the start (doors count as passable if a key exists)');
  return problems;
}

/** BFS from the first start to any exit; doors are passable only if the level has at least one key. */
export function exitReachable(lvl) {
  const { w, h, rows, starts } = lvl;
  const hasKey = rows.some((r) => r.includes(T.KEY));
  const seen = new Uint8Array(w * h);
  const q = [starts[0]];
  seen[starts[0][1] * w + starts[0][0]] = 1;
  while (q.length) {
    const [x, y] = q.shift();
    if (EXIT_TILES.has(rows[y][x])) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const c = rows[ny][nx];
      if (c === T.WALL) continue;
      if (c === T.DOOR && !hasKey) continue;
      const i = ny * w + nx;
      if (seen[i]) continue;
      seen[i] = 1;
      q.push([nx, ny]);
    }
  }
  return false;
}

/** Try to fix common problems in a generated level: pad/crop rows, force border walls, carve a path to the exit. */
export function repairLevel(raw) {
  let rows = (raw.rows || []).map((r) => String(r).replace(/[^#.DKFPTESghm123ZW456lsXC!8]/g, '.'));
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
  if (!find(T.EXIT)) {
    let placed = false;
    for (let y = h - 2; y > 0 && !placed; y--) for (let x = w - 2; x > 0 && !placed; x--) if (grid[y][x] === T.FLOOR) { grid[y][x] = T.EXIT; placed = true; }
    if (!placed) { grid[h - 2][w - 2] = T.EXIT; }
  }
  let lvl = { name: raw.name, description: raw.description, rows: grid.map((r) => r.join('')) };
  const parsed = parseLevel(lvl);
  if (!exitReachable(parsed)) {
    // Carve an L-shaped corridor from start to the first exit.
    const [sx, sy] = parsed.starts[0];
    const [ex, ey] = parsed.exits[0];
    const carve = (x, y) => { if (grid[y][x] === T.WALL || grid[y][x] === T.TRAP || grid[y][x] === T.DOOR) grid[y][x] = T.FLOOR; };
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
];
