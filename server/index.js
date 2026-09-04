import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { db, now } from './db.js';
import * as auth from './auth.js';
import * as stats from './stats.js';
import { Lobby } from './game/lobby.js';
import { generateFromPrompt, aiAvailable } from './ai/levelgen.js';
import { validateLevel, parseLevel } from '../shared/level.js';
import { CLASSES } from '../shared/constants.js';
import { generateLevel } from '../shared/procgen.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const PORT = Number(process.env.PORT || 3000);
const lobby = new Lobby();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ---------- tiny helpers ----------
function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now(); const b = buckets.get(key) || [];
  const recent = b.filter((x) => t - x < windowMs);
  if (recent.length >= max) { buckets.set(key, recent); return false; }
  recent.push(t); buckets.set(key, recent); return true;
}
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/') rel = '/index.html';
  const base = rel.startsWith('/shared/') ? ROOT : path.join(ROOT, 'client');
  const file = path.normalize(path.join(base, rel.startsWith('/shared/') ? rel : rel));
  if (!file.startsWith(base)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------- REST API ----------
async function api(req, res, url) {
  const user = auth.userFromToken(auth.bearer(req));
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const m = req.method;
  const need = () => { if (!user) throw Object.assign(new Error('Login required'), { status: 401 }); return user; };

  if (m === 'POST' && url.pathname === '/api/register') { const b = await readBody(req); return json(res, 200, auth.register(b.username, b.password)); }
  if (m === 'POST' && url.pathname === '/api/login') { const b = await readBody(req); return json(res, 200, auth.login(b.username, b.password)); }
  if (m === 'POST' && url.pathname === '/api/logout') { auth.logout(auth.bearer(req)); return json(res, 200, { ok: true }); }
  if (m === 'GET' && url.pathname === '/api/me') {
    if (!user) return json(res, 200, { user: null });
    return json(res, 200, { user, stats: stats.getStats(user.id), achievements: stats.getAchievements(user.id), runs: stats.recentRuns(user.id) });
  }
  if (m === 'GET' && url.pathname === '/api/leaderboard') return json(res, 200, stats.leaderboard(20));
  if (m === 'GET' && url.pathname === '/api/rooms') return json(res, 200, { rooms: lobby.list() });
  if (m === 'GET' && url.pathname === '/api/ai/status') return json(res, 200, { available: aiAvailable() });

  // ----- levels -----
  if (m === 'GET' && url.pathname === '/api/levels') {
    const rows = db.prepare(`SELECT l.id, l.name, l.description, l.source, l.plays, l.created_at, u.username AS author FROM levels l JOIN users u ON u.id = l.owner_id WHERE l.published = 1 ORDER BY l.plays DESC, l.created_at DESC LIMIT 100`).all();
    return json(res, 200, { levels: rows });
  }
  if (m === 'GET' && url.pathname === '/api/levels/mine') {
    const u = need();
    const rows = db.prepare('SELECT id, name, description, source, published, plays, created_at, updated_at FROM levels WHERE owner_id = ? ORDER BY updated_at DESC').all(u.id);
    return json(res, 200, { levels: rows });
  }
  if (m === 'POST' && url.pathname === '/api/levels/validate') {
    const b = await readBody(req);
    return json(res, 200, { problems: validateLevel(b) });
  }
  if (m === 'POST' && url.pathname === '/api/levels/procgen') {
    const b = await readBody(req);
    const level = generateLevel({ seed: String(b.seed || crypto.randomBytes(2).toString('hex')), level: Math.max(1, Math.min(60, Number(b.level) || 3)) });
    return json(res, 200, { level });
  }
  if (m === 'POST' && url.pathname === '/api/levels/generate') {
    const ip = req.socket.remoteAddress || 'x';
    if (!rateLimit('gen:' + (user ? 'u' + user.id : ip), 6, 60_000)) return json(res, 429, { error: 'Slow down: 6 generations per minute' });
    const b = await readBody(req);
    const out = await generateFromPrompt({ prompt: b.prompt, difficulty: Math.max(1, Math.min(10, Number(b.difficulty) || 3)), size: ['small', 'medium', 'large'].includes(b.size) ? b.size : 'medium' });
    let unlocked = [];
    if (user && out.source === 'ai') unlocked = stats.bump(user.id, 'ai_levels');
    return json(res, 200, { ...out, unlocked });
  }
  if (m === 'POST' && url.pathname === '/api/levels') {
    const u = need();
    const b = await readBody(req);
    const problems = validateLevel(b);
    if (problems.length) return json(res, 400, { error: problems[0], problems });
    const lvl = parseLevel(b);
    const rows = JSON.stringify(lvl.rows);
    const source = ['editor', 'ai', 'procedural'].includes(b.source) ? b.source : 'editor';
    if (b.id) {
      const own = db.prepare('SELECT id FROM levels WHERE id = ? AND owner_id = ?').get(Number(b.id), u.id);
      if (!own) return json(res, 404, { error: 'Level not found' });
      db.prepare('UPDATE levels SET name = ?, description = ?, rows = ?, source = ?, prompt = ?, updated_at = ? WHERE id = ?').run(lvl.name, lvl.description, rows, source, String(b.prompt || '').slice(0, 600), now(), Number(b.id));
      return json(res, 200, { id: Number(b.id) });
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM levels WHERE owner_id = ?').get(u.id).n;
    if (count >= 50) return json(res, 400, { error: 'Level limit reached (50)' });
    const r = db.prepare('INSERT INTO levels (owner_id, name, description, rows, source, prompt, published, plays, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)').run(u.id, lvl.name, lvl.description, rows, source, String(b.prompt || '').slice(0, 600), now(), now());
    return json(res, 200, { id: Number(r.lastInsertRowid) });
  }
  if (seg[0] === 'api' && seg[1] === 'levels' && seg[2]) {
    const id = Number(seg[2]);
    const row = db.prepare('SELECT l.*, u.username AS author FROM levels l JOIN users u ON u.id = l.owner_id WHERE l.id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Level not found' });
    const level = { id: row.id, name: row.name, description: row.description, rows: JSON.parse(row.rows), source: row.source, prompt: row.prompt, published: !!row.published, plays: row.plays, author: row.author, owner_id: row.owner_id };
    if (m === 'GET' && !seg[3]) {
      if (!level.published && level.owner_id !== user?.id) return json(res, 403, { error: 'This level is private' });
      return json(res, 200, { level });
    }
    if (m === 'POST' && seg[3] === 'publish') {
      const u = need(); if (row.owner_id !== u.id) return json(res, 403, { error: 'Not yours' });
      const pub = !row.published;
      db.prepare('UPDATE levels SET published = ?, updated_at = ? WHERE id = ?').run(pub ? 1 : 0, now(), id);
      const unlocked = pub ? stats.bump(u.id, 'levels_published') : [];
      return json(res, 200, { published: pub, unlocked });
    }
    if (m === 'DELETE' && !seg[3]) {
      const u = need(); if (row.owner_id !== u.id) return json(res, 403, { error: 'Not yours' });
      db.prepare('DELETE FROM levels WHERE id = ?').run(id);
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && seg[3] === 'play') {
      if (!level.published && level.owner_id !== user?.id) return json(res, 403, { error: 'This level is private' });
      const b = await readBody(req);
      const room = lobby.create({ name: b.name || level.name, source: { type: 'custom', levelId: level.id, level: { name: level.name, description: level.description, rows: level.rows } }, isPublic: b.public !== false });
      return json(res, 200, { room: room.info() });
    }
  }
  if (m === 'POST' && url.pathname === '/api/rooms') {
    const b = await readBody(req);
    let source = { type: 'campaign' };
    if (b.level) {
      // Test-play an unsaved level straight from the editor.
      const problems = validateLevel(b.level);
      if (problems.length) return json(res, 400, { error: problems[0], problems });
      const lvl = parseLevel(b.level);
      source = { type: 'custom', levelId: Number(b.levelId) || null, level: { name: lvl.name, description: lvl.description, rows: lvl.rows } };
    }
    const room = lobby.create({ name: b.name, isPublic: b.public !== false, source });
    return json(res, 200, { room: room.info() });
  }
  json(res, 404, { error: 'No such endpoint' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try { await api(req, res, url); }
    catch (e) { json(res, e.status || 400, { error: e.message }); }
    return;
  }
  serveStatic(req, res, url.pathname);
});

// ---------- WebSocket game protocol ----------
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const pid = crypto.randomBytes(4).toString('hex');
  let room = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    try {
      switch (msg.t) {
        case 'join': {
          if (room) { room.leave(pid); room = null; }
          const user = auth.userFromToken(msg.token);
          const cls = CLASSES[msg.cls] ? msg.cls : 'warrior';
          const name = user ? user.username : String(msg.name || 'Guest').replace(/[^\w ]/g, '').slice(0, 12) || 'Guest';
          let target = msg.roomId ? lobby.get(msg.roomId) : null;
          if (msg.roomId && !target) throw new Error('That room no longer exists');
          if (!target) target = msg.create ? lobby.create({ name: msg.roomName, isPublic: msg.public !== false }) : lobby.quick();
          target.join(ws, { pid, user, name, cls });
          room = target;
          break;
        }
        case 'input': if (room) room.handleInput(pid, msg); break;
        case 'chat': if (room) room.chat(pid, msg.text); break;
        case 'leave': if (room) { room.leave(pid); room = null; send({ t: 'left' }); } break;
        case 'rooms': send({ t: 'rooms', rooms: lobby.list() }); break;
        case 'ping': send({ t: 'pong', ts: msg.ts }); break;
      }
    } catch (e) { send({ t: 'error', error: e.message }); }
  });
  ws.on('close', () => { if (room) room.leave(pid); });
});
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); } }, 30000);

server.listen(PORT, () => {
  console.log(`Gauntlet Crawler listening on http://localhost:${PORT}  (AI level builder: ${aiAvailable() ? 'Claude' : 'procedural fallback — set ANTHROPIC_API_KEY'})`);
});
