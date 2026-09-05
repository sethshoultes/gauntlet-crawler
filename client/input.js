// Touch d-pad + auto-fire toggle, and Gamepad API polling for up to four local heroes on one
// machine (#15 "Mobile: full touch layout and gamepad support"). The pure input-mapping helpers
// below (axis/button decoding, pad->slot routing, the auto-fire toggle) have no DOM/browser
// dependency and are exercised directly by test/input.test.js under plain Node; everything past
// that point assumes a browser (DOM, `navigator.getGamepads`, `localStorage`) and only runs once
// `initInput()` is called from client/game.js.
//
// Protocol (server/index.js + server/game/room.js Room#joinLocal): gamepad index 0 always drives
// *this* connection's own hero — its direction/fire is merged into game.js's existing keyboard
// input via getPrimaryState() rather than sent separately. Gamepad indices 1-3 each open an extra
// local co-op player bound to this same WebSocket via one `{t:'join_local', slot}` message, and
// their input is polled and sent straight from here, tagged `{slot}`.

const AUTO_FIRE_KEY = 'gc_autofire';
// Always-unlocked base classes (see README "How to play") — the safe default for an extra local
// player so a second controller never trips a locked-hero error regardless of room progress.
const LOCAL_CLASSES = ['warrior', 'valkyrie', 'wizard', 'elf'];

// ---------------- pure helpers (exported for test/input.test.js) ----------------

/** One raw analog axis value -> -1/0/1, dead-zoned per axis (issue #15: deadzone 0.35). */
export function axis(value, deadzone = 0.35) {
  return Math.abs(value) > deadzone ? Math.sign(value) : 0;
}

/** Left stick (or any two-axis pair) -> {dx, dy}, each already dead-zoned to -1/0/1. */
export function axesToDirection(axesArr, deadzone = 0.35) {
  const a = axesArr || [];
  return { dx: axis(a[0] || 0, deadzone), dy: axis(a[1] || 0, deadzone) };
}

/** Standard-mapping d-pad buttons (indices 12-15: up/down/left/right) -> {dx, dy}. */
export function dpadButtonsToDirection(pressed) {
  const p = pressed || [];
  const up = !!p[12], down = !!p[13], left = !!p[14], right = !!p[15];
  return { dx: (right ? 1 : 0) - (left ? 1 : 0), dy: (down ? 1 : 0) - (up ? 1 : 0) };
}

/** Standard mapping "fire": face buttons 0-3 (A/B/X/Y, or Cross/Circle/Square/Triangle) or the
 *  right trigger (button 7, "R2"/"RT"). */
export function standardFireHeld(pressed) {
  const p = pressed || [];
  return !!(p[0] || p[1] || p[2] || p[3] || p[7]);
}

/** Non-standard-mapping fallback: buttons 0-3 read the same conventional way, with no d-pad or
 *  trigger index assumed (issue #15: "a fallback that treats axes 0/1 and buttons 0-3
 *  conventionally for non-standard pads"). */
export function fallbackFireHeld(pressed) {
  const p = pressed || [];
  return !!(p[0] || p[1] || p[2] || p[3]);
}

/** A raw Gamepad-like object (`{mapping, axes, buttons}}`, buttons as GamepadButton-likes or
 *  plain booleans/numbers) -> the {dx, dy, fire} this game's input protocol wants. Honors the
 *  'standard' mapping (stick + d-pad + trigger) when the browser reports one, else the plain
 *  axes/buttons fallback. */
export function mapGamepad(pad, deadzone = 0.35) {
  const pressed = (pad?.buttons || []).map((b) => (typeof b === 'number' ? b > 0.5 : typeof b === 'boolean' ? b : !!b?.pressed));
  const stick = axesToDirection(pad?.axes, deadzone);
  if (pad?.mapping === 'standard') {
    const dpad = dpadButtonsToDirection(pressed);
    return { dx: stick.dx || dpad.dx, dy: stick.dy || dpad.dy, fire: standardFireHeld(pressed) };
  }
  return { dx: stick.dx, dy: stick.dy, fire: fallbackFireHeld(pressed) };
}

/** Gamepad index -> the local player "slot" it drives: 0 is this connection's own hero, 1-3 each
 *  name an extra local co-op player. Clamped so a 5th+ pad harmlessly doubles up on slot 3
 *  instead of being silently ignored. */
export function slotForPad(index) { return Math.max(0, Math.min(3, index | 0)); }

/** The class an extra local player (slot 1-3) defaults to. */
export function localClassForSlot(slot) { return LOCAL_CLASSES[((slot % LOCAL_CLASSES.length) + LOCAL_CLASSES.length) % LOCAL_CLASSES.length]; }

/** Auto-fire toggle as a tiny, independently-testable state machine: {type:'toggle'} flips it,
 *  {type:'set', on} forces a value (used to restore the persisted preference at boot). */
export function autoFireReducer(state, action) {
  if (action?.type === 'toggle') return { on: !state.on };
  if (action?.type === 'set') return { on: !!action.on };
  return state;
}

/** Whether the touch layout should render: a coarse pointer (phone/tablet), or the `?touch=1`
 *  query flag so tests/e2e can exercise it on a desktop browser (issue #15). */
export function shouldShowTouch(search, isCoarsePointer) {
  return !!isCoarsePointer || /(?:^|[?&])touch=1(?:&|$)/.test(search || '');
}

// ---------------- stateful runtime (DOM + Gamepad API) ----------------
let opts = null;
let touchDir = { dx: 0, dy: 0 };
let touchFire = false;
let autoFire = { on: false };
let pad0State = { dx: 0, dy: 0, fire: false };
const slotPid = new Map();       // local slot (1-3) -> server-assigned pid, once join_local acks
const lastLocalSent = new Map(); // local slot -> last input JSON sent (dedupe, like game.js's own sendInput)
const startWasDown = new Map();  // gamepad index -> previous frame's Start-button state (rising-edge detect)

function loadAutoFire() {
  try { return localStorage.getItem(AUTO_FIRE_KEY) === '1'; } catch { return false; }
}
function saveAutoFire(on) {
  try { localStorage.setItem(AUTO_FIRE_KEY, on ? '1' : '0'); } catch {}
}

/** Build the touch layout (oversized 8-way d-pad, fire button, auto-fire toggle, potion button)
 *  into `#touch` and start listening for gamepad connect/disconnect. Call once at boot.
 *  `o.log`/`o.say` reuse game.js's existing log/narrator hooks; `o.getWs`/`o.isInRoom` let this
 *  module send local co-op join/input messages on its own; `o.sendInput` reuses game.js's own
 *  potion-press plumbing so it isn't duplicated here. */
export function initInput(o) {
  opts = o;
  autoFire = { on: loadAutoFire() };
  if (typeof document !== 'undefined') buildTouchUI();
  if (typeof window !== 'undefined') {
    window.addEventListener('gamepadconnected', (e) => announcePad(e.gamepad, true));
    window.addEventListener('gamepaddisconnected', (e) => announcePad(e.gamepad, false));
  }
}

function announcePad(pad, connected) {
  const slot = slotForPad(pad.index);
  if (!connected && slot > 0) slotPid.delete(slot);
  const text = `Controller ${slot + 1} ${connected ? 'connected' : 'disconnected'}`;
  opts?.log?.(`<span class="n">${text}</span>`);
  // A unique id per event (never a fixed literal) so this is exempt from voice-lines.json
  // coverage, same convention as the AI narrator's free-text lines in game.js.
  opts?.say?.(`gamepad_${connected ? 'on' : 'off'}_${Date.now()}`, text);
  if (connected && slot > 0) maybeJoinLocal(slot);
}

function maybeJoinLocal(slot) {
  if (slotPid.has(slot)) return;
  if (!opts?.isInRoom?.()) return;
  const ws = opts.getWs?.();
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ t: 'join_local', slot, cls: localClassForSlot(slot), name: `P${slot + 1}` }));
}

/** Handle the server's `{t:'welcome_local', slot, pid}` ack — the "local-hero routing" hook
 *  client/game.js's onMessage() forwards to this module — so later input for that slot is tagged
 *  with the pid the server actually minted for it. */
export function onWelcomeLocal(m) {
  if (m && Number.isInteger(m.slot)) slotPid.set(m.slot, m.pid);
}

/** Forget every local co-op player (call from game.js on leaveGame()) so a later join doesn't
 *  resend `join_local` for slots the server already dropped along with the old room. */
export function resetLocalPlayers() { slotPid.clear(); lastLocalSent.clear(); }

// ---------------- touch d-pad ----------------
const DIR_VECTORS = [
  ['nw', -1, -1], ['n', 0, -1], ['ne', 1, -1],
  ['w', -1, 0], ['', 0, 0], ['e', 1, 0],
  ['sw', -1, 1], ['s', 0, 1], ['se', 1, 1],
];
const DIR_ARROWS = { n: '▲', s: '▼', e: '▶', w: '◀', ne: '◥', nw: '◤', se: '◢', sw: '◣' };

function buildTouchUI() {
  const host = document.getElementById('touch');
  if (!host) return;
  host.innerHTML = '';
  host.classList.add('input-touch');
  if (shouldShowTouch(location.search, matchMedia('(pointer: coarse)').matches)) host.classList.add('touch-force');

  const dpad = document.createElement('div');
  dpad.className = 'input-dpad';
  const held = new Map(); // direction name -> Set<pointerId> (multiple zones can be held at once)
  const recompute = () => {
    let dx = 0, dy = 0;
    for (const [name, ids] of held) {
      if (!ids.size) continue;
      const d = DIR_VECTORS.find((x) => x[0] === name);
      if (d) { dx += d[1]; dy += d[2]; }
    }
    touchDir = { dx: Math.sign(dx), dy: Math.sign(dy) };
  };
  for (const [name] of DIR_VECTORS) {
    const b = document.createElement('button');
    b.type = 'button';
    if (!name) { b.className = 'input-dir input-dir-mid'; b.tabIndex = -1; dpad.appendChild(b); continue; }
    b.textContent = DIR_ARROWS[name];
    b.className = 'input-dir';
    held.set(name, new Set());
    // Pointer events (not touch events): each button tracks its own held pointer ids, so a
    // direction zone and the separate fire button can be held down by two fingers at once.
    const down = (ev) => { ev.preventDefault(); held.get(name).add(ev.pointerId); recompute(); };
    const up = (ev) => { held.get(name).delete(ev.pointerId); recompute(); };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('pointerleave', up);
    dpad.appendChild(b);
  }

  const actions = document.createElement('div');
  actions.className = 'input-actions';

  const fireHeld = new Set();
  const fireBtn = document.createElement('button');
  fireBtn.type = 'button'; fireBtn.className = 'input-fire'; fireBtn.textContent = '🔥';
  fireBtn.addEventListener('pointerdown', (ev) => { ev.preventDefault(); fireHeld.add(ev.pointerId); touchFire = true; });
  const releaseFire = (ev) => { fireHeld.delete(ev.pointerId); touchFire = fireHeld.size > 0; };
  fireBtn.addEventListener('pointerup', releaseFire);
  fireBtn.addEventListener('pointercancel', releaseFire);
  fireBtn.addEventListener('pointerleave', releaseFire);

  const autoBtn = document.createElement('button');
  autoBtn.type = 'button'; autoBtn.className = 'input-autofire';
  const renderAuto = () => { autoBtn.textContent = `AUTO-FIRE ${autoFire.on ? 'ON' : 'OFF'}`; autoBtn.classList.toggle('on', autoFire.on); };
  renderAuto();
  autoBtn.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    autoFire = autoFireReducer(autoFire, { type: 'toggle' });
    saveAutoFire(autoFire.on);
    renderAuto();
  });

  const potionBtn = document.createElement('button');
  potionBtn.type = 'button'; potionBtn.className = 'input-potion'; potionBtn.textContent = '🧪';
  potionBtn.addEventListener('pointerdown', (ev) => { ev.preventDefault(); opts?.sendInput?.({ potion: true }); });

  actions.append(fireBtn, autoBtn, potionBtn);
  host.append(dpad, actions);
}

// ---------------- gamepad polling ----------------
/** Call once per animation frame from game.js's existing render loop (the "poll in the existing
 *  render loop" hook, ~60 Hz). Refreshes pad 0's merged state (read back via getPrimaryState())
 *  and sends slots 1-3's input straight to the server, tagged `{slot}`. */
export function poll() {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
  const pads = navigator.getGamepads();
  pad0State = { dx: 0, dy: 0, fire: false };
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (!pad || !pad.connected) continue;
    checkStartButton(pad);
    const slot = slotForPad(i);
    const state = mapGamepad(pad);
    if (slot === 0) { pad0State = state; continue; }
    if (!slotPid.has(slot)) { maybeJoinLocal(slot); continue; }
    sendLocalInput(slot, state);
  }
}

function checkStartButton(pad) {
  // Standard mapping's Start button is index 9. No pause/lobby overlay exists mid-game today, so
  // this is a no-op unless a caller opts in via initInput({ onStart }) — kept for parity with the
  // acceptance criteria ("start button to open/close the pause/lobby if such a thing exists").
  if (pad.mapping !== 'standard' || !opts?.onStart) return;
  const down = !!pad.buttons?.[9]?.pressed;
  if (down && !startWasDown.get(pad.index)) opts.onStart(pad.index);
  startWasDown.set(pad.index, down);
}

function sendLocalInput(slot, state) {
  const ws = opts?.getWs?.();
  if (!ws || ws.readyState !== 1) return;
  const msg = { t: 'input', slot, dx: state.dx, dy: state.dy, fire: state.fire };
  const s = JSON.stringify(msg);
  if (lastLocalSent.get(slot) === s) return;
  lastLocalSent.set(slot, s);
  ws.send(s);
}

/** The merged touch + gamepad-pad-0 + auto-fire state for *this* connection's own hero — OR'd
 *  into game.js's existing keyboard read in sendInput() (the "reading the input state" hook). */
export function getPrimaryState() {
  return {
    dx: touchDir.dx || pad0State.dx,
    dy: touchDir.dy || pad0State.dy,
    fire: touchFire || pad0State.fire || autoFire.on,
  };
}
