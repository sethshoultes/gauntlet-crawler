// Regression test for the title-media static assets (client/media/*) added for GitHub issue #21:
// the generated backdrop/loop/trailer must actually be reachable through the real static file
// server with the right MIME types, and the pages that reference them must still load. Boots the
// real server as a child process (spawn pattern copied from test/server-static.test.js).
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

test('title backdrop/loop media and the attract/trailer pages are served correctly', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'gauntlet-media-test-'));
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

    const backdrop = await fetch(baseUrl + '/media/title-backdrop.webp');
    assert.equal(backdrop.status, 200, 'GET /media/title-backdrop.webp should succeed');
    assert.equal(backdrop.headers.get('content-type'), 'image/webp');

    const card = await fetch(baseUrl + '/media/title-card.webp');
    assert.equal(card.status, 200, 'GET /media/title-card.webp should succeed');
    assert.equal(card.headers.get('content-type'), 'image/webp');

    const loop = await fetch(baseUrl + '/media/title-loop.mp4');
    assert.equal(loop.status, 200, 'GET /media/title-loop.mp4 should succeed');
    assert.equal(loop.headers.get('content-type'), 'video/mp4');

    const trailer = await fetch(baseUrl + '/media/trailer.mp4');
    assert.equal(trailer.status, 200, 'GET /media/trailer.mp4 should succeed');
    assert.equal(trailer.headers.get('content-type'), 'video/mp4');

    const attract = await fetch(baseUrl + '/attract.html');
    assert.equal(attract.status, 200, 'GET /attract.html should succeed');
    const attractHtml = await attract.text();
    assert.match(attractHtml, /backdrop-video/);
    assert.match(attractHtml, /\/media\/title-loop\.mp4/);

    const trailerPage = await fetch(baseUrl + '/trailer.html');
    assert.equal(trailerPage.status, 200, 'GET /trailer.html should succeed');
    assert.match(await trailerPage.text(), /\/media\/trailer\.mp4/);
  } finally {
    if (server.exitCode === null && server.pid) { try { process.kill(server.pid, 'SIGTERM'); } catch {} }
    await serverExit.catch(() => {}); // reuse the existing exit promise: a fresh once() would hang if the child already exited
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
