// Integration tests for the async AI level-generation API (server/index.js, server/ai/jobs.js).
// No ANTHROPIC_API_KEY is set in this environment, so every generation falls back to the
// procedural generator (server/ai/levelgen.js) -- fast and deterministic enough to poll in a test
// without a real Claude call. Boots the real server as a child process, same pattern as
// test/room-create-rate-limit.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

async function withServer(fn) {
  const server = await startServer();
  try {
    await fn(server.baseUrl);
  } finally {
    await server.stop();
  }
}

function genBody() {
  return JSON.stringify({ prompt: 'a small crypt guarded by ghosts', difficulty: 3, size: 'small' });
}

async function register(baseUrl, username) {
  const r = await fetch(`${baseUrl}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'hunter22' }),
  });
  assert.equal(r.status, 200, `register(${username}) should succeed`);
  return r.json();
}

async function pollUntilDone(baseUrl, jobId, headers, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await fetch(`${baseUrl}/api/levels/generate/${jobId}`, { headers });
    assert.equal(r.status, 200);
    const body = await r.json();
    if (body.status !== 'pending') return body;
    if (Date.now() > deadline) throw new Error('job never finished');
    await new Promise((res) => setTimeout(res, 50));
  }
}

test('POST /api/levels/generate returns 202 with a jobId, and polling reaches "done" with the procedural fallback', async () => {
  await withServer(async (baseUrl) => {
    const startRes = await fetch(`${baseUrl}/api/levels/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: genBody(),
    });
    assert.equal(startRes.status, 202);
    const started = await startRes.json();
    assert.equal(started.status, 'pending');
    assert.equal(typeof started.jobId, 'string');
    assert.ok(started.jobId.length > 0);

    const done = await pollUntilDone(baseUrl, started.jobId, {});
    assert.equal(done.status, 'done');
    assert.equal(done.source, 'procedural', 'no ANTHROPIC_API_KEY is configured in this test environment');
    assert.ok(done.level && Array.isArray(done.level.rows));
    assert.ok(Array.isArray(done.problems));
    assert.equal(done.problems.length, 0);
    assert.ok(Array.isArray(done.unlocked));
  });
});

test('a job belonging to one caller 404s for a different caller', async () => {
  await withServer(async (baseUrl) => {
    const userA = await register(baseUrl, 'genjob_user_a');
    const userB = await register(baseUrl, 'genjob_user_b');
    const headersA = { 'Content-Type': 'application/json', Authorization: `Bearer ${userA.token}` };
    const headersB = { 'Content-Type': 'application/json', Authorization: `Bearer ${userB.token}` };

    const startRes = await fetch(`${baseUrl}/api/levels/generate`, { method: 'POST', headers: headersA, body: genBody() });
    assert.equal(startRes.status, 202);
    const { jobId } = await startRes.json();

    const otherRes = await fetch(`${baseUrl}/api/levels/generate/${jobId}`, { headers: headersB });
    assert.equal(otherRes.status, 404, "another user's caller identity must not be able to read this job");

    const ownRes = await fetch(`${baseUrl}/api/levels/generate/${jobId}`, { headers: headersA });
    assert.ok([200].includes(ownRes.status));
  });
});

test('GET /api/levels/generate/:jobId 404s for an unknown job id', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/levels/generate/doesnotexist`);
    assert.equal(res.status, 404);
  });
});

test('POST /api/levels/generate?wait=1 keeps the old synchronous response shape', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/levels/generate?wait=1`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: genBody(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, undefined, 'the synchronous shape has no job status field');
    assert.equal(body.source, 'procedural');
    assert.ok(body.level && Array.isArray(body.level.rows));
    assert.ok(Array.isArray(body.problems));
    assert.ok(Array.isArray(body.unlocked));
  });
});
