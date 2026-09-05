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
npm test             # unit tests (level format, procgen, simulation, achievements, progression, death mode)
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
| `GAUNTLET_ADMINS` | Comma-separated usernames granted access to `/admin.html`. Unset means only the first registered account (user id 1) is an admin — see [Admin dashboard](#admin-dashboard) |
| `GAUNTLET_SALT` | Salt used to hash IPs before they're stored for analytics. Auto-generated and persisted if unset — see [Analytics and privacy](#analytics-and-privacy) |

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
- **Death mode**: pick it from the room screen's Mode dropdown. Every level is a randomly generated arena (no
  hand-built opener) and the exit stays sealed — shown pulsing red — until your party clears that level's timed
  waves of monsters. Beat the level cap (shown as "Level N / cap" in the HUD and "Death mode · cap 99" in the room
  list) and you get a victory screen; get wiped out for too long and the run ends too. Either way the room drops
  back to the lobby so you can run it again.

## Features

- **Authoritative server simulation** at 20 Hz over WebSockets; clients send input, receive compact snapshots and interpolate.
- **Rooms** of up to four players, public room list, quick play, deep links (`/?room=ID`), in-game chat.
- **Pre-game room screen**: ready-up, host-only start (gated on all-ready, or auto-start on a 5s countdown), host settings
  (campaign vs. a published custom level, private/public), hero switching before start, and host-only kick. A kick sticks
  for that room's whole lifetime — for logged-in players by account, and for guests via a signed guest id (`gc_guest_id`
  in `localStorage`) that survives reconnects and reloads. Host migrates to the next player if the host leaves. Late
  joiners to a room already in progress skip the room screen and jump straight in.
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

## Settings

`/settings.html` (linked from the nav once you're logged in): change your password (rotates every
other session's token so a stolen token elsewhere stops working, while keeping you signed in),
adjust preferences — sound volume, narrator on/off, colour-blind palette, reduced motion, and key
bindings — saved server-side to a `prefs` table and synced to any device you log into, download a
JSON export of everything the server knows about your account, or permanently delete your account
(password-confirmed; cascades to your sessions, stats, achievements, run history and levels,
unpublishing anything you'd shared). Sound/narrator preferences are merged into the same
`localStorage` keys the game already reads (`gc_mute`, `gc_narrate`) the moment you log in, so the
game picks them up with no changes to `client/game.js`.

## Admin dashboard

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
`/api/admin/*` endpoint (mounted from `server/admin.js`) checks this on every request; a logged-in
non-admin gets a 403 and `/admin.html` shows an access-denied message instead of the dashboard.

## Analytics and privacy

A first-party `events` table (`server/telemetry.js`) records a small set of interactions: server
side, a room's `join`/`leave`/`start`/game-over the moment they cross the WebSocket boundary in
`server/index.js` (nothing in `server/game/*` knows telemetry exists); client side, small beacons
the browser posts to `POST /api/telemetry` for page views, session starts, level-reached, run-end
and client error events (fired from `client/common.js`, rate-limited per IP). Guests are counted
by a random per-browser id that resets if they clear site data — never anything more identifying.

**What's stored**: an event's timestamp, kind, optional user id or guest id, a small JSON payload
(e.g. which room), and a hashed IP. **Raw IP addresses are never written to the database** — each
is SHA-256 hashed together with a server-side salt (`GAUNTLET_SALT`, or one generated once and
kept in a `meta` table) before it's stored, so the same visitor hashes consistently without the
address itself ever being recoverable. Events older than **90 days** are deleted automatically by
a daily background job. The admin analytics tab only ever sees aggregates (counts per day, per
class, per level) — never a list of raw events.

## Error logging

`server/log.js` is a small structured JSON logger; `server/index.js`'s one bare `console.error`
now goes through it, and every `level: 'error'` line is also written to an `errors` table so
failures survive past whatever log viewer you have. Browser errors reach the same table: `client/
common.js` installs `window.onerror` and `unhandledrejection` handlers that `POST` to
`/api/client-errors` (rate-limited, body size capped, stack traces truncated to 4 KB, identical
messages deduped per page load). Admins can browse both server and client errors on the **Errors**
tab of `/admin.html`.

`GET /api/health` (no auth required) returns `{ ok, uptime, rooms, players, version }` for uptime
monitoring and container health checks — `deploy/deploy.sh` and the `Dockerfile`'s `HEALTHCHECK`
both poll it instead of the old `/api/ai/status`.

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
  account.js       settings-page ops: password change + session rotation, prefs, account deletion, data export
  admin.js         admin dashboard API (mounted under /api/admin/*), admin designation
  telemetry.js     first-party analytics: events table, IP hashing, aggregations, 90-day retention
  log.js           structured JSON logger + persisted `errors` table
shared/            code used by both server and browser
  constants.js     tiles, classes, monsters, tuning
  level.js         parse / validate / repair
  procgen.js       seeded endless generator (rooms + corridors + loot + generators)
  levels/level1.js the hand-built opener
  achievements.js  achievement definitions
  progression.js   XP curve, rank titles/thresholds, perk caps — shared by server and dashboard/HUD
  chests.js        intermission chest pool, seeded rolling, and applying picked chests to a player
  unlocks.js       palette + hero-archetype unlock catalogue, requirement evaluation, dashboard catalogue
client/            static browser app (no build step): game, dashboard, editor, sprites, audio, settings, admin
test/              node:test suites
```

## Roadmap

Tracked as GitHub issues: hero level-ups (#2). The full pre-game lobby with ready-up, private rooms and reconnect
(#5), the chest selection intermission between levels (#3), character unlocks — alternate palettes and new hero
archetypes (#1) — and Endless / Death mode with timed waves and a rank-gated level cap (#4) are implemented above.

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
