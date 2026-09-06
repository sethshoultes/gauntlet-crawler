// Achievement definitions. Each is unlocked when the named stat counter reaches `threshold`.
// Stats are simple per-user counters kept server-side (see server/stats.js).
export const ACHIEVEMENTS = [
  { id: 'first_blood',      name: 'First Blood',            icon: '🗡️', stat: 'kills',              threshold: 1,    desc: 'Slay your first monster.' },
  { id: 'monster_masher',   name: 'Monster Masher',         icon: '💀', stat: 'kills',              threshold: 500,  desc: 'Slay 500 monsters.' },
  { id: 'legend',           name: 'Dungeon Legend',         icon: '👑', stat: 'kills',              threshold: 5000, desc: 'Slay 5,000 monsters.' },
  { id: 'ghostbuster',      name: 'Ghostbuster',            icon: '👻', stat: 'kills_ghost',        threshold: 100,  desc: 'Bust 100 ghosts.' },
  { id: 'grunt_work',       name: 'Grunt Work',             icon: '🪓', stat: 'kills_grunt',        threshold: 100,  desc: 'Cut down 100 grunts.' },
  { id: 'exorcist',         name: 'Exorcist',               icon: '🔥', stat: 'kills_demon',        threshold: 50,   desc: 'Banish 50 demons.' },
  { id: 'wrecker',          name: 'Generator Wrecker',      icon: '🧨', stat: 'generators',         threshold: 25,   desc: 'Destroy 25 monster generators.' },
  { id: 'reaper_reaped',    name: 'Reaper Reaped',          icon: '⚰️', stat: 'kills_death',        threshold: 1,    desc: 'Destroy Death with a magic potion.' },
  { id: 'needs_food',       name: 'Needs Food Badly',       icon: '🍗', stat: 'food_low',           threshold: 1,    desc: 'Eat food while under 200 health.' },
  { id: 'shot_the_food',    name: 'Don\'t Shoot the Food!', icon: '🎯', stat: 'food_shot',          threshold: 1,    desc: 'Destroy food with a shot. Classic.' },
  { id: 'glutton',          name: 'Glutton',                icon: '🍖', stat: 'food',               threshold: 100,  desc: 'Eat 100 pieces of food.' },
  { id: 'locksmith',        name: 'Locksmith',              icon: '🔑', stat: 'doors',              threshold: 50,   desc: 'Open 50 doors.' },
  { id: 'treasure_hunter',  name: 'Treasure Hunter',        icon: '💰', stat: 'treasure',           threshold: 100,  desc: 'Collect 100 treasures.' },
  { id: 'alchemist',        name: 'Alchemist',              icon: '🧪', stat: 'potions',            threshold: 25,   desc: 'Use 25 magic potions.' },
  { id: 'secret_keeper',    name: 'Secret Keeper',          icon: '🧱', stat: 'secrets',            threshold: 10,   desc: 'Find 10 secret walls.' },
  { id: 'delver_5',         name: 'Delver',                 icon: '🕯️', stat: 'deepest_level',      threshold: 5,    desc: 'Reach level 5.' },
  { id: 'delver_10',        name: 'Deep Delver',            icon: '🕳️', stat: 'deepest_level',      threshold: 10,   desc: 'Reach level 10.' },
  { id: 'delver_25',        name: 'Abyss Walker',           icon: '🌑', stat: 'deepest_level',      threshold: 25,   desc: 'Reach level 25.' },
  { id: 'delver_50',        name: 'Bottomless',             icon: '♾️', stat: 'deepest_level',      threshold: 50,   desc: 'Reach level 50. It never ends.' },
  { id: 'speedrunner',      name: 'Speedrunner',            icon: '⏱️', stat: 'speed_clears',       threshold: 1,    desc: 'Clear a level in under 45 seconds.' },
  { id: 'pacifist',         name: 'Pacifist',               icon: '🕊️', stat: 'pacifist_clears',    threshold: 1,    desc: 'Clear a level without killing anything.' },
  { id: 'squad_goals',      name: 'Squad Goals',            icon: '🤝', stat: 'squad_clears',       threshold: 1,    desc: 'Clear a level with a full party of four.' },
  { id: 'solo_hero',        name: 'Solo Hero',              icon: '🧍', stat: 'solo_clears',        threshold: 10,   desc: 'Clear 10 levels alone.' },
  { id: 'iron_will',        name: 'Iron Will',              icon: '🛡️', stat: 'no_death_clears',    threshold: 5,    desc: 'Clear 5 levels in a row without dying.' },
  { id: 'insert_coin',      name: 'Insert Coin',            icon: '🪙', stat: 'coins',              threshold: 1,    desc: 'Continue after dying.' },
  { id: 'quarter_muncher',  name: 'Quarter Muncher',        icon: '🎰', stat: 'coins',              threshold: 50,   desc: 'Continue 50 times. The arcade thanks you.' },
  { id: 'all_classes',      name: 'Jack of All Trades',     icon: '🎭', stat: 'classes_played',     threshold: 4,    desc: 'Play as all four heroes.' },
  { id: 'architect',        name: 'Architect',              icon: '📐', stat: 'levels_published',   threshold: 1,    desc: 'Publish a custom level.' },
  { id: 'prompt_engineer',  name: 'Prompt Engineer',        icon: '🤖', stat: 'ai_levels',          threshold: 1,    desc: 'Generate a level with the AI level builder.' },
  { id: 'crowd_pleaser',    name: 'Crowd Pleaser',          icon: '🎉', stat: 'level_plays',        threshold: 25,   desc: 'Your custom levels are played 25 times by others.' },
  { id: 'high_score',       name: 'High Score',             icon: '🏆', stat: 'best_score',         threshold: 10000, desc: 'Score 10,000 in one run.' },
  { id: 'marathon',         name: 'Marathon',               icon: '🏃', stat: 'seconds_played',     threshold: 3600, desc: 'Play for a total of one hour.' },
  { id: 'lucky_dip',        name: 'Lucky Dip',              icon: '🎁', stat: 'chests_opened',      threshold: 25,   desc: 'Open 25 intermission chests.' },
  { id: 'cursed',           name: 'Cursed',                 icon: '💀', stat: 'cursed_chests',      threshold: 5,    desc: 'Open 5 cursed chests.' },
  { id: 'wave_rider',       name: 'Wave Rider',             icon: '🌊', stat: 'waves_cleared',      threshold: 50,   desc: 'Clear 50 Death mode waves.' },
  { id: 'death_10',         name: 'Staring Down Death',     icon: '☠️', stat: 'deepest_death_level', threshold: 10,   desc: 'Reach level 10 in Death mode.' },
  { id: 'stop_thief',       name: 'Stop, Thief!',           icon: '👮', stat: 'thief_kills',        threshold: 5,    desc: 'Kill 5 thieves before they escape with your loot.' },
  { id: 'teleporter',       name: 'Teleporter',             icon: '🌀', stat: 'teleports',          threshold: 25,   desc: 'Use 25 transporters.' },
  { id: 'bonus_hunter',     name: 'Bonus Hunter',           icon: '💎', stat: 'treasure_rooms_cleared', threshold: 5, desc: 'Clear 5 bonus treasure rooms.' },
  { id: 'amulet_collector', name: 'Amulet Collector',       icon: '🔮', stat: 'amulet_kinds_run',   threshold: 4,    desc: 'Collect all four amulet types in a single run.' },
];

export const ACHIEVEMENT_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

/** Return the achievements that become unlocked when `stat` reaches `value` (and were not already). */
export function newlyUnlocked(stat, value, unlockedIds) {
  return ACHIEVEMENTS.filter((a) => a.stat === stat && value >= a.threshold && !unlockedIds.has(a.id));
}
