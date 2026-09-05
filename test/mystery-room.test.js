// Arcade parity (#13): mystery treasure rooms — concealed exits behind a hidden-exit glyph, a
// switch that reveals them, and the "collect it all" alternative reveal condition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../server/game/sim.js';
import { T, DT } from '../shared/constants.js';
import { parseLevel, exitReachable, validateLevel } from '../shared/level.js';
import { generateTreasureRoom } from '../shared/procgen.js';

const run = (sim, ticks) => { for (let i = 0; i < ticks; i++) sim.step(DT); };

// A hidden exit (H, x=5 on row 5) plus a real exit (E) sealed off in its own 1-tile vault so
// parseLevel is satisfied without the sealed E ever actually being reachable — the only way out
// of the main room for gameplay purposes is the hidden exit.
const SEALED_ROOM_ROWS = [
  '############',
  '#S.........#',
  '#..........#',
  '#..........#',
  '#..........#',
  '#....H.....#',
  '#..........#',
  '#..........#',
  '#..........#',
  '#..........#',
  '############',
  '###E########',
  '############',
];

test('a hidden exit renders/behaves exactly like a wall until it is revealed', () => {
  const sim = new Sim({ name: 'x', rows: SEALED_ROOM_ROWS });
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.x = 4.5; p.y = 5.5; p.dir = 2; // one tile west of the hidden exit at (5,5), facing east
  assert.equal(sim.tile(5, 5), T.HIDDEN_EXIT);
  sim.setInput('a', { dx: 1, dy: 0 });
  run(sim, 40); // plenty of time to walk into it if it were passable
  assert.ok(p.x < 5, `a hidden exit blocks movement like a wall (player.x=${p.x})`);

  sim.revealHiddenExits();
  assert.equal(sim.tile(5, 5), T.EXIT, 'revealed in place — the same tile becomes a real exit');
  // Now that it's a real exit, walking onto it completes the level.
  run(sim, 40);
  assert.ok(sim.completed, 'the revealed exit is walkable and completes the level');
});

test('revealHiddenExits emits a reveal event exactly once, even if called again', () => {
  const events = [];
  const sim = new Sim({ name: 'x', rows: SEALED_ROOM_ROWS }, { onEvent: (e) => events.push(e) });
  sim.revealHiddenExits();
  sim.revealHiddenExits();
  const reveals = events.filter((e) => e.type === 'reveal');
  assert.equal(reveals.length, 1);
  assert.equal(reveals[0].count, 1);
});

const SWITCH_ROOM_ROWS = [
  '############',
  '#S.........#',
  '#..........#',
  '#..........#',
  '#..........#',
  '#....H.....#',
  '#..........#',
  '#..L.......#',
  '#..........#',
  '#..........#',
  '############',
  '###E########',
  '############',
];

test('stepping on the switch reveals every hidden exit in the level', () => {
  const events = [];
  const sim = new Sim({ name: 'x', rows: SWITCH_ROOM_ROWS }, { onEvent: (e) => events.push(e) });
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.x = 3.5; p.y = 6.5; p.dir = 6; // just north of the switch at (3,7)
  sim.setInput('a', { dx: 0, dy: 1 });
  run(sim, 20);
  assert.equal(sim.tile(5, 5), T.EXIT, 'the switch revealed the hidden exit elsewhere in the level');
  assert.ok(events.some((e) => e.type === 'reveal'), 'a reveal event was emitted');
  // The switch itself stays on the map — it's a lever, not a consumable pickup.
  assert.equal(sim.tile(3, 7), T.SWITCH);
});

const TREASURE_ROOM_ROWS = [
  '############',
  '#S.........#',
  '#..........#',
  '#..........#',
  '#..........#',
  '#....H.....#',
  '#..........#',
  '#..T.......#',
  '#..........#',
  '#..........#',
  '############',
  '###E########',
  '############',
];

test('collecting the last piece of treasure reveals every hidden exit', () => {
  const sim = new Sim({ name: 'x', rows: TREASURE_ROOM_ROWS });
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  assert.equal(sim.tile(5, 5), T.HIDDEN_EXIT);
  p.x = 3.5; p.y = 6.5; p.dir = 6; // just north of the lone treasure tile at (3,7)
  sim.setInput('a', { dx: 0, dy: 1 });
  run(sim, 20);
  assert.equal(sim.tile(3, 7), T.FLOOR, 'the treasure tile was picked up');
  assert.equal(sim.tile(5, 5), T.EXIT, 'the hidden exit revealed once the last treasure was collected');
});

test('exitReachable treats a hidden exit as an exit only when the level has a switch or treasure', () => {
  assert.equal(exitReachable(parseLevel({ rows: SEALED_ROOM_ROWS })), false, 'no switch, no treasure — the hidden exit can never open');
  assert.match(validateLevel({ rows: SEALED_ROOM_ROWS })[0], /not reachable/);

  assert.ok(exitReachable(parseLevel({ rows: SWITCH_ROOM_ROWS })), 'a switch makes the hidden exit reachable');
  assert.deepEqual(validateLevel({ rows: SWITCH_ROOM_ROWS }), []);

  assert.ok(exitReachable(parseLevel({ rows: TREASURE_ROOM_ROWS })), 'reachable treasure makes the hidden exit reachable');
  assert.deepEqual(validateLevel({ rows: TREASURE_ROOM_ROWS }), []);
});

// 12x12: start at top-left, one treasure in the open, a second treasure walled off in the bottom-right
// corner (unreachable), hidden exit on the right edge of the open area.
const HALF_TREASURE_ROWS = [
  '############',
  '#S.........#',
  '#..........#',
  '#....T.....#',
  '#..........#',
  '#.........H#',
  '#..........#',
  '#..........#',
  '#......#####',
  '#......#..T#',
  '#......#...#',
  '############',
];
// No switch and no treasure, so the hidden exit can never reveal; the only real exit sits behind
// it, so the only way there would be to path *through* the H tile itself, which gameplay never allows.
const H_AS_CORRIDOR_ROWS = [
  '############',
  '#S.........#',
  '#..........#',
  '#..........#',
  '#..........#',
  '#.......#H##',
  '#.......#.E#',
  '#.......####',
  '#..........#',
  '#..........#',
  '#..........#',
  '############',
];

test('a hidden exit is not reachable when some treasure can never be collected', () => {
  assert.equal(exitReachable(parseLevel({ rows: HALF_TREASURE_ROWS })), false, 'the reveal needs every treasure; one is sealed off');
  assert.match(validateLevel({ rows: HALF_TREASURE_ROWS })[0], /not reachable/);
  // Give the sealed corner a switch-based reveal instead and the same layout validates.
  const withSwitch = HALF_TREASURE_ROWS.map((r, y) => (y === 2 ? '#L.........#' : r));
  assert.deepEqual(validateLevel({ rows: withSwitch }), []);
});

test('a hidden exit is never used as a corridor to something behind it', () => {
  assert.equal(exitReachable(parseLevel({ rows: H_AS_CORRIDOR_ROWS })), false);
  // A real exit does count when it is genuinely walkable-to.
  const open = H_AS_CORRIDOR_ROWS.map((r, y) => (y === 5 ? '#.......#.##' : r));
  assert.ok(exitReachable(parseLevel({ rows: open })));
  // And with a reveal condition present, the adjacent hidden exit itself is the exit that counts.
  const withTreasure = H_AS_CORRIDOR_ROWS.map((r, y) => (y === 3 ? '#....T.....#' : r));
  assert.ok(exitReachable(parseLevel({ rows: withTreasure })));
});

test('procgen mystery treasure rooms validate and carry both the hidden-exit and switch glyphs', () => {
  // level 6 is the first treasure room a run reaches — never mystery (see generateTreasureRoom).
  const first = generateTreasureRoom({ seed: 'mystery-seed', level: 6 });
  assert.ok(!first.rows.join('').includes(T.HIDDEN_EXIT), 'the first treasure room is a plain one');

  // level 12 is the second — mystery, deterministic for this seed/level.
  const second = generateTreasureRoom({ seed: 'mystery-seed', level: 12 });
  assert.deepEqual(validateLevel(second), []);
  const joined = second.rows.join('');
  assert.ok(joined.includes(T.HIDDEN_EXIT), 'the second treasure room conceals its exits');
  assert.ok(joined.includes(T.SWITCH), 'a switch is placed somewhere in the room');
  assert.ok(!joined.includes(T.EXIT), 'no plain exit tile — every exit is hidden');
  assert.ok(exitReachable(parseLevel(second)), 'the room is always full of treasure, so its hidden exits are always reachable');

  // deterministic for a given seed/level, same as the plain treasure room.
  const again = generateTreasureRoom({ seed: 'mystery-seed', level: 12 });
  assert.deepEqual(again.rows, second.rows);
});
