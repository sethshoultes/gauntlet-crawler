// Arcade parity (#11): pressure-plate wall groups and timed walls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../server/game/sim.js';
import { T, DT, TRAP_PLATES } from '../shared/constants.js';
import { parseLevel, exitReachable, validateLevel } from '../shared/level.js';
import { generateLevel } from '../shared/procgen.js';

const run = (sim, ticks) => { for (let i = 0; i < ticks; i++) sim.step(DT); };

// A wide room with two independent wall groups (A guards the west pocket, B guards the east one)
// and their plates placed far from both, so stepping on one plate can be isolated from the other.
const ROOM = {
  name: 'room',
  rows: [
    '#####################',
    '#S..................#',
    '#..................E#',
    '#....==........++...#',
    '#....==........++...#',
    '#...................#',
    '#...................#',
    '#...................#',
    '#...................#',
    '#...................#',
    '#...................#',
    '#####################',
  ],
};

test('a plate dissolves every tile of its matching wall group, for a hero', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  assert.equal(sim.grid[3].join(''), '#....==........++...#');
  p.x = 10.5; p.y = 1.5; // clear of both groups
  sim.grid[1][10] = T.TRAP_PLATE_A;
  run(sim, 2);
  assert.equal(sim.grid[3].join(''), '#......' + '........++...#', 'every group-A tile became floor');
});

test('only the matching group dissolves; the other group is untouched', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.grid[1][10] = T.TRAP_PLATE_A;
  p.x = 10.5; p.y = 1.5;
  run(sim, 2);
  const row3 = sim.grid[3].join('');
  assert.ok(!row3.includes('='), 'group A walls are gone');
  assert.ok(row3.includes('+'), 'group B walls are untouched by plate A');
  assert.equal(sim.platesTriggered.has(T.TRAP_PLATE_A), true);
  assert.equal(sim.platesTriggered.has(T.TRAP_PLATE_B), false);
});

test('a plate fires only once even while something keeps standing on it', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.grid[1][10] = T.TRAP_PLATE_A;
  p.x = 10.5; p.y = 1.5;
  run(sim, 5); // several ticks standing still on the plate
  // Manually re-place a wall-group-A tile after the first dissolve: if triggerPlate fired again
  // it would immediately dissolve this too, since the player is still standing on the plate tile.
  sim.grid[3][5] = T.TRAP_WALL_A;
  run(sim, 5);
  assert.equal(sim.grid[3][5], T.TRAP_WALL_A, 'a spent plate does not refire on repeated contact');
});

test('a monster stepping onto a plate triggers it too', () => {
  const sim = new Sim(ROOM);
  sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.grid[1][10] = T.TRAP_PLATE_B;
  const m = sim.spawnMonster('grunt', 10.5, 1.5);
  run(sim, 2);
  const row3 = sim.grid[3].join('');
  assert.ok(!row3.includes('+'), 'group B dissolved after a monster (not a player) touched the plate');
  assert.ok(row3.includes('='), 'group A, whose plate was never placed, is untouched');
});

test('group walls and timed walls block movement and shots like an ordinary wall', () => {
  const sim = new Sim(ROOM);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  assert.equal(sim.isSolidFor(T.TRAP_WALL_A, 'player'), true);
  assert.equal(sim.isSolidFor(T.TRAP_WALL_B, 'player'), true);
  assert.equal(sim.isSolidFor(T.TIMED_WALL, 'player'), true);
  assert.equal(sim.isSolidFor(T.TIMED_WALL_EXIT, 'player'), true);
  // A pressure plate itself is not solid — it behaves like floor underfoot.
  assert.equal(sim.isSolidFor(T.TRAP_PLATE_A, 'player'), false);
  p.x = 4.5; p.y = 3.5; p.dir = 2; // facing east, one tile west of the wall group (which starts at x=5)
  sim.setInput('a', { dx: 1, dy: 0 });
  run(sim, 10);
  assert.ok(p.x < 4.7, 'blocked by the still-solid wall group A, never reaching tile x=5');
});

test('a timed wall converts to floor once its timer elapses, using a per-level override', () => {
  const level = { ...ROOM, timers: { wall: 2 } };
  const sim = new Sim(level);
  sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.grid[3][7] = T.TIMED_WALL;
  sim.grid[3][8] = T.TIMED_WALL;
  sim.timedWalls = [{ x: 7, y: 3, glyph: T.TIMED_WALL, remaining: 2 }, { x: 8, y: 3, glyph: T.TIMED_WALL, remaining: 2 }];
  run(sim, 39); // 1.95s — just under the 2s override
  assert.equal(sim.grid[3][7], T.TIMED_WALL, 'still solid a moment before its timer fires');
  run(sim, 2); // cross the 2s mark
  assert.equal(sim.grid[3][7], T.FLOOR);
  assert.equal(sim.grid[3][8], T.FLOOR);
  assert.equal(sim.timedWalls.length, 0);
});

test('a timed exit wall becomes a real exit tile, and completing the level through it works', () => {
  const level = { ...ROOM, timers: { exit: 1 } };
  const sim = new Sim(level);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  sim.grid[3][7] = T.TIMED_WALL_EXIT;
  sim.timedWalls = [{ x: 7, y: 3, glyph: T.TIMED_WALL_EXIT, remaining: 1 }];
  p.x = 6.5; p.y = 3.5;
  run(sim, 25); // 1.25s, enough to cross the 1s timer
  assert.equal(sim.grid[3][7], T.EXIT, 'converted into a real exit tile in place');
  assert.equal(sim.completed, null, 'not standing on it yet');
  p.x = 7.5; p.y = 3.5;
  run(sim, 1);
  assert.ok(sim.completed, 'stepping onto the now-open timed exit completes the level like any other exit');
});

test('exitReachable: a group wall is passable only when its own plate is present in the level', () => {
  // A single '=' gap in an otherwise solid dividing wall, between the start (top) and exit (bottom).
  const rowsNoPlate = [
    '##############', '#S...........#', '#............#', '#............#', '#............#',
    '######=#######', '#............#', '#............#', '#............#', '#............#',
    '#...........E#', '##############',
  ];
  assert.match(validateLevel({ rows: rowsNoPlate })[0], /not reachable/, 'no plate anywhere -> group wall A never opens -> unreachable');

  const rowsWithPlate = rowsNoPlate.slice();
  rowsWithPlate[1] = '#S....%......#'; // plate A, matches group A
  assert.deepEqual(validateLevel({ rows: rowsWithPlate }), [], 'plate A present -> group wall A treated as eventually passable');

  const rowsWrongPlate = rowsNoPlate.slice();
  rowsWrongPlate[1] = '#S....&......#'; // plate B, doesn't open group A
  assert.match(validateLevel({ rows: rowsWrongPlate })[0], /not reachable/, "a different group's plate doesn't help");
});

test('exitReachable: a timed wall is always treated as eventually passable, with no plate needed', () => {
  const rows = [
    '##############', '#S...........#', '#............#', '#............#', '#............#',
    '######^#######', '#............#', '#............#', '#............#', '#............#',
    '#...........E#', '##############',
  ];
  assert.deepEqual(validateLevel({ rows }), [], 'timed wall opens on its own, no plate required');
  const rowsExitVariant = rows.slice(); rowsExitVariant[5] = '######:#######';
  assert.deepEqual(validateLevel({ rows: rowsExitVariant }), []);
});

test('the pressure-plate and timed-wall glyphs are accepted tiles', () => {
  const rows = [
    '########################', '#S.....................#', '#......................#', '#......................#',
    '#......................#', '#..%.&.*.=.+.~.^.:.....#', '#......................#', '#......................#',
    '#......................#', '#......................#', '#.....................E#', '########################',
  ];
  assert.deepEqual(validateLevel({ rows }), []);
});

test('procedural levels that generated a plate/wall-group puzzle still validate', () => {
  let sawPuzzle = 0;
  for (let i = 0; i < 250; i++) {
    const lvl = generateLevel({ seed: `puzzle-${i}`, level: 3 + (i % 20) });
    assert.deepEqual(validateLevel(lvl), [], `seed puzzle-${i}`);
    const joined = lvl.rows.join('');
    const usedGroup = Object.values(TRAP_PLATES).find((wallGlyph) => joined.includes(wallGlyph));
    if (usedGroup) {
      sawPuzzle++;
      const plateGlyph = Object.keys(TRAP_PLATES).find((pg) => TRAP_PLATES[pg] === usedGroup);
      assert.ok(joined.includes(plateGlyph), `wall group ${usedGroup} always ships with its plate ${plateGlyph}`);
      assert.ok(exitReachable(parseLevel(lvl)), `seed puzzle-${i}: exit still reachable around the puzzle`);
    }
  }
  assert.ok(sawPuzzle > 0, 'at least one sampled seed produced a plate puzzle');
});

test('procedural levels occasionally produce timed walls and still validate', () => {
  let sawTimed = 0;
  for (let i = 0; i < 250; i++) {
    const lvl = generateLevel({ seed: `timed-${i}`, level: 3 + (i % 20) });
    assert.deepEqual(validateLevel(lvl), [], `seed timed-${i}`);
    const joined = lvl.rows.join('');
    if (joined.includes(T.TIMED_WALL) || joined.includes(T.TIMED_WALL_EXIT)) sawTimed++;
  }
  assert.ok(sawTimed > 0, 'at least one sampled seed produced a timed wall');
});
