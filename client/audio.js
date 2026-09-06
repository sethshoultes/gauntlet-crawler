// WebAudio sound engine (#20): synthesized square/triangle/noise voices run through a lightweight
// bit-crusher (a quantizing WaveShaperNode — no ScriptProcessor/AudioWorklet needed) on the SFX
// bus, for a grittier 1985-arcade feel. Exposes a small master/SFX/voice volume mixer persisted
// to localStorage (mirrored from server-saved prefs for logged-in users via common.js's
// loadPrefs(), same pattern as the existing gc_mute/gc_narrate keys) and the `M`-key mute toggle.
// Effects play from the pre-rendered clips in client/audio/sfx/ (see manifest.json) when one exists and fall back to the synthesizer otherwise.
const VOL_KEYS = { master: 'gc_vol_master', sfx: 'gc_vol_sfx', voice: 'gc_vol_voice' };

function readVol(key) {
  try {
    const v = localStorage.getItem(key);
    const n = v == null ? 100 : Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) / 100 : 1;
  } catch { return 1; }
}
function readMuted() {
  try { return localStorage.getItem('gc_mute') === '1'; } catch { return false; }
}

const vol = { master: readVol(VOL_KEYS.master), sfx: readVol(VOL_KEYS.sfx), voice: readVol(VOL_KEYS.voice) };
let muted = readMuted();

let AC = null, masterGain = null, sfxBus = null, sfxClipBus = null, crusher = null;

/** A quantizing curve: rounds the waveform down to a small number of amplitude steps, the
 *  classic cheap-DAC "crunch" of 1985 arcade sound chips. */
function makeCrusherCurve(steps = 14) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

function build() {
  if (AC) return AC;
  try { AC = new (window.AudioContext || window.webkitAudioContext)(); }
  catch { return null; }
  masterGain = AC.createGain(); masterGain.gain.value = vol.master;
  masterGain.connect(AC.destination);
  crusher = AC.createWaveShaper();
  crusher.curve = makeCrusherCurve(14);
  crusher.oversample = '2x';
  sfxBus = AC.createGain(); sfxBus.gain.value = vol.sfx;
  sfxBus.connect(crusher).connect(masterGain);
  // Pre-rendered sfx clips (see loadSfxBuffer()/playBuffer() below) are already retro-sounding
  // out of the ElevenLabs+ffmpeg pipeline, so they get their own gain node straight to
  // masterGain -- same sfx-volume level as sfxBus, just skipping the bit-crusher bus.
  sfxClipBus = AC.createGain(); sfxClipBus.gain.value = vol.sfx;
  sfxClipBus.connect(masterGain);
  return AC;
}
function ac() { return build(); }

/** Set up the context so it can be created/resumed on the first user gesture, per browser
 *  autoplay policy. Safe to call multiple times (each listener is `{ once: true }`). */
export function initAudio() {
  const resume = () => { const a = build(); if (a && a.state === 'suspended') a.resume(); };
  window.addEventListener('pointerdown', resume, { once: true });
  window.addEventListener('keydown', resume, { once: true });
  loadSfxManifest(); // kick off the manifest fetch now; never awaited, never blocks gameplay
}

// ---------- pre-rendered sfx clips (#20 clip pipeline; see tools/generate-sfx.mjs) ----------
// client/audio.js's synth engine above remains the always-available fallback: sfx(name) plays a
// pre-rendered clip when one has been generated and decoded, otherwise falls straight through to
// the WebAudio synth switch below, exactly as before this pipeline existed.
let sfxManifest = null; // null until the fetch below resolves; {} on 404/error (tolerated)
let sfxManifestPromise = null;
function loadSfxManifest() {
  if (!sfxManifestPromise) {
    sfxManifestPromise = fetch('/audio/sfx/manifest.json')
      .then((r) => (r.ok ? r.json() : {}))
      .then((m) => { sfxManifest = (m && typeof m === 'object' && !Array.isArray(m)) ? m : {}; return sfxManifest; })
      .catch(() => { sfxManifest = {}; return sfxManifest; });
  }
  return sfxManifestPromise;
}

const sfxBuffers = new Map(); // id -> decoded AudioBuffer (or null once a fetch/decode attempt has
                               // failed for this id), filled in lazily on first request. A Map
                               // (rather than a plain object) so an id like "__proto__" can't
                               // collide with Object.prototype.
const sfxBufferPromises = new Map(); // id -> in-flight decode Promise, so a burst of the same id
                                      // before the first decode finishes doesn't fire off
                                      // duplicate fetches
/** Lazily fetch + decode one clip the first time its id is actually requested (never eagerly for
 *  every clip in the manifest). On any fetch/decode failure, records `null` in sfxBuffers for
 *  this id (permanently for the session) so sfx(name) falls through to the synth without ever
 *  retrying the fetch -- a missing/undecodable clip doesn't get re-requested on every call. */
function loadSfxBuffer(id, file) {
  const a = ac();
  if (!a) return Promise.resolve(null);
  const p = fetch(`/audio/sfx/${file}`)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`sfx fetch ${r.status}`))))
    .then((buf) => a.decodeAudioData(buf))
    .then((decoded) => { sfxBuffers.set(id, decoded); return decoded; })
    .catch(() => { sfxBuffers.set(id, null); return null; })
    .finally(() => { sfxBufferPromises.delete(id); });
  sfxBufferPromises.set(id, p);
  return p;
}
function playBuffer(buffer) {
  const a = ac(); if (!a || muted || !sfxClipBus) return;
  const src = a.createBufferSource();
  src.buffer = buffer;
  src.connect(sfxClipBus);
  src.start();
  // Debug-only counter (mirrors window.__gc in client/game.js) so smoke/e2e tooling can confirm a
  // pre-rendered clip actually decoded and played, without this module needing to know anything
  // about the game's own debug object.
  try { window.__gcSfxClipsPlayed = (window.__gcSfxClipsPlayed || 0) + 1; } catch {}
}

const muteListeners = new Set();
/** Subscribe to mute toggles (used by client/voice.js to cancel in-flight narration the moment
 *  mute is turned on, without the two modules importing each other). Returns an unsubscribe fn. */
export function onMuteChange(fn) { muteListeners.add(fn); return () => muteListeners.delete(fn); }

export function setMuted(v) {
  muted = !!v;
  try { localStorage.setItem('gc_mute', muted ? '1' : '0'); } catch {}
  muteListeners.forEach((fn) => { try { fn(muted); } catch {} });
}
export function isMuted() { return muted; }

function tone(freq, dur, type = 'square', gain = 0.08, slide = 0, opts = {}) {
  const a = ac(); if (!a || muted) return;
  const o = a.createOscillator(); const g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, a.currentTime);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), a.currentTime + dur);
  if (opts.vibrato) {
    const lfo = a.createOscillator(); const lg = a.createGain();
    lfo.frequency.value = opts.vibrato; lg.gain.value = opts.vibratoDepth ?? 20;
    lfo.connect(lg).connect(o.frequency); lfo.start(); lfo.stop(a.currentTime + dur);
  }
  g.gain.setValueAtTime(gain, a.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  o.connect(g).connect(sfxBus || a.destination); o.start(); o.stop(a.currentTime + dur);
}
function noise(dur, gain = 0.08, opts = {}) {
  const a = ac(); if (!a || muted) return;
  const buf = a.createBuffer(1, Math.max(1, Math.floor(a.sampleRate * dur)), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const s = a.createBufferSource(); s.buffer = buf;
  const g = a.createGain(); g.gain.value = gain;
  let node = s;
  if (opts.filter) {
    const f = a.createBiquadFilter(); f.type = opts.filter; f.frequency.value = opts.filterFreq ?? 800;
    node.connect(f); node = f;
  }
  node.connect(g).connect(sfxBus || a.destination);
  s.start();
}
function chord(freqs, dur, type, gain, gap = 0) { freqs.forEach((f, i) => setTimeout(() => tone(f, dur, type, gain), i * gap)); }

const sfxLast = new Map();
/** Play a named sound effect (rate-limited per name so a burst of identical events in one frame
 *  doesn't distort into a buzz). See README's "Sound" section for the full catalogue. */
export function sfx(name) {
  const now = performance.now();
  if (sfxLast.has(name) && now - sfxLast.get(name) < 40) return;
  sfxLast.set(name, now);

  if (!muted) {
    const buf = sfxBuffers.get(name);
    if (buf) { playBuffer(buf); return; }
    // Manifest not resolved yet, this id has no clip, or a previous fetch/decode attempt for it
    // failed (sfxBuffers.get(name) === null, which is falsy above but IS present in the map, so
    // the has() check below skips retrying it): fall through to the synth below for *this* call.
    // If the manifest lists a clip for this id and it hasn't been attempted yet, kick off
    // decoding it in the background (deduped via sfxBufferPromises) so the *next* call to
    // sfx(name) can use it.
    // Own-property check: the manifest is parsed JSON, so a name like "__proto__" would otherwise
    // resolve through the prototype chain to a truthy non-entry.
    const entry = sfxManifest && Object.hasOwn(sfxManifest, name) ? sfxManifest[name] : null;
    if (entry && typeof entry.file === 'string' && !sfxBuffers.has(name) && !sfxBufferPromises.has(name)) {
      loadSfxBuffer(name, entry.file);
    }
  }
  switch (name) {
    // ---- generic ----
    case 'shoot': tone(880, 0.06, 'square', 0.04, -400); break;
    case 'hit': noise(0.05, 0.05); break;
    case 'kill': tone(220, 0.12, 'sawtooth', 0.06, -150); noise(0.08, 0.04); break;
    case 'boom': noise(0.35, 0.12); tone(80, 0.3, 'sawtooth', 0.1, -60); break;
    case 'coin': tone(988, 0.08, 'square', 0.06); setTimeout(() => tone(1319, 0.15, 'square', 0.06), 80); break;
    case 'key': tone(1319, 0.06, 'square', 0.05); setTimeout(() => tone(1760, 0.1, 'square', 0.05), 60); break;
    case 'eat': tone(330, 0.08, 'triangle', 0.08); setTimeout(() => tone(440, 0.1, 'triangle', 0.08), 80); break;
    case 'pick': tone(660, 0.1, 'triangle', 0.06); break;
    case 'door': tone(160, 0.25, 'sawtooth', 0.06, 60); break;
    case 'potion': case 'magic': tone(200, 0.6, 'sine', 0.1, 1400); noise(0.3, 0.05); break;
    case 'teleport': tone(300, 0.4, 'sine', 0.08, 900); tone(600, 0.35, 'sine', 0.05, -400); break;
    case 'death': tone(440, 0.8, 'sawtooth', 0.1, -400); break;
    case 'bad': tone(200, 0.3, 'square', 0.06, -100); break;
    case 'poison': tone(260, 0.35, 'square', 0.07, -180, { vibrato: 18, vibratoDepth: 30 }); break; // sour
    case 'fireball': tone(300, 0.15, 'sawtooth', 0.04, -200); break; // hostile fireball (demon/lobber)
    case 'spawn': tone(120, 0.1, 'square', 0.03, 80); break;
    case 'level': chord([523, 659, 784, 1047], 0.18, 'square', 0.06, 110); break;
    case 'clear': chord([784, 659, 784, 1047, 1319], 0.2, 'square', 0.07, 120); break;
    case 'wave': chord([220, 440, 330], 0.22, 'triangle', 0.08, 130); break; // wave banner
    case 'ach': chord([1047, 1319, 1568], 0.25, 'triangle', 0.08, 90); break;
    case 'rankup': chord([659, 784, 988, 1319], 0.22, 'square', 0.08, 100); break;
    case 'chest': tone(988, 0.1, 'square', 0.06); setTimeout(() => tone(1568, 0.2, 'triangle', 0.06), 100); break;
    case 'victory': chord([523, 659, 784, 1047, 1319, 1568], 0.24, 'square', 0.08, 130); break;
    case 'gameover': chord([440, 349, 293, 220], 0.4, 'sawtooth', 0.08, 220); break;

    // ---- per-weapon shots (see shared/constants.js CLASSES[cls].weapon) ----
    case 'shoot_warrior': tone(140, 0.14, 'sawtooth', 0.07, 40, { vibrato: 55, vibratoDepth: 40 }); break; // axe whirr
    case 'shoot_valkyrie': noise(0.08, 0.05, { filter: 'highpass', filterFreq: 2000 }); tone(700, 0.07, 'square', 0.04, -900); break; // sword slash
    case 'shoot_wizard': tone(260, 0.22, 'sawtooth', 0.06, 500); noise(0.16, 0.03); break; // fireball whoosh
    case 'shoot_elf': tone(1200, 0.08, 'triangle', 0.05, -700); break; // arrow twang
    case 'shoot_paladin': noise(0.12, 0.09, { filter: 'lowpass', filterFreq: 300 }); tone(90, 0.14, 'sine', 0.08, -30); break; // hammer thud
    case 'shoot_ranger': tone(1600, 0.03, 'square', 0.04); break; // dagger tick
    case 'shoot_necromancer': tone(180, 0.35, 'sawtooth', 0.06, -60, { vibrato: 8, vibratoDepth: 25 }); break; // skull wail

    // ---- per-monster contact hit (non-lethal) ----
    case 'hit_ghost': tone(500, 0.05, 'sine', 0.05, 250); break;
    case 'hit_grunt': noise(0.06, 0.06, { filter: 'lowpass', filterFreq: 500 }); tone(140, 0.08, 'square', 0.05); break;
    case 'hit_demon': tone(110, 0.14, 'sawtooth', 0.08, -30); noise(0.08, 0.05); break;
    case 'hit_sorcerer': tone(500, 0.06, 'sine', 0.05, 300); break;

    // ---- per-monster death (see shared/constants.js MONSTERS) ----
    case 'kill_ghost': tone(700, 0.1, 'sine', 0.05, 600); break; // pop
    case 'kill_grunt': noise(0.1, 0.07, { filter: 'lowpass', filterFreq: 400 }); tone(120, 0.12, 'square', 0.05, -60); break; // grunt
    case 'kill_demon': tone(90, 0.35, 'sawtooth', 0.09, -40); noise(0.2, 0.06); break; // roar
    case 'kill_death': tone(220, 0.9, 'sine', 0.08, -160, { vibrato: 4, vibratoDepth: 12 }); break; // moan
    case 'kill_lobber': tone(180, 0.12, 'sine', 0.06, -300); noise(0.06, 0.04); break; // plop
    case 'kill_sorcerer': tone(1200, 0.08, 'sine', 0.05, -900); break; // blink
    case 'kill_thief': tone(880, 0.05, 'square', 0.04); setTimeout(() => tone(1108, 0.06, 'square', 0.04), 50); break; // snicker
    default: break;
  }
}
