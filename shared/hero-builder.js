// Hero Builder: pure, shared rules for a player-authored custom hero — a 6-stat "notch" point
// buy, a weapon, a trait, and an 8x8 pixel portrait. Used by the server (server/heroes.js) to
// validate and price a saved hero, and by the client (client/heroes.js) to render the builder UI.
// Nothing here touches the DOM, sqlite, or the network — see server/heroes.js and client/heroes.js
// for the sides that do, and the "Hero Builder" section of README.md for the integration contract
// that lets shared/game/sim.js consume a built hero without needing to import this file's
// validation path.

// ---------- stats ----------
export const STATS = ['speed', 'shot', 'fireRate', 'armor', 'magic', 'health'];
export const NOTCH_CAP = 5; // per-stat cap, regardless of budget

// `BUDGET_BASE` is the notch total a rank-3 player starts with (see budgetFor). It was picked,
// then the per-stat ranges below were tuned, so that converting each of the four classic
// CLASSES entries through `notchesFromClass` lands at 11-13 total notches — i.e. a brand new
// Hero Builder character can be built to roughly "as strong as a classic hero", not stronger.
export const BUDGET_BASE = 12;

// ---------- notch <-> raw-stat-value mapping ----------
// Each stat is a linear scale from `lo` (notch 0) to `hi` (notch 5). `fireRate` is inverted:
// a HIGHER notch means a LOWER (faster) shotCooldown, because faster is better for the player,
// same sense as every other stat. `lo`/`hi` are tuned constants (see shared/hero-builder.test
// coverage "classic mapping"), not derived from CLASSES at runtime, so they stay stable even if
// a future locked archetype's raw stats change.
const RANGES = {
  speed:    { lo: 3.4,  hi: 7.8 },   // tiles/sec, see CLASSES[*].speed
  shot:     { lo: 0.7,  hi: 3.9 },   // shotDamage
  fireRate: { lo: 0.12, hi: 0.54 },  // shotCooldown seconds (inverted below)
  armor:    { lo: 0.35, hi: 1.35 },  // armor multiplier (damage taken is roughly 1/armor)
  magic:    { lo: 0,    hi: 4.5 },   // magic multiplier (potion radius/power)
  health:   { lo: 0,    hi: 300 },   // bonus max health on top of START_HEALTH — a Hero Builder
                                     // -only stat; the four classics don't vary in health so their
                                     // mapped notch is always 0 (see notchesFromClass).
};
const MAGIC_FLOOR = 0.3; // never let a 0-notch custom hero have literally zero magic multiplier

function clampNotch(n) { return Math.max(0, Math.min(NOTCH_CAP, Math.round(n) || 0)); }

/** notch (0-5) -> raw stat value for `key`. */
function valueForNotch(key, notch) {
  const r = RANGES[key];
  const n = clampNotch(notch);
  const v = r.lo + (r.hi - r.lo) * (n / NOTCH_CAP);
  return key === 'magic' ? Math.max(MAGIC_FLOOR, v) : v;
}
/** raw stat value -> nearest notch (0-5), for `key` (not `fireRate` — see fireRateNotch). */
function notchForValue(key, value) {
  const r = RANGES[key];
  // + 1e-9 nudges an exact half-step tie up, so the mapping doesn't depend on float rounding noise.
  return clampNotch(Math.round((NOTCH_CAP * (value - r.lo)) / (r.hi - r.lo) + 1e-9));
}
function fireRateNotch(shotCooldown) {
  const r = RANGES.fireRate;
  const inverted = r.hi - shotCooldown + r.lo; // higher = faster
  return notchForValue('fireRate', inverted);
}
function cooldownForNotch(notch) {
  const r = RANGES.fireRate;
  const inverted = valueForNotch('fireRate', notch);
  return r.hi - inverted + r.lo;
}

/** Convert one of the four classic `CLASSES` entries into a `{speed,shot,fireRate,armor,magic,
 *  health}` notch vector — used only to calibrate/verify the budget (see test/hero-builder.test.js)
 *  and to seed `presetHeroes()`. Locked archetypes (paladin/ranger/necromancer) also convert fine,
 *  they just aren't part of the 11-13 budget guarantee. */
export function notchesFromClass(cls) {
  return {
    speed: notchForValue('speed', cls.speed),
    shot: notchForValue('shot', cls.shotDamage),
    fireRate: fireRateNotch(cls.shotCooldown),
    armor: notchForValue('armor', cls.armor),
    magic: notchForValue('magic', cls.magic),
    health: 0, // classics don't vary in health (all share START_HEALTH)
  };
}

function statTotal(stats) {
  return STATS.reduce((sum, k) => sum + clampNotch(stats?.[k]), 0);
}

/** Total notch budget available to build/edit a hero, given the owner's rank and achievement
 *  set. Locked entirely below rank 3. `achievements` is a Set of achievement ids (or an
 *  iterable of them) — see server/stats.js getAchievementIds. */
export function budgetFor(rank, achievements) {
  const r = Number(rank) || 1;
  if (r < 3) return 0;
  let budget = BUDGET_BASE;
  if (r >= 6) budget += 1;
  if (r >= 9) budget += 1;
  const ach = achievements instanceof Set ? achievements : new Set(achievements || []);
  if (ach.has('legend')) budget += 1;
  return budget;
}

// ---------- weapons ----------
// `range` is in tiles. `homing` is either false or a 0-1 turn-strength fraction (skull only, and
// small — a gentle nudge, not a guaranteed hit). `splash` is a 0-1 fraction of damage dealt to
// monsters near (not just at) the impact point (fireball only). All multipliers apply on TOP of
// the notch-derived base stats from toClassDef.
export const WEAPONS = {
  axe:      { name: 'Axe',      shotSpeedMul: 1.0,  damageMul: 1.15, cooldownMul: 1.05, range: 6,   homing: false, splash: 0,   sprite: 'axe',      desc: 'Heavy swing — +15% damage, a touch slower.' },
  arrow:    { name: 'Arrow',    shotSpeedMul: 1.25, damageMul: 0.85, cooldownMul: 0.85, range: 9,   homing: false, splash: 0,   sprite: 'arrow',    desc: 'Fast and long-ranged, but light.' },
  fireball: { name: 'Fireball', shotSpeedMul: 0.85, damageMul: 1.0,  cooldownMul: 1.1,  range: 7,   homing: false, splash: 0.8, sprite: 'fireball', desc: 'Splashes nearby monsters for 80% damage.' },
  hammer:   { name: 'Hammer',   shotSpeedMul: 0.75, damageMul: 1.35, cooldownMul: 1.3,  range: 5,   homing: false, splash: 0,   sprite: 'hammer',   desc: 'Slow, but devastating.' },
  dagger:   { name: 'Dagger',   shotSpeedMul: 1.1,  damageMul: 0.75, cooldownMul: 0.6,  range: 3.5, homing: false, splash: 0,   sprite: 'dagger',   desc: 'Short reach, very fast follow-up.' },
  skull:    { name: 'Skull',    shotSpeedMul: 0.95, damageMul: 0.9,  cooldownMul: 1.0,  range: 7,   homing: 0.35, splash: 0,   sprite: 'skull',    desc: 'Bone bolt that gently homes toward the nearest monster.' },
};
export const WEAPON_IDS = Object.keys(WEAPONS);

// ---------- traits ----------
// `requires` uses the same condition shape as shared/unlocks.js (rank/achievement/any/all) so the
// server can reuse its evaluator; omitted means unlocked as soon as the builder itself is (rank 3).
export const TRAITS = {
  glutton:    { name: 'Glutton',    desc: 'Food heals for 50% more.',               foodHealMul: 1.5,   requires: { achievement: 'glutton' } },
  scavenger:  { name: 'Scavenger',  desc: 'Treasure and generator score +25%.',     lootScoreMul: 1.25, requires: { rank: 3 } },
  thick_skin: { name: 'Thick Skin', desc: 'Take 10% less damage.',                  damageTakenMul: 0.9, requires: { rank: 3 } },
  locksmith:  { name: 'Locksmith',  desc: 'Open doors from one tile further away.', doorRangeAdd: 1,    requires: { achievement: 'locksmith' } },
  sprinter:   { name: 'Sprinter',   desc: '+8% move speed.',                       speedMul: 1.08,     requires: { achievement: 'speedrunner' } },
  arcanist:   { name: 'Arcanist',   desc: 'Magic potion blast radius +20%.',        potionRadiusMul: 1.2, requires: { achievement: 'alchemist' } },
};
export const TRAIT_IDS = Object.keys(TRAITS);

function evalRequires(cond, ctx) {
  if (!cond) return true;
  if (cond.any) return cond.any.some((c) => evalRequires(c, ctx));
  if (cond.all) return cond.all.every((c) => evalRequires(c, ctx));
  if (cond.rank != null) return ctx.rank >= cond.rank;
  if (cond.achievement) return ctx.achievements.has(cond.achievement);
  return false;
}

/** Weapon ids and trait ids unlocked for a given rank/achievement profile. All weapons are
 *  available as soon as the builder itself is (rank 3); traits each carry their own `requires`. */
export function unlockedBuilderItems(rank, achievements) {
  const ctx = { rank: Number(rank) || 1, achievements: achievements instanceof Set ? achievements : new Set(achievements || []) };
  return {
    weapons: ctx.rank >= 3 ? [...WEAPON_IDS] : [],
    traits: ctx.rank >= 3 ? TRAIT_IDS.filter((id) => evalRequires(TRAITS[id].requires, ctx)) : [],
  };
}

// ---------- palette ----------
// 8 hex colours lifted straight from client/sprites.js PAL so this shared module never touches
// the DOM. Index 0-7 is what `pixels` characters '0'-'7' select; '.' is always transparent.
export const PALETTE = ['#000000', '#f4f4f4', '#e03c31', '#3b7dff', '#f2c400', '#2ecc40', '#a05cff', '#c97b3a'];

// ---------- validation ----------
const NAME_RE = /^[A-Za-z0-9 ]{2,12}$/;
const PIXEL_ROW_RE = /^[.0-7]{8}$/;

/** Validate a hero payload against the builder rules for a given owner profile. Returns
 *  `{ok, errors}`; `errors` is always an array (empty when ok). Never throws. */
export function validateHero(hero, { rank, achievements } = {}) {
  const errors = [];
  const h = hero && typeof hero === 'object' ? hero : {};
  const budget = budgetFor(rank, achievements);
  if (budget <= 0) errors.push('Hero Builder unlocks at rank 3');

  if (typeof h.name !== 'string' || !NAME_RE.test(h.name)) errors.push('Name must be 2-12 letters, digits or spaces');
  if (h.title != null && (typeof h.title !== 'string' || h.title.length > 16)) errors.push('Title must be 16 characters or fewer');
  if (h.motto != null && (typeof h.motto !== 'string' || h.motto.length > 60)) errors.push('Motto must be 60 characters or fewer');

  const stats = h.stats && typeof h.stats === 'object' ? h.stats : {};
  for (const k of STATS) {
    const v = stats[k];
    if (!Number.isInteger(v) || v < 0 || v > NOTCH_CAP) errors.push(`Stat "${k}" must be a whole number from 0 to ${NOTCH_CAP}`);
  }
  const total = statTotal(stats);
  if (total > budget) errors.push(`Stats use ${total} notches but your budget is ${budget}`);

  const { weapons, traits } = unlockedBuilderItems(rank, achievements);
  if (!WEAPONS[h.weapon]) errors.push('Unknown weapon');
  else if (!weapons.includes(h.weapon)) errors.push('That weapon is not unlocked yet');
  if (h.trait != null) {
    if (!TRAITS[h.trait]) errors.push('Unknown trait');
    else if (!traits.includes(h.trait)) errors.push('That trait is not unlocked yet');
  }

  if (!Array.isArray(h.pixels) || h.pixels.length !== 8) errors.push('Pixel art must be 8 rows');
  else {
    let painted = 0;
    for (const row of h.pixels) {
      if (typeof row !== 'string' || !PIXEL_ROW_RE.test(row)) { errors.push('Pixel art rows must be exactly 8 characters from "." or "0"-"7"'); break; }
      for (const c of row) if (c !== '.') painted++;
    }
    if (Array.isArray(h.pixels) && h.pixels.length === 8 && h.pixels.every((r) => typeof r === 'string' && PIXEL_ROW_RE.test(r)) && painted < 8) {
      errors.push('Paint at least 8 pixels');
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------- sim-facing conversion ----------
/** The most-used non-transparent palette colour across `pixels` — used as the hero's `color`. */
function dominantColor(pixels) {
  const counts = new Array(PALETTE.length).fill(0);
  for (const row of Array.isArray(pixels) ? pixels : []) {
    for (const c of String(row)) { if (c >= '0' && c <= '7') counts[c.charCodeAt(0) - 48]++; }
  }
  let best = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] > counts[best]) best = i;
  return counts[best] > 0 ? PALETTE[best] : PALETTE[1]; // default to white if somehow nothing painted
}

/** Convert a stored/validated hero row into an object shaped like a `shared/constants.js` CLASSES
 *  entry, so `sim.addPlayer` can consume it unchanged via `classDef` (see README "Integration
 *  contract"). Does NOT re-validate — call `validateHero` first. */
export function toClassDef(hero) {
  const s = hero.stats || {};
  const weapon = WEAPONS[hero.weapon] ? hero.weapon : 'dagger';
  const weaponDef = WEAPONS[weapon];
  const trait = hero.trait && TRAITS[hero.trait] ? hero.trait : null;
  return {
    name: hero.title || hero.name || 'Custom Hero',
    hero: hero.name || 'Adventurer',
    color: dominantColor(hero.pixels),
    speed: valueForNotch('speed', s.speed),
    shotDamage: valueForNotch('shot', s.shot),
    shotCooldown: cooldownForNotch(s.fireRate),
    armor: valueForNotch('armor', s.armor),
    magic: valueForNotch('magic', s.magic),
    maxHealthBonus: valueForNotch('health', s.health),
    weapon,
    shotKey: 'c', // 'c' = custom, reserved so it never collides with a CLASSES shotKey (see constants.js)
    custom: true,
    trait,
    traitDef: trait ? TRAITS[trait] : null,
    weaponDef,
  };
}

// ---------- presets ----------
/** Three ready-made starter heroes, each within the rank-3 budget (12 notches) and pre-painted.
 *  Useful as "New from template" starting points in the builder, and as validation fixtures. */
export function presetHeroes() {
  return [
    {
      id: 'preset_bruiser', name: 'Bruiser', title: 'The Bruiser', motto: 'Walks in, walks out.',
      stats: { speed: 1, shot: 4, fireRate: 2, armor: 3, magic: 1, health: 1 }, // total 12
      weapon: 'hammer', trait: 'thick_skin',
      pixels: [
        '..2222..',
        '.222222.',
        '..2222..',
        '.333333.',
        '2333333.',
        '.333333.',
        '..33.33.',
        '..00.00.',
      ],
    },
    {
      id: 'preset_ranger', name: 'Fleetfoot', title: 'Fleetfoot', motto: 'Gone before you notice.',
      stats: { speed: 4, shot: 1, fireRate: 4, armor: 1, magic: 1, health: 1 }, // total 12
      weapon: 'arrow', trait: 'scavenger',
      pixels: [
        '..1111..',
        '.111111.',
        '..1111..',
        '.555555.',
        '5555555.',
        '.555555.',
        '..55.55.',
        '..00.00.',
      ],
    },
    {
      id: 'preset_mystic', name: 'Mystic', title: 'The Mystic', motto: 'Reads the dark for fun.',
      stats: { speed: 2, shot: 1, fireRate: 2, armor: 2, magic: 4, health: 1 }, // total 12
      weapon: 'skull', trait: 'scavenger',
      pixels: [
        '..7777..',
        '.777777.',
        '..7777..',
        '.666666.',
        '6666666.',
        '.666666.',
        '..66.66.',
        '..00.00.',
      ],
    },
  ];
}
