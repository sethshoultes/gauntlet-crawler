// Arcade three-initial high scores (#14): the all-time top-10 board (GET /api/highscores,
// server/highscores.js) rendered as a plain HTML table for the lobby (client/index.html) and the
// attract loop's data source (client/attract.js still draws it with the bitmap font, but pulls
// from the same fetchHighScores() this module exports); plus the classic name-entry modal shown
// at run end when a Death mode score cracks the top 10 (client/game.js's 'gameover' handler).
import { api, esc } from './common.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Top-10 `{ initials, username, score, class, level_reached, ended_at }[]`, oldest-first on a
 *  tie — never throws, an unreachable server just means an empty board. */
export async function fetchHighScores() {
  try {
    const r = await api('/api/highscores');
    return Array.isArray(r.scores) ? r.scores : [];
  } catch { return []; }
}

function fmtDate(endedAt) {
  if (!endedAt) return '';
  const d = new Date(endedAt * 1000);
  return d.toISOString().slice(0, 10);
}

/** Render the arcade score table into `el` (a plain container — a `<table>` is written into it,
 *  matching the rest of the site's dashboard/leaderboard tables, see client/dashboard.js). */
export function renderHighScoreTable(el, scores) {
  if (!el) return;
  if (!scores || !scores.length) {
    el.innerHTML = '<p class="muted">No high scores yet — be the first!</p>';
    return;
  }
  const rows = scores.map((s, i) => `<tr>
    <td>${i + 1}</td>
    <td class="hs-name">${esc(s.initials || s.username || 'GUEST')}</td>
    <td class="muted">${esc(s.class || '')}</td>
    <td>${(s.score || 0).toLocaleString()}</td>
    <td>${s.level_reached ?? ''}</td>
    <td class="muted">${fmtDate(s.ended_at)}</td>
  </tr>`).join('');
  el.innerHTML = `<table class="hs-table"><tbody>
    <tr><th>#</th><th>Name</th><th>Class</th><th>Score</th><th>Level</th><th>Date</th></tr>
    ${rows}
  </tbody></table>`;
}

/** Fetch-and-render helper for a static container, with a light auto-refresh — used by the lobby
 *  panel below; the attract loop keeps its own canvas refresh loop (client/attract.js) and calls
 *  fetchHighScores() directly instead. */
async function refreshInto(el) {
  renderHighScoreTable(el, await fetchHighScores());
}

// Auto-wire the lobby panel, if this page has one — keeps client/index.html and client/game.js
// from needing to know anything about how the table is fetched or drawn.
(function autoInitLobbyTable() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('lobby-highscores');
  if (!el) return;
  refreshInto(el);
  setInterval(() => refreshInto(el), 30_000);
})();

// ---------------- three-initial entry modal ----------------
/** Very small, poll-based Gamepad support for the modal only (not a general input system — see
 *  client/input.js for that): standard-mapping D-pad/left-stick up/down/left/right plus button 0
 *  ("A"), edge-triggered against the previous poll so a held button doesn't repeat every frame. */
function pollGamepad(prevRef, onAction) {
  let pads;
  try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch { return; }
  if (!pads) return;
  for (const gp of pads) {
    if (!gp) continue;
    const ax = gp.axes || [];
    const pressed = {
      up: !!gp.buttons[12]?.pressed || ax[1] < -0.5,
      down: !!gp.buttons[13]?.pressed || ax[1] > 0.5,
      left: !!gp.buttons[14]?.pressed || ax[0] < -0.5,
      right: !!gp.buttons[15]?.pressed || ax[0] > 0.5,
      confirm: !!gp.buttons[0]?.pressed,
    };
    const prev = prevRef.get(gp.index) || {};
    for (const key of Object.keys(pressed)) if (pressed[key] && !prev[key]) onAction(key);
    prevRef.set(gp.index, pressed);
  }
}

/**
 * Classic arcade "enter your initials" modal: three A-Z slots, Up/Down cycles the active slot's
 * letter, Left/Right moves between slots, Enter (or clicking Confirm, or a gamepad's "A") submits
 * — which POSTs to /api/runs/:id/initials (server/highscores.js), the only place that validates
 * and one-shots the entry. Resolves with the submitted initials, or null if the player dismisses
 * it without a successful submit (e.g. the tab is left open past the server's claim window).
 */
export function showInitialsModal({ runId, score }) {
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'modal-bg hs-modal-bg';
    bg.innerHTML = `<div class="modal hs-modal">
      <h3>High score!</h3>
      <p class="muted" style="margin:0 0 10px;font-size:12px">${(score || 0).toLocaleString()} points cracked the all-time top 10. Enter your initials:</p>
      <div class="hs-slots">
        ${[0, 1, 2].map((i) => `<button type="button" class="hs-slot" data-i="${i}" aria-label="Letter ${i + 1}">A</button>`).join('')}
      </div>
      <p class="help" style="margin-top:10px">&uarr;/&darr; change letter &middot; &larr;/&rarr; move &middot; Enter to confirm</p>
      <div class="row" style="margin-top:10px;justify-content:flex-end">
        <button type="button" id="hs-skip">Skip</button>
        <button type="button" id="hs-confirm" class="primary">Confirm</button>
      </div>
      <div id="hs-err" style="color:var(--red);font-size:12px;margin-top:8px"></div>
    </div>`;
    document.body.appendChild(bg);

    const letters = [0, 0, 0];
    let active = 0;
    let done = false;
    const slots = [...bg.querySelectorAll('.hs-slot')];
    function render() {
      slots.forEach((el, i) => {
        el.textContent = LETTERS[letters[i]];
        el.classList.toggle('active', i === active);
      });
    }
    function move(dActive) { active = (active + dActive + 3) % 3; render(); }
    function cycle(dLetter) { letters[active] = (letters[active] + dLetter + 26) % 26; render(); }
    render();

    async function confirm() {
      if (done) return;
      const initials = letters.map((n) => LETTERS[n]).join('');
      try {
        await api(`/api/runs/${runId}/initials`, { method: 'POST', body: { initials } });
        done = true; cleanup(); resolve(initials);
      } catch (e) {
        bg.querySelector('#hs-err').textContent = e.message || 'Could not save your score';
      }
    }
    function skip() { if (done) return; done = true; cleanup(); resolve(null); }

    function onKey(e) {
      if (e.key === 'ArrowUp') { cycle(1); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { cycle(-1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { move(-1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { move(1); e.preventDefault(); }
      else if (e.key === 'Enter') { confirm(); e.preventDefault(); }
      else if (e.key === 'Escape') { skip(); e.preventDefault(); }
    }
    const gpPrev = new Map();
    const gpTimer = setInterval(() => pollGamepad(gpPrev, (action) => {
      if (action === 'up') cycle(1); else if (action === 'down') cycle(-1);
      else if (action === 'left') move(-1); else if (action === 'right') move(1);
      else if (action === 'confirm') confirm();
    }), 100);

    function cleanup() { window.removeEventListener('keydown', onKey, true); clearInterval(gpTimer); bg.remove(); }
    window.addEventListener('keydown', onKey, true);
    slots.forEach((el, i) => {
      el.onclick = () => { if (active === i) cycle(1); else { active = i; render(); } };
    });
    bg.querySelector('#hs-confirm').onclick = confirm;
    bg.querySelector('#hs-skip').onclick = skip;
  });
}
