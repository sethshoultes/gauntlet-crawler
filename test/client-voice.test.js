// Unit tests for client/voice.js honoring the global mute flag (client/audio.js `setMuted`/
// `isMuted`), for both playback paths (pre-rendered clip and speechSynthesis fallback), and for
// canceling in-flight narration the instant mute is turned on. Runs under plain Node by stubbing
// the small bits of browser environment these two modules touch — no jsdom needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
}

globalThis.localStorage = makeLocalStorage();
globalThis.window = globalThis;
// voice.js's say() rate-limits against `performance.now()`; process start is close to t=0 so the
// real performance.now() would falsely trip the "too soon since last line" gate on the very
// first call in this short-lived test process. Give each test call its own far-apart clock tick.
let clock = 100_000;
globalThis.performance = { now: () => (clock += 10_000) };

// The very first call to say()/playClip() triggers voice.js's memoized manifest fetch; every
// later call reuses that same (by-then-resolved) promise. So to test the "mute toggled while the
// manifest fetch is still in flight" race, the manifest fetch must be held open under our control
// for the *first* test only — later tests get the normal immediate-empty-manifest behaviour once
// we release it.
let manifestResolve = null;
let manifestReleased = false;
globalThis.fetch = () => {
  if (manifestReleased) return Promise.resolve({ ok: true, json: async () => ({}) });
  return new Promise((resolve) => { manifestResolve = resolve; });
};
function releaseManifest(json = {}) {
  manifestReleased = true;
  if (manifestResolve) { manifestResolve({ ok: true, json: async () => json }); manifestResolve = null; }
}

let spokenCount = 0;
let lastUtterance = null;
let cancelCount = 0;
class FakeUtterance { constructor(text) { this.text = text; } }
globalThis.SpeechSynthesisUtterance = FakeUtterance;
globalThis.speechSynthesis = {
  speak: (u) => { spokenCount++; lastUtterance = u; },
  cancel: () => { cancelCount++; },
};
// playClip() wraps `new Audio(...)` in try/catch; leaving Audio undefined is fine for every test
// here since none of these manifests ever contain a matching id, so playClip() always falls
// through to "no clip available" before it would touch Audio.

const audio = await import('../client/audio.js');
const voice = await import('../client/voice.js');

function resetCounters() { spokenCount = 0; lastUtterance = null; cancelCount = 0; }

test('a mute toggled while the manifest fetch is in flight wins the race (no speechSynthesis fallback)', async () => {
  resetCounters();
  audio.setMuted(false);
  voice.say('race_line', 'Should never be spoken');
  // The manifest fetch above is still pending (we haven't released it). Mute now, exactly like a
  // user hitting mute mid-flight, then let the fetch resolve.
  audio.setMuted(true);
  releaseManifest({}); // empty manifest -> would normally fall back to speechSynthesis.speak()
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(spokenCount, 0, 'speechSynthesis.speak must not fire once mute won the race');
});

test('say() is a no-op (no speechSynthesis call) while muted', async () => {
  resetCounters();
  audio.setMuted(true);
  voice.say('line1', 'Hello there');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(spokenCount, 0, 'speechSynthesis.speak should not be called while muted');
});

test('say() speaks normally once unmuted', async () => {
  resetCounters();
  audio.setMuted(false);
  voice.say('line2', 'Hello again');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(spokenCount, 1);
  assert.equal(lastUtterance.text, 'Hello again');
});

test('turning mute on cancels any in-flight speechSynthesis', async () => {
  resetCounters();
  audio.setMuted(false);
  audio.setMuted(true);
  assert.equal(cancelCount, 1, 'speechSynthesis.cancel() should fire when mute is turned on');
});
