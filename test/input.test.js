// Unit tests for the pure input-mapping helpers in client/input.js: axis->direction deadzone,
// gamepad button/mapping decoding, pad->slot routing, the auto-fire toggle reducer, and the
// touch-layout visibility rule (#15 "Mobile: full touch layout and gamepad support"). These run
// under plain Node — no DOM/browser globals needed, since none of these exports touch them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  axis, axesToDirection, dpadButtonsToDirection, standardFireHeld, fallbackFireHeld,
  mapGamepad, slotForPad, localClassForSlot, autoFireReducer, shouldShowTouch,
} from '../client/input.js';

// ---------------- axis / deadzone ----------------
test('axis() zeroes anything at or under the deadzone and signs anything past it', () => {
  assert.equal(axis(0), 0);
  assert.equal(axis(0.1), 0);
  assert.equal(axis(0.35), 0, 'exactly at the deadzone boundary counts as no input');
  assert.equal(axis(0.36), 1);
  assert.equal(axis(-0.9), -1);
  assert.equal(axis(1, 0.9), 1, 'a custom deadzone is honored');
});

test('axesToDirection reduces a 2-axis stick to a -1/0/1 pair', () => {
  assert.deepEqual(axesToDirection([0, 0]), { dx: 0, dy: 0 });
  assert.deepEqual(axesToDirection([0.9, -0.9]), { dx: 1, dy: -1 });
  assert.deepEqual(axesToDirection([-0.2, 0.2]), { dx: 0, dy: 0 }, 'small drift inside the deadzone stays neutral');
  assert.deepEqual(axesToDirection(undefined), { dx: 0, dy: 0 }, 'a missing axes array is tolerated');
});

// ---------------- d-pad buttons / fire ----------------
test('dpadButtonsToDirection reads the standard-mapping d-pad (buttons 12-15)', () => {
  assert.deepEqual(dpadButtonsToDirection([]), { dx: 0, dy: 0 });
  const up = []; up[12] = true;
  assert.deepEqual(dpadButtonsToDirection(up), { dx: 0, dy: -1 });
  const rightDown = []; rightDown[13] = true; rightDown[15] = true;
  assert.deepEqual(dpadButtonsToDirection(rightDown), { dx: 1, dy: 1 });
});

test('standardFireHeld fires on any of buttons 0-3 or the right trigger (7), nothing else', () => {
  assert.equal(standardFireHeld([]), false);
  const a = []; a[0] = true; assert.equal(standardFireHeld(a), true);
  const trig = []; trig[7] = true; assert.equal(standardFireHeld(trig), true);
  const shoulder = []; shoulder[5] = true; assert.equal(standardFireHeld(shoulder), false);
});

test('fallbackFireHeld only looks at buttons 0-3 (no trigger assumption for non-standard pads)', () => {
  const trig = []; trig[7] = true;
  assert.equal(fallbackFireHeld(trig), false);
  const b = []; b[2] = true;
  assert.equal(fallbackFireHeld(b), true);
});

// ---------------- full gamepad mapping ----------------
test('mapGamepad on a standard pad: stick or d-pad move, face buttons or trigger fire', () => {
  const pad = { mapping: 'standard', axes: [1, 0], buttons: new Array(16).fill(false) };
  assert.deepEqual(mapGamepad(pad), { dx: 1, dy: 0, fire: false });

  const dpadPad = { mapping: 'standard', axes: [0, 0], buttons: new Array(16).fill(false) };
  dpadPad.buttons[14] = true; // d-pad left
  dpadPad.buttons[1] = true;  // face button -> fire
  assert.deepEqual(mapGamepad(dpadPad), { dx: -1, dy: 0, fire: true });
});

test('mapGamepad falls back to plain axes/buttons for a non-standard mapping', () => {
  const pad = { mapping: '', axes: [0, -1], buttons: [false, false, true, false] };
  assert.deepEqual(mapGamepad(pad), { dx: 0, dy: -1, fire: true });
  // A non-standard pad's d-pad-equivalent buttons (12-15) and trigger (7) are never consulted.
  const noisy = { mapping: '', axes: [0, 0], buttons: (() => { const b = new Array(16).fill(false); b[7] = true; b[14] = true; return b; })() };
  assert.deepEqual(mapGamepad(noisy), { dx: 0, dy: 0, fire: false });
});

test('mapGamepad accepts raw numeric button values (analog triggers reported as 0..1) as well as {pressed}', () => {
  const pad = { mapping: 'standard', axes: [0, 0], buttons: new Array(16).fill(0) };
  pad.buttons[7] = 0.8; // held past the implicit >0.5 press threshold
  assert.equal(mapGamepad(pad).fire, true);
});

// ---------------- slot routing ----------------
test('slotForPad clamps to the 0-3 local-player slot range', () => {
  assert.equal(slotForPad(0), 0);
  assert.equal(slotForPad(3), 3);
  assert.equal(slotForPad(9), 3, 'a 5th+ pad harmlessly clamps to the last slot');
  assert.equal(slotForPad(-1), 0);
});

test('localClassForSlot cycles through the always-unlocked base classes', () => {
  assert.equal(localClassForSlot(1), 'valkyrie');
  assert.equal(localClassForSlot(2), 'wizard');
  assert.equal(localClassForSlot(3), 'elf');
  assert.equal(localClassForSlot(4), 'warrior', 'wraps back around past the 4 base classes');
});

// ---------------- auto-fire toggle state machine ----------------
test('autoFireReducer toggles and force-sets the auto-fire flag', () => {
  let state = { on: false };
  state = autoFireReducer(state, { type: 'toggle' });
  assert.equal(state.on, true);
  state = autoFireReducer(state, { type: 'toggle' });
  assert.equal(state.on, false);
  state = autoFireReducer(state, { type: 'set', on: true });
  assert.equal(state.on, true);
  const unchanged = autoFireReducer(state, { type: 'unknown' });
  assert.equal(unchanged, state, 'an unrecognized action is a no-op');
});

// ---------------- touch layout visibility ----------------
test('shouldShowTouch: coarse pointer or the ?touch=1 flag, not otherwise', () => {
  assert.equal(shouldShowTouch('', false), false);
  assert.equal(shouldShowTouch('', true), true);
  assert.equal(shouldShowTouch('?touch=1', false), true);
  assert.equal(shouldShowTouch('?room=abc&touch=1', false), true);
  assert.equal(shouldShowTouch('?touch=0', false), false);
  assert.equal(shouldShowTouch('?other=1', false), false);
});
