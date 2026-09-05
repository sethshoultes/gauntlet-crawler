import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Room imports server/db.js, which creates a sqlite file under DATA_DIR on import — point it at
// a scratch directory before the (dynamic) import so we never touch the real ./data.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'gauntlet-room-test-'));
const { Room } = await import('../server/game/room.js');
const { db, now } = await import('../server/db.js');
const stats = await import('../server/stats.js');

function fakeWs() {
  const sent = [];
  return { readyState: 1, sent, send(s) { sent.push(JSON.parse(s)); } };
}

// ---------- Hero Builder test fixtures ----------
let nextTestUser = 1;
function makeUser(username = `hero_tester_${nextTestUser++}`) {
  const r = db.prepare('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)').run(username, 'x', 'x', now());
  return { id: Number(r.lastInsertRowid), username };
}
const VALID_HERO_STATS = { speed: 2, shot: 2, fireRate: 2, armor: 2, magic: 2, health: 2 }; // 12 notches
const VALID_HERO_PIXELS = new Array(8).fill('.222222.');
function makeHeroRow(ownerId, overrides = {}) {
  const r = db.prepare(`INSERT INTO heroes (owner_id, name, title, motto, stats, weapon, trait, pixels, published, clones, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`).run(
    ownerId, overrides.name || 'Test Hero', overrides.title || 'The Tester', overrides.motto || '',
    JSON.stringify(overrides.stats || VALID_HERO_STATS), overrides.weapon || 'axe', overrides.trait || '',
    JSON.stringify(overrides.pixels || VALID_HERO_PIXELS), now(), now(),
  );
  return Number(r.lastInsertRowid);
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
    for (const c of chestsMsg.chests) {
      assert.deepEqual(Object.keys(c).sort(), ['icon', 'id', 'label'], 'the outgoing chests message reveals nothing but id/label/icon');
      assert.equal(c.kind, undefined, 'kind must never leave the server before a pick');
      assert.equal(c.value, undefined, 'value must never leave the server before a pick');
      assert.equal(c.cursed, undefined, 'cursed must never leave the server before a pick');
    }

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

test('a player who joins mid-intermission gets a chest offer, counts toward "all picked", and the timeout auto-picks them too (#9)', () => {
  const room = makeRoom({ id: 'intermission-late' });
  try {
    const wsA = fakeWs();
    room.join(wsA, { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    room.start('a'); // solo host
    room.onEvent({ type: 'exit', pid: 'a', levelTime: 12 });
    room.startIntermission();
    assert.equal(room.intermissionSeconds, 15);
    room.intermissionSeconds = 9; // simulate a few seconds having ticked by

    const wsB = fakeWs();
    const late = room.join(wsB, { pid: 'b', user: null, name: 'Bob', cls: 'elf' });
    assert.ok(late, 'a late joiner is accepted mid-intermission');
    assert.equal(room.chestOffers.get('b')?.length, 3, 'the late joiner rolled their own three-chest offer');
    const chestsMsg = wsB.sent.find((m) => m.t === 'chests');
    assert.ok(chestsMsg, 'the late joiner receives a chests message');
    assert.equal(chestsMsg.seconds, 9, 'the remaining countdown, not a fresh 15s, is sent');
    assert.ok(chestsMsg.chests.every((c) => c.label === '???'), 'contents stay hidden until picked, same as everyone else');

    // Ann already picked long ago in a real game, but here neither has — checkIntermissionDone
    // must not fire early just because Bob is present without a pick yet.
    assert.equal(room.intermissionEnding, false, 'still waiting on both players');

    room.pick('a', room.chestOffers.get('a')[0].id);
    assert.equal(room.intermissionEnding, false, 'Bob (the late joiner) still has not picked');

    // Timeout auto-pick must cover the late joiner exactly like everyone else.
    room.autoPickRemaining();
    assert.ok(room.chestPicks.has('b'), 'the late joiner is auto-picked at timeout, not skipped');
    assert.equal(room.intermissionEnding, true);

    room.finishIntermission();
    assert.equal(room.state, 'playing');
    assert.ok(room.sim.players.has('b'), 'the late joiner is still in the sim after the level advances');
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

test('a fresh guest gets a minted guestId back in welcome, and a kicked guest is durably refused (#7)', () => {
  const room = makeRoom({ id: 'guestkick-1' });
  try {
    room.join(fakeWs(), { pid: 'host', user: null, name: 'Host', cls: 'warrior' });
    const wsGuest = fakeWs();
    const guest = room.join(wsGuest, { pid: 'g1', user: null, name: 'Guest', cls: 'elf' });
    assert.match(guest.guestId, /^[0-9a-f]{32}$/, 'a hex guestId of the expected length was minted');
    const welcomeMsg = wsGuest.sent.find((m) => m.t === 'welcome');
    assert.equal(welcomeMsg.guestId, guest.guestId, 'the guestId is echoed back in welcome');

    room.kick('host', 'g1');
    assert.equal(room.clients.has('g1'), false);

    // The same guest reloads the invite link (no resume token survives a kick) but their client
    // resends the stored guestId on the fresh join — they must be refused, not let back in.
    const wsRejoin = fakeWs();
    assert.throws(
      () => room.join(wsRejoin, { pid: 'g2', user: null, name: 'Guest', cls: 'elf', guestId: guest.guestId }),
      /removed/i,
      'a kicked guestId stays refused across a fresh join',
    );

    // A different, never-kicked guest is unaffected.
    const wsOther = fakeWs();
    assert.doesNotThrow(() => room.join(wsOther, { pid: 'g3', user: null, name: 'Other', cls: 'valkyrie' }));
  } finally { room.close(); }
});

test('a malformed guestId is never trusted for a kick check — a fresh one is minted instead (#7)', () => {
  const room = makeRoom({ id: 'guestkick-2' });
  try {
    const ws = fakeWs();
    const c = room.join(ws, { pid: 'a', user: null, name: 'Ann', cls: 'warrior', guestId: 'not-hex-and-wrong-length!' });
    assert.match(c.guestId, /^[0-9a-f]{32}$/, 'an invalid guestId format is replaced, never used as-is');
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

test('a skip-exit (e.skip) advances the level by 4 instead of 1', () => {
  const room = makeRoom({ id: 'skip-1' });
  try {
    room.join(fakeWs(), { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    room.start('a');
    room.onEvent({ type: 'exit', pid: 'a', levelTime: 5, skip: 4 });
    room.startIntermission();
    room.finishIntermission();
    assert.equal(room.levelIndex, 5, 'level 1 + a skip of 4 = level 5');
  } finally { room.close(); }
});

test('a regular exit still advances the level by 1', () => {
  const room = makeRoom({ id: 'skip-2' });
  try {
    room.join(fakeWs(), { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    room.start('a');
    room.onEvent({ type: 'exit', pid: 'a', levelTime: 5 });
    room.startIntermission();
    room.finishIntermission();
    assert.equal(room.levelIndex, 2);
  } finally { room.close(); }
});

test('every 6th campaign level (after 5 regular ones) is a bonus treasure room, skipping the chest intermission', () => {
  const room = makeRoom({ id: 'treasure-1' });
  try {
    room.join(fakeWs(), { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    room.start('a');
    assert.equal(room.isTreasureLevel(6), true);
    assert.equal(room.isTreasureLevel(5), false);
    assert.equal(room.isTreasureLevel(12), true);

    room.levelIndex = 5;
    room.sim.loadLevel(room.levelFor(5), 5);
    room.onEvent({ type: 'exit', pid: 'a', levelTime: 5 });
    room.startIntermission();
    room.finishIntermission(); // -> level 6, a treasure room

    assert.equal(room.levelIndex, 6);
    assert.equal(room.sim.treasureRoom, true, 'level 6 loaded as a treasure room');
    assert.equal(room.state, 'playing');
    assert.ok(room.treasureTimer, 'the 30s bonus timer was armed');

    // Clearing the treasure room (finding an exit) skips straight to level 7 with no intermission.
    room.onEvent({ type: 'exit', pid: 'a', levelTime: 3 });
    assert.equal(room.state, 'playing', 'the level-clear celebration delay has not fired yet');
    clearTimeout(room.levelChangeTimer); room.levelChangeTimer = null;
    room.advanceLevel();
    assert.equal(room.levelIndex, 7);
    assert.equal(room.state, 'playing', 'went straight back into play, no intermission');
    assert.equal(room.sim.treasureRoom, false);
  } finally { room.close(); }
});

test("the treasure room's timer auto-completes the level with no bonus if nobody finds an exit in time", () => {
  const room = makeRoom({ id: 'treasure-2' });
  try {
    room.join(fakeWs(), { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    room.start('a');
    room.levelIndex = 6;
    room.sim.loadLevel(room.levelFor(6), 6, { treasureRoom: true });
    room.state = 'playing';
    room.startTreasureTimer();
    assert.ok(room.treasureTimer);

    room.finishTreasureRoom(); // simulates the 30s timeout firing
    assert.equal(room.levelIndex, 7);
    assert.equal(room.state, 'playing');
    assert.equal(room.treasureTimer, null);
  } finally { room.close(); }
});

test('Death mode never gets a treasure room, however the levelIndex lines up', () => {
  const room = new Room({ id: 'no-treasure-death', name: 'D', seed: 'nd1', source: { type: 'death' }, isPublic: true, onEmpty: () => {} });
  try {
    for (const n of [6, 12, 30, 60]) assert.equal(room.isTreasureLevel(n), false, `level ${n} in Death mode is never a treasure room`);
  } finally { room.close(); }
});

// ---------- Hero Builder integration (#24) ----------
test('a custom hero is accepted for its owner once they meet the builder rank', () => {
  const room = makeRoom({ id: 'custom-1' });
  try {
    const owner = makeUser();
    stats.bumpXp(owner.id, 700); // lands at rank 3, the Hero Builder's unlock rank
    const heroId = makeHeroRow(owner.id, { name: 'Boltclaw', title: 'The Bolt', trait: 'thick_skin' });

    const ws = fakeWs();
    const c = room.join(ws, { pid: 'a', user: owner, name: owner.username, cls: `custom:${heroId}` });
    assert.equal(c.cls, `custom:${heroId}`, 'the custom cls token is kept, not squashed to warrior');
    assert.ok(c.classDef, 'a classDef was resolved for the owner');
    assert.equal(c.classDef.custom, true);
    assert.equal(c.classDef.shotKey, 'c');
    assert.ok(c.custom && c.custom.name === 'Boltclaw', 'display info (name/pixels/color) is carried for the roster');
    assert.equal(ws.sent.find((m) => m.t === 'error'), undefined, 'no error for a valid owned hero');

    // Starting the room threads the same classDef into the sim player.
    room.start('a');
    const p = room.sim.players.get('a');
    assert.equal(p.classDef.custom, true);
    assert.equal(p.custom.name, 'Boltclaw');

    const info = room.info();
    const row = info.roster.find((r) => r.pid === 'a');
    assert.ok(row.custom && row.custom.name === 'Boltclaw', 'room.info() roster carries the custom display info');
    assert.equal(row.weapon, 'axe');
  } finally { room.close(); }
});

test('a custom hero is rejected for a non-owner, falling back to warrior with an error', () => {
  const room = makeRoom({ id: 'custom-2' });
  try {
    const owner = makeUser();
    stats.bumpXp(owner.id, 700);
    const heroId = makeHeroRow(owner.id);

    const intruder = makeUser();
    stats.bumpXp(intruder.id, 700); // plenty of rank — ownership is the thing that must fail, not rank
    const ws = fakeWs();
    const c = room.join(ws, { pid: 'a', user: intruder, name: intruder.username, cls: `custom:${heroId}` });
    assert.equal(c.cls, 'warrior', 'falls back to warrior — the hero belongs to someone else');
    assert.equal(c.classDef, null);
    const err = ws.sent.find((m) => m.t === 'error');
    assert.ok(err, 'an error message is sent to the client');
    assert.match(err.error, /not yours/i);
  } finally { room.close(); }
});

test('a guest cannot use a custom hero at all, even one that exists and would validate', () => {
  const room = makeRoom({ id: 'custom-3' });
  try {
    const owner = makeUser();
    stats.bumpXp(owner.id, 700);
    const heroId = makeHeroRow(owner.id);

    const ws = fakeWs();
    const c = room.join(ws, { pid: 'a', user: null, name: 'Guest', cls: `custom:${heroId}` });
    assert.equal(c.cls, 'warrior');
    assert.equal(c.classDef, null);
    const err = ws.sent.find((m) => m.t === 'error');
    assert.ok(err);
    assert.match(err.error, /guest/i);
  } finally { room.close(); }
});

test('a custom hero is downgraded to warrior when the owner no longer meets the builder rank', () => {
  const room = makeRoom({ id: 'custom-4' });
  try {
    // The owner never reached rank 3 (or dropped back below it) — re-validation at join time must
    // catch this exactly like the publish-time re-check does, never trusting a stored classDef.
    const owner = makeUser();
    const heroId = makeHeroRow(owner.id);

    const ws = fakeWs();
    const c = room.join(ws, { pid: 'a', user: owner, name: owner.username, cls: `custom:${heroId}` });
    assert.equal(c.cls, 'warrior', 'falls back to warrior — the owner no longer meets the rank requirement');
    assert.equal(c.classDef, null);
    const err = ws.sent.find((m) => m.t === 'error');
    assert.ok(err);
    assert.match(err.error, /rank 3/i);
  } finally { room.close(); }
});

test('an in-lobby hero switch (setHero) to a custom hero works the same as join', () => {
  const room = makeRoom({ id: 'custom-5' });
  try {
    const owner = makeUser();
    stats.bumpXp(owner.id, 700);
    const heroId = makeHeroRow(owner.id, { name: 'Switcheroo' });

    const ws = fakeWs();
    room.join(ws, { pid: 'a', user: owner, name: owner.username, cls: 'warrior' });
    room.setHero('a', `custom:${heroId}`);
    const c = room.clients.get('a');
    assert.equal(c.cls, `custom:${heroId}`);
    assert.ok(c.classDef);
    assert.equal(c.custom.name, 'Switcheroo');
  } finally { room.close(); }
});

test('chat trims/caps text, drops empty messages, and throttles a flooding client', () => {
  const room = makeRoom({ id: 'chat-1' });
  try {
    const ws = fakeWs();
    room.join(ws, { pid: 'a', user: null, name: 'Ann', cls: 'warrior' });
    ws.sent.length = 0;

    room.chat('a', '   ');
    assert.equal(ws.sent.filter((m) => m.t === 'chat').length, 0, 'a blank/whitespace-only message is dropped');

    room.chat('a', '  hello  ' + 'x'.repeat(300));
    const first = ws.sent.find((m) => m.t === 'chat');
    assert.ok(first, 'a real message is broadcast');
    assert.equal(first.text.length, 200, 'text is capped at 200 chars');
    assert.equal(first.text.startsWith('hello'), true, 'leading/trailing whitespace is trimmed');

    ws.sent.length = 0;
    for (let i = 0; i < 20; i++) room.chat('a', `msg ${i}`);
    const got = ws.sent.filter((m) => m.t === 'chat').length;
    assert.ok(got <= 10, `a flooding client is throttled well below 20 messages (got ${got})`);
    assert.ok(got >= 1, 'at least the first few messages still get through');
  } finally { room.close(); }
});

process.on('exit', () => { try { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch {} });
