// Regression coverage for the WS side of local co-op (#15, server/index.js's `join_local`/`input`
// cases): server/game/room.js's joinLocal()/leave() already have thorough Room-level tests (see
// test/room.test.js "local co-op"), but the slot validation, the welcome_local ack, and the
// cross-connection isolation only exist in server/index.js's WS handler itself, so they need
// coverage at this layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from './helpers/server.mjs';

function wsConnect(baseUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/ws');
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** An in-order queue of every message this socket receives, from the moment this is called (never
 *  from connection start, so attach it right after wsConnect()). A single join/join_local/leave
 *  can fan out several message types (its own ack plus room/players/notice broadcasts) — waiting
 *  for just "the next message" races whichever of those happens to arrive first, so `waitFor`
 *  below scans forward past anything that doesn't match instead of consuming/misreading it as the
 *  reply to a specific send. */
function messageQueue(ws) {
  const buffered = [];
  const waiters = [];
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    const w = waiters.shift();
    if (w) w(msg); else buffered.push(msg);
  });
  function next() {
    return new Promise((resolve) => { if (buffered.length) resolve(buffered.shift()); else waiters.push(resolve); });
  }
  return {
    /** Scan forward, in order, for the first message matching `pred` (an 'error' message always
     *  matches too, unless `pred` itself already only matches 'error'), discarding everything
     *  before it. Throws if none arrives within `timeoutMs`. */
    async waitFor(pred, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('timed out waiting for a matching message');
        const msg = await Promise.race([
          next(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for a matching message')), remaining)),
        ]);
        if (pred(msg) || msg.t === 'error') return msg;
      }
    },
    /** Drain whatever arrives over `ms`, ignoring order — for asserting an absence (e.g. "no
     *  second ack", "no error"). */
    collectFor(ms) {
      return new Promise((resolve) => setTimeout(() => resolve(buffered.splice(0)), ms));
    },
  };
}

async function withServer(fn) {
  const server = await startServer();
  try { await fn(server.baseUrl); } finally { await server.stop(); }
}

test('join_local rejects an out-of-range or non-integer slot with an error, never adding a player', async () => {
  await withServer(async (baseUrl) => {
    const ws = await wsConnect(baseUrl);
    const q = messageQueue(ws);
    ws.send(JSON.stringify({ t: 'join', create: true, name: 'Host' }));
    await q.waitFor((m) => m.t === 'welcome');

    for (const badSlot of [0, 4, -1, 1.5, 'x', null]) {
      ws.send(JSON.stringify({ t: 'join_local', slot: badSlot, name: 'P2', cls: 'elf' }));
      const reply = await q.waitFor((m) => m.t === 'welcome_local');
      assert.equal(reply.t, 'error', `slot=${JSON.stringify(badSlot)} must be rejected`);
      assert.match(reply.error, /slot/i);
    }
    ws.close();
  });
});

test('join_local with a valid slot acks welcome_local; a repeat on the same slot is a silent no-op', async () => {
  await withServer(async (baseUrl) => {
    const ws = await wsConnect(baseUrl);
    const q = messageQueue(ws);
    ws.send(JSON.stringify({ t: 'join', create: true, name: 'Host' }));
    const welcome = await q.waitFor((m) => m.t === 'welcome');

    ws.send(JSON.stringify({ t: 'join_local', slot: 1, name: 'P2', cls: 'elf' }));
    const ack = await q.waitFor((m) => m.t === 'welcome_local');
    assert.equal(ack.t, 'welcome_local');
    assert.equal(ack.slot, 1);
    assert.equal(ack.pid, `${welcome.pid}L1`, 'the minted local pid is derived from the connection\'s own pid');

    // A second join_local for the SAME slot from the same connection is a documented no-op (see
    // server/index.js: `if (localPids.has(slot)) break;`) -- it must not mint a second player or
    // send a second ack.
    ws.send(JSON.stringify({ t: 'join_local', slot: 1, name: 'P2-again', cls: 'wizard' }));
    const extra = await q.collectFor(300);
    assert.equal(extra.some((m) => m.t === 'welcome_local'), false, 'no second ack for an already-joined slot');
    ws.close();
  });
});

test('an `input` with a slot this connection never joined falls back to controlling this connection\'s own player, never another connection\'s', async () => {
  await withServer(async (baseUrl) => {
    const wsA = await wsConnect(baseUrl);
    const qA = messageQueue(wsA);
    wsA.send(JSON.stringify({ t: 'join', create: true, name: 'A' }));
    const welcomeA = await qA.waitFor((m) => m.t === 'welcome');
    const roomId = welcomeA.room.id;

    const wsB = await wsConnect(baseUrl);
    const qB = messageQueue(wsB);
    wsB.send(JSON.stringify({ t: 'join', roomId, name: 'B' }));
    await qB.waitFor((m) => m.t === 'welcome');
    // B also mints a local player at slot 1 on B's own connection, so B's connection has a
    // localPids entry keyed by slot 1 too -- A's slot-1 input must never resolve to B's pids.
    wsB.send(JSON.stringify({ t: 'join_local', slot: 1, name: 'B-local', cls: 'elf' }));
    const ackB = await qB.waitFor((m) => m.t === 'welcome_local');
    assert.equal(ackB.slot, 1);

    // A never joined a local player at all, so A's connection's `localPids` map is empty --
    // `(slot ? localPids.get(slot) : null) || pid` must fall back to A's own pid, not throw, and
    // must never reach into B's connection state.
    assert.doesNotThrow(() => wsA.send(JSON.stringify({ t: 'input', slot: 1, dx: 1, dy: 0, fire: false })));
    // Neither connection should see an 'error' as a result.
    const afterA = await qA.collectFor(200);
    assert.equal(afterA.some((m) => m.t === 'error'), false);
    const afterB = await qB.collectFor(200);
    assert.equal(afterB.some((m) => m.t === 'error'), false);

    wsA.close(); wsB.close();
  });
});

test('join_local is capped at MAX_PLAYERS and the extra local player is rejected with an error over the wire', async () => {
  await withServer(async (baseUrl) => {
    const ws = await wsConnect(baseUrl);
    const q = messageQueue(ws);
    ws.send(JSON.stringify({ t: 'join', create: true, name: 'Host' }));
    await q.waitFor((m) => m.t === 'welcome');

    for (const slot of [1, 2, 3]) {
      ws.send(JSON.stringify({ t: 'join_local', slot, name: `P${slot + 1}`, cls: 'elf' }));
      const ack = await q.waitFor((m) => m.t === 'welcome_local');
      assert.equal(ack.t, 'welcome_local', `slot ${slot} (room now at MAX_PLAYERS) should still be accepted`);
    }
    // A 5th player has no free slot to even request (slot must be 1..MAX_PLAYERS-1=3) -- Room#full
    // is the real backstop once every slot is legitimately taken, covered directly in
    // test/room.test.js's "capped by MAX_PLAYERS" case; this just confirms an out-of-range slot
    // request against an already-full room still comes back as a clean error, not a crash.
    ws.send(JSON.stringify({ t: 'join_local', slot: 4, name: 'P5', cls: 'elf' }));
    const rejected = await q.waitFor((m) => m.t === 'welcome_local');
    assert.equal(rejected.t, 'error');
    ws.close();
  });
});

test('sending "leave" cleans up every local player this connection minted, immediately', async () => {
  await withServer(async (baseUrl) => {
    const wsHost = await wsConnect(baseUrl);
    const qHost = messageQueue(wsHost);
    wsHost.send(JSON.stringify({ t: 'join', create: true, name: 'Host' }));
    const welcomeHost = await qHost.waitFor((m) => m.t === 'welcome');
    const roomId = welcomeHost.room.id;

    wsHost.send(JSON.stringify({ t: 'join_local', slot: 1, name: 'P2', cls: 'elf' }));
    const ack = await qHost.waitFor((m) => m.t === 'welcome_local');
    assert.equal(ack.slot, 1);

    // An independent observer socket in the same room sees both the host and the local player on
    // the roster (via the 'room' broadcast every join triggers).
    const wsObserver = await wsConnect(baseUrl);
    const qObserver = messageQueue(wsObserver);
    wsObserver.send(JSON.stringify({ t: 'join', roomId, name: 'Observer' }));
    const welcomeObs = await qObserver.waitFor((m) => m.t === 'welcome');
    assert.equal(welcomeObs.room.roster.length, 3, 'host + local player + observer');
    assert.equal(welcomeObs.room.roster.some((r) => r.pid === ack.pid), true, 'the local player is on the roster before leaving');

    wsHost.send(JSON.stringify({ t: 'leave' }));
    await qHost.waitFor((m) => m.t === 'left');
    // leaveLocals() drops the local player and the primary player with two separate room.leave()
    // calls, each broadcasting its own 'room' snapshot -- skip past the observer's own
    // just-joined broadcast, and past the intermediate one (local player gone, host not yet), to
    // the final settled state with neither of them left.
    const roomMsg = await qObserver.waitFor((m) => m.t === 'room' && !m.room.roster.some((r) => r.name === 'Host'));
    assert.equal(roomMsg.room.roster.some((r) => r.pid === ack.pid), false, 'the local player is gone, not just the host');
    assert.equal(roomMsg.room.roster.length, 1, 'only the observer remains');

    wsHost.close(); wsObserver.close();
  });
});
