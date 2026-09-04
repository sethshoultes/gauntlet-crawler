// Persistent hero progression: XP -> rank -> perks. One shared table used by both the
// server (awarding XP, applying perks, gating rank-up messages) and the client (HUD,
// dashboard). Keep perks small — this is an arcade score-drain game, not an RPG.

export const RANK_TITLES = [
  'Peasant', 'Squire', 'Adventurer', 'Veteran', 'Champion',
  'Knight', 'Hero', 'Vanguard', 'Mythic', 'Legend',
];
export const MAX_RANK = RANK_TITLES.length;

const RANK_BASE_XP = 150; // scale of the curve below

/** Cumulative XP required to reach `rank` (1-indexed; rank 1 needs 0 XP). Grows ~quadratically. */
export function xpForRank(rank) {
  const r = Math.max(1, Math.min(MAX_RANK, Math.round(rank) || 1));
  if (r <= 1) return 0;
  return Math.round(RANK_BASE_XP * (r - 1) ** 2.1);
}

/** Highest rank reachable with a given amount of total XP. */
export function rankForXp(xp) {
  xp = Math.max(0, Number(xp) || 0);
  let rank = 1;
  for (let r = 2; r <= MAX_RANK; r++) {
    if (xp >= xpForRank(r)) rank = r; else break;
  }
  return rank;
}

export function rankTitle(rank) {
  const r = Math.max(1, Math.min(MAX_RANK, Math.round(rank) || 1));
  return RANK_TITLES[r - 1];
}

// Hard caps — never exceeded no matter how high XP climbs.
export const PERK_CAPS = {
  speedMul: 1.15,        // +15% speed at max rank
  shotDamageAdd: 1,      // +1 shot damage from rank 8 (Vanguard) up
  damageTakenMul: 0.85,  // -15% damage taken at max rank
  maxHealthBonus: 200,   // +200 max starting health at max rank
  magicAdd: 1,           // +1 magic at max rank (Legend)
};
const SHOT_DAMAGE_RANK = 8; // Vanguard

/** Perk modifiers granted automatically at a given rank. Ramps linearly toward the caps. */
export function perksForRank(rank) {
  const r = Math.max(1, Math.min(MAX_RANK, Math.round(rank) || 1));
  const t = (r - 1) / (MAX_RANK - 1); // 0..1 progress toward max rank
  return {
    speedMul: 1 + (PERK_CAPS.speedMul - 1) * t,
    shotDamageAdd: r >= SHOT_DAMAGE_RANK ? PERK_CAPS.shotDamageAdd : 0,
    damageTakenMul: 1 - (1 - PERK_CAPS.damageTakenMul) * t,
    maxHealthBonus: Math.round(PERK_CAPS.maxHealthBonus * t),
    magicAdd: r >= MAX_RANK ? PERK_CAPS.magicAdd : 0,
  };
}

/** Full progression bundle for a given XP total — used by the dashboard and HUD. */
export function progressionFor(xp) {
  xp = Math.max(0, Number(xp) || 0);
  const rank = rankForXp(xp);
  const next = rank < MAX_RANK ? rank + 1 : null;
  const floor = xpForRank(rank);
  const ceil = next ? xpForRank(next) : floor;
  return {
    xp, rank, title: rankTitle(rank), perks: perksForRank(rank),
    nextRank: next, nextTitle: next ? rankTitle(next) : null,
    xpIntoRank: xp - floor, xpForNextRank: next ? ceil - floor : 0,
    progress: next ? Math.min(1, (xp - floor) / Math.max(1, ceil - floor)) : 1,
  };
}

// ---------- XP sources (server-authoritative) ----------
export const XP_KILL = { ghost: 5, grunt: 8, demon: 12, death: 150 };
export const XP_GENERATOR = 15;
export const XP_TREASURE = 8;
/** Bonus XP for clearing a level, scaled by how deep it is. */
export function xpForLevelClear(levelIndex) {
  return 20 + Math.max(1, Math.round(levelIndex)) * 5;
}
