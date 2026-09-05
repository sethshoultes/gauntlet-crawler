// Pure, dependency-free trigger detectors for AI narrator commentary (#18). Kept separate from
// Room so they're unit-testable (test/narrator.test.js) without spinning up a live Sim/timers —
// server/game/room.js is the only caller.
import { LOW_HEALTH } from '../../shared/constants.js';

export const KILL_STREAK_THRESHOLDS = [10, 25, 50];

/** True the instant a player's health crosses back up over the low-health line after having been
 *  below it — a "near-death save". `prevHp` must be a genuine previous reading: `null`/`undefined`
 *  (no prior reading yet, e.g. this tick) and `0` (a respawn's 0 -> maxHealth jump, not a save)
 *  both correctly fail to trigger. */
export function detectNearDeathSave(prevHp, currHp, threshold = LOW_HEALTH) {
  return typeof prevHp === 'number' && prevHp > 0 && prevHp < threshold && currHp >= threshold;
}

/** Given a kill streak counter that just incremented to `count`, and the highest threshold
 *  already announced for this streak (`announced`, 0 if none yet), return the highest
 *  newly-crossed threshold from `thresholds` to announce now, or null if none was just crossed.
 *  Checking highest-first means a single big jump (e.g. a potion clearing a room) announces only
 *  its top newly-crossed rung once, rather than firing three narrator lines back to back. */
export function checkKillStreak(count, announced = 0, thresholds = KILL_STREAK_THRESHOLDS) {
  const sorted = [...thresholds].sort((a, b) => b - a);
  for (const t of sorted) if (count >= t && announced < t) return t;
  return null;
}

/** Room-level rate limit for spoken AI lines: at most one per `minGapMs` (see
 *  server/game/room.js's AI_NARRATOR_MIN_GAP_MS). */
export function canNarrateNow(nowMs, lastAtMs, minGapMs) {
  return nowMs - lastAtMs >= minGapMs;
}
