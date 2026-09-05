// Accounts: username/password registration (scrypt-hashed), login/logout, and bearer-token
// session lookup. Sessions are opaque tokens in the `sessions` table, not JWTs.
import crypto from 'node:crypto';
import { db, now } from './db.js';

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

export function register(username, password) {
  if (!USERNAME_RE.test(username || '')) throw new Error('Username must be 3-16 letters, digits or underscores');
  if (typeof password !== 'string' || password.length < 6) throw new Error('Password must be at least 6 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  try {
    const r = db.prepare('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)').run(username, hash(password, salt), salt, now());
    return createSession(Number(r.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new Error('That name is taken');
    throw e;
  }
}

export function login(username, password) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!u) throw new Error('Unknown user or wrong password');
  const h = hash(String(password || ''), u.salt);
  if (!crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.pass_hash))) throw new Error('Unknown user or wrong password');
  return createSession(u.id);
}

function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, now());
  const u = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
  return { token, user: u };
}

export function userFromToken(token) {
  if (!token) return null;
  return db.prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token) || null;
}

export function logout(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token || '');
}

export function bearer(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}
