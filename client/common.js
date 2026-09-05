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
  nav.innerHTML = `
    <a class="brand" href="/">GAUNTLET CRAWLER</a>
    <a class="nl ${active === 'play' ? 'active' : ''}" href="/">Play</a>
    <a class="nl ${active === 'dashboard' ? 'active' : ''}" href="/dashboard.html">Dashboard</a>
    <a class="nl ${active === 'editor' ? 'active' : ''}" href="/editor.html">Level Builder</a>
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
export function fmtTime(s) { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
export function ago(ts) { const d = Math.floor(Date.now() / 1000 - ts); if (d < 60) return `${d}s ago`; if (d < 3600) return `${Math.floor(d / 60)}m ago`; if (d < 86400) return `${Math.floor(d / 3600)}h ago`; return `${Math.floor(d / 86400)}d ago`; }
