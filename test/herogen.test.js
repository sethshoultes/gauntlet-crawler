// Coverage for the Hero Builder AI Assist (server/ai/herogen.js + POST /api/heroes/ai). No
// ANTHROPIC_API_KEY is set in this test environment, so generateHeroFromPrompt always exercises the
// deterministic preset-fallback path here — the repair/validation of a *malformed model result* is
// tested directly against the pure `repairHero` helper instead of mocking the Anthropic SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATS, budgetFor, unlockedBuilderItems, validateHero } from '../shared/hero-builder.js';
import { repairHero, generateHeroFromPrompt, aiAvailable } from '../server/ai/herogen.js';
import { startServer } from './helpers/server.mjs';

function total(stats) { return STATS.reduce((s, k) => s + stats[k], 0); }
const RANK3 = { rank: 3, achievements: [] };
const BUDGET3 = budgetFor(RANK3.rank, RANK3.achievements);
const UNLOCKED3 = unlockedBuilderItems(RANK3.rank, RANK3.achievements);

test('this test environment has no AI credentials configured', () => {
  // Sanity check the premise above: if this ever fires, the "preset fallback" assertions below are
  // no longer exercising the fallback path and need rethinking.
  assert.equal(aiAvailable(), false);
});

test('repairHero: a badly malformed "model result" is coerced into something validateHero accepts', () => {
  const malformed = {
    name: '!!not a valid name?? way way way too long for the field',
    title: 'x'.repeat(80),
    motto: 'y'.repeat(400),
    stats: { speed: 99, shot: -5, fireRate: 2.7, armor: 5, magic: 5, health: 5 }, // way over budget, non-integer, negative
    weapon: 'not-a-real-weapon',
    trait: 'not-a-real-trait',
    pixels: ['bad-row', '........', '..', '........', '........', '........', '........', '........', 'one-row-too-many'],
  };
  const hero = repairHero(malformed, { budget: BUDGET3, weaponIds: UNLOCKED3.weapons, traitIds: UNLOCKED3.traits });
  const check = validateHero(hero, RANK3);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  assert.ok(total(hero.stats) <= BUDGET3);
  assert.ok(UNLOCKED3.weapons.includes(hero.weapon));
  assert.equal(hero.trait, null); // unknown trait id is dropped, never crashes
});

test('repairHero: a completely empty object still repairs to something valid', () => {
  const hero = repairHero({}, { budget: BUDGET3, weaponIds: UNLOCKED3.weapons, traitIds: UNLOCKED3.traits });
  const check = validateHero(hero, RANK3);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
});

test('repairHero: stats that sum over budget are trimmed down, never negative', () => {
  const hero = repairHero({ stats: { speed: 5, shot: 5, fireRate: 5, armor: 5, magic: 5, health: 5 } }, {
    budget: BUDGET3, weaponIds: UNLOCKED3.weapons, traitIds: UNLOCKED3.traits,
  });
  assert.equal(total(hero.stats), BUDGET3);
  for (const k of STATS) assert.ok(hero.stats[k] >= 0 && hero.stats[k] <= 5);
});

test('generateHeroFromPrompt: preset fallback is deterministic per prompt (no AI credentials here)', async () => {
  const a1 = await generateHeroFromPrompt({ prompt: 'a shadowy archer who lives on treasure', ...RANK3 });
  const a2 = await generateHeroFromPrompt({ prompt: 'a shadowy archer who lives on treasure', ...RANK3 });
  assert.equal(a1.source, 'preset');
  assert.deepEqual(a1.hero, a2.hero);

  const b = await generateHeroFromPrompt({ prompt: 'a heavily armored bruiser who never runs', ...RANK3 });
  assert.equal(b.source, 'preset');
  assert.equal(validateHero(b.hero, RANK3).ok, true);
});

test('generateHeroFromPrompt: locked (rank < 3) still returns a valid-shaped preset with a note', async () => {
  const out = await generateHeroFromPrompt({ prompt: 'anything', rank: 1, achievements: [] });
  assert.equal(out.source, 'preset');
  assert.match(out.note, /rank 3/i);
});

test('POST /api/heroes/ai: auth, validation, and rate limiting', async (t) => {
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

  try {
    await t.test('a guest is 401d', async () => {
      const r = await api('/api/heroes/ai', { method: 'POST', body: { prompt: 'a fast rogue' } });
      assert.equal(r.status, 401);
    });

    const alice = await register('alice_aihero');

    await t.test('below rank 3, the request is rejected with 400', async () => {
      const r = await api('/api/heroes/ai', { method: 'POST', body: { prompt: 'a fast rogue' }, token: alice });
      assert.equal(r.status, 400);
    });

    // xpForRank(3) = 643, see test/heroes-api.test.js for the same 700-XP calibration.
    const grant = await api('/api/heroes/debug/xp', { method: 'POST', body: { amount: 700 }, token: alice });
    assert.equal(grant.status, 200, JSON.stringify(grant.data));

    await t.test('an empty prompt is rejected with 400', async () => {
      const r = await api('/api/heroes/ai', { method: 'POST', body: { prompt: '   ' }, token: alice });
      assert.equal(r.status, 400);
    });

    await t.test('a valid prompt returns a hero that passes validateHero', async () => {
      const r = await api('/api/heroes/ai', { method: 'POST', body: { prompt: 'a shadowy archer who lives on treasure' }, token: alice });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.ok(['ai', 'preset'].includes(r.data.source));
      assert.equal(typeof r.data.aiAvailable, 'boolean');
      const check = validateHero(r.data.hero, RANK3);
      assert.equal(check.ok, true, JSON.stringify(check.errors));
    });

    await t.test('an immediate second request is rate-limited to 429', async () => {
      const r = await api('/api/heroes/ai', { method: 'POST', body: { prompt: 'a heavily armored bruiser' }, token: alice });
      assert.equal(r.status, 429);
    });

    assert.equal(server.exitCode, null, 'server must still be running throughout');
  } finally {
    await server.stop();
  }
});
