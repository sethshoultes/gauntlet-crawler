// Shared ffmpeg helpers used by both tools/generate-voice.mjs and tools/generate-sfx.mjs: whether
// ffmpeg is on PATH at all, and which Ogg audio encoder it was actually built with. Different
// ffmpeg builds ship different codecs (Homebrew's ffmpeg 8 on macOS, for instance, has libopus
// but no libvorbis), so hardcoding "libvorbis" the way the original voice pipeline did breaks on
// any machine without it -- detect what's available instead and prefer Vorbis when present since
// it's the more universally-supported Ogg payload, falling back to Opus otherwise.
import { spawn } from 'node:child_process';

export function hasFfmpeg() {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

function listEncoders() {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn('ffmpeg', ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(''));
    p.on('exit', () => resolve(out));
  });
}

let cachedEncoder = null;
/** Returns { codec, extraArgs? } for the best Ogg-compatible audio encoder ffmpeg has built in, or
 *  null if none is usable. Both callers always encode mono (client-side clips are mono, per the
 *  README/game design), which rules out ffmpeg's built-in native "vorbis" encoder -- it only
 *  supports 2-channel output -- so the preference order is: libvorbis (matches what the voice
 *  pipeline has always produced) > libopus (a real library, handles mono fine) > native opus >
 *  native vorbis (last resort; only usable for stereo sources). */
export async function detectOggEncoder() {
  if (cachedEncoder !== null) return cachedEncoder;
  const encoders = await listEncoders();
  if (/\blibvorbis\b/.test(encoders)) cachedEncoder = { codec: 'libvorbis' };
  else if (/\blibopus\b/.test(encoders)) cachedEncoder = { codec: 'libopus' };
  else if (/\bopus\b/.test(encoders)) cachedEncoder = { codec: 'opus' };
  else if (/\bvorbis\b/.test(encoders)) cachedEncoder = { codec: 'vorbis', extraArgs: ['-strict', '-2'] };
  else cachedEncoder = null;
  return cachedEncoder;
}

/** Runs an ffmpeg filter/encode pass, resolving on a clean exit and rejecting (with stderr
 *  attached, when captured) otherwise. `args` should omit the leading "ffmpeg". */
export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))));
  });
}
