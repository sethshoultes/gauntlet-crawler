// server/sentry.js: optional Sentry (or compatible) error forwarding behind SENTRY_DSN. Covers the
// three contracts the module promises -- disabled by default (no import, no network), the key
// scrubber strips sensitive fields, and with a DSN set, captureError actually posts an envelope to
// it. All hermetic: the "enabled" case points SENTRY_DSN at a plain http server on 127.0.0.1
// spawned by the test itself, never a real network address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';

const ORIGINAL_DSN = process.env.SENTRY_DSN;
const ORIGINAL_ENV = process.env.SENTRY_ENVIRONMENT;
delete process.env.SENTRY_DSN;
delete process.env.SENTRY_ENVIRONMENT;

const sentry = await import('../server/sentry.js');

test('enabled() is false and captureError is a no-op when SENTRY_DSN is unset', () => {
  delete process.env.SENTRY_DSN;
  assert.equal(sentry.enabled(), false);
  assert.doesNotThrow(() => sentry.captureError('should be ignored', { stack: 'Error: x' }));
});

test('captureError never throws with SENTRY_DSN unset, even given malformed fields', () => {
  delete process.env.SENTRY_DSN;
  assert.doesNotThrow(() => sentry.captureError('null fields', null));
  assert.doesNotThrow(() => sentry.captureError('string fields', 'not-an-object'));
  assert.doesNotThrow(() => sentry.captureError());
});

test('captureError touches no network when SENTRY_DSN is unset', async () => {
  delete process.env.SENTRY_DSN;
  // Sentry's node transport sends envelopes via plain http(s).request -- if captureError ever
  // reached it while disabled, these spies would catch it. Patching both covers either scheme.
  let called = false;
  const realHttpRequest = http.request;
  const realHttpsRequest = https.request;
  http.request = (...args) => { called = true; throw new Error('http.request must not be called while Sentry is disabled'); };
  https.request = (...args) => { called = true; throw new Error('https.request must not be called while Sentry is disabled'); };
  try {
    sentry.captureError('disabled path', { stack: 'Error: disabled', userId: 7 });
    // captureError is fire-and-forget; give any errant async work a tick to (not) run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(called, false, 'no HTTP request should have been attempted');
  } finally {
    http.request = realHttpRequest;
    https.request = realHttpsRequest;
  }
});

test('scrub() strips keys matching token/authorization/cookie/password/ip, at any depth', () => {
  const input = {
    message: 'kept',
    token: 'secret-token-value',
    Authorization: 'Bearer zzz',
    Cookie: 'session=abc',
    password: 'hunter2',
    userIp: '203.0.113.9',
    nested: {
      apiToken: 'nested-secret',
      safe: 'kept-nested',
      deeper: { authorization_header: 'also gone', fine: 1 },
    },
    list: [{ password: 'gone-in-list' }, { ok: true }],
  };
  const out = sentry.scrub(input);
  assert.equal(out.message, 'kept');
  assert.equal('token' in out, false);
  assert.equal('Authorization' in out, false);
  assert.equal('Cookie' in out, false);
  assert.equal('password' in out, false);
  assert.equal('userIp' in out, false);
  assert.equal(out.nested.safe, 'kept-nested');
  assert.equal('apiToken' in out.nested, false);
  assert.equal('authorization_header' in out.nested.deeper, false);

  assert.equal(out.nested.deeper.fine, 1);
  assert.equal('password' in out.list[0], false);
  assert.equal(out.list[1].ok, true);
  // The input object itself must be untouched (scrub copies, never mutates).
  assert.equal(input.token, 'secret-token-value');
});

test('scrub() tolerates a self-referential array without recursing forever', () => {
  const arr = [1, { token: 'secret', ok: true }];
  arr.push(arr);
  let out;
  assert.doesNotThrow(() => { out = sentry.scrub({ list: arr }); });
  assert.equal(out.list[0], 1);
  assert.equal(out.list[1].token, undefined);
  assert.equal(out.list[1].ok, true);
  assert.equal(out.list[2], '[Circular]');
});

test('scrub() tolerates circular references without throwing', () => {
  const obj = { name: 'x', authorization: 'nope' };
  obj.self = obj;
  let out;
  assert.doesNotThrow(() => { out = sentry.scrub(obj); });
  assert.equal(out.name, 'x');
  assert.equal('authorization' in out, false);
  assert.equal(out.self, '[Circular]');
});

test('captureError, with a DSN pointing at a local server, posts an envelope with the message and without a planted secret', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  try {
    process.env.SENTRY_DSN = `http://testpublickey@127.0.0.1:${port}/1`;
    process.env.SENTRY_ENVIRONMENT = 'test';
    assert.equal(sentry.enabled(), true);

    const plantedToken = 'PLANTED-SECRET-TOKEN-Zx91q';
    const plantedNestedToken = 'PLANTED-NESTED-SECRET-Qw77z';
    sentry.captureError('sentry integration boom', {
      stack: 'Error: sentry integration boom\n    at somewhere.js:1:1',
      source: 'server',
      url: '/api/thing',
      token: plantedToken,
      authorization: `Bearer ${plantedToken}`,
      safeField: 'this-is-fine',
      // extra is not always flat -- confirm the scrub the beforeSend hook applies (scrubEvent in
      // server/sentry.js) reaches a sensitive key nested inside the extras object too, not just
      // the fields captureError itself flattens at the top level.
      nested: { password: plantedNestedToken, safeNested: 'nested-and-fine' },
    });
    // captureError's own contract ("never throws") must hold for a real, wired-up Sentry client
    // too, not just the disabled no-op path covered above -- these must not throw or otherwise
    // disrupt the assertions below.
    assert.doesNotThrow(() => sentry.captureError('null fields', null));
    assert.doesNotThrow(() => sentry.captureError('string fields', 'not-an-object'));
    assert.doesNotThrow(() => sentry.captureError());
    await sentry.flush(3000);

    assert.ok(received.length >= 1, 'the local server should have received at least one request');
    const bodies = received.join('\n');
    assert.match(bodies, /sentry integration boom/, 'the envelope should contain the error message');
    assert.doesNotMatch(bodies, new RegExp(plantedToken), 'the planted token must never reach the wire');
    assert.doesNotMatch(bodies, new RegExp(plantedNestedToken), 'a sensitive key nested inside extra must never reach the wire either');
    assert.match(bodies, /nested-and-fine/, 'a non-sensitive nested value should still be forwarded');
    assert.doesNotMatch(bodies, /Bearer /, 'the authorization value must never reach the wire');
    assert.match(bodies, /this-is-fine/, 'non-sensitive fields should still be forwarded');
  } finally {
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENVIRONMENT;
    await new Promise((resolve) => server.close(resolve));
  }
});

process.on('exit', () => {
  if (ORIGINAL_DSN === undefined) delete process.env.SENTRY_DSN; else process.env.SENTRY_DSN = ORIGINAL_DSN;
  if (ORIGINAL_ENV === undefined) delete process.env.SENTRY_ENVIRONMENT; else process.env.SENTRY_ENVIRONMENT = ORIGINAL_ENV;
});


test('isSensitiveKey() catches IP-bearing header names but leaves words that merely contain "ip"', () => {
  for (const k of ['ip', 'userIp', 'ipAddress', 'clientIP', 'X-Real-IP', 'CF-Connecting-IP', 'X-Forwarded-For', 'REMOTE_ADDR', 'remoteAddress', 'ips', 'apiSecret', 'passwd']) {
    assert.equal(sentry.isSensitiveKey(k), true, `${k} should be scrubbed`);
  }
  for (const k of ['shipping', 'description', 'zip', 'recipe', 'tip', 'skipCount', 'message', 'stack', 'url']) {
    assert.equal(sentry.isSensitiveKey(k), false, `${k} should be kept`);
  }
  const out = sentry.scrub({ request: { headers: { 'X-Forwarded-For': '203.0.113.9', 'CF-Connecting-IP': '203.0.113.9', 'User-Agent': 'ua' } }, shipping: 'kept' });
  assert.deepEqual(out.request.headers, { 'User-Agent': 'ua' });
  assert.equal(out.shipping, 'kept');
});
