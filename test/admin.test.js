// Admin dashboard backend (server/admin.js), mounted from server/index.js under /api/admin/*.
// Boots the real server as a child process against a fresh temp DB (like test/server-static.test.js)
// so "user id 1 is the default admin" and session/db state start from nothing every run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function waitForServer(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      fetch(url).then(resolve).catch((err) => {
        if (Date.now() > deadline) return reject(err);
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

async function withServer(env, fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'gauntlet-admin-test-'));
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d.toString(); });
  server.stderr.on('data', (d) => { out += d.toString(); });
  const exit = once(server, 'exit');
  try {
    await Promise.race([waitForServer(baseUrl), exit.then(([c]) => { throw new Error(`server exited early (${c}):\n${out}`); })]);
    await fn(baseUrl);
  } finally {
    if (server.exitCode === null && server.pid) { try { process.kill(server.pid, 'SIGTERM'); } catch {} }
    await once(server, 'exit').catch(() => {});
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function register(baseUrl, username, password = 'hunter22') {
  const res = await fetch(`${baseUrl}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200, `register ${username} should succeed`);
  return res.json(); // { token, user }
}

function authed(token) { return { Authorization: `Bearer ${token}` }; }

test('first registered user (id 1) is admin by default; a later user is not', async () => {
  await withServer({}, async (baseUrl) => {
    const first = await register(baseUrl, 'admin_one');
    const second = await register(baseUrl, 'plain_two');
    assert.equal(first.user.id, 1);

    const meFirst = await fetch(`${baseUrl}/api/me`, { headers: authed(first.token) }).then((r) => r.json());
    assert.equal(meFirst.isAdmin, true, 'first user should be flagged admin in /api/me');
    const meSecond = await fetch(`${baseUrl}/api/me`, { headers: authed(second.token) }).then((r) => r.json());
    assert.equal(meSecond.isAdmin, false);

    const okOverview = await fetch(`${baseUrl}/api/admin/overview`, { headers: authed(first.token) });
    assert.equal(okOverview.status, 200);
    const body = await okOverview.json();
    assert.equal(typeof body.users, 'number');
    assert.equal(typeof body.runs, 'number');
    assert.equal(typeof body.levels, 'number');
    assert.ok(Array.isArray(body.rooms));

    const denied = await fetch(`${baseUrl}/api/admin/overview`, { headers: authed(second.token) });
    assert.equal(denied.status, 403, 'non-admin should get 403 on /api/admin/*');

    const noAuth = await fetch(`${baseUrl}/api/admin/overview`);
    assert.equal(noAuth.status, 403, 'logged-out request should also get 403, not a crash');
  });
});

test('GAUNTLET_ADMINS overrides the id-1 default', async () => {
  await withServer({ GAUNTLET_ADMINS: 'boss' }, async (baseUrl) => {
    const first = await register(baseUrl, 'not_boss'); // id 1, but not in the admin list
    const boss = await register(baseUrl, 'boss');
    assert.equal((await fetch(`${baseUrl}/api/admin/overview`, { headers: authed(first.token) })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/admin/overview`, { headers: authed(boss.token) })).status, 200);
  });
});

test('admin users/levels listing, level moderation, and room close', async () => {
  await withServer({}, async (baseUrl) => {
    const admin = await register(baseUrl, 'the_admin');
    const author = await register(baseUrl, 'level_author');

    const users = await fetch(`${baseUrl}/api/admin/users?search=level`, { headers: authed(admin.token) }).then((r) => r.json());
    assert.ok(users.users.some((u) => u.username === 'level_author'));

    const level = {
      name: 'Test Room', description: '',
      rows: [
        '############', '#S.........#', '#..........#', '#..........#', '#..........#', '#..........#',
        '#..........#', '#..........#', '#..........#', '#..........#', '#.........E#', '############',
      ],
    };
    const created = await fetch(`${baseUrl}/api/levels`, { method: 'POST', headers: { ...authed(author.token), 'Content-Type': 'application/json' }, body: JSON.stringify(level) }).then((r) => r.json());
    await fetch(`${baseUrl}/api/levels/${created.id}/publish`, { method: 'POST', headers: authed(author.token) });

    const levels = await fetch(`${baseUrl}/api/admin/levels?search=Test`, { headers: authed(admin.token) }).then((r) => r.json());
    const row = levels.levels.find((l) => l.id === created.id);
    assert.ok(row, 'created level should show up in admin listing');
    assert.equal(row.published, 1);

    const unpub = await fetch(`${baseUrl}/api/admin/levels/${created.id}/unpublish`, { method: 'POST', headers: authed(admin.token) });
    assert.equal(unpub.status, 200);
    // Admin's own moderation view already reports it as unpublished...
    const levelsAfter = await fetch(`${baseUrl}/api/admin/levels?search=Test`, { headers: authed(admin.token) }).then((r) => r.json());
    assert.equal(levelsAfter.levels.find((l) => l.id === created.id)?.published, 0);
    // ...and the level itself is now private to everyone but its author (unrelated access control,
    // unaffected by the admin action).
    assert.equal((await fetch(`${baseUrl}/api/levels/${created.id}`, { headers: authed(admin.token) })).status, 403);
    const afterUnpub = await fetch(`${baseUrl}/api/levels/${created.id}`, { headers: authed(author.token) }).then((r) => r.json());
    assert.equal(afterUnpub.level.published, false);

    const del = await fetch(`${baseUrl}/api/admin/levels/${created.id}`, { method: 'DELETE', headers: authed(admin.token) });
    assert.equal(del.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/levels/${created.id}`)).status, 404);

    // Room close: create a room (as a guest, no WS needed) and close it via the admin API.
    const room = await fetch(`${baseUrl}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Close me' }) }).then((r) => r.json());
    const overview = await fetch(`${baseUrl}/api/admin/overview`, { headers: authed(admin.token) }).then((r) => r.json());
    assert.ok(overview.rooms.some((r) => r.id === room.room.id));
    const closed = await fetch(`${baseUrl}/api/admin/rooms/${room.room.id}/close`, { method: 'POST', headers: authed(admin.token) });
    assert.equal(closed.status, 200);
    const missing = await fetch(`${baseUrl}/api/admin/rooms/${room.room.id}/close`, { method: 'POST', headers: authed(admin.token) });
    assert.equal(missing.status, 404, 'closing an already-closed room should 404, not crash');
  });
});
