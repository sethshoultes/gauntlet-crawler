// AI narrator commentary (#18): occasional, opt-in Claude-generated arcade-narrator lines for a
// handful of run events (party composition, near-death saves, kill streaks, treasure vaults),
// modelled directly on server/ai/levelgen.js's client/availability pattern. Unlike level
// generation there is no procedural fallback here — a missing/rejected/errored generation simply
// means no line is spoken this time (server/game/room.js's maybeNarrate() already treats `null`
// as "say nothing"), since narrator commentary is cosmetic and must never block or degrade play.
import Anthropic from '@anthropic-ai/sdk';
import { db, now } from '../db.js';

const MODEL = process.env.GAUNTLET_AI_MODEL || 'claude-opus-5';
// See server/ai/levelgen.js's AI_TIMEOUT_MS comment. Narrator lines are fire-and-forget and never
// awaited on the tick path, but a stuck request would otherwise linger for the SDK's 10-minute
// default (and get retried) for no benefit -- a line this late is worthless anyway.
const AI_TIMEOUT_MS = 15_000;

// Same in-memory Map cache used across the AI features, capped so a room that somehow cycles
// through many distinct context keys over a long uptime can't grow this unbounded — see MAX_CACHE.
const cache = new Map(); // cacheKey -> line
const MAX_CACHE = 200;

let client = null;
function getClient() {
  if (client) return client;
  // Same gating as server/ai/levelgen.js: only the two env vars (or the explicit test escape
  // hatch) decide availability, so a missing `ant auth login` profile fails fast into "no line"
  // rather than throwing mid-request.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && process.env.GAUNTLET_AI !== '1') return null;
  client = new Anthropic();
  return client;
}

export function aiAvailable() { return getClient() !== null; }

const SYSTEM = `You are the booming, deadpan arcade narrator voice of a Gauntlet (1985) style dungeon crawler
(think "Wizard needs food, badly!"). Given a coarse description of something that just happened in a run,
reply with exactly one short punchy narrator line, at most 12 words, in that classic arcade-narrator voice.
Never invent or use any player's real name — you are only ever given hero archetypes and coarse facts, and
must stick to those. No profanity, no markdown, just the line.`;

const SCHEMA = {
  type: 'object',
  properties: { line: { type: 'string', description: 'One short narrator line, max ~12 words' } },
  required: ['line'],
  additionalProperties: false,
};

/** The coarse context key cached and persisted alongside each event type — e.g. "warrior,valkyrie"
 *  for a party, "10" for a kill-streak threshold, "" for the context-free events. Deliberately
 *  built only from small enums/numbers the caller already computed (server/game/room.js), never
 *  from anything a player typed (name, chat, custom hero title). */
function contextKeyFor(eventType, context = {}) {
  switch (eventType) {
    case 'party': return [...(context.classes || [])].map(String).sort().join(',');
    case 'kill_streak': return String(context.threshold ?? '');
    case 'near_death':
    case 'treasure_enter':
    case 'treasure_clear':
    default: return '';
  }
}

function promptFor(eventType, context) {
  switch (eventType) {
    case 'party': return `A fresh party of ${(context.classes || []).length || 'some'} heroes (${(context.classes || []).join(', ') || 'adventurers'}) just entered the dungeon at level 1. Announce them.`;
    case 'near_death': return `A hero's health just climbed back out of the danger zone after nearly dying. Announce the narrow escape.`;
    case 'kill_streak': return `A hero has just reached a kill streak of ${context.threshold} without dying. Hype it up.`;
    case 'treasure_enter': return `The party just stepped into a bonus treasure vault. Announce it with excitement.`;
    case 'treasure_clear': return `The party successfully cleared the bonus treasure vault. Congratulate them.`;
    default: return `Something noteworthy just happened (${eventType}). Give a short arcade-narrator line for it.`;
  }
}

function cacheSet(key, line) {
  cache.set(key, line);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value); // evict oldest (Map preserves insertion order)
}

function loadPersisted(key) {
  try {
    const row = db.prepare('SELECT line FROM narrator_lines WHERE cache_key = ?').get(key);
    return row ? row.line : null;
  } catch { return null; }
}

function persist(key, eventType, line) {
  try {
    db.prepare(`INSERT INTO narrator_lines (cache_key, event_type, line, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET line = excluded.line`).run(key, eventType, line, now());
  } catch (e) { console.warn('[narrator] failed to persist line', e.message); }
}

/** Real Claude call, used unless a test injects its own `generate`. Returns the line string, or
 *  null on refusal/error/no-credentials — never throws. */
async function defaultGenerate(eventType, context) {
  const anthropic = getClient();
  if (!anthropic) return null;
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: SYSTEM,
      messages: [{ role: 'user', content: promptFor(eventType, context) }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    }, { timeout: AI_TIMEOUT_MS });
    if (response.stop_reason === 'refusal') return null;
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const raw = JSON.parse(text);
    const line = String(raw.line || '').trim().slice(0, 140);
    return line || null;
  } catch (e) {
    console.warn('[narrator] generation failed', e.message);
    return null;
  }
}

/** Get (generating and caching if needed) a narrator line for `eventType`/`context`. Every event
 *  type + coarse context key is generated at most once, ever (in-memory cache, backed by the
 *  `narrator_lines` sqlite table so a restart doesn't re-spend it) — the caller
 *  (server/game/room.js's maybeNarrate()) is expected to call this fire-and-forget, never awaited
 *  on the game tick path. Returns null (no line) when AI credentials aren't configured, the model
 *  refused, or generation errored — callers must treat that as "say nothing", not an error.
 *  `generate` is an injection point for tests only; production callers never pass it. */
export async function lineFor(eventType, context = {}, { generate } = {}) {
  const key = `${eventType}|${contextKeyFor(eventType, context)}`;
  if (cache.has(key)) return cache.get(key);
  const persisted = loadPersisted(key);
  if (persisted != null) { cacheSet(key, persisted); return persisted; }
  const gen = generate || defaultGenerate;
  const line = await gen(eventType, context);
  if (!line) return null;
  cacheSet(key, line);
  persist(key, eventType, line);
  return line;
}

// Test-only escape hatches: reset the in-memory cache between tests without touching the sqlite
// table (which node:sqlite already isolates per-test via DATA_DIR/DB_PATH env vars).
export function _resetCacheForTests() { cache.clear(); }
