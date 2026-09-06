// PWA service worker (#33): precaches the static app shell so the lobby, dashboard, editor and
// hero builder still load offline after a first visit. Registered as a module worker (`{ type:
// 'module' }` in client/pwa.js) so it can import the routing rules — shared with
// test/pwa.test.js — from ./sw-rules.js instead of duplicating them here.
//
// Strategy: cache-first for the precached shell, network-first-with-offline-fallback for page
// navigations, and — per shouldHandle()/isNetworkOnly() in ./sw-rules.js — the REST API, the
// WebSocket upgrade and this file itself are never intercepted at all. POST/PUT/DELETE responses
// are never written to the cache even for an otherwise-cacheable path.
import { shouldHandle, PRECACHE_URLS } from './sw-rules.js';

// Bump this whenever the precached shell changes, so activate() drops the previous cache instead
// of serving stale assets forever. Plain string constant — there's no build step to stamp one in.
const SW_VERSION = 'v4';
const CACHE_NAME = `gauntlet-shell-${SW_VERSION}`;

// PRECACHE_URLS (the static app shell) is defined in ./sw-rules.js so the unit tests can pin it
// to the real file set; see the comment there.

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_URLS);
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
    // falling back to the cached page — then the cached home page — only once offline.
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cached = await caches.match(request);
        return cached || (await caches.match('/index.html'));
      }
    })());
    return;
  }

  event.respondWith((async () => {
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
