import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLevel, biasFromPrompt, generateTreasureRoom } from '../shared/procgen.js';
import { validateLevel } from '../shared/level.js';

test('procedural levels are valid across a wide difficulty range', () => {
  for (let level = 2; level <= 80; level += 3) {
    for (const seed of ['a', 'b', 'zeta']) {
      const lvl = generateLevel({ seed, level });
      assert.deepEqual(validateLevel(lvl), [], `seed ${seed} level ${level}`);
    }
  }
});

test('generation is deterministic for a seed/level pair', () => {
  const a = generateLevel({ seed: 'same', level: 7 });
  const b = generateLevel({ seed: 'same', level: 7 });
  assert.deepEqual(a.rows, b.rows);
  const c = generateLevel({ seed: 'other', level: 7 });
  assert.notDeepEqual(a.rows, c.rows);
});

test('difficulty scales generator count and map size', () => {
  const count = (lvl, chars) => lvl.rows.join('').split('').filter((c) => chars.includes(c)).length;
  const easy = generateLevel({ seed: 'scale', level: 2 });
  const hard = generateLevel({ seed: 'scale', level: 30 });
  assert.ok(count(hard, 'ghm') > count(easy, 'ghm'));
  assert.ok(hard.rows.length * hard.rows[0].length > easy.rows.length * easy.rows[0].length);
});

test('arena bias produces valid levels across the difficulty range', () => {
  for (let level = 1; level <= 60; level += 7) {
    for (const seed of ['a', 'b', 'zeta']) {
      const lvl = generateLevel({ seed, level, bias: { arena: true } });
      assert.deepEqual(validateLevel(lvl), [], `arena seed ${seed} level ${level}`);
    }
  }
});

test('arena bias packs in more generator tiles than a normal dungeon at the same seed/level', () => {
  const count = (lvl, chars) => lvl.rows.join('').split('').filter((c) => chars.includes(c)).length;
  for (const level of [1, 5, 20, 40, 60]) {
    const plain = generateLevel({ seed: 'arena-cmp', level });
    const arena = generateLevel({ seed: 'arena-cmp', level, bias: { arena: true } });
    assert.ok(count(arena, 'ghm') > count(plain, 'ghm'), `level ${level}: arena (${count(arena, 'ghm')}) should out-generator plain (${count(plain, 'ghm')})`);
  }
});

test('prompt bias extraction', () => {
  const b = biasFromPrompt('A haunted maze full of ghosts and treasure, brutal difficulty');
  assert.equal(b.ghost, 1); assert.equal(b.maze, 1); assert.equal(b.treasure, 1); assert.equal(b.monsters, 1);
  const lvl = generateLevel({ seed: 'p', level: 4, bias: b });
  assert.deepEqual(validateLevel(lvl), []);
});

test('prompt bias extraction recognizes the new monster/item words', () => {
  const b = biasFromPrompt('A lobber and a sorcerer guard a teleporter, watch for poison and grab the cider');
  assert.equal(b.lobber, 1); assert.equal(b.sorcerer, 1); assert.equal(b.teleport, 1);
  assert.equal(b.poison, 1); assert.equal(b.cider, 1);
  const b2 = biasFromPrompt('a sneaky thief lurks here');
  assert.equal(b2.thief, 1);
});

test('levels with the new monster/item glyphs still validate across a wide difficulty range', () => {
  for (let level = 2; level <= 80; level += 3) {
    for (const seed of ['a', 'b', 'zeta']) {
      const lvl = generateLevel({ seed, level, bias: { lobber: 1, sorcerer: 1, thief: 1, teleport: 1, poison: 1, cider: 1 } });
      assert.deepEqual(validateLevel(lvl), [], `seed ${seed} level ${level}`);
    }
  }
});

test('a skip-exit (8) can appear on deeper levels and still counts as a valid exit', () => {
  // Deterministic seeds don't guarantee a hit at 8% — just assert that whenever one does appear
  // (searching a range of seeds), the level still validates and the tile is present.
  let sawSkip = false;
  for (let seed = 0; seed < 60 && !sawSkip; seed++) {
    const lvl = generateLevel({ seed: `skip-${seed}`, level: 5 });
    if (lvl.rows.some((r) => r.includes('8'))) {
      sawSkip = true;
      assert.deepEqual(validateLevel(lvl), []);
    }
  }
  assert.ok(sawSkip, 'a skip-exit tile appeared in at least one of the sampled seeds');
});

test('generateTreasureRoom produces an open, monster-free room with several exits that validates', () => {
  const room = generateTreasureRoom({ seed: 'bonus', level: 6 });
  assert.deepEqual(validateLevel(room), []);
  const joined = room.rows.join('');
  assert.ok(!/[123456ghlms]/.test(joined), 'no monsters or generators in a treasure room');
  const exits = joined.split('').filter((c) => c === 'E').length;
  assert.ok(exits >= 3, `several exits: ${exits}`);
  assert.ok(room.rows.join('').split('').filter((c) => c === 'T').length > 50, 'the room is full of treasure');
  // deterministic for a given seed/level
  const again = generateTreasureRoom({ seed: 'bonus', level: 6 });
  assert.deepEqual(again.rows, room.rows);
});
