import { api, me, renderNav, authModal, esc, fmtTime, ago } from './common.js';
import { CLASSES } from '/shared/constants.js';
import { progressionFor } from '/shared/progression.js';

const $ = (s) => document.querySelector(s);
renderNav('dashboard');

const STAT_LABELS = [
  ['best_score', 'Best score'], ['deepest_level', 'Deepest level'], ['levels_cleared', 'Levels cleared'], ['kills', 'Monsters slain'],
  ['xp', 'Experience'], ['kills_ghost', 'Ghosts'], ['kills_grunt', 'Grunts'], ['kills_demon', 'Demons'], ['generators', 'Generators destroyed'],
  ['treasure', 'Treasure'], ['food', 'Food eaten'], ['food_shot', 'Food shot'], ['doors', 'Doors opened'], ['secrets', 'Secrets found'],
  ['potions', 'Potions used'], ['deaths', 'Deaths'], ['coins', 'Coins inserted'], ['no_death_clears', 'Best no-death streak'],
  ['speed_clears', 'Speed clears'], ['pacifist_clears', 'Pacifist clears'], ['squad_clears', 'Full-party clears'], ['solo_clears', 'Solo clears'],
  ['ai_levels', 'AI levels made'], ['levels_published', 'Levels published'], ['level_plays', 'Plays of my levels'], ['seconds_played', 'Time played'],
];

const PERK_LABELS = (perks) => {
  const out = [];
  if (perks.speedMul > 1) out.push(`+${Math.round((perks.speedMul - 1) * 100)}% speed`);
  if (perks.shotDamageAdd) out.push(`+${perks.shotDamageAdd} shot damage`);
  if (perks.damageTakenMul < 1) out.push(`-${Math.round((1 - perks.damageTakenMul) * 100)}% damage taken`);
  if (perks.maxHealthBonus) out.push(`+${perks.maxHealthBonus} max health`);
  if (perks.magicAdd) out.push(`+${perks.magicAdd} magic`);
  return out;
};

async function main() {
  const m = await me();
  if (!m.user) {
    $('#guest').style.display = '';
    $('#login').onclick = () => authModal().then((ok) => ok && location.reload());
  } else {
    $('#mine').style.display = '';
    $('#uname').textContent = m.user.username;
    const s = m.stats || {};
    const prog = progressionFor(s.xp || 0);
    $('#rank').textContent = `Rank ${prog.rank} · ${prog.title}`;
    $('#prog-title').textContent = `Rank ${prog.rank}: ${prog.title}`;
    $('#prog-xp').textContent = `${prog.xp.toLocaleString()} XP`;
    $('#prog-bar-fill').style.width = `${Math.round(prog.progress * 100)}%`;
    $('#prog-next').textContent = prog.nextRank
      ? `${Math.max(0, prog.xpForNextRank - prog.xpIntoRank).toLocaleString()} XP to Rank ${prog.nextRank}: ${prog.nextTitle}`
      : 'Max rank reached — you are a Legend.';
    const perkLabels = PERK_LABELS(prog.perks);
    $('#prog-perks').innerHTML = perkLabels.length
      ? perkLabels.map((p) => `<span class="perk">${esc(p)}</span>`).join('')
      : '<span class="muted">No perks yet — keep playing to rank up.</span>';
    $('#stats').innerHTML = STAT_LABELS.map(([k, l]) => `<div class="stat"><div class="v">${k === 'seconds_played' ? fmtTime(s[k] || 0) : (s[k] || 0).toLocaleString()}</div><div class="l">${l}</div></div>`).join('');
    const achs = m.achievements || [];
    const n = achs.filter((a) => a.unlocked).length;
    $('#ach-count').textContent = `${n} / ${achs.length}`;
    achs.sort((a, b) => (b.unlocked ? 1 : 0) - (a.unlocked ? 1 : 0) || (b.progress / b.threshold) - (a.progress / a.threshold));
    $('#achs').innerHTML = achs.map((a) => `<div class="ach ${a.unlocked ? 'on' : ''}" title="${esc(a.desc)}"><div class="i">${a.icon}</div><div style="flex:1"><div class="n">${esc(a.name)}</div><div class="d">${esc(a.desc)}</div>
      ${a.unlocked ? `<div class="d" style="color:var(--yellow)">Unlocked ${ago(a.unlocked)}</div>` : `<div class="p"><div style="width:${Math.round(100 * a.progress / a.threshold)}%"></div></div><div class="d">${a.progress.toLocaleString()} / ${a.threshold.toLocaleString()}</div>`}
    </div></div>`).join('');
    const runs = m.runs || [];
    $('#runs').innerHTML = `<tr><th>Hero</th><th>Score</th><th>Level</th><th>Kills</th><th>Time</th><th>When</th></tr>` + (runs.length ? runs.map((r) => `<tr><td class="cls-${r.class}">${CLASSES[r.class]?.name || r.class}</td><td>${r.score.toLocaleString()}</td><td>${r.level_reached}</td><td>${r.kills}</td><td>${fmtTime(r.seconds)}</td><td class="muted">${ago(r.ended_at)}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">No runs yet. Go play!</td></tr>');
    const { levels } = await api('/api/levels/mine').catch(() => ({ levels: [] }));
    $('#mylevels').innerHTML = `<tr><th>Name</th><th>Source</th><th>Status</th><th>Plays</th></tr>` + (levels.length ? levels.map((l) => `<tr><td><a href="/editor.html#edit=${l.id}">${esc(l.name)}</a></td><td><span class="tag">${l.source}</span></td><td>${l.published ? 'Published' : 'Draft'}</td><td>${l.plays}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">None yet.</td></tr>');
  }
  const lb = await api('/api/leaderboard').catch(() => null);
  const render = (t) => {
    if (!lb) { $('#lb').innerHTML = '<tr><td class="muted">Leaderboard unavailable</td></tr>'; return; }
    const rows = lb[t] || [];
    const head = { scores: ['#', 'Hero', 'Class', 'Score', 'Level', 'Kills', 'When'], rank: ['#', 'Hero', 'XP', 'Rank'], depth: ['#', 'Hero', 'Deepest level'], kills: ['#', 'Hero', 'Kills'], achievements: ['#', 'Hero', 'Achievements'] }[t];
    const body = rows.map((r, i) => {
      const cells = t === 'scores' ? [i + 1, esc(r.username), `<span class="cls-${r.class}">${CLASSES[r.class]?.name || r.class}</span>`, r.score.toLocaleString(), r.level_reached, r.kills, `<span class="muted">${ago(r.ended_at)}</span>`]
        : t === 'rank' ? [i + 1, esc(r.username), r.xp.toLocaleString(), `Rank ${progressionFor(r.xp).rank} · ${progressionFor(r.xp).title}`]
        : t === 'depth' ? [i + 1, esc(r.username), r.deepest] : t === 'kills' ? [i + 1, esc(r.username), r.kills.toLocaleString()] : [i + 1, esc(r.username), r.n];
      return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
    }).join('') || `<tr><td colspan="${head.length}" class="muted">Nobody yet. Be the first.</td></tr>`;
    $('#lb').innerHTML = `<tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${body}`;
  };
  $('#tabs').querySelectorAll('button').forEach((b) => b.onclick = () => { $('#tabs .on')?.classList.remove('on'); b.classList.add('on'); render(b.dataset.t); });
  render('scores');
}
main();
