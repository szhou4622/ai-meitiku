import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mediaByteRange } from '../electron/media-range.mjs';

test('local playback sends exact bytes for suffix, open, clipped, and invalid ranges', async () => {
  // Execute the production handler without starting Electron or loading user data.
  const source = await readFile(new URL('../electron/main.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function dispatchMediaStreamWaiters()'), source.indexOf('async function serveQianchuanPreview('));
  const filePath = fileURLToPath(new URL('../package.json', import.meta.url));
  const bytes = await readFile(filePath);
  const createHandler = new Function('createReadStream', 'stat', 'path', 'mediaByteRange', 'mediaFilesByToken', 'applicationLog', `
    let activeMediaStreams = 0;
    const MAX_ACTIVE_MEDIA_STREAMS = 2, mediaStreamWaiters = [], mediaContentTypes = {}, contentTypes = {};
    ${code}
    return serveRegisteredMedia;
  `);
  const handler = createHandler(createReadStream, stat, path, mediaByteRange, new Map([['test', filePath]]), { write() {} });
  const server = createServer((req, res) => handler(req, res, 'test').catch(() => res.destroy()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    for (const [range, status, expected, contentRange] of [
      ['', 200, bytes, null],
      ['bytes=0-9', 206, bytes.subarray(0, 10), `bytes 0-9/${bytes.length}`],
      ['bytes=-10', 206, bytes.subarray(-10), `bytes ${bytes.length - 10}-${bytes.length - 1}/${bytes.length}`],
      ['bytes=10-', 206, bytes.subarray(10), `bytes 10-${bytes.length - 1}/${bytes.length}`],
      ['bytes=0-999999', 206, bytes, `bytes 0-${bytes.length - 1}/${bytes.length}`],
      ['bytes=999999-', 416, Buffer.alloc(0), `bytes */${bytes.length}`],
      ['bytes=20-10', 416, Buffer.alloc(0), `bytes */${bytes.length}`],
      ['bytes=-0', 416, Buffer.alloc(0), `bytes */${bytes.length}`],
      ['bytes=0-1,4-5', 200, bytes, null],
    ]) {
      const response = await fetch(url, { headers: range ? { range } : {}, signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, status, range);
      assert.equal(response.headers.get('content-range'), contentRange, range);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, range);
    }
    const head = await fetch(url, { method: 'HEAD', headers: { range: 'bytes=-10' } });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-length'), '10');
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(url).then(r => r.arrayBuffer())));
    for (const result of responses) assert.deepEqual(Buffer.from(result), bytes);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('empty files and oversized suffix ranges have explicit bounds', () => {
  assert.deepEqual(mediaByteRange('bytes=0-', 0), { unsatisfiable: true });
  assert.deepEqual(mediaByteRange('bytes=-999', 10), { start: 0, end: 9 });
  assert.deepEqual(mediaByteRange('bytes=9007199254740992-', 10), { unsatisfiable: true });
  assert.equal(mediaByteRange('bytes=-', 10), null);
});
