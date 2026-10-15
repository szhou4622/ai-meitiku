import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EventEmitter } from 'node:events';

// Execute the current production handler and its actual shared stream semaphore.
const main = await readFile(new URL('../electron/main.mjs', import.meta.url), 'utf8');
const slots = main.slice(main.indexOf('function dispatchMediaStreamWaiters()'), main.indexOf('async function pipeRegisteredMedia('));
const preview = main.slice(main.indexOf('async function serveQianchuanPreview('), main.indexOf('async function serveLocalVisualModel('));
function harness(fetchImpl, entries = new Map([['valid', { url: 'https://example.invalid/video', expiresAt: Date.now() + 60000 }]])) {
  const logs = [];
  const make = new Function('fetch', 'Readable', 'pipeline', 'qianchuanPreviewByToken', 'qianchuanInternals', 'applicationLog', `
    let activeMediaStreams=0;
    const MAX_ACTIVE_MEDIA_STREAMS=2, mediaStreamWaiters=[], QIANCHUAN_PREVIEW_MAX_BYTES=100;
    ${slots}
    ${preview}
    return { serve:serveQianchuanPreview, counts:()=>({active:activeMediaStreams,waiting:mediaStreamWaiters.length}) };
  `);
  return { ...make(fetchImpl, Readable, pipeline, entries, { qianchuanDownloadHeaders: () => ({ 'x-fixture': 'unchanged' }), assertSafeDownloadUrl: () => {} }, { write: (...args) => logs.push(args) }), logs };
}
function exchange(method = 'GET', range) {
  const req = Object.assign(new EventEmitter(), { method, headers: range ? { range } : {}, destroyed: false, diagnosticRequestId: 'fixture' });
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  res.headersSent = false;
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
  return { req, res, chunks };
}
async function until(fn) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); }
  throw Error('Test condition did not settle');
}
const doneSlots = h => assert.deepEqual(h.counts(), { active: 0, waiting: 0 });

test('preview preserves Range headers and bytes, and HEAD releases the stream slot', async () => {
  const requests = [];
  const h = harness(async (_url, options) => {
    requests.push(options);
    return new Response(options.method === 'HEAD' ? null : 'abcdef', { status: 206, headers: { 'content-range': 'bytes 2-7/8', 'content-length': '6', 'accept-ranges': 'bytes', 'content-type': 'video/mp4' } });
  });
  for (const method of ['GET', 'HEAD']) {
    const x = exchange(method, 'bytes=2-7');
    await h.serve(x.req, x.res, 'valid');
    assert.equal(x.res.status, 206);
    assert.equal(x.res.headers['Content-Range'], 'bytes 2-7/8');
    assert.equal(Buffer.concat(x.chunks).toString(), method === 'GET' ? 'abcdef' : '');
    doneSlots(h);
    assert.equal(x.req.listenerCount('aborted'), 0);
  }
  assert.equal(requests[0].headers.Range, 'bytes=2-7');
  assert.equal(requests[0].headers['x-fixture'], 'unchanged');
  assert.equal(h.logs.length, 0);
});

test('upstream body reset is consumed and logged, and a later preview still works', async () => {
  let first = true;
  const h = harness(async () => {
    if (!first) return new Response('recovered');
    first = false;
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); setTimeout(() => c.error(new Error('fixture upstream reset')), 5); } }));
  });
  const broken = exchange();
  await h.serve(broken.req, broken.res, 'valid');
  assert.equal(broken.res.destroyed, true);
  doneSlots(h);
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0][1], 'qianchuan.preview.stream.error');
  const good = exchange(); await h.serve(good.req, good.res, 'valid');
  assert.equal(Buffer.concat(good.chunks).toString(), 'recovered'); doneSlots(h);
});

test('client abort cancels in-flight fetch and is not reported as a developer error', async () => {
  let signal;
  const h = harness(async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
  });
  const x = exchange(); const pending = h.serve(x.req, x.res, 'valid');
  await until(() => signal); x.req.emit('aborted'); x.res.destroy(); await pending;
  assert.equal(signal.aborted, true); doneSlots(h); assert.equal(h.logs.length, 0);
});

test('closing a playing preview cancels its upstream body and frees the slot', async () => {
  let cancelled = false;
  const h = harness(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } })));
  const x = exchange(); const pending = h.serve(x.req, x.res, 'valid');
  await until(() => x.chunks.length); x.res.destroy(); await pending;
  assert.equal(cancelled, true); doneSlots(h); assert.equal(h.logs.length, 0);
});

test('concurrent previews share the slot cap; cancelled and expired waiters never fetch', async () => {
  let calls = 0;
  const bodies = [];
  const entries = new Map([['valid', { url: 'https://example.invalid/video', expiresAt: Date.now() + 60000 }], ['expires', { url: 'https://example.invalid/old', expiresAt: Date.now() + 60000 }]]);
  const h = harness(async () => { calls++; return new Response(new ReadableStream({ start(c) { bodies.push(c); } })); }, entries);
  const a = exchange(), b = exchange(), c = exchange(), d = exchange();
  const pa = h.serve(a.req, a.res, 'valid'), pb = h.serve(b.req, b.res, 'valid');
  await until(() => bodies.length === 2);
  const pc = h.serve(c.req, c.res, 'valid'), pd = h.serve(d.req, d.res, 'expires');
  assert.deepEqual(h.counts(), { active: 2, waiting: 2 });
  c.req.destroyed = true; c.req.emit('aborted'); c.res.destroy(); await pc;
  entries.get('expires').expiresAt = Date.now() - 1;
  bodies[0].close(); bodies[1].close(); await Promise.all([pa, pb, pd]);
  assert.equal(calls, 2); assert.equal(d.res.status, 404); doneSlots(h);
  const e = exchange(); const pe = h.serve(e.req, e.res, 'valid'); await until(() => bodies.length === 3); bodies[2].close(); await pe;
  assert.equal(calls, 3); doneSlots(h);
});

test('rejected headers cancel unread bodies and network failures return 502 before headers', async () => {
  for (const [status, headers, expected] of [[503, {}, 503], [200, { 'content-length': '101' }, 413]]) {
    let cancelled = false;
    const h = harness(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers }));
    const x = exchange(); await h.serve(x.req, x.res, 'valid');
    assert.equal(x.res.status, expected); assert.equal(cancelled, true); doneSlots(h);
  }
  const h = harness(async () => { throw Error('fixture network failure'); });
  const x = exchange(); await h.serve(x.req, x.res, 'valid');
  assert.equal(x.res.status, 502); assert.equal(h.logs.length, 1); doneSlots(h);
});
