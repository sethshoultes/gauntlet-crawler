// The lobby/room screen and the in-game client: hero picking, room/ready UI, the WebSocket
// protocol handshake, canvas rendering of the 20 Hz snapshot, HUD, chat, and the narrator/cutscene
// trigger points (see client/audio.js, client/voice.js, client/cutscenes.js).
import { api, me, token, toast, renderNav, esc, cssToken, authModal, NAME_KEY, CLASS_KEY, PALETTE_KEY } from './common.js';
import { sprite, TILE, TILE_SPRITE, SHOT_SPRITE, GEN_TINT, PLATE_TINT } from './sprites.js';
import { spriteFromPixels } from './pixelsprite.js';
import {
  T, CLASSES, CLASS_IDS, LOW_HEALTH, DIRS, SNAP_KEY_TO_MONSTER,
  AMULET_TILES, BOOST_TILES, AMULET_NAMES, BOOST_NAMES,
} from '/shared/constants.js';
import { PALETTES, requirementText } from '/shared/unlocks.js';
import { BOOST_ICONS } from '/shared/chests.js';
// HUD icon for each run-boost stat (permanent) and each amulet kind (temporary) — cosmetic only,
// the actual glyph on the map comes from client/sprites.js's amulet_*/boost_* sprites.
const RUN_BOOST_ICON = { speed: '💨', armor: '🛡️', shotPower: '⚔️', shotSpeed: '🔫', magic: '🔮' };
const AMULET_ICON = { invis: '👻', reflect: '🪞', repulse: '🌀', super: '⭐' };
// BOOST_TILES/AMULET_TILES (shared/constants.js) already map the snapshot's single-char tile
// code (see sim.js snapshot()'s encodeBoosts/encodeAmulets) back to the internal kind/stat key.
import { STATS as HERO_STATS, PALETTE as HERO_PALETTE } from '/shared/hero-builder.js';
import { initAudio, sfx, setMuted } from './audio.js';
import { say as voiceSay } from './voice.js';
import { playCutscene, hasSeen, markSeen, getScene } from './cutscenes.js';
import * as Input from './input.js'; // touch d-pad, auto-fire and gamepad/local-multiplayer input (#15)
import { computeCanvasLayout } from './layout.js'; // canvas-fit math for the mobile game screen (#31)
import { showInitialsModal } from './highscore.js';
import { startIdleAttract } from './attract-idle.js';
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
  tileChangedAt: new Map(), // "x,y" -> performance.now() of its last 'tile' event, for the brief dissolve flash (#11)
  input: { dx: 0, dy: 0, fire: false }, lastSent: '', camX: 0, camY: 0, overlay: null, muted: localStorage.getItem('gc_mute') === '1', narrate: localStorage.getItem('gc_narrate') !== '0',
  aiNarrator: localStorage.getItem('gc_ai_narrator') === '1', // opt-in AI narrator commentary (#18); off unless explicitly turned on
  followId: null, lastFood: 0, shake: 0,
  inRoom: false, reconnecting: false, reconnectAttempts: 0, reconnectTimer: null,
  intermission: null, // { seconds, startedAt, totalMs, chests, picks:Map<pid,chest>, myPick, rects[] }
  sealed: false, // Death mode: exit tile is impassable-for-completion until all of a level's waves clear
  bonus: null, // { total, startedAt } — treasure-room countdown (see 'bonus' message)
  keyCount: 0, foodShotCount: 0, // per-level narrator counters
  lastMagicNag: 0, lastDying: 0, // narrator rate-limit timestamps
  hsTokens: new Map(), // runId -> claim token (private 'hstoken' message, #14 ownership check)
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
  Input.resetLocalPlayers();
  clearResume();
  $('#game').classList.remove('on'); $('#roomscreen').classList.remove('on'); $('#session').classList.remove('on');
  $('#lobby').style.display = ''; $('#touch').classList.remove('on');
  document.body.classList.remove('gc-playing'); // touch/scroll hygiene (#31), see client/style.css
  document.body.classList.remove('gc-menu-open'); // close the mobile Leave/chat panel (#42) if it was open
  $('#hud-menu')?.setAttribute('aria-expanded', 'false');
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); // don't leave a run stuck in fullscreen
  releaseWakeLock();
  if (reason) toast('Left the dungeon', reason);
  loadRooms();
  history.replaceState(null, '', '/');
}
$('#leave').onclick = () => { if (G.ws) G.ws.send(JSON.stringify({ t: 'leave' })); leaveGame(); };

function onMessage(m) {
  switch (m.t) {
    // Arcade high scores (#14): private per-connection claim token for our own just-ended run,
    // sent ahead of the room-wide 'gameover' broadcast — see server/game/room.js endRun().
    case 'hstoken': G.hsTokens.set(m.runId, m.token); break;
    case 'welcome':
      G.pid = m.pid; G.room = m.room; G.inRoom = true; G.reconnecting = false; G.reconnectAttempts = 0;
      if (m.guestId && m.guestId !== guestId) { guestId = m.guestId; try { localStorage.setItem(GUEST_KEY, guestId); } catch {} }
      saveResume(m.room, m.pid, m.resume);
      $('#lobby').style.display = 'none'; $('#session').classList.add('on');
      if (m.room.state === 'lobby') {
        $('#roomscreen').classList.add('on'); $('#game').classList.remove('on'); $('#touch').classList.remove('on');
        document.body.classList.remove('gc-playing');
      } else {
        // Resuming (reconnect, or a deep link into a room already in progress) drops straight into
        // the game view, same as 'start' below — same mobile layout/wake-lock hooks apply (#31).
        $('#roomscreen').classList.remove('on'); $('#game').classList.add('on'); $('#touch').classList.add('on');
        document.body.classList.add('gc-playing');
        acquireWakeLock();
      }
      layoutGame();
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
      document.body.classList.add('gc-playing'); // touch/scroll hygiene (#31)
      layoutGame();
      acquireWakeLock();
      renderCountdown(null);
      if (G.room?.mode === 'death' && !hasSeen('death_mode')) playScene('death_mode', { onDone: () => markSeen('death_mode') });
      break;
    case 'level':
      G.level = m; G.grid = m.rows.map((r) => r.split(''));
      G.prev = G.cur = null; G.fx = []; G.sealed = !!m.sealed; G.bonus = null;
      G.tileChangedAt.clear();
      G.keyCount = 0; G.foodShotCount = 0;
      G.overlay = { kind: 'level', title: `LEVEL ${m.index}`, sub: m.name, until: performance.now() + 2500 };
      log(`<span class="n">Level ${m.index}: ${esc(m.name)}</span> <span class="muted">${esc(m.description || '')}</span>`);
      if (m.index > 1) say('level_n', `Let's see how you do in level ${m.index}`);
      sfx('level');
      if ([10, 25, 50].includes(m.index)) playScene(`level_milestone_${m.index}`);
      break;
    case 'bonus':
      G.bonus = { total: m.seconds, startedAt: performance.now() };
      G.overlay = m.mystery
        ? { kind: 'bonus', title: 'MYSTERY ROOM!', sub: 'The exit is hidden — find it or the switch', until: performance.now() + 2500 }
        : { kind: 'bonus', title: 'BONUS ROUND!', sub: 'Grab treasure — any exit will do', until: performance.now() + 2500 };
      log(m.mystery
        ? '<span class="n">Mystery treasure room! The exit is hidden — find the switch or clear every treasure tile.</span>'
        : '<span class="n">Bonus treasure room! Grab everything before time runs out.</span>');
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
      // Arcade high scores (#14): the server tells us via the matching scores[] entry whether our
      // own run just cracked the all-time top 10 (server/game/room.js endRun()).
      const mine = m.scores.find((s) => s.pid === G.pid);
      if (mine?.hs && mine.runId != null) {
        const hsToken = G.hsTokens.get(mine.runId);
        G.hsTokens.delete(mine.runId);
        showInitialsModal({ runId: mine.runId, score: mine.score, token: hsToken });
      }
      releaseWakeLock(); // run's over — release now rather than waiting out the 6s gameover overlay
      setTimeout(() => {
        $('#game').classList.remove('on'); $('#roomscreen').classList.add('on'); $('#touch').classList.remove('on');
        document.body.classList.remove('gc-playing');
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
    case 'welcome_local': Input.onWelcomeLocal(m); break; // ack for an extra local gamepad hero (#15)
  }
}

function onEvent(e) {
  const mine = e.pid === G.pid;
  const info = G.players.get(e.pid);
  const name = info?.name || '';
  const hLabel = heroLabel(info);
  switch (e.type) {
    case 'tile':
      if (G.grid) G.grid[e.y][e.x] = e.c;
      if (e.c === '.') G.fx.push({ kind: 'puff', x: e.x + 0.5, y: e.y + 0.5, t: 0 });
      // A hidden exit revealed (#13) turns into a real exit tile in place — same glow a timed exit
      // wall gets when its own countdown fires (see the 'timedWall' case below).
      else if (e.c === 'E') G.fx.push({ kind: 'magic', x: e.x + 0.5, y: e.y + 0.5, t: 0, r: 1.4 });
      G.tileChangedAt.set(e.x + ',' + e.y, performance.now()); // brief dissolve/appear flash, see render()
      break;
    case 'plate':
      sfx('door');
      log(name ? `<span class="n">${esc(name)} triggered a pressure plate — walls crumble!</span>` : '<span class="n">A pressure plate triggers — walls crumble!</span>');
      break;
    case 'timedWall':
      G.fx.push({ kind: e.becomes === 'E' ? 'magic' : 'puff', x: e.x + 0.5, y: e.y + 0.5, t: 0, r: 1.4 });
      sfx(e.becomes === 'E' ? 'level' : 'door');
      break;
    case 'reveal':
      log('<span class="n">The hidden exits are revealed!</span>');
      sfx('level');
      break;
    case 'it':
      if (mine) {
        G.overlay = { kind: 'it', title: "YOU'RE IT!", sub: 'Monsters are coming for you', until: performance.now() + 2500 };
        sfx('level');
        say('you_are_it', 'You are It!');
      } else {
        log(`<span class="n">${esc(name || 'Someone')} is now It!</span>`);
      }
      break;
    case 'kill': G.fx.push({ kind: 'die', x: e.x, y: e.y, t: 0, m: e.monster }); if (mine) sfx(e.monster ? 'kill_' + e.monster : 'kill'); break;
    case 'generator': G.fx.push({ kind: 'boom', x: e.x + 0.5, y: e.y + 0.5, t: 0 }); sfx('boom'); if (mine) G.shake = 0.3; break;
    case 'pickup': {
      const amuletKind = AMULET_TILES[e.item];
      const boostStat = BOOST_TILES[e.item];
      if (mine) {
        if (amuletKind) {
          sfx('amulet');
          // Each branch passes say() a literal id (see test/voice.test.js's simple id scan) rather
          // than a computed one, so every amulet line is verified against voice-lines.json.
          if (amuletKind === 'invis') say('amulet_invis', 'Invisibility!');
          else if (amuletKind === 'reflect') say('amulet_reflect', 'Reflective shots!');
          else if (amuletKind === 'repulse') say('amulet_repulse', 'Repulsion!');
          else if (amuletKind === 'super') say('amulet_super', 'Super shots!');
        } else if (boostStat) { sfx('boost'); say('boost_pickup', 'Permanent power up!'); }
        else sfx(e.item === 'T' ? 'coin' : e.item === 'K' ? 'key' : (e.item === 'F' || e.item === 'C') ? 'eat' : 'pick');
        if (e.item === 'K') { G.keyCount++; if (G.keyCount === 3) say('save_keys', 'Save keys for later levels'); }
      }
      if (amuletKind) log(`<span class="n">${esc(name)} picked up ${esc(AMULET_NAMES[amuletKind])}!</span>`);
      else if (boostStat) log(`<span class="n">${esc(name)} found a permanent ${esc(BOOST_NAMES[boostStat])} boost!</span>`);
      break;
    }
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
    case 'stun': log(`<span class="n">${esc(name)} got stunned!</span>`); if (mine) sfx('stun'); break;
    case 'spark': G.fx.push({ kind: 'spark', x: e.x, y: e.y, t: 0 }); if (Math.random() < 0.5) sfx('spark'); break;
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
$('#rs-itmode').onchange = () => {
  if (G.ws && G.ws.readyState === 1) G.ws.send(JSON.stringify({ t: 'settings', itMode: $('#rs-itmode').checked }));
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
    $('#rs-itmode').checked = !!room.itMode;
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
// Touch d-pad/auto-fire UI and Gamepad API handling (mobile layout + local multiplayer, #15) live
// in client/input.js; it owns the #touch layout end-to-end (replacing the old inline touch dpad).
Input.initInput({
  getWs: () => G.ws, isInRoom: () => G.inRoom, log, say,
  sendInput: (extra) => sendInput(extra),
});
function sendInput(extra = {}) {
  if (!G.ws || G.ws.readyState !== 1) return;
  const ext = Input.getPrimaryState(); // touch + gamepad-0 + auto-fire, merged with the keyboard below
  const kx = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
  const ky = (keys.has('s') || keys.has('arrowdown') ? 1 : 0) - (keys.has('w') || keys.has('arrowup') ? 1 : 0);
  const dx = kx || ext.dx, dy = ky || ext.dy;
  const fire = keys.has(' ') || keys.has('control') || ext.fire;
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
  if (G.intermission && !G.intermission.pickSent) {
    const rect = cv.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * (VIEW_W / rect.width);
    const y = (ev.clientY - rect.top) * (VIEW_H / rect.height);
    for (const r of G.intermission.rects) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { pickChest(r.id); break; }
    }
    return;
  }
  // Tap-to-continue (#31): the "INSERT COIN" death screen otherwise only listens for Enter, which
  // a touch player has no way to press — a tap anywhere on the canvas does the same thing. Harmless
  // for a mouse user too (there's nothing else to click on that screen).
  const mine = G.cur?.p.find((p) => p[0] === G.pid);
  if (mine && mine[8]) sendInput({ respawn: true });
});

// ---------------- mobile-responsive canvas fit, fullscreen, wake lock (#31, reworked by #42) ----------------
// Everything below is additive to the desktop rendering path above: on a wide, mouse-driven
// viewport layoutGame() puts the canvas back to its native 640x480 backing store and lets the
// existing CSS (.cv-wrap's aspect-ratio box) drive sizing exactly as before. Only once the
// "(max-width: 900px), (pointer: coarse)" media query matches (phones/tablets, and desktop windows
// narrow enough to be worth treating the same way) does it take over. Before #42, `.stage`'s own
// measured box already excluded the nav bar, main's padding and the chat log/bar/help row below it
// (CSS gave `.stage` `flex: 1 1 auto` inside a viewport-height `#session`); #42 turned that flexbox
// column into a CSS grid spanning the whole game screen instead (`#game`/`.stage` go `display:
// contents` while playing — see client/style.css's "body.gc-playing" block — so their children
// become direct grid items alongside `#log`/`#touch`), which means `.stage` no longer generates a
// box to measure at all. `#session` (the grid container, and the fullscreen target below) takes
// its place, and `#log`'s height now has to be measured and subtracted explicitly too (`logH`) —
// see client/layout.js's computeCanvasLayout() doc comment for why.
const sessionEl = $('#session');
const cvWrap = document.querySelector('.cv-wrap');
const hudEl = $('#hud');
const logEl = $('#log');
const touchEl = $('#touch');
const fsBtn = $('#fs-toggle');
const menuBtn = $('#hud-menu');
const rotateHint = $('#rotate-hint');
let rotateHintDismissed = false;
let touchActive = false; // cached shouldShowTouch() result, refreshed in layoutGame() (see below)
const CONTROLS_MIN_H = 130; // see layoutGame()'s controlsH — matches client/style.css's grid minmax(110px, 1fr) plus a small margin

function viewportSize() {
  const vv = window.visualViewport;
  return vv ? { w: Math.round(vv.width), h: Math.round(vv.height) } : { w: window.innerWidth, h: window.innerHeight };
}

function resetDesktopCanvas() {
  cv.style.width = ''; cv.style.height = '';
  if (cv.width !== VIEW_W || cv.height !== VIEW_H) { cv.width = VIEW_W; cv.height = VIEW_H; ctx.imageSmoothingEnabled = false; }
  if (sceneCv && (sceneCv.width !== VIEW_W || sceneCv.height !== VIEW_H)) { sceneCv.width = VIEW_W; sceneCv.height = VIEW_H; }
}

// Portrait/tablet "band" sizing constants (post-#31 follow-up review). DPAD_PAD_V is the controls
// band's own top+bottom padding (client/style.css gives #touch this exact padding, so the two stay
// in lock-step) and DPAD_GAP matches .input-dpad's CSS gap (also shared with the landscape
// "overlay" d-pad's separate fixed 80px/gap-8 rule — see client/style.css) — both used for the
// *height* budget below pretty much as the review specified. The *width* budget is not the review's
// literal "floor((viewportW * 0.58 - 2*gap) / 3)": on a 412px-wide phone (Pixel 7) 58% of the
// viewport can't fit three 90px cells no matter how gap/padding are tuned (3*90 alone is already
// 270px, more than 0.58*412=239px) — short of both the ">= 90px at a >= 380px band" requirement
// this same review adds to test/e2e-mobile.mjs and the "~110px on Pixel 7" example it gives. What
// actually shares the row with the d-pad is the fire/potion/auto-fire column, whose own width is
// itself cell-dependent (FIRE_MULT below) — cellFromWidthBudget() solves that joint constraint
// directly (verified against real devices below) rather than reserving an independent width
// fraction that can't account for it.
const DPAD_PAD_V = 16, DPAD_GAP = 8, TOUCH_SIDE_PAD = 6, TOUCH_COL_GAP = 4, FIRE_CAP = 110, FIRE_MULT = 1.3;
// Overlay mode's #touch keeps client/index.html's base `.touch` rule (position: fixed, anchored
// `bottom: 10px + safe-area-inset-bottom`) rather than the band layout's own padding — that bottom
// offset has to come out of the height budget too (plus a couple of px of rounding slack), or a
// d-pad sized to exactly fill "vh - hudH" ends up anchored 10px+ *higher* than assumed and climbs
// into the HUD strip regardless of how small the cell itself is capped. Deliberately ignores actual
// safe-area-inset-bottom (unreadable from plain JS without a live probe element) — a real notch
// there would need slightly more, but none of the devices this game supports have one in landscape.
const OVERLAY_BOTTOM_OFFSET = 12;
// .input-dpad's own CSS padding in this mode (client/index.html's "@media (orientation: landscape)
// and (max-height: 500px)" rule — the translucent backing box around the pad) adds this much on
// *both* top and bottom of the d-pad's rendered height, on top of the cells/gaps themselves —
// forgetting it here undercounts the pad's real height by 2*OVERLAY_DPAD_PAD and reintroduces the
// exact HUD-overlap this whole function exists to prevent.
const OVERLAY_DPAD_PAD = 6;
// The actions column (fire, the auto-fire pill, potion, stacked) is bottom-anchored in the same
// fixed box as the d-pad, so it needs the same "clear the HUD/#log strip stacked at the top" check
// — its own non-fire overhead (auto-fire pill height + the column's own two internal gaps +
// top/bottom padding, all from .input-actions's CSS) measured empirically at ~68px, since the
// auto-fire label can wrap onto a second line at this column's width, making it awkward to derive
// from the individual CSS values exactly.
const OVERLAY_ACTIONS_OVERHEAD = 68;

/** The largest d-pad cell (unfloored, uncapped) that leaves enough width for the fire/potion column
 *  it sits beside — `TOUCH_SIDE_PAD*2 + TOUCH_COL_GAP + DPAD_GAP*2` is everything *else* horizontal
 *  in the row (#touch's own side padding, the gap between the d-pad and action columns, and the
 *  d-pad's own two internal gaps); what's left splits between `3` d-pad cells and one fire/potion
 *  circle (`FIRE_MULT` cell-widths wide, per the spec, until it hits its own `FIRE_CAP`). Solved as
 *  two linear regimes rather than guessed at: while the fire diameter implied by `cell` is still
 *  under FIRE_CAP, growing cell grows both cell*3 and cell*FIRE_MULT together (denominator `3 +
 *  FIRE_MULT`); once fire would exceed FIRE_CAP it's pinned there instead, so from that point only
 *  the d-pad's own `3*cell` keeps growing against the remaining width. */
function cellFromWidthBudget(vw) {
  const overhead = TOUCH_SIDE_PAD * 2 + TOUCH_COL_GAP + DPAD_GAP * 2;
  const uncappedFireCell = (vw - overhead) / (3 + FIRE_MULT);
  if (uncappedFireCell * FIRE_MULT <= FIRE_CAP) return uncappedFireCell;
  return (vw - overhead - FIRE_CAP) / 3;
}

/** Sizes the on-screen d-pad cells and fire/potion buttons from the *actual* height (and, via
 *  cellFromWidthBudget(), width) available to them — never raw vw alone, which is what let a fire/
 *  potion/auto-fire overflow off-screen on a narrow phone pre-#42 (client/index.html's clamp() is
 *  now only a same-origin fallback for a frame where this hasn't run yet).
 *
 *  `availH` means two different things depending on `overlayControls`, both supplied by the
 *  caller: in the normal portrait/tablet "band" layout it's `controlsAvailH` — computeCanvasLayout's
 *  leftover height below the fitted canvas (client/layout.js); in the short-landscape "overlay"
 *  layout (no reserved band — the pad floats over the canvas edges instead) it's `vh - hudH - logH`,
 *  the room the *floating* d-pad and fire/potion/auto-fire column must fit inside without climbing
 *  over the HUD strip and the translucent #log strip stacked right under it (both real, opaque
 *  content there too — only the canvas is meant to be floated over). Overlay's own 80px/gap-8 CSS
 *  cap (client/style.css's ".gc-controls-overlay .input-dpad" rule) and fire/potion's existing
 *  ~84px CSS fallback are both a *ceiling* ("may stay in the right margin as they are" per the #42
 *  follow-up review) — this only shrinks either *below* that on the tightest supported viewport
 *  (iPhone SE landscape, 320px tall total), where even those defaults don't clear the HUD/#log
 *  stacked at the top. */
function layoutTouchControls(touchShown, overlayControls, availH, vw) {
  if (!touchEl) return;
  if (!touchShown) { touchEl.style.removeProperty('--dpad-cell'); touchEl.style.removeProperty('--fire-size'); return; }
  if (overlayControls) {
    const overlayCell = Math.max(1, Math.min(80, Math.floor((availH - OVERLAY_BOTTOM_OFFSET - OVERLAY_DPAD_PAD * 2 - DPAD_GAP * 2) / 3)));
    touchEl.style.setProperty('--dpad-cell', overlayCell + 'px');
    const overlayFire = Math.max(1, Math.min(84, Math.floor((availH - OVERLAY_BOTTOM_OFFSET - OVERLAY_ACTIONS_OVERHEAD) / 2)));
    touchEl.style.setProperty('--fire-size', overlayFire + 'px');
    return;
  }
  const cellFromHeight = (availH - DPAD_PAD_V * 2 - DPAD_GAP * 2) / 3;
  const cellFromWidth = cellFromWidthBudget(vw);
  // No lower floor: the #42 spec's cap (120px) is only ever a *ceiling* here (`Math.min(120, ...)`)
  // — clamping a *minimum* on top, as an earlier version of this did, would force cells back up
  // past whatever space the math just proved is actually available, overflowing on the smallest
  // supported viewport (iPhone SE) exactly the way raw vw units used to everywhere. iPhone SE's
  // own ~211px band naturally degrades this to its old ~50-55px cells (height-bound there, not
  // width-bound) without any special-casing.
  const cell = Math.max(1, Math.min(120, Math.floor(Math.min(cellFromHeight, cellFromWidth))));
  touchEl.style.setProperty('--dpad-cell', cell + 'px');
  const fire = Math.max(1, Math.min(FIRE_CAP, Math.floor(cell * FIRE_MULT)));
  touchEl.style.setProperty('--fire-size', fire + 'px');
}

function layoutGame() {
  touchActive = Input.shouldShowTouch(location.search, matchMedia('(pointer: coarse)').matches);
  if (!$('#game').classList.contains('on') || !sessionEl || !cvWrap) { if (menuBtn) menuBtn.hidden = true; return; }
  const mobile = matchMedia('(max-width: 900px), (pointer: coarse)').matches;
  if (menuBtn) menuBtn.hidden = !mobile; // the mobile-only "reach Leave/Chat" button (#42) — see client/style.css
  if (!mobile) {
    resetDesktopCanvas(); if (rotateHint) rotateHint.hidden = true;
    document.body.classList.remove('gc-controls-overlay');
    if (touchEl) { touchEl.style.removeProperty('--dpad-cell'); touchEl.style.removeProperty('--fire-size'); }
    return;
  }

  const { w: vw, h: vh } = viewportSize();
  const portrait = vh >= vw;
  // Portrait reserves a band below the canvas for the d-pad; landscape *phones* (short viewport)
  // instead let it overlay the canvas edges, matching the CSS "@media (orientation: landscape) and
  // (max-height: 500px)" rule that gives the pad a translucent backing specifically so it stays
  // legible over whatever's rendered underneath — so nothing needs to be subtracted from the fit
  // there. That rule (and this check) must stay in lock-step: a landscape *tablet* is tall enough
  // to miss the 500px breakpoint (no translucent backing), so it needs the same reserved band
  // portrait gets — treating every landscape viewport as "overlay" regardless of height used to
  // leave a fully-opaque d-pad sitting on top of the canvas there with nothing subtracted from the
  // fit, genuinely overlapping it (caught by test/e2e-mobile.mjs's #34 canvas-geometry scenario on
  // a landscape iPad). client/style.css keys its own grid-vs-overlay split off this same class.
  // Toggled *before* measuring #hud/#log below (rather than after, as an earlier version of this
  // did) so a portrait->landscape-overlay transition never measures a stale, previous-mode #log
  // height — #log's own rendered size differs between the two (client/style.css).
  const overlayControls = !portrait && vh <= 500;
  document.body.classList.toggle('gc-controls-overlay', overlayControls);

  const sessionBox = sessionEl.getBoundingClientRect(); // the grid container's own box (post safe-area padding) — see the doc comment above
  const hudH = hudEl ? hudEl.getBoundingClientRect().height : 0;
  const logH = logEl ? logEl.getBoundingClientRect().height : 0;
  const touchShown = !!touchEl && touchEl.classList.contains('on') && getComputedStyle(touchEl).display !== 'none';
  // A fixed reservation, not touchEl's own measured height (#31's original approach): #42 sizes
  // the d-pad/fire/potion *from* the band's leftover height (layoutTouchControls() below), so
  // feeding that same rendered height back in here as the *estimate* for how much to reserve would
  // be circular — a slightly-too-generous reservation on one pass shrinks the canvas, which grows
  // the leftover, which grows the controls, which grows next pass's reservation, and so on, with no
  // guarantee of converging back to "use the full width". CONTROLS_MIN_H matches the grid's own
  // `minmax(110px, 1fr)` floor (client/style.css) plus a little breathing room: the fit only needs
  // to guarantee *at least* that much room exists, since the grid's flexible row gives the band
  // whatever's actually left — always >= this minimum, usually quite a bit more on anything but the
  // shortest phones. Irrelevant in overlay mode: the pad there is a fixed-size CSS overlay (below),
  // not sized from any reserved band, so nothing needs reserving from the canvas fit at all.
  const controlsH = touchShown && !overlayControls ? CONTROLS_MIN_H : 0;
  // In overlay mode #log no longer claims its own grid row (client/style.css) — it floats over the
  // top of the canvas instead (translucent, 2 lines) — so the canvas fit shouldn't reserve room
  // for it there; only in the normal band layout does logH still need subtracting.
  const fitLogH = overlayControls ? 0 : logH;

  const layout = computeCanvasLayout({
    vw: sessionBox.width, vh: sessionBox.height, hudH, logH: fitLogH, controlsH,
    levelW: VIEW_W, levelH: VIEW_H, dpr: window.devicePixelRatio || 1,
  });
  cv.style.width = layout.width + 'px';
  cv.style.height = layout.height + 'px';
  if (cv.width !== layout.backingWidth || cv.height !== layout.backingHeight) {
    cv.width = layout.backingWidth; cv.height = layout.backingHeight; ctx.imageSmoothingEnabled = false;
  }
  if (sceneCv && (sceneCv.width !== layout.backingWidth || sceneCv.height !== layout.backingHeight)) {
    sceneCv.width = layout.backingWidth; sceneCv.height = layout.backingHeight;
  }

  // Overlay mode reserves nothing in the canvas fit (controlsH is 0 there, see above) — the canvas
  // itself gets the full vh-hudH, since #log there is a translucent overlay drawn *over* the top of
  // it (client/style.css), not a reserved row. But the bottom-anchored d-pad still has to clear
  // both real, opaque strips stacked at the top of the screen (HUD, then #log right under it) —
  // its own budget is `vh - hudH - logH`, not just `vh - hudH`.
  layoutTouchControls(touchShown, overlayControls, overlayControls ? Math.max(0, vh - hudH - logH) : layout.controlsAvailH, vw);

  if (rotateHint) {
    const tooShort = vh < 360;
    if (!tooShort) rotateHintDismissed = false;
    rotateHint.hidden = !tooShort || rotateHintDismissed;
  }
}
$('#rotate-hint-dismiss')?.addEventListener('click', () => { rotateHintDismissed = true; layoutGame(); });
window.addEventListener('resize', layoutGame);
window.addEventListener('orientationchange', () => setTimeout(layoutGame, 60));
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', layoutGame);
  window.visualViewport.addEventListener('scroll', layoutGame);
}

// ---------------- fullscreen + mobile menu toggles (#31, reworked by #42) ----------------
// Feature-detected rather than assumed: iOS Safari has no Fullscreen API for arbitrary elements
// (only <video>), so the button stays hidden there instead of doing nothing when tapped. Requests
// fullscreen on #session (HUD + canvas + log + controls) rather than .cv-wrap (canvas alone, the
// pre-#42 target) — the whole reason the old fullscreen view went black outside the canvas.
if (fsBtn) {
  const fsSupported = !!(sessionEl?.requestFullscreen && document.fullscreenEnabled);
  fsBtn.hidden = !fsSupported;
  if (fsSupported) {
    fsBtn.onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      else sessionEl.requestFullscreen?.().catch(() => {});
    };
    document.addEventListener('fullscreenchange', () => {
      fsBtn.classList.toggle('on', !!document.fullscreenElement);
      fsBtn.title = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
      layoutGame(); // re-lay-out on every transition, per #42 — HUD/log/controls must reflow to the new box, not just the canvas
    });
  }
}
if (menuBtn) {
  menuBtn.onclick = () => {
    const open = document.body.classList.toggle('gc-menu-open');
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
}

// ---------------- Screen Wake Lock (#31) ----------------
// Best-effort: unsupported browsers, a backgrounded tab, or a user/OS policy denial all just throw
// or resolve falsy here, and are silently ignored either way — the game works identically without it.
let wakeLock = null;
async function acquireWakeLock() {
  try { wakeLock = (await navigator.wakeLock?.request?.('screen')) || null; } catch { wakeLock = null; }
}
function releaseWakeLock() { try { wakeLock?.release(); } catch {} wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && G.inRoom && $('#game').classList.contains('on')) acquireWakeLock();
});
layoutGame(); // sets the initial touchActive/rotate-hint state even before any room is joined

function lerpSnap(now) {
  if (!G.cur) return null;
  // tw (#11 timed walls) is never interpolated -- like g (generators) and it (It mode's tagged
  // monster id, #13), its entries don't move/aren't positional, so this always passes the latest
  // snapshot's value straight through. Omitting it here used to mean snap.tw was always undefined
  // (only p/m/b/g were ever copied onto the returned object), so the timed-wall pulse below always
  // fell back to its "no data yet" default instead of ever reading the real remaining-seconds
  // countdown the server actually sends every tick.
  if (!G.prev) return { p: G.cur.p, m: G.cur.m, b: G.cur.b, g: G.cur.g, it: G.cur.it, tw: G.cur.tw };
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
  return { p: lerpList(G.prev.p, G.cur.p, 0, 1, 2), m: lerpList(G.prev.m, G.cur.m, 0, 2, 3), b: lerpList(G.prev.b, G.cur.b, 0, 1, 2), g: G.cur.g, it: G.cur.it, tw: G.cur.tw };
}

let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  Input.poll(); // gamepad state, ~60 Hz (#15)
  const dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
  // Everything below draws in the fixed 640x480 logical coordinate space it always has; this one
  // transform (#31) is what makes that correct again after layoutGame() resizes the canvas's real
  // backing store (cv.width/height) to fit a phone's viewport at devicePixelRatio — a no-op
  // identity transform on desktop, where the backing store still just is VIEW_W x VIEW_H.
  ctx.setTransform(cv.width / VIEW_W, 0, 0, cv.height / VIEW_H, 0, 0);
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
    if (c === T.ACID) {
      // Cheap 2-frame boil animation (#12) — no per-tile state needed, just alternate on the clock.
      ctx.drawImage(sprite(Math.floor(now / 280) % 2 === 0 ? 'acid' : 'acid2'), x * TS, y * TS, TS, TS);
      continue;
    }
    if (c === T.FORCE_FIELD) {
      // Translucent energy bars (#12) with a slow shimmer; never blocks movement, only shots.
      ctx.globalAlpha = 0.5 + 0.18 * Math.sin(now / 240 + x + y);
      ctx.drawImage(sprite('forcefield'), x * TS, y * TS, TS, TS);
      ctx.globalAlpha = 1;
      continue;
    }
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
    if (PLATE_TINT[c]) { ctx.drawImage(sprite(name, PLATE_TINT[c]), x * TS, y * TS, TS, TS); }
    else ctx.drawImage(sprite(name), x * TS, y * TS, TS, TS);
    if (name === 'timedwall') {
      // pulse faster the less time is left (#11) — falls back to a slow default pulse if the
      // snapshot hasn't reported this tile's remaining seconds yet (e.g. mid-transition).
      const tw = snap.tw && snap.tw.find((t) => t[0] === x && t[1] === y);
      const left = tw ? tw[2] : 30;
      const speed = 260 - Math.min(220, (30 - Math.min(30, left)) * 7);
      ctx.fillStyle = `rgba(255,220,120,${0.18 + 0.18 * Math.sin(now / speed)})`;
      ctx.fillRect(x * TS, y * TS, TS, TS);
    }
    // brief dissolve/appear flash (#11): a fading white highlight right after a tile changes.
    const changedAt = G.tileChangedAt.get(x + ',' + y);
    if (changedAt != null) {
      const age = now - changedAt;
      if (age < 260) { ctx.globalAlpha = Math.max(0, 1 - age / 260) * 0.55; ctx.fillStyle = '#fff'; ctx.fillRect(x * TS, y * TS, TS, TS); ctx.globalAlpha = 1; }
      else G.tileChangedAt.delete(x + ',' + y);
    }
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
    if (m[6] > 0) drawStunStars(m[2] * TS, m[3] * TS, now); // stun tile (#12): frozen — see snapshot()
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
    if (p[11] > 0 && !p[8]) drawStunStars(p[1] * TS, p[2] * TS, now); // stun tile (#12): frozen hero
    // It tag mode (#13): a pulsing gold ring plus a small crown glyph over whoever's currently It.
    if (snap.it === p[0] && !p[8]) {
      const px = p[1] * TS, py = p[2] * TS;
      const pulse = 1 + Math.sin(now / 180) * 0.12;
      ctx.strokeStyle = '#f2c400'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, TS * 0.62 * pulse, 0, Math.PI * 2); ctx.stroke();
      ctx.font = '12px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = '#f2c400';
      ctx.fillText('👑', px, py - TS / 2 - 12);
    }
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
    } else if (f.kind === 'boom' || f.kind === 'die' || f.kind === 'puff' || f.kind === 'spark') {
      const n = f.kind === 'boom' ? 10 : f.kind === 'spark' ? 5 : 6;
      const col = f.kind === 'boom' ? '#ff8c1a' : f.kind === 'die' ? '#f4f4f4' : f.kind === 'spark' ? '#5cd6ff' : '#9a9aa8';
      ctx.fillStyle = col; ctx.globalAlpha = Math.max(0, 1 - f.t * (f.kind === 'spark' ? 4 : 2));
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; const d = f.t * 60 * (f.kind === 'boom' ? 1.6 : f.kind === 'spark' ? 0.8 : 1); ctx.fillRect(px + Math.cos(a) * d - 2, py + Math.sin(a) * d - 2, 4, 4); }
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
    if (Math.floor(now / 500) % 2) {
      ctx.fillStyle = '#f2c400'; ctx.font = '14px monospace';
      // Touch layout (#31): there's no Enter key to press, but the whole canvas is a tap target
      // (see the click handler above), so say so instead of pointing at a key that doesn't exist.
      ctx.fillText(touchActive ? 'INSERT COIN — tap to continue' : 'INSERT COIN — press ENTER to continue', VIEW_W / 2, VIEW_H - 24);
    }
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
  // Mystery treasure rooms (#13): keep the "find the exit" reminder up for as long as any hidden
  // exit tile is still on the grid — once revealHiddenExits() flips them to real exits (via the
  // usual 'tile' events), G.grid no longer contains 'H' and this just stops drawing on its own.
  if (G.level?.mysteryRoom && G.grid?.some((row) => row.includes('H'))) {
    ctx.fillStyle = '#5cd6ff'; ctx.font = 'bold 13px monospace'; ctx.textAlign = 'center';
    ctx.fillText('MYSTERY ROOM: find the exit', VIEW_W / 2, G.bonus ? 38 : 20);
  }
  // It tag mode (#13): a persistent reminder for whoever's currently tagged, on top of the
  // one-shot overlay/crown — pulses slowly so it reads at a glance without being distracting.
  if (mine && !mine[8] && snap.it === G.pid) {
    ctx.fillStyle = Math.floor(now / 400) % 2 ? '#f2c400' : '#ffe27a';
    ctx.font = 'bold 16px monospace'; ctx.textAlign = 'center';
    ctx.fillText("YOU'RE IT!", VIEW_W / 2, VIEW_H - 14);
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

/** Stun tile (#12): a small ring of orbiting yellow stars over a frozen hero/monster — purely
 *  cosmetic, driven off the snapshot's per-entity remaining-stun-ticks field (see sim.js snapshot()). */
function drawStunStars(cx, cy, now) {
  ctx.fillStyle = '#f2c400';
  for (let i = 0; i < 3; i++) {
    const a = now / 180 + i * (Math.PI * 2 / 3);
    const sx = cx + Math.cos(a) * TS * 0.4, sy = cy - TS * 0.6 + Math.sin(a) * TS * 0.15;
    ctx.fillRect(sx - 2, sy - 2, 4, 4);
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
  // Header row (#42): level + timer together at the top, ahead of the player rows — the mobile
  // grid layout (client/style.css's "body.gc-playing" block) turns this into the HUD strip's thin
  // header, with #fs-toggle/#hud-menu pinned over its right side (they're separate static
  // elements, not part of this regenerated markup, so their click handlers survive every
  // renderHud() call — see the fullscreen/menu wiring below). Desktop keeps #hud-time pinned to
  // the sidebar's bottom via CSS (`.hud-head` only changes layout under the mobile media query).
  hud.innerHTML = `<div class="hud-head"><span class="lvl" id="hud-lvl"></span><span id="hud-time"></span></div>` + [...G.players.values()].map((p) => {
    const color = playerColor(p);
    // Compact HUD (#31, <700px width or a short landscape phone): the icon badge + health bar
    // stand in for the full name/HEALTH/SCORE block that the wide layout shows instead — see
    // client/style.css's "game screen / mobile" block for which parts CSS hides at that breakpoint.
    const initial = (heroLabel(p) || p.name || '?').trim().charAt(0).toUpperCase() || '?';
    return `
    <div class="pp ${p.away ? 'away' : ''}" data-pid="${p.id}" style="border-color:${color}">
      <div class="pp-head">
        <span class="ic" style="background:${color}">${esc(initial)}</span>
        <div class="pp-names">
          <div class="nm" style="color:${color}">${esc(p.name)}${p.id === G.pid ? ' (you)' : ''}${p.away ? ' <span class="muted">(away)</span>' : ''}</div>
          <div class="muted sub" style="font-size:11px">${esc(heroLabel(p))}${p.title ? ` &middot; <span class="rk">Rank ${p.rank} ${esc(p.title)}</span>` : ''}</div>
        </div>
      </div>
      <div class="pp-vitals">
        <div class="hpbar"><i></i></div>
        <div class="pp-nums"><span>HP <b class="hp">0</b></span><span>SC <b class="sc">0</b></span></div>
      </div>
      <div class="muted kp" style="font-size:12px">🔑 <span class="k">0</span> &nbsp; 🧪 <span class="po">0</span></div>
      ${p.boosts?.length ? `<div class="boosts" title="Active chest boosts this level">${p.boosts.map((b) => BOOST_ICONS[b] || '✨').join(' ')}</div>` : ''}
      <div class="runboosts" title="Permanent run boosts"></div>
      <div class="amulets" title="Active amulets"></div>
    </div>`;
  }).join('');
  layoutGame(); // the HUD's own height feeds the canvas-fit math (#31) — re-measure after it changes
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
    // Compact-HUD health bar (#31): START_HEALTH is 2000 (see test/e2e.mjs's reconnect scenario);
    // boosts/armor can push a hero's effective max a bit past that, so this is an approximation,
    // purely cosmetic — clamped so an over-full bar never renders past 100%.
    const bar = el.querySelector('.hpbar i'); if (bar) bar.style.width = Math.max(0, Math.min(100, (p[4] / 2000) * 100)) + '%';
    el.classList.toggle('low', p[4] < LOW_HEALTH && !p[8]); el.classList.toggle('dead', !!p[8]);
    el.classList.toggle('it', s.it === p[0] && !p[8]); // It tag mode (#13)
    // Acid puddle (#12): tint the HUD card while standing on one — read straight off the tile grid
    // rather than a snapshot flag, since the client already tracks it for rendering.
    const onAcid = !p[8] && G.grid?.[Math.floor(p[2])]?.[Math.floor(p[1])] === 'a';
    el.classList.toggle('acid', onAcid);
    el.classList.toggle('stunned', p[11] > 0 && !p[8]);
    // 10th element: run-boost pip string (one letter per stack, see sim.js's encodeBoosts).
    const rb = el.querySelector('.runboosts');
    if (rb) rb.innerHTML = [...(p[9] || '')].map((ch) => RUN_BOOST_ICON[BOOST_TILES[ch]] || '✨').join(' ');
    // 11th element: active-amulet string, pairs of (letter, 2-digit seconds remaining) — see
    // sim.js's encodeAmulets — rendered as an icon plus a live countdown.
    const am = el.querySelector('.amulets');
    if (am) {
      const parts = [];
      const re = /([A-Z])(\d{2})/g; let mm;
      while ((mm = re.exec(p[10] || ''))) {
        const kind = AMULET_TILES[mm[1]];
        parts.push(`${AMULET_ICON[kind] || '✨'} ${Number(mm[2])}s`);
      }
      am.innerHTML = parts.join(' &nbsp; ');
    }
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

// Lobby idle -> attract mode (#14): only while nobody's joined a room yet.
startIdleAttract(() => !G.inRoom);
