// Structured JSON logger + a persisted record of error-level events.
//
// Only server/index.js is wired to use this (replacing its one bare `console.error`) — every
// other server module keeps whatever logging it already had. `error()` both prints a JSON line
// and, best-effort, inserts a row into the `errors` table (see server/db.js) so the admin
// dashboard can list recent failures from both the server and the browser.
import { db, now } from './db.js';

let insertErrorStmt = null;
function insertError() {
  if (!insertErrorStmt) insertErrorStmt = db.prepare('INSERT INTO errors (ts, source, message, stack, url, user_id, ua) VALUES (?, ?, ?, ?, ?, ?, ?)');
  return insertErrorStmt;
}

function emit(level, msg, fields) {
  const line = JSON.stringify({ level, ts: new Date().toISOString(), msg, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function info(msg, fields = {}) { emit('info', msg, fields); }
export function warn(msg, fields = {}) { emit('warn', msg, fields); }

/** Log an error line and persist it to the `errors` table. `fields.source` defaults to 'server';
 *  pass 'client' (see recordClientError) for browser-reported errors. Never throws. */
export function error(msg, fields = {}) {
  emit('error', msg, fields);
  try {
    insertError().run(
      now(),
      fields.source === 'client' ? 'client' : 'server',
      String(msg || 'Error').slice(0, 2000),
      fields.stack ? String(fields.stack).slice(0, 4096) : null,
      fields.url ? String(fields.url).slice(0, 500) : null,
      fields.userId || null,
      fields.ua ? String(fields.ua).slice(0, 300) : null,
    );
  } catch { /* logging must never itself crash the request handler */ }
}

/** Store a browser-reported error (POST /api/client-errors in server/index.js). Caller is
 *  responsible for rate limiting and body-size limits before this is invoked. */
export function recordClientError({ message, stack, url, ua } = {}, userId = null) {
  error(String(message || 'Client error').slice(0, 500), { source: 'client', stack, url, ua, userId });
}

export function recentErrors(limit = 100) {
  return db.prepare('SELECT id, ts, source, message, stack, url, user_id, ua FROM errors ORDER BY id DESC LIMIT ?').all(limit);
}
