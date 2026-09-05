// Admin dashboard backend. Mounted from server/index.js with a single passthrough line:
//   if (url.pathname.startsWith('/api/admin/')) return admin.handle(req, res, url, user);
// `init(lobby)` is called once at startup so this module can see live rooms without lobby.js
// exposing anything new.
import { db } from './db.js';
import { rankForXp, rankTitle } from '../shared/progression.js';
import { recentErrors } from './log.js';
import { analytics } from './telemetry.js';

let lobby = null;
export function init(lobbyInstance) { lobby = lobbyInstance; }

/** Admins are whoever is listed (by username) in GAUNTLET_ADMINS, comma-separated — or, when
 *  that env var is unset entirely, whichever account registered first (user id 1). This means a
 *  fresh install always has exactly one admin (its first user) with no configuration required,
 *  while a deployed instance can name real admins explicitly. See README's Admin section. */
export function isAdmin(user) {
  if (!user) return false;
  const raw = process.env.GAUNTLET_ADMINS;
  if (raw && raw.trim()) {
    const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return names.includes(user.username);
  }
  return user.id === 1;
}

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

export async function handle(req, res, url, user) {
  if (!isAdmin(user)) return json(res, 403, { error: 'Admin access required' });
  const seg = url.pathname.split('/').filter(Boolean); // ['api', 'admin', ...]
  const m = req.method;

  if (m === 'GET' && seg[2] === 'overview') {
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const runs = db.prepare('SELECT COUNT(*) AS n FROM runs').get().n;
    const levels = db.prepare('SELECT COUNT(*) AS n FROM levels').get().n;
    const rooms = lobby ? [...lobby.rooms.values()].map((r) => r.info()) : [];
    return json(res, 200, { users, runs, levels, rooms });
  }

  if (m === 'GET' && seg[2] === 'users') {
    const q = `%${(url.searchParams.get('search') || '').slice(0, 60)}%`;
    const rows = db.prepare(`
      SELECT u.id, u.username, u.created_at,
        COALESCE((SELECT value FROM stats s WHERE s.user_id = u.id AND s.key = 'xp'), 0) AS xp,
        (SELECT MAX(ended_at) FROM runs r WHERE r.user_id = u.id) AS last_run
      FROM users u WHERE u.username LIKE ? ORDER BY u.id ASC LIMIT 200
    `).all(q);
    const out = rows.map((r) => { const rank = rankForXp(r.xp); return { ...r, rank, rankTitle: rankTitle(rank) }; });
    return json(res, 200, { users: out });
  }

  if (m === 'GET' && seg[2] === 'levels') {
    const q = `%${(url.searchParams.get('search') || '').slice(0, 60)}%`;
    const rows = db.prepare(`
      SELECT l.id, l.name, l.published, l.plays, l.created_at, l.updated_at, u.username AS author, l.owner_id
      FROM levels l JOIN users u ON u.id = l.owner_id
      WHERE l.name LIKE ? OR u.username LIKE ? ORDER BY l.updated_at DESC LIMIT 200
    `).all(q, q);
    return json(res, 200, { levels: rows });
  }

  if (m === 'POST' && seg[2] === 'levels' && seg[3] && seg[4] === 'unpublish') {
    const id = Number(seg[3]);
    const row = db.prepare('SELECT id FROM levels WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Level not found' });
    db.prepare('UPDATE levels SET published = 0 WHERE id = ?').run(id);
    return json(res, 200, { ok: true });
  }

  if (m === 'DELETE' && seg[2] === 'levels' && seg[3]) {
    const id = Number(seg[3]);
    const row = db.prepare('SELECT id FROM levels WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Level not found' });
    db.prepare('DELETE FROM levels WHERE id = ?').run(id);
    return json(res, 200, { ok: true });
  }

  if (m === 'GET' && seg[2] === 'errors') {
    return json(res, 200, { errors: recentErrors(200) });
  }

  if (m === 'GET' && seg[2] === 'analytics') {
    return json(res, 200, analytics());
  }

  if (m === 'POST' && seg[2] === 'rooms' && seg[3] && seg[4] === 'close') {
    const room = lobby?.get(seg[3]);
    if (!room) return json(res, 404, { error: 'Room not found' });
    room.close();
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'No such admin endpoint' });
}
