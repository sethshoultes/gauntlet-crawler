// server/stats.js bumpXp: guests (falsy userId) must never touch the database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// stats.js imports server/db.js, which creates a sqlite file under DATA_DIR on import — point it
// at a scratch directory before the (dynamic) import so we never touch the real ./data.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'gauntlet-stats-test-'));
const { bumpXp } = await import('../server/stats.js');
const { db } = await import('../server/db.js');

function statsRowCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM stats').get().n;
}

test('bumpXp(null, amount) is a no-op for guests: no row written, safe return value', () => {
  const before = statsRowCount();
  const result = bumpXp(null, 50);
  assert.equal(statsRowCount(), before, 'no stats row was inserted or updated');
  assert.deepEqual(result, { value: 0, fresh: [] });
});

test('bumpXp(undefined, amount) is also a no-op', () => {
  const before = statsRowCount();
  const result = bumpXp(undefined, 50);
  assert.equal(statsRowCount(), before);
  assert.deepEqual(result, { value: 0, fresh: [] });
});

test('bumpXp with a real userId still writes and returns the running total', () => {
  const before = statsRowCount();
  const result = bumpXp(1, 50);
  assert.equal(statsRowCount(), before + 1, 'a stats row was written for a real user');
  assert.equal(result.value, 50);
  assert.deepEqual(result.fresh, []);
});

process.on('exit', () => { try { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch {} });
