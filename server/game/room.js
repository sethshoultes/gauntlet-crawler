import crypto from 'node:crypto';
import { Sim } from './sim.js';
import { LEVEL1 } from '../../shared/levels/level1.js';
import { generateLevel } from '../../shared/procgen.js';
import { TICK_RATE, DT, MAX_PLAYERS, CLASSES } from '../../shared/constants.js';
import { rankForXp, rankTitle, perksForRank, XP_KILL, XP_GENERATOR, XP_TREASURE, xpForLevelClear } from '../../shared/progression.js';
import * as stats from '../stats.js';
import { db } from '../db.js';

const SPEEDRUN_SECONDS = 45;
const LEVEL_CHANGE_DELAY_MS = 2500;
const AWAY_GRACE_MS = 30000;    // how long a disconnected player's slot is held before a real leave
const COUNTDOWN_SECONDS = 5;    // auto-start countdown once everyone is ready

export class Room {
  constructor({ id, name, seed, source = { type: 'campaign' }, isPublic = true, onEmpty }) {
    this.id = id; this.name = name; this.seed = seed; this.source = source; this.isPublic = isPublic;
    this.onEmpty = onEmpty;
    this.clients = new Map(); // pid -> {ws, pid, user, name, cls, joinedAt, streak, ready, away, resume, ...}
    this.levelIndex = 1;
    this.pendingEvents = [];
    this.createdAt = Date.now();
    this.state = 'lobby'; // 'lobby' | 'playing'
    this.hostPid = null;
    this.kickedIds = new Set(); // 'u<userId>' for logged-in players kicked from this room
    this.countdownTimer = null;
    this.countdownSeconds = 0;
    this.sim = new Sim(this.levelFor(1), { levelIndex: 1, onEvent: (e) => this.onEvent(e) });
    this.timer = setInterval(() => this.tick(), 1000 / TICK_RATE);
    this.secondsTimer = setInterval(() => this.creditTime(), 30000);
    this.changing = false;
    this.emptySince = null;
  }

  levelFor(n) {
    if (n === 1) {
      if (this.source.type === 'custom' && this.source.level) return this.source.level;
      return LEVEL1;
    }
    return generateLevel({ seed: this.seed, level: n });
  }

  get playerCount() { return this.clients.size; }
  get full() { return this.clients.size >= MAX_PLAYERS; }

  info() {
    return {
      id: this.id, name: this.name, players: this.playerCount, max: MAX_PLAYERS, state: this.state,
      level: this.levelIndex, levelName: this.sim.level.name, source: this.source.type,
      mode: this.source.type, customLevel: this.source.type === 'custom' && this.source.level
        ? { id: this.source.levelId || null, name: this.source.level.name } : null,
      customName: this.source.level?.name || null, public: this.isPublic, hostPid: this.hostPid,
      roster: [...this.clients.values()].map((c) => ({
        pid: c.pid, name: c.name, cls: c.cls, rank: c.rank, title: c.title,
        ready: !!c.ready, away: !!c.away, host: c.pid === this.hostPid,
      })),
    };
  }

  send(c, msg) { if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); }
  broadcast(msg) { const s = JSON.stringify(msg); for (const c of this.clients.values()) if (c.ws && c.ws.readyState === 1) c.ws.send(s); }
  broadcastRoom() { this.broadcast({ t: 'room', room: this.info() }); }
  playersPacket() {
    return { t: 'players', list: this.sim.playerInfo().map((p) => ({ ...p, away: !!this.clients.get(p.id)?.away })) };
  }

  // ---------- joining / reconnecting ----------
  join(ws, { pid, user, name, cls, resume }) {
    if (resume) {
      const c = this.resume(ws, resume);
      if (c) return c;
    }
    if (this.full) throw new Error('Room is full');
    if (user && this.kickedIds.has('u' + user.id)) throw new Error('You were removed from this room');
    let rank = null, title = null, perks = null;
    if (user) {
      rank = rankForXp(stats.getStats(user.id).xp || 0);
      title = rankTitle(rank);
      perks = perksForRank(rank);
    }
    const c = {
      ws, pid, user, name, cls, joinedAt: Date.now(), streak: 0, rank, title, perks,
      ready: false, away: false, awaySince: null, awayTimer: null, resume: crypto.randomBytes(8).toString('hex'),
    };
    this.clients.set(pid, c);
    if (!this.hostPid) this.hostPid = pid;
    this.emptySince = null;
    if (this.state === 'playing') this.enterGame(c);
    this.send(c, { t: 'welcome', pid, resume: c.resume, room: this.info() });
    if (this.state === 'playing') this.send(c, this.sim.levelPacket());
    this.broadcastRoom();
    if (this.state === 'playing') this.broadcast(this.playersPacket());
    this.broadcast({ t: 'notice', text: `${name} the ${cap(cls)} enters the dungeon` });
    this.checkAutoStart();
    return c;
  }

  /** Re-attach a disconnected client's ws using its resume token. Returns the client, or null. */
  resume(ws, token) {
    for (const c of this.clients.values()) {
      if (c.away && c.resume === token) {
        if (c.awayTimer) { clearTimeout(c.awayTimer); c.awayTimer = null; }
        c.ws = ws; c.away = false; c.awaySince = null;
        this.send(c, { t: 'welcome', pid: c.pid, resume: c.resume, room: this.info(), resumed: true });
        if (this.state === 'playing') this.send(c, this.sim.levelPacket());
        this.broadcastRoom();
        if (this.state === 'playing') this.broadcast(this.playersPacket());
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
    if (this.state === 'playing') this.broadcast(this.playersPacket());
    c.awayTimer = setTimeout(() => this.leave(pid), AWAY_GRACE_MS);
  }

  /** Move a lobby client into the running sim (on start, or on late join into a live room). */
  enterGame(c) {
    this.sim.addPlayer(c.pid, { name: c.name, cls: c.cls, userId: c.user?.id || null, perks: c.perks, rank: c.rank, title: c.title });
    if (c.user) {
      const fresh = stats.raise(c.user.id, `class_${c.cls}`, 1);
      const played = db.prepare("SELECT COUNT(*) AS n FROM stats WHERE user_id = ? AND key LIKE 'class_%' AND value > 0").get(c.user.id).n;
      this.unlock(c, [...fresh, ...stats.raise(c.user.id, 'classes_played', played)]);
      this.unlock(c, stats.raise(c.user.id, 'deepest_level', this.levelIndex));
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

  setHero(pid, cls) {
    const c = this.clients.get(pid);
    if (!c || this.state !== 'lobby' || !CLASSES[cls]) return;
    c.cls = cls;
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
    } else if (mode) {
      throw new Error('Unknown mode');
    }
    if (typeof isPublic === 'boolean') this.isPublic = isPublic;
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
    this.countdownTimer = setInterval(() => {
      this.countdownSeconds--;
      if (this.countdownSeconds <= 0) { clearInterval(this.countdownTimer); this.countdownTimer = null; this.beginPlay(); return; }
      this.broadcast({ t: 'countdown', seconds: this.countdownSeconds });
    }, 1000);
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
      stats.recordRun(c.user.id, { cls: c.cls, score: p.score, level: this.levelIndex, kills: p.kills, seconds: Math.round((Date.now() - c.joinedAt) / 1000) });
      stats.raise(c.user.id, 'best_score', p.score);
    }
    this.clients.delete(pid);
    this.sim.removePlayer(pid);
    if (this.hostPid === pid) this.migrateHost();
    this.broadcastRoom();
    this.broadcast(this.playersPacket());
    this.broadcast({ t: 'notice', text: `${c.name} has left` });
    if (this.clients.size === 0) this.emptySince = Date.now();
    else this.checkAutoStart();
  }

  handleInput(pid, input) { this.sim.setInput(pid, input); }

  chat(pid, text) {
    const c = this.clients.get(pid);
    if (!c) return;
    this.broadcast({ t: 'chat', from: c.name, text: String(text).slice(0, 200) });
  }

  creditTime() {
    for (const c of this.clients.values()) if (c.user) this.unlock(c, stats.bump(c.user.id, 'seconds_played', 30));
  }

  unlock(c, fresh) {
    for (const a of fresh) {
      this.send(c, { t: 'ach', ach: { id: a.id, name: a.name, icon: a.icon, desc: a.desc } });
      this.broadcast({ t: 'notice', text: `${c.name} unlocked ${a.icon} ${a.name}` });
    }
  }

  /** Award XP to a logged-in client and announce a rank-up if it just happened. Guests earn nothing. */
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
    }
  }

  onEvent(e) {
    if (e.type !== 'sound') this.pendingEvents.push(e); else if (this.pendingEvents.length < 40) this.pendingEvents.push(e);
    const c = e.pid != null ? this.clients.get(e.pid) : null;
    const uidOf = c?.user?.id || null;
    const bump = (k, n = 1) => { if (uidOf && c) this.unlock(c, stats.bump(uidOf, k, n)); };
    switch (e.type) {
      case 'kill': bump('kills'); bump(`kills_${e.monster}`); this.awardXp(c, uidOf, XP_KILL[e.monster] || 5); break;
      case 'generator': bump('generators'); this.awardXp(c, uidOf, XP_GENERATOR); break;
      case 'food': bump('food'); if (e.lowHealth) bump('food_low'); break;
      case 'food_shot': bump('food_shot'); break;
      case 'pickup': if (e.item === 'T') { bump('treasure'); this.awardXp(c, uidOf, XP_TREASURE); } if (e.item === 'K') bump('keys'); break;
      case 'door': bump('doors'); break;
      case 'secret': bump('secrets'); break;
      case 'potion': if (!e.weak) bump('potions'); break;
      case 'death': bump('deaths'); if (c) c.streak = 0; break;
      case 'coin': bump('coins'); break;
      case 'exit': this.onLevelComplete(e); break;
    }
  }

  onLevelComplete(e) {
    if (this.changing) return;
    this.changing = true;
    const n = this.clients.size;
    for (const c of this.clients.values()) {
      const p = this.sim.players.get(c.pid);
      if (!p) continue;
      if (p.levelDeaths === 0) c.streak++; else c.streak = 0;
      if (!c.user) continue;
      const u = c.user.id;
      this.awardXp(c, u, xpForLevelClear(this.levelIndex));
      const fresh = [
        ...stats.bump(u, 'levels_cleared'),
        ...stats.raise(u, 'deepest_level', this.levelIndex + 1),
        ...(e.levelTime < SPEEDRUN_SECONDS ? stats.bump(u, 'speed_clears') : []),
        ...(p.levelKills === 0 ? stats.bump(u, 'pacifist_clears') : []),
        ...(n === MAX_PLAYERS ? stats.bump(u, 'squad_clears') : []),
        ...(n === 1 ? stats.bump(u, 'solo_clears') : []),
        ...stats.raise(u, 'no_death_clears', c.streak),
        ...stats.raise(u, 'best_score', p.score),
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
    this.broadcast({ t: 'levelclear', by: who?.name || '?', level: this.levelIndex, time: Math.round(e.levelTime), next: this.levelIndex + 1 });
    setTimeout(() => {
      this.levelIndex++;
      this.sim.loadLevel(this.levelFor(this.levelIndex), this.levelIndex);
      this.broadcast(this.sim.levelPacket());
      this.broadcast(this.playersPacket());
      this.changing = false;
    }, LEVEL_CHANGE_DELAY_MS);
  }

  tick() {
    if (this.clients.size === 0) {
      if (this.emptySince && Date.now() - this.emptySince > 30000) this.close();
      return;
    }
    if (this.state !== 'playing') return; // lobby: frozen, nothing to simulate yet
    this.sim.step(DT);
    const snap = this.sim.snapshot();
    if (this.pendingEvents.length) { snap.e = this.pendingEvents; this.pendingEvents = []; }
    this.broadcast(snap);
  }

  close() {
    clearInterval(this.timer); clearInterval(this.secondsTimer);
    this.cancelCountdown();
    for (const c of this.clients.values()) { if (c.awayTimer) clearTimeout(c.awayTimer); this.send(c, { t: 'kicked', reason: 'Room closed' }); }
    this.onEmpty?.(this);
  }
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
