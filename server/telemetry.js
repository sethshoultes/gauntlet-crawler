// First-party analytics: a single `events` table fed two ways —
//  1. server/index.js calls recordEvent() directly at a few WebSocket-protocol boundaries
//     (join/leave/start/gameover) without this module ever touching server/game/*.
//  2. the browser posts small beacons to POST /api/telemetry (see client/common.js `track()`),
//     which server/index.js forwards here via recordClient() after its own rate limiting.
//
// Privacy: raw IPs are never stored. Every event's IP is SHA-256 hashed together with a salt
// that is either read from GAUNTLET_SALT or generated once and persisted in the `meta` table, so
// hashes stay stable across restarts without ever writing the real salt to disk in the clear...
// (well, it *is* in the sqlite file, same trust boundary as password hashes) but never logged.
import crypto from 'node:crypto';
import { db, now } from './db.js';

function loadOrCreateSalt() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'telemetry_salt'").get();
  if (row) return row.value;
  const salt = process.env.GAUNTLET_SALT || crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('telemetry_salt', salt);
  return salt;
}
let SALT = null;
function salt() { if (!SALT) SALT = loadOrCreateSalt(); return SALT; }

export function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(String(ip) + ':' + salt()).digest('hex');
}

const insertEvent = db.prepare('INSERT INTO events (ts, user_id, guest_id, kind, data, ip_hash) VALUES (?, ?, ?, ?, ?, ?)');

/** Record one event. Best-effort: telemetry must never be able to break the request/WS handler
 *  that calls it. */
export function recordEvent({ kind, userId = null, guestId = null, data = null, ip = null } = {}) {
  if (!kind) return;
  try {
    insertEvent.run(
      now(),
      userId || null,
      guestId ? String(guestId).slice(0, 64) : null,
      String(kind).slice(0, 40),
      data ? JSON.stringify(data).slice(0, 4000) : null,
      ip ? hashIp(ip) : null,
    );
  } catch { /* never throw from telemetry */ }
}

const CLIENT_KINDS = new Set(['pageview', 'session_start', 'level_reached', 'run_end', 'error']);

/** Handle a POST /api/telemetry body. Throws a 400-tagged error for an unrecognized kind; the
 *  caller (server/index.js) is expected to have already rate-limited by IP. */
export function recordClient(body, { user, ip } = {}) {
  const kind = body && CLIENT_KINDS.has(body.kind) ? body.kind : null;
  if (!kind) throw Object.assign(new Error('Unknown telemetry kind'), { status: 400 });
  const guestId = typeof body.guestId === 'string' ? body.guestId : null;
  const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : null;
  recordEvent({ kind, userId: user?.id || null, guestId, data, ip });
}

/** Aggregations backing the admin analytics tab. Cheap enough to compute on demand (no
 *  materialized rollups) at this project's scale. */
export function analytics() {
  const since30 = now() - 30 * 86400;
  const activeKinds = ['pageview', 'session_start'];
  const placeholders = activeKinds.map(() => '?').join(',');
  const dau = db.prepare(
    `SELECT date(ts, 'unixepoch') AS day, COUNT(DISTINCT user_id) AS n FROM events
     WHERE user_id IS NOT NULL AND ts >= ? AND kind IN (${placeholders}) GROUP BY day ORDER BY day`
  ).all(since30, ...activeKinds);
  const guestDau = db.prepare(
    `SELECT date(ts, 'unixepoch') AS day, COUNT(DISTINCT guest_id) AS n FROM events
     WHERE guest_id IS NOT NULL AND ts >= ? AND kind IN (${placeholders}) GROUP BY day ORDER BY day`
  ).all(since30, ...activeKinds);
  const runsPerDay = db.prepare(
    `SELECT date(ended_at, 'unixepoch') AS day, COUNT(*) AS n FROM runs WHERE ended_at >= ? GROUP BY day ORDER BY day`
  ).all(since30);
  const avgRunLength = db.prepare('SELECT AVG(seconds) AS avg FROM runs').get().avg || 0;
  const depthHist = db.prepare(
    `SELECT (level_reached / 5) * 5 AS bucket, COUNT(*) AS n FROM runs GROUP BY bucket ORDER BY bucket`
  ).all();
  const topLevels = db.prepare(
    `SELECT l.id, l.name, l.plays, u.username AS author FROM levels l JOIN users u ON u.id = l.owner_id
     WHERE l.published = 1 ORDER BY l.plays DESC LIMIT 10`
  ).all();
  const heroPickRates = db.prepare(`SELECT class, COUNT(*) AS n FROM runs GROUP BY class ORDER BY n DESC`).all();
  return { dau, guestDau, runsPerDay, avgRunLength, depthHist, topLevels, heroPickRates };
}

let retentionTimer = null;
/** Delete events older than `days` once at startup and once a day thereafter. `.unref()`ed so it
 *  never keeps the process alive on its own. Idempotent — a second call is a no-op. */
export function startRetentionJob(days = 90) {
  if (retentionTimer) return retentionTimer;
  const sweep = () => { try { db.prepare('DELETE FROM events WHERE ts < ?').run(now() - days * 86400); } catch {} };
  sweep();
  retentionTimer = setInterval(sweep, 24 * 60 * 60 * 1000);
  retentionTimer.unref?.();
  return retentionTimer;
}
