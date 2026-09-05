// Unit tests for the in-memory job store backing the async AI level-generation API
// (server/ai/jobs.js). See test/levelgen-api.test.js for the HTTP-level behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startJob, getJob, _clear, _size, JobStoreFullError } from '../server/ai/jobs.js';

function tick() { return new Promise((r) => setImmediate(r)); }

test('startJob resolves to status "done" with the runner\'s result', async () => {
  _clear();
  const id = startJob('u1', async () => ({ ok: true }));
  const job = getJob(id, 'u1');
  assert.equal(job.status, 'pending');
  await tick(); await tick();
  assert.equal(getJob(id, 'u1').status, 'done');
  assert.deepEqual(getJob(id, 'u1').result, { ok: true });
});

test('a runner that throws produces status "error" with the message', async () => {
  _clear();
  const id = startJob('u1', async () => { throw new Error('boom'); });
  await tick(); await tick();
  const job = getJob(id, 'u1');
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'boom');
});

test('getJob returns undefined for a different owner (looks like 404 to the caller)', async () => {
  _clear();
  const id = startJob('u1', async () => ({ ok: true }));
  assert.equal(getJob(id, 'u2'), undefined);
  assert.ok(getJob(id, 'u1'));
});

test('getJob returns undefined for an unknown job id', () => {
  _clear();
  assert.equal(getJob('nope', 'u1'), undefined);
});

test('the store is capped at 200 concurrent entries: a finished job is evicted to make room', async () => {
  _clear();
  const first = startJob('u1', async () => ({ n: 0 }));
  await tick(); await tick(); // let it finish so it's eligible for eviction
  for (let i = 1; i < 200; i++) startJob('u1', async () => ({ n: i })); // fill to the cap (still pending)
  assert.equal(_size(), 200);
  // One more job should evict the finished one above rather than growing past the cap.
  const extra = startJob('u1', async () => ({ n: 200 }));
  assert.equal(_size(), 200);
  assert.equal(getJob(first, 'u1'), undefined, 'the oldest finished job should have been evicted');
  assert.ok(getJob(extra, 'u1'));
});

test('the cap holds when every job is still pending: the extra request is refused with a 503-style error', async () => {
  _clear();
  for (let i = 0; i < 200; i++) startJob('u1', () => new Promise(() => {})); // never settle
  assert.equal(_size(), 200);
  assert.throws(() => startJob('u1', async () => ({})), (err) => err instanceof JobStoreFullError && err.status === 503);
  assert.equal(_size(), 200, 'the store must not grow past the cap');
  _clear();
});
