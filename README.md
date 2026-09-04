# Gauntlet Crawler

A love letter to the 1985 arcade dungeon crawler: four heroes, hordes of ghosts and grunts pouring out of
generators, keys and doors, food you must not shoot, a health bar that never stops ticking down, and a
narrator who reminds you that the Elf needs food badly.

This version is **online multiplayer** (up to four players per dungeon), has **modern achievements** and a
**player dashboard**, is **endless** thanks to a seeded procedural dungeon generator, and ships with a
**level builder** that can draft dungeons with an **AI generator** (Claude) from a text prompt.

Deliberately simple graphics: every sprite is 8x8 pixel art drawn in code, no asset pipeline.

## Quick start

```bash
npm install
npm start            # http://localhost:3000
npm test             # unit tests (level format, procgen, simulation, achievements)
```

Requires Node.js 22.5+ (uses the built-in `node:sqlite`). Data lives in `./data/gauntlet.sqlite`.

Optional environment variables:

| Variable | Purpose |
|---|---|
| `PORT` | HTTP/WebSocket port (default 3000) |
| `DATA_DIR` / `DB_PATH` | Where the SQLite database is stored |
| `ANTHROPIC_API_KEY` | Enables the AI level builder. Without it, "Generate with AI" falls back to the procedural generator steered by your prompt |
| `GAUNTLET_AI_MODEL` | Claude model id for level generation (default `claude-opus-5`) |

## How to play

- Pick a hero: **Warrior** (Thor, strongest shot and armor), **Valkyrie** (Thyra, balanced), **Wizard** (Merlin, best magic),
  **Elf** (Questor, fastest, rapid fire).
- **Quick Play** drops you into a public dungeon with other players, or **Create room** for your own (optionally private).
- Move with `WASD` or arrows. Hold `Space` to fire; while firing you stand still and the stick turns you, just like the arcade.
- `Q` or `Shift` uses a magic potion (clears monsters around you; kills Death). `Enter` inserts a coin after you die.
- `T` chats, `M` toggles sound, `N` toggles the narrator. Touch controls appear on phones.
- Your health drains one point per second. Eat food (+100). Shoot generators before they flood the room. Keys open doors
  (all connected door tiles open together). Secret walls crumble when touched. Step on the exit to move the whole party to the next level.
- Level 1 is hand-built. Every level after that is procedurally generated from the room seed, getting bigger and nastier forever.

## Features

- **Authoritative server simulation** at 20 Hz over WebSockets; clients send input, receive compact snapshots and interpolate.
- **Rooms** of up to four players, public room list, quick play, deep links (`/?room=ID`), in-game chat.
- **Accounts** (username + password, scrypt-hashed) with per-user stats, run history and achievements. Guests can play without saving.
- **32 achievements** (`shared/achievements.js`): classics like *Don't Shoot the Food!* and *Needs Food Badly*, plus
  speedruns, pacifist clears, full-party clears, no-death streaks, depth milestones, and builder achievements (*Architect*, *Prompt Engineer*).
- **Dashboard** (`/dashboard.html`): career stats, achievement progress, recent runs, your levels, and leaderboards (score, depth, kills, achievements).
- **Level Builder** (`/editor.html`): paint tiles, flood fill, resize, import/export ASCII, validate (border, connectivity, keys before doors),
  test-play instantly, save, publish to the community list, and play other people's levels.
- **AI generator**: describe a dungeon, pick difficulty and size. With an Anthropic key the server asks Claude for a level
  as structured JSON, validates and auto-repairs it, and falls back to the procedural generator if anything is off.

## Level format

Levels are arrays of equal-length strings. Border must be walls; a start `S` and exit `E` are required.

```
# wall   . floor   D door   K key   F food   P potion   T treasure   E exit   S start
g grunt generator   h ghost generator   m demon generator
1 ghost   2 grunt   3 demon   Z Death   W secret wall
```

## Architecture

```
server/            Node HTTP + WebSocket server
  index.js         static files, REST API (/api/*), WebSocket protocol (/ws)
  game/sim.js      authoritative simulation: movement, combat, generators, pickups, doors, potions, exits
  game/room.js     a running dungeon: tick loop, level progression, stats and achievement hooks
  game/lobby.js    room registry, quick play
  ai/levelgen.js   Claude-backed level generation with validation/repair and procedural fallback
  db.js / auth.js / stats.js   node:sqlite persistence, sessions, counters + achievement unlocks
shared/            code used by both server and browser
  constants.js     tiles, classes, monsters, tuning
  level.js         parse / validate / repair
  procgen.js       seeded endless generator (rooms + corridors + loot + generators)
  levels/level1.js the hand-built opener
  achievements.js  achievement definitions
client/            static browser app (no build step): game, dashboard, editor, sprites, audio
test/              node:test suites
```

## Roadmap

Tracked as GitHub issues: character unlocks (#1), hero level-ups (#2), chest selection between levels (#3),
Endless / Death mode with rank-gated level caps (#4), and a full pre-game lobby with ready-up and reconnect (#5).

Not affiliated with Atari. Gauntlet is a trademark of its respective owners; this is a fan tribute built from scratch.
