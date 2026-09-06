// PWA service worker (#33): precaches the static app shell so the lobby, dashboard, editor and
// hero builder still load offline after a first visit. Registered as a module worker (`{ type:
// 'module' }` in client/pwa.js) so it can import the routing rules — shared with
// test/pwa.test.js — from ./sw-rules.js instead of duplicating them here.
//
// Strategy: cache-first for the precached shell, network-first-with-offline-fallback for page
// navigations, and — per shouldHandle()/isNetworkOnly() in ./sw-rules.js — the REST API, the
// WebSocket upgrade and this file itself are never intercepted at all. POST/PUT/DELETE responses
// are never written to the cache even for an otherwise-cacheable path.
import { shouldHandle, versionedUrl, PRECACHE_URLS } from './sw-rules.js';

// Bump this whenever the precached shell changes for a reason *other* than the asset fingerprint
// below, so activate() drops the previous cache instead of serving stale assets forever. Plain
// string constant — there's no build step to stamp one in.
const SW_VERSION = 'v18';

// Cache-busting (#38): server/index.js replaces this literal token with its running
// ASSET_VERSION every time it serves /sw.js — see serveStatic()'s special-case for this one path.
// That means these bytes, and therefore the whole worker script, change on *every* deploy, which
// is what makes the browser's own update check notice a new build even when nothing else about
// sw.js changed. Precaching with the matching `?v=` (below) means every precached asset URL is
// now exactly what a versioned page/module reference resolves to, so a plain, unqualified
// caches.match(request) finds it — no need to ignoreSearch and risk matching an older cached
// ?v= (or an unversioned URL Cloudflare could itself have served stale for up to four hours).
const ASSET_VERSION = '__ASSET_VERSION__';
const CACHE_NAME = `gauntlet-shell-${SW_VERSION}-${ASSET_VERSION}`;

// PRECACHE_URLS (the static app shell) is defined in ./sw-rules.js so the unit tests can pin it
// to the real file set; see the comment there. versionedUrl() (also from ./sw-rules.js, the same
// helper server/assets.js uses) leaves an HTML page or image URL alone and appends `?v=` to a
// .js/.css/.webmanifest one — i.e. exactly the URLs a versioned page actually requests.
const VERSIONED_PRECACHE_URLS = PRECACHE_URLS.map((u) => versionedUrl(u, ASSET_VERSION));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(VERSIONED_PRECACHE_URLS);
    await self.skipWaiting(); // don't wait for every tab to close before an update takes over
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
    await self.clients.claim();
    // Tell already-open tabs a new version just took over so pwa.js can show its "reload?" toast.
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) client.postMessage({ type: 'gauntlet-sw-updated', version: SW_VERSION });
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!shouldHandle(request)) return; // /api/*, /ws, /sw.js itself: leave untouched for the browser

  if (request.mode === 'navigate') {
    // Navigations: prefer the live network (so a player online always gets the current lobby),
    // falling back to the cached page — then the cached home page — only once offline. Page URLs
    // are never versioned (see versionedUrl()) but do carry app queries (`/?room=abc`, `?touch=1`),
    // and the precache holds only the bare paths, so ignore the query here. That is safe for
    // pages precisely because they are not content-addressed; assets below must match exactly.
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cached = await caches.match(request, { ignoreSearch: true });
        return cached || (await caches.match('/index.html'));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    // An exact match: VERSIONED_PRECACHE_URLS was populated with the same `?v=<ASSET_VERSION>`
    // the server stamps onto the page's own asset links, so a versioned request for a precached
    // file lands on exactly the entry it was installed under — never an older cached ?v=, and
    // never an unversioned URL Cloudflare might itself be serving stale.
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
      // Awaited on purpose: a fire-and-forget put() races an immediate offline reload, which
      // could then miss a module cached "a moment later" and fail to import it.
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
