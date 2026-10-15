import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { AliyunSubtitleService } from '../electron/aliyun-subtitle-service.mjs';
import { validateRegion, cloudErrorMessage, safeResultUrl, probeVideo, downloadAliyunResult, createAliyunClient } from '../electron/aliyun-subtitle-client.mjs';
import { createAliyunBrowser, isAliyunPage, aliyunLinks } from '../electron/aliyun-browser.mjs';
import { subtitleDisplayDirectory, subtitleDisplayText } from '../electron/subtitle-display.mjs';

const region = { BX: 0, BY: .75, BW: 1, BH: .25 };
const fakeKeys = { accessKeyId: 'testAccessKey12345', accessKeySecret: 'testSecret123456789', browserMode: 'system' };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('historical status copy is neutral while credentials, task identifiers and saved paths stay unchanged', () => {
  const service = new AliyunSubtitleService({});
  const job = { id: 'old', batchId: 'batch', status: 'paused', jobId: 'request-id', credentialFingerprint: 'private', message: '请检查阿里云连接后继续', outputPath: '/Downloads/阿里云去字幕/result.mp4' };
  service.jobs = [job];
  const state = service.publicState();
  assert.doesNotMatch(state.jobs[0].message, /阿里云/);
  assert.doesNotMatch(state.batch.message, /阿里云/);
  assert.equal(state.jobs[0].jobId, job.jobId);
  assert.equal(state.jobs[0].outputPath, job.outputPath);
  assert.equal(state.jobs[0].credentialFingerprint, undefined);
  assert.equal(service.jobs[0], job);
  assert.equal(job.message, '请检查阿里云连接后继续');
  assert.doesNotMatch(subtitleDisplayDirectory('/Downloads/阿里云去字幕'), /阿里云/);
  assert.equal(subtitleDisplayDirectory('/Downloads/成片'), '/Downloads/成片');
  assert.doesNotMatch(subtitleDisplayText('阿里云处理中'), /阿里云/);
  assert.doesNotMatch(subtitleDisplayText('ALIYUN_TIMEOUT: https://x.aliyuncs.com/file?secret=unsafe'), /aliyun|aliyuncs|secret|https:/i);
  assert.doesNotMatch(subtitleDisplayText('MiniMax / 火山引擎 / volcengine 返回失败'), /MiniMax|火山|volcengine/i);
});
function store() {
  const files = new Map();
  return { files, readEncrypted: async key => files.get(key) || null, writeEncrypted: async (key, text) => { files.set(key, text); } };
}
async function setup(t, custom = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'aliyun-tests-'));
  let submissions = 0, queries = 0;
  const secureStore = custom.secureStore || store();
  const fakeClient = {
    verify: async () => {},
    submit: async () => { submissions++; return 'official-job-id-123456'; },
    query: async () => { queries++; return { status: 'PROCESS_SUCCESS', result: JSON.stringify({ VideoUrl: 'https://test.oss-cn-shanghai.aliyuncs.com/result.mp4' }) }; },
    ...custom.client,
  };
  const probe = async input => ({ path: input, name: path.basename(input), width: 640, height: 360, duration: 3, sizeBytes: 100 });
  const service = await new AliyunSubtitleService({ secureStore, probe, clientFactory: () => fakeClient, interval: 600000,
    download: async (_url, output) => { await writeFile(output, 'local-result'); return { sizeBytes: 12, sha256: 'checked-hash' }; }, ...custom, }).initialize();
  await service.saveConfig(fakeKeys);
  t.after(async () => { service.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const submit = () => service.submit({ path: path.join(directory, 'video.mp4'), outputDirectory: directory, region, consent: true });
  return { directory, service, secureStore, submit, submissions: () => submissions, queries: () => queries };
}

test('official SDK constructs the real advance and asynchronous-query clients', () => {
  const client = createAliyunClient(fakeKeys);
  assert.equal(typeof client.submit, 'function'); assert.equal(typeof client.query, 'function');
});
test('paid submission requires consent, valid region, output folder and prevents concurrent duplicate jobs', async t => {
  let release;
  const { service, submit, directory } = await setup(t, { client: { submit: () => new Promise(resolve => { release = resolve; }) } });
  await assert.rejects(service.submit({ consent: false }), /确认/);
  await assert.rejects(service.submit({ consent: true, region: { ...region, BH: .5 } }), /区域/);
  await assert.rejects(service.submit({ consent: true, region, path: '/video.mp4', outputDirectory: path.join(directory, 'absent') }));
  await submit();
  await assert.rejects(submit(), /等待/);
  release('official-job-id-123456'); await flush();
  assert.equal(service.publicState().jobs[0].status, 'queued');
});
test('submission → query → durable local result → import marker, with keys absent from public state', async t => {
  const { service, submit, submissions, queries, secureStore } = await setup(t);
  await submit(); await flush(); await service.tick();
  const state = service.publicState(), job = state.jobs[0];
  assert.equal(job.status, 'completed'); assert.equal(await readFile(job.outputPath, 'utf8'), 'local-result');
  assert.equal(submissions(), 1); assert.equal(queries(), 1);
  assert.equal(JSON.stringify(state).includes(fakeKeys.accessKeySecret), false);
  assert.equal(secureStore.files.get('aliyun-subtitle-jobs.v1.bin').includes('https:'), false);
  await service.markImported(job.id); assert.ok(service.publicState().jobs[0].importedAt);
  await assert.rejects(service.retry(job.id));
});
test('timeout leaves an uncertain job and never resubmits automatically; manual RequestId recovery only queries', async t => {
  const { service, submit, submissions } = await setup(t, { client: { submit: async () => { throw Object.assign(new Error('secret signed URL'), { code: 'ETIMEDOUT' }); } } });
  await submit(); await flush();
  const job = service.publicState().jobs[0];
  assert.equal(job.status, 'unknown'); assert.equal(job.message.includes('secret signed URL'), false);
  await service.tick(); assert.equal(service.publicState().jobs[0].status, 'unknown');
  await service.recoverJobId(job.id, 'official-job-id-123456'); await service.tick();
  assert.equal(service.publicState().jobs[0].status, 'completed'); assert.equal(submissions(), 0);
});
test('download failure can retry original job without a new paid submission', async t => {
  let downloads = 0;
  const { service, submit, submissions } = await setup(t, { download: async (_url, output) => { if (++downloads === 1) throw new Error('expired'); await writeFile(output, 'ok'); return {}; } });
  await submit(); await flush(); await service.tick();
  const job = service.publicState().jobs[0]; assert.equal(job.status, 'download-error');
  await service.retry(job.id); await service.tick();
  assert.equal(service.publicState().jobs[0].status, 'completed'); assert.equal(submissions(), 1);
});
test('restart recovers known job without submission and isolates uncertain submission', async t => {
  const { service, submit, secureStore } = await setup(t);
  await submit(); await flush(); service.shutdown();
  const jobs = JSON.parse(secureStore.files.get('aliyun-subtitle-jobs.v1.bin'));
  jobs.push({ ...jobs[0], id: 'uncertain', jobId: '', status: 'submitting' });
  await secureStore.writeEncrypted('aliyun-subtitle-jobs.v1.bin', JSON.stringify(jobs));
  let submissions = 0, queries = 0;
  const recovered = await new AliyunSubtitleService({ secureStore, probe: async () => ({}), interval: 600000,
    clientFactory: () => ({ submit: async () => { submissions++; }, query: async () => { queries++; return { status: 'PROCESSING' }; } }) }).initialize();
  t.after(() => recovered.shutdown()); await recovered.tick();
  assert.equal(submissions, 0); assert.equal(queries, 1); assert.equal(recovered.jobs[1].status, 'unknown');
});
test('query errors, server failure, config replacement and safe error redaction', async t => {
  const { service, submit } = await setup(t, { client: { query: async () => { throw { code: 'Forbidden', message: fakeKeys.accessKeySecret }; } } });
  await submit(); await flush();
  await assert.rejects(service.saveConfig({ ...fakeKeys, accessKeyId: 'differentKey12345' }), /仍有/);
  await service.tick(); assert.equal(service.jobs[0].status, 'query-error');
  assert.match(service.jobs[0].message, /拒绝/); assert.ok(!service.jobs[0].message.includes(fakeKeys.accessKeySecret));
  await service.saveConfig({ accessKeyId: '', accessKeySecret: '', browserMode: 'embedded' });
  assert.equal(service.publicState().configured, true);
  await assert.rejects(service.saveConfig({ ...fakeKeys, accessKeySecret: '' }), /同时/);
  assert.match(cloudErrorMessage({ code: 'SignatureDoesNotMatch', message: 'private' }), /密钥/);
  await service.retry(service.jobs[0].id);
  service.clientFactory = () => ({ query: async () => ({ status: 'LIMIT_RETRY_FAILED' }) });
  await service.tick(); assert.equal(service.jobs[0].status, 'failed');
});
test('region and returned URLs reject invalid values and non-OSS destinations', () => {
  assert.deepEqual(validateRegion(region), region);
  for (const bad of [{ ...region, BX: NaN }, { ...region, BW: 0 }, { ...region, BX: .2 }, { ...region, BY: '0' }]) assert.throws(() => validateRegion(bad));
  for (const url of ['https://127.0.0.1/a', 'file:///a', 'https://aliyuncs.com.evil.test/a', 'https://user:secret@test.aliyuncs.com/a', 'https://test.aliyuncs.com:444/a']) assert.throws(() => safeResultUrl(url));
  assert.equal(safeResultUrl('http://test.aliyuncs.com/a?Signature=secret'), 'https://test.aliyuncs.com/a?Signature=secret');
});
test('real MP4 validation and streamed download are checked by FFmpeg and SHA-256; corrupt outputs never complete', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aliyun-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ffmpeg = process.env.FFMPEG_BIN || path.resolve('bundled-tools', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const input = path.join(directory, 'input.mp4'), output = path.join(directory, 'result.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', input]);
  const media = await probeVideo(input, ffmpeg); assert.equal(media.width, 640); assert.equal(media.duration, 1);
  const bytes = await readFile(input);
  const options = { fetchImpl: async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } }), probe: (p, opts) => probeVideo(p, ffmpeg, opts) };
  const result = await downloadAliyunResult('https://test.aliyuncs.com/a', output, options);
  assert.equal(result.sizeBytes, (await stat(output)).size); assert.match(result.sha256, /^[a-f0-9]{64}$/);
  execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'null', '-']);
  const invalid = path.join(directory, 'invalid.mp4');
  await assert.rejects(downloadAliyunResult('https://test.aliyuncs.com/a', invalid, { ...options, fetchImpl: async () => new Response('broken mp4') }));
  await assert.rejects(stat(invalid));
  await assert.rejects(downloadAliyunResult('https://test.aliyuncs.com/a', invalid, { ...options, fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }) }));
});
test('both browser routes work and embedded navigation has no preload or Node access', async () => {
  let external, options, load, navigation, popup;
  class Window extends EventEmitter {
    constructor(opts) { super(); options = opts; this.webContents = new EventEmitter(); this.webContents.on('will-navigate', (event, url) => { navigation = [event, url]; }); this.webContents.setWindowOpenHandler = fn => { popup = fn; }; Window.latest = this; }
    isDestroyed() { return false; } async loadURL(url) { load = url; } show() {} focus() {}
  }
  const open = createAliyunBrowser({ BrowserWindow: Window, shell: { openExternal: async url => { external = url; } }, session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) } });
  await open('guide', 'system'); assert.equal(external, aliyunLinks.guide);
  await open('keys', 'system'); assert.equal(external, 'https://ram.console.aliyun.com/manage/ak');
  await open('keys', 'embedded'); assert.equal(load, 'https://ram.console.aliyun.com/manage/ak'); assert.equal(options.webPreferences.nodeIntegration, false); assert.equal(options.webPreferences.preload, undefined); assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.title, '去字幕服务');
  let titlePrevented = false;
  Window.latest.emit('page-title-updated', { preventDefault() { titlePrevented = true; } }, '阿里云控制台');
  assert.equal(titlePrevented, true);
  let prevented = false; Window.latest.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'file:///etc/passwd'); assert.equal(prevented, true); assert.ok(navigation);
  assert.deepEqual(popup({ url: 'javascript:alert(1)' }), { action: 'deny' });
  assert.equal(isAliyunPage('https://help.aliyun.com/path'), true); assert.equal(isAliyunPage('https://aliyun.com.evil.test/'), false);
  await assert.rejects(open('unknown', 'system')); await assert.rejects(open('guide', 'invalid'));
});

test('SDK adapter forwards normalized region, local stream and RequestId without automatic paid retries', async t => {
  const Video = (await import('@alicloud/videoenhan20200320')).default;
  const Sts = (await import('@alicloud/sts20150401')).default;
  const directory = await mkdtemp(path.join(tmpdir(), 'aliyun-sdk-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'input.mp4'); await writeFile(file, 'sdk-local-stream');
  let payload, runtime, queried;
  t.mock.method(Video.default.prototype, 'eraseVideoSubtitlesAdvance', async (request, options) => {
    payload = request; runtime = options;
    let actual = ''; for await (const chunk of request.videoUrlObject) actual += chunk;
    assert.equal(actual, 'sdk-local-stream');
    return { body: { requestId: 'request-as-job-id-1234' } };
  });
  t.mock.method(Video.default.prototype, 'getAsyncJobResultWithOptions', async request => {
    queried = request.jobId;
    return { body: { data: { status: 'QUEUING' } } };
  });
  t.mock.method(Sts.default.prototype, 'getCallerIdentityWithOptions', async options => {
    assert.equal(options.autoretry, false); return { body: {} };
  });
  const client = createAliyunClient(fakeKeys);
  await client.verify();
  const jobId = await client.submit(file, region);
  assert.equal(jobId, 'request-as-job-id-1234');
  assert.deepEqual({ BX: payload.BX, BY: payload.BY, BW: payload.BW, BH: payload.BH }, region);
  assert.equal(runtime.autoretry, false); assert.equal(runtime.maxAttempts, 1);
  assert.equal((await client.query(jobId)).status, 'QUEUING'); assert.equal(queried, jobId);
});

test('failed durable intent does not upload and is recoverable for a later explicit submit', async t => {
  const context = await setup(t);
  const originalWrite = context.secureStore.writeEncrypted;
  context.secureStore.writeEncrypted = async () => { throw new Error('disk full'); };
  await assert.rejects(context.submit(), /未上传或提交/);
  assert.equal(context.service.publicState().jobs.length, 0); assert.equal(context.submissions(), 0);
  context.secureStore.writeEncrypted = originalWrite;
  await context.submit(); await flush(); assert.equal(context.submissions(), 1);
});

test('switching credentials never queries a job using a different account', async t => {
  const { service, submit, queries } = await setup(t);
  await submit(); await flush();
  service.jobs[0].status = 'query-error';
  await service.saveConfig({ ...fakeKeys, accessKeyId: 'anotherAccountKey12345' });
  await assert.rejects(service.retry(service.jobs[0].id), /提交此任务时/);
  assert.equal(queries(), 0);
});

test('completed response without result URL cannot mark a local task completed', async t => {
  const { service, submit } = await setup(t, { client: { query: async () => ({ status: 'PROCESS_SUCCESS', result: '{}' }) } });
  await submit(); await flush(); await service.tick();
  assert.equal(service.jobs[0].status, 'query-error'); await assert.rejects(stat(service.jobs[0].outputPath));
});

test('first submission creates only the configured default output folder without requiring a folder picker', async t => {
  const parent = await mkdtemp(path.join(tmpdir(), 'aliyun-default-'));
  const directory = path.join(parent, '阿里云去字幕');
  t.after(() => rm(parent, { recursive: true, force: true }));
  const { service, submissions } = await setup(t, { defaultOutputDirectory: directory });
  assert.equal(service.publicState().defaultOutputDirectory, directory);
  await assert.rejects(stat(directory));
  await service.submit({ path: path.join(parent, 'video.mp4'), region, consent: true }); await flush();
  assert.equal((await stat(directory)).isDirectory(), true);
  assert.equal(path.dirname(service.jobs[0].outputPath), directory); assert.equal(submissions(), 1);
});

test('visual selection maps resized preview pixels to the API region in either drag direction', async () => {
  const { subtitlePoint, subtitleRectangle } = await import('../app/subtitle-region.mjs');
  const bounds = { left: 100, top: 50, width: 640, height: 360 };
  const start = subtitlePoint(164, 320, bounds);
  const end = subtitlePoint(676, 392, bounds);
  const box = subtitleRectangle(start, end);
  assert.equal(box.BX, .1); assert.equal(box.BY, .75); assert.equal(box.BW, .8);
  assert.ok(Math.abs(box.BH - .2) < .000001);
  assert.deepEqual(subtitleRectangle(end, start), box);
  assert.deepEqual(subtitleRectangle(subtitlePoint(0, 0, bounds), subtitlePoint(2000, 1500, bounds)), { BX: 0, BY: 0, BW: 1, BH: 1 });
  assert.deepEqual(validateRegion(box), box);
  assert.equal(subtitlePoint(0, 0, { left: 0, top: 0, width: 0, height: 360 }), null);
});

test('auto-sync choice and failure survive restart; retry import clears error without cloud submission', async t => {
  const { service, directory, secureStore, submissions } = await setup(t);
  await service.submit({ path: path.join(directory, 'video.mp4'), outputDirectory: directory, region, consent: true, syncToMediaLibrary: true });
  await flush(); await service.tick();
  const job = service.jobs[0];
  assert.equal(job.syncToMediaLibrary, true);
  await service.markImportFailed(job.id);
  assert.equal(job.status, 'completed'); assert.equal(job.importedAt, null);
  service.shutdown();
  const restarted = await new AliyunSubtitleService({ secureStore, probe: async () => ({}), interval: 600000 }).initialize();
  t.after(() => restarted.shutdown());
  assert.equal(restarted.jobs[0].syncToMediaLibrary, true); assert.ok(restarted.jobs[0].importError);
  await restarted.markImported(job.id);
  assert.ok(restarted.jobs[0].importedAt); assert.equal(restarted.jobs[0].importError, ''); assert.equal(submissions(), 1);
});

test('unchecked job stays opt-out and failed marker write cannot claim import success', async t => {
  const { service, submit, secureStore } = await setup(t);
  await submit(); await flush(); await service.tick();
  const job = service.jobs[0]; assert.equal(job.syncToMediaLibrary, false);
  secureStore.writeEncrypted = async () => { throw new Error('disk full'); };
  await assert.rejects(service.markImported(job.id)); assert.equal(job.importedAt, null);
});

test('points mode refuses personal credentials before submission, while an existing personal task keeps querying', async t => {
  let own = true;
  const { service, submit, submissions } = await setup(t, { getApiSelection: async () => ({ provider: 'aliyun', apiMode: own ? 'customer_api' : 'platform_api', usesSoftwarePoints: !own }) });
  own = false;
  await assert.rejects(submit(), { code: 'PLATFORM_API_UNAVAILABLE' });
  await assert.rejects(service.verify(), { code: 'PLATFORM_API_UNAVAILABLE' });
  assert.equal(submissions(), 0);
  assert.equal(service.jobs.length, 0);
  assert.equal(service.publicState().configured, false);
  own = true;
  await submit(); await flush();
  assert.equal(service.jobs[0].apiSelection.apiMode, 'customer_api');
  own = false;
  await service.tick();
  assert.equal(service.jobs[0].status, 'completed');
  assert.equal(submissions(), 1);
  await assert.rejects(submit(), { code: 'PLATFORM_API_UNAVAILABLE' });
});

test('a queued subtitle batch keeps the original personal mode for each file after a switch change', async t => {
  let own = true;
  const { service, directory, submissions } = await setup(t, { getApiSelection: async () => ({ provider: 'aliyun', apiMode: own ? 'customer_api' : 'platform_api', usesSoftwarePoints: !own }) });
  await service.startBatch({ consent: true, outputDirectory: directory, entries: [{ path: path.join(directory, 'one.mp4'), region }, { path: path.join(directory, 'two.mp4'), region }] });
  own = false;
  await flush();
  for (let i = 0; i < 5; i++) { await service.tick(); await flush(); }
  assert.equal(submissions(), 2);
  assert.ok(service.jobs.every(job => job.apiSelection.apiMode === 'customer_api' && job.status === 'completed'));
});

test('platform subtitles persist the quote before running and never use saved personal keys', async t => {
  const calls = [];
  const quoteId = 'a'.repeat(40);
  const { service, submit, submissions, directory } = await setup(t, {
    getApiSelection: async () => ({ provider: 'aliyun', apiMode: 'platform_api', usesSoftwarePoints: true }),
    getPlatformStatus: async () => ({ ready: true }),
    platformUpload: async filePath => { assert.equal(path.extname(filePath), '.mp4'); return { upload_id: 'b'.repeat(48) }; },
    platformExecute: async input => { calls.push(input); await input.onQuoted(quoteId); return { quoteId, result: { VideoUrl: 'https://bucket.aliyuncs.com/test.mp4' }, billingPending: true }; },
    platformStatus: async () => { throw new Error('stored result already available'); },
  });
  await writeFile(path.join(directory, 'video.mp4'), 'test bytes');
  await submit();
  for (let i = 0; i < 30 && service.jobs[0].status === 'submitting'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  await service.tick();
  assert.equal(service.jobs[0].status, 'completed');
  assert.equal(service.jobs[0].jobId, quoteId);
  assert.equal(service.jobs[0].billingPending, true);
  assert.equal(submissions(), 0);
  assert.equal(calls.length, 1); assert.equal(calls[0].feature, 'subtitle-removal');
  assert.equal(calls[0].payload.apiKey, undefined);
  assert.equal(calls[0].payload.video, undefined);
  assert.equal(calls[0].payload.upload_id, 'b'.repeat(48));
});

test('platform upload failure pauses safely before quoting and does not become an uncertain paid task', async t => {
  let quotes=0;
  const {service,submit,directory}=await setup(t,{
    getApiSelection:async()=>({provider:'aliyun',apiMode:'platform_api',usesSoftwarePoints:true}),
    getPlatformStatus:async()=>({ready:true}),platformUpload:async()=>{throw new Error('synthetic upload timeout');},
    platformExecute:async()=>{quotes++;},platformStatus:async()=>({}),
  });
  await writeFile(path.join(directory,'video.mp4'),'test bytes');await submit();
  for(let i=0;i<30&&service.jobs[0].status==='submitting';i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(service.jobs[0].status,'paused');assert.equal(quotes,0);
  assert.match(service.jobs[0].message,/未冻结或扣除积分/);assert.ok(!service.jobs[0].jobId);
});

test('lost quote response resumes with identical uploaded bytes and logical request identity', async t => {
  let uploads=0;const quotes=[];
  const {service,submit,directory}=await setup(t,{
    getApiSelection:async()=>({provider:'aliyun',apiMode:'platform_api',usesSoftwarePoints:true}),
    getPlatformStatus:async()=>({ready:true}),platformUpload:async()=>{uploads++;return {upload_id:'c'.repeat(48)};},
    platformExecute:async input=>{quotes.push(input);if(quotes.length===1)throw new Error('lost quote response');
      await input.onQuoted('d'.repeat(40));return {quoteId:'d'.repeat(40),result:{VideoUrl:'https://bucket.aliyuncs.com/test.mp4'}};},
    platformStatus:async()=>({}),
  });
  await writeFile(path.join(directory,'video.mp4'),'test bytes');await submit();
  for(let i=0;i<30&&service.jobs[0].status==='submitting';i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(service.jobs[0].status,'paused');await flush();await service.resumeBatch(service.jobs[0].batchId);
  for(let i=0;i<30&&!service.jobs[0].jobId;i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(uploads,1);assert.equal(quotes.length,2);assert.equal(quotes[0].requestId,quotes[1].requestId);
  assert.deepEqual(quotes[0].payload,quotes[1].payload);assert.equal(service.jobs[0].jobId,'d'.repeat(40));
});

test('confirmed platform failure is terminal and pauses remaining batch without claiming it is free', async t => {
  const {service} = await setup(t);
  const job={id:'synthetic-failed',batchId:'one',status:'submitting',jobId:'a'.repeat(40),apiSelection:{apiMode:'platform_api'}};
  const waiting={id:'synthetic-next',batchId:'one',status:'waiting'};
  service.jobs=[job,waiting];
  await service.finishSubmit(job,{submit:async()=>{throw Object.assign(new Error('private'),{terminalFailure:true,billingPending:true});}});
  assert.equal(job.status,'failed'); assert.equal(waiting.status,'paused');
  assert.equal(job.billingPending,true); assert.match(job.message,/结算待核对/);
  assert.doesNotMatch(job.message,/未扣|免费|aliyun|private/i);
});

test('retry download refreshes cached platform URL and never quotes or generates again', async t => {
  let queries=0, downloads=0;
  const {service,directory}=await setup(t,{
    platformExecute:async()=>{throw new Error('must not generate');},
    platformUpload:async()=>{throw new Error('must not upload');},
    platformStatus:async()=>{queries++;return {status:'succeeded',result:{VideoUrl:'https://test.aliyuncs.com/fresh.mp4',download_expires_at:Date.now()/1000+900,size_bytes:12,sha256:'checked-hash'}};},
    download:async(url,output,options)=>{downloads++;assert.match(url,/fresh.mp4/);assert.equal(options.expectedSize,12);await writeFile(output,'local-result');return {sizeBytes:12,sha256:'checked-hash'};},
  });
  const job={id:'download-test',jobId:'a'.repeat(40),status:'download-error',apiSelection:{apiMode:'platform_api'},
    outputPath:path.join(directory,'retry.mp4'),platformResult:{VideoUrl:'https://test.aliyuncs.com/expired.mp4'}};
  service.jobs=[job];await service.retry(job.id);await service.tick();
  assert.equal(job.status,'completed');assert.equal(queries,1);assert.equal(downloads,1);
  assert.match(job.platformResult.VideoUrl,/fresh/);
});

test('expired retained output reports download state without resubmitting paid generation', async t => {
  const {service}=await setup(t,{platformExecute:async()=>{throw new Error('must not generate');},platformUpload:async()=>{},
    platformStatus:async()=>({status:'succeeded',result:{download_error:'SUBTITLE_RESULT_EXPIRED'}})});
  const job={id:'expired-output',jobId:'b'.repeat(40),status:'download-error',apiSelection:{apiMode:'platform_api'}};
  service.jobs=[job];await service.retry(job.id);await service.tick();
  assert.equal(job.status,'download-error');assert.match(job.message,/暂存已过期/);assert.doesNotMatch(job.message,/aliyun/i);
});

test('restart during a confirmed platform task queries the durable quote without reconnecting or resubmitting',async t=>{
 const context=await setup(t);const {secureStore,directory}=context;context.service.shutdown();
 const id='c'.repeat(40);let queries=0,executions=0;
 await secureStore.writeEncrypted('aliyun-subtitle-jobs.v1.bin',JSON.stringify([{id:'restart',jobId:id,status:'submitting',platformPhase:'retrieving',apiSelection:{apiMode:'platform_api'},name:'video.mp4',sourcePath:path.join(directory,'video.mp4'),outputPath:path.join(directory,'result.mp4')} ]));
 const restarted=await new AliyunSubtitleService({secureStore,probe:async()=>({duration:5}),getApiSelection:async()=>({apiMode:'platform_api'}),getPlatformStatus:async()=>({ready:true}),platformUpload:async()=>{throw new Error('must not upload');},platformExecute:async()=>{executions++;throw new Error('must not submit');},platformStatus:async quote=>{assert.equal(quote,id);queries++;return {status:'executing',transfer:{phase:'storing'}};}}).initialize();
 t.after(()=>restarted.shutdown());assert.equal(restarted.jobs[0].status,'processing');
 await restarted.refresh(restarted.jobs[0]);assert.equal(queries,1);assert.equal(executions,0);assert.match(restarted.jobs[0].message,/转存/);
});
