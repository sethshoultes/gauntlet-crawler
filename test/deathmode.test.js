import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Room (and its db import) creates a sqlite file under DATA_DIR on import — point it at a
// scratch directory before the (dynamic) import so we never touch the real ./data.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'gauntlet-death-test-'));
const { Room } = await import('../server/game/room.js');
const { db } = await import('../server/db.js');

function fakeWs() {
  const sent = [];
  return { readyState: 1, sent, send(s) { sent.push(JSON.parse(s)); } };
}

function makeDeathRoom(overrides = {}) {
  return new Room({ id: 'd1', name: 'Death Room', seed: 'd1', source: { type: 'death' }, isPublic: true, onEmpty: () => {}, ...overrides });
}

test('a death-mode room generates an arena level with a sealed exit from the start', () => {
  const room = makeDeathRoom({ id: 'd-sealed' });
  try {
    assert.equal(room.sim.mode, 'death');
    assert.equal(room.sim.exitSealed, true, 'level 1 loads sealed in death mode');
  } finally { room.close(); }
});

test('death mode runs a wave loop that seals the exit until every wave clears, then unseals it', () => {
  const room = makeDeathRoom({ id: 'd-waves' });
  try {
    const ws = fakeWs();
    room.join(ws, { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    room.start('a'); // solo host — allowed to start unready
    assert.equal(room.state, 'playing');
    assert.equal(room.sim.exitSealed, true);
    assert.equal(room.waveCount, 3, 'level 1 death mode runs 3 waves');

    const firstWave = ws.sent.find((m) => m.t === 'wave');
    assert.ok(firstWave, 'a WAVE banner message was broadcast');
    assert.equal(firstWave.n, 1);
    assert.equal(firstWave.total, 3);

    for (let w = 1; w <= room.waveCount; w++) {
      assert.ok(room.waveBannerTimer, `banner timer pending before wave ${w} spawns`);
      clearTimeout(room.waveBannerTimer); room.waveBannerTimer = null;
      room.spawnWave();
      assert.ok(room.waveMonsterIds.size > 0, `wave ${w} spawned at least one monster`);
      for (const id of room.waveMonsterIds) room.sim.monsters.delete(id); // simulate the party killing the wave
      room.checkWaveAdvance(false);
    }

    assert.equal(room.sim.exitSealed, false, 'exit unseals once every wave on the level is cleared');
    assert.ok(ws.sent.some((m) => m.t === 'exitopen'), 'client is told the exit opened');
  } finally { room.close(); }
});

test('a wave forces itself to advance after its timeout even if monsters are still alive', () => {
  const room = makeDeathRoom({ id: 'd-timeout' });
  try {
    room.join(fakeWs(), { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    room.start('a');
    clearTimeout(room.waveBannerTimer); room.waveBannerTimer = null;
    room.spawnWave();
    assert.equal(room.waveNum, 1);
    assert.ok(room.waveMonsterIds.size > 0, 'wave 1 has live monsters');
    room.checkWaveAdvance(false); // monsters still alive, not a timeout — nothing should change
    assert.equal(room.waveNum, 1);
    room.checkWaveAdvance(true); // simulates the wave's own forced-timeout firing
    assert.equal(room.waveNum, 2, 'the timeout force-advances the wave regardless of survivors');
  } finally { room.close(); }
});

test('death mode ends the run once the party clears the rank-gated level cap, and records the run', () => {
  const room = makeDeathRoom({ id: 'd-cap' });
  try {
    const ws = fakeWs();
    const user = { id: 424242, username: 'CapTester' };
    room.join(ws, { pid: 'a', user, name: 'CapTester', cls: 'warrior' });
    room.start('a');
    assert.equal(room.computeDeathCap(), 99, 'a fresh (rank 1) account caps at level 99');

    // Pretend the party is already standing on the capped level and reaches its exit.
    room.levelIndex = 99;
    room.onEvent({ type: 'exit', pid: 'a', levelTime: 5 });
    assert.ok(room.levelChangeTimer, 'the level-clear celebration delay was scheduled');
    clearTimeout(room.levelChangeTimer); room.levelChangeTimer = null;
    room.endRun('cap'); // what that timer would have called

    assert.equal(room.state, 'lobby', 'the room returns to the lobby after hitting the cap');
    assert.equal(room.levelIndex, 1, 'level resets so the party can run it again');
    const overMsg = ws.sent.find((m) => m.t === 'gameover');
    assert.ok(overMsg, 'a gameover message was broadcast');
    assert.equal(overMsg.reason, 'cap');
    assert.equal(overMsg.cap, 99);

    const run = db.prepare('SELECT * FROM runs WHERE user_id = ?').get(user.id);
    assert.ok(run, 'a run row was recorded');
    assert.equal(run.mode, 'death', 'the run is tagged as a death-mode run');
    assert.equal(run.level_reached, 99);
  } finally { room.close(); }
});

test('death mode ends the run as a wipe once everyone stays dead past the grace period', () => {
  const room = makeDeathRoom({ id: 'd-wipe' });
  try {
    room.join(fakeWs(), { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    room.start('a');
    const p = room.sim.players.get('a');
    p.dead = true;
    room.checkWipe();
    assert.ok(room.allDeadSince, 'the wipe clock starts once everyone is dead');
    assert.equal(room.state, 'playing', 'not ended yet — the grace period has not elapsed');

    room.allDeadSince = Date.now() - 11000; // fast-forward past the grace period without a real wait
    room.checkWipe();
    assert.equal(room.state, 'lobby', 'the run ends as a wipe once the grace period elapses');
  } finally { room.close(); }
});

test('reviving before the grace period elapses cancels the pending wipe', () => {
  const room = makeDeathRoom({ id: 'd-revive' });
  try {
    room.join(fakeWs(), { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    room.start('a');
    const p = room.sim.players.get('a');
    p.dead = true;
    room.checkWipe();
    assert.ok(room.allDeadSince);
    p.dead = false; // player continued ("insert coin")
    room.checkWipe();
    assert.equal(room.allDeadSince, null, 'the wipe clock resets once someone is alive again');
    assert.equal(room.state, 'playing');
  } finally { room.close(); }
});

test('campaign mode rooms never seal the exit or run a wave loop', () => {
  const room = new Room({ id: 'campaign-1', name: 'Campaign Room', seed: 'c1', source: { type: 'campaign' }, isPublic: true, onEmpty: () => {} });
  try {
    room.join(fakeWs(), { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    room.start('a');
    assert.equal(room.sim.mode, 'campaign');
    assert.equal(room.sim.exitSealed, false);
    assert.equal(room.waveCount, 0);
  } finally { room.close(); }
});

process.on('exit', () => { try { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch {} });
