// Settings-page endpoints (server/account.js, mounted from server/index.js): password change +
// session rotation, preferences round-trip, and account deletion cascading. Boots the real
// server against a fresh temp DB, same pattern as test/server-static.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

async function withServer(fn) {
  // GAUNTLET_DEBUG=1 exposes POST /api/heroes/debug/xp (server/heroes.js), which the account
  // deletion cascade test below uses to unlock the Hero Builder without a real playthrough.
  const server = await startServer({ env: { GAUNTLET_DEBUG: '1' } });
  try {
    await fn(server.baseUrl);
  } finally {
    await server.stop();
  }
}

function authed(token) { return { Authorization: `Bearer ${token}` }; }
async function postJson(baseUrl, path, body, headers = {}) {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('changing password rotates every other session but keeps the current one', async () => {
  await withServer(async (baseUrl) => {
    const reg = await postJson(baseUrl, '/api/register', { username: 'pw_user', password: 'firstpass1' }).then((r) => r.json());
    const otherSession = await postJson(baseUrl, '/api/login', { username: 'pw_user', password: 'firstpass1' }).then((r) => r.json());
    // Both tokens work before the change.
    assert.equal((await fetch(`${baseUrl}/api/me`, { headers: authed(reg.token) })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/me`, { headers: authed(otherSession.token) })).status, 200);

    const changed = await postJson(baseUrl, '/api/me/password', { current: 'firstpass1', next: 'secondpass2' }, authed(reg.token));
    assert.equal(changed.status, 200);

    // The session that made the change is untouched...
    const meAfter = await fetch(`${baseUrl}/api/me`, { headers: authed(reg.token) }).then((r) => r.json());
    assert.equal(meAfter.user.username, 'pw_user');
    // ...but the *other* session's token was revoked.
    const otherAfter = await fetch(`${baseUrl}/api/me`, { headers: authed(otherSession.token) }).then((r) => r.json());
    assert.equal(otherAfter.user, null, 'a different session should be signed out by a password change');

    // Old password no longer works; new one does.
    assert.equal((await postJson(baseUrl, '/api/login', { username: 'pw_user', password: 'firstpass1' })).status, 400);
    assert.equal((await postJson(baseUrl, '/api/login', { username: 'pw_user', password: 'secondpass2' })).status, 200);

    const wrongCurrent = await postJson(baseUrl, '/api/me/password', { current: 'not-it', next: 'thirdpass3' }, authed(reg.token));
    assert.equal(wrongCurrent.status, 400);
  });
});

test('preferences round-trip through GET/PUT /api/me/prefs', async () => {
  await withServer(async (baseUrl) => {
    const reg = await postJson(baseUrl, '/api/register', { username: 'prefs_user', password: 'hunter22' }).then((r) => r.json());
    const empty = await fetch(`${baseUrl}/api/me/prefs`, { headers: authed(reg.token) }).then((r) => r.json());
    assert.deepEqual(empty.prefs, {});

    const prefs = { soundVolume: 40, narrator: false, colorBlindPalette: true, reducedMotion: true, keyBindings: { up: 'ArrowUp', fire: 'J' } };
    const put = await fetch(`${baseUrl}/api/me/prefs`, { method: 'PUT', headers: { ...authed(reg.token), 'Content-Type': 'application/json' }, body: JSON.stringify(prefs) });
    assert.equal(put.status, 200);

    const got = await fetch(`${baseUrl}/api/me/prefs`, { headers: authed(reg.token) }).then((r) => r.json());
    assert.deepEqual(got.prefs, prefs);

    // Unknown keys are dropped rather than stored verbatim.
    const putExtra = await fetch(`${baseUrl}/api/me/prefs`, { method: 'PUT', headers: { ...authed(reg.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ ...prefs, evil: 'nope' }) });
    assert.equal(putExtra.status, 200);
    const gotAfter = await fetch(`${baseUrl}/api/me/prefs`, { headers: authed(reg.token) }).then((r) => r.json());
    assert.equal(gotAfter.prefs.evil, undefined);
  });
});

test('an oversized prefs payload is rejected with 400 and does not overwrite what was already saved', async () => {
  await withServer(async (baseUrl) => {
    const reg = await postJson(baseUrl, '/api/register', { username: 'prefs_oversize', password: 'hunter22' }).then((r) => r.json());

    const goodPrefs = { soundVolume: 55, narrator: true, keyBindings: { up: 'ArrowUp' } };
    const firstPut = await fetch(`${baseUrl}/api/me/prefs`, { method: 'PUT', headers: { ...authed(reg.token), 'Content-Type': 'application/json' }, body: JSON.stringify(goodPrefs) });
    assert.equal(firstPut.status, 200);

    // A keyBindings value alone longer than the 8000-byte limit — previously this was silently
    // truncated with `.slice(0, 8000)`, which can cut mid-token and parse back as `{}`, wiping
    // every previously saved preference. It must now be rejected outright instead.
    const oversized = { ...goodPrefs, keyBindings: { up: 'x'.repeat(9000) } };
    const badPut = await fetch(`${baseUrl}/api/me/prefs`, { method: 'PUT', headers: { ...authed(reg.token), 'Content-Type': 'application/json' }, body: JSON.stringify(oversized) });
    assert.equal(badPut.status, 400);
    const badBody = await badPut.json();
    assert.equal(typeof badBody.error, 'string');

    // The previously saved (valid) prefs must be completely unchanged, not wiped or partially
    // overwritten.
    const after = await fetch(`${baseUrl}/api/me/prefs`, { headers: authed(reg.token) }).then((r) => r.json());
    assert.deepEqual(after.prefs, goodPrefs);
  });
});

test('the prefs size cap counts UTF-8 bytes, not UTF-16 code units', async () => {
  await withServer(async (baseUrl) => {
    const reg = await postJson(baseUrl, '/api/register', { username: 'prefs_bytes', password: 'hunter22' }).then((r) => r.json());
    // 64 entries of 32-char keys and values made of a 2-byte character: every field passes the
    // per-field validators and the payload is well under 8000 characters, but over 8000 bytes.
    const keyBindings = {};
    for (let i = 0; i < 64; i++) keyBindings['\u00e9'.repeat(30) + String(i).padStart(2, '0')] = '\u00e9'.repeat(32);
    const body = JSON.stringify({ keyBindings });
    assert.ok(body.length < 8000, 'payload must be under the cap in characters');
    assert.ok(Buffer.byteLength(body, 'utf8') > 8000, 'payload must be over the cap in bytes');
    const res = await fetch(`${baseUrl}/api/me/prefs`, { method: 'PUT', headers: { ...authed(reg.token), 'Content-Type': 'application/json' }, body });
    assert.equal(res.status, 400);
    const after = await fetch(`${baseUrl}/api/me/prefs`, { headers: authed(reg.token) }).then((r) => r.json());
    assert.deepEqual(after.prefs, {});
  });
});

test('prefs with out-of-range or wrong-typed values are rejected with 400', async () => {
  await withServer(async (baseUrl) => {
    const reg = await postJson(baseUrl, '/api/register', { username: 'prefs_invalid', password: 'hunter22' }).then((r) => r.json());

    const cases = [
      { soundVolume: 500 },                 // out of range (client sends 0-100 percentages)
      { soundVolume: -1 },                   // negative
      { soundVolume: 'loud' },               // wrong type
      { narrator: 'yes' },                   // must be a strict boolean
      { keyBindings: 'not-an-object' },      // must be an object map
      { keyBindings: { fire: 123 } },        // binding values must be strings
    ];
    for (const bad of cases) {
      const res = await fetch(`${baseUrl}/api/me/prefs`, { method: 'PUT', headers: { ...authed(reg.token), 'Content-Type': 'application/json' }, body: JSON.stringify(bad) });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }

    // Nothing invalid ever got stored.
    const got = await fetch(`${baseUrl}/api/me/prefs`, { headers: authed(reg.token) }).then((r) => r.json());
    assert.deepEqual(got.prefs, {});
  });
});

test('deleting an account cascades: sessions, published levels, custom heroes, and login all go away', async () => {
  await withServer(async (baseUrl) => {
    const reg = await postJson(baseUrl, '/api/register', { username: 'doomed_user', password: 'hunter22' }).then((r) => r.json());

    // Unlock the Hero Builder (rank >= 3) and create a custom hero so we can assert it's gone
    // after account deletion (server/account.js deleteAccount -> DELETE FROM heroes).
    await postJson(baseUrl, '/api/heroes/debug/xp', { amount: 700 }, authed(reg.token));
    const hero = await fetch(`${baseUrl}/api/heroes`, {
      method: 'POST', headers: { ...authed(reg.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Doomed Hero', title: '', motto: '',
        stats: { speed: 2, shot: 2, fireRate: 2, armor: 2, magic: 2, health: 2 },
        weapon: 'axe', trait: 'thick_skin', pixels: new Array(8).fill('.222222.'),
      }),
    }).then((r) => r.json());
    assert.ok(hero.id, JSON.stringify(hero));

    const level = {
      name: 'Doomed Level', description: '',
      rows: [
        '############', '#S.........#', '#..........#', '#..........#', '#..........#', '#..........#',
        '#..........#', '#..........#', '#..........#', '#..........#', '#.........E#', '############',
      ],
    };
    const created = await fetch(`${baseUrl}/api/levels`, { method: 'POST', headers: { ...authed(reg.token), 'Content-Type': 'application/json' }, body: JSON.stringify(level) }).then((r) => r.json());
    await fetch(`${baseUrl}/api/levels/${created.id}/publish`, { method: 'POST', headers: authed(reg.token) });
    assert.equal((await fetch(`${baseUrl}/api/levels/${created.id}`)).status, 200);

    const badDelete = await fetch(`${baseUrl}/api/me`, { method: 'DELETE', headers: { ...authed(reg.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
    assert.equal(badDelete.status, 400);

    const del = await fetch(`${baseUrl}/api/me`, { method: 'DELETE', headers: { ...authed(reg.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'hunter22' }) });
    assert.equal(del.status, 200);

    // Session is gone.
    assert.equal((await fetch(`${baseUrl}/api/me`, { headers: authed(reg.token) }).then((r) => r.json())).user, null);
    // Login no longer works.
    assert.equal((await postJson(baseUrl, '/api/login', { username: 'doomed_user', password: 'hunter22' })).status, 400);
    // The level they published is gone (deleted, not just unpublished).
    assert.equal((await fetch(`${baseUrl}/api/levels/${created.id}`)).status, 404);
    // Their custom hero is gone too (it was private, so a guest 403'd on it before; now it's a
    // plain 404 since the row no longer exists at all).
    assert.equal((await fetch(`${baseUrl}/api/heroes/${hero.id}`)).status, 404);
    // Re-registering the same username works again (old row is really gone).
    assert.equal((await postJson(baseUrl, '/api/register', { username: 'doomed_user', password: 'newpass99' })).status, 200);
  });
});
