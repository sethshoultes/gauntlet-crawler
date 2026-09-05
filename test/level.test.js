import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLevel, validateLevel, repairLevel, exitReachable } from '../shared/level.js';
import { LEVEL1 } from '../shared/levels/level1.js';

test('level 1 is valid', () => {
  assert.deepEqual(validateLevel(LEVEL1), []);
  const lvl = parseLevel(LEVEL1);
  assert.equal(lvl.w, 32); assert.equal(lvl.h, 24);
  assert.ok(lvl.starts.length >= 2);
});

test('rejects ragged rows and unknown tiles', () => {
  const rows = LEVEL1.rows.slice(); rows[3] = rows[3].slice(0, -1);
  assert.match(validateLevel({ rows })[0], /length/);
  const rows2 = LEVEL1.rows.slice(); rows2[3] = rows2[3].replace('.', '?');
  assert.match(validateLevel({ rows: rows2 })[0], /unknown tile/);
});

test('detects unreachable exit and doors without keys', () => {
  const rows = [
    '############',
    '#S.........#',
    '#..........#',
    '############',
    '#.........E#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '############',
  ];
  assert.match(validateLevel({ rows })[0], /not reachable/);
  const withDoor = rows.slice(); withDoor[3] = '#####D######';
  assert.match(validateLevel({ rows: withDoor })[0], /not reachable/, 'door with no key is impassable');
  const withKey = withDoor.slice(); withKey[1] = '#S....K....#';
  assert.deepEqual(validateLevel({ rows: withKey }), []);
});

test('the new monster/item glyphs are accepted, and the skip-exit (8) counts as an exit', () => {
  const rows = LEVEL1.rows.slice();
  // Antechamber row 6 has a stretch of floor around the '2' grunt; swap in the new glyphs.
  rows[1] = rows[1].slice(0, 20) + '4' + rows[1].slice(21);
  rows[2] = rows[2].slice(0, 20) + '5' + rows[2].slice(21);
  rows[4] = rows[4].slice(0, 20) + '6' + rows[4].slice(21);
  rows[6] = rows[6].slice(0, 20) + 'X' + rows[6].slice(21);
  rows[8] = rows[8].slice(0, 20) + '!' + rows[8].slice(21);
  rows[10] = rows[10].slice(0, 20) + 'C' + rows[10].slice(21);
  assert.deepEqual(validateLevel({ rows }), []);

  // '8' (the skip-exit variant) is accepted as a tile and satisfies the exit requirement on its own.
  const withSkipExit = LEVEL1.rows.slice();
  const exitRow = withSkipExit.findIndex((r) => r.includes('E'));
  withSkipExit[exitRow] = withSkipExit[exitRow].replace('E', '8');
  assert.deepEqual(validateLevel({ rows: withSkipExit }), []);
  const parsed = parseLevel({ rows: withSkipExit });
  assert.equal(parsed.exits.length, 1, "'8' is recognized as an exit tile");
});

test('repairLevel fixes borders, missing start/exit and connectivity', () => {
  const broken = { name: 'x', rows: ['..........', '..####....', '..#..#....', '..........', '..........', '..........', '..........', '..........', '..........', '.........'] };
  const fixed = repairLevel(broken);
  assert.deepEqual(validateLevel(fixed), []);
  assert.ok(exitReachable(parseLevel(fixed)));
  assert.ok(fixed.rows.every((r) => r.length === fixed.rows[0].length));
});

test('repairLevel keeps a level that only has a skip exit (8) and adds no extra E', () => {
  const rows = [
    '############',
    '#S.........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#.........8#',
    '############',
  ];
  const fixed = repairLevel({ name: 'skip-only', rows });
  const joined = fixed.rows.join('');
  assert.ok(!joined.includes('E'), 'no classic exit should be added');
  assert.equal((joined.match(/8/g) || []).length, 1);
  assert.deepEqual(validateLevel(fixed), []);
});

test('the missing-exit error names both exit tiles', () => {
  const rows = Array.from({ length: 12 }, (_, y) => (y === 0 || y === 11 ? '############' : y === 1 ? '#S.........#' : '#..........#'));
  assert.throws(() => parseLevel({ rows }), /E or 8/);
});
