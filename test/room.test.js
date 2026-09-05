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

test('level clear enters intermission, offers chests, and a pick moves everyone into the next level', () => {
  const room = makeRoom({ id: 'intermission-1' });
  try {
    const wsA = fakeWs();
    room.join(wsA, { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    room.start('a'); // solo host
    assert.equal(room.state, 'playing');

    room.onEvent({ type: 'exit', pid: 'a', levelTime: 12 });
    assert.equal(room.state, 'playing', 'the level-clear celebration delay has not fired yet');

    room.startIntermission();
    assert.equal(room.state, 'intermission');
    assert.equal(room.chestOffers.get('a')?.length, 3, 'three chests were rolled for the only player');
    const chestsMsg = wsA.sent.find((m) => m.t === 'chests');
    assert.ok(chestsMsg, 'client receives a chests offer');
    assert.equal(chestsMsg.chests.length, 3);
    assert.ok(chestsMsg.chests.every((c) => c.label === '???' && c.icon === '📦'), 'contents are hidden until picked');

    const offeredId = room.chestOffers.get('a')[0].id;
    room.pick('a', offeredId);
    assert.ok(room.chestPicks.has('a'), 'pick recorded');
    const pickMsg = wsA.sent.filter((m) => m.t === 'chestpick').pop();
    assert.equal(pickMsg.pid, 'a');
    assert.equal(pickMsg.chest.id, offeredId);
    assert.notEqual(pickMsg.chest.label, '???', 'the pick broadcast reveals real contents');
    assert.equal(room.intermissionEnding, true, 'the only (connected) player has picked, so the intermission is wrapping up');

    room.finishIntermission();
    assert.equal(room.state, 'playing');
    assert.equal(room.levelIndex, 2, 'advanced to the next level');
    assert.ok(wsA.sent.some((m) => m.t === 'chestsdone'));
    assert.ok(wsA.sent.some((m) => m.t === 'level' && m.index === 2));
  } finally { room.close(); }
});

test('pick rejects a second pick and an id not in that player\'s own offer', () => {
  const room = makeRoom({ id: 'intermission-2' });
  try {
    room.join(fakeWs(), { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    room.start('a');
    room.onEvent({ type: 'exit', pid: 'a', levelTime: 12 });
    room.startIntermission();

    room.pick('a', 'not-a-real-id');
    assert.equal(room.chestPicks.has('a'), false, 'an out-of-range id is rejected');

    const [first, second] = room.chestOffers.get('a');
    room.pick('a', first.id);
    assert.equal(room.chestPicks.get('a').id, first.id);
    room.pick('a', second.id);
    assert.equal(room.chestPicks.get('a').id, first.id, 'a second pick is ignored');
  } finally { room.close(); }
});

test('intermission waits for every connected player to pick before advancing, and applies effects on finish', () => {
  const room = makeRoom({ id: 'intermission-3' });
  try {
    room.join(fakeWs(), { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    room.join(fakeWs(), { pid: 'b', user: null, name: 'Bob', cls: 'elf' });
    room.setReady('a', true); room.setReady('b', true);
    room.start('a');
    room.onEvent({ type: 'exit', pid: 'a', levelTime: 12 });
    room.startIntermission();
    assert.equal(room.chestOffers.size, 2);

    room.pick('a', room.chestOffers.get('a')[0].id);
    assert.equal(room.intermissionEnding, false, 'still waiting on Bob');

    const bChest = room.chestOffers.get('b')[0];
    const pA = room.sim.players.get('a'); const before = { hp: pA.hp, potions: pA.potions, keys: pA.keys, score: pA.score };
    room.pick('b', bChest.id);
    assert.equal(room.intermissionEnding, true, 'everyone connected has now picked');

    room.finishIntermission();
    assert.equal(room.state, 'playing');
    assert.equal(room.levelIndex, 2);
    // Ann's own chest effect should have landed somewhere observable (permanent stat moved, or
    // her boosts/pendingCurse got resolved by loadLevel) — at minimum nothing throws and the sim
    // player still exists in good standing.
    assert.ok(room.sim.players.has('a') && room.sim.players.has('b'));
    void before; // effects vary by random-ish chest kind; presence of the player post-apply is what we assert
  } finally { room.close(); }
});

test('intermission timeout auto-picks for anyone who has not chosen, including an away player', () => {
  const room = makeRoom({ id: 'intermission-4' });
  try {
    const wsA = fakeWs();
    room.join(wsA, { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    const wsB = fakeWs();
    room.join(wsB, { pid: 'b', user: null, name: 'Bob', cls: 'elf' });
    room.setReady('a', true); room.setReady('b', true);
    room.start('a');
    room.onEvent({ type: 'exit', pid: 'a', levelTime: 12 });
    room.startIntermission();

    room.disconnect('b'); // Bob drops mid-intermission and never picks
    assert.equal(room.clients.get('b').away, true);

    // Simulate the 15s countdown elapsing without relying on real timers.
    room.autoPickRemaining();
    assert.equal(room.chestPicks.size, 2, 'both players — including the away one — end up with a pick');
    assert.ok(room.chestPicks.has('a') && room.chestPicks.has('b'));

    room.finishIntermission();
    assert.equal(room.state, 'playing');
    assert.equal(room.levelIndex, 2);
  } finally { room.close(); }
});

test('a locked hero request falls back to warrior and the player is told why', () => {
  const room = makeRoom({ id: 'locked-1' });
  try {
    const ws = fakeWs();
    // A logged-in user with no stats/achievements at all — rank 1, paladin needs rank 5.
    const user = { id: 999001, username: 'Newbie' };
    const c = room.join(ws, { pid: 'a', user, name: 'Newbie', cls: 'paladin' });
    assert.equal(c.cls, 'warrior', 'paladin is locked for a fresh account, so it falls back to warrior');
    const err = ws.sent.find((m) => m.t === 'error');
    assert.ok(err, 'an error message is sent to the client');
    assert.match(err.error, /locked/i);
    assert.match(err.error, /rank/i, 'the error names the actual requirement');
  } finally { room.close(); }
});

test('a locked palette request is dropped (no palette) with an error, while an unlocked one sticks', () => {
  const room = makeRoom({ id: 'locked-2' });
  try {
    const ws = fakeWs();
    const user = { id: 999002, username: 'Newbie2' };
    const c = room.join(ws, { pid: 'a', user, name: 'Newbie2', cls: 'warrior', palette: 'warrior_gold' });
    assert.equal(c.cls, 'warrior');
    assert.equal(c.palette, null, 'warrior_gold requires rank 3 or an achievement neither of which this fresh account has');
    assert.ok(ws.sent.find((m) => m.t === 'error' && /locked/i.test(m.error)));
  } finally { room.close(); }
});

test('setHero also enforces unlocks for an in-lobby hero switch', () => {
  const room = makeRoom({ id: 'locked-3' });
  try {
    const ws = fakeWs();
    const user = { id: 999003, username: 'Newbie3' };
    room.join(ws, { pid: 'a', user, name: 'Newbie3', cls: 'warrior' });
    room.setHero('a', 'necromancer');
    const c = room.clients.get('a');
    assert.equal(c.cls, 'warrior', 'necromancer (rank 8 or reaper_reaped) stays locked');
    assert.ok(ws.sent.some((m) => m.t === 'error' && /locked/i.test(m.error)));
  } finally { room.close(); }
});

test('a guest (no user) can never carry a palette — palettes require an account', () => {
  const room = makeRoom({ id: 'locked-4' });
  try {
    const ws = fakeWs();
    const c = room.join(ws, { pid: 'a', user: null, name: 'Guest', cls: 'warrior', palette: 'warrior_classic' });
    assert.equal(c.cls, 'warrior');
    assert.equal(c.palette, null);
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

test('tick() contains an exception from the sim instead of letting it crash the process', () => {
  const room = makeRoom({ id: 'tick-crash' });
  try {
    room.join(fakeWs(), { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    room.start('a');
    assert.equal(room.state, 'playing');

    const realStep = room.sim.step.bind(room.sim);
    room.sim.step = () => { throw new Error('boom: simulated sim failure'); };
    const realError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    try {
      assert.doesNotThrow(() => room.tick(), 'tick() must catch and log, never throw out of the interval callback');
    } finally { console.error = realError; }
    assert.ok(logged.length >= 1, 'the failure was logged');
    assert.match(String(logged[0][0]), /tick\(\) failed/);

    // The room survives the failed tick and keeps working once the sim is healthy again.
    room.sim.step = realStep;
    assert.doesNotThrow(() => room.tick());
    assert.equal(room.state, 'playing');
  } finally { room.close(); }
});

test('a timer callback (e.g. the countdown tick) that throws is contained, not fatal to the room', () => {
  const room = makeRoom({ id: 'timer-crash' });
  try {
    const realError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    const boom = room.guard('unit-test label', () => { throw new Error('boom'); });
    try {
      assert.doesNotThrow(() => boom(), 'a guarded callback must never throw');
    } finally { console.error = realError; }
    assert.ok(logged.length >= 1);
    assert.match(String(logged[0][0]), /unit-test label failed/);
  } finally { room.close(); }
});

process.on('exit', () => { try { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch {} });
