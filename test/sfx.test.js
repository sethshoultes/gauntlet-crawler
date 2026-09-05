// Sound-effects clip pipeline (#20 clips): every id in client/audio.js's `sfx(name)` switch must
// have a matching entry in client/sfx-lines.json (source of truth for tools/generate-sfx.mjs),
// and the shipped manifest (client/audio/sfx/manifest.json) must be valid JSON whose files all
// exist on disk, are non-empty, and are actually Ogg containers (magic bytes "OggS").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Pulls every `case 'id':` label out of the sfx(name) switch in client/audio.js. Deliberately a
 *  simple regex scan (same approach as test/voice.test.js's say() id extraction), not a JS
 *  parser -- good enough to keep sfx-lines.json in sync with the switch. */
function extractSfxIds(src) {
  const ids = new Set();
  const re = /\bcase\s+'([a-zA-Z0-9_]+)'\s*:/g;
  let m;
  while ((m = re.exec(src))) ids.add(m[1]);
  return ids;
}

test('every case in client/audio.js\'s sfx(name) switch exists in client/sfx-lines.json', async () => {
  const src = await fs.readFile(path.join(ROOT, 'client', 'audio.js'), 'utf8');
  const ids = extractSfxIds(src);
  assert.ok(ids.size > 0, 'expected to find at least one case in the sfx(name) switch');

  const linesRaw = await fs.readFile(path.join(ROOT, 'client', 'sfx-lines.json'), 'utf8');
  const lines = JSON.parse(linesRaw);
  const missing = [...ids].filter((id) => !(id in lines));
  assert.deepEqual(missing, [], `sfx id(s) used in audio.js but missing from sfx-lines.json: ${missing.join(', ')}`);
});

test('every sfx-lines.json entry has a non-empty prompt and a sane duration (or a valid alias)', async () => {
  const linesRaw = await fs.readFile(path.join(ROOT, 'client', 'sfx-lines.json'), 'utf8');
  const lines = JSON.parse(linesRaw);
  assert.ok(Object.keys(lines).length > 0);
  for (const [id, entry] of Object.entries(lines)) {
    // An "alias" entry (e.g. "magic" -> "potion", ids that share a synth case in
    // client/audio.js) reuses another id's clip rather than carrying its own prompt/duration.
    if (entry.alias) {
      assert.ok(entry.alias in lines, `sfx-lines.json["${id}"].alias "${entry.alias}" must itself be a known id`);
      assert.ok(!lines[entry.alias].alias, `sfx-lines.json["${id}"].alias must not point at another alias`);
      continue;
    }
    assert.equal(typeof entry.prompt, 'string', `sfx-lines.json["${id}"].prompt must be a string`);
    assert.ok(entry.prompt.length > 0, `sfx-lines.json["${id}"].prompt must not be empty`);
    assert.equal(typeof entry.seconds, 'number', `sfx-lines.json["${id}"].seconds must be a number`);
    assert.ok(entry.seconds > 0 && entry.seconds <= 3, `sfx-lines.json["${id}"].seconds should be a short clip length, got ${entry.seconds}`);
  }
});

test('client/audio/sfx/manifest.json is valid JSON whose clips exist, are non-empty, and are real Ogg files', async () => {
  const manifestPath = path.join(ROOT, 'client', 'audio', 'sfx', 'manifest.json');
  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  assert.equal(typeof manifest, 'object');
  assert.ok(manifest !== null);
  assert.ok(!Array.isArray(manifest));

  const linesRaw = await fs.readFile(path.join(ROOT, 'client', 'sfx-lines.json'), 'utf8');
  const lines = JSON.parse(linesRaw);

  for (const [id, entry] of Object.entries(manifest)) {
    assert.ok(id in lines, `manifest id "${id}" is not a known sfx id in sfx-lines.json`);
    assert.equal(typeof entry.file, 'string', `manifest["${id}"].file must be a string`);
    assert.equal(typeof entry.seconds, 'number', `manifest["${id}"].seconds must be a number`);

    const filePath = path.join(ROOT, 'client', 'audio', 'sfx', entry.file);
    const buf = await fs.readFile(filePath);
    assert.ok(buf.length > 0, `${entry.file} must not be empty`);
    assert.equal(buf.subarray(0, 4).toString('latin1'), 'OggS', `${entry.file} must be a real Ogg container (magic bytes "OggS")`);
  }
});
