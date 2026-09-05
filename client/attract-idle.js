// Lobby idle -> attract mode (#14): after 30s with no keyboard/pointer/touch activity while the
// lobby/hero-pick screen is showing (nobody has joined a room yet), send the tab to the existing
// attract loop (client/attract.js) exactly as if the "Arcade" nav link had been clicked — that
// page already treats any key, click or tap as "go play the game" and jumps straight back to '/'.
const IDLE_MS = 30_000;

/**
 * @param {() => boolean} isIdleEligible called each time the timer would fire (and on every
 *   reset); attract mode is only triggered if it's still true, so joining a room, opening a modal
 *   that itself listens for input, etc. can veto the redirect right up to the last moment.
 */
export function startIdleAttract(isIdleEligible) {
  let timer = null;
  function arm() {
    if (timer) clearTimeout(timer);
    if (!isIdleEligible()) return;
    timer = setTimeout(() => {
      if (isIdleEligible()) location.href = '/attract.html';
    }, IDLE_MS);
  }
  const reset = () => arm();
  ['keydown', 'pointerdown', 'mousemove', 'touchstart', 'wheel'].forEach((ev) => window.addEventListener(ev, reset, { passive: true }));
  arm();
}
