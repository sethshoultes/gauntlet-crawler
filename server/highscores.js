// Arcade all-time high scores (#14): a classic three-initial score table, separate from the
// per-account `runs` history in server/stats.js (which skips guests entirely). Every Death mode
// run that ends live (server/game/room.js `endRun()` — the only well-defined "run end" in this
// game; campaign is endless by design, see README) is recorded here regardless of login status,
// and the still-connected clients are told whether their own score just cracked the top 10 so the
// client can show the three-letter initials-entry modal (client/highscore.js).
//
// The run id is a small sequential integer, so it alone is not a capability: without a check,
// anyone could guess or enumerate ids and claim someone else's run within the window. Every insert
// therefore mints a random `claim_token` that only reaches the client that actually owns the run,
// via a private 'hstoken' message sent just to that connection (server/game/room.js endRun(), kept
// out of the room-wide 'gameover' broadcast) -- POST /api/runs/:id/initials must present the
// matching token, compared in constant time, before it may set that row's initials.
import crypto from 'node:crypto';
import { db, now } from './db.js';

const INITIALS_RE = /^[A-Z]{3}$/;
const INITIALS_WINDOW_SECONDS = 5 * 60;

function fail(status, message) { throw Object.assign(new Error(message), { status }); }

/** Constant-time string compare, safe for tokens of unequal or attacker-controlled length (unlike
 *  crypto.timingSafeEqual, which throws on a length mismatch rather than just returning false). */
function tokensMatch(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  return bufA.length === bufB.length && bufA.length > 0 && crypto.timingSafeEqual(bufA, bufB);
}

const insertStmt = db.prepare(`INSERT INTO highscores (user_id, guest_id, username, class, score, level_reached, mode, ended_at, claim_token)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const topScoreValuesStmt = db.prepare('SELECT score FROM highscores ORDER BY score DESC LIMIT ?');
const topStmt = db.prepare('SELECT initials, username, score, class, level_reached, ended_at FROM highscores ORDER BY score DESC, ended_at ASC LIMIT ?');
const getStmt = db.prepare('SELECT id, initials, ended_at, claim_token FROM highscores WHERE id = ?');
const setInitialsStmt = db.prepare('UPDATE highscores SET initials = ?, initials_set_at = ? WHERE id = ?');

/** Pure and unit-testable on its own: would `score` earn a spot in a top-`limit` board that
 *  currently holds `topScores` (plain numbers, any order, at most `limit` of them)? Ties keep the
 *  earlier run (strictly greater beats the current lowest, matching topStmt's `score DESC,
 *  ended_at ASC` ordering above). */
export function qualifiesForHighScore(score, topScores, limit = 10) {
  if (!Number.isFinite(score)) return false;
  const scores = Array.isArray(topScores) ? topScores : [];
  if (scores.length < limit) return true;
  return score > Math.min(...scores);
}

/** Record one run's final score. Always succeeds (guest or logged-in, any score) — the returned
 *  `qualifies` flag is computed against the board as it stood *before* this insert, so the caller
 *  can decide whether to prompt for initials. The returned `token` is the one and only time this
 *  run's claim token is handed back; the caller (server/game/room.js) must relay it only to the
 *  client that owns this run. */
export function recordHighScore({ userId = null, guestId = null, username = null, cls, score, level, mode = 'campaign', endedAt }) {
  const topScores = topScoreValuesStmt.all(10).map((r) => r.score);
  const qualifies = qualifiesForHighScore(score, topScores, 10);
  const token = crypto.randomBytes(16).toString('hex');
  const { lastInsertRowid } = insertStmt.run(userId, guestId, username, cls, Math.max(0, Math.floor(score) || 0), Math.max(1, Math.floor(level) || 1), mode, endedAt ?? now(), token);
  return { id: Number(lastInsertRowid), qualifies, token };
}

/** Top-`limit` all-time board: `{ initials, username, score, class, level_reached, ended_at }[]` —
 *  `initials` is null until someone claims that row, `username` is null for a guest run. */
export function topHighScores(limit = 10) {
  return topStmt.all(limit);
}

/** Claim a run's three-initial entry. Requires the random `token` minted for this run by
 *  recordHighScore() (compared in constant time) so a guessed or enumerated run id alone can't
 *  claim someone else's score — see the module comment above. One shot per run, and only within
 *  INITIALS_WINDOW_SECONDS of the run ending — both enforced here so a stale runId (or a repeat
 *  submit) 409s instead of silently overwriting an earlier entry. */
export function setInitials(id, initials, token) {
  if (!INITIALS_RE.test(String(initials))) fail(400, 'Initials must be exactly three letters, A-Z');
  const row = getStmt.get(Number(id));
  if (!row) fail(404, 'Run not found');
  if (!tokensMatch(token, row.claim_token)) fail(403, 'Invalid or missing claim token');
  if (row.initials) fail(409, 'Initials already recorded for this run');
  if (now() - row.ended_at > INITIALS_WINDOW_SECONDS) fail(409, 'Initials entry window has expired');
  setInitialsStmt.run(initials, now(), row.id);
  return { id: row.id, initials };
}

export { INITIALS_RE, INITIALS_WINDOW_SECONDS };
