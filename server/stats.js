// Per-user stat counters + achievement unlocking. Guests have no userId and are skipped.
import { db, now } from './db.js';
import { newlyUnlocked, ACHIEVEMENTS } from '../shared/achievements.js';

const bumpStmt = db.prepare(`INSERT INTO stats (user_id, key, value) VALUES (?, ?, ?)
  ON CONFLICT(user_id, key) DO UPDATE SET value = value + excluded.value RETURNING value`);
const maxStmt = db.prepare(`INSERT INTO stats (user_id, key, value) VALUES (?, ?, ?)
  ON CONFLICT(user_id, key) DO UPDATE SET value = MAX(value, excluded.value) RETURNING value`);
const unlockedStmt = db.prepare('SELECT ach_id FROM achievements WHERE user_id = ?');
const insertAch = db.prepare('INSERT OR IGNORE INTO achievements (user_id, ach_id, unlocked_at) VALUES (?, ?, ?)');

function check(userId, key, value) {
  const have = new Set(unlockedStmt.all(userId).map((r) => r.ach_id));
  const fresh = newlyUnlocked(key, value, have);
  for (const a of fresh) insertAch.run(userId, a.id, now());
  return fresh;
}

/** Increment a counter; returns newly unlocked achievement definitions. */
export function bump(userId, key, n = 1) {
  if (!userId || !n) return [];
  const { value } = bumpStmt.get(userId, key, n);
  return check(userId, key, value);
}

/** Award XP (guests earn nothing). Returns the new total plus any newly unlocked achievements
 *  — the caller compares the total against `amount` to detect a rank-up. */
export function bumpXp(userId, amount) {
  if (!userId) return { value: 0, fresh: [] };
  if (!amount) return { value: getStats(userId).xp || 0, fresh: [] };
  const { value } = bumpStmt.get(userId, 'xp', amount);
  return { value, fresh: check(userId, 'xp', value) };
}

/** Raise a high-water-mark stat; returns newly unlocked achievements. */
export function raise(userId, key, v) {
  if (!userId) return [];
  const { value } = maxStmt.get(userId, key, v);
  return check(userId, key, value);
}

export function getStats(userId) {
  const rows = db.prepare('SELECT key, value FROM stats WHERE user_id = ?').all(userId);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Set of achievement ids this user currently holds — used by shared/unlocks.js requirement checks. */
export function getAchievementIds(userId) {
  if (!userId) return new Set();
  return new Set(unlockedStmt.all(userId).map((r) => r.ach_id));
}

export function getAchievements(userId) {
  const unlocked = Object.fromEntries(db.prepare('SELECT ach_id, unlocked_at FROM achievements WHERE user_id = ?').all(userId).map((r) => [r.ach_id, r.unlocked_at]));
  const stats = getStats(userId);
  return ACHIEVEMENTS.map((a) => ({
    ...a,
    unlocked: unlocked[a.id] || null,
    progress: Math.min(a.threshold, stats[a.stat] || 0),
  }));
}

export function recordRun(userId, run) {
  if (!userId) return;
  db.prepare('INSERT INTO runs (user_id, class, score, level_reached, kills, seconds, ended_at, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, run.cls, run.score, run.level, run.kills, run.seconds, now(), run.mode || 'campaign');
}

export function leaderboard(limit = 20) {
  return {
    scores: db.prepare(`SELECT u.username, r.class, r.score, r.level_reached, r.kills, r.ended_at FROM runs r JOIN users u ON u.id = r.user_id WHERE r.mode = 'campaign' ORDER BY r.score DESC LIMIT ?`).all(limit),
    death: db.prepare(`SELECT u.username, r.class, r.score, r.level_reached, r.kills, r.ended_at FROM runs r JOIN users u ON u.id = r.user_id WHERE r.mode = 'death' ORDER BY r.score DESC LIMIT ?`).all(limit),
    depth: db.prepare(`SELECT u.username, MAX(s.value) AS deepest FROM stats s JOIN users u ON u.id = s.user_id WHERE s.key = 'deepest_level' GROUP BY u.id ORDER BY deepest DESC LIMIT ?`).all(limit),
    kills: db.prepare(`SELECT u.username, s.value AS kills FROM stats s JOIN users u ON u.id = s.user_id WHERE s.key = 'kills' ORDER BY s.value DESC LIMIT ?`).all(limit),
    achievements: db.prepare(`SELECT u.username, COUNT(*) AS n FROM achievements a JOIN users u ON u.id = a.user_id GROUP BY u.id ORDER BY n DESC LIMIT ?`).all(limit),
    rank: db.prepare(`SELECT u.username, s.value AS xp FROM stats s JOIN users u ON u.id = s.user_id WHERE s.key = 'xp' ORDER BY s.value DESC LIMIT ?`).all(limit),
  };
}

export function recentRuns(userId, limit = 10) {
  return db.prepare('SELECT class, score, level_reached, kills, seconds, ended_at FROM runs WHERE user_id = ? ORDER BY ended_at DESC LIMIT ?').all(userId, limit);
}
