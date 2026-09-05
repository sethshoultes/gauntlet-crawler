#!/usr/bin/env node
// Real end-to-end test suite: boots the actual server once (free port, temp DATA_DIR,
// GAUNTLET_DEBUG=1) and drives it through the whole multiplayer surface with two real Chromium
// browser contexts (Playwright) plus a raw `ws` client for server-only debug hooks. Not a
// node:test file (test/**/*.test.js only), so it never runs as part of `npm test` — invoked
// explicitly via `npm run e2e`.
//
// The server-spawning and free-port helpers below are intentionally copied from test/smoke.mjs
// rather than imported, so this script has no import-time dependency on that file.
//
// Usage:
//   npm run e2e
//   CHROMIUM_PATH=/opt/pw-browsers/chromium npm run e2e   # pre-installed browser instead of
//                                                          // the one `playwright install` fetched
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import WebSocket from 'ws';

function log(msg) {
  console.log(`[e2e] ${msg}`);
}

// ---------- copied from test/smoke.mjs (see header note) ----------
function findFreePort() {
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

function waitForServer(url, timeoutMs = 20_000) {
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
// ---------- end copied helpers ----------

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
 *  than a test-harness issue. Prints a loud, unmissable marker; the assertion itself must still
 *  have been left to fail above (never weaken it to make this quieter). */
function knownBug(name, detail) {
  knownBugs.push({ name, detail });
  log(`KNOWN BUG in "${name}": ${detail}`);
}

/** Read the local player's own HUD row (name, HP, current level text) as one atomic in-page
 *  evaluation, retrying until it resolves. #hud is fully replaced (briefly emptying #hud-lvl and
 *  every .pp row) each time a `players` packet arrives, then repainted on the next animation
 *  frame — reading name/hp/level as separate round trips (locator calls) can straddle that reset
 *  and see an inconsistent snapshot, so this grabs all three in a single page.evaluate() and
 *  retries as a whole until it sees a complete, non-empty reading. */
async function readSelfHud(page, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const lvl = (document.querySelector('#hud-lvl')?.textContent || '').trim();
      const row = [...document.querySelectorAll('#hud .pp')].find((el) => el.textContent.includes('(you)'));
      if (!row || !lvl) return null;
      const name = (row.querySelector('.nm')?.textContent || '').trim();
      const hp = Number((row.querySelector('.hp')?.textContent || '').trim());
      return { name, hp, level: lvl, playerCount: document.querySelectorAll('#hud .pp').length };
    });
    if (last && last.name && Number.isFinite(last.hp) && last.level) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for a stable HUD reading (last=${JSON.stringify(last)})`);
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'gauntlet-e2e-'));
  const port = await findFreePort();
  // fileURLToPath (not URL#pathname) so a repo path containing spaces or other characters that
  // get percent-encoded in a file: URL (e.g. "Local%20Sites") resolves to a real, spawnable
  // directory instead of a literal "%20" that doesn't exist on disk.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const baseUrl = `http://127.0.0.1:${port}`;

  log(`starting server on ${baseUrl} (DATA_DIR=${dataDir}, GAUNTLET_DEBUG=1)`);
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, GAUNTLET_DEBUG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (d) => { serverOutput += d.toString(); });
  server.stderr.on('data', (d) => { serverOutput += d.toString(); });
  const serverExit = once(server, 'exit');

  let browser = null;
  let overallFailed = false;

  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  function attach(page, tag) {
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

  try {
    await Promise.race([
      waitForServer(baseUrl),
      serverExit.then(([code]) => { throw new Error(`server exited early (code ${code}):\n${serverOutput}`); }),
    ]);
    log('server is listening');

    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage(); attach(pageA, 'A');
    const pageB = await ctxB.newPage(); attach(pageB, 'B');

    const rnd = () => crypto.randomBytes(3).toString('hex');
    const userA = { name: `e2eA${rnd()}`, pass: 'Password123' };
    const restUser = { name: `e2eR${rnd()}`, pass: 'Password123' };

    let roomIdMain = null;
    let deathRoomId = null;

    // ---------------- 1. Registration + login: REST API and UI modal ----------------
    await scenario('1. Registration + login via REST API and UI modal', async () => {
      const regRes = await fetch(`${baseUrl}/api/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: restUser.name, password: restUser.pass }),
      });
      if (!regRes.ok) throw new Error(`REST register failed: HTTP ${regRes.status}`);
      const regBody = await regRes.json();
      if (!regBody.token || regBody.user?.username !== restUser.name) throw new Error(`REST register response malformed: ${JSON.stringify(regBody)}`);

      const loginRes = await fetch(`${baseUrl}/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: restUser.name, password: restUser.pass }),
      });
      if (!loginRes.ok) throw new Error(`REST login failed: HTTP ${loginRes.status}`);
      const loginBody = await loginRes.json();
      if (!loginBody.token || loginBody.user?.username !== restUser.name) throw new Error(`REST login response malformed: ${JSON.stringify(loginBody)}`);

      // UI modal: register a *different* account on browser A's page — this becomes browser A's
      // logged-in identity for the rest of the run.
      await pageA.goto(`${baseUrl}/?nosw=1`, { waitUntil: 'load' });
      await pageA.click('#nav-login');
      await pageA.fill('#au', userA.name);
      await pageA.fill('#ap', userA.pass);
      await Promise.all([
        pageA.waitForNavigation({ waitUntil: 'load' }),
        pageA.click('#a-reg'),
      ]);
      await pageA.waitForSelector('#nav-logout', { timeout: 10_000 });
      const whoAfterReg = (await pageA.locator('.who').textContent()).trim();
      if (!whoAfterReg.includes(userA.name)) throw new Error(`nav bar did not show logged-in username after UI register, got: "${whoAfterReg}"`);

      // Log out, then log back in through the modal to exercise the UI login path too.
      await pageA.click('#nav-logout');
      await pageA.waitForSelector('#nav-login', { timeout: 10_000 });
      await pageA.click('#nav-login');
      await pageA.fill('#au', userA.name);
      await pageA.fill('#ap', userA.pass);
      await Promise.all([
        pageA.waitForNavigation({ waitUntil: 'load' }),
        pageA.click('#a-login'),
      ]);
      await pageA.waitForSelector('#nav-logout', { timeout: 10_000 });
      const whoAfterLogin = (await pageA.locator('.who').textContent()).trim();
      if (!whoAfterLogin.includes(userA.name)) throw new Error(`nav bar did not show logged-in username after UI login, got: "${whoAfterLogin}"`);
    });

    // ---------------- 2. Two-browser co-op ----------------
    await scenario('2. Two-browser co-op: create/join, ready/start, move+fire, HUD', async () => {
      await pageA.waitForSelector('#heroes .hero', { timeout: 10_000 });
      await pageA.click('#heroes .hero:nth-child(1)'); // Warrior — always unlocked
      await pageA.fill('#roomname', 'E2E Co-op Room');
      await pageA.click('#create');
      await pageA.waitForSelector('#roomscreen.on', { timeout: 15_000 });

      const urlA = new URL(pageA.url());
      roomIdMain = urlA.searchParams.get('room');
      if (!roomIdMain) throw new Error(`browser A URL did not carry a room id after create: ${pageA.url()}`);

      await pageB.goto(`${baseUrl}/?room=${roomIdMain}&nosw=1`, { waitUntil: 'load' });
      await pageB.waitForSelector('#roomscreen.on', { timeout: 15_000 });

      await pageA.click('#rs-ready');
      await pageB.click('#rs-ready');
      await pageA.waitForSelector('#rs-start:not([disabled])', { timeout: 10_000 });
      await pageA.click('#rs-start');

      await pageA.waitForSelector('#game.on', { timeout: 15_000 });
      await pageB.waitForSelector('#game.on', { timeout: 15_000 });

      await pageA.waitForFunction(() => document.querySelectorAll('#hud .pp').length === 2, { timeout: 10_000 });
      await pageB.waitForFunction(() => document.querySelectorAll('#hud .pp').length === 2, { timeout: 10_000 });

      const hud0A = await readSelfHud(pageA);
      const hud0B = await readSelfHud(pageB);
      if (hud0A.playerCount !== 2 || hud0B.playerCount !== 2) throw new Error(`expected 2 players in the HUD (A saw ${hud0A.playerCount}, B saw ${hud0B.playerCount})`);

      await pageA.keyboard.down('d'); await pageB.keyboard.down('d');
      await pageA.waitForTimeout(1500);
      await pageA.keyboard.up('d'); await pageB.keyboard.up('d');
      await pageA.keyboard.down(' '); await pageB.keyboard.down(' ');
      await pageA.waitForTimeout(1500);
      await pageA.keyboard.up(' '); await pageB.keyboard.up(' ');

      const hud1A = await readSelfHud(pageA);
      const hud1B = await readSelfHud(pageB);
      if (!(hud1A.hp < hud0A.hp)) throw new Error(`expected browser A health to drop below ${hud0A.hp} after 3s of play, got ${hud1A.hp}`);
      if (!(hud1B.hp < hud0B.hp)) throw new Error(`expected browser B health to drop below ${hud0B.hp} after 3s of play, got ${hud1B.hp}`);
    });

    // ---------------- 3. Level clear + chests via debug hook ----------------
    await scenario('3. Level clear + chest intermission via debug "clear" -> level 2', async () => {
      if (!roomIdMain) throw new Error('no room id from scenario 2 to attach the debug client to');
      const helperWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await once(helperWs, 'open');
      helperWs.on('message', (data) => {
        let msg; try { msg = JSON.parse(data); } catch { return; }
        // Also pick a chest for the helper bot itself so the intermission ends on the fast
        // "everyone picked" path instead of waiting out the full 15s timeout.
        if (msg.t === 'chests' && msg.chests?.length) helperWs.send(JSON.stringify({ t: 'pick', id: msg.chests[0].id }));
      });
      helperWs.send(JSON.stringify({ t: 'join', roomId: roomIdMain, name: 'HelperBot' }));
      await new Promise((r) => setTimeout(r, 400)); // let the join land before the debug action
      helperWs.send(JSON.stringify({ t: 'debug', action: 'clear' }));

      await pageA.waitForFunction(() => document.querySelector('#log').textContent.includes('Choose a chest'), { timeout: 10_000 });
      await pageB.waitForFunction(() => document.querySelector('#log').textContent.includes('Choose a chest'), { timeout: 10_000 });

      await pageA.keyboard.press('1');
      await pageB.keyboard.press('1');

      await pageA.waitForFunction(() => document.querySelector('#log').textContent.includes('Level 2:'), { timeout: 15_000 });
      await pageB.waitForFunction(() => document.querySelector('#log').textContent.includes('Level 2:'), { timeout: 15_000 });
      await pageA.waitForFunction(() => (document.querySelector('#hud-lvl')?.textContent || '').trim() === 'Level 2', { timeout: 5_000 });
      await pageB.waitForFunction(() => (document.querySelector('#hud-lvl')?.textContent || '').trim() === 'Level 2', { timeout: 5_000 });

      try { helperWs.send(JSON.stringify({ t: 'leave' })); helperWs.close(); } catch { /* best effort */ }
    });

    // ---------------- 4. Reconnect ----------------
    await scenario('4. Reconnect: reloading browser B mid-game resumes the same player', async () => {
      const before = await readSelfHud(pageB);

      await pageB.reload({ waitUntil: 'load' });
      await pageB.waitForSelector('#game.on', { timeout: 15_000 });
      const after = await readSelfHud(pageB);

      if (after.name !== before.name) throw new Error(`resumed player name mismatch: before="${before.name}" after="${after.name}"`);
      if (after.level !== before.level) throw new Error(`level changed across reconnect: before="${before.level}" after="${after.level}"`);
      if (!(after.hp > 0)) throw new Error(`HP invalid after reconnect: ${after.hp}`);
      // A resumed player keeps accumulated HP (only ticking down slightly further while the page
      // reloaded) instead of respawning at a fresh START_HEALTH (2000, plus/minus any chest boost
      // already applied) — so it should stay close to the pre-reload value, not jump back up to it.
      if (after.hp > before.hp) throw new Error(`HP went up across reconnect (before=${before.hp}, after=${after.hp}) — looks reset rather than resumed`);
      if (before.hp - after.hp > 50) throw new Error(`HP dropped too much across a reload to be normal drain (before=${before.hp}, after=${after.hp})`);
    });

    // ---------------- 5. Death mode ----------------
    await scenario('5. Death mode: wave banner, HUD level cap, wave advance via debug killall', async () => {
      await pageA.click('#leave');
      await pageA.waitForSelector('#heroes .hero', { timeout: 10_000 });
      await pageA.click('#heroes .hero:nth-child(1)');
      await pageA.click('#create');
      await pageA.waitForSelector('#roomscreen.on', { timeout: 15_000 });

      const url2 = new URL(pageA.url());
      deathRoomId = url2.searchParams.get('room');
      if (!deathRoomId) throw new Error(`browser A URL did not carry a room id for the death-mode room: ${pageA.url()}`);

      await pageA.selectOption('#rs-mode', 'death');
      await pageA.waitForFunction(() => document.querySelector('#rs-death-help')?.style.display !== 'none', { timeout: 5_000 });
      await pageA.waitForSelector('#rs-start:not([disabled])', { timeout: 5_000 }); // solo host, no ready-up needed
      await pageA.click('#rs-start');
      await pageA.waitForSelector('#game.on', { timeout: 15_000 });

      await pageA.waitForFunction(() => document.querySelector('#log').textContent.includes('Wave 1 of'), { timeout: 8_000 });
      await pageA.waitForFunction(() => (document.querySelector('#hud-lvl')?.textContent || '').includes('/ 99'), { timeout: 8_000 });

      // WAVE_BANNER_SECONDS (3s) must elapse before the wave's monsters actually spawn — only
      // then does a debug "killall" have anything to clear (and so anything to advance from).
      await pageA.waitForTimeout(3600);

      const helperWs2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await once(helperWs2, 'open');
      helperWs2.send(JSON.stringify({ t: 'join', roomId: deathRoomId, name: 'HelperBot2' }));
      await new Promise((r) => setTimeout(r, 400));
      helperWs2.send(JSON.stringify({ t: 'debug', action: 'killall' }));

      await pageA.waitForFunction(() => document.querySelector('#log').textContent.includes('Wave 2 of'), { timeout: 8_000 });

      try { helperWs2.send(JSON.stringify({ t: 'leave' })); helperWs2.close(); } catch { /* best effort */ }
    });

    // ---------------- 6. Editor ----------------
    await scenario('6. Editor: generate (procedural fallback), remix/tune/explain (#17), save, publish, test play', async () => {
      await pageA.click('#leave').catch(() => {}); // leave the Death mode room first
      await pageA.goto(`${baseUrl}/editor.html?nosw=1`, { waitUntil: 'load' });
      await pageA.waitForSelector('#gen', { timeout: 10_000 });
      await pageA.fill('#prompt', 'A small crypt guarded by ghosts with a treasure vault behind a locked door');
      await pageA.click('#gen');
      await pageA.waitForFunction(() => (document.querySelector('#status')?.textContent || '').includes('Playable'), { timeout: 20_000 });

      // #17 AI assist: "Make harder" + undo, all logged in as pageA. Remix/harder/easier/explain
      // share one per-user rate-limit bucket with the "Generate with AI" call just above (1 AI
      // action per 10s, see server/index.js), so give that bucket a moment to clear first rather
      // than racing it and getting a 429 the UI would (correctly) just toast and stop on.
      await pageA.waitForTimeout(10_500);

      const genCountFromStatus = async () => {
        const t = await pageA.locator('#status').textContent();
        const m = t.match(/(\d+)\s+generators/);
        if (!m) throw new Error(`could not read generator count from #status: "${t}"`);
        return Number(m[1]);
      };
      const genBefore = await genCountFromStatus();
      await pageA.click('#harder');
      await pageA.waitForFunction(() => (document.querySelector('#remix-note')?.textContent || '').toLowerCase().includes('harder'), { timeout: 20_000 });
      const genAfterHarder = await genCountFromStatus();
      if (!(genAfterHarder > genBefore)) throw new Error(`"Make harder" should increase the generator count (before ${genBefore}, after ${genAfterHarder})`);
      if (!(await pageA.locator('#undoRemix').isVisible())) throw new Error('undo button should appear after a remix/tune action');

      await pageA.click('#undoRemix');
      await pageA.waitForFunction((n) => {
        const t = document.querySelector('#status')?.textContent || '';
        const m = t.match(/(\d+)\s+generators/);
        return m && Number(m[1]) === n;
      }, genBefore, { timeout: 10_000 });

      // "Explain this level" on the (now reverted) level -- exercised on its own, well clear of
      // the harder/undo calls' own 10s window.
      await pageA.waitForTimeout(10_500);
      await pageA.click('#explain');
      await pageA.waitForFunction(() => (document.querySelector('#explain-panel')?.textContent || '').length > 10, { timeout: 20_000 });

      await pageA.click('#save');
      await pageA.waitForFunction(() => document.querySelector('#publish') && !document.querySelector('#publish').disabled, { timeout: 10_000 });

      await pageA.click('#publish');
      await pageA.waitForFunction(() => document.querySelector('#publish')?.textContent.trim() === 'Unpublish', { timeout: 10_000 });

      await Promise.all([
        pageA.waitForURL(/room=/, { timeout: 15_000 }),
        pageA.click('#test'),
      ]);
      await pageA.waitForSelector('#roomscreen.on, #game.on', { timeout: 15_000 });
    });

    // ---------------- 7. Dashboard ----------------
    await scenario('7. Dashboard: progression, achievements, recent runs, leaderboard tabs', async () => {
      await pageA.goto(`${baseUrl}/dashboard.html?nosw=1`, { waitUntil: 'load' });
      await pageA.waitForSelector('#mine', { timeout: 10_000 });
      if (!(await pageA.locator('#mine').isVisible())) throw new Error('#mine panel is not visible for a logged-in user');

      const progTitle = (await pageA.locator('#prog-title').textContent()).trim();
      if (!progTitle) throw new Error('progression panel (#prog-title) is empty');

      await pageA.waitForFunction(() => document.querySelectorAll('.ach').length > 0, { timeout: 10_000 });
      const unlockedCount = await pageA.locator('.ach.on').count();
      if (unlockedCount < 1) throw new Error('expected at least one unlocked achievement (e.g. Architect, from publishing a level)');
      const achNames = await pageA.locator('.ach.on .n').allTextContents();
      if (!achNames.some((n) => n.includes('Architect'))) log(`note: Architect not among unlocked achievements (unlocked: ${achNames.join(', ')})`);

      const runsText = await pageA.locator('#runs').textContent();
      if (runsText.includes('No runs yet')) throw new Error('expected at least one row in the Recent runs table after all the play above');

      for (const tab of ['death', 'rank', 'depth', 'kills', 'achievements', 'scores']) {
        await pageA.click(`#tabs button[data-t="${tab}"]`);
        await pageA.waitForTimeout(150);
        const lbHtml = await pageA.locator('#lb').innerHTML();
        if (!lbHtml || !lbHtml.includes('<th')) throw new Error(`leaderboard tab "${tab}" did not render a header row`);
      }
    });

    // ---------------- 8. Security regressions ----------------
    await scenario('8. Security regressions: path traversal, NUL byte, server liveness', async () => {
      const trav = await fetch(`${baseUrl}/shared/..%2fpackage.json`);
      if (![403, 404].includes(trav.status)) throw new Error(`expected 403/404 for encoded path traversal, got HTTP ${trav.status}`);

      const nul = await fetch(`${baseUrl}/%00`);
      if (nul.status !== 400) throw new Error(`expected 400 for a NUL-byte path, got HTTP ${nul.status}`);

      const alive = await fetch(`${baseUrl}/`);
      if (!alive.ok) throw new Error(`server did not respond 200 to / after the hostile requests above (HTTP ${alive.status})`);
    });

    // ---------------- 9. Hero Builder integration (#24) ----------------
    await scenario('9. Hero Builder: create a custom hero via the API, pick it in the lobby Custom tab, solo game HUD shows its name/colour', async () => {
      const loginRes = await fetch(`${baseUrl}/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: userA.name, password: userA.pass }),
      });
      if (!loginRes.ok) throw new Error(`login for userA failed: HTTP ${loginRes.status}`);
      const { token: tokenA } = await loginRes.json();
      if (!tokenA) throw new Error('login response for userA carried no token');

      // GAUNTLET_DEBUG=1-only test hook (server/heroes.js) — grants enough XP to clear the Hero
      // Builder's rank-3 unlock.
      const xpRes = await fetch(`${baseUrl}/api/heroes/debug/xp`, {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({ amount: 700 }),
      });
      if (!xpRes.ok) throw new Error(`granting XP for the Hero Builder unlock failed: HTTP ${xpRes.status}`);
      const xpBody = await xpRes.json();
      if (!(xpBody.rank >= 3)) throw new Error(`expected rank >= 3 after the XP grant, got ${JSON.stringify(xpBody)}`);

      const heroName = `Bolt${rnd().slice(0, 4)}`; // NAME_RE caps names at 12 chars (see shared/hero-builder.js)
      const heroRes = await fetch(`${baseUrl}/api/heroes`, {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({
          name: heroName, title: 'The Bolt', motto: 'Zap.',
          stats: { speed: 2, shot: 2, fireRate: 2, armor: 2, magic: 2, health: 2 }, // 12 notches
          weapon: 'skull', trait: 'thick_skin',
          pixels: new Array(8).fill('.333333.'), // palette index 3 = #3b7dff, dominant colour
        }),
      });
      if (!heroRes.ok) throw new Error(`creating the custom hero failed: HTTP ${heroRes.status}: ${await heroRes.text()}`);
      const heroBody = await heroRes.json();
      if (!heroBody.id) throw new Error(`hero creation response carried no id: ${JSON.stringify(heroBody)}`);

      // Scenario 6's "test play" click left a dangling sessionStorage resume token for that room
      // (never explicitly left) — clear it first so this fresh navigation lands on the lobby
      // instead of auto-reconnecting into that stale room (see game.js's resume-on-load check).
      await pageA.evaluate(() => { try { sessionStorage.removeItem('gc_resume'); } catch {} });
      await pageA.goto(`${baseUrl}/?nosw=1`, { waitUntil: 'load' });
      await pageA.waitForSelector('#heroes .hero', { timeout: 10_000 });
      await pageA.click('#hero-tabs [data-tab="custom"]');
      await pageA.waitForSelector('#heroes-custom .hero', { timeout: 10_000 });
      await pageA.click('#heroes-custom .hero');

      await pageA.click('#create');
      await pageA.waitForSelector('#roomscreen.on', { timeout: 15_000 });
      await pageA.waitForSelector('#rs-start:not([disabled])', { timeout: 10_000 }); // solo host, no ready-up needed
      await pageA.click('#rs-start');
      await pageA.waitForSelector('#game.on', { timeout: 15_000 });

      await pageA.waitForFunction((name) => [...document.querySelectorAll('#hud .pp')].some((el) => el.textContent.includes(name)), heroName, { timeout: 10_000 });
      const nmColor = await pageA.evaluate((name) => {
        const row = [...document.querySelectorAll('#hud .pp')].find((el) => el.textContent.includes(name));
        return row ? getComputedStyle(row.querySelector('.nm')).color : null;
      }, heroName);
      if (nmColor !== 'rgb(59, 125, 255)') throw new Error(`expected the custom hero's colour (#3b7dff) on the HUD name tag, got ${nmColor}`);

      await pageA.click('#leave').catch(() => {});
    });

    // ---------------- 10. Touch layout (#15) ----------------
    await scenario('10. Touch layout: ?touch=1 forces the d-pad to render, and tapping a zone moves the hero', async () => {
      const ctxC = await browser.newContext();
      const pageC = await ctxC.newPage(); attach(pageC, 'C');

      await pageC.goto(`${baseUrl}/?touch=1&nosw=1`, { waitUntil: 'load' });
      await pageC.waitForSelector('#heroes .hero', { timeout: 10_000 });
      await pageC.click('#heroes .hero:nth-child(1)'); // Warrior
      await pageC.fill('#gname', 'TouchTester');
      await pageC.click('#create');
      await pageC.waitForSelector('#roomscreen.on', { timeout: 15_000 });
      await pageC.waitForSelector('#rs-start:not([disabled])', { timeout: 5_000 }); // solo host, no ready-up needed
      await pageC.click('#rs-start');
      await pageC.waitForSelector('#game.on', { timeout: 15_000 });

      const touchRoomId = new URL(pageC.url()).searchParams.get('room');
      if (!touchRoomId) throw new Error(`browser C URL did not carry a room id for the touch-layout room: ${pageC.url()}`);

      // client/input.js force-shows the layout via a `touch-force` class when `?touch=1` is
      // present, since headless Chromium reports a fine (not coarse) pointer.
      await pageC.waitForSelector('#touch.touch-force', { timeout: 5_000 });
      const dirCount = await pageC.locator('.input-dpad .input-dir:not(.input-dir-mid)').count();
      if (dirCount !== 8) throw new Error(`expected 8 direction tap zones in the touch d-pad, got ${dirCount}`);
      if (!(await pageC.locator('.input-fire').isVisible())) throw new Error('touch fire button is not visible');
      if (!(await pageC.locator('.input-autofire').isVisible())) throw new Error('touch auto-fire toggle is not visible');

      // The HUD has no position readout, so spy on the room's raw snapshot stream (same pattern as
      // scenarios 3/5's debug helper) to read TouchTester's own hero position before/after the tap.
      const helperWs3 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await once(helperWs3, 'open');
      let myPid = null;
      let lastSnap = null;
      helperWs3.on('message', (data) => {
        let msg; try { msg = JSON.parse(data); } catch { return; }
        if (msg.t === 'players' && !myPid) {
          const me = msg.list.find((p) => p.name === 'TouchTester');
          if (me) myPid = me.id;
        }
        if (msg.t === 's') lastSnap = msg;
      });
      helperWs3.send(JSON.stringify({ t: 'join', roomId: touchRoomId, name: 'TouchSpy' }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!myPid) throw new Error('helper spy never saw a "players" packet naming TouchTester');
      const posOf = () => { const p = lastSnap?.p?.find((pp) => pp[0] === myPid); return p ? { x: p[1], y: p[2] } : null; };
      const before = posOf();
      if (!before) throw new Error('no snapshot position for TouchTester before the tap');

      // A held pointer on the "east" zone (▶) should move the hero right, same as holding 'd'.
      const eastBtn = pageC.locator('.input-dpad .input-dir', { hasText: '▶' });
      const box = await eastBtn.boundingBox();
      if (!box) throw new Error('east tap zone has no bounding box (not rendered/visible)');
      await pageC.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await pageC.mouse.down();
      await pageC.waitForTimeout(1200);
      await pageC.mouse.up();

      const after = posOf();
      if (!after) throw new Error('no snapshot position for TouchTester after the tap');
      if (!(after.x > before.x)) throw new Error(`expected TouchTester's x to increase after holding the east tap zone (before=${before.x}, after=${after.x})`);

      try { helperWs3.send(JSON.stringify({ t: 'leave' })); helperWs3.close(); } catch { /* best effort */ }
      await pageC.click('#leave').catch(() => {});
      await ctxC.close().catch(() => {});
    });

    // ---------------- 11. Lobby high-score table (#14) ----------------
    await scenario('11. Lobby renders the arcade high-score table (GET /api/highscores)', async () => {
      // No Death mode run has reached endRun() in this whole suite (scenario 5 only advances a
      // wave), so the board is still empty here — a deterministic, low-risk check that the panel
      // itself fetches and renders without error, rather than trying to drive a full run to
      // completion (and the initials-entry modal) through two browser contexts.
      await pageA.goto(`${baseUrl}/?nosw=1`, { waitUntil: 'load' });
      await pageA.waitForSelector('#lobby-highscores', { timeout: 10_000 });
      await pageA.waitForFunction(() => (document.querySelector('#lobby-highscores')?.textContent || '').trim().length > 0, { timeout: 10_000 });
      const text = await pageA.textContent('#lobby-highscores');
      if (!/no high scores yet/i.test(text)) throw new Error(`expected the empty-board message, got: ${text}`);

      const res = await fetch(`${baseUrl}/api/highscores`);
      if (!res.ok) throw new Error(`GET /api/highscores -> HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body.scores)) throw new Error(`expected { scores: [] }, got ${JSON.stringify(body)}`);
    });

    // ---------------- 12. PWA (#33): manifest, SW registration, offline reload ----------------
    await scenario('12. PWA: manifest link present, service worker registers, lobby reloads offline', async () => {
      // Its own context (no ?nosw=1 anywhere) so this is the one page load in the whole suite
      // that actually exercises client/pwa.js registering client/sw.js for real.
      const ctxD = await browser.newContext();
      const pageD = await ctxD.newPage();
      try {
        await pageD.goto(`${baseUrl}/`, { waitUntil: 'load' });

        const manifestHref = await pageD.locator('link[rel="manifest"]').getAttribute('href');
        if (manifestHref !== '/manifest.webmanifest') throw new Error(`expected the manifest link, got href="${manifestHref}"`);

        const reg = await pageD.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return registration ? { scope: registration.scope } : null;
        });
        if (!reg) throw new Error('navigator.serviceWorker.getRegistration() resolved to nothing after load');

        // Give the worker a moment to finish installing/activating and precaching the shell
        // before pulling the network out from under it.
        await pageD.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15_000 });

        await ctxD.setOffline(true);
        await pageD.reload({ waitUntil: 'load' });
        await pageD.waitForSelector('#heroes .hero', { timeout: 10_000 });
        await ctxD.setOffline(false);
      } finally {
        await ctxD.close().catch(() => {});
      }
    });

    await ctxA.close().catch(() => {});
    await ctxB.close().catch(() => {});
  } catch (err) {
    overallFailed = true;
    console.error('[e2e] harness-level failure:', (err && err.stack) || err);
    if (serverOutput) console.error('[e2e] server output so far:\n' + serverOutput);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server.exitCode === null && server.pid) {
      try { process.kill(server.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    await serverExit.catch(() => {}); // reuse the existing exit promise: a fresh once() would hang if the child already exited
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
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
  if (serverOutput.trim()) log('server output:\n' + serverOutput);

  log(overallFailed ? 'E2E FAILED' : 'E2E PASS: all scenarios green, no page/console errors, no failed requests');
  process.exit(overallFailed ? 1 : 0);
}

main();
