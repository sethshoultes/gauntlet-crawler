// Shared client helpers: auth token, API fetch, nav, toasts.
export const TOKEN_KEY = 'gc_token';
export const NAME_KEY = 'gc_guest_name';
export const CLASS_KEY = 'gc_class';
export const PALETTE_KEY = 'gc_palette';

export function token() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
export function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} }

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const t = token(); if (t) headers['Authorization'] = 'Bearer ' + t;
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let meCache = null;
export async function me(force = false) {
  if (meCache && !force) return meCache;
  meCache = await api('/api/me').catch(() => ({ user: null }));
  return meCache;
}

// ---- first-party analytics beacon (server/telemetry.js) ----
// A per-browser id for guests only (never sent for logged-in users, who are already identified by
// their account). Deliberately a *different* key than the game's own `gc_guest_id` — that one is
// server-signed and gates room re-kicks; this one is a throwaway analytics label.
function telemetryGuestId() {
  try {
    let g = localStorage.getItem('gc_telemetry_guest');
    if (!g) {
      g = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem('gc_telemetry_guest', g);
    }
    return g;
  } catch { return null; }
}

/** Fire-and-forget analytics beacon. Never throws, never blocks the caller. */
export function track(kind, data) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    const t = token(); if (t) headers['Authorization'] = 'Bearer ' + t;
    // Only attach the guest analytics id when there's no auth token — a logged-in user is already
    // identified server-side by their bearer token (server/telemetry.js uses `user_id` from it),
    // so tagging their events with guestId too would double-count them in guest metrics.
    const body = { kind, data, ...(t ? {} : { guestId: telemetryGuestId() }) };
    fetch('/api/telemetry', { method: 'POST', headers, keepalive: true, body: JSON.stringify(body) }).catch(() => {});
  } catch {}
}

// ---- client-side error reporting (server/log.js `errors` table) ----
// Deliberately no browser Sentry SDK loaded from a CDN here, even when GET /api/health reports
// `sentry: true` (see server/index.js / server/sentry.js) -- this app has no build step and is
// meant to keep working fully offline/first-party, and a browser SDK would mean an extra
// third-party script origin plus its own network calls straight from the client. Instead the
// existing beacon below (POST /api/client-errors, unchanged) is the only path; the *server*
// decides whether to additionally forward it to Sentry (server/log.js `error()` -> server/sentry.js
// `captureError()`), tagged `source: 'client'`.
const seenClientErrors = new Set();
function reportClientError(message, stack) {
  const key = String(message || 'Error').slice(0, 300);
  if (seenClientErrors.has(key)) return; // dedupe identical messages within this page load
  seenClientErrors.add(key);
  try {
    const headers = { 'Content-Type': 'application/json' };
    const t = token(); if (t) headers['Authorization'] = 'Bearer ' + t;
    fetch('/api/client-errors', {
      method: 'POST', headers, keepalive: true,
      body: JSON.stringify({ message: key, stack: String(stack || '').slice(0, 4000), url: location.href }),
    }).catch(() => {});
  } catch {}
}
let errorHandlersInstalled = false;
function installErrorReporting() {
  if (errorHandlersInstalled || typeof window === 'undefined') return;
  errorHandlersInstalled = true;
  window.addEventListener('error', (e) => reportClientError(e.message || 'Script error', e.error?.stack));
  window.addEventListener('unhandledrejection', (e) => reportClientError(String(e.reason?.message || e.reason || 'Unhandled rejection'), e.reason?.stack));
}
installErrorReporting(); // every page that imports common.js gets these handlers for free

// ---- preferences: merge server-saved prefs (logged-in users) over the localStorage keys the
// game already reads directly (gc_mute, gc_narrate), so game.js needs no changes to pick them up.
export async function loadPrefs() {
  if (!token()) return null;
  const prefs = await api('/api/me/prefs').then((r) => r.prefs).catch(() => null);
  if (!prefs || typeof prefs !== 'object') return prefs;
  try {
    const pct = (v) => Math.max(0, Math.min(100, Number(v) || 0));
    if ('soundVolume' in prefs) {
      localStorage.setItem('gc_mute', Number(prefs.soundVolume) <= 0 ? '1' : '0');
      localStorage.setItem('gc_vol_master', String(pct(prefs.soundVolume)));
    }
    if ('sfxVolume' in prefs) localStorage.setItem('gc_vol_sfx', String(pct(prefs.sfxVolume)));
    if ('voiceVolume' in prefs) localStorage.setItem('gc_vol_voice', String(pct(prefs.voiceVolume)));
    if ('narrator' in prefs) localStorage.setItem('gc_narrate', prefs.narrator === false ? '0' : '1');
    if ('cutscenes' in prefs) localStorage.setItem('gc_cutscenes', prefs.cutscenes === false ? '0' : '1');
  } catch {}
  return prefs;
}

export function toast(title, text, kind = '') {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<div class="t"></div><div class="b"></div>`;
  el.querySelector('.t').textContent = title; el.querySelector('.b').textContent = text || '';
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

export async function renderNav(active) {
  const nav = document.querySelector('nav.top');
  if (!nav) return;
  const m = await me();
  track('pageview', { path: location.pathname });
  if (m.user) loadPrefs().catch(() => {});
  nav.innerHTML = `
    <a class="brand" href="/">GAUNTLET CRAWLER</a>
    <a class="nl ${active === 'play' ? 'active' : ''}" href="/">Play</a>
    <a class="nl ${active === 'dashboard' ? 'active' : ''}" href="/dashboard.html">Dashboard</a>
    <a class="nl ${active === 'editor' ? 'active' : ''}" href="/editor.html">Level Builder</a>
    <a class="nl ${active === 'attract' ? 'active' : ''}" href="/attract.html">Arcade</a>
    ${m.user ? `<a class="nl ${active === 'heroes' ? 'active' : ''}" href="/heroes.html">Heroes</a>` : ''}
    ${m.user ? `<a class="nl ${active === 'settings' ? 'active' : ''}" href="/settings.html">Settings</a>` : ''}
    ${m.isAdmin ? `<a class="nl ${active === 'admin' ? 'active' : ''}" href="/admin.html">Admin</a>` : ''}
    <span class="spacer"></span>
    <span class="who">${m.user ? `Logged in as <b>${esc(m.user.username)}</b>` : 'Playing as guest'}</span>
    ${m.user ? '<button id="nav-logout">Log out</button>' : '<button id="nav-login">Log in / Register</button>'}
  `;
  nav.querySelector('#nav-logout')?.addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); setToken(null); location.reload(); });
  nav.querySelector('#nav-login')?.addEventListener('click', () => authModal().then((ok) => ok && location.reload()));
}

/** Login/register modal. Resolves true if the user logged in. */
export function authModal() {
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal">
      <h3>Enter the dungeon</h3>
      <p class="muted" style="margin:0 0 6px;font-size:12px">An account saves your score, stats, achievements and levels. Guests can still play.</p>
      <label>Name</label><input id="au" maxlength="16" autocomplete="username" />
      <label>Password</label><input id="ap" type="password" autocomplete="current-password" />
      <div class="row" style="margin-top:14px;justify-content:space-between">
        <button id="a-cancel">Cancel</button>
        <span class="row"><button id="a-reg">Register</button><button class="primary" id="a-login">Log in</button></span>
      </div>
      <div id="a-err" style="color:var(--red);font-size:12px;margin-top:8px"></div>
    </div>`;
    document.body.appendChild(bg);
    const done = (ok) => { bg.remove(); resolve(ok); };
    const go = async (path) => {
      try {
        const r = await api(path, { method: 'POST', body: { username: bg.querySelector('#au').value.trim(), password: bg.querySelector('#ap').value } });
        setToken(r.token); meCache = null; done(true);
      } catch (e) { bg.querySelector('#a-err').textContent = e.message; }
    };
    bg.querySelector('#a-cancel').onclick = () => done(false);
    bg.querySelector('#a-reg').onclick = () => go('/api/register');
    bg.querySelector('#a-login').onclick = () => go('/api/login');
    bg.querySelector('#ap').addEventListener('keydown', (e) => { if (e.key === 'Enter') go('/api/login'); });
    bg.querySelector('#au').focus();
  });
}

export function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// `esc()` HTML-escapes for use in text/attribute *values*, but a value dropped straight into a
// `class="..."` attribute (e.g. `cls-${value}`) needs to be a safe CSS class *token*, not merely
// HTML-safe — a class like `custom:123` (Hero Builder custom heroes, see shared/hero-builder.js)
// contains `:`, which is harmless in HTML but not a valid/selectable class-name character. Replace
// anything outside the safe token charset so the resulting class always matches a plain CSS
// selector 1:1 with no escaping needed.
export function cssToken(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '_'); }
export function fmtTime(s) { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
export function ago(ts) { const d = Math.floor(Date.now() / 1000 - ts); if (d < 60) return `${d}s ago`; if (d < 3600) return `${Math.floor(d / 60)}m ago`; if (d < 86400) return `${Math.floor(d / 3600)}h ago`; return `${Math.floor(d / 86400)}d ago`; }
