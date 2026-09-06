import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLevel, validateLevel, repairLevel, exitReachable } from '../shared/level.js';
import { LEVEL1 } from '../shared/levels/level1.js';

test('level 1 is valid', () => {
  assert.deepEqual(validateLevel(LEVEL1), []);
  const lvl = parseLevel(LEVEL1);
  assert.equal(lvl.w, 32); assert.equal(lvl.h, 24);
  assert.ok(lvl.starts.length >= 2);
});

test('rejects ragged rows and unknown tiles', () => {
  const rows = LEVEL1.rows.slice(); rows[3] = rows[3].slice(0, -1);
  assert.match(validateLevel({ rows })[0], /length/);
  const rows2 = LEVEL1.rows.slice(); rows2[3] = rows2[3].replace('.', '?');
  assert.match(validateLevel({ rows: rows2 })[0], /unknown tile/);
});

test('detects unreachable exit and doors without keys', () => {
  const rows = [
    '############',
    '#S.........#',
    '#..........#',
    '############',
    '#.........E#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '############',
  ];
  assert.match(validateLevel({ rows })[0], /not reachable/);
  const withDoor = rows.slice(); withDoor[3] = '#####D######';
  assert.match(validateLevel({ rows: withDoor })[0], /not reachable/, 'door with no key is impassable');
  const withKey = withDoor.slice(); withKey[1] = '#S....K....#';
  assert.deepEqual(validateLevel({ rows: withKey }), []);
});

// #48: exitReachable() used to treat every door as passable the instant a key existed *anywhere*
// in the level. These minimal grids pin the key-aware replacement — doors are search state, and
// opening a door cluster (see server/game/sim.js dissolveGroup) actually spends one of the keys
// collected in the region reachable so far.
test('a key sealed with no gap in its vault is never reachable, so the exit is not either', () => {
  const rows = [
    '############',
    '#S.........#',
    '#....####..#',
    '#....#K.#..#',
    '#....####..#',
    '#..........#',
    '######D#####',
    '#..........#',
    '#.........E#',
    '#..........#',
    '#..........#',
    '############',
  ];
  assert.ok(!exitReachable(parseLevel({ rows })), 'the only key is walled off with no gap, so the door can never open');
});

test('a key reachable only through the one door it opens is useless — the exit stays sealed', () => {
  const rows = [
    '############',
    '#S.........#',
    '#..........#',
    '######D#####',
    '#....K.....#',
    '#..........#',
    '#.........E#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '############',
  ];
  assert.ok(!exitReachable(parseLevel({ rows })), 'the key sits behind the very door it would open');
});

test('one key and one door guarding the exit: reachable', () => {
  const rows = [
    '############',
    '#S....K....#',
    '#..........#',
    '######D#####',
    '#..........#',
    '#..........#',
    '#.........E#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '############',
  ];
  assert.ok(exitReachable(parseLevel({ rows })));
});

test('a decoy door: the key must be spent on the door that actually leads to the exit', () => {
  // Start room has two doors: one (left) leads to a dead-end vault, the other (right) leads to the
  // exit. Only one key exists, reachable before either door. The search must find the branch where
  // the single key is spent on the *right* door, even though the left one is tried too.
  const rows = [
    '################',
    '#S.....K.......#',
    '######D#D#######',
    '#......#.......#',
    '#......#.......#',
    '#......#.......#',
    '#......#.......#',
    '#......#.......#',
    '#......#.......#',
    '#......#.......#',
    '#......#.....E.#',
    '################',
  ];
  assert.ok(exitReachable(parseLevel({ rows })), 'search must try opening the door that actually reaches the exit');
});

test('two doors in series but only one key: sealed', () => {
  const rows = [
    '############',
    '#S....K....#',
    '#..........#',
    '######D#####',
    '#..........#',
    '#..........#',
    '######D#####',
    '#..........#',
    '#.........E#',
    '#..........#',
    '#..........#',
    '############',
  ];
  assert.ok(!exitReachable(parseLevel({ rows })), 'one key can only open one of the two doors gating the exit');
});

test('two doors in series with two keys: reachable', () => {
  const rows = [
    '############',
    '#S....K....#',
    '#..........#',
    '######D#####',
    '#....K.....#',
    '#..........#',
    '######D#####',
    '#..........#',
    '#.........E#',
    '#..........#',
    '#..........#',
    '############',
  ];
  assert.ok(exitReachable(parseLevel({ rows })));
});

test('a 2-tile connected door cluster costs a single key, same as dissolveGroup', () => {
  const rows = [
    '############',
    '#S....K....#',
    '#..........#',
    '#####DD#####',
    '#..........#',
    '#.........E#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '############',
  ];
  assert.ok(exitReachable(parseLevel({ rows })), 'the whole DD cluster opens for one key, like Sim#dissolveGroup');
});

test('the new monster/item glyphs are accepted, and the skip-exit (8) counts as an exit', () => {
  const rows = LEVEL1.rows.slice();
  // Antechamber row 6 has a stretch of floor around the '2' grunt; swap in the new glyphs.
  rows[1] = rows[1].slice(0, 20) + '4' + rows[1].slice(21);
  rows[2] = rows[2].slice(0, 20) + '5' + rows[2].slice(21);
  rows[4] = rows[4].slice(0, 20) + '6' + rows[4].slice(21);
  rows[6] = rows[6].slice(0, 20) + 'X' + rows[6].slice(21);
  rows[8] = rows[8].slice(0, 20) + '!' + rows[8].slice(21);
  rows[10] = rows[10].slice(0, 20) + 'C' + rows[10].slice(21);
  assert.deepEqual(validateLevel({ rows }), []);

  // '8' (the skip-exit variant) is accepted as a tile and satisfies the exit requirement on its own.
  const withSkipExit = LEVEL1.rows.slice();
  const exitRow = withSkipExit.findIndex((r) => r.includes('E'));
  withSkipExit[exitRow] = withSkipExit[exitRow].replace('E', '8');
  assert.deepEqual(validateLevel({ rows: withSkipExit }), []);
  const parsed = parseLevel({ rows: withSkipExit });
  assert.equal(parsed.exits.length, 1, "'8' is recognized as an exit tile");
});

test('the amulet and boost glyphs are accepted tiles', () => {
  const rows = LEVEL1.rows.slice();
  rows[1] = rows[1].slice(0, 20) + 'I' + rows[1].slice(21);
  rows[2] = rows[2].slice(0, 20) + 'R' + rows[2].slice(21);
  rows[4] = rows[4].slice(0, 20) + 'O' + rows[4].slice(21);
  rows[6] = rows[6].slice(0, 20) + 'U' + rows[6].slice(21);
  rows[8] = rows[8].slice(0, 20) + 'V' + rows[8].slice(21);
  rows[10] = rows[10].slice(0, 20) + 'A' + rows[10].slice(21);
  rows[12] = rows[12].slice(0, 20) + 'B' + rows[12].slice(21);
  rows[14] = rows[14].slice(0, 20) + 'Q' + rows[14].slice(21);
  rows[16] = rows[16].slice(0, 20) + 'N' + rows[16].slice(21);
  assert.deepEqual(validateLevel({ rows }), []);
});

test('the pressure-plate/wall-group and timed-wall glyphs (#11) are accepted tiles', () => {
  const rows = LEVEL1.rows.slice();
  rows[1] = rows[1].slice(0, 20) + '%' + rows[1].slice(21);
  rows[2] = rows[2].slice(0, 20) + '&' + rows[2].slice(21);
  rows[4] = rows[4].slice(0, 20) + '*' + rows[4].slice(21);
  rows[6] = rows[6].slice(0, 20) + '=' + rows[6].slice(21);
  rows[8] = rows[8].slice(0, 20) + '+' + rows[8].slice(21);
  rows[10] = rows[10].slice(0, 20) + '~' + rows[10].slice(21);
  rows[12] = rows[12].slice(0, 20) + '^' + rows[12].slice(21);
  rows[14] = rows[14].slice(0, 20) + ':' + rows[14].slice(21);
  assert.deepEqual(validateLevel({ rows }), []);
});

test('repairLevel sanitizes the pressure-plate/wall-group/timed-wall glyphs through unchanged (not scrubbed to floor)', () => {
  const broken = { name: 'x', rows: ['..........', '..####....', '..#%=+~^:#', '..........', '..........', '..........', '..........', '..........', '..........', '.........'] };
  const fixed = repairLevel(broken);
  const joined = fixed.rows.join('');
  for (const glyph of ['%', '=', '+', '~', '^', ':']) assert.ok(joined.includes(glyph), `${glyph} survived repairLevel's sanitiser`);
});

test('the acid/stun/force-field glyphs (#12) are accepted tiles', () => {
  const rows = LEVEL1.rows.slice();
  rows[1] = rows[1].slice(0, 20) + 'a' + rows[1].slice(21);
  rows[2] = rows[2].slice(0, 20) + 't' + rows[2].slice(21);
  rows[4] = rows[4].slice(0, 20) + 'f' + rows[4].slice(21);
  assert.deepEqual(validateLevel({ rows }), []);
});

test("repairLevel sanitizes the acid/stun/force-field glyphs (#12) through unchanged", () => {
  const broken = { name: 'x', rows: ['..........', '..####....', '..#atf....', '..........', '..........', '..........', '..........', '..........', '..........', '.........'] };
  const fixed = repairLevel(broken);
  const joined = fixed.rows.join('');
  for (const glyph of ['a', 't', 'f']) assert.ok(joined.includes(glyph), `${glyph} survived repairLevel's sanitiser`);
});

test('the hidden-exit and switch glyphs (#13) are accepted tiles', () => {
  const rows = LEVEL1.rows.slice(); // LEVEL1 already contains treasure, so a lone H is reachable
  rows[1] = rows[1].slice(0, 20) + 'H' + rows[1].slice(21);
  rows[2] = rows[2].slice(0, 20) + 'L' + rows[2].slice(21);
  assert.deepEqual(validateLevel({ rows }), []);
  const parsed = parseLevel({ rows });
  assert.ok(parsed.exits.some(([x, y]) => rows[y][x] === 'H'), 'a hidden exit counts toward parseLevel\'s exit list');
});

test('a hidden exit with no switch and no treasure fails validation (it could never be revealed)', () => {
  // Strip every treasure tile and turn LEVEL1's one real exit into a hidden one — now nothing in
  // the level could ever reveal it, so it must behave exactly like a permanent wall.
  const rows = LEVEL1.rows.slice().map((r) => r.replace(/T/g, '.').replace(/E/g, 'H'));
  assert.ok(!rows.some((r) => r.includes('T') || r.includes('E')), 'sanity: no treasure, no plain exit left');
  assert.match(validateLevel({ rows })[0], /not reachable/);
});

test("repairLevel sanitizes the hidden-exit/switch glyphs (#13) through unchanged", () => {
  const broken = { name: 'x', rows: ['..........', '..####....', '..#HL.....', '..........', '..........', '..........', '..........', '..........', '..........', '.........'] };
  const fixed = repairLevel(broken);
  const joined = fixed.rows.join('');
  for (const glyph of ['H', 'L']) assert.ok(joined.includes(glyph), `${glyph} survived repairLevel's sanitiser`);
});

test('repairLevel fixes borders, missing start/exit and connectivity', () => {
  const broken = { name: 'x', rows: ['..........', '..####....', '..#..#....', '..........', '..........', '..........', '..........', '..........', '..........', '.........'] };
  const fixed = repairLevel(broken);
  assert.deepEqual(validateLevel(fixed), []);
  assert.ok(exitReachable(parseLevel(fixed)));
  assert.ok(fixed.rows.every((r) => r.length === fixed.rows[0].length));
});

test('repairLevel keeps a level that only has a skip exit (8) and adds no extra E', () => {
  const rows = [
    '############',
    '#S.........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#..........#',
    '#.........8#',
    '############',
  ];
  const fixed = repairLevel({ name: 'skip-only', rows });
  const joined = fixed.rows.join('');
  assert.ok(!joined.includes('E'), 'no classic exit should be added');
  assert.equal((joined.match(/8/g) || []).length, 1);
  assert.deepEqual(validateLevel(fixed), []);
});

test("repairLevel's connectivity carve never overwrites a hidden exit tile (#27 review)", () => {
  // A hidden exit (H), enclosed in its own room by a fully-solid wall row, with no other exit-like
  // tile anywhere else. A treasure tile makes it revealable (hiddenExitOpenable), so it should count
  // as a real exit once repairLevel carves a path to it — the connectivity fallback must never carve
  // straight through the H tile itself (that used to convert it to floor, destroying the level's
  // only exit outright).
  const w = 12, h = 12;
  const grid = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => {
    if (y === 0 || y === h - 1 || x === 0 || x === w - 1 || y === 5) return '#';
    return '.';
  }));
  grid[1][1] = 'S';
  grid[1][6] = 'T'; // treasure: makes the hidden exit openable
  grid[7][10] = 'H'; // hidden exit, walled off in its own room (row 5 is solid all the way across)
  const rows = grid.map((r) => r.join(''));
  const fixed = repairLevel({ name: 'hidden-exit-only', rows });
  const joined = fixed.rows.join('');
  assert.equal((joined.match(/H/g) || []).length, 1, "the hidden exit must survive repairLevel's carve");
  assert.deepEqual(validateLevel(fixed), []);
});

test('the missing-exit error names every exit-like tile, including the hidden exit (#13)', () => {
  const rows = Array.from({ length: 12 }, (_, y) => (y === 0 || y === 11 ? '############' : y === 1 ? '#S.........#' : '#..........#'));
  assert.throws(() => parseLevel({ rows }), /E, 8, or H/);
});

// A grid with far more door clusters than the exact search is allowed to enumerate (see
// MAX_EXACT_DOOR_GROUPS in shared/level.js): a corridor of 30 single doors in series with a pocket
// of keys before them. The optimistic fallback must still say "solvable", quickly, and its mirror
// with no keys at all must still say "not solvable".
function manyDoorsLevel({ keys, keyBehindFirstDoor = false }) {
  const w = 64; // parseLevel's MAX_SIZE: '#S' + 30 x '.D' + 'E#' fills it exactly
  const wall = '#'.repeat(w);
  // Optionally the only key sits past the second door (column 6, clear of the key pocket's
  // columns 1-4 below): unreachable with every door shut, so even the optimistic check must
  // reject it.
  const doorRow = '#S' + '.D.D' + (keyBehindFirstDoor ? 'KD' : '.D') + '.D'.repeat(27) + 'E#';
  // A 4x8 pocket of keys (32, enough for the 30 doors) hanging below the start, walled off from
  // the corridor everywhere else so the doors cannot simply be walked around.
  const pocketRow = '#' + (keys ? 'KKKK' : '....') + '#'.repeat(w - 6) + '#';
  const rows = [wall, wall, doorRow];
  while (rows.length < 11) rows.push(pocketRow);
  rows.push(wall); // 12 rows: parseLevel's MIN_SIZE
  return { name: 'many doors', rows };
}

// The per-test timeout (not a wall-clock assertion) is what guards against the exact search being
// used here by mistake: 2^30 door states would never finish inside it.
test('exitReachable stays bounded on a level with dozens of door clusters (optimistic all-open check)', { timeout: 5000 }, () => {
  const lvl = parseLevel(manyDoorsLevel({ keys: true }));
  assert.equal(lvl.rows[2].split('D').length - 1, 30, 'fixture has 30 door tiles');
  assert.equal(exitReachable(lvl), true);
  assert.equal(exitReachable(parseLevel(manyDoorsLevel({ keys: false }))), false, 'no key anywhere');
  assert.equal(exitReachable(parseLevel(manyDoorsLevel({ keys: false, keyBehindFirstDoor: true }))), false, 'the only key is behind a door');
});
