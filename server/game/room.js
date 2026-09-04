import { Sim } from './sim.js';
import { LEVEL1 } from '../../shared/levels/level1.js';
import { generateLevel } from '../../shared/procgen.js';
import { TICK_RATE, DT, MAX_PLAYERS } from '../../shared/constants.js';
import { rankForXp, rankTitle, perksForRank, XP_KILL, XP_GENERATOR, XP_TREASURE, xpForLevelClear } from '../../shared/progression.js';
import * as stats from '../stats.js';
import { db } from '../db.js';

const SPEEDRUN_SECONDS = 45;
const LEVEL_CHANGE_DELAY_MS = 2500;

export class Room {
  constructor({ id, name, seed, source = { type: 'campaign' }, isPublic = true, onEmpty }) {
    this.id = id; this.name = name; this.seed = seed; this.source = source; this.isPublic = isPublic;
    this.onEmpty = onEmpty;
    this.clients = new Map(); // pid -> {ws, pid, user, name, cls, joinedAt, streak}
    this.levelIndex = 1;
    this.pendingEvents = [];
    this.createdAt = Date.now();
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
      id: this.id, name: this.name, players: this.playerCount, max: MAX_PLAYERS, level: this.levelIndex,
      levelName: this.sim.level.name, source: this.source.type, customName: this.source.level?.name || null, public: this.isPublic,
      roster: [...this.clients.values()].map((c) => ({ name: c.name, cls: c.cls, rank: c.rank, title: c.title })),
    };
  }

  send(c, msg) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); }
  broadcast(msg) { const s = JSON.stringify(msg); for (const c of this.clients.values()) if (c.ws.readyState === 1) c.ws.send(s); }

  join(ws, { pid, user, name, cls }) {
    if (this.full) throw new Error('Room is full');
    let rank = null, title = null, perks = null;
    if (user) {
      rank = rankForXp(stats.getStats(user.id).xp || 0);
      title = rankTitle(rank);
      perks = perksForRank(rank);
    }
    const c = { ws, pid, user, name, cls, joinedAt: Date.now(), streak: 0, rank, title };
    this.clients.set(pid, c);
    this.emptySince = null;
    this.sim.addPlayer(pid, { name, cls, userId: user?.id || null, perks, rank, title });
    this.send(c, { t: 'welcome', pid, room: this.info() });
    this.send(c, this.sim.levelPacket());
    this.broadcast({ t: 'players', list: this.sim.playerInfo() });
    this.broadcast({ t: 'notice', text: `${name} the ${cap(cls)} enters the dungeon` });
    if (user) {
      const fresh = stats.raise(user.id, `class_${cls}`, 1);
      const played = db.prepare("SELECT COUNT(*) AS n FROM stats WHERE user_id = ? AND key LIKE 'class_%' AND value > 0").get(user.id).n;
      this.unlock(c, [...fresh, ...stats.raise(user.id, 'classes_played', played)]);
      this.unlock(c, stats.raise(user.id, 'deepest_level', this.levelIndex));
    }
    return c;
  }

  leave(pid) {
    const c = this.clients.get(pid);
    if (!c) return;
    const p = this.sim.players.get(pid);
    if (c.user && p) {
      stats.recordRun(c.user.id, { cls: c.cls, score: p.score, level: this.levelIndex, kills: p.kills, seconds: Math.round((Date.now() - c.joinedAt) / 1000) });
      stats.raise(c.user.id, 'best_score', p.score);
    }
    this.clients.delete(pid);
    this.sim.removePlayer(pid);
    this.broadcast({ t: 'players', list: this.sim.playerInfo() });
    this.broadcast({ t: 'notice', text: `${c.name} has left` });
    if (this.clients.size === 0) { this.emptySince = Date.now(); }
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
      this.broadcast({ t: 'players', list: this.sim.playerInfo() });
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
      this.broadcast({ t: 'players', list: this.sim.playerInfo() });
      this.changing = false;
    }, LEVEL_CHANGE_DELAY_MS);
  }

  tick() {
    if (this.clients.size === 0) {
      if (this.emptySince && Date.now() - this.emptySince > 30000) this.close();
      return;
    }
    this.sim.step(DT);
    const snap = this.sim.snapshot();
    if (this.pendingEvents.length) { snap.e = this.pendingEvents; this.pendingEvents = []; }
    this.broadcast(snap);
  }

  close() {
    clearInterval(this.timer); clearInterval(this.secondsTimer);
    for (const c of this.clients.values()) this.send(c, { t: 'kicked', reason: 'Room closed' });
    this.onEmpty?.(this);
  }
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
