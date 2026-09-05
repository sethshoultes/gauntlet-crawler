// Chest pool for the between-level intermission (see server/game/room.js). Offers are rolled
// from a seeded RNG (shared/rng.js) keyed on the room seed + level index + player id, so a given
// room/level/player combination always sees the same three chests — deterministic and replay-safe.
import { START_HEALTH } from './constants.js';

// Non-cursed pool. `weight` is relative likelihood; `base` is the pre-scaling magnitude used to
// build the displayed label/value. Boost chests are temporary — they apply for the next level
// only (see applyChest + server/game/sim.js loadLevel, which activates/clears them).
const CHEST_POOL = [
  { kind: 'potion1', icon: '🧪', weight: 16, base: 1 },
  { kind: 'potion2', icon: '🧪', weight: 8, base: 2 },
  { kind: 'key', icon: '🔑', weight: 14, base: 1 },
  { kind: 'food_basket', icon: '🍗', weight: 14, base: 200 },
  { kind: 'food_feast', icon: '🍖', weight: 8, base: 300 },
  { kind: 'boost_speed', icon: '💨', weight: 10, base: 0.15 },
  { kind: 'boost_shot', icon: '⚔️', weight: 10, base: 1 },
  { kind: 'boost_armor', icon: '🛡️', weight: 10, base: 0.2 },
  { kind: 'boost_rapid', icon: '🔫', weight: 8, base: 0.3 },
  { kind: 'score_bonus', icon: '💰', weight: 12, base: 150 },
];

// Cursed pool — rolled independently at CURSED_WEIGHT. Each entry is a distinct "bad surprise".
const CURSED_POOL = [
  { kind: 'curse_drain', icon: '💀', base: 0 },
  { kind: 'curse_spawn', icon: '💀', base: 0 },
  { kind: 'curse_health', icon: '💀', base: 150 },
];

export const CURSED_WEIGHT = 0.10; // ~10% of rolled chests are cursed

// Icon shown next to a player in the HUD while a given boost key is active (see sim.js `boosts`).
export const BOOST_ICONS = {
  speedMul: '💨', shotDamageAdd: '⚔️', damageTakenMul: '🛡️', shotCooldownMul: '🔫', drainMul: '☠️',
};

function weightedPick(rng, pool) {
  const total = pool.reduce((s, e) => s + e.weight, 0);
  let r = rng.next() * total;
  for (const e of pool) { r -= e.weight; if (r <= 0) return e; }
  return pool[pool.length - 1];
}

function label(kind, value) {
  switch (kind) {
    case 'potion1': return '+1 Potion';
    case 'potion2': return '+2 Potions';
    case 'key': return '+1 Key';
    case 'food_basket': return `+${value} Health`;
    case 'food_feast': return `+${value} Health (Feast)`;
    case 'boost_speed': return `Winged Boots (+${Math.round(value * 100)}% Speed)`;
    case 'boost_shot': return `Sharpened Blade (+${value} Damage)`;
    case 'boost_armor': return `Iron Skin (-${Math.round(value * 100)}% Damage Taken)`;
    case 'boost_rapid': return `Rapid Fire (-${Math.round(value * 100)}% Reload)`;
    case 'score_bonus': return `+${value} Score`;
    case 'curse_drain': return 'Cursed Chest: Drain Doubled';
    case 'curse_spawn': return 'Cursed Chest: Monster Ambush';
    case 'curse_health': return `Cursed Chest: -${value} Health`;
    default: return '???';
  }
}

// `index` is this chest's position within the offer being rolled — combined with a roll drawn
// from the same seeded `rng`, it makes the id both deterministic (same seed -> same ids) and
// unique within one offer, without any module-level counter. The id is intentionally opaque: it
// never includes `kind` (or anything derived from it), since the server hands this id to clients
// during the intermission — while the label is still '???' — and a kind-bearing id would let
// clients infer a chest's contents before it's picked. See offerChestsTo/startIntermission in
// server/game/room.js and the `chests` message it sends.
function makeChest(rng, levelIndex, index) {
  const cursed = rng.chance(CURSED_WEIGHT);
  const scale = 1 + Math.min(0.6, Math.max(0, levelIndex - 1) * 0.03); // minor amounts creep up with depth
  const id = `${rng.int(0, 2 ** 31).toString(36)}-${index}`;
  if (cursed) {
    const def = rng.pick(CURSED_POOL);
    const value = def.kind === 'curse_health' ? Math.round(def.base * scale) : def.base;
    return { id, kind: def.kind, label: label(def.kind, value), icon: def.icon, value, cursed: true };
  }
  const def = weightedPick(rng, CHEST_POOL);
  const scalable = def.kind.startsWith('food') || def.kind === 'score_bonus';
  const value = scalable ? Math.round(def.base * scale) : def.base;
  return { id, kind: def.kind, label: label(def.kind, value), icon: def.icon, value, cursed: false };
}

/** Roll `count` chest offers for one player. Each call advances `rng`, so pass a fresh RNG seeded
 *  per (room seed, level index, player id) for deterministic, player-distinct offers — including
 *  the chest ids themselves, which are derived from that same rng rather than a global counter. */
export function rollChests(rng, levelIndex, count = 3) {
  const chests = [];
  const usedKinds = new Set();
  let guard = 0;
  while (chests.length < count && guard++ < 100) {
    const chest = makeChest(rng, levelIndex, chests.length);
    if (usedKinds.has(chest.kind)) continue; // keep the three offers distinct when possible
    usedKinds.add(chest.kind);
    chests.push(chest);
  }
  return chests;
}

/** Apply a picked chest to a sim player, mutating it in place. Permanent effects (potions, keys,
 *  health, score) land immediately; temporary boosts and the ambush curse are staged onto
 *  `player.pendingBoosts` / `player.pendingCurse` for sim.loadLevel() to activate for the next
 *  level (and clear again the level after). Returns the player for convenience. */
export function applyChest(player, chest) {
  const cap = (player.maxHealth || START_HEALTH) + 500;
  const addBoost = (patch) => { player.pendingBoosts = { ...player.pendingBoosts, ...patch }; };
  switch (chest.kind) {
    case 'potion1': player.potions += 1; break;
    case 'potion2': player.potions += 2; break;
    case 'key': player.keys += 1; break;
    case 'food_basket': case 'food_feast':
      player.hp = Math.min(cap, player.hp + chest.value); break;
    case 'boost_speed': addBoost({ speedMul: (player.pendingBoosts?.speedMul || 1) * (1 + chest.value) }); break;
    case 'boost_shot': addBoost({ shotDamageAdd: (player.pendingBoosts?.shotDamageAdd || 0) + chest.value }); break;
    case 'boost_armor': addBoost({ damageTakenMul: (player.pendingBoosts?.damageTakenMul || 1) * (1 - chest.value) }); break;
    case 'boost_rapid': addBoost({ shotCooldownMul: (player.pendingBoosts?.shotCooldownMul || 1) * (1 - chest.value) }); break;
    case 'score_bonus': player.score += chest.value; break;
    case 'curse_health': player.hp = Math.max(1, player.hp - chest.value); break;
    case 'curse_drain': addBoost({ drainMul: (player.pendingBoosts?.drainMul || 1) * 2 }); break;
    case 'curse_spawn': player.pendingCurse = 'spawn'; break;
  }
  return player;
}
