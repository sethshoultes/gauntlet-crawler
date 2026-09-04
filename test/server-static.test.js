// Regression test for the static file server (server/index.js serveStatic()): a request whose
// decoded path escapes the intended /shared or /client directory (via a raw ".." segment, or one
// smuggled past Node's URL dot-segment normalization inside a %2f-encoded slash) must never be
// able to read files elsewhere in the repo — including the sqlite database, server source, or
// package.json. Boots the real server as a child process (like test/smoke.mjs) since the
// traversal only manifests through the real HTTP request-path parsing.
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

test('static file traversal is blocked; legitimate /shared and /client files still serve', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'gauntlet-static-test-'));
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (d) => { serverOutput += d.toString(); });
  server.stderr.on('data', (d) => { serverOutput += d.toString(); });
  const serverExit = once(server, 'exit');

  try {
    await Promise.race([
      waitForServer(baseUrl),
      serverExit.then(([code]) => { throw new Error(`server exited early (code ${code}):\n${serverOutput}`); }),
    ]);

    // A literal ".." is already collapsed by Node's URL parser before serveStatic ever sees it,
    // so the historically dangerous case is a slash smuggled in as %2f, which survives that
    // normalization and only becomes ".." after serveStatic's own decodeURIComponent().
    const traversalPaths = [
      '/shared/..%2fserver/db.js',
      '/shared/..%2f..%2fpackage.json',
      '/shared/..%2fdata/gauntlet.sqlite',
      '/shared/%2e%2e%2fserver%2fdb.js',
    ];
    for (const p of traversalPaths) {
      const res = await fetch(baseUrl + p);
      assert.ok(res.status === 403 || res.status === 404, `${p} should be blocked, got HTTP ${res.status}`);
    }

    // The fix must not break legitimate access to shared/ and client/ files.
    const shared = await fetch(baseUrl + '/shared/constants.js');
    assert.equal(shared.status, 200, 'GET /shared/constants.js should still succeed');
    assert.match(await shared.text(), /CLASSES/);

    const index = await fetch(baseUrl + '/');
    assert.equal(index.status, 200, 'GET / should still serve index.html');
  } finally {
    if (server.exitCode === null && server.pid) { try { process.kill(server.pid, 'SIGTERM'); } catch {} }
    await once(server, 'exit').catch(() => {});
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
