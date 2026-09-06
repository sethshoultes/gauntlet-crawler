// Unit tests for the pure cache-busting helpers (#38): server/assets.js. See server/index.js
// serveStatic() for how these get wired into real HTTP responses, and test/server-static.test.js
// for the integration-level assertions (headers, end-to-end HTML/JS rewriting).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeAssetVersion, versionHtml, versionJs } from '../server/assets.js';

// ---------- computeAssetVersion ----------

test('computeAssetVersion: 12 hex chars, stable across repeated calls, changes with any file content', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gauntlet-assets-'));
  try {
    await mkdir(path.join(dir, 'client'));
    await mkdir(path.join(dir, 'shared'));
    await writeFile(path.join(dir, 'client', 'a.js'), 'export const a = 1;\n');
    await writeFile(path.join(dir, 'shared', 'b.js'), 'export const b = 2;\n');
    const dirs = [
      { dir: path.join(dir, 'client'), prefix: '' },
      { dir: path.join(dir, 'shared'), prefix: 'shared/' },
    ];

    const v1 = computeAssetVersion(dirs);
    const v2 = computeAssetVersion(dirs);
    assert.match(v1, /^[0-9a-f]{12}$/);
    assert.equal(v1, v2, 'must be deterministic across repeated calls with unchanged files');

    await writeFile(path.join(dir, 'client', 'a.js'), 'export const a = 2;\n'); // change one byte
    const v3 = computeAssetVersion(dirs);
    assert.notEqual(v3, v1, 'must change when any file under a hashed dir changes');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('computeAssetVersion: a client/x.js and a shared/x.js with identical names+contents do not collide', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gauntlet-assets-'));
  try {
    await mkdir(path.join(dir, 'client'));
    await mkdir(path.join(dir, 'shared'));
    await writeFile(path.join(dir, 'client', 'x.js'), 'same bytes\n');
    const dirs = [
      { dir: path.join(dir, 'client'), prefix: '' },
      { dir: path.join(dir, 'shared'), prefix: 'shared/' },
    ];
    const onlyClient = computeAssetVersion(dirs);
    await writeFile(path.join(dir, 'shared', 'x.js'), 'same bytes\n'); // identical name+contents, different dir
    const both = computeAssetVersion(dirs);
    assert.notEqual(onlyClient, both, 'adding shared/x.js must change the version even though it duplicates client/x.js byte-for-byte');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('computeAssetVersion: file rename (same total content, different path) changes the version', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gauntlet-assets-'));
  try {
    await mkdir(path.join(dir, 'client'));
    await mkdir(path.join(dir, 'shared'));
    await writeFile(path.join(dir, 'client', 'a.js'), 'x');
    const dirs = [{ dir: path.join(dir, 'client'), prefix: '' }, { dir: path.join(dir, 'shared'), prefix: 'shared/' }];
    const before = computeAssetVersion(dirs);
    await rm(path.join(dir, 'client', 'a.js'));
    await writeFile(path.join(dir, 'client', 'b.js'), 'x');
    const after = computeAssetVersion(dirs);
    assert.notEqual(before, after, 'renaming a file must change the version even though the bytes are identical');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('computeAssetVersion: independent of filesystem readdir order (nested dirs included)', async () => {
  const dirA = await mkdtemp(path.join(tmpdir(), 'gauntlet-assets-a-'));
  const dirB = await mkdtemp(path.join(tmpdir(), 'gauntlet-assets-b-'));
  try {
    for (const [d, names] of [[dirA, ['a.js', 'b.js', 'nested']], [dirB, ['b.js', 'nested', 'a.js']]]) {
      await mkdir(path.join(d, 'client'));
      await mkdir(path.join(d, 'shared'));
      for (const n of names) {
        if (n === 'nested') {
          await mkdir(path.join(d, 'client', 'nested'));
          await writeFile(path.join(d, 'client', 'nested', 'c.js'), 'nested content');
        } else {
          await writeFile(path.join(d, 'client', n), n);
        }
      }
    }
    const dirsFor = (d) => [{ dir: path.join(d, 'client'), prefix: '' }, { dir: path.join(d, 'shared'), prefix: 'shared/' }];
    assert.equal(computeAssetVersion(dirsFor(dirA)), computeAssetVersion(dirsFor(dirB)));
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

// ---------- versionHtml ----------

test('versionHtml: versions script src, stylesheet/manifest href and modulepreload href', () => {
  const html = [
    '<script type="module" src="/game.js"></script>',
    '<link rel="stylesheet" href="/style.css" />',
    '<link rel="manifest" href="/manifest.webmanifest" />',
    '<link rel="modulepreload" href="/shared/constants.js">',
  ].join('\n');
  const out = versionHtml(html, 'deadbeef1234');
  assert.match(out, /src="\/game\.js\?v=deadbeef1234"/);
  assert.match(out, /href="\/style\.css\?v=deadbeef1234"/);
  assert.match(out, /href="\/manifest\.webmanifest\?v=deadbeef1234"/);
  assert.match(out, /href="\/shared\/constants\.js\?v=deadbeef1234"/);
});

test('versionHtml: never touches /sw.js', () => {
  const html = '<script src="/sw.js"></script>';
  assert.equal(versionHtml(html, 'v1'), html);
});

test('versionHtml: never touches an external or protocol-relative URL', () => {
  const html = [
    '<script src="https://cdn.example.com/lib.js"></script>',
    '<link rel="stylesheet" href="//cdn.example.com/x.css" />',
  ].join('\n');
  assert.equal(versionHtml(html, 'v1'), html);
});

test('versionHtml: never touches a URL that already carries a query string', () => {
  const html = '<link rel="stylesheet" href="/style.css?cachebust=1" />';
  assert.equal(versionHtml(html, 'v1'), html);
});

test('versionHtml: leaves an icon/apple-touch-icon link (not js/css/manifest/modulepreload) alone', () => {
  const html = '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />';
  assert.equal(versionHtml(html, 'v1'), html);
});

test('versionHtml: leaves a data: URI icon link alone', () => {
  const html = '<link rel="icon" href="data:image/svg+xml,%3Csvg/%3E" />';
  assert.equal(versionHtml(html, 'v1'), html);
});

test('versionHtml: handles single-quoted attributes the same as double-quoted', () => {
  const html = "<script src='/game.js'></script>";
  assert.equal(versionHtml(html, 'v1'), "<script src='/game.js?v=v1'></script>");
});

test('versionHtml: a <script> with no src, or a src that is not .js, is left alone', () => {
  const html = '<script>console.log(1)</script>\n<link rel="preconnect" href="/foo.txt" />';
  assert.equal(versionHtml(html, 'v1'), html);
});

// ---------- versionJs ----------

test('versionJs: versions relative and root-absolute static import specifiers', () => {
  const src = "import { a } from './common.js';\nimport * as X from '/shared/constants.js';\n";
  const out = versionJs(src, 'v1');
  assert.match(out, /from '\.\/common\.js\?v=v1'/);
  assert.match(out, /from '\/shared\/constants\.js\?v=v1'/);
});

test('versionJs: versions re-export from-clauses (named and star)', () => {
  const src = "export { b } from './b.js';\nexport * from './c.js';\n";
  const out = versionJs(src, 'v1');
  assert.match(out, /export \{ b \} from '\.\/b\.js\?v=v1'/);
  assert.match(out, /export \* from '\.\/c\.js\?v=v1'/);
});

test('versionJs: versions a dynamic import()', () => {
  const src = "import('/shared/dyn.js').then((m) => m.run());";
  const out = versionJs(src, 'v1');
  assert.match(out, /import\('\/shared\/dyn\.js\?v=v1'\)/);
});

test('versionJs: versions a bare side-effect import', () => {
  const src = "import './side-effect.js';\n";
  assert.equal(versionJs(src, 'v1'), "import './side-effect.js?v=v1';\n");
});

test('versionJs: double-quoted specifiers are versioned too', () => {
  const src = 'import { a } from "./common.js";';
  assert.equal(versionJs(src, 'v1'), 'import { a } from "./common.js?v=v1";');
});

test('versionJs: never touches navigator.serviceWorker.register(\'/sw.js\', ...)', () => {
  const src = "navigator.serviceWorker.register('/sw.js', { type: 'module' });";
  assert.equal(versionJs(src, 'v1'), src);
});

test('versionJs: never touches import.meta', () => {
  const src = 'const u = import.meta.url;';
  assert.equal(versionJs(src, 'v1'), src);
});

test('versionJs: never touches a bare package specifier', () => {
  const src = "import { WebSocketServer } from 'ws';";
  assert.equal(versionJs(src, 'v1'), src);
});

test('versionJs: never touches a non-.js import (e.g. JSON)', () => {
  const src = "import data from './voice-lines.json';";
  assert.equal(versionJs(src, 'v1'), src);
});

test('versionJs: never touches a specifier that already carries a query', () => {
  const src = "import { a } from './common.js?raw';";
  assert.equal(versionJs(src, 'v1'), src);
});

test('versionJs: never touches an external https:// or protocol-relative import', () => {
  const src = "import x from 'https://cdn.example.com/lib.js';\nimport y from '//cdn.example.com/lib.js';";
  assert.equal(versionJs(src, 'v1'), src);
});

test('versionJs: rewriting a string that only looks like an import inside a comment is harmless (result stays valid JS)', () => {
  // The rewriter works on text, not a real parser -- a comment that happens to look like an
  // import gets rewritten too. That's fine: a comment is never evaluated, so the file is still
  // valid, functionally-identical JS either way (explicitly allowed by #38's acceptance notes).
  const src = "// see import './old-example.js' for context\nimport { a } from './common.js';";
  const out = versionJs(src, 'v1');
  assert.match(out, /\.\/common\.js\?v=v1/);
  assert.doesNotThrow(() => new Function(out.replace(/^import.*$/m, ''))); // sanity: still parses as JS
});
