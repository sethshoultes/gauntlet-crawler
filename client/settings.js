import { api, me, renderNav, authModal, setToken, track } from './common.js';

const $ = (s) => document.querySelector(s);
renderNav('settings');

const DEFAULT_KEYS = { up: 'W', down: 'S', left: 'A', right: 'D', fire: 'Space', potion: 'Q' };

function setMsg(text, kind = '') {
  const el = $('#msg'); el.textContent = text || ''; el.className = kind;
}

async function main() {
  const m = await me();
  if (!m.user) {
    $('#guest').style.display = '';
    $('#login').onclick = () => authModal().then((ok) => ok && location.reload());
    return;
  }
  $('#mine').style.display = '';
  $('#uname').textContent = m.user.username;

  const prefs = await api('/api/me/prefs').then((r) => r.prefs || {}).catch(() => ({}));
  const volume = Number.isFinite(prefs.soundVolume) ? prefs.soundVolume : 100;
  $('#p-volume').value = volume;
  $('#p-volume-val').textContent = `${volume}%`;
  $('#p-volume').oninput = () => { $('#p-volume-val').textContent = `${$('#p-volume').value}%`; };
  $('#p-narrator').checked = prefs.narrator !== false;
  $('#p-colorblind').checked = !!prefs.colorBlindPalette;
  $('#p-reduced-motion').checked = !!prefs.reducedMotion;
  const keys = { ...DEFAULT_KEYS, ...(prefs.keyBindings || {}) };
  for (const k of Object.keys(DEFAULT_KEYS)) { const el = $(`#k-${k}`); if (el) el.value = keys[k]; }

  $('#save-prefs').onclick = async () => {
    const keyBindings = {};
    for (const k of Object.keys(DEFAULT_KEYS)) keyBindings[k] = ($(`#k-${k}`).value || DEFAULT_KEYS[k]).trim().slice(0, 12) || DEFAULT_KEYS[k];
    const body = {
      soundVolume: Number($('#p-volume').value),
      narrator: $('#p-narrator').checked,
      colorBlindPalette: $('#p-colorblind').checked,
      reducedMotion: $('#p-reduced-motion').checked,
      keyBindings,
    };
    try {
      await api('/api/me/prefs', { method: 'PUT', body });
      $('#prefs-msg').textContent = 'Saved.'; $('#prefs-msg').style.color = 'var(--green)';
      setTimeout(() => { $('#prefs-msg').textContent = ''; }, 3000);
    } catch (e) { $('#prefs-msg').textContent = e.message; $('#prefs-msg').style.color = 'var(--red)'; }
  };

  $('#change-pw').onclick = async () => {
    const current = $('#cur-pw').value, next = $('#new-pw').value;
    try {
      await api('/api/me/password', { method: 'POST', body: { current, next } });
      $('#cur-pw').value = ''; $('#new-pw').value = '';
      setMsg('Password changed. Your other sessions have been signed out.', 'ok');
    } catch (e) { setMsg(e.message, 'err'); }
  };

  $('#export').onclick = async () => {
    try {
      const data = await api('/api/me/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `gauntlet-crawler-${m.user.username}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(a.href);
    } catch (e) { setMsg(e.message, 'err'); }
  };

  $('#delete-account').onclick = async () => {
    const password = $('#del-pw').value;
    if (!password) { setMsg('Enter your password to confirm.', 'err'); return; }
    if (!confirm('Delete your account permanently? This cannot be undone.')) return;
    try {
      await api('/api/me', { method: 'DELETE', body: { password } });
      track('run_end', { reason: 'account_deleted' });
      setToken(null);
      setMsg('Account deleted. Goodbye, adventurer.', 'ok');
      setTimeout(() => { location.href = '/'; }, 1200);
    } catch (e) { setMsg(e.message, 'err'); }
  };
}

main();
