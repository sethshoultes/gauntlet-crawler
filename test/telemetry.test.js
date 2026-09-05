// Analytics beacons (POST /api/telemetry), client error reporting (POST /api/client-errors,
// server/log.js), and the health endpoint. Boots the real server against a fresh temp DB, same
// pattern as test/server-static.test.js.
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
  const dataDir = await mkdtemp(path.join(tmpdir(), 'gauntlet-telemetry-test-'));
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

test('GET /api/health has the documented shape and needs no auth', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.uptime, 'number');
    assert.equal(typeof body.rooms, 'number');
    assert.equal(typeof body.players, 'number');
    assert.equal(typeof body.version, 'string');
  });
});

test('telemetry beacons are stored and reflected in admin analytics', async () => {
  await withServer(async (baseUrl) => {
    const admin = await fetch(`${baseUrl}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'telemetry_admin', password: 'hunter22' }) }).then((r) => r.json());

    const beacon = await fetch(`${baseUrl}/api/telemetry`, {
      method: 'POST', headers: { ...authed(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'pageview', data: { path: '/' } }),
    });
    assert.equal(beacon.status, 200);

    // A guest beacon (no auth header) with a guestId should count toward guest DAU separately.
    const guestBeacon = await fetch(`${baseUrl}/api/telemetry`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'session_start', guestId: 'guest-abc-123' }),
    });
    assert.equal(guestBeacon.status, 200);

    const badKind = await fetch(`${baseUrl}/api/telemetry`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'not_a_real_kind' }),
    });
    assert.equal(badKind.status, 400, 'an unrecognized telemetry kind should be rejected');

    const analytics = await fetch(`${baseUrl}/api/admin/analytics`, { headers: authed(admin.token) }).then((r) => r.json());
    const totalDau = analytics.dau.reduce((s, r) => s + r.n, 0);
    const totalGuestDau = analytics.guestDau.reduce((s, r) => s + r.n, 0);
    assert.ok(totalDau >= 1, 'the logged-in pageview beacon should count toward DAU');
    assert.ok(totalGuestDau >= 1, 'the guest session_start beacon should count toward guest DAU');
    assert.ok(Array.isArray(analytics.heroPickRates));
    assert.ok(Array.isArray(analytics.depthHist));
    assert.ok(Array.isArray(analytics.topLevels));
    assert.equal(typeof analytics.avgRunLength, 'number');
  });
});

test('telemetry beacons are rate limited per IP', async () => {
  await withServer(async (baseUrl) => {
    let sawTooManyRequests = false;
    for (let i = 0; i < 70; i++) {
      const res = await fetch(`${baseUrl}/api/telemetry`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'pageview' }),
      });
      if (res.status === 429) { sawTooManyRequests = true; break; }
    }
    assert.ok(sawTooManyRequests, 'hammering /api/telemetry from one IP should eventually 429');
  });
});

test('client errors are stored with a truncated stack and surfaced to admins', async () => {
  await withServer(async (baseUrl) => {
    const admin = await fetch(`${baseUrl}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'errors_admin', password: 'hunter22' }) }).then((r) => r.json());

    const hugeStack = 'x'.repeat(10_000);
    const res = await fetch(`${baseUrl}/api/client-errors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Boom, something broke', stack: hugeStack, url: '/play' }),
    });
    assert.equal(res.status, 200);

    const list = await fetch(`${baseUrl}/api/admin/errors`, { headers: authed(admin.token) }).then((r) => r.json());
    const row = list.errors.find((e) => e.message === 'Boom, something broke');
    assert.ok(row, 'client error should be stored and visible to admins');
    assert.equal(row.source, 'client');
    assert.ok(row.stack.length <= 4096, 'stack should be truncated to 4KB');
  });
});
