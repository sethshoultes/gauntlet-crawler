// Cache-busting for static assets (#38). Cloudflare sits in front of production and rewrites the
// origin's `Cache-Control: no-cache` on `.js`/`.css` into its own 4-hour edge TTL — so a fresh
// deploy's `index.html` (still no-cache) can get served alongside up to four hours of stale
// game.js/style.css from the edge, breaking the page in exactly the way #38 describes. Fixing that
// without touching Cloudflare's settings means the origin has to fingerprint every asset URL
// itself: compute one version string at startup, stamp it onto every same-origin script/link the
// server serves, and only let a request carrying the *current* version be cached long-term.
//
// Three pure, dependency-free pieces:
//   - computeAssetVersion(dirs): hashes every file under client/ and shared/ into one short id.
//   - versionHtml(html, v): stamps `?v=<id>` onto same-origin <script src>/<link href> asset refs.
//   - versionJs(source, v): stamps the same query onto same-origin ES module import specifiers.
// server/index.js calls computeAssetVersion() once at startup (ASSET_VERSION) and runs the other
// two over every .html/.js response serveStatic() sends.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// Single source of truth for "which URLs get a ?v= suffix, and what that suffix looks like" —
// shared with client/sw.js (which maps this over PRECACHE_URLS so the service worker's precache
// keys line up with the versioned URLs the server actually serves). client/sw-rules.js is a
// plain dependency-free module, safe to import from either side.
import { versionedUrl } from '../client/sw-rules.js';

/** Recursively list every regular file under `dir`, as paths relative to `dir` using forward
 * slashes (so the result is stable across platforms and matches how these files are served). */
function listFilesRelative(dir) {
  const out = [];
  (function walk(current, relPrefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) out.push(rel);
    }
  })(dir, '');
  return out;
}

/**
 * Compute a short, stable fingerprint of every file under a set of directories: a sha1 over each
 * file's path (prefixed so client/ and shared/ can never collide) and contents, in a fixed sorted
 * order so the result doesn't depend on filesystem readdir ordering.
 *
 * @param {{ dir: string, prefix: string }[]} dirs directories to hash, each with the URL-ish
 *   prefix its files are addressed under (e.g. `{ dir: '.../client', prefix: '' }`,
 *   `{ dir: '.../shared', prefix: 'shared/' }`).
 * @returns {string} the first 12 hex characters of the sha1 digest.
 */
export function computeAssetVersion(dirs) {
  const entries = [];
  for (const { dir, prefix = '' } of dirs) {
    for (const rel of listFilesRelative(dir)) {
      entries.push({ key: prefix + rel, abs: path.join(dir, rel) });
    }
  }
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const hash = crypto.createHash('sha1');
  for (const { key, abs } of entries) {
    // Length-prefix and NUL-delimit each (path, bytes) pair so the concatenated stream is
    // unambiguous: without separators, different path/content splits could hash identically.
    const bytes = fs.readFileSync(abs);
    hash.update(`${key.length}:${key}\0${bytes.length}:`);
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

// A same-origin asset reference eligible for versioning: root-relative (starts with a single
// '/', never '//' — that's protocol-relative and points off-origin) and has no '#' fragment.
// Whether its extension actually qualifies (.js/.css/.webmanifest) and whether it's `/sw.js` (the
// browser must always re-fetch that one unversioned to notice a new deploy at all) is
// versionedUrl()'s call, not duplicated here — see the import above.
function isSameOriginUrl(url) {
  if (!url || url.includes('#')) return false;
  return url.startsWith('/') && !url.startsWith('//');
}

const HTML_TAG_RE = /<(script|link)\b([^>]*)>/gi;
const HTML_ATTR_RE = /([\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttrs(attrStr) {
  const attrs = {};
  HTML_ATTR_RE.lastIndex = 0;
  let m;
  while ((m = HTML_ATTR_RE.exec(attrStr))) {
    attrs[m[1].toLowerCase()] = { value: m[3] !== undefined ? m[3] : m[4], quote: m[3] !== undefined ? '"' : "'" };
  }
  return attrs;
}

/**
 * Rewrite same-origin static-asset references in a served HTML page so they carry `?v=<v>`:
 * `<script src="/x.js">`, `<link href="/x.css">`, `<link href="/manifest.webmanifest">` and any
 * `<link rel="modulepreload" href="...">` — but only when that href's extension is one
 * versionedUrl() actually versions (.js/.css/.webmanifest); a modulepreload pointed at some other
 * extension is left alone, same as everywhere else in this module. Never touches `/sw.js`, an
 * external URL, or a URL that already carries a query string.
 */
export function versionHtml(html, v) {
  return html.replace(HTML_TAG_RE, (full, tagName, attrStr) => {
    const attrs = parseAttrs(attrStr);
    const lower = tagName.toLowerCase();
    let attr;
    if (lower === 'script') {
      attr = attrs.src;
      if (!attr || !/\.js$/i.test(attr.value)) return full;
    } else {
      attr = attrs.href;
      if (!attr) return full;
      const rel = (attrs.rel?.value || '').toLowerCase().split(/\s+/);
      if (!rel.includes('modulepreload') && !/\.(css|webmanifest)$/i.test(attr.value)) return full;
    }
    if (!isSameOriginUrl(attr.value)) return full;
    const versioned = versionedUrl(attr.value, v);
    if (versioned === attr.value) return full; // /sw.js, an unversioned extension, or an existing query
    const original = `${attr.quote}${attr.value}${attr.quote}`;
    const replaced = `${attr.quote}${versioned}${attr.quote}`;
    return full.replace(original, replaced);
  });
}

// A JS import specifier eligible for versioning: relative (`./`, `../`) or root-absolute (`/...`,
// never `//` — that's protocol-relative, off-origin). Whether its extension/query/`/sw.js`-ness
// actually qualifies is versionedUrl()'s call, same as isSameOriginUrl() above for HTML.
function isRelativeOrRootAbsoluteSpecifier(spec) {
  if (!spec || spec.includes('#')) return false;
  if (spec.startsWith('./') || spec.startsWith('../')) return true;
  return spec.startsWith('/') && !spec.startsWith('//');
}

function rewriteSpecifiers(source, v, regex) {
  return source.replace(regex, (match, prefix, quote, spec) => {
    if (!isRelativeOrRootAbsoluteSpecifier(spec)) return match;
    const versioned = versionedUrl(spec, v);
    if (versioned === spec) return match; // /sw.js, an unversioned extension, or an existing query
    return `${prefix}${quote}${versioned}${quote}`;
  });
}

// Order matters: the dynamic-import pattern must run before the bare-import pattern so
// `import('/x.js')` is never mistaken for a side-effect `import '/x.js'` (it can't be — `import(`
// has no space before the paren — but running dynamic first keeps that invariant explicit rather
// than relying on the space in `\bimport\s+` to save us).
const FROM_CLAUSE_RE = /\b(from\s+)(['"])([^'"]*)\2/g; // import X from '...'; export {a} from '...'; export * from '...'
const DYNAMIC_IMPORT_RE = /(import\s*\(\s*)(['"])([^'"]*)\2/g; // import('...') — never import.meta, which has no '(' or quote here
const BARE_IMPORT_RE = /\b(import\s+)(['"])([^'"]*)\2/g; // side-effect import '...' (no braces/from/parens)

/**
 * Rewrite same-origin ES module import specifiers in served JS so they carry `?v=<v>`: static
 * `import ... from '...'`/`export ... from '...'`, dynamic `import('...')`, and bare side-effect
 * `import '...'`. Only relative (`./`, `../`) or root-absolute (`/...`) specifiers whose extension
 * versionedUrl() actually versions (.js in practice — every import in this codebase) are touched;
 * bare package specifiers, external URLs, `import.meta`, and `/sw.js` are left alone — e.g.
 * `navigator.serviceWorker.register('/sw.js')` is a method call, not an import, so it's never
 * matched by any of these patterns in the first place.
 */
export function versionJs(source, v) {
  let out = source;
  out = rewriteSpecifiers(out, v, FROM_CLAUSE_RE);
  out = rewriteSpecifiers(out, v, DYNAMIC_IMPORT_RE);
  out = rewriteSpecifiers(out, v, BARE_IMPORT_RE);
  return out;
}
