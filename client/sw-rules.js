// Pure routing rules for the PWA service worker (client/sw.js), factored into their own
// dependency-free module so test/pwa.test.js can assert the "never cache the REST API, the
// WebSocket upgrade, or the worker script itself" invariant as plain function calls, without
// spinning up a real ServiceWorkerGlobalScope/CacheStorage.
//
// Accepts either a real Fetch API Request (as seen inside the service worker's 'fetch' handler)
// or a plain { method, url, headers } object (as the unit tests pass) — both shapes expose the
// same fields this module reads.

const NEVER_CACHE_EXACT = new Set(['/sw.js']);
const NEVER_CACHE_PREFIXES = ['/api/', '/ws'];

function pathOf(request) {
  return new URL(request.url, 'http://localhost').pathname;
}

function isWebSocketUpgrade(request) {
  const headers = request && request.headers;
  if (!headers) return false;
  const value = typeof headers.get === 'function' ? headers.get('upgrade') : headers.upgrade;
  return typeof value === 'string' && value.toLowerCase() === 'websocket';
}

/** True when a request must always go straight to the network: the REST API, the WebSocket
 * upgrade, and the service worker script itself (so a new deploy's worker is always fetched
 * fresh, never masked by a stale cached copy of the old one). */
export function isNetworkOnly(request) {
  const path = pathOf(request);
  if (NEVER_CACHE_EXACT.has(path)) return true;
  if (NEVER_CACHE_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  return isWebSocketUpgrade(request);
}

/** True when the service worker's cache-first handling applies to this request at all. Only
 * cacheable GETs that aren't network-only qualify — POST/PUT/DELETE responses are never put in
 * the cache, even for an otherwise-cacheable path. */
export function shouldHandle(request) {
  const method = (request && request.method) || 'GET';
  if (method !== 'GET') return false;
  return !isNetworkOnly(request);
}

// Extensions the server fingerprints with `?v=<ASSET_VERSION>` — .js, .css, and the web app
// manifest. server/assets.js imports versionedUrl() below rather than keeping its own copy of this
// rule, so "which URLs get a version suffix, and what that suffix looks like" is defined exactly
// once and can never drift out of sync between the two sides of this cache-busting scheme.
const VERSIONABLE_EXT_RE = /\.(js|css|webmanifest)$/i;

/**
 * Append `?v=<v>` to `url` if it's one of the extensions the server versions and doesn't already
 * carry a query string; every other URL — an HTML page, an image, or `/sw.js` itself (which the
 * browser must always refetch unversioned to notice a new deploy at all) — comes back unchanged.
 * Pure, and shared by both sides of the fingerprinting scheme: server/assets.js's HTML/JS
 * rewriters call it per same-origin attribute/specifier they find, and client/sw.js maps it over
 * PRECACHE_URLS so the shell it installs is addressed exactly the way the server serves it.
 */
export function versionedUrl(url, v) {
  if (!url || url === '/sw.js' || url.includes('?')) return url;
  return VERSIONABLE_EXT_RE.test(url) ? `${url}?v=${v}` : url;
}

/** The static app shell precached at install. Lives here (not in sw.js, which needs a
 * ServiceWorkerGlobalScope) so test/pwa.test.js can pin it to the real file set: every client
 * module under client/ except the worker itself, every shared module, and the static assets the
 * pages need. A module missing from this list is fetched and cached at runtime while online, but
 * an offline reload before that happens would then fail to import it — which is exactly how the
 * lobby broke in CI after layout.js and paint-path.js landed. */
export const PRECACHE_URLS = [
  '/', '/index.html', '/admin.html', '/attract.html', '/cutscenes-demo.html', '/dashboard.html',
  '/editor.html', '/heroes.html', '/settings.html', '/trailer.html',
  '/style.css', '/manifest.webmanifest',
  '/pwa.js', '/sw-rules.js',
  '/admin.js', '/attract-idle.js', '/attract.js', '/audio.js', '/common.js', '/cutscenes.js',
  '/dashboard.js', '/editor.js', '/font.js', '/game.js', '/heroes.js', '/highscore.js', '/input.js',
  '/layout.js', '/paint-path.js', '/pixelsprite.js', '/settings.js', '/sprites.js', '/voice.js',
  '/shared/achievements.js', '/shared/chests.js', '/shared/constants.js', '/shared/hero-builder.js',
  '/shared/level.js', '/shared/procgen.js', '/shared/progression.js', '/shared/rng.js', '/shared/unlocks.js',
  '/audio/voice/manifest.json',
  '/media/title-backdrop.webp', '/media/title-card.webp',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-512-maskable.png', '/icons/apple-touch-icon.png',
];
