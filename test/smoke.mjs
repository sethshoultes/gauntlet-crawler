#!/usr/bin/env node
// End-to-end smoke test: boots the real server, drives a real browser (Playwright/Chromium)
// through hero select -> quick play -> a few seconds of live play, and separately checks the
// procedural level-generation API. Not a node:test file (test/**/*.test.js only), so it never
// runs as part of `npm test` — it's invoked explicitly via `npm run smoke`.
//
// Usage:
//   npm run smoke
//   CHROMIUM_PATH=/path/to/chrome npm run smoke   # use a pre-installed browser instead of
//                                                  // the one `playwright install` downloaded
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

function log(msg) {
  console.log(`[smoke] ${msg}`);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForServer(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      fetch(url).then((res) => {
        resolve(res);
      }).catch((err) => {
        if (Date.now() > deadline) return reject(err);
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'gauntlet-smoke-'));
  const port = await findFreePort();
  // fileURLToPath (not URL#pathname) so a repo path containing spaces or other characters that
  // get percent-encoded in a file: URL (e.g. "Local%20Sites") resolves to a real, spawnable
  // directory instead of a literal "%20" that doesn't exist on disk.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const baseUrl = `http://127.0.0.1:${port}`;

  log(`starting server on ${baseUrl} (DATA_DIR=${dataDir})`);
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  server.stdout.on('data', (d) => { serverOutput += d.toString(); });
  server.stderr.on('data', (d) => { serverOutput += d.toString(); });

  const serverExit = once(server, 'exit');
  let browser = null;
  let failed = false;

  try {
    await Promise.race([
      waitForServer(baseUrl),
      serverExit.then(([code]) => { throw new Error(`server exited early (code ${code}):\n${serverOutput}`); }),
    ]);
    log('server is listening');

    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
    });
    const page = await browser.newPage();

    const pageErrors = [];
    const consoleErrors = [];
    const failedRequests = [];
    page.on('pageerror', (err) => pageErrors.push(String(err && err.stack || err)));
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('requestfailed', (req) => {
      const errorText = req.failure()?.errorText || 'failed';
      // Navigating away (e.g. to the next page in the loop below) aborts any in-flight
      // requests the previous page kicked off — that's expected, not a real failure.
      if (errorText === 'net::ERR_ABORTED') return;
      failedRequests.push(`${req.method()} ${req.url()} -> ${errorText}`);
    });
    page.on('response', (res) => {
      if (res.status() >= 500) failedRequests.push(`${res.request().method()} ${res.url()} -> HTTP ${res.status()}`);
    });

    for (const p of ['/', '/dashboard.html', '/editor.html']) {
      log(`loading ${p}`);
      const res = await page.goto(baseUrl + p, { waitUntil: 'load', timeout: 15_000 });
      if (!res || !res.ok()) throw new Error(`GET ${p} -> ${res ? res.status() : 'no response'}`);
    }

    // Back on the lobby page, play through hero select -> quick play -> a few seconds live.
    await page.goto(baseUrl + '/', { waitUntil: 'load', timeout: 15_000 });
    log('selecting hero and starting quick play');
    await page.waitForSelector('.hero:nth-child(2)', { timeout: 10_000 });
    await page.click('.hero:nth-child(2)');
    await page.fill('#gname', 'SmokeTest');
    await page.click('#quick');
    log('waiting for the pre-game room screen');
    await page.waitForSelector('#roomscreen.on', { timeout: 15_000 });
    log('solo host — clicking Start');
    await page.click('#rs-start');
    await page.waitForSelector('#game.on', { timeout: 15_000 });
    log('in game, holding "d" for 500ms');
    await page.keyboard.down('d');
    await page.waitForTimeout(500);
    await page.keyboard.up('d');

    if (pageErrors.length) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
    if (consoleErrors.length) throw new Error(`console errors:\n${consoleErrors.join('\n')}`);
    if (failedRequests.length) throw new Error(`failed requests:\n${failedRequests.join('\n')}`);
    log('browser session clean: no page errors, console errors, or failed requests');

    log('checking POST /api/levels/generate?wait=1 (procedural fallback, no ANTHROPIC_API_KEY)');
    const genRes = await fetch(baseUrl + '/api/levels/generate?wait=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a small crypt guarded by ghosts', difficulty: 3, size: 'small' }),
    });
    if (!genRes.ok) throw new Error(`POST /api/levels/generate?wait=1 -> HTTP ${genRes.status}`);
    const gen = await genRes.json();
    if (gen.source !== 'procedural') throw new Error(`expected source 'procedural', got '${gen.source}'`);
    if (!Array.isArray(gen.problems) || gen.problems.length !== 0) {
      throw new Error(`expected no validation problems, got ${JSON.stringify(gen.problems)}`);
    }
    log(`level generation ok: "${gen.level?.name}" (${gen.level?.rows?.length} rows)`);

    log('SMOKE PASS: static pages, quick play, and level generation all OK');
  } catch (err) {
    failed = true;
    console.error('[smoke] FAILED:', err && err.stack || err);
    if (serverOutput) console.error('[smoke] server output:\n' + serverOutput);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server.exitCode === null && server.pid) {
      try { process.kill(server.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    // Reuse the exit promise created at spawn time: a fresh once(server, 'exit') here would hang
    // forever if the child already exited (e.g. a startup failure above).
    await serverExit.catch(() => {});
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  process.exit(failed ? 1 : 0);
}

main();
