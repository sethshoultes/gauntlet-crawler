// Arcade parity (#13): "It" tag mode — one randomly tagged player draws monster aggression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../server/game/sim.js';
import { T, IT_KILL_BONUS, MONSTERS } from '../shared/constants.js';

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

test('assignItTag only tags someone when the mode is on and 2+ players are present', () => {
  const sim = new Sim(ROOM);
  const a = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  // Off: never tags anyone, regardless of player count.
  sim.assignItTag(false);
  assert.equal(sim.itPid, null);
  // On, but solo: still nobody is It.
  sim.assignItTag(true);
  assert.equal(sim.itPid, null, 'a single player is never tagged It');

  const b = sim.addPlayer('b', { name: 'B', cls: 'elf' });
  sim.assignItTag(true);
  assert.ok(sim.itPid === a.id || sim.itPid === b.id, 'one of the two players is tagged');
});

test('monsters target the It player over a closer non-It player', () => {
  const sim = new Sim(ROOM);
  const near = sim.addPlayer('near', { name: 'Near', cls: 'warrior' });
  const far = sim.addPlayer('far', { name: 'Far', cls: 'warrior' });
  near.x = 5.5; near.y = 5.5;
  far.x = 12.5; far.y = 5.5;
  const m = sim.spawnMonster('grunt', 5.7, 5.5); // right next to `near`, far from `far`
  // Plain nearest-player targeting (no It tag): the monster should prefer the near player.
  const plain = sim.nearestPlayer(m.x, m.y, MONSTERS.grunt.wakeRange, { skipInvisible: true });
  assert.equal(plain.id, 'near');

  // Tag the far player It: the monster's target search now prefers them instead, as long as
  // they're within the same wakeRange (line-of-sight/pathing "in range" per the design).
  sim.itPid = 'far';
  const withIt = sim.nearestPlayer(m.x, m.y, MONSTERS.grunt.wakeRange, { skipInvisible: true });
  assert.equal(withIt.id, 'far', 'the It player is targeted over the nearer non-It player');
});

test('an invisible It player cannot be targeted — monsters fall back to nearest-player logic', () => {
  const sim = new Sim(ROOM);
  const it = sim.addPlayer('it', { name: 'It', cls: 'warrior' });
  const other = sim.addPlayer('other', { name: 'Other', cls: 'warrior' });
  it.x = 5.5; it.y = 5.5;
  other.x = 6.5; other.y = 5.5;
  sim.itPid = 'it';
  it.amulets = { invis: 10 };
  const target = sim.nearestPlayer(5.5, 5.5, 20, { skipInvisible: true });
  assert.equal(target.id, 'other', 'invisible It player is skipped; falls back to the other player');
  // Without skipInvisible (a caller that doesn't care about invisibility) the It preference still
  // applies, matching the plain nearestPlayer behaviour for any other invisible player.
  const targetNoSkip = sim.nearestPlayer(5.5, 5.5, 20, {});
  assert.equal(targetNoSkip.id, 'it');
});

test('the It tag passes to a random other living player when the It player dies', () => {
  const sim = new Sim(ROOM);
  const a = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  const b = sim.addPlayer('b', { name: 'B', cls: 'warrior' });
  const c = sim.addPlayer('c', { name: 'C', cls: 'warrior' });
  sim.itPid = 'a';
  sim.hurtPlayer(a, 100000, 'test');
  assert.ok(a.dead);
  assert.ok(sim.itPid === 'b' || sim.itPid === 'c', 'tag passed to one of the other two players');
  assert.notEqual(sim.itPid, 'a', 'the dead player cannot keep the tag');
});

test('the It tag passes to another player when the It player leaves, as long as 2+ remain', () => {
  const sim = new Sim(ROOM);
  sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.addPlayer('b', { name: 'B', cls: 'warrior' });
  sim.addPlayer('c', { name: 'C', cls: 'warrior' });
  sim.itPid = 'a';
  sim.removePlayer('a');
  assert.ok(sim.itPid === 'b' || sim.itPid === 'c', 'tag passed to one of the two remaining players');
});

test('the It tag is dropped (not passed) when the It player leaves and only one player remains', () => {
  const sim = new Sim(ROOM);
  sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.addPlayer('b', { name: 'B', cls: 'warrior' });
  sim.itPid = 'a';
  sim.removePlayer('a');
  assert.equal(sim.itPid, null, 'a lone survivor is never tagged It, even if they were the fallback candidate');
});

test('nobody is It once only one player remains', () => {
  const sim = new Sim(ROOM);
  sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.addPlayer('b', { name: 'B', cls: 'warrior' });
  sim.itPid = 'a';
  sim.removePlayer('b'); // the non-It player leaves, dropping the room to one player
  assert.equal(sim.itPid, null, 'a lone survivor is never tagged It');
});

test('killing a monster while tagged It earns a small score bonus on top of the normal kill score', () => {
  const sim = new Sim(ROOM);
  const it = sim.addPlayer('it', { name: 'It', cls: 'warrior' });
  const other = sim.addPlayer('other', { name: 'Other', cls: 'warrior' });
  sim.itPid = 'it';
  const m1 = sim.spawnMonster('grunt', 5.5, 5.5);
  sim.killMonster(m1, it);
  assert.equal(it.score, MONSTERS.grunt.score + IT_KILL_BONUS);

  const m2 = sim.spawnMonster('grunt', 6.5, 6.5);
  sim.killMonster(m2, other);
  assert.equal(other.score, MONSTERS.grunt.score, 'no bonus for a kill by a non-It player');
});
