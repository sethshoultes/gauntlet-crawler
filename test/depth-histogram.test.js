// server/telemetry.js analytics() depthHist bucketing: level_reached buckets into 0/5/10/...
// using integer division. Regression test for the review finding that the bucket expression's
// comment claimed ambiguous REAL division — `level_reached` is INTEGER so SQLite's `/` was
// already integer division, but the query is now explicit (CAST ... AS INTEGER) rather than
// relying on the column's declared type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'gauntlet-depthhist-test-'));
const { db, now } = await import('../server/db.js');
const { analytics } = await import('../server/telemetry.js');

db.prepare('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)').run('depthhist_user', 'x', 'y', now());
const userId = db.prepare('SELECT id FROM users WHERE username = ?').get('depthhist_user').id;

const insertRun = db.prepare(`INSERT INTO runs (user_id, class, score, level_reached, kills, seconds, ended_at, mode)
  VALUES (?, 'warrior', 0, ?, 0, 0, ?, 'campaign')`);
for (const level of [7, 9, 12]) insertRun.run(userId, level, now());

test('depthHist buckets levels 7 and 9 into 5, and level 12 into 10', () => {
  const { depthHist } = analytics();
  const byBucket = Object.fromEntries(depthHist.map((r) => [r.bucket, r.n]));
  assert.equal(byBucket[5], 2, 'levels 7 and 9 should both fall in the 5 bucket');
  assert.equal(byBucket[10], 1, 'level 12 should fall in the 10 bucket');
  assert.equal(byBucket[0], undefined, 'no run landed in the 0 bucket');
});

process.on('exit', () => { try { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch {} });
