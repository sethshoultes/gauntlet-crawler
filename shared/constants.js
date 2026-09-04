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
  GHOST: '1',
  GRUNT: '2',
  DEMON: '3',
  DEATH: 'Z',
  TRAP: 'W', // secret wall: solid to monsters and shots, crumbles (whole group) when a player touches it
};

export const SOLID_TILES = new Set([T.WALL, T.DOOR, T.TRAP]);
export const PICKUP_TILES = new Set([T.KEY, T.FOOD, T.POTION, T.TREASURE]);
export const GENERATOR_TILES = new Set([T.GEN_GRUNT, T.GEN_GHOST, T.GEN_DEMON]);
export const MONSTER_TILES = new Set([T.GHOST, T.GRUNT, T.DEMON, T.DEATH]);
export const ALL_TILES = new Set(Object.values(T));

export const CLASSES = {
  warrior:  { name: 'Warrior',  hero: 'Thor',    color: '#e03c31', speed: 4.6, shotDamage: 3, shotCooldown: 0.32, armor: 0.7, magic: 1,   weapon: 'axe' },
  valkyrie: { name: 'Valkyrie', hero: 'Thyra',   color: '#3b7dff', speed: 5.0, shotDamage: 2, shotCooldown: 0.28, armor: 0.8, magic: 1.5, weapon: 'sword' },
  wizard:   { name: 'Wizard',   hero: 'Merlin',  color: '#f2c400', speed: 5.4, shotDamage: 2, shotCooldown: 0.26, armor: 1.0, magic: 3,   weapon: 'fireball' },
  elf:      { name: 'Elf',      hero: 'Questor', color: '#2ecc40', speed: 6.4, shotDamage: 1, shotCooldown: 0.16, armor: 0.9, magic: 1.5, weapon: 'arrow' },
};
export const CLASS_IDS = Object.keys(CLASSES);

export const MONSTERS = {
  ghost: { hp: 1, speed: 3.2, damage: 15, touchKills: true,  score: 10,  wakeRange: 13 },
  grunt: { hp: 2, speed: 2.6, damage: 12, touchKills: false, score: 20,  wakeRange: 12, hitCooldown: 0.6 },
  demon: { hp: 3, speed: 2.3, damage: 20, touchKills: false, score: 30,  wakeRange: 12, hitCooldown: 0.8, shoots: true, shotDamage: 15, range: 5.5, shotCooldown: 1.6 },
  death: { hp: 9999, speed: 3.0, damage: 4, touchKills: false, score: 1000, wakeRange: 16, drainTotal: 200, immune: true },
};

export const GENERATOR_SPAWNS = { [T.GEN_GRUNT]: 'grunt', [T.GEN_GHOST]: 'ghost', [T.GEN_DEMON]: 'demon' };
export const GENERATOR_SCORE = 100;
export const TREASURE_SCORE = 100;

export const DIRS = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
]; // 0=N clockwise
export function dirIndex(dx, dy) {
  if (dx === 0 && dy === 0) return -1;
  const a = Math.atan2(dy, dx); // -PI..PI, 0 = east
  let i = Math.round(a / (Math.PI / 4)) + 2; // east(0) -> index 2
  return ((i % 8) + 8) % 8;
}
