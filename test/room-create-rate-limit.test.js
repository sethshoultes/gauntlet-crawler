// Regression test for room-creation rate limiting (server/index.js roomCreateKey()): the REST
// endpoints (POST /api/rooms, POST /api/levels/:id/play) key their per-minute room-creation
// bucket by 'u' + user.id when logged in (falling back to IP for guests), while the WS
// 'join'-with-create protocol message used to key its bucket by IP alone regardless of auth. That
// let a logged-in user dodge their account-wide limit by switching from REST to WS (or vice
// versa), and meant every account behind one shared IP/NAT competed for a single WS bucket. Both
// paths now share one roomCreateKey(user, ip) helper. Boots the real server as a child process,
// same pattern as test/telemetry.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { default as WebSocket } from 'ws';

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
  const dataDir = await mkdtemp(path.join(tmpdir(), 'gauntlet-roomrate-test-'));
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
    await fn(baseUrl, port);
  } finally {
    if (server.exitCode === null && server.pid) { try { process.kill(server.pid, 'SIGTERM'); } catch {} }
    await once(server, 'exit').catch(() => {});
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

function wsJoinCreate(port, token, roomName) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', create: true, roomName, token, name: 'Guest', cls: 'warrior' })));
    ws.once('message', (data) => {
      const msg = JSON.parse(data.toString());
      ws.close();
      resolve(msg);
    });
    ws.on('error', reject);
  });
}

test('WS room creation shares the same per-account rate-limit bucket as the REST endpoint', async () => {
  await withServer(async (baseUrl, port) => {
    const reg = await fetch(`${baseUrl}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'roomrate_user', password: 'hunter22' }),
    }).then((r) => r.json());
    const token = reg.token;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    // Exhaust this user's 10-per-minute room-creation limit entirely over REST.
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${baseUrl}/api/rooms`, { method: 'POST', headers, body: JSON.stringify({ name: `r${i}` }) });
      assert.equal(res.status, 200, `REST room creation #${i} should succeed`);
    }
    // The 11th over REST is correctly rejected.
    const restOver = await fetch(`${baseUrl}/api/rooms`, { method: 'POST', headers, body: JSON.stringify({ name: 'over-rest' }) });
    assert.equal(restOver.status, 429, 'the 11th REST room creation this minute should be rate limited');

    // Switching transport must not reset or bypass the same account's bucket: WS room creation,
    // authenticated as the same user, should also be rejected rather than keying off IP alone.
    const wsMsg = await wsJoinCreate(port, token, 'over-ws');
    assert.equal(wsMsg.t, 'error', 'WS room creation should be rate limited too, since it shares the REST bucket for this user');
    assert.match(wsMsg.error, /Slow down/i);
  });
});
