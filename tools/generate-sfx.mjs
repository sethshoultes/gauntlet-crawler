#!/usr/bin/env node
// Generates pre-rendered arcade sound-effect clips (see client/audio.js's `sfx(name)` / issue
// #20), mirroring tools/generate-voice.mjs's shape for the narrator pipeline.
//
// Reads client/sfx-lines.json (id -> { prompt, seconds }) and, if an ElevenLabs API key is
// present, calls ElevenLabs' sound-generation endpoint for each id, then post-processes the
// result with ffmpeg (mono, 16kHz, loudness-normalized, leading silence trimmed) into
// client/audio/sfx/<id>.ogg, and writes client/audio/sfx/manifest.json (id -> { file, seconds }).
// client/audio.js fetches each clip and decodes it via AudioContext.decodeAudioData() -- there's
// no <audio> element involved.
//
// Without ffmpeg on PATH (or without a usable Ogg encoder), clips can't be produced in a format
// client/audio.js can decode, so encoding is skipped for every id (the ElevenLabs API isn't even
// called, to avoid spending quota on output that can't be used) and the manifest is still written
// for whatever clips already exist on disk from a previous run. Every id keeps using
// client/audio.js's synthesized fallback until it has a usable clip.
//
// If neither ELEVENLABS_API_KEY nor ELEVENLABS_API is set, this prints setup instructions and
// exits 0 (not an error) -- the game already falls back to the WebAudio synth for any effect with
// no pre-rendered clip, so a fresh checkout works fine without ever running this script.
//
// Usage:
//   ELEVENLABS_API_KEY=... node tools/generate-sfx.mjs [id ...]
// With no ids given, every effect in sfx-lines.json is (re)generated.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFfmpeg, detectOggEncoder, runFfmpeg } from './lib/ffmpeg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINES_PATH = path.join(ROOT, 'client', 'sfx-lines.json');
const OUT_DIR = path.join(ROOT, 'client', 'audio', 'sfx');
const MANIFEST_PATH = path.join(OUT_DIR, 'manifest.json');

const PROMPT_INFLUENCE = 0.6;
// ElevenLabs' sound-generation endpoint rejects duration_seconds below 0.5 (many of this game's
// effects -- a dagger tick, an arrow twang -- are meant to be shorter than that once trimmed).
// Request at least the API minimum and let ffmpeg's silence-trim pass (see processToOgg() below)
// bring the *final* clip down closer to the intended length; sfx-lines.json's "seconds" stays the
// intended/nominal length used for the manifest and README, not the literal API request value.
const MIN_API_DURATION = 0.5;

async function synthesize(apiKey, prompt, seconds) {
  const res = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text: prompt, duration_seconds: Math.max(MIN_API_DURATION, seconds), prompt_influence: PROMPT_INFLUENCE }),
  });
  if (!res.ok) throw new Error(`ElevenLabs API ${res.status}: ${await res.text().catch(() => '')}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Post-process a raw ElevenLabs mp3 into a small, clean, mono Ogg clip: 16kHz mono, leading
 *  silence trimmed (ElevenLabs sound-generation often leaves a beat of silence up front), and
 *  loudness-normalized so every clip plays back at a consistent level through the game's SFX bus
 *  regardless of how loud the source render came out. */
async function processToOgg(inputPath, outputPath, encoderArgs) {
  const af = 'silenceremove=start_periods=1:start_threshold=-50dB,loudnorm=I=-16:TP=-1.5:LRA=11';
  await runFfmpeg(['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-af', af, ...encoderArgs, outputPath]);
}

function printInstructions() {
  console.log(`No ELEVENLABS_API_KEY (or ELEVENLABS_API) set — skipping sound-effect generation.

client/audio.js already falls back to its synthesized WebAudio sound engine for any effect with
no pre-rendered clip, so this is optional. To generate real clips:

  1. Get an API key from https://elevenlabs.io (Profile -> API Keys).
  2. Run:
       ELEVENLABS_API_KEY=sk-... node tools/generate-sfx.mjs

Requires ffmpeg (any recent version on PATH, with a Vorbis or Opus encoder) to convert ElevenLabs'
mp3 output into the mono Ogg clips the game requests -- without it, no clips are written and the
synth fallback covers every effect.

Sound generation bills roughly 200 characters per clip against your ElevenLabs quota; with ~40
effect ids that's well under a creator-tier account's quota. Be economical when regenerating: only
redo an id if its clip is clearly unusable (too long, too quiet, wrong sound).`);
}

async function main() {
  const raw = await fs.readFile(LINES_PATH, 'utf8');
  const lines = JSON.parse(raw);
  const requested = process.argv.slice(2);
  const ids = requested.length ? requested : Object.keys(lines);
  for (const id of ids) {
    if (!(id in lines)) { console.error(`Unknown sfx id: ${id} (not in client/sfx-lines.json)`); process.exitCode = 1; return; }
  }

  const apiKey = process.env.ELEVENLABS_API_KEY || process.env.ELEVENLABS_API;
  if (!apiKey) { printInstructions(); return; }

  const ffmpegPresent = await hasFfmpeg();
  const encoderArgs = ffmpegPresent ? await detectOggEncoder() : null;
  if (!ffmpegPresent) console.log('ffmpeg not found on PATH -- skipping sound-effect generation for every id (synth fallback covers all of them).');
  else if (!encoderArgs) console.log('ffmpeg has no usable Ogg encoder (libopus/libvorbis) -- skipping sound-effect generation for every id (synth fallback covers all of them).');

  if (encoderArgs) {
    await fs.mkdir(OUT_DIR, { recursive: true });
    const codecLabel = encoderArgs[1];

    for (const id of ids) {
      const entry = lines[id];
      // An "alias" entry (e.g. "magic" -> "potion", which share the same synth case in
      // client/audio.js) reuses another id's clip instead of spending API quota on an identical
      // sound -- handled entirely in writeManifest() below, nothing to generate here.
      if (entry.alias) { console.log(`Skipping "${id}" (alias of "${entry.alias}")`); continue; }
      const { prompt, seconds } = entry;
      process.stdout.write(`Generating "${id}" (${seconds}s)... `);
      const tmpPath = path.join(OUT_DIR, `${id}.raw.mp3`);
      try {
        const mp3 = await synthesize(apiKey, prompt, seconds);
        await fs.writeFile(tmpPath, mp3);
        await processToOgg(tmpPath, path.join(OUT_DIR, `${id}.ogg`), encoderArgs);
        console.log(`ok (.ogg, ${codecLabel})`);
      } catch (err) {
        console.log(`FAILED: ${err.message}`);
        process.exitCode = 1;
      } finally {
        // Always remove the temp file, even when synth/encode fails, so a partial run doesn't
        // leave stray `.raw.mp3` artifacts in OUT_DIR.
        await fs.rm(tmpPath, { force: true });
      }
    }
  }

  await writeManifest();
}

/** Lists every sfx id that has a .ogg clip on disk (client/audio.js only ever requests
 *  "<id>.ogg"), alongside its nominal duration from sfx-lines.json. An "alias" id (see the loop
 *  above) points at its target id's already-resolved manifest entry -- same file on disk, no
 *  duplicate bytes -- rather than needing its own clip. */
async function writeManifest() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const raw = await fs.readFile(LINES_PATH, 'utf8');
  const lines = JSON.parse(raw);
  const manifest = {};
  for (const [id, entry] of Object.entries(lines)) {
    if (entry.alias) continue; // resolved in the second pass below, once targets are known
    const file = `${id}.ogg`;
    try {
      await fs.access(path.join(OUT_DIR, file));
      manifest[id] = { file, seconds: entry.seconds };
    } catch { /* no clip yet */ }
  }
  for (const [id, entry] of Object.entries(lines)) {
    if (entry.alias && manifest[entry.alias]) manifest[id] = { ...manifest[entry.alias] };
  }
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote ${MANIFEST_PATH} (${Object.keys(manifest).length}/${Object.keys(lines).length} effects have clips).`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
