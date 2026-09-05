import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLevel, biasFromPrompt } from '../shared/procgen.js';
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
