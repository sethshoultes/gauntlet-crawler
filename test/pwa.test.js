// Regression tests for the installable PWA shell (#33): the manifest's shape and icon files, the
// icon generator's byte-for-byte reproducibility, the server's MIME/caching headers for the
// manifest and service worker, and the service worker's routing rules (client/sw-rules.js) as
// pure functions — proving /api/*, /ws and /sw.js itself are never cached, independent of any
// real ServiceWorkerGlobalScope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { startServer } from './helpers/server.mjs';
import { isNetworkOnly, shouldHandle, PRECACHE_URLS } from '../client/sw-rules.js';
import { ICON_SPECS, ICONS_DIR, generateAll } from '../tools/generate-icons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_DIR = path.join(ROOT, 'client');

test('manifest.webmanifest parses and has the fields an installability check needs', () => {
  const raw = fs.readFileSync(path.join(CLIENT_DIR, 'manifest.webmanifest'), 'utf8');
  const manifest = JSON.parse(raw);

  assert.equal(typeof manifest.name, 'string');
  assert.ok(manifest.name.length > 0);
  assert.equal(typeof manifest.short_name, 'string');
  assert.ok(manifest.short_name.length > 0);
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, 'needs at least a 192 and a 512 icon');

  const sizesSeen = new Set();
  for (const icon of manifest.icons) {
    assert.match(icon.src, /^\/icons\/.+\.png$/, `icon src should be an /icons/*.png path, got ${icon.src}`);
    assert.match(icon.sizes, /^\d+x\d+$/);
    assert.equal(icon.type, 'image/png');
    const onDisk = path.join(CLIENT_DIR, icon.src);
    assert.ok(fs.existsSync(onDisk), `manifest references ${icon.src} but it doesn't exist on disk`);
    sizesSeen.add(icon.sizes);
  }
  assert.ok(sizesSeen.has('192x192'), 'manifest must list a 192x192 icon');
  assert.ok(sizesSeen.has('512x512'), 'manifest must list a 512x512 icon');
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'manifest must list a maskable icon');

  // Apple doesn't read the manifest for its touch icon — it's a separate <link>, checked below.
  assert.ok(fs.existsSync(path.join(CLIENT_DIR, 'icons', 'apple-touch-icon.png')));
});

test('tools/generate-icons.mjs reproduces the committed icons byte-for-byte', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'gauntlet-icons-'));
  try {
    const written = generateAll(tmp);
    assert.equal(written.length, ICON_SPECS.length);
    for (const spec of ICON_SPECS) {
      const committed = fs.readFileSync(path.join(ICONS_DIR, spec.file));
      const regenerated = fs.readFileSync(path.join(tmp, spec.file));
      assert.ok(
        committed.equals(regenerated),
        `client/icons/${spec.file} does not match a fresh run of tools/generate-icons.mjs — regenerate and commit it`,
      );
      // Sanity-check it's actually a PNG of the size the spec claims (catches a corrupt commit
      // even if some future refactor made the byte-equality check above vacuously true).
      assert.equal(committed.readUInt32BE(16), spec.size, `${spec.file} width`);
      assert.equal(committed.readUInt32BE(20), spec.size, `${spec.file} height`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('every HTML page under client/ carries the PWA head tags', () => {
  const pages = fs.readdirSync(CLIENT_DIR).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length > 0);
  for (const page of pages) {
    const html = fs.readFileSync(path.join(CLIENT_DIR, page), 'utf8');
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/, `${page} missing manifest link`);
    assert.match(html, /<meta name="theme-color" content="#0b0b12" \/>/, `${page} missing theme-color`);
    assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes" \/>/, `${page} missing apple-mobile-web-app-capable`);
    assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" \/>/, `${page} missing status bar style`);
    assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png" \/>/, `${page} missing apple-touch-icon`);
    assert.match(html, /<script type="module" src="\/pwa\.js"><\/script>/, `${page} missing pwa.js registration script`);
  }
});

test('the server serves manifest.webmanifest and sw.js with correct MIME/caching headers', async () => {
  const server = await startServer();
  const { baseUrl } = server;
  try {
    const manifestRes = await fetch(baseUrl + '/manifest.webmanifest');
    assert.equal(manifestRes.status, 200);
    assert.equal(manifestRes.headers.get('content-type'), 'application/manifest+json');
    // Never let a stale manifest survive an icon/name change.
    assert.equal(manifestRes.headers.get('cache-control'), 'no-cache');

    const swRes = await fetch(baseUrl + '/sw.js');
    assert.equal(swRes.status, 200);
    assert.match(swRes.headers.get('content-type'), /javascript/);
    // A new deploy's worker must never be masked by a cached old one.
    assert.equal(swRes.headers.get('cache-control'), 'no-cache');

    const swRulesRes = await fetch(baseUrl + '/sw-rules.js');
    assert.equal(swRulesRes.status, 200);

    const pwaRes = await fetch(baseUrl + '/pwa.js');
    assert.equal(pwaRes.status, 200);

    for (const icon of ['icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png']) {
      const res = await fetch(`${baseUrl}/icons/${icon}`);
      assert.equal(res.status, 200, `GET /icons/${icon}`);
      assert.equal(res.headers.get('content-type'), 'image/png');
    }
  } finally {
    await server.stop();
  }
});

test('sw-rules: isNetworkOnly/shouldHandle never let /api, /ws or /sw.js be cached', () => {
  const get = (url, extra = {}) => ({ method: 'GET', url, ...extra });

  for (const url of ['/api/register', '/api/levels/generate', '/api/heroes/anything', '/ws', '/sw.js']) {
    assert.equal(isNetworkOnly(get(url)), true, `${url} should be network-only`);
    assert.equal(shouldHandle(get(url)), false, `${url} should never be handled by the cache`);
  }

  // A WebSocket upgrade is network-only regardless of path, if a real Request ever surfaced one.
  const wsUpgrade = { method: 'GET', url: '/some-other-path', headers: { get: (k) => (k.toLowerCase() === 'upgrade' ? 'websocket' : null) } };
  assert.equal(isNetworkOnly(wsUpgrade), true);
  assert.equal(shouldHandle(wsUpgrade), false);

  // Ordinary shell assets are handled.
  for (const url of ['/', '/index.html', '/style.css', '/game.js', '/shared/constants.js', '/icons/icon-192.png']) {
    assert.equal(isNetworkOnly(get(url)), false, `${url} should not be network-only`);
    assert.equal(shouldHandle(get(url)), true, `${url} should be handled (cache-first)`);
  }

  // POST/PUT/DELETE responses are never cached, even on an otherwise-cacheable path.
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal(shouldHandle(get('/', { method })), false, `${method} / must not be cached`);
  }
});

test('PRECACHE_URLS covers every client and shared module, so an offline reload can never miss an import', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const clientJs = fs.readdirSync(path.join(root, 'client')).filter((f) => f.endsWith('.js') && f !== 'sw.js').map((f) => `/${f}`);
  const sharedJs = fs.readdirSync(path.join(root, 'shared')).filter((f) => f.endsWith('.js')).map((f) => `/shared/${f}`);
  const html = fs.readdirSync(path.join(root, 'client')).filter((f) => f.endsWith('.html')).map((f) => `/${f}`);
  const set = new Set(PRECACHE_URLS);
  for (const url of [...clientJs, ...sharedJs, ...html]) assert.ok(set.has(url), `${url} is missing from PRECACHE_URLS`);
  assert.equal(set.has('/sw.js'), false, 'the worker script itself must never be precached');
  // And nothing listed points at a file that does not exist (a typo would make cache.addAll()
  // reject and the install fail wholesale).
  for (const url of PRECACHE_URLS) {
    if (url === '/') continue;
    // /shared/* is served from the repo's shared/ directory, everything else from client/.
    const file = url.startsWith('/shared/') ? path.join(root, url.slice(1)) : path.join(root, 'client', url.slice(1));
    assert.ok(fs.existsSync(file), `${url} is precached but does not exist on disk`);
  }
});

// client/sw.js caches the precached shell under `gauntlet-shell-${SW_VERSION}` and only clears the
// previous cache in activate() when that name actually changed — so an offline install's stale
// game.js/style.css/etc. only ever gets refreshed by a browser update check that notices *some*
// byte of the registered worker script changed. Bump discipline (README "Install as an app") is
// the only thing standing between a deploy and a shell every returning player is stuck on: nothing
// in the code enforces it. This test is the enforcement — it hashes SW_VERSION together with
// PRECACHE_URLS and the actual bytes of every precached file and pins that to a checked-in fixture,
// so any change to the precached shell (a file's content, or the URL list itself) that isn't paired
// with a SW_VERSION bump fails right here instead of shipping a silently-stale offline shell.
//
// To update after a deliberate shell change: bump SW_VERSION in client/sw.js, then replace
// test/fixtures/sw-shell-hash.json with `{ "version": "<new SW_VERSION>", "hash": "<digest this
// test's failure message prints>" }`.
test('client/sw.js SW_VERSION is pinned to a hash of the precached shell (bump discipline)', () => {
  const swSrc = fs.readFileSync(path.join(CLIENT_DIR, 'sw.js'), 'utf8');
  const versionMatch = swSrc.match(/const SW_VERSION = '([^']+)'/);
  assert.ok(versionMatch, 'could not find `const SW_VERSION = \'...\'` in client/sw.js');
  const version = versionMatch[1];

  const digest = createHash('sha256');
  digest.update(version);
  digest.update(JSON.stringify(PRECACHE_URLS));
  for (const url of PRECACHE_URLS) {
    if (url === '/') continue; // same bytes as /index.html on disk, already hashed once
    const file = url.startsWith('/shared/') ? path.join(ROOT, url.slice(1)) : path.join(CLIENT_DIR, url.slice(1));
    digest.update(fs.readFileSync(file));
  }
  const hash = digest.digest('hex');

  const fixturePath = path.join(ROOT, 'test', 'fixtures', 'sw-shell-hash.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  assert.equal(fixture.version, version,
    `client/sw.js's SW_VERSION ("${version}") doesn't match the version this fixture was recorded for `
    + `("${fixture.version}") — update ${path.relative(ROOT, fixturePath)} to { "version": "${version}", "hash": "${hash}" }.`);
  assert.equal(fixture.hash, hash,
    `the precached shell changed (a file in PRECACHE_URLS, or its content) but SW_VERSION in client/sw.js `
    + `was not bumped. Bump SW_VERSION, then set ${path.relative(ROOT, fixturePath)} to `
    + `{ "version": "<new SW_VERSION>", "hash": "${hash}" }.`);
});
