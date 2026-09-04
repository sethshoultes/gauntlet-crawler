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
npm test             # unit tests (level format, procgen, simulation, achievements, progression)
```

Requires Node.js 22.5+ (uses the built-in `node:sqlite`). Data lives in `./data/gauntlet.sqlite`.

## Development

`npm test` runs the unit tests (`test/**/*.test.js`) with `node --test`. `npm run smoke` boots the
real server, drives it end-to-end in a real browser via Playwright (needs `npx playwright install --with-deps chromium`
once), and checks the level generation API; CI (`.github/workflows/ci.yml`) runs both on every push and pull request.

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
- **Quick Play** joins a public room that's still in its lobby (or makes one), **Create room** starts your own (optionally private).
  Either way you land in the **room screen** first: roster with hero/rank/ready state, a hero picker, chat, and an invite link
  (`/?room=ID`) to share. Toggle **Ready** — the host can start once everyone is ready (or alone), and the room also
  auto-starts on a cancellable 5s countdown once everyone readies up. The host can also pick campaign vs. a published
  custom level, toggle private/public, and kick players.
- Rooms already in progress still take late joiners (up to 4) straight into the action; the public room list shows
  "In lobby" or the current level for each open dungeon.
- If your connection drops mid-run, the client automatically tries to reconnect (with backoff) and resumes your same
  hero — health, keys, potions and score intact — as long as you're back within 30 seconds; a disconnected ally shows
  up dimmed ("away") in the HUD until then.
- Move with `WASD` or arrows. Hold `Space` to fire; while firing you stand still and the stick turns you, just like the arcade.
- `Q` or `Shift` uses a magic potion (clears monsters around you; kills Death). `Enter` inserts a coin after you die.
- `T` chats, `M` toggles sound, `N` toggles the narrator. Touch controls appear on phones.
- Your health drains one point per second. Eat food (+100). Shoot generators before they flood the room. Keys open doors
  (all connected door tiles open together). Secret walls crumble when touched. Step on the exit to move the whole party to the next level.
- Level 1 is hand-built. Every level after that is procedurally generated from the room seed, getting bigger and nastier forever.

## Features

- **Authoritative server simulation** at 20 Hz over WebSockets; clients send input, receive compact snapshots and interpolate.
- **Rooms** of up to four players, public room list, quick play, deep links (`/?room=ID`), in-game chat.
- **Pre-game room screen**: ready-up, host-only start (gated on all-ready, or auto-start on a 5s countdown), host settings
  (campaign vs. a published custom level, private/public), hero switching before start, and host-only kick. Host migrates
  to the next player if the host leaves. Late joiners to a room already in progress skip the room screen and jump straight in.
- **Reconnect**: a dropped socket keeps its player entity (score/keys/potions/health) for 30s, marked "away" in the HUD; the
  client auto-retries the connection with backoff and resumes the same hero via a per-tab resume token.
- **Accounts** (username + password, scrypt-hashed) with per-user stats, run history and achievements. Guests can play without saving.
- **32 achievements** (`shared/achievements.js`): classics like *Don't Shoot the Food!* and *Needs Food Badly*, plus
  speedruns, pacifist clears, full-party clears, no-death streaks, depth milestones, and builder achievements (*Architect*, *Prompt Engineer*).
- **Persistent hero progression**: registered heroes earn XP for kills, generators, treasure and level clears, which builds a
  hero **rank** (Peasant through Legend, `shared/progression.js`) that grants small automatic perks — more speed, shot damage,
  damage resistance, max health and magic — capped so the arcade health-drain loop and 4-player fairness stay intact. Guests
  earn no XP. A rank-up shows an in-game toast and a leaderboard mention.
- **Dashboard** (`/dashboard.html`): career stats, rank/XP progress bar and perks, achievement progress, recent runs, your levels,
  and leaderboards (score, rank, depth, kills, achievements).
- **Level Builder** (`/editor.html`): paint tiles, flood fill, resize, import/export ASCII, validate (border, connectivity, keys before doors),
  test-play instantly, save, publish to the community list, and play other people's levels.
- **AI generator**: describe a dungeon, pick difficulty and size. With an Anthropic key the server asks Claude for a level
  as structured JSON, validates and auto-repairs it, and falls back to the procedural generator if anything is off.
- **Chest intermission** (`shared/chests.js`): after clearing a level, a 15s pick window opens where every player is
  offered three hidden chests rolled from a seeded RNG (potions, keys, health, temporary next-level-only boosts like
  speed/shot damage/armor/rapid fire, a score bonus, or a rare ~10% cursed chest). Picks reveal live to everyone, the
  round ends early once all connected players have chosen (or auto-picks at the timeout), and boosts stack with hero
  perks for the following level, shown as small icons in the HUD, before clearing.

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
  progression.js   XP curve, rank titles/thresholds, perk caps — shared by server and dashboard/HUD
  chests.js        intermission chest pool, seeded rolling, and applying picked chests to a player
client/            static browser app (no build step): game, dashboard, editor, sprites, audio
test/              node:test suites
```

## Roadmap

Tracked as GitHub issues: character unlocks (#1), hero level-ups (#2), and Endless / Death mode with rank-gated
level caps (#4). The full pre-game lobby with ready-up, private rooms and reconnect (#5), and the chest selection
intermission between levels (#3), are implemented above; a real Death mode is still coming.

Not affiliated with Atari. Gauntlet is a trademark of its respective owners; this is a fan tribute built from scratch.

## Deployment

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
with `docker compose up -d --build --remove-orphans`, prunes old images, and polls `/api/ai/status` inside the
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
