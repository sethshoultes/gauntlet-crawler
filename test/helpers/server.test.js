// Regression test for the bug test/helpers/server.mjs exists to fix: awaiting a *fresh*
// once(child, 'exit') after the child has already exited never resolves, because that event
// already fired once and will not fire again. waitExit() must instead resolve immediately off
// the pre-created exit promise, not fall through to its own SIGKILL timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { startServer, waitExit } from './server.mjs';

test('waitExit resolves promptly (not via its SIGKILL timeout) when the child already exited', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const exited = once(child, 'exit');

  // Wait for the process to have actually exited before calling waitExit, so the 'exit' event has
  // already fired by the time we ask — this is exactly the scenario (child already gone) that
  // used to hang the tests: a *fresh* once(child, 'exit') taken at this point would never resolve.
  await exited;

  const start = Date.now();
  await waitExit(child, exited, 10_000); // large timeout: a slow resolve here would mean it fell through to the SIGKILL fallback, not a bug
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 2000, `waitExit should resolve almost immediately off the pre-created promise, took ${elapsed}ms`);
  assert.equal(child.exitCode, 0, 'the already-exited child should be untouched (no SIGKILL was needed)');
});

test('waitExit force-kills and still resolves when the child never exits on its own', async () => {
  // A process that ignores SIGTERM (but not SIGKILL) and never exits by itself, to exercise
  // waitExit's forced-timeout fallback path.
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const exited = once(child, 'exit');

  const start = Date.now();
  await waitExit(child, exited, 300); // short timeout so the test doesn't wait 10s for the fallback
  const elapsed = Date.now() - start;

  assert.ok(elapsed >= 300, `waitExit should not resolve before its timeout elapses, took ${elapsed}ms`);
  assert.ok(elapsed < 5000, `waitExit should resolve soon after its timeout, took ${elapsed}ms`);
  // A process killed by signal (rather than exiting on its own) reports its death via
  // signalCode, not exitCode -- exitCode stays null in that case.
  assert.equal(child.signalCode, 'SIGKILL', 'the stuck child should have been force-killed with SIGKILL');
});

// A listener that holds a port but drops every connection at once, so the readiness probe in
// startServer() fails fast instead of leaving a half-open socket that would keep close() waiting.
function occupiedPort() {
  return net.createServer((socket) => socket.destroy());
}

test('startServer retries on a fresh port when the chosen one is already bound (EADDRINUSE)', async () => {
  // Hold a port open ourselves so the first spawn is guaranteed to lose the bind, the way a
  // sibling test file racing for the same port does under node:test's parallel file runner.
  const blocker = occupiedPort();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const takenPort = blocker.address().port;

  const handedOut = [];
  const pickPort = async () => {
    if (handedOut.length === 0) { handedOut.push(takenPort); return takenPort; }
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
    });
    handedOut.push(free);
    return free;
  };

  let server;
  try {
    server = await startServer({ pickPort });
    assert.equal(handedOut.length, 2, 'exactly one retry after the EADDRINUSE startup');
    assert.equal(server.port, handedOut[1], 'the server must come up on the second, free port');
    const res = await fetch(server.baseUrl + '/api/health');
    assert.equal(res.status, 200);
  } finally {
    if (server) await server.stop();
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('startServer gives up after `attempts` EADDRINUSE startups and surfaces the last error', async () => {
  const blocker = occupiedPort();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const takenPort = blocker.address().port;
  let picks = 0;
  try {
    await assert.rejects(
      startServer({ attempts: 2, pickPort: async () => { picks++; return takenPort; } }),
      /EADDRINUSE/,
    );
    assert.equal(picks, 2, 'one port pick per attempt, no more');
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});
