// End-to-end coverage for server/heroes.js. Boots the real server as a child process (like
// test/server-static.test.js) with GAUNTLET_DEBUG=1 so the /api/heroes/debug/xp test-only hook
// is reachable, then drives the whole Hero Builder API lifecycle over plain fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

const VALID_STATS = { speed: 2, shot: 2, fireRate: 2, armor: 2, magic: 2, health: 2 }; // 12 notches
const VALID_PIXELS = new Array(8).fill('.222222.');

function heroPayload(overrides = {}) {
  return {
    name: 'Test Hero', title: 'The Test', motto: 'For science.',
    stats: VALID_STATS, weapon: 'axe', trait: 'thick_skin', pixels: VALID_PIXELS,
    ...overrides,
  };
}

test('Hero Builder API: full lifecycle', async (t) => {
  const server = await startServer({ env: { GAUNTLET_DEBUG: '1' } });
  const { baseUrl } = server;

  async function api(pathname, { method = 'GET', body, token } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(baseUrl + pathname, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }
  async function register(username) {
    const r = await api('/api/register', { method: 'POST', body: { username, password: 'password123' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.token;
  }
  async function grantXp(token, amount) {
    const r = await api('/api/heroes/debug/xp', { method: 'POST', body: { amount }, token });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  }

  try {
    await t.test('gallery is open to guests', async () => {
      const r = await api('/api/heroes/gallery');
      assert.equal(r.status, 200);
      assert.deepEqual(r.data.heroes, []);
    });

    await t.test('every other route 401s a guest', async () => {
      for (const [pathname, method] of [
        ['/api/heroes/mine', 'GET'], ['/api/heroes/budget', 'GET'], ['/api/heroes', 'POST'],
        ['/api/heroes/1', 'DELETE'], ['/api/heroes/1/publish', 'POST'], ['/api/heroes/1/clone', 'POST'],
      ]) {
        const r = await api(pathname, { method });
        assert.equal(r.status, 401, `${method} ${pathname}`);
      }
    });

    const alice = await register('alice_hero');

    await t.test('budget reports locked at rank 1 (fresh account)', async () => {
      const r = await api('/api/heroes/budget', { token: alice });
      assert.equal(r.status, 200);
      assert.equal(r.data.rank, 1);
      assert.equal(r.data.unlocked, false);
      assert.equal(r.data.budget, 0);
    });

    await t.test('creating a hero below rank 3 is rejected', async () => {
      const r = await api('/api/heroes', { method: 'POST', body: heroPayload(), token: alice });
      assert.equal(r.status, 400);
    });

    // xpForRank(3) = 643, xpForRank(4) = 1507 (RANK_BASE_XP=150, exponent 2.1) — 700 XP lands
    // exactly at rank 3, so budgetFor stays the base 12 (no rank-6/9 bonus) for a clean assertion.
    await grantXp(alice, 700);

    let aliceHeroId;
    await t.test('budget unlocks at rank >= 3', async () => {
      const r = await api('/api/heroes/budget', { token: alice });
      assert.equal(r.status, 200);
      assert.ok(r.data.rank >= 3, JSON.stringify(r.data));
      assert.equal(r.data.unlocked, true);
      assert.equal(r.data.budget, 12);
      assert.ok(r.data.weapons.includes('axe'));
      assert.ok(r.data.traits.includes('thick_skin'));
    });

    await t.test('create a hero', async () => {
      const r = await api('/api/heroes', { method: 'POST', body: heroPayload(), token: alice });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.ok(r.data.id);
      aliceHeroId = r.data.id;
      assert.equal(r.data.hero.name, 'Test Hero');
      assert.equal(r.data.hero.published, false);
    });

    await t.test('update the hero by id', async () => {
      const r = await api('/api/heroes', { method: 'POST', body: heroPayload({ id: aliceHeroId, motto: 'Updated motto.' }), token: alice });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.hero.motto, 'Updated motto.');
    });

    await t.test('exceeding the stat budget is rejected with 400', async () => {
      const r = await api('/api/heroes', {
        method: 'POST',
        body: heroPayload({ id: aliceHeroId, stats: { speed: 5, shot: 5, fireRate: 5, armor: 5, magic: 5, health: 5 } }),
        token: alice,
      });
      assert.equal(r.status, 400);
      assert.ok(r.data.error);
    });

    await t.test('a non-integer stat notch (e.g. 1.4) is rejected with 400, not silently rounded', async () => {
      const r = await api('/api/heroes', {
        method: 'POST',
        body: heroPayload({ id: aliceHeroId, stats: { ...VALID_STATS, speed: 1.4 } }),
        token: alice,
      });
      assert.equal(r.status, 400, JSON.stringify(r.data));
      assert.match(r.data.error, /whole number/i);
    });

    await t.test('mine lists the created hero', async () => {
      const r = await api('/api/heroes/mine', { token: alice });
      assert.equal(r.status, 200);
      assert.equal(r.data.heroes.length, 1);
      assert.equal(r.data.heroes[0].id, aliceHeroId);
    });

    await t.test('publish toggles on', async () => {
      const r = await api(`/api/heroes/${aliceHeroId}/publish`, { method: 'POST', token: alice });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.published, true);
    });

    await t.test('gallery now lists the published hero with author', async () => {
      const r = await api('/api/heroes/gallery');
      assert.equal(r.status, 200);
      assert.equal(r.data.heroes.length, 1);
      assert.equal(r.data.heroes[0].id, aliceHeroId);
      assert.equal(r.data.heroes[0].author, 'alice_hero');
    });

    const bob = await register('bob_hero');
    await grantXp(bob, 700);

    let bobCloneId;
    await t.test('a second user can clone the published hero', async () => {
      const r = await api(`/api/heroes/${aliceHeroId}/clone`, { method: 'POST', token: bob });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      bobCloneId = r.data.id;
      assert.notEqual(bobCloneId, aliceHeroId);
      assert.equal(r.data.hero.name, 'Test Hero');
    });

    await t.test('clone incremented the original hero\'s clones counter', async () => {
      const r = await api('/api/heroes/gallery');
      assert.equal(r.data.heroes.find((h) => h.id === aliceHeroId).clones, 1);
    });

    await t.test('the 5-hero-per-user limit is enforced', async () => {
      for (let i = 0; i < 4; i++) {
        const r = await api('/api/heroes', { method: 'POST', body: heroPayload({ name: `Extra ${i}` }), token: bob });
        assert.equal(r.status, 200, JSON.stringify(r.data));
      }
      // bob now owns 5 heroes (1 clone + 4 extras) — a 6th must be rejected.
      const over = await api('/api/heroes', { method: 'POST', body: heroPayload({ name: 'One Too Many' }), token: bob });
      assert.equal(over.status, 400);
      assert.match(over.data.error, /limit/i);
    });

    await t.test('a private (unpublished) hero 403s a non-owner and 200s the owner', async () => {
      const forbidden = await api(`/api/heroes/${bobCloneId}`, { method: 'GET' }); // guest, bob's clone is unpublished
      assert.equal(forbidden.status, 403);
      const ok = await api(`/api/heroes/${bobCloneId}`, { token: bob });
      assert.equal(ok.status, 200);
    });

    await t.test('delete removes the hero', async () => {
      const r = await api(`/api/heroes/${bobCloneId}`, { method: 'DELETE', token: bob });
      assert.equal(r.status, 200);
      const mine = await api('/api/heroes/mine', { token: bob });
      assert.ok(!mine.data.heroes.some((h) => h.id === bobCloneId));
    });

    await t.test('deleting someone else\'s hero 403s', async () => {
      const r = await api(`/api/heroes/${aliceHeroId}`, { method: 'DELETE', token: bob });
      assert.equal(r.status, 403);
    });

    assert.equal(server.exitCode, null, 'server must still be running throughout');
  } finally {
    await server.stop();
  }
});
