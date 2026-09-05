// server/telemetry.js loadOrCreateSalt(): an explicitly configured GAUNTLET_SALT must take
// precedence over whatever salt (if any) was previously persisted in the `meta` table, and must
// persist itself so a later restart without the env var set stays stable on that same value.
// Each scenario runs in its own child process (the salt is memoized per-process, and DATA_DIR
// selects the sqlite file) via test/fixtures/telemetry-salt-probe.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(ROOT, 'test', 'fixtures', 'telemetry-salt-probe.mjs');

async function runProbe(dataDir, extraEnv = {}) {
  const env = { ...process.env, DATA_DIR: dataDir };
  delete env.GAUNTLET_SALT;
  Object.assign(env, extraEnv);
  const { stdout } = await execFileAsync(process.execPath, ['--no-warnings=ExperimentalWarning', PROBE], { cwd: ROOT, env });
  return JSON.parse(stdout);
}

test('GAUNTLET_SALT is used and persisted when set with no prior stored salt', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'gauntlet-salt-test-'));
  try {
    const { persistedSalt } = await runProbe(dataDir, { GAUNTLET_SALT: 'configured-salt-one' });
    assert.equal(persistedSalt, 'configured-salt-one');
  } finally {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('GAUNTLET_SALT overrides (and overwrites) a salt already persisted from an earlier run', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'gauntlet-salt-test-'));
  try {
    // First run with no env var set: a salt is generated and persisted.
    const first = await runProbe(dataDir);
    assert.ok(first.persistedSalt, 'a salt should be generated and persisted on first run');

    // Second run, same DATA_DIR, now with GAUNTLET_SALT set to something else: the env var must
    // win over the already-persisted salt, and overwrite it.
    const second = await runProbe(dataDir, { GAUNTLET_SALT: 'configured-salt-two' });
    assert.equal(second.persistedSalt, 'configured-salt-two');
    assert.notEqual(second.persistedSalt, first.persistedSalt);

    // Third run, same DATA_DIR, env var unset again: it should fall back to the *overwritten*
    // stored value (the configured salt), proving it stayed stable/persisted rather than
    // reverting or regenerating.
    const third = await runProbe(dataDir);
    assert.equal(third.persistedSalt, 'configured-salt-two');
  } finally {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
