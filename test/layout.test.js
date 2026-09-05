// Unit tests for the pure canvas-fit math in client/layout.js (#31 "Mobile: responsive game
// screen"). No DOM/browser globals needed — computeCanvasLayout() is a plain numeric helper, and
// these run under plain node:test like every other pure-function client suite (see input.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCanvasLayout } from '../client/layout.js';

const LEVEL = { levelW: 640, levelH: 480 }; // client/game.js's VIEW_W/VIEW_H

test('fits width-bound on a narrow portrait phone (iPhone SE, no HUD/controls reserved)', () => {
  const r = computeCanvasLayout({ vw: 375, vh: 667, levelW: LEVEL.levelW, levelH: LEVEL.levelH, dpr: 1 });
  assert.equal(r.orientation, 'portrait');
  assert.equal(r.width, 375, 'width-bound: canvas should use the full available width');
  assert.ok(r.height <= 667, 'height must not exceed the viewport');
  assert.equal(Math.round(r.height), Math.round(375 * (480 / 640)), 'height follows the 4:3 aspect ratio');
});

test('subtracts hudH and controlsH from the available height before fitting', () => {
  // A short enough viewport that reserving HUD/controls space flips the fit from width-bound to
  // height-bound, shrinking both dimensions (since the aspect ratio is preserved).
  const noChrome = computeCanvasLayout({ vw: 375, vh: 500, levelW: 640, levelH: 480 });
  const withChrome = computeCanvasLayout({ vw: 375, vh: 500, hudH: 90, controlsH: 150, levelW: 640, levelH: 480 });
  assert.ok(withChrome.height < noChrome.height, 'reserving HUD/controls space must shrink the fitted canvas');
  assert.ok(withChrome.width < noChrome.width);
});

test('never returns a canvas box taller than vh - hudH - controlsH', () => {
  const r = computeCanvasLayout({ vw: 900, vh: 500, hudH: 60, controlsH: 40, levelW: 640, levelH: 480 });
  assert.ok(r.height <= 500 - 60 - 40, `expected height <= 400, got ${r.height}`);
});

test('never returns a canvas box wider than vw', () => {
  const r = computeCanvasLayout({ vw: 300, vh: 2000, levelW: 640, levelH: 480 });
  assert.ok(r.width <= 300, `expected width <= 300, got ${r.width}`);
});

test('height-bound case (tall, narrow available box) still keeps the 4:3 aspect', () => {
  const r = computeCanvasLayout({ vw: 1200, vh: 300, levelW: 640, levelH: 480 });
  assert.equal(r.height, 300, 'height-bound: canvas should use the full available height');
  assert.ok(r.width <= 1200);
  assert.equal(Math.round(r.width), Math.round(300 * (640 / 480)));
});

test('prefers an exact integer scale when one fits without shrinking the fractional fit', () => {
  // 640x480 fits exactly twice into 1280x960 -> an integer 2x scale, not a blurry 1.999x.
  const r = computeCanvasLayout({ vw: 1280, vh: 960, levelW: 640, levelH: 480 });
  assert.equal(r.scale, 2);
  assert.equal(r.width, 1280);
  assert.equal(r.height, 960);
});

test('falls back to a fractional scale when the viewport is smaller than the native resolution', () => {
  // Below 1x native (640x480) there is no integer scale to snap to at all — floor(rawScale) would
  // be 0, so this must stay fractional (this is also the common phone case: the available box
  // after HUD/controls is almost always smaller than 640x480).
  const r = computeCanvasLayout({ vw: 500, vh: 400, levelW: 640, levelH: 480 });
  assert.ok(!Number.isInteger(r.scale), `expected a fractional scale, got ${r.scale}`);
  assert.ok(r.scale < 1);
});

test('snaps down to an integer scale (accepting letterboxing) once the viewport reaches native resolution', () => {
  // A viewport that comfortably fits 1x native resolution prefers a crisp whole-number zoom over a
  // fractional one that would fill more of the screen but blur the pixel art.
  const r = computeCanvasLayout({ vw: 900, vh: 700, levelW: 640, levelH: 480 });
  assert.equal(r.scale, 1);
  assert.equal(r.width, 640);
  assert.equal(r.height, 480);
});

test('backingWidth/backingHeight scale with devicePixelRatio for a crisp backing store', () => {
  const r1 = computeCanvasLayout({ vw: 400, vh: 400, levelW: 640, levelH: 480, dpr: 1 });
  const r2 = computeCanvasLayout({ vw: 400, vh: 400, levelW: 640, levelH: 480, dpr: 3 });
  assert.equal(r2.width, r1.width, 'CSS size is dpr-independent');
  assert.equal(r2.backingWidth, r1.backingWidth * 3);
  assert.equal(r2.backingHeight, r1.backingHeight * 3);
});

test('orientation reflects landscape vs portrait from the raw vw/vh', () => {
  assert.equal(computeCanvasLayout({ vw: 915, vh: 412, levelW: 640, levelH: 480 }).orientation, 'landscape');
  assert.equal(computeCanvasLayout({ vw: 412, vh: 915, levelW: 640, levelH: 480 }).orientation, 'portrait');
});

test('degrades gracefully on garbage/missing input instead of throwing or returning non-finite numbers', () => {
  const r = computeCanvasLayout({});
  assert.ok(Number.isFinite(r.width) && r.width >= 1);
  assert.ok(Number.isFinite(r.height) && r.height >= 1);
  assert.ok(Number.isFinite(r.backingWidth) && r.backingWidth >= 1);
  const r2 = computeCanvasLayout({ vw: -50, vh: NaN, hudH: -10, dpr: 0, levelW: 0, levelH: 0 });
  assert.ok(Number.isFinite(r2.width) && r2.width >= 1);
  assert.ok(Number.isFinite(r2.height) && r2.height >= 1);
});

test('a very short landscape band (controlsH=0, small hudH) still fills nearly the full height', () => {
  // Pixel 7 landscape: 915x412, thin HUD strip, d-pad overlays the canvas so controlsH=0.
  const r = computeCanvasLayout({ vw: 915, vh: 412, hudH: 40, controlsH: 0, levelW: 640, levelH: 480 });
  assert.ok(r.height <= 372);
  assert.ok(r.height > 300, `expected the canvas to use most of the remaining height, got ${r.height}`);
});
