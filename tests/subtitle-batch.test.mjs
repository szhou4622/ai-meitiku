import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AliyunSubtitleService } from '../electron/aliyun-subtitle-service.mjs';
import { DEFAULT_SUBTITLE_REGION as region, applySubtitleRegion, parseSubtitleDraft, serializeSubtitleDraft } from '../app/subtitle-batch.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
const keys = {accessKeyId:'testSavedAccessKey123', accessKeySecret:'testSavedSecret123456', browserMode:'embedded'};
async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'subtitle-batch-'));
  const files = new Map(), submissions = [], events = [];
  const secureStore = {readEncrypted:async key => files.get(key) || null, writeEncrypted:async(key,text) => files.set(key,text)};
  const client = {submit: async(file,box) => {submissions.push({file,box}); return `job-${submissions.length}-1234567890123456`;}, query:async() => ({status:'PROCESS_SUCCESS',result:{VideoUrl:'https://test.aliyuncs.com/result.mp4'}}), ...options.client};
  const service = await new AliyunSubtitleService({secureStore, interval:600000,
    probe: async file => ({path:file,name:path.basename(file),width:640,height:360,duration:2}),
    download: async(_url,file) => {await writeFile(file,'result');return {sizeBytes:6};},
    clientFactory: credentials => {assert.equal(credentials.accessKeyId,keys.accessKeyId); return client;},
    onChange: state => events.push(state), ...options.service}).initialize();
  await service.saveConfig(keys);
  t.after(async() => {service.shutdown(); await rm(directory,{recursive:true,force:true});});
  const entries = [1,2,3].map(i => ({id:`item-${i}`,path:path.join(directory,`${i}.mp4`),region:{...region}}));
  const start = () => service.startBatch({entries,outputDirectory:directory,consent:true,syncToMediaLibrary:true});
  return {service,files,secureStore,submissions,entries,start,events,directory};
}
test('batch reuses saved credentials and immutable regions; serial worker progresses with no renderer attached', async t => {
  const ctx = await setup(t);
  const config = ctx.files.get('aliyun-subtitle-settings.v1.bin');
  await ctx.start(); await flush();
  ctx.entries[0].region.BY = 0;
  assert.equal(ctx.submissions.length,1);
  assert.equal(ctx.submissions[0].box.BY,.75);
  await ctx.service.tick(); assert.equal(ctx.submissions.length,2);
  await ctx.service.tick(); assert.equal(ctx.submissions.length,3);
  await ctx.service.tick();
  const state = ctx.service.publicState();
  assert.equal(state.batch.completed,3); assert.equal(state.batch.active,0);
  assert.equal(ctx.files.get('aliyun-subtitle-settings.v1.bin'),config);
  assert.ok(state.jobs.every(job => job.syncToMediaLibrary && job.status==='completed'));
  assert.ok(ctx.events.some(state => state.batch?.completed===3));
  assert.ok(!JSON.stringify(ctx.events).includes(keys.accessKeySecret));
  await assert.rejects(ctx.service.retry(state.jobs[0].id)); assert.equal(ctx.submissions.length,3);
});

test('VIP expiry during probing pauses unsent jobs, preserves records, and permits explicit resume after renewal', async t => {
  let release, allowed = true;
  const assertAccess = () => { if (!allowed) throw Object.assign(new Error('无权'), {code:'FEATURE_NOT_ENTITLED'}); };
  const ctx = await setup(t, {service:{assertAccess, probe:file => new Promise(resolve => {release = () => resolve({path:file,name:path.basename(file)});})}});
  await ctx.start(); await flush();
  allowed = false; release(); await flush();
  assert.equal(ctx.submissions.length, 0);
  assert.equal(ctx.service.publicState().batch.paused, 3);
  assert.match(ctx.service.jobs[0].message, /VIP权益已失效/);
  await assert.rejects(ctx.service.resumeBatch(ctx.service.jobs[0].batchId), /无权/);
  assert.equal(ctx.service.jobs.length, 3);
  allowed = true;
  ctx.service.probe = async file => ({path:file,name:path.basename(file)});
  await ctx.service.resumeBatch(ctx.service.jobs[0].batchId); await flush();
  assert.equal(ctx.submissions.length, 1);
  allowed = false;
  await ctx.service.tick();
  assert.equal(ctx.submissions.length, 1, 'expiry must stop the next paid submission');
  assert.equal(ctx.service.publicState().batch.completed, 1, 'already accepted result is preserved');
  assert.equal(ctx.service.publicState().batch.paused, 2);
});
test('pause and cancel during local probing cannot submit that file; resume uses original queued intent', async t => {
  let release;
  const ctx = await setup(t,{service:{probe: file => new Promise(resolve => {release = () => resolve({path:file,name:path.basename(file)});})}});
  await ctx.start(); await flush();
  assert.equal(ctx.service.jobs[0].status,'preparing');
  await ctx.service.pauseBatch(ctx.service.jobs[0].batchId);
  release(); await flush(); assert.equal(ctx.submissions.length,0);
  assert.equal(ctx.service.publicState().batch.paused,3);
  ctx.service.probe = async file => ({path:file,name:path.basename(file)});
  await ctx.service.resumeBatch(ctx.service.jobs[0].batchId); await flush(); assert.equal(ctx.submissions.length,1);
  await ctx.service.cancelPending(ctx.service.jobs[0].batchId);
  await ctx.service.tick(); await ctx.service.tick();
  assert.equal(ctx.submissions.length,1); assert.equal(ctx.service.publicState().batch.cancelled,2);
  assert.equal(ctx.service.publicState().batch.completed,1);
});
test('new batch cannot race an existing queue or switch its saved account', async t => {
  const ctx = await setup(t);
  await ctx.start(); await flush();
  await assert.rejects(ctx.start(),/等待/);
  await assert.rejects(ctx.service.saveConfig({...keys,accessKeyId:'otherSavedAccessKey123'}),/仍有/);
  await ctx.service.pauseBatch(ctx.service.jobs[0].batchId); await ctx.service.tick();
  await assert.rejects(ctx.service.saveConfig({...keys,accessKeyId:'otherSavedAccessKey123'}),/等待提交/);
});
test('restart keeps old records and credentials; known cloud job resumes, unsent items pause instead of recharging', async t => {
  const ctx = await setup(t); await ctx.start(); await flush(); ctx.service.shutdown();
  let queries=0,submitted=0;
  const restarted = await new AliyunSubtitleService({secureStore:ctx.secureStore, interval:600000, probe:async file=>({path:file}),
    clientFactory: credentials => {assert.equal(credentials.accessKeySecret,keys.accessKeySecret);return {submit:async()=>{submitted++;},query:async()=>{queries++;return {status:'PROCESSING'};}};}}).initialize();
  t.after(()=>restarted.shutdown()); await restarted.tick();
  assert.equal(queries,1); assert.equal(submitted,0); assert.equal(restarted.publicState().batch.paused,2);
  assert.equal(restarted.publicState().configured,true); assert.equal(restarted.publicState().browserMode,'embedded');
  assert.equal(restarted.jobs.length,3);
});
test('uncertain paid submission pauses following files and never auto resubmits; recover and resume query the existing job', async t => {
  const ctx = await setup(t,{client:{submit:async()=>{throw Object.assign(new Error('private signed URL'),{code:'ETIMEDOUT'});}}});
  await ctx.start(); await flush();
  assert.equal(ctx.service.jobs[0].status,'unknown'); assert.equal(ctx.service.publicState().batch.paused,2);
  await ctx.service.tick(); await assert.rejects(ctx.service.resumeBatch(ctx.service.jobs[0].batchId),/先找回/);
  assert.ok(!JSON.stringify(ctx.service.publicState()).includes('private signed URL'));
  await ctx.service.recoverJobId(ctx.service.jobs[0].id,'official-recovered-id-123456'); await ctx.service.tick();
  assert.equal(ctx.service.jobs[0].status,'completed');
});
test('preflight file error skips only that file and never calls cloud; next item remains processable', async t => {
  const ctx=await setup(t,{service:{probe:async file=>{if(path.basename(file)==='1.mp4')throw Error('offline');return {path:file};}}});
  await ctx.start();await flush(); assert.equal(ctx.service.jobs[0].status,'preflight-error');assert.equal(ctx.submissions.length,0);
  await ctx.service.tick(); assert.equal(ctx.submissions.length,1); assert.ok(ctx.submissions[0].file.endsWith('2.mp4'));
});
test('write failures and invalid batch prevent all paid calls', async t => {
  const ctx=await setup(t);
  await assert.rejects(ctx.service.startBatch({entries:ctx.entries,consent:false}),/确认/);
  await assert.rejects(ctx.service.startBatch({entries:[ctx.entries[0],ctx.entries[0]],outputDirectory:ctx.directory,consent:true}),/重复/);
  ctx.secureStore.writeEncrypted=async()=>{throw Error('disk full');};
  await assert.rejects(ctx.start(),/未上传或提交/); await ctx.service.tick();
  assert.equal(ctx.submissions.length,0); assert.equal(ctx.service.jobs.length,0);
});
test('pausing after upload starts does not cancel accepted cloud jobs; query/download recovery never adds a paid submission', async t => {
  let release, calls=0, queries=0;
  const ctx=await setup(t,{client:{submit:()=>{calls++;return new Promise(resolve=>{release=resolve;});},query:async()=>{queries++;if(queries===1)throw {code:'Forbidden'};return {status:'PROCESS_SUCCESS',result:{VideoUrl:'https://test.aliyuncs.com/result.mp4'}};}}});
  await ctx.start();await flush();await ctx.service.pauseBatch(ctx.service.jobs[0].batchId);
  release('accepted-job-123456789');await flush();await ctx.service.tick();
  assert.equal(ctx.service.jobs[0].status,'query-error');assert.equal(calls,1);
  await ctx.service.retry(ctx.service.jobs[0].id);await ctx.service.tick();
  assert.equal(ctx.service.jobs[0].status,'completed');assert.equal(calls,1);assert.equal(ctx.service.publicState().batch.paused,2);
});
test('renderer drafts keep per-video boxes, selection and sync choice across restore; URLs and submitted boxes remain separate', () => {
  const source={id:'one',path:'/one.mp4',url:'http://temporary-token',region:{...region},checked:true};
  const other={...source,id:'two',path:'/two.mp4',region:{...region}};
  const applied=applySubtitleRegion([source,other],{BX:.1,BY:.8,BW:.8,BH:.1},['one']);
  assert.equal(applied[0],source);assert.notEqual(applied[1].region,source.region);assert.equal(applied[1].region.BY,.8);
  const raw=serializeSubtitleDraft({entries:applied,activeId:'two',output:'/output',sync:true});
  assert.ok(!raw.includes('temporary-token')); const draft=parseSubtitleDraft(raw);
  assert.equal(draft.activeId,'two');assert.equal(draft.entries[1].region.BY,.8);assert.equal(draft.sync,true);
  assert.throws(()=>parseSubtitleDraft('{broken')); assert.throws(()=>applySubtitleRegion(applied,{...region,BY:1}));
});
