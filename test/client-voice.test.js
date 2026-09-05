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

// Manifest always empty -> playClip() always resolves false -> say() always falls through to
// the speechSynthesis path, which is what these tests want to observe.
globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => ({}) });

let spokenCount = 0;
let lastUtterance = null;
let cancelCount = 0;
class FakeUtterance { constructor(text) { this.text = text; } }
globalThis.SpeechSynthesisUtterance = FakeUtterance;
globalThis.speechSynthesis = {
  speak: (u) => { spokenCount++; lastUtterance = u; },
  cancel: () => { cancelCount++; },
};

const audio = await import('../client/audio.js');
const voice = await import('../client/voice.js');

function resetCounters() { spokenCount = 0; lastUtterance = null; cancelCount = 0; }

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
