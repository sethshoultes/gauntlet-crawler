// Settings-page account operations: password change (keeps the current session, revokes all
// others), account deletion
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
 *  run history, owned levels (which also unpublishes them — a deleted row can't be listed),
 *  owned custom heroes (server/heroes.js) and saved preferences, then the user row itself.
 *  Requires the current password.
 *
 *  `events` (server/telemetry.js) and `errors` (server/log.js) are NOT deleted, only
 *  de-identified (user_id -> NULL): every other table here holds the user's own content or
 *  1:1 account state, but these two are aggregate/operational logs — deleting rows out from
 *  under them would quietly corrupt historical DAU/analytics counts and error-rate history for
 *  days the account was active. Nulling user_id removes the link back to the deleted account
 *  (nothing in either table is personally identifying beyond that: IPs are already hashed with a
 *  salt, see server/telemetry.js hashIp) while leaving the aggregate counts intact, and both
 *  tables already age out under their own retention policy (events: startRetentionJob, 90 days). */
export function deleteAccount(userId, password) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) throw httpError(404, 'User not found');
  if (!passwordMatches(row, password)) throw httpError(400, 'Password is incorrect');
  // Wrap the whole cascade in one transaction: if any statement throws partway through (a
  // constraint error, a crash-prone edge case, whatever), the account must not end up
  // half-deleted (e.g. levels gone but the user row and sessions still there).
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM stats WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM achievements WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM runs WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM levels WHERE owner_id = ?').run(userId);
    db.prepare('DELETE FROM heroes WHERE owner_id = ?').run(userId);
    db.prepare('DELETE FROM prefs WHERE user_id = ?').run(userId);
    db.prepare('UPDATE events SET user_id = NULL WHERE user_id = ?').run(userId);
    db.prepare('UPDATE errors SET user_id = NULL WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
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

// Per-field shape for each whitelisted key: volumes are finite numbers in 0..100 (percent), the boolean
// toggles are strict booleans, and keyBindings is a small flat map of short strings (action name
// -> key label). Keys outside PREF_KEYS are dropped; a whitelisted key whose value fails its
// validator rejects the whole request with HTTP 400 (nothing is written), so a malformed value
// can't silently corrupt a player's saved settings or bloat the row.
const PREF_MAX_JSON_BYTES = 8000;
const KEY_BINDING_VALUE_MAX = 32;
const KEY_BINDINGS_MAX_ENTRIES = 64;

// The client (client/settings.js) sends these as 0-100 percentages (range-input sliders,
// min=0/max=100 in settings.html), not a 0..1 fraction, so that's the range validated here.
function isVolume(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100; }
function isBool(v) { return typeof v === 'boolean'; }
function isKeyBindings(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  if (entries.length > KEY_BINDINGS_MAX_ENTRIES) return false;
  return entries.every(([k, val]) => typeof k === 'string' && k.length <= KEY_BINDING_VALUE_MAX && typeof val === 'string' && val.length <= KEY_BINDING_VALUE_MAX);
}

const PREF_VALIDATORS = {
  soundVolume: isVolume,
  sfxVolume: isVolume,
  voiceVolume: isVolume,
  narrator: isBool,
  colorBlindPalette: isBool,
  reducedMotion: isBool,
  cutscenes: isBool,
  keyBindings: isKeyBindings,
};

export function setPrefs(userId, body) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  // Reject an oversized body up front rather than truncating it: truncating the serialized JSON
  // can cut mid-token and later parse as `{}`, silently wiping every previously saved preference.
  // Measure bytes, not UTF-16 code units: multibyte characters would otherwise slip past the cap.
  if (Buffer.byteLength(JSON.stringify(src), 'utf8') > PREF_MAX_JSON_BYTES) throw httpError(400, 'Preferences payload is too large');
  const clean = {};
  for (const k of PREF_KEYS) {
    if (!(k in src)) continue;
    const validate = PREF_VALIDATORS[k];
    if (validate && !validate(src[k])) throw httpError(400, `Invalid value for preference "${k}"`);
    clean[k] = src[k];
  }
  const json = JSON.stringify(clean);
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
