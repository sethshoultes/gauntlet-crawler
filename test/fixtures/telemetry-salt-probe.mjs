// Fixture used by test/telemetry-salt.test.js: runs in its own short-lived process (so the
// per-process salt memoization in server/telemetry.js can't leak between scenarios) with
// DATA_DIR and optionally GAUNTLET_SALT set by the parent. Triggers the salt to be
// loaded/created by recording one event with an IP, then prints back what ended up persisted in
// the `meta` table so the test can assert on it.
const { db } = await import('../../server/db.js');
const telemetry = await import('../../server/telemetry.js');

telemetry.recordEvent({ kind: 'probe', ip: '203.0.113.5' });

const row = db.prepare("SELECT value FROM meta WHERE key = 'telemetry_salt'").get();
process.stdout.write(JSON.stringify({ persistedSalt: row ? row.value : null }));
