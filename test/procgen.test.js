import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLevel, biasFromPrompt, generateTreasureRoom } from '../shared/procgen.js';
import { parseLevel, validateLevel, exitReachable } from '../shared/level.js';

test('procedural levels are valid across a wide difficulty range', () => {
  for (let level = 2; level <= 80; level += 3) {
    for (const seed of ['a', 'b', 'zeta']) {
      const lvl = generateLevel({ seed, level });
      assert.deepEqual(validateLevel(lvl), [], `seed ${seed} level ${level}`);
    }
  }
});

// #48: exitReachable() is now key-aware (a door only opens if a key is actually reachable without
// crossing it — see shared/level.js), which also means a key placed *inside* the exit room it
// unlocks (the original LEVEL1 bug, reproduced generically here) is now structurally impossible:
// generateLevel excludes the exit room's interior from key placement. Fuzz a wide seed/depth range
// to make sure that holds — every generated level must both pass validateLevel (which already
// checks exitReachable) and pass exitReachable directly, so a regression here fails loudly rather
// than only showing up as a "not reachable" string buried in validateLevel's problem list.
test('generated levels are solvable under the key-aware reachability check across many seeds/depths', () => {
  let checked = 0;
  for (let seed = 0; seed < 300; seed++) {
    for (let depth = 1; depth <= 30; depth++) {
      const lvl = generateLevel({ seed: `fuzz-${seed}`, level: depth });
      const parsed = parseLevel(lvl);
      assert.ok(exitReachable(parsed), `seed fuzz-${seed} level ${depth}: exit must be reachable`);
      assert.deepEqual(validateLevel(lvl), [], `seed fuzz-${seed} level ${depth}`);
      checked++;
    }
  }
  assert.equal(checked, 300 * 30);
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

test('amulets appear occasionally and boosts rarely, more often on deeper levels, without breaking validity', () => {
  const countOf = (lvl, chars) => lvl.rows.join('').split('').filter((c) => chars.includes(c)).length;
  let shallowAmulets = 0, deepAmulets = 0, deepBoosts = 0;
  for (let i = 0; i < 40; i++) {
    const shallow = generateLevel({ seed: `am-shallow-${i}`, level: 2 });
    const deep = generateLevel({ seed: `am-deep-${i}`, level: 30 });
    assert.deepEqual(validateLevel(shallow), [], `shallow seed ${i}`);
    assert.deepEqual(validateLevel(deep), [], `deep seed ${i}`);
    shallowAmulets += countOf(shallow, 'IROU');
    deepAmulets += countOf(deep, 'IROU');
    deepBoosts += countOf(deep, 'VABQN');
  }
  assert.ok(deepAmulets > shallowAmulets, 'deeper levels see more amulets than shallow ones over many seeds');
  assert.ok(deepBoosts > 0, 'permanent boosts show up at least occasionally on deep levels');
  // Level 1 never gets boosts (gated at diff >= 4) — a sanity check the gate actually holds.
  let level1Boosts = 0;
  for (let i = 0; i < 20; i++) level1Boosts += countOf(generateLevel({ seed: `am-l1-${i}`, level: 1 }), 'VABQN');
  assert.equal(level1Boosts, 0, 'boosts never appear this early');
});

test('an "amulet"/"boost" prompt bias raises the chance without breaking validity', () => {
  const b1 = biasFromPrompt('grab the amulet of invisibility');
  assert.equal(b1.amulet, 1);
  const b2 = biasFromPrompt('a rare power-up awaits');
  assert.equal(b2.boost, 1);
  for (let level = 2; level <= 40; level += 6) {
    const lvl = generateLevel({ seed: `bias-${level}`, level, bias: { amulet: 1, boost: 1 } });
    assert.deepEqual(validateLevel(lvl), [], `level ${level}`);
  }
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
