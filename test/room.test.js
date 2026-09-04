import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Room imports server/db.js, which creates a sqlite file under DATA_DIR on import — point it at
// a scratch directory before the (dynamic) import so we never touch the real ./data.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'gauntlet-room-test-'));
const { Room } = await import('../server/game/room.js');

function fakeWs() {
  const sent = [];
  return { readyState: 1, sent, send(s) { sent.push(JSON.parse(s)); } };
}

function makeRoom(overrides = {}) {
  return new Room({ id: 'r1', name: 'Test Room', seed: 'r1', source: { type: 'campaign' }, isPublic: true, onEmpty: () => {}, ...overrides });
}

test('room starts in lobby and does not start the sim until start', () => {
  const room = makeRoom();
  try {
    assert.equal(room.state, 'lobby');
    const wsA = fakeWs();
    const cA = room.join(wsA, { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    assert.equal(room.state, 'lobby');
    assert.equal(room.sim.players.size, 0, 'joining a lobby room does not spawn a sim entity yet');
    assert.equal(room.hostPid, 'a', 'first joiner becomes host');

    const wsB = fakeWs();
    room.join(wsB, { pid: 'b', user: null, name: 'Bob', cls: 'elf' });
    assert.equal(room.sim.players.size, 0);

    // Host alone would be allowed to start, but with a second (unready) player present it's gated.
    assert.throws(() => room.start('a'), /ready/i);

    room.setReady('a', true);
    room.setReady('b', true);
    room.start('a');
    assert.equal(room.state, 'playing');
    assert.equal(room.sim.players.size, 2, 'starting moves every lobby client into the sim');
    assert.ok(cA);
  } finally { room.close(); }
});

test('host migrates to the next player when the host leaves', () => {
  const room = makeRoom();
  try {
    room.join(fakeWs(), { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    room.join(fakeWs(), { pid: 'b', user: null, name: 'Bob', cls: 'elf' });
    assert.equal(room.hostPid, 'a');
    room.leave('a');
    assert.equal(room.hostPid, 'b', 'host migrates to the remaining player');
    assert.equal(room.clients.size, 1);
  } finally { room.close(); }
});

test('ready gating: solo host may start unready, but a group needs everyone ready', () => {
  const solo = makeRoom({ id: 'solo' });
  try {
    solo.join(fakeWs(), { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    assert.doesNotThrow(() => solo.start('a'), 'a lone host does not need to ready up');
    assert.equal(solo.state, 'playing');
  } finally { solo.close(); }

  const group = makeRoom({ id: 'group' });
  try {
    group.join(fakeWs(), { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    group.join(fakeWs(), { pid: 'b', user: null, name: 'Bob', cls: 'elf' });
    assert.throws(() => group.start('a'), /ready/i);
    group.setReady('b', true);
    assert.throws(() => group.start('a'), /ready/i, 'host itself still needs to be ready');
    group.setReady('a', true);
    assert.doesNotThrow(() => group.start('a'));
    assert.equal(group.state, 'playing');
  } finally { group.close(); }

  const notHost = makeRoom({ id: 'nothost' });
  try {
    notHost.join(fakeWs(), { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    notHost.join(fakeWs(), { pid: 'b', user: null, name: 'Bob', cls: 'elf' });
    assert.throws(() => notHost.start('b'), /host/i);
  } finally { notHost.close(); }
});

test('a resume token re-attaches the same sim player within the grace period, preserving score', () => {
  const room = makeRoom();
  try {
    const ws1 = fakeWs();
    const c = room.join(ws1, { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    room.start('a'); // solo host — allowed to start unready
    assert.equal(room.state, 'playing');
    const p = room.sim.players.get('a');
    assert.ok(p, 'sim player exists after start');
    p.score = 777; p.keys = 2; p.potions = 1; p.hp = 555;

    const resumeToken = c.resume;
    assert.ok(resumeToken, 'a resume token was issued on join');

    room.disconnect('a');
    assert.equal(room.clients.get('a').away, true, 'client is marked away, not removed');
    assert.equal(room.sim.players.has('a'), true, 'sim entity is kept while away');

    const ws2 = fakeWs();
    const reattached = room.resume(ws2, resumeToken);
    assert.ok(reattached, 'resume() found the away client and re-attached it');
    assert.equal(reattached.pid, 'a');
    assert.equal(reattached.away, false);
    assert.equal(reattached.ws, ws2);

    const p2 = room.sim.players.get('a');
    assert.equal(p2.score, 777, 'score preserved across reconnect');
    assert.equal(p2.keys, 2, 'keys preserved across reconnect');
    assert.equal(p2.potions, 1, 'potions preserved across reconnect');
    assert.equal(p2.hp, 555, 'health preserved across reconnect');

    // A stale/unknown token should not resume anything.
    assert.equal(room.resume(fakeWs(), 'not-a-real-token'), null);
  } finally { room.close(); }
});

test('kick removes the player and records a fresh sim state should they somehow rejoin', () => {
  const room = makeRoom();
  try {
    room.join(fakeWs(), { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    room.join(fakeWs(), { pid: 'b', user: null, name: 'Bob', cls: 'elf' });
    assert.throws(() => room.kick('b', 'a'), /host/i, 'only the host can kick');
    room.kick('a', 'b');
    assert.equal(room.clients.has('b'), false);
    assert.equal(room.clients.size, 1);
  } finally { room.close(); }
});

process.on('exit', () => { try { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch {} });
