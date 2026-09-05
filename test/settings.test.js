// Settings-page endpoints (server/account.js, mounted from server/index.js): password change +
// session rotation, preferences round-trip, and account deletion cascading. Boots the real
// server against a fresh temp DB, same pattern as test/server-static.test.js.
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

async function withServer(fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'gauntlet-settings-test-'));
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
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

function authed(token) { return { Authorization: `Bearer ${token}` }; }
async function postJson(baseUrl, path, body, headers = {}) {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('changing password rotates every other session but keeps the current one', async () => {
  await withServer(async (baseUrl) => {
    const reg = await postJson(baseUrl, '/api/register', { username: 'pw_user', password: 'firstpass1' }).then((r) => r.json());
    const otherSession = await postJson(baseUrl, '/api/login', { username: 'pw_user', password: 'firstpass1' }).then((r) => r.json());
    // Both tokens work before the change.
    assert.equal((await fetch(`${baseUrl}/api/me`, { headers: authed(reg.token) })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/me`, { headers: authed(otherSession.token) })).status, 200);

    const changed = await postJson(baseUrl, '/api/me/password', { current: 'firstpass1', next: 'secondpass2' }, authed(reg.token));
    assert.equal(changed.status, 200);

    // The session that made the change is untouched...
    const meAfter = await fetch(`${baseUrl}/api/me`, { headers: authed(reg.token) }).then((r) => r.json());
    assert.equal(meAfter.user.username, 'pw_user');
    // ...but the *other* session's token was revoked.
    const otherAfter = await fetch(`${baseUrl}/api/me`, { headers: authed(otherSession.token) }).then((r) => r.json());
    assert.equal(otherAfter.user, null, 'a different session should be signed out by a password change');

    // Old password no longer works; new one does.
    assert.equal((await postJson(baseUrl, '/api/login', { username: 'pw_user', password: 'firstpass1' })).status, 400);
    assert.equal((await postJson(baseUrl, '/api/login', { username: 'pw_user', password: 'secondpass2' })).status, 200);

    const wrongCurrent = await postJson(baseUrl, '/api/me/password', { current: 'not-it', next: 'thirdpass3' }, authed(reg.token));
    assert.equal(wrongCurrent.status, 400);
  });
});

test('preferences round-trip through GET/PUT /api/me/prefs', async () => {
  await withServer(async (baseUrl) => {
    const reg = await postJson(baseUrl, '/api/register', { username: 'prefs_user', password: 'hunter22' }).then((r) => r.json());
    const empty = await fetch(`${baseUrl}/api/me/prefs`, { headers: authed(reg.token) }).then((r) => r.json());
    assert.deepEqual(empty.prefs, {});

    const prefs = { soundVolume: 40, narrator: false, colorBlindPalette: true, reducedMotion: true, keyBindings: { up: 'ArrowUp', fire: 'J' } };
    const put = await fetch(`${baseUrl}/api/me/prefs`, { method: 'PUT', headers: { ...authed(reg.token), 'Content-Type': 'application/json' }, body: JSON.stringify(prefs) });
    assert.equal(put.status, 200);

    const got = await fetch(`${baseUrl}/api/me/prefs`, { headers: authed(reg.token) }).then((r) => r.json());
    assert.deepEqual(got.prefs, prefs);

    // Unknown keys are dropped rather than stored verbatim.
    const putExtra = await fetch(`${baseUrl}/api/me/prefs`, { method: 'PUT', headers: { ...authed(reg.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ ...prefs, evil: 'nope' }) });
    assert.equal(putExtra.status, 200);
    const gotAfter = await fetch(`${baseUrl}/api/me/prefs`, { headers: authed(reg.token) }).then((r) => r.json());
    assert.equal(gotAfter.prefs.evil, undefined);
  });
});

test('deleting an account cascades: sessions, published levels, and login all go away', async () => {
  await withServer(async (baseUrl) => {
    const reg = await postJson(baseUrl, '/api/register', { username: 'doomed_user', password: 'hunter22' }).then((r) => r.json());
    const level = {
      name: 'Doomed Level', description: '',
      rows: [
        '############', '#S.........#', '#..........#', '#..........#', '#..........#', '#..........#',
        '#..........#', '#..........#', '#..........#', '#..........#', '#.........E#', '############',
      ],
    };
    const created = await fetch(`${baseUrl}/api/levels`, { method: 'POST', headers: { ...authed(reg.token), 'Content-Type': 'application/json' }, body: JSON.stringify(level) }).then((r) => r.json());
    await fetch(`${baseUrl}/api/levels/${created.id}/publish`, { method: 'POST', headers: authed(reg.token) });
    assert.equal((await fetch(`${baseUrl}/api/levels/${created.id}`)).status, 200);

    const badDelete = await fetch(`${baseUrl}/api/me`, { method: 'DELETE', headers: { ...authed(reg.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
    assert.equal(badDelete.status, 400);

    const del = await fetch(`${baseUrl}/api/me`, { method: 'DELETE', headers: { ...authed(reg.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'hunter22' }) });
    assert.equal(del.status, 200);

    // Session is gone.
    assert.equal((await fetch(`${baseUrl}/api/me`, { headers: authed(reg.token) }).then((r) => r.json())).user, null);
    // Login no longer works.
    assert.equal((await postJson(baseUrl, '/api/login', { username: 'doomed_user', password: 'hunter22' })).status, 400);
    // The level they published is gone (deleted, not just unpublished).
    assert.equal((await fetch(`${baseUrl}/api/levels/${created.id}`)).status, 404);
    // Re-registering the same username works again (old row is really gone).
    assert.equal((await postJson(baseUrl, '/api/register', { username: 'doomed_user', password: 'newpass99' })).status, 200);
  });
});
