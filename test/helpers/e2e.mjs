// Shared plumbing for the Playwright-driven end-to-end suites written after test/e2e.mjs
// (test/e2e-features.mjs, #35; test/e2e-mobile.mjs, #34; and any future sibling): server-boot
// helpers, the scenario runner + failure reporting, browser-error capture, a REST-registered
// login identity, and a WebSocket "snap spy" for reading the authoritative snapshot stream
// without a browser. Deliberately NOT imported by test/e2e.mjs itself — that file predates this
// one and several agents touch it concurrently (see AGENT_RULES.md), so its own inline copies of
// this logic are left alone.
//
// The server-spawning helpers below overlap with test/helpers/server.mjs's startServer() (used by
// node:test files and by test/e2e-features.mjs directly); they're kept here too, alongside
// spawnGameServer()/stopGameServer(), because test/e2e-mobile.mjs was written independently
// against this shape. A later cleanup pass could consolidate on one or the other.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import net from 'node:net';
import WebSocket from 'ws';

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function waitForServer(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      fetch(url).then((res) => resolve(res)).catch((err) => {
        if (Date.now() > deadline) return reject(err);
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

/** Random hex suffix for unique usernames/room names across a run. */
export function rnd() {
  return crypto.randomBytes(3).toString('hex');
}

/** Spawn server/index.js on a free port against `dataDir`, merging `env` over process.env. Returns
 *  once it starts listening (or throws if it exits first). `root` is the repo root (the caller's
 *  `..` from wherever it lives under test/). */
export async function spawnGameServer({ root, dataDir, port, env = {} }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, GAUNTLET_DEBUG: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (d) => { serverOutput += d.toString(); });
  server.stderr.on('data', (d) => { serverOutput += d.toString(); });
  const serverExit = once(server, 'exit');

  await Promise.race([
    waitForServer(baseUrl),
    serverExit.then(([code]) => { throw new Error(`server exited early (code ${code}):\n${serverOutput}`); }),
  ]);

  return { server, serverExit, baseUrl, output: () => serverOutput };
}

/** Reuses the pre-created `serverExit` promise (see test/helpers/server.mjs's header note for why
 *  a fresh once(child,'exit') would hang if the child already exited) to shut the server down. */
export async function stopGameServer({ server, serverExit }) {
  if (server.exitCode === null && server.pid) {
    try { process.kill(server.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await serverExit.catch(() => {});
}

/** Wires a page's pageerror/console-error/failed-request/5xx-response events into the shared bags
 *  every suite fails its overall run on, tagging each entry with `tag` for a multi-context suite.
 *  `isExpectedFailure(req)` (optional) lets a scenario that deliberately breaks the network — the
 *  PWA offline-reload check, say — mark a specific in-flight request's failure as expected rather
 *  than a bug. The browser also logs its own "Failed to load resource: ..." line to the console for
 *  the same failed request, so `isExpectedConsoleError(text)` (optional) suppresses that echo too;
 *  neither turns off failure tracking for anything else the page does. */
export function attach(page, tag, bags, isExpectedFailure, isExpectedConsoleError) {
  page.on('pageerror', (err) => bags.pageErrors.push(`[${tag}] ${String((err && err.stack) || err)}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (isExpectedConsoleError?.(msg.text())) return;
    bags.consoleErrors.push(`[${tag}] ${msg.text()}`);
  });
  page.on('requestfailed', (req) => {
    const errorText = req.failure()?.errorText || 'failed';
    if (errorText === 'net::ERR_ABORTED') return; // navigations aborting in-flight requests is normal
    if (isExpectedFailure?.(req)) return;
    bags.failedRequests.push(`[${tag}] ${req.method()} ${req.url()} -> ${errorText}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 500) bags.failedRequests.push(`[${tag}] ${res.request().method()} ${res.url()} -> HTTP ${res.status()}`);
  });
}

/** Same as attach() with no expected-failure filters — matches test/e2e-features.mjs's original
 *  call shape (page, tag, {pageErrors, consoleErrors, failedRequests}). */
export function attachPageErrors(page, tag, bags) {
  attach(page, tag, bags);
}

/** Builds a `scenario(name, fn)` runner + `knownBug(name, detail)` marker sharing one log prefix
 *  and one `results`/`knownBugs` array pair, same shape as test/e2e.mjs's top-level ones. Accepts
 *  either a log *function* (test/e2e-features.mjs's own `log(msg)`) or a plain string *prefix* to
 *  build one from (test/e2e-mobile.mjs's `makeRunner('e2e-mobile')`). */
export function makeRunner(logOrPrefix) {
  const results = [];
  const knownBugs = [];
  const log = typeof logOrPrefix === 'function' ? logOrPrefix : (msg) => console.log(`[${logOrPrefix}] ${msg}`);
  async function scenario(name, fn) {
    const start = Date.now();
    try {
      await fn();
      results.push({ name, ok: true });
      log(`PASS: ${name} (${Date.now() - start}ms)`);
    } catch (err) {
      results.push({ name, ok: false, error: err });
      log(`FAIL: ${name}: ${(err && err.stack) || err}`);
    }
  }
  /** Call from inside a scenario when the failing assertion reflects a genuine product bug rather
   *  than a test-harness issue. Prints a loud, unmissable marker; the assertion itself must still
   *  have been left to fail above (never weaken it to make this quieter). */
  function knownBug(name, detail) {
    knownBugs.push({ name, detail });
    log(`KNOWN BUG in "${name}": ${detail}`);
  }
  return { log, scenario, knownBug, results, knownBugs };
}

/** Register (or log in, if the name is already taken) a guest-free account over the REST API and
 *  return its bearer token + user id. Used wherever a scenario needs a logged-in identity without
 *  driving the login modal (the modal flow itself is covered by test/e2e.mjs scenario 1). */
export async function registerUser(baseUrl, name, pass) {
  const res = await fetch(`${baseUrl}/api/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: name, password: pass }),
  });
  if (!res.ok) throw new Error(`register failed for ${name}: HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (!body.token || body.user?.username !== name) throw new Error(`register response malformed: ${JSON.stringify(body)}`);
  return { token: body.token, id: body.user.id };
}

/** Open a raw `ws` connection to the game server and resolve once it's open — the same "helper
 *  bot" pattern test/e2e.mjs uses (scenarios 3/5/10) to reach server-only debug hooks or read the
 *  authoritative snapshot stream without a browser. */
export async function wsConnect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await once(ws, 'open');
  return ws;
}

/** A passive "snap spy": joins `roomId` as its own extra player (never sends input) purely to
 *  observe the authoritative broadcast stream — every discrete sim event (tile changes, plate/
 *  timedWall/reveal/teleport/pickup/...) arrives batched onto `t:'s'` snapshots as `.e`, exactly
 *  as client/game.js's onEvent() consumes them. Buffers the last `cap` events and every `t:'s'`
 *  snapshot's player-position array, so a scenario can assert on either without hand-rolling its
 *  own message parser (mirrors test/e2e.mjs's inline helperWs listeners, generalized). Because
 *  joining mid-game always spawns a real sim player (Room#join -> enterGame), every fixture level
 *  a scenario loads through the debug 'loadLevel' hook alongside a spy MUST place this player far
 *  from the hero's own path (see test/e2e-features.mjs's fixture builders) or its stationary body
 *  can block the hero's movement (Sim#blockedByPlayer). */
export async function snapSpy(port, roomId, name, cap = 300) {
  const ws = await wsConnect(port);
  const events = [];
  const pidByName = new Map();
  let lastSnap = null;
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.t === 's') {
      lastSnap = msg;
      if (msg.e) {
        events.push(...msg.e);
        if (events.length > cap) events.splice(0, events.length - cap);
      }
    } else if (msg.t === 'players') {
      for (const p of msg.list) pidByName.set(p.name, p.id);
    }
  });
  ws.send(JSON.stringify({ t: 'join', roomId, name }));
  await new Promise((r) => setTimeout(r, 400)); // let the join land before the caller acts
  return {
    ws,
    events,
    snap: () => lastSnap,
    /** pid of another player already in the room, resolved by the name they joined with (the
     *  'players' roster broadcast, not this spy's own join) — lets a scenario read the hero's own
     *  live position/hp via posOf() below without the hero's page exposing its pid anywhere. */
    pidOf: (playerName) => pidByName.get(playerName) ?? null,
    /** Position/health for one player pid — [id,x,y,dir,hp,kills,potions,score,dead,boosts,amulets,stun]
     *  per server/game/sim.js snapshot(). The spy only sees pids, not names, so the caller resolves
     *  the hero's own pid first (see the 'players' packet its own page received on join). */
    posOf: (pid) => { const p = lastSnap?.p?.find((row) => row[0] === pid); return p ? { x: p[1], y: p[2], hp: p[4], dead: !!p[8] } : null; },
    /** True once an event matching `pred` has been seen (searches the whole retained buffer, not
     *  just the latest snapshot — events only live on the tick they fired). */
    sawEvent: (pred) => events.some(pred),
    async waitForEvent(pred, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = events.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timed out waiting for a matching sim event (buffer: ${JSON.stringify(events.slice(-10))})`);
    },
    close() { try { ws.send(JSON.stringify({ t: 'leave' })); ws.close(); } catch { /* best effort */ } },
  };
}

/** Read the local player's own HUD row (name, HP, current level text) as one atomic in-page
 *  evaluation, retrying until it resolves. #hud is fully replaced (briefly emptying #hud-lvl and
 *  every .pp row) each time a `players` packet arrives, then repainted on the next animation frame
 *  — reading name/hp/level as separate round trips (locator calls) can straddle that reset and see
 *  an inconsistent snapshot, so this grabs all three in a single page.evaluate() and retries as a
 *  whole until it sees a complete, non-empty reading. (Copied from test/e2e.mjs.) */
export async function readSelfHud(page, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const lvl = (document.querySelector('#hud-lvl')?.textContent || '').trim();
      const row = [...document.querySelectorAll('#hud .pp')].find((el) => el.textContent.includes('(you)'));
      if (!row || !lvl) return null;
      const name = (row.querySelector('.nm')?.textContent || '').trim();
      const hp = Number((row.querySelector('.hp')?.textContent || '').trim());
      return {
        name, hp, level: lvl, playerCount: document.querySelectorAll('#hud .pp').length,
        amulets: (row.querySelector('.amulets')?.textContent || '').trim(),
        runboosts: (row.querySelector('.runboosts')?.textContent || '').trim(),
        classes: row.className,
      };
    });
    if (last && last.name && Number.isFinite(last.hp) && last.level) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for a stable HUD reading (last=${JSON.stringify(last)})`);
}

/** Hold a movement key for `ms`, then release it — the standard way these scenarios walk the hero
 *  a controlled distance onto/through a fixture tile. */
export async function pressFor(page, key, ms) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

/** A Playwright device descriptor (viewport, deviceScaleFactor, isMobile, hasTouch) suitable for
 *  `browser.newContext({...chromiumDevice(name), ...})`, run entirely on Chromium. Playwright's
 *  `devices['iPhone SE']`/`devices['iPad (gen 7)']` entries carry a WebKit user-agent string and
 *  `defaultBrowserType: 'webkit'` (they're meant to pair with a WebKit browser); Chromium can still
 *  emulate their touch/viewport/DPR characteristics, but presenting a Safari UA string from a
 *  Chromium engine would be actively misleading rather than realistic, so both are dropped. */
export function chromiumDevice(playwrightDevices, name) {
  const d = playwrightDevices[name];
  if (!d) throw new Error(`no Playwright device descriptor named "${name}"`);
  const { userAgent, defaultBrowserType, ...rest } = d;
  return rest;
}

/** Swaps a portrait device's width/height for its landscape orientation (Playwright's own
 *  `"<name> landscape"` descriptors are WebKit-flavoured for the iPhone/iPad entries too — see
 *  chromiumDevice() — so this just rotates the numbers ourselves instead of looking one up). */
export function landscapeOf(device) {
  return { ...device, viewport: { width: device.viewport.height, height: device.viewport.width } };
}
