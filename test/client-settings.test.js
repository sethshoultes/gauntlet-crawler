// Regression test for the account-deletion telemetry beacon (client/settings.js
// `#delete-account` handler): the server revokes every session for the user -- including the
// one making the DELETE call -- as part of deleting the account (server/account.js
// deleteAccount()). If the client fired its `run_end` beacon *after* the DELETE call, the beacon
// would carry an Authorization header for an already-revoked token: the server can't attribute
// the event to the user (session lookup fails) and, since a token is present, it also skips the
// guest-id fallback -- so the event lands completely unattributed. This test asserts the beacon
// is sent (and reaches the network) before the DELETE call, so the fix can't silently regress.
//
// Runs client/settings.js directly under Node by stubbing the small bits of browser/DOM
// environment it touches -- same pattern as test/client-common.test.js and
// test/client-voice.test.js.
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
globalThis.localStorage.setItem('gc_token', 'sometoken');

// Minimal fake DOM element: any property/method used by settings.js is created lazily so the
// same handful of stub objects can stand in for every #id the module queries.
function makeElement() {
  const el = {
    style: {}, classList: { add() {}, remove() {} },
    value: '', textContent: '', className: '', checked: false,
    addEventListener() {}, appendChild() {},
  };
  return el;
}
const elements = new Map();
globalThis.document = {
  querySelector(sel) {
    if (sel === 'nav.top') return null; // renderNav() no-ops without a <nav>; not under test here
    if (!elements.has(sel)) elements.set(sel, makeElement());
    return elements.get(sel);
  },
};
globalThis.window = globalThis;
globalThis.confirm = () => true;
globalThis.addEventListener = () => {};
globalThis.location = { pathname: '/settings.html', href: '' };

const fetchLog = [];
globalThis.fetch = (url, opts = {}) => {
  fetchLog.push({ url, method: opts.method || 'GET' });
  if (url === '/api/me' && opts.method === 'DELETE') return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  if (url === '/api/me') return Promise.resolve({ ok: true, json: async () => ({ user: { username: 'doomed' } }) });
  if (url === '/api/me/prefs') return Promise.resolve({ ok: true, json: async () => ({ prefs: {} }) });
  if (url === '/api/telemetry') return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  return Promise.resolve({ ok: true, json: async () => ({}) });
};

await import('../client/settings.js');
// main() runs unawaited at module load; let its initial `await me()` / prefs fetch settle before
// we simulate a click.
await new Promise((r) => setTimeout(r, 20));

test('account deletion fires the run_end beacon before the DELETE call, while the session is still valid', async () => {
  fetchLog.length = 0;
  document.querySelector('#del-pw').value = 'correcthorse';
  await document.querySelector('#delete-account').onclick();

  const telemetryIdx = fetchLog.findIndex((f) => f.url === '/api/telemetry');
  const deleteIdx = fetchLog.findIndex((f) => f.url === '/api/me' && f.method === 'DELETE');
  assert.ok(telemetryIdx !== -1, 'expected a telemetry beacon to be sent');
  assert.ok(deleteIdx !== -1, 'expected the DELETE /api/me call to be sent');
  assert.ok(telemetryIdx < deleteIdx, 'telemetry beacon must fire before the account-deleting DELETE call, while the token is still valid');
});
