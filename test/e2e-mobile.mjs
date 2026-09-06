#!/usr/bin/env node
// Mobile end-to-end suite (#34): boots the real server once (free port, temp DATA_DIR,
// GAUNTLET_DEBUG=1) and drives it with Playwright's real device emulation — touch, mobile
// viewport, device scale factor — across an iPhone SE, a Pixel 7 and an iPad (gen 7), portrait
// plus a landscape variant of the core gameplay scenario on the two phones. Shares the desktop
// harness's plumbing (test/helpers/e2e.mjs) rather than test/e2e.mjs itself, which several agents
// edit concurrently (see AGENT_RULES.md) — this file is untouched by that traffic.
//
// Not a node:test file (test/**/*.test.js only), so it never runs as part of `npm test` — invoked
// explicitly via `npm run e2e:mobile`.
//
// Usage:
//   npm run e2e:mobile
//   CHROMIUM_PATH=/opt/pw-browsers/chromium npm run e2e:mobile
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import WebSocket from 'ws';
import {
  findFreePort, spawnGameServer, stopGameServer, attach, makeRunner, readSelfHud, rnd,
  chromiumDevice, landscapeOf,
} from './helpers/e2e.mjs';

// ---------------- device profiles ----------------
// Chromium-only (see chromiumDevice()'s doc comment for why the WebKit UA/defaultBrowserType on
// Playwright's iPhone/iPad descriptors are dropped): viewport, deviceScaleFactor, isMobile and
// hasTouch are all Chromium can (and does) faithfully emulate.
const DEVICE_SPECS = [
  { label: 'iPhone SE', device: chromiumDevice(devices, 'iPhone SE') },
  { label: 'Pixel 7', device: chromiumDevice(devices, 'Pixel 7') },
  { label: 'iPad (gen 7)', device: chromiumDevice(devices, 'iPad (gen 7)') },
];
const PHONE_LABELS = new Set(['iPhone SE', 'Pixel 7']); // the two devices that get a landscape gameplay rerun

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'gauntlet-e2e-mobile-'));
  const port = await findFreePort();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const { log, scenario, knownBug, results, knownBugs } = makeRunner('e2e-mobile');
  log(`starting server on http://127.0.0.1:${port} (DATA_DIR=${dataDir}, GAUNTLET_DEBUG=1)`);
  const { server, serverExit, baseUrl, output } = await spawnGameServer({ root, dataDir, port });
  log('server is listening');

  const bags = { pageErrors: [], consoleErrors: [], failedRequests: [] };
  let browser = null;
  let overallFailed = false;

  // One account per touch scenario that needs to be logged in, registered exactly once (session
  // tokens never expire — see server/auth.js — so every device context below just injects the
  // same token into its own localStorage rather than re-registering/re-logging-in, which would
  // otherwise chew through the 10-registrations-per-minute rate limit across 3 devices worth of
  // scenarios sharing one server).
  let gameplayCreds = { name: `e2eMobG${rnd()}`, pass: 'Password123' };
  let gameplayToken = null; // captured after scenario 2's touch-driven registration on the first device

  async function registerApi(name, pass) {
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: name, password: pass }),
    });
    if (!res.ok) throw new Error(`registering ${name} failed: HTTP ${res.status}`);
    const body = await res.json();
    if (!body.token) throw new Error(`register response for ${name} carried no token`);
    return body.token;
  }

  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

    const heroCreds = { name: `e2eMobH${rnd()}`, pass: 'Password123' };
    const levelCreds = { name: `e2eMobL${rnd()}`, pass: 'Password123' };
    const settingsCreds = { name: `e2eMobS${rnd()}`, pass: 'Password123' };
    const heroToken = await registerApi(heroCreds.name, heroCreds.pass);
    const levelToken = await registerApi(levelCreds.name, levelCreds.pass);
    const settingsToken = await registerApi(settingsCreds.name, settingsCreds.pass);

    const xpRes = await fetch(`${baseUrl}/api/heroes/debug/xp`, {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${heroToken}` },
      body: JSON.stringify({ amount: 700 }), // clears the rank-3 Hero Builder unlock, same debug hook as test/e2e.mjs
    });
    if (!xpRes.ok) throw new Error(`granting XP for the Hero Builder unlock failed: HTTP ${xpRes.status}`);

    // ---------------- per-scenario implementations (one context per scenario/device) ----------------

    /** Injects `token` into a page's localStorage after landing on the origin once, then reloads
     *  so every module (common.js's token()) picks it up as if the user had just logged in. */
    async function loginAs(page, token, path = '/') {
      await page.goto(`${baseUrl}${path}${path.includes('?') ? '&' : '?'}nosw=1`, { waitUntil: 'load' });
      await page.evaluate((t) => { try { localStorage.setItem('gc_token', t); } catch {} }, token);
      await page.reload({ waitUntil: 'load' });
    }

    /** Waits for client/heroes.js's `window.__hb.ready` (resolved once boot() has picked a branch
     *  and, when unlocked, already reset the form via newHero()) rather than inferring readiness
     *  from `#builder:not([hidden])` becoming visible — that inference only holds because boot()
     *  today never awaits between unhiding #builder and calling newHero(), an invariant this test
     *  shouldn't have to trust. Bounded with its own timeout via Promise.race so a `ready` that
     *  never resolves fails loudly instead of hanging the whole run. */
    async function waitForHbReady(page, timeoutMs = 10_000) {
      await page.evaluate((ms) => Promise.race([
        window.__hb.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error('window.__hb.ready did not resolve in time')), ms)),
      ]), timeoutMs);
    }

    /** #nav-login/#nav-logout live inside #nav-links, which the phones' <=700px breakpoint keeps
     *  display:none until #nav-toggle is tapped (the iPad's 810px portrait width never hides it in
     *  the first place — see the lobby scenario's own nav-toggle check). Tapping a hidden element
     *  fails, so open the menu first whenever it's actually collapsed. */
    async function ensureNavOpen(page) {
      const toggle = page.locator('#nav-toggle');
      if (await toggle.isVisible().catch(() => false) && !(await page.locator('#nav-links').isVisible())) {
        await toggle.tap();
      }
    }

    async function lobbyScenario(spec) {
      const ctx = await browser.newContext({ ...spec.device });
      const page = await ctx.newPage(); attach(page, `lobby-${spec.label}`, bags);
      try {
        await page.goto(`${baseUrl}/?nosw=1`, { waitUntil: 'load' });
        await page.waitForSelector('#heroes .hero', { timeout: 10_000 });

        const { scrollWidth, innerWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
        }));
        if (scrollWidth > innerWidth + 1) throw new Error(`${spec.label}: lobby has horizontal overflow (scrollWidth=${scrollWidth} innerWidth=${innerWidth})`);
        if (!(await page.locator('#heroes .hero').first().isVisible())) throw new Error(`${spec.label}: hero picker not visible`);

        await page.waitForFunction(() => (document.querySelector('#lobby-highscores')?.textContent || '').trim().length > 0, undefined, { timeout: 10_000 });
        if (!(await page.locator('#lobby-highscores').isVisible())) throw new Error(`${spec.label}: high-score table not visible`);

        // Nav toggle: on the two phones (<=700px, see client/style.css's "@media (max-width:
        // 700px)" rule) the nav collapses behind #nav-toggle; the iPad's 810px portrait width is
        // wide enough that the CSS never hides #nav-links in the first place, so there's nothing
        // to toggle there — assert whichever behaviour actually applies at this viewport.
        await page.waitForSelector('#nav-toggle', { state: 'attached', timeout: 10_000 }); // may be legitimately hidden (iPad-width) — see below
        const toggleVisible = await page.locator('#nav-toggle').isVisible();
        if (toggleVisible) {
          if (await page.locator('#nav-links').isVisible()) throw new Error(`${spec.label}: #nav-links should start collapsed`);
          if ((await page.getAttribute('#nav-toggle', 'aria-expanded')) !== 'false') throw new Error(`${spec.label}: #nav-toggle should start with aria-expanded="false"`);
          await page.locator('#nav-toggle').tap();
          if (!(await page.locator('#nav-links').isVisible())) throw new Error(`${spec.label}: #nav-links did not open after tapping #nav-toggle`);
          if ((await page.getAttribute('#nav-toggle', 'aria-expanded')) !== 'true') throw new Error(`${spec.label}: #nav-toggle should report aria-expanded="true" once opened`);
        } else if (!(await page.locator('#nav-links').isVisible())) {
          throw new Error(`${spec.label}: #nav-links should already be visible when #nav-toggle is not shown`);
        }
      } finally { await ctx.close().catch(() => {}); }
    }

    async function gameplayScenario(spec, { landscape = false } = {}) {
      const dev = landscape ? landscapeOf(spec.device) : spec.device;
      const tag = `play-${spec.label}${landscape ? '-landscape' : ''}`;
      const ctx = await browser.newContext({ ...dev });
      const page = await ctx.newPage(); attach(page, tag, bags);
      let helperWs = null;
      try {
        const isFirstRun = gameplayToken === null;
        await page.goto(`${baseUrl}/?touch=1&nosw=1`, { waitUntil: 'load' });
        await page.waitForSelector('#heroes .hero', { timeout: 10_000 });

        if (isFirstRun) {
          // Registration via touch, exercised once (the modal itself is identical regardless of
          // viewport — repeating it on every device/orientation combo would just burn the
          // 10-registrations-per-minute rate limit for no extra coverage).
          await ensureNavOpen(page);
          await page.locator('#nav-login').tap();
          await page.fill('#au', gameplayCreds.name);
          await page.fill('#ap', gameplayCreds.pass);
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'load' }),
            page.locator('#a-reg').tap(),
          ]);
          await page.waitForFunction(() => { try { return !!localStorage.getItem('gc_token'); } catch { return false; } }, undefined, { timeout: 10_000 });
          gameplayToken = await page.evaluate(() => { try { return localStorage.getItem('gc_token'); } catch { return null; } });
          if (!gameplayToken) throw new Error('touch registration did not leave a session token in localStorage');
        } else {
          await page.evaluate((t) => { try { localStorage.setItem('gc_token', t); } catch {} }, gameplayToken);
          await page.reload({ waitUntil: 'load' });
          await page.waitForSelector('#heroes .hero', { timeout: 10_000 });
        }

        // #gname is disabled once logged in (client/game.js shows the account username and locks
        // it) — the room roster carries that username instead, which is what the spy filters on.
        await page.locator('#heroes .hero').first().tap(); // Warrior — always unlocked
        await page.fill('#roomname', `Mobile ${tag}`);
        await page.locator('#create').tap();
        await page.waitForSelector('#roomscreen.on', { timeout: 15_000 });
        await page.waitForSelector('#rs-start:not([disabled])', { timeout: 5_000 }); // solo host, no ready-up needed
        await page.locator('#rs-start').tap();
        await page.waitForSelector('#game.on', { timeout: 15_000 });
        await page.waitForSelector('#touch.touch-force', { timeout: 5_000 });

        const roomId = new URL(page.url()).searchParams.get('room');
        if (!roomId) throw new Error(`${tag}: URL did not carry a room id after create`);

        // Spy on the room's raw snapshot stream (same trick as test/e2e.mjs's touch-layout
        // scenario) to read hero position and shots fired, since the HUD itself exposes neither.
        let myPid = null; let lastSnap = null;
        helperWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        await once(helperWs, 'open');
        helperWs.on('message', (data) => {
          let msg; try { msg = JSON.parse(data); } catch { return; }
          if (msg.t === 'players' && !myPid) { const me = msg.list.find((p) => p.name === gameplayCreds.name); if (me) myPid = me.id; }
          if (msg.t === 's') lastSnap = msg;
        });
        helperWs.send(JSON.stringify({ t: 'join', roomId, name: 'MobileSpy' }));
        await new Promise((r) => setTimeout(r, 400));
        if (!myPid) throw new Error(`${tag}: helper spy never saw a "players" packet naming our hero`);
        const posOf = () => { const p = lastSnap?.p?.find((pp) => pp[0] === myPid); return p ? { x: p[1], y: p[2] } : null; };

        // d-pad hold moves the hero. Playwright's touchscreen API only has tap() (no hold/drag), so
        // a held pointer is simulated with page.mouse — the input-dpad's own pointerdown/pointerup
        // listeners don't discriminate by pointerType, so this exercises the identical code path a
        // real touch hold would (same precedent as test/e2e.mjs's touch-layout scenario).
        const before = posOf();
        if (!before) throw new Error(`${tag}: no snapshot position before the d-pad hold`);
        const eastBtn = page.locator('.input-dpad .input-dir', { hasText: '▶' });
        const dpadBox = await eastBtn.boundingBox();
        if (!dpadBox) throw new Error(`${tag}: east d-pad zone has no bounding box`);
        await page.mouse.move(dpadBox.x + dpadBox.width / 2, dpadBox.y + dpadBox.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(1000);
        await page.mouse.up();
        const afterMove = posOf();
        if (!afterMove) throw new Error(`${tag}: no snapshot position after the d-pad hold`);
        if (!(afterMove.x > before.x)) throw new Error(`${tag}: expected x to increase after holding the east d-pad zone (before=${before.x}, after=${afterMove.x})`);

        // Fire button shoots: the snapshot's `b` array is the live shot list (server/game/sim.js
        // snapshot()) — a direct signal, rather than inferring it from HP/score drift. Held (not
        // tapped) via page.mouse for the same reason as the d-pad above: input.js sends the held
        // state at most once per 50ms (client/game.js's setInterval), so a bare tap can start and
        // end between two sends and never actually reach the server as `fire: true`.
        const fireBox = await page.locator('.input-fire').boundingBox();
        if (!fireBox) throw new Error(`${tag}: fire button has no bounding box`);
        await page.mouse.move(fireBox.x + fireBox.width / 2, fireBox.y + fireBox.height / 2);
        await page.mouse.down();
        // Poll rather than a single check right after a fixed hold: a shot can lag a tick or two
        // behind the client's next 50ms input send and the snapshot that follows it.
        const fireDeadline = Date.now() + 1500;
        while (Date.now() < fireDeadline && !(lastSnap?.b?.length > 0)) await new Promise((r) => setTimeout(r, 100));
        await page.mouse.up();
        if (!(lastSnap?.b?.length > 0)) throw new Error(`${tag}: expected at least one live shot in the snapshot after holding the fire button`);

        // Auto-fire toggle persists (localStorage) across a reload of the same run page.
        const autoBtn = page.locator('.input-autofire');
        await autoBtn.tap();
        const onAfterToggle = await page.evaluate(() => { try { return localStorage.getItem('gc_autofire'); } catch { return null; } });
        if (onAfterToggle !== '1') throw new Error(`${tag}: expected gc_autofire=1 in localStorage after tapping auto-fire`);

        await page.reload({ waitUntil: 'load' }); // resumes the same room via sessionStorage's gc_resume
        await page.waitForSelector('#game.on', { timeout: 15_000 });
        await page.waitForSelector('#touch.touch-force', { timeout: 5_000 });
        const autoOnAfterReload = await page.locator('.input-autofire').getAttribute('class');
        if (!autoOnAfterReload?.includes('on')) throw new Error(`${tag}: auto-fire toggle did not stay ON across a reload`);

        // Best-effort only, short-timeout: on a short landscape phone the fixed touch-controls
        // band can sit exactly where #leave/chat also land in the document flow (both anchor to
        // the bottom of a viewport that short), so a bare .tap() can dead-end retrying against an
        // obstructed hit-test for the full default 30s before giving up. Closing the context right
        // after has the same effect anyway (the room just sees a disconnect, same as a real user
        // switching apps — server/game/room.js's AWAY_GRACE_MS/emptySince cleanup already covers
        // that, same as every other scenario in this suite that never bothers clicking Leave).
        await page.locator('#leave').tap({ timeout: 2000 }).catch(() => {});
      } finally {
        try { helperWs?.send(JSON.stringify({ t: 'leave' })); helperWs?.close(); } catch { /* best effort */ }
        await ctx.close().catch(() => {});
      }
    }

    async function geometryScenario(spec) {
      const ctx = await browser.newContext({ ...spec.device });
      const page = await ctx.newPage(); attach(page, `geom-${spec.label}`, bags);
      try {
        // Stub Element.prototype.requestFullscreen *before* any script runs, recording which
        // element every call targets (headless Chromium can refuse the real Fullscreen API even
        // with a trusted tap, so this is what actually lets the "fullscreen targets #session, not
        // the canvas" acceptance criterion (#42) be asserted reliably rather than best-effort).
        await page.addInitScript(() => {
          window.__fsCalls = [];
          Element.prototype.requestFullscreen = function () { window.__fsCalls.push(this.id || this.tagName); return Promise.resolve(); };
        });
        await page.goto(`${baseUrl}/?touch=1&nosw=1`, { waitUntil: 'load' });
        await page.waitForSelector('#heroes .hero', { timeout: 10_000 });
        await page.locator('#heroes .hero').first().tap();
        await page.fill('#gname', `Geo${spec.label.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`);
        await page.locator('#create').tap();
        await page.waitForSelector('#roomscreen.on', { timeout: 15_000 });
        await page.waitForSelector('#rs-start:not([disabled])', { timeout: 5_000 });
        // Start the run from a *scrolled* room screen (#46): on a real phone the Start button sits
        // below the fold, so the page carries a scroll offset into the run. That offset used to
        // survive (the body was taller than the visible viewport, see client/style.css) and slid
        // the HUD strip up under the address bar — assertLayout() below checks it cannot any more.
        await page.evaluate(() => window.scrollTo(0, Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight)));
        await page.locator('#rs-start').tap();
        await page.waitForSelector('#game.on', { timeout: 15_000 });
        await page.waitForSelector('#touch.touch-force', { timeout: 5_000 });
        await page.waitForFunction(() => document.querySelectorAll('#hud .pp').length > 0, undefined, { timeout: 10_000 });
        await page.waitForTimeout(200); // let layoutGame() run at least once post-HUD

        const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        const inViewport = (box, viewport) => box.x >= -0.5 && box.y >= -0.5 && box.x + box.width <= viewport.width + 0.5 && box.y + box.height <= viewport.height + 0.5;

        // #42 acceptance criteria: this scenario is deliberately rewritten from the #34 original,
        // which only ever compared *container* boxes (#touch as a whole vs #cv/#hud) — on the
        // broken pre-#42 layout that could (and did) pass anyway, for two reasons this version
        // fixes: (1) #touch was `position: fixed` while #hud/#cv/#log were normal in-flow content
        // on a page that could itself scroll (exactly the "page scrolls during play" bug, #42's
        // acceptance criteria adds an explicit assertion against it below) — once the page is
        // scrolled even a little (e.g. a leftover scroll position from focusing #gname in the
        // lobby beforehand), a fixed element's box and a scrolled-away in-flow element's box are no
        // longer comparable at all, so the overlap check could spuriously see no intersection even
        // though the *unscrolled* page clearly does; (2) it never looked at any individual button —
        // a fire/potion/auto-fire pushed off the right edge of the screen (the phone screenshots'
        // literal first complaint) never showed up in a check that only ever measured the
        // container's own (possibly differently-sized) box. This version checks the real button
        // elements themselves, and (#46) measures the page exactly as the player sees it: an
        // earlier version pinned scrollY to 0 first, which is precisely what hid the "HUD slides
        // under the address bar" bug — a leftover room-screen scroll offset is what this must catch.
        const assertLayout = async (whenLabel) => {
          const overflow = await page.evaluate(() => ({
            scrollX: window.scrollX, scrollY: window.scrollY,
            scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
            scrollHeight: document.scrollingElement.scrollHeight, innerHeight: window.innerHeight,
            bodyHeight: document.body.getBoundingClientRect().height,
            // Headless Chromium has no collapsing address bar, so 100vh and 100dvh agree here and
            // the body's *rendered* height alone cannot show the real-device bug. Its computed
            // min-height can: the page-wide `body { min-height: 100vh }` is what made the body
            // taller than the dynamic viewport on a phone, so it must resolve to 0 during a run.
            bodyMinHeight: getComputedStyle(document.body).minHeight,
          }));
          if (overflow.scrollX || overflow.scrollY) throw new Error(`${spec.label} ${whenLabel}: page is scrolled during play (scrollX=${overflow.scrollX} scrollY=${overflow.scrollY}) — the HUD strip would sit above the viewport`);
          if (overflow.scrollWidth > overflow.innerWidth + 1) throw new Error(`${spec.label} ${whenLabel}: horizontal scroll (scrollWidth=${overflow.scrollWidth} innerWidth=${overflow.innerWidth})`);
          if (overflow.scrollHeight > overflow.innerHeight + 1) throw new Error(`${spec.label} ${whenLabel}: page scrolls vertically during play (scrollHeight=${overflow.scrollHeight} innerHeight=${overflow.innerHeight})`);
          if (Math.abs(overflow.bodyHeight - overflow.innerHeight) > 1) throw new Error(`${spec.label} ${whenLabel}: body is not exactly viewport-height during play (body=${overflow.bodyHeight} innerHeight=${overflow.innerHeight})`);
          if (overflow.bodyMinHeight !== '0px') throw new Error(`${spec.label} ${whenLabel}: body.gc-playing min-height is ${overflow.bodyMinHeight}, expected 0px (a 100vh floor makes the body taller than the dynamic viewport on phones, #46)`);

          const cvBox = await page.locator('#cv').boundingBox();
          if (!cvBox) throw new Error(`${spec.label} ${whenLabel}: #cv has no bounding box`);
          const viewport = page.viewportSize();
          if (!inViewport(cvBox, viewport)) throw new Error(`${spec.label} ${whenLabel}: #cv is not fully inside the viewport: box=${JSON.stringify(cvBox)} viewport=${JSON.stringify(viewport)}`);

          const hudBox = await page.locator('#hud').boundingBox();
          if (!hudBox) throw new Error(`${spec.label} ${whenLabel}: #hud has no bounding box`);
          if (!inViewport(hudBox, viewport)) throw new Error(`${spec.label} ${whenLabel}: #hud is not fully inside the viewport: box=${JSON.stringify(hudBox)} viewport=${JSON.stringify(viewport)}`);
          // The pinned menu/fullscreen buttons are position:fixed at the viewport's top edge while
          // the HUD header row is in-flow (client/style.css): the two only line up when the page
          // is not scrolled, which is exactly what the user saw broken (#46) — buttons floating over
          // the map with the header row itself cut off above them.
          for (const id of ['#hud-menu', '#fs-toggle']) {
            const btn = await page.locator(id).boundingBox();
            if (!btn) continue; // hidden in this mode (e.g. #fs-toggle without Fullscreen API support)
            if (btn.y < hudBox.y - 0.5 || btn.y + btn.height > hudBox.y + hudBox.height + 0.5) {
              throw new Error(`${spec.label} ${whenLabel}: ${id} is not inside the HUD strip vertically: button=${JSON.stringify(btn)} hud=${JSON.stringify(hudBox)}`);
            }
          }
          const portrait = viewport.height >= viewport.width;
          if (portrait && hudBox.height > viewport.height * 0.25 + 0.5) {
            throw new Error(`${spec.label} ${whenLabel}: HUD is taller than 25% of the viewport (hud height=${hudBox.height}, viewport height=${viewport.height})`);
          }

          const logBox = await page.locator('#log').boundingBox();
          if (!logBox) throw new Error(`${spec.label} ${whenLabel}: #log has no bounding box (not visible)`);
          if (!(logBox.height > 0)) throw new Error(`${spec.label} ${whenLabel}: #log has zero height`);
          if (!inViewport(logBox, viewport)) throw new Error(`${spec.label} ${whenLabel}: #log is not fully inside the viewport: box=${JSON.stringify(logBox)}`);

          // Short landscape phones are the one deliberate exception (client/game.js's layoutGame,
          // matching the CSS "@media (orientation: landscape) and (max-height: 500px)" rule /
          // body.gc-controls-overlay class): the d-pad/fire/potion overlay the canvas edges there
          // on purpose, with a translucent backing to stay legible, rather than reserving a band
          // that would leave little room for either. Every other case — portrait, and landscape
          // tall enough to miss that breakpoint (tablets) — must not overlap the canvas. Overlapping
          // the HUD strip is never acceptable in any mode (the HUD sits at the very top; nothing
          // gameplay-related has a reason to reach it).
          const overlayByDesign = viewport.width > viewport.height && viewport.height <= 500;

          // Every *real* control button (#42: not just #touch's own container box) — each d-pad
          // cell (excluding the inert visibility:hidden middle one), fire, potion, and the
          // auto-fire toggle.
          const dpadCells = await page.locator('.input-dpad .input-dir:not(.input-dir-mid)').all();
          if (dpadCells.length !== 8) throw new Error(`${spec.label} ${whenLabel}: expected 8 real d-pad cells, found ${dpadCells.length}`);
          const gameplayControls = [
            ...await Promise.all(dpadCells.map(async (el, i) => ({ name: `d-pad cell ${i}`, box: await el.boundingBox() }))),
            { name: 'fire', box: await page.locator('.input-fire').boundingBox() },
            { name: 'potion', box: await page.locator('.input-potion').boundingBox() },
            { name: 'auto-fire', box: await page.locator('.input-autofire').boundingBox() },
          ];
          for (const { name, box } of gameplayControls) {
            if (!box) throw new Error(`${spec.label} ${whenLabel}: "${name}" has no bounding box (not visible)`);
            if (!inViewport(box, viewport)) throw new Error(`${spec.label} ${whenLabel}: "${name}" is not fully inside the viewport: box=${JSON.stringify(box)} viewport=${JSON.stringify(viewport)}`);
            if (overlaps(box, hudBox)) throw new Error(`${spec.label} ${whenLabel}: "${name}" overlaps the HUD: box=${JSON.stringify(box)} hud=${JSON.stringify(hudBox)}`);
            if (!overlayByDesign && overlaps(box, cvBox)) throw new Error(`${spec.label} ${whenLabel}: "${name}" overlaps the canvas: box=${JSON.stringify(box)} cv=${JSON.stringify(cvBox)}`);
            // Log strip text must never be covered by a control in *any* mode — in the portrait/
            // tablet "band" layout #log sits in its own row above the controls so this is trivially
            // true, but in the short-landscape "overlay" layout (client/style.css's
            // body.gc-controls-overlay) #log floats over the *top* of the canvas specifically so
            // the bottom-anchored d-pad/fire/potion/auto-fire (which do legitimately overlay the
            // canvas itself) can never reach it.
            if (overlaps(box, logBox)) throw new Error(`${spec.label} ${whenLabel}: "${name}" overlaps #log: box=${JSON.stringify(box)} log=${JSON.stringify(logBox)}`);
          }

          // Fullscreen + menu: pinned to the top-right, deliberately over the *header row* of the
          // HUD strip they're visually part of (so no whole-#hud overlap check for these two) —
          // but they must never reach down into the canvas, must stay on-screen, and — landscape
          // specifically, where the header row is short enough for this to have actually happened
          // (a player card's score sat right under the buttons' bottom edge) — must never cover any
          // individual player card either. client/style.css's ".hud-head" gets a min-height tall
          // enough to contain the buttons for exactly this reason; this is the regression check.
          const ppBoxes = await Promise.all((await page.locator('#hud .pp').all()).map((el) => el.boundingBox()));
          for (const sel of ['#fs-toggle', '#hud-menu']) {
            const box = await page.locator(sel).boundingBox();
            if (!box) continue; // #fs-toggle legitimately hides itself when the Fullscreen API is unsupported (client/game.js)
            if (!inViewport(box, viewport)) throw new Error(`${spec.label} ${whenLabel}: "${sel}" is not fully inside the viewport: box=${JSON.stringify(box)}`);
            if (overlaps(box, cvBox)) throw new Error(`${spec.label} ${whenLabel}: "${sel}" overlaps the canvas: box=${JSON.stringify(box)}`);
            if (overlaps(box, logBox)) throw new Error(`${spec.label} ${whenLabel}: "${sel}" overlaps #log: box=${JSON.stringify(box)} log=${JSON.stringify(logBox)}`);
            ppBoxes.forEach((ppBox, i) => {
              if (ppBox && overlaps(box, ppBox)) throw new Error(`${spec.label} ${whenLabel}: "${sel}" overlaps player card ${i}: box=${JSON.stringify(box)} card=${JSON.stringify(ppBox)}`);
            });
          }

          // Portrait/tablet "band" mode only (#42 follow-up review): once the controls band is
          // tall enough to comfortably afford it (>= 380px), client/game.js's layoutTouchControls()
          // should be sizing the d-pad meaningfully large (>= 90px cells), not leaving it small
          // with a big dead zone above it — a regression check for the "cells were ~75px in a
          // ~413px band" bug this review's formula tuning fixed (see DPAD_WIDTH_FRAC's comment).
          if (!overlayByDesign) {
            const touchBox = await page.locator('#touch').boundingBox();
            if (!touchBox) throw new Error(`${spec.label} ${whenLabel}: #touch has no bounding box`);
            if (touchBox.height >= 380) {
              const firstCellBox = dpadCells.length ? await dpadCells[0].boundingBox() : null;
              if (!firstCellBox) throw new Error(`${spec.label} ${whenLabel}: no d-pad cell bounding box to check against the band-height budget`);
              if (firstCellBox.width < 89.5) {
                throw new Error(`${spec.label} ${whenLabel}: controls band is ${touchBox.height}px tall but d-pad cells are only ${firstCellBox.width}px (expected >= 90px)`);
              }
            }
          }
        };

        await assertLayout('before rotate');

        const vp = page.viewportSize();
        await page.setViewportSize({ width: vp.height, height: vp.width }); // simulates a device rotation
        await page.waitForTimeout(300); // let the resize listener re-run layoutGame()
        await assertLayout('after rotate');

        // Regression check (Copilot review on PR #42/#43): layoutGame() must fit the canvas inside
        // #session's *inner content* box (its bounding rect minus its own computed padding), not
        // the raw bounding rect — #session's padding while playing is a real, sometimes nonzero
        // safe-area inset (client/style.css's "env(safe-area-inset-*)"), not decoration, so sizing
        // into the padded-out rect would put the canvas straight into the area a notch/home-
        // indicator/rounded corner actually occupies on a device that reports one. No such device
        // is in this suite's emulated set, so this injects an artificial left/right/bottom padding
        // on #session directly (mirroring the real rule's shape — no top padding) and asserts the
        // canvas stays fully inside what's left after it once layoutGame() re-runs (via a plain
        // "resize" event — the same listener a real viewport/orientation change fires).
        const injectedPad = 30;
        const sessionRectBefore = await page.evaluate(() => document.querySelector('#session').getBoundingClientRect());
        await page.evaluate((pad) => {
          const session = document.querySelector('#session');
          session.style.paddingLeft = `${pad}px`; session.style.paddingRight = `${pad}px`; session.style.paddingBottom = `${pad}px`;
          window.dispatchEvent(new Event('resize'));
        }, injectedPad);
        await page.waitForTimeout(300);
        const cvBoxPadded = await page.locator('#cv').boundingBox();
        if (!cvBoxPadded) throw new Error(`${spec.label}: #cv has no bounding box after injecting #session padding`);
        const innerLeft = sessionRectBefore.x + injectedPad, innerRight = sessionRectBefore.x + sessionRectBefore.width - injectedPad;
        const innerBottom = sessionRectBefore.y + sessionRectBefore.height - injectedPad;
        if (cvBoxPadded.x < innerLeft - 0.5 || cvBoxPadded.x + cvBoxPadded.width > innerRight + 0.5 || cvBoxPadded.y + cvBoxPadded.height > innerBottom + 0.5) {
          throw new Error(`${spec.label}: #cv was not fitted inside #session's padded content box: cv=${JSON.stringify(cvBoxPadded)} innerLeft=${innerLeft} innerRight=${innerRight} innerBottom=${innerBottom}`);
        }
        await page.evaluate(() => {
          const session = document.querySelector('#session');
          session.style.paddingLeft = ''; session.style.paddingRight = ''; session.style.paddingBottom = '';
          window.dispatchEvent(new Event('resize'));
        });

        // Regression check (Copilot review on PR #43): a *bottom* safe-area inset specifically —
        // #session already pads env(safe-area-inset-bottom), and #touch's own band-mode padding /
        // overlay-mode `bottom` offset each add the *same* inset again (client/style.css), which
        // layoutTouchControls() now reads live off #touch's own computed style rather than
        // assuming a fixed 16px/10px (band/overlay) as a JS constant. Simulates a device reporting
        // a 24px inset by setting the *exact* values that inset would resolve each of those three
        // declarations to (mirroring the real calc() shape) and asserts nothing regresses: every
        // control stays on-screen and clear of the HUD/#log/canvas exactly as assertLayout() checks
        // for the un-padded case above.
        const simulatedInset = 24;
        const inOverlay = await page.evaluate(() => document.body.classList.contains('gc-controls-overlay'));
        await page.evaluate(({ inset, overlay }) => {
          const session = document.querySelector('#session');
          const touch = document.querySelector('#touch');
          session.style.paddingBottom = `${inset}px`;
          if (overlay) touch.style.bottom = `${10 + inset}px`; // matches .touch's base "calc(10px + env(safe-area-inset-bottom))"
          else touch.style.paddingBottom = `${16 + inset}px`; // matches the band rule's "calc(16px + env(safe-area-inset-bottom))"
          window.dispatchEvent(new Event('resize'));
        }, { inset: simulatedInset, overlay: inOverlay });
        await page.waitForTimeout(300);
        await assertLayout(`with a simulated ${simulatedInset}px bottom safe-area inset`);
        await page.evaluate(() => {
          const session = document.querySelector('#session');
          const touch = document.querySelector('#touch');
          session.style.paddingBottom = ''; touch.style.bottom = ''; touch.style.paddingBottom = '';
          window.dispatchEvent(new Event('resize'));
        });

        await page.setViewportSize(vp); // back to this device's original (portrait) size before the checks below assume it

        // Fullscreen (#42) requests the whole game container (#session — HUD + canvas + log +
        // controls), never just the canvas: the pre-#42 bug this issue fixes was requesting
        // fullscreen on .cv-wrap, which made everything *but* the canvas vanish. Uses the
        // Element.prototype.requestFullscreen stub installed above rather than the real Fullscreen
        // API, which headless Chromium can silently refuse even for a trusted tap.
        if (await page.locator('#fs-toggle').isVisible()) {
          await page.locator('#fs-toggle').tap();
          const fsCalls = await page.evaluate(() => window.__fsCalls);
          if (fsCalls.at(-1) !== 'session') throw new Error(`${spec.label}: #fs-toggle called requestFullscreen() on "${fsCalls.at(-1)}", expected "session" (#session)`);
        }

        // Best-effort only, short-timeout — see the gameplay scenario's #leave comment above for
        // why: a short landscape phone can leave #leave sitting exactly under the fixed
        // touch-controls band. #leave is reachable through #hud-menu now (#42) rather than always
        // on-screen.
        if (await page.locator('#hud-menu').isVisible().catch(() => false)) await page.locator('#hud-menu').tap().catch(() => {});
        await page.locator('#leave').tap({ timeout: 2000 }).catch(() => {});
      } finally { await ctx.close().catch(() => {}); }
    }

    async function deathModeScenario(spec) {
      const ctx = await browser.newContext({ ...spec.device });
      const page = await ctx.newPage(); attach(page, `death-${spec.label}`, bags);
      let helperWs = null;
      try {
        await page.goto(`${baseUrl}/?touch=1&nosw=1`, { waitUntil: 'load' });
        await page.waitForSelector('#heroes .hero', { timeout: 10_000 });
        await page.locator('#heroes .hero').first().tap();
        await page.fill('#gname', `Death${spec.label.replace(/[^A-Za-z0-9]/g, '').slice(0, 6)}`);
        await page.locator('#create').tap();
        await page.waitForSelector('#roomscreen.on', { timeout: 15_000 });
        await page.selectOption('#rs-mode', 'death');
        await page.waitForSelector('#rs-start:not([disabled])', { timeout: 5_000 }); // solo host, no ready-up needed
        await page.locator('#rs-start').tap();
        await page.waitForSelector('#game.on', { timeout: 15_000 });

        const roomId = new URL(page.url()).searchParams.get('room');
        if (!roomId) throw new Error(`death-${spec.label}: URL did not carry a room id`);

        // Force the run to end right now via the 'endrun' debug hook (server/game/room.js) rather
        // than waiting out a real wipe or grinding to the level cap — see README's Debug hooks.
        helperWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        await once(helperWs, 'open');
        helperWs.send(JSON.stringify({ t: 'join', roomId, name: 'DeathHelper' }));
        await new Promise((r) => setTimeout(r, 300));
        helperWs.send(JSON.stringify({ t: 'debug', action: 'endrun' }));

        await page.waitForSelector('.hs-modal-bg', { timeout: 10_000 }); // a fresh/near-empty board qualifies any score

        // Complete the initials modal by touch: bump the first letter once (A -> B), then confirm.
        await page.locator('.hs-up[data-i="0"]').tap();
        await page.locator('#hs-confirm').tap();
        await page.waitForSelector('.hs-modal-bg', { state: 'detached', timeout: 10_000 });

        const hsRes = await fetch(`${baseUrl}/api/highscores`);
        if (!hsRes.ok) throw new Error(`GET /api/highscores -> HTTP ${hsRes.status}`);
        const { scores } = await hsRes.json();
        if (!scores.some((s) => s.initials === 'BAA')) throw new Error(`expected a "BAA" row on the high-score board, got: ${JSON.stringify(scores)}`);

        // The lobby high-score table lists it too, not just the API.
        await page.goto(`${baseUrl}/?nosw=1`, { waitUntil: 'load' });
        await page.waitForFunction(() => (document.querySelector('#lobby-highscores')?.textContent || '').includes('BAA'), undefined, { timeout: 10_000 });
      } finally {
        try { helperWs?.send(JSON.stringify({ t: 'leave' })); helperWs?.close(); } catch { /* best effort */ }
        await ctx.close().catch(() => {});
      }
    }

    async function heroBuilderScenario(spec) {
      const ctx = await browser.newContext({ ...spec.device });
      const page = await ctx.newPage(); attach(page, `hero-${spec.label}`, bags);
      // Diagnostics (#40): every POST/PUT /api/heroes response this page gets, method+status+body,
      // so a save failure's thrown error can name the actual validateHero rule that fired instead
      // of just "waitForFunction timed out".
      const heroResponses = [];
      page.on('response', (resp) => {
        const req = resp.request();
        if (!/^\/api\/heroes(\/|$)/.test(new URL(resp.url()).pathname)) return;
        if (req.method() !== 'POST' && req.method() !== 'PUT') return;
        resp.text().then((body) => heroResponses.push(`${req.method()} ${resp.url()} -> ${resp.status()} ${body}`)).catch(() => {});
      });
      try {
        await loginAs(page, heroToken, '/heroes.html');
        await waitForHbReady(page);
        if (!(await page.locator('#builder').isVisible())) throw new Error(`hero-${spec.label}: Hero Builder is locked/hidden for this account (not rank 3+?)`);

        const heroName = `Mob${spec.label.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`; // NAME_RE: 2-12 letters/digits/spaces
        await page.fill('#hname', heroName);

        await page.locator('#pcv').scrollIntoViewIfNeeded();
        const pcvBox = await page.locator('#pcv').boundingBox();
        if (!pcvBox) throw new Error(`hero-${spec.label}: #pcv has no bounding box`);
        // Touch-drag painting: same fast-drag (one big jump, no intermediate pointermoves) case
        // paintPath() exists for, and the same mouse-simulated-hold precedent as the d-pad above —
        // Playwright's touchscreen API has no drag primitive, and pcv's pointerdown/pointermove
        // listeners don't discriminate by pointerType.
        const cell = (cx, cy) => ({ x: pcvBox.x + (cx + 0.5) * (pcvBox.width / 8), y: pcvBox.y + (cy + 0.5) * (pcvBox.height / 8) });
        const from = cell(0, 4), to = cell(7, 4); // a full row: 8 pixels, exactly validateHero's "paint at least 8" floor
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y);
        await page.mouse.up();

        const pixels = await page.evaluate(() => window.__hb.pixels());
        const painted = pixels.reduce((n, row) => n + [...row].filter((c) => c !== '.').length, 0);
        if (painted < 8) throw new Error(`hero-${spec.label}: touch-drag only painted ${painted} pixel(s), expected >= 8`);

        await page.locator('#save-btn').tap();
        try {
          await page.waitForFunction(() => (document.querySelector('#save-status')?.textContent || '') === 'Saved.', undefined, { timeout: 10_000 });
        } catch (waitErr) {
          const status = await page.locator('#save-status').textContent().catch(() => '<unreadable>');
          const responses = heroResponses.length ? heroResponses.join(' | ') : '<no /api/heroes POST/PUT response captured>';
          throw new Error(`hero-${spec.label}: save did not complete — #save-status="${status}"; ${responses}`);
        }

        await loginAs(page, heroToken, '/');
        await page.waitForSelector('#heroes .hero', { timeout: 10_000 });
        await page.locator('#hero-tabs [data-tab="custom"]').tap();
        await page.waitForSelector('#heroes-custom .hero', { timeout: 10_000 });
        const customText = await page.locator('#heroes-custom').textContent();
        if (!customText.includes(heroName)) throw new Error(`hero-${spec.label}: saved hero "${heroName}" did not appear in the lobby Custom tab`);
      } finally { await ctx.close().catch(() => {}); }
    }

    async function levelBuilderScenario(spec) {
      const ctx = await browser.newContext({ ...spec.device });
      const page = await ctx.newPage(); attach(page, `level-${spec.label}`, bags);
      try {
        await loginAs(page, levelToken, '/editor.html');
        await page.waitForSelector('#ecv', { timeout: 10_000 });
        await page.locator('#pal button[data-c="F"]').tap(); // brush: food — visually distinct from floor/wall

        await page.locator('#ecv').scrollIntoViewIfNeeded();
        const ecvBox = await page.locator('#ecv').boundingBox();
        if (!ecvBox) throw new Error(`level-${spec.label}: #ecv has no bounding box`);
        const EW = 32, EH = 24; // client/editor.js's ED.w/h default
        const cell = (cx, cy) => ({ x: ecvBox.x + (cx + 0.5) * (ecvBox.width / EW), y: ecvBox.y + (cy + 0.5) * (ecvBox.height / EH) });
        const from = cell(3, 10), to = cell(28, 10);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y); // one big jump — same sparse-pointermove case paintPath() exists for
        await page.mouse.up();

        const grid = await page.evaluate(() => window.__ed.grid());
        for (let x = 3; x <= 28; x++) {
          if (grid[10][x] !== 'F') throw new Error(`level-${spec.label}: touch-drag left a gap at column ${x} (row 10)`);
        }

        const levelName = `MobLvl${spec.label.replace(/[^A-Za-z0-9]/g, '').slice(0, 6)}`;
        await page.fill('#name', levelName);
        await page.locator('#save').tap();
        await page.waitForFunction(() => document.querySelector('#publish') && !document.querySelector('#publish').disabled, undefined, { timeout: 10_000 });
        await page.locator('#publish').tap();
        await page.waitForFunction(() => document.querySelector('#publish')?.textContent.trim() === 'Unpublish', undefined, { timeout: 10_000 });

        const pubText = await page.locator('#pub').textContent();
        if (!pubText.includes(levelName)) throw new Error(`level-${spec.label}: published level "${levelName}" did not appear in the community browse list`);
      } finally { await ctx.close().catch(() => {}); }
    }

    async function settingsScenario(spec) {
      const ctx = await browser.newContext({ ...spec.device });
      const page = await ctx.newPage(); attach(page, `settings-${spec.label}`, bags);
      try {
        await loginAs(page, settingsToken, '/settings.html');
        await page.waitForSelector('#mine', { timeout: 10_000 });
        if (!(await page.locator('#mine').isVisible())) throw new Error(`settings-${spec.label}: #mine panel not visible for a logged-in user`);

        const cutscenesBefore = await page.locator('#p-cutscenes').isChecked();
        await page.locator('#p-cutscenes').tap();
        const cutscenesAfterTap = await page.locator('#p-cutscenes').isChecked();
        if (cutscenesAfterTap === cutscenesBefore) throw new Error(`settings-${spec.label}: tapping #p-cutscenes did not toggle it`);

        // Move a slider by touch: a tap on a native <input type=range> track snaps its value to
        // that position (standard browser behaviour, not app JS) — a real touch drag lands on the
        // same code path since range inputs respond to any pointer position, not a specific
        // pointerType.
        const sliderBox = await page.locator('#p-voice-volume').boundingBox();
        if (!sliderBox) throw new Error(`settings-${spec.label}: #p-voice-volume has no bounding box`);
        await page.touchscreen.tap(sliderBox.x + sliderBox.width * 0.3, sliderBox.y + sliderBox.height / 2);
        const volumeAfterTap = await page.locator('#p-voice-volume').inputValue();

        await page.locator('#save-prefs').tap();
        await page.waitForFunction(() => (document.querySelector('#prefs-msg')?.textContent || '') === 'Saved.', undefined, { timeout: 10_000 });

        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('#mine', { timeout: 10_000 });
        const cutscenesAfterReload = await page.locator('#p-cutscenes').isChecked();
        if (cutscenesAfterReload !== cutscenesAfterTap) throw new Error(`settings-${spec.label}: #p-cutscenes did not persist across reload (expected ${cutscenesAfterTap}, got ${cutscenesAfterReload})`);
        const volumeAfterReload = await page.locator('#p-voice-volume').inputValue();
        if (volumeAfterReload !== volumeAfterTap) throw new Error(`settings-${spec.label}: #p-voice-volume did not persist across reload (expected ${volumeAfterTap}, got ${volumeAfterReload})`);
      } finally { await ctx.close().catch(() => {}); }
    }

    async function pwaScenario(spec) {
      // Deliberately no ?nosw=1: this is the one page load per device that actually exercises
      // client/pwa.js registering client/sw.js for real (same as test/e2e.mjs's PWA scenario).
      const ctx = await browser.newContext({ ...spec.device });
      let offline = false;
      // Precached shell assets (HTML/CSS/JS/manifest/icons — see client/sw-rules.js) load fine
      // offline; /api/* is deliberately network-only (never cached), so the lobby's own background
      // calls (rooms, high scores, `me`, a telemetry beacon) are *expected* to fail for the
      // duration of this scenario's offline window — that's the network-only routing working
      // correctly, not a bug, so it's excluded from the shared failed-request bag.
      const page = await ctx.newPage();
      attach(
        page, `pwa-${spec.label}`, bags,
        (req) => offline && new URL(req.url()).pathname.startsWith('/api/'),
        (text) => offline && /ERR_INTERNET_DISCONNECTED/.test(text),
      );
      try {
        await page.goto(`${baseUrl}/`, { waitUntil: 'load' });

        // The server stamps ?v=<ASSET_VERSION> onto this href (#38); require it, so a regression in
        // the HTML fingerprinting shows up here rather than as stale assets after a deploy.
        const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
        if (!/^\/manifest\.webmanifest\?v=[0-9a-f]{12}$/.test(manifestHref)) throw new Error(`pwa-${spec.label}: expected the manifest link, got href="${manifestHref}"`);

        const reg = await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return registration ? { scope: registration.scope } : null;
        });
        if (!reg) throw new Error(`pwa-${spec.label}: navigator.serviceWorker.getRegistration() resolved to nothing after load`);

        await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 15_000 });

        offline = true;
        await ctx.setOffline(true);
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('#heroes .hero', { timeout: 10_000 });
        await ctx.setOffline(false);
        offline = false;
      } finally { await ctx.close().catch(() => {}); }
    }

    /** Regression check (Copilot review on PR #43): opening #hud-menu, resizing wide enough to
     *  cross into layoutGame()'s desktop ("!mobile") branch, then narrow again, must not leave the
     *  Leave/chat panel (.bar) open from a tap that happened a whole viewport ago — that branch has
     *  to reset "gc-menu-open"/aria-expanded, not just hide the button. Deliberately *not* run
     *  against any of DEVICE_SPECS (all `hasTouch: true`, under which `matchMedia('(pointer:
     *  coarse)')` keeps `mobile` true regardless of viewport width — resizing alone could never
     *  cross that branch there) — a plain, resizable, no-touch context with `?touch=1` forcing the
     *  touch UI to render is what actually lets width alone drive `mobile` true/false. */
    async function menuResetScenario() {
      const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } });
      const page = await ctx.newPage(); attach(page, 'menu-reset', bags);
      try {
        await page.goto(`${baseUrl}/?touch=1&nosw=1`, { waitUntil: 'load' });
        await page.waitForSelector('#heroes .hero', { timeout: 10_000 });
        await page.click('#heroes .hero:nth-child(1)');
        await page.fill('#gname', 'MenuResetTester');
        await page.click('#create');
        await page.waitForSelector('#roomscreen.on', { timeout: 15_000 });
        await page.waitForSelector('#rs-start:not([disabled])', { timeout: 5_000 });
        await page.click('#rs-start');
        await page.waitForSelector('#game.on', { timeout: 15_000 });
        await page.waitForFunction(() => document.querySelectorAll('#hud .pp').length > 0, undefined, { timeout: 10_000 });
        await page.waitForTimeout(200);

        if (!(await page.locator('#hud-menu').isVisible())) throw new Error('menu-reset: #hud-menu should be visible at a 375px-wide mobile viewport');
        await page.click('#hud-menu');
        if (!(await page.locator('.bar').isVisible())) throw new Error('menu-reset: .bar did not open after clicking #hud-menu');
        if ((await page.getAttribute('#hud-menu', 'aria-expanded')) !== 'true') throw new Error('menu-reset: #hud-menu should report aria-expanded="true" once opened');

        await page.setViewportSize({ width: 1024, height: 800 }); // desktop-width, fine pointer — crosses layoutGame()'s "!mobile" branch
        await page.waitForTimeout(300);
        if (await page.locator('#hud-menu').isVisible()) throw new Error('menu-reset: #hud-menu should hide at a 1024px-wide viewport');

        await page.setViewportSize({ width: 375, height: 667 }); // back to mobile width, without ever clicking #hud-menu again
        await page.waitForTimeout(300);
        if (await page.locator('.bar').isVisible()) throw new Error('menu-reset: .bar reappeared after a desktop-width round-trip without clicking #hud-menu again (stale "gc-menu-open")');
        if ((await page.getAttribute('#hud-menu', 'aria-expanded')) !== 'false') throw new Error('menu-reset: #hud-menu should report aria-expanded="false" after the desktop-width round-trip');
      } finally { await ctx.close().catch(() => {}); }
    }

    // ---------------- run every scenario across all three devices ----------------
    let n = 1;
    for (const spec of DEVICE_SPECS) {
      await scenario(`${n++}. Lobby: no horizontal overflow, hero picker + high scores visible, nav toggle — ${spec.label}`, () => lobbyScenario(spec));
    }
    for (const spec of DEVICE_SPECS) {
      await scenario(`${n++}. Register via touch, solo run, d-pad move + fire + auto-fire persists — ${spec.label}`, () => gameplayScenario(spec));
    }
    for (const spec of DEVICE_SPECS) {
      if (!PHONE_LABELS.has(spec.label)) continue;
      await scenario(`${n++}. Landscape gameplay rerun — ${spec.label}`, () => gameplayScenario(spec, { landscape: true }));
    }
    for (const spec of DEVICE_SPECS) {
      await scenario(`${n++}. Canvas geometry: fully in viewport, d-pad clear of canvas/HUD, survives a rotate mid-run — ${spec.label}`, () => geometryScenario(spec));
    }
    for (const spec of DEVICE_SPECS) {
      await scenario(`${n++}. Death mode: 'endrun' debug hook ends the run, initials modal completed by touch, lobby high scores list it — ${spec.label}`, () => deathModeScenario(spec));
    }
    for (const spec of DEVICE_SPECS) {
      await scenario(`${n++}. Hero Builder: touch-drag paints pixels, save, appears in the lobby Custom tab — ${spec.label}`, () => heroBuilderScenario(spec));
    }
    for (const spec of DEVICE_SPECS) {
      await scenario(`${n++}. Level Builder: touch-drag paints tiles, save + publish, shows in the browse list — ${spec.label}`, () => levelBuilderScenario(spec));
    }
    for (const spec of DEVICE_SPECS) {
      await scenario(`${n++}. Settings: toggle + slider by touch persist across reload — ${spec.label}`, () => settingsScenario(spec));
    }
    for (const spec of DEVICE_SPECS) {
      await scenario(`${n++}. PWA: manifest + service worker registration, offline lobby reload — ${spec.label}`, () => pwaScenario(spec));
    }
    await scenario(`${n++}. #hud-menu's open state resets across a desktop-width round-trip (no stale "gc-menu-open")`, () => menuResetScenario());
  } catch (err) {
    overallFailed = true;
    console.error('[e2e-mobile] harness-level failure:', (err && err.stack) || err);
    if (output()) console.error('[e2e-mobile] server output so far:\n' + output());
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopGameServer({ server, serverExit });
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  const failedScenarios = results.filter((r) => !r.ok);
  if (failedScenarios.length) overallFailed = true;
  if (bags.pageErrors.length || bags.consoleErrors.length || bags.failedRequests.length) overallFailed = true;

  log('---- summary ----');
  for (const r of results) log(`${r.ok ? 'PASS' : 'FAIL'}: ${r.name}`);
  if (knownBugs.length) {
    log(`${knownBugs.length} known bug(s) flagged (see KNOWN BUG lines above):`);
    for (const b of knownBugs) log(`  - ${b.name}: ${b.detail}`);
  }
  if (bags.pageErrors.length) { log(`${bags.pageErrors.length} browser page error(s):`); for (const e of bags.pageErrors) log('  ' + e); }
  if (bags.consoleErrors.length) { log(`${bags.consoleErrors.length} browser console error(s):`); for (const e of bags.consoleErrors) log('  ' + e); }
  if (bags.failedRequests.length) { log(`${bags.failedRequests.length} failed/5xx request(s):`); for (const e of bags.failedRequests) log('  ' + e); }
  if (output().trim()) log('server output:\n' + output());

  log(overallFailed ? 'E2E-MOBILE FAILED' : 'E2E-MOBILE PASS: all scenarios green across every device, no page/console errors, no failed requests');
  process.exit(overallFailed ? 1 : 0);
}

main();
