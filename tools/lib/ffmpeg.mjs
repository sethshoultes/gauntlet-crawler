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
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(''));
    // 'close' (not 'exit') so stdout has fully drained before we parse the encoder list. A
    // non-zero exit means ffmpeg couldn't enumerate its encoders correctly -- treat whatever
    // partial stdout it produced as an unreadable listing rather than parsing it, so a broken
    // `-encoders` invocation can't produce a false-positive encoder detection.
    p.on('close', (code) => resolve(code === 0 ? out : ''));
  });
}

/** Pure parser over `ffmpeg -hide_banner -encoders` output: picks the best Ogg-compatible audio
 *  encoder ffmpeg was actually built with, or null if none is usable. Both callers always encode
 *  mono (client-side clips are mono, per the README/game design), which rules out ffmpeg's
 *  built-in native "vorbis" encoder -- it only supports 2-channel output, so it is never returned
 *  here even when present. Preference order: libvorbis (matches what the voice pipeline has
 *  always produced) > libopus (a real library, handles mono fine; given an explicit bitrate since
 *  it has no sensible default the way libvorbis does) > null (no usable encoder -- callers must
 *  skip encoding rather than fall back to the native vorbis encoder). */
export function pickOggEncoder(listText) {
  if (/\blibvorbis\b/.test(listText)) return ['-c:a', 'libvorbis'];
  if (/\blibopus\b/.test(listText)) return ['-c:a', 'libopus', '-b:a', '24k'];
  return null;
}

let cachedEncoder;
/** Returns the ffmpeg args array for the best available Ogg encoder (see pickOggEncoder()), or
 *  null if none is usable. Cached after the first call. */
export async function detectOggEncoder() {
  if (cachedEncoder !== undefined) return cachedEncoder;
  const encoders = await listEncoders();
  cachedEncoder = pickOggEncoder(encoders);
  return cachedEncoder;
}

/** Runs an ffmpeg filter/encode pass, resolving on a clean exit and rejecting (with stderr
 *  attached, when captured) otherwise. `args` should omit the leading "ffmpeg". */
export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    // 'close' so the stderr tail in the error message is complete.
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))));
  });
}
