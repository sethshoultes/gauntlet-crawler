// REST API for the Hero Builder (custom player-authored heroes). Mounted from server/index.js as
// the single additive line `if (url.pathname.startsWith('/api/heroes')) return heroes.handle(req,
// res, url, user);` placed at the top of api() right after `user` is resolved from the bearer
// token — see README.md "Hero Builder" for the full route list and the integration contract that
// lets the sim/room/lobby consume a saved hero later. This module is intentionally
// self-contained (its own json/readBody/rate-limit helpers) so it never imports from
// server/index.js, avoiding a circular import.
import { db, now } from './db.js';
import { rankForXp } from '../shared/progression.js';
import { getStats, getAchievementIds, bumpXp } from './stats.js';
import { STATS, budgetFor, unlockedBuilderItems, validateHero, toClassDef } from '../shared/hero-builder.js';

const MAX_HEROES_PER_USER = 5;

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now(); const b = buckets.get(key) || [];
  const recent = b.filter((x) => t - x < windowMs);
  if (recent.length >= max) { buckets.set(key, recent); return false; }
  recent.push(t); buckets.set(key, recent); return true;
}

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function need(user) { if (!user) fail(401, 'Login required'); return user; }
function profileFor(user) {
  const s = getStats(user.id);
  const achievements = getAchievementIds(user.id);
  return { rank: rankForXp(s.xp || 0), achievements };
}

function rowToHero(row) {
  return {
    id: row.id, name: row.name, title: row.title, motto: row.motto,
    stats: JSON.parse(row.stats), weapon: row.weapon, trait: row.trait || null,
    pixels: JSON.parse(row.pixels), published: !!row.published, clones: row.clones,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const selectMine = db.prepare('SELECT * FROM heroes WHERE owner_id = ? ORDER BY updated_at DESC');
const selectOne = db.prepare('SELECT * FROM heroes WHERE id = ?');
const countMine = db.prepare('SELECT COUNT(*) AS n FROM heroes WHERE owner_id = ?');
const insertHero = db.prepare(`INSERT INTO heroes (owner_id, name, title, motto, stats, weapon, trait, pixels, published, clones, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`);
const updateHero = db.prepare(`UPDATE heroes SET name = ?, title = ?, motto = ?, stats = ?, weapon = ?, trait = ?, pixels = ?, updated_at = ? WHERE id = ?`);
const deleteHero = db.prepare('DELETE FROM heroes WHERE id = ?');
const togglePublish = db.prepare('UPDATE heroes SET published = ?, updated_at = ? WHERE id = ?');
const bumpClones = db.prepare('UPDATE heroes SET clones = clones + 1 WHERE id = ?');
const galleryPage = db.prepare(`SELECT h.*, u.username AS author FROM heroes h JOIN users u ON u.id = h.owner_id
  WHERE h.published = 1 ORDER BY h.clones DESC, h.updated_at DESC LIMIT ? OFFSET ?`);
const galleryCount = db.prepare('SELECT COUNT(*) AS n FROM heroes WHERE published = 1');

function normalizeBody(b) {
  // Coerce stat notches to integers defensively before validateHero's stricter Number.isInteger
  // check runs, so "5" (a string from a sloppy client) doesn't slip past as invalid-but-truthy.
  const stats = {};
  for (const k of STATS) stats[k] = Math.round(Number(b?.stats?.[k]));
  return {
    id: b?.id || null,
    name: typeof b?.name === 'string' ? b.name.trim() : '',
    title: typeof b?.title === 'string' ? b.title.trim() : '',
    motto: typeof b?.motto === 'string' ? b.motto.trim() : '',
    stats, weapon: b?.weapon, trait: b?.trait || null, pixels: b?.pixels,
  };
}

export async function handle(req, res, url, user) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', 'heroes', ...]
  const m = req.method;

  // ----- GAUNTLET_DEBUG=1-only test hook: grant XP to the caller. Lives under /api/heroes so it
  // reaches this module through the single router line in server/index.js; never reachable
  // otherwise. See test/heroes-api.test.js. -----
  if (m === 'POST' && seg[2] === 'debug' && seg[3] === 'xp') {
    if (process.env.GAUNTLET_DEBUG !== '1') return json(res, 404, { error: 'No such endpoint' });
    const u = need(user);
    const b = await readBody(req);
    const { value } = bumpXp(u.id, Math.max(0, Number(b.amount) || 0));
    return json(res, 200, { xp: value, rank: rankForXp(value) });
  }

  if (m === 'GET' && seg[2] === 'mine') {
    const u = need(user);
    return json(res, 200, { heroes: selectMine.all(u.id).map(rowToHero) });
  }

  if (m === 'GET' && seg[2] === 'budget') {
    const u = need(user);
    const profile = profileFor(u);
    const budget = budgetFor(profile.rank, profile.achievements);
    const { weapons, traits } = unlockedBuilderItems(profile.rank, profile.achievements);
    return json(res, 200, { rank: profile.rank, unlocked: profile.rank >= 3, budget, weapons, traits });
  }

  if (m === 'GET' && seg[2] === 'gallery') {
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 20));
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const rows = galleryPage.all(limit, (page - 1) * limit);
    const total = galleryCount.get().n;
    return json(res, 200, { heroes: rows.map((r) => ({ ...rowToHero(r), author: r.author })), total, page, limit });
  }

  if (m === 'POST' && seg.length === 2) { // POST /api/heroes — create or update
    const u = need(user);
    if (!rateLimit('heroes:w:' + u.id, 30, 60_000)) return json(res, 429, { error: 'Slow down: 30 writes per minute' });
    const profile = profileFor(u);
    const body = normalizeBody(await readBody(req));
    const check = validateHero(body, profile);
    if (!check.ok) return json(res, 400, { error: check.errors[0], errors: check.errors });
    const stats = JSON.stringify(body.stats);
    const pixels = JSON.stringify(body.pixels);
    if (body.id) {
      const own = selectOne.get(Number(body.id));
      if (!own || own.owner_id !== u.id) return json(res, 404, { error: 'Hero not found' });
      updateHero.run(body.name, body.title, body.motto, stats, body.weapon, body.trait || '', pixels, now(), Number(body.id));
      return json(res, 200, { id: Number(body.id), hero: rowToHero(selectOne.get(Number(body.id))) });
    }
    const count = countMine.get(u.id).n;
    if (count >= MAX_HEROES_PER_USER) return json(res, 400, { error: `Hero limit reached (${MAX_HEROES_PER_USER})` });
    const r = insertHero.run(u.id, body.name, body.title, body.motto, stats, body.weapon, body.trait || '', pixels, now(), now());
    const newId = Number(r.lastInsertRowid);
    return json(res, 200, { id: newId, hero: rowToHero(selectOne.get(newId)) });
  }

  // ----- routes addressing a single hero: /api/heroes/:id[/action] -----
  if (seg[2] && /^\d+$/.test(seg[2])) {
    const id = Number(seg[2]);
    // DELETE/publish/clone always require login — check that BEFORE the row lookup, so a guest
    // (or a wrong-owner request) never learns "404: no such hero" vs "401: log in" depending on
    // whether the id happens to exist; only GET is ever reachable by a guest (for a published hero).
    const authRequired = m === 'DELETE' || (m === 'POST' && (seg[3] === 'publish' || seg[3] === 'clone'));
    if (authRequired) need(user);

    const row = selectOne.get(id);
    if (!row) return json(res, 404, { error: 'Hero not found' });

    if (m === 'GET' && !seg[3]) {
      if (!row.published && row.owner_id !== user?.id) return json(res, 403, { error: 'This hero is private' });
      const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(row.owner_id);
      return json(res, 200, { hero: { ...rowToHero(row), author: owner?.username || null } });
    }
    if (m === 'DELETE' && !seg[3]) {
      if (row.owner_id !== user.id) return json(res, 403, { error: 'Not yours' });
      if (!rateLimit('heroes:w:' + user.id, 30, 60_000)) return json(res, 429, { error: 'Slow down: 30 writes per minute' });
      deleteHero.run(id);
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && seg[3] === 'publish') {
      if (row.owner_id !== user.id) return json(res, 403, { error: 'Not yours' });
      if (!rateLimit('heroes:w:' + user.id, 30, 60_000)) return json(res, 429, { error: 'Slow down: 30 writes per minute' });
      const pub = !row.published;
      if (pub) {
        // Re-validate against the owner's CURRENT rank/achievements before letting a stale hero
        // (built long ago, maybe over-budget after a since-nerfed rank curve) go public.
        const profile = profileFor(user);
        const check = validateHero(rowToHero(row), profile);
        if (!check.ok) return json(res, 400, { error: check.errors[0], errors: check.errors });
      }
      togglePublish.run(pub ? 1 : 0, now(), id);
      return json(res, 200, { published: pub });
    }
    if (m === 'POST' && seg[3] === 'clone') {
      if (!rateLimit('heroes:w:' + user.id, 30, 60_000)) return json(res, 429, { error: 'Slow down: 30 writes per minute' });
      if (!row.published && row.owner_id !== user.id) return json(res, 403, { error: 'This hero is private' });
      const count = countMine.get(user.id).n;
      if (count >= MAX_HEROES_PER_USER) return json(res, 400, { error: `Hero limit reached (${MAX_HEROES_PER_USER})` });
      const r = insertHero.run(user.id, row.name, row.title, row.motto, row.stats, row.weapon, row.trait, row.pixels, now(), now());
      bumpClones.run(id);
      const newId = Number(r.lastInsertRowid);
      return json(res, 200, { id: newId, hero: rowToHero(selectOne.get(newId)) });
    }
  }

  json(res, 404, { error: 'No such endpoint' });
}

// Exported for the sim/room integration contract described in README.md — a room can build the
// classDef for a stored hero row without re-importing rowToHero's shape from scratch. Does NOT
// check ownership or re-validate against the caller's current rank — see resolveCustomHero below
// for the safe path a `join`/`hero` message must actually use.
export function classDefForHeroId(id) {
  const row = selectOne.get(Number(id));
  if (!row) return null;
  return toClassDef(rowToHero(row));
}

/** The one safe way for server/game/room.js to turn a `custom:<heroId>` cls token into a classDef:
 *  confirms `user` actually owns the hero, then re-validates it against the owner's CURRENT
 *  rank/achievements (same reasoning as the publish-time re-check in handle() above) — a hero
 *  built long ago, or belonging to someone else entirely, is never trusted as-is. Returns
 *  `{ok:true, classDef, hero:{name,pixels}}` on success (the trimmed `hero` fields are exactly
 *  what the room needs for the roster's `custom` display info — see room.js pickHero), or
 *  `{ok:false, error}` naming why it fell back — guests always fail here, callers should fall
 *  back to warrior on any `ok:false`. Never throws. */
export function resolveCustomHero(heroId, user) {
  if (!user) return { ok: false, error: 'Guests cannot use custom heroes' };
  const id = Number(heroId);
  if (!Number.isInteger(id)) return { ok: false, error: 'Unknown custom hero' };
  const row = selectOne.get(id);
  if (!row || row.owner_id !== user.id) return { ok: false, error: 'That custom hero is not yours' };
  const hero = rowToHero(row);
  const profile = profileFor(user);
  const check = validateHero(hero, profile);
  if (!check.ok) return { ok: false, error: check.errors[0] || 'That custom hero no longer meets the requirements' };
  return { ok: true, classDef: toClassDef(hero), hero: { name: hero.name, pixels: hero.pixels } };
}
