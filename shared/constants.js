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
export const GENERATOR_HP = 3;
export const GENERATOR_RANGE = 14; // only generators near a player spawn
export const MONSTER_WAKE_RANGE = 13;
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
};

export const SOLID_TILES = new Set([T.WALL, T.DOOR, T.TRAP]);
export const PICKUP_TILES = new Set([T.KEY, T.FOOD, T.POTION, T.TREASURE, T.POISON_FOOD, T.CIDER]);
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

export const MONSTERS = {
  ghost: { hp: 1, speed: 3.2, damage: 15, touchKills: true,  score: 10,  wakeRange: 13 },
  grunt: { hp: 2, speed: 2.6, damage: 12, touchKills: false, score: 20,  wakeRange: 12, hitCooldown: 0.6 },
  demon: { hp: 3, speed: 2.3, damage: 20, touchKills: false, score: 30,  wakeRange: 12, hitCooldown: 0.8, shoots: true, shotDamage: 15, range: 5.5, shotCooldown: 1.6 },
  death: { hp: 9999, speed: 3.0, damage: 4, touchKills: false, score: 1000, wakeRange: 16, drainTotal: 200, immune: true },
  // Lobber: keeps its distance (4-7 tiles) and lobs an arcing shot that flies over walls — see
  // Sim#stepLobber / stepShots's `arc` handling and client/game.js's growing/shrinking shot scale.
  lobber: { hp: 2, speed: 2.0, damage: 0, touchKills: false, score: 50, wakeRange: 14, shotDamage: 15, shotCooldown: 2.0, minRange: 4, maxRange: 7 },
  // Sorcerer: a grunt that blinks in and out of visibility (see Sim#stepSorcererBlink) — while
  // invisible it can't be hit by a shot or a potion, and the client draws it at 20% alpha.
  sorcerer: { hp: 2, speed: 2.6, damage: 12, touchKills: false, score: 40, wakeRange: 12, hitCooldown: 0.6, blinkVisible: 1.5, blinkInvisible: 1.0 },
  // Thief: hunts down whichever player carries a key or potion, steals it on contact, then flees
  // (see Sim#stepThief). Never spawns from a generator.
  thief: { hp: 2, speed: 4.2, damage: 0, touchKills: false, score: 60, wakeRange: 16 },
};

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
