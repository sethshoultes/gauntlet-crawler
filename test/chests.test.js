import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../shared/rng.js';
import { rollChests, applyChest, CURSED_WEIGHT } from '../shared/chests.js';
import { Sim } from '../server/game/sim.js';
import { DT } from '../shared/constants.js';

const ARENA = {
  name: 'arena',
  rows: [
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
    '#.........E#',
    '############',
  ],
};

test('rollChests returns three offers with distinct ids (and, with this pool size, distinct kinds)', () => {
  const rng = makeRng('seed-a');
  const chests = rollChests(rng, 1);
  assert.equal(chests.length, 3);
  const ids = new Set(chests.map((c) => c.id));
  assert.equal(ids.size, 3, 'ids are distinct');
  const kinds = new Set(chests.map((c) => c.kind));
  assert.equal(kinds.size, 3, 'kinds are distinct for a 3-of-13 draw');
  for (const c of chests) {
    assert.ok(c.label && c.icon, 'label/icon present');
    assert.equal(typeof c.cursed, 'boolean');
  }
});

test('rolls are deterministic for a given rng seed and level', () => {
  const a = rollChests(makeRng('room1|3|p1'), 3);
  const b = rollChests(makeRng('room1|3|p1'), 3);
  assert.deepEqual(a.map((c) => [c.kind, c.value]), b.map((c) => [c.kind, c.value]));
  const c = rollChests(makeRng('room1|3|p2'), 3);
  assert.notDeepEqual(a.map((x) => x.kind), c.map((x) => x.kind), 'different players see different offers (almost certainly)');
});

test('chest ids are reproducible from the seed, not from a global counter', () => {
  const a = rollChests(makeRng('room1|3|p1'), 3);
  const b = rollChests(makeRng('room1|3|p1'), 3);
  assert.deepEqual(a.map((c) => c.id), b.map((c) => c.id), 'same seed -> identical ids, run to run');

  const ids = new Set(a.map((c) => c.id));
  assert.equal(ids.size, a.length, 'ids are distinct within one offer');

  // A second, unrelated roll (different seed/level) must not shift the ids of the first roll —
  // i.e. ids don't depend on any process-wide counter or on rolls that came before them.
  rollChests(makeRng('unrelated-seed'), 7);
  const aAgain = rollChests(makeRng('room1|3|p1'), 3);
  assert.deepEqual(a.map((c) => c.id), aAgain.map((c) => c.id), 'ids are unaffected by unrelated prior rolls');
});

// Kind identifiers from shared/chests.js's CHEST_POOL/CURSED_POOL. Not exported (deliberately —
// see makeChest's comment), so mirrored here to assert none of them leak into an id. If a kind is
// added/renamed in shared/chests.js without updating this list, the substring check below is what
// should catch a regression, so keep it in sync.
const CHEST_KIND_NAMES = [
  'potion1', 'potion2', 'key', 'food_basket', 'food_feast', 'boost_speed', 'boost_shot',
  'boost_armor', 'boost_rapid', 'score_bonus', 'curse_drain', 'curse_spawn', 'curse_health',
];

test('chest ids are opaque: no kind name (or fragment of one) appears in any rolled id', () => {
  for (let i = 0; i < 200; i++) {
    const chests = rollChests(makeRng(`opaque-check-${i}`), 1 + (i % 30));
    for (const chest of chests) {
      for (const kindName of CHEST_KIND_NAMES) {
        assert.ok(!chest.id.includes(kindName), `id "${chest.id}" must not reveal kind "${kindName}" (actual kind: ${chest.kind})`);
      }
    }
  }
});

test('chest ids stay deterministic per seed and unique per offer after the opacity fix', () => {
  const a = rollChests(makeRng('opaque-det|3|p1'), 3);
  const b = rollChests(makeRng('opaque-det|3|p1'), 3);
  assert.deepEqual(a.map((c) => c.id), b.map((c) => c.id), 'same seed -> identical ids');
  assert.equal(new Set(a.map((c) => c.id)).size, a.length, 'ids unique within one offer');
});

test('cursed chest weight is roughly the configured 10% over many rolls', () => {
  const rng = makeRng('cursed-weight-check');
  let cursed = 0, total = 0;
  for (let i = 0; i < 5000; i++) {
    for (const chest of rollChests(rng, 1)) { total++; if (chest.cursed) cursed++; }
  }
  const rate = cursed / total;
  assert.ok(Math.abs(rate - CURSED_WEIGHT) < 0.03, `cursed rate ${rate} should be close to ${CURSED_WEIGHT}`);
});

test('applyChest: permanent effects land immediately on the player', () => {
  const sim = new Sim(ARENA);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.hp = 100; p.potions = 0; p.keys = 0; p.score = 0;

  applyChest(p, { id: 'x1', kind: 'potion2', value: 2, cursed: false });
  assert.equal(p.potions, 2);

  applyChest(p, { id: 'x2', kind: 'key', value: 1, cursed: false });
  assert.equal(p.keys, 1);

  applyChest(p, { id: 'x3', kind: 'food_basket', value: 200, cursed: false });
  assert.equal(p.hp, 300);

  applyChest(p, { id: 'x4', kind: 'score_bonus', value: 150, cursed: false });
  assert.equal(p.score, 150);
});

test('applyChest: healing is capped at maxHealth + 500', () => {
  const sim = new Sim(ARENA);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.hp = p.maxHealth;
  applyChest(p, { id: 'x1', kind: 'food_feast', value: 300, cursed: false });
  assert.equal(p.hp, Math.min(p.maxHealth + 500, p.maxHealth + 300));
  p.hp = p.maxHealth + 480;
  applyChest(p, { id: 'x2', kind: 'food_feast', value: 300, cursed: false });
  assert.equal(p.hp, p.maxHealth + 500, 'healing does not exceed the cap');
});

test('applyChest: cursed health chest hurts but never kills outright', () => {
  const sim = new Sim(ARENA);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  p.hp = 100;
  applyChest(p, { id: 'x1', kind: 'curse_health', value: 150, cursed: true });
  assert.equal(p.hp, 1, 'floors at 1 instead of going to 0/negative');
});

test('applyChest: temporary boosts stage onto pendingBoosts and stack multiplicatively with perks after loadLevel activates them', () => {
  const sim = new Sim(ARENA);
  const p = sim.addPlayer('a', {
    name: 'A', cls: 'warrior', userId: 1,
    perks: { speedMul: 1.1, shotDamageAdd: 0, damageTakenMul: 1, maxHealthBonus: 0, magicAdd: 0 },
  });
  applyChest(p, { id: 'x1', kind: 'boost_speed', value: 0.15, cursed: false });
  applyChest(p, { id: 'x2', kind: 'boost_shot', value: 1, cursed: false });
  assert.equal(p.boosts.speedMul, undefined, 'not active until the next loadLevel');

  sim.loadLevel(ARENA, 2); // simulate the room advancing into the next level
  assert.ok(Math.abs(p.boosts.speedMul - 1.15) < 1e-9);
  assert.equal(p.boosts.shotDamageAdd, 1);
  // fire a shot and confirm the effective damage includes perk + boost
  p.x = 2.5; p.y = 2.5; p.dir = 2;
  sim.setInput('a', { fire: true });
  sim.step(DT);
  const shot = [...sim.shots.values()][0];
  assert.ok(shot, 'a shot was fired');
  assert.equal(shot.dmg, 3 + 0 + 1, 'base warrior shot damage + perk + boost');
});

test('boosts are cleared by the loadLevel after the one they applied to', () => {
  const sim = new Sim(ARENA);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  applyChest(p, { id: 'x1', kind: 'boost_speed', value: 0.15, cursed: false });
  sim.loadLevel(ARENA, 2); // boost activates for level 2
  assert.ok(p.boosts.speedMul);
  sim.loadLevel(ARENA, 3); // level 2 is over and no new chest was applied -> boost gone
  assert.deepEqual(p.boosts, {});
});

test('applyChest: cursed ambush queues a monster spawn that loadLevel resolves', () => {
  const sim = new Sim(ARENA);
  const p = sim.addPlayer('a', { name: 'A', cls: 'warrior' });
  applyChest(p, { id: 'x1', kind: 'curse_spawn', value: 0, cursed: true });
  const before = sim.monsters.size;
  sim.loadLevel(ARENA, 2);
  assert.equal(sim.monsters.size, before + 1, 'a monster spawned near the player at level start');
  assert.equal(p.pendingCurse, null);
});

test('food chest amounts scale up a little with level index', () => {
  function findFoodValue(level, seedPrefix) {
    for (let i = 0; i < 80; i++) {
      const chest = rollChests(makeRng(`${seedPrefix}-${i}`), level).find((c) => c.kind === 'food_basket');
      if (chest) return chest.value;
    }
    return null;
  }
  const early = findFoodValue(1, 'scale-early');
  const late = findFoodValue(30, 'scale-late');
  assert.ok(early !== null && late !== null, 'found a food_basket chest at both levels');
  assert.ok(late > early, `expected level 30 food value (${late}) to be greater than level 1 (${early})`);
});
