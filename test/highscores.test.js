// Coverage for server/highscores.js (#14): the pure qualification helper is tested in-process
// against the real sqlite-backed module; the HTTP surface (GET /api/highscores, POST
// /api/runs/:id/initials) is exercised end-to-end via startServer() + the GAUNTLET_DEBUG=1 debug
// hook that seeds a run directly, the way test/heroes-api.test.js seeds XP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

// server/db.js creates its sqlite file under DATA_DIR at import time — point it at a scratch
// directory before the (dynamic) import so this in-process half of the suite never touches ./data.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'gauntlet-highscores-test-'));
const { qualifiesForHighScore, recordHighScore, setInitials, topHighScores } = await import('../server/highscores.js');

// ---------------- pure function ----------------
test('qualifiesForHighScore: board with fewer than `limit` entries always qualifies', () => {
  assert.equal(qualifiesForHighScore(1, [], 10), true);
  assert.equal(qualifiesForHighScore(1, [500, 200, 300], 10), true);
});

test('qualifiesForHighScore: full board needs to beat the current lowest', () => {
  const top10 = [1000, 900, 800, 700, 600, 500, 400, 300, 200, 100];
  assert.equal(qualifiesForHighScore(150, top10, 10), true);
  assert.equal(qualifiesForHighScore(100, top10, 10), false, 'a tie does not bump an existing entry');
  assert.equal(qualifiesForHighScore(99, top10, 10), false);
});

test('qualifiesForHighScore: non-finite scores never qualify', () => {
  assert.equal(qualifiesForHighScore(NaN, [], 10), false);
  assert.equal(qualifiesForHighScore(undefined, [], 10), false);
});

// ---------------- in-process module (real sqlite, scratch DATA_DIR) ----------------
test('recordHighScore + topHighScores: guest and logged-in runs both land on the board, ranked by score', () => {
  const a = recordHighScore({ userId: 42, username: 'Alice', cls: 'wizard', score: 5000, level: 12, mode: 'death', endedAt: Math.floor(Date.now() / 1000) });
  const b = recordHighScore({ guestId: 'guest-1', cls: 'elf', score: 8000, level: 20, mode: 'death', endedAt: Math.floor(Date.now() / 1000) });
  assert.equal(a.qualifies, true);
  assert.equal(b.qualifies, true);
  const top = topHighScores(10);
  assert.equal(top[0].score, 8000);
  assert.equal(top[0].username, null, 'a guest run carries no username');
  assert.equal(top[1].score, 5000);
  assert.equal(top[1].username, 'Alice');
  assert.equal(top[0].initials, null, 'nobody has claimed initials yet');
});

test('setInitials: rejects a malformed pattern, then accepts, then one-shots', () => {
  const { id } = recordHighScore({ guestId: 'guest-2', cls: 'warrior', score: 12345, level: 5, endedAt: Math.floor(Date.now() / 1000) });
  assert.throws(() => setInitials(id, 'ab1'), (err) => err.status === 400);
  assert.throws(() => setInitials(id, 'ABCD'), (err) => err.status === 400);
  const ok = setInitials(id, 'ABC');
  assert.deepEqual(ok, { id, initials: 'ABC' });
  assert.throws(() => setInitials(id, 'XYZ'), (err) => err.status === 409, 'a second attempt on the same run is rejected');
  const top = topHighScores(10);
  assert.equal(top.find((r) => r.score === 12345)?.initials, 'ABC');
});

test('setInitials: the claim window expires 5 minutes after the run ended', () => {
  const staleEndedAt = Math.floor(Date.now() / 1000) - 301;
  const { id } = recordHighScore({ guestId: 'guest-3', cls: 'valkyrie', score: 999, level: 3, endedAt: staleEndedAt });
  assert.throws(() => setInitials(id, 'OLD'), (err) => err.status === 409);
});

test('setInitials: 404 for an unknown run id', () => {
  assert.throws(() => setInitials(999999, 'ABC'), (err) => err.status === 404);
});

// ---------------- HTTP surface ----------------
test('HTTP: GET /api/highscores shape/order, POST /api/runs/:id/initials validation and one-shot rule', async (t) => {
  const server = await startServer({ env: { GAUNTLET_DEBUG: '1' } });
  const { baseUrl } = server;
  async function api(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(baseUrl + pathname, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }
  async function seedRun(overrides = {}) {
    const r = await api('/api/debug/highscore', { method: 'POST', body: { cls: 'warrior', score: 100, level: 1, ...overrides } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.id;
  }

  try {
    await t.test('an empty board renders with no scores', async () => {
      const r = await api('/api/highscores');
      assert.equal(r.status, 200);
      assert.deepEqual(r.data.scores, []);
    });

    let ids;
    await t.test('seeding several runs — GET /api/highscores returns them ranked score DESC', async () => {
      ids = {
        low: await seedRun({ cls: 'elf', score: 100, level: 2, username: 'Low' }),
        mid: await seedRun({ cls: 'wizard', score: 5000, level: 10, username: 'Mid' }),
        high: await seedRun({ cls: 'valkyrie', score: 9000, level: 20, guestId: 'g-http-1' }),
      };
      const r = await api('/api/highscores');
      assert.equal(r.status, 200);
      const scores = r.data.scores.map((s) => s.score);
      assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'scores are sorted descending');
      assert.equal(r.data.scores[0].score, 9000);
      assert.equal(r.data.scores[0].username, null, 'guest run has no username');
      assert.equal(r.data.scores[0].class, 'valkyrie');
      assert.equal(r.data.scores[0].level_reached, 20);
      assert.ok(Number.isFinite(r.data.scores[0].ended_at));
      assert.equal(r.data.scores.some((s) => s.username === 'Mid'), true);
    });

    await t.test('POST initials 400s on anything but exactly three A-Z letters', async () => {
      for (const bad of ['ab1', 'AB', 'ABCD', '', '123']) {
        const r = await api(`/api/runs/${ids.high}/initials`, { method: 'POST', body: { initials: bad } });
        assert.equal(r.status, 400, `expected 400 for initials=${JSON.stringify(bad)}`);
      }
    });

    await t.test('a valid claim succeeds and shows up on the board', async () => {
      const r = await api(`/api/runs/${ids.high}/initials`, { method: 'POST', body: { initials: 'ACE' } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.data, { id: ids.high, initials: 'ACE' });
      const board = await api('/api/highscores');
      assert.equal(board.data.scores[0].initials, 'ACE');
    });

    await t.test('a second claim on the same run is rejected with 409', async () => {
      const r = await api(`/api/runs/${ids.high}/initials`, { method: 'POST', body: { initials: 'ZZZ' } });
      assert.equal(r.status, 409);
    });

    await t.test('claiming an unknown run id 404s', async () => {
      const r = await api('/api/runs/999999999/initials', { method: 'POST', body: { initials: 'ABC' } });
      assert.equal(r.status, 404);
    });

    await t.test('the debug seed hook is unreachable without GAUNTLET_DEBUG=1', async () => {
      const plain = await startServer();
      try {
        const r = await fetch(plain.baseUrl + '/api/debug/highscore', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cls: 'warrior', score: 1, level: 1 }),
        });
        assert.equal(r.status, 404);
      } finally {
        await plain.stop();
      }
    });
  } finally {
    await server.stop();
  }
});

process.on('exit', () => { try { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch {} });
