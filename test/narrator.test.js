// AI narrator commentary (#18): server/ai/narrator.js's caching/availability, the pure trigger
// detectors in server/game/narrator-events.js, and account.js's aiNarrator pref round-trip.
// Hermetic throughout — no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN is ever set here, so
// aiAvailable() stays false and no test can accidentally reach the network; lineFor()'s cache-hit
// test instead injects a fake `generate` function (see server/ai/narrator.js's `lineFor` doc).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'gauntlet-narrator-test-'));
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.GAUNTLET_AI;

const narrator = await import('../server/ai/narrator.js');
const { detectNearDeathSave, checkKillStreak, canNarrateNow, KILL_STREAK_THRESHOLDS } = await import('../server/game/narrator-events.js');
const { setPrefs, getPrefs } = await import('../server/account.js');
const { db, now } = await import('../server/db.js');
const { LOW_HEALTH } = await import('../shared/constants.js');

test('aiAvailable() is false with no AI credentials configured', () => {
  assert.equal(narrator.aiAvailable(), false);
});

test('lineFor() returns null without generating when AI is unavailable and no generator is injected', async () => {
  const line = await narrator.lineFor('party', { classes: ['warrior'] });
  assert.equal(line, null);
});

test('lineFor() caches per event type + coarse context key, never regenerating a cache hit', async () => {
  let calls = 0;
  const generate = async (eventType, context) => { calls++; return `${eventType}:${context.threshold}`; };

  const first = await narrator.lineFor('kill_streak', { threshold: 10 }, { generate });
  assert.equal(first, 'kill_streak:10');
  assert.equal(calls, 1);

  // Same event type + same coarse context (threshold 10) again -> cache hit, generator not called.
  const second = await narrator.lineFor('kill_streak', { threshold: 10 }, { generate });
  assert.equal(second, 'kill_streak:10');
  assert.equal(calls, 1, 'a cache hit must not invoke the generator again');

  // A different context (threshold 25) is a different cache key -> generates again.
  const third = await narrator.lineFor('kill_streak', { threshold: 25 }, { generate });
  assert.equal(third, 'kill_streak:25');
  assert.equal(calls, 2);
});

test('lineFor() persists a generated line to the narrator_lines table and reuses it across "restarts"', async () => {
  let calls = 0;
  const generate = async () => { calls++; return 'A fresh party descends!'; };
  const first = await narrator.lineFor('party', { classes: ['valkyrie', 'warrior'] }, { generate });
  assert.equal(first, 'A fresh party descends!');
  assert.equal(calls, 1);

  const row = db.prepare('SELECT line FROM narrator_lines WHERE cache_key = ?').get('party|valkyrie,warrior');
  assert.equal(row.line, 'A fresh party descends!');

  // Simulate a process restart: clear the in-memory cache only (the row on disk survives).
  narrator._resetCacheForTests();
  const second = await narrator.lineFor('party', { classes: ['valkyrie', 'warrior'] }, { generate });
  assert.equal(second, 'A fresh party descends!');
  assert.equal(calls, 1, 'a persisted line must be reused instead of regenerated after a restart');
});

test('lineFor() never caches a null/failed generation', async () => {
  const generate = async () => null;
  const line = await narrator.lineFor('treasure_enter', {}, { generate });
  assert.equal(line, null);
  const row = db.prepare('SELECT line FROM narrator_lines WHERE cache_key = ?').get('treasure_enter|');
  assert.equal(row, undefined);
});

// ---------- pure trigger detectors (server/game/narrator-events.js) ----------

test('detectNearDeathSave() fires only when hp crosses back up over the threshold from below', () => {
  assert.equal(detectNearDeathSave(150, 250, LOW_HEALTH), true, 'below -> at/above threshold is a save');
  assert.equal(detectNearDeathSave(250, 260, LOW_HEALTH), false, 'already safe stays uneventful');
  assert.equal(detectNearDeathSave(150, 180, LOW_HEALTH), false, 'still below threshold is not a save');
  assert.equal(detectNearDeathSave(0, 900, LOW_HEALTH), false, 'a 0 -> max jump is a respawn, not a save');
  assert.equal(detectNearDeathSave(null, 900, LOW_HEALTH), false, 'no prior reading yet must not trigger');
  assert.equal(detectNearDeathSave(undefined, 900, LOW_HEALTH), false);
});

test('checkKillStreak() announces each threshold exactly once, highest-first on a big jump', () => {
  assert.equal(checkKillStreak(9, 0), null);
  assert.equal(checkKillStreak(10, 0), 10);
  assert.equal(checkKillStreak(10, 10), null, 'already announced 10 must not re-fire at the same count');
  assert.equal(checkKillStreak(24, 10), null);
  assert.equal(checkKillStreak(25, 10), 25);
  // A single potion-fuelled kill flurry can jump straight past 10 and 25 in one event -> only the
  // highest newly-crossed threshold (50) should be reported, not all three.
  assert.equal(checkKillStreak(60, 0), 50);
  assert.deepEqual(KILL_STREAK_THRESHOLDS, [10, 25, 50]);
});

test('canNarrateNow() enforces the per-room rate limit window', () => {
  const t0 = 1_000_000;
  assert.equal(canNarrateNow(t0, 0, 20000), true, 'never having narrated before always allows the first line');
  assert.equal(canNarrateNow(t0 + 5000, t0, 20000), false, 'inside the window is rate-limited');
  assert.equal(canNarrateNow(t0 + 19999, t0, 20000), false);
  assert.equal(canNarrateNow(t0 + 20000, t0, 20000), true, 'exactly at the window boundary is allowed');
});

// ---------- account.js prefs round-trip for aiNarrator ----------

test('setPrefs()/getPrefs() round-trip aiNarrator alongside the other whitelisted prefs', () => {
  const userId = db.prepare('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)')
    .run(`narrator_prefs_${Date.now()}`, 'x', 'y', now()).lastInsertRowid;

  assert.deepEqual(getPrefs(Number(userId)), {}, 'no saved prefs yet');

  const saved = setPrefs(Number(userId), { aiNarrator: true, narrator: false });
  assert.deepEqual(saved, { aiNarrator: true, narrator: false });
  assert.deepEqual(getPrefs(Number(userId)), { aiNarrator: true, narrator: false });

  // Off by default: omitting it entirely (rather than sending false) is also valid and must not
  // be coerced to anything — it's simply absent, same as narrator's boolean sibling.
  const savedOff = setPrefs(Number(userId), { aiNarrator: false });
  assert.deepEqual(savedOff, { aiNarrator: false });

  // A non-boolean value is rejected outright (whole request fails, nothing written).
  assert.throws(() => setPrefs(Number(userId), { aiNarrator: 'yes' }), /Invalid value for preference "aiNarrator"/);
  assert.deepEqual(getPrefs(Number(userId)), { aiNarrator: false }, 'the rejected write must not have overwritten anything');
});
