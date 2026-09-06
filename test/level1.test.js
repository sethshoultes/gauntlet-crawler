import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLevel, validateLevel, exitReachable } from '../shared/level.js';
import { LEVEL1 } from '../shared/levels/level1.js';

// #48: the shipped LEVEL1 had its only key sealed in a walled vault with no door or gap, so the
// level could never be completed. These tests pin the fixed layout (a gap in the vault wall plus
// two extra keys placed on open floor) and, separately, prove the *old* sealed-vault layout is now
// caught by validateLevel's key-aware exitReachable() — it wasn't, before this fix, since the old
// rule treated every door as passable the instant any key existed anywhere in the level.

test('LEVEL1 is solvable: no validation problems and the exit is reachable', () => {
  assert.deepEqual(validateLevel(LEVEL1), []);
  assert.ok(exitReachable(parseLevel(LEVEL1)));
});

test('every key in LEVEL1 sits in the floor plan reachable from the start once all doors are open', () => {
  // A weaker, easier-to-eyeball sanity check than exitReachable() itself: with every door treated
  // as passable, is each key at least in the same connected component as the start? (Not sufficient
  // for solvability on its own — see the key-gated tests below — but a sealed vault like the
  // original bug fails even this weaker bar.)
  const rows = LEVEL1.rows;
  const w = rows[0].length, h = rows.length;
  const seen = new Uint8Array(w * h);
  const [sx, sy] = (() => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (rows[y][x] === 'S') return [x, y]; })();
  const q = [[sx, sy]];
  seen[sy * w + sx] = 1;
  for (let head = 0; head < q.length; head++) {
    const [x, y] = q[head];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (rows[ny][nx] === '#') continue;
      const i = ny * w + nx;
      if (seen[i]) continue;
      seen[i] = 1;
      q.push([nx, ny]);
    }
  }
  let keyCount = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rows[y][x] !== 'K') continue;
    keyCount++;
    assert.ok(seen[y * w + x], `key at (${x},${y}) must be reachable with every door open`);
  }
  assert.ok(keyCount >= 3, 'the fix adds two extra keys alongside the original vault key');
});

test('the original sealed-vault LEVEL1 layout (#48) is rejected by validateLevel', () => {
  // Reconstruct the pre-fix layout: the vault wall fully closed (no gap at row 11) and only the
  // one key that used to sit inside it (drop the two extra keys the fix adds elsewhere).
  const rows = LEVEL1.rows.slice();
  const vaultRow = rows.findIndex((r) => r === '#.T..#..#.g..#.......#..#......#');
  assert.ok(vaultRow >= 0, 'sanity: found the vault row this fix opened');
  rows[vaultRow] = '#.T..#..#.g..#.......####......#'; // reseal the vault
  const extraKeyRow1 = rows.findIndex((r) => r === '#.........................K....#');
  const extraKeyRow2 = rows.findIndex((r) => r === '#.K................######......#');
  assert.ok(extraKeyRow1 >= 0 && extraKeyRow2 >= 0, 'sanity: found the two rows the fix added keys to');
  rows[extraKeyRow1] = '#.........................K....#'.replace('K', '.');
  rows[extraKeyRow2] = '#.K................######......#'.replace('K', '.');

  const problems = validateLevel({ rows });
  assert.match(problems[0], /not reachable/);
  assert.ok(!exitReachable(parseLevel({ rows })));
});
