import { api, me, token, toast, renderNav, esc, authModal, NAME_KEY, CLASS_KEY } from './common.js';
import { sprite, TILE, TILE_SPRITE, SHOT_SPRITE, GEN_TINT } from './sprites.js';
import { CLASSES, CLASS_IDS, LOW_HEALTH, DIRS } from '/shared/constants.js';

const $ = (s) => document.querySelector(s);
const SCALE = 2;                 // 8px art -> 16px tiles
const ZOOM = 2;                  // 16px tiles -> 32px on the 640x480 canvas => 20x15 tiles visible
const VIEW_W = 640, VIEW_H = 480;

// ---------------- lobby ----------------
let selectedClass = localStorage.getItem(CLASS_KEY) || 'warrior';
const heroes = $('#heroes');
for (const id of CLASS_IDS) {
  const c = CLASSES[id];
  const el = document.createElement('div');
  el.className = 'hero' + (id === selectedClass ? ' sel' : '');
  el.innerHTML = `<canvas width="16" height="16" class="pixel"></canvas><div class="n cls-${id}">${c.name}</div><div class="s">${c.hero}</div>
    <div class="s">Speed ${'★'.repeat(Math.round((c.speed - 4) * 1.5))}<br>Shot ${'★'.repeat(c.shotDamage)}<br>Armor ${'★'.repeat(Math.round((1.1 - c.armor) * 10))}<br>Magic ${'★'.repeat(Math.round(c.magic))}</div>`;
  el.querySelector('canvas').getContext('2d').drawImage(sprite('hero', c.color), 0, 0);
  el.onclick = () => { selectedClass = id; localStorage.setItem(CLASS_KEY, id); document.querySelectorAll('.hero').forEach((h) => h.classList.remove('sel')); el.classList.add('sel'); };
  heroes.appendChild(el);
}
$('#gname').value = localStorage.getItem(NAME_KEY) || '';
$('#gname').oninput = () => localStorage.setItem(NAME_KEY, $('#gname').value);

async function loadRooms() {
  const { rooms } = await api('/api/rooms').catch(() => ({ rooms: [] }));
  const box = $('#rooms');
  if (!rooms.length) { box.innerHTML = '<span class="muted">No open dungeons. Start one!</span>'; return; }
  box.innerHTML = rooms.map((r) => `<div class="r"><div><b>${esc(r.name)}</b> <span class="tag">${r.source === 'custom' ? 'custom: ' + esc(r.customName || '') : 'campaign'}</span><br>
    <span class="muted" style="font-size:12px">Level ${r.level} · ${esc(r.levelName)} · ${r.roster.map((p) => `<span class="cls-${p.cls}">${esc(p.name)}</span>`).join(', ') || 'empty'}</span></div>
    <button data-join="${r.id}" ${r.players >= r.max ? 'disabled' : ''}>${r.players}/${r.max} Join</button></div>`).join('');
  box.querySelectorAll('[data-join]').forEach((b) => b.onclick = () => joinGame({ roomId: b.dataset.join }));
}
$('#refresh').onclick = loadRooms;
$('#quick').onclick = () => joinGame({});
$('#create').onclick = () => joinGame({ create: true, roomName: $('#roomname').value, public: !$('#private').checked });

renderNav('play').then(async () => {
  const m = await me();
  if (m.user) { $('#gname').value = m.user.username; $('#gname').disabled = true; $('#gname-note').textContent = '(your account name)'; }
  else $('#gname-note').innerHTML = 'Guests keep no stats. <a href="#" id="loginlink">Log in</a> to earn achievements.';
  $('#loginlink')?.addEventListener('click', (e) => { e.preventDefault(); authModal().then((ok) => ok && location.reload()); });
});
loadRooms();
setInterval(() => { if (!G.ws) loadRooms(); }, 5000);

// ---------------- game state ----------------
const G = {
  ws: null, pid: null, room: null, level: null, grid: null, players: new Map(), // id -> {name, cls}
  prev: null, cur: null, prevAt: 0, curAt: 0, tiles: {}, fx: [], notices: [],
  input: { dx: 0, dy: 0, fire: false }, lastSent: '', camX: 0, camY: 0, overlay: null, muted: localStorage.getItem('gc_mute') === '1', narrate: localStorage.getItem('gc_narrate') !== '0',
  followId: null, lastFood: 0, shake: 0,
};

function joinGame(opts) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  G.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'join', token: token(), name: $('#gname').value.trim() || 'Guest', cls: selectedClass, ...opts }));
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onclose = () => { if (G.ws === ws) { leaveGame('Disconnected from server'); } };
  ws.onerror = () => toast('Connection error', 'Could not reach the game server', 'err');
}

function leaveGame(reason) {
  if (G.ws) { try { G.ws.close(); } catch {} }
  G.ws = null; G.level = null; G.cur = G.prev = null; G.players.clear(); G.overlay = null;
  $('#game').classList.remove('on'); $('#lobby').style.display = ''; $('#touch').classList.remove('on');
  if (reason) toast('Left the dungeon', reason);
  loadRooms();
  history.replaceState(null, '', '/');
}
$('#leave').onclick = () => leaveGame();

function onMessage(m) {
  switch (m.t) {
    case 'welcome':
      G.pid = m.pid; G.room = m.room;
      $('#lobby').style.display = 'none'; $('#game').classList.add('on'); $('#touch').classList.add('on');
      $('#log').innerHTML = '';
      log(`<span class="n">Welcome to ${esc(m.room.name)}. ${m.room.source === 'custom' ? 'Custom dungeon: ' + esc(m.room.customName || '') : ''}</span>`);
      history.replaceState(null, '', `/?room=${m.room.id}`);
      say('Welcome, ' + CLASSES[selectedClass].name);
      break;
    case 'level':
      G.level = m; G.grid = m.rows.map((r) => r.split(''));
      G.prev = G.cur = null; G.fx = [];
      G.overlay = { kind: 'level', title: `LEVEL ${m.index}`, sub: m.name, until: performance.now() + 2500 };
      log(`<span class="n">Level ${m.index}: ${esc(m.name)}</span> <span class="muted">${esc(m.description || '')}</span>`);
      if (m.index > 1) say(`Let's see how you do in level ${m.index}`);
      sfx('level');
      break;
    case 'players':
      G.players = new Map(m.list.map((p) => [p.id, p]));
      renderHud();
      break;
    case 's':
      G.prev = G.cur; G.prevAt = G.curAt; G.cur = m; G.curAt = performance.now();
      if (m.e) for (const e of m.e) onEvent(e);
      break;
    case 'notice': log(`<span class="n">${esc(m.text)}</span>`); break;
    case 'chat': log(`<span class="c"><b>${esc(m.from)}:</b> ${esc(m.text)}</span>`); break;
    case 'ach': toast(`${m.ach.icon} Achievement: ${m.ach.name}`, m.ach.desc); sfx('ach'); break;
    case 'levelclear':
      G.overlay = { kind: 'clear', title: 'LEVEL CLEARED', sub: `${m.by} found the exit in ${m.time}s`, until: performance.now() + 2500 };
      sfx('clear'); break;
    case 'error': toast('Error', m.error, 'err'); if (!G.level) leaveGame(); break;
    case 'kicked': leaveGame(m.reason); break;
    case 'left': leaveGame(); break;
  }
}

function onEvent(e) {
  const mine = e.pid === G.pid;
  const name = G.players.get(e.pid)?.name || '';
  const cls = G.players.get(e.pid)?.cls;
  switch (e.type) {
    case 'tile': if (G.grid) G.grid[e.y][e.x] = e.c; if (e.c === '.') G.fx.push({ kind: 'puff', x: e.x + 0.5, y: e.y + 0.5, t: 0 }); break;
    case 'kill': G.fx.push({ kind: 'die', x: e.x, y: e.y, t: 0, m: e.monster }); if (mine) sfx('kill'); break;
    case 'generator': G.fx.push({ kind: 'boom', x: e.x + 0.5, y: e.y + 0.5, t: 0 }); sfx('boom'); if (mine) G.shake = 0.3; break;
    case 'pickup': if (mine) { sfx(e.item === 'T' ? 'coin' : e.item === 'K' ? 'key' : e.item === 'F' ? 'eat' : 'pick'); } break;
    case 'food': if (mine && e.lowHealth) say(`${CLASSES[cls]?.name} was about to die… saved by food`); break;
    case 'food_shot': log(`<span class="n">${esc(name)} shot the food!</span>`); if (mine) { say("Don't shoot the food!"); sfx('bad'); } break;
    case 'door': sfx('door'); break;
    case 'secret': log(`<span class="n">${esc(name)} found a secret wall</span>`); sfx('door'); break;
    case 'potion': G.fx.push({ kind: 'magic', x: e.x, y: e.y, r: e.radius, t: 0 }); sfx('magic'); G.shake = 0.4; break;
    case 'death': log(`<span class="n">${esc(name)} the ${cls} has died</span>`); if (mine) { sfx('death'); say(`${CLASSES[cls]?.name} has died. Insert coin to continue.`); } break;
    case 'coin': if (mine) sfx('coin'); break;
    case 'exit': break;
    case 'sound':
      if (!mine && Math.random() < 0.7) break;
      if (e.name.startsWith('shoot_')) sfx('shoot'); else if (e.name === 'hit') sfx('hit'); else if (e.name === 'fireball') sfx('fireball'); else if (e.name === 'spawn') sfx('spawn'); else if (e.name === 'ghost_hit') sfx('hit');
      break;
  }
}

function log(html) {
  const el = $('#log'); const d = document.createElement('div'); d.innerHTML = html; el.appendChild(d);
  while (el.children.length > 60) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}

// ---------------- input ----------------
const keys = new Set();
const chat = $('#chat');
window.addEventListener('keydown', (e) => {
  if (!G.ws) return;
  if (document.activeElement === chat) {
    if (e.key === 'Enter') { if (chat.value.trim()) G.ws.send(JSON.stringify({ t: 'chat', text: chat.value.trim() })); chat.value = ''; chat.blur(); }
    if (e.key === 'Escape') { chat.value = ''; chat.blur(); }
    return;
  }
  if (e.key === 't' || e.key === 'T') { e.preventDefault(); chat.focus(); return; }
  if (e.key === 'm' || e.key === 'M') { G.muted = !G.muted; localStorage.setItem('gc_mute', G.muted ? '1' : '0'); toast(G.muted ? 'Sound off' : 'Sound on'); return; }
  if (e.key === 'n' || e.key === 'N') { G.narrate = !G.narrate; localStorage.setItem('gc_narrate', G.narrate ? '1' : '0'); toast(G.narrate ? 'Narrator on' : 'Narrator off'); return; }
  if (e.key === 'q' || e.key === 'Q' || e.key === 'Shift') { sendInput({ potion: true }); e.preventDefault(); return; }
  if (e.key === 'Enter') { sendInput({ respawn: true }); return; }
  if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
  keys.add(e.key.toLowerCase());
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());
const touchHeld = { up: false, down: false, left: false, right: false, fire: false };
(function buildDpad() {
  const pad = $('#dpad');
  const cells = [['', ''], ['up', '▲'], ['', ''], ['left', '◀'], ['', ''], ['right', '▶'], ['', ''], ['down', '▼'], ['', '']];
  for (const [act, label] of cells) {
    const b = document.createElement('button'); b.textContent = label; if (!act) b.style.visibility = 'hidden';
    const on = (v) => (ev) => { ev.preventDefault(); touchHeld[act] = v; };
    b.addEventListener('touchstart', on(true)); b.addEventListener('touchend', on(false)); b.addEventListener('touchcancel', on(false));
    pad.appendChild(b);
  }
  document.querySelectorAll('#touch [data-act]').forEach((b) => {
    const act = b.dataset.act;
    if (act === 'potion') b.addEventListener('touchstart', (ev) => { ev.preventDefault(); sendInput({ potion: true }); });
    else { b.addEventListener('touchstart', (ev) => { ev.preventDefault(); touchHeld.fire = true; }); b.addEventListener('touchend', (ev) => { ev.preventDefault(); touchHeld.fire = false; }); }
  });
})();
function sendInput(extra = {}) {
  if (!G.ws || G.ws.readyState !== 1) return;
  const dx = (keys.has('d') || keys.has('arrowright') || touchHeld.right ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') || touchHeld.left ? 1 : 0);
  const dy = (keys.has('s') || keys.has('arrowdown') || touchHeld.down ? 1 : 0) - (keys.has('w') || keys.has('arrowup') || touchHeld.up ? 1 : 0);
  const fire = keys.has(' ') || keys.has('control') || touchHeld.fire;
  const msg = { t: 'input', dx, dy, fire, ...extra };
  const s = JSON.stringify(msg);
  if (s !== G.lastSent || extra.potion || extra.respawn) { G.ws.send(s); G.lastSent = JSON.stringify({ t: 'input', dx, dy, fire }); }
}
setInterval(() => sendInput(), 50);

// ---------------- rendering ----------------
const cv = $('#cv'); const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;
const TS = TILE * ZOOM; // 32 screen px per tile

function lerpSnap(now) {
  if (!G.cur) return null;
  if (!G.prev) return { p: G.cur.p, m: G.cur.m, b: G.cur.b, g: G.cur.g };
  const span = Math.max(1, G.curAt - G.prevAt);
  const t = Math.min(1.2, Math.max(0, (now - G.curAt) / span)); // extrapolate slightly past the latest snapshot
  const lerpList = (prevL, curL, idIdx, xi, yi) => {
    const pm = new Map(prevL.map((e) => [e[idIdx], e]));
    return curL.map((e) => {
      const pe = pm.get(e[idIdx]);
      if (!pe) return e;
      const out = e.slice(); out[xi] = pe[xi] + (e[xi] - pe[xi]) * Math.min(1, t) ; out[yi] = pe[yi] + (e[yi] - pe[yi]) * Math.min(1, t);
      return out;
    });
  };
  return { p: lerpList(G.prev.p, G.cur.p, 0, 1, 2), m: lerpList(G.prev.m, G.cur.m, 0, 2, 3), b: lerpList(G.prev.b, G.cur.b, 0, 1, 2), g: G.cur.g };
}

let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  if (!G.level || !G.grid) return;
  const snap = lerpSnap(now);
  if (!snap) return;
  // camera: follow me, or the first living player if I'm not there
  let meP = snap.p.find((p) => p[0] === G.pid);
  if (!meP || meP[8]) { const alive = snap.p.find((p) => !p[8]); if (alive && !meP) meP = alive; }
  if (meP) {
    const tx = meP[1] * TS - VIEW_W / 2, ty = meP[2] * TS - VIEW_H / 2;
    const maxX = G.level.w * TS - VIEW_W, maxY = G.level.h * TS - VIEW_H;
    const cx = Math.max(0, Math.min(maxX, tx)), cy = Math.max(0, Math.min(maxY, ty));
    G.camX += (cx - G.camX) * Math.min(1, dt * 10); G.camY += (cy - G.camY) * Math.min(1, dt * 10);
    if (maxX < 0) G.camX = maxX / 2; if (maxY < 0) G.camY = maxY / 2;
  }
  if (G.shake > 0) { G.shake -= dt; }
  const sx = Math.round(G.camX + (G.shake > 0 ? (Math.random() - 0.5) * 6 : 0)), sy = Math.round(G.camY + (G.shake > 0 ? (Math.random() - 0.5) * 6 : 0));
  ctx.save(); ctx.translate(-sx, -sy);
  // tiles
  const x0 = Math.max(0, Math.floor(sx / TS)), y0 = Math.max(0, Math.floor(sy / TS));
  const x1 = Math.min(G.level.w - 1, Math.ceil((sx + VIEW_W) / TS)), y1 = Math.min(G.level.h - 1, Math.ceil((sy + VIEW_H) / TS));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const c = G.grid[y][x];
    let name = TILE_SPRITE[c];
    if (!name) name = 'floor';
    if (name !== 'wall' && name !== 'floor' && name !== 'trap') ctx.drawImage(sprite('floor'), x * TS, y * TS, TS, TS);
    if (c === 'g' || c === 'h' || c === 'm') {
      const g = snap.g.find((gg) => gg[0] === x && gg[1] === y);
      const hp = g ? g[2] : 3;
      ctx.drawImage(sprite('gen' + Math.max(1, Math.min(3, hp)), GEN_TINT[c]), x * TS, y * TS, TS, TS);
      continue;
    }
    ctx.drawImage(sprite(name), x * TS, y * TS, TS, TS);
  }
  // exits glow
  // shots
  for (const b of snap.b) {
    const name = SHOT_SPRITE[b[4]] || 'fireball';
    const px = b[1] * TS, py = b[2] * TS;
    ctx.save(); ctx.translate(px, py);
    if (name === 'axe') ctx.rotate(now / 60); else ctx.rotate((b[3] - 2) * Math.PI / 4);
    ctx.drawImage(sprite(name), -TS / 2, -TS / 2, TS, TS);
    ctx.restore();
  }
  // monsters
  const MNAME = { g: 'ghost', r: 'grunt', d: 'demon', e: 'death' };
  for (const m of snap.m) {
    const name = MNAME[m[1]] || 'ghost';
    const bob = name === 'ghost' ? Math.sin(now / 150 + m[0]) * 2 : (Math.floor(now / 200 + m[0]) % 2) * 1;
    drawEntity(sprite(name), m[2], m[3], m[4], bob);
  }
  // players
  for (const p of snap.p) {
    const info = G.players.get(p[0]); const cls = CLASSES[info?.cls || 'warrior'];
    if (p[8]) { ctx.globalAlpha = 0.35; }
    const bob = (Math.floor(now / 120) % 2) * 1;
    drawEntity(sprite('hero', cls.color), p[1], p[2], p[3], p[8] ? 0 : bob, true);
    ctx.globalAlpha = 1;
    // name tag
    ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = cls.color;
    ctx.fillText((info?.name || '').toUpperCase(), p[1] * TS, p[2] * TS - TS / 2 - 3);
  }
  // fx
  for (const f of G.fx) {
    f.t += dt;
    const px = f.x * TS, py = f.y * TS;
    if (f.kind === 'magic') {
      const r = Math.min(f.r, f.t * 20) * TS; ctx.strokeStyle = `rgba(92,214,255,${Math.max(0, 1 - f.t * 1.5)})`; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.stroke();
    } else if (f.kind === 'boom' || f.kind === 'die' || f.kind === 'puff') {
      const n = f.kind === 'boom' ? 10 : 6; const col = f.kind === 'boom' ? '#ff8c1a' : f.kind === 'die' ? '#f4f4f4' : '#9a9aa8';
      ctx.fillStyle = col; ctx.globalAlpha = Math.max(0, 1 - f.t * 2);
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; const d = f.t * 60 * (f.kind === 'boom' ? 1.6 : 1); ctx.fillRect(px + Math.cos(a) * d - 2, py + Math.sin(a) * d - 2, 4, 4); }
      ctx.globalAlpha = 1;
    }
  }
  G.fx = G.fx.filter((f) => f.t < 0.7);
  ctx.restore();
  // overlays
  if (G.overlay) {
    if (now > G.overlay.until) G.overlay = null;
    else {
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, VIEW_H / 2 - 50, VIEW_W, 100);
      ctx.fillStyle = '#f2c400'; ctx.font = 'bold 28px monospace'; ctx.textAlign = 'center'; ctx.fillText(G.overlay.title, VIEW_W / 2, VIEW_H / 2 - 8);
      ctx.fillStyle = '#e8e6d8'; ctx.font = '14px monospace'; ctx.fillText(G.overlay.sub, VIEW_W / 2, VIEW_H / 2 + 22);
    }
  }
  const mine = G.cur.p.find((p) => p[0] === G.pid);
  if (mine && mine[8]) {
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(0, VIEW_H - 90, VIEW_W, 90);
    ctx.fillStyle = '#e03c31'; ctx.font = 'bold 26px monospace'; ctx.textAlign = 'center'; ctx.fillText('YOU HAVE DIED', VIEW_W / 2, VIEW_H - 52);
    if (Math.floor(now / 500) % 2) { ctx.fillStyle = '#f2c400'; ctx.font = '14px monospace'; ctx.fillText('INSERT COIN — press ENTER to continue', VIEW_W / 2, VIEW_H - 24); }
  } else if (mine && mine[4] < LOW_HEALTH && now - G.lastFood > 12000) {
    G.lastFood = now; say(`${CLASSES[G.players.get(G.pid)?.cls]?.name || 'Hero'} needs food badly`);
  }
  updateHudValues(G.cur);
}
requestAnimationFrame(frame);

function drawEntity(img, x, y, dir, bob = 0, isHero = false) {
  const px = x * TS, py = y * TS + bob;
  ctx.save(); ctx.translate(px, py);
  const flip = dir >= 5 && dir <= 7;
  if (flip) ctx.scale(-1, 1);
  ctx.drawImage(img, -TS / 2, -TS / 2, TS, TS);
  ctx.restore();
  // facing tick so you can tell where a shot will go
  if (isHero) {
    const [dx, dy] = DIRS[dir] || [0, 1];
    ctx.fillStyle = '#fff'; ctx.fillRect(px + dx * (TS / 2 + 2) - 2, py + dy * (TS / 2 + 2) - 2, 4, 4);
  }
}

// ---------------- HUD ----------------
function renderHud() {
  const hud = $('#hud');
  hud.innerHTML = `<div class="lvl" id="hud-lvl"></div>` + [...G.players.values()].map((p) => `
    <div class="pp" data-pid="${p.id}" style="border-color:${CLASSES[p.cls].color}">
      <div class="nm" style="color:${CLASSES[p.cls].color}">${esc(p.name)}${p.id === G.pid ? ' (you)' : ''}</div>
      <div class="muted" style="font-size:11px">${CLASSES[p.cls].name}</div>
      <div>HEALTH <span class="hp">0</span></div>
      <div>SCORE <span class="sc">0</span></div>
      <div class="muted" style="font-size:12px">🔑 <span class="k">0</span> &nbsp; 🧪 <span class="po">0</span></div>
    </div>`).join('') + `<div class="muted" style="font-size:11px;text-align:center;margin-top:auto" id="hud-time"></div>`;
}
function updateHudValues(s) {
  if (!s) return;
  const lvl = $('#hud-lvl'); if (lvl && G.level) lvl.textContent = `Level ${G.level.index}`;
  for (const p of s.p) {
    const el = document.querySelector(`.pp[data-pid="${p[0]}"]`); if (!el) continue;
    el.querySelector('.hp').textContent = p[4]; el.querySelector('.sc').textContent = p[7]; el.querySelector('.k').textContent = p[5]; el.querySelector('.po').textContent = p[6];
    el.classList.toggle('low', p[4] < LOW_HEALTH && !p[8]); el.classList.toggle('dead', !!p[8]);
  }
  const t = $('#hud-time'); if (t) t.textContent = `Time ${Math.floor(s.lt / 60)}:${String(s.lt % 60).padStart(2, '0')}`;
}

// ---------------- audio ----------------
let AC = null;
function ac() { if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } } if (AC.state === 'suspended') AC.resume(); return AC; }
window.addEventListener('pointerdown', () => ac(), { once: true }); window.addEventListener('keydown', () => ac(), { once: true });
function tone(freq, dur, type = 'square', vol = 0.08, slide = 0) {
  const a = ac(); if (!a || G.muted) return;
  const o = a.createOscillator(); const g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, a.currentTime);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), a.currentTime + dur);
  g.gain.setValueAtTime(vol, a.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + dur);
}
function noise(dur, vol = 0.08) {
  const a = ac(); if (!a || G.muted) return;
  const buf = a.createBuffer(1, a.sampleRate * dur, a.sampleRate); const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const s = a.createBufferSource(); s.buffer = buf; const g = a.createGain(); g.gain.value = vol; s.connect(g).connect(a.destination); s.start();
}
const sfxLast = {};
function sfx(name) {
  const now = performance.now(); if (sfxLast[name] && now - sfxLast[name] < 40) return; sfxLast[name] = now;
  switch (name) {
    case 'shoot': tone(880, 0.06, 'square', 0.04, -400); break;
    case 'hit': noise(0.05, 0.05); break;
    case 'kill': tone(220, 0.12, 'sawtooth', 0.06, -150); noise(0.08, 0.04); break;
    case 'boom': noise(0.35, 0.12); tone(80, 0.3, 'sawtooth', 0.1, -60); break;
    case 'coin': tone(988, 0.08, 'square', 0.06); setTimeout(() => tone(1319, 0.15, 'square', 0.06), 80); break;
    case 'key': tone(1319, 0.06, 'square', 0.05); setTimeout(() => tone(1760, 0.1, 'square', 0.05), 60); break;
    case 'eat': tone(330, 0.08, 'triangle', 0.08); setTimeout(() => tone(440, 0.1, 'triangle', 0.08), 80); break;
    case 'pick': tone(660, 0.1, 'triangle', 0.06); break;
    case 'door': tone(160, 0.25, 'sawtooth', 0.06, 60); break;
    case 'magic': tone(200, 0.6, 'sine', 0.1, 1400); noise(0.3, 0.05); break;
    case 'death': tone(440, 0.8, 'sawtooth', 0.1, -400); break;
    case 'bad': tone(200, 0.3, 'square', 0.06, -100); break;
    case 'fireball': tone(300, 0.15, 'sawtooth', 0.04, -200); break;
    case 'spawn': tone(120, 0.1, 'square', 0.03, 80); break;
    case 'level': [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.18, 'square', 0.06), i * 110)); break;
    case 'clear': [784, 659, 784, 1047, 1319].forEach((f, i) => setTimeout(() => tone(f, 0.2, 'square', 0.07), i * 120)); break;
    case 'ach': [1047, 1319, 1568].forEach((f, i) => setTimeout(() => tone(f, 0.25, 'triangle', 0.08), i * 90)); break;
  }
}
let lastSay = 0;
function say(text) {
  if (!G.narrate || !('speechSynthesis' in window)) return;
  const now = performance.now(); if (now - lastSay < 2500) return; lastSay = now;
  const u = new SpeechSynthesisUtterance(text); u.rate = 0.9; u.pitch = 0.6; u.volume = 0.9;
  speechSynthesis.speak(u);
}

// deep link: /?room=ID
const params = new URLSearchParams(location.search);
if (params.get('room')) joinGame({ roomId: params.get('room') });
