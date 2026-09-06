// pickOggEncoder() parses `ffmpeg -hide_banner -encoders` output into the args ffmpeg needs to
// produce a mono-compatible Ogg clip. Both tools/generate-sfx.mjs and tools/generate-voice.mjs
// force `-ac 1` (mono), which ffmpeg's built-in native "vorbis" encoder can't handle (2-channel
// output only) -- so a build that only has the native encoders must come back null, never that
// native vorbis case, even though the raw `-encoders` listing does mention "vorbis".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickOggEncoder } from '../tools/lib/ffmpeg.mjs';

const LIBVORBIS_LISTING = `
 Encoders:
  A..... = Audio
 ------
 A..... libvorbis            libvorbis (codec vorbis)
 A..... aac                  AAC (Advanced Audio Coding)
`;

const LIBOPUS_LISTING = `
 Encoders:
  A..... = Audio
 ------
 A..... libopus              libopus Opus (codec opus)
 A..... aac                  AAC (Advanced Audio Coding)
`;

// A build with only the native (non-library) codecs -- e.g. ffmpeg built without --enable-libvorbis
// and without --enable-libopus. The listing still contains the substring "vorbis" (as part of the
// native encoder's name), which is exactly the case that must NOT be picked.
const NATIVE_ONLY_LISTING = `
 Encoders:
  A..... = Audio
 ------
 A..... vorbis               Vorbis (codec vorbis)
 A..... opus                 Opus (codec opus)
 A..... aac                  AAC (Advanced Audio Coding)
`;

test('pickOggEncoder() picks libvorbis when available', () => {
  assert.deepEqual(pickOggEncoder(LIBVORBIS_LISTING), ['-c:a', 'libvorbis']);
});

test('pickOggEncoder() picks libopus with an explicit bitrate when libvorbis is unavailable', () => {
  assert.deepEqual(pickOggEncoder(LIBOPUS_LISTING), ['-c:a', 'libopus', '-b:a', '24k']);
});

test('pickOggEncoder() returns null when only native (mono-incapable) codecs are present', () => {
  assert.equal(pickOggEncoder(NATIVE_ONLY_LISTING), null);
});

test('pickOggEncoder() returns null on empty/unreadable encoder listing', () => {
  assert.equal(pickOggEncoder(''), null);
});
