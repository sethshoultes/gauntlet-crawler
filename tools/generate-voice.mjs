#!/usr/bin/env node
// Generates pre-rendered narrator voice clips (see client/voice.js / issue #19).
//
// Reads client/voice-lines.json (id -> text) and, if ELEVENLABS_API_KEY is set, calls the
// ElevenLabs REST API to synthesize each line, optionally bit-crushing the result (a crude
// sample-rate reduction, for that cheap-arcade-narrator feel) if `ffmpeg` is on PATH, then writes
// client/audio/voice/<id>.ogg and an updated client/audio/voice/manifest.json listing every clip
// that exists on disk. Without `ffmpeg` the raw ElevenLabs output is kept as <id>.mp3 and those
// lines are NOT added to the manifest, so the game keeps using speechSynthesis for them until
// ffmpeg is installed and the script is re-run.
//
// If ELEVENLABS_API_KEY is not set, this prints setup instructions and exits 0 (not an error —
// the game already falls back to speechSynthesis for any line with no pre-rendered clip, so a
// fresh checkout works fine without ever running this script).
//
// Usage:
//   ELEVENLABS_API_KEY=... [ELEVENLABS_VOICE_ID=...] node tools/generate-voice.mjs [id ...]
// With no ids given, every line in voice-lines.json is (re)generated.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFfmpeg, detectOggEncoder, runFfmpeg } from './lib/ffmpeg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINES_PATH = path.join(ROOT, 'client', 'voice-lines.json');
const OUT_DIR = path.join(ROOT, 'client', 'audio', 'voice');
const MANIFEST_PATH = path.join(OUT_DIR, 'manifest.json');

// A generic "arcade narrator" preset on ElevenLabs' shared voice library. Any valid voice id
// works — override with ELEVENLABS_VOICE_ID to use a different one.
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // "Rachel" — ElevenLabs' documented default demo voice

/** Crude "bit-crush": ffmpeg down to an 8kHz mono Ogg file — a cheap, lossy sample rate that
 *  gives generated speech a chunkier, lower-fidelity arcade-narrator character. Uses whichever
 *  Ogg-compatible encoder (Vorbis preferred, Opus as a fallback) this ffmpeg build actually has —
 *  see tools/lib/ffmpeg.mjs's detectOggEncoder(). */
async function crushToOgg(inputPath, outputPath, encoder) {
  const extra = encoder.extraArgs || [];
  await runFfmpeg(['-y', '-i', inputPath, '-ar', '8000', '-ac', '1', '-c:a', encoder.codec, ...extra, outputPath]);
}

async function synthesize(voiceId, apiKey, text) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: 'eleven_monolingual_v1', voice_settings: { stability: 0.5, similarity_boost: 0.6 } }),
  });
  if (!res.ok) throw new Error(`ElevenLabs API ${res.status}: ${await res.text().catch(() => '')}`);
  return Buffer.from(await res.arrayBuffer());
}

function printInstructions() {
  console.log(`No ELEVENLABS_API_KEY set — skipping voice generation.

client/voice.js already falls back to the browser's speechSynthesis for any narrator line with no
pre-rendered clip, so this is optional. To generate real clips:

  1. Get an API key from https://elevenlabs.io (Profile -> API Keys).
  2. Optionally pick a voice id from https://elevenlabs.io/app/voice-library (Profile -> Voices),
     or use the built-in default.
  3. Run:
       ELEVENLABS_API_KEY=sk-... [ELEVENLABS_VOICE_ID=voice_id] node tools/generate-voice.mjs

Install ffmpeg (any recent version on PATH) for the extra 8kHz "arcade narrator" bit-crush pass;
without it, clips are written unmodified (as .mp3 instead of .ogg — client/voice.js requests
"<id>.ogg" for every clip listed in the manifest, so an ffmpeg-less run's mp3-only clips won't be
picked up until ffmpeg is available, but the speechSynthesis fallback still covers those lines).`);
}

async function main() {
  const raw = await fs.readFile(LINES_PATH, 'utf8');
  const lines = JSON.parse(raw);
  const requested = process.argv.slice(2);
  const ids = requested.length ? requested : Object.keys(lines);
  for (const id of ids) {
    if (!(id in lines)) { console.error(`Unknown voice line id: ${id} (not in client/voice-lines.json)`); process.exitCode = 1; return; }
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) { printInstructions(); return; }

  const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  await fs.mkdir(OUT_DIR, { recursive: true });
  const ffmpegPresent = await hasFfmpeg();
  const encoder = ffmpegPresent ? await detectOggEncoder() : null;
  const canCrush = !!encoder;
  if (!ffmpegPresent) console.log('ffmpeg not found on PATH — clips will be written as plain .mp3 (no bit-crush pass).');
  else if (!canCrush) console.log('ffmpeg has no Vorbis or Opus encoder — clips will be written as plain .mp3 (no bit-crush pass).');

  for (const id of ids) {
    const text = lines[id];
    process.stdout.write(`Generating "${id}"... `);
    try {
      const mp3 = await synthesize(voiceId, apiKey, text);
      if (canCrush) {
        const tmpPath = path.join(OUT_DIR, `${id}.raw.mp3`);
        await fs.writeFile(tmpPath, mp3);
        // Always remove the temp file, even when the crush step itself fails (bad codec, corrupt
        // input): otherwise a partial failure leaves stray `.raw.mp3` artifacts in OUT_DIR.
        try {
          await crushToOgg(tmpPath, path.join(OUT_DIR, `${id}.ogg`), encoder);
        } finally {
          await fs.rm(tmpPath, { force: true });
        }
        console.log(`ok (.ogg, bit-crushed, ${encoder.codec})`);
      } else {
        await fs.writeFile(path.join(OUT_DIR, `${id}.mp3`), mp3);
        console.log('ok (.mp3)');
      }
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      process.exitCode = 1;
    }
  }

  await writeManifest();
}

/** Lists every voice-line id that has an .ogg clip on disk (client/voice.js only ever requests
 *  "<id>.ogg", so a plain .mp3 from an ffmpeg-less run is intentionally left out here — it isn't
 *  fetchable under the id it's shown against without ffmpeg present next time). */
async function writeManifest() {
  const raw = await fs.readFile(LINES_PATH, 'utf8');
  const ids = Object.keys(JSON.parse(raw));
  const manifest = {};
  for (const id of ids) {
    try { await fs.access(path.join(OUT_DIR, `${id}.ogg`)); manifest[id] = true; } catch { /* no clip yet */ }
  }
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote ${MANIFEST_PATH} (${Object.keys(manifest).length}/${ids.length} lines have clips).`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
