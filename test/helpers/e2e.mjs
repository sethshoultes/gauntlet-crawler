// Shared bits for Playwright-driven end-to-end scripts (test/e2e.mjs, test/e2e-features.mjs).
// Deliberately NOT imported by test/e2e.mjs itself — that file predates this one and several
// agents touch it concurrently, so its own copies of this logic (server/browser spawn, console/
// request error capture, the scenario runner, ...) are left alone; this module exists so a
// *second* Playwright script (test/e2e-features.mjs, #35) doesn't have to re-invent them. A later
// cleanup pass can point test/e2e.mjs at this file too once nobody else is mid-edit on it.
//
// The server-spawning half of that duplicated logic already had its own shared home
// (test/helpers/server.mjs's startServer()), used by several node:test files — this module reuses
// that directly rather than copying it a third time. What's left here is everything Playwright-
// specific that startServer() has no reason to know about.
import { once } from 'node:events';
import WebSocket from 'ws';

/** Attach page/console/request error capture to a Playwright page, tagged for the summary log —
 *  same shape as test/e2e.mjs's own `attach()`. Push targets are shared arrays so every page in
 *  a run reports into one place. */
export function attachPageErrors(page, tag, { pageErrors, consoleErrors, failedRequests }) {
  page.on('pageerror', (err) => pageErrors.push(`[${tag}] ${String((err && err.stack) || err)}`));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(`[${tag}] ${msg.text()}`); });
  page.on('requestfailed', (req) => {
    const errorText = req.failure()?.errorText || 'failed';
    if (errorText === 'net::ERR_ABORTED') return; // navigations aborting in-flight requests is normal
    failedRequests.push(`[${tag}] ${req.method()} ${req.url()} -> ${errorText}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 500) failedRequests.push(`[${tag}] ${res.request().method()} ${res.url()} -> HTTP ${res.status()}`);
  });
}

/** A tiny scenario runner: each named scenario runs independently, failures are recorded (not
 *  thrown) so the rest of the suite keeps going, and a final summary prints PASS/FAIL for every
 *  one plus any explicitly-flagged product bugs. Mirrors test/e2e.mjs's own scenario()/knownBug(). */
export function makeRunner(log) {
  const results = [];
  const knownBugs = [];
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
   *  than a test-harness issue. The assertion itself must still have been left to fail above. */
  function knownBug(name, detail) {
    knownBugs.push({ name, detail });
    log(`KNOWN BUG in "${name}": ${detail}`);
  }
  return { scenario, knownBug, results, knownBugs };
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
 *  evaluation, retrying until it resolves — copied from test/e2e.mjs's readSelfHud() (see there
 *  for why this must be one page.evaluate() rather than several locator round trips). */
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
