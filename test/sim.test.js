import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../server/game/sim.js';
import { CLASSES, MONSTERS, SNAP_KEY_TO_MONSTER, START_HEALTH, DT } from '../shared/constants.js';

const ARENA = {
  name: 'arena',
  rows: [
    '################',
    '#S.............#',
    '#..............#',
    '#....K.........#',
    '#..............#',
    '#......######D##',
    '#......#......E#',
    '#......#.......#',
    '#......#..F....#',
    '#......#.......#',
    '#......#..P....#',
    '#......#.......#',
    '#......#.......#',
    '#......#.......#',
    '#..............#',
    '################',
  ],
};
const run = (sim, ticks) => { for (let i = 0; i < ticks; i++) sim.step(DT); };

test('players spawn at S, drain health over time and are blocked by walls', () => {
  const sim = new Sim(ARENA);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  assert.deepEqual([Math.floor(p.x), Math.floor(p.y)], [1, 1]);
  sim.setInput('a', { dx: -1, dy: -1 });
  run(sim, 40);
  assert.ok(p.x > 1 && p.y > 1, 'stays inside the wall');
  assert.ok(p.hp < START_HEALTH && p.hp > START_HEALTH - 5, `health drains slowly: ${p.hp}`);
});

test('keys open doors, pickups are collected, exit completes the level', () => {
  const events = [];
  const sim = new Sim(ARENA, { onEvent: (e) => events.push(e) });
  const p = sim.addPlayer('a', { name: 'A', cls: 'elf' });
  // walk to the key at (5,3)
  p.x = 5.5; p.y = 1.5; sim.setInput('a', { dx: 0, dy: 1 }); run(sim, 12);
  assert.equal(p.keys, 1, 'picked up key');
  // stand under the door and push into it
  p.x = 13.5; p.y = 4.5; sim.setInput('a', { dx: 0, dy: 1 }); run(sim, 10);
  assert.equal(p.keys, 0, 'key consumed');
  assert.equal(sim.grid[5][13], '.', 'door opened');
  assert.ok(events.some((e) => e.type === 'door'));
  // food heals, potion is stored, exit completes
  p.hp = 100; p.x = 10.5; p.y = 7.5; sim.setInput('a', { dx: 0, dy: 1 }); run(sim, 8);
  assert.equal(p.hp > 150, true, 'ate food');
  assert.ok(events.some((e) => e.type === 'food' && e.lowHealth), 'low-health food event fires');
  run(sim, 8);
  assert.equal(p.potions, 1);
  p.x = 14.5; p.y = 5.9; sim.setInput('a', { dx: 0, dy: 1 }); run(sim, 8);
  assert.ok(sim.completed, 'level completed');
  assert.equal(sim.completed.pid, 'a');
});

test('shots kill monsters and destroy generators; food can be shot', () => {
  const events = [];
  const sim = new Sim(ARENA, { onEvent: (e) => events.push(e) });
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.x = 2.5; p.y = 2.5; p.dir = 2; // face east
  sim.spawnMonster('grunt', 6.5, 2.5);
  sim.setInput('a', { dx: 0, dy: 0, fire: true });
  run(sim, 20);
  assert.equal(sim.monsters.size, 0, 'grunt died');
  assert.equal(p.score, 20);
  assert.ok(events.some((e) => e.type === 'kill' && e.monster === 'grunt'));
  // generator
  sim.grid[2][10] = 'g'; sim.generators.set('10,2', { x: 10, y: 2, type: 'grunt', tile: 'g', hp: 3, timer: 99 });
  run(sim, 40);
  assert.equal(sim.generators.size, 0, 'generator destroyed');
  assert.equal(sim.grid[2][10], '.');
  // shooting food destroys it
  sim.setInput('a', { fire: false }); p.x = 8.5; p.y = 8.5; p.dir = 2; sim.setInput('a', { fire: true });
  run(sim, 10);
  assert.ok(events.some((e) => e.type === 'food_shot'), 'shot the food');
});

test('ghosts die on contact and hurt the player; death and respawn work', () => {
  const events = [];
  const sim = new Sim(ARENA, { onEvent: (e) => events.push(e) });
  const p = sim.addPlayer('a', { name: 'A', cls: 'wizard' });
  p.x = 3.5; p.y = 3.5; sim.spawnMonster('ghost', 4.2, 3.5);
  run(sim, 5);
  assert.equal(sim.monsters.size, 0);
  assert.ok(p.hp < START_HEALTH - 10);
  p.hp = 0.5; run(sim, 20);
  assert.equal(p.dead, true);
  assert.ok(events.some((e) => e.type === 'death'));
  sim.setInput('a', { respawn: true }); run(sim, 1);
  assert.equal(p.dead, false); assert.equal(p.hp, START_HEALTH); assert.equal(p.coins, 1);
});

test('potion clears nearby monsters and Death only dies to magic', () => {
  const sim = new Sim(ARENA);
  const p = sim.addPlayer('a', { name: 'A', cls: 'wizard' });
  p.x = 3.5; p.y = 3.5; p.potions = 1;
  sim.spawnMonster('demon', 5.5, 3.5); sim.spawnMonster('death', 6.5, 6.5); sim.spawnMonster('ghost', 30, 30);
  sim.setInput('a', { potion: true }); run(sim, 1);
  assert.equal(sim.monsters.size, 1, 'only the far ghost remains');
  assert.equal(p.score, 30 + 1000);
});

test('addPlayer perks are optional (backward compatible) and apply speed/health/damage caps when given', () => {
  const sim = new Sim(ARENA);
  const base = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  assert.equal(base.maxHealth, START_HEALTH, 'no perks means no health bonus');
  assert.equal(base.perks.speedMul, 1);

  const perked = sim.addPlayer('b', {
    name: 'B', cls: 'warrior', userId: 1,
    perks: { speedMul: 1.15, shotDamageAdd: 1, damageTakenMul: 0.85, maxHealthBonus: 200, magicAdd: 1 },
  });
  assert.equal(perked.maxHealth, START_HEALTH + 200, 'max health perk raises starting/spawn health');
  assert.equal(perked.hp, perked.maxHealth);
  assert.equal(perked.perks.speedMul, 1.15);

  // damage-taken perk reduces incoming damage relative to an unperked player of the same class
  sim.hurtPlayer(base, 100, 'test');
  sim.hurtPlayer(perked, 100, 'test');
  const baseDamage = START_HEALTH - base.hp;
  const perkedDamage = perked.maxHealth - perked.hp;
  assert.ok(perkedDamage < baseDamage, 'perked player takes less damage from the same hit');
});

test('new hero archetypes spawn with their own stat blocks and distinct shot sprite keys', () => {
  const sim = new Sim(ARENA);
  const pal = sim.addPlayer('a', { name: 'A', cls: 'paladin' });
  assert.equal(pal.cls, 'paladin');
  assert.ok(CLASSES.paladin.armor < CLASSES.warrior.armor, 'paladin has heavier armor than warrior');
  sim.addPlayer('b', { name: 'B', cls: 'ranger' });
  assert.ok(CLASSES.ranger.shotCooldown < CLASSES.elf.shotCooldown, 'ranger fires faster than elf');
  const necro = sim.addPlayer('c', { name: 'C', cls: 'necromancer' });
  assert.equal(necro.cls, 'necromancer');
  assert.ok(CLASSES.necromancer.potionRadiusMul > 1, 'necromancer potions reach further');
  // sim falls back to warrior for an unknown class, same as before these archetypes existed
  const unknown = sim.addPlayer('d', { name: 'D', cls: 'not_a_class' });
  assert.equal(unknown.cls, 'warrior');
  // every class's shot sprite key (see snapshot() and client/sprites.js SHOT_SPRITE) is distinct
  const keys = Object.values(CLASSES).map((c) => c.shotKey);
  assert.equal(new Set(keys).size, keys.length, 'no two classes share a shot key');
});

test('a player\'s palette id travels into playerInfo() so other clients can render the tint', () => {
  const sim = new Sim(ARENA);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior', palette: 'warrior_gold' });
  assert.equal(p.palette, 'warrior_gold');
  const info = sim.playerInfo().find((i) => i.id === 'a');
  assert.equal(info.palette, 'warrior_gold');
  const noPalette = sim.addPlayer('b', { name: 'B', cls: 'elf' });
  assert.equal(noPalette.palette, null);
});

test('necromancer\'s wider potion radius reaches monsters a normal potion would miss', () => {
  const sim = new Sim(ARENA);
  const p = sim.addPlayer('a', { name: 'A', cls: 'necromancer' });
  p.x = 1.5; p.y = 1.5; p.potions = 1;
  // 8.4 tiles away: outside the base 7.5 radius but inside necromancer's boosted 7.5*1.3=9.75
  sim.spawnMonster('ghost', 1.5, 9.9);
  sim.setInput('a', { potion: true });
  run(sim, 1);
  assert.equal(sim.monsters.size, 0, "necromancer's wider potion radius reached the distant ghost");
});

test('lobber arc shot flies over a wall and damages the target on landing', () => {
  const events = [];
  const sim = new Sim(ARENA, { onEvent: (e) => events.push(e) });
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.x = 8.5; p.y = 10.5; // behind the wall at column 7, inside the little room with food/potion
  const m = sim.spawnMonster('lobber', 3.5, 10.5); // outside the walled room, on the other side of the wall
  // The lobber should hold its distance rather than walking through/around the wall to melee.
  run(sim, 25); // ~1.25s: its first shot (fired ~1s in) should be in flight now
  assert.equal(sim.monsters.has(m.id), true, 'lobber is still alive, not adjacent to melee');
  const arc = [...sim.shots.values()].find((s) => s.arc);
  assert.ok(arc, 'the lobber fired an arcing shot within a couple of seconds');
  assert.equal(arc.tx, p.x); assert.equal(arc.ty, p.y);
  const before = p.hp;
  run(sim, 20); // its 0.9s flight time has now elapsed
  assert.equal([...sim.shots.values()].some((s) => s.arc), false, 'the arc shot landed and was removed');
  assert.ok(p.hp < before, 'the landing shot damaged the target through the wall');
});

test('sorcerer cannot be hit by a shot or potion while blinked invisible', () => {
  const sim = new Sim(ARENA);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.x = 2.5; p.y = 2.5; p.dir = 2; p.potions = 1;
  const m = sim.spawnMonster('sorcerer', 6.5, 2.5);
  m.visible = false; m.blinkTimer = 10; // force (and hold) invisible for this test
  sim.setInput('a', { dx: 0, dy: 0, fire: true });
  run(sim, 20); // several shots would have crossed its position by now
  assert.equal(sim.monsters.has(m.id), true, 'shots pass through an invisible sorcerer');
  sim.setInput('a', { fire: false });
  sim.setInput('a', { potion: true });
  run(sim, 1);
  assert.equal(sim.monsters.has(m.id), true, 'a potion cannot hit an invisible sorcerer either');
  m.visible = true; m.blinkTimer = 10;
  p.x = 2.5; p.y = 2.5; p.dir = 2; m.x = 6.5; m.y = 2.5;
  sim.setInput('a', { fire: true });
  run(sim, 20);
  assert.equal(sim.monsters.has(m.id), false, 'once visible again, a shot kills it normally');
});

test('thief steals a potion, flees, and drops it when killed', () => {
  const events = [];
  const sim = new Sim(ARENA, { onEvent: (e) => events.push(e) });
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.x = 5.5; p.y = 5.5; p.potions = 1;
  const m = sim.spawnMonster('thief', 5.6, 5.5);
  run(sim, 5);
  assert.equal(p.potions, 0, 'the thief stole the potion on contact');
  assert.equal(m.stolen, 'potion');
  assert.ok(events.some((e) => e.type === 'steal' && e.item === 'potion'));
  // Kill it while it's fleeing with the loot — it should drop a potion tile where it died.
  m.hp = 1;
  const tx = Math.floor(m.x), ty = Math.floor(m.y);
  sim.grid[ty][tx] = '.';
  sim.killMonster(m, p);
  assert.equal(sim.grid[ty][tx], 'P', 'the stolen potion is dropped as a tile on death');
});

test('a transporter teleports a player to the other pad, with a cooldown against ping-pong', () => {
  const TP = {
    name: 'tp',
    rows: [
      '################',
      '#S.............#',
      '#..............#',
      '#..X...........#',
      '#..............#',
      '#..............#',
      '#..............#',
      '#..............#',
      '#..............#',
      '#..............#',
      '#............E.#',
      '#............X.#',
      '#..............#',
      '#..............#',
      '#..............#',
      '################',
    ],
  };
  const events = [];
  const sim = new Sim(TP, { onEvent: (e) => events.push(e) });
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.x = 3.5; p.y = 3.5;
  run(sim, 1);
  assert.ok(p.x > 10 || p.y > 9, 'teleported to the other pad');
  assert.ok(events.some((e) => e.type === 'teleport' && e.pid === 'a'));
  const afterFirst = { x: p.x, y: p.y };
  run(sim, 1); // still standing on the destination pad — cooldown must block an immediate bounce-back
  assert.equal(p.x, afterFirst.x); assert.equal(p.y, afterFirst.y);
});

test('poison food costs health (floored at 1) and cider heals', () => {
  const sim = new Sim(ARENA);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.grid[3][3] = '!';
  p.x = 3.5; p.y = 3.5; p.hp = 50;
  run(sim, 1);
  assert.equal(p.hp, 1, 'poison food costs 100 health but floors at 1');
  sim.grid[3][4] = 'C';
  p.hp = 500;
  p.x = 4.5; p.y = 3.5;
  run(sim, 1);
  assert.ok(p.hp > 545 && p.hp <= 550, `cider heals ~50: ${p.hp}`);
});

test('shooting poison food is harmless (no food_shot event); shooting cider counts as shooting food', () => {
  const events = [];
  const sim = new Sim(ARENA, { onEvent: (e) => events.push(e) });
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.grid[2][6] = '!';
  p.x = 2.5; p.y = 2.5; p.dir = 2;
  sim.setInput('a', { fire: true });
  run(sim, 12);
  assert.equal(sim.grid[2][6], '.', 'the poison food was destroyed');
  assert.equal(events.some((e) => e.type === 'food_shot'), false, 'no penalty for shooting the poison');
  events.length = 0;
  sim.setInput('a', { fire: false });
  sim.grid[2][6] = 'C';
  sim.setInput('a', { fire: true });
  run(sim, 12);
  assert.ok(events.some((e) => e.type === 'food_shot'), 'shooting cider is treated like shooting food');
});

test('players block each other: a move that would overlap another player within 0.7 tiles is cancelled on that axis', () => {
  const sim = new Sim(ARENA);
  const a = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  const b = sim.addPlayer('b', { name: 'B', cls: 'warrior' });
  a.x = 5; a.y = 5; b.x = 5.5; b.y = 5;
  sim.moveEntity(a, 0.3, 0, 'player'); // would land a.x=5.3, within 0.7 of b.x=5.5
  assert.equal(a.x, 5, 'the move into another player is cancelled');
  sim.moveEntity(a, 0, 1, 'player'); // orthogonal move, no other player nearby on that axis
  assert.equal(a.y, 6);
  // Player shots still pass through teammates: standing shoulder to shoulder does not block fire.
  a.x = 5; a.y = 5; a.dir = 2; b.x = 6; b.y = 5;
  sim.setInput('a', { dx: 0, dy: 0, fire: true });
  run(sim, 1);
  assert.ok(b.hp > b.maxHealth - 1, "a teammate's shot never damages another player (only the 1-tick health drain applies)");
});

test('snapshot is compact and level packet round-trips', () => {
  const sim = new Sim(ARENA);
  sim.addPlayer('a', { name: 'A', cls: 'valkyrie' });
  const s = sim.snapshot();
  assert.equal(s.t, 's'); assert.equal(s.p.length, 1); assert.equal(s.p[0].length, 9);
  const lp = sim.levelPacket();
  assert.equal(lp.rows.length, 16); assert.equal(lp.rows[0].length, 16);
});

test('every monster type has a unique snapKey, and snapshot() maps each back to its real type', () => {
  const types = Object.keys(MONSTERS);
  const keys = types.map((t) => MONSTERS[t].snapKey);
  for (const k of keys) assert.equal(typeof k, 'string');
  for (const k of keys) assert.equal(k.length, 1, `snapKey "${k}" must be a single character`);
  assert.equal(new Set(keys).size, keys.length, `snapKeys must be unique: ${keys.join(',')}`);
  // ghost/grunt (both start with "g") and demon/death (both start with "d") are exactly the
  // collision this test guards against — see shared/constants.js's MONSTERS comment.
  assert.notEqual(MONSTERS.ghost.snapKey, MONSTERS.grunt.snapKey);
  assert.notEqual(MONSTERS.demon.snapKey, MONSTERS.death.snapKey);

  const sim = new Sim(ARENA);
  let x = 2.5;
  for (const type of types) { sim.spawnMonster(type, x, 2.5); x += 1; }
  const snap = sim.snapshot();
  assert.equal(snap.m.length, types.length);
  for (const row of snap.m) {
    const [, snapKey] = row;
    const resolved = SNAP_KEY_TO_MONSTER[snapKey];
    assert.ok(resolved, `snapKey "${snapKey}" should resolve back to a monster type`);
    const m = sim.monsters.get(row[0]);
    assert.equal(resolved, m.type, `snapshot key for a ${m.type} must map back to "${m.type}", got "${resolved}"`);
  }
});
