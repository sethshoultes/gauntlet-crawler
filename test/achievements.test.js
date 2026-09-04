import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACHIEVEMENTS, newlyUnlocked } from '../shared/achievements.js';

test('achievement ids are unique and thresholds positive', () => {
  const ids = new Set(ACHIEVEMENTS.map((a) => a.id));
  assert.equal(ids.size, ACHIEVEMENTS.length);
  assert.ok(ACHIEVEMENTS.every((a) => a.threshold > 0 && a.stat && a.name && a.desc));
});

test('newlyUnlocked returns only crossings not already held', () => {
  const first = newlyUnlocked('kills', 1, new Set());
  assert.deepEqual(first.map((a) => a.id), ['first_blood']);
  const big = newlyUnlocked('kills', 500, new Set(['first_blood']));
  assert.deepEqual(big.map((a) => a.id), ['monster_masher']);
  assert.deepEqual(newlyUnlocked('kills', 499, new Set(['first_blood'])), []);
});
