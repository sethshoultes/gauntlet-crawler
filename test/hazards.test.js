// Arcade parity (#12): acid puddles, stun tiles and force fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../server/game/sim.js';
import { T, DT, STUN_TICKS, STUN_IMMUNITY_TICKS } from '../shared/constants.js';
import { validateLevel } from '../shared/level.js';
import { generateLevel } from '../shared/procgen.js';

const run = (sim, ticks) => { for (let i = 0; i < ticks; i++) sim.step(DT); };

const ROOM = {
  name: 'room',
  rows: [
    '################',
    '#S.............#',
    '#..............#',
    '#..............#',
    '#..............#',
    '#..............#',
    '#..............#',
    '#..............#',
    '#..............#',
    '#..............#',
    '#.............E#',
    '################',
  ],
};

// ---------------- acid ----------------

test('acid puddle damages a hero standing on it every tick, scaled by armor like any other damage', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' }); // warrior armor 0.7
  sim.grid[5][5] = T.ACID;
  p.x = 5.5; p.y = 5.5;
  const before = p.hp;
  run(sim, 20); // 1 second
  const lost = before - p.hp;
  // Health drain (1/s) plus acid (10/s * 0.7 armor = 7/s) ~= 8/s; allow generous tolerance for the
  // dt-integration and drain ordering, but this must be well above plain hunger drain alone (1/s).
  assert.ok(lost > 5 && lost < 10, `expected ~8hp lost to armor-scaled acid + drain over 1s, got ${lost}`);

  // A second player with an armor run-boost takes measurably less acid damage than the first.
  const sim2 = new Sim(ROOM);
  const p2 = sim2.addPlayer('b', { name: 'B', cls: 'warrior' });
  sim2.grid[5][5] = T.ACID;
  p2.x = 5.5; p2.y = 5.5;
  p2.runBoosts.armor = 2; // -12%/stack, see BOOST_EFFECT.armor
  const before2 = p2.hp;
  run(sim2, 20);
  const lost2 = before2 - p2.hp;
  assert.ok(lost2 < lost, 'an armor run-boost reduces acid damage exactly like it reduces any other damage source');
});

test('monsters standing on acid take no damage at all', () => {
  const sim = new Sim(ROOM);
  sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.grid[5][5] = T.ACID;
  const m = sim.spawnMonster('grunt', 5.5, 5.5);
  const hpBefore = m.hp;
  run(sim, 60); // 3 seconds standing in the puddle
  assert.equal(sim.monsters.get(m.id).hp, hpBefore, 'a monster is immune to acid — it is native to the dungeon');
});

// ---------------- stun ----------------

test('stepping onto a stun tile freezes a hero on contact', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.grid[5][6] = T.STUN_TILE;
  p.x = 5.5; p.y = 5.5; p.dir = 2; // one tile west, facing east
  sim.setInput('a', { dx: 1, dy: 0 });
  run(sim, 6); // walk onto it
  assert.ok(p.stunTicks > 0, 'contact with the stun tile froze the hero');
  assert.ok(p.stunImmuneTicks >= p.stunTicks, 'the immunity window always covers at least the freeze itself');
});

test('a stun freeze blocks firing for its whole duration, then firing works again', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.x = 5.5; p.y = 5.5; p.dir = 2;
  sim.triggerStun(p, true);
  sim.setInput('a', { dx: 0, dy: 0, fire: true });
  run(sim, STUN_TICKS);
  assert.equal(sim.shots.size, 0, 'no shot fired for the entire frozen window');
  run(sim, 1);
  assert.equal(sim.shots.size, 1, 'firing works again the instant the freeze ends');
});

test('a stun freeze blocks movement for its whole duration, then movement works again', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.x = 5.5; p.y = 5.5;
  sim.triggerStun(p, true);
  sim.setInput('a', { dx: 1, dy: 0 });
  run(sim, STUN_TICKS);
  assert.equal(p.x, 5.5, 'no movement for the entire frozen window');
  run(sim, 1);
  assert.ok(p.x > 5.5, 'movement resumes the instant the freeze ends');
});

test('the post-freeze immunity window stops an immediate retrigger, then a later contact retriggers it', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.grid[5][5] = T.STUN_TILE;
  p.x = 5.5; p.y = 5.5; // standing on the tile throughout — never moves in this test
  sim.triggerStun(p, true);
  assert.equal(p.stunTicks, STUN_TICKS);
  assert.equal(p.stunImmuneTicks, STUN_TICKS + STUN_IMMUNITY_TICKS);

  run(sim, STUN_TICKS); // freeze ends
  assert.equal(p.stunTicks, 0, 'freeze has worn off');
  assert.equal(p.stunImmuneTicks, STUN_IMMUNITY_TICKS, 'exactly the immunity window remains');

  run(sim, STUN_IMMUNITY_TICKS - 1);
  assert.equal(p.stunTicks, 0, 'still within the immunity window — standing on the same tile does not refreeze');

  run(sim, 1); // immunity fully elapses this tick, and contact is still active
  assert.equal(p.stunTicks, STUN_TICKS, 'a fresh contact once immunity fully expires retriggers the stun');
});

test('a monster stepping onto a stun tile is frozen the same way, then resumes chasing once unfrozen', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.x = 6.5; p.y = 5.5; // within wakeRange, but far enough not to be touched while the monster is frozen
  sim.grid[5][8] = T.STUN_TILE;
  const m = sim.spawnMonster('grunt', 8.5, 5.5);
  run(sim, 1);
  assert.ok(m.stunTicks > 0, 'contact with the stun tile froze the monster');
  const frozenX = m.x, frozenY = m.y;
  run(sim, STUN_TICKS - 1);
  assert.equal(m.x, frozenX); assert.equal(m.y, frozenY);
  run(sim, 60); // past the freeze and well into the immunity window
  assert.ok(m.x !== frozenX || m.y !== frozenY, 'the monster resumes its AI (chasing) once unfrozen');
});

// ---------------- force field ----------------

test('a force field is solid only to shots — never to a hero or a monster', () => {
  const sim = new Sim(ROOM);
  assert.equal(sim.isSolidFor(T.FORCE_FIELD, 'player'), false);
  assert.equal(sim.isSolidFor(T.FORCE_FIELD, 'monster'), false);
  assert.equal(sim.isSolidFor(T.FORCE_FIELD, 'shot'), true);
});

test('a hero walks straight through a force-field tile, unobstructed', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.grid[5][8] = T.FORCE_FIELD;
  p.x = 6.5; p.y = 5.5;
  sim.setInput('a', { dx: 1, dy: 0 });
  run(sim, 40);
  assert.ok(p.x > 8.5, 'the hero passed straight through the force-field tile');
});

test('a force field destroys a player shot on contact, with a spark, before it reaches a monster', () => {
  const sim = new Sim(ROOM);
  sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.grid[5][8] = T.FORCE_FIELD;
  const m = sim.spawnMonster('grunt', 11.5, 5.5);
  const sparks = [];
  sim.onEvent = (e) => { if (e.type === 'spark') sparks.push(e); };
  sim.shots.set(1, { id: 1, owner: 'a', x: 6.5, y: 5.5, vx: 12, vy: 0, dmg: 3, dir: 2, hostile: false, life: 5 });
  run(sim, 20);
  assert.equal(sim.shots.size, 0, 'the player shot was consumed by the force field');
  assert.ok(sparks.length > 0, 'a spark event fired on impact');
  assert.ok(sim.monsters.has(m.id), 'the monster behind the field survived untouched');
});

test('a force field destroys a hostile shot before it can hit a player, with a spark', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.x = 10.5; p.y = 5.5;
  sim.grid[5][8] = T.FORCE_FIELD;
  const sparks = [];
  sim.onEvent = (e) => { if (e.type === 'spark') sparks.push(e); };
  sim.shots.set(2, { id: 2, owner: null, x: 6.5, y: 5.5, vx: 7, vy: 0, dmg: 15, dir: 2, hostile: true, life: 5 });
  const before = p.hp;
  run(sim, 20);
  assert.equal(sim.shots.size, 0, 'the hostile shot was destroyed at the force field');
  assert.ok(sparks.length > 0, 'a spark event fired on impact');
  assert.ok(p.hp > before - 5, 'the player behind the field took no shot damage (only the per-tick hunger drain)');
});

test("a force field swallows a lobber shot at landing time instead of damaging whoever's standing there", () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.grid[5][8] = T.FORCE_FIELD;
  p.x = 8.5; p.y = 5.5; // standing right on the guarded tile
  const sparks = [];
  sim.onEvent = (e) => { if (e.type === 'spark') sparks.push(e); };
  sim.shots.set(3, {
    id: 3, owner: null, cls: 'lobber', x: 8.5, y: 5.5, x0: 6.5, y0: 5.5, tx: 8.5, ty: 5.5,
    vx: 0, vy: 0, dmg: 15, dir: 2, hostile: true, life: 999, arc: true, elapsed: 0.85, flight: 0.9,
  });
  const before = p.hp;
  run(sim, 2); // cross the 0.9s flight mark
  assert.equal(sim.shots.size, 0, 'the arc shot landed (and was consumed) at the force field');
  assert.ok(sparks.some((e) => Math.abs(e.x - 8.5) < 0.01), 'a spark event fired at the landing spot');
  assert.ok(p.hp > before - 1, 'no lobber landing damage got through the force field');
});

test('exitReachable treats acid/stun/force-field tiles as ordinary floor', () => {
  const rows = [
    '##############', '#S...........#', '#............#', '#............#', '#............#',
    '######a#######', '#............#', '#............#', '#............#', '#............#',
    '#...........E#', '##############',
  ];
  assert.deepEqual(validateLevel({ rows }), [], 'a single acid tile in an otherwise solid dividing wall is still passable');
  const rowsStun = rows.slice(); rowsStun[5] = '######t#######';
  assert.deepEqual(validateLevel({ rows: rowsStun }), []);
  const rowsForce = rows.slice(); rowsForce[5] = '######f#######';
  assert.deepEqual(validateLevel({ rows: rowsForce }), []);
});

test('the acid/stun/force-field glyphs are accepted tiles', () => {
  const rows = [
    '########################', '#S.....................#', '#......................#', '#......................#',
    '#......................#', '#..a.t.f...............#', '#......................#', '#......................#',
    '#......................#', '#......................#', '#.....................E#', '########################',
  ];
  assert.deepEqual(validateLevel({ rows }), []);
});

test('procedural levels at level 5+ occasionally sprinkle acid/stun/force-field hazards and still validate', () => {
  let sawAcid = 0, sawStun = 0, sawField = 0;
  for (let i = 0; i < 200; i++) {
    const lvl = generateLevel({ seed: `hazard-${i}`, level: 5 + (i % 15) });
    assert.deepEqual(validateLevel(lvl), [], `seed hazard-${i}`);
    const joined = lvl.rows.join('');
    if (joined.includes(T.ACID)) sawAcid++;
    if (joined.includes(T.STUN_TILE)) sawStun++;
    if (joined.includes(T.FORCE_FIELD)) sawField++;
  }
  assert.ok(sawAcid > 0, 'at least one sampled seed produced acid puddles');
  assert.ok(sawStun > 0, 'at least one sampled seed produced a stun tile');
  assert.ok(sawField > 0, 'at least one sampled seed produced a force field');
});
