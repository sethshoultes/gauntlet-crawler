// Authoritative game simulation. Pure logic, no networking. Emits events through onEvent().
import {
  T, CLASSES, MONSTERS, GENERATOR_SPAWNS, GENERATOR_SCORE, TREASURE_SCORE, GENERATOR_HP, GENERATOR_RANGE,
  START_HEALTH, HEALTH_DRAIN_PER_SEC, FOOD_HEALTH, LOW_HEALTH, MAX_MONSTERS, MAX_SHOTS_PER_PLAYER,
  SHOT_SPEED, MONSTER_SHOT_SPEED, LEVEL_BONUS, DIRS, dirIndex, GENERATOR_TILES, PICKUP_TILES, MONSTER_TILES,
} from '../../shared/constants.js';
import { parseLevel } from '../../shared/level.js';

const HALF = 0.38;            // entity half-size in tiles
const MONSTER_TYPE_BY_TILE = { [T.GHOST]: 'ghost', [T.GRUNT]: 'grunt', [T.DEMON]: 'demon', [T.DEATH]: 'death' };
const DEFAULT_PERKS = { speedMul: 1, shotDamageAdd: 0, damageTakenMul: 1, maxHealthBonus: 0, magicAdd: 0 };

let nextId = 1;
const uid = () => nextId++;

export class Sim {
  constructor(levelDef, { levelIndex = 1, onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.players = new Map();
    this.loadLevel(levelDef, levelIndex);
  }

  loadLevel(levelDef, levelIndex) {
    const lvl = parseLevel(levelDef);
    this.level = lvl;
    this.levelIndex = levelIndex;
    this.w = lvl.w; this.h = lvl.h;
    this.grid = lvl.rows.map((r) => r.split(''));
    this.monsters = new Map();
    this.shots = new Map();
    this.generators = new Map(); // key "x,y" -> {x,y,type,hp,timer}
    this.time = 0;
    this.levelTime = 0;
    this.completed = null;
    this.levelKills = 0;
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const c = this.grid[y][x];
      if (MONSTER_TILES.has(c)) {
        this.grid[y][x] = T.FLOOR;
        this.spawnMonster(MONSTER_TYPE_BY_TILE[c], x + 0.5, y + 0.5);
      } else if (GENERATOR_TILES.has(c)) {
        this.generators.set(`${x},${y}`, { x, y, type: GENERATOR_SPAWNS[c], tile: c, hp: GENERATOR_HP, timer: 1 + Math.random() * 2 });
      }
    }
    this.startCursor = 0;
    for (const p of this.players.values()) {
      this.placeAtStart(p);
      p.levelKills = 0; p.levelDeaths = 0;
      p.shotCd = 0;
    }
  }

  levelPacket() {
    return { t: 'level', index: this.levelIndex, name: this.level.name, description: this.level.description, w: this.w, h: this.h, rows: this.grid.map((r) => r.join('')) };
  }

  // ---------- players ----------
  addPlayer(id, { name, cls, userId = null, perks = null, rank = null, title = null }) {
    if (!CLASSES[cls]) cls = 'warrior';
    const mergedPerks = { ...DEFAULT_PERKS, ...(perks || {}) };
    const maxHealth = START_HEALTH + mergedPerks.maxHealthBonus;
    const p = {
      id, name: String(name).slice(0, 16), cls, userId,
      x: 1.5, y: 1.5, dir: 4, hp: maxHealth, maxHealth, keys: 0, potions: 0, score: 0,
      dead: false, shotCd: 0, kills: 0, levelKills: 0, deaths: 0, levelDeaths: 0, coins: 0,
      input: { dx: 0, dy: 0, fire: false, potion: false, respawn: false },
      lastPotion: 0, stats: {}, perks: mergedPerks, rank, title,
    };
    this.players.set(id, p);
    this.placeAtStart(p);
    return p;
  }
  removePlayer(id) { this.players.delete(id); }
  setInput(id, input) {
    const p = this.players.get(id);
    if (!p) return;
    p.input.dx = Math.sign(Number(input.dx) || 0);
    p.input.dy = Math.sign(Number(input.dy) || 0);
    p.input.fire = !!input.fire;
    if (input.potion) p.input.potion = true;      // edge-triggered, consumed in step
    if (input.respawn) p.input.respawn = true;
  }
  placeAtStart(p) {
    const s = this.level.starts[this.startCursor++ % this.level.starts.length];
    p.x = s[0] + 0.5; p.y = s[1] + 0.5;
  }

  // ---------- helpers ----------
  tile(x, y) { return (x < 0 || y < 0 || x >= this.w || y >= this.h) ? T.WALL : this.grid[y][x]; }
  setTile(x, y, c) { this.grid[y][x] = c; this.onEvent({ type: 'tile', x, y, c }); }
  isSolidFor(c, who) {
    if (c === T.WALL || c === T.DOOR || c === T.TRAP) return true;
    if (GENERATOR_TILES.has(c)) return true;
    return false;
  }
  /** Move an entity with axis-separated AABB collision. Returns set of blocking tiles touched (for doors/traps). */
  moveEntity(e, dx, dy, who) {
    const touched = [];
    if (dx !== 0) {
      const nx = e.x + dx;
      const edge = dx > 0 ? nx + HALF : nx - HALF;
      const tx = Math.floor(edge);
      const y0 = Math.floor(e.y - HALF), y1 = Math.floor(e.y + HALF);
      let blocked = false;
      for (let ty = y0; ty <= y1; ty++) { const c = this.tile(tx, ty); if (this.isSolidFor(c, who)) { blocked = true; touched.push([tx, ty, c]); } }
      if (!blocked) e.x = nx; else e.x = dx > 0 ? tx - HALF - 0.001 : tx + 1 + HALF + 0.001;
    }
    if (dy !== 0) {
      const ny = e.y + dy;
      const edge = dy > 0 ? ny + HALF : ny - HALF;
      const ty = Math.floor(edge);
      const x0 = Math.floor(e.x - HALF), x1 = Math.floor(e.x + HALF);
      let blocked = false;
      for (let tx = x0; tx <= x1; tx++) { const c = this.tile(tx, ty); if (this.isSolidFor(c, who)) { blocked = true; touched.push([tx, ty, c]); } }
      if (!blocked) e.y = ny; else e.y = dy > 0 ? ty - HALF - 0.001 : ty + 1 + HALF + 0.001;
    }
    return touched;
  }
  nearestPlayer(x, y, maxDist = Infinity) {
    let best = null, bd = maxDist * maxDist;
    for (const p of this.players.values()) {
      if (p.dead) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  spawnMonster(type, x, y) {
    if (this.monsters.size >= MAX_MONSTERS) return null;
    const def = MONSTERS[type];
    const m = { id: uid(), type, x, y, hp: def.hp, cd: 0, shotCd: 1, drained: 0, dir: 4 };
    this.monsters.set(m.id, m);
    return m;
  }
  /** Flood-fill the group of identical tiles connected to (x,y) and replace them with floor. */
  dissolveGroup(x, y, kind) {
    const q = [[x, y]]; const seen = new Set([`${x},${y}`]); let n = 0;
    while (q.length) {
      const [cx, cy] = q.pop();
      if (this.tile(cx, cy) !== kind) continue;
      this.setTile(cx, cy, T.FLOOR); n++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${cx + dx},${cy + dy}`;
        if (!seen.has(k)) { seen.add(k); q.push([cx + dx, cy + dy]); }
      }
    }
    return n;
  }
  hurtPlayer(p, amount, source) {
    if (p.dead) return;
    p.hp -= amount * CLASSES[p.cls].armor * p.perks.damageTakenMul;
    if (p.hp <= 0) {
      p.hp = 0; p.dead = true; p.deaths++; p.levelDeaths++;
      this.onEvent({ type: 'death', pid: p.id, source });
    }
  }
  killMonster(m, killer, viaPotion = false) {
    this.monsters.delete(m.id);
    const def = MONSTERS[m.type];
    if (killer) {
      killer.score += def.score;
      killer.kills++; killer.levelKills++;
      this.onEvent({ type: 'kill', pid: killer.id, monster: m.type, viaPotion, x: m.x, y: m.y });
    }
    this.levelKills++;
  }
  damageGenerator(gen, amount, by) {
    gen.hp -= amount;
    if (gen.hp <= 0) {
      this.generators.delete(`${gen.x},${gen.y}`);
      this.setTile(gen.x, gen.y, T.FLOOR);
      if (by) { by.score += GENERATOR_SCORE; this.onEvent({ type: 'generator', pid: by.id, x: gen.x, y: gen.y }); }
    } else {
      this.onEvent({ type: 'sound', name: 'hit', x: gen.x + 0.5, y: gen.y + 0.5 });
    }
  }

  // ---------- main step ----------
  step(dt) {
    this.time += dt; this.levelTime += dt;
    if (this.completed) return;
    this.stepPlayers(dt);
    this.stepMonsters(dt);
    this.stepGenerators(dt);
    this.stepShots(dt);
  }

  stepPlayers(dt) {
    const cls = (p) => CLASSES[p.cls];
    for (const p of this.players.values()) {
      const inp = p.input;
      if (p.dead) {
        if (inp.respawn) {
          inp.respawn = false;
          p.dead = false; p.hp = p.maxHealth; p.coins++;
          this.placeAtStart(p);
          this.onEvent({ type: 'coin', pid: p.id });
        }
        continue;
      }
      inp.respawn = false;
      const c = cls(p);
      // health drain — the clock is always ticking
      p.hp -= HEALTH_DRAIN_PER_SEC * dt;
      if (p.hp <= 0) { p.hp = 0; p.dead = true; p.deaths++; p.levelDeaths++; this.onEvent({ type: 'death', pid: p.id, source: 'hunger' }); continue; }

      const moving = inp.dx !== 0 || inp.dy !== 0;
      if (moving) p.dir = dirIndex(inp.dx, inp.dy);
      p.shotCd = Math.max(0, p.shotCd - dt);
      if (inp.fire) {
        // Arcade rule: you stand still while firing; the stick turns you.
        if (p.shotCd === 0 && [...this.shots.values()].filter((s) => s.owner === p.id).length < MAX_SHOTS_PER_PLAYER) {
          const [dx, dy] = DIRS[p.dir];
          const len = Math.hypot(dx, dy);
          const sid = uid();
          this.shots.set(sid, { id: sid, owner: p.id, cls: p.cls, x: p.x + dx * 0.5, y: p.y + dy * 0.5, vx: dx / len * SHOT_SPEED, vy: dy / len * SHOT_SPEED, dmg: c.shotDamage + p.perks.shotDamageAdd, dir: p.dir, hostile: false, life: 3 });
          p.shotCd = c.shotCooldown;
          this.onEvent({ type: 'sound', name: 'shoot_' + p.cls, x: p.x, y: p.y });
        }
      } else if (moving) {
        const len = Math.hypot(inp.dx, inp.dy);
        const speed = c.speed * p.perks.speedMul;
        const touched = this.moveEntity(p, inp.dx / len * speed * dt, inp.dy / len * speed * dt, 'player');
        for (const [tx, ty, tc] of touched) {
          if (tc === T.DOOR && p.keys > 0) {
            p.keys--; this.dissolveGroup(tx, ty, T.DOOR);
            this.onEvent({ type: 'door', pid: p.id, x: tx, y: ty });
          } else if (tc === T.TRAP) {
            this.dissolveGroup(tx, ty, T.TRAP);
            this.onEvent({ type: 'secret', pid: p.id, x: tx, y: ty });
          }
        }
      }
      // pickups & exit at the player's centre tile
      const tx = Math.floor(p.x), ty = Math.floor(p.y);
      const here = this.tile(tx, ty);
      if (PICKUP_TILES.has(here)) {
        this.setTile(tx, ty, T.FLOOR);
        if (here === T.KEY) p.keys++;
        else if (here === T.FOOD) { this.onEvent({ type: 'food', pid: p.id, lowHealth: p.hp < LOW_HEALTH }); p.hp += FOOD_HEALTH; }
        else if (here === T.POTION) p.potions++;
        else if (here === T.TREASURE) p.score += TREASURE_SCORE;
        this.onEvent({ type: 'pickup', pid: p.id, item: here, x: tx, y: ty });
      } else if (here === T.EXIT) {
        p.score += LEVEL_BONUS;
        this.completed = { pid: p.id, levelTime: this.levelTime, players: this.players.size };
        this.onEvent({ type: 'exit', pid: p.id, levelTime: this.levelTime });
        return;
      }
      if (inp.potion) {
        inp.potion = false;
        if (p.potions > 0) { p.potions--; this.usePotion(p, c.magic + p.perks.magicAdd); }
      }
    }
  }

  usePotion(p, magic, radius = 7.5, byShot = false) {
    let kills = 0;
    const dmg = byShot ? 1 : Math.ceil(magic * 2);
    for (const m of [...this.monsters.values()]) {
      if ((m.x - p.x) ** 2 + (m.y - p.y) ** 2 > radius * radius) continue;
      if (m.type === 'death') { if (!byShot) { this.killMonster(m, p, true); kills++; } continue; }
      m.hp -= dmg;
      if (m.hp <= 0) { this.killMonster(m, p, true); kills++; }
    }
    for (const g of [...this.generators.values()]) {
      if ((g.x + 0.5 - p.x) ** 2 + (g.y + 0.5 - p.y) ** 2 > radius * radius) continue;
      this.damageGenerator(g, byShot ? 1 : Math.ceil(magic), p);
    }
    this.onEvent({ type: 'potion', pid: p.id, x: p.x, y: p.y, radius, kills, weak: byShot });
  }

  stepMonsters(dt) {
    const list = [...this.monsters.values()];
    for (const m of list) {
      const def = MONSTERS[m.type];
      m.cd = Math.max(0, m.cd - dt); m.shotCd = Math.max(0, m.shotCd - dt);
      const target = this.nearestPlayer(m.x, m.y, def.wakeRange);
      if (!target) continue;
      const dx = target.x - m.x, dy = target.y - m.y;
      const dist = Math.hypot(dx, dy) || 0.001;
      // contact
      if (dist < 0.8) {
        if (def.touchKills) {
          this.hurtPlayer(target, def.damage, m.type);
          this.monsters.delete(m.id);
          this.onEvent({ type: 'sound', name: 'ghost_hit', x: m.x, y: m.y });
          continue;
        } else if (m.type === 'death') {
          const take = Math.min(def.damage, def.drainTotal - m.drained);
          this.hurtPlayer(target, take / CLASSES[target.cls].armor, 'death');
          m.drained += take;
          if (m.drained >= def.drainTotal) { this.monsters.delete(m.id); this.onEvent({ type: 'sound', name: 'death_leave', x: m.x, y: m.y }); }
          continue;
        } else if (m.cd === 0) {
          m.cd = def.hitCooldown;
          this.hurtPlayer(target, def.damage, m.type);
          this.onEvent({ type: 'sound', name: 'hit', x: m.x, y: m.y });
        }
      }
      // ranged demons hang back
      if (def.shoots && dist < def.range && m.shotCd === 0) {
        m.shotCd = def.shotCooldown;
        const sid = uid();
        this.shots.set(sid, { id: sid, owner: m.id, cls: 'demon', x: m.x, y: m.y, vx: dx / dist * MONSTER_SHOT_SPEED, vy: dy / dist * MONSTER_SHOT_SPEED, dmg: def.shotDamage, dir: dirIndex(dx, dy), hostile: true, life: 2 });
        this.onEvent({ type: 'sound', name: 'fireball', x: m.x, y: m.y });
      }
      if (def.shoots && dist < def.range * 0.6) continue; // hold position when in range
      // chase with wall sliding
      const speed = def.speed * (1 + Math.min(0.6, (this.levelIndex - 1) * 0.02));
      let mx = dx / dist * speed * dt, my = dy / dist * speed * dt;
      const before = [m.x, m.y];
      this.moveEntity(m, mx, 0, 'monster');
      this.moveEntity(m, 0, my, 'monster');
      if (Math.abs(m.x - before[0]) + Math.abs(m.y - before[1]) < speed * dt * 0.2) {
        // stuck: try perpendicular nudge
        const side = ((m.id % 2) ? 1 : -1);
        this.moveEntity(m, -my * side, mx * side, 'monster');
      }
      m.dir = dirIndex(dx, dy);
    }
    // gentle separation so monsters don't stack into a single blob
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (!this.monsters.has(a.id) || !this.monsters.has(b.id)) continue;
      const dx = b.x - a.x, dy = b.y - a.y; const d2 = dx * dx + dy * dy;
      if (d2 < 0.5 * 0.5 && d2 > 0.0001) {
        const d = Math.sqrt(d2); const push = (0.5 - d) * 0.5;
        this.moveEntity(a, -dx / d * push, -dy / d * push, 'monster');
        this.moveEntity(b, dx / d * push, dy / d * push, 'monster');
      }
    }
  }

  stepGenerators(dt) {
    const interval = Math.max(1.0, 3.2 - this.levelIndex * 0.08);
    for (const g of this.generators.values()) {
      g.timer -= dt;
      if (g.timer > 0) continue;
      g.timer = interval * (0.7 + Math.random() * 0.6);
      if (!this.nearestPlayer(g.x + 0.5, g.y + 0.5, GENERATOR_RANGE)) continue;
      let nearby = 0;
      for (const m of this.monsters.values()) if (Math.abs(m.x - g.x) < 4 && Math.abs(m.y - g.y) < 4) nearby++;
      if (nearby >= 6) continue;
      const spots = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].filter(([dx, dy]) => this.tile(g.x + dx, g.y + dy) === T.FLOOR);
      if (!spots.length) continue;
      const [dx, dy] = spots[Math.floor(Math.random() * spots.length)];
      const m = this.spawnMonster(g.type, g.x + dx + 0.5, g.y + dy + 0.5);
      if (m) this.onEvent({ type: 'sound', name: 'spawn', x: m.x, y: m.y });
    }
  }

  stepShots(dt) {
    for (const s of [...this.shots.values()]) {
      s.life -= dt;
      if (s.life <= 0) { this.shots.delete(s.id); continue; }
      const steps = 2; // sub-step so fast shots don't tunnel through 1-tile walls
      let done = false;
      for (let k = 0; k < steps && !done; k++) {
        s.x += s.vx * dt / steps; s.y += s.vy * dt / steps;
        const tx = Math.floor(s.x), ty = Math.floor(s.y);
        const c = this.tile(tx, ty);
        if (s.hostile) {
          if (c === T.WALL || c === T.DOOR || c === T.TRAP || GENERATOR_TILES.has(c)) { done = true; break; }
          for (const p of this.players.values()) {
            if (p.dead) continue;
            if (Math.abs(p.x - s.x) < HALF + 0.15 && Math.abs(p.y - s.y) < HALF + 0.15) { this.hurtPlayer(p, s.dmg, 'fireball'); done = true; break; }
          }
          continue;
        }
        const owner = this.players.get(s.owner);
        if (GENERATOR_TILES.has(c)) { const g = this.generators.get(`${tx},${ty}`); if (g) this.damageGenerator(g, s.dmg, owner); done = true; break; }
        if (c === T.WALL || c === T.DOOR || c === T.TRAP) { done = true; break; }
        if (c === T.FOOD) { this.setTile(tx, ty, T.FLOOR); if (owner) this.onEvent({ type: 'food_shot', pid: s.owner, x: tx, y: ty }); done = true; break; }
        if (c === T.POTION) { this.setTile(tx, ty, T.FLOOR); if (owner) this.usePotion({ ...owner, x: tx + 0.5, y: ty + 0.5, id: owner.id }, 1, 4, true); done = true; break; }
        for (const m of this.monsters.values()) {
          if (Math.abs(m.x - s.x) < HALF + 0.15 && Math.abs(m.y - s.y) < HALF + 0.15) {
            done = true;
            if (MONSTERS[m.type].immune) { this.onEvent({ type: 'sound', name: 'clank', x: m.x, y: m.y }); break; }
            m.hp -= s.dmg;
            if (m.hp <= 0) this.killMonster(m, owner); else this.onEvent({ type: 'sound', name: 'hit', x: m.x, y: m.y });
            break;
          }
        }
      }
      if (done) this.shots.delete(s.id);
    }
  }

  // ---------- network view ----------
  snapshot() {
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      t: 's', tick: Math.round(this.time * 20), lt: Math.round(this.levelTime),
      p: [...this.players.values()].map((p) => [p.id, r2(p.x), r2(p.y), p.dir, Math.round(p.hp), p.keys, p.potions, p.score, p.dead ? 1 : 0]),
      m: [...this.monsters.values()].map((m) => [m.id, m.type[0], r2(m.x), r2(m.y), m.dir]),
      g: [...this.generators.values()].map((g) => [g.x, g.y, g.hp]),
      b: [...this.shots.values()].map((s) => [s.id, r2(s.x), r2(s.y), s.dir, s.hostile ? 'd' : s.cls[0]]),
    };
  }
  playerInfo() {
    return [...this.players.values()].map((p) => ({ id: p.id, name: p.name, cls: p.cls, score: p.score, kills: p.kills, dead: p.dead, rank: p.rank, title: p.title }));
  }
}
