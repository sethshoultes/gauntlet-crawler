// Shared spawner for the integration tests that boot the real server (server/index.js) as a
// child process against a fresh temp DATA_DIR and free port.
//
// This centralizes a fix for a bug that used to be copy-pasted independently into ~7 test files:
// each test created its exit-tracking promise once at spawn time (`once(child, 'exit')`), raced
// it against the readiness poll, but then in its `finally` cleanup created a *fresh*
// `once(server, 'exit')` to await after sending SIGTERM. If the child had already exited earlier
// — a startup failure that made the readiness race throw, or a crash mid-test — that 'exit' event
// had already fired and would never fire again, so the fresh listener never resolved and the test
// hung CI. The fix: create the exit promise exactly once, at spawn time, and reuse that same
// promise everywhere (including stop()) rather than ever re-subscribing to 'exit'.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// Polls `url` until it answers or `timeoutMs` passes. `signal` lets the caller stop the poll early
// (the child exited before ever serving) so the pending timer does not keep the test process
// alive for the rest of the readiness window.
function waitForServer(url, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (signal.aborted) return reject(signal.reason);
      // Per-request timeout: a port that accepts TCP but never answers (something else holding it)
      // must not park this probe forever, or the surrounding race can never settle cleanly.
      fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) }).then(resolve).catch((err) => {
        if (signal.aborted) return reject(signal.reason);
        if (Date.now() > deadline) return reject(err);
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

/**
 * Await a pre-created `once(child, 'exit')` promise, forcing the issue with SIGKILL if the child
 * hasn't gone away within `timeoutMs`. Exported on its own (rather than folded invisibly into
 * stop()) so test/helpers/server.test.js can exercise the "child already exited before we
 * started waiting" case directly, without booting the whole game server.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {Promise<[number|null, string|null]>} exited the promise created at spawn time
 * @param {number} [timeoutMs]
 */
export async function waitExit(child, exited, timeoutMs = 10_000) {
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  try {
    await Promise.race([exited.catch(() => {}), timedOut]);
  } finally {
    clearTimeout(timer);
  }
  // Still alive after the grace period: escalate to SIGKILL and wait for the same pre-created
  // exit promise to actually settle, rather than returning before the process is really gone.
  if (child.exitCode === null && child.pid) {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
    await exited.catch(() => {});
  }
}

/**
 * Spawn server/index.js on a free port against a fresh temp DATA_DIR, and wait until it is either
 * ready to serve requests or has exited early (whichever comes first) before resolving.
 *
 * node:test runs test files in parallel processes, and findFreePort() has an unavoidable window
 * between closing its probe socket and the child actually binding the port. Two files probing at
 * once can therefore be handed the same port, and the loser dies at startup with EADDRINUSE (seen
 * on CI in test/pwa.test.js). That failure is retried here with a fresh port rather than surfaced,
 * because it says nothing about the code under test.
 *
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.env] extra environment variables merged over process.env
 *   (e.g. `{ GAUNTLET_DEBUG: '1' }`, `{ GAUNTLET_ADMINS: 'boss' }`).
 * @param {number} [opts.timeoutMs] readiness timeout in ms (default 20s).
 * @param {number} [opts.attempts] how many EADDRINUSE startups to tolerate before giving up.
 * @param {() => Promise<number>} [opts.pickPort] port chooser, injectable so the retry path can
 *   be exercised deterministically by test/helpers/server.test.js.
 * @returns {Promise<{
 *   baseUrl: string, port: number, pid: number, dataDir: string,
 *   exitCode: number|null, output: () => string, stop: () => Promise<void>,
 * }>}
 */
export async function startServer({ env = {}, timeoutMs = 20_000, attempts = 5, pickPort = findFreePort } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await startServerOnce({ env, timeoutMs, port: await pickPort() });
    } catch (err) {
      lastErr = err;
      if (!err?.portInUse) throw err;
    }
  }
  throw lastErr;
}

async function startServerOnce({ env, timeoutMs, port }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'gauntlet-test-'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  // Created exactly once, right here at spawn time — see the module doc comment above for why a
  // fresh once(child, 'exit') later, in cleanup, can hang forever.
  const exited = once(child, 'exit');

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.pid) { try { process.kill(child.pid, 'SIGTERM'); } catch {} }
    await waitExit(child, exited);
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  const probe = new AbortController();
  try {
    await Promise.race([
      waitForServer(baseUrl, timeoutMs, probe.signal),
      exited.then(([code]) => {
        const err = new Error(`server exited early (code ${code}):\n${out}`);
        // Mark the lost-the-port-race case so startServer() can retry it on a different port.
        err.portInUse = out.includes('EADDRINUSE');
        throw err;
      }),
    ]);
  } catch (err) {
    await stop();
    throw err;
  } finally {
    probe.abort(new Error('readiness poll cancelled'));
  }

  return {
    baseUrl,
    port,
    pid: child.pid,
    dataDir,
    get exitCode() { return child.exitCode; },
    output: () => out,
    stop,
  };
}
