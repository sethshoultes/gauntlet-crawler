// The lobby/room screen and the in-game client: hero picking, room/ready UI, the WebSocket
// protocol handshake, canvas rendering of the 20 Hz snapshot, HUD, chat, and the narrator/cutscene
// trigger points (see client/audio.js, client/voice.js, client/cutscenes.js).
import { api, me, token, toast, renderNav, esc, cssToken, authModal, NAME_KEY, CLASS_KEY, PALETTE_KEY } from './common.js';
import { sprite, TILE, TILE_SPRITE, SHOT_SPRITE, GEN_TINT } from './sprites.js';
import { spriteFromPixels } from './pixelsprite.js';
import { CLASSES, CLASS_IDS, LOW_HEALTH, DIRS, SNAP_KEY_TO_MONSTER } from '/shared/constants.js';
import { PALETTES, requirementText } from '/shared/unlocks.js';
import { BOOST_ICONS } from '/shared/chests.js';
import { STATS as HERO_STATS, PALETTE as HERO_PALETTE } from '/shared/hero-builder.js';
import { initAudio, sfx, setMuted } from './audio.js';
import { say as voiceSay } from './voice.js';
import { playCutscene, hasSeen, markSeen, getScene } from './cutscenes.js';
const RESUME_KEY = 'gc_resume';
const GUEST_KEY = 'gc_guest_id';
// Durable guest identity (#7): minted by the server on our first join and echoed back in every
// `welcome`. We resend it on every later join so a host kick can block us across reconnects and
// even after sessionStorage's resume token has expired — it carries no other trust.
let guestId = null;
try { guestId = localStorage.getItem(GUEST_KEY) || null; } catch {}

const $ = (s) => document.querySelector(s);
const SCALE = 2;                 // 8px art -> 16px tiles
const ZOOM = 2;                  // 16px tiles -> 32px on the 640x480 canvas => 20x15 tiles visible
const VIEW_W = 640, VIEW_H = 480;

// ---------------- cutscenes (#23) ----------------
// Client-side overlays only: they never touch the WebSocket protocol or block server-side
// gameplay, are always skippable, and honor both the `cutscenes` preference (default on, see
// client/common.js loadPrefs()) and prefers-reduced-motion (handled inside cutscenes.js itself).
function cutscenesEnabled() {
  try { return localStorage.getItem('gc_cutscenes') !== '0'; } catch { return true; }
}
const introCv = $('#intro-cutscene');   // lobby overlay: only the one-time 'intro'/'hero_*' scenes
const sceneCv = $('#scene-cutscene');   // in-session overlay: death_mode/treasure_room/game_over/victory/milestones
function playScene(sceneId, opts = {}) {
  if (!cutscenesEnabled()) return;
  const cv2 = G.inRoom ? sceneCv : introCv;
  if (!cv2) return;
  cv2.hidden = false;
  playCutscene(cv2, sceneId, {
    sfx, say: (text) => say('cutscene', text),
    onDone: () => { cv2.hidden = true; opts.onDone?.(); },
    onSkip: opts.onSkip,
  });
}

// ---------------- lobby ----------------
// `unlocked` starts out base-classes-only (a guest's baseline) and is replaced once /api/me
// resolves with the server's real answer for this account — the server is authoritative; this
// is purely what the picker renders before that arrives.
let selectedClass = localStorage.getItem(CLASS_KEY) || 'warrior';
let selectedPalette = localStorage.getItem(PALETTE_KEY) || '';
let unlocked = { classes: new Set(CLASS_IDS.filter((id) => !CLASSES[id].locked)), palettes: new Set() };
// Hero Builder custom heroes for the logged-in account (see /api/heroes/mine) — empty for guests.
let myHeroes = [];
function isCustomCls(cls) { return typeof cls === 'string' && cls.startsWith('custom:'); }
function findCustomHero(cls) { return isCustomCls(cls) ? myHeroes.find((h) => `custom:${h.id}` === cls) : null; }

/** The tint color to draw `clsId` with, honoring `selectedPalette` only when it's this class's
 *  own and actually unlocked. */
function colorFor(clsId, paletteId) {
  if (paletteId && unlocked.palettes.has(paletteId)) {
    const p = PALETTES.find((pp) => pp.id === paletteId && pp.cls === clsId);
    if (p) return p.color;
  }
  return CLASSES[clsId].color;
}
/** The color to render a *room-mate's* hero with, from the {cls, palette, custom} the server sent
 *  us (their palette/custom hero was already resolved+unlock-checked server-side, so no local
 *  re-check needed here — see server/game/room.js pickHero / sim.js playerInfo()). */
function playerColor(info) {
  if (!info) return CLASSES.warrior.color;
  if (info.custom) return info.custom.color;
  const cls = CLASSES[info.cls] ? info.cls : 'warrior';
  if (info.palette) {
    const p = PALETTES.find((pp) => pp.id === info.palette && pp.cls === cls);
    if (p) return p.color;
  }
  return CLASSES[cls].color;
}
/** The display name for whichever hero `cls` names — a classic CLASSES entry, or a Hero Builder
 *  custom hero (from myHeroes) for a `custom:<id>` token. */
function heroDisplayName(cls) {
  if (isCustomCls(cls)) { const h = findCustomHero(cls); return h ? (h.title || h.name) : 'Adventurer'; }
  return CLASSES[cls]?.name || 'Adventurer';
}
/** The name/label to show for a room-mate (or self) from their `players`/roster info — a custom
 *  hero's own painted name when present, else the classic class name. */
function heroLabel(info) {
  if (info?.custom) return info.custom.name;
  return CLASSES[info?.cls]?.name || info?.cls || 'Hero';
}

// The first time a class is picked this session, play its intro cutscene (hero_<classId>). Custom
// heroes all share one generic 'hero_custom' scene — see client/cutscenes.js — and are skipped
// entirely (no toast, no error) if that scene doesn't exist, per the Hero Builder integration note.
function maybeHeroCutscene(cls) {
  const sceneId = isCustomCls(cls) ? 'hero_custom' : `hero_${cls}`;
  if (hasSeen(sceneId)) return;
  if (!getScene(sceneId)) return;
  playScene(sceneId, { onDone: () => markSeen(sceneId) });
}

const heroes = $('#heroes');
const heroesCustom = $('#heroes-custom');
const STAT_ABBR = { speed: 'SPD', shot: 'DMG', fireRate: 'RATE', armor: 'ARM', magic: 'MAG', health: 'HP' };
function renderCustomHeroPicker() {
  if (!heroesCustom) return;
  if (!myHeroes.length) {
    heroesCustom.innerHTML = '<div class="muted" style="grid-column:1/-1;padding:8px">No custom heroes yet. <a href="/heroes.html">Build one</a> at rank 3+.</div>';
    return;
  }
  heroesCustom.innerHTML = '';
  for (const h of myHeroes) {
    const cls = `custom:${h.id}`;
    const el = document.createElement('div');
    el.className = 'hero' + (cls === selectedClass ? ' sel' : '');
    const notches = HERO_STATS.map((k) => `${STAT_ABBR[k]} ${'★'.repeat(h.stats?.[k] || 0)}`).join('<br>');
    el.innerHTML = `<canvas width="16" height="16" class="pixel"></canvas><div class="n">${esc(h.title || h.name)}</div><div class="s">${esc(h.name)}</div><div class="notches">${notches}</div>`;
    const bmp = spriteFromPixels(h.pixels, HERO_PALETTE, 4);
    if (bmp) el.querySelector('canvas').getContext('2d').drawImage(bmp, 0, 0, 16, 16);
    el.onclick = () => {
      selectedClass = cls; localStorage.setItem(CLASS_KEY, cls);
      selectedPalette = ''; localStorage.removeItem(PALETTE_KEY);
      renderHeroPicker(); renderCustomHeroPicker(); rebuildHeroSelect();
      maybeHeroCutscene(cls);
    };
    heroesCustom.appendChild(el);
  }
}
document.querySelectorAll('#hero-tabs [data-tab]').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#hero-tabs [data-tab]').forEach((x) => x.classList.toggle('sel', x === b));
    heroes.style.display = b.dataset.tab === 'classic' ? '' : 'none';
    if (heroesCustom) heroesCustom.style.display = b.dataset.tab === 'custom' ? '' : 'none';
  };
});
function paletteRow(id) {
  const opts = [{ id: '', name: 'Default', color: CLASSES[id].color, locked: false },
    ...PALETTES.filter((p) => p.cls === id).map((p) => ({ id: p.id, name: p.name, color: p.color, locked: !unlocked.palettes.has(p.id) }))];
  return `<div class="swatches">${opts.map((o) => `<span class="swatch ${o.id === selectedPalette ? 'sel' : ''} ${o.locked ? 'locked' : ''}" data-palette="${o.id}" title="${esc(o.name)}${o.locked ? ' (locked)' : ''}" style="background:${o.color}"></span>`).join('')}</div>`;
}
function renderHeroPicker() {
  heroes.innerHTML = '';
  for (const id of CLASS_IDS) {
    const c = CLASSES[id];
    const isUnlocked = unlocked.classes.has(id);
    const el = document.createElement('div');
    el.className = 'hero' + (id === selectedClass ? ' sel' : '') + (isUnlocked ? '' : ' locked');
    const color = colorFor(id, id === selectedClass ? selectedPalette : '');
    el.innerHTML = `<canvas width="16" height="16" class="pixel"></canvas><div class="n cls-${cssToken(id)}">${c.name}</div><div class="s">${c.hero}</div>
      <div class="s">Speed ${'★'.repeat(Math.max(0, Math.round((c.speed - 4) * 1.5)))}<br>Shot ${'★'.repeat(c.shotDamage)}<br>Armor ${'★'.repeat(Math.max(0, Math.round((1.1 - c.armor) * 10)))}<br>Magic ${'★'.repeat(Math.round(c.magic))}</div>
      ${isUnlocked ? paletteRow(id) : `<div class="lock">🔒 ${esc(requirementText({ requires: c.requires }))}</div>`}`;
    el.querySelector('canvas').getContext('2d').drawImage(sprite('hero', color), 0, 0);
    if (isUnlocked) {
      el.onclick = () => {
        selectedClass = id; localStorage.setItem(CLASS_KEY, id);
        if (!PALETTES.some((p) => p.id === selectedPalette && p.cls === id)) { selectedPalette = ''; localStorage.removeItem(PALETTE_KEY); }
        renderHeroPicker();
        rebuildHeroSelect();
        maybeHeroCutscene(id);
      };
      el.querySelectorAll('[data-palette]').forEach((sw) => sw.onclick = (ev) => {
        ev.stopPropagation();
        const pid = sw.dataset.palette;
        if (pid && !unlocked.palettes.has(pid)) return;
        selectedClass = id; localStorage.setItem(CLASS_KEY, id);
        selectedPalette = pid; if (pid) localStorage.setItem(PALETTE_KEY, pid); else localStorage.removeItem(PALETTE_KEY);
        renderHeroPicker();
        rebuildHeroSelect();
        maybeHeroCutscene(id);
      });
    }
    heroes.appendChild(el);
  }
}
renderHeroPicker();
$('#gname').value = localStorage.getItem(NAME_KEY) || '';
$('#gname').oninput = () => localStorage.setItem(NAME_KEY, $('#gname').value);

async function loadRooms() {
  const { rooms } = await api('/api/rooms').catch(() => ({ rooms: [] }));
  const box = $('#rooms');
  if (!rooms.length) { box.innerHTML = '<span class="muted">No open dungeons. Start one!</span>'; return; }
  box.innerHTML = rooms.map((r) => `<div class="r"><div><b>${esc(r.name)}</b> <span class="tag">${r.mode === 'death' ? `Death mode · cap ${r.deathCap != null ? r.deathCap : '∞'}` : r.source === 'custom' ? 'custom: ' + esc(r.customName || '') : 'campaign'}</span> <span class="tag">${r.state === 'lobby' ? 'In lobby' : 'Level ' + r.level}</span><br>
    <span class="muted" style="font-size:12px">${esc(r.levelName)} · ${r.roster.map((p) => `<span style="color:${playerColor(p)}">${esc(p.name)}${p.title ? ` <span class="muted">(${esc(p.title)})</span>` : ''}</span>`).join(', ') || 'empty'}</span></div>
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
  unlocked = {
    classes: new Set(m.unlocks?.classes || CLASS_IDS.filter((id) => !CLASSES[id].locked)),
    palettes: new Set(m.unlocks?.palettes || []),
  };
  if (m.user) { try { ({ heroes: myHeroes } = await api('/api/heroes/mine')); } catch { myHeroes = []; } }
  else myHeroes = [];
  if (isCustomCls(selectedClass)) {
    if (!findCustomHero(selectedClass)) { selectedClass = 'warrior'; localStorage.setItem(CLASS_KEY, selectedClass); }
  } else if (!unlocked.classes.has(selectedClass)) { selectedClass = 'warrior'; localStorage.setItem(CLASS_KEY, selectedClass); }
  if (selectedPalette && !unlocked.palettes.has(selectedPalette)) { selectedPalette = ''; localStorage.removeItem(PALETTE_KEY); }
  renderHeroPicker();
  renderCustomHeroPicker();
  rebuildHeroSelect();
  if (isCustomCls(selectedClass)) document.querySelector('#hero-tabs [data-tab="custom"]')?.click();
  if (!hasSeen('intro')) playScene('intro', { onDone: () => markSeen('intro') });
});
loadRooms();
setInterval(() => { if (!G.ws) loadRooms(); }, 5000);

// ---------------- game state ----------------
const G = {
  ws: null, pid: null, room: null, level: null, grid: null, players: new Map(), // id -> {name, cls}
  prev: null, cur: null, prevAt: 0, curAt: 0, tiles: {}, fx: [], notices: [],
  input: { dx: 0, dy: 0, fire: false }, lastSent: '', camX: 0, camY: 0, overlay: null, muted: localStorage.getItem('gc_mute') === '1', narrate: localStorage.getItem('gc_narrate') !== '0',
  aiNarrator: localStorage.getItem('gc_ai_narrator') === '1', // opt-in AI narrator commentary (#18); off unless explicitly turned on
  followId: null, lastFood: 0, shake: 0,
  inRoom: false, reconnecting: false, reconnectAttempts: 0, reconnectTimer: null,
  intermission: null, // { seconds, startedAt, totalMs, chests, picks:Map<pid,chest>, myPick, rects[] }
  sealed: false, // Death mode: exit tile is impassable-for-completion until all of a level's waves clear
  bonus: null, // { total, startedAt } — treasure-room countdown (see 'bonus' message)
  keyCount: 0, foodShotCount: 0, // per-level narrator counters
  lastMagicNag: 0, lastDying: 0, // narrator rate-limit timestamps
};
// exposed for manual/E2E debugging only — not used by the game itself
window.__gc = {
  reconnectNow: () => attemptReconnect(),
  send: (msg) => { if (G.ws && G.ws.readyState === 1) G.ws.send(JSON.stringify(msg)); },
};

function saveResume(room, pid, resume) {
  try { sessionStorage.setItem(RESUME_KEY, JSON.stringify({ roomId: room.id, pid, resume, name: $('#gname').value.trim() || 'Guest', cls: selectedClass, palette: selectedPalette || null })); } catch {}
}
function loadResume() {
  try { return JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null'); } catch { return null; }
}
function clearResume() { try { sessionStorage.removeItem(RESUME_KEY); } catch {} }

function joinGame(opts) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  G.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'join', token: token(), name: $('#gname').value.trim() || 'Guest', cls: selectedClass, palette: selectedPalette || null, guestId, aiNarrator: G.aiNarrator, ...opts }));
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onclose = () => { if (G.ws === ws) { G.ws = null; G.inRoom ? scheduleReconnect() : leaveGame('Disconnected from server'); } };
  ws.onerror = () => { if (!G.inRoom) toast('Connection error', 'Could not reach the game server', 'err'); };
}

function scheduleReconnect() {
  if (G.reconnectTimer) return;
  const saved = loadResume();
  if (!saved) { leaveGame('Disconnected from server'); return; }
  const delay = Math.min(20000, 1000 * 2 ** G.reconnectAttempts);
  G.reconnectAttempts++;
  toast('Reconnecting…', `Trying again in ${Math.round(delay / 1000)}s`);
  G.reconnectTimer = setTimeout(() => { G.reconnectTimer = null; attemptReconnect(); }, delay);
}
function attemptReconnect() {
  const saved = loadResume();
  if (!saved) { leaveGame('Disconnected from server'); return; }
  G.reconnecting = true;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  G.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', token: token(), roomId: saved.roomId, resume: saved.resume, name: saved.name, cls: saved.cls, palette: saved.palette || null, guestId, aiNarrator: G.aiNarrator }));
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onclose = () => { if (G.ws === ws) { G.ws = null; G.inRoom ? scheduleReconnect() : leaveGame('Disconnected from server'); } };
  ws.onerror = () => {};
}

function leaveGame(reason) {
  if (G.reconnectTimer) { clearTimeout(G.reconnectTimer); G.reconnectTimer = null; }
  G.reconnecting = false; G.reconnectAttempts = 0; G.inRoom = false;
  if (G.ws) { try { G.ws.close(); } catch {} }
  G.ws = null; G.level = null; G.cur = G.prev = null; G.players.clear(); G.overlay = null; G.room = null;
  clearResume();
  $('#game').classList.remove('on'); $('#roomscreen').classList.remove('on'); $('#session').classList.remove('on');
  $('#lobby').style.display = ''; $('#touch').classList.remove('on');
  if (reason) toast('Left the dungeon', reason);
  loadRooms();
  history.replaceState(null, '', '/');
}
$('#leave').onclick = () => { if (G.ws) G.ws.send(JSON.stringify({ t: 'leave' })); leaveGame(); };

function onMessage(m) {
  switch (m.t) {
    case 'welcome':
      G.pid = m.pid; G.room = m.room; G.inRoom = true; G.reconnecting = false; G.reconnectAttempts = 0;
      if (m.guestId && m.guestId !== guestId) { guestId = m.guestId; try { localStorage.setItem(GUEST_KEY, guestId); } catch {} }
      saveResume(m.room, m.pid, m.resume);
      $('#lobby').style.display = 'none'; $('#session').classList.add('on');
      if (m.room.state === 'lobby') {
        $('#roomscreen').classList.add('on'); $('#game').classList.remove('on'); $('#touch').classList.remove('on');
      } else {
        $('#roomscreen').classList.remove('on'); $('#game').classList.add('on'); $('#touch').classList.add('on');
      }
      $('#log').innerHTML = '';
      log(`<span class="n">Welcome to ${esc(m.room.name)}. ${m.room.source === 'custom' ? 'Custom dungeon: ' + esc(m.room.customName || '') : ''}</span>`);
      history.replaceState(null, '', `/?room=${m.room.id}`);
      renderRoomScreen(m.room);
      say('welcome', 'Welcome, ' + heroDisplayName(selectedClass));
      break;
    case 'room':
      G.room = m.room;
      renderRoomScreen(m.room);
      break;
    case 'countdown': renderCountdown(m.seconds); break;
    case 'start':
      $('#roomscreen').classList.remove('on'); $('#game').classList.add('on'); $('#touch').classList.add('on');
      renderCountdown(null);
      if (G.room?.mode === 'death' && !hasSeen('death_mode')) playScene('death_mode', { onDone: () => markSeen('death_mode') });
      break;
    case 'level':
      G.level = m; G.grid = m.rows.map((r) => r.split(''));
      G.prev = G.cur = null; G.fx = []; G.sealed = !!m.sealed; G.bonus = null;
      G.keyCount = 0; G.foodShotCount = 0;
      G.overlay = { kind: 'level', title: `LEVEL ${m.index}`, sub: m.name, until: performance.now() + 2500 };
      log(`<span class="n">Level ${m.index}: ${esc(m.name)}</span> <span class="muted">${esc(m.description || '')}</span>`);
      if (m.index > 1) say('level_n', `Let's see how you do in level ${m.index}`);
      sfx('level');
      if ([10, 25, 50].includes(m.index)) playScene(`level_milestone_${m.index}`);
      break;
    case 'bonus':
      G.bonus = { total: m.seconds, startedAt: performance.now() };
      G.overlay = { kind: 'bonus', title: 'BONUS ROUND!', sub: 'Grab treasure — any exit will do', until: performance.now() + 2500 };
      log('<span class="n">Bonus treasure room! Grab everything before time runs out.</span>');
      sfx('level');
      playScene('treasure_room');
      break;
    case 'wave':
      G.overlay = { kind: 'wave', title: `WAVE ${m.n} / ${m.total}`, sub: 'Survive!', until: performance.now() + m.seconds * 1000 };
      log(`<span class="n">Wave ${m.n} of ${m.total} incoming…</span>`);
      say('wave_n', `Wave ${m.n}`);
      sfx('wave');
      break;
    case 'exitopen':
      G.sealed = false;
      log('<span class="n">All waves cleared — the exit has opened!</span>');
      sfx('clear');
      break;
    case 'gameover': {
      const sorted = [...m.scores].sort((a, b) => b.score - a.score);
      const lines = sorted.map((s, i) => `${i + 1}. ${esc(s.name)} ${s.score.toLocaleString()}`).join('  ·  ');
      const capTxt = Number.isFinite(m.cap) ? m.cap : '∞';
      const title = m.reason === 'cap' ? 'LEVEL CAP REACHED!' : 'PARTY WIPED';
      G.overlay = { kind: 'gameover', title, sub: `Level ${m.level} / cap ${capTxt}`, until: performance.now() + 6000 };
      log(`<span class="n">${title} — reached level ${m.level}. ${lines}</span>`);
      sfx(m.reason === 'cap' ? 'victory' : 'gameover');
      playScene(m.reason === 'cap' ? 'victory' : 'game_over');
      setTimeout(() => {
        $('#game').classList.remove('on'); $('#roomscreen').classList.add('on'); $('#touch').classList.remove('on');
        if (G.room) renderRoomScreen(G.room);
      }, 6000);
      break;
    }
    case 'players':
      G.players = new Map(m.list.map((p) => [p.id, p]));
      renderHud();
      break;
    case 's':
      G.prev = G.cur; G.prevAt = G.curAt; G.cur = m; G.curAt = performance.now();
      if (m.e) for (const e of m.e) onEvent(e);
      break;
    case 'notice': log(`<span class="n">${esc(m.text)}</span>`); break;
    // AI narrator commentary (#18): free-text line from server/ai/narrator.js, delivered through
    // the same say() gate (narrator on/off, mute, volume — see client/voice.js) as the fixed
    // arcade lines below, plus this preference: never spoken unless the player opted in. The id
    // passed to say() is deliberately unique per line (never a fixed string literal, so it's
    // exempt from test/voice.test.js's voice-lines.json coverage check, and — more importantly —
    // can never collide with a pre-rendered clip): this text is generated fresh per event and
    // must always fall through to speechSynthesis, never get silently replaced by a stale clip.
    case 'say': if (G.aiNarrator) { log(`<span class="n">${esc(m.text)}</span>`); say(`ai_${Date.now()}`, m.text); } break;
    case 'chat': log(`<span class="c"><b>${esc(m.from)}:</b> ${esc(m.text)}</span>`); break;
    case 'ach': toast(`${m.ach.icon} Achievement: ${m.ach.name}`, m.ach.desc); sfx('ach'); break;
    case 'rankup': toast(`⭐ Rank Up!`, `You are now Rank ${m.rank}: ${m.title}`); sfx('ach'); break;
    case 'unlock':
      toast(m.item.type === 'hero' ? `🔓 New hero unlocked!` : `🎨 New palette unlocked!`, m.item.name);
      sfx('ach');
      break;
    case 'levelclear':
      G.overlay = { kind: 'clear', title: 'LEVEL CLEARED', sub: `${m.by} found the exit in ${m.time}s`, until: performance.now() + 2500 };
      if (!m.deaths && m.kills >= 30) say('bravery', "I've not seen such bravery");
      sfx('clear'); break;
    case 'chests':
      G.intermission = {
        startedAt: performance.now(), totalMs: m.seconds * 1000,
        chests: m.chests, picks: new Map(), myPick: null, pickSent: false, rects: [],
      };
      log('<span class="n">Choose a chest for the next level…</span>');
      break;
    case 'chestpick': {
      if (!G.intermission) break;
      G.intermission.picks.set(m.pid, m.chest);
      if (m.pid === G.pid) { G.intermission.myPick = m.chest; sfx(m.chest.cursed ? 'bad' : 'chest'); }
      const nm = G.players.get(m.pid)?.name || 'Someone';
      log(`<span class="n">${esc(nm)} opened ${esc(m.chest.icon)} ${esc(m.chest.label)}</span>`);
      break;
    }
    case 'chestsdone': G.intermission = null; break;
    case 'error':
      toast('Error', m.error, 'err');
      if (G.reconnecting || !G.inRoom) leaveGame();
      break;
    case 'kicked': leaveGame(m.reason); break;
    case 'left': leaveGame(); break;
  }
}

function onEvent(e) {
  const mine = e.pid === G.pid;
  const info = G.players.get(e.pid);
  const name = info?.name || '';
  const hLabel = heroLabel(info);
  switch (e.type) {
    case 'tile': if (G.grid) G.grid[e.y][e.x] = e.c; if (e.c === '.') G.fx.push({ kind: 'puff', x: e.x + 0.5, y: e.y + 0.5, t: 0 }); break;
    case 'kill': G.fx.push({ kind: 'die', x: e.x, y: e.y, t: 0, m: e.monster }); if (mine) sfx(e.monster ? 'kill_' + e.monster : 'kill'); break;
    case 'generator': G.fx.push({ kind: 'boom', x: e.x + 0.5, y: e.y + 0.5, t: 0 }); sfx('boom'); if (mine) G.shake = 0.3; break;
    case 'pickup':
      if (mine) {
        sfx(e.item === 'T' ? 'coin' : e.item === 'K' ? 'key' : (e.item === 'F' || e.item === 'C') ? 'eat' : 'pick');
        if (e.item === 'K') { G.keyCount++; if (G.keyCount === 3) say('save_keys', 'Save keys for later levels'); }
      }
      break;
    case 'food': if (mine && e.lowHealth) say('saved_by_food', `${hLabel} was about to die… saved by food`); break;
    case 'poison': log(`<span class="n">${esc(name)} ate poisoned food!</span>`); if (mine) { sfx('poison'); say('poisoned', 'That was poisoned!'); } break;
    case 'steal': log(`<span class="n">A thief stole ${e.item === 'potion' ? 'a potion' : 'a key'} from ${esc(name)}!</span>`); if (mine) sfx('bad'); break;
    case 'teleport': if (mine) sfx('teleport'); break;
    case 'lob_land': G.fx.push({ kind: 'boom', x: e.x, y: e.y, t: 0 }); if (Math.random() < 0.7) sfx('boom'); break;
    case 'food_shot':
      log(`<span class="n">${esc(name)} shot the food!</span>`);
      if (mine) {
        G.foodShotCount++; sfx('bad');
        say(G.foodShotCount === 2 ? 'dont_shoot_food_again' : 'dont_shoot_food', G.foodShotCount === 2 ? "Remember, don't shoot food" : "Don't shoot the food!");
      }
      break;
    case 'door': sfx('door'); break;
    case 'secret': log(`<span class="n">${esc(name)} found a secret wall</span>`); sfx('door'); break;
    case 'potion': G.fx.push({ kind: 'magic', x: e.x, y: e.y, r: e.radius, t: 0 }); sfx('potion'); G.shake = 0.4; break;
    case 'death': log(`<span class="n">${esc(name)} the ${esc(hLabel)} has died</span>`); if (mine) { sfx('death'); say('died', `${hLabel} has died. Insert coin to continue.`); } break;
    case 'coin': if (mine) sfx('coin'); break;
    case 'exit': break;
    case 'sound':
      if (!mine && Math.random() < 0.7) break;
      if (e.name.startsWith('shoot_')) sfx(e.name);
      else if (e.name === 'hit') sfx(e.mtype ? 'hit_' + e.mtype : 'hit');
      else if (e.name === 'fireball') sfx('fireball');
      else if (e.name === 'spawn') sfx('spawn');
      else if (e.name === 'ghost_hit') sfx('hit_ghost');
      break;
  }
}

function log(html) {
  const el = $('#log'); const d = document.createElement('div'); d.innerHTML = html; el.appendChild(d);
  while (el.children.length > 60) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}

// ---------------- room (pre-game) screen ----------------
const heroSelect = $('#rs-hero');
const paletteSelect = $('#rs-palette');
function rebuildHeroSelect() {
  const classicOpts = CLASS_IDS.map((id) => {
    const locked = !unlocked.classes.has(id);
    return `<option value="${id}" ${locked ? 'disabled' : ''}>${esc(CLASSES[id].name)}${locked ? ' (locked)' : ''}</option>`;
  }).join('');
  const customOpts = myHeroes.length
    ? `<optgroup label="Custom">${myHeroes.map((h) => `<option value="custom:${h.id}">${esc(h.title || h.name)}</option>`).join('')}</optgroup>`
    : '';
  heroSelect.innerHTML = classicOpts + customOpts;
  heroSelect.value = findCustomHero(selectedClass) ? selectedClass : unlocked.classes.has(selectedClass) ? selectedClass : 'warrior';
  rebuildPaletteSelect();
}
function rebuildPaletteSelect() {
  // Custom heroes carry their own fixed color (from their pixel art) — no palette to pick.
  paletteSelect.disabled = isCustomCls(selectedClass);
  if (isCustomCls(selectedClass)) { paletteSelect.innerHTML = '<option value="">—</option>'; return; }
  const opts = [{ id: '', name: 'Default' }, ...PALETTES.filter((p) => p.cls === selectedClass)];
  paletteSelect.innerHTML = opts.map((o) => {
    const locked = o.id && !unlocked.palettes.has(o.id);
    return `<option value="${o.id}" ${locked ? 'disabled' : ''}>${esc(o.name)}${locked ? ' (locked)' : ''}</option>`;
  }).join('');
  paletteSelect.value = selectedPalette && unlocked.palettes.has(selectedPalette) ? selectedPalette : '';
}
rebuildHeroSelect();
function sendHeroChange() {
  if (G.ws && G.ws.readyState === 1) G.ws.send(JSON.stringify({ t: 'hero', cls: selectedClass, palette: selectedPalette || null }));
}
heroSelect.onchange = () => {
  selectedClass = heroSelect.value; localStorage.setItem(CLASS_KEY, selectedClass);
  if (!PALETTES.some((p) => p.id === selectedPalette && p.cls === selectedClass)) selectedPalette = '';
  rebuildPaletteSelect();
  sendHeroChange();
};
paletteSelect.onchange = () => {
  selectedPalette = paletteSelect.value;
  if (selectedPalette) localStorage.setItem(PALETTE_KEY, selectedPalette); else localStorage.removeItem(PALETTE_KEY);
  sendHeroChange();
};
let selfReady = false;
$('#rs-ready').onclick = () => {
  selfReady = !selfReady;
  if (G.ws && G.ws.readyState === 1) G.ws.send(JSON.stringify({ t: 'ready', ready: selfReady }));
};
$('#rs-start').onclick = () => { if (G.ws && G.ws.readyState === 1) G.ws.send(JSON.stringify({ t: 'start' })); };
$('#rs-mode').onchange = () => {
  const mode = $('#rs-mode').value;
  $('#rs-customwrap').style.display = mode === 'custom' ? '' : 'none';
  $('#rs-death-help').style.display = mode === 'death' ? '' : 'none';
  if (G.ws && G.ws.readyState === 1 && mode !== 'custom') G.ws.send(JSON.stringify({ t: 'settings', mode }));
};
$('#rs-customlevel').onchange = () => {
  const levelId = $('#rs-customlevel').value;
  if (G.ws && G.ws.readyState === 1 && levelId) G.ws.send(JSON.stringify({ t: 'settings', mode: 'custom', levelId }));
};
$('#rs-private').onchange = () => {
  if (G.ws && G.ws.readyState === 1) G.ws.send(JSON.stringify({ t: 'settings', isPublic: !$('#rs-private').checked }));
};
let customLevelsLoaded = false;
async function ensureCustomLevels() {
  if (customLevelsLoaded) return;
  customLevelsLoaded = true;
  const { levels } = await api('/api/levels').catch(() => ({ levels: [] }));
  const sel = $('#rs-customlevel');
  sel.innerHTML = levels.map((l) => `<option value="${l.id}">${esc(l.name)} (by ${esc(l.author)})</option>`).join('') || '<option disabled>No published levels yet</option>';
}
function renderRoomScreen(room) {
  if (!room || room.state !== 'lobby') return;
  ensureCustomLevels();
  $('#rs-name').textContent = room.name;
  $('#rs-invite').value = `${location.origin}/?room=${room.id}`;
  const isHost = room.hostPid === G.pid;
  $('#rs-start').style.display = isHost ? '' : 'none';
  const me2 = room.roster.find((p) => p.pid === G.pid);
  selfReady = !!me2?.ready;
  $('#rs-ready').textContent = selfReady ? 'Not ready' : 'Ready';
  $('#rs-ready').className = selfReady ? '' : 'primary';
  const allReady = room.players <= 1 || room.roster.every((p) => p.ready);
  $('#rs-start').disabled = !allReady;
  $('#settingspanel').style.display = isHost ? '' : 'none';
  if (isHost) {
    $('#rs-mode').value = room.mode === 'custom' ? 'custom' : room.mode === 'death' ? 'death' : 'campaign';
    $('#rs-customwrap').style.display = room.mode === 'custom' ? '' : 'none';
    $('#rs-death-help').style.display = room.mode === 'death' ? '' : 'none';
    if (room.mode === 'custom' && room.customLevel) $('#rs-customlevel').value = String(room.customLevel.id || '');
    $('#rs-private').checked = !room.public;
  }
  $('#rs-cap').textContent = room.mode === 'death' ? `· cap ${room.deathCap != null ? room.deathCap : '∞'}` : '';
  $('#rs-roster').innerHTML = room.roster.map((p) => `
    <div class="row2 ${p.away ? 'away' : ''}">
      <div class="who"><span class="nm" style="color:${playerColor(p)}">${esc(p.name)}${p.pid === G.pid ? ' (you)' : ''}</span> ${p.title ? `<span class="muted" style="font-size:11px">${esc(p.title)}</span>` : ''}</div>
      ${p.host ? '<span class="badge host">HOST</span>' : ''}
      ${p.away ? '<span class="badge away">AWAY</span>' : `<span class="badge ${p.ready ? 'ready' : ''}">${p.ready ? 'READY' : 'not ready'}</span>`}
      ${isHost && p.pid !== G.pid ? `<button data-kick="${p.pid}" style="font-size:11px;padding:2px 6px">Kick</button>` : ''}
    </div>`).join('');
  $('#rs-roster').querySelectorAll('[data-kick]').forEach((b) => b.onclick = () => G.ws?.send(JSON.stringify({ t: 'kick', pid: b.dataset.kick })));
}
function renderCountdown(seconds) {
  $('#countdown').textContent = seconds ? `Starting in ${seconds}…` : '';
}

// ---------------- input ----------------
const keys = new Set();
const chat = $('#chat');
window.addEventListener('keydown', (e) => {
  if (!G.ws) return;
  const ae = document.activeElement;
  if (ae && ae !== chat && ['INPUT', 'SELECT', 'TEXTAREA'].includes(ae.tagName)) return;
  if (document.activeElement === chat) {
    if (e.key === 'Enter') { if (chat.value.trim()) G.ws.send(JSON.stringify({ t: 'chat', text: chat.value.trim() })); chat.value = ''; chat.blur(); }
    if (e.key === 'Escape') { chat.value = ''; chat.blur(); }
    return;
  }
  if (G.intermission && !G.intermission.pickSent && ['1', '2', '3'].includes(e.key)) {
    const chest = G.intermission.chests[Number(e.key) - 1];
    if (chest) pickChest(chest.id);
    return;
  }
  if (e.key === 't' || e.key === 'T') { e.preventDefault(); chat.focus(); return; }
  if (e.key === 'm' || e.key === 'M') { G.muted = !G.muted; setMuted(G.muted); toast(G.muted ? 'Sound off' : 'Sound on'); return; }
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

function pickChest(id) {
  if (!G.intermission || G.intermission.pickSent) return;
  if (!G.ws || G.ws.readyState !== 1) return;
  G.intermission.pickSent = true;
  G.ws.send(JSON.stringify({ t: 'pick', id }));
}

// ---------------- rendering ----------------
const cv = $('#cv'); const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;
const TS = TILE * ZOOM; // 32 screen px per tile

cv.addEventListener('click', (ev) => {
  if (!G.intermission || G.intermission.pickSent) return;
  const rect = cv.getBoundingClientRect();
  const x = (ev.clientX - rect.left) * (VIEW_W / rect.width);
  const y = (ev.clientY - rect.top) * (VIEW_H / rect.height);
  for (const r of G.intermission.rects) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { pickChest(r.id); break; }
  }
});

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
    if (c === 'g' || c === 'h' || c === 'm' || c === 'l' || c === 's') {
      const g = snap.g.find((gg) => gg[0] === x && gg[1] === y);
      const hp = g ? g[2] : 3;
      ctx.drawImage(sprite('gen' + Math.max(1, Math.min(3, hp)), GEN_TINT[c]), x * TS, y * TS, TS, TS);
      continue;
    }
    if (c === 'X') {
      // transporter: pulse in size to draw the eye
      const pulse = 0.82 + 0.18 * Math.sin(now / 220 + x * 3 + y);
      const cx = x * TS + TS / 2, cy = y * TS + TS / 2;
      ctx.drawImage(sprite(name), cx - (TS * pulse) / 2, cy - (TS * pulse) / 2, TS * pulse, TS * pulse);
      continue;
    }
    ctx.drawImage(sprite(name), x * TS, y * TS, TS, TS);
  }
  // Death mode: pulse the exit red while it's sealed behind uncleared waves
  if (G.sealed) {
    ctx.fillStyle = `rgba(224,60,49,${0.3 + 0.15 * Math.sin(now / 220)})`;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (G.grid[y][x] === 'E') ctx.fillRect(x * TS, y * TS, TS, TS);
    }
  }
  // shots
  for (const b of snap.b) {
    let name = SHOT_SPRITE[b[4]] || 'fireball';
    // A custom hero's shots all share shotKey 'c' — the owner's own weapon (== its sprite id, see
    // shared/hero-builder.js WEAPONS) says which sprite to actually draw (see snapshot()'s owner id).
    if (b[4] === 'c' && b[6] != null) { const owner = G.players.get(b[6]); if (owner?.weapon) name = owner.weapon; }
    const px = b[1] * TS, py = b[2] * TS;
    ctx.save(); ctx.translate(px, py);
    if (b[4] === 'a' && b[5] != null) {
      // lobber's arcing shot: grows then shrinks across its flight to suggest height
      const prog = b[5]; const scale = 1 + Math.sin(prog * Math.PI) * 0.9;
      ctx.drawImage(sprite(name), (-TS * scale) / 2, (-TS * scale) / 2, TS * scale, TS * scale);
    } else {
      if (name === 'axe') ctx.rotate(now / 60); else ctx.rotate((b[3] - 2) * Math.PI / 4);
      ctx.drawImage(sprite(name), -TS / 2, -TS / 2, TS, TS);
    }
    ctx.restore();
  }
  // monsters
  for (const m of snap.m) {
    const name = SNAP_KEY_TO_MONSTER[m[1]] || 'ghost';
    const bob = name === 'ghost' ? Math.sin(now / 150 + m[0]) * 2 : (Math.floor(now / 200 + m[0]) % 2) * 1;
    const invisible = m[5] === 1;
    if (invisible) ctx.globalAlpha = 0.2;
    drawEntity(sprite(name), m[2], m[3], m[4], bob);
    if (invisible) ctx.globalAlpha = 1;
  }
  // players
  for (const p of snap.p) {
    const info = G.players.get(p[0]); const color = playerColor(info);
    if (p[8]) { ctx.globalAlpha = 0.35; }
    const bob = (Math.floor(now / 120) % 2) * 1;
    // A custom hero renders its own painted pixel art instead of the tinted stock hero sprite.
    const heroImg = (info?.custom && spriteFromPixels(info.custom.pixels, HERO_PALETTE, 4)) || sprite('hero', color);
    drawEntity(heroImg, p[1], p[2], p[3], p[8] ? 0 : bob, true);
    ctx.globalAlpha = 1;
    // name tag
    ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = color;
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
  } else if (mine && !mine[8]) {
    const heroName = heroLabel(G.players.get(G.pid));
    if (mine[4] < 100 && now - G.lastDying > 8000) { G.lastDying = now; say('about_to_die', `${heroName} is about to die`); }
    else if (mine[4] < LOW_HEALTH && now - G.lastFood > 12000) { G.lastFood = now; say('needs_food', `${heroName} needs food badly`); }
    else if (mine[4] < 300 && mine[6] > 0 && now - G.lastMagicNag > 15000) { G.lastMagicNag = now; say('use_magic', `${heroName}, use magic!`); }
  }
  if (G.bonus) {
    const remain = Math.max(0, G.bonus.total * 1000 - (now - G.bonus.startedAt));
    ctx.fillStyle = '#f2c400'; ctx.font = 'bold 14px monospace'; ctx.textAlign = 'center';
    ctx.fillText(`BONUS: ${Math.ceil(remain / 1000)}s`, VIEW_W / 2, 20);
  }
  if (G.intermission) drawIntermission(now);
  updateHudValues(G.cur);
}
requestAnimationFrame(frame);

function wrapText(text, x, y, maxWidth, lineHeight = 14) {
  const words = text.split(' ');
  let line = '', ly = y;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) { ctx.fillText(line, x, ly); line = w; ly += lineHeight; }
    else line = test;
  }
  if (line) ctx.fillText(line, x, ly);
  return ly;
}

function drawIntermission(now) {
  const iv = G.intermission;
  const remain = Math.max(0, iv.totalMs - (now - iv.startedAt));
  ctx.fillStyle = 'rgba(6,6,10,0.86)'; ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f2c400'; ctx.font = 'bold 22px monospace';
  ctx.fillText(iv.pickSent ? 'YOUR REWARD' : 'CHOOSE A CHEST', VIEW_W / 2, 34);

  // countdown bar
  const barW = 320, barX = VIEW_W / 2 - barW / 2, barY = 44;
  ctx.strokeStyle = '#2b2b3d'; ctx.lineWidth = 1; ctx.strokeRect(barX, barY, barW, 8);
  ctx.fillStyle = remain < 4000 ? '#e03c31' : '#2ecc40';
  ctx.fillRect(barX + 1, barY + 1, Math.max(0, (barW - 2) * Math.min(1, remain / iv.totalMs)), 6);

  const n = iv.chests.length;
  const boxW = 150, boxH = 148, gap = 22;
  const totalW = n * boxW + (n - 1) * gap;
  const startX = VIEW_W / 2 - totalW / 2;
  const boxY = 66;
  iv.rects = [];
  for (let i = 0; i < n; i++) {
    const chest = iv.chests[i];
    const picked = iv.myPick && iv.myPick.id === chest.id;
    const x = startX + i * (boxW + gap);
    if (!iv.pickSent) iv.rects.push({ x, y: boxY, w: boxW, h: boxH, id: chest.id });
    ctx.fillStyle = picked ? '#1d1d2b' : '#15151f';
    ctx.strokeStyle = picked ? (iv.myPick.cursed ? '#e03c31' : '#f2c400') : '#2b2b3d';
    ctx.lineWidth = picked ? 3 : 2;
    ctx.fillRect(x, boxY, boxW, boxH); ctx.strokeRect(x, boxY, boxW, boxH);
    if (iv.pickSent && !picked) ctx.globalAlpha = 0.35;
    ctx.save(); ctx.translate(x + boxW / 2, boxY + 56);
    const bob = iv.pickSent ? 0 : Math.sin(now / 260 + i) * 3;
    ctx.drawImage(sprite('treasure', null, 8), -32, -32 + bob, 64, 64);
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#8e8ca0'; ctx.font = '12px monospace';
    ctx.fillText(`[${i + 1}]`, x + boxW / 2, boxY + 100);
    ctx.font = '12px monospace';
    if (picked) {
      ctx.fillStyle = iv.myPick.cursed ? '#e03c31' : '#f2c400';
      wrapText(`${iv.myPick.icon} ${iv.myPick.label}`, x + boxW / 2, boxY + 118, boxW - 10);
    } else if (!iv.pickSent) {
      ctx.fillStyle = '#e8e6d8'; ctx.fillText('???', x + boxW / 2, boxY + 118);
    }
  }
  if (!iv.pickSent) {
    ctx.fillStyle = '#8e8ca0'; ctx.font = '12px monospace';
    ctx.fillText('Click a chest or press 1 / 2 / 3', VIEW_W / 2, boxY + boxH + 22);
  }

  // roster of picks so far
  ctx.textAlign = 'left'; ctx.font = '13px monospace';
  let ry = boxY + boxH + 42;
  for (const p of G.players.values()) {
    const pick = iv.picks.get(p.id);
    ctx.fillStyle = pick ? (pick.cursed ? '#e03c31' : '#2ecc40') : '#8e8ca0';
    const what = pick ? `${pick.icon} ${pick.label}` : 'choosing…';
    ctx.fillText(`${(p.name || '?').toUpperCase()}${p.id === G.pid ? ' (you)' : ''}: ${what}`, VIEW_W / 2 - 150, ry);
    ry += 17;
    if (ry > VIEW_H - 10) break;
  }
}

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
    <div class="pp ${p.away ? 'away' : ''}" data-pid="${p.id}" style="border-color:${playerColor(p)}">
      <div class="nm" style="color:${playerColor(p)}">${esc(p.name)}${p.id === G.pid ? ' (you)' : ''}${p.away ? ' <span class="muted">(away)</span>' : ''}</div>
      <div class="muted" style="font-size:11px">${esc(heroLabel(p))}${p.title ? ` &middot; <span class="rk">Rank ${p.rank} ${esc(p.title)}</span>` : ''}</div>
      <div>HEALTH <span class="hp">0</span></div>
      <div>SCORE <span class="sc">0</span></div>
      <div class="muted" style="font-size:12px">🔑 <span class="k">0</span> &nbsp; 🧪 <span class="po">0</span></div>
      ${p.boosts?.length ? `<div class="boosts" title="Active chest boosts this level">${p.boosts.map((b) => BOOST_ICONS[b] || '✨').join(' ')}</div>` : ''}
    </div>`).join('') + `<div class="muted" style="font-size:11px;text-align:center;margin-top:auto" id="hud-time"></div>`;
}
function updateHudValues(s) {
  if (!s) return;
  const lvl = $('#hud-lvl');
  if (lvl && G.level) {
    const cap = G.room?.mode === 'death' ? (G.room.deathCap != null ? G.room.deathCap : '∞') : null;
    lvl.textContent = cap != null ? `Level ${G.level.index} / ${cap}` : `Level ${G.level.index}`;
  }
  for (const p of s.p) {
    const el = document.querySelector(`.pp[data-pid="${p[0]}"]`); if (!el) continue;
    el.querySelector('.hp').textContent = p[4]; el.querySelector('.sc').textContent = p[7]; el.querySelector('.k').textContent = p[5]; el.querySelector('.po').textContent = p[6];
    el.classList.toggle('low', p[4] < LOW_HEALTH && !p[8]); el.classList.toggle('dead', !!p[8]);
  }
  const t = $('#hud-time'); if (t) t.textContent = `Time ${Math.floor(s.lt / 60)}:${String(s.lt % 60).padStart(2, '0')}`;
}

// ---------------- audio ----------------
// SFX synthesis lives in client/audio.js (#20); the narrator voice pipeline (pre-rendered clip
// or speechSynthesis fallback) lives in client/voice.js (#19). This wrapper just gates on the
// narrator on/off preference, same as the old inline say() used to.
initAudio();
setMuted(G.muted);
function say(id, text) {
  if (!G.narrate) return;
  voiceSay(id, text);
}

// deep link: /?room=ID — but if this tab already holds a resume token for a room (e.g. the page
// reloaded after a dropped connection), reconnect as the same player instead of joining fresh.
const params = new URLSearchParams(location.search);
const savedResume = loadResume();
if (savedResume && (!params.get('room') || params.get('room') === savedResume.roomId)) {
  attemptReconnect();
} else if (params.get('room')) {
  joinGame({ roomId: params.get('room') });
}
