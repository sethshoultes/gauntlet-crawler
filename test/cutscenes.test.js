// Node-only tests for client/cutscenes.js. No DOM: renderFrame is exercised against a plain
// object stub 2D context, and hasSeen/markSeen against a stubbed sessionStorage. This file
// intentionally never imports client/sprites.js or touches a real canvas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENES, SCENE_IDS, getScene, listScenes, renderFrame, hasSeen, markSeen, clearSeen,
} from '../client/cutscenes.js';

// A recording stub CanvasRenderingContext2D: every draw call is logged so tests can assert
// *something* was drawn without asserting exact pixels (which would be brittle art review).
function makeStubCtx() {
  const calls = [];
  const ctx = {
    calls,
    fillStyle: '#000',
    globalAlpha: 1,
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    scale(x, y) { calls.push(['scale', x, y]); },
    translate(x, y) { calls.push(['translate', x, y]); },
    fillRect(x, y, w, h) { calls.push(['fillRect', x, y, w, h]); },
    drawImage(img, ...rest) { calls.push(['drawImage', img && img.__name, ...rest]); },
  };
  return ctx;
}

function stubSpriteProvider(name, tint, scale) {
  return { width: 8 * (scale || 2), height: 8 * (scale || 2), __name: name, __tint: tint };
}

test('every scene has a unique id and a positive duration', () => {
  const ids = new Set();
  for (const id of SCENE_IDS) {
    const s = getScene(id);
    assert.ok(s, `scene ${id} should be resolvable via getScene`);
    assert.equal(s.id, id, 'scene.id must match its registry key');
    assert.ok(!ids.has(id), `duplicate scene id: ${id}`);
    ids.add(id);
    assert.equal(typeof s.duration, 'number');
    assert.ok(s.duration > 0, `scene ${id} must have a positive duration`);
  }
  assert.ok(SCENE_IDS.length >= 10, 'expected the full roster of scenes to be registered');
});

test('listScenes mirrors the registry', () => {
  const listed = listScenes();
  assert.equal(listed.length, SCENE_IDS.length);
  for (const row of listed) {
    assert.ok(SCENES[row.id]);
    assert.equal(row.duration, SCENES[row.id].duration);
  }
});

test('captions are sorted by time and fall within the scene duration', () => {
  for (const id of SCENE_IDS) {
    const scene = getScene(id);
    const caps = scene.captions || [];
    let lastAt = -Infinity;
    for (const cap of caps) {
      assert.equal(typeof cap.at, 'number', `${id}: caption.at must be numeric`);
      assert.ok(cap.at >= 0, `${id}: caption.at must be non-negative`);
      assert.ok(cap.at < scene.duration, `${id}: caption.at (${cap.at}) must be before duration (${scene.duration})`);
      assert.ok(cap.at >= lastAt, `${id}: captions must be sorted by time (${cap.at} came after ${lastAt})`);
      assert.equal(typeof cap.text, 'string');
      assert.ok(cap.text.length > 0);
      lastAt = cap.at;
    }
  }
});

test('renderFrame draws every scene at start, middle and end without throwing', () => {
  for (const id of SCENE_IDS) {
    const scene = getScene(id);
    for (const frac of [0, 0.5, 1]) {
      const ctx = makeStubCtx();
      const t = scene.duration * frac;
      assert.doesNotThrow(() => {
        renderFrame(ctx, scene, t, { spriteProvider: stubSpriteProvider, canvasW: 640, canvasH: 480 });
      }, `${id} @ t=${t} should not throw`);
      assert.ok(ctx.calls.length > 0, `${id} @ t=${t} should have issued at least one draw call`);
      // every frame is scaled into the target canvas exactly once (canonical 640x480 space)
      assert.ok(ctx.calls.some((c) => c[0] === 'scale'), `${id} @ t=${t} should scale into the canvas`);
    }
  }
});

test('renderFrame tolerates a missing spriteProvider (falls back to flat fills, never throws)', () => {
  const scene = getScene('intro');
  const ctx = makeStubCtx();
  assert.doesNotThrow(() => renderFrame(ctx, scene, scene.duration / 2, {}));
  assert.ok(ctx.calls.length > 0);
});

test('renderFrame respects reducedMotion without throwing (bob/shake disabled)', () => {
  const scene = getScene('death_mode'); // has both bob (Death rising) and camera shake
  const ctx = makeStubCtx();
  assert.doesNotThrow(() => {
    renderFrame(ctx, scene, scene.duration - 0.1, { spriteProvider: stubSpriteProvider, reducedMotion: true });
  });
});

test('hasSeen/markSeen round-trip through a stubbed sessionStorage', () => {
  const store = new Map();
  const stub = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const prev = globalThis.sessionStorage;
  globalThis.sessionStorage = stub;
  try {
    assert.equal(hasSeen('intro'), false);
    markSeen('intro');
    assert.equal(hasSeen('intro'), true);
    assert.equal(hasSeen('victory'), false, 'marking one scene must not mark another');
    clearSeen('intro');
    assert.equal(hasSeen('intro'), false);
  } finally {
    if (prev === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = prev;
  }
});

test('hasSeen/markSeen degrade gracefully with no sessionStorage at all', () => {
  const prev = globalThis.sessionStorage;
  delete globalThis.sessionStorage;
  try {
    assert.equal(hasSeen('intro'), false);
    assert.doesNotThrow(() => markSeen('intro'));
  } finally {
    if (prev !== undefined) globalThis.sessionStorage = prev;
  }
});

test('hero scenes exist for every playable archetype', () => {
  for (const cls of ['warrior', 'valkyrie', 'wizard', 'elf', 'paladin', 'ranger', 'necromancer']) {
    assert.ok(getScene(`hero_${cls}`), `missing hero_${cls} scene`);
  }
});

test('level milestone scenes exist for 10/25/50', () => {
  for (const lvl of [10, 25, 50]) assert.ok(getScene(`level_milestone_${lvl}`));
});
