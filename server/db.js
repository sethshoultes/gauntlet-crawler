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
`);

// Idempotent migration: older databases predate the Death mode leaderboard split.
const runsCols = db.prepare('PRAGMA table_info(runs)').all().map((r) => r.name);
if (!runsCols.includes('mode')) db.exec("ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'campaign'");
db.exec('CREATE INDEX IF NOT EXISTS runs_mode_score ON runs(mode, score DESC);');

export const now = () => Math.floor(Date.now() / 1000);
