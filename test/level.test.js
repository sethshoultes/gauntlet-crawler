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

test('repairLevel fixes borders, missing start/exit and connectivity', () => {
  const broken = { name: 'x', rows: ['..........', '..####....', '..#..#....', '..........', '..........', '..........', '..........', '..........', '..........', '.........'] };
  const fixed = repairLevel(broken);
  assert.deepEqual(validateLevel(fixed), []);
  assert.ok(exitReachable(parseLevel(fixed)));
  assert.ok(fixed.rows.every((r) => r.length === fixed.rows[0].length));
});
