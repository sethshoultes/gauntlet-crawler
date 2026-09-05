// In-engine pixel-art cutscene system. Everything at module scope (scene data, renderFrame,
// the little math helpers) is plain data + pure functions — no `document`/`window`/canvas
// element creation happens until a caller actually invokes playCutscene() with a real <canvas>,
// so this file imports cleanly under plain Node for tests. Actor art is never baked in here:
// every renderer takes a `spriteProvider(name, tint, scale) -> {width,height} drawable` so
// tests can hand in a stub instead of client/sprites.js's real canvas-backed sprite().
//
// Canonical scene space is always 640x480 (the game's native canvas size); renderFrame scales
// into whatever canvas it is actually given, so the same scene data drives both the in-game
// canvas and a full-screen attract-mode canvas.
import { drawText, wrapText } from './font.js';

const CW = 640, CH = 480;
const SEEN_PREFIX = 'gc:cutscene-seen:';

// ---- small pure math helpers -------------------------------------------------
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function lerp(a, b, k) { return a + (b - a) * k; }
function segT(t, start, end) { return end <= start ? (t >= end ? 1 : 0) : clamp01((t - start) / (end - start)); }
function layerAlpha(t, start, end, fadeIn = 0.3, fadeOut = 0.3) {
  if (t < start || t > end) return 0;
  let a = 1;
  if (fadeIn > 0 && t < start + fadeIn) a = (t - start) / fadeIn;
  if (fadeOut > 0 && t > end - fadeOut) a = Math.min(a, (end - t) / fadeOut);
  return clamp01(a);
}

// ---- hero flavour data (deliberately duplicated from shared/constants.js rather than
// imported: keeps this module dependency-free of files other agents are editing, and safe to
// import from plain Node without a web-root-relative `/shared/...` resolution problem). ----
export const HERO = {
  warrior:     { name: 'Thor',    color: '#e03c31', weapon: 'axe',      motto: 'Strong arm, thick skin.' },
  valkyrie:    { name: 'Thyra',   color: '#3b7dff', weapon: 'sword',    motto: 'Swift wings, sharp steel.' },
  wizard:      { name: 'Merlin',  color: '#f2c400', weapon: 'fireball', motto: 'Old magic, quick wit.' },
  elf:         { name: 'Questor', color: '#2ecc40', weapon: 'arrow',    motto: 'Fast feet, keen eyes.' },
  paladin:     { name: 'Aldric',  color: '#e8a33d', weapon: 'hammer',   motto: 'Faith is my armor.' },
  ranger:      { name: 'Sable',   color: '#0fb8a5', weapon: 'dagger',   motto: 'One shot, one kill.' },
  necromancer: { name: 'Mordant', color: '#8b3fd1', weapon: 'skull',    motto: 'Death serves the living.' },
};
export const HERO_ORDER = ['warrior', 'valkyrie', 'wizard', 'elf', 'paladin', 'ranger', 'necromancer'];

// ---- background rendering ------------------------------------------------------
function drawDungeonHall(ctx, sprites, opts = {}) {
  const S = 4, TS = 8 * S; // 32px tiles -> 20x15 tiles across the 640x480 canonical canvas
  const cols = Math.ceil(CW / TS), rows = Math.ceil(CH / TS);
  const floor = sprites('floor', null, S);
  const wall = sprites('wall', null, S);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      ctx.drawImage((ty === 0 || ty === rows - 1) ? wall : floor, tx * TS, ty * TS);
    }
  }
  if (opts.door) {
    const door = sprites('door', null, S);
    const dx = opts.door.x ?? (CW - TS);
    const midRow = Math.floor(rows / 2);
    ctx.drawImage(door, dx, (midRow - 1) * TS);
    ctx.drawImage(door, dx, midRow * TS);
  }
}

function drawBackground(ctx, bg, sprites, t) {
  const type = bg?.type || 'void';
  if (type === 'hall' || type === 'arena') {
    if (sprites) drawDungeonHall(ctx, sprites, bg);
    else { ctx.fillStyle = '#14141f'; ctx.fillRect(0, 0, CW, CH); }
  } else {
    ctx.fillStyle = bg?.color || '#0b0b12';
    ctx.fillRect(0, 0, CW, CH);
  }
  if (bg?.tint) {
    ctx.save();
    ctx.globalAlpha = bg.tintAlpha ?? 0.25;
    ctx.fillStyle = bg.tint;
    ctx.fillRect(0, 0, CW, CH);
    ctx.restore();
  }
}

// ---- layer renderers -------------------------------------------------------------
function drawActorLayer(ctx, layer, t, sprites, sceneDuration, reducedMotion) {
  if (!sprites) return;
  const start = layer.start ?? 0, end = layer.end ?? sceneDuration;
  const k = segT(t, start, end);
  let x = lerp(layer.from.x, layer.to.x, k);
  let y = lerp(layer.from.y, layer.to.y, k);
  if (layer.bob && !reducedMotion) y += Math.sin(t * 6 + (layer.bobPhase || 0)) * layer.bob;
  const scale = layer.scale ?? 3;
  const img = sprites(layer.sprite, layer.tint ?? null, scale);
  const w = img?.width ?? 8 * scale, h = img?.height ?? 8 * scale;
  ctx.save();
  if (layer.alpha != null) ctx.globalAlpha = layer.alpha;
  if (layer.flip) {
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0);
  } else {
    ctx.drawImage(img, x, y);
  }
  ctx.restore();
  void h;
}

function drawConfetti(ctx, t, layer) {
  const { start = 0, count = 40, colors = ['#e03c31', '#3b7dff', '#f2c400', '#2ecc40', '#a05cff', '#ff8c1a'] } = layer;
  const lt = Math.max(0, t - start);
  for (let i = 0; i < count; i++) {
    const seed = i * 37.13;
    const x = (Math.sin(seed) * 0.5 + 0.5) * CW;
    const speed = 40 + (i % 5) * 14;
    const raw = (Math.sin(seed * 1.7) * 0.5 + 0.5) * CH * 0.3 + lt * speed;
    const y = (raw % (CH + 20)) - 10;
    const size = 3 + (i % 3);
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(x, y, size, size);
  }
}

function drawTorchFlame(ctx, x, y, t, seed = 0) {
  const flick = 0.6 + 0.4 * Math.sin(t * 13 + seed * 2.1);
  const h = 9 + flick * 6;
  ctx.fillStyle = '#3a3a4c';
  ctx.fillRect(x - 3, y, 6, 16);
  ctx.fillStyle = '#e03c31';
  ctx.fillRect(x - 5, y - h, 10, h);
  ctx.fillStyle = '#ff8c1a';
  ctx.fillRect(x - 3, y - h * 0.7, 6, h * 0.7);
  ctx.fillStyle = '#f2c400';
  ctx.fillRect(x - 1, y - h * 0.35, 2, h * 0.35);
}

function drawPulse(ctx, t, layer) {
  const period = layer.period ?? 1.2, amp = layer.amp ?? 0.18, base = layer.base ?? 0.05;
  const a = base + amp * (0.5 + 0.5 * Math.sin(t * (2 * Math.PI / period)));
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = layer.color ?? '#e03c31';
  ctx.fillRect(0, 0, CW, CH);
  ctx.restore();
}

function drawLayer(ctx, layer, t, sprites, sceneDuration, reducedMotion) {
  const start = layer.start ?? 0, end = layer.end ?? sceneDuration;
  switch (layer.type) {
    case 'actor':
      if (t < (layer.showFrom ?? -Infinity) || t > (layer.showUntil ?? Infinity)) return;
      drawActorLayer(ctx, layer, t, sprites, sceneDuration, reducedMotion);
      return;
    case 'sprite-static': {
      if (!sprites) return;
      const img = sprites(layer.sprite, layer.tint ?? null, layer.scale ?? 4);
      ctx.drawImage(img, layer.x, layer.y);
      return;
    }
    case 'text': {
      const a = layerAlpha(t, start, end, layer.fadeIn ?? 0.4, layer.fadeOut ?? 0.4);
      if (a <= 0) return;
      drawText(ctx, layer.text, layer.x, layer.y, {
        scale: layer.scale ?? 3, color: layer.color ?? '#ffffff', align: layer.align ?? 'center',
        shadow: layer.shadow ?? true, alpha: a,
      });
      return;
    }
    case 'rect': {
      const a = layerAlpha(t, start, end, layer.fadeIn ?? 0, layer.fadeOut ?? 0);
      if (a <= 0) return;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = layer.color ?? '#ffffff';
      ctx.fillRect(layer.x, layer.y, layer.w, layer.h);
      ctx.restore();
      return;
    }
    case 'particles':
      if (t < start || t > end) return;
      if (layer.kind === 'confetti') drawConfetti(ctx, t, layer);
      return;
    case 'torch':
      drawTorchFlame(ctx, layer.x, layer.y, t, layer.seed ?? 0);
      return;
    case 'pulse':
      if (t < start || t > end) return;
      drawPulse(ctx, t, layer);
      return;
    default:
      return;
  }
}

function drawCaptionBar(ctx, scene, t) {
  const caps = scene.captions || [];
  if (!caps.length) return;
  let active = null;
  for (let i = 0; i < caps.length; i++) {
    const nextAt = caps[i + 1] ? caps[i + 1].at : scene.duration;
    if (t >= caps[i].at && t < nextAt) { active = caps[i]; break; }
  }
  if (!active) return;
  const lines = wrapText(active.text, 560, 2);
  const boxH = 22 + lines.length * 18;
  const boxY = CH - boxH - 14;
  ctx.save();
  ctx.globalAlpha = 0.72;
  ctx.fillStyle = '#000000';
  ctx.fillRect(40, boxY, CW - 80, boxH);
  ctx.restore();
  lines.forEach((line, i) => {
    drawText(ctx, line, CW / 2, boxY + 10 + i * 18, { scale: 2, align: 'center', color: '#ffe066', shadow: true });
  });
}

function drawSceneFade(ctx, t, duration, fade = {}) {
  const { fadeIn = 0.45, fadeOut = 0.55, color = '#000000' } = fade || {};
  let a = 0;
  if (fadeIn > 0 && t < fadeIn) a = 1 - t / fadeIn;
  if (fadeOut > 0 && t > duration - fadeOut) a = Math.max(a, (t - (duration - fadeOut)) / fadeOut);
  a = clamp01(a);
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, CW, CH);
  ctx.restore();
}

/**
 * Pure render of one frame of `scene` at time `t` (seconds, clamped to [0, scene.duration])
 * into `ctx`. Never touches document/window/timers — safe to call from tests against a stub
 * 2D context. opts:
 *   spriteProvider(name, tint, scale) -> drawable   (falls back to flat-colour rects if omitted)
 *   canvasW/canvasH                                  actual canvas size (scene space is 640x480)
 *   reducedMotion                                    drop bob/shake for prefers-reduced-motion
 */
export function renderFrame(ctx, scene, t, opts = {}) {
  if (!ctx || !scene) return;
  const { spriteProvider = null, canvasW = CW, canvasH = CH, reducedMotion = false } = opts;
  const duration = scene.duration;
  const tt = clamp01(duration <= 0 ? 0 : t / duration) * duration;
  ctx.save();
  ctx.scale(canvasW / CW, canvasH / CH);

  let shakeX = 0, shakeY = 0;
  if (scene.shake && !reducedMotion) {
    const { start = 0, end = duration, magnitude = 4 } = scene.shake;
    if (tt >= start && tt <= end) {
      shakeX = Math.sin(tt * 53) * magnitude;
      shakeY = Math.cos(tt * 47) * magnitude;
    }
  }
  ctx.save();
  ctx.translate(shakeX, shakeY);
  drawBackground(ctx, scene.background, spriteProvider, tt);
  for (const layer of scene.layers || []) drawLayer(ctx, layer, tt, spriteProvider, duration, reducedMotion);
  ctx.restore();

  drawCaptionBar(ctx, scene, tt);
  if (!scene.noFade) drawSceneFade(ctx, tt, duration, scene.fade);
  ctx.restore();
}

// ---- scene authoring --------------------------------------------------------------
function heroScene(cls) {
  const h = HERO[cls];
  return {
    id: `hero_${cls}`,
    duration: 5.5,
    background: { type: 'hall' },
    layers: [
      { type: 'actor', sprite: 'hero', tint: h.color, scale: 5, from: { x: -80, y: 250 }, to: { x: 270, y: 250 }, start: 0.2, end: 2.2, bob: 2 },
      { type: 'actor', sprite: h.weapon, tint: null, scale: 4, from: { x: -60, y: 220 }, to: { x: 720, y: 220 }, start: 2.4, end: 3.7 },
      { type: 'text', text: h.name.toUpperCase(), x: 320, y: 60, scale: 5, color: h.color, align: 'center', shadow: true, start: 1.6, end: 5.5, fadeIn: 0.4, fadeOut: 0.5 },
      { type: 'text', text: h.motto, x: 320, y: 400, scale: 2, color: '#e8e6d8', align: 'center', shadow: true, start: 2.0, end: 5.5, fadeIn: 0.4, fadeOut: 0.5 },
    ],
    captions: [],
  };
}

function milestoneScene(level) {
  const tag = level >= 50 ? 'THE DEPTHS DEEPEN' : level >= 25 ? 'HALFWAY TO LEGEND' : 'DEEP DUNGEON REACHED';
  return {
    id: `level_milestone_${level}`,
    duration: 3.2,
    noFade: false,
    background: { type: 'void', color: '#0b0b12' },
    layers: [
      { type: 'rect', x: 0, y: 0, w: CW, h: CH, color: '#f2c400', start: 0, end: 0.16, fadeIn: 0, fadeOut: 0.16 },
      { type: 'text', text: 'LEVEL', x: 320, y: 150, scale: 4, color: '#ffffff', align: 'center', start: 0.15, end: 3.2, fadeIn: 0.2, fadeOut: 0.4 },
      { type: 'text', text: String(level), x: 320, y: 220, scale: 9, color: '#f2c400', align: 'center', shadow: true, start: 0.15, end: 3.2, fadeIn: 0.2, fadeOut: 0.4 },
      { type: 'text', text: tag, x: 320, y: 350, scale: 2, color: '#8e8ca0', align: 'center', start: 0.4, end: 3.2, fadeIn: 0.3, fadeOut: 0.4 },
    ],
    captions: [],
  };
}

const introHeroes = ['warrior', 'valkyrie', 'wizard', 'elf'];
const scene_intro = {
  id: 'intro',
  duration: 8,
  background: { type: 'hall', door: { x: 560 } },
  layers: [
    { type: 'torch', x: 84, y: 208, seed: 1 },
    { type: 'torch', x: 576, y: 208, seed: 4.2 },
    { type: 'text', text: 'GAUNTLET CRAWLER', x: 320, y: 32, scale: 4, color: '#f2c400', align: 'center', shadow: true, start: 0.3, end: 8, fadeIn: 0.6, fadeOut: 0.8 },
    ...introHeroes.map((cls, i) => ({
      type: 'actor', sprite: 'hero', tint: HERO[cls].color, scale: 3,
      from: { x: -50 - i * 34, y: 250 + i * 24 }, to: { x: 500 - i * 12, y: 250 + i * 24 },
      start: 1 + i * 0.35, end: 6.4 + i * 0.35, bob: 3, bobPhase: i * 1.3,
    })),
  ],
  captions: [{ at: 2.4, text: 'Four heroes. One dungeon. It never ends.' }],
};

const scene_death_mode = {
  id: 'death_mode',
  duration: 7,
  background: { type: 'arena', tint: '#3a0000', tintAlpha: 0.12 },
  shake: { start: 4, end: 7, magnitude: 3 },
  layers: [
    { type: 'pulse', color: '#8f1f18', period: 1.1, amp: 0.22, base: 0.05 },
    { type: 'sprite-static', sprite: 'exit', tint: '#5a5a6a', scale: 6, x: 272, y: 300 },
    { type: 'text', text: 'SEALED', x: 320, y: 372, scale: 2, color: '#e03c31', align: 'center', shadow: true, start: 1.0, end: 7, fadeIn: 0.4, fadeOut: 0.5 },
    { type: 'actor', sprite: 'death', tint: null, scale: 8, from: { x: 288, y: 540 }, to: { x: 288, y: 170 }, start: 0.5, end: 4, bob: 4 },
    { type: 'text', text: 'DEATH MODE', x: 320, y: 44, scale: 4, color: '#e03c31', align: 'center', shadow: true, start: 0.2, end: 7, fadeIn: 0.5, fadeOut: 0.6 },
  ],
  captions: [{ at: 3.8, text: 'The exit is sealed. Survive the waves.' }],
};

const chestXs = [80, 160, 240, 320, 400, 480, 560];
const scene_treasure_room = {
  id: 'treasure_room',
  duration: 6,
  background: { type: 'hall' },
  layers: [
    { type: 'text', text: 'TREASURE ROOM', x: 320, y: 36, scale: 4, color: '#f2c400', align: 'center', shadow: true, start: 0.1, end: 6, fadeIn: 0.4, fadeOut: 0.6 },
    ...chestXs.map((x, i) => ({
      type: 'actor', sprite: 'treasure', tint: null, scale: 4,
      from: { x, y: -40 - i * 20 }, to: { x, y: 300 + (i % 3) * 22 },
      start: 0.4 + i * 0.25, end: 2.0 + i * 0.25,
    })),
  ],
  captions: [{ at: 2.8, text: 'Treasure room! Grab everything before the clock runs out.' }],
};

const gameOverHeroes = ['warrior', 'valkyrie', 'wizard', 'elf'];
const scene_game_over = {
  id: 'game_over',
  duration: 7,
  background: { type: 'hall', tint: '#000000', tintAlpha: 0.35 },
  layers: [
    { type: 'text', text: 'GAME OVER', x: 320, y: 48, scale: 5, color: '#e03c31', align: 'center', shadow: true, start: 0.2, end: 7, fadeIn: 0.5, fadeOut: 0.6 },
    ...gameOverHeroes.flatMap((cls, i) => {
      const h = HERO[cls];
      const x = 150 + i * 100;
      const fallAt = 1.2 + i * 1.1;
      return [
        { type: 'actor', sprite: 'hero', tint: h.color, scale: 4, from: { x, y: 250 }, to: { x, y: 250 }, start: 0, end: fallAt, showUntil: fallAt },
        { type: 'actor', sprite: 'hero', tint: '#6a6a78', scale: 4, from: { x, y: 250 }, to: { x: x - 8, y: 292 }, start: fallAt, end: fallAt + 0.6, flip: true, showFrom: fallAt },
      ];
    }),
  ],
  captions: [{ at: 5.2, text: 'Your quest ends here. Insert coin?' }],
};

const victoryHeroes = ['warrior', 'valkyrie', 'wizard', 'elf'];
const scene_victory = {
  id: 'victory',
  duration: 7,
  background: { type: 'hall' },
  layers: [
    ...[110, 210, 310, 410, 510].map((x, i) => ({ type: 'sprite-static', sprite: 'treasure', tint: null, scale: 3 + (i % 2), x, y: 350 - (i % 2) * 16 })),
    ...victoryHeroes.map((cls, i) => ({
      type: 'actor', sprite: 'hero', tint: HERO[cls].color, scale: 4,
      from: { x: 150 + i * 100, y: 280 }, to: { x: 150 + i * 100, y: 280 }, start: 0, end: 7, bob: 2, bobPhase: i * 1.1,
    })),
    { type: 'text', text: 'VICTORY!', x: 320, y: 44, scale: 5, color: '#2ecc40', align: 'center', shadow: true, start: 0.2, end: 7, fadeIn: 0.5, fadeOut: 0.6 },
    { type: 'particles', kind: 'confetti', start: 0, end: 7, count: 50 },
  ],
  captions: [{ at: 1.4, text: 'You have conquered the depths.' }],
};

const SCENES = {};
[scene_intro, scene_death_mode, scene_treasure_room, scene_game_over, scene_victory].forEach((s) => { SCENES[s.id] = s; });
for (const cls of HERO_ORDER) { const s = heroScene(cls); SCENES[s.id] = s; }
for (const lvl of [10, 25, 50]) { const s = milestoneScene(lvl); SCENES[s.id] = s; }

export { SCENES };
export const SCENE_IDS = Object.keys(SCENES);
export function getScene(id) { return SCENES[id] || null; }
export function listScenes() { return SCENE_IDS.map((id) => ({ id, duration: SCENES[id].duration, captions: SCENES[id].captions.length })); }

// ---- session "seen once" bookkeeping ---------------------------------------------
function storage() {
  try {
    if (typeof sessionStorage !== 'undefined' && sessionStorage) return sessionStorage;
  } catch { /* ignore (privacy mode, sandboxed iframe, ...) */ }
  return null;
}
export function hasSeen(id) {
  const s = storage();
  if (!s) return false;
  try { return s.getItem(SEEN_PREFIX + id) === '1'; } catch { return false; }
}
export function markSeen(id) {
  const s = storage();
  if (!s) return;
  try { s.setItem(SEEN_PREFIX + id, '1'); } catch { /* ignore */ }
}
export function clearSeen(id) {
  const s = storage();
  if (!s) return;
  try { s.removeItem(SEEN_PREFIX + id); } catch { /* ignore */ }
}

// ---- browser playback -------------------------------------------------------------
let spriteModulePromise = null;
function loadDefaultSpriteProvider() {
  if (!spriteModulePromise) spriteModulePromise = import('./sprites.js').then((m) => m.sprite);
  return spriteModulePromise;
}

/**
 * Play scene `sceneId` into `canvas` (a real <canvas> — this function is browser-only, unlike
 * renderFrame). Any keydown, click or pointerdown skips straight to the end. Returns a handle
 * with .skip()/.stop(). options:
 *   sfx(name), say(text)       — optional hooks wired to the game's own sfx()/say() (or no-ops)
 *   onSkip(), onDone({id,skipped}), allowSkip=true
 *   spriteProvider              — override for sprites.js's sprite() (tests / previews)
 *   reducedMotion                — defaults to matchMedia('(prefers-reduced-motion: reduce)')
 *   autoMarkSeen=true            — calls markSeen(sceneId) once the scene finishes or is skipped
 */
export function playCutscene(canvas, sceneId, options = {}) {
  const scene = SCENES[sceneId];
  const ctx = canvas.getContext('2d');
  let reduced = options.reducedMotion;
  if (reduced === undefined) {
    try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { reduced = false; }
  }
  const {
    sfx = () => {}, say = () => {}, onSkip, onDone, allowSkip = true,
    spriteProvider, canvasW = canvas.width || CW, canvasH = canvas.height || CH, autoMarkSeen = true,
  } = options;

  if (!scene) {
    const err = new Error(`Unknown cutscene: ${sceneId}`);
    if (onDone) onDone({ id: sceneId, skipped: false, error: err });
    throw err;
  }

  let stopped = false, startTime = null, rafId = null;
  const firedCaptions = new Set();
  const providerP = spriteProvider ? Promise.resolve(spriteProvider) : loadDefaultSpriteProvider();

  function cleanupListeners() {
    window.removeEventListener('keydown', onSkipEvt);
    canvas.removeEventListener('click', onSkipEvt);
    canvas.removeEventListener('pointerdown', onSkipEvt);
  }
  function onSkipEvt() { if (allowSkip) finish(true); }
  function finish(wasSkipped) {
    if (stopped) return;
    stopped = true;
    if (rafId != null) cancelAnimationFrame(rafId);
    cleanupListeners();
    if (autoMarkSeen) markSeen(sceneId);
    if (wasSkipped && onSkip) onSkip();
    else if (!wasSkipped && typeof scene.onEnd === 'function') scene.onEnd();
    if (onDone) onDone({ id: sceneId, skipped: !!wasSkipped });
  }

  providerP.then((sprites) => {
    if (stopped) return;
    window.addEventListener('keydown', onSkipEvt);
    canvas.addEventListener('click', onSkipEvt);
    canvas.addEventListener('pointerdown', onSkipEvt);
    if (ctx.imageSmoothingEnabled !== undefined) ctx.imageSmoothingEnabled = false;
    function frame(ts) {
      if (stopped) return;
      if (startTime == null) startTime = ts;
      const t = (ts - startTime) / 1000;
      renderFrame(ctx, scene, t, { spriteProvider: sprites, canvasW, canvasH, reducedMotion: reduced });
      for (const cap of scene.captions || []) {
        if (t >= cap.at && !firedCaptions.has(cap)) { firedCaptions.add(cap); say(cap.voice ?? cap.text); }
      }
      if (t >= scene.duration) { finish(false); return; }
      rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);
  }).catch((err) => { if (!stopped) { stopped = true; if (onDone) onDone({ id: sceneId, skipped: false, error: err }); } });

  void sfx; // sfx hook is available to future scene sfxCues; kept in the options contract now
  return {
    skip: () => finish(true),
    stop: () => finish(true),
    get scene() { return scene; },
  };
}
