// Endless procedural dungeon generator. Deterministic for (seed, level).
// Difficulty scales with level number: bigger maps, more generators, nastier monsters, less food.
import { T, GENERATOR_TILES } from './constants.js';
import { makeRng, hashSeed } from './rng.js';
import { parseLevel, exitReachable, repairLevel, validateLevel } from './level.js';

const THEMES = ['Catacombs', 'Crypt', 'Vault', 'Warrens', 'Sanctum', 'Oubliette', 'Cistern', 'Ossuary', 'Labyrinth', 'Barrow'];
const ADJ = ['Forgotten', 'Screaming', 'Sunken', 'Bone', 'Ember', 'Frozen', 'Cursed', 'Gilded', 'Whispering', 'Hollow'];

/**
 * @param {object} opts
 * @param {string|number} opts.seed  room seed
 * @param {number} opts.level        1-based level number (drives difficulty)
 * @param {object} [opts.bias]       optional hints from the AI/editor: {monsters, treasure, food, maze, size, ghost, grunt, demon, death, arena}
 *   `arena` is the death-mode "wave arena" profile: fewer/bigger rooms, wide two-tile corridors, more generators.
 */
export function generateLevel({ seed, level = 2, bias = {} }) {
  const rng = makeRng(hashSeed(`${seed}:${level}`));
  const diff = Math.max(1, level);
  const arena = !!bias.arena; // "wave arena" profile: death mode — fewer/bigger rooms, wide corridors, more generators
  const sizeBias = bias.size ?? 0;
  const w = clamp(24 + Math.floor(diff * 1.2) + sizeBias * 6 + rng.int(-2, 4), 20, 56);
  const h = clamp(20 + Math.floor(diff * 0.9) + sizeBias * 4 + rng.int(-2, 3), 16, 44);
  const g = Array.from({ length: h }, () => Array(w).fill(T.WALL));

  // 1. Rooms — an arena favors a handful of big open rooms over many small ones
  const rooms = [];
  const target = arena
    ? clamp(3 + Math.floor(diff / 5), 3, 10)
    : clamp(6 + Math.floor(diff / 2) + (bias.maze ? 4 : 0), 6, 22);
  for (let tries = 0; tries < 400 && rooms.length < target; tries++) {
    const rw = arena ? rng.int(7, 13) : rng.int(4, bias.maze ? 6 : 9);
    const rh = arena ? rng.int(6, 11) : rng.int(3, bias.maze ? 5 : 7);
    const rx = rng.int(1, w - rw - 2), ry = rng.int(1, h - rh - 2);
    if (rooms.some((r) => rx < r.x + r.w + 1 && rx + rw + 1 > r.x && ry < r.y + r.h + 1 && ry + rh + 1 > r.y)) continue;
    rooms.push({ x: rx, y: ry, w: rw, h: rh, cx: rx + (rw >> 1), cy: ry + (rh >> 1) });
    for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) g[y][x] = T.FLOOR;
  }
  // 2. Corridors: connect rooms in order (sorted by x) plus a few extra loops.
  // An arena carves them two tiles wide so packs of monsters can flow freely.
  rooms.sort((a, b) => a.cx - b.cx);
  const carveCorridor = (a, b) => {
    let x = a.cx, y = a.cy;
    const horizFirst = rng.chance(0.5);
    const mark = (mx, my) => { if (g[my]?.[mx] === T.WALL) g[my][mx] = T.FLOOR; };
    const stepX = () => { while (x !== b.cx) { x += Math.sign(b.cx - x); mark(x, y); if (arena) mark(x, y + 1); } };
    const stepY = () => { while (y !== b.cy) { y += Math.sign(b.cy - y); mark(x, y); if (arena) mark(x + 1, y); } };
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
  // Skip exit (see README's "Level format" section): on deeper levels, a small chance the exit becomes a variant that jumps the
  // party ahead 4 levels instead of 1 (see server/game/room.js onLevelComplete). exitRoom is
  // already the farthest-apart room from the start, satisfying "in a room far from the start".
  const skipExit = diff >= 3 && rng.chance(0.08);
  g[exitRoom.cy][exitRoom.cx] = skipExit ? T.EXIT_SKIP : T.EXIT;

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
  // Poison food (looks like food, costs health) and cider (+50 health) — rare, more common when
  // the prompt calls for them.
  const poisonN = clamp((bias.poison ? rng.int(1, 2) : 0) + (diff >= 5 && rng.chance(0.2 + diff * 0.01) ? 1 : 0), 0, 3);
  const ciderN = clamp((bias.cider ? rng.int(1, 2) : 0) + (rng.chance(0.25) ? 1 : 0), 0, 3);
  place(T.POISON_FOOD, poisonN);
  place(T.CIDER, ciderN);
  // Amulets (README's "Features" section, "Amulets and boosts"): temporary power-ups, occasional
  // from level 2 on and more likely the deeper the party goes. Permanent boosts are much rarer and
  // only start appearing on level 4+, since they persist for the whole run.
  const amuletTiles = [T.AMULET_INVIS, T.AMULET_REFLECT, T.AMULET_REPULSE, T.AMULET_SUPER];
  const amuletN = diff >= 2 && rng.chance(clamp(0.12 + diff * 0.01 + (bias.amulet ? 0.25 : 0), 0, 0.6)) ? rng.int(1, 2) : 0;
  for (let i = 0; i < amuletN; i++) place(rng.pick(amuletTiles), 1);
  const boostTiles = [T.BOOST_SPEED, T.BOOST_ARMOR, T.BOOST_SHOT, T.BOOST_FIRE_RATE, T.BOOST_MAGIC];
  if (diff >= 4 && rng.chance(clamp(0.06 + diff * 0.004 + (bias.boost ? 0.15 : 0), 0, 0.3))) place(rng.pick(boostTiles), 1);
  // Transporter pair (README's "Features" section, "Transporters"): teleports the party between two spots. Two X tiles must be placed
  // together, or not at all.
  if (diff >= 2 && rng.chance(0.15 + diff * 0.005 + (bias.teleport ? 0.3 : 0)) && cells.length >= 2) {
    place(T.TRANSPORTER, 2);
  }

  // 6. Generators and monsters — an arena packs in noticeably more generators than a normal dungeon
  const monsterScale = 1 + (bias.monsters ?? 0) * 0.5;
  const genN = clamp(Math.round((2 + diff * 0.6) * monsterScale * (arena ? 1.8 : 1)), 1, arena ? 26 : 14);
  const genPool = [];
  const wGhost = 3 + (bias.ghost ?? 0) * 4, wGrunt = 3 + (bias.grunt ?? 0) * 4, wDemon = Math.max(0, diff - 2) * 0.8 + (bias.demon ?? 0) * 4;
  const wLobber = diff >= 3 ? 2 + (bias.lobber ?? 0) * 4 : 0;
  const wSorcerer = diff >= 2 ? 2 + (bias.sorcerer ?? 0) * 4 : 0;
  const genWeights = [[T.GEN_GHOST, wGhost], [T.GEN_GRUNT, wGrunt], [T.GEN_DEMON, wDemon], [T.GEN_LOBBER, wLobber], [T.GEN_SORCERER, wSorcerer]];
  const monsterWeights = [[T.GHOST, wGhost], [T.GRUNT, wGrunt], [T.DEMON, wDemon], [T.LOBBER, wLobber], [T.SORCERER, wSorcerer]];
  const weightedTile = (weights) => {
    const total = weights.reduce((s, [, w]) => s + w, 0);
    let r = rng.next() * total;
    for (const [tile, w] of weights) { r -= w; if (r <= 0) return tile; }
    return weights[weights.length - 1][0];
  };
  for (let i = 0; i < genN; i++) genPool.push(weightedTile(genWeights));
  for (const c of genPool) place(c, 1);
  const looseN = clamp(Math.round((3 + diff * 1.2) * monsterScale), 2, 30);
  for (let i = 0; i < looseN; i++) place(weightedTile(monsterWeights), 1);
  if ((diff >= 6 && rng.chance(0.15 + diff * 0.01)) || bias.death) place(T.DEATH, 1);
  // Thief: loose only, never from a generator. Rare, more likely when asked for or deeper.
  const thiefChance = (bias.thief ? 0.35 : 0) + (diff >= 4 ? 0.1 + diff * 0.005 : 0);
  if (rng.chance(clamp(thiefChance, 0, 0.6))) place(T.THIEF, 1);

  // 7. Secret walls: turn a few dead-end wall tiles next to floors into W — or, occasionally on
  // deeper levels, a timed wall/timed-exit-wall shortcut (#11) that opens on its own after a
  // countdown instead of needing a touch.
  if (diff >= 2) {
    const candidates = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      if (g[y][x] !== T.WALL) continue;
      const n = [g[y - 1][x], g[y + 1][x], g[y][x - 1], g[y][x + 1]].filter((c) => c === T.FLOOR).length;
      if (n === 2 && ((g[y - 1][x] === T.FLOOR && g[y + 1][x] === T.FLOOR) || (g[y][x - 1] === T.FLOOR && g[y][x + 1] === T.FLOOR))) candidates.push([x, y]);
    }
    rng.shuffle(candidates);
    for (let i = 0; i < Math.min(candidates.length, rng.int(1, 3)); i++) {
      const [x, y] = candidates[i];
      let glyph = T.TRAP;
      if (diff >= 3 && rng.chance(0.2)) glyph = rng.chance(0.7) ? T.TIMED_WALL : T.TIMED_WALL_EXIT;
      g[y][x] = glyph;
    }
  }

  // 8. Pressure-plate wall group puzzle (#11): occasionally (levels 3+) seal a small treasure
  // vault behind a wall group carved into the solid rock just outside a non-start/exit room, with
  // the matching plate placed elsewhere in the level as an environmental puzzle. shared/level.js's
  // exitReachable() only ever treats a group wall as passable when its plate is present, which is
  // guaranteed here since both are always placed together.
  if (diff >= 3 && rng.chance(0.35)) {
    const groups = [[T.TRAP_PLATE_A, T.TRAP_WALL_A], [T.TRAP_PLATE_B, T.TRAP_WALL_B], [T.TRAP_PLATE_C, T.TRAP_WALL_C]];
    const [plateGlyph, wallGlyph] = rng.pick(groups);
    const others = rooms.filter((r) => r !== startRoom && r !== exitRoom);
    for (const room of rng.shuffle((others.length ? others : rooms).slice())) {
      const vault = carveAlcove(g, w, h, room, rng);
      if (!vault.length) continue;
      for (const [gx, gy, px, py] of vault) { g[gy][gx] = wallGlyph; g[py][px] = T.TREASURE; }
      const plateSpot = (cells.length ? cells : freeCells()).pop();
      if (plateSpot) g[plateSpot[1]][plateSpot[0]] = plateGlyph;
      break;
    }
  }

  // 9. Environmental hazards (#12, arcade parity): acid puddles, an occasional stun tile, and force
  // fields guarding a generator's approach. All three are walkable (a force field only blocks
  // shots), so scattering them can never break reachability the way a wall-like tile could — no
  // extra exitReachable bookkeeping needed, unlike the plate puzzle above.
  if (diff >= 5) {
    const isInRoom = (x, y) => rooms.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    const corridorCells = (cells.length ? cells : freeCells()).filter(([x, y]) => !isInRoom(x, y));
    const acidN = clamp(Math.round(1 + diff * 0.15), 1, 6);
    for (let i = 0; i < acidN && corridorCells.length; i++) {
      const [x, y] = corridorCells.splice(rng.int(0, corridorCells.length - 1), 1)[0];
      if (g[y][x] === T.FLOOR) g[y][x] = T.ACID;
    }
    // A stun tile next to a treasure tile, occasionally — guards the loot without blocking it.
    if (rng.chance(0.3)) {
      const treasureSpots = [];
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (g[y][x] === T.TREASURE) treasureSpots.push([x, y]);
      for (const [tx, ty] of rng.shuffle(treasureSpots)) {
        const spot = rng.shuffle([[tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]]).find(([nx, ny]) => g[ny]?.[nx] === T.FLOOR);
        if (spot) { g[spot[1]][spot[0]] = T.STUN_TILE; break; }
      }
    }
    // Force fields gate a generator's approach tiles: a shot can't reach it from outside the gate,
    // but walking up to it (force fields never block movement) works exactly as before.
    if (rng.chance(0.4)) {
      const genSpots = [];
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (GENERATOR_TILES.has(g[y][x])) genSpots.push([x, y]);
      if (genSpots.length) {
        const [gx, gy] = rng.pick(genSpots);
        let placed = 0;
        for (const [nx, ny] of rng.shuffle([[gx + 1, gy], [gx - 1, gy], [gx, gy + 1], [gx, gy - 1]])) {
          if (placed >= 2) break;
          if (g[ny]?.[nx] === T.FLOOR) { g[ny][nx] = T.FORCE_FIELD; placed++; }
        }
      }
    }
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
    lobber: has('lobber', 'lob', 'catapult', 'mortar') ? 1 : 0,
    sorcerer: has('sorcerer', 'sorcery', 'wizard', 'mage', 'witch') ? 1 : 0,
    thief: has('thief', 'steal', 'rogue', 'bandit') ? 1 : 0,
    teleport: has('teleport', 'transporter', 'portal', 'warp') ? 1 : 0,
    poison: has('poison', 'toxic', 'venom', 'venomous') ? 1 : 0,
    cider: has('cider', 'ale', 'mead', 'tavern', 'drink') ? 1 : 0,
    amulet: has('amulet', 'invisib', 'reflect', 'repuls', 'super shot', 'pierce') ? 1 : 0,
    boost: has('boost', 'power up', 'power-up', 'powerup', 'upgrade') ? 1 : 0,
  };
}

/** Deterministic level name for a seed, independent of generateLevel()'s own internal rng use (that
 *  rng is consumed room-by-room before it ever reaches the name pick, so re-deriving a name from
 *  the same seed there would silently change with unrelated generator tweaks). Reused by
 *  server/ai/levelgen.js's describeLevel() as the "no AI credentials" fallback name for both
 *  procedural levels and AI remixes. */
export function nameForSeed(seed, level = 1) {
  const rng = makeRng(hashSeed(`name:${seed}:${level}`));
  return `${rng.pick(ADJ)} ${rng.pick(THEMES)}`;
}

/** Bonus level (README's "Features" section, "Bonus treasure rooms"): an open room full of treasure, no monsters, several exits. See
 *  server/game/room.js — after every 5th campaign level, levelFor() returns this instead of a
 *  regular generated level; Sim.loadLevel({treasureRoom:true}) starts a 30s auto-complete timer.
 *
 *  Mystery variant (#13, arcade parity: Gauntlet II's level-8-style secret vaults): every other
 *  treasure room a run reaches conceals its exits behind T.HIDDEN_EXIT instead of a plain T.EXIT,
 *  plus a T.SWITCH tile across the room from the entrance — either throwing the switch or picking
 *  up every last piece of treasure reveals them all at once (server/game/sim.js
 *  revealHiddenExits()). `level` is always this room's own campaign level number (6, 12, 18, …, see
 *  Room#isTreasureLevel), so "every other" is simply every other *occurrence*, not a coin flip —
 *  deterministic for a given run regardless of seed (the seed still drives everything about the
 *  room's own layout). A treasure room is, by construction, always full of T.TREASURE, so
 *  shared/level.js's exitReachable() rule for hidden exits (switch-or-treasure) is always satisfied
 *  here. */
export function generateTreasureRoom({ seed, level = 1 } = {}) {
  const rng = makeRng(hashSeed(`treasure:${seed}:${level}`));
  const w = 22, h = 16;
  const g = Array.from({ length: h }, () => Array(w).fill(T.TREASURE));
  for (let x = 0; x < w; x++) { g[0][x] = T.WALL; g[h - 1][x] = T.WALL; }
  for (let y = 0; y < h; y++) { g[y][0] = T.WALL; g[y][w - 1] = T.WALL; }
  const midY = h >> 1;
  g[midY][1] = T.START; g[midY][2] = T.START;
  g[midY - 1][1] = T.START; g[midY + 1][1] = T.START;
  const roomNum = Math.round(level / 6) - 1; // 0 for the first treasure room (level 6), 1 for the second (level 12), ...
  const mystery = roomNum % 2 === 1;
  const exitSpots = rng.shuffle([[w - 2, 2], [w - 2, midY], [w - 2, h - 3], [w >> 1, h - 2], [w >> 1, 2]]).slice(0, rng.int(3, 4));
  for (const [ex, ey] of exitSpots) g[ey][ex] = mystery ? T.HIDDEN_EXIT : T.EXIT;
  if (mystery) {
    // Across the room from the entrance (start sits against the west wall) — finding it takes a
    // real lap of the vault, not just a lucky first step. Any of these candidate spots is still
    // solid rock or plain treasure at this point, so overwriting it is always safe.
    const [swx, swy] = rng.pick([[w - 3, h - 3], [w - 3, 2], [(w >> 1) + 2, midY]]);
    g[swy][swx] = T.SWITCH;
  }
  let lvl = {
    name: mystery ? 'Mystery Vault' : 'Treasure Vault',
    description: mystery
      ? `Find the concealed exit — or the switch that reveals it — before the ${30}s timer runs out.`
      : `Grab everything before the ${30}s timer runs out — any exit will do.`,
    rows: g.map((r) => r.join('')),
  };
  if (!exitReachable(parseLevel(lvl))) lvl = repairLevel(lvl);
  if (validateLevel(lvl).length) lvl = repairLevel(lvl);
  return lvl;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** Find up to 3 single-tile vault pockets carved into the untouched solid rock just outside
 *  `room`'s border ring (see generateLevel's pressure-plate puzzle step, #11): a wall tile
 *  adjacent to the room (the "gate", which the caller turns into a wall-group glyph) with solid
 *  rock directly beyond it (the "pocket", which becomes a sealed treasure tile). The pocket's own
 *  perpendicular neighbours must not already be floor, so this never punches into another room or
 *  corridor that happens to run close by. Returns [[gateX, gateY, pocketX, pocketY], ...]. */
function carveAlcove(g, w, h, room, rng) {
  const solidRock = (x, y) => x > 0 && y > 0 && x < w - 1 && y < h - 1 && g[y][x] === T.WALL;
  const isFloor = (x, y) => x >= 0 && y >= 0 && x < w && y < h && g[y][x] === T.FLOOR;
  const sides = rng.shuffle([
    { cells: Array.from({ length: room.w }, (_, i) => [room.x + i, room.y - 1]), dir: [0, -1] },
    { cells: Array.from({ length: room.w }, (_, i) => [room.x + i, room.y + room.h]), dir: [0, 1] },
    { cells: Array.from({ length: room.h }, (_, i) => [room.x - 1, room.y + i]), dir: [-1, 0] },
    { cells: Array.from({ length: room.h }, (_, i) => [room.x + room.w, room.y + i]), dir: [1, 0] },
  ]);
  for (const side of sides) {
    const found = [];
    for (const [gx, gy] of side.cells) {
      if (!solidRock(gx, gy)) continue;
      const [dx, dy] = side.dir;
      const px = gx + dx, py = gy + dy;
      if (!solidRock(px, py)) continue;
      if (isFloor(px + dy, py + dx) || isFloor(px - dy, py - dx)) continue; // too close to another room/corridor
      found.push([gx, gy, px, py]);
      if (found.length >= 3) break;
    }
    if (found.length) return found;
  }
  return [];
}
