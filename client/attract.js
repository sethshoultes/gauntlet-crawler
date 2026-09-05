// Arcade attract-mode title screen: cycles a pulsing title card, the in-engine `intro`
// cutscene, a hero roster, and a live top-10 leaderboard, then loops — exactly like a coin-op
// cabinet left idle. Any key, click or tap jumps straight to the real lobby ('/').
//
// Browser-only file (never imported by tests): free to reach for the real sprite() renderer
// and the shared game constants directly.
import { sprite, GEN_TINT } from './sprites.js';
import { renderFrame, getScene, HERO, HERO_ORDER } from './cutscenes.js';
import { CLASSES, CLASS_IDS, T, SOLID_TILES } from '/shared/constants.js';
import { drawText, wrapText } from './font.js';

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
ctx.imageSmoothingEnabled = false;
const CW = 640, CH = 480;

const reducedMotion = (() => {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch { return false; }
})();

// Hidden-by-default: append ?demo=1 to see monsters wander a fresh procedurally generated
// level. Kept out of the normal loop so the public-facing attract cycle stays predictable.
const showMapDemo = new URLSearchParams(location.search).get('demo') === '1';

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
function goToGame() {
  if (navigating) return;
  navigating = true;
  location.href = '/';
}
window.addEventListener('keydown', goToGame);
window.addEventListener('pointerdown', goToGame);
window.addEventListener('click', goToGame);

// ---------- phase machine ----------
const PHASES = ['title', 'intro', 'roster', 'scores'];
if (showMapDemo) PHASES.push('mapdemo');
let phaseIndex = 0;
let phaseStart = performance.now();

function phaseDuration(name) {
  const base = { title: 6, intro: getScene('intro')?.duration ?? 8, roster: 8.5, scores: 8, mapdemo: 14 }[name] ?? 6;
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

// ---------- hero roster ----------
function drawRoster(t) {
  ctx.fillStyle = '#0b0b12';
  ctx.fillRect(0, 0, CW, CH);
  const a = Math.min(1, t / 0.4);
  drawText(ctx, 'CHOOSE YOUR HERO', CW / 2, 20, { scale: 3, align: 'center', color: '#f2c400', shadow: true, alpha: a });
  const cols = 4;
  const cellW = 150, cellH = 190;
  const gridW = cols * cellW;
  const startX = (CW - gridW) / 2;
  const startY = 66;
  CLASS_IDS.forEach((id, i) => {
    const cls = CLASSES[id];
    const cx = startX + (i % cols) * cellW + cellW / 2;
    const row = Math.floor(i / cols);
    const cy = startY + row * cellH;
    const enter = Math.min(1, Math.max(0, (t - i * 0.08) / 0.35));
    if (enter <= 0) return;
    const bob = reducedMotion ? 0 : Math.sin(t * 2 + i) * 2;
    ctx.save();
    ctx.globalAlpha = enter;
    const img = sprite('hero', cls.color, 5);
    ctx.drawImage(img, cx - img.width / 2, cy + bob);
    ctx.restore();
    drawText(ctx, cls.name.toUpperCase(), cx, cy + 46, { scale: 2, align: 'center', color: cls.color, shadow: true, alpha: enter });
    drawText(ctx, HERO[id]?.name?.toUpperCase() ?? '', cx, cy + 66, { scale: 1.2, align: 'center', color: '#8e8ca0', alpha: enter });
    const stats = [
      `SPD ${cls.speed.toFixed(1)}`,
      `DMG ${cls.shotDamage}`,
      `ARM ${cls.armor.toFixed(1)}`,
      `MAG ${cls.magic.toFixed(1)}`,
    ];
    stats.forEach((s, si) => drawText(ctx, s, cx, cy + 84 + si * 14, { scale: 1.2, align: 'center', color: '#e8e6d8', alpha: enter }));
    if (cls.locked) drawText(ctx, 'LOCKED', cx, cy + 84 + stats.length * 14 + 4, { scale: 1.2, align: 'center', color: '#e03c31', alpha: enter });
  });
}

// ---------- high scores ----------
let scores = null, scoresError = null, scoresFetchedAt = 0;
async function loadScores(force = false) {
  if (!force && scores && performance.now() - scoresFetchedAt < 30000) return;
  try {
    const res = await fetch('/api/leaderboard');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    scores = Array.isArray(data.scores) ? data.scores.slice(0, 10) : [];
    scoresError = null;
  } catch (err) {
    scoresError = String(err.message || err);
    scores = scores || [];
  }
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
    drawText(ctx, scoresError ? 'SCORES UNAVAILABLE' : 'NO SCORES YET — BE THE FIRST', CW / 2, 200, { scale: 2, align: 'center', color: '#8e8ca0', alpha: a });
    return;
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const rowAlpha = Math.min(1, Math.max(0, a - i * 0.03));
    const color = i === 0 ? '#f2c400' : i === 1 ? '#e8e6d8' : i === 2 ? '#e8a33d' : '#8e8ca0';
    drawText(ctx, `${i + 1}.`.padEnd(3, ' '), 90, y, { scale: 1.8, color, alpha: rowAlpha });
    drawText(ctx, String(r.username || 'GUEST').slice(0, 12).toUpperCase(), 170, y, { scale: 1.8, color, alpha: rowAlpha });
    drawText(ctx, String(r.class || '').slice(0, 10).toUpperCase(), 330, y, { scale: 1.8, color, alpha: rowAlpha });
    drawText(ctx, String(r.score ?? 0), 460, y, { scale: 1.8, color, alpha: rowAlpha });
    drawText(ctx, String(r.level_reached ?? ''), 570, y, { scale: 1.8, color, alpha: rowAlpha });
  });
}

// ---------- hidden demo mode: monsters wandering a fresh procedurally generated map ----------
let mapDemo = null; // { rows, w, h, ts, monsters }
async function ensureMapDemo() {
  if (mapDemo) return;
  mapDemo = { loading: true };
  try {
    const res = await fetch('/api/levels/procgen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed: Math.random().toString(36).slice(2), level: 6 }),
    });
    const data = await res.json();
    const rows = data.level.rows;
    const w = rows[0].length, h = rows.length;
    const ts = Math.max(4, Math.floor(Math.min(CW / w, CH / h)));
    const floors = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!SOLID_TILES.has(rows[y][x])) floors.push([x, y]);
    const kinds = [
      { sprite: 'ghost', tint: GEN_TINT.h, speed: 3.4 },
      { sprite: 'grunt', tint: GEN_TINT.g, speed: 2.6 },
      { sprite: 'grunt', tint: GEN_TINT.g, speed: 2.6 },
      { sprite: 'ghost', tint: GEN_TINT.h, speed: 3.4 },
      { sprite: 'demon', tint: GEN_TINT.m, speed: 2.2 },
      { sprite: 'ghost', tint: GEN_TINT.h, speed: 3.4 },
    ];
    const isFloor = (x, y) => x >= 0 && y >= 0 && x < w && y < h && !SOLID_TILES.has(rows[y][x]);
    const monsters = kinds.map((k, i) => {
      const [sx, sy] = floors.length ? floors[Math.floor((i / kinds.length) * floors.length)] : [1, 1];
      return { ...k, x: sx, y: sy, tx: sx, ty: sy, wait: 0 };
    });
    mapDemo = { rows, w, h, ts, monsters, isFloor, loading: false };
  } catch (err) {
    mapDemo = { error: String(err.message || err), loading: false };
  }
}

function pickNextTile(m, isFloor, w, h) {
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  const shuffled = dirs.map((d) => [d, Math.random()]).sort((a, b) => a[1] - b[1]).map((d) => d[0]);
  for (const [dx, dy] of shuffled) {
    const nx = m.tx + dx, ny = m.ty + dy;
    if (isFloor(nx, ny)) return [nx, ny];
  }
  return [m.tx, m.ty];
}

let lastMapT = null;
function stepMapDemo(dt) {
  if (!mapDemo || !mapDemo.monsters) return;
  const { isFloor, w, h, monsters } = mapDemo;
  for (const m of monsters) {
    const dx = m.tx - m.x, dy = m.ty - m.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.05) {
      m.x = m.tx; m.y = m.ty;
      m.wait -= dt;
      if (m.wait <= 0) {
        [m.tx, m.ty] = pickNextTile(m, isFloor, w, h);
        m.wait = 0.15 + Math.random() * 0.4;
      }
    } else {
      const step = m.speed * dt;
      m.x += (dx / dist) * Math.min(step, dist);
      m.y += (dy / dist) * Math.min(step, dist);
    }
  }
}

function drawMapDemo(t) {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, CW, CH);
  if (!mapDemo || mapDemo.loading) {
    drawText(ctx, 'GENERATING DUNGEON…', CW / 2, CH / 2 - 8, { scale: 2, align: 'center', color: '#8e8ca0' });
    return;
  }
  if (mapDemo.error) {
    drawText(ctx, 'DEMO MAP UNAVAILABLE', CW / 2, CH / 2 - 8, { scale: 2, align: 'center', color: '#e03c31' });
    return;
  }
  const { rows, w, h, ts, monsters } = mapDemo;
  const offX = Math.floor((CW - w * ts) / 2), offY = Math.floor((CH - h * ts) / 2);
  const S = Math.max(1, Math.round(ts / 8));
  const floor = sprite('floor', null, S), wall = sprite('wall', null, S);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const solid = SOLID_TILES.has(rows[y][x]);
      const img = solid ? wall : floor;
      ctx.drawImage(img, offX + x * ts, offY + y * ts, ts, ts);
    }
  }
  for (const m of monsters) {
    const img = sprite(m.sprite, m.tint, S);
    ctx.drawImage(img, offX + m.x * ts - img.width / 2, offY + m.y * ts - img.height / 2);
  }
  const a = Math.min(1, t / 0.4);
  drawText(ctx, 'LIVE DUNGEON PREVIEW', CW / 2, 14, { scale: 2, align: 'center', color: '#f2c400', shadow: true, alpha: a });
}

// ---------- main loop ----------
let rafId = null;
function tick(now) {
  const phase = PHASES[phaseIndex];
  const t = (now - phaseStart) / 1000;
  const dur = phaseDuration(phase);

  if (lastMapT == null) lastMapT = now;
  const dt = Math.min(0.05, (now - lastMapT) / 1000);
  lastMapT = now;

  switch (phase) {
    case 'title': drawTitle(t); break;
    case 'intro': renderFrame(ctx, getScene('intro'), t, { spriteProvider: sprite, canvasW: CW, canvasH: CH, reducedMotion }); break;
    case 'roster': drawRoster(t); break;
    case 'scores': drawScores(t); break;
    case 'mapdemo': stepMapDemo(dt); drawMapDemo(t); break;
    default: break;
  }

  if (t >= dur) {
    phaseIndex = (phaseIndex + 1) % PHASES.length;
    phaseStart = now;
    const next = PHASES[phaseIndex];
    if (next === 'scores') loadScores();
    if (next === 'mapdemo') ensureMapDemo();
  }
  rafId = requestAnimationFrame(tick);
}

if (PHASES[phaseIndex] === 'scores') loadScores();
if (PHASES[phaseIndex] === 'mapdemo') ensureMapDemo();
rafId = requestAnimationFrame(tick);

window.addEventListener('pagehide', () => { if (rafId) cancelAnimationFrame(rafId); });
void HERO_ORDER;
