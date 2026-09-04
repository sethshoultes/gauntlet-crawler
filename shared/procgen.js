// Endless procedural dungeon generator. Deterministic for (seed, level).
// Difficulty scales with level number: bigger maps, more generators, nastier monsters, less food.
import { T } from './constants.js';
import { makeRng, hashSeed } from './rng.js';
import { parseLevel, exitReachable, repairLevel, validateLevel } from './level.js';

const THEMES = ['Catacombs', 'Crypt', 'Vault', 'Warrens', 'Sanctum', 'Oubliette', 'Cistern', 'Ossuary', 'Labyrinth', 'Barrow'];
const ADJ = ['Forgotten', 'Screaming', 'Sunken', 'Bone', 'Ember', 'Frozen', 'Cursed', 'Gilded', 'Whispering', 'Hollow'];

/**
 * @param {object} opts
 * @param {string|number} opts.seed  room seed
 * @param {number} opts.level        1-based level number (drives difficulty)
 * @param {object} [opts.bias]       optional hints from the AI/editor: {monsters, treasure, food, maze, size, ghost, grunt, demon, death}
 */
export function generateLevel({ seed, level = 2, bias = {} }) {
  const rng = makeRng(hashSeed(`${seed}:${level}`));
  const diff = Math.max(1, level);
  const sizeBias = bias.size ?? 0;
  const w = clamp(24 + Math.floor(diff * 1.2) + sizeBias * 6 + rng.int(-2, 4), 20, 56);
  const h = clamp(20 + Math.floor(diff * 0.9) + sizeBias * 4 + rng.int(-2, 3), 16, 44);
  const g = Array.from({ length: h }, () => Array(w).fill(T.WALL));

  // 1. Rooms
  const rooms = [];
  const target = clamp(6 + Math.floor(diff / 2) + (bias.maze ? 4 : 0), 6, 22);
  for (let tries = 0; tries < 400 && rooms.length < target; tries++) {
    const rw = rng.int(4, bias.maze ? 6 : 9), rh = rng.int(3, bias.maze ? 5 : 7);
    const rx = rng.int(1, w - rw - 2), ry = rng.int(1, h - rh - 2);
    if (rooms.some((r) => rx < r.x + r.w + 1 && rx + rw + 1 > r.x && ry < r.y + r.h + 1 && ry + rh + 1 > r.y)) continue;
    rooms.push({ x: rx, y: ry, w: rw, h: rh, cx: rx + (rw >> 1), cy: ry + (rh >> 1) });
    for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) g[y][x] = T.FLOOR;
  }
  // 2. Corridors: connect rooms in order (sorted by x) plus a few extra loops
  rooms.sort((a, b) => a.cx - b.cx);
  const carveCorridor = (a, b) => {
    let x = a.cx, y = a.cy;
    const horizFirst = rng.chance(0.5);
    const stepX = () => { while (x !== b.cx) { x += Math.sign(b.cx - x); g[y][x] = g[y][x] === T.WALL ? T.FLOOR : g[y][x]; } };
    const stepY = () => { while (y !== b.cy) { y += Math.sign(b.cy - y); g[y][x] = g[y][x] === T.WALL ? T.FLOOR : g[y][x]; } };
    if (horizFirst) { stepX(); stepY(); } else { stepY(); stepX(); }
  };
  for (let i = 1; i < rooms.length; i++) carveCorridor(rooms[i - 1], rooms[i]);
  const loops = rng.int(1, 2 + Math.floor(diff / 4));
  for (let i = 0; i < loops && rooms.length > 2; i++) carveCorridor(rng.pick(rooms), rng.pick(rooms));

  // 3. Start and exit in the two farthest-apart rooms
  let best = [rooms[0], rooms[rooms.length - 1], -1];
  for (const a of rooms) for (const b of rooms) {
    const d = Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy);
    if (d > best[2]) best = [a, b, d];
  }
  const [startRoom, exitRoom] = best;
  const sx = startRoom.cx, sy = startRoom.cy;
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    if (g[sy + dy]?.[sx + dx] === T.FLOOR) g[sy + dy][sx + dx] = T.START;
  }
  if (g[sy][sx] !== T.START) g[sy][sx] = T.START;
  g[exitRoom.cy][exitRoom.cx] = T.EXIT;

  // 4. Doors guarding the exit room + keys elsewhere
  const doorCount = diff >= 3 ? rng.int(1, 2) : rng.int(0, 1);
  let doorsPlaced = 0;
  const perimeter = [];
  for (let x = exitRoom.x - 1; x <= exitRoom.x + exitRoom.w; x++) { perimeter.push([x, exitRoom.y - 1]); perimeter.push([x, exitRoom.y + exitRoom.h]); }
  for (let y = exitRoom.y; y < exitRoom.y + exitRoom.h; y++) { perimeter.push([exitRoom.x - 1, y]); perimeter.push([exitRoom.x + exitRoom.w, y]); }
  for (const [x, y] of perimeter) {
    if (doorsPlaced >= doorCount) break;
    if (g[y]?.[x] === T.FLOOR) { g[y][x] = T.DOOR; doorsPlaced++; }
  }
  const freeCells = () => {
    const out = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (g[y][x] === T.FLOOR && Math.abs(x - sx) + Math.abs(y - sy) > 3) out.push([x, y]);
    return rng.shuffle(out);
  };
  let cells = freeCells();
  const place = (c, n) => { for (let i = 0; i < n && cells.length; i++) { const [x, y] = cells.pop(); g[y][x] = c; } };
  place(T.KEY, doorsPlaced + rng.int(0, 1));

  // 5. Pickups: food shrinks with depth, treasure grows
  const foodN = clamp(Math.round((5 - diff * 0.15) * (1 + (bias.food ?? 0) * 0.6)), 1, 8);
  const treasureN = clamp(Math.round((3 + diff * 0.4) * (1 + (bias.treasure ?? 0) * 0.8)), 2, 14);
  place(T.FOOD, foodN);
  place(T.TREASURE, treasureN);
  place(T.POTION, rng.int(1, 1 + Math.floor(diff / 3)));

  // 6. Generators and monsters
  const monsterScale = 1 + (bias.monsters ?? 0) * 0.5;
  const genN = clamp(Math.round((2 + diff * 0.6) * monsterScale), 1, 14);
  const genPool = [];
  const wGhost = 3 + (bias.ghost ?? 0) * 4, wGrunt = 3 + (bias.grunt ?? 0) * 4, wDemon = Math.max(0, diff - 2) * 0.8 + (bias.demon ?? 0) * 4;
  for (let i = 0; i < genN; i++) {
    const r = rng.next() * (wGhost + wGrunt + wDemon);
    genPool.push(r < wGhost ? T.GEN_GHOST : r < wGhost + wGrunt ? T.GEN_GRUNT : T.GEN_DEMON);
  }
  for (const c of genPool) place(c, 1);
  const looseN = clamp(Math.round((3 + diff * 1.2) * monsterScale), 2, 30);
  for (let i = 0; i < looseN; i++) {
    const r = rng.next() * (wGhost + wGrunt + wDemon);
    place(r < wGhost ? T.GHOST : r < wGhost + wGrunt ? T.GRUNT : T.DEMON, 1);
  }
  if ((diff >= 6 && rng.chance(0.15 + diff * 0.01)) || bias.death) place(T.DEATH, 1);

  // 7. Secret walls: turn a few dead-end wall tiles next to floors into W
  if (diff >= 2) {
    const candidates = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      if (g[y][x] !== T.WALL) continue;
      const n = [g[y - 1][x], g[y + 1][x], g[y][x - 1], g[y][x + 1]].filter((c) => c === T.FLOOR).length;
      if (n === 2 && ((g[y - 1][x] === T.FLOOR && g[y + 1][x] === T.FLOOR) || (g[y][x - 1] === T.FLOOR && g[y][x + 1] === T.FLOOR))) candidates.push([x, y]);
    }
    rng.shuffle(candidates);
    for (let i = 0; i < Math.min(candidates.length, rng.int(1, 3)); i++) { const [x, y] = candidates[i]; g[y][x] = T.TRAP; }
  }

  let lvl = {
    name: `${rng.pick(ADJ)} ${rng.pick(THEMES)}`,
    description: `Level ${level}. Generated dungeon, seed ${seed}.`,
    rows: g.map((r) => r.join('')),
  };
  if (!exitReachable(parseLevel(lvl))) lvl = repairLevel(lvl);
  if (validateLevel(lvl).length) lvl = repairLevel(lvl);
  return lvl;
}

/** Derive generator bias hints from free text (used when the AI generator is unavailable). */
export function biasFromPrompt(prompt = '') {
  const p = prompt.toLowerCase();
  const has = (...ws) => ws.some((w) => p.includes(w));
  return {
    monsters: has('horde', 'swarm', 'lots of monsters', 'many monsters', 'brutal', 'hard', 'deadly') ? 1 : has('easy', 'calm', 'peaceful', 'few monsters') ? -1 : 0,
    treasure: has('treasure', 'gold', 'rich', 'loot', 'vault') ? 1 : 0,
    food: has('food', 'feast', 'banquet', 'kitchen') ? 1 : has('starv', 'famine', 'hunger') ? -1 : 0,
    maze: has('maze', 'labyrinth', 'twisty', 'corridor') ? 1 : 0,
    size: has('huge', 'giant', 'massive', 'sprawling', 'big') ? 1 : has('tiny', 'small', 'compact', 'arena') ? -1 : 0,
    ghost: has('ghost', 'haunted', 'spirit', 'spectre', 'specter') ? 1 : 0,
    grunt: has('grunt', 'orc', 'brute', 'warband') ? 1 : 0,
    demon: has('demon', 'hell', 'inferno', 'fire', 'lava') ? 1 : 0,
    death: has('death', 'reaper', 'grim') ? 1 : 0,
  };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
