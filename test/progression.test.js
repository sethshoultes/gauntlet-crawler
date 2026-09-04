import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RANK_TITLES, MAX_RANK, PERK_CAPS, xpForRank, rankForXp, rankTitle, perksForRank,
  progressionFor, XP_KILL, XP_GENERATOR, XP_TREASURE, xpForLevelClear,
} from '../shared/progression.js';

test('rank titles: 10 unique, fun titles ending in Legend', () => {
  assert.equal(RANK_TITLES.length, MAX_RANK);
  assert.equal(new Set(RANK_TITLES).size, RANK_TITLES.length, 'no duplicate titles');
  assert.equal(RANK_TITLES[0], 'Peasant');
  assert.equal(RANK_TITLES[MAX_RANK - 1], 'Legend');
  for (const t of RANK_TITLES) assert.ok(typeof t === 'string' && t.length > 0);
});

test('xpForRank is monotonically non-decreasing and rank 1 is free', () => {
  assert.equal(xpForRank(1), 0);
  let prev = -1;
  for (let r = 1; r <= MAX_RANK; r++) {
    const x = xpForRank(r);
    assert.ok(x > prev, `xpForRank(${r})=${x} should exceed previous ${prev}`);
    prev = x;
  }
  // out-of-range ranks clamp instead of throwing
  assert.equal(xpForRank(0), xpForRank(1));
  assert.equal(xpForRank(999), xpForRank(MAX_RANK));
});

test('rankForXp is the inverse of xpForRank at each threshold', () => {
  assert.equal(rankForXp(0), 1);
  assert.equal(rankForXp(-50), 1, 'negative xp clamps to rank 1');
  for (let r = 1; r <= MAX_RANK; r++) {
    assert.equal(rankForXp(xpForRank(r)), r, `exactly at threshold for rank ${r}`);
    if (r > 1) assert.equal(rankForXp(xpForRank(r) - 1), r - 1, `just under threshold stays at rank ${r - 1}`);
  }
  assert.equal(rankForXp(Number.MAX_SAFE_INTEGER), MAX_RANK, 'huge xp caps at MAX_RANK');
});

test('rankForXp and rankForXp/rankForXp never regress as xp grows', () => {
  let prevRank = 1;
  for (let xp = 0; xp <= xpForRank(MAX_RANK) + 1000; xp += 37) {
    const r = rankForXp(xp);
    assert.ok(r >= prevRank, 'rank never decreases as xp increases');
    prevRank = r;
  }
});

test('rankTitle matches RANK_TITLES and clamps out-of-range ranks', () => {
  for (let r = 1; r <= MAX_RANK; r++) assert.equal(rankTitle(r), RANK_TITLES[r - 1]);
  assert.equal(rankTitle(0), RANK_TITLES[0]);
  assert.equal(rankTitle(50), RANK_TITLES[MAX_RANK - 1]);
});

test('perksForRank stays at zero/neutral for rank 1 and never exceeds the caps', () => {
  const base = perksForRank(1);
  assert.equal(base.speedMul, 1);
  assert.equal(base.shotDamageAdd, 0);
  assert.equal(base.damageTakenMul, 1);
  assert.equal(base.maxHealthBonus, 0);
  assert.equal(base.magicAdd, 0);

  for (let r = 1; r <= MAX_RANK; r++) {
    const p = perksForRank(r);
    assert.ok(p.speedMul <= PERK_CAPS.speedMul + 1e-9, `speedMul ${p.speedMul} exceeds cap at rank ${r}`);
    assert.ok(p.shotDamageAdd <= PERK_CAPS.shotDamageAdd, `shotDamageAdd exceeds cap at rank ${r}`);
    assert.ok(p.damageTakenMul >= PERK_CAPS.damageTakenMul - 1e-9, `damageTakenMul ${p.damageTakenMul} exceeds cap at rank ${r}`);
    assert.ok(p.maxHealthBonus <= PERK_CAPS.maxHealthBonus, `maxHealthBonus exceeds cap at rank ${r}`);
    assert.ok(p.magicAdd <= PERK_CAPS.magicAdd, `magicAdd exceeds cap at rank ${r}`);
  }

  const max = perksForRank(MAX_RANK);
  assert.equal(max.speedMul, PERK_CAPS.speedMul);
  assert.equal(max.damageTakenMul, PERK_CAPS.damageTakenMul);
  assert.equal(max.maxHealthBonus, PERK_CAPS.maxHealthBonus);
  assert.equal(max.magicAdd, PERK_CAPS.magicAdd);
});

test('perksForRank ramps monotonically toward the caps as rank increases', () => {
  let prev = perksForRank(1);
  for (let r = 2; r <= MAX_RANK; r++) {
    const cur = perksForRank(r);
    assert.ok(cur.speedMul >= prev.speedMul - 1e-9);
    assert.ok(cur.damageTakenMul <= prev.damageTakenMul + 1e-9);
    assert.ok(cur.maxHealthBonus >= prev.maxHealthBonus);
    prev = cur;
  }
});

test('progressionFor bundles xp, rank, title, perks and next-rank progress', () => {
  const p0 = progressionFor(0);
  assert.equal(p0.rank, 1);
  assert.equal(p0.title, 'Peasant');
  assert.equal(p0.nextRank, 2);
  assert.ok(p0.progress >= 0 && p0.progress < 1);

  const pMax = progressionFor(xpForRank(MAX_RANK) + 99999);
  assert.equal(pMax.rank, MAX_RANK);
  assert.equal(pMax.nextRank, null);
  assert.equal(pMax.nextTitle, null);
  assert.equal(pMax.progress, 1);
});

test('XP sources are positive and level-clear XP scales with level index', () => {
  for (const v of Object.values(XP_KILL)) assert.ok(v > 0);
  assert.ok(XP_GENERATOR > 0);
  assert.ok(XP_TREASURE > 0);
  assert.ok(xpForLevelClear(1) > 0);
  assert.ok(xpForLevelClear(10) > xpForLevelClear(1), 'deeper levels award more clear XP');
  assert.ok(xpForLevelClear(0) === xpForLevelClear(1), 'level index clamps to at least 1');
});
