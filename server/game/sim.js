// Authoritative game simulation. Pure logic, no networking. Emits events through onEvent().
import {
  T, CLASSES, MONSTERS, GENERATOR_SPAWNS, GENERATOR_SCORE, TREASURE_SCORE, GENERATOR_RANGE,
  START_HEALTH, HEALTH_DRAIN_PER_SEC, FOOD_HEALTH, LOW_HEALTH, MAX_MONSTERS, MAX_SHOTS_PER_PLAYER,
  SHOT_SPEED, MONSTER_SHOT_SPEED, LEVEL_BONUS, DIRS, dirIndex, GENERATOR_TILES, PICKUP_TILES, MONSTER_TILES,
  generatorTier, GENERATOR_TIER_HP, GENERATOR_TIER_HP_BONUS, GENERATOR_TIER_SCORE_MUL,
  AMULET_TILES, BOOST_TILES, AMULET_DURATION, AMULET_SCORE, BOOST_SCORE, BOOST_STACK_CAP, BOOST_EFFECT,
  REPULSE_RANGE, AMULET_LETTER, BOOST_LETTER, TRAP_PLATES, GROUP_WALLS, TIMED_WALLS, TIMER_DEFAULT_SEC,
  ACID_DAMAGE_PER_SEC, STUN_TICKS, STUN_IMMUNITY_TICKS,
} from '../../shared/constants.js';
import { parseLevel } from '../../shared/level.js';

const HALF = 0.38;            // entity half-size in tiles
const PLAYER_SEPARATION = 0.7; // players block each other's movement within this distance (README's "Features" section, "Players block each other")
const TELEPORT_COOLDOWN = 1.0; // seconds before a player can use another transporter (avoid ping-pong)
const THIEF_DESPAWN_DIST = 15; // tiles from every player before a fleeing thief vanishes with its loot
const MONSTER_TYPE_BY_TILE = {
  [T.GHOST]: 'ghost', [T.GRUNT]: 'grunt', [T.DEMON]: 'demon', [T.DEATH]: 'death',
  [T.LOBBER]: 'lobber', [T.SORCERER]: 'sorcerer', [T.THIEF]: 'thief',
};
const DEFAULT_PERKS = { speedMul: 1, shotDamageAdd: 0, damageTakenMul: 1, maxHealthBonus: 0, magicAdd: 0 };
const SPLASH_RADIUS = 1.75; // tiles — fireball-style weapons (weaponDef.splash) damage monsters within this of the hit

let nextId = 1;
const uid = () => nextId++;

/** Effective class definition for a player: a Hero Builder `classDef` (see shared/hero-builder.js
 *  toClassDef) when one was attached at addPlayer() time, else the usual CLASSES[p.cls] lookup —
 *  every stat/weapon/trait read in this file goes through this so classic classes keep behaving
 *  exactly as before (all classDef-only fields are simply absent/undefined on a CLASSES entry). */
function classOf(p) { return p.classDef || CLASSES[p.cls] || CLASSES.warrior; }

export class Sim {
  constructor(levelDef, { levelIndex = 1, onEvent = () => {}, mode = 'campaign', rng = null } = {}) {
    this.onEvent = onEvent;
    this.mode = mode; // 'campaign' | 'death' — Room may flip this before loadLevel() on a mode switch
    // Seeded/random source for gameplay randomness that needs to be swappable in tests (e.g. the
    // Locksmith trait's door-key-save roll) — defaults to plain Math.random so nothing else changes.
    this.rng = rng || { chance: (p) => Math.random() < p };
    this.players = new Map();
    this.loadLevel(levelDef, levelIndex);
  }

  loadLevel(levelDef, levelIndex, opts = {}) {
    const lvl = parseLevel(levelDef);
    this.level = lvl;
    this.levelIndex = levelIndex;
    this.w = lvl.w; this.h = lvl.h;
    this.grid = lvl.rows.map((r) => r.split(''));
    this.monsters = new Map();
    this.shots = new Map();
    this.generators = new Map(); // key "x,y" -> {x,y,type,hp,tier,timer}
    this.transporters = [];      // [[cx,cy], ...] tile centres — see tryTeleport()
    this.time = 0;
    this.levelTime = 0;
    this.completed = null;
    this.levelKills = 0;
    this.treasureRoom = !!opts.treasureRoom; // see shared/procgen.js generateTreasureRoom + server/game/room.js
    // Death mode: every level starts with the exit sealed until Room clears all its waves.
    this.exitSealed = this.mode === 'death';
    // Pressure-plate wall groups (#11): each plate glyph fires at most once per level (see
    // triggerPlate()) even though the plate tile itself stays in the grid afterward.
    this.platesTriggered = new Set();
    // Timed walls (#11): `levelDef.timers` (the raw, unparsed level object — parseLevel() strips
    // anything it doesn't know) optionally overrides the default per-kind, or via `.default` for
    // both kinds at once; entries are seconds from this level's start until conversion.
    const timersCfg = (levelDef && typeof levelDef.timers === 'object' && levelDef.timers) || {};
    const timerSecFor = (kind) => {
      if (typeof timersCfg[kind] === 'number' && timersCfg[kind] > 0) return timersCfg[kind];
      if (typeof timersCfg.default === 'number' && timersCfg.default > 0) return timersCfg.default;
      return TIMER_DEFAULT_SEC;
    };
    this.timedWalls = []; // [{x,y,glyph,remaining}] — ticked down in stepTimedWalls()
    const tier = generatorTier(levelIndex);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const c = this.grid[y][x];
      if (MONSTER_TILES.has(c)) {
        this.grid[y][x] = T.FLOOR;
        this.spawnMonster(MONSTER_TYPE_BY_TILE[c], x + 0.5, y + 0.5);
      } else if (GENERATOR_TILES.has(c)) {
        this.generators.set(`${x},${y}`, { x, y, type: GENERATOR_SPAWNS[c], tile: c, hp: GENERATOR_TIER_HP[tier], tier, timer: 1 + Math.random() * 2 });
      } else if (c === T.TRANSPORTER) {
        this.transporters.push([x + 0.5, y + 0.5]);
      } else if (c === T.TIMED_WALL) {
        this.timedWalls.push({ x, y, glyph: c, remaining: timerSecFor('wall') });
      } else if (c === T.TIMED_WALL_EXIT) {
        this.timedWalls.push({ x, y, glyph: c, remaining: timerSecFor('exit') });
      }
    }
    this.startCursor = 0;
    for (const p of this.players.values()) {
      this.placeAtStart(p);
      p.levelKills = 0; p.levelDeaths = 0;
      p.shotCd = 0; p.teleportCd = 0;
      // Chest boosts picked in the just-finished intermission activate for this level only —
      // whatever was active for the level that just ended is discarded here.
      p.boosts = p.pendingBoosts || {};
      p.pendingBoosts = null;
      // Amulets are picked up within a level and don't make sense to carry into the next one
      // (new positions, new dangers) — they're cleared on every level load. `runBoosts` (the
      // permanent per-run stat boosts) is deliberately NOT touched here: it persists for the
      // whole run and only resets when addPlayer() creates a fresh player (a new run/join).
      p.amulets = {};
      // Stun (#12) doesn't carry across a level load either — new positions, new dangers.
      p.stunTicks = 0; p.stunImmuneTicks = 0;
      if (p.pendingCurse === 'spawn') {
        const type = ['ghost', 'grunt', 'demon'][Math.floor(Math.random() * 3)];
        const side = Math.random() < 0.5 ? -1 : 1;
        this.spawnMonster(type, Math.min(this.w - 1.5, Math.max(0.5, p.x + side)), p.y);
      }
      p.pendingCurse = null;
    }
  }

  levelPacket() {
    return { t: 'level', index: this.levelIndex, name: this.level.name, description: this.level.description, w: this.w, h: this.h, rows: this.grid.map((r) => r.join('')), sealed: !!this.exitSealed, treasureRoom: !!this.treasureRoom };
  }

  // ---------- players ----------
  // `classDef` (see shared/hero-builder.js toClassDef) is a validated Hero Builder hero's stats,
  // shaped like a CLASSES entry plus builder-only extras (maxHealthBonus/weaponDef/traitDef) —
  // server/game/room.js resolves and re-validates it before ever passing it in here (never trust
  // a stored classDef without that check). `custom` (see room.js playerInfo()) is display-only
  // ({name, pixels, color}) carried alongside for the roster/HUD, never read for gameplay math.
  addPlayer(id, { name, cls, userId = null, perks = null, rank = null, title = null, palette = null, classDef = null, custom = null }) {
    if (!classDef && !CLASSES[cls]) cls = 'warrior';
    const mergedPerks = { ...DEFAULT_PERKS, ...(perks || {}) };
    const maxHealth = START_HEALTH + mergedPerks.maxHealthBonus + (classDef?.maxHealthBonus || 0);
    const p = {
      id, name: String(name).slice(0, 16), cls, classDef: classDef || null, custom: custom || null, userId, palette: palette || null,
      x: 1.5, y: 1.5, dir: 4, hp: maxHealth, maxHealth, keys: 0, potions: 0, score: 0,
      dead: false, shotCd: 0, teleportCd: 0, kills: 0, levelKills: 0, deaths: 0, levelDeaths: 0, coins: 0,
      input: { dx: 0, dy: 0, fire: false, potion: false, respawn: false },
      lastPotion: 0, stats: {}, perks: mergedPerks, rank, title,
      boosts: {}, pendingBoosts: null, pendingCurse: null, // temporary chest effects, see shared/chests.js
      // Arcade parity (#10): `amulets` is {kind: secondsRemaining} for the temporary pickups
      // (invis/reflect/repulse/super — see AMULET_TILES), cleared every level load. `runBoosts` is
      // {stat: stackCount} for the permanent per-run pickups (speed/armor/shotPower/shotSpeed/magic
      // — see BOOST_TILES), which persists across loadLevel() and only resets here, i.e. on a
      // fresh addPlayer() for a new run/join.
      amulets: {}, runBoosts: {},
      // Stun tile (#12): stunTicks counts down the frozen (no movement/no firing) window;
      // stunImmuneTicks counts down the whole no-retrigger period (frozen span + the grace window
      // after it ends) — see triggerStun()/stepPlayers().
      stunTicks: 0, stunImmuneTicks: 0,
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
    if (GROUP_WALLS.has(c) || TIMED_WALLS.has(c)) return true;
    if (GENERATOR_TILES.has(c)) return true;
    // Force field (#12): blocks a shot's path but never a hero's or monster's movement.
    if (c === T.FORCE_FIELD) return who === 'shot';
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
      if (blocked) e.x = dx > 0 ? tx - HALF - 0.001 : tx + 1 + HALF + 0.001;
      else if (who === 'player' && this.blockedByPlayer(e, nx, e.y)) { /* soft-blocked by another player: cancel this axis */ }
      else e.x = nx;
    }
    if (dy !== 0) {
      const ny = e.y + dy;
      const edge = dy > 0 ? ny + HALF : ny - HALF;
      const ty = Math.floor(edge);
      const x0 = Math.floor(e.x - HALF), x1 = Math.floor(e.x + HALF);
      let blocked = false;
      for (let tx = x0; tx <= x1; tx++) { const c = this.tile(tx, ty); if (this.isSolidFor(c, who)) { blocked = true; touched.push([tx, ty, c]); } }
      if (blocked) e.y = dy > 0 ? ty - HALF - 0.001 : ty + 1 + HALF + 0.001;
      else if (who === 'player' && this.blockedByPlayer(e, e.x, ny)) { /* soft-blocked by another player: cancel this axis */ }
      else e.y = ny;
    }
    return touched;
  }
  /** Players are soft obstacles to each other (README's "Features" section, "Players block each other"): a move that would put `e` within
   *  PLAYER_SEPARATION tiles of another living player is cancelled on that axis. Shots still pass
   *  through teammates — this only applies to player movement (who === 'player'). */
  blockedByPlayer(e, nx, ny) {
    for (const p of this.players.values()) {
      if (p === e || p.dead) continue;
      if (Math.hypot(p.x - nx, p.y - ny) < PLAYER_SEPARATION) return true;
    }
    return false;
  }
  /** Nearest living player to (x,y). `opts.skipInvisible` (invisibility amulet, see
   *  AMULET_TILES/README's "Amulets and boosts") excludes a player currently invisible — used by
   *  every monster AI target search so an invisible player gets no targeting/aggro at all. */
  nearestPlayer(x, y, maxDist = Infinity, opts = {}) {
    let best = null, bd = maxDist * maxDist;
    for (const p of this.players.values()) {
      if (p.dead) continue;
      if (opts.skipInvisible && p.amulets?.invis > 0) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  /** Nearest monster to (x,y) within maxDist — used by a homing (Hero Builder skull) shot's gentle
   *  steering (see stepShots). */
  nearestMonster(x, y, maxDist = Infinity) {
    let best = null, bd = maxDist * maxDist;
    for (const m of this.monsters.values()) {
      const d = (m.x - x) ** 2 + (m.y - y) ** 2;
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }
  spawnMonster(type, x, y, hpBonus = 0) {
    if (this.monsters.size >= MAX_MONSTERS) return null;
    const def = MONSTERS[type];
    // stunTicks/stunImmuneTicks (#12): mirrors the player fields below — see triggerStun().
    const m = { id: uid(), type, x, y, hp: def.hp + hpBonus, cd: 0, shotCd: 1, drained: 0, dir: 4, stunTicks: 0, stunImmuneTicks: 0 };
    if (type === 'sorcerer') { m.visible = true; m.blinkTimer = def.blinkVisible; }
    if (type === 'thief') m.stolen = null;
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
  /** Pressure plate (#11, see TRAP_PLATES): the first hero or monster to stand on a plate dissolves
   *  every wall tile sharing its group glyph across the whole level — not just a connected cluster,
   *  unlike dissolveGroup() above — so a level can scatter one group's walls in several places and
   *  a single plate opens them all at once. Fires at most once per plate glyph per level; a second
   *  plate of a different glyph only ever affects its own group (see TRAP_PLATES's 1:1 mapping). */
  triggerPlate(glyph) {
    if (this.platesTriggered.has(glyph)) return;
    this.platesTriggered.add(glyph);
    const wallGlyph = TRAP_PLATES[glyph];
    if (!wallGlyph) return;
    let n = 0;
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.grid[y][x] === wallGlyph) { this.setTile(x, y, T.FLOOR); n++; }
    }
    if (n) this.onEvent({ type: 'plate', glyph, wallGlyph, count: n });
  }
  /** Timed walls (#11, see TIMED_WALLS): tick every pending timed wall down by dt and convert any
   *  that reach zero in place — T.TIMED_WALL becomes floor, T.TIMED_WALL_EXIT becomes a real exit
   *  tile (picked up automatically by the EXIT_TILES check in stepPlayers/exitReachable). */
  stepTimedWalls(dt) {
    if (!this.timedWalls.length) return;
    const fired = [];
    for (const tw of this.timedWalls) { tw.remaining -= dt; if (tw.remaining <= 0) fired.push(tw); }
    if (!fired.length) return;
    this.timedWalls = this.timedWalls.filter((tw) => tw.remaining > 0);
    for (const tw of fired) {
      const becomes = tw.glyph === T.TIMED_WALL_EXIT ? T.EXIT : T.FLOOR;
      this.setTile(tw.x, tw.y, becomes);
      this.onEvent({ type: 'timedWall', x: tw.x, y: tw.y, becomes });
    }
  }
  /** Stun tile (#12): freezes `entity` (a player or a monster — both carry stunTicks/stunImmuneTicks,
   *  see addPlayer()/spawnMonster()) for STUN_TICKS, then leaves it immune to retriggering for a
   *  further STUN_IMMUNITY_TICKS so it has a chance to walk off the tile before it can fire again.
   *  A no-op while stunImmuneTicks is still counting down from an earlier trigger (which covers both
   *  the frozen window itself and the grace period after it, since immuneTicks is always >= ticks). */
  triggerStun(entity, isPlayer) {
    if ((entity.stunImmuneTicks || 0) > 0) return;
    entity.stunTicks = STUN_TICKS;
    entity.stunImmuneTicks = STUN_TICKS + STUN_IMMUNITY_TICKS;
    if (isPlayer) this.onEvent({ type: 'stun', pid: entity.id });
  }
  /** Acid puddle (#12): per-tick damage through the normal hurtPlayer() pipeline so armor/perks/boosts
   *  reduce it exactly like any other source of damage (ACID_DAMAGE_PER_SEC * dt keeps it framerate-
   *  correct — 0.5hp/tick at the default 10/s and 20Hz). Monsters are immune (native to the dungeon),
   *  so this is only ever called for players. */
  applyAcid(p, dt) {
    this.hurtPlayer(p, ACID_DAMAGE_PER_SEC * dt, 'acid');
  }
  hurtPlayer(p, amount, source) {
    if (p.dead) return;
    const c = classOf(p);
    const armorBoostMul = Math.max(0.1, 1 - (p.runBoosts?.armor || 0) * BOOST_EFFECT.armor);
    let dmg = amount * c.armor * p.perks.damageTakenMul * (p.boosts?.damageTakenMul || 1) * armorBoostMul;
    // thick_skin (Hero Builder trait): only softens a ghost's touch attack, not damage in general.
    if (source === 'ghost' && c.traitDef?.ghostDamageTakenMul != null) dmg *= c.traitDef.ghostDamageTakenMul;
    p.hp -= dmg;
    if (p.hp <= 0) {
      p.hp = 0; p.dead = true; p.deaths++; p.levelDeaths++;
      this.onEvent({ type: 'death', pid: p.id, source });
    }
  }
  killMonster(m, killer, viaPotion = false) {
    this.monsters.delete(m.id);
    const def = MONSTERS[m.type];
    // A thief carrying stolen loot drops it where it died instead of keeping it (README's "Features" section, "New monster types").
    if (m.type === 'thief' && m.stolen) {
      const tx = Math.floor(m.x), ty = Math.floor(m.y);
      if (this.tile(tx, ty) === T.FLOOR) this.setTile(tx, ty, m.stolen === 'potion' ? T.POTION : T.KEY);
    }
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
      if (by) {
        by.score += Math.round(GENERATOR_SCORE * (GENERATOR_TIER_SCORE_MUL[gen.tier] || 1) * (classOf(by).traitDef?.lootScoreMul || 1));
        this.onEvent({ type: 'generator', pid: by.id, x: gen.x, y: gen.y });
      }
    } else {
      this.onEvent({ type: 'sound', name: 'hit', x: gen.x + 0.5, y: gen.y + 0.5 });
    }
  }
  /** Nearest OTHER transporter tile from (x,y) — random among ties (README's "Features" section, "Transporters"). Null if fewer than 2 exist. */
  otherTransporter(x, y) {
    const others = this.transporters.filter(([tx, ty]) => Math.hypot(tx - x, ty - y) > 0.5);
    if (!others.length) return null;
    let bestD = Infinity;
    for (const [tx, ty] of others) bestD = Math.min(bestD, Math.hypot(tx - x, ty - y));
    const nearest = others.filter(([tx, ty]) => Math.hypot(tx - x, ty - y) <= bestD + 0.01);
    return nearest[Math.floor(Math.random() * nearest.length)];
  }
  tryTeleport(p) {
    if (p.teleportCd > 0) return;
    if (this.transporters.length < 2) return;
    const dest = this.otherTransporter(p.x, p.y);
    if (!dest) return;
    p.x = dest[0]; p.y = dest[1];
    p.teleportCd = TELEPORT_COOLDOWN;
    this.onEvent({ type: 'teleport', pid: p.id, x: p.x, y: p.y });
  }

  // ---------- main step ----------
  step(dt) {
    this.time += dt; this.levelTime += dt;
    if (this.completed) return;
    this.stepAmulets(dt);
    this.stepTimedWalls(dt);
    this.stepPlayers(dt);
    this.stepMonsters(dt);
    this.stepRepulsion(dt);
    this.stepGenerators(dt);
    this.stepShots(dt);
  }

  /** Tick down every player's active temporary amulets (README's "Amulets and boosts"); runs
   *  regardless of dead/alive so a death doesn't pause or reset the clock. */
  stepAmulets(dt) {
    for (const p of this.players.values()) {
      if (!p.amulets) continue;
      for (const kind of Object.keys(p.amulets)) {
        p.amulets[kind] -= dt;
        if (p.amulets[kind] <= 0) delete p.amulets[kind];
      }
    }
  }

  /** Repulsiveness amulet: push every monster within REPULSE_RANGE of a player who has it active
   *  away each tick — paired with stepMonsters' touch-damage guard for the "cannot touch you"
   *  half of the effect (a push alone couldn't guarantee a fast/cornered monster never grazes). */
  stepRepulsion(dt) {
    for (const p of this.players.values()) {
      if (p.dead || !(p.amulets?.repulse > 0)) continue;
      for (const m of this.monsters.values()) {
        const dx = m.x - p.x, dy = m.y - p.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= REPULSE_RANGE || dist < 0.001) continue;
        const push = (REPULSE_RANGE - dist) * 3 * dt;
        this.moveEntity(m, dx / dist * push, dy / dist * push, 'monster');
      }
    }
  }

  stepPlayers(dt) {
    const cls = (p) => classOf(p);
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
      p.teleportCd = Math.max(0, (p.teleportCd || 0) - dt);
      // health drain — the clock is always ticking (a cursed chest can double this for the level;
      // Death mode itself drains 1.5x to keep the timed waves under pressure)
      p.hp -= HEALTH_DRAIN_PER_SEC * dt * (p.boosts?.drainMul || 1) * (this.mode === 'death' ? 1.5 : 1);
      if (p.hp <= 0) { p.hp = 0; p.dead = true; p.deaths++; p.levelDeaths++; this.onEvent({ type: 'death', pid: p.id, source: 'hunger' }); continue; }

      // Stun tile (#12): tick both counters down every step regardless of which is active — stunTicks
      // is the frozen (no movement/no firing) window, stunImmuneTicks additionally covers the grace
      // period right after it (see triggerStun()). While stunned, skip movement/firing entirely but
      // still let the hazard-tile checks below run (e.g. acid still hurts you while frozen on it).
      const stunned = (p.stunTicks || 0) > 0;
      if (stunned) p.stunTicks--;
      if (p.stunImmuneTicks > 0) p.stunImmuneTicks--;

      if (!stunned) {
        const moving = inp.dx !== 0 || inp.dy !== 0;
        if (moving) p.dir = dirIndex(inp.dx, inp.dy);
        p.shotCd = Math.max(0, p.shotCd - dt);
        if (inp.fire) {
          // Arcade rule: you stand still while firing; the stick turns you.
          if (p.shotCd === 0 && [...this.shots.values()].filter((s) => s.owner === p.id).length < MAX_SHOTS_PER_PLAYER) {
            const [dx, dy] = DIRS[p.dir];
            const len = Math.hypot(dx, dy);
            const sid = uid();
            const wpn = c.weaponDef || null; // Hero Builder weapon (see shared/hero-builder.js WEAPONS)
            const shotSpeed = SHOT_SPEED * (wpn?.shotSpeedMul || 1);
            const dmg = (c.shotDamage + p.perks.shotDamageAdd + (p.boosts?.shotDamageAdd || 0)
              + (p.runBoosts?.shotPower || 0) * BOOST_EFFECT.shotPower) * (wpn?.damageMul || 1);
            // `range` (tiles) -> shot lifetime, so a weapon's reach stays constant regardless of its
            // own speed multiplier; classics (no weaponDef) keep the old fixed 3s lifetime.
            const life = wpn?.range != null ? wpn.range / shotSpeed : 3;
            // Amulet effects are baked into the shot at fire time (see stepShots): reflective shots
            // bounce off one wall instead of dying there, super shots pierce through every monster
            // they pass instead of stopping at the first one.
            this.shots.set(sid, {
              id: sid, owner: p.id, cls: p.cls, shotKey: c.shotKey, x: p.x + dx * 0.5, y: p.y + dy * 0.5,
              vx: dx / len * shotSpeed, vy: dy / len * shotSpeed, dmg, dir: p.dir, hostile: false, life,
              homing: wpn?.homing || 0, splash: wpn?.splash || 0,
              reflect: !!(p.amulets?.reflect > 0), pierce: !!(p.amulets?.super > 0),
            });
            const shotSpeedBoostMul = Math.max(0.2, 1 - (p.runBoosts?.shotSpeed || 0) * BOOST_EFFECT.shotSpeed);
            p.shotCd = c.shotCooldown * (p.boosts?.shotCooldownMul || 1) * shotSpeedBoostMul * (wpn?.cooldownMul || 1);
            // Custom heroes have no per-class synth tone; fall back to the weapon's own sound (the
            // weapon id doubles as its sprite/sound key — see shared/hero-builder.js WEAPONS).
            this.onEvent({ type: 'sound', name: 'shoot_' + (p.classDef ? c.weapon : p.cls), x: p.x, y: p.y });
          }
        } else if (moving) {
          const len = Math.hypot(inp.dx, inp.dy);
          // sprinter (Hero Builder trait): a speed boost that only kicks in below its HP threshold.
          const sprint = (c.traitDef?.sprintSpeedMul && p.hp < (c.traitDef.sprintHpThreshold ?? Infinity)) ? c.traitDef.sprintSpeedMul : 1;
          const runSpeedMul = 1 + (p.runBoosts?.speed || 0) * BOOST_EFFECT.speed;
          const speed = c.speed * p.perks.speedMul * (p.boosts?.speedMul || 1) * runSpeedMul * sprint;
          const touched = this.moveEntity(p, inp.dx / len * speed * dt, inp.dy / len * speed * dt, 'player');
          for (const [tx, ty, tc] of touched) {
            if (tc === T.DOOR && p.keys > 0) {
              // locksmith (Hero Builder trait): a chance the door opens without spending the key.
              const saved = c.traitDef?.doorKeySaveChance ? this.rng.chance(c.traitDef.doorKeySaveChance) : false;
              if (!saved) p.keys--;
              this.dissolveGroup(tx, ty, T.DOOR);
              this.onEvent({ type: 'door', pid: p.id, x: tx, y: ty });
            } else if (tc === T.TRAP) {
              this.dissolveGroup(tx, ty, T.TRAP);
              this.onEvent({ type: 'secret', pid: p.id, x: tx, y: ty });
            }
          }
        }
      }
      // pickups & exit at the player's centre tile
      const tx = Math.floor(p.x), ty = Math.floor(p.y);
      const here = this.tile(tx, ty);
      if (PICKUP_TILES.has(here)) {
        this.setTile(tx, ty, T.FLOOR);
        if (here === T.KEY) p.keys++;
        else if (here === T.FOOD) { this.onEvent({ type: 'food', pid: p.id, lowHealth: p.hp < LOW_HEALTH }); p.hp += FOOD_HEALTH * (c.traitDef?.foodHealMul || 1); }
        else if (here === T.POTION) p.potions++;
        else if (here === T.TREASURE) p.score += TREASURE_SCORE * (c.traitDef?.lootScoreMul || 1);
        else if (here === T.POISON_FOOD) { p.hp = Math.max(1, p.hp - 100); this.onEvent({ type: 'poison', pid: p.id }); }
        else if (here === T.CIDER) p.hp += 50;
        else if (AMULET_TILES[here]) {
          // Temporary amulet: (re)start its full duration — a second pickup of the same kind just
          // refreshes the clock rather than stacking, since these are on/off effects, not stats.
          const kind = AMULET_TILES[here];
          p.amulets = p.amulets || {};
          p.amulets[kind] = AMULET_DURATION;
          p.score += AMULET_SCORE;
        } else if (BOOST_TILES[here]) {
          // Permanent per-run boost: stacks up to BOOST_STACK_CAP, persists across levels (see
          // loadLevel — this field is never reset there) until a fresh addPlayer() (a new run).
          const stat = BOOST_TILES[here];
          p.runBoosts = p.runBoosts || {};
          p.runBoosts[stat] = Math.min(BOOST_STACK_CAP, (p.runBoosts[stat] || 0) + 1);
          p.score += BOOST_SCORE;
        }
        this.onEvent({ type: 'pickup', pid: p.id, item: here, x: tx, y: ty });
      } else if (here === T.TRANSPORTER) {
        this.tryTeleport(p);
      } else if (TRAP_PLATES[here] != null) {
        this.triggerPlate(here);
      } else if (here === T.ACID) {
        this.applyAcid(p, dt);
      } else if (here === T.STUN_TILE) {
        this.triggerStun(p, true);
      } else if ((here === T.EXIT || here === T.EXIT_SKIP) && !this.exitSealed) {
        p.score += LEVEL_BONUS;
        const skip = here === T.EXIT_SKIP ? 4 : 1;
        this.completed = { pid: p.id, levelTime: this.levelTime, players: this.players.size, skip };
        this.onEvent({ type: 'exit', pid: p.id, levelTime: this.levelTime, skip });
        return;
      }
      if (inp.potion) {
        inp.potion = false;
        if (p.potions > 0) {
          p.potions--;
          const magic = c.magic + p.perks.magicAdd + (p.runBoosts?.magic || 0) * BOOST_EFFECT.magic;
          this.usePotion(p, magic, 7.5 * (c.potionRadiusMul || 1) * (c.traitDef?.potionRadiusMul || 1));
        }
      }
    }
  }

  usePotion(p, magic, radius = 7.5, byShot = false) {
    let kills = 0;
    const dmg = byShot ? 1 : Math.ceil(magic * 2);
    for (const m of [...this.monsters.values()]) {
      if ((m.x - p.x) ** 2 + (m.y - p.y) ** 2 > radius * radius) continue;
      if (m.type === 'sorcerer' && m.visible === false) continue; // can't be hit while blinked out
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

  /** Sorcerer blink cycle (visible def.blinkVisible seconds, invisible def.blinkInvisible seconds) —
   *  while invisible it can't be hit by a shot or potion (see stepShots/usePotion) and the client
   *  renders it at 20% alpha off the `vis` snapshot flag. */
  stepSorcererBlink(m, def, dt) {
    if (m.visible === undefined) { m.visible = true; m.blinkTimer = def.blinkVisible; }
    m.blinkTimer -= dt;
    if (m.blinkTimer <= 0) {
      m.visible = !m.visible;
      m.blinkTimer = m.visible ? def.blinkVisible : def.blinkInvisible;
    }
  }
  /** Lobber AI (README's "Features" section, "New monster types"): holds 4-7 tiles from its target and lobs an arcing shot every ~2s that flies
   *  clean over walls, landing on the target's launch-time position (see stepShots's `arc` path). */
  stepLobber(m, def, dt) {
    const target = this.nearestPlayer(m.x, m.y, def.wakeRange, { skipInvisible: true });
    if (!target) { if (this.nearestPlayer(m.x, m.y, def.wakeRange)) this.wander(m, def, dt); return; }
    const dx = target.x - m.x, dy = target.y - m.y;
    const dist = Math.hypot(dx, dy) || 0.001;
    if (dist < def.minRange) this.moveEntity(m, -dx / dist * def.speed * dt, -dy / dist * def.speed * dt, 'monster');
    else if (dist > def.maxRange) this.moveEntity(m, dx / dist * def.speed * dt, dy / dist * def.speed * dt, 'monster');
    m.dir = dirIndex(dx, dy);
    if (m.shotCd === 0) {
      m.shotCd = def.shotCooldown;
      const sid = uid();
      this.shots.set(sid, {
        id: sid, owner: m.id, cls: 'lobber', x: m.x, y: m.y, x0: m.x, y0: m.y, tx: target.x, ty: target.y,
        vx: 0, vy: 0, dmg: def.shotDamage, dir: dirIndex(dx, dy), hostile: true, life: 999,
        arc: true, elapsed: 0, flight: 0.9,
      });
      this.onEvent({ type: 'sound', name: 'fireball', x: m.x, y: m.y });
    }
  }
  /** Thief AI (README's "Features" section, "New monster types"): hunts the nearest player carrying a key or potion, steals one on contact, then
   *  flees; despawns with the loot once 15+ tiles from every player. Killing it drops the item
   *  (see killMonster). Never touches/damages a player directly. */
  stepThief(m, def, dt) {
    if (m.stolen) {
      let nearest = null, nd = Infinity;
      for (const p of this.players.values()) { if (p.dead) continue; const d = Math.hypot(p.x - m.x, p.y - m.y); if (d < nd) { nd = d; nearest = p; } }
      if (!nearest) return;
      if (nd >= THIEF_DESPAWN_DIST) { this.monsters.delete(m.id); return; }
      const dx = m.x - nearest.x, dy = m.y - nearest.y;
      const dist = Math.hypot(dx, dy) || 0.001;
      this.moveEntity(m, dx / dist * def.speed * dt, dy / dist * def.speed * dt, 'monster');
      m.dir = dirIndex(-dx, -dy);
      return;
    }
    let target = null, td = Infinity;
    for (const p of this.players.values()) {
      if (p.dead || (p.keys <= 0 && p.potions <= 0)) continue;
      if (p.amulets?.invis > 0) continue; // invisibility: the thief can't sense you either
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < td) { td = d; target = p; }
    }
    if (!target) return; // nothing worth stealing right now (or nobody it can perceive)
    const dx = target.x - m.x, dy = target.y - m.y;
    const dist = Math.hypot(dx, dy) || 0.001;
    if (dist < 0.8) {
      if (target.amulets?.repulse > 0) return; // repulsiveness amulet: the thief can't touch you to steal
      if (target.potions > 0) { target.potions--; m.stolen = 'potion'; }
      else { target.keys--; m.stolen = 'key'; }
      this.onEvent({ type: 'steal', pid: target.id, item: m.stolen });
      return;
    }
    this.moveEntity(m, dx / dist * def.speed * dt, dy / dist * def.speed * dt, 'monster');
    m.dir = dirIndex(dx, dy);
  }

  /** Invisibility amulet: a monster with nobody it can target (its only nearby player is
   *  invisible) doesn't just freeze like it would when simply out of wakeRange — it wanders in a
   *  slowly-changing random direction instead, per the "monsters ignore you" arcade parity spec. */
  wander(m, def, dt) {
    if (m.wanderDir == null || Math.random() < 0.02) m.wanderDir = Math.random() * Math.PI * 2;
    const speed = (def.speed || 2) * 0.4;
    this.moveEntity(m, Math.cos(m.wanderDir) * speed * dt, Math.sin(m.wanderDir) * speed * dt, 'monster');
  }

  stepMonsters(dt) {
    const list = [...this.monsters.values()];
    for (const m of list) {
      const def = MONSTERS[m.type];
      m.cd = Math.max(0, m.cd - dt); m.shotCd = Math.max(0, m.shotCd - dt);
      // Pressure plates trigger for monsters too, not just heroes (#11's acceptance criteria).
      const underMonster = this.tile(Math.floor(m.x), Math.floor(m.y));
      if (TRAP_PLATES[underMonster] != null) this.triggerPlate(underMonster);
      // Stun tile (#12): a monster is frozen exactly like a hero — see triggerStun() — skipping all
      // AI/movement below (including a lobber's/thief's own step functions) for the duration.
      const monsterStunned = (m.stunTicks || 0) > 0;
      if (monsterStunned) m.stunTicks--;
      if (m.stunImmuneTicks > 0) m.stunImmuneTicks--;
      if (underMonster === T.STUN_TILE) this.triggerStun(m, false);
      if (monsterStunned) continue;
      if (m.type === 'sorcerer') this.stepSorcererBlink(m, def, dt);
      if (m.type === 'lobber') { this.stepLobber(m, def, dt); continue; }
      if (m.type === 'thief') { this.stepThief(m, def, dt); continue; }
      const target = this.nearestPlayer(m.x, m.y, def.wakeRange, { skipInvisible: true });
      if (!target) {
        if (this.nearestPlayer(m.x, m.y, def.wakeRange)) this.wander(m, def, dt);
        continue;
      }
      const dx = target.x - m.x, dy = target.y - m.y;
      const dist = Math.hypot(dx, dy) || 0.001;
      // contact — the repulsiveness amulet makes the target untouchable regardless of distance
      // (stepRepulsion() also actively pushes monsters away from that player each tick)
      if (dist < 0.8 && !(target.amulets?.repulse > 0)) {
        if (def.touchKills) {
          this.hurtPlayer(target, def.damage, m.type);
          this.monsters.delete(m.id);
          this.onEvent({ type: 'sound', name: 'ghost_hit', x: m.x, y: m.y });
          continue;
        } else if (m.type === 'death') {
          const take = Math.min(def.damage, def.drainTotal - m.drained);
          this.hurtPlayer(target, take / classOf(target).armor, 'death');
          m.drained += take;
          if (m.drained >= def.drainTotal) { this.monsters.delete(m.id); this.onEvent({ type: 'sound', name: 'death_leave', x: m.x, y: m.y }); }
          continue;
        } else if (m.cd === 0) {
          m.cd = def.hitCooldown;
          this.hurtPlayer(target, def.damage, m.type);
          this.onEvent({ type: 'sound', name: 'hit', mtype: m.type, x: m.x, y: m.y });
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
      const m = this.spawnMonster(g.type, g.x + dx + 0.5, g.y + dy + 0.5, GENERATOR_TIER_HP_BONUS[g.tier] || 0);
      if (m) this.onEvent({ type: 'sound', name: 'spawn', x: m.x, y: m.y });
    }
  }

  stepShots(dt) {
    for (const s of [...this.shots.values()]) {
      if (s.arc) {
        // Lobber shots fly clean over walls/monsters: no collision at all in flight, they just
        // count down to their landing time and damage anyone standing at the target spot (README's
        // "Features" section, "New monster types").
        s.elapsed += dt;
        const t = Math.min(1, s.elapsed / s.flight);
        s.x = s.x0 + (s.tx - s.x0) * t; s.y = s.y0 + (s.ty - s.y0) * t;
        if (s.elapsed >= s.flight) {
          // Force field (#12): even a lobber's over-the-walls arc can't land through one — it fizzles
          // on the field instead of damaging whoever's standing there.
          if (this.tile(Math.floor(s.tx), Math.floor(s.ty)) === T.FORCE_FIELD) {
            this.onEvent({ type: 'spark', x: s.tx, y: s.ty });
          } else {
            for (const p of this.players.values()) {
              if (p.dead) continue;
              if (Math.hypot(p.x - s.tx, p.y - s.ty) <= 0.8) this.hurtPlayer(p, s.dmg, 'lobber');
            }
            this.onEvent({ type: 'lob_land', x: s.tx, y: s.ty });
          }
          this.shots.delete(s.id);
        }
        continue;
      }
      s.life -= dt;
      if (s.life <= 0) { this.shots.delete(s.id); continue; }
      // homing (Hero Builder skull weapon): a gentle nudge of velocity toward the nearest monster
      // each tick, not a guaranteed hit — `s.homing` is the 0-1 turn-strength fraction from WEAPONS.
      if (!s.hostile && s.homing) {
        const target = this.nearestMonster(s.x, s.y, 10);
        if (target) {
          const speedMag = Math.hypot(s.vx, s.vy) || 1;
          const tdx = target.x - s.x, tdy = target.y - s.y;
          const td = Math.hypot(tdx, tdy) || 1;
          const turn = Math.min(1, s.homing * dt * 4);
          let nvx = s.vx + (tdx / td * speedMag - s.vx) * turn;
          let nvy = s.vy + (tdy / td * speedMag - s.vy) * turn;
          const nmag = Math.hypot(nvx, nvy) || 1;
          s.vx = nvx / nmag * speedMag; s.vy = nvy / nmag * speedMag;
        }
      }
      const steps = 2; // sub-step so fast shots don't tunnel through 1-tile walls
      let done = false;
      for (let k = 0; k < steps && !done; k++) {
        const px = s.x, py = s.y; // pre-substep position, for reflect's axis-of-impact check below
        s.x += s.vx * dt / steps; s.y += s.vy * dt / steps;
        const tx = Math.floor(s.x), ty = Math.floor(s.y);
        const c = this.tile(tx, ty);
        if (s.hostile) {
          if (c === T.FORCE_FIELD) { this.onEvent({ type: 'spark', x: s.x, y: s.y }); done = true; break; }
          if (this.isSolidFor(c, 'shot')) { done = true; break; }
          for (const p of this.players.values()) {
            if (p.dead) continue;
            if (Math.abs(p.x - s.x) < HALF + 0.15 && Math.abs(p.y - s.y) < HALF + 0.15) { this.hurtPlayer(p, s.dmg, 'fireball'); done = true; break; }
          }
          continue;
        }
        const owner = this.players.get(s.owner);
        if (GENERATOR_TILES.has(c)) { const g = this.generators.get(`${tx},${ty}`); if (g) this.damageGenerator(g, s.dmg, owner); done = true; break; }
        // Force field (#12): absorbs the shot outright (no reflect-amulet bounce off it — it's a
        // field, not a wall) with a spark instead of the usual silent stop.
        if (c === T.FORCE_FIELD) { this.onEvent({ type: 'spark', x: s.x, y: s.y }); done = true; break; }
        if (c === T.WALL || c === T.DOOR || c === T.TRAP || GROUP_WALLS.has(c) || TIMED_WALLS.has(c)) {
          // Reflective shots amulet: bounce off a wall once (mirror the axis that was actually
          // blocked, so a shot hitting a wall square-on bounces straight back, and one clipping a
          // corner bounces diagonally) instead of dying here.
          if (s.reflect && !s.bounced) {
            const hitX = this.isSolidFor(this.tile(Math.floor(s.x), Math.floor(py)), 'shot');
            const hitY = this.isSolidFor(this.tile(Math.floor(px), Math.floor(s.y)), 'shot');
            if (hitX) s.vx = -s.vx;
            if (hitY || (!hitX && !hitY)) s.vy = -s.vy;
            s.bounced = true;
            s.x = px; s.y = py; // undo this substep's move so the shot isn't left embedded in the wall
            s.dir = dirIndex(s.vx, s.vy);
            continue;
          }
          done = true; break;
        }
        if (c === T.FOOD || c === T.CIDER) { this.setTile(tx, ty, T.FLOOR); if (owner) this.onEvent({ type: 'food_shot', pid: s.owner, x: tx, y: ty }); done = true; break; }
        if (c === T.POISON_FOOD) { this.setTile(tx, ty, T.FLOOR); done = true; break; } // harmless — no penalty for shooting the poison
        if (c === T.POTION) { this.setTile(tx, ty, T.FLOOR); if (owner) this.usePotion({ ...owner, x: tx + 0.5, y: ty + 0.5, id: owner.id }, 1, 4, true); done = true; break; }
        for (const m of this.monsters.values()) {
          if (Math.abs(m.x - s.x) < HALF + 0.15 && Math.abs(m.y - s.y) < HALF + 0.15) {
            if (m.type === 'sorcerer' && m.visible === false) continue; // shot passes through while blinked out
            // Super shots amulet: pierce straight through instead of stopping, damaging every
            // monster it passes exactly once (the `hit` set below keeps a slow-moving shot from
            // re-damaging the same monster across several sub-steps/ticks while still overlapping it).
            if (s.pierce) { s.hit = s.hit || new Set(); if (s.hit.has(m.id)) continue; s.hit.add(m.id); }
            else done = true;
            if (MONSTERS[m.type].immune) { this.onEvent({ type: 'sound', name: 'clank', x: m.x, y: m.y }); if (s.pierce) continue; break; }
            m.hp -= s.dmg;
            if (m.hp <= 0) this.killMonster(m, owner); else this.onEvent({ type: 'sound', name: 'hit', mtype: m.type, x: m.x, y: m.y });
            // splash (Hero Builder fireball-style weapons): also damage OTHER monsters near the
            // impact point for `s.splash` fraction of the shot's damage — a single hit can't
            // double-dip the primary target through this.
            if (s.splash > 0) this.applySplash(m, s.dmg * s.splash, owner);
            if (s.pierce) continue;
            break;
          }
        }
      }
      if (done) this.shots.delete(s.id);
    }
  }
  /** Deal `dmg` to every monster (other than `origin`, already hit directly) within SPLASH_RADIUS
   *  of `origin`'s position — see stepShots' weaponDef.splash handling. */
  applySplash(origin, dmg, owner) {
    for (const m of [...this.monsters.values()]) {
      if (m === origin) continue;
      if (MONSTERS[m.type].immune) continue;
      if (m.type === 'sorcerer' && m.visible === false) continue;
      if (Math.hypot(m.x - origin.x, m.y - origin.y) > SPLASH_RADIUS) continue;
      m.hp -= dmg;
      if (m.hp <= 0) this.killMonster(m, owner); else this.onEvent({ type: 'sound', name: 'hit', mtype: m.type, x: m.x, y: m.y });
    }
  }

  // ---------- network view ----------
  /** Compact per-player boost-pip string for the snapshot's `p` array: each stacked run-boost
   *  contributes its BOOST_LETTER repeated once per stack (e.g. speed x2 + armor x1 -> "VVA") —
   *  see client/game.js's HUD boost pips. Empty string when there are no run-boosts. */
  encodeBoosts(runBoosts) {
    if (!runBoosts) return '';
    let out = '';
    for (const stat of Object.keys(BOOST_EFFECT)) {
      const n = runBoosts[stat] || 0;
      if (n > 0) out += BOOST_LETTER[stat].repeat(n);
    }
    return out;
  }
  /** Compact per-player amulet string for the snapshot's `p` array: each active amulet contributes
   *  its AMULET_LETTER plus its remaining whole seconds, zero-padded to 2 digits (e.g. invis with
   *  12.4s left + reflect with 5s left -> "I12R05") — see client/game.js's HUD countdown. Empty
   *  string when nothing is active. */
  encodeAmulets(amulets) {
    if (!amulets) return '';
    let out = '';
    for (const kind of Object.keys(AMULET_LETTER)) {
      const left = amulets[kind];
      if (left > 0) out += AMULET_LETTER[kind] + String(Math.min(99, Math.ceil(left))).padStart(2, '0');
    }
    return out;
  }
  snapshot() {
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      t: 's', tick: Math.round(this.time * 20), lt: Math.round(this.levelTime),
      // 10th element: compact run-boost pip string (encodeBoosts). 11th: compact active-amulet
      // string with remaining seconds (encodeAmulets). 12th (#12): remaining stun ticks (0 when not
      // stunned) — the client renders stun stars while it's positive. See README's "Amulets and
      // boosts" and "Environmental hazards" sections.
      p: [...this.players.values()].map((p) => [
        p.id, r2(p.x), r2(p.y), p.dir, Math.round(p.hp), p.keys, p.potions, p.score, p.dead ? 1 : 0,
        this.encodeBoosts(p.runBoosts), this.encodeAmulets(p.amulets), p.stunTicks || 0,
      ]),
      // 6th element: 1 while a sorcerer is blinked invisible (client draws it at 20% alpha); omitted
      // otherwise. 7th (#12): remaining stun ticks when a monster is frozen on a stun tile; omitted
      // (falls back to 0/falsy) otherwise.
      m: [...this.monsters.values()].map((m) => [m.id, MONSTERS[m.type].snapKey, r2(m.x), r2(m.y), m.dir, m.visible === false ? 1 : undefined, m.stunTicks > 0 ? m.stunTicks : undefined]),
      g: [...this.generators.values()].map((g) => [g.x, g.y, g.hp]),
      // 6th element on an arc (lobber) shot: flight progress 0..1, for the client's growing/shrinking scale.
      // 7th element (player shots only): owner pid — a custom hero's shotKey ('c') is shared by
      // every weapon, so the client needs the owner to look up which weapon sprite to draw (see
      // playerInfo()'s `weapon` field).
      b: [...this.shots.values()].map((s) => {
        const type = s.hostile ? (s.arc ? 'a' : 'd') : (s.shotKey || CLASSES[s.cls]?.shotKey || s.cls[0]);
        return [s.id, r2(s.x), r2(s.y), s.dir, type, s.arc ? r2(Math.min(1, s.elapsed / s.flight)) : undefined, s.hostile ? undefined : s.owner];
      }),
      // Timed walls (#11): [x, y, wholeSecondsLeft] — cheap (a level has at most a handful) and
      // lets the client pulse them more urgently as their timer runs down.
      tw: this.timedWalls.map((t) => [t.x, t.y, Math.max(0, Math.ceil(t.remaining))]),
    };
  }
  playerInfo() {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, cls: p.cls, palette: p.palette || null, score: p.score, kills: p.kills, dead: p.dead, rank: p.rank, title: p.title,
      boosts: p.boosts && Object.keys(p.boosts).length ? Object.keys(p.boosts) : undefined,
      // Hero Builder heroes only — display-only portrait data plus which weapon (== sprite id,
      // see shared/hero-builder.js WEAPONS) their shots should render as (see snapshot()'s `b`).
      custom: p.custom || undefined,
      weapon: p.classDef?.weapon || undefined,
    }));
  }
}
