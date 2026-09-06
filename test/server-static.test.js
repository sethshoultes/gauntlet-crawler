// Regression test for the static file server (server/index.js serveStatic()): a request whose
// decoded path escapes the intended /shared or /client directory (via a raw ".." segment, or one
// smuggled past Node's URL dot-segment normalization inside a %2f-encoded slash) must never be
// able to read files elsewhere in the repo — including the sqlite database, server source, or
// package.json. Boots the real server as a child process (like test/smoke.mjs) since the
// traversal only manifests through the real HTTP request-path parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('static file traversal is blocked; legitimate /shared and /client files still serve', async () => {
  const server = await startServer();
  const { baseUrl } = server;

  try {
    // A literal ".." is already collapsed by Node's URL parser before serveStatic ever sees it,
    // so the historically dangerous case is a slash smuggled in as %2f, which survives that
    // normalization and only becomes ".." after serveStatic's own decodeURIComponent().
    const traversalPaths = [
      '/shared/..%2fserver/db.js',
      '/shared/..%2f..%2fpackage.json',
      '/shared/..%2fdata/gauntlet.sqlite',
      '/shared/%2e%2e%2fserver%2fdb.js',
    ];
    for (const p of traversalPaths) {
      const res = await fetch(baseUrl + p);
      assert.ok(res.status === 403 || res.status === 404, `${p} should be blocked, got HTTP ${res.status}`);
    }

    // Hostile paths must never crash the process: a NUL byte used to make fs.readFile throw
    // synchronously inside the request handler, taking the whole server down with a 000 response.
    for (const p of ['/%00', '/style.css%00.png', '/shared/%00constants.js', '/%zz']) {
      const res = await fetch(baseUrl + p);
      assert.ok([400, 403, 404].includes(res.status), `${p} should be rejected, got HTTP ${res.status}`);
    }
    assert.equal(server.exitCode, null, 'server must still be running after hostile paths');

    // The fix must not break legitimate access to shared/ and client/ files.
    const shared = await fetch(baseUrl + '/shared/constants.js');
    assert.equal(shared.status, 200, 'GET /shared/constants.js should still succeed');
    assert.match(await shared.text(), /CLASSES/);

    const index = await fetch(baseUrl + '/');
    assert.equal(index.status, 200, 'GET / should still serve index.html');
  } finally {
    await server.stop();
  }
});

test('GET /audio/sfx/<clip>.ogg serves with Content-Type audio/ogg', async () => {
  // Uses whichever clip the sfx pipeline (tools/generate-sfx.mjs) has actually generated on disk,
  // via client/audio/sfx/manifest.json -- rather than hardcoding an id. The repo ships 42
  // committed clips, so the manifest must be non-empty here (a truly empty manifest would make
  // this whole check a silent no-op).
  const manifestPath = path.join(ROOT, 'client', 'audio', 'sfx', 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const ids = Object.keys(manifest);
  assert.ok(ids.length > 0, 'expected client/audio/sfx/manifest.json to have at least one entry (the repo ships 42 clips)');

  const server = await startServer();
  const { baseUrl } = server;
  try {
    const file = manifest[ids[0]].file;
    const res = await fetch(`${baseUrl}/audio/sfx/${file}`);
    assert.equal(res.status, 200, `GET /audio/sfx/${file} should succeed`);
    assert.match(res.headers.get('content-type') || '', /^audio\/ogg/, 'Content-Type should be audio/ogg');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 0, 'served clip should not be empty');
  } finally {
    await server.stop();
  }
});

// Cache-busting for static assets (#38): a fresh index.html must never be able to end up paired
// with a stale game.js/style.css behind Cloudflare's edge cache — see server/assets.js and
// serveStatic() in server/index.js.
test('static assets are fingerprinted with ?v=<ASSET_VERSION> and cached accordingly', async () => {
  const server = await startServer();
  const { baseUrl } = server;
  try {
    const indexRes = await fetch(baseUrl + '/');
    assert.equal(indexRes.status, 200);
    const html = await indexRes.text();
    const match = html.match(/\/game\.js\?v=([0-9a-f]{12})/);
    assert.ok(match, 'served HTML must reference /game.js?v=<12 hex chars>');
    const version = match[1];
    // Every other same-origin script/link this page references should carry the same version.
    assert.match(html, /\/style\.css\?v=[0-9a-f]{12}/);
    assert.match(html, /\/pwa\.js\?v=[0-9a-f]{12}/);
    assert.match(html, /\/highscore\.js\?v=[0-9a-f]{12}/);
    // /sw.js is registered from client/pwa.js by plain string, not linked from HTML, but must
    // never itself gain a version query anywhere it might appear.
    assert.doesNotMatch(html, /sw\.js\?v=/);

    // Requests carrying the current version are immutable-cacheable...
    const versioned = await fetch(`${baseUrl}/game.js?v=${version}`);
    assert.equal(versioned.status, 200);
    assert.equal(versioned.headers.get('cache-control'), 'public, max-age=31536000, immutable');

    // ...an unversioned request for the same file stays no-cache...
    const unversioned = await fetch(baseUrl + '/game.js');
    assert.equal(unversioned.status, 200);
    assert.equal(unversioned.headers.get('cache-control'), 'no-cache');

    // ...and so does a request carrying a stale/incorrect version (e.g. a browser tab still
    // holding a link from a previous deploy) — it must be revalidated, never trusted as immutable.
    const stale = await fetch(baseUrl + '/game.js?v=wrong');
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get('cache-control'), 'no-cache');

    // /sw.js must always stay no-cache, even if a stray ?v= is appended to the request, so the
    // browser's own update check for it is never short-circuited by an immutable header.
    const swVersioned = await fetch(`${baseUrl}/sw.js?v=${version}`);
    assert.equal(swVersioned.status, 200);
    assert.equal(swVersioned.headers.get('cache-control'), 'no-cache');
    const swPlain = await fetch(baseUrl + '/sw.js');
    assert.equal(swPlain.headers.get('cache-control'), 'no-cache');

    // Pages and images are not fingerprinted, so even a matching ?v= must not make them immutable:
    // a proxy or a future code path appending ?v= to /index.html would otherwise pin stale HTML for
    // a year.
    for (const p of ['/', '/index.html', '/icons/icon-192.png']) {
      const r = await fetch(`${baseUrl}${p}?v=${version}`);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get('cache-control'), 'no-cache', `${p}?v= must stay no-cache`);
    }

    // The served JS body itself carries versioned import specifiers (both relative and
    // root-absolute), not just the HTML that links to it.
    const gameJsBody = await unversioned.text();
    assert.match(gameJsBody, /from '\.\/common\.js\?v=[0-9a-f]{12}'/);
    assert.match(gameJsBody, /from '\/shared\/constants\.js\?v=[0-9a-f]{12}'/);

    // The service worker's own import of ./sw-rules.js is versioned too.
    const swBody = await swPlain.text();
    assert.match(swBody, /from '\.\/sw-rules\.js\?v=[0-9a-f]{12}'/);

    // The version is stable across separate requests to the same running server.
    const again = await fetch(baseUrl + '/');
    const againMatch = (await again.text()).match(/\/game\.js\?v=([0-9a-f]{12})/);
    assert.equal(againMatch && againMatch[1], version, 'ASSET_VERSION must be stable across requests within one server lifetime');

    const healthRes = await fetch(baseUrl + '/api/health');
    const health = await healthRes.json();
    assert.equal(health.assetVersion, version, '/api/health must report the same ASSET_VERSION used to fingerprint served assets');
  } finally {
    await server.stop();
  }
});
