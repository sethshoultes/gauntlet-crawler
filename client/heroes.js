import { api, me, renderNav, authModal, toast, esc } from './common.js';
import { sprite } from './sprites.js';
import { spriteFromPixels } from './pixelsprite.js';
import { STATS, PALETTE, WEAPONS, TRAITS, presetHeroes, notchesFromClass } from '/shared/hero-builder.js';
import { CLASSES } from '/shared/constants.js';
import { rankTitle } from '/shared/progression.js';
import { ACHIEVEMENT_BY_ID } from '/shared/achievements.js';

const $ = (s) => document.querySelector(s);
renderNav('heroes');

const STAT_LABEL = { speed: 'Speed', shot: 'Shot Power', fireRate: 'Fire Rate', armor: 'Armor', magic: 'Magic', health: 'Health' };
const CLASSIC_NOTCHES = Object.fromEntries(
  ['warrior', 'valkyrie', 'wizard', 'elf'].map((id) => [id, notchesFromClass(CLASSES[id])]),
);
const CLASSIC_COLOR = { warrior: 'var(--red)', valkyrie: 'var(--blue)', wizard: 'var(--yellow)', elf: 'var(--green)' };
const blankStats = () => Object.fromEntries(STATS.map((k) => [k, 0]));
const blankPixels = () => new Array(8).fill('........');

const HB = {
  rank: 1, budget: 0, unlockedWeapons: [], unlockedTraits: [],
  id: null, name: '', title: '', motto: '',
  stats: blankStats(), weapon: 'axe', trait: null, pixels: blankPixels(),
  brush: '2', mirror: false, scale: 4, flip: false,
};

function requirementText(requires) {
  if (!requires) return 'Unlocked';
  if (requires.rank != null) return `Rank ${requires.rank}+`;
  if (requires.achievement) return `Unlock "${ACHIEVEMENT_BY_ID[requires.achievement]?.name || requires.achievement}"`;
  return 'Locked';
}

// ---------- pixel editor ----------
const pcv = $('#pcv'); const pctx = pcv.getContext('2d'); pctx.imageSmoothingEnabled = false;
const CELL = 32; // 256 / 8

function drawGrid() {
  pctx.clearRect(0, 0, 256, 256);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const ch = HB.pixels[y][x];
      if (ch !== '.') { pctx.fillStyle = PALETTE[Number(ch)]; pctx.fillRect(x * CELL, y * CELL, CELL, CELL); }
    }
  }
  pctx.strokeStyle = 'rgba(255,255,255,0.08)';
  for (let i = 0; i <= 8; i++) {
    pctx.beginPath(); pctx.moveTo(i * CELL, 0); pctx.lineTo(i * CELL, 256); pctx.stroke();
    pctx.beginPath(); pctx.moveTo(0, i * CELL); pctx.lineTo(256, i * CELL); pctx.stroke();
  }
}
function setPixel(x, y, ch) {
  const row = HB.pixels[y].split('');
  row[x] = ch; HB.pixels[y] = row.join('');
  if (HB.mirror) { const mx = 7 - x; const mrow = HB.pixels[y].split(''); mrow[mx] = ch; HB.pixels[y] = mrow.join(''); }
}
function cellAt(ev) {
  const r = pcv.getBoundingClientRect();
  const x = Math.floor((ev.clientX - r.left) / r.width * 8);
  const y = Math.floor((ev.clientY - r.top) / r.height * 8);
  return x >= 0 && y >= 0 && x < 8 && y < 8 ? [x, y] : null;
}
let painting = false;
function paintAt(ev) {
  const cell = cellAt(ev); if (!cell) return;
  const [x, y] = cell;
  const ch = ev.buttons === 2 ? '.' : HB.brush;
  setPixel(x, y, ch);
  drawGrid(); updatePreview();
}
pcv.addEventListener('contextmenu', (e) => e.preventDefault());
pcv.addEventListener('pointerdown', (e) => { painting = true; paintAt(e); });
pcv.addEventListener('pointermove', (e) => { if (painting) paintAt(e); });
window.addEventListener('pointerup', () => { painting = false; });

// palette swatches
const swatchesEl = $('#swatches');
PALETTE.forEach((color, i) => {
  const b = document.createElement('button');
  b.className = 'swatch-btn' + (String(i) === HB.brush ? ' on' : '');
  b.style.background = color;
  b.title = color;
  b.onclick = () => { HB.brush = String(i); refreshTools(); };
  swatchesEl.appendChild(b);
});
function refreshTools() {
  swatchesEl.querySelectorAll('.swatch-btn').forEach((b, i) => b.classList.toggle('on', String(i) === HB.brush));
  $('#eraser-btn').classList.toggle('on', HB.brush === '.');
  $('#mirror-btn').classList.toggle('on', HB.mirror);
  $('#mirror-btn').textContent = 'Mirror: ' + (HB.mirror ? 'On' : 'Off');
}
$('#eraser-btn').onclick = () => { HB.brush = '.'; refreshTools(); };
$('#mirror-btn').onclick = () => { HB.mirror = !HB.mirror; refreshTools(); };
$('#clear-btn').onclick = () => { HB.pixels = blankPixels(); drawGrid(); updatePreview(); };

// preset dropdown
const PRESETS = presetHeroes();
const presetSel = $('#preset');
for (const p of PRESETS) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; presetSel.appendChild(o); }
presetSel.onchange = () => {
  const p = PRESETS.find((x) => x.id === presetSel.value); if (!p) return;
  loadHeroIntoForm({ ...p, id: null });
  toast('Template loaded', `${p.name} — tweak it, then Save Hero.`);
  presetSel.value = '';
};

// live preview
const previewCv = $('#preview');
function updatePreview() {
  const scaleMap = { 1: 2, 2: 4, 4: 8 };
  const bitmap = spriteFromPixels(HB.pixels, PALETTE, scaleMap[HB.scale] || 4);
  if (!bitmap) return;
  previewCv.width = bitmap.width; previewCv.height = bitmap.height;
  const ctx = previewCv.getContext('2d'); ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  previewCv.classList.toggle('flip', HB.flip);
}
document.querySelectorAll('.scale-btns button').forEach((b) => {
  b.onclick = () => {
    HB.scale = Number(b.dataset.scale);
    document.querySelectorAll('.scale-btns button').forEach((x) => x.classList.toggle('on', x === b));
    updatePreview();
  };
});
$('#flip-btn').onclick = () => { HB.flip = !HB.flip; updatePreview(); };

// ---------- stats ----------
function renderStats() {
  const box = $('#stats'); box.innerHTML = '';
  for (const key of STATS) {
    const row = document.createElement('div'); row.className = 'stat-row';
    row.innerHTML = `
      <div class="head"><span>${STAT_LABEL[key]}</span><span class="v">${HB.stats[key]} / 5</span></div>
      <input type="range" min="0" max="5" step="1" value="${HB.stats[key]}" data-stat="${key}" />
      <div class="compare"><span class="lbl">vs classics</span><div class="track"></div></div>
    `;
    const track = row.querySelector('.track');
    for (const cls of ['warrior', 'valkyrie', 'wizard', 'elf']) {
      const mark = document.createElement('div'); mark.className = 'mark';
      mark.style.left = `${(CLASSIC_NOTCHES[cls][key] / 5) * 100}%`;
      mark.style.background = CLASSIC_COLOR[cls];
      mark.title = `${cls}: ${CLASSIC_NOTCHES[cls][key]}`;
      track.appendChild(mark);
    }
    const mine = document.createElement('div'); mine.className = 'mine';
    mine.style.left = `calc(${(HB.stats[key] / 5) * 100}% - 2px)`;
    track.appendChild(mine);
    row.querySelector('input').oninput = (e) => {
      HB.stats[key] = Number(e.target.value);
      renderStats(); refreshBudget();
    };
    box.appendChild(row);
  }
}
function totalNotches() { return STATS.reduce((s, k) => s + HB.stats[k], 0); }
function refreshBudget() {
  const total = totalNotches();
  const bar = $('#budget-bar'); const fill = bar.querySelector('div');
  const pct = HB.budget > 0 ? Math.min(100, (total / HB.budget) * 100) : 0;
  fill.style.width = pct + '%';
  bar.classList.toggle('over', total > HB.budget);
  $('#budget-label').textContent = `${total} / ${HB.budget} notches`;
}

// ---------- weapon + trait pickers ----------
function renderWeapons() {
  const box = $('#weapons'); box.innerHTML = '';
  for (const [id, w] of Object.entries(WEAPONS)) {
    const unlocked = HB.unlockedWeapons.includes(id);
    const b = document.createElement('button');
    b.className = 'pick' + (id === HB.weapon ? ' sel' : '') + (unlocked ? '' : ' locked');
    b.innerHTML = `<canvas width="24" height="24"></canvas><span class="n">${w.name}</span><div class="d">${esc(w.desc)}</div>${unlocked ? '' : `<div class="req">Rank 3+</div>`}`;
    b.querySelector('canvas').getContext('2d').drawImage(sprite(w.sprite), 0, 0, 24, 24);
    b.disabled = !unlocked;
    b.onclick = () => { HB.weapon = id; renderWeapons(); };
    box.appendChild(b);
  }
}
function renderTraits() {
  const box = $('#traits'); box.innerHTML = '';
  for (const [id, t] of Object.entries(TRAITS)) {
    const unlocked = HB.unlockedTraits.includes(id);
    const b = document.createElement('button');
    b.className = 'pick' + (id === HB.trait ? ' sel' : '') + (unlocked ? '' : ' locked');
    b.innerHTML = `<span class="n">${t.name}</span><div class="d">${esc(t.desc)}</div>${unlocked ? '' : `<div class="req">${esc(requirementText(t.requires))}</div>`}`;
    b.disabled = !unlocked;
    b.onclick = () => { HB.trait = HB.trait === id ? null : id; renderTraits(); };
    box.appendChild(b);
  }
}

// ---------- form <-> state ----------
function loadHeroIntoForm(hero) {
  HB.id = hero.id ?? null;
  HB.name = hero.name || ''; HB.title = hero.title || ''; HB.motto = hero.motto || '';
  HB.stats = { ...blankStats(), ...hero.stats };
  HB.weapon = WEAPONS[hero.weapon] ? hero.weapon : 'axe';
  HB.trait = hero.trait || null;
  HB.pixels = Array.isArray(hero.pixels) && hero.pixels.length === 8 ? hero.pixels.slice() : blankPixels();
  $('#hname').value = HB.name; $('#htitle').value = HB.title; $('#hmotto').value = HB.motto;
  $('#save-status').textContent = '';
  drawGrid(); updatePreview(); renderStats(); refreshBudget(); renderWeapons(); renderTraits();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function newHero() { loadHeroIntoForm({ id: null, name: '', title: '', motto: '', stats: blankStats(), weapon: 'axe', trait: null, pixels: blankPixels() }); }
$('#new-btn').onclick = newHero;

$('#hname').oninput = (e) => { HB.name = e.target.value; };
$('#htitle').oninput = (e) => { HB.title = e.target.value; };
$('#hmotto').oninput = (e) => { HB.motto = e.target.value; };

$('#save-btn').onclick = async () => {
  const payload = { id: HB.id, name: HB.name.trim(), title: HB.title.trim(), motto: HB.motto.trim(), stats: HB.stats, weapon: HB.weapon, trait: HB.trait, pixels: HB.pixels };
  try {
    const r = await api('/api/heroes', { method: 'POST', body: payload });
    HB.id = r.id;
    $('#save-status').textContent = 'Saved.';
    toast('Hero saved', payload.name);
    loadMine();
  } catch (e) {
    $('#save-status').textContent = e.message;
    toast('Could not save', e.message, 'err');
  }
};

// ---------- lists ----------
function heroRowHtml(h, opts = {}) {
  return `<div class="h" data-id="${h.id}">
    <canvas class="thumb" width="32" height="32"></canvas>
    <div class="who"><div class="n">${esc(h.title || h.name)}</div>
      <div class="s">${opts.author ? `by ${esc(opts.author)} · ` : ''}${STATS.reduce((s, k) => s + (h.stats[k] || 0), 0)} notches${h.clones != null ? ` · ${h.clones} clones` : ''}${h.published ? ' · <span style="color:var(--green)">published</span>' : ''}</div>
    </div>
    <div class="btns">${opts.buttons || ''}</div>
  </div>`;
}
function paintThumbs(container, heroes) {
  container.querySelectorAll('.h').forEach((el, i) => {
    const h = heroes[i]; const bmp = spriteFromPixels(h.pixels, PALETTE, 4);
    if (bmp) { const cv = el.querySelector('.thumb'); cv.width = bmp.width; cv.height = bmp.height; cv.getContext('2d').drawImage(bmp, 0, 0); }
  });
}

async function loadMine() {
  const box = $('#mine-list');
  let heroes = [];
  try { ({ heroes } = await api('/api/heroes/mine')); } catch { /* not logged in / locked */ }
  $('#mine-count').textContent = `${heroes.length} / 5`;
  box.innerHTML = heroes.length ? heroes.map((h) => heroRowHtml(h, {
    buttons: `<button data-edit="${h.id}">Edit</button><button data-pub="${h.id}">${h.published ? 'Unpublish' : 'Publish'}</button><button class="danger" data-del="${h.id}">Delete</button>`,
  })).join('') : '<span class="muted">No heroes yet — build one!</span>';
  paintThumbs(box, heroes);
  box.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => loadHeroIntoForm(heroes.find((h) => h.id === Number(b.dataset.edit))));
  box.querySelectorAll('[data-pub]').forEach((b) => b.onclick = async () => {
    try { const r = await api(`/api/heroes/${b.dataset.pub}/publish`, { method: 'POST' }); toast(r.published ? 'Published!' : 'Unpublished', r.published ? 'Anyone can see it in the gallery now.' : ''); loadMine(); loadGallery(); }
    catch (e) { toast('Could not publish', e.message, 'err'); }
  });
  box.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this hero for good?')) return;
    try { await api(`/api/heroes/${b.dataset.del}`, { method: 'DELETE' }); toast('Deleted'); if (HB.id === Number(b.dataset.del)) newHero(); loadMine(); }
    catch (e) { toast('Could not delete', e.message, 'err'); }
  });
}

async function loadGallery() {
  const box = $('#gallery-list');
  let heroes = [];
  try { ({ heroes } = await api('/api/heroes/gallery')); } catch { /* ignore */ }
  box.innerHTML = heroes.length ? heroes.map((h) => heroRowHtml(h, { author: h.author, buttons: `<button data-clone="${h.id}">Clone</button>` })).join('') : '<span class="muted">Nothing published yet. Be the first hero designer.</span>';
  paintThumbs(box, heroes);
  box.querySelectorAll('[data-clone]').forEach((b) => b.onclick = async () => {
    const m = await me();
    if (!m.user) { if (!(await authModal())) return; }
    try { const r = await api(`/api/heroes/${b.dataset.clone}/clone`, { method: 'POST' }); toast('Cloned', `${r.hero.name} added to My Heroes.`); loadMine(); loadGallery(); }
    catch (e) { toast('Could not clone', e.message, 'err'); }
  });
}

// ---------- boot ----------
async function boot() {
  const m = await me();
  if (!m.user) {
    $('#guest').hidden = false; $('#locked').hidden = true; $('#builder').hidden = true;
    loadGallery();
    return;
  }
  let budget;
  try { budget = await api('/api/heroes/budget'); }
  catch { budget = { rank: 1, unlocked: false, budget: 0, weapons: [], traits: [] }; }
  HB.rank = budget.rank; HB.budget = budget.budget; HB.unlockedWeapons = budget.weapons; HB.unlockedTraits = budget.traits;

  if (!budget.unlocked) {
    $('#guest').hidden = true; $('#locked').hidden = false; $('#builder').hidden = true;
    $('#locked-rank').textContent = `You are rank ${budget.rank} (${rankTitle(budget.rank)}). Reach rank 3 (${rankTitle(3)}) to unlock it.`;
    loadGallery();
    return;
  }

  $('#guest').hidden = true; $('#locked').hidden = true; $('#builder').hidden = false;
  refreshTools();
  drawGrid(); updatePreview();
  renderWeapons(); renderTraits();
  newHero();
  loadMine(); loadGallery();
}
$('#guest-login').onclick = () => authModal().then((ok) => ok && boot());

boot();
