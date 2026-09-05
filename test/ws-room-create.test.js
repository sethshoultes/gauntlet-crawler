// Regression test for the WS `join`/`create:true` path in server/index.js: the room-creation
// rate limit must key on the logged-in user's id (same as the REST POST /api/rooms and POST
// /api/levels/:id/play paths, and test/room-create-rate-limit.test.js's same-user
// cross-transport check), not fall back to sharing one bucket keyed purely by IP — which would
// let a different logged-in user behind the same IP/NAT get caught by another account's
// exhausted limit. (The companion finding — WS join telemetry recording the final guestId
// Room#join actually settles on, rather than the raw requested one — has its own regression test
// in test/telemetry.test.js.)
// Boots the real server against a fresh temp DB, same pattern as test/settings.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from './helpers/server.mjs';

async function withServer(fn) {
  const server = await startServer();
  try {
    await fn(server.baseUrl, server.dataDir);
  } finally {
    await server.stop();
  }
}

async function postJson(baseUrl, path, body) {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function wsConnect(baseUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/ws');
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
// Joining/creating a room fans out several message types on the same socket (this client's own
// 'welcome', a 'room' broadcast, a 'players' packet, a 'notice', ...) — wait for the specific
// type the test cares about rather than assuming it's the very next frame.
function nextMessageOfType(ws, type) {
  return new Promise((resolve) => {
    const onMessage = (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.t === type || msg.t === 'error') { ws.off('message', onMessage); resolve(msg); }
    };
    ws.on('message', onMessage);
  });
}

test('WS create-room rate limit is keyed per logged-in user, not shared across users on one IP', async () => {
  await withServer(async (baseUrl) => {
    const a = await postJson(baseUrl, '/api/register', { username: 'rl_user_a', password: 'hunter22' }).then((r) => r.json());
    const b = await postJson(baseUrl, '/api/register', { username: 'rl_user_b', password: 'hunter22' }).then((r) => r.json());

    const wsA = await wsConnect(baseUrl);
    for (let i = 0; i < 10; i++) {
      wsA.send(JSON.stringify({ t: 'join', create: true, token: a.token, name: 'A' }));
      const msg = await nextMessageOfType(wsA, 'welcome');
      assert.equal(msg.t, 'welcome', `room ${i} for user A should be created, got ${JSON.stringify(msg)}`);
    }
    // The 11th room in the same window trips user A's own limit.
    wsA.send(JSON.stringify({ t: 'join', create: true, token: a.token, name: 'A' }));
    const limited = await nextMessageOfType(wsA, 'welcome');
    assert.equal(limited.t, 'error');
    assert.match(limited.error, /too many rooms/);

    // A *different* logged-in user, from the same test-runner IP (127.0.0.1), must have their
    // own untouched quota — this is the bug: the WS path used to rate-limit by bare IP, so user
    // A's exhausted bucket would also block user B here.
    const wsB = await wsConnect(baseUrl);
    wsB.send(JSON.stringify({ t: 'join', create: true, token: b.token, name: 'B' }));
    const okB = await nextMessageOfType(wsB, 'welcome');
    assert.equal(okB.t, 'welcome', 'a different logged-in user on the same IP must not share user A\'s room-creation limit');

    wsA.close(); wsB.close();
  });
});
