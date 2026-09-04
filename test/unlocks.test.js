import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLASSES, CLASS_IDS } from '../shared/constants.js';
import {
  PALETTES, UNLOCKS, unlockedFor, isClassUnlocked, isPaletteUnlocked, paletteColor, requirementText, catalogueFor,
} from '../shared/unlocks.js';

test('a guest (null profile) unlocks only the four base classes and no palettes', () => {
  const { classes, palettes } = unlockedFor(null);
  assert.deepEqual([...classes].sort(), ['elf', 'valkyrie', 'warrior', 'wizard']);
  assert.equal(palettes.size, 0);
  for (const id of ['paladin', 'ranger', 'necromancer']) assert.equal(classes.has(id), false, `${id} is locked for guests`);
});

test('the catalogue has at least 8 palettes and 2 new archetypes', () => {
  assert.ok(PALETTES.length >= 8, `expected >= 8 palettes, got ${PALETTES.length}`);
  const heroes = UNLOCKS.filter((u) => u.type === 'hero');
  assert.ok(heroes.length >= 2, `expected >= 2 locked archetypes, got ${heroes.length}`);
  // every locked CLASSES entry should have a matching catalogue item and vice versa
  const lockedClassIds = CLASS_IDS.filter((id) => CLASSES[id].locked);
  assert.deepEqual(heroes.map((h) => h.id).sort(), lockedClassIds.sort());
});

test('isClassUnlocked: base classes are always unlocked, rank-gated classes need rank', () => {
  assert.equal(isClassUnlocked('warrior', null), true);
  assert.equal(isClassUnlocked('paladin', null), false, 'guest has no rank');
  assert.equal(isClassUnlocked('paladin', { rank: 4 }), false);
  assert.equal(isClassUnlocked('paladin', { rank: 5 }), true);
  assert.equal(isClassUnlocked('bogus_class', { rank: 99 }), false);
});

test('AND condition: ranger needs both the elf-played stat and the ghostbuster achievement', () => {
  const onlyStat = { stats: { class_elf: 1 }, achievements: new Set(), rank: 1 };
  const onlyAch = { stats: {}, achievements: new Set(['ghostbuster']), rank: 1 };
  const both = { stats: { class_elf: 1 }, achievements: new Set(['ghostbuster']), rank: 1 };
  assert.equal(isClassUnlocked('ranger', onlyStat), false);
  assert.equal(isClassUnlocked('ranger', onlyAch), false);
  assert.equal(isClassUnlocked('ranger', both), true);
});

test('OR condition: necromancer needs the reaper_reaped achievement OR rank 8', () => {
  assert.equal(isClassUnlocked('necromancer', { rank: 7, achievements: new Set() }), false);
  assert.equal(isClassUnlocked('necromancer', { rank: 8, achievements: new Set() }), true);
  assert.equal(isClassUnlocked('necromancer', { rank: 1, achievements: new Set(['reaper_reaped']) }), true);
});

test('palettes gate on rank, achievement, or either (any/or)', () => {
  const rank2 = { rank: 2, achievements: new Set() };
  const rank1 = { rank: 1, achievements: new Set() };
  assert.equal(isPaletteUnlocked('warrior_classic', rank1), false);
  assert.equal(isPaletteUnlocked('warrior_classic', rank2), true);
  assert.equal(isPaletteUnlocked('wizard_void', rank2), false, 'wizard_void needs the alchemist achievement, not just rank');
  assert.equal(isPaletteUnlocked('wizard_void', { rank: 1, achievements: new Set(['alchemist']) }), true);
  assert.equal(isPaletteUnlocked('warrior_gold', { rank: 1, achievements: new Set(['monster_masher']) }), true, 'achievement satisfies the OR');
  assert.equal(isPaletteUnlocked('warrior_gold', { rank: 3, achievements: new Set() }), true, 'rank satisfies the OR');
  assert.equal(isPaletteUnlocked('warrior_gold', { rank: 1, achievements: new Set() }), false);
});

test('paletteColor falls back to the class base color when locked, unknown, or belongs to another class', () => {
  const locked = { rank: 1, achievements: new Set() };
  const unlockedProfile = { rank: 3, achievements: new Set() };
  assert.equal(paletteColor('warrior', null, locked), CLASSES.warrior.color, 'no palette id -> base color');
  assert.equal(paletteColor('warrior', 'warrior_gold', locked), CLASSES.warrior.color, 'locked palette falls back');
  assert.notEqual(paletteColor('warrior', 'warrior_gold', unlockedProfile), CLASSES.warrior.color, 'unlocked palette overrides base color');
  assert.equal(paletteColor('valkyrie', 'warrior_gold', unlockedProfile), CLASSES.valkyrie.color, 'a palette that belongs to a different class is ignored');
  assert.equal(paletteColor('warrior', 'not_a_real_id', unlockedProfile), CLASSES.warrior.color, 'unknown palette id falls back');
});

test('requirementText is non-empty and readable for every catalogue item', () => {
  for (const item of UNLOCKS) {
    const text = requirementText(item);
    assert.ok(typeof text === 'string' && text.length > 0, `empty requirement text for ${item.id}`);
    assert.notEqual(text, 'Locked', `${item.id} requirement text should describe how to unlock it, not just say "Locked"`);
  }
});

test('catalogueFor annotates every item with unlocked + requirement for a given profile', () => {
  const cat = catalogueFor(null);
  assert.equal(cat.length, UNLOCKS.length);
  assert.ok(cat.every((c) => c.unlocked === false), 'nothing in the catalogue is unlocked for a guest');
  const maxed = catalogueFor({ rank: 10, achievements: new Set(['monster_masher', 'alchemist', 'speedrunner', 'ghostbuster', 'reaper_reaped']), stats: { class_elf: 1 } });
  assert.ok(maxed.every((c) => c.unlocked === true), 'a maxed-out profile unlocks everything in the catalogue');
});
