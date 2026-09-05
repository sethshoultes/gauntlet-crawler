// Level Builder (/editor.html): paint/flood-fill/resize a level, import/export ASCII, validate,
// test-play, save/publish, and the AI-generator prompt UI (falls back to the procedural generator
// without an Anthropic key).
import { api, me, renderNav, authModal, toast, esc } from './common.js';
import { sprite, TILE_SPRITE, GEN_TINT, PLATE_TINT } from './sprites.js';
import { paintPath } from './paint-path.js';
import { T } from '/shared/constants.js';
import { validateLevel, LEGEND } from '/shared/level.js';

const $ = (s) => document.querySelector(s);
renderNav('editor');

const ED = { w: 32, h: 24, grid: [], name: 'My Dungeon', desc: '', id: null, source: 'editor', prompt: '', published: false, brush: T.WALL, painting: false, user: null };
const CELL = 20;
// exposed for manual/E2E debugging only — not used by the editor itself (see client/game.js's window.__gc for the same pattern)
window.__ed = { grid: () => ED.grid.map((r) => r.slice()) };
const cv = $('#ecv'); const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;

const MON_SPRITE = {
  [T.GHOST]: 'ghost', [T.GRUNT]: 'grunt', [T.DEMON]: 'demon', [T.DEATH]: 'death',
  [T.LOBBER]: 'lobber', [T.SORCERER]: 'sorcerer', [T.THIEF]: 'thief',
};
const GEN_TILES = new Set([T.GEN_GRUNT, T.GEN_GHOST, T.GEN_DEMON, T.GEN_LOBBER, T.GEN_SORCERER]);

function blank(w, h) {
  const g = [];
  for (let y = 0; y < h; y++) { const row = []; for (let x = 0; x < w; x++) row.push(x === 0 || y === 0 || x === w - 1 || y === h - 1 ? T.WALL : T.FLOOR); g.push(row); }
  g[2][2] = T.START; g[2][3] = T.START; g[h - 3][w - 3] = T.EXIT;
  return g;
}
function load(level, meta = {}) {
  ED.grid = level.rows.map((r) => r.split(''));
  ED.h = ED.grid.length; ED.w = ED.grid[0].length;
  ED.name = level.name || 'Untitled'; ED.desc = level.description || '';
  ED.id = meta.id ?? null; ED.source = meta.source || 'editor'; ED.prompt = meta.prompt || ''; ED.published = !!meta.published;
  $('#name').value = ED.name; $('#desc').value = ED.desc; $('#w').value = ED.w; $('#h').value = ED.h;
  draw(); refreshMeta();
}
function rows() { return ED.grid.map((r) => r.join('')); }
function current() { return { id: ED.id, name: $('#name').value.trim() || 'Untitled', description: $('#desc').value.trim(), rows: rows(), source: ED.source, prompt: ED.prompt }; }

function draw() {
  cv.width = ED.w * CELL; cv.height = ED.h * CELL;
  ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < ED.h; y++) for (let x = 0; x < ED.w; x++) {
    const c = ED.grid[y][x];
    ctx.drawImage(sprite('floor'), x * CELL, y * CELL, CELL, CELL);
    if (GEN_TILES.has(c)) ctx.drawImage(sprite('gen3', GEN_TINT[c]), x * CELL, y * CELL, CELL, CELL);
    else if (MON_SPRITE[c]) ctx.drawImage(sprite(MON_SPRITE[c]), x * CELL, y * CELL, CELL, CELL);
    else if (c === T.START) { ctx.drawImage(sprite('hero', '#e03c31'), x * CELL, y * CELL, CELL, CELL); }
    else if (PLATE_TINT[c]) ctx.drawImage(sprite(TILE_SPRITE[c], PLATE_TINT[c]), x * CELL, y * CELL, CELL, CELL);
    else if (c !== T.FLOOR) ctx.drawImage(sprite(TILE_SPRITE[c] || 'floor'), x * CELL, y * CELL, CELL, CELL);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  for (let x = 0; x <= ED.w; x++) { ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, ED.h * CELL); ctx.stroke(); }
  for (let y = 0; y <= ED.h; y++) { ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(ED.w * CELL, y * CELL); ctx.stroke(); }
  applyZoom(); // re-apply the displayed zoom size in case the grid was just resized
  validate();
}
function validate() {
  const problems = validateLevel(current());
  const genCount = count(T.GEN_GRUNT) + count(T.GEN_GHOST) + count(T.GEN_DEMON) + count(T.GEN_LOBBER) + count(T.GEN_SORCERER);
  const exitCount = count(T.EXIT) + count(T.EXIT_SKIP);
  $('#status').innerHTML = problems.length ? `<span class="problems">⚠ ${esc(problems[0])}</span>` : `<span class="ok">✓ Playable — ${ED.w}×${ED.h}, ${count(T.START)} starts, ${exitCount} exits, ${genCount} generators, ${count(T.FOOD)} food, ${count(T.TREASURE)} treasure</span>`;
  return problems;
}
function count(c) { let n = 0; for (const r of ED.grid) for (const x of r) if (x === c) n++; return n; }
function refreshMeta() {
  $('#source').innerHTML = ED.source === 'ai' ? '<span class="badge">AI generated</span>' : ED.source === 'procedural' ? '<span class="tag">procedural</span>' : '<span class="tag">hand made</span>';
  $('#publish').textContent = ED.published ? 'Unpublish' : 'Publish';
  $('#publish').disabled = !ED.id; $('#delete').disabled = !ED.id;
}

// palette
const pal = $('#pal');
for (const [c, label] of LEGEND) {
  const b = document.createElement('button'); b.dataset.c = c; b.title = label;
  const cc = document.createElement('canvas'); cc.width = 16; cc.height = 16; cc.className = 'pixel';
  const g = cc.getContext('2d');
  if (GEN_TILES.has(c)) g.drawImage(sprite('gen3', GEN_TINT[c]), 0, 0);
  else if (MON_SPRITE[c]) g.drawImage(sprite(MON_SPRITE[c]), 0, 0);
  else if (c === T.START) g.drawImage(sprite('hero', '#e03c31'), 0, 0);
  else if (PLATE_TINT[c]) g.drawImage(sprite(TILE_SPRITE[c], PLATE_TINT[c]), 0, 0);
  else g.drawImage(sprite(TILE_SPRITE[c] || 'floor'), 0, 0);
  b.appendChild(cc); b.appendChild(document.createTextNode(label.split(' (')[0]));
  b.onclick = () => { ED.brush = c; pal.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); };
  if (c === ED.brush) b.classList.add('on');
  pal.appendChild(b);
}

// painting
function cellAt(ev) {
  const r = cv.getBoundingClientRect();
  const x = Math.floor((ev.clientX - r.left) / r.width * ED.w), y = Math.floor((ev.clientY - r.top) / r.height * ED.h);
  return x >= 0 && y >= 0 && x < ED.w && y < ED.h ? [x, y] : null;
}
function paintCell(x, y, c) { if (x >= 0 && y >= 0 && x < ED.w && y < ED.h) ED.grid[y][x] = c; }
function floodFill(x, y, c) {
  const from = ED.grid[y][x]; if (from === c) return;
  const q = [[x, y]]; const seen = new Set();
  while (q.length) {
    const [cx, cy] = q.pop(); const k = cx + ',' + cy;
    if (seen.has(k) || cx < 0 || cy < 0 || cx >= ED.w || cy >= ED.h || ED.grid[cy][cx] !== from) continue;
    seen.add(k); ED.grid[cy][cx] = c;
    q.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
}
ED.lastCell = null; // last painted cell, for paintPath() drag interpolation below
function paint(ev, isDrag) {
  const cell = cellAt(ev); if (!cell) { ED.lastCell = null; return; }
  const [x, y] = cell;
  const c = ev.buttons === 2 ? T.FLOOR : ED.brush;
  if (ev.shiftKey) { floodFill(x, y, c); ED.lastCell = cell; draw(); return; } // flood only ever applies to the exact cell under the pointer, never the interpolated path
  // A fast drag (especially touch) can report pointermove events several cells apart; paint every
  // cell along the straight line from the last one so the stroke has no gaps.
  const cells = isDrag && ED.lastCell ? paintPath(ED.lastCell, cell) : [cell];
  for (const [cx, cy] of cells) paintCell(cx, cy, c);
  ED.lastCell = cell;
  draw();
}
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  ED.painting = true; ED.lastCell = null;
  cv.setPointerCapture(e.pointerId); // keeps pointermove targeting #ecv even if the drag leaves its bounds
  paint(e, false);
});
cv.addEventListener('pointermove', (e) => { if (ED.painting) paint(e, true); });
window.addEventListener('pointerup', (e) => {
  ED.painting = false; ED.lastCell = null;
  try { cv.releasePointerCapture(e.pointerId); } catch { /* not captured / already released */ }
});

// zoom (#32): the grid otherwise shrinks to fit the panel (max-width:100%), which is unusably
// small on a phone for anything but the smallest levels. Zooming changes only the canvas's
// *displayed* CSS size — the pixel buffer (and so the coordinate math in cellAt() above, which
// works off getBoundingClientRect()) is untouched — and #ecv-wrap scrolls (not the page) once the
// zoomed size exceeds the panel.
let zoom = 1;
function applyZoom() {
  if (zoom === 1) { cv.style.width = ''; cv.style.maxWidth = ''; }
  else { cv.style.width = `${ED.w * CELL * zoom}px`; cv.style.maxWidth = 'none'; }
  $('#zoom-val').textContent = `${Math.round(zoom * 100)}%`;
}
$('#zoom-in').onclick = () => { zoom = Math.min(3, zoom + 0.25); applyZoom(); };
$('#zoom-out').onclick = () => { zoom = Math.max(0.5, zoom - 0.25); applyZoom(); };

// controls
$('#name').oninput = validate; $('#desc').oninput = validate;
$('#resize').onclick = () => {
  const w = Math.max(12, Math.min(64, Number($('#w').value) || 32)), h = Math.max(12, Math.min(64, Number($('#h').value) || 24));
  const g = blank(w, h);
  for (let y = 0; y < Math.min(h, ED.h); y++) for (let x = 0; x < Math.min(w, ED.w); x++) if (x < w - 1 && y < h - 1) g[y][x] = ED.grid[y][x];
  for (let x = 0; x < w; x++) { g[0][x] = T.WALL; g[h - 1][x] = T.WALL; } for (let y = 0; y < h; y++) { g[y][0] = T.WALL; g[y][w - 1] = T.WALL; }
  ED.grid = g; ED.w = w; ED.h = h; draw();
};
$('#new').onclick = () => { load({ name: 'My Dungeon', description: '', rows: blank(32, 24).map((r) => r.join('')) }); };
$('#clear').onclick = () => { ED.grid = blank(ED.w, ED.h); draw(); };
$('#export').onclick = () => {
  const io = $('#io'); io.style.display = io.style.display === 'none' ? '' : 'none';
  io.value = rows().join('\n');
  io.onchange = () => {
    const lines = io.value.split('\n').map((l) => l.trimEnd()).filter(Boolean);
    const probs = validateLevel({ name: 'x', rows: lines });
    if (probs.length && !/reachable|border/.test(probs[0])) return toast('Import failed', probs[0], 'err');
    ED.grid = lines.map((l) => l.split('')); ED.h = ED.grid.length; ED.w = ED.grid[0].length; $('#w').value = ED.w; $('#h').value = ED.h; draw();
  };
};
$('#diff').oninput = () => { $('#diffv').textContent = $('#diff').value; };

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Generation runs as a background job on the server (server/ai/jobs.js) so the request doesn't
// sit open for the ~100s Claude can take -- Cloudflare in front of production kills any proxied
// request past 100s. We poll the job endpoint every 2s, showing a running counter, for up to 4
// minutes before giving up.
async function pollJob(jobId, onTick) {
  const deadline = Date.now() + 4 * 60_000;
  const started = Date.now();
  while (Date.now() < deadline) {
    await sleep(2000);
    onTick(Math.round((Date.now() - started) / 1000));
    const r = await api(`/api/levels/generate/${jobId}`);
    if (r.status === 'done') return r;
    if (r.status === 'error') throw new Error(r.error || 'Generation failed');
    // else 'pending' -- keep polling
  }
  throw new Error('Timed out waiting for the AI to finish');
}

$('#gen').onclick = async () => {
  const btn = $('#gen'); btn.disabled = true; btn.textContent = 'Summoning…';
  $('#ai-note').textContent = 'The AI is drawing your dungeon. This usually takes a minute or two and can run up to four…';
  try {
    const started = await api('/api/levels/generate', { method: 'POST', body: { prompt: $('#prompt').value, difficulty: Number($('#diff').value), size: $('#size').value } });
    let r;
    if (started.level) {
      // Legacy synchronous shape, in case an old server (pre-async) answers this request.
      r = started;
    } else {
      r = await pollJob(started.jobId, (secs) => { $('#ai-note').textContent = `Summoning… ${secs}s`; });
    }
    load(r.level, { source: r.source, prompt: $('#prompt').value });
    $('#ai-note').textContent = r.note || (r.source === 'ai' ? 'Generated by Claude.' : '');
    for (const a of r.unlocked || []) toast(`${a.icon} Achievement: ${a.name}`, a.desc);
    toast(r.source === 'ai' ? 'AI level ready' : 'Procedural level ready', r.level.name);
  } catch (e) { toast('Generation failed', e.message, 'err'); }
  btn.disabled = false; btn.textContent = 'Generate with AI';
};
$('#procgen').onclick = async () => {
  const r = await api('/api/levels/procgen', { method: 'POST', body: { seed: $('#seed').value || Math.random().toString(36).slice(2, 6), level: Number($('#plevel').value) } });
  load(r.level, { source: 'procedural' });
};

async function requireLogin() {
  if (ED.user) return true;
  const ok = await authModal(); if (!ok) return false;
  ED.user = (await me(true)).user; renderNav('editor'); loadMine(); return true;
}
$('#save').onclick = async () => {
  const problems = validate(); if (problems.length) return toast('Fix the level first', problems[0], 'err');
  if (!(await requireLogin())) return;
  try {
    const r = await api('/api/levels', { method: 'POST', body: current() });
    ED.id = r.id; refreshMeta(); location.hash = 'edit=' + r.id; toast('Saved', $('#name').value); loadMine();
  } catch (e) { toast('Save failed', e.message, 'err'); }
};
$('#publish').onclick = async () => {
  if (!ED.id) return;
  try { const r = await api(`/api/levels/${ED.id}/publish`, { method: 'POST' }); ED.published = r.published; refreshMeta(); toast(r.published ? 'Published!' : 'Unpublished', r.published ? 'Anyone can play it now.' : ''); for (const a of r.unlocked || []) toast(`${a.icon} Achievement: ${a.name}`, a.desc); loadMine(); loadPublished(); }
  catch (e) { toast('Failed', e.message, 'err'); }
};
$('#delete').onclick = async () => {
  if (!ED.id || !confirm('Delete this level for good?')) return;
  try { await api(`/api/levels/${ED.id}`, { method: 'DELETE' }); toast('Deleted'); $('#new').click(); loadMine(); loadPublished(); } catch (e) { toast('Failed', e.message, 'err'); }
};
$('#test').onclick = async () => {
  const problems = validate(); if (problems.length) return toast('Fix the level first', problems[0], 'err');
  try {
    const { room } = await api('/api/rooms', { method: 'POST', body: { name: 'Test: ' + $('#name').value, public: false, level: current(), levelId: ED.id } });
    location.href = `/?room=${room.id}`;
  } catch (e) { toast('Could not start test', e.message, 'err'); }
};

async function loadMine() {
  const box = $('#mine');
  if (!ED.user) { box.innerHTML = '<span class="muted">Log in to save levels.</span>'; return; }
  const { levels } = await api('/api/levels/mine').catch(() => ({ levels: [] }));
  box.innerHTML = levels.length ? levels.map((l) => `<div class="l"><div><b>${esc(l.name)}</b> <span class="tag">${l.source}</span> ${l.published ? '<span class="tag" style="color:var(--green)">published</span>' : ''}<br><span class="muted" style="font-size:11px">${l.plays} plays</span></div><button data-edit="${l.id}">Edit</button></div>`).join('') : '<span class="muted">No levels yet.</span>';
  box.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openLevel(b.dataset.edit));
}
async function loadPublished() {
  const { levels } = await api('/api/levels').catch(() => ({ levels: [] }));
  const box = $('#pub');
  box.innerHTML = levels.length ? levels.map((l) => `<div class="l"><div><b>${esc(l.name)}</b> <span class="tag">${l.source}</span><br><span class="muted" style="font-size:11px">by ${esc(l.author)} · ${l.plays} plays · ${esc(l.description || '')}</span></div><span class="row"><button data-open="${l.id}">View</button><button class="primary" data-play="${l.id}">Play</button></span></div>`).join('') : '<span class="muted">Nothing published yet. Be the first architect.</span>';
  box.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => openLevel(b.dataset.open, true));
  box.querySelectorAll('[data-play]').forEach((b) => b.onclick = async () => {
    const { room } = await api(`/api/levels/${b.dataset.play}/play`, { method: 'POST', body: {} });
    location.href = `/?room=${room.id}`;
  });
}
async function openLevel(id, readOnly = false) {
  try {
    const { level } = await api(`/api/levels/${id}`);
    const mine = ED.user && level.owner_id === ED.user.id;
    load(level, { id: mine ? level.id : null, source: level.source, prompt: level.prompt, published: level.published });
    if (!mine) { ED.id = null; refreshMeta(); toast('Opened a copy', `Save to keep your own version of "${level.name}"`); }
    location.hash = mine ? 'edit=' + id : '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) { toast('Could not open level', e.message, 'err'); }
}


// ============================================================================================
// #17 AI assist: remix / harden / soften the level currently on the canvas, and explain it.
// Kept in its own section at the end of the file to stay out of the way of concurrent edits
// to the palette/buttons above.
// ============================================================================================
let aiAvailableFlag = true; // set from GET /api/ai/status in the IIFE above; only affects button labels
let remixUndo = null;       // one-level undo snapshot: {grid, w, h, name, desc, source}

const REMIX_BTN_IDS = ['remix', 'harder', 'easier', 'explain'];
const REMIX_BTN_BASE_TITLE = Object.fromEntries(REMIX_BTN_IDS.map((id) => [id, $('#' + id).title]));

/** Guests can't call the AI-assist endpoints (they're logged-in only server-side), so disable the
 *  buttons with an explanatory tooltip rather than letting them click through to a 401. Once we
 *  know whether the server has an AI key, append a note so a signed-in user isn't surprised that
 *  "Remix" quietly gave them a procedural variation instead of a Claude one. */
function refreshRemixButtons() {
  const guest = !ED.user;
  for (const id of REMIX_BTN_IDS) {
    const b = $('#' + id);
    b.disabled = guest;
    b.title = guest
      ? 'Log in to use AI level assist'
      : aiAvailableFlag ? REMIX_BTN_BASE_TITLE[id]
      : `${REMIX_BTN_BASE_TITLE[id]} (no AI key configured on this server — uses the procedural generator instead of Claude)`;
  }
}

function snapshotRemixUndo() {
  remixUndo = { grid: ED.grid.map((r) => r.slice()), w: ED.w, h: ED.h, name: ED.name, desc: ED.desc, source: ED.source };
  $('#undoRemix').style.display = '';
}
$('#undoRemix').onclick = () => {
  if (!remixUndo) return;
  ED.grid = remixUndo.grid; ED.w = remixUndo.w; ED.h = remixUndo.h; ED.name = remixUndo.name; ED.desc = remixUndo.desc; ED.source = remixUndo.source;
  $('#name').value = ED.name; $('#desc').value = ED.desc; $('#w').value = ED.w; $('#h').value = ED.h;
  draw(); refreshMeta();
  remixUndo = null; $('#undoRemix').style.display = 'none';
  $('#remix-note').textContent = 'Reverted to the level before the last remix/tune.';
};

async function runRemix(mode, btn) {
  if (!(await requireLogin())) return;
  refreshRemixButtons();
  const problems = validate(); if (problems.length) return toast('Fix the level first', problems[0], 'err');
  const label = btn.textContent; btn.disabled = true; btn.textContent = 'Thinking…';
  try {
    const r = await api('/api/levels/ai/remix', { method: 'POST', body: { level: current(), mode } });
    snapshotRemixUndo();
    load(r.level, { id: ED.id, source: r.source, prompt: ED.prompt, published: ED.published });
    $('#remix-note').textContent = r.source === 'ai' ? `Remixed by Claude (${mode}).` : `Procedural ${mode} applied (AI unavailable or declined the request).`;
    toast(r.source === 'ai' ? 'Level remixed' : 'Procedural variation ready', r.level.name);
  } catch (e) { toast('Could not remix level', e.message, 'err'); }
  btn.disabled = false; btn.textContent = label;
}
$('#remix').onclick = () => runRemix('remix', $('#remix'));
$('#harder').onclick = () => runRemix('harder', $('#harder'));
$('#easier').onclick = () => runRemix('easier', $('#easier'));

$('#explain').onclick = async () => {
  if (!(await requireLogin())) return;
  refreshRemixButtons();
  const problems = validate(); if (problems.length) return toast('Fix the level first', problems[0], 'err');
  const btn = $('#explain'); const label = btn.textContent; btn.disabled = true; btn.textContent = 'Thinking…';
  try {
    const r = await api('/api/levels/ai/explain', { method: 'POST', body: { level: current() } });
    const panel = $('#explain-panel'); panel.textContent = r.explanation; panel.style.display = '';
  } catch (e) { toast('Could not explain level', e.message, 'err'); }
  btn.disabled = false; btn.textContent = label;
};

// Boot. Lives at the very end of the module so every `let`/`const` above (including the #17
// remix state) is initialised before any of this runs -- no reliance on the awaits to dodge the
// temporal dead zone.
(async () => {
  ED.user = (await me()).user;
  load({ name: 'My Dungeon', description: '', rows: blank(32, 24).map((r) => r.join('')) });
  loadMine(); loadPublished();
  refreshRemixButtons();
  const m = location.hash.match(/edit=(\d+)/); if (m) openLevel(m[1]);
  if (location.hash === '#browse') $('#browse').scrollIntoView();
  const st = await api('/api/ai/status').catch(() => ({ available: false }));
  if (!st.available) $('#ai-note').textContent = 'No AI key configured on this server: "Generate" will use the procedural generator, steered by your prompt.';
  aiAvailableFlag = !!st.available;
  refreshRemixButtons();
})();
