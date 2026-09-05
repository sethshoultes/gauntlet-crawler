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
