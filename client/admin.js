// Admin dashboard UI (/admin.html): live server overview, rooms, users, levels, error feed and
// analytics charts. Talks to /api/admin/* (server/admin.js); shows an access-denied message for
// a logged-in non-admin instead of the dashboard.
import { api, me, renderNav, esc, ago } from './common.js';

const $ = (s) => document.querySelector(s);
renderNav('admin');

/** Minimal inline-SVG bar chart — no external libs. `rows` is [{label, value}]. */
function barChart(rows, { width = 720, barH = 20, gap = 6, color = 'var(--yellow)' } = {}) {
  if (!rows.length) return '<p class="muted" style="font-size:12px">No data yet.</p>';
  const max = Math.max(1, ...rows.map((r) => r.value));
  const labelW = 130;
  const chartW = width - labelW - 50;
  const height = rows.length * (barH + gap);
  const bars = rows.map((r, i) => {
    const y = i * (barH + gap);
    const w = Math.max(1, Math.round((r.value / max) * chartW));
    return `
      <text x="${labelW - 8}" y="${y + barH * 0.7}" text-anchor="end" font-size="11" fill="var(--muted)">${esc(String(r.label))}</text>
      <rect x="${labelW}" y="${y}" width="${w}" height="${barH - 4}" fill="${color}"></rect>
      <text x="${labelW + w + 6}" y="${y + barH * 0.7}" font-size="11" fill="var(--text)">${r.value.toLocaleString()}</text>
    `;
  }).join('');
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
}

function tableRows(cols, rows, render) {
  return `<thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(render).join('') || `<tr><td colspan="${cols.length}" class="muted">Nothing here.</td></tr>`}</tbody>`;
}

async function loadOverview() {
  const d = await api('/api/admin/overview');
  $('#ov-stats').innerHTML = `
    <div class="stat"><div class="v">${d.users.toLocaleString()}</div><div class="l">Users</div></div>
    <div class="stat"><div class="v">${d.runs.toLocaleString()}</div><div class="l">Runs</div></div>
    <div class="stat"><div class="v">${d.levels.toLocaleString()}</div><div class="l">Levels</div></div>
    <div class="stat"><div class="v">${d.rooms.length}</div><div class="l">Rooms live</div></div>
  `;
  $('#ov-rooms').innerHTML = tableRows(
    ['Room', 'Mode', 'State', 'Players', 'Visibility', ''],
    d.rooms,
    (r) => `<tr>
      <td>${esc(r.name)}</td><td>${esc(r.mode)}</td><td>${esc(r.state)}</td><td>${r.players} / ${r.max}</td>
      <td><span class="badge ${r.public ? 'pub' : 'priv'}">${r.public ? 'Public' : 'Private'}</span></td>
      <td><button data-close="${esc(r.id)}">Close</button></td>
    </tr>`,
  );
  $('#ov-rooms').querySelectorAll('[data-close]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Close this room? Everyone in it will be disconnected.')) return;
      await api(`/api/admin/rooms/${btn.dataset.close}/close`, { method: 'POST' }).catch((e) => alert(e.message));
      loadOverview();
    };
  });
}

async function loadUsers(search = '') {
  const d = await api(`/api/admin/users?search=${encodeURIComponent(search)}`);
  $('#users-table').innerHTML = tableRows(
    ['ID', 'Username', 'Created', 'Rank', 'XP', 'Last run'],
    d.users,
    (u) => `<tr><td>${u.id}</td><td>${esc(u.username)}</td><td>${ago(u.created_at)}</td><td>${u.rank} · ${esc(u.rankTitle)}</td><td>${(u.xp || 0).toLocaleString()}</td><td>${u.last_run ? ago(u.last_run) : '—'}</td></tr>`,
  );
}

async function loadLevels(search = '') {
  const d = await api(`/api/admin/levels?search=${encodeURIComponent(search)}`);
  $('#levels-table').innerHTML = tableRows(
    ['ID', 'Name', 'Author', 'Status', 'Plays', 'Updated', ''],
    d.levels,
    (l) => `<tr>
      <td>${l.id}</td><td>${esc(l.name)}</td><td>${esc(l.author)}</td>
      <td><span class="badge ${l.published ? 'pub' : 'priv'}">${l.published ? 'Published' : 'Unpublished'}</span></td>
      <td>${l.plays}</td><td>${ago(l.updated_at)}</td>
      <td>${l.published ? `<button data-unpub="${l.id}">Unpublish</button>` : ''}<button data-del="${l.id}" class="danger">Delete</button></td>
    </tr>`,
  );
  $('#levels-table').querySelectorAll('[data-unpub]').forEach((btn) => {
    btn.onclick = async () => { await api(`/api/admin/levels/${btn.dataset.unpub}/unpublish`, { method: 'POST' }).catch((e) => alert(e.message)); loadLevels($('#level-search').value); };
  });
  $('#levels-table').querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Delete this level permanently?')) return;
      await api(`/api/admin/levels/${btn.dataset.del}`, { method: 'DELETE' }).catch((e) => alert(e.message));
      loadLevels($('#level-search').value);
    };
  });
}

async function loadErrors() {
  const d = await api('/api/admin/errors');
  $('#errors-table').innerHTML = tableRows(
    ['When', 'Source', 'Message', 'URL', 'User', ''],
    d.errors,
    (e) => `<tr><td>${ago(e.ts)}</td><td>${esc(e.source)}</td><td>${esc(e.message)}</td><td class="muted">${esc(e.url || '')}</td><td>${e.user_id || '—'}</td>
      <td>${e.stack ? `<button data-stack="${e.id}">Stack</button>` : ''}</td></tr>`,
  );
  $('#errors-table').querySelectorAll('[data-stack]').forEach((btn) => {
    const row = d.errors.find((e) => String(e.id) === btn.dataset.stack);
    btn.onclick = () => alert(row?.stack || 'No stack trace.');
  });
}

async function loadAnalytics() {
  const d = await api('/api/admin/analytics');
  $('#chart-dau').innerHTML = barChart(d.dau.map((r) => ({ label: r.day, value: r.n })), { color: 'var(--blue)' })
    + '<p class="muted" style="font-size:11px;margin-top:6px">Guests (separate id, no account): ' + d.guestDau.reduce((s, r) => s + r.n, 0).toLocaleString() + ' guest-days</p>';
  $('#chart-runs').innerHTML = barChart(d.runsPerDay.map((r) => ({ label: r.day, value: r.n })), { color: 'var(--green)' });
  $('#avg-run-length').textContent = `${Math.round(d.avgRunLength)}s`;
  $('#chart-depth').innerHTML = barChart(d.depthHist.map((r) => ({ label: `Lv ${r.bucket}-${r.bucket + 4}`, value: r.n })), { color: 'var(--purple)' });
  $('#chart-heroes').innerHTML = barChart(d.heroPickRates.map((r) => ({ label: r.class, value: r.n })), { color: 'var(--orange)' });
  $('#top-levels').innerHTML = tableRows(
    ['Level', 'Author', 'Plays'], d.topLevels,
    (l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.author)}</td><td>${l.plays}</td></tr>`,
  );
}

const LOADERS = { overview: loadOverview, users: () => loadUsers($('#user-search').value), levels: () => loadLevels($('#level-search').value), errors: loadErrors, analytics: loadAnalytics };

function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === name));
  document.querySelectorAll('.tabpage').forEach((p) => p.classList.toggle('on', p.id === `page-${name}`));
  LOADERS[name]?.().catch((e) => console.error(e));
}

async function main() {
  const m = await me();
  if (!m.isAdmin) { $('#denied').style.display = ''; return; }
  $('#app').style.display = '';
  document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.t); });
  let searchTimer = null;
  $('#user-search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadUsers($('#user-search').value), 250); };
  $('#level-search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadLevels($('#level-search').value), 250); };
  showTab('overview');
}

main();
