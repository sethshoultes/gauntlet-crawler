// Settings-page account operations: password change (with session rotation), account deletion
// (with cascading cleanup), and a small JSON preferences blob. Kept in its own module so
// server/index.js only needs to add a handful of route lines that call into here.
import crypto from 'node:crypto';
import { db, now } from './db.js';

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password ?? ''), salt, 32).toString('hex');
}

function passwordMatches(userRow, password) {
  try {
    const candidate = Buffer.from(hashPassword(password, userRow.salt));
    const stored = Buffer.from(userRow.pass_hash);
    return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
  } catch { return false; }
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

/** Verify `current`, set a new password hash/salt, and drop every *other* session for this user —
 *  the caller's own current session token (`currentToken`) is kept alive so they aren't logged
 *  out by changing their own password. */
export function changePassword(userId, currentToken, current, next) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) throw httpError(404, 'User not found');
  if (!passwordMatches(row, current)) throw httpError(400, 'Current password is incorrect');
  if (typeof next !== 'string' || next.length < 6) throw httpError(400, 'New password must be at least 6 characters');
  const newSalt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hashPassword(next, newSalt), newSalt, userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(userId, currentToken || '');
  return { ok: true };
}

/** Delete the account and everything that points at it: sessions, stat counters, achievements,
 *  run history, owned levels (which also unpublishes them — a deleted row can't be listed) and
 *  saved preferences, then the user row itself. Requires the current password. */
export function deleteAccount(userId, password) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) throw httpError(404, 'User not found');
  if (!passwordMatches(row, password)) throw httpError(400, 'Password is incorrect');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM stats WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM achievements WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM runs WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM levels WHERE owner_id = ?').run(userId);
  db.prepare('DELETE FROM prefs WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  return { ok: true };
}

export function getPrefs(userId) {
  const row = db.prepare('SELECT json FROM prefs WHERE user_id = ?').get(userId);
  if (!row) return {};
  try { return JSON.parse(row.json); } catch { return {}; }
}

// Whitelisted so an arbitrary blob can't grow unbounded or smuggle unrelated data in.
// soundVolume doubles as the "master" bus for backward compatibility with existing saved prefs;
// sfxVolume/voiceVolume are the other two mixer buses (see client/audio.js / client/voice.js).
const PREF_KEYS = ['soundVolume', 'sfxVolume', 'voiceVolume', 'narrator', 'keyBindings', 'colorBlindPalette', 'reducedMotion', 'cutscenes'];

export function setPrefs(userId, body) {
  const clean = {};
  const src = body && typeof body === 'object' ? body : {};
  for (const k of PREF_KEYS) if (k in src) clean[k] = src[k];
  const json = JSON.stringify(clean).slice(0, 8000);
  db.prepare(`INSERT INTO prefs (user_id, json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(userId, json, now());
  return clean;
}

/** Everything GDPR-ish "download my data" ought to include: profile, counters, achievements,
 *  run history, owned levels (published or not) and preferences. */
export function exportData(userId) {
  const user = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(userId);
  const stats = Object.fromEntries(db.prepare('SELECT key, value FROM stats WHERE user_id = ?').all(userId).map((r) => [r.key, r.value]));
  const achievements = db.prepare('SELECT ach_id, unlocked_at FROM achievements WHERE user_id = ?').all(userId);
  const runs = db.prepare('SELECT class, score, level_reached, kills, seconds, ended_at, mode FROM runs WHERE user_id = ?').all(userId);
  const levels = db.prepare('SELECT id, name, description, source, published, plays, created_at, updated_at FROM levels WHERE owner_id = ?').all(userId);
  const prefs = getPrefs(userId);
  return { user, stats, achievements, runs, levels, prefs, exportedAt: now() };
}
