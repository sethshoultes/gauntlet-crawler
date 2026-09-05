// Regression test for the bug test/helpers/server.mjs exists to fix: awaiting a *fresh*
// once(child, 'exit') after the child has already exited never resolves, because that event
// already fired once and will not fire again. waitExit() must instead resolve immediately off
// the pre-created exit promise, not fall through to its own SIGKILL timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { waitExit } from './server.mjs';

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
