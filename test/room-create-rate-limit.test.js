// Regression test for room-creation rate limiting (server/index.js roomCreateKey()): the REST
// endpoints (POST /api/rooms, POST /api/levels/:id/play) key their per-minute room-creation
// bucket by 'u' + user.id when logged in (falling back to IP for guests), while the WS
// 'join'-with-create protocol message used to key its bucket by IP alone regardless of auth. That
// let a logged-in user dodge their account-wide limit by switching from REST to WS (or vice
// versa), and meant every account behind one shared IP/NAT competed for a single WS bucket. Both
// paths now share one roomCreateKey(user, ip) helper. Boots the real server as a child process,
// same pattern as test/telemetry.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { default as WebSocket } from 'ws';
import { startServer } from './helpers/server.mjs';

async function withServer(fn) {
  const server = await startServer();
  try {
    await fn(server.baseUrl, server.port);
  } finally {
    await server.stop();
  }
}

function wsJoinCreate(port, token, roomName) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', create: true, roomName, token, name: 'Guest', cls: 'warrior' })));
    ws.once('message', (data) => {
      const msg = JSON.parse(data.toString());
      ws.close();
      resolve(msg);
    });
    ws.on('error', reject);
  });
}

test('WS room creation shares the same per-account rate-limit bucket as the REST endpoint', async () => {
  await withServer(async (baseUrl, port) => {
    const reg = await fetch(`${baseUrl}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'roomrate_user', password: 'hunter22' }),
    }).then((r) => r.json());
    const token = reg.token;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    // Exhaust this user's 10-per-minute room-creation limit entirely over REST.
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${baseUrl}/api/rooms`, { method: 'POST', headers, body: JSON.stringify({ name: `r${i}` }) });
      assert.equal(res.status, 200, `REST room creation #${i} should succeed`);
    }
    // The 11th over REST is correctly rejected.
    const restOver = await fetch(`${baseUrl}/api/rooms`, { method: 'POST', headers, body: JSON.stringify({ name: 'over-rest' }) });
    assert.equal(restOver.status, 429, 'the 11th REST room creation this minute should be rate limited');

    // Switching transport must not reset or bypass the same account's bucket: WS room creation,
    // authenticated as the same user, should also be rejected rather than keying off IP alone.
    const wsMsg = await wsJoinCreate(port, token, 'over-ws');
    assert.equal(wsMsg.t, 'error', 'WS room creation should be rate limited too, since it shares the REST bucket for this user');
    assert.match(wsMsg.error, /Slow down/i);
  });
});
