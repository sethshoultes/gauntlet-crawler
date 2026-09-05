// SQLite connection (node:sqlite, no external driver) and schema migrations. Every other server
// module imports `db`/`now` from here rather than opening its own connection.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'gauntlet.sqlite');

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stats (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS achievements (
  user_id INTEGER NOT NULL,
  ach_id TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ach_id)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  class TEXT NOT NULL,
  score INTEGER NOT NULL,
  level_reached INTEGER NOT NULL,
  kills INTEGER NOT NULL,
  seconds INTEGER NOT NULL,
  ended_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS levels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rows TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'editor',
  prompt TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 0,
  plays INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_score ON runs(score DESC);
CREATE INDEX IF NOT EXISTS levels_pub ON levels(published, plays DESC);
CREATE TABLE IF NOT EXISTS prefs (
  user_id INTEGER PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  guest_id TEXT,
  kind TEXT NOT NULL,
  data TEXT,
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_kind_ts ON events(kind, ts);
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  url TEXT,
  user_id INTEGER,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS errors_ts ON errors(ts DESC);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Idempotent migration: older databases predate the Death mode leaderboard split.
const runsCols = db.prepare('PRAGMA table_info(runs)').all().map((r) => r.name);
if (!runsCols.includes('mode')) db.exec("ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'campaign'");
db.exec('CREATE INDEX IF NOT EXISTS runs_mode_score ON runs(mode, score DESC);');

// Hero Builder (server/heroes.js, shared/hero-builder.js): player-authored custom heroes.
// `stats` is a JSON object of notches (see shared/hero-builder.js STATS), `pixels` a JSON array
// of 8 row-strings. `trait` is '' when none is chosen.
db.exec(`
CREATE TABLE IF NOT EXISTS heroes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  motto TEXT NOT NULL DEFAULT '',
  stats TEXT NOT NULL,
  weapon TEXT NOT NULL,
  trait TEXT NOT NULL DEFAULT '',
  pixels TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  clones INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS heroes_owner ON heroes(owner_id);
CREATE INDEX IF NOT EXISTS heroes_pub ON heroes(published, clones DESC);
`);

// AI narrator commentary (#18, server/ai/narrator.js): generated lines are cached in-process (a
// capped Map) but also persisted here so a restart doesn't re-spend a generation for a cache key
// already answered once. `cache_key` is `${eventType}|${coarse context key}` (e.g.
// "party|warrior,valkyrie", "kill_streak|10") — coarse and non-identifying by construction, never
// a username or chat text (see README.md's AI Narrator section).
db.exec(`
CREATE TABLE IF NOT EXISTS narrator_lines (
  cache_key TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  line TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// Arcade all-time high scores (#14, server/highscores.js): a separate table from `runs` above —
// `runs` is per-account history (guests are never recorded there, see server/stats.js recordRun),
// while this one is the classic-cabinet "everybody's best runs" board, so user_id/guest_id are
// both nullable and `username`/`class` are snapshotted at insert time (a later username change or
// account deletion shouldn't rewrite history on the score table). `initials` starts NULL and is
// filled in once by POST /api/runs/:id/initials within a short window of the run ending — see
// server/highscores.js for the exact rule.
db.exec(`
CREATE TABLE IF NOT EXISTS highscores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  guest_id TEXT,
  username TEXT,
  class TEXT NOT NULL,
  score INTEGER NOT NULL,
  level_reached INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'campaign',
  ended_at INTEGER NOT NULL,
  initials TEXT,
  initials_set_at INTEGER
);
CREATE INDEX IF NOT EXISTS highscores_score ON highscores(score DESC);
`);

export const now = () => Math.floor(Date.now() / 1000);
