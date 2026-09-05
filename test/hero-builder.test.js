import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLASSES } from '../shared/constants.js';
import {
  STATS, budgetFor, notchesFromClass, validateHero, toClassDef, presetHeroes, WEAPONS, TRAITS, PALETTE,
} from '../shared/hero-builder.js';

function total(stats) { return STATS.reduce((s, k) => s + stats[k], 0); }

test('budgetFor: locked below rank 3, 12 at rank 3, +1 at rank 6 and 9, +1 for legend', () => {
  assert.equal(budgetFor(1, []), 0);
  assert.equal(budgetFor(2, []), 0);
  assert.equal(budgetFor(3, []), 12);
  assert.equal(budgetFor(5, []), 12);
  assert.equal(budgetFor(6, []), 13);
  assert.equal(budgetFor(8, []), 13);
  assert.equal(budgetFor(9, []), 14);
  assert.equal(budgetFor(9, ['legend']), 15);
  assert.equal(budgetFor(3, new Set(['legend'])), 13);
});

test('per-stat cap is 5 regardless of budget', () => {
  const hero = { name: 'Cap Test', stats: { speed: 6, shot: 5, fireRate: 5, armor: 5, magic: 5, health: 5 }, weapon: 'axe', pixels: eightPixels() };
  const r = validateHero(hero, { rank: 9, achievements: ['legend'] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /0 to 5/.test(e)));
});

test('classic class mapping: all four classics land within 11-13 notches (budget is 12 at rank 3)', () => {
  const results = {};
  for (const id of ['warrior', 'valkyrie', 'wizard', 'elf']) {
    const n = notchesFromClass(CLASSES[id]);
    for (const k of STATS) assert.ok(Number.isInteger(n[k]) && n[k] >= 0 && n[k] <= 5, `${id}.${k} notch in range`);
    results[id] = total(n);
  }
  for (const [id, t] of Object.entries(results)) {
    assert.ok(t >= 11 && t <= 13, `${id} totals ${t} notches, expected 11-13 (got ${JSON.stringify(results)})`);
  }
});

function eightPixels(fillChar = '2') {
  const row = '.' + fillChar.repeat(6) + '.';
  return new Array(8).fill(row);
}

const RANK3 = { rank: 3, achievements: [] };

test('validateHero: valid hero at rank 3 passes', () => {
  const hero = {
    name: 'Ok Hero', title: 'The Ok', motto: 'Fine, I guess.',
    stats: { speed: 2, shot: 2, fireRate: 2, armor: 2, magic: 2, health: 2 }, // 12 total
    weapon: 'axe', trait: 'scavenger',
    pixels: eightPixels(),
  };
  const r = validateHero(hero, RANK3);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('validateHero: locked below rank 3', () => {
  const hero = { name: 'Low Rank', stats: { speed: 0, shot: 0, fireRate: 0, armor: 0, magic: 0, health: 0 }, weapon: 'axe', pixels: eightPixels() };
  const r = validateHero(hero, { rank: 2, achievements: [] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /rank 3/.test(e)));
});

test('validateHero: name rules (length + charset)', () => {
  const base = { stats: { speed: 1, shot: 1, fireRate: 1, armor: 1, magic: 1, health: 1 }, weapon: 'axe', pixels: eightPixels() };
  assert.equal(validateHero({ ...base, name: 'A' }, RANK3).ok, false); // too short
  assert.equal(validateHero({ ...base, name: 'A'.repeat(13) }, RANK3).ok, false); // too long
  assert.equal(validateHero({ ...base, name: 'Bad$Name' }, RANK3).ok, false); // bad char
  assert.equal(validateHero({ ...base, name: 'Good Name 2' }, RANK3).ok, true);
});

test('validateHero: title and motto length caps', () => {
  const base = { name: 'Hero', stats: { speed: 1, shot: 1, fireRate: 1, armor: 1, magic: 1, health: 1 }, weapon: 'axe', pixels: eightPixels() };
  assert.equal(validateHero({ ...base, title: 'x'.repeat(17) }, RANK3).ok, false);
  assert.equal(validateHero({ ...base, title: 'x'.repeat(16) }, RANK3).ok, true);
  assert.equal(validateHero({ ...base, motto: 'x'.repeat(61) }, RANK3).ok, false);
  assert.equal(validateHero({ ...base, motto: 'x'.repeat(60) }, RANK3).ok, true);
});

test('validateHero: stats must be integers 0-5 and within budget', () => {
  const base = { name: 'Hero', weapon: 'axe', pixels: eightPixels() };
  assert.equal(validateHero({ ...base, stats: { speed: 1.5, shot: 1, fireRate: 1, armor: 1, magic: 1, health: 1 } }, RANK3).ok, false);
  assert.equal(validateHero({ ...base, stats: { speed: -1, shot: 1, fireRate: 1, armor: 1, magic: 1, health: 1 } }, RANK3).ok, false);
  assert.equal(validateHero({ ...base, stats: { speed: 5, shot: 5, fireRate: 5, armor: 5, magic: 5, health: 5 } }, RANK3).ok, false); // 30 > 12
  assert.equal(validateHero({ ...base, stats: { speed: 2, shot: 2, fireRate: 2, armor: 2, magic: 2, health: 2 } }, RANK3).ok, true); // == 12
});

test('validateHero: unknown or locked weapon rejected', () => {
  const base = { name: 'Hero', stats: { speed: 1, shot: 1, fireRate: 1, armor: 1, magic: 1, health: 1 }, pixels: eightPixels() };
  assert.equal(validateHero({ ...base, weapon: 'lightsaber' }, RANK3).ok, false);
  for (const w of Object.keys(WEAPONS)) assert.equal(validateHero({ ...base, weapon: w }, RANK3).ok, true, w);
});

test('validateHero: locked trait rejected, requirement met accepted', () => {
  const base = { name: 'Hero', stats: { speed: 1, shot: 1, fireRate: 1, armor: 1, magic: 1, health: 1 }, weapon: 'axe', pixels: eightPixels() };
  assert.equal(validateHero({ ...base, trait: 'arcanist' }, RANK3).ok, false); // needs 'alchemist' achievement
  assert.equal(validateHero({ ...base, trait: 'arcanist' }, { rank: 3, achievements: ['alchemist'] }).ok, true);
  assert.equal(validateHero({ ...base, trait: 'unknown_trait' }, RANK3).ok, false);
  assert.equal(validateHero({ ...base, trait: 'thick_skin' }, RANK3).ok, true); // free at rank 3
});

test('validateHero: pixels must be 8x8 from "." + "0"-"7", with at least 8 painted', () => {
  const base = { name: 'Hero', stats: { speed: 1, shot: 1, fireRate: 1, armor: 1, magic: 1, health: 1 }, weapon: 'axe' };
  assert.equal(validateHero({ ...base, pixels: new Array(7).fill('........') }, RANK3).ok, false); // wrong row count
  assert.equal(validateHero({ ...base, pixels: new Array(8).fill('.......') }, RANK3).ok, false); // wrong row length
  assert.equal(validateHero({ ...base, pixels: new Array(8).fill('88888888') }, RANK3).ok, false); // '8' out of range
  assert.equal(validateHero({ ...base, pixels: new Array(8).fill('........') }, RANK3).ok, false); // nothing painted
  assert.equal(validateHero({ ...base, pixels: eightPixels() }, RANK3).ok, true);
});

test('toClassDef: shape matches CLASSES.warrior keys (plus builder extras)', () => {
  const hero = presetHeroes()[0];
  const def = toClassDef(hero);
  for (const k of Object.keys(CLASSES.warrior)) assert.ok(k in def, `missing key "${k}"`);
  assert.equal(def.custom, true);
  assert.equal(def.shotKey, 'c');
  assert.ok(typeof def.color === 'string' && def.color.startsWith('#'));
  assert.ok(PALETTE.includes(def.color));
  assert.equal(def.weaponDef, WEAPONS[def.weapon]);
});

test('toClassDef: notch->value mapping stays positive and sane', () => {
  for (const hero of presetHeroes()) {
    const def = toClassDef(hero);
    assert.ok(def.speed > 0);
    assert.ok(def.shotDamage > 0);
    assert.ok(def.shotCooldown > 0);
    assert.ok(def.armor > 0);
    assert.ok(def.magic > 0);
    assert.ok(def.maxHealthBonus >= 0);
  }
});

test('presetHeroes: three templates, each validate at rank 3 and stay within budget', () => {
  const presets = presetHeroes();
  assert.equal(presets.length, 3);
  for (const hero of presets) {
    assert.ok(total(hero.stats) <= budgetFor(3, []), `${hero.name} exceeds rank-3 budget`);
    const r = validateHero(hero, RANK3);
    assert.deepEqual(r.errors, [], `${hero.name}: ${r.errors.join('; ')}`);
    assert.equal(r.ok, true);
  }
});

test('TRAITS requirement conditions are well-formed', () => {
  for (const [id, t] of Object.entries(TRAITS)) {
    assert.ok(t.name && t.desc, id);
    assert.ok(t.requires && (t.requires.rank != null || t.requires.achievement), `${id} requires shape`);
  }
});
