// Unit tests for client/common.js's track() beacon (client/common.js `track`). Runs the browser
// module directly under Node by stubbing the tiny bits of browser environment it touches
// (localStorage, fetch, window) before importing it — no jsdom needed.
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
// Deliberately leave `window` undefined: common.js's installErrorReporting() no-ops when
// `typeof window === 'undefined'`, so importing it here doesn't need a full window shim.

let lastFetch = null;
globalThis.fetch = (url, opts) => {
  lastFetch = { url, opts };
  return Promise.resolve({ ok: true, json: async () => ({}) });
};

const { track, TOKEN_KEY, cssToken } = await import('../client/common.js');

test('cssToken: passes through an already-safe token unchanged', () => {
  assert.equal(cssToken('warrior'), 'warrior');
  assert.equal(cssToken('boost_speed-01'), 'boost_speed-01');
});

test('cssToken: replaces any character outside [A-Za-z0-9_-] with an underscore', () => {
  assert.equal(cssToken('custom:123'), 'custom_123');
  assert.equal(cssToken('a b"c<d>'), 'a_b_c_d_');
  assert.equal(cssToken('curse_health-0-abc def'), 'curse_health-0-abc_def');
});

test('cssToken: coerces non-string input via String()', () => {
  assert.equal(cssToken(123), '123');
  assert.equal(cssToken(null), 'null');
});

test('track() omits guestId when an auth token is present', async () => {
  globalThis.localStorage.setItem(TOKEN_KEY, 'sometoken');
  track('pageview', { path: '/' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lastFetch.url, '/api/telemetry');
  assert.equal(lastFetch.opts.headers['Authorization'], 'Bearer sometoken');
  const body = JSON.parse(lastFetch.opts.body);
  assert.equal(body.kind, 'pageview');
  assert.ok(!('guestId' in body), 'an authenticated beacon should not carry guestId');
});

test('track() attaches guestId when there is no auth token', async () => {
  globalThis.localStorage.removeItem(TOKEN_KEY);
  lastFetch = null;
  track('session_start');
  await new Promise((r) => setTimeout(r, 0));
  const body = JSON.parse(lastFetch.opts.body);
  assert.equal(typeof body.guestId, 'string');
  assert.ok(body.guestId.length > 0);
});
