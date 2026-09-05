# Gauntlet Crawler

A love letter to the 1985 arcade dungeon crawler: four heroes, hordes of ghosts and grunts pouring out of
generators, keys and doors, food you must not shoot, a health bar that never stops ticking down, and a
narrator who reminds you that the Elf needs food badly.

This version is **online multiplayer** (up to four players per dungeon), has **modern achievements** and a
**player dashboard**, is **endless** thanks to a seeded procedural dungeon generator, ships with a
**level builder** that can draft dungeons with an **AI generator** (Claude) from a text prompt, and lets you
design your own **custom hero** from scratch in the Hero Builder.

Deliberately simple graphics: every sprite is 8x8 pixel art drawn in code, no asset pipeline.

## Quick start

```bash
npm install
npm start            # http://localhost:3000
npm run dev          # same, but restarts on file changes (node --watch)
npm test             # unit tests (level format, procgen, simulation, achievements, progression, death mode, ...)
```

Requires Node.js 22.5+ (uses the built-in `node:sqlite`). Data lives in `./data/gauntlet.sqlite`.

## How to play

- Pick a hero: **Warrior** (Thor, strongest shot and armor), **Valkyrie** (Thyra, balanced), **Wizard** (Merlin, best magic),
  **Elf** (Questor, fastest, rapid fire) — or bring your own from the [Hero Builder](#hero-builder).
- **Quick Play** joins a public room that's still in its lobby (or makes one), **Create room** starts your own (optionally private).
  Either way you land in the **room screen** first: roster with hero/rank/ready state, a hero picker, chat, and an invite link
  (`/?room=ID`) to share. Toggle **Ready** — the host can start once everyone is ready (or alone), and the room also
  auto-starts on a cancellable 5s countdown once everyone readies up. The host can also pick campaign vs. a published
  custom level, toggle Death mode, toggle private/public, and kick players.
- Rooms already in progress still take late joiners (up to 4) straight into the action; the public room list shows
  "In lobby" or the current level for each open dungeon.
- If your connection drops mid-run, the client automatically tries to reconnect (with backoff) and resumes your same
  hero — health, keys, potions and score intact — as long as you're back within 30 seconds; a disconnected ally shows
  up dimmed ("away") in the HUD until then.
- Move with `WASD` or arrows. Hold `Space` to fire; while firing you stand still and the stick turns you, just like the arcade.
- `Q` or `Shift` uses a magic potion (clears monsters around you; kills Death). `Enter` inserts a coin after you die.
- `T` chats, `M` toggles sound, `N` toggles the narrator.
- **Mobile and gamepad** (#15, `client/input.js`): on a coarse (touch) pointer, or with `?touch=1` in the URL, an oversized
  8-direction d-pad, a fire button, an **AUTO-FIRE** toggle (persists for the run, remembered in `localStorage`) and a
  potion button replace the keyboard controls; each direction/fire zone tracks its own pointer, so steering and firing
  work together with two fingers down at once. Standard USB/Bluetooth gamepads (Xbox, PlayStation, generic) work too,
  polled every frame: the left stick or d-pad steers (0.35 deadzone), face buttons 0-3 or the right trigger fire, and a
  non-standard pad falls back to plain axes 0/1 and buttons 0-3. Gamepad connects/disconnects are announced in the log
  and narrator ("Controller 2 connected"). Pad 0 always drives your own hero; pads 1-3 each open an **extra local hero**
  in the same room on the same connection (capped at 4 players total) via a small `{t:'join_local', slot}` protocol
  extension (`server/game/room.js` `Room#joinLocal`) — no lobby ready-up needed for the extra heroes, and input for them
  is tagged with their `slot`.
- A master/SFX/narrator-voice **volume mixer**, a **Cutscenes** on/off toggle, colour-blind palette and reduced-motion
  options all live in [Settings](#settings) (`/settings.html`) and take effect immediately.
- A short pixel-art cutscene plays the first time you see the lobby, the first time you pick each
  hero, and at a few other story beats (Death mode start, a treasure room, game over/victory,
  depth milestones) — any key skips it, and it can be turned off entirely from Settings. The
  **Arcade** nav link (`/attract.html`) loops an idle attract-mode title screen, hero roster and
  high-score table when nobody's playing.
- Your health drains one point per second. Eat food (+100). Shoot generators before they flood the room. Keys open doors
  (all connected door tiles open together). Secret walls crumble when touched. Step on the exit to move the whole party to the next level.
- Level 1 is hand-built. Every level after that is procedurally generated from the room seed, getting bigger and nastier forever.
- **Death mode**: pick it from the room screen's Mode dropdown. Every level is a randomly generated arena (no
  hand-built opener) and the exit stays sealed — shown pulsing red — until your party clears that level's timed
  waves of monsters. Beat the level cap (shown as "Level N / cap" in the HUD and "Death mode · cap 99" in the room
  list) and you get a victory screen; get wiped out for too long and the run ends too. Either way the room drops
  back to the lobby so you can run it again.

## Features

- **Authoritative server simulation** at 20 Hz over WebSockets; clients send input, receive compact snapshots and interpolate.
  Each monster type carries its own single-character `snapKey` (`shared/constants.js`) so the wire format never collides
  two types starting with the same letter (ghost/grunt both "g", demon/death both "d" — a bug that used to make grunts
  draw as ghosts and Death draw as a demon); `SNAP_KEY_TO_MONSTER` maps it back to a real type on the client.
- **Rooms** of up to four players, public room list, quick play, deep links (`/?room=ID`), in-game chat. A room's four
  slots can be filled by separate connections, extra local gamepads on one machine (see "Mobile and gamepad" below), or
  a mix of both.
- **Pre-game room screen**: ready-up, host-only start (gated on all-ready, or auto-start on a 5s countdown), host settings
  (campaign vs. a published custom level, private/public, It tag mode — see below), hero switching before start, and
  host-only kick. A kick sticks for that room's whole lifetime — for logged-in players by account, and for guests via a
  signed guest id (`gc_guest_id` in `localStorage`) that survives reconnects and reloads. Host migrates to the next
  player if the host leaves. Late joiners to a room already in progress skip the room screen and jump straight in.
- **Reconnect**: a dropped socket keeps its player entity (score/keys/potions/health) for 30s, marked "away" in the HUD; the
  client auto-retries the connection with backoff and resumes the same hero via a per-tab resume token.
- **Accounts** (username + password, scrypt-hashed) with per-user stats, run history and achievements. Guests can play without saving.
- **Dozens of achievements**, defined in `shared/achievements.js`: classics like *Don't Shoot the Food!* and *Needs Food Badly*, plus
  speedruns, pacifist clears, full-party clears, no-death streaks, depth milestones, and builder achievements (*Architect*, *Prompt Engineer*).
- **Persistent hero progression**: registered heroes earn XP for kills, generators, treasure and level clears, which builds a
  hero **rank** (Peasant through Legend, `shared/progression.js`) that grants small automatic perks — more speed, shot damage,
  damage resistance, max health and magic — capped so the arcade health-drain loop and 4-player fairness stay intact. Guests
  earn no XP. A rank-up shows an in-game toast and a leaderboard mention.
- **Dashboard** (`/dashboard.html`): career stats, rank/XP progress bar and perks, achievement progress, recent runs, your levels,
  and leaderboards (score, rank, depth, kills, achievements, and a separate Death-mode tab).
- **Level Builder** (`/editor.html`): paint tiles, flood fill, resize, import/export ASCII, validate (border, connectivity, keys before doors),
  test-play instantly, save, publish to the community list, and play other people's levels.
- **AI generator**: describe a dungeon, pick difficulty and size. With an Anthropic key the server asks Claude for a level
  as structured JSON, validates and auto-repairs it, and falls back to the procedural generator if anything is off.
- **AI Narrator** (opt-in, off by default — see [AI Narrator](#ai-narrator-18) below): occasional Claude-generated
  commentary for party intros, near-death saves, kill streaks, and treasure vaults, cached per event and delivered
  through the same narrator voice channel as the fixed lines.
- **AI remix and tune** (#17): four more buttons in the Level Builder work on whatever level is currently on the canvas —
  **Remix** (vary the layout/monsters/loot), **Make harder** / **Make easier** (more or fewer generators and monsters,
  food swapped for poison food or back), and **Explain this level** (3-5 sentences of strategy advice in a panel).
  Remix/harder/easier always keep the start and exit tile(s) at their original coordinates and re-validate the result
  (repairing it first if needed); one level of undo is kept. Without an Anthropic key (or if the AI call fails
  validation) these fall back to a deterministic procedural variation instead of a real Claude rewrite — the status
  line always says which (`source: 'ai'` or `'procedural'`), and the buttons are relabeled to say so up front. All
  four AI-assist buttons are disabled with an explanatory tooltip for guests. Procedurally generated campaign/Death-mode
  levels also get an AI-written name and one-sentence description when a key is configured, fetched ahead of time for
  the *next* level so the tick/level-load path itself never waits on the network — see "Level Builder and AI generator"
  below.
  `POST /api/levels/generate` validates input and rate-limits as normal, then starts generation in the background and
  replies `202 {"jobId": "<id>", "status": "pending"}` immediately; the client polls `GET /api/levels/generate/:jobId` every couple
  of seconds until it reports `{"status": "done", "level": {...}, "source": "ai"|"procedural", "problems": [], "note": "...", "unlocked": []}` (or `{"status": "error", "error": "..."}`) —
  jobs are scoped to the caller who started them and expire 10 minutes after finishing. Pass `?wait=1` on the POST to
  get the old synchronous response back instead, for tests and scripts. This exists because production sits behind
  Cloudflare, which kills any proxied request running past 100 seconds, and Claude generation can take close to that long.
- **Chest intermission** (`shared/chests.js`): after clearing a level, a 15s pick window opens where every player is
  offered three hidden chests rolled from a seeded RNG (potions, keys, health, temporary next-level-only boosts like
  speed/shot damage/armor/rapid fire, a score bonus, or a rare ~10% cursed chest). Picks reveal live to everyone, the
  round ends early once all connected players have chosen (or auto-picks at the timeout), and boosts stack with hero
  perks for the following level, shown as small icons in the HUD, before clearing. A player who joins (or resumes)
  mid-intermission gets their own offer rolled immediately with the remaining countdown, and is covered by both the
  early-finish check and the timeout auto-pick.
- **Character unlocks** (`shared/unlocks.js`): 8 alternate palettes (a "classic" recolor per class at rank 2, plus
  harder-earned skins gated on a specific achievement or deeper rank) and 3 locked hero archetypes — **Paladin**
  (heavy armor, unlocks at rank 5), **Ranger** (fast, rapid-fire, unlocks after playing Elf and earning *Ghostbuster*),
  and **Necromancer** (frail but magic-heavy with wider potion blasts, unlocks via *Reaper Reaped* or rank 8).
  Requirements are evaluated server-side from real stats/achievements/rank; a locked hero or palette request silently
  falls back to Warrior/default with an error toast. The hero picker greys out locked cards with their requirement
  text and shows palette swatches under unlocked classes; other players see your chosen skin, tinted with your
  palette everywhere your name appears — the HUD, the room-screen roster, and the public room list. Newly
  opened unlocks push an in-game toast the moment an achievement or rank-up earns them, and the dashboard lists the
  whole catalogue with locked/unlocked state.
- **Death mode** (`bias.arena` in `shared/procgen.js`): an endless wave-survival mode. Every level is a generated
  arena — fewer, bigger rooms, wide corridors, noticeably more monster generators than a normal dungeon — and the
  exit is sealed (server-authoritative, rendered as a pulsing red tile) until the level's `3 + floor(level/5)`
  timed waves are cleared. Each wave spawns `4 + level*1.5` monsters at least 6 tiles from every player, mixing more
  grunts and demons in at depth and a Death every 5th level; a wave advances once its monsters are dead or after a
  40s timeout, with a 3s "WAVE N" banner between waves. Health drains 1.5x faster than campaign. The level cap is
  rank-gated (`levelCapForRank` in `shared/progression.js`: 99 through rank 3, +25 per rank after that, uncapped at
  the top rank) using the highest rank in the room (guests count as rank 1); clearing the capped level ends the run
  with a victory screen, and a party that stays wiped for 10 seconds with nobody continuing ends it as a loss —
  either way the room returns to the lobby to run it again. Runs are recorded to their own `death` leaderboard tab
  on the dashboard, separate from campaign high scores, with two Death-specific achievements (*Wave Rider*, *Staring
  Down Death*).
- **It tag mode** (#13, arcade parity: Gauntlet II): a host-set room option next to Mode/Private in the pre-game
  settings, off by default. With it on and 2+ players in the room, one random player is tagged "It" the moment
  a level starts (pulsing gold ring + a small crown over their hero, "YOU'RE IT!" in their own HUD) — every
  monster's target search (`server/game/sim.js` `nearestPlayer`) prefers the It player over whoever's actually
  closest, as long as they're alive and within the monster's usual wake range, falling back to ordinary
  nearest-player targeting the instant they're out of range or turn invisible (the Invisibility amulet still
  works exactly as it does for anyone else). The tag passes to a random other living player the moment the
  current bearer dies or leaves the room; with only one player left nobody is It and monsters behave normally.
  Killing a monster while tagged earns a small `+2` score bonus on top of the kill's normal value.
- **Mystery treasure rooms** (#13, arcade parity: Gauntlet II's level-8-style secret vaults): every other bonus
  treasure room (see below) conceals its exits behind a **hidden exit** (tile `H`) instead of a plain exit — it
  renders and behaves exactly like a wall until revealed. A **switch** (tile `L`, a walkable floor tile) placed
  across the room reveals every hidden exit in the level at once when a hero steps on it; collecting every last
  piece of treasure does the same, so the room is always solvable without the switch too. `shared/level.js`'s
  `exitReachable` never paths *through* a hidden exit (it is a wall until revealed, an exit afterwards): the
  level counts as solvable only when a hero can stand next to the hidden exit and can also reach a switch, or
  reach every treasure tile — one sealed-off treasure means the exit never opens. With no reveal condition at
  all it is treated exactly like a permanent wall, same as an unmatched pressure-plate wall group. The reveal reuses the tile-change flash from #11 (no separate animation plumbing)
  plus a "MYSTERY ROOM: find the exit" HUD banner that clears itself the moment the last hidden exit opens; the
  30s bonus-room timer still auto-completes the level with no bonus if nobody ever finds (or reveals) a way out.
- **New monster types**: the **Lobber** (tile `4`, generator `l`) keeps 4-7 tiles from its target and lobs an
  arcing shot every ~2s that flies clean over walls, landing on the target's position at launch time and
  damaging anyone within 0.8 tiles — the client draws it with a growing-then-shrinking scale to suggest height.
  The **Sorcerer** (tile `5`, generator `s`) fights like a grunt but blinks — visible 1.5s, invisible 1.0s —
  and can't be hit by a shot or potion while invisible (drawn at 20% alpha). The **Thief** (tile `6`, no
  generator) runs down whichever player is carrying a key or potion, steals one on contact, then flees; shoot
  it and it drops the stolen item on the spot, or it despawns with the loot once 15+ tiles from everyone
  (*Stop, Thief!* achievement).
- **Transporters** (tile `X`): step on one and it teleports you to the nearest other transporter in the level
  (randomly among ties), with a 1s cooldown so you can't instantly ping-pong back — monsters never use them.
  Twenty-five uses earns the *Teleporter* achievement. **Poison food** (tile `!`) looks just like food but
  costs 100 health (floored at 1) instead of healing — shooting it is harmless. **Cider** (tile `C`) is a
  simple +50 health drink; shooting it counts as "shooting the food."
- **Generator tiers**: a generator's tier (1-3) is derived from the level index (`1 + floor((level-1)/6)`,
  capped at 3), raising its own hp (3/5/7), the hp bonus it grants monsters it spawns (+0/+1/+2), and the
  score it's worth when destroyed (×1/×1.5/×2) — shown via the existing tinted `gen1`/`gen2`/`gen3` sprites.
- **Skip exit** (tile `8`): a rare exit variant (procgen places one ~8% of the time on levels 3+, always in a
  room far from the start) that jumps the whole party ahead 4 levels instead of 1 — Death mode's rank-gated
  cap still applies to the level you land on.
- **Bonus treasure rooms**: every 6th level in any non-Death mode is a generated open vault full of treasure
  with no monsters and several exits (`generateTreasureRoom` in `shared/procgen.js`) instead of a regular
  dungeon. A 30s timer runs from the moment it loads; find any exit early or let the timer expire — either
  way there's no chest intermission afterward. Every other one of these (deterministic per level, so the same
  seed always plays out the same way) is a **mystery room** instead, with its exits concealed — see "Mystery
  treasure rooms" above. Clearing 5 of them earns the *Bonus Hunter* achievement.
- **Amulets and boosts** (`server/game/sim.js` player `amulets`/`runBoosts`): rare arcade-parity pickups
  sprinkled by `shared/procgen.js` (amulets occasionally from level 2 on, boosts much more rarely from
  level 4 on, both scaling with depth). Four **amulets** are temporary, lasting 20 seconds with the
  remaining time shown in the HUD: **Invisibility** (tile `I`) makes every monster ignore you entirely —
  no targeting or aggro, they just wander — until it wears off; **Reflective Shots** (tile `R`) makes your
  shots bounce off one wall instead of dying there; **Repulsiveness** (tile `O`) pushes every monster
  within 3 tiles away each tick and makes you untouchable to them; **Super Shots** (tile `U`) makes your
  shots pierce straight through monsters, damaging each one they pass instead of stopping at the first.
  Five **permanent boosts** are rare and last the whole run (reset only when a fresh run starts), stacking
  up to 3 times each and shown as HUD pips: **Speed** (tile `V`, +12%/stack), **Armor** (tile `A`,
  -12% damage taken/stack), **Shot Power** (tile `B`, +1 damage/stack), **Shot Speed** (tile `Q`, -12%
  reload time/stack) and **Magic Power** (tile `N`, +0.5 magic/stack) — all apply immediately and work
  identically for Hero Builder custom heroes, since they live on the shared player object rather than any
  class-specific field. Collecting all four amulet kinds in a single run earns the *Amulet Collector*
  achievement.
- **Pressure-plate wall groups and timed walls** (`shared/constants.js` `TRAP_PLATES`/`GROUP_WALLS`/`TIMED_WALLS`,
  `server/game/sim.js` `triggerPlate`/`stepTimedWalls`): environmental puzzles distinct from the classic
  `W` secret wall (which crumbles on touch/collision). Three independent plate/wall-group pairs — plate
  `%` opens every `=` tile, `&` opens every `+` tile, `*` opens every `~` tile — solid like a wall until a
  hero **or a monster** steps onto the matching plate, which then dissolves *every* tile of that group glyph
  across the whole level (not just a connected cluster), once per plate. `shared/procgen.js` occasionally
  (levels 3+) seals a small treasure vault behind a wall group carved into the rock just outside a room, with
  the matching plate placed elsewhere as a fetch-the-key-first puzzle; `shared/level.js`'s `exitReachable`
  only ever treats a group wall as passable when its own plate is actually present in the level. Separately,
  timed walls are solid until a countdown (30s from level start by default, `TIMER_DEFAULT_SEC`, overridable
  per-level via an optional `{timers: {wall, exit, default}}` on the level object) elapses, then convert in
  place: `^` becomes floor, `:` becomes a real exit tile. `exitReachable` always treats a timed wall as
  eventually passable, since its timer fires unconditionally. The client fades in newly-opened tiles over a
  few frames and pulses a timed wall's tint faster as its countdown runs down.
- **Environmental hazards** (#12, `ACID_DAMAGE_PER_SEC`/`STUN_TICKS`/`STUN_IMMUNITY_TICKS` in
  `shared/constants.js`, `server/game/sim.js` `applyAcid`/`triggerStun`): all three are walkable —
  none of them ever block a hero's or a monster's movement — so they add spatial risk without
  turning into another pathing puzzle. **Acid puddles** (tile `a`) drain a standing hero's health
  every tick (10/s by default) straight through the same armor/perk/boost-scaled damage pipeline as
  any hit, so an armor boost softens it too; monsters are immune, being native to the dungeon.
  **Stun tiles** (tile `t`) freeze whoever touches them — hero or monster — for `STUN_TICKS` (1.5s):
  no movement, no firing, shown in the HUD/on-map as orbiting stars, followed by a `STUN_IMMUNITY_TICKS`
  (3s) grace window where the same tile won't retrigger, long enough to step off it. **Force fields**
  (tile `f`) block every projectile that touches them — player shots, monster shots, even a lobber's
  arc landing on one — destroying it with a spark, while never blocking movement, so gating a
  generator behind one means you must walk up to it instead of sniping it from range.
  `shared/procgen.js` sprinkles acid through corridors, an occasional stun tile guarding treasure,
  and force fields gating a generator's approach tiles, all from level 5 on.
- **Players block each other**: bumping into a teammate cancels that axis of movement (soft collision within
  0.7 tiles) so the party can't stack on top of one another — player shots still pass straight through
  teammates, only movement is blocked.
- **More narrator lines**: "Save keys for later levels" on your 3rd key of a level, "*Hero*, use magic!" when
  low on health with potions in reserve, "I've not seen such bravery" clearing a level with zero deaths and
  30+ kills, a more urgent "*Hero* is about to die" under 100 health, and "Remember, don't shoot food" the
  second time you shoot food in a level.
- **Pixel-art cutscenes, a synthesized sound engine, and a narrator voice pipeline** — see below — plus an
  **Arcade** attract-mode nav link and a synced sound/cutscenes mixer in Settings.

### Hero Builder

A player-authored custom hero: a 6-stat "notch" point-buy, a weapon, a trait, and hand-painted
8x8 pixel art. Its own files (`shared/hero-builder.js`, `server/heroes.js`,
`client/heroes.html`/`client/heroes.js`, `client/pixelsprite.js`) and its own `heroes` sqlite
table hold the character-sheet side (design, save, publish, clone); it is **fully wired into the
sim, room, and lobby** — a custom hero is playable exactly like a classic one.

**Playing as a custom hero**: on the lobby page (or the in-room hero switcher), click the
**Custom** tab next to "Choose your hero" to list your saved heroes (rank 3+ and logged in — build
one first at `/heroes.html`). Picking one sends `cls: 'custom:<heroId>'` in the `join`/`hero`
WebSocket message; `server/game/room.js`'s `pickHero` confirms you own it, re-validates it against
your *current* rank/achievements (`server/heroes.js`'s `resolveCustomHero`), and falls back to
Warrior with an on-screen error if either check fails (a hero built long ago, or belonging to
someone else, is never trusted as-is) — guests can't use custom heroes at all. In game your hero
renders its own painted pixel art (not a tinted stock sprite), its shots use its own weapon's
sprite, and its name tag/HUD use its painted color. The choice persists in `localStorage`
(`gc_class` as `custom:<id>`) and falls back to Warrior if that hero no longer exists.

- **Unlocks at rank 3** (Adventurer). Below that, `/heroes.html` shows a locked message instead of
  the builder.
- **Stats** (`shared/hero-builder.js` `STATS`): Speed, Shot Power, Fire Rate, Armor, Magic, and
  Health, each 0-5 notches ("Health" has no classic-class equivalent — see below). A rank-3 player
  gets a **12-notch budget**, +1 more at rank 6, +1 more at rank 9, and +1 for the `legend`
  achievement (max 15). Per-stat cap is always 5, regardless of budget.
  - **Classic-class calibration**: `notchesFromClass(cls)` converts one of the four classic
    `CLASSES` entries (warrior/valkyrie/wizard/elf) into a notch vector using fixed, hand-tuned
    linear ranges per stat (documented in `shared/hero-builder.js`, not derived at runtime from
    `CLASSES` so a future locked-archetype tweak can't silently shift the budget). Converted, the
    four classics land at **Warrior 11, Valkyrie 11, Wizard 13, Elf 13** notches — i.e. within
    11-13 of the 12-notch budget, so a from-scratch Hero Builder character is roughly as strong as
    (never stronger than) a classic hero. `fireRate` is the inverse of `shotCooldown` (higher notch
    = faster shots); `health` is a Hero-Builder-only stat (the four classics all share
    `START_HEALTH`, so their mapped `health` notch is always 0) that adds a flat bonus to max
    health via `maxHealthBonus`.
- **Weapons** (`WEAPONS`): axe, arrow, fireball (80% splash — also damages other monsters near the
  impact point), hammer, dagger (short range, fast), skull (gentle homing — its shot steers a
  little toward the nearest monster each tick). Each carries
  `shotSpeedMul`/`damageMul`/`cooldownMul`/`range`(tiles)/`sprite` on top of the notch-derived base
  stats; `server/game/sim.js` applies these to every shot a custom hero fires. All six are
  available as soon as the builder itself is (rank 3) — there's no per-weapon lock.
- **Traits** (`TRAITS`, pick at most one), applied live by `server/game/sim.js`: Glutton (food
  heals for 50% more, needs the `glutton` achievement), Scavenger (treasure/generator score +50%,
  rank 3), Thick Skin (take 50% less damage from a ghost's touch specifically, rank 3), Locksmith
  (25% chance a door doesn't consume your key, needs the `locksmith` achievement), Sprinter (+25%
  move speed while below 300 HP, needs `speedrunner`), Arcanist (potion blast radius +30%, needs
  `alchemist`).
- **Pixel art**: exactly 8 rows of 8 characters, each `.` (transparent) or `0`-`7` indexing
  `PALETTE` (8 hex colours lifted from `client/sprites.js`' `PAL`). At least 8 pixels must be
  painted. The hero's `color` (for `toClassDef`) is the most-used non-transparent colour.
- **Server rules** (`server/heroes.js`, table `heroes`): up to **5 heroes per account**; writes
  (create/update/delete/publish/clone) are rate-limited to 30/min per user; every route except
  `GET /api/heroes/gallery` requires login (401 for guests). Publishing re-validates the hero
  against the owner's *current* rank/achievements, so a hero built long ago can't go public if a
  later rule change put it over budget.
- **Gallery**: `GET /api/heroes/gallery` lists published heroes (paginated, `?page=`/`?limit=`),
  sorted by clone count. `POST /api/heroes/:id/clone` copies a published hero into the caller's own
  collection (subject to the same 5-hero limit) and bumps the original's clone count — a simple
  "fork" mechanic with no attribution tracking beyond the copy's own `author` field at read time.
- **AI Assist** (`server/ai/herogen.js`): the "🤖 AI Assist" panel in `/heroes.html` lets a rank-3+
  player describe a hero in prose ("a shadowy archer who lives on treasure") and get back a
  suggested build — stats within their point budget, a weapon, a trait, name/title/motto and an
  8x8 pixel sprite — loaded straight into the builder's form for them to tweak and save normally
  (the endpoint never saves anything itself). It calls Claude with the same `json_schema`
  structured-output approach as the AI level builder (sharing its Anthropic client/credential gate
  via `getClient`/`aiAvailable`, exported from `server/ai/levelgen.js`), feeding the model the
  caller's exact notch budget, unlocked weapon/trait ids and the fixed palette from
  `shared/hero-builder.js`. The model's JSON is repaired (stats rounded/clamped and trimmed down to
  budget, unknown weapon/trait ids replaced, malformed pixel rows replaced) and then validated with
  `validateHero`; if it still doesn't validate, or no AI credentials are configured, or the request
  is rate-limited, a **preset** is suggested instead — one of `presetHeroes()`'s three ready-made
  heroes, picked deterministically by hashing the prompt text, so the same description always
  suggests the same preset. `POST /api/heroes/ai` (body `{prompt}`, truncated to 300 characters):
  login + rank 3 required, rate-limited to 1 request per 10 seconds per user, returns `{hero,
  source: 'ai'|'preset', note?, aiAvailable}` — check `GET /api/ai/status` (or the response's
  `aiAvailable` field) to show a graceful "assistant unavailable, suggesting a preset instead"
  message up front.
- **Routes**: `GET /api/heroes/mine`, `GET /api/heroes/budget` (rank, unlocked weapons/traits,
  notch budget), `GET /api/heroes/gallery`, `POST /api/heroes` (create, or update when `id` is
  set), `GET /api/heroes/:id` (own or published), `DELETE /api/heroes/:id`, `POST
  /api/heroes/:id/publish` (toggle), `POST /api/heroes/:id/clone`, `POST /api/heroes/ai` (AI
  Assist, above). `POST /api/heroes/debug/xp`
  (body `{amount}`) is a test-only hook that grants XP to the caller, alive only when the server is
  started with `GAUNTLET_DEBUG=1` — it lives under `/api/heroes` (rather than the imagined
  `/api/debug/xp`) purely so the single additive router line in `server/index.js` still routes it
  to `server/heroes.js` without adding a second mount point.

Custom heroes are wired end to end into the sim, room and lobby (not just the character sheet):
`join`/`hero` messages accept `cls: 'custom:<heroId>'`; `sim.addPlayer` accepts a `classDef` object
so every place `server/game/sim.js` used to read `CLASSES[p.cls]` now goes through a `classOf(p)`
helper (`p.classDef || CLASSES[p.cls]`), keeping classic classes byte-for-byte unaffected; snapshot
and roster packets carry `custom: {name, pixels, color}` and `weapon` for display; and the lobby
and in-room hero pickers both list `GET /api/heroes/mine` under a "Custom" tab, rendered with
`spriteFromPixels` (`client/pixelsprite.js`).

### Level Builder and AI generator

See the Features list above — `/editor.html` (paint/flood-fill/resize/import-export/validate/publish)
and the "Generate with AI" prompt (Claude with a procedural fallback) are covered there. The AI side
lives in `server/ai/levelgen.js`; the async job queue backing the `/api/levels/generate*` endpoints
lives in `server/ai/jobs.js`; the shared validate/repair logic both sides rely on lives in
`shared/level.js`.

**AI remix and tune (#17)** — same file, same structured-JSON pattern, three more exports:

- `remixLevel({ level, mode })`, `mode` one of `'remix' | 'harder' | 'easier'` — sends the level's full
  current rows to Claude along with the exact coordinates its start/exit tile(s) must keep, then forces
  those coordinates back to their original glyphs regardless of what came back, repairs and re-validates
  the result. If it's still invalid (or there's no AI key, or the call fails) it falls back to a
  deterministic procedural variation instead: `'remix'` regenerates a fresh dungeon of the same size from
  a new seed via `shared/procgen.js`'s `generateLevel()` and overwrites start/exit back onto it; `'harder'`
  / `'easier'` add or remove generators/monsters and swap food for poison food (or back) on the existing
  rows, with no randomness involved, so the result is reproducible. Either way the response is
  `{ level, source: 'ai' | 'procedural' }`.
- `explainLevel({ level })` returns `{ explanation }` — 3-5 sentences of strategy advice from Claude, or
  (no AI key) a templated summary computed straight from the level's own tile counts (generators, loose
  monsters, keys/doors, treasure, poison food, a thief, Death).
- `describeLevel({ level, seed })` returns `{ name, description }` for a procedurally generated level —
  an AI-written name/blurb when a key is configured, or (falling back) a deterministic name derived from
  `seed` via `shared/procgen.js`'s `nameForSeed()` (same "\<Adjective\> \<Theme\>" word lists
  `generateLevel()` uses for its own default names).

  `server/game/room.js` calls `describeLevel()` for the *next* campaign/Death-mode level right after
  loading the current one (`Room#prefetchName`), caches whatever comes back, and never awaits it on the
  tick/level-load path itself (`Room#levelFor`/`applyCachedName` just check the cache synchronously) — a
  level loads with its plain procedural name if the AI name isn't back yet, and with the AI name if it
  is.

  Endpoints: `POST /api/levels/ai/remix` (body `{ level, mode }`) and `POST /api/levels/ai/explain` (body
  `{ level }`) — both logged-in only, and rate-limited to 1 AI action per 10 seconds per account, sharing
  that bucket with `POST /api/levels/generate` (so switching between "Generate", "Remix" and "Explain"
  doesn't dodge the limit). The Level Builder's **Remix**, **Make harder**, **Make easier** and **Explain
  this level** buttons call these; Remix/harder/easier replace the canvas with the result (keeping one
  level of undo) and show the source in the status line, Explain shows the text in a panel below the
  buttons, and all four are disabled with a tooltip for guests and relabeled when the server has no AI key
  configured.

### Cutscenes and attract mode

A small in-engine cutscene system draws pixel-art story beats using only the game's existing
8x8 sprites (`client/sprites.js`) and a hand-drawn 5x7 bitmap font (`client/font.js`) — no video,
no external images, no web fonts. Everything renders straight into a `<canvas>` at runtime.

**What exists**

- `client/font.js` — a chunky 5x7 bitmap font (A-Z, 0-9, basic punctuation) with `drawText(ctx,
  text, x, y, {scale, color, align, shadow})`, `measureText(text, scale)` and `wrapText(text,
  maxWidth, scale)`. Every glyph is drawn with `ctx.fillRect`, so it looks identical everywhere.
- `client/cutscenes.js` — the scene engine. Scenes are plain data: keyframed sprite "actors",
  a tiled dungeon background, title/caption text, screen fades, camera shake and a confetti
  particle layer. Fifteen scenes ship out of the box: `intro`, one `hero_<class>` scene per
  playable archetype (warrior, valkyrie, wizard, elf, paladin, ranger, necromancer),
  `death_mode`, `treasure_room`, `game_over`, `victory`, and `level_milestone_10` /
  `_25` / `_50`.
- `client/attract.html` (served at `/attract.html`, linked from the nav as **Arcade**) +
  `client/attract.js` — a full-screen arcade attract mode, looping forever: a pulsing title card
  ("PRESS ANY KEY"), the `intro` cutscene, a one-hero-at-a-time **portrait carousel** (each classic
  archetype drawn large via `sprite('hero', ...)` with its name and stats in the bitmap font, a
  short fanfare SFX cue — `client/audio.js`'s `sfx('ach')`, muted the same way every other SFX
  respects the mute setting — each time it advances to the next hero), a **scripted demo**
  (a hero built entirely client-side with `generateLevel` from `shared/procgen.js` — no server
  round-trip — hunts a few wandering grunts/ghosts/a demon around a small level, "killing" and
  respawning them; pure client-side, no server-side monster simulation), and the same all-time
  top-10 **high scores** board the lobby renders (`GET /api/highscores`, see [High
  scores](#high-scores-14) below). Any key, click or tap jumps to `/`.
- `client/cutscenes-demo.html` (served at `/cutscenes-demo.html`) — a dev page listing every
  registered scene in a dropdown with Play/Skip/loop controls, for reviewing new scenes quickly.
- An AI-generated dungeon backdrop (`client/media/title-backdrop.webp`, animated as
  `title-loop.mp4`) plays full-bleed behind the in-engine attract-mode canvas, dimmed so the
  bitmap title/text stay readable; a matching `title-card.webp` and `trailer.mp4` back the social
  preview image and the `/trailer.html` page (see `client/media/README.md` for provenance).
- `prefers-reduced-motion`, or the video simply failing to play (autoplay blocked, no decoder),
  falls back to the static `title-backdrop.webp` poster instead of the loop.

**Where scenes actually fire in `client/game.js`**: `intro` plays once per browser
session over a small canvas at the top of the lobby (`#intro-cutscene` in `client/index.html`,
hidden again once it finishes or is skipped); `hero_<classId>` plays the first time that session
picks that hero in the picker; `death_mode` plays over the in-game canvas (`#scene-cutscene`,
absolutely positioned on top of `#cv`) the moment a Death-mode room's `start` message arrives;
`treasure_room` plays on the `bonus` message; `game_over` / `victory` play on `gameover` (reason
`wipe` vs `cap`); and `level_milestone_10`/`_25`/`_50` fire as short stingers on the matching
`level` packet index. Every trigger is gated on `hasSeen`/`markSeen` where it's meant to run once,
and on a **Cutscenes** on/off toggle in Settings (`gc_cutscenes` in `localStorage`, default on —
see Settings below); `playCutscene` itself always honors
`prefers-reduced-motion` and is skippable on any key, click or tap, and never blocks or delays the
server-authoritative game underneath it.

**How to trigger a scene from game code**

```js
import { playCutscene, hasSeen, markSeen } from './cutscenes.js';

const handle = playCutscene(canvasEl, 'death_mode', {
  sfx,                          // reuse the game's own sfx(name) from client/audio.js — optional
  say: (text) => say('cutscene', text), // wrap the game's own say(id, text) narrator — optional
  allowSkip: true,      // any keydown/click/pointerdown on the canvas skips to the end
  onSkip:  () => {},    // called if the player skipped
  onDone:  ({ id, skipped }) => {},  // called exactly once, skipped or not
});
// handle.skip() / handle.stop() end it early from your own UI.

if (!hasSeen('intro')) {
  playCutscene(cv, 'intro', { onDone: () => markSeen('intro') });
}
```

`hasSeen(id)` / `markSeen(id)` use `sessionStorage`, so a "show once" trigger (e.g. `intro` on
first load, or `hero_<class>` the first time a player picks that archetype this session) won't
replay on the next room without a full browser restart. `playCutscene` lazily imports
`sprites.js` the first time it's called, so importing `cutscenes.js` never touches the DOM.

**How to author a new scene**

Add an entry to the `SCENES` registry in `client/cutscenes.js`:

```js
{
  id: 'my_scene',            // must be unique
  duration: 5,                // seconds; keep it short (4-9s) and skippable
  background: { type: 'hall' },              // or { type: 'void', color }
  shake: { start: 3, end: 5, magnitude: 3 }, // optional camera shake window
  layers: [
    { type: 'text', text: 'MY SCENE', x: 320, y: 40, scale: 4, color: '#f2c400', align: 'center' },
    { type: 'actor', sprite: 'hero', tint: '#e03c31', scale: 4,
      from: { x: -60, y: 260 }, to: { x: 300, y: 260 }, start: 0.2, end: 2, bob: 2 },
    { type: 'particles', kind: 'confetti', start: 0, count: 30 },
  ],
  captions: [{ at: 1.5, text: 'One line of dialogue.' }],
}
```

Layer `type`s available: `actor` (a keyframed sprite, `from`/`to`/`start`/`end`/`flip`/`bob`),
`sprite-static`, `text`, `rect`, `particles` (`kind: 'confetti'`), `torch` and `pulse` (a
pulsing full-screen tint, used by `death_mode`'s red vignette). `renderFrame(ctx, scene, t,
opts)` is a pure function — no timers, no DOM — so `test/cutscenes.test.js` renders every scene
at its start/middle/end frame against a stub 2D context to make sure nothing throws and every
scene's captions are sorted and in-bounds.

**Everything is skippable.** Every cutscene call defaults to `allowSkip: true`; the attract mode
treats *any* input as "go play the game" rather than gating on a specific key. Nothing here ever
blocks a player who just wants to get into the dungeon.

**Lobby idle → attract mode** (`client/attract-idle.js`): after 30 seconds with no keyboard,
pointer, touch or wheel activity on the lobby/hero-pick screen (`client/index.html`) while no room
has been joined, the tab is sent to `/attract.html` — the same as clicking the **Arcade** nav link.
The check is vetoed live (via a small callback game.js passes in) the instant a room is joined, so
a player mid-setup on a slow connection never gets yanked away just because the timer already
started; attract mode's own any-key/click/tap handler brings you straight back to `/`.

### High scores (#14)

A classic three-initial arcade score table, layered on top of (but not replacing) the per-account
career leaderboard on `/dashboard.html` — see `server/highscores.js` and `client/highscore.js`.

- **What counts as a "run"**: campaign is endless by design (see [How to play](#how-to-play) —
  "it never ends"), so the only place a run actually *ends* while its clients are still connected
  is **Death mode**'s cap/wipe finish (`server/game/room.js` `endRun()`). That's the one spot that
  records a score here — for every connected player, guest or logged-in, unlike the per-account
  `runs` table (`server/stats.js`) which skips guests entirely — and tells the client whether its
  own score just cracked the all-time top 10.
- **Storage**: a dedicated `highscores` sqlite table (`server/db.js`) — `user_id`/`guest_id` are
  both nullable and `username`/`class` are snapshotted at insert time, so a later username change
  or account deletion never rewrites the board. `initials` starts `NULL`.
- **Qualifying**: `qualifiesForHighScore(score, topScores, limit)` in `server/highscores.js` is a
  small pure function (unit-tested on its own in `test/highscores.test.js`) — true if the board
  holds fewer than `limit` entries, or the score beats the current lowest of the top `limit`. Ties
  don't bump an existing entry.
- **Entry modal**: when the local player's own score qualifies, `client/game.js`'s `gameover`
  handler shows `client/highscore.js`'s `showInitialsModal()` — three A-Z slots, Up/Down cycles the
  active slot's letter, Left/Right moves between slots, Enter (or a click, or a gamepad's face
  button — a small poll-based reader in the modal itself, not the general input system) confirms.
  Confirming calls `POST /api/runs/:id/initials`.
- **Claiming initials**: `POST /api/runs/:id/initials` (body `{initials, token}`), open to guests
  (no login required). `token` is a random value `recordHighScore()` mints for the run and hands
  back *only* to the client that owns it, via a private `hstoken` WS message sent just before the
  room-wide `gameover` broadcast (never inside `gameover`'s shared `scores[]`, which every player in
  the room receives identically) — a run id alone is a small sequential integer, so it is never
  trusted as its own capability. `initials` is validated against `/^[A-Z]{3}$/` (400 otherwise), the
  token is compared in constant time (403 if missing/wrong), and the claim is one-shot per run
  within 5 minutes of the run ending (409 past either limit).
- **Reading the board**: `GET /api/highscores` returns the top 10 all-time, `{ initials, username,
  score, class, level_reached, ended_at }[]`, `username` `null` for a guest run and `initials`
  `null` until claimed. Rendered as an arcade table both in the lobby (`#lobby-highscores` in
  `client/index.html`, auto-wired by `client/highscore.js` on load, refreshed every 30s) and drawn
  with the bitmap font in the attract loop (same data source, see [Cutscenes and attract
  mode](#cutscenes-and-attract-mode) above).

### Sound

Every sound effect is synthesized at runtime with the Web Audio API — no audio assets ship with
the game. `client/audio.js` is the whole engine: `initAudio()` arms the context to resume on the
first click/keypress (autoplay policy), `sfx(name)` plays one named effect, and `setMuted(bool)`
backs the `M` key. Square/triangle/noise
oscillators feed a small **bit-crusher** (a quantizing `WaveShaperNode`, no `ScriptProcessor`/
`AudioWorklet` needed) on the shared SFX bus for a grittier, lower-fidelity 1985-arcade character.

The catalogue covers a shot per weapon (axe whirr, sword slash, fireball whoosh, arrow twang,
hammer thud, dagger tick, skull wail), a hit/death pair per monster (ghost pop, grunt grunt, demon
roar, death moan, lobber plop, sorcerer blink, thief snicker), and one-shot cues for generator
crumble, doors, keys, food/cider, poison (a sour, wavering tone), potions, teleports, chest opens,
amulets (a magical shimmer) and permanent boosts (a brighter fanfare), a stun-tile zap and a
force-field spark (#12), the wave banner, level fanfare, victory/game-over stingers, rank-ups and
achievements.

The **master / SFX / narrator-voice** mixer lives in Settings (see below) and persists to
`localStorage` (`gc_vol_master`, `gc_vol_sfx`, `gc_vol_voice`, `gc_mute`) so it works for guests
too, mirrored to a logged-in account's saved `prefs` the same way sound/narrator preferences
already were. Volumes are read once when `client/audio.js` loads (a page navigation, e.g. from
Settings back to the lobby, is what picks up a change) rather than adjusted live within one page.

### Narrator voice

`client/voice.js` exports `say(lineId, text)`. It first tries a pre-rendered clip at
`/audio/voice/<lineId>.ogg` — checking `client/audio/voice/manifest.json` for which ids actually
have one — and falls back to `speechSynthesis` (the same low, slow, robotic settings the narrator
always used) when there's no clip yet. `client/game.js` calls `say(id, text)` with a stable id for
every narrator line (`welcome`, `needs_food`, `about_to_die`, `saved_by_food`, `poisoned`,
`dont_shoot_food`, `dont_shoot_food_again`, `save_keys`, `use_magic`, `bravery`, `level_n`,
`wave_n`, `died`, `amulet_invis`, `amulet_reflect`, `amulet_repulse`, `amulet_super`,
`boost_pickup`, plus `cutscene` for cutscene captions) instead of hard-coding the line's text —
`text` is still passed through as the speechSynthesis fallback and as the source for generating a
clip, but a pre-rendered clip is looked up by id alone. Every line runs through the narrator-voice
mixer volume from Settings.

`client/voice-lines.json` is the source of truth mapping every id to its line's text, and
`client/audio/voice/manifest.json` (ships empty) lists which ids currently have a rendered clip.
`test/voice.test.js` greps `client/game.js` for every `say(id, ...)` call and fails if an id is
missing from `voice-lines.json`. See [Development](#development) below for how to generate real
clips with `tools/generate-voice.mjs`.

### AI Narrator (#18)

An **optional, opt-in** layer on top of the fixed [Narrator voice](#narrator-voice) above:
occasional Claude-generated commentary lines for a handful of run events — a fresh party's arrival
at level 1, a near-death save (health climbing back out of the danger zone after dipping below it),
kill-streak milestones (10/25/50 kills in a row without dying), and entering/clearing a bonus
treasure vault. **Off by default.** Toggle it on `/settings.html` (works for guests too, stored in
`localStorage` — see [Settings](#settings) below); the toggle is disabled with an explanatory note
whenever the server has no AI credentials configured (`GET /api/ai/status` reports this as
`narrator: false`).

`server/ai/narrator.js` mirrors `server/ai/levelgen.js`'s Anthropic-SDK/`json_schema` pattern: `{
line }` structured output, at most ~12 words, in the arcade-narrator voice. There is no procedural
fallback — a missing API key, a refusal, or an error simply means no line is spoken that time.
Every event type + a coarse context key (e.g. `party|warrior,valkyrie`, `kill_streak|10`) is
generated **at most once ever**: a capped (200-entry) in-memory `Map` cache is backed by a
`narrator_lines` sqlite table (`server/db.js`) so a restart doesn't re-spend a generation for a key
already answered. Generation is always fire-and-forget from `server/game/room.js`'s `maybeNarrate()`
— never awaited on the 20Hz tick path — and a room speaks at most one AI line every 20 seconds, and
only once at least one connected player has opted in. The near-death and kill-streak triggers are
pure, unit-tested functions in `server/game/narrator-events.js`.

Lines are delivered through the exact same channel as the fixed lines — a `{t:'say', text}`
WebSocket message the client speaks via `client/voice.js`'s `say(id, text)` (a per-line-unique id,
so it can never be pre-rendered like the fixed ids and always falls through to `speechSynthesis`),
gated on the `aiNarrator` preference and honoring the same narrator on/off, mute, and volume
settings as every other narrator line.

**Privacy**: only coarse event context ever reaches the API — hero class names and integers like a
kill-streak threshold — never a player's username, chat text, or anything else about them.

### Settings

`/settings.html` (linked from the nav once you're logged in): change your password (rotates every
other session's token so a stolen token elsewhere stops working, while keeping you signed in),
adjust preferences — a **master/SFX/narrator-voice volume mixer**, narrator on/off, the opt-in
[AI Narrator](#ai-narrator-18) toggle, **cutscenes on/off**, colour-blind palette, reduced motion,
and key bindings — saved server-side to a `prefs` table and synced to any device you log into,
download a JSON export of everything the server knows about your account, or permanently delete
your account (password-confirmed; cascades to your sessions, stats, achievements, run history and
levels, unpublishing anything you'd shared). The AI Narrator toggle itself is shown even to guests
(logged out), since it works without an account.
Every preference is merged into the same `localStorage` keys the game already reads directly
(`gc_mute`, `gc_narrate`, `gc_ai_narrator`, `gc_cutscenes`, `gc_vol_master`, `gc_vol_sfx`,
`gc_vol_voice`) the moment you log in or save, so `client/game.js`, `client/audio.js` and
`client/voice.js` pick them up on their next load with no page reload needed once you navigate —
and guests get the same mixer/cutscenes-toggle/AI-narrator behavior from those same `localStorage`
keys, just without server-side sync across devices. `server/account.js`'s `PREF_KEYS` whitelist
names the exact same preference keys (`soundVolume`, `sfxVolume`, `voiceVolume`, `narrator`,
`aiNarrator`, `cutscenes`, `colorBlindPalette`, `reducedMotion`, `keyBindings`) that
`client/settings.js` sends and `client/common.js` mirrors into `localStorage`.

### Admin dashboard

`/admin.html` (linked from the nav for admins only) gives a live overview of the server: user,
run and level counts; every room currently open (public and private) with player counts and a
one-click **Close** action; a searchable user list (rank/XP, last run); a searchable level list
with **Unpublish**/**Delete** moderation actions; a feed of recent server- and client-side errors;
and an analytics tab with simple inline-SVG bar charts (no external chart library) for daily
active users, runs per day, average run length, a deepest-level histogram, hero pick rates and the
most-played custom levels.

**Who's an admin**: set `GAUNTLET_ADMINS` to a comma-separated list of usernames on the server
(e.g. `GAUNTLET_ADMINS=alice,bob`). If it's unset, the very first account ever registered (user id
1) is the admin — so a fresh install always has exactly one admin with zero configuration. Every
`/api/admin/*` endpoint (mounted from `server/admin.js`) checks this on every request via a single
`isAdmin(user)` gate at the top of `admin.handle()`; a logged-in non-admin gets a 403 and
`/admin.html` shows an access-denied message instead of the dashboard.

### Analytics and logging

A first-party `events` table (`server/telemetry.js`) records a small set of interactions: server
side, a room's `join`/`leave`/`start`/game-over the moment they cross the WebSocket boundary in
`server/index.js` (nothing in `server/game/*` knows telemetry exists); client side, small beacons
the browser posts to `POST /api/telemetry` for page views, session starts, level-reached, run-end
and client error events (fired from `client/common.js`, rate-limited per IP). Guests are counted
by a random per-browser id that resets if they clear site data — never anything more identifying.
See [Privacy](#privacy) below for exactly what is and isn't stored.

`server/log.js` is a small structured JSON logger; `server/index.js`'s one bare `console.error`
goes through it, and every `level: 'error'` line is also written to an `errors` table so
failures survive past whatever log viewer you have. Browser errors reach the same table: `client/
common.js` installs `window.onerror` and `unhandledrejection` handlers that `POST` to
`/api/client-errors` (rate-limited, body size capped, stack traces truncated to 4 KB, identical
messages deduped per page load). Admins can browse both server and client errors on the **Errors**
tab of `/admin.html`.

`GET /api/health` (no auth required) returns `{ ok, uptime, rooms, players, version }` for uptime
monitoring and container health checks — `deploy/deploy.sh` and the `Dockerfile`'s `HEALTHCHECK`
both poll it.

### Error reporting

Optional forwarding to [Sentry](https://sentry.io) (or any Sentry-compatible DSN endpoint) sits
behind `SENTRY_DSN` (`server/sentry.js`). Unset (the default), `@sentry/node` is never imported and
nothing changes: the first-party `errors` table above remains the only sink. Set it, and:

- **Setup**: set `SENTRY_DSN` to your project's DSN (`deploy/.env.example` has a template; the
  `docker-compose.yml` `app` service passes both `SENTRY_DSN` and the optional `SENTRY_ENVIRONMENT`
  through). No code change or restart-time flag needed beyond that — `server/log.js` `error()` and
  `POST /api/client-errors` pick it up automatically.
- **What's sent**: every `level: 'error'` line already destined for the `errors` table (server-side
  failures, plus browser errors reported via `window.onerror`/`unhandledrejection` in
  `client/common.js`) is *also* forwarded as one Sentry event, tagged `source: 'server'` or
  `source: 'client'`. The first-party table write always happens first and is unaffected by
  whether Sentry forwarding succeeds, fails, or is disabled.
- **Scrubbing**: forwarded events never include Authorization headers, session tokens, cookies,
  passwords, or raw IP addresses — any field whose key names one of those (token, authorization,
  cookie, password/passwd, secret, forwarded, remote-addr, or an `ip` word segment such as `userIp`,
  `X-Real-IP` or `CF-Connecting-IP`; words that merely contain "ip" like `shipping` are kept), at
  any depth, is stripped before the event is queued (`isSensitiveKey()`/`scrub()`/`beforeSend` in
  `server/sentry.js`, unit-tested in `test/sentry.test.js`). A reported `url` is reduced to origin + path (query strings and fragments are dropped, since a `?token=` in `location.href` is a string the key scrub cannot see). A client error's User-Agent is reduced
  to a coarse browser family (`Chrome`/`Firefox`/`Safari`/`Edge`/`Other`) rather than sent raw, and
  no username or user identity is attached to the event.
- **No source maps**: there's no build step, so stack traces already reference the exact files
  served over HTTP — source maps don't apply here.
- **Client-side**: no browser Sentry SDK is loaded from a CDN, even when `GET /api/health` reports
  `sentry: true` — this app is meant to keep working fully offline/first-party, and that would add
  a third-party script origin plus its own network calls straight from the browser. The existing
  `POST /api/client-errors` beacon (`client/common.js`) is unchanged; the *server* decides whether
  to additionally forward each one to Sentry.

**WebSocket protocol hardening**: the `/ws` server caps incoming message size (`maxPayload: 16KB`
— every legitimate message on this protocol is tiny, and chat text alone is already capped at 200
chars server-side) so a single hostile client can't force a huge allocation per message. Every
write path is rate-limited: `POST /api/register`, `POST /api/login`, room creation (`POST
/api/rooms`, `POST /api/levels/:id/play`, and the WS `join` message's `create: true` — all three
share one bucket, since each persists a live sim and timers in memory until the room empties out),
account changes, every level/hero write, and `POST /api/runs/:id/initials`. In-room chat is additionally trimmed, drops
empty/whitespace-only messages, and throttles a single connection to 10 messages per 10 seconds.

## Install as an app

Gauntlet Crawler is an installable PWA (#33): on Android/Chrome and desktop Chrome/Edge, an **Install app**
button appears (bottom-right, or wherever the page already provides an install slot) once the browser fires
`beforeinstallprompt`; on iOS Safari, use Share → **Add to Home Screen**. Installed, it launches full-screen
(no browser chrome) like an arcade cabinet, with its own home-screen icon.

- `client/manifest.webmanifest` declares the name, standalone display mode and icon set; every page's `<head>`
  links it plus `theme-color` and the Apple home-screen meta tags (`apple-mobile-web-app-capable`,
  `apple-mobile-web-app-status-bar-style`, `apple-touch-icon`).
- Icons (`client/icons/*.png` — 192, 512, a 512 maskable variant, and a 180 Apple touch icon) are pixel-art
  renders of the warrior hero sprite, generated by a pure-Node script with no image-library or native
  dependency: `node tools/generate-icons.mjs` (re)writes them; `test/pwa.test.js` regenerates into a temp
  directory and byte-compares against the committed PNGs so they can never silently drift out of date.
- `client/sw.js` is a module service worker (registered by `client/pwa.js`) that precaches the static app
  shell — every HTML page, `style.css`, the client and `/shared/*.js` modules, the sprite/font code, the
  media webp stills and the narrator's audio manifest — cache-first. It never intercepts `/api/*`, the `/ws`
  WebSocket upgrade, or `/sw.js` itself (see `client/sw-rules.js`, shared with its unit tests); navigations
  try the network first and fall back to the cached page only once offline. **Offline caveat**: the cached
  shell loads and the classic hero list still renders, but live play, rooms, chat, the leaderboard and the AI
  level builder all need the network — none of that is, or should be, served from cache.
- On activation, a new version posts a message back to every open tab and `client/pwa.js` shows a small
  "Updated — reload for the latest version" toast.
- Pass `?nosw=1` in the URL to skip registering the service worker entirely (used by the smoke/e2e test
  harnesses so a cached shell from a previous run can never mask a fresh code change).

## Level format

Levels are arrays of equal-length strings. Border must be walls; a start `S` and exit `E` are required.

```
# wall   . floor   D door   K key   F food   ! poison food (-100 hp)   C cider (+50 hp)
P potion   T treasure   E exit   8 skip-exit (+4 levels)   S start   X transporter
g grunt generator   h ghost generator   m demon generator   l lobber generator   s sorcerer generator
1 ghost   2 grunt   3 demon   4 lobber   5 sorcerer   6 thief (no generator)   Z Death   W secret wall
I invisibility amulet (20s)   R reflective-shots amulet (20s)   O repulsiveness amulet (20s)   U super-shots amulet (20s)
V speed boost (permanent)   A armor boost (permanent)   B shot-power boost (permanent)   Q shot-speed boost (permanent)   N magic-power boost (permanent)
% plate A (opens =)   & plate B (opens +)   * plate C (opens ~)   = / + / ~ wall groups (solid until their plate is triggered)
^ timed wall (-> floor after its countdown)   : timed wall (-> exit after its countdown)
a acid puddle (damages any hero standing on it; monsters immune)   t stun tile (freezes on contact, then a brief immunity window)
f force field (blocks shots; heroes and monsters walk straight through)
H hidden exit (solid like a wall until revealed by a switch or full treasure pickup)   L switch (reveals every hidden exit when a hero steps on it)
```

The same legend is exported as `LEGEND` from `shared/level.js` for the editor's tile palette and
its "Level format" help panel, so this table and the actual game logic can't drift apart.

## Architecture

```
server/            Node HTTP + WebSocket server
  index.js         static files, REST API (/api/*), WebSocket protocol (/ws), rate limits, maxPayload
  game/sim.js      authoritative simulation: movement, combat, generators, pickups, doors, potions, exits,
                   pressure-plate wall groups, timed walls, acid/stun/force-field hazards
  game/room.js     a running dungeon: tick loop, level progression, stats and achievement hooks
  game/lobby.js    room registry, quick play
  ai/levelgen.js   Claude-backed level generation with validation/repair and procedural fallback
  ai/herogen.js    Claude-backed Hero Builder AI Assist (build + sprite from a prompt), preset fallback
  ai/jobs.js       in-memory job store backing the async /api/levels/generate* endpoints
  db.js            node:sqlite connection + schema migrations
  auth.js          registration, login/logout, bearer-token sessions
  stats.js         per-user stat counters + achievement unlocking
  heroes.js        Hero Builder REST API (custom heroes) and the sim/room integration point
  account.js       settings-page ops: password change + session rotation, prefs, account deletion, data export
  admin.js         admin dashboard API (mounted under /api/admin/*), admin designation
  telemetry.js     first-party analytics: events table, IP hashing, aggregations, 90-day retention
  log.js           structured JSON logger + persisted `errors` table
  ws-heartbeat.js  WebSocket liveness sweep (ping/pong, dead-client cleanup)
  highscores.js    arcade all-time high scores: record/qualify/claim-initials (#14)
shared/            code used by both server and browser
  constants.js     tiles, classes, monsters, tuning
  level.js         parse / validate / repair, tile legend
  procgen.js       seeded endless generator (rooms + corridors + loot + generators + bonus rooms)
  levels/level1.js the hand-built opener
  rng.js           seeded PRNG (mulberry32) used everywhere gameplay randomness must be reproducible
  achievements.js  achievement definitions
  progression.js   XP curve, rank titles/thresholds, perk caps — shared by server and dashboard/HUD
  chests.js        intermission chest pool, seeded rolling, and applying picked chests to a player
  unlocks.js       palette + hero-archetype unlock catalogue, requirement evaluation, dashboard catalogue
  hero-builder.js  Hero Builder stat/weapon/trait rules, validation and pricing (server + client)
client/            static browser app (no build step)
  index.html/game.js       lobby, room screen and in-game client
  dashboard.html/js        player dashboard
  editor.html/js           Level Builder + AI generator UI
  heroes.html/js           Hero Builder UI
  settings.html/js         account settings
  admin.html/js            admin dashboard UI
  attract.html/js          attract-mode title screen (hero carousel + scripted demo + high scores)
  attract-idle.js          lobby-idle -> attract mode redirect (#14)
  highscore.js             arcade high-score table + three-initial entry modal (#14)
  cutscenes-demo.html      dev page for reviewing cutscenes
  common.js, sprites.js, font.js, pixelsprite.js, audio.js, voice.js, cutscenes.js   shared client modules
  input.js                touch d-pad/auto-fire + Gamepad API + local co-op input (#15)
test/               node:test unit suites, plus smoke.mjs and e2e.mjs (Playwright)
tools/              tools/generate-voice.mjs — narrator voice clip generation
deploy/             Hetzner/Docker deployment scripts and Caddy config
```

## Development

```bash
npm test                                              # unit tests (test/**/*.test.js), node --test
CHROMIUM_PATH=/path/to/chromium npm run smoke         # boots the real server, drives it in a real browser
CHROMIUM_PATH=/path/to/chromium npm run e2e           # full multiplayer/editor/dashboard scenarios, two browsers
```

`npm run smoke` and `npm run e2e` need `npx playwright install --with-deps chromium` once (or an
existing Chromium binary pointed at by `CHROMIUM_PATH`). `.github/workflows/ci.yml` runs all three
— `test`, `smoke`, `e2e` — on every push and pull request.

Optional environment variables:

| Variable | Purpose |
|---|---|
| `PORT` | HTTP/WebSocket port (default 3000) |
| `DATA_DIR` / `DB_PATH` | Where the SQLite database is stored |
| `ANTHROPIC_API_KEY` | Enables the AI level builder, the Hero Builder's AI Assist, and the opt-in [AI Narrator](#ai-narrator-18). Without it: "Generate with AI" falls back to the procedural generator, AI Assist suggests a preset hero (both still steered by your prompt), and AI Narrator silently produces no lines (the toggle is disabled client-side too) |
| `GAUNTLET_AI_MODEL` | Claude model id for level generation, Hero Builder AI Assist, and AI Narrator commentary (default `claude-opus-5`) |
| `TRUST_PROXY` | Set to `1` when running behind Cloudflare/nginx so rate limits and per-caller job scoping use `cf-connecting-ip` / `x-forwarded-for` instead of the proxy's address. Leave unset when clients connect directly (headers could be spoofed) |
| `GAUNTLET_ADMINS` | Comma-separated usernames granted access to `/admin.html`. Unset means only the first registered account (user id 1) is an admin — see [Admin dashboard](#admin-dashboard) |
| `GAUNTLET_SALT` | Salt used to hash IPs before they're stored for analytics. Takes precedence over any previously-persisted salt when set; auto-generated and persisted if unset — see [Privacy](#privacy) |
| `SENTRY_DSN` | Enables forwarding server and client errors to Sentry (or a compatible DSN endpoint). Unset means Sentry is never imported and the first-party `errors` table is the only sink — see [Error reporting](#error-reporting) |
| `SENTRY_ENVIRONMENT` | Environment name tagged on forwarded Sentry events (default `production`). No effect when `SENTRY_DSN` is unset |
| `GAUNTLET_DEBUG` | Set to `1` to arm test-only hooks (below). Never set this in production |

**Debug hooks** (only reachable when `GAUNTLET_DEBUG=1`, otherwise a plain 404/no-op — these are
the *only* debug surfaces in the app):

- A `{t:'debug', action}` WebSocket message, handled by `Room#debugAction` (`server/game/room.js`):
  `action: 'clear'` force-completes the current level (used by `test/e2e.mjs` to reach the chest
  intermission and later levels without playing them out), `action: 'killall'` wipes every current
  monster (used to force a Death-mode wave to advance instantly).
- `POST /api/heroes/debug/xp` (body `{amount}`), handled in `server/heroes.js`: grants XP to the
  caller so `test/heroes-api.test.js` and `test/e2e.mjs` can reach the Hero Builder's rank-3 unlock
  without a long grind.
- `POST /api/debug/highscore` (body `{score, cls, level, mode, userId, guestId, username,
  endedAt}`), handled inline in `server/index.js`: seeds one row directly on the [arcade high-score
  board](#high-scores-14) so `test/highscores.test.js` can test `GET /api/highscores` and `POST
  /api/runs/:id/initials` without driving a whole Death-mode run to completion.

`test/e2e.mjs` starts its server with `GAUNTLET_DEBUG=1`; `npm start`/`npm run dev` don't set it,
so these hooks are unreachable in a normal or deployed instance.

**Generating narrator voice clips**: the game works out of the box via the browser's
`speechSynthesis` (see [Narrator voice](#narrator-voice) above). To pre-render real audio clips
instead, run `tools/generate-voice.mjs`:

```bash
# no key set: prints setup instructions and exits 0 (the game already works via speechSynthesis)
node tools/generate-voice.mjs

# with an ElevenLabs account:
ELEVENLABS_API_KEY=sk-...            \
ELEVENLABS_VOICE_ID=voice_id_here    \  # optional — defaults to a documented placeholder voice
node tools/generate-voice.mjs [id ...]  # omit ids to (re)generate every line
```

It calls the ElevenLabs REST text-to-speech API over `fetch`, and if `ffmpeg` is on `PATH` it
additionally down-samples each clip to 8kHz mono Ogg/Vorbis (a cheap-DAC "bit-crush" pass that
matches the arcade-narrator feel) before writing `client/audio/voice/<id>.ogg` and refreshing the
manifest. Generated clips are not committed to the repo (see `.gitignore`) — only
`client/audio/voice/manifest.json` is, shipping empty so a fresh checkout always falls back to
`speechSynthesis` until someone runs the script.

## Deployment

### CloudPanel host (no Docker)

The production instance runs on a CloudPanel server as a Node.js site: `clpctl site:add:nodejs --domainName=<host> --nodejsVersion=22 --appPort=3000 --siteUser=gauntlet ...` creates the nginx vhost (with WebSocket upgrade headers) and a per-user Node via nvm. The app runs under pm2 with `PORT=3000 DATA_DIR=$HOME/data`, and `deploy/deploy-cloudpanel.sh` is installed as `$HOME/deploy.sh` for the site user. The GitHub deploy workflow runs that script when it exists on the target host and falls back to the Docker path otherwise.


The app ships as a single Docker image (`Dockerfile`, `node:22-slim`, non-root user, `npm ci --omit=dev` so
`playwright` never lands in production) fronted by [Caddy](https://caddyserver.com) for automatic HTTPS and
WebSocket-aware reverse proxying (`docker-compose.yml`, `deploy/Caddyfile`). It's designed to run on a single
Hetzner Cloud VPS with data persisted in a Docker volume, and to auto-deploy from GitHub Actions over SSH whenever
`main` is updated.

### Hetzner quick start

1. Create a Hetzner Cloud server: **CX22**, image **Ubuntu 24.04**, add your SSH key.
2. Point your domain's DNS `A`/`AAAA` record at the server's IP (skip this for an IP-only/test deploy).
3. SSH in as root and bootstrap it:

   ```bash
   ssh root@YOUR_SERVER_IP
   curl -fsSL https://raw.githubusercontent.com/sethshoultes/gauntlet-crawler/main/deploy/setup-server.sh | bash
   ```

   (Or `scp deploy/setup-server.sh root@YOUR_SERVER_IP:/root/` and run it there.) This installs Docker, opens
   `ufw` for `22/80/443`, creates a `deploy` user, clones the repo into `/opt/gauntlet-crawler`, copies
   `deploy/.env.example` to `.env`, and runs `docker compose up -d --build`.
4. Edit `/opt/gauntlet-crawler/.env` and set `DOMAIN` (your real hostname, for Caddy's automatic HTTPS) and,
   optionally, `ANTHROPIC_API_KEY` to enable the AI level builder. Then re-apply:

   ```bash
   cd /opt/gauntlet-crawler && docker compose up -d --build
   ```

### Auto-deploy from GitHub Actions

`.github/workflows/deploy.yml` runs `npm ci && npm test` on every push to `main` (and via manual
`workflow_dispatch`), then SSHes into the server and runs `deploy/deploy.sh`, which pulls the branch, rebuilds
with `docker compose up -d --build --remove-orphans`, prunes old images, and polls `GET /api/health` inside the
`app` container before declaring success. It's a no-op (skipped, not failed) until these repository secrets are
set:

| Secret | Purpose |
|---|---|
| `DEPLOY_HOST` | Server hostname or IP to SSH into |
| `DEPLOY_USER` | SSH user on the server (the `deploy` user created by `setup-server.sh`) |
| `DEPLOY_SSH_KEY` | Private key authorized for that user (its public half must be in the user's `~/.ssh/authorized_keys`) |
| `DEPLOY_PORT` *(optional)* | SSH port, if not 22 |

### Manual operations

```bash
cd /opt/gauntlet-crawler
docker compose up -d --build       # deploy/redeploy
docker compose logs -f app         # tail server logs
docker compose ps                  # container status
docker compose down                # stop everything (volumes persist)
```

## Privacy

**Raw IP addresses are never written to the database.** Every event's IP (used only for coarse,
aggregate analytics and rate limiting) is SHA-256 hashed together with a server-side salt before
it's stored, so the same visitor hashes consistently across requests without the address itself
ever being recoverable from the data. The salt is `GAUNTLET_SALT` when that env var is set
(taking precedence over, and persisting over, any salt a previous run stored) — otherwise it's
read back from a `meta` table, or generated once and persisted there on first run — so hashes
stay stable across restarts either way. Guests are otherwise counted by a random per-browser id
that resets if they clear site data — never anything more identifying than that.

**What's stored** in the first-party `events` table (`server/telemetry.js`): a timestamp, an event
kind (page view, join/leave/start/game-over, client error, etc.), an optional user id or guest id,
a small JSON payload (e.g. which room), and the hashed IP described above. Events older than **90
days** are deleted automatically by a daily background job. The admin analytics tab (see [Admin
dashboard](#admin-dashboard)) only ever sees aggregates — counts per day, per class, per level —
never a list of raw events.

**Your account's data**: `/settings.html` lets any logged-in user download a JSON export of
everything the server knows about their account (profile, stat counters, achievements, run
history, owned levels, preferences) or permanently delete the account — password-confirmed,
cascading to sessions, stats, achievements, run history and levels, and unpublishing anything
they'd shared.

## Roadmap

Tracked as GitHub issues. Implemented already (see [Features](#features) above): character unlocks
(#1), hero level-ups/progression (#2), the chest selection intermission (#3), Endless/Death mode
(#4), the full pre-game lobby with ready-up/private rooms/reconnect (#5), durable guest kicks (#7),
palette tint shown in the lobby roster and room list (#8), chests offered to players who join
mid-intermission (#9), in-game cutscene triggers (#23), the Hero Builder's lobby/simulation
integration (#24), an AI-generated launch trailer and title backdrop (#21), AI remix/tune/explain
for existing levels plus AI-written names for procedural levels (#17), and the rest of Gauntlet
II's arcade parity: amulets and permanent boosts (#10), pressure-plate wall groups and timed walls
(#11), acid puddles/stun tiles/force fields (#12), and It tag mode plus mystery treasure rooms
(#13).

Sound synthesis (#20), pre-rendered narrator voice lines (#19), optional opt-in AI narrator
commentary (#18), the mobile touch layout/gamepad support (#15), and the original-style attract
mode / three-initial high-score entry (#14) are also implemented (see [Sound](#sound), [Narrator
voice](#narrator-voice), [AI Narrator](#ai-narrator-18), "Mobile and gamepad", and [Cutscenes and
attract mode](#cutscenes-and-attract-mode) / [High scores](#high-scores-14) above) even though all
five issues are still open on the tracker pending someone closing them out.

The installable PWA shell — manifest, home-screen icons, offline app-shell caching (#33) — is also
implemented; see [Install as an app](#install-as-an-app) above.

Open, not yet implemented:

- **AI assist**: describe a hero and get a build/sprite suggestion (#16).
- **Ops**: optional Sentry (or compatible) error reporting alongside the built-in error log (#22).

Not affiliated with Atari. Gauntlet is a trademark of its respective owners; this is a fan tribute built from scratch.

## Credits

Built as a fan tribute to the 1985 Atari Games arcade classic *Gauntlet*, with every sprite, sound
and voice line original to this project (see [Sound](#sound) and [Narrator voice](#narrator-voice)
above) — no assets from the original game are used.
