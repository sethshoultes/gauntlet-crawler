// A running dungeon: one Room per game, owning a Sim, the tick loop, level progression (campaign,
// procedural, Death mode, bonus treasure rooms), the chest intermission, and the stats/achievement
// hooks that fire as players play.
import crypto from 'node:crypto';
import { Sim } from './sim.js';
import { LEVEL1 } from '../../shared/levels/level1.js';
import { generateLevel, generateTreasureRoom } from '../../shared/procgen.js';
import { TICK_RATE, DT, MAX_PLAYERS, MAX_MONSTERS, CLASSES, T } from '../../shared/constants.js';
import { rankForXp, rankTitle, perksForRank, levelCapForRank, XP_KILL, XP_GENERATOR, XP_TREASURE, xpForLevelClear } from '../../shared/progression.js';
import { makeRng } from '../../shared/rng.js';
import { rollChests, applyChest } from '../../shared/chests.js';
import { isClassUnlocked, isPaletteUnlocked, unlockedFor, requirementText, PALETTE_BY_ID } from '../../shared/unlocks.js';
import * as stats from '../stats.js';
import { db } from '../db.js';
import { resolveCustomHero } from '../heroes.js';

const CUSTOM_CLS_RE = /^custom:(\d+)$/;

const SPEEDRUN_SECONDS = 45;
const LEVEL_CHANGE_DELAY_MS = 2500;
const AWAY_GRACE_MS = 30000;    // how long a disconnected player's slot is held before a real leave
const COUNTDOWN_SECONDS = 5;    // auto-start countdown once everyone is ready
const INTERMISSION_SECONDS = 15; // how long players get to pick a chest before auto-pick
const INTERMISSION_REVEAL_MS = 2000; // grace period after everyone has picked, before the next level loads
const WAVE_BANNER_SECONDS = 3;   // "WAVE N" banner shown before a wave's monsters actually spawn
const WAVE_TIMEOUT_MS = 40000;  // a wave advances automatically after this even if not fully cleared
const WIPE_GRACE_MS = 10000;    // Death mode: end the run if everyone stays dead this long, uncontested
const WAVE_SPAWN_MIN_DIST = 6;  // tiles a wave spawn must be from every player
const TREASURE_ROOM_SECONDS = 30; // bonus level timer (README's "Features" section, "Bonus treasure rooms") — auto-completes with no bonus at 0

export class Room {
  constructor({ id, name, seed, source = { type: 'campaign' }, isPublic = true, onEmpty }) {
    this.id = id; this.name = name; this.seed = seed; this.source = source; this.isPublic = isPublic;
    this.onEmpty = onEmpty;
    this.clients = new Map(); // pid -> {ws, pid, user, name, cls, joinedAt, streak, ready, away, resume, ...}
    this.levelIndex = 1;
    this.pendingEvents = [];
    this.createdAt = Date.now();
    this.state = 'lobby'; // 'lobby' | 'playing' | 'intermission'
    this.hostPid = null;
    this.kickedIds = new Set(); // 'u<userId>' for logged-in players kicked from this room
    this.countdownTimer = null;
    this.countdownSeconds = 0;
    this.levelChangeTimer = null;    // level-clear celebration delay, before intermission opens
    this.intermissionTimer = null;   // per-second countdown ticker
    this.intermissionEndTimer = null; // the reveal-then-advance timeout
    this.intermissionSeconds = 0;
    this.intermissionEnding = false;
    this.chestOffers = new Map(); // pid -> chest[] offered this intermission (hidden contents)
    this.chestPicks = new Map();  // pid -> chest picked this intermission
    // ---- Death mode wave state (see startWaves() and friends below) ----
    this.waveCount = 0; this.waveNum = 0;
    this.waveMonsterIds = null;   // Set<monsterId> — null while no wave is in flight
    this.waveBannerTimer = null;  // "WAVE N" banner delay before monsters actually spawn
    this.waveTimer = null;        // forces the wave to advance after WAVE_TIMEOUT_MS
    this.allDeadSince = null;     // Death mode wipe-timeout tracking
    this.pendingSkip = 1;         // set by a skip-exit ('8'), consumed by advanceLevel() (see README's "Level format" section)
    this.treasureTimer = null;    // bonus-level 30s auto-complete timer (README's "Features" section, "Bonus treasure rooms")
    this.sim = new Sim(this.levelFor(1), {
      levelIndex: 1, onEvent: (e) => this.onEvent(e), mode: this.source.type === 'death' ? 'death' : 'campaign',
      rng: makeRng(`${seed}|sim`),
    });
    this.timer = setInterval(() => this.tick(), 1000 / TICK_RATE);
    this.secondsTimer = setInterval(this.guard('creditTime', () => this.creditTime()), 30000);
    this.changing = false;
    this.emptySince = null;
  }

  /** Wrap a timer callback so an uncaught exception inside it is logged and contained instead of
   *  crashing the whole process (every setInterval/setTimeout in this class other than the main
   *  tick loop, which guards itself directly, goes through this). */
  guard(label, fn) {
    return (...args) => {
      try { fn(...args); } catch (e) { console.error(`[room ${this.id}] ${label} failed:`, e); }
    };
  }

  levelFor(n) {
    if (this.source.type === 'death') return generateLevel({ seed: this.seed, level: n, bias: this.deathBias(n) });
    if (this.isTreasureLevel(n)) return generateTreasureRoom({ seed: this.seed, level: n });
    if (n === 1) {
      if (this.source.type === 'custom' && this.source.level) return this.source.level;
      return LEVEL1;
    }
    return generateLevel({ seed: this.seed, level: n });
  }

  /** Bonus level (README's "Features" section, "Bonus treasure rooms"): every 6th level (i.e. after every 5 regular levels) in any non-Death mode
   *  is a generated treasure room instead — see shared/procgen.js generateTreasureRoom(). */
  isTreasureLevel(n) { return this.source.type !== 'death' && n > 1 && n % 6 === 0; }

  /** Death mode generator bias: arena layout, and monster mix shifting ghost -> grunt -> demon as
   *  the party goes deeper, with a Death appearing every 5th level. */
  deathBias(n) {
    const t = Math.min(1, n / 40);
    return { arena: true, monsters: 0.6, ghost: Math.max(0, 1 - t), grunt: 0.5 + t * 0.5, demon: t, death: n % 5 === 0 ? 1 : 0 };
  }

  /** Highest Death-mode level cap among the room's players (guests count as rank 1). */
  computeDeathCap() {
    let cap = 0;
    for (const c of this.clients.values()) cap = Math.max(cap, levelCapForRank(c.user ? (c.rank || 1) : 1));
    return cap || 99;
  }

  get playerCount() { return this.clients.size; }
  get full() { return this.clients.size >= MAX_PLAYERS; }

  info() {
    let deathCap = null;
    if (this.source.type === 'death') { const cap = this.computeDeathCap(); deathCap = Number.isFinite(cap) ? cap : null; } // Infinity isn't JSON-safe
    return {
      id: this.id, name: this.name, players: this.playerCount, max: MAX_PLAYERS, state: this.state,
      level: this.levelIndex, levelName: this.sim.level.name, source: this.source.type,
      mode: this.source.type, deathCap, customLevel: this.source.type === 'custom' && this.source.level
        ? { id: this.source.levelId || null, name: this.source.level.name } : null,
      customName: this.source.level?.name || null, public: this.isPublic, hostPid: this.hostPid,
      roster: [...this.clients.values()].map((c) => ({
        pid: c.pid, name: c.name, cls: c.cls, palette: c.palette, rank: c.rank, title: c.title,
        ready: !!c.ready, away: !!c.away, host: c.pid === this.hostPid,
        custom: c.custom || undefined, weapon: c.classDef?.weapon || undefined,
      })),
    };
  }

  send(c, msg) { if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); }
  broadcast(msg) { const s = JSON.stringify(msg); for (const c of this.clients.values()) if (c.ws && c.ws.readyState === 1) c.ws.send(s); }
  broadcastRoom() { this.broadcast({ t: 'room', room: this.info() }); }
  playersPacket() {
    return { t: 'players', list: this.sim.playerInfo().map((p) => ({ ...p, away: !!this.clients.get(p.id)?.away })) };
  }

  // ---------- character unlocks (shared/unlocks.js) ----------
  /** This user's unlock-evaluation profile (stats/achievements/rank). Guests get null, which
   *  shared/unlocks.js treats as base-classes-only, no palettes. */
  profileFor(user) {
    if (!user) return null;
    const s = stats.getStats(user.id);
    return { stats: s, achievements: stats.getAchievementIds(user.id), rank: rankForXp(s.xp || 0) };
  }

  /** Validate a requested hero/palette against what `user` has actually unlocked. Anything
   *  locked (or an unknown class) silently falls back to warrior/no-palette, and `error` carries
   *  a human message for the client toast — same rule for `join` and the in-lobby `hero` switch.
   *  A `cls` of `custom:<heroId>` (Hero Builder — see README.md "Hero Builder") takes a separate
   *  path: it never falls through to `CLASSES`, since it names a row in the `heroes` table, not a
   *  fixed archetype. */
  pickHero(user, cls, palette) {
    const customId = typeof cls === 'string' ? cls.match(CUSTOM_CLS_RE)?.[1] : null;
    if (customId != null) {
      const resolved = resolveCustomHero(customId, user);
      if (!resolved.ok) return { cls: 'warrior', palette: null, error: resolved.error, classDef: null, custom: null };
      return { cls, palette: null, error: null, classDef: resolved.classDef, custom: { ...resolved.hero, color: resolved.classDef.color } };
    }
    const profile = this.profileFor(user);
    const requestedCls = CLASSES[cls] ? cls : 'warrior';
    let outCls = requestedCls, error = null;
    if (!isClassUnlocked(requestedCls, profile)) {
      error = `That hero is locked: ${requirementText({ requires: CLASSES[requestedCls].requires })}`;
      outCls = 'warrior';
    }
    const outPalette = this.resolvePalette(profile, outCls, palette);
    if (palette && !outPalette && !error) {
      const p = PALETTE_BY_ID[palette];
      if (p) error = `That palette is locked: ${requirementText({ requires: p.requires })}`;
    }
    return { cls: outCls, palette: outPalette, error, classDef: null, custom: null };
  }

  resolvePalette(profile, cls, palette) {
    if (!palette) return null;
    const p = PALETTE_BY_ID[palette];
    if (!p || p.cls !== cls) return null;
    return isPaletteUnlocked(palette, profile) ? palette : null;
  }

  /** Catalogue items newly present in `after` but not `before` (see unlockedFor) — used to push
   *  `{t:'unlock'}` toasts when an achievement or rank-up opens something new mid-session. */
  diffUnlocks(before, after) {
    const out = [];
    for (const id of after.classes) if (!before.classes.has(id)) {
      const c = CLASSES[id];
      out.push({ type: 'hero', id, cls: id, name: c.hero, color: c.color });
    }
    for (const id of after.palettes) if (!before.palettes.has(id)) {
      const p = PALETTE_BY_ID[id];
      out.push({ type: 'palette', id, cls: p.cls, name: p.name, color: p.color });
    }
    return out;
  }

  // ---------- joining / reconnecting ----------
  /** Guest identity token: 16 random bytes as lowercase hex (32 chars). Issued once per guest on
   *  their first join and echoed back on every later one so a host kick can durably block them —
   *  this is the only thing it is ever used for; it grants no other trust. */
  isValidGuestId(id) { return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id); }

  join(ws, { pid, user, name, cls, resume, palette, guestId }) {
    if (resume) {
      const c = this.resume(ws, resume);
      if (c) return c;
    }
    if (this.full) throw new Error('Room is full');
    if (user && this.kickedIds.has('u' + user.id)) throw new Error('You were removed from this room');
    const requestedGuestId = this.isValidGuestId(guestId) ? guestId : null;
    if (!user && requestedGuestId && this.kickedIds.has('g' + requestedGuestId)) throw new Error('You were removed from this room');
    const finalGuestId = user ? null : (requestedGuestId || crypto.randomBytes(16).toString('hex'));
    let rank = null, title = null, perks = null;
    if (user) {
      rank = rankForXp(stats.getStats(user.id).xp || 0);
      title = rankTitle(rank);
      perks = perksForRank(rank);
    }
    const picked = this.pickHero(user, cls, palette);
    const c = {
      ws, pid, user, name, cls: picked.cls, palette: picked.palette, classDef: picked.classDef || null, custom: picked.custom || null,
      guestId: finalGuestId, joinedAt: Date.now(), streak: 0, rank, title, perks,
      ready: false, away: false, awaySince: null, awayTimer: null, resume: crypto.randomBytes(8).toString('hex'),
    };
    this.clients.set(pid, c);
    if (!this.hostPid) this.hostPid = pid;
    this.emptySince = null;
    if (this.state !== 'lobby') this.enterGame(c);
    this.send(c, { t: 'welcome', pid, resume: c.resume, guestId: c.guestId || undefined, room: this.info() });
    if (picked.error) this.send(c, { t: 'error', error: picked.error });
    if (this.state !== 'lobby') this.send(c, this.sim.levelPacket());
    if (this.state === 'intermission') this.offerChestsTo(c);
    this.broadcastRoom();
    if (this.state !== 'lobby') this.broadcast(this.playersPacket());
    const heroLabel = picked.custom ? picked.custom.name : cap(picked.cls);
    this.broadcast({ t: 'notice', text: `${name} the ${heroLabel} enters the dungeon` });
    this.checkAutoStart();
    return c;
  }

  /** Re-attach a disconnected client's ws using its resume token. Returns the client, or null. */
  resume(ws, token) {
    for (const c of this.clients.values()) {
      if (c.away && c.resume === token) {
        if (c.awayTimer) { clearTimeout(c.awayTimer); c.awayTimer = null; }
        c.ws = ws; c.away = false; c.awaySince = null;
        this.send(c, { t: 'welcome', pid: c.pid, resume: c.resume, guestId: c.guestId || undefined, room: this.info(), resumed: true });
        if (this.state !== 'lobby') this.send(c, this.sim.levelPacket());
        if (this.state === 'intermission' && !this.chestPicks.has(c.pid)) {
          const chests = this.chestOffers.get(c.pid);
          if (chests) this.send(c, { t: 'chests', seconds: this.intermissionSeconds, chests: chests.map((ch) => ({ id: ch.id, label: '???', icon: '📦' })) });
        }
        this.broadcastRoom();
        if (this.state !== 'lobby') this.broadcast(this.playersPacket());
        this.broadcast({ t: 'notice', text: `${c.name} reconnected` });
        return c;
      }
    }
    return null;
  }

  /** Called when a live socket drops. Keeps the player's slot/entity for a grace period. */
  disconnect(pid) {
    const c = this.clients.get(pid);
    if (!c || c.away) return;
    c.ws = null; c.away = true; c.awaySince = Date.now();
    this.broadcastRoom();
    if (this.state !== 'lobby') this.broadcast(this.playersPacket());
    if (this.state === 'intermission') this.checkIntermissionDone();
    c.awayTimer = setTimeout(this.guard('away-timeout leave', () => this.leave(pid)), AWAY_GRACE_MS);
  }

  /** Move a lobby client into the running sim (on start, or on late join into a live room). */
  enterGame(c) {
    this.sim.addPlayer(c.pid, {
      name: c.name, cls: c.cls, userId: c.user?.id || null, perks: c.perks, rank: c.rank, title: c.title,
      palette: c.palette, classDef: c.classDef || null, custom: c.custom || null,
    });
    if (c.user) {
      // Every custom hero shares one 'class_custom' stat key rather than one per hero id — an
      // unbounded, colon-bearing key per hero would be a poor fit for the classes_played/unlock
      // machinery below, which only ever knows about the fixed CLASSES roster anyway.
      const classKey = c.classDef ? 'class_custom' : `class_${c.cls}`;
      const fresh = stats.raise(c.user.id, classKey, 1);
      const played = db.prepare("SELECT COUNT(*) AS n FROM stats WHERE user_id = ? AND key LIKE 'class_%' AND value > 0").get(c.user.id).n;
      this.unlock(c, [...fresh, ...stats.raise(c.user.id, 'classes_played', played)]);
      this.unlock(c, stats.raise(c.user.id, this.source.type === 'death' ? 'deepest_death_level' : 'deepest_level', this.levelIndex));
    }
  }

  // ---------- lobby controls ----------
  setReady(pid, ready) {
    const c = this.clients.get(pid);
    if (!c || this.state !== 'lobby') return;
    c.ready = !!ready;
    this.broadcastRoom();
    this.checkAutoStart();
  }

  setHero(pid, cls, palette) {
    const c = this.clients.get(pid);
    if (!c || this.state !== 'lobby') return;
    const picked = this.pickHero(c.user, cls, palette);
    c.cls = picked.cls; c.palette = picked.palette; c.classDef = picked.classDef || null; c.custom = picked.custom || null;
    if (picked.error) this.send(c, { t: 'error', error: picked.error });
    this.broadcastRoom();
  }

  setSettings(pid, { mode, levelId, isPublic } = {}) {
    if (pid !== this.hostPid) throw new Error('Only the host can change settings');
    if (this.state !== 'lobby') throw new Error('Cannot change settings after start');
    if (mode === 'campaign') {
      this.source = { type: 'campaign' };
    } else if (mode === 'custom') {
      const row = db.prepare('SELECT id, name, description, rows FROM levels WHERE id = ? AND published = 1').get(Number(levelId));
      if (!row) throw new Error('Pick a published custom level');
      this.source = { type: 'custom', levelId: row.id, level: { name: row.name, description: row.description, rows: JSON.parse(row.rows) } };
    } else if (mode === 'death') {
      this.source = { type: 'death' };
    } else if (mode) {
      throw new Error('Unknown mode');
    }
    if (typeof isPublic === 'boolean') this.isPublic = isPublic;
    this.sim.mode = this.source.type === 'death' ? 'death' : 'campaign';
    this.sim.loadLevel(this.levelFor(1), 1);
    this.broadcastRoom();
  }

  start(byPid) {
    if (this.state !== 'lobby') throw new Error('Already started');
    if (byPid !== this.hostPid) throw new Error('Only the host can start');
    const allReady = this.clients.size <= 1 || [...this.clients.values()].every((c) => c.ready);
    if (!allReady) throw new Error('Everyone must be ready first');
    this.beginPlay();
  }

  beginPlay() {
    if (this.state === 'playing') return;
    this.cancelCountdown();
    this.state = 'playing';
    for (const c of this.clients.values()) this.enterGame(c);
    this.broadcastRoom();
    this.broadcast({ t: 'start' });
    this.broadcast(this.sim.levelPacket());
    this.broadcast(this.playersPacket());
    if (this.source.type === 'death') this.startWaves();
  }

  checkAutoStart() {
    if (this.state !== 'lobby') return;
    const n = this.clients.size;
    const allReady = n > 1 && [...this.clients.values()].every((c) => c.ready);
    if (allReady && !this.countdownTimer) this.beginCountdown();
    else if (!allReady && this.countdownTimer) this.cancelCountdown();
  }

  beginCountdown() {
    this.countdownSeconds = COUNTDOWN_SECONDS;
    this.broadcast({ t: 'countdown', seconds: this.countdownSeconds });
    this.countdownTimer = setInterval(this.guard('countdown tick', () => {
      this.countdownSeconds--;
      if (this.countdownSeconds <= 0) { clearInterval(this.countdownTimer); this.countdownTimer = null; this.beginPlay(); return; }
      this.broadcast({ t: 'countdown', seconds: this.countdownSeconds });
    }), 1000);
  }

  cancelCountdown() {
    if (!this.countdownTimer) return;
    clearInterval(this.countdownTimer); this.countdownTimer = null;
    this.broadcast({ t: 'countdown', seconds: null });
  }

  kick(byPid, targetPid) {
    if (byPid !== this.hostPid) throw new Error('Only the host can kick');
    if (targetPid === byPid) throw new Error("You can't kick yourself");
    const c = this.clients.get(targetPid);
    if (!c) return;
    if (c.user) this.kickedIds.add('u' + c.user.id);
    else if (c.guestId) this.kickedIds.add('g' + c.guestId);
    this.send(c, { t: 'kicked', reason: 'Removed by the host' });
    this.leave(targetPid);
  }

  migrateHost() {
    const remaining = [...this.clients.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    this.hostPid = remaining.length ? remaining[0].pid : null;
  }

  leave(pid) {
    const c = this.clients.get(pid);
    if (!c) return;
    if (c.awayTimer) { clearTimeout(c.awayTimer); c.awayTimer = null; }
    const p = this.sim.players.get(pid);
    if (c.user && p) {
      stats.recordRun(c.user.id, { cls: c.cls, score: p.score, level: this.levelIndex, kills: p.kills, seconds: Math.round((Date.now() - c.joinedAt) / 1000), mode: this.source.type === 'death' ? 'death' : 'campaign' });
      stats.raise(c.user.id, 'best_score', p.score);
    }
    this.clients.delete(pid);
    this.sim.removePlayer(pid);
    if (this.hostPid === pid) this.migrateHost();
    this.broadcastRoom();
    this.broadcast(this.playersPacket());
    this.broadcast({ t: 'notice', text: `${c.name} has left` });
    if (this.clients.size === 0) this.emptySince = Date.now();
    else { this.checkAutoStart(); if (this.state === 'intermission') this.checkIntermissionDone(); }
  }

  handleInput(pid, input) { this.sim.setInput(pid, input); }

  /** Test/manual-verification only, gated behind GAUNTLET_DEBUG=1 in server/index.js. */
  debugAction(action) {
    if (action === 'clear' && this.state === 'playing') {
      const anyPid = [...this.sim.players.keys()][0];
      if (anyPid != null) this.onEvent({ type: 'exit', pid: anyPid, levelTime: this.sim.levelTime });
    } else if (action === 'killall' && this.state === 'playing') {
      // Wipes every current monster — mainly useful to force a Death mode wave to advance instantly.
      for (const id of [...this.sim.monsters.keys()]) this.sim.monsters.delete(id);
    }
  }

  chat(pid, text) {
    const c = this.clients.get(pid);
    if (!c) return;
    const clean = String(text ?? '').trim().slice(0, 200);
    if (!clean) return;
    // Simple per-client throttle so one connection can't flood every player in the room.
    const now = Date.now();
    const recent = (c.chatTimes || []).filter((t) => now - t < 10_000);
    if (recent.length >= 10) return;
    recent.push(now); c.chatTimes = recent;
    this.broadcast({ t: 'chat', from: c.name, text: clean });
  }

  creditTime() {
    for (const c of this.clients.values()) if (c.user) this.unlock(c, stats.bump(c.user.id, 'seconds_played', 30));
  }

  /** Announce freshly-awarded achievements, then diff unlockedFor() before/after them to push
   *  any newly-opened hero/palette as a `{t:'unlock'}` toast. */
  unlock(c, fresh) {
    if (!fresh.length) return;
    let diff = [];
    if (c.user) {
      const profile = this.profileFor(c.user);
      const freshIds = new Set(fresh.map((a) => a.id));
      const beforeAch = new Set([...profile.achievements].filter((id) => !freshIds.has(id)));
      const before = unlockedFor({ ...profile, achievements: beforeAch });
      const after = unlockedFor(profile);
      diff = this.diffUnlocks(before, after);
    }
    for (const a of fresh) {
      this.send(c, { t: 'ach', ach: { id: a.id, name: a.name, icon: a.icon, desc: a.desc } });
      this.broadcast({ t: 'notice', text: `${c.name} unlocked ${a.icon} ${a.name}` });
    }
    for (const item of diff) this.send(c, { t: 'unlock', item });
  }

  /** Award XP to a logged-in client and announce a rank-up if it just happened. Guests earn
   *  nothing. A rank-up is also diffed through unlockedFor() for rank-gated unlocks. */
  awardXp(c, userId, amount) {
    if (!c || !userId || !amount) return;
    const { value, fresh } = stats.bumpXp(userId, amount);
    this.unlock(c, fresh);
    const oldRank = rankForXp(value - amount);
    const newRank = rankForXp(value);
    if (newRank > oldRank) {
      const title = rankTitle(newRank);
      c.rank = newRank; c.title = title;
      const p = this.sim.players.get(c.pid);
      if (p) { p.rank = newRank; p.title = title; p.perks = { ...p.perks, ...perksForRank(newRank) }; }
      this.send(c, { t: 'rankup', rank: newRank, title });
      this.broadcast({ t: 'notice', text: `${c.name} reached Rank ${newRank}: ${title}!` });
      this.broadcast(this.playersPacket());
      const profile = this.profileFor(c.user);
      const before = unlockedFor({ ...profile, rank: oldRank });
      const after = unlockedFor({ ...profile, rank: newRank });
      for (const item of this.diffUnlocks(before, after)) this.send(c, { t: 'unlock', item });
    }
  }

  onEvent(e) {
    if (e.type !== 'sound') this.pendingEvents.push(e); else if (this.pendingEvents.length < 40) this.pendingEvents.push(e);
    const c = e.pid != null ? this.clients.get(e.pid) : null;
    const uidOf = c?.user?.id || null;
    const bump = (k, n = 1) => { if (uidOf && c) this.unlock(c, stats.bump(uidOf, k, n)); };
    switch (e.type) {
      case 'kill': bump('kills'); bump(`kills_${e.monster}`); if (e.monster === 'thief') bump('thief_kills'); this.awardXp(c, uidOf, XP_KILL[e.monster] || 5); break;
      case 'generator': bump('generators'); this.awardXp(c, uidOf, XP_GENERATOR); break;
      case 'food': bump('food'); if (e.lowHealth) bump('food_low'); break;
      case 'food_shot': bump('food_shot'); break;
      case 'pickup': if (e.item === 'T') { bump('treasure'); this.awardXp(c, uidOf, XP_TREASURE); } if (e.item === 'K') bump('keys'); break;
      case 'door': bump('doors'); break;
      case 'secret': bump('secrets'); break;
      case 'potion': if (!e.weak) bump('potions'); break;
      case 'death': bump('deaths'); if (c) c.streak = 0; break;
      case 'coin': bump('coins'); break;
      case 'teleport': bump('teleports'); break;
      case 'exit': this.onLevelComplete(e); break;
    }
  }

  onLevelComplete(e) {
    if (this.changing) return;
    this.changing = true;
    if (this.treasureTimer) { clearTimeout(this.treasureTimer); this.treasureTimer = null; }
    const wasTreasure = this.sim.treasureRoom;
    const skipAmt = e.skip === 4 ? 4 : 1; // exit variant '8' jumps the party ahead 4 levels (see README's "Level format" section)
    this.pendingSkip = skipAmt;
    const n = this.clients.size;
    let totalKills = 0, anyDeaths = false;
    for (const c of this.clients.values()) {
      const p = this.sim.players.get(c.pid);
      if (!p) continue;
      totalKills += p.levelKills || 0;
      if (p.levelDeaths > 0) anyDeaths = true;
      if (p.levelDeaths === 0) c.streak++; else c.streak = 0;
      if (!c.user) continue;
      const u = c.user.id;
      this.awardXp(c, u, xpForLevelClear(this.levelIndex));
      // Death mode tracks its own depth stat so a grind there can't trivially unlock the
      // campaign-only Delver achievements (and vice versa).
      const depthKey = this.source.type === 'death' ? 'deepest_death_level' : 'deepest_level';
      const fresh = [
        ...stats.bump(u, 'levels_cleared'),
        ...stats.raise(u, depthKey, this.levelIndex + skipAmt),
        ...(e.levelTime < SPEEDRUN_SECONDS ? stats.bump(u, 'speed_clears') : []),
        ...(p.levelKills === 0 ? stats.bump(u, 'pacifist_clears') : []),
        ...(n === MAX_PLAYERS ? stats.bump(u, 'squad_clears') : []),
        ...(n === 1 ? stats.bump(u, 'solo_clears') : []),
        ...stats.raise(u, 'no_death_clears', c.streak),
        ...stats.raise(u, 'best_score', p.score),
        ...(wasTreasure ? stats.bump(u, 'treasure_rooms_cleared') : []),
      ];
      this.unlock(c, fresh);
    }
    if (this.source.type === 'custom' && this.levelIndex === 1 && this.source.levelId) {
      db.prepare('UPDATE levels SET plays = plays + 1 WHERE id = ?').run(this.source.levelId);
      const owner = db.prepare('SELECT owner_id FROM levels WHERE id = ?').get(this.source.levelId);
      if (owner) {
        const ownerPlaying = [...this.clients.values()].some((c) => c.user?.id === owner.owner_id);
        if (!ownerPlaying) stats.bump(owner.owner_id, 'level_plays');
      }
    }
    const who = this.clients.get(e.pid);
    this.broadcast({
      t: 'levelclear', by: who?.name || '?', level: this.levelIndex, time: Math.round(e.levelTime),
      next: this.levelIndex + skipAmt, kills: totalKills, deaths: anyDeaths ? 1 : 0,
    });
    // Death mode: clearing (or skip-jumping past) the rank-gated cap level ends the run (victory)
    // instead of continuing into another intermission/level — skip the chest pick entirely.
    const atCap = this.source.type === 'death' && (this.levelIndex + skipAmt) > this.computeDeathCap();
    this.levelChangeTimer = setTimeout(this.guard('level change', () => {
      this.levelChangeTimer = null;
      if (atCap) this.endRun('cap');
      else if (wasTreasure) this.advanceLevel();
      else this.startIntermission();
    }), LEVEL_CHANGE_DELAY_MS);
  }

  // ---------- chest intermission ----------
  /** Roll and send one player's hidden chest offer from the same seeded scheme (room seed +
   *  level index + pid) — used both to open the intermission for everyone already in the room
   *  and for a player who joins/resumes mid-intermission (#9, see join()/resume() above). Requires
   *  a sim entity to exist for them (enterGame() must already have run). */
  offerChestsTo(c) {
    if (!this.sim.players.has(c.pid)) return;
    const rng = makeRng(`${this.seed}|${this.levelIndex}|${c.pid}`);
    const chests = rollChests(rng, this.levelIndex);
    this.chestOffers.set(c.pid, chests);
    this.send(c, { t: 'chests', seconds: this.intermissionSeconds, chests: chests.map((ch) => ({ id: ch.id, label: '???', icon: '📦' })) });
  }

  /** Roll three hidden chest offers per player and open the pick window. */
  startIntermission() {
    if (this.levelChangeTimer) { clearTimeout(this.levelChangeTimer); this.levelChangeTimer = null; }
    this.state = 'intermission';
    this.intermissionEnding = false;
    this.chestOffers = new Map();
    this.chestPicks = new Map();
    this.intermissionSeconds = INTERMISSION_SECONDS;
    for (const c of this.clients.values()) this.offerChestsTo(c);
    this.broadcastRoom();
    this.intermissionTimer = setInterval(this.guard('intermission tick', () => {
      this.intermissionSeconds--;
      if (this.intermissionSeconds <= 0) {
        clearInterval(this.intermissionTimer); this.intermissionTimer = null;
        this.autoPickRemaining();
        this.finishIntermissionSoon();
      }
    }), 1000);
  }

  /** Client -> server chest pick. Rejects a second pick or an id not in that player's own offer. */
  pick(pid, id) {
    if (this.state !== 'intermission' || this.intermissionEnding) return;
    if (this.chestPicks.has(pid)) return;
    const offers = this.chestOffers.get(pid);
    if (!offers) return;
    const chest = offers.find((ch) => ch.id === id);
    if (!chest) return;
    this.commitPick(pid, chest);
  }

  /** Auto-pick a random offered chest for anyone (away or just slow) who hasn't chosen yet. */
  autoPickRemaining() {
    for (const c of this.clients.values()) {
      if (this.chestPicks.has(c.pid)) continue;
      const offers = this.chestOffers.get(c.pid);
      if (!offers || !offers.length) continue;
      this.commitPick(c.pid, offers[Math.floor(Math.random() * offers.length)]);
    }
  }

  commitPick(pid, chest) {
    this.chestPicks.set(pid, chest);
    const c = this.clients.get(pid);
    this.broadcast({ t: 'chestpick', pid, chest: { id: chest.id, kind: chest.kind, label: chest.label, icon: chest.icon, cursed: !!chest.cursed } });
    if (c?.user) {
      const fresh = [...stats.bump(c.user.id, 'chests_opened'), ...(chest.cursed ? stats.bump(c.user.id, 'cursed_chests') : [])];
      this.unlock(c, fresh);
    }
    this.checkIntermissionDone();
  }

  /** If every still-connected player has picked, end the intermission early after a short reveal. */
  checkIntermissionDone() {
    if (this.state !== 'intermission' || this.intermissionEnding) return;
    const connected = [...this.clients.values()].filter((cc) => !cc.away);
    if (connected.length > 0 && connected.every((cc) => this.chestPicks.has(cc.pid))) this.finishIntermissionSoon();
  }

  /** Everyone (connected) has picked — end the intermission early after a short reveal beat. */
  finishIntermissionSoon() {
    if (this.intermissionEnding) return;
    this.intermissionEnding = true;
    if (this.intermissionTimer) { clearInterval(this.intermissionTimer); this.intermissionTimer = null; }
    this.intermissionEndTimer = setTimeout(this.guard('finishIntermission', () => this.finishIntermission()), INTERMISSION_REVEAL_MS);
  }

  /** Apply every picked chest, then load the next level. Exposed directly for tests. */
  finishIntermission() {
    if (this.state !== 'intermission') return;
    if (this.intermissionTimer) { clearInterval(this.intermissionTimer); this.intermissionTimer = null; }
    if (this.intermissionEndTimer) { clearTimeout(this.intermissionEndTimer); this.intermissionEndTimer = null; }
    for (const [pid, chest] of this.chestPicks) {
      const p = this.sim.players.get(pid);
      if (p) applyChest(p, chest);
    }
    this.broadcast({ t: 'chestsdone' });
    this.chestOffers = new Map(); this.chestPicks = new Map();
    this.advanceLevel();
  }

  /** Load the next level (honoring a pending skip-exit jump — see README's "Level format" section) and, if it's a bonus treasure
   *  room (README's "Features" section, "Bonus treasure rooms"), start its 30s timer. Shared by the normal post-intermission path and the
   *  no-intermission path a treasure room takes straight from onLevelComplete(). */
  advanceLevel() {
    this.levelIndex += this.pendingSkip || 1;
    this.pendingSkip = 1;
    const treasure = this.isTreasureLevel(this.levelIndex);
    this.sim.loadLevel(this.levelFor(this.levelIndex), this.levelIndex, { treasureRoom: treasure });
    this.state = 'playing';
    this.changing = false;
    this.broadcast(this.sim.levelPacket());
    this.broadcast(this.playersPacket());
    this.broadcastRoom();
    if (treasure) { this.broadcast({ t: 'bonus', seconds: TREASURE_ROOM_SECONDS }); this.startTreasureTimer(); }
    if (this.source.type === 'death') this.startWaves();
  }

  /** Arm (or re-arm) the bonus-level auto-complete timer. */
  startTreasureTimer() {
    if (this.treasureTimer) { clearTimeout(this.treasureTimer); this.treasureTimer = null; }
    this.treasureTimer = setTimeout(this.guard('finishTreasureRoom', () => this.finishTreasureRoom()), TREASURE_ROOM_SECONDS * 1000);
  }

  /** The bonus level's timer ran out with nobody having found an exit: move on with no bonus,
   *  and — since a treasure room never offers chests — skip the intermission entirely. */
  finishTreasureRoom() {
    if (this.treasureTimer) { clearTimeout(this.treasureTimer); this.treasureTimer = null; }
    if (this.state !== 'playing' || this.changing || !this.sim.treasureRoom) return;
    this.changing = true;
    for (const c of this.clients.values()) if (c.user) this.unlock(c, stats.bump(c.user.id, 'treasure_rooms_cleared'));
    this.broadcast({ t: 'notice', text: 'Time is up in the treasure vault!' });
    this.pendingSkip = 1;
    this.advanceLevel();
  }

  // ---------- Death mode: timed waves, rank-gated cap, wipe/cap run-ending ----------
  /** Begin the wave loop for the level just loaded. Wave count grows with depth. */
  startWaves() {
    this.clearWaveTimers();
    this.waveCount = 3 + Math.floor(this.levelIndex / 5);
    this.waveNum = 0;
    this.waveMonsterIds = null;
    this.nextWave();
  }

  clearWaveTimers() {
    if (this.waveBannerTimer) { clearTimeout(this.waveBannerTimer); this.waveBannerTimer = null; }
    if (this.waveTimer) { clearTimeout(this.waveTimer); this.waveTimer = null; }
  }

  /** Advance to the next wave, or finish the level's wave set once they're all done. */
  nextWave() {
    this.waveNum++;
    if (this.waveNum > this.waveCount) { this.finishWaves(); return; }
    this.broadcast({ t: 'wave', n: this.waveNum, total: this.waveCount, seconds: WAVE_BANNER_SECONDS });
    this.waveBannerTimer = setTimeout(this.guard('spawnWave', () => { this.waveBannerTimer = null; this.spawnWave(); }), WAVE_BANNER_SECONDS * 1000);
  }

  /** Spawn this wave's monsters (mix shifts ghost -> grunt -> demon with depth; a Death appears
   *  on the level's first wave every 5th level) and arm the wave's forced-advance timeout. */
  spawnWave() {
    const n = Math.round(4 + this.levelIndex * 1.5);
    const t = Math.min(1, this.levelIndex / 40);
    const weights = { ghost: Math.max(0.15, 1 - t), grunt: 0.5 + t * 0.5, demon: 0.2 + t * 0.8 };
    const ids = new Set();
    for (let i = 0; i < n && this.sim.monsters.size < MAX_MONSTERS; i++) {
      const spot = this.farSpawnSpot();
      if (!spot) continue;
      const m = this.sim.spawnMonster(weightedPick(weights), spot[0] + 0.5, spot[1] + 0.5);
      if (m) ids.add(m.id);
    }
    if (this.levelIndex % 5 === 0 && this.waveNum === 1 && this.sim.monsters.size < MAX_MONSTERS) {
      const spot = this.farSpawnSpot();
      if (spot) { const m = this.sim.spawnMonster('death', spot[0] + 0.5, spot[1] + 0.5); if (m) ids.add(m.id); }
    }
    this.waveMonsterIds = ids;
    this.waveTimer = setTimeout(this.guard('checkWaveAdvance', () => this.checkWaveAdvance(true)), WAVE_TIMEOUT_MS);
  }

  /** A random floor tile at least WAVE_SPAWN_MIN_DIST tiles (Manhattan) from every player. */
  farSpawnSpot() {
    const sim = this.sim;
    const candidates = [];
    for (let y = 1; y < sim.h - 1; y++) for (let x = 1; x < sim.w - 1; x++) {
      if (sim.grid[y][x] !== T.FLOOR) continue;
      let ok = true;
      for (const p of sim.players.values()) if (Math.abs(p.x - (x + 0.5)) + Math.abs(p.y - (y + 0.5)) < WAVE_SPAWN_MIN_DIST) { ok = false; break; }
      if (ok) candidates.push([x, y]);
    }
    if (!candidates.length) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /** Called every tick while a wave is in flight, and once from the wave's own timeout. Advances
   *  once every spawned monster is dead, or unconditionally once the timeout fires. */
  checkWaveAdvance(fromTimeout) {
    if (!this.waveMonsterIds) return;
    const anyAlive = [...this.waveMonsterIds].some((id) => this.sim.monsters.has(id));
    if (anyAlive && !fromTimeout) return;
    if (this.waveTimer) { clearTimeout(this.waveTimer); this.waveTimer = null; }
    this.waveMonsterIds = null;
    for (const c of this.clients.values()) if (c.user) this.unlock(c, stats.bump(c.user.id, 'waves_cleared'));
    this.nextWave();
  }

  /** Every wave on this level is done: unseal the exit and let the party know. */
  finishWaves() {
    this.clearWaveTimers();
    this.waveMonsterIds = null;
    this.sim.exitSealed = false;
    this.broadcast({ t: 'exitopen' });
    this.broadcast({ t: 'notice', text: 'All waves cleared — the exit has opened!' });
  }

  /** Everyone has been dead for WIPE_GRACE_MS with nobody continuing — end the run. Death mode only. */
  checkWipe() {
    const players = [...this.sim.players.values()];
    if (!players.length) { this.allDeadSince = null; return; }
    const allDead = players.every((p) => p.dead);
    if (!allDead) { this.allDeadSince = null; return; }
    if (!this.allDeadSince) this.allDeadSince = Date.now();
    else if (Date.now() - this.allDeadSince >= WIPE_GRACE_MS) this.endRun('wipe');
  }

  /** End a Death mode run (cap reached, or a wipe): record each player's run, broadcast the
   *  result, and drop the room back to the lobby so the party can start another one. */
  endRun(reason) {
    if (this.state !== 'playing') return;
    this.clearWaveTimers();
    if (this.treasureTimer) { clearTimeout(this.treasureTimer); this.treasureTimer = null; }
    this.waveMonsterIds = null;
    this.allDeadSince = null;
    const cap = this.computeDeathCap();
    const scores = [...this.sim.players.values()].map((p) => ({ pid: p.id, name: p.name, cls: p.cls, score: p.score, kills: p.kills }));
    for (const c of this.clients.values()) {
      const p = this.sim.players.get(c.pid);
      if (!p || !c.user) continue;
      stats.recordRun(c.user.id, { cls: c.cls, score: p.score, level: this.levelIndex, kills: p.kills, seconds: Math.round((Date.now() - c.joinedAt) / 1000), mode: 'death' });
      this.unlock(c, stats.raise(c.user.id, 'best_score', p.score));
    }
    this.broadcast({ t: 'gameover', reason, level: this.levelIndex, cap: Number.isFinite(cap) ? cap : null, scores });
    for (const pid of [...this.sim.players.keys()]) this.sim.removePlayer(pid);
    this.state = 'lobby';
    this.levelIndex = 1;
    this.changing = false;
    for (const c of this.clients.values()) c.ready = false;
    this.sim.loadLevel(this.levelFor(1), 1);
    this.broadcastRoom();
  }

  tick() {
    // This runs off a raw setInterval (see the constructor) with nothing else between it and the
    // Node event loop: an uncaught exception here would crash the whole process, taking down
    // every room, not just this one. Contain it and keep the room alive for the next tick instead.
    try {
      if (this.clients.size === 0) {
        if (this.emptySince && Date.now() - this.emptySince > 30000) this.close();
        return;
      }
      if (this.state !== 'playing') return; // lobby: frozen, nothing to simulate yet
      this.sim.step(DT);
      if (this.source.type === 'death') { this.checkWaveAdvance(false); this.checkWipe(); }
      const snap = this.sim.snapshot();
      if (this.pendingEvents.length) { snap.e = this.pendingEvents; this.pendingEvents = []; }
      this.broadcast(snap);
    } catch (e) {
      console.error(`[room ${this.id}] tick() failed:`, e);
    }
  }

  close() {
    clearInterval(this.timer); clearInterval(this.secondsTimer);
    this.cancelCountdown();
    if (this.levelChangeTimer) clearTimeout(this.levelChangeTimer);
    if (this.intermissionTimer) clearInterval(this.intermissionTimer);
    if (this.intermissionEndTimer) clearTimeout(this.intermissionEndTimer);
    if (this.treasureTimer) clearTimeout(this.treasureTimer);
    this.clearWaveTimers();
    for (const c of this.clients.values()) { if (c.awayTimer) clearTimeout(c.awayTimer); this.send(c, { t: 'kicked', reason: 'Room closed' }); }
    this.onEmpty?.(this);
  }
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/** Weighted random pick from a {key: weight} map, e.g. Death mode's ghost/grunt/demon mix. */
function weightedPick(weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [k, w] of entries) { if (r < w) return k; r -= w; }
  return entries[entries.length - 1][0];
}
