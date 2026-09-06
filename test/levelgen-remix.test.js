// #17 AI assist: remix/tune/explain/describe an existing level. These unit tests run with no
// ANTHROPIC_API_KEY set (see test/helpers/server.mjs-based endpoint tests below for the server
// wiring), so every call here exercises the procedural/templated fallback paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remixLevel, explainLevel, describeLevel, aiAvailable } from '../server/ai/levelgen.js';
import { validateLevel, parseLevel } from '../shared/level.js';
import { generateLevel } from '../shared/procgen.js';
import { T, GENERATOR_TILES, MONSTER_TILES } from '../shared/constants.js';
import { startServer } from './helpers/server.mjs';

test('no ANTHROPIC_API_KEY is configured in this test environment', () => {
  assert.equal(aiAvailable(), false, 'these tests exercise the procedural fallback, not the real AI call');
});

function genPlusMon(rows) {
  let n = 0;
  for (const row of rows) for (const c of row) if (GENERATOR_TILES.has(c) || MONSTER_TILES.has(c)) n++;
  return n;
}

// Array.prototype.sort() default-coerces [x,y] pairs to strings ("9" > "20" lexicographically),
// which can reorder an otherwise-identical set of coordinates differently between two calls.
// Sort numerically by (x, then y) instead so deepEqual actually compares the same order.
function sortPts(pts) { return [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]); }

test('remix preserves start/exit coordinates and produces a valid, procedural level', async () => {
  const base = generateLevel({ seed: 'remix-base', level: 6 });
  const parsedBefore = parseLevel(base);
  const out = await remixLevel({ level: base, mode: 'remix' });
  assert.equal(out.source, 'procedural');
  assert.deepEqual(validateLevel(out.level), []);
  const parsedAfter = parseLevel(out.level);
  assert.deepEqual(sortPts(parsedAfter.starts), sortPts(parsedBefore.starts));
  assert.deepEqual(sortPts(parsedAfter.exits), sortPts(parsedBefore.exits));
  for (const [x, y] of parsedBefore.starts) assert.equal(out.level.rows[y][x], base.rows[y][x]);
  for (const [x, y] of parsedBefore.exits) assert.equal(out.level.rows[y][x], base.rows[y][x]);
});

test('remix on a differently-sized level still lands on a valid result with start/exit intact', async () => {
  for (const level of [2, 10, 25]) {
    const base = generateLevel({ seed: `remix-size-${level}`, level });
    const before = parseLevel(base);
    const out = await remixLevel({ level: base, mode: 'remix' });
    assert.deepEqual(validateLevel(out.level), [], `level ${level}`);
    const after = parseLevel(out.level);
    assert.deepEqual(sortPts(after.starts), sortPts(before.starts), `level ${level} starts`);
    assert.deepEqual(sortPts(after.exits), sortPts(before.exits), `level ${level} exits`);
  }
});

test('"harder" increases the generator+monster count and stays valid; "easier" decreases it', async () => {
  const base = generateLevel({ seed: 'tune-base', level: 8 });
  const baseCount = genPlusMon(base.rows);

  const harder = await remixLevel({ level: base, mode: 'harder' });
  assert.equal(harder.source, 'procedural');
  assert.deepEqual(validateLevel(harder.level), []);
  assert.ok(genPlusMon(harder.level.rows) > baseCount, 'harder should add generators/monsters');

  const easier = await remixLevel({ level: base, mode: 'easier' });
  assert.equal(easier.source, 'procedural');
  assert.deepEqual(validateLevel(easier.level), []);
  assert.ok(genPlusMon(easier.level.rows) < baseCount, 'easier should remove generators/monsters');
});

test('"harder"/"easier" preserve start and exit coordinates too', async () => {
  const base = generateLevel({ seed: 'tune-coords', level: 5 });
  const before = parseLevel(base);
  for (const mode of ['harder', 'easier']) {
    const out = await remixLevel({ level: base, mode });
    const after = parseLevel(out.level);
    assert.deepEqual(sortPts(after.starts), sortPts(before.starts), mode);
    assert.deepEqual(sortPts(after.exits), sortPts(before.exits), mode);
  }
});

test('an invalid mode falls back to "remix" rather than throwing', async () => {
  const base = generateLevel({ seed: 'bad-mode', level: 4 });
  const out = await remixLevel({ level: base, mode: 'nonsense' });
  assert.deepEqual(validateLevel(out.level), []);
});

test('explain returns a non-empty templated summary mentioning the level\'s tile counts', async () => {
  const level = generateLevel({ seed: 'explain-me', level: 9 });
  const { explanation } = await explainLevel({ level });
  assert.ok(explanation.length > 0);
  assert.match(explanation, /generator/i);
  const sentences = explanation.split(/(?<=[.!?])\s+/).filter(Boolean);
  assert.ok(sentences.length >= 3 && sentences.length <= 5, `expected 3-5 sentences, got ${sentences.length}: ${explanation}`);
});

test('explain mentions the thief and Death when present', async () => {
  const grid = generateLevel({ seed: 'explain-thief', level: 12 });
  // Force a thief and a Death onto known floor tiles so the templated summary is exercised.
  const rows = grid.rows.map((r) => r.split(''));
  outer: for (let y = 1; y < rows.length - 1; y++) {
    for (let x = 1; x < rows[0].length - 1; x++) {
      if (rows[y][x] === T.FLOOR) { rows[y][x] = T.THIEF; break outer; }
    }
  }
  outer2: for (let y = 1; y < rows.length - 1; y++) {
    for (let x = 1; x < rows[0].length - 1; x++) {
      if (rows[y][x] === T.FLOOR) { rows[y][x] = T.DEATH; break outer2; }
    }
  }
  const level = { name: grid.name, description: grid.description, rows: rows.map((r) => r.join('')) };
  const { explanation } = await explainLevel({ level });
  assert.match(explanation, /thief/i);
  assert.match(explanation, /death/i);
});

test('describeLevel is deterministic per seed (no AI key configured)', async () => {
  const level = generateLevel({ seed: 'name-me', level: 3 });
  const a = await describeLevel({ level, seed: 'seed-one' });
  const b = await describeLevel({ level, seed: 'seed-one' });
  assert.equal(a.name, b.name);
  assert.ok(a.name.length > 0);
  assert.ok(a.description.length > 0);
  const c = await describeLevel({ level, seed: 'seed-two' });
  assert.notEqual(a.name, c.name);
});

// ================================================================================================
// Endpoint tests: POST /api/levels/ai/remix and POST /api/levels/ai/explain, boot the real server
// as a child process (same pattern as test/room-create-rate-limit.test.js).
// ================================================================================================

async function withServer(fn) {
  const server = await startServer();
  try { await fn(server); } finally { await server.stop(); }
}

async function registerUser(baseUrl, username) {
  const reg = await fetch(`${baseUrl}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'hunter22' }),
  }).then((r) => r.json());
  return { token: reg.token, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reg.token}` } };
}

test('POST /api/levels/ai/remix: 401 for a guest', async () => {
  await withServer(async ({ baseUrl }) => {
    const level = generateLevel({ seed: 'ep-guest', level: 3 });
    const res = await fetch(`${baseUrl}/api/levels/ai/remix`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, mode: 'remix' }),
    });
    assert.equal(res.status, 401);
  });
});

test('POST /api/levels/ai/explain: 401 for a guest', async () => {
  await withServer(async ({ baseUrl }) => {
    const level = generateLevel({ seed: 'ep-guest-explain', level: 3 });
    const res = await fetch(`${baseUrl}/api/levels/ai/explain`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level }),
    });
    assert.equal(res.status, 401);
  });
});

test('POST /api/levels/ai/remix: 400 for an invalid level', async () => {
  await withServer(async ({ baseUrl }) => {
    const { headers } = await registerUser(baseUrl, 'remix_bad_level');
    const res = await fetch(`${baseUrl}/api/levels/ai/remix`, {
      method: 'POST', headers, body: JSON.stringify({ level: { rows: ['not a level'] }, mode: 'remix' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });
});

test('POST /api/levels/ai/explain: 400 for an invalid level', async () => {
  await withServer(async ({ baseUrl }) => {
    const { headers } = await registerUser(baseUrl, 'explnbadlvl');
    const res = await fetch(`${baseUrl}/api/levels/ai/explain`, {
      method: 'POST', headers, body: JSON.stringify({ level: {} }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /api/levels/ai/remix: 200 with a valid procedural result, then 429 on an immediate repeat', async () => {
  await withServer(async ({ baseUrl }) => {
    const { headers } = await registerUser(baseUrl, 'remix_ok_user');
    const level = generateLevel({ seed: 'ep-ok', level: 4 });
    const res = await fetch(`${baseUrl}/api/levels/ai/remix`, { method: 'POST', headers, body: JSON.stringify({ level, mode: 'harder' }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, 'procedural'); // no ANTHROPIC_API_KEY in the test environment
    assert.deepEqual(validateLevel(body.level), []);

    const again = await fetch(`${baseUrl}/api/levels/ai/remix`, { method: 'POST', headers, body: JSON.stringify({ level, mode: 'harder' }) });
    assert.equal(again.status, 429, 'a second AI-assist call within 10s for the same user should be rate limited');
  });
});

test('POST /api/levels/ai/explain: 200 with a non-empty explanation, then 429 on an immediate repeat', async () => {
  await withServer(async ({ baseUrl }) => {
    const { headers } = await registerUser(baseUrl, 'explain_ok_user');
    const level = generateLevel({ seed: 'ep-ok-explain', level: 4 });
    const res = await fetch(`${baseUrl}/api/levels/ai/explain`, { method: 'POST', headers, body: JSON.stringify({ level }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.explanation && body.explanation.length > 0);

    const again = await fetch(`${baseUrl}/api/levels/ai/explain`, { method: 'POST', headers, body: JSON.stringify({ level }) });
    assert.equal(again.status, 429, 'a second AI-assist call within 10s for the same user should be rate limited');
  });
});

test('remix and explain share the same per-user AI rate-limit bucket as /api/levels/generate', async () => {
  await withServer(async ({ baseUrl }) => {
    const { headers } = await registerUser(baseUrl, 'sharedbucket1');
    const gen = await fetch(`${baseUrl}/api/levels/generate?wait=1`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'a small crypt' }) });
    assert.equal(gen.status, 200);
    const level = generateLevel({ seed: 'ep-shared', level: 4 });
    const remix = await fetch(`${baseUrl}/api/levels/ai/remix`, { method: 'POST', headers, body: JSON.stringify({ level, mode: 'remix' }) });
    assert.equal(remix.status, 429, 'a generate call moments earlier should already have used up this user\'s shared AI-assist budget');
  });
});
