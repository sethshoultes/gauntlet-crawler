// Arcade attract-mode title screen: cycles a pulsing title card, the in-engine `intro`
// cutscene, a hero roster, and a live top-10 leaderboard, then loops — exactly like a coin-op
// cabinet left idle. Any key, click or tap jumps straight to the real lobby ('/').
//
// Browser-only file (never imported by tests): free to reach for the real sprite() renderer
// and the shared game constants directly.
import { sprite, GEN_TINT } from './sprites.js';
import { renderFrame, getScene, HERO, HERO_ORDER } from './cutscenes.js';
import { CLASSES, CLASS_IDS, SOLID_TILES } from '/shared/constants.js';
import { generateLevel } from '/shared/procgen.js';
import { drawText } from './font.js';
import { sfx, initAudio } from './audio.js';
import { fetchHighScores } from './highscore.js';

// Arming the audio context so the carousel's advance fanfare (below) has a chance of actually
// being audible: browsers only let it resume on a user gesture, and the only gestures this page
// ever sees (goToGame's keydown/pointerdown/click listeners) immediately navigate away — so on a
// truly untouched cabinet the fanfare stays silent, same as it would on a real one with no coin
// inserted yet. Harmless either way; never throws, never blocks the loop.
initAudio();

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
ctx.imageSmoothingEnabled = false;
const CW = 640, CH = 480;

const reducedMotion = (() => {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch { return false; }
})();


// ---------- fit the fixed 640x480 canvas to fill the viewport, letterboxed ----------
function fitCanvas() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const scale = Math.max(1, Math.min(vw / CW, vh / CH));
  cv.style.width = `${Math.round(CW * scale)}px`;
  cv.style.height = `${Math.round(CH * scale)}px`;
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

// ---------- any input leaves attract mode ----------
let navigating = false;
function goToGame(e) {
  if (navigating) return;
  // Let the footer's "Trailer" link behave like a normal link instead of being hijacked
  // straight back to '/' the instant it's clicked or tabbed to.
  if (e && e.target && typeof e.target.closest === 'function' && e.target.closest('#footer-links')) return;
  navigating = true;
  location.href = '/';
}
window.addEventListener('keydown', goToGame);
window.addEventListener('pointerdown', goToGame);
window.addEventListener('click', goToGame);

// ---------- AI-generated backdrop: video behind the canvas, static image fallback ----------
(function initBackdrop() {
  const video = document.getElementById('backdrop-video');
  const fallback = document.getElementById('backdrop-fallback');
  if (!video || !fallback) return;
  function useFallback() {
    video.style.display = 'none';
    fallback.style.display = 'block';
  }
  if (reducedMotion) { useFallback(); return; } // CSS already hides the video in this case too
  video.addEventListener('error', useFallback);
  try {
    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(useFallback);
  } catch { useFallback(); }
  // Autoplay can also fail silently (no error, no rejection) when a browser can't decode the
  // stream at all -- headless Chromium without H.264 support is exactly this case. If playback
  // never actually advances, treat it as failed and drop back to the static poster.
  setTimeout(() => {
    if (video.style.display === 'none') return;
    if (video.readyState < 2 || video.currentTime === 0) useFallback();
  }, 2000);
})();

// ---------- phase machine ----------
// 'carousel' (the hero portrait cycle) replaced the old static 4-up roster grid, and 'demo' (a
// scripted hero-vs-monsters encounter, see below) is no longer hidden behind a query flag: both
// are acceptance criteria for #14, not opt-in extras.
const PHASES = ['title', 'intro', 'carousel', 'demo', 'scores'];
let phaseIndex = 0;
let phaseStart = performance.now();
const CAROUSEL_STEP = 2.6; // seconds shown per hero

function phaseDuration(name) {
  const base = { title: 6, intro: getScene('intro')?.duration ?? 8, carousel: CLASS_IDS.length * CAROUSEL_STEP, demo: 14, scores: 8 }[name] ?? 6;
  return reducedMotion ? base * 0.75 : base;
}

// ---------- title card (built from the same declarative scene format as cutscenes.js) ----------
const titleScene = {
  id: 'attract_title',
  duration: 999,
  noFade: true,
  background: { type: 'hall' },
  layers: [
    { type: 'torch', x: 60, y: 216, seed: 2 },
    { type: 'torch', x: 580, y: 216, seed: 6.4 },
    { type: 'text', text: 'GAUNTLET CRAWLER', x: 320, y: 118, scale: 6, color: '#f2c400', align: 'center', shadow: true, start: 0, end: 999, fadeIn: 0.4, fadeOut: 0 },
    { type: 'text', text: 'A 1985-STYLE ONLINE DUNGEON CRAWL', x: 320, y: 208, scale: 2, color: '#8e8ca0', align: 'center', start: 0, end: 999, fadeIn: 0.4, fadeOut: 0 },
  ],
  captions: [],
};

function drawTitle(t) {
  renderFrame(ctx, titleScene, t, { spriteProvider: sprite, canvasW: CW, canvasH: CH, reducedMotion });
  const blink = reducedMotion ? (Math.floor(t) % 2 === 0) : (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 4.2)));
  drawText(ctx, 'PRESS ANY KEY', CW / 2, 330, { scale: 3, align: 'center', color: '#ffffff', shadow: true, alpha: typeof blink === 'boolean' ? (blink ? 1 : 0) : blink });
  drawText(ctx, 'FOUR HEROES · ONE DUNGEON · IT NEVER ENDS', CW / 2, 380, { scale: 1.6, align: 'center', color: '#5a5870' });
  drawText(ctx, '© 1985-STYLE HOMAGE — NOT AFFILIATED WITH ATARI', CW / 2, 456, { scale: 1.2, align: 'center', color: '#3a3a4c' });
}

// ---------- hero portrait carousel ----------
// One hero at a time, large, with a short fanfare (client/audio.js) each time it advances to the
// next — the classic "insert coin, meet the cast" cabinet beat, replacing the old static 4-up grid.
let carouselIdx = -1;
function drawCarousel(t) {
  ctx.fillStyle = '#0b0b12';
  ctx.fillRect(0, 0, CW, CH);
  const idx = Math.min(CLASS_IDS.length - 1, Math.floor(t / CAROUSEL_STEP));
  if (idx !== carouselIdx) { carouselIdx = idx; sfx('ach'); } // respects the shared mute flag inside audio.js
  const localT = t - idx * CAROUSEL_STEP;
  const id = CLASS_IDS[idx];
  const cls = CLASSES[id];
  const a = Math.min(1, localT / 0.3);
  drawText(ctx, 'MEET THE HEROES', CW / 2, 20, { scale: 3, align: 'center', color: '#f2c400', shadow: true });
  drawText(ctx, `${idx + 1} / ${CLASS_IDS.length}`, CW / 2, 52, { scale: 1.4, align: 'center', color: '#5a5870' });
  const cx = CW / 2, cy = 220;
  const bob = reducedMotion ? 0 : Math.sin(t * 1.6) * 3;
  const slideIn = reducedMotion ? 0 : (1 - a) * 60;
  ctx.save();
  ctx.globalAlpha = a;
  const img = sprite('hero', cls.color, 10);
  ctx.drawImage(img, cx - img.width / 2 - slideIn, cy - img.height / 2 + bob);
  ctx.restore();
  drawText(ctx, cls.name.toUpperCase(), cx, cy + 90, { scale: 3.4, align: 'center', color: cls.color, shadow: true, alpha: a });
  drawText(ctx, HERO[id]?.name?.toUpperCase() ?? '', cx, cy + 120, { scale: 1.6, align: 'center', color: '#8e8ca0', alpha: a });
  const stats = [
    `SPEED ${cls.speed.toFixed(1)}`,
    `SHOT ${cls.shotDamage}`,
    `ARMOR ${cls.armor.toFixed(1)}`,
    `MAGIC ${cls.magic.toFixed(1)}`,
  ];
  stats.forEach((s, si) => drawText(ctx, s, cx, cy + 148 + si * 18, { scale: 1.6, align: 'center', color: '#e8e6d8', alpha: a }));
  if (cls.locked) drawText(ctx, 'UNLOCKS LATER — KEEP PLAYING', cx, cy + 148 + stats.length * 18 + 10, { scale: 1.4, align: 'center', color: '#e03c31', alpha: a });
  // progress dots
  CLASS_IDS.forEach((_, i) => {
    const dx = cx - (CLASS_IDS.length - 1) * 10 + i * 20;
    ctx.fillStyle = i === idx ? '#f2c400' : '#2b2b3d';
    ctx.fillRect(dx - 3, CH - 30, 6, 6);
  });
}

// ---------- high scores ----------
// Same all-time arcade board the lobby renders as HTML (client/highscore.js's fetchHighScores(),
// GET /api/highscores, server/highscores.js) — shared data source, drawn here with the bitmap
// font instead of a DOM table since this whole page is one canvas.
let scores = null, scoresFetchedAt = 0;
async function loadScores(force = false) {
  if (!force && scores && performance.now() - scoresFetchedAt < 30000) return;
  scores = await fetchHighScores();
  scoresFetchedAt = performance.now();
}

function drawScores(t) {
  ctx.fillStyle = '#0b0b12';
  ctx.fillRect(0, 0, CW, CH);
  const a = Math.min(1, t / 0.4);
  drawText(ctx, 'HIGH SCORES', CW / 2, 26, { scale: 4, align: 'center', color: '#f2c400', shadow: true, alpha: a });
  const rows = scores || [];
  const top = 90, rowH = 30;
  drawText(ctx, 'RANK', 90, top - 20, { scale: 1.4, color: '#5a5870' });
  drawText(ctx, 'NAME', 170, top - 20, { scale: 1.4, color: '#5a5870' });
  drawText(ctx, 'CLASS', 330, top - 20, { scale: 1.4, color: '#5a5870' });
  drawText(ctx, 'SCORE', 460, top - 20, { scale: 1.4, color: '#5a5870' });
  drawText(ctx, 'LVL', 570, top - 20, { scale: 1.4, color: '#5a5870' });
  if (!rows.length) {
    drawText(ctx, 'NO SCORES YET — BE THE FIRST', CW / 2, 200, { scale: 2, align: 'center', color: '#8e8ca0', alpha: a });
    return;
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const rowAlpha = Math.min(1, Math.max(0, a - i * 0.03));
    const color = i === 0 ? '#f2c400' : i === 1 ? '#e8e6d8' : i === 2 ? '#e8a33d' : '#8e8ca0';
    drawText(ctx, `${i + 1}.`.padEnd(3, ' '), 90, y, { scale: 1.8, color, alpha: rowAlpha });
    drawText(ctx, String(r.initials || r.username || 'GUEST').slice(0, 12).toUpperCase(), 170, y, { scale: 1.8, color, alpha: rowAlpha });
    drawText(ctx, String(r.class || '').slice(0, 10).toUpperCase(), 330, y, { scale: 1.8, color, alpha: rowAlpha });
    drawText(ctx, String(r.score ?? 0), 460, y, { scale: 1.8, color, alpha: rowAlpha });
    drawText(ctx, String(r.level_reached ?? ''), 570, y, { scale: 1.8, color, alpha: rowAlpha });
  });
}

// ---------- scripted demo: a hero hunting a few monsters around a small local level ----------
// Built entirely client-side from shared/procgen.js — the same seeded generator the real game
// uses server-side — so this phase never depends on a live connection or round-trip, and can run
// in the default loop (it used to be hidden behind ?demo=1 and fetched /api/levels/procgen).
let demo = null; // { rows, w, h, ts, isFloor, floors, hero, monsters, score, fx }
function buildDemo() {
  try {
    const level = generateLevel({ seed: Math.random().toString(36).slice(2), level: 4 });
    const rows = level.rows;
    const w = rows[0].length, h = rows.length;
    const ts = Math.max(4, Math.floor(Math.min(CW / w, (CH - 40) / h)));
    const isFloor = (x, y) => x >= 0 && y >= 0 && x < w && y < h && !SOLID_TILES.has(rows[y][x]);
    const floors = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (isFloor(x, y)) floors.push([x, y]);
    const spot = (i, n) => (floors.length ? floors[Math.floor((i / n) * floors.length)] : [1, 1]);
    const heroCls = CLASS_IDS[Math.floor(Math.random() * CLASS_IDS.length)];
    const [hx, hy] = spot(0, 5);
    const hero = { x: hx, y: hy, tx: hx, ty: hy, wait: 0, speed: 3.2, cls: heroCls, color: CLASSES[heroCls].color };
    const kinds = [
      { sprite: 'ghost', tint: GEN_TINT.h, speed: 3.0 },
      { sprite: 'grunt', tint: GEN_TINT.g, speed: 2.4 },
      { sprite: 'grunt', tint: GEN_TINT.g, speed: 2.4 },
      { sprite: 'demon', tint: GEN_TINT.m, speed: 2.0 },
    ];
    const monsters = kinds.map((k, i) => {
      const [sx, sy] = spot(i + 1, kinds.length + 1);
      return { ...k, x: sx, y: sy, tx: sx, ty: sy, wait: 0, alive: true };
    });
    demo = { rows, w, h, ts, isFloor, floors, hero, monsters, score: 0, fx: [] };
  } catch (err) {
    demo = { error: String(err.message || err) };
  }
}

function pickNextTile(e, isFloor) {
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  const shuffled = dirs.map((d) => [d, Math.random()]).sort((a, b) => a[1] - b[1]).map((d) => d[0]);
  for (const [dx, dy] of shuffled) {
    const nx = e.tx + dx, ny = e.ty + dy;
    if (isFloor(nx, ny)) return [nx, ny];
  }
  return [e.tx, e.ty];
}
function stepEntity(e, isFloor, dt) {
  const dx = e.tx - e.x, dy = e.ty - e.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.05) {
    e.x = e.tx; e.y = e.ty;
    e.wait -= dt;
    if (e.wait <= 0) { [e.tx, e.ty] = pickNextTile(e, isFloor); e.wait = 0.15 + Math.random() * 0.4; }
  } else {
    const step = e.speed * dt;
    e.x += (dx / dist) * Math.min(step, dist);
    e.y += (dy / dist) * Math.min(step, dist);
  }
}

/** The hero always makes for the nearest living monster (no random wandering while one's out
 *  there — nothing to chase means it just idles via the normal pickNextTile roam above); catching
 *  one is a "kill": it respawns elsewhere after a beat so the loop never runs dry. */
function stepDemo(dt) {
  if (!demo || demo.error) return;
  const { isFloor, monsters, hero, floors } = demo;
  let target = null, bestD = Infinity;
  for (const m of monsters) if (m.alive) { const d = Math.hypot(m.x - hero.x, m.y - hero.y); if (d < bestD) { bestD = d; target = m; } }
  if (target) { hero.tx = Math.round(target.x); hero.ty = Math.round(target.y); hero.wait = 0; }
  stepEntity(hero, isFloor, dt);
  for (const m of monsters) if (m.alive) stepEntity(m, isFloor, dt);
  if (target && Math.hypot(target.x - hero.x, target.y - hero.y) < 0.6) {
    target.alive = false;
    demo.score += 100;
    demo.fx.push({ x: target.x, y: target.y, t: 0 });
    sfx('kill');
    setTimeout(() => {
      if (!demo || demo.error || !floors.length) return;
      const [sx, sy] = floors[Math.floor(Math.random() * floors.length)];
      Object.assign(target, { x: sx, y: sy, tx: sx, ty: sy, alive: true, wait: 0.4 });
    }, 900);
  }
  for (const f of demo.fx) f.t += dt;
  demo.fx = demo.fx.filter((f) => f.t < 0.6);
}

function drawDemo(t) {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, CW, CH);
  if (!demo) { drawText(ctx, 'GENERATING DUNGEON…', CW / 2, CH / 2 - 8, { scale: 2, align: 'center', color: '#8e8ca0' }); return; }
  if (demo.error) { drawText(ctx, 'DEMO UNAVAILABLE', CW / 2, CH / 2 - 8, { scale: 2, align: 'center', color: '#e03c31' }); return; }
  const { rows, w, h, ts, monsters, hero } = demo;
  const offX = Math.floor((CW - w * ts) / 2), offY = Math.floor((CH - h * ts) / 2) + 10;
  const S = Math.max(1, Math.round(ts / 8));
  const floor = sprite('floor', null, S), wall = sprite('wall', null, S);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const solid = SOLID_TILES.has(rows[y][x]);
      ctx.drawImage(solid ? wall : floor, offX + x * ts, offY + y * ts, ts, ts);
    }
  }
  for (const m of monsters) if (m.alive) {
    const img = sprite(m.sprite, m.tint, S);
    ctx.drawImage(img, offX + m.x * ts - img.width / 2, offY + m.y * ts - img.height / 2);
  }
  const heroImg = sprite('hero', hero.color, S);
  ctx.drawImage(heroImg, offX + hero.x * ts - heroImg.width / 2, offY + hero.y * ts - heroImg.height / 2);
  for (const f of demo.fx) {
    ctx.fillStyle = `rgba(244,244,244,${Math.max(0, 1 - f.t * 2)})`;
    for (let i = 0; i < 6; i++) {
      const a2 = (i / 6) * Math.PI * 2, d = f.t * 60;
      ctx.fillRect(offX + f.x * ts + Math.cos(a2) * d - 2, offY + f.y * ts + Math.sin(a2) * d - 2, 4, 4);
    }
  }
  const a = Math.min(1, t / 0.4);
  drawText(ctx, `${CLASSES[hero.cls].name.toUpperCase()} DEMO — SCORE ${demo.score}`, CW / 2, 14, { scale: 2, align: 'center', color: '#f2c400', shadow: true, alpha: a });
}

// ---------- main loop ----------
let rafId = null;
let lastFrameT = null;
function tick(now) {
  const phase = PHASES[phaseIndex];
  const t = (now - phaseStart) / 1000;
  const dur = phaseDuration(phase);

  if (lastFrameT == null) lastFrameT = now;
  const dt = Math.min(0.05, (now - lastFrameT) / 1000);
  lastFrameT = now;

  switch (phase) {
    case 'title': drawTitle(t); break;
    case 'intro': renderFrame(ctx, getScene('intro'), t, { spriteProvider: sprite, canvasW: CW, canvasH: CH, reducedMotion }); break;
    case 'carousel': drawCarousel(t); break;
    case 'demo': stepDemo(dt); drawDemo(t); break;
    case 'scores': drawScores(t); break;
    default: break;
  }

  if (t >= dur) {
    phaseIndex = (phaseIndex + 1) % PHASES.length;
    phaseStart = now;
    const next = PHASES[phaseIndex];
    if (next === 'carousel') carouselIdx = -1;
    if (next === 'demo') buildDemo();
    if (next === 'scores') loadScores();
  }
  rafId = requestAnimationFrame(tick);
}

if (PHASES[phaseIndex] === 'demo') buildDemo();
if (PHASES[phaseIndex] === 'scores') loadScores();
rafId = requestAnimationFrame(tick);

window.addEventListener('pagehide', () => { if (rafId) cancelAnimationFrame(rafId); });
void HERO_ORDER;
