// Unit tests for server/account.js's deleteAccount(): the cascade of deletes/updates must be
// atomic — a failure partway through must not leave the account half-deleted. Imports server/db.js
// directly against a scratch DB, same in-process pattern as test/room.test.js (rather than
// spawning the whole HTTP server, since this test needs to monkey-patch db.prepare to force a
// mid-cascade failure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'gauntlet-account-test-'));
const { db, now } = await import('../server/db.js');
const { deleteAccount } = await import('../server/account.js');

const PASSWORD = 'hunter22';
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 32).toString('hex'); }

function makeUserWithSession() {
  const salt = crypto.randomBytes(16).toString('hex');
  const r = db.prepare('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)')
    .run(`doomed_${crypto.randomBytes(4).toString('hex')}`, hashPassword(PASSWORD, salt), salt, now());
  const userId = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(crypto.randomBytes(8).toString('hex'), userId, now());
  return userId;
}

test('deleteAccount() commits the whole cascade on success', () => {
  const userId = makeUserWithSession();
  const result = deleteAccount(userId, PASSWORD);
  assert.deepEqual(result, { ok: true });
  assert.equal(db.prepare('SELECT id FROM users WHERE id = ?').get(userId), undefined);
  assert.equal(db.prepare('SELECT token FROM sessions WHERE user_id = ?').get(userId), undefined);
});

test('a failure mid-cascade rolls back and leaves the account fully intact', () => {
  const userId = makeUserWithSession();
  const realPrepare = db.prepare.bind(db);
  // Force the DELETE FROM heroes step (partway through the cascade, after sessions/stats/
  // achievements/runs/levels have already been deleted in-transaction) to throw.
  db.prepare = (sql) => {
    if (sql.includes('DELETE FROM heroes')) throw new Error('forced failure mid-cascade');
    return realPrepare(sql);
  };
  try {
    assert.throws(() => deleteAccount(userId, PASSWORD), /forced failure mid-cascade/);
  } finally {
    db.prepare = realPrepare;
  }
  // Nothing should have been committed: the user row and its earlier-in-the-cascade session
  // must both still be there, proving the transaction rolled back rather than leaving a
  // half-deleted account.
  assert.ok(db.prepare('SELECT id FROM users WHERE id = ?').get(userId), 'user row should survive a rolled-back cascade');
  assert.ok(db.prepare('SELECT token FROM sessions WHERE user_id = ?').get(userId), 'session deleted earlier in the same transaction should be rolled back too');
});
