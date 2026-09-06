// Unit tests for client/paint-path.js's paintPath() line-interpolation helper (#32), used by the
// Hero Builder pixel editor and the Level Builder tile grid so a fast drag doesn't skip cells.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paintPath } from '../client/paint-path.js';

test('paintPath: same start and end returns a single point', () => {
  assert.deepEqual(paintPath([3, 4], [3, 4]), [[3, 4]]);
});

test('paintPath: horizontal line covers every intermediate cell, in order', () => {
  assert.deepEqual(paintPath([0, 2], [4, 2]), [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2]]);
});

test('paintPath: vertical line covers every intermediate cell', () => {
  assert.deepEqual(paintPath([1, 0], [1, 3]), [[1, 0], [1, 1], [1, 2], [1, 3]]);
});

test('paintPath: reverse direction (horizontal and vertical) still walks every cell', () => {
  assert.deepEqual(paintPath([4, 2], [0, 2]), [[4, 2], [3, 2], [2, 2], [1, 2], [0, 2]]);
  assert.deepEqual(paintPath([1, 3], [1, 0]), [[1, 3], [1, 2], [1, 1], [1, 0]]);
});

test('paintPath: perfect diagonal steps one cell at a time in both axes', () => {
  assert.deepEqual(paintPath([0, 0], [3, 3]), [[0, 0], [1, 1], [2, 2], [3, 3]]);
  assert.deepEqual(paintPath([3, 3], [0, 0]), [[3, 3], [2, 2], [1, 1], [0, 0]]);
});

test('paintPath: a shallow (non-45-degree) line never skips a column — no gaps on a fast drag', () => {
  const pts = paintPath([0, 0], [8, 3]);
  const xs = pts.map((p) => p[0]);
  // every x from 0..8 must appear at least once, and in non-decreasing order (no skipped columns)
  for (let x = 0; x <= 8; x++) assert.ok(xs.includes(x), `missing column ${x} in ${JSON.stringify(pts)}`);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1], 'x must be monotonic along the path');
});

test('paintPath: a steep line never skips a row', () => {
  const pts = paintPath([0, 0], [3, 8]);
  const ys = pts.map((p) => p[1]);
  for (let y = 0; y <= 8; y++) assert.ok(ys.includes(y), `missing row ${y} in ${JSON.stringify(pts)}`);
});

test('paintPath: consecutive points in any path are always adjacent (including diagonally) — no gaps', () => {
  const pts = paintPath([0, 0], [7, 2]);
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = pts[i - 1];
    const [x, y] = pts[i];
    assert.ok(Math.abs(x - px) <= 1 && Math.abs(y - py) <= 1, `gap between ${pts[i - 1]} and ${pts[i]}`);
  }
});
