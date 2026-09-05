// Regression test for the title-media static assets (client/media/*) added for GitHub issue #21:
// the generated backdrop/loop/trailer must actually be reachable through the real static file
// server with the right MIME types, and the pages that reference them must still load. Uses the
// shared startServer() helper, which boots server/index.js as a child process on a free port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

test('title backdrop/loop media and the attract/trailer pages are served correctly', async () => {
  const server = await startServer();
  const { baseUrl } = server;
  try {
    const expectations = [
      ['/media/title-backdrop.webp', 'image/webp'],
      ['/media/title-card.webp', 'image/webp'],
      ['/media/title-loop.mp4', 'video/mp4'],
      ['/media/trailer.mp4', 'video/mp4'],
    ];
    for (const [urlPath, mime] of expectations) {
      const res = await fetch(baseUrl + urlPath);
      assert.equal(res.status, 200, `GET ${urlPath} should succeed`);
      assert.equal(res.headers.get('content-type'), mime, `${urlPath} content-type`);
    }

    const attract = await fetch(baseUrl + '/attract.html');
    assert.equal(attract.status, 200, 'GET /attract.html should succeed');
    const attractHtml = await attract.text();
    assert.match(attractHtml, /backdrop-video/);
    assert.match(attractHtml, /\/media\/title-loop\.mp4/);

    const trailerPage = await fetch(baseUrl + '/trailer.html');
    assert.equal(trailerPage.status, 200, 'GET /trailer.html should succeed');
    assert.match(await trailerPage.text(), /\/media\/trailer\.mp4/);
  } finally {
    await server.stop();
  }
});
