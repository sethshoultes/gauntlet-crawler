// Regression test for the 'endrun' debug hook added for #34 (test/e2e-mobile.mjs): force-ends a
// Death mode run immediately, on the same path a real wipe or level-cap finish would take
// (Room#endRun), rather than needing the WIPE_GRACE_MS wait or a rank-gated cap. Modeled on the
// existing endRun() tests in test/deathmode.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'gauntlet-debug-endrun-test-'));
const { Room } = await import('../server/game/room.js');
const { db } = await import('../server/db.js');

function fakeWs() {
  const sent = [];
  return { readyState: 1, sent, send(s) { sent.push(JSON.parse(s)); } };
}

function makeDeathRoom(overrides = {}) {
  return new Room({ id: 'd1', name: 'Death Room', seed: 'd1', source: { type: 'death' }, isPublic: true, onEmpty: () => {}, ...overrides });
}

test('debugAction("endrun") ends an in-progress run immediately and records it, same as a real wipe', () => {
  const room = makeDeathRoom({ id: 'd-endrun' });
  try {
    const ws = fakeWs();
    const user = { id: 909090, username: 'EndRunTester' };
    room.join(ws, { pid: 'a', user, name: 'EndRunTester', cls: 'warrior' });
    room.start('a'); // solo host — allowed to start unready
    assert.equal(room.state, 'playing');

    room.debugAction('endrun');

    assert.equal(room.state, 'lobby', 'the room drops back to the lobby, same as any other endRun()');
    const overMsg = ws.sent.find((m) => m.t === 'gameover');
    assert.ok(overMsg, 'a gameover message was broadcast');
    assert.equal(overMsg.reason, 'wipe');

    const run = db.prepare('SELECT * FROM runs WHERE user_id = ?').get(user.id);
    assert.ok(run, 'a run row was recorded, same as a real wipe/cap finish');
    assert.equal(run.mode, 'death');
  } finally { room.close(); }
});

test('debugAction("endrun") is a no-op outside of an in-progress run (still in the lobby)', () => {
  const room = makeDeathRoom({ id: 'd-endrun-noop' });
  try {
    const ws = fakeWs();
    room.join(ws, { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    assert.equal(room.state, 'lobby');

    room.debugAction('endrun');

    assert.equal(room.state, 'lobby', 'nothing changes when no run is in progress');
    assert.ok(!ws.sent.some((m) => m.t === 'gameover'), 'no gameover broadcast for a no-op endrun');
  } finally { room.close(); }
});
