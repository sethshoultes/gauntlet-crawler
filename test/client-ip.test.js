import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp } from '../server/client-ip.js';

const req = (headers, remote = '10.0.0.9') => ({ headers, socket: { remoteAddress: remote } });

test('without TRUST_PROXY the socket address is used even if proxy headers are present', () => {
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.2.3.4' }), { trustProxy: false }), '10.0.0.9');
  assert.equal(clientIp(req({ 'cf-connecting-ip': '1.2.3.4' }), { trustProxy: false }), '10.0.0.9');
});

test('with TRUST_PROXY cf-connecting-ip wins, then the first x-forwarded-for hop, then x-real-ip', () => {
  assert.equal(clientIp(req({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8, 9.9.9.9' }), { trustProxy: true }), '1.2.3.4');
  assert.equal(clientIp(req({ 'x-forwarded-for': '5.6.7.8, 9.9.9.9' }), { trustProxy: true }), '5.6.7.8');
  assert.equal(clientIp(req({ 'x-real-ip': '2001:db8::1' }), { trustProxy: true }), '2001:db8::1');
});

test('malformed proxy headers fall back to the socket address', () => {
  assert.equal(clientIp(req({ 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': 'garbage' }), { trustProxy: true }), '10.0.0.9');
  assert.equal(clientIp({ headers: {}, socket: {} }, { trustProxy: true }), 'x');
});
