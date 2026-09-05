// Narrator voice pipeline (#19): every id passed to say(...) in client/game.js must have a matching
// entry in client/voice-lines.json (source of truth for tools/generate-voice.mjs), and the shipped
// manifest (client/audio/voice/manifest.json) must be valid JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Pulls every `say('some_id', ...)` call's first-argument id out of a JS source string. Only
 *  matches the two-argument id-based form (a bare string literal for the first arg) — this is
 *  deliberately a simple regex scan (per the task), not a JS parser. */
function extractSayIds(src) {
  const ids = new Set();
  const re = /\bsay\(\s*['"]([a-zA-Z0-9_]+)['"]/g;
  let m;
  while ((m = re.exec(src))) ids.add(m[1]);
  return ids;
}

test('every say(id, ...) id used in client/game.js exists in client/voice-lines.json', async () => {
  const src = await fs.readFile(path.join(ROOT, 'client', 'game.js'), 'utf8');
  const ids = extractSayIds(src);
  assert.ok(ids.size > 0, 'expected to find at least one say(id, ...) call in client/game.js');

  const linesRaw = await fs.readFile(path.join(ROOT, 'client', 'voice-lines.json'), 'utf8');
  const lines = JSON.parse(linesRaw);
  const missing = [...ids].filter((id) => !(id in lines));
  assert.deepEqual(missing, [], `voice line id(s) used in game.js but missing from voice-lines.json: ${missing.join(', ')}`);
});

test('every voice-lines.json entry is a non-empty string', async () => {
  const linesRaw = await fs.readFile(path.join(ROOT, 'client', 'voice-lines.json'), 'utf8');
  const lines = JSON.parse(linesRaw);
  assert.ok(Object.keys(lines).length > 0);
  for (const [id, text] of Object.entries(lines)) {
    assert.equal(typeof text, 'string', `voice-lines.json["${id}"] must be a string`);
    assert.ok(text.length > 0, `voice-lines.json["${id}"] must not be empty`);
  }
});

test('client/audio/voice/manifest.json is valid JSON (an object)', async () => {
  const raw = await fs.readFile(path.join(ROOT, 'client', 'audio', 'voice', 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw);
  assert.equal(typeof manifest, 'object');
  assert.ok(manifest !== null);
  assert.ok(!Array.isArray(manifest));
});
