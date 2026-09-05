// The heartbeat sweep must terminate a dead client without aborting the loop, so every other
// client still gets pinged/reset. See server/ws-heartbeat.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heartbeat } from '../server/ws-heartbeat.js';

function fakeSocket(isAlive) {
  return { isAlive, terminated: false, pinged: false, terminate() { this.terminated = true; }, ping() { this.pinged = true; } };
}

test('heartbeat terminates a dead client but keeps sweeping the rest', () => {
  const dead = fakeSocket(false);
  const aliveA = fakeSocket(true);
  const aliveB = fakeSocket(true);
  heartbeat([dead, aliveA, aliveB]);

  assert.equal(dead.terminated, true, 'dead client is terminated');
  assert.equal(dead.pinged, false, 'dead client is not pinged');

  assert.equal(aliveA.terminated, false, 'live client after a dead one is not terminated');
  assert.equal(aliveA.pinged, true, 'live client after a dead one is still pinged');
  assert.equal(aliveA.isAlive, false, 'live client isAlive is reset pending its next pong');

  assert.equal(aliveB.terminated, false);
  assert.equal(aliveB.pinged, true, 'a second live client after the dead one is also pinged');
});

test('heartbeat handles an all-dead set without throwing', () => {
  const a = fakeSocket(false);
  const b = fakeSocket(false);
  assert.doesNotThrow(() => heartbeat([a, b]));
  assert.ok(a.terminated && b.terminated);
});

test('heartbeat handles an empty client set', () => {
  assert.doesNotThrow(() => heartbeat([]));
});

test('a client whose ping()/terminate() throws does not abort the sweep for the rest', () => {
  const throwsOnPing = fakeSocket(true);
  throwsOnPing.ping = () => { throw new Error('socket already closing'); };
  const throwsOnTerminate = fakeSocket(false);
  throwsOnTerminate.terminate = () => { throw new Error('socket already closed'); };
  const aliveAfter = fakeSocket(true);

  assert.doesNotThrow(() => heartbeat([throwsOnPing, throwsOnTerminate, aliveAfter]));

  assert.equal(aliveAfter.pinged, true, 'a client after one whose ping() throws is still pinged');
  assert.equal(aliveAfter.isAlive, false, 'a client after one whose ping() throws still gets isAlive reset');
});
