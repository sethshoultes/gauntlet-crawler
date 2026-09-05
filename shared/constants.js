// Shared game constants. Units: 1 tile = 1.0 world unit. Server runs at TICK_RATE.
export const TICK_RATE = 20;
export const DT = 1 / TICK_RATE;

export const MAX_PLAYERS = 4;
export const START_HEALTH = 2000;
export const HEALTH_DRAIN_PER_SEC = 1;
export const FOOD_HEALTH = 100;
export const LOW_HEALTH = 200;
export const MAX_MONSTERS = 48;
export const MAX_SHOTS_PER_PLAYER = 3;
export const SHOT_SPEED = 12;
export const MONSTER_SHOT_SPEED = 7;
export const GENERATOR_RANGE = 14; // only generators near a player spawn
export const LEVEL_BONUS = 500;

// Tile glyphs used in the ASCII level format.
export const T = {
  WALL: '#',
  FLOOR: '.',
  DOOR: 'D',
  KEY: 'K',
  FOOD: 'F',
  POTION: 'P',
  TREASURE: 'T',
  EXIT: 'E',
  START: 'S',
  GEN_GRUNT: 'g',
  GEN_GHOST: 'h',
  GEN_DEMON: 'm',
  GEN_LOBBER: 'l',
  GEN_SORCERER: 's',
  GHOST: '1',
  GRUNT: '2',
  DEMON: '3',
  DEATH: 'Z',
  TRAP: 'W', // secret wall: solid to monsters and shots, crumbles (whole group) when a player touches it
  LOBBER: '4',
  SORCERER: '5',
  THIEF: '6', // no generator tile — the thief only appears loose, placed by procgen/editor
  TRANSPORTER: 'X', // steps onto another X tile in the level, see Sim#tryTeleport
  POISON_FOOD: '!', // looks like food, costs health instead
  CIDER: 'C', // +50 health drink
  EXIT_SKIP: '8', // exit variant that jumps the party ahead 4 levels instead of 1
  // ---- amulets: temporary (AMULET_DURATION seconds), see server/game/sim.js player.amulets ----
  AMULET_INVIS: 'I',   // monsters ignore you entirely: no targeting/aggro, they wander instead
  AMULET_REFLECT: 'R', // your shots bounce off one wall instead of dying there
  AMULET_REPULSE: 'O', // monsters within REPULSE_RANGE tiles are pushed away each tick and can't touch you
  AMULET_SUPER: 'U',   // your shots pierce through monsters, damaging each one they pass
  // ---- boosts: permanent for the run, rare, stack up to BOOST_STACK_CAP, see player.runBoosts ----
  BOOST_SPEED: 'V',
  BOOST_ARMOR: 'A',
  BOOST_SHOT: 'B',      // shot power (damage)
  BOOST_FIRE_RATE: 'Q', // shot speed (reload rate)
  BOOST_MAGIC: 'N',     // magic power
  // ---- pressure-plate wall groups (#11): stepping on a plate (by a hero OR a monster) dissolves
  // every wall tile sharing its group glyph across the whole level, not just a connected cluster —
  // see TRAP_PLATES below and server/game/sim.js's triggerPlate(). Three independent pairs so a
  // level can nest more than one puzzle at once. Solid like a wall until dissolved. ----
  TRAP_PLATE_A: '%', TRAP_PLATE_B: '&', TRAP_PLATE_C: '*',
  TRAP_WALL_A: '=', TRAP_WALL_B: '+', TRAP_WALL_C: '~',
  // ---- timed walls (#11): solid like a wall until TIMER_DEFAULT_SEC (or a level's `timers`
  // override) seconds after the level loads, then convert in place — see sim.js stepTimedWalls(). ----
  TIMED_WALL: '^',      // -> floor
  TIMED_WALL_EXIT: ':', // -> exit (E)
};

export const SOLID_TILES = new Set([
  T.WALL, T.DOOR, T.TRAP, T.TRAP_WALL_A, T.TRAP_WALL_B, T.TRAP_WALL_C, T.TIMED_WALL, T.TIMED_WALL_EXIT,
]);
// plate glyph -> the wall group glyph it dissolves (see server/game/sim.js triggerPlate()).
export const TRAP_PLATES = { [T.TRAP_PLATE_A]: T.TRAP_WALL_A, [T.TRAP_PLATE_B]: T.TRAP_WALL_B, [T.TRAP_PLATE_C]: T.TRAP_WALL_C };
export const GROUP_WALLS = new Set(Object.values(TRAP_PLATES));
export const TIMED_WALLS = new Set([T.TIMED_WALL, T.TIMED_WALL_EXIT]);
export const TIMER_DEFAULT_SEC = 30; // seconds from level start before a timed wall converts, absent a level.timers override
export const PICKUP_TILES = new Set([
  T.KEY, T.FOOD, T.POTION, T.TREASURE, T.POISON_FOOD, T.CIDER,
  T.AMULET_INVIS, T.AMULET_REFLECT, T.AMULET_REPULSE, T.AMULET_SUPER,
  T.BOOST_SPEED, T.BOOST_ARMOR, T.BOOST_SHOT, T.BOOST_FIRE_RATE, T.BOOST_MAGIC,
]);
// tile -> internal kind/stat key (see server/game/sim.js pickup handling in stepPlayers).
export const AMULET_TILES = { [T.AMULET_INVIS]: 'invis', [T.AMULET_REFLECT]: 'reflect', [T.AMULET_REPULSE]: 'repulse', [T.AMULET_SUPER]: 'super' };
export const BOOST_TILES = { [T.BOOST_SPEED]: 'speed', [T.BOOST_ARMOR]: 'armor', [T.BOOST_SHOT]: 'shotPower', [T.BOOST_FIRE_RATE]: 'shotSpeed', [T.BOOST_MAGIC]: 'magic' };
// Inverse of the above — the single-char snapshot code for each amulet/boost (see sim.js
// snapshot()'s compact per-player amulet/boost strings and client/game.js's decoder).
export const AMULET_LETTER = Object.fromEntries(Object.entries(AMULET_TILES).map(([tile, kind]) => [kind, tile]));
export const BOOST_LETTER = Object.fromEntries(Object.entries(BOOST_TILES).map(([tile, stat]) => [stat, tile]));

export const AMULET_DURATION = 20; // seconds a temporary amulet effect lasts once picked up
export const AMULET_SCORE = 150;   // score awarded for picking up an amulet
export const BOOST_SCORE = 300;    // score awarded for picking up a permanent boost (rarer, worth more)
export const BOOST_STACK_CAP = 3;  // a run-boost stat can't stack past this many pickups
export const REPULSE_RANGE = 3;    // tiles — the repulsiveness amulet's push/no-touch radius
// Display names, used by the client's HUD tooltips and the narrator's pickup line lookup (see
// client/game.js's onEvent 'pickup' handling and voice-lines.json's amulet_<kind>/boost_pickup ids).
export const AMULET_NAMES = { invis: 'Invisibility', reflect: 'Reflective Shots', repulse: 'Repulsion', super: 'Super Shots' };
export const BOOST_NAMES = { speed: 'Speed', armor: 'Armor', shotPower: 'Shot Power', shotSpeed: 'Shot Speed', magic: 'Magic Power' };
// Per-stack magnitude of each permanent run-boost stat (see server/game/sim.js's use of these).
export const BOOST_EFFECT = {
  speed: 0.12,     // +12% move speed per stack
  armor: 0.12,     // -12% damage taken per stack
  shotPower: 1,    // +1 flat shot damage per stack
  shotSpeed: 0.12, // -12% shot cooldown (faster reload) per stack
  magic: 0.5,      // +0.5 magic power per stack
};
export const GENERATOR_TILES = new Set([T.GEN_GRUNT, T.GEN_GHOST, T.GEN_DEMON, T.GEN_LOBBER, T.GEN_SORCERER]);
export const MONSTER_TILES = new Set([T.GHOST, T.GRUNT, T.DEMON, T.DEATH, T.LOBBER, T.SORCERER, T.THIEF]);
export const EXIT_TILES = new Set([T.EXIT, T.EXIT_SKIP]);
export const ALL_TILES = new Set(Object.values(T));

// `shotKey` picks the shot sprite/snapshot letter for a class (see server/game/sim.js snapshot()
// and client/sprites.js SHOT_SPRITE) — kept explicit so classes whose names share a first letter
// (warrior/wizard both start with 'w') never collide.
// `locked` + `requires` gate a hero archetype behind shared/unlocks.js (see isClassUnlocked);
// omitted (or falsy) means always playable, including by guests.
export const CLASSES = {
  warrior:  { name: 'Warrior',  hero: 'Thor',    color: '#e03c31', speed: 4.6, shotDamage: 3, shotCooldown: 0.32, armor: 0.7, magic: 1,   weapon: 'axe',      shotKey: 'w' },
  valkyrie: { name: 'Valkyrie', hero: 'Thyra',   color: '#3b7dff', speed: 5.0, shotDamage: 2, shotCooldown: 0.28, armor: 0.8, magic: 1.5, weapon: 'sword',    shotKey: 'v' },
  wizard:   { name: 'Wizard',   hero: 'Merlin',  color: '#f2c400', speed: 5.4, shotDamage: 2, shotCooldown: 0.26, armor: 1.0, magic: 3,   weapon: 'fireball', shotKey: 'z' },
  elf:      { name: 'Elf',      hero: 'Questor', color: '#2ecc40', speed: 6.4, shotDamage: 1, shotCooldown: 0.16, armor: 0.9, magic: 1.5, weapon: 'arrow',    shotKey: 'e' },
  // ---- unlockable archetypes (shared/unlocks.js HERO_UNLOCKS mirrors these) ----
  paladin: {
    name: 'Paladin', hero: 'Aldric', color: '#e8a33d', speed: 3.9, shotDamage: 3, shotCooldown: 0.42, armor: 0.55, magic: 2,
    weapon: 'hammer', shotKey: 'p', locked: true, requires: { rank: 5 },
  },
  ranger: {
    name: 'Ranger', hero: 'Sable', color: '#0fb8a5', speed: 7.0, shotDamage: 1, shotCooldown: 0.12, armor: 1.0, magic: 1,
    weapon: 'dagger', shotKey: 'r', locked: true, requires: { all: [{ stat: { key: 'class_elf', min: 1 } }, { achievement: 'ghostbuster' }] },
  },
  necromancer: {
    name: 'Necromancer', hero: 'Mordant', color: '#8b3fd1', speed: 5.0, shotDamage: 1, shotCooldown: 0.3, armor: 1.1, magic: 4,
    weapon: 'skull', shotKey: 'n', potionRadiusMul: 1.3, locked: true, requires: { any: [{ achievement: 'reaper_reaped' }, { rank: 8 }] },
  },
};
export const CLASS_IDS = Object.keys(CLASSES);

// `snapKey` is the single unique character server/game/sim.js's snapshot() sends for this
// monster type in the compact `m` array (see SNAP_KEY_TO_MONSTER below and client/game.js) —
// kept explicit (rather than derived from the type name's first letter) because several monster
// names share a first letter (ghost/grunt both 'g', demon/death both 'd') and a first-letter
// scheme silently collides them on the wire.
export const MONSTERS = {
  ghost: { hp: 1, speed: 3.2, damage: 15, touchKills: true,  score: 10,  wakeRange: 13, snapKey: 'g' },
  grunt: { hp: 2, speed: 2.6, damage: 12, touchKills: false, score: 20,  wakeRange: 12, hitCooldown: 0.6, snapKey: 'r' },
  demon: { hp: 3, speed: 2.3, damage: 20, touchKills: false, score: 30,  wakeRange: 12, hitCooldown: 0.8, shoots: true, shotDamage: 15, range: 5.5, shotCooldown: 1.6, snapKey: 'd' },
  death: { hp: 9999, speed: 3.0, damage: 4, touchKills: false, score: 1000, wakeRange: 16, drainTotal: 200, immune: true, snapKey: 'e' },
  // Lobber: keeps its distance (4-7 tiles) and lobs an arcing shot that flies over walls — see
  // Sim#stepLobber / stepShots's `arc` handling and client/game.js's growing/shrinking shot scale.
  lobber: { hp: 2, speed: 2.0, damage: 0, touchKills: false, score: 50, wakeRange: 14, shotDamage: 15, shotCooldown: 2.0, minRange: 4, maxRange: 7, snapKey: 'l' },
  // Sorcerer: a grunt that blinks in and out of visibility (see Sim#stepSorcererBlink) — while
  // invisible it can't be hit by a shot or a potion, and the client draws it at 20% alpha.
  sorcerer: { hp: 2, speed: 2.6, damage: 12, touchKills: false, score: 40, wakeRange: 12, hitCooldown: 0.6, blinkVisible: 1.5, blinkInvisible: 1.0, snapKey: 's' },
  // Thief: hunts down whichever player carries a key or potion, steals it on contact, then flees
  // (see Sim#stepThief). Never spawns from a generator.
  thief: { hp: 2, speed: 4.2, damage: 0, touchKills: false, score: 60, wakeRange: 16, snapKey: 't' },
};
// Inverse of the above, keyed by snapKey — used by client/game.js to turn a snapshot monster
// entry's single-char type back into a real monster type name for sprite lookup.
export const SNAP_KEY_TO_MONSTER = Object.fromEntries(Object.entries(MONSTERS).map(([type, def]) => [def.snapKey, type]));

export const GENERATOR_SPAWNS = { [T.GEN_GRUNT]: 'grunt', [T.GEN_GHOST]: 'ghost', [T.GEN_DEMON]: 'demon', [T.GEN_LOBBER]: 'lobber', [T.GEN_SORCERER]: 'sorcerer' };
export const GENERATOR_SCORE = 100;
export const TREASURE_SCORE = 100;

// Generator tiers (see shared/procgen.js and server/game/sim.js loadLevel/stepGenerators): a
// generator's tier is derived from the level index, not stored per-tile (a 1-char grid has no
// room for a digit suffix). Tier raises the generator's own hp, the hp bonus it grants monsters
// it spawns, and the score it's worth when destroyed.
export function generatorTier(levelIndex) {
  return Math.min(3, 1 + Math.floor((Math.max(1, levelIndex) - 1) / 6));
}
export const GENERATOR_TIER_HP = { 1: 3, 2: 5, 3: 7 };
export const GENERATOR_TIER_HP_BONUS = { 1: 0, 2: 1, 3: 2 };
export const GENERATOR_TIER_SCORE_MUL = { 1: 1, 2: 1.5, 3: 2 };

export const DIRS = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
]; // 0=N clockwise
export function dirIndex(dx, dy) {
  if (dx === 0 && dy === 0) return -1;
  const a = Math.atan2(dy, dx); // -PI..PI, 0 = east
  let i = Math.round(a / (Math.PI / 4)) + 2; // east(0) -> index 2
  return ((i % 8) + 8) % 8;
}
