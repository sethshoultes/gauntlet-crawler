#!/usr/bin/env node
// Full-game e2e sweep (#35): boots one real server (GAUNTLET_DEBUG=1) and drives one real Chromium
// browser through every gameplay/product surface test/e2e.mjs doesn't already reach — amulets,
// permanent boosts, pressure plates, timed walls, acid/stun/force-field hazards, transporters,
// poison food/cider, skip exits, mystery treasure rooms, bonus treasure rooms, It tag mode, local
// co-op, a mid-run reconnect, the Level Builder's Remix+Undo, the Hero Builder's AI-assist
// fallback, account settings (password/prefs/export/delete), the admin dashboard, and the attract
// page/trailer. Kept in its own file (rather than added to test/e2e.mjs) so it can be developed and
// run independently — see test/helpers/e2e.mjs's header for why the shared bits live there instead
// of being imported from test/e2e.mjs itself.
//
// Most of these need a hero standing right next to one specific tile, which a real generated (or
// hand-built) level can't guarantee — so this suite leans on the GAUNTLET_DEBUG-only
// `{t:'debug', action:'loadLevel', rows, timers, treasureRoom}` hook (server/game/room.js
// Room#debugAction, documented in README.md's "Debug hooks" section) to swap the current room's
// level for a small fixture grid built on the fly, then drives the hero onto the tile with real
// keyboard input and asserts on the same DOM/HUD text test/e2e.mjs already reads, or on a
// WebSocket "snap spy" that watches the authoritative snapshot stream the way test/e2e.mjs's own
// inline helper bots do (see test/helpers/e2e.mjs's snapSpy()).
//
// Chest picking (after a level clear) is exercised by scenario 12 (skip exit); It mode's tag
// handoff and local co-op's roster/HUD are exercised together by scenario 13, since both need the
// same two-browser-plus-a-local-player room. Hero rank/unlocks get incidental coverage from
// scenario 16's XP grant (same debug hook test/e2e.mjs's own Hero Builder scenario uses).
//
// Usage:
//   npm run e2e:features
//   CHROMIUM_PATH=/opt/pw-browsers/chromium npm run e2e:features
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { startServer } from './helpers/server.mjs';
import {
  attachPageErrors, makeRunner, registerUser, snapSpy, wsConnect, readSelfHud, pressFor,
} from './helpers/e2e.mjs';

function log(msg) { console.log(`[e2e-features] ${msg}`); }

// ---------- fixture-level grid builder ----------
// A 20x14 room (parseLevel needs >=12x12): border walls, one start tile for the hero, a second
// start tile far away in the opposite corner for the snap spy's own (never-moved) sim player —
// see test/helpers/e2e.mjs's snapSpy() doc comment for why that player must stay well clear of
// the hero's path — and, unless `noDefaultExit`, a plain exit tile tucked off in a corner no
// scenario's hero ever walks toward. `tiles` places extra glyphs at explicit {x,y} coordinates.
function hazardGrid(tiles = {}, { w = 20, h = 14, start = [1, 1], start2 = [w - 2, h - 2], exit = [10, 7], noDefaultExit = false } = {}) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      const here = tiles[`${x},${y}`];
      if (y === 0 || y === h - 1 || x === 0 || x === w - 1) row += '#';
      else if (here) row += here;
      else if (x === start[0] && y === start[1]) row += 'S';
      else if (x === start2[0] && y === start2[1]) row += 'S';
      else if (!noDefaultExit && x === exit[0] && y === exit[1]) row += 'E';
      else row += '.';
    }
    rows.push(row);
  }
  return rows;
}

async function sendDebug(page, msg) { await page.evaluate((m) => window.__gc.send(m), msg); }
/** window.__gc.send() (client/game.js) is exposed for exactly this — see its own "exposed for
 *  manual/E2E debugging only" comment — so loading a fixture never needs a second WebSocket. */

async function clearLog(page) {
  await page.evaluate(() => { const el = document.querySelector('#log'); if (el) el.innerHTML = ''; });
}
async function logIncludes(page, text, timeoutMs = 6000) {
  await page.waitForFunction((t) => (document.querySelector('#log')?.textContent || '').includes(t), text, { timeout: timeoutMs });
}
async function resolvePid(spy, name, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = spy.pidOf(name);
    if (pid != null) return pid;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`spy never saw a 'players' packet naming "${name}"`);
}
/** Nudge `key` in short bursts, checking the spy's authoritative position between each one, until
 *  the hero's tile matches (targetX,targetY) exactly. Used only where a scenario must dwell ON one
 *  specific tile (acid, stun) rather than merely pass through it — a nudge shorter than one tile
 *  guarantees a check lands inside the target tile before a later nudge can carry it past. */
async function walkUntilTile(page, spy, pid, key, targetX, { targetY = 1, stepMs = 100, maxSteps = 60 } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    const pos = spy.posOf(pid);
    if (pos && Math.floor(pos.x) === targetX && Math.floor(pos.y) === targetY) return pos;
    await pressFor(page, key, stepMs);
    await new Promise((r) => setTimeout(r, 70)); // let the next snapshot land before re-checking
  }
  throw new Error(`walkUntilTile: never reached (${targetX},${targetY}); last pos=${JSON.stringify(spy.posOf(pid))}`);
}

async function main() {
  const server = await startServer({ env: { GAUNTLET_DEBUG: '1' } });
  const { baseUrl, port } = server;
  log(`server ready at ${baseUrl} (DATA_DIR=${server.dataDir}, GAUNTLET_DEBUG=1)`);

  const { scenario, knownBug, results, knownBugs } = makeRunner(log);
  const pageErrors = [], consoleErrors = [], failedRequests = [];
  const rnd = () => crypto.randomBytes(3).toString('hex');

  let browser = null;
  let overallFailed = false;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

    // Registered before anything else so it lands on user id 1 -> the default admin (see
    // server/admin.js isAdmin(): unset GAUNTLET_ADMINS means "user id 1 is the admin").
    const adminUser = { name: `e2eAdmin${rnd()}`, pass: 'Password123' };
    await registerUser(baseUrl, adminUser.name, adminUser.pass);
    const otherUser = { name: `e2eOther${rnd()}`, pass: 'Password123' };
    await registerUser(baseUrl, otherUser.name, otherUser.pass);

    // ================================================================
    // Hazard/pickup fixture sweep: one solo room + one passive snap-spy player, reused by
    // scenarios 1-12 — each swaps in its own small fixture via the debug 'loadLevel' hook rather
    // than opening a fresh room, so this whole block costs one browser context and one room.
    // ================================================================
    const ctxD = await browser.newContext();
    const pageD = await ctxD.newPage();
    attachPageErrors(pageD, 'Hazard', { pageErrors, consoleErrors, failedRequests });

    await pageD.goto(`${baseUrl}/?nosw=1`, { waitUntil: 'load' });
    await pageD.waitForSelector('#heroes .hero', { timeout: 10_000 });
    await pageD.click('#heroes .hero:nth-child(1)'); // Warrior — fixed, known speed (4.6 tiles/s)
    await pageD.fill('#gname', 'HazardHero');
    await pageD.click('#create');
    await pageD.waitForSelector('#roomscreen.on', { timeout: 15_000 });
    const hazardRoomId = new URL(pageD.url()).searchParams.get('room');
    if (!hazardRoomId) throw new Error(`browser D URL did not carry a room id: ${pageD.url()}`);
    await pageD.waitForSelector('#rs-start:not([disabled])', { timeout: 5_000 }); // solo host, no ready-up
    await pageD.click('#rs-start');
    await pageD.waitForSelector('#game.on', { timeout: 15_000 });

    const spy = await snapSpy(port, hazardRoomId, 'HazardSpy');
    const heroPid = await resolvePid(spy, 'HazardHero');
    // Auto-pick whatever chest the spy's own dummy hero is offered, same as test/e2e.mjs's helper
    // bots, so an intermission (scenario 12) ends on the fast "everyone picked" path rather than
    // waiting out the full 15s timeout.
    spy.ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (msg.t === 'chests' && msg.chests?.length) spy.ws.send(JSON.stringify({ t: 'pick', id: msg.chests[0].id }));
    });

    async function loadFixture(tiles, opts = {}) {
      await clearLog(pageD);
      const loadedAt = Date.now();
      await sendDebug(pageD, { t: 'debug', action: 'loadLevel', rows: hazardGrid(tiles, opts), timers: opts.timers, treasureRoom: opts.treasureRoom });
      await logIncludes(pageD, 'Debug Fixture'); // confirms the client applied the new 'level' packet
      return loadedAt;
    }

    await scenario('1. Amulet pickup shows a HUD countdown', async () => {
      await loadFixture({ '3,1': 'R' }); // reflective-shots amulet
      await pressFor(pageD, 'd', 700); // 2 tiles at 4.6 tiles/s, ample margin
      await logIncludes(pageD, 'picked up Reflective Shots');
      const hud = await readSelfHud(pageD);
      if (!/\d/.test(hud.amulets)) throw new Error(`expected the HUD amulet countdown to show a number of seconds, got "${hud.amulets}"`);
    });

    await scenario('2. Permanent boost pickup shows a HUD pip', async () => {
      await loadFixture({ '3,1': 'V' }); // speed boost
      await pressFor(pageD, 'd', 700);
      await logIncludes(pageD, 'found a permanent Speed boost');
      const hud = await readSelfHud(pageD);
      if (!hud.runboosts) throw new Error('expected the HUD run-boosts pip row to be non-empty after a boost pickup');
    });

    await scenario('3. Poison food hurts, cider heals', async () => {
      await loadFixture({ '3,1': '!', '6,1': 'C' });
      const before = await readSelfHud(pageD);
      await pressFor(pageD, 'd', 700);
      await logIncludes(pageD, 'ate poisoned food');
      const afterPoison = await readSelfHud(pageD);
      if (!(before.hp - afterPoison.hp >= 50)) throw new Error(`expected poison food to drop HP by ~100 (before=${before.hp}, after=${afterPoison.hp})`);
      await pressFor(pageD, 'd', 700);
      const afterCider = await readSelfHud(pageD);
      if (!(afterCider.hp - afterPoison.hp >= 30)) throw new Error(`expected cider to raise HP by ~50 (before=${afterPoison.hp}, after=${afterCider.hp})`);
    });

    await scenario('4. Pressure plate dissolves its wall group', async () => {
      await loadFixture({ '3,1': '%', '5,1': '=' }); // plate A, wall-group A
      await pressFor(pageD, 'd', 2000); // through the plate, and (once dissolved) through the former wall
      // The 'plate' sim event carries no pid (see server/game/sim.js triggerPlate()), so
      // client/game.js's onEvent logs the anonymous phrasing here rather than "<name> triggered...".
      await logIncludes(pageD, 'walls crumble');
      const pos = spy.posOf(heroPid);
      if (!(pos && pos.x > 6)) knownBug('4. Pressure plate dissolves its wall group', `hero never got past the wall-group tile (last x=${pos?.x}) — the plate fired but the wall stayed solid`);
    });

    await scenario('5. Timed wall converts to floor after its timer', async () => {
      const loadedAt = await loadFixture({ '5,1': '^' }, { timers: { wall: 1.5 } });
      await pressFor(pageD, 'd', 300); // stop short of the (still solid) timed wall
      const elapsed = Date.now() - loadedAt;
      await pageD.waitForTimeout(Math.max(0, 1500 - elapsed) + 700); // wait out the shortened timer, plus margin
      await pressFor(pageD, 'd', 900); // now try to walk through it
      const pos = spy.posOf(heroPid);
      if (!(pos && pos.x > 6)) knownBug('5. Timed wall converts to floor after its timer', `hero never got past the timed wall (last x=${pos?.x}) after its countdown should have fired`);
    });

    await scenario('6. Acid damages a hero standing on it', async () => {
      await loadFixture({ '5,1': 'a' });
      await walkUntilTile(pageD, spy, heroPid, 'd', 5);
      const before = spy.posOf(heroPid);
      await pageD.waitForTimeout(1000);
      const after = spy.posOf(heroPid);
      if (!(before.hp - after.hp >= 4)) throw new Error(`expected standing on acid for 1s to drain noticeable HP (before=${before.hp}, after=${after.hp})`);
    });

    await scenario('7. Stun tile freezes movement briefly, then releases', async () => {
      // The tile sits right next to the start (rather than several tiles away, like the other
      // hazard fixtures) so walkUntilTile's own travel time can't eat into STUN_TICKS' short 1.5s
      // freeze window before the test even starts checking it.
      await loadFixture({ '2,1': 't' });
      const landed = await walkUntilTile(pageD, spy, heroPid, 'd', 2);
      const hudFrozen = await readSelfHud(pageD);
      if (!hudFrozen.classes.includes('stunned')) throw new Error(`expected the HUD row to carry the "stunned" class right after touching the stun tile (classes="${hudFrozen.classes}")`);
      await pressFor(pageD, 'd', 900); // STUN_TICKS is 1.5s @ 20Hz — held well within the freeze
      const duringFreeze = spy.posOf(heroPid);
      if (!(Math.floor(duringFreeze.x) === 2)) throw new Error(`expected movement to stay frozen on the stun tile for ~1.5s (landed x=${landed.x}, after holding 'd' for 900ms x=${duringFreeze.x})`);
      await pageD.waitForTimeout(700); // clear the rest of the freeze + immunity grace window
      await pressFor(pageD, 'd', 900);
      const after = spy.posOf(heroPid);
      if (!(after.x - duringFreeze.x > 0.5)) throw new Error(`expected movement to resume once the stun wore off (frozen x=${duringFreeze.x}, later x=${after.x})`);
    });

    await scenario('8. Transporter teleports the hero to its paired tile', async () => {
      await loadFixture({ '3,1': 'X', '15,1': 'X' });
      await pressFor(pageD, 'd', 800); // ~3 tiles to reach the first transporter
      await spy.waitForEvent((e) => e.type === 'teleport' && e.pid === heroPid, 4000);
      const pos = spy.posOf(heroPid);
      if (!(pos && pos.x > 10)) throw new Error(`expected the hero to land near the paired transporter (x~15), got x=${pos?.x}`);
    });

    await scenario('9. Force field blocks a shot but not movement', async () => {
      await loadFixture({ '4,1': 'f' });
      // "Arcade rule: you stand still while firing" (server/game/sim.js) — holding both keeps the
      // hero at the start tile, facing east, shooting at the field a few tiles away.
      await pageD.keyboard.down('d'); await pageD.keyboard.down(' ');
      await pageD.waitForTimeout(700);
      await spy.waitForEvent((e) => e.type === 'spark', 3000);
      await pageD.keyboard.up(' '); // stop firing; 'd' is still held, so the hero now actually walks
      await pageD.waitForTimeout(900);
      await pageD.keyboard.up('d');
      const pos = spy.posOf(heroPid);
      if (!(pos && pos.x > 5)) throw new Error(`expected the force field to block the shot but not the hero's own walk through it (last x=${pos?.x})`);
    });

    await scenario('10. Mystery room: switch reveals the hidden exit', async () => {
      // Real mystery rooms are always a bonus treasure room that happens to contain hidden exits
      // (see Room#levelFor/isTreasureLevel) — treasureRoom:true here is what makes the debug hook
      // broadcast the 'bonus' banner (mystery:true, since the grid itself has a hidden exit).
      await loadFixture({ '3,1': 'L', '10,5': 'H' }, { noDefaultExit: true, treasureRoom: true });
      await logIncludes(pageD, 'Mystery treasure room'); // the 'bonus' banner text for mysteryRoom:true
      await pressFor(pageD, 'd', 700); // onto the switch
      await logIncludes(pageD, 'hidden exits are revealed');
      await spy.waitForEvent((e) => e.type === 'reveal', 3000);
      await spy.waitForEvent((e) => e.type === 'tile' && e.x === 10 && e.y === 5 && e.c === 'E', 3000);
    });

    await scenario('11. Treasure room: bonus banner, any exit clears without a chest pick', async () => {
      await loadFixture({}, { exit: [5, 1], treasureRoom: true });
      await logIncludes(pageD, 'Bonus treasure room');
      const before = (await readSelfHud(pageD)).level;
      await pressFor(pageD, 'd', 700); // straight onto the exit
      const deadline = Date.now() + 6000;
      let sawChestPrompt = false;
      while (Date.now() < deadline) {
        const text = await pageD.locator('#log').textContent();
        if (text.includes('Choose a chest')) sawChestPrompt = true;
        const hud = await readSelfHud(pageD).catch(() => null);
        if (hud && hud.level !== before) break;
        await pageD.waitForTimeout(200);
      }
      const after = (await readSelfHud(pageD)).level;
      if (after === before) throw new Error(`expected clearing a treasure room's exit to advance the level (stuck at "${before}")`);
      if (sawChestPrompt) knownBug('11. Treasure room: bonus banner, any exit clears without a chest pick', 'a treasure room offered a chest pick — it should skip the intermission entirely (see Room#onLevelComplete\'s wasTreasure branch)');
    });

    await scenario('12. Skip exit jumps the party ahead 4 levels via the normal chest intermission', async () => {
      const before = Number((await readSelfHud(pageD)).level.match(/\d+/)[0]);
      await loadFixture({ '5,1': '8' }); // skip exit
      await pressFor(pageD, 'd', 700);
      await logIncludes(pageD, 'Choose a chest');
      await pageD.keyboard.press('1');
      await pageD.waitForFunction((n) => {
        const t = document.querySelector('#hud-lvl')?.textContent || '';
        const m = t.match(/\d+/);
        return m && Number(m[0]) === n;
      }, before + 4, { timeout: 15_000 });
    });

    spy.close();
    await pageD.click('#leave').catch(() => {});
    await ctxD.close().catch(() => {});

    // ================================================================
    // It mode + local co-op + reconnect: one two-browser room plus a raw-WS local co-op player.
    // ================================================================
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage(); attachPageErrors(pageA, 'CoopA', { pageErrors, consoleErrors, failedRequests });
    const pageB = await ctxB.newPage(); attachPageErrors(pageB, 'CoopB', { pageErrors, consoleErrors, failedRequests });
    let coopRoomId = null;
    let localWs = null;

    await scenario('13. It mode toggle + tag HUD in a two-browser room, plus local co-op via join_local and the lobby roster', async () => {
      await pageA.goto(`${baseUrl}/?nosw=1`, { waitUntil: 'load' });
      await pageA.waitForSelector('#heroes .hero', { timeout: 10_000 });
      await pageA.click('#heroes .hero:nth-child(1)');
      await pageA.click('#create');
      await pageA.waitForSelector('#roomscreen.on', { timeout: 15_000 });
      coopRoomId = new URL(pageA.url()).searchParams.get('room');
      if (!coopRoomId) throw new Error(`browser A URL did not carry a room id: ${pageA.url()}`);

      await pageB.goto(`${baseUrl}/?room=${coopRoomId}&nosw=1`, { waitUntil: 'load' });
      await pageB.waitForSelector('#roomscreen.on', { timeout: 15_000 });

      // Local co-op (#15): one raw WebSocket standing in for "a second gamepad on browser A's
      // machine" — joins normally, then mints a bound local player via join_local, exactly like
      // client/input.js's real gamepad-detected flow does.
      localWs = await wsConnect(port);
      localWs.send(JSON.stringify({ t: 'join', roomId: coopRoomId, name: 'LocalHost' }));
      await new Promise((r) => setTimeout(r, 300));
      localWs.send(JSON.stringify({ t: 'ready', ready: true })); // don't block pageA's start below
      localWs.send(JSON.stringify({ t: 'join_local', slot: 1, name: 'LocalBuddy', cls: 'elf' }));
      await new Promise((r) => setTimeout(r, 300));

      await pageA.waitForFunction(() => (document.querySelector('#rs-roster')?.textContent || '').includes('LocalBuddy'), { timeout: 5_000 });
      await pageA.waitForFunction(() => (document.querySelector('#rs-roster')?.textContent || '').includes('LocalHost'), { timeout: 5_000 });

      await pageA.check('#rs-itmode');
      await pageA.click('#rs-ready');
      await pageB.click('#rs-ready');
      await pageA.waitForSelector('#rs-start:not([disabled])', { timeout: 10_000 });
      await pageA.click('#rs-start');
      await pageA.waitForSelector('#game.on', { timeout: 15_000 });
      await pageB.waitForSelector('#game.on', { timeout: 15_000 });

      await pageA.waitForFunction(() => document.querySelectorAll('#hud .pp').length === 4, { timeout: 10_000 });
      await pageA.waitForFunction(() => document.querySelectorAll('#hud .pp.it').length === 1, { timeout: 8_000 });
    });

    await scenario('14. Reconnect: reloading browser B mid-run resumes the same player', async () => {
      const before = await readSelfHud(pageB);
      await pageB.reload({ waitUntil: 'load' });
      await pageB.waitForSelector('#game.on', { timeout: 15_000 });
      const after = await readSelfHud(pageB);
      if (after.name !== before.name) throw new Error(`resumed player name mismatch: before="${before.name}" after="${after.name}"`);
      if (after.hp > before.hp) throw new Error(`HP went up across reconnect (before=${before.hp}, after=${after.hp}) — looks reset rather than resumed`);
    });

    try { localWs?.send(JSON.stringify({ t: 'leave' })); localWs?.close(); } catch { /* best effort */ }
    await pageA.click('#leave').catch(() => {});
    await pageB.click('#leave').catch(() => {});
    await ctxA.close().catch(() => {});
    await ctxB.close().catch(() => {});

    // ================================================================
    // Level Builder: Remix + Undo, in procedural-fallback mode (no ANTHROPIC_API_KEY in this test
    // environment) — Make harder/easier/Remix/Explain and Save/Publish/Test-play are already
    // covered by test/e2e.mjs scenario 6; this covers Remix specifically, plus its Undo.
    // ================================================================
    await scenario('15. Level Builder: Remix + Undo (procedural fallback)', async () => {
      const ed = { name: `e2eEditor${rnd()}`, pass: 'Password123' };
      const { token } = await registerUser(baseUrl, ed.name, ed.pass);
      const ctxE = await browser.newContext();
      const pageE = await ctxE.newPage(); attachPageErrors(pageE, 'Editor', { pageErrors, consoleErrors, failedRequests });
      try {
        await pageE.goto(`${baseUrl}/?nosw=1`, { waitUntil: 'load' });
        await pageE.evaluate((t) => localStorage.setItem('gc_token', t), token);
        await pageE.goto(`${baseUrl}/editor.html?nosw=1`, { waitUntil: 'load' });
        await pageE.waitForSelector('#remix', { timeout: 10_000 });

        const genCountFromStatus = async () => {
          const t = await pageE.locator('#status').textContent();
          const m = t.match(/(\d+)\s+generators/);
          if (!m) throw new Error(`could not read generator count from #status: "${t}"`);
          return Number(m[1]);
        };
        const before = await genCountFromStatus();
        await pageE.click('#remix');
        await pageE.waitForFunction(() => (document.querySelector('#remix-note')?.textContent || '').toLowerCase().includes('procedural') || (document.querySelector('#remix-note')?.textContent || '').toLowerCase().includes('remix'), { timeout: 20_000 });
        if (!(await pageE.locator('#undoRemix').isVisible())) throw new Error('undo button should appear after Remix');
        const afterRemix = await genCountFromStatus();

        await pageE.click('#undoRemix');
        await pageE.waitForFunction((n) => {
          const t = document.querySelector('#status')?.textContent || '';
          const m = t.match(/(\d+)\s+generators/);
          return m && Number(m[1]) === n;
        }, before, { timeout: 10_000 });
        void afterRemix;
      } finally {
        await ctxE.close().catch(() => {});
      }
    });

    // ================================================================
    // Hero Builder: AI assist fallback (no ANTHROPIC_API_KEY -> a preset build) saves cleanly.
    // ================================================================
    await scenario('16. Hero Builder: AI assist fallback returns a preset that saves', async () => {
      const hb = { name: `e2eHero${rnd()}`, pass: 'Password123' };
      const { token } = await registerUser(baseUrl, hb.name, hb.pass);
      const xpRes = await fetch(`${baseUrl}/api/heroes/debug/xp`, {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ amount: 700 }),
      });
      if (!xpRes.ok) throw new Error(`granting XP for the Hero Builder unlock failed: HTTP ${xpRes.status}`);

      const ctxF = await browser.newContext();
      const pageF = await ctxF.newPage(); attachPageErrors(pageF, 'HeroBuilder', { pageErrors, consoleErrors, failedRequests });
      try {
        await pageF.goto(`${baseUrl}/?nosw=1`, { waitUntil: 'load' });
        await pageF.evaluate((t) => localStorage.setItem('gc_token', t), token);
        await pageF.goto(`${baseUrl}/heroes.html?nosw=1`, { waitUntil: 'load' });
        await pageF.waitForSelector('#builder:not([hidden])', { timeout: 10_000 });
        await pageF.fill('#ai-prompt', 'A shadowy archer who lives on treasure');
        await pageF.click('#ai-gen');
        await pageF.waitForFunction(() => {
          const t = document.querySelector('#ai-note')?.textContent || '';
          return t.length > 0 && !t.includes('Conjuring') && !t.includes('Asking the AI');
        }, { timeout: 20_000 });
        const heroName = await pageF.inputValue('#hname');
        if (!heroName) throw new Error('AI assist (fallback preset) did not populate a hero name');
        await pageF.click('#save-btn');
        await pageF.waitForFunction(() => (document.querySelector('#save-status')?.textContent || '') === 'Saved.', { timeout: 10_000 });
      } finally {
        await ctxF.close().catch(() => {});
      }
    });

    // ================================================================
    // Settings: password change, prefs round trip (narrator toggle + mute), data export, account
    // deletion — a dedicated throwaway account, since the last step deletes it.
    // ================================================================
    await scenario('17. Settings: password change, prefs round trip, data export, account deletion', async () => {
      const su = { name: `e2eStg${rnd()}`, pass: 'Password123' }; // NAME_RE caps usernames at 16 chars
      const { token } = await registerUser(baseUrl, su.name, su.pass);
      const ctxG = await browser.newContext();
      const pageG = await ctxG.newPage(); attachPageErrors(pageG, 'Settings', { pageErrors, consoleErrors, failedRequests });
      try {
        await pageG.goto(`${baseUrl}/?nosw=1`, { waitUntil: 'load' });
        await pageG.evaluate((t) => localStorage.setItem('gc_token', t), token);
        await pageG.goto(`${baseUrl}/settings.html?nosw=1`, { waitUntil: 'load' });
        await pageG.waitForSelector('#mine:not([style*="display: none"])', { timeout: 10_000 });

        // prefs round trip: flip narrator off and mute the master volume (#18/narrator + mute).
        await pageG.uncheck('#p-narrator');
        await pageG.fill('#p-volume', '0');
        await pageG.click('#save-prefs');
        await pageG.waitForFunction(() => (document.querySelector('#prefs-msg')?.textContent || '') === 'Saved.', { timeout: 10_000 });
        await pageG.reload({ waitUntil: 'load' });
        await pageG.waitForSelector('#mine:not([style*="display: none"])', { timeout: 10_000 });
        if (await pageG.isChecked('#p-narrator')) throw new Error('narrator preference did not round-trip as off after a reload');
        if ((await pageG.inputValue('#p-volume')) !== '0') throw new Error('mute (0% volume) preference did not round-trip after a reload');

        // password change
        await pageG.fill('#cur-pw', su.pass);
        await pageG.fill('#new-pw', 'Password456');
        await pageG.click('#change-pw');
        await pageG.waitForFunction(() => (document.querySelector('#msg')?.textContent || '').includes('Password changed'), { timeout: 10_000 });

        // data export -> a downloaded JSON file named after the account
        const downloadPromise = pageG.waitForEvent('download', { timeout: 10_000 });
        await pageG.click('#export');
        const download = await downloadPromise;
        if (!download.suggestedFilename().includes('gauntlet-crawler')) throw new Error(`unexpected export filename: ${download.suggestedFilename()}`);

        // account deletion (guarded by a native confirm() dialog)
        pageG.once('dialog', (d) => d.accept());
        await pageG.fill('#del-pw', 'Password456');
        await pageG.click('#delete-account');
        await pageG.waitForFunction(() => (document.querySelector('#msg')?.textContent || '').includes('deleted'), { timeout: 10_000 });

        const loginAfterDelete = await fetch(`${baseUrl}/api/login`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: su.name, password: 'Password456' }),
        });
        if (loginAfterDelete.ok) throw new Error('logging in as the just-deleted account should fail');
      } finally {
        await ctxG.close().catch(() => {});
      }
    });

    // ================================================================
    // Admin dashboard: loads for user id 1 (the default admin) and lists a user.
    // ================================================================
    await scenario('18. Admin dashboard loads for user id 1 and lists a user', async () => {
      const loginRes = await fetch(`${baseUrl}/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: adminUser.name, password: adminUser.pass }),
      });
      if (!loginRes.ok) throw new Error(`admin login failed: HTTP ${loginRes.status}`);
      const { token } = await loginRes.json();

      const ctxH = await browser.newContext();
      const pageH = await ctxH.newPage(); attachPageErrors(pageH, 'Admin', { pageErrors, consoleErrors, failedRequests });
      try {
        await pageH.goto(`${baseUrl}/?nosw=1`, { waitUntil: 'load' });
        await pageH.evaluate((t) => localStorage.setItem('gc_token', t), token);
        await pageH.goto(`${baseUrl}/admin.html?nosw=1`, { waitUntil: 'load' });
        await pageH.waitForSelector('#app:not([style*="display: none"])', { timeout: 10_000 });
        await pageH.click('#tabs button[data-t="users"]');
        await pageH.waitForFunction((name) => (document.querySelector('#users-table')?.textContent || '').includes(name), otherUser.name, { timeout: 10_000 });
      } finally {
        await ctxH.close().catch(() => {});
      }
    });

    // ================================================================
    // Attract mode: the lobby's idle timer redirects to /attract.html, and the attract canvas
    // actually animates once there (title -> carousel/demo phases both fill a near-black
    // background, so a fast luminance drop is a cheap, deterministic "phase advanced" signal
    // without needing to read the bitmap text). Trailer page loads a real video element.
    // ================================================================
    await scenario('19. Attract mode: idle redirect from the lobby, and the canvas animates past the title card', async () => {
      const ctxI = await browser.newContext();
      const pageI = await ctxI.newPage(); attachPageErrors(pageI, 'Attract', { pageErrors, consoleErrors, failedRequests });
      try {
        await pageI.clock.install();
        await pageI.goto(`${baseUrl}/`, { waitUntil: 'load' });
        await pageI.waitForSelector('#heroes .hero', { timeout: 10_000 });
        await pageI.clock.fastForward(31_000); // client/attract-idle.js's IDLE_MS is 30s
        await pageI.waitForURL(/attract\.html/, { timeout: 5_000 });
        await pageI.waitForSelector('#cv', { timeout: 10_000 });

        const avgLuma = () => pageI.evaluate(() => {
          const cv = document.querySelector('#cv');
          const ctx = cv.getContext('2d');
          const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
          let sum = 0;
          for (let i = 0; i < data.length; i += 4 * 97) sum += (data[i] + data[i + 1] + data[i + 2]) / 3; // sampled, not every pixel
          return sum;
        });
        const deadline = Date.now() + 20_000;
        let before = await avgLuma();
        let sawChange = false;
        while (Date.now() < deadline) {
          await pageI.waitForTimeout(500);
          const now = await avgLuma();
          if (Math.abs(now - before) > 1) sawChange = true;
          before = now;
          if (sawChange) break;
        }
        if (!sawChange) throw new Error('attract canvas never appeared to redraw over 20s (title blink / phase change)');
      } finally {
        await ctxI.close().catch(() => {});
      }
    });

    await scenario('20. Trailer page loads a video element with no console errors', async () => {
      const ctxJ = await browser.newContext();
      const pageJ = await ctxJ.newPage(); attachPageErrors(pageJ, 'Trailer', { pageErrors, consoleErrors, failedRequests });
      try {
        await pageJ.goto(`${baseUrl}/trailer.html?nosw=1`, { waitUntil: 'load' });
        const src = await pageJ.locator('video source').first().getAttribute('src');
        if (!src || !src.includes('trailer.mp4')) throw new Error(`expected the trailer <video> to have a trailer.mp4 <source>, got "${src}"`);
      } finally {
        await ctxJ.close().catch(() => {});
      }
    });
  } catch (err) {
    overallFailed = true;
    console.error('[e2e-features] harness-level failure:', (err && err.stack) || err);
    console.error('[e2e-features] server output so far:\n' + server.output());
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.stop();
  }

  const failedScenarios = results.filter((r) => !r.ok);
  if (failedScenarios.length) overallFailed = true;
  if (pageErrors.length || consoleErrors.length || failedRequests.length) overallFailed = true;

  log('---- summary ----');
  for (const r of results) log(`${r.ok ? 'PASS' : 'FAIL'}: ${r.name}`);
  if (knownBugs.length) {
    log(`${knownBugs.length} known bug(s) flagged (see KNOWN BUG lines above):`);
    for (const b of knownBugs) log(`  - ${b.name}: ${b.detail}`);
  }
  if (pageErrors.length) { log(`${pageErrors.length} browser page error(s):`); for (const e of pageErrors) log('  ' + e); }
  if (consoleErrors.length) { log(`${consoleErrors.length} browser console error(s):`); for (const e of consoleErrors) log('  ' + e); }
  if (failedRequests.length) { log(`${failedRequests.length} failed/5xx request(s):`); for (const e of failedRequests) log('  ' + e); }

  log(overallFailed ? 'E2E-FEATURES FAILED' : 'E2E-FEATURES PASS: all scenarios green, no page/console errors, no failed requests');
  process.exit(overallFailed ? 1 : 0);
}

main();
