// Optional Sentry (or any DSN-compatible envelope endpoint) error forwarding, gated entirely on
// SENTRY_DSN. Unset: `enabled()` is false, `captureError()` is a no-op, and `@sentry/node` is
// never imported -- the game has zero Sentry footprint by default. Set: `server/log.js` `error()`
// and `POST /api/client-errors` (server/index.js, via `log.recordClientError`) both forward here.
//
// @sentry/node's default setup pulls in a full OpenTelemetry auto-instrumentation stack meant for
// request tracing (it patches `http`, `console`, etc. via `import-in-the-middle`). We want none of
// that -- `captureError` sends one manually-built event per call, nothing automatic -- so init()
// below explicitly disables tracing and default integrations (`tracesSampleRate: 0`,
// `defaultIntegrations: false`, `integrations: []`). That keeps the SDK to "build an envelope and
// POST it", which is also what makes it swappable for the hand-rolled fallback described below.

let sentryPromise = null;
/** Lazily import and initialize @sentry/node. Only ever called when enabled() is true; the
 *  promise is cached so init() runs exactly once no matter how many errors are reported. */
function loadSentry() {
  if (!sentryPromise) {
    sentryPromise = import('@sentry/node').then((Sentry) => {
      Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.SENTRY_ENVIRONMENT || 'production',
        tracesSampleRate: 0,
        defaultIntegrations: false,
        integrations: [],
        beforeSend: scrubEvent,
      });
      return Sentry;
    });
  }
  return sentryPromise;
}

/** True when SENTRY_DSN is set. Callers (server/log.js, server/index.js) use this to decide
 *  whether to mention Sentry at all -- it's also what GET /api/health reports as `sentry`. */
export function enabled() {
  return Boolean(process.env.SENTRY_DSN);
}

// Any key matching this, at any depth, is dropped before an event leaves the process: auth
// headers/tokens, session cookies, passwords, and IP addresses. This is a name-pattern backstop
// over *whatever* shape `fields` happens to have -- the fixed fields we forward on purpose
// (message, stack, url, source, a coarse browser family) are handled explicitly below and never
// carry these names.
const SENSITIVE_KEY = /token|authorization|cookie|password|ip/i;

/** Deep-copy `value`, dropping every object key whose name matches SENSITIVE_KEY. Never mutates
 *  the input. Exported so it can be unit-tested directly, independent of Sentry being installed. */
export function scrub(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map((v) => scrub(v, seen));
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) continue;
      out[k] = scrub(v, seen);
    }
    return out;
  }
  return value;
}

/** Sentry `beforeSend` hook: scrub the parts of the event *Sentry itself* populates (request
 *  headers/cookies, user identity, runtime contexts) in addition to whatever we hand it via
 *  captureError's `fields` (already scrubbed before it reaches `scope.setExtras`, see below) --
 *  belt and suspenders against a future default integration reintroducing raw request data. */
function scrubEvent(event) {
  if (event.request) event.request = scrub(event.request);
  if (event.contexts) event.contexts = scrub(event.contexts);
  if (event.extra) event.extra = scrub(event.extra);
  delete event.user; // never send a user identity to a third party
  return event;
}

// Coarse browser family only -- "Chrome" / "Firefox" / "Safari" / "Edge" / "Other" -- never the
// raw User-Agent string, which fingerprints OS, device and exact version.
function browserFamily(ua) {
  const s = String(ua || '');
  if (!s) return undefined;
  if (/Edg\//.test(s)) return 'Edge';
  if (/Chrome\//.test(s)) return 'Chrome';
  if (/Firefox\//.test(s)) return 'Firefox';
  if (/Safari\//.test(s) && !/Chrome/.test(s)) return 'Safari';
  return 'Other';
}

/**
 * Forward one error to Sentry. No-op -- and imports nothing -- unless SENTRY_DSN is set. Never
 * throws: a bad DSN or a Sentry outage must not affect the caller, matching the "never throws"
 * contract `server/log.js` `error()` already has.
 * @param {string} msg
 * @param {object} [fields] same shape server/log.js already builds. `stack` becomes the event's
 *   exception (so Sentry groups by it); `source` ('client'|'server') and a coarse `ua` browser
 *   family become tags; `url` and everything else become extras -- all scrubbed for keys matching
 *   token/authorization/cookie/password/ip first. Raw `ua` and any `userId`-shaped identifier are
 *   never sent as-is: `ua` is reduced to a browser family, and `userId`/`user_id` fall under the
 *   generic key scrub already (case-insensitive `ip`/`token`/etc. substrings aside, an id alone
 *   isn't scrubbed by name -- callers should not pass a username/email in `fields`).
 */
export function captureError(msg, fields = {}) {
  if (!enabled()) return;
  // The whole synchronous half is wrapped too, not just the async Sentry call below: `fields` is
  // whatever a caller's error path happened to build (server/log.js already guards its own calls,
  // but this module's contract -- never throws -- must hold on its own, for any caller, including a
  // malformed/non-object `fields`) -- e.g. an explicit `null` would otherwise throw destructuring it.
  try {
    const safeFields = fields && typeof fields === 'object' ? fields : {};
    const { stack, ua, source, url, ...rest } = safeFields;
    const tags = { source: source === 'client' ? 'client' : 'server' };
    const browser = browserFamily(ua);
    if (browser) tags.browser = browser;
    const extra = scrub(url ? { ...rest, url } : rest);
    loadSentry().then((Sentry) => {
      Sentry.withScope((scope) => {
        scope.setTags(tags);
        scope.setExtras(extra);
        if (stack) {
          const err = new Error(String(msg || 'Error'));
          err.stack = String(stack);
          Sentry.captureException(err);
        } else {
          Sentry.captureMessage(String(msg || 'Error'), 'error');
        }
      });
    }).catch(() => { /* init or network failure must never affect the caller */ });
  } catch { /* malformed input must never affect the caller -- this function must never throw */ }
}

/** Flush any queued Sentry events before the process exits. No-op when disabled. Exported for
 *  tests and for a graceful-shutdown hook; ordinary calls to captureError are fire-and-forget. */
export async function flush(timeoutMs = 2000) {
  if (!enabled() || !sentryPromise) return;
  const Sentry = await sentryPromise;
  await Sentry.flush(timeoutMs);
}
