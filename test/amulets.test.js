// Arcade parity (#10): amulets (temporary, 20s effects) and permanent per-run boosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../server/game/sim.js';
import {
  T, DT, START_HEALTH, AMULET_DURATION, AMULET_SCORE, BOOST_SCORE, BOOST_STACK_CAP, BOOST_EFFECT,
} from '../shared/constants.js';

// A wide, mostly-open room — plenty of clearance for shots to travel, bounce and pierce, and for
// monsters to be placed at controlled distances from the player.
const ROOM = {
  name: 'room',
  rows: [
    '####################',
    '#S.................#',
    '#..................#',
    '#..................#',
    '#..................#',
    '#..................#',
    '#..................#',
    '#..................#',
    '#..................#',
    '#..................#',
    '#..................#',
    '#..................#',
    '#.................E#',
    '####################',
  ],
};
const run = (sim, ticks) => { for (let i = 0; i < ticks; i++) sim.step(DT); };

test('picking up an amulet tile clears it, starts its countdown, and scores; a boost tile clears and stacks', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.grid[6][6] = T.AMULET_INVIS;
  p.x = 6.5; p.y = 6.5;
  const scoreBefore = p.score;
  run(sim, 1);
  assert.equal(sim.grid[6][6], '.', 'the amulet tile is gone');
  assert.equal(p.amulets.invis, AMULET_DURATION, 'invisibility amulet armed for its full duration');
  assert.equal(p.score, scoreBefore + AMULET_SCORE);

  sim.grid[6][9] = T.BOOST_SPEED;
  p.x = 9.5; p.y = 6.5;
  run(sim, 1);
  assert.equal(sim.grid[6][9], '.', 'the boost tile is gone');
  assert.equal(p.runBoosts.speed, 1, 'first speed boost stacks to 1');
  assert.equal(p.score, scoreBefore + AMULET_SCORE + BOOST_SCORE);

  // Stacking caps at BOOST_STACK_CAP even after picking up more than that many.
  for (let i = 0; i < BOOST_STACK_CAP + 2; i++) {
    sim.grid[6][9] = T.BOOST_SPEED;
    run(sim, 1);
  }
  assert.equal(p.runBoosts.speed, BOOST_STACK_CAP, 'speed boost stacking is capped');
});

test('a temporary amulet expires after its 20s duration', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.amulets.reflect = AMULET_DURATION;
  run(sim, Math.round(AMULET_DURATION / DT) - 5); // just under 20s
  assert.ok(p.amulets.reflect > 0, 'still active a moment before expiry');
  run(sim, 10); // cross the 20s mark
  assert.equal(p.amulets.reflect, undefined, 'expired and removed');
});

test('invisibility amulet stops monsters from targeting or hurting the player', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.x = 10.5; p.y = 6.5;
  p.amulets.invis = AMULET_DURATION;
  sim.spawnMonster('ghost', 13.5, 6.5); // 3 tiles away, well within the ghost's wakeRange
  run(sim, 60); // 3s — plenty of time for a normal ghost to close in and touch-kill itself on the player
  assert.equal(sim.monsters.size, 1, 'the ghost never reached/touched the invisible player');
  assert.ok(p.hp > START_HEALTH - 5, 'no touch damage taken (only the trickle of hunger drain)');

  // Once invisibility runs out, the same ghost resumes targeting normally.
  p.amulets.invis = 0.01;
  run(sim, 2);
  run(sim, 200); // several seconds — long enough for the ghost to close the remaining distance
  assert.equal(sim.monsters.size, 0, 'the ghost engaged and touch-killed itself once visible again');
});

test('reflective shots amulet bounces a shot off one wall, then it dies on the second wall hit', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.amulets.reflect = AMULET_DURATION;
  p.x = 17.5; p.y = 6.5; p.dir = 2; // facing east, ~1.5 tiles from the east border wall
  sim.setInput('a', { dx: 0, dy: 0, fire: true });
  run(sim, 1);
  sim.setInput('a', { fire: false });
  const shot = [...sim.shots.values()].find((s) => s.owner === 'a');
  assert.ok(shot, 'a shot was fired');
  assert.equal(shot.reflect, true, 'the shot was flagged as reflective at spawn time');

  run(sim, 10); // enough time to reach the east wall and bounce
  assert.ok(sim.shots.has(shot.id), 'the shot survived its first wall hit');
  assert.equal(shot.bounced, true, 'it bounced exactly once');
  assert.ok(shot.vx < 0, 'its velocity reversed on the axis that hit the wall');

  run(sim, 50); // enough time to cross back and hit the west wall
  assert.equal(sim.shots.has(shot.id), false, 'it died normally on the second wall hit');
});

test('super shots amulet pierces through multiple monsters, damaging each one it passes', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.amulets.super = AMULET_DURATION;
  p.x = 2.5; p.y = 6.5; p.dir = 2; // facing east
  const m1 = sim.spawnMonster('grunt', 6.5, 6.5);
  const m2 = sim.spawnMonster('grunt', 10.5, 6.5);
  sim.setInput('a', { dx: 0, dy: 0, fire: true });
  run(sim, 30); // ~1.5s: enough for the shot to cross both monsters before its 3s lifetime ends
  assert.equal(sim.monsters.has(m1.id), false, 'the first monster in the shot\'s path died');
  assert.equal(sim.monsters.has(m2.id), false, 'the second monster in the shot\'s path also died — the shot pierced through');
});

test('repulsiveness amulet pushes a nearby monster away and it cannot touch the player', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.x = 10.5; p.y = 6.5;
  p.amulets.repulse = AMULET_DURATION;
  const m = sim.spawnMonster('grunt', 10.9, 6.5); // right next to the player, well within REPULSE_RANGE
  const startDist = Math.hypot(m.x - p.x, m.y - p.y);
  run(sim, 20); // 1s
  const endDist = Math.hypot(m.x - p.x, m.y - p.y);
  assert.ok(endDist > startDist, 'the monster was pushed farther away, not closer');
  assert.ok(p.hp > START_HEALTH - 5, 'no contact damage was ever applied while repulsion was active');
});

test('permanent run-boosts persist across a level advance and reset only on a fresh addPlayer (new run)', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.grid[6][6] = T.BOOST_ARMOR;
  p.x = 6.5; p.y = 6.5;
  run(sim, 1);
  assert.equal(p.runBoosts.armor, 1, 'armor boost picked up');
  // Also give a temporary amulet, to prove the two fields are cleared independently.
  p.amulets.super = AMULET_DURATION;

  sim.loadLevel(ROOM, 2); // simulates advancing to the next level
  const p2 = sim.players.get('a');
  assert.equal(p2.runBoosts.armor, 1, 'the permanent boost survives a level advance');
  assert.deepEqual(p2.amulets, {}, 'temporary amulets are cleared on a level advance');

  // A brand-new player (what a fresh run's addPlayer() produces, e.g. after Death mode's endRun())
  // starts with no run-boosts at all.
  const fresh = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  assert.deepEqual(fresh.runBoosts, {}, 'run-boosts reset for a brand-new player/run');
});

test('permanent boosts affect gameplay immediately: speed and shot power', () => {
  const withoutBoost = new Sim(ROOM);
  const p1 = withoutBoost.addPlayer('a', { name: 'A', cls: 'warrior' });
  p1.x = 2.5; p1.y = 2.5;
  withoutBoost.setInput('a', { dx: 1, dy: 0 });
  run(withoutBoost, 1);
  const distPlain = p1.x - 2.5;

  const withBoost = new Sim(ROOM);
  const p2 = withBoost.addPlayer('a', { name: 'A', cls: 'warrior' });
  p2.x = 2.5; p2.y = 2.5; p2.runBoosts.speed = 2;
  withBoost.setInput('a', { dx: 1, dy: 0 });
  run(withBoost, 1);
  const distBoosted = p2.x - 2.5;
  const expectedMul = 1 + 2 * BOOST_EFFECT.speed;
  assert.ok(Math.abs(distBoosted - distPlain * expectedMul) < 1e-6, 'moved faster in proportion to the speed boost stacks');

  const sim3 = new Sim(ROOM);
  const p3 = sim3.addPlayer('a', { name: 'A', cls: 'warrior' });
  p3.x = 2.5; p3.y = 2.5; p3.dir = 2; p3.runBoosts.shotPower = 3;
  sim3.setInput('a', { dx: 0, dy: 0, fire: true });
  run(sim3, 1);
  const shot = [...sim3.shots.values()][0];
  assert.ok(shot, 'a shot was fired');
  assert.ok(Math.abs(shot.dmg - (3 + 3 * BOOST_EFFECT.shotPower)) < 1e-9, 'shot damage includes the shot-power boost stacks');
});
