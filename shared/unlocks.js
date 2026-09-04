// Character unlock catalogue: alternate palettes (recolors, cosmetic only) and locked hero
// archetypes (real CLASSES entries with `locked: true` + a `requires` condition — see
// shared/constants.js). Requirement conditions are small trees evaluated against a "profile":
//   { stats: {key: number}, achievements: Set<id>, rank: number }
// A condition is one of:
//   { rank: N }                      -- profile.rank >= N
//   { achievement: 'id' }            -- profile.achievements has 'id'
//   { stat: { key, min } }           -- profile.stats[key] >= min
//   { any: [cond, ...] }             -- OR of sub-conditions
//   { all: [cond, ...] }             -- AND of sub-conditions
// Server (server/game/room.js) evaluates these against real per-user stats/achievements/rank to
// gate `join`/`hero`; the client uses the `unlocks`/`catalogue` the server returns from
// GET /api/me to render the picker — it never re-derives unlock state from raw stats itself.
import { CLASSES, CLASS_IDS } from './constants.js';
import { ACHIEVEMENT_BY_ID } from './achievements.js';

export const PALETTES = [
  // One "classic" alt recolor per base class, unlocked early (rank 2) as a taste of the system.
  { id: 'warrior_classic', cls: 'warrior', name: 'Classic Thor', color: '#ff6b4a', requires: { rank: 2 } },
  { id: 'valkyrie_classic', cls: 'valkyrie', name: 'Classic Thyra', color: '#5a9bff', requires: { rank: 2 } },
  { id: 'wizard_classic', cls: 'wizard', name: 'Classic Merlin', color: '#ffe066', requires: { rank: 2 } },
  { id: 'elf_classic', cls: 'elf', name: 'Classic Questor', color: '#5fe066', requires: { rank: 2 } },
  // Harder-earned recolors, each gated on a class-flavored achievement or a deeper rank.
  { id: 'warrior_gold', cls: 'warrior', name: 'Golden Thor', color: '#f2c400', requires: { any: [{ achievement: 'monster_masher' }, { rank: 3 }] } },
  { id: 'valkyrie_ice', cls: 'valkyrie', name: 'Frost Thyra', color: '#a8f0ff', requires: { rank: 3 } },
  { id: 'wizard_void', cls: 'wizard', name: 'Void Merlin', color: '#7a3fd4', requires: { achievement: 'alchemist' } },
  { id: 'elf_shadow', cls: 'elf', name: 'Shadow Questor', color: '#2a2a3a', requires: { achievement: 'speedrunner' } },
];
export const PALETTE_BY_ID = Object.fromEntries(PALETTES.map((p) => [p.id, p]));

/** Locked hero archetypes, derived straight from CLASSES so the stat block and the catalogue
 *  entry can never drift apart. */
export const HERO_UNLOCKS = CLASS_IDS.filter((id) => CLASSES[id].locked).map((id) => ({
  id, type: 'hero', cls: id, name: CLASSES[id].hero, color: CLASSES[id].color, requires: CLASSES[id].requires,
}));

export const UNLOCKS = [...PALETTES.map((p) => ({ ...p, type: 'palette' })), ...HERO_UNLOCKS];

function normalizeProfile(profile) {
  return {
    stats: profile?.stats || {},
    achievements: profile?.achievements instanceof Set ? profile.achievements : new Set(profile?.achievements || []),
    rank: profile?.rank || 1,
  };
}

function evalCond(cond, ctx) {
  if (!cond) return true; // no requirement means always unlocked
  if (cond.any) return cond.any.some((c) => evalCond(c, ctx));
  if (cond.all) return cond.all.every((c) => evalCond(c, ctx));
  if (cond.rank != null) return ctx.rank >= cond.rank;
  if (cond.achievement) return ctx.achievements.has(cond.achievement);
  if (cond.stat) return (ctx.stats[cond.stat.key] || 0) >= cond.stat.min;
  return false;
}

/** Every class id (base + unlocked archetypes) and every unlocked palette id for this profile.
 *  A `null`/guest profile only ever unlocks the four base classes and no palettes. */
export function unlockedFor(profile) {
  const ctx = normalizeProfile(profile);
  const classes = new Set(CLASS_IDS.filter((id) => evalCond(CLASSES[id].requires, ctx)));
  const palettes = new Set(PALETTES.filter((p) => evalCond(p.requires, ctx)).map((p) => p.id));
  return { classes, palettes };
}

export function isClassUnlocked(cls, profile) {
  const c = CLASSES[cls];
  if (!c) return false;
  return evalCond(c.requires, normalizeProfile(profile));
}

export function isPaletteUnlocked(paletteId, profile) {
  const p = PALETTE_BY_ID[paletteId];
  if (!p) return false;
  return evalCond(p.requires, normalizeProfile(profile));
}

/** The tint color to render `cls` with `paletteId` (or null for default) for this profile.
 *  Falls back to the class's base color if the palette is unknown, belongs to another class,
 *  or isn't unlocked yet — so a stale/tampered palette id never renders as anything but default. */
export function paletteColor(cls, paletteId, profile) {
  const base = CLASSES[cls]?.color || null;
  if (!paletteId) return base;
  const p = PALETTE_BY_ID[paletteId];
  if (!p || p.cls !== cls) return base;
  return isPaletteUnlocked(paletteId, profile) ? p.color : base;
}

const STAT_LABELS = { class_elf: 'Play as Elf' };
function statText(stat) { return `${STAT_LABELS[stat.key] || stat.key} ${stat.min}+`; }
function condText(cond) {
  if (!cond) return 'Unlocked';
  if (cond.any) return cond.any.map(condText).join(' or ');
  if (cond.all) return cond.all.map(condText).join(' and ');
  if (cond.rank != null) return `Rank ${cond.rank}+`;
  if (cond.achievement) return `Unlock "${ACHIEVEMENT_BY_ID[cond.achievement]?.name || cond.achievement}"`;
  if (cond.stat) return statText(cond.stat);
  return 'Locked';
}
/** Human-readable requirement text for a catalogue item (or any `{requires}`-shaped object). */
export function requirementText(item) { return condText(item?.requires); }

/** The full catalogue with `unlocked`/`requirement` computed for a given profile — what
 *  GET /api/me hands the dashboard. */
export function catalogueFor(profile) {
  const ctx = normalizeProfile(profile);
  return UNLOCKS.map((item) => ({ ...item, unlocked: evalCond(item.requires, ctx), requirement: requirementText(item) }));
}
