// Regression test for the static file server (server/index.js serveStatic()): a request whose
// decoded path escapes the intended /shared or /client directory (via a raw ".." segment, or one
// smuggled past Node's URL dot-segment normalization inside a %2f-encoded slash) must never be
// able to read files elsewhere in the repo — including the sqlite database, server source, or
// package.json. Boots the real server as a child process (like test/smoke.mjs) since the
// traversal only manifests through the real HTTP request-path parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

test('static file traversal is blocked; legitimate /shared and /client files still serve', async () => {
  const server = await startServer();
  const { baseUrl } = server;

  try {
    // A literal ".." is already collapsed by Node's URL parser before serveStatic ever sees it,
    // so the historically dangerous case is a slash smuggled in as %2f, which survives that
    // normalization and only becomes ".." after serveStatic's own decodeURIComponent().
    const traversalPaths = [
      '/shared/..%2fserver/db.js',
      '/shared/..%2f..%2fpackage.json',
      '/shared/..%2fdata/gauntlet.sqlite',
      '/shared/%2e%2e%2fserver%2fdb.js',
    ];
    for (const p of traversalPaths) {
      const res = await fetch(baseUrl + p);
      assert.ok(res.status === 403 || res.status === 404, `${p} should be blocked, got HTTP ${res.status}`);
    }

    // Hostile paths must never crash the process: a NUL byte used to make fs.readFile throw
    // synchronously inside the request handler, taking the whole server down with a 000 response.
    for (const p of ['/%00', '/style.css%00.png', '/shared/%00constants.js', '/%zz']) {
      const res = await fetch(baseUrl + p);
      assert.ok([400, 403, 404].includes(res.status), `${p} should be rejected, got HTTP ${res.status}`);
    }
    assert.equal(server.exitCode, null, 'server must still be running after hostile paths');

    // The fix must not break legitimate access to shared/ and client/ files.
    const shared = await fetch(baseUrl + '/shared/constants.js');
    assert.equal(shared.status, 200, 'GET /shared/constants.js should still succeed');
    assert.match(await shared.text(), /CLASSES/);

    const index = await fetch(baseUrl + '/');
    assert.equal(index.status, 200, 'GET / should still serve index.html');
  } finally {
    await server.stop();
  }
});
