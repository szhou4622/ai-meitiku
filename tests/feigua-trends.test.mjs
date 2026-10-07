import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { FEIGUA_SOURCES, normalizeKeywords, normalizeMusicTag, normalizeMusicTagOptions, validateMusicTag, validateCapture, isFeiguaDataUrl, normalizeVideoQueries, normalizeVideoOptions, validateVideoQueries } from '../electron/feigua-contract.mjs';
import { FeiguaService, dueHotspotsDate, dueVideosDate } from '../electron/feigua-service.mjs';
import { FeiguaBrowser, isFeiguaNavigation } from '../electron/feigua-browser.mjs';
import { featureRegistry, requireFeatureAccess } from '../electron/feature-registry.mjs';
import { displayedFeiguaGroups } from '../app/feigua-results.mjs';

const capture = (kind, keyword = null, extra = {}) => ({
  url: `https://dy.feigua.cn/test/${kind}`, keyword, sort: FEIGUA_SOURCES[kind].sort, direction: 'desc', period: FEIGUA_SOURCES[kind].period,
  musicTag: [], categoryPath: [], tagPath: [], filtersVerified: true, dateRange: '2026-09-25 - 2026-10-01',
  rows: Array.from({ length: 7 }, (_, index) => ({ id: `${kind}-${index}`, title: `合成测试标题${index}`, author: '合成测试作者', yesterdayUsers: '10w', participantGrowth: '20%', peakHeat: '100w', sales: '10w~25w', products: [{ title: '合成测试商品', commission: '5.00%' }] })),
  ...extra,
});

function fixture({ stored, collect, auth, write } = {}) {
  let disk = stored || { version: 1, loginEntryUrl: 'https://dy.feigua.cn/', keywords: [], runs: [] };
  const calls = [];
  const browser = {
    async openLogin() {}, async checkLogin() { return auth || { status: 'authenticated', message: '已登录' }; },
    async collect(kind, keyword, signal, options) { calls.push([kind, keyword]); return collect ? collect(kind, keyword, signal, options) : capture(kind, keyword, options); },
    stop() {}, dispose() {},
  };
  const service = new FeiguaService({ userDataPath: '/unused', browser, storage: {
    read: async () => structuredClone(disk), write: async value => { if (write) await write(value); disk = structuredClone(value); },
  } });
  return { service, calls, disk: () => disk, browser };
}

const videoCatalog = { categoryPath: [{ label: '食品', children: [{ label: '调味品', children: [{ label: '酱料', children: [] }] }] }, { label: '家居', children: [] }], tagPath: [{ label: '美食', children: [{ label: '教程', children: [] }] }, { label: '生活', children: [] }] };
const videoQueries = [{ keyword: '拌饭', categoryPath: ['食品', '调味品', '酱料'], tagPath: ['美食', '教程'] }, { keyword: '收纳', categoryPath: ['家居'], tagPath: ['生活'] }];

test('new and legacy installs can choose actual bundled categories before login or collection', async () => {
  for(const videoFilterOptions of [undefined,{categoryPath:[],tagPath:[]}]) {
    const {service,calls}=fixture({stored:{version:1,keywords:[],runs:[],videoFilterOptions}});
    const state=await service.state();
    assert.equal(state.videoFilterOptions.categoryPath.length,22);
    assert.equal(state.videoFilterOptions.tagPath.length,29);
    assert.ok(state.videoFilterOptions.categoryPath.some(option=>option.label==='美妆'));
    const selected=[{keyword:'素颜霜',categoryPath:['美妆'],tagPath:['时尚']}];
    await service.saveVideoQueries(selected);
    assert.deepEqual((await service.state()).videoQueries,selected);
    assert.equal(calls.length,0);
  }
});

test('cached live directories take precedence over the bundled snapshot', async()=>{
  const {service}=fixture({stored:{version:1,keywords:[],runs:[],videoFilterOptions:videoCatalog}});
  assert.deepEqual((await service.state()).videoFilterOptions,videoCatalog);
});

test('login with an unsaved draft refreshes catalogs without collecting saved or draft keywords',async()=>{
  const {service,browser,calls}=fixture();
  browser.getVideoFilters=async()=>videoCatalog;
  browser.getMusicTags=async()=>({options:[{label:'目录标签',children:[]}]});
  await service.saveKeywords(['已保存词']);
  await service.login({collectAfterLogin:false});
  browser.onAuthChange({status:'authenticated'});
  await service.autoStart;
  const state=await service.state();
  assert.deepEqual(state.keywords,['已保存词']);
  assert.equal(state.runs.length,0);
  assert.deepEqual(calls,[]);
  assert.deepEqual(state.videoFilterOptions,videoCatalog);
  await service.login({collectAfterLogin:false}); await service.cancel();
  browser.onAuthChange({status:'authenticated'});
  assert.equal(service.autoCatalogRequested,false);
});

test('offline catalogs remain usable when automatic provider refresh fails',async()=>{
  const {service,browser}=fixture();
  browser.getVideoFilters=async()=>{throw new Error('unavailable');};
  browser.getMusicTags=async()=>{throw new Error('unavailable');};
  await service.login({collectAfterLogin:false});browser.onAuthChange({status:'authenticated'});await service.autoStart;
  assert.equal((await service.state()).videoFilterOptions.categoryPath.length,22);
  await service.saveVideoQueries([{keyword:'素颜霜',categoryPath:['美妆'],tagPath:['时尚']}]);
  assert.match((await service.state()).catalogMessage,/仍可使用已有分类/);
});

test('per-keyword filters validate full paths, duplicate names and parent changes', () => {
  assert.deepEqual(validateVideoQueries(videoQueries, videoCatalog), videoQueries);
  assert.deepEqual(normalizeVideoQueries([{keyword:'  旧关键词  '}]), [{keyword:'旧关键词',categoryPath:[],tagPath:[]}]);
  assert.throws(() => normalizeVideoQueries([{keyword:'x'}, {keyword:' x '}]), /重复/);
  assert.throws(() => normalizeVideoQueries([{keyword:''}]), /不能为空/);
  assert.throws(() => normalizeVideoQueries([{keyword:'x',categoryPath:['全部']}]), /无效/);
  assert.throws(() => validateVideoQueries([{...videoQueries[0],categoryPath:['家居','调味品']}],videoCatalog), /失效/);
  assert.throws(() => normalizeVideoOptions([{label:'重复'}, {label:'重复'}]), /重复/);
});

test('legacy keyword configuration migrates to independent all filters and preserves history', async () => {
  const old = {version:1,keywords:['甲','乙'],runs:[{id:'old',status:'completed',groups:[]}]};
  const {service}=fixture({stored:old});
  const state=await service.state();
  assert.deepEqual(state.videoQueries,old.keywords.map(keyword=>({keyword,categoryPath:[],tagPath:[]})));
  assert.deepEqual(state.runs,old.runs);
});

test('saving keyword groups refreshes only videos and persists each independent filter through restart', async () => {
  const {service,browser,calls,disk}=fixture();
  browser.getVideoFilters=async()=>videoCatalog;
  await service.ready; await service.syncVideoFilters();
  await service.saveAndRefreshVideoQueries(videoQueries); await service.job;
  assert.deepEqual(calls,[['videos','拌饭'],['videos','收纳']]);
  assert.equal(disk().runs[0].status,'completed');
  for (const [index,query] of videoQueries.entries()) {
    assert.deepEqual(disk().runs[0].groups[index].result.filters,{...query,publishedAt:'不限'});
  }
  const restored=fixture({stored:disk()});
  assert.deepEqual((await restored.service.state()).videoQueries,videoQueries);
  assert.deepEqual((await restored.service.state()).videoFilterOptions,videoCatalog);
});

test('video filter snapshot is fixed before login awaits and edits do not affect in-flight groups', async () => {
  const {service,browser,disk}=fixture();
  browser.getVideoFilters=async()=>videoCatalog;
  await service.ready; await service.syncVideoFilters(); await service.saveVideoQueries(videoQueries);
  let release;
  browser.checkLogin=()=>new Promise(resolve=>{release=resolve;});
  const starting=service.start();
  while(!release) await new Promise(resolve=>setImmediate(resolve));
  await service.saveVideoQueries([{keyword:'拌饭',categoryPath:[],tagPath:[]}]);
  release({status:'authenticated'}); await starting; await service.job;
  assert.deepEqual(disk().runs[0].groups.filter(group=>group.kind==='videos').map(({keyword,categoryPath,tagPath})=>({keyword,categoryPath,tagPath})),videoQueries);
  assert.equal(disk().videoQueries.length,1);
  assert.equal(disk().runs[0].status,'completed');
});

test('missing or mismatched provider video filters cannot overwrite previously collected results', async () => {
  const {service,browser}=fixture();
  browser.getVideoFilters=async()=>videoCatalog;
  await service.ready; await service.syncVideoFilters();
  await service.saveAndRefreshVideoQueries(videoQueries); await service.job;
  browser.collect=async(kind,keyword)=>capture(kind,keyword); // Provider remained on All.
  await service.saveAndRefreshVideoQueries(videoQueries); await service.job;
  const state=await service.state();
  assert.equal(state.runs[0].status,'failed');
  const groups=displayedFeiguaGroups(state.runs,'',state.latestResults);
  assert.ok(groups.every(group=>group.showingPrevious && group.refreshStatus==='failed'));
  assert.deepEqual(groups[0].result.filters.categoryPath,videoQueries[0].categoryPath);
  for(const invalid of [{categoryPath:undefined},{tagPath:undefined},{categoryPath:['食品']},{tagPath:['生活']}]) {
    assert.throws(()=>validateCapture('videos','拌饭',capture('videos','拌饭',{...videoQueries[0],...invalid}),videoQueries[0]),/不一致/);
  }
});

test('keyword group saving rolls back on disk errors and deleting all groups does not collect rankings', async () => {
  const {service,calls}=fixture({stored:{version:1,keywords:videoQueries.map(query=>query.keyword),videoQueries,videoFilterOptions:videoCatalog,runs:[]},write:async()=>{throw new Error('disk full');}});
  await assert.rejects(service.saveAndRefreshVideoQueries([]),/disk full/);
  assert.deepEqual((await service.state()).videoQueries,videoQueries);
  assert.equal(calls.length,0);
  const empty=fixture(); await empty.service.saveAndRefreshVideoQueries([]);
  assert.deepEqual(empty.calls,[]); assert.deepEqual((await empty.service.state()).runs,[]);
});

test('busy keyword refresh cannot replace saved groups, and login failure preserves the saved intent', async () => {
  const {service,browser}=fixture();
  browser.getVideoFilters=async()=>videoCatalog;
  await service.ready; await service.syncVideoFilters();
  let release;
  browser.checkLogin=()=>new Promise(resolve=>{release=resolve;});
  await service.saveAndRefreshVideoQueries(videoQueries);
  await assert.rejects(service.saveAndRefreshVideoQueries([]),/正在执行/);
  release({status:'signed_out'}); await service.job;
  const state=await service.state();
  assert.deepEqual(state.videoQueries,videoQueries);
  assert.equal(state.runs[0].status,'failed');
});

test('catalogs update automatically even with no keywords; refresh errors preserve cached selections', async () => {
  const {service,browser}=fixture();
  browser.getVideoFilters=async()=>videoCatalog;
  browser.getMusicTags=async()=>({options:[{label:'榜单分类',children:[]}]});
  await service.start(); await service.job;
  assert.deepEqual((await service.state()).videoFilterOptions,videoCatalog);
  await service.saveVideoQueries(videoQueries);
  browser.getVideoFilters=async()=>{throw new Error('private payload');};
  await service.start(); await service.job;
  const state=await service.state();
  assert.deepEqual(state.videoQueries,videoQueries);
  assert.deepEqual(state.videoFilterOptions,videoCatalog);
  assert.match(state.catalogMessage,/自动加载失败/);
  assert.doesNotMatch(JSON.stringify(state),/private payload/);
});

test('browser applies both video paths, then keyword, period and sales sort for each group', async () => {
  const browser=new FeiguaBrowser({}); const calls=[];
  browser.openSource=async()=>{};browser.settle=async()=>{};
  browser.execute=async(command,args)=>{calls.push([command,args]);return {verified:true};};
  await browser.collect('videos','拌饭',undefined,videoQueries[0]);
  assert.deepEqual(calls.filter(([command])=>command==='video-filter'),[
    ['video-filter',{label:'带货品类',path:videoQueries[0].categoryPath,phase:'expand',depth:0}],
    ['video-filter',{label:'带货品类',path:videoQueries[0].categoryPath,phase:'expand',depth:1}],
    ['video-filter',{label:'带货品类',path:videoQueries[0].categoryPath,phase:'select'}],
    ['video-filter',{label:'视频标签',path:videoQueries[0].tagPath,phase:'expand',depth:0}],
    ['video-filter',{label:'视频标签',path:videoQueries[0].tagPath,phase:'select'}],
  ]);
  assert.ok(calls.some(([command,args])=>command==='keyword' && args.keyword==='拌饭'));
  assert.ok(calls.some(([command,args])=>command==='choice' && args.label==='近7天'));
  assert.ok(calls.some(([command,args])=>command==='sort' && args.label==='视频销售额'));
  calls.length=0;
  await browser.collect('videos','全部');
  assert.equal(calls[0][0],'clear');
  assert.deepEqual(calls.filter(([command])=>command==='video-filter').map(([,args])=>args.path),[[],[]]);
});

test('daily hotspots use 07:00 Beijing time across UTC date boundaries', () => {
  assert.equal(dueHotspotsDate(Date.parse('2026-10-01T22:59:59Z')), null);
  assert.equal(dueHotspotsDate(Date.parse('2026-10-01T23:00:00Z')), '2026-10-02');
  assert.equal(dueHotspotsDate(Date.parse('2026-10-02T15:59:59Z')), '2026-10-02');
  assert.equal(dueHotspotsDate(Date.parse('2026-10-02T16:00:00Z')), null);
});

test('daily keyword videos start at exactly 06:30 Beijing time and reset at midnight',()=>{
  assert.equal(dueVideosDate(Date.parse('2026-10-01T22:29:59Z')),null);
  assert.equal(dueVideosDate(Date.parse('2026-10-01T22:30:00Z')),'2026-10-02');
  assert.equal(dueHotspotsDate(Date.parse('2026-10-01T22:30:00Z')),null);
  assert.equal(dueVideosDate(Date.parse('2026-10-02T15:59:59Z')),'2026-10-02');
  assert.equal(dueVideosDate(Date.parse('2026-10-02T16:00:00Z')),null);
});

test('06:30 collects every saved video group once and preserves independent 07:00 schedule across restart',async()=>{
  const {service,calls,disk}=fixture({stored:{version:1,keywords:videoQueries.map(q=>q.keyword),videoQueries,videoFilterOptions:videoCatalog,runs:[]}});
  const now=Date.parse('2026-10-01T22:30:00Z');
  await service.checkDailySchedule(now-1,()=>true);
  await service.checkDailySchedule(now,()=>false);
  assert.equal(calls.length,0);
  await Promise.all([service.checkDailySchedule(now,()=>true),service.checkDailySchedule(now,()=>true)]);await service.job;
  assert.deepEqual(calls,[['videos','拌饭'],['videos','收纳']]);
  assert.equal(disk().lastVideosScheduleDate,'2026-10-02');
  assert.equal(disk().lastHotspotsScheduleDate,null);
  assert.equal(disk().runs[0].trigger,'daily-videos');
  assert.deepEqual(disk().runs[0].groups[0].result.filters,{...videoQueries[0],publishedAt:'不限'});
  const restored=fixture({stored:disk()});
  await restored.service.checkDailySchedule(now+1000,()=>true);
  assert.equal(restored.calls.length,0);
  await restored.service.checkDailySchedule(now+1800000,()=>true);await restored.service.job;
  assert.deepEqual(restored.calls,[['hotspots',null]]);
  await restored.service.checkDailySchedule(now+86400000,()=>true);await restored.service.job;
  assert.deepEqual(restored.calls.slice(1),[['videos','拌饭'],['videos','收纳']]);
});

test('late startup catches up videos first, waits while busy, then independently catches up hotspots',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const {service,calls,disk}=fixture({collect:async(kind,keyword,_signal,options)=>{if(kind==='videos')await gate;return capture(kind,keyword,options);}});
  await service.saveKeywords(['晚启动关键词']);
  const now=Date.parse('2026-10-02T05:00:00Z');
  await service.checkDailySchedule(now,()=>true);
  await service.checkDailySchedule(now,()=>true);
  assert.equal(disk().runs.length,1);
  release();await service.job;
  await service.checkDailySchedule(now,()=>true);await service.job;
  await service.checkDailySchedule(now,()=>true);
  assert.deepEqual(calls,[['videos','晚启动关键词'],['hotspots',null]]);
  assert.equal(disk().runs.length,2);
  assert.equal(disk().lastVideosScheduleDate,'2026-10-02');
  assert.equal(disk().lastHotspotsScheduleDate,'2026-10-02');
});

test('video schedule failure and cancellation do not retry that day or consume hotspot schedule',async()=>{
  for(const cancel of [false,true]) {
    const {service,browser,calls,disk}=fixture();await service.saveKeywords(['词']);
    let release;
    browser.checkLogin=()=>new Promise(resolve=>{release=resolve;});
    const now=Date.parse('2026-10-01T22:30:00Z');
    await service.checkDailySchedule(now,()=>true);
    if(cancel)await service.cancel();
    release({status:cancel?'authenticated':'expired'});await service.job;
    await service.checkDailySchedule(now+60000,()=>true);
    assert.equal(disk().runs[0].status,cancel?'cancelled':'failed');
    assert.equal(calls.length,0);assert.equal(disk().runs.length,1);
    assert.equal(disk().lastVideosScheduleDate,'2026-10-02');assert.equal(disk().lastHotspotsScheduleDate,null);
  }
});

test('video schedule must durably record its intent before any browser I/O',async()=>{
  const {service,browser,calls}=fixture({stored:{version:1,keywords:['词'],runs:[]},write:async()=>{throw new Error('disk full');}});
  let checks=0;browser.checkLogin=async()=>{checks++;return {status:'authenticated'};};
  await assert.rejects(service.checkDailySchedule(Date.parse('2026-10-01T22:30:00Z'),()=>true),/disk full/);
  assert.equal(checks,0);assert.equal(calls.length,0);
  const state=await service.state();assert.equal(state.lastVideosScheduleDate,null);assert.equal(state.runs.length,0);
});

test('adding or editing a keyword immediately collects only changed groups; deletion and unchanged saves do not collect',async()=>{
  const {service,calls,disk}=fixture({stored:{version:1,keywords:[],runs:[],videoFilterOptions:videoCatalog}});
  await service.saveAndRefreshVideoQueries([videoQueries[0]],{changedOnly:true});await service.job;
  assert.deepEqual(calls,[['videos','拌饭']]);calls.length=0;
  await service.saveAndRefreshVideoQueries(videoQueries,{changedOnly:true});await service.job;
  assert.deepEqual(calls,[['videos','收纳']]);calls.length=0;
  const edited=[{...videoQueries[0],categoryPath:['家居'],tagPath:['生活']},videoQueries[1]];
  await service.saveAndRefreshVideoQueries(edited,{changedOnly:true});await service.job;
  assert.deepEqual(calls,[['videos','拌饭']]);calls.length=0;
  assert.equal(disk().runs[0].trigger,'video-settings');
  assert.deepEqual(disk().runs[0].groups[0].result.filters,{...edited[0],publishedAt:'不限'});
  const runCount=disk().runs.length;
  await service.saveAndRefreshVideoQueries([...edited].reverse(),{changedOnly:true});
  await service.saveAndRefreshVideoQueries([edited[0]],{changedOnly:true});
  assert.deepEqual(calls,[]);assert.equal(disk().runs.length,runCount);
  assert.deepEqual(disk().keywords,['拌饭']);
  await service.saveAndRefreshVideoQueries([edited[0]]);await service.job;
  assert.deepEqual(calls,[['videos','拌饭']]);
});

test('new groups still collect immediately after the daily quota is used, without resetting it',async()=>{
  const {service,calls,disk}=fixture();await service.saveKeywords(['旧关键词']);
  const now=Date.parse('2026-10-01T22:30:00Z');
  await service.checkDailySchedule(now,()=>true);await service.job;calls.length=0;
  await service.saveAndRefreshVideoQueries([{keyword:'旧关键词'},{keyword:'新关键词'}],{changedOnly:true});await service.job;
  assert.deepEqual(calls,[['videos','新关键词']]);
  assert.equal(disk().lastVideosScheduleDate,'2026-10-02');
  await service.checkDailySchedule(now+1000,()=>true);assert.equal(calls.length,1);
});

test('without keywords the daily collection catches up only hotspots once per day, including after restart', async () => {
  const { service, calls, disk } = fixture();
  const now = Date.parse('2026-10-02T01:00:00Z');
  await Promise.all([service.checkDailySchedule(now, () => true), service.checkDailySchedule(now, () => true)]);
  await service.job;
  assert.deepEqual(calls, [['hotspots', null]]);
  assert.equal(disk().runs[0].trigger, 'daily-hotspots');
  assert.equal(disk().runs[0].scheduledDate, '2026-10-02');
  // The durable marker survives even when that run has fallen out of history.
  const restored = fixture({ stored: { ...disk(), runs: [] } });
  await restored.service.checkDailySchedule(now, () => true);
  assert.equal(restored.calls.length, 0);
  await restored.service.checkDailySchedule(now + 86400000, () => true);
  await restored.service.job;
  assert.deepEqual(restored.calls, [['hotspots', null]]);
});

test('daily collection waits for 07:00, authorization and idle state', async () => {
  const { service, calls, disk } = fixture();
  const now = Date.parse('2026-10-01T23:00:00Z');
  await service.checkDailySchedule(now - 1, () => true);
  await service.checkDailySchedule(now, () => false);
  service.operation = Promise.resolve();
  await service.checkDailySchedule(now, () => true);
  service.operation = null;
  assert.equal(calls.length, 0);
  assert.equal(disk().lastHotspotsScheduleDate, undefined);
  await service.checkDailySchedule(now, () => true);
  await service.job;
  assert.equal(calls.length, 1);
});

test('expired scheduled login is visible without repeated attempts or replacing prior results', async () => {
  const previous = fixture();
  await previous.service.start(); await previous.service.job;
  const { service, browser, calls, disk } = fixture({ stored: previous.disk() });
  let checks = 0;
  browser.checkLogin = async () => { checks++; return { status: 'expired', message: '请重新登录' }; };
  const now = Date.parse('2026-10-01T23:00:00Z');
  await service.checkDailySchedule(now, () => true); await service.job;
  await service.checkDailySchedule(now + 60000, () => true);
  assert.equal(checks, 1);
  assert.equal(calls.length, 0);
  assert.equal(disk().runs[0].status, 'failed');
  assert.match(disk().runs[0].message, /登录/);
  assert.equal(disk().runs[1].groups[2].result.rows.length, 5);
});

test('failed schedule persistence prevents browser I/O and rolls back the daily marker', async () => {
  const { service, browser, calls } = fixture({ write: async () => { throw new Error('disk full'); } });
  let checks = 0;
  browser.checkLogin = async () => { checks++; return { status: 'authenticated' }; };
  await assert.rejects(service.checkDailySchedule(Date.parse('2026-10-01T23:00:00Z'), () => true), /disk full/);
  assert.equal(checks, 0); assert.equal(calls.length, 0);
  const state = await service.state();
  assert.equal(state.lastHotspotsScheduleDate, null); assert.equal(state.runs.length, 0);
});

test('disposing stops the daily timer and prevents subsequent collection', async () => {
  const { service, calls } = fixture();
  service.startDailySchedule(() => false);
  const timer = service.scheduleTimer;
  service.startDailySchedule(() => false);
  assert.equal(service.scheduleTimer, timer);
  service.dispose();
  await service.checkDailySchedule(Date.parse('2026-10-01T23:00:00Z'), () => true);
  assert.equal(service.scheduleTimer, null); assert.equal(calls.length, 0);
});

test('cancelling scheduled login prevents collection and does not requeue that day', async () => {
  const { service, browser, calls, disk } = fixture();
  let release;
  browser.checkLogin = () => new Promise(resolve => { release = resolve; });
  const now = Date.parse('2026-10-01T23:00:00Z');
  await service.checkDailySchedule(now, () => true);
  await service.cancel();
  release({ status: 'authenticated' });
  await service.job;
  await service.checkDailySchedule(now + 60000, () => true);
  assert.equal(calls.length, 0);
  assert.equal(disk().runs[0].status, 'cancelled');
  assert.equal(disk().lastHotspotsScheduleDate, '2026-10-02');
});

test('daily-only history rotation preserves cached BGM, topics and keyword videos', async () => {
  const { service, disk } = fixture();
  await service.saveKeywords(['已保存关键词']);
  await service.start(); await service.job;
  const now = Date.parse('2026-10-01T23:00:00Z');
  for (let day = 0; day < 13; day++) {
    await service.checkDailySchedule(now + day * 86400000, () => true);
    await service.job;
    await service.checkDailySchedule(now + day * 86400000, () => true);
    await service.job;
  }
  const restored = fixture({ stored: disk() });
  const state = await restored.service.state();
  assert.equal(state.runs.length, 12);
  assert.ok(state.runs.every(run => run.groups.length === 1 && ['hotspots','videos'].includes(run.groups[0].kind)));
  assert.deepEqual(new Set(state.latestResults.map(group => group.kind)), new Set(['music', 'topics', 'hotspots', 'videos']));
});

test('keywords are validated and deduplicated without grouping distinct terms', () => {
  assert.deepEqual(normalizeKeywords([' 素颜霜 ', '粉底液', '素颜霜', '']), ['素颜霜', '粉底液']);
  for (const invalid of [[3], ['a\nb'], ['a'.repeat(61)], Array(51).fill('a'), 'abc']) assert.throws(() => normalizeKeywords(invalid));
});

test('only verified provider ranking is accepted; sales ranges remain unchanged', () => {
  const result = validateCapture('videos', '测试', capture('videos', '测试'));
  assert.equal(result.rows.length, 5);
  assert.equal(result.rows[0].sales, '10w~25w');
  assert.equal(result.rows[0].products[0].commission, '5.00%');
  assert.equal(result.rows[0].plays, null);
  assert.ok(result.rows[0].missingFields.includes('plays'));
  assert.equal(result.filters.publishedAt, '不限');
  for (const invalid of [{ sort: '视频销量' }, { direction: 'asc' }, { period: '本周' }, { keyword: '其他词' }, { filtersVerified: false }, { dateRange: null }, { rows: [] }, { url: 'https://evil.example/' }]) {
    assert.throws(() => validateCapture('videos', '测试', capture('videos', '测试', invalid)));
  }
  assert.equal(validateCapture('videos', '测试', capture('videos', '测试', { rows: [], emptyVerified: true })).rows.length, 0);
});

test('hotspots select the daily hot ranking and verify descending peak heat before capture', async () => {
  const browser = new FeiguaBrowser({});
  const calls = [];
  browser.openSource = async kind => { calls.push(['source', FEIGUA_SOURCES[kind].navigation]); };
  browser.settle = async () => {};
  browser.execute = async (command, args) => {
    calls.push([command, args]);
    return command === 'capture' ? capture('hotspots', null, args) : { verified: true };
  };
  const result = await browser.collect('hotspots');
  assert.deepEqual(calls, [
    ['source', ['抖音热点榜']],
    ['choice', { label: '热点榜' }],
    ['choice', { label: '日榜' }],
    ['optional-filters', undefined],
    ['sort', { label: '峰值热度', verify: false }],
    ['capture', { kind: 'hotspots', keyword: undefined, sort: '峰值热度', period: '日榜' }],
  ]);
  assert.equal(validateCapture('hotspots', null, result).period, '日榜');
  for (const invalid of [{ period: '近7天' }, { period: '实时榜' }, { period: '周榜' }, { direction: 'asc' }]) {
    assert.throws(() => validateCapture('hotspots', null, { ...result, ...invalid }), /筛选或降序/);
  }
});

test('deduplicate stable IDs within each group and never expose unrecognized payload fields', () => {
  const row = capture('music').rows[0];
  const result = validateCapture('music', null, capture('music', null, { rows: [row, row, { ...row, id: 'another', extra: 'private-test-value' }], cookies: 'private-test-value' }));
  assert.equal(result.rows.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /private-test-value/);
  assert.throws(() => validateCapture('music', null, capture('music', null, { rows: [{ title: 'a', yesterdayUsers: '1' }] })), /标识/);
});

test('empty configuration still collects the three independent leaderboards', async () => {
  const { service, calls, disk } = fixture();
  await service.start(); await service.job;
  assert.deepEqual(calls.map(call => call[0]), ['music', 'topics', 'hotspots']);
  assert.equal(disk().runs[0].status, 'completed');
  assert.equal((await service.state()).busy, false);
});

test('keyword snapshot is fixed during a run; edits persist for the next run', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, calls, disk } = fixture({ collect: async (kind, keyword) => { if (kind === 'music') await gate; return capture(kind, keyword); } });
  await service.saveKeywords(['测试甲', '测试乙']);
  await service.start();
  await assert.rejects(service.start(), /正在执行/);
  await assert.rejects(service.login(), /正在执行/);
  await service.saveKeywords(['测试丙']);
  release(); await service.job;
  assert.deepEqual(calls.filter(([kind]) => kind === 'videos').map(([, keyword]) => keyword), ['测试甲', '测试乙']);
  assert.deepEqual(disk().keywords, ['测试丙']);
  assert.deepEqual(disk().runs[0].keywords, ['测试甲', '测试乙']);
});

test('login required prevents collection and does not create a fake successful run', async () => {
  const { service, calls } = fixture({ auth: { status: 'signed_out', message: '请先登录飞瓜' } });
  await assert.rejects(service.start(), /请先登录/);
  assert.equal(calls.length, 0); assert.equal((await service.state()).runs.length, 0);
});

test('session expiry halts remaining groups and preserves successful groups', async () => {
  const { service, calls } = fixture({ collect: async (kind, keyword) => {
    if (kind === 'topics') throw Object.assign(new Error('private network detail'), { code: 'FEIGUA_AUTH_REQUIRED', publicMessage: '请重新登录' });
    return capture(kind, keyword);
  } });
  await service.start(); await service.job;
  const state = await service.state();
  assert.equal(state.auth.status, 'expired'); assert.equal(state.runs[0].status, 'partial');
  assert.equal(state.runs[0].groups[2].status, 'skipped'); assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(state), /private network detail/);
});

test('failed refresh does not overwrite older successful results', async () => {
  const { service, browser } = fixture();
  await service.start(); await service.job;
  browser.collect = async () => { throw new Error('secret test payload'); };
  await service.start(); await service.job;
  const state = await service.state();
  assert.equal(state.runs[0].status, 'failed'); assert.equal(state.runs[1].status, 'completed');
  assert.equal(state.runs[1].groups[0].result.rows.length, 5);
  assert.doesNotMatch(JSON.stringify(state), /secret test payload/);
});

test('cancellation does not save in-flight results or start later groups', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, calls, disk } = fixture({ collect: async kind => { await gate; return capture(kind); } });
  await service.start(); await service.cancel(); release(); await service.job;
  assert.equal(disk().runs[0].status, 'cancelled');
  assert.equal(calls.length, 1); assert.ok(disk().runs[0].groups.every(group => !group.result));
});

test('restart marks interrupted work without automatically replaying provider reads', async () => {
  const { service, calls, disk } = fixture({ stored: { version: 1, keywords: [], runs: [{ id: 'test', status: 'running', groups: [{ kind: 'music', status: 'running' }, { kind: 'topics', status: 'completed', result: { rows: [] } }] }] } });
  assert.equal((await service.state()).runs[0].status, 'interrupted');
  assert.equal(disk().runs[0].groups[1].status, 'completed'); assert.equal(calls.length, 0);
});

test('storage failure before provider I/O prevents collection', async () => {
  const { service, calls } = fixture({ write: async () => { throw new Error('disk full'); } });
  await assert.rejects(service.start(), /disk full/); assert.equal(calls.length, 0);
  assert.equal((await service.state()).runs.length, 0);
  await assert.rejects(service.saveKeywords(['测试']), /disk full/);
  assert.deepEqual((await service.state()).keywords, []);
});

test('all Feigua operations retain base-license authorization', () => {
  for (const method of ['state', 'save-keywords', 'save-music-tag', 'refresh-music-tags', 'login', 'check-login', 'start', 'cancel']) {
    assert.equal(featureRegistry.forIpc(`feigua-${method}`).id, 'feigua-trends');
  }
  assert.throws(() => requireFeatureAccess(featureRegistry, 'feigua-trends', { authorized: false }), /无权/);
});

test('navigation rejects foreign hosts, credentials and non-HTTPS URLs', () => {
  for (const url of ['http://dy.feigua.cn/', 'https://dy.feigua.cn.evil.example/', 'https://u:p@dy.feigua.cn/', 'https://dy.feigua.cn:444/', 'file:///etc/passwd', 'javascript:alert(1)']) assert.equal(isFeiguaNavigation(url), false);
  assert.equal(isFeiguaDataUrl('https://dy3.feigua.cn/ranking'), true);
  assert.equal(isFeiguaNavigation('https://open.weixin.qq.com/connect/qrconnect'), true);
  assert.equal(isFeiguaDataUrl('https://open.weixin.qq.com/connect/qrconnect'), false);
});

test('provider window is sandboxed and reuses its own persistent session without a preload', async () => {
  let options, permissions, popup;
  const partition = new EventEmitter();
  Object.assign(partition, { setPermissionRequestHandler: handler => { permissions = handler; }, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {}, onCompleted() {}, onErrorOccurred() {} } });
  class Window extends EventEmitter {
    constructor(opts) { super(); options = opts; this.webContents = new EventEmitter(); Object.assign(this.webContents, { setWindowOpenHandler: handler => { popup = handler; } }); }
    isDestroyed() { return false; } show() {} focus() {} loadURL() { return Promise.resolve(); }
  }
  const browser = new FeiguaBrowser({ BrowserWindow: Window, session: { fromPartition: name => { assert.equal(name, 'persist:feigua-trends'); return partition; } } });
  assert.equal(browser.ensureWindow(), browser.ensureWindow());
  assert.equal(options.webPreferences.sandbox, true); assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.preload, undefined);
  permissions(null, 'camera', result => assert.equal(result, false));
  assert.deepEqual(popup({ url: 'https://evil.example' }), { action: 'deny' });
  let blocked = false;
  browser.window.webContents.emit('will-navigate', { preventDefault() { blocked = true; } }, 'https://evil.example');
  assert.equal(blocked, true);
});

test('successful login closes its window automatically and notifies the service without clearing the session', async () => {
  let authenticated = false, closed = 0, notified;
  const browser = new FeiguaBrowser({});
  browser.partition = { marker: 'persistent-session' };
  browser.window = { isDestroyed: () => false, webContents: { getURL: () => 'https://dy.feigua.cn/member' }, close: () => { closed++; } };
  browser.execute = async () => ({ authenticated });
  browser.onAuthChange = auth => { notified = auth; };
  browser.startLoginWatch();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 0); assert.equal(notified, undefined);
  authenticated = true;
  browser.startLoginWatch();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1); assert.equal(notified.status, 'authenticated');
  assert.equal(browser.loginTimer, null); assert.equal(browser.partition.marker, 'persistent-session');
  assert.equal(browser.wasAuthenticated, true);
});

test('automatic login notification reaches the state polled by the media library', async () => {
  const { service, browser } = fixture();
  browser.onAuthChange({ status: 'authenticated', message: '已登录飞瓜' });
  assert.equal((await service.state()).auth.status, 'authenticated');
});

test('signed-in marketing homepage enters the workspace before closing the login window', async () => {
  const browser = new FeiguaBrowser({});
  let url = 'https://dy.feigua.cn/', closed = 0, entered = 0;
  const states = [];
  browser.window = { isDestroyed: () => false, webContents: { getURL: () => url }, close: () => { closed++; } };
  browser.onAuthChange = auth => states.push(auth.status);
  browser.execute = async command => {
    if (command === 'enter-workspace') { entered++; return { url: 'https://dy.feigua.cn/synthetic/workspace' }; }
    return { authenticated: url.endsWith('/workspace'), workspaceAvailable: url === 'https://dy.feigua.cn/' };
  };
  browser.navigate = async target => { url = target; };
  browser.startLoginWatch();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, 1); assert.equal(closed, 0);
  assert.deepEqual(states, ['checking']);
  browser.startLoginWatch();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1); assert.deepEqual(states, ['checking', 'authenticated']);
  assert.equal(browser.loginTimer, null);
});

test('persisted homepage session is resolved to the workspace during login checks', async () => {
  const browser = new FeiguaBrowser({});
  let entered = false;
  browser.ensureWindow = () => {};
  browser.window = { webContents: { getURL: () => 'https://dy.feigua.cn/' } };
  browser.execute = async command => {
    if (command === 'enter-workspace') { entered = true; return { clicked: true }; }
    return { authenticated: entered, workspaceAvailable: !entered, loginVisible: false };
  };
  assert.equal((await browser.checkLogin()).status, 'authenticated');
  assert.equal(entered, true);
});

test('known provider notice is confirmed once and login then closes automatically', async () => {
  let closed = 0, notified, accepted = 0;
  const browser = new FeiguaBrowser({});
  browser.ensureWindow = () => {};
  browser.window = { isDestroyed: () => false, webContents: { getURL: () => 'https://dy.feigua.cn/app/' }, close: () => { closed++; } };
  browser.execute = async command => {
    if (command === 'accept-terms') { accepted++; return { accepted: true }; }
    return { authenticated: accepted > 0, actionRequired: accepted ? null : 'terms' };
  };
  browser.onAuthChange = state => { notified = state; };
  assert.equal((await browser.checkLogin()).status, 'authenticated');
  browser.startLoginWatch();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1); assert.equal(notified.status, 'authenticated'); assert.equal(accepted, 1);
  browser.stopLoginWatch();
});

test('login success starts a single collection automatically using saved keywords', async () => {
  const {service,browser,calls} = fixture();
  await service.saveKeywords(['测试词']);
  browser.openLogin = async () => { browser.onAuthChange({status:'authenticated',message:'已登录'}); };
  await service.login(); await service.autoStart; await service.job;
  browser.onAuthChange({status:'authenticated',message:'已登录'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await service.state()).runs.length,1);
  assert.deepEqual(calls.at(-1),['videos','测试词']);
});

test('cancelling pending automatic startup prevents a collection from starting', async () => {
  const {service,browser,calls} = fixture();
  browser.openLogin = async () => { browser.onAuthChange({status:'authenticated',message:'已登录'}); await service.cancel(); };
  await service.login(); await service.autoStart;
  assert.equal(calls.length,0);
});

test('failed automatic notice confirmation stops remaining reads without claiming success', async () => {
  const { service, calls } = fixture({ collect: async () => { throw Object.assign(new Error('terms'), { code: 'FEIGUA_NOTICE_FAILED', publicMessage: '声明确认未生效' }); } });
  await service.start(); await service.job;
  const state = await service.state();
  assert.equal(state.auth.status, 'error'); assert.equal(calls.length, 1);
  assert.equal(state.runs[0].status, 'failed');
  assert.equal(state.runs[0].groups[1].status, 'skipped');
});

const tagOptions = [{ label: '测试一级甲', children: [{ label: '测试二级甲' }, { label: '测试二级乙' }] }, { label: '测试一级乙', children: [{ label: '测试二级丙' }] }];

test('music tags support all, first level and second level without cross-parent selections', () => {
  assert.deepEqual(normalizeMusicTag(), []);
  assert.deepEqual(validateMusicTag(['测试一级甲'], tagOptions), ['测试一级甲']);
  assert.deepEqual(validateMusicTag(['测试一级甲', '测试二级乙'], tagOptions), ['测试一级甲', '测试二级乙']);
  for (const invalid of [['a', 'b', 'c'], [''], ['全部'], ['a\nb'], 'a']) assert.throws(() => normalizeMusicTag(invalid));
  assert.throws(() => validateMusicTag(['测试一级乙', '测试二级甲'], tagOptions), /目录/);
  assert.throws(() => normalizeMusicTagOptions([{ label: 'a', children: null }]), /结构/);
});

test('legacy saved state gains all-category defaults without changing keywords or history', async () => {
  const { service } = fixture({ stored: { version: 1, keywords: ['旧关键词'], runs: [{ id: 'old', status: 'completed', groups: [] }] } });
  const state = await service.state();
  assert.deepEqual(state.musicTag, []); assert.deepEqual(state.musicTagOptions, []);
  assert.deepEqual(state.keywords, ['旧关键词']); assert.equal(state.runs[0].id, 'old');
});

test('catalog and selected second-level tag survive reload independently of keywords', async () => {
  const { service, browser, disk } = fixture();
  browser.getMusicTags = async () => ({ options: tagOptions, restricted: true });
  await service.refreshMusicTags();
  await service.saveKeywords(['测试关键词']);
  await service.saveMusicTag(['测试一级甲', '测试二级乙']);
  const restored = fixture({ stored: disk() }).service;
  const state = await restored.state();
  assert.deepEqual(state.musicTag, ['测试一级甲', '测试二级乙']);
  assert.equal(state.musicTagRestricted, true);
  assert.deepEqual(state.keywords, ['测试关键词']);
  assert.equal(state.musicTagOptions[0].children.length, 2);
});

test('music and topic groups retain their shared complete category snapshot when settings change', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const paths = [];
  const { service, disk } = fixture({ collect: async (kind, keyword, _signal, options) => {
    if (kind === 'music') { paths.push(options.musicTag); await gate; }
    return capture(kind, keyword, { musicTag: options.musicTag });
  } });
  await service.ready; await service.cacheMusicTags({ options: tagOptions });
  await service.saveMusicTag(['测试一级甲', '测试二级甲']);
  await service.start();
  await service.saveMusicTag(['测试一级乙', '测试二级丙']);
  release(); await service.job;
  assert.deepEqual(paths, [['测试一级甲', '测试二级甲']]);
  assert.deepEqual(disk().musicTag, ['测试一级乙', '测试二级丙']);
  assert.equal(disk().runs[0].groups[0].result.filters.category, '测试一级甲 > 测试二级甲');
  assert.deepEqual(disk().runs[0].groups[1].result.filters, { category: '测试一级甲 > 测试二级甲', categoryPath: ['测试一级甲', '测试二级甲'] });
});

test('category mismatch cannot be silently recorded as all-category music', () => {
  assert.throws(() => validateCapture('music', null, capture('music'), { musicTag: ['测试一级甲'] }), /不一致/);
  assert.throws(() => validateCapture('music', null, capture('music', null, { musicTag: ['测试一级乙'] }), { musicTag: ['测试一级甲'] }), /不一致/);
});

test('topic results must confirm the complete shared path including the second level', () => {
  const musicTag = ['测试一级甲', '测试二级甲'];
  assert.deepEqual(validateCapture('topics', null, capture('topics', null, {musicTag}), {musicTag}).filters,
    {category:'测试一级甲 > 测试二级甲',categoryPath:musicTag});
  for (const actual of [undefined, null, [], ['测试一级甲'], ['测试一级甲','测试二级乙']]) {
    assert.throws(() => validateCapture('topics', null, capture('topics', null, {musicTag:actual}), {musicTag}), /不一致/);
  }
  assert.deepEqual(validateCapture('topics', null, capture('topics')).filters, {category:'全部',categoryPath:[]});
});

test('topic browser applies shared first/second levels without changing weekly ranking rules', async () => {
  const browser = new FeiguaBrowser({});
  const calls=[];
  browser.openSource=async kind=>assert.equal(kind,'topics');
  browser.settle=async()=>{};
  browser.choose=async(command,args)=>{calls.push([command,args]);};
  browser.execute=async(command,args)=>{
    if(command==='sort') {assert.equal(args.label,'参与人数增长率');return {verified:true};}
    if(command==='music-tag') calls.push([command,args]);
    return {verified:true};
  };
  for(const musicTag of [[],['测试一级甲'],['测试一级甲','测试二级甲']]) {
    calls.length=0;
    await browser.collect('topics',null,undefined,{musicTag});
    const expected=[['choice',{label:'话题总榜'}],['choice',{label:'周榜'}]];
    if(musicTag.length>1) expected.push(['music-tag',{kind:'topics',path:musicTag,phase:'expand'}]);
    expected.push(['music-tag',{kind:'topics',path:musicTag,phase:'select'}],['category',{label:'话题类型'}]);
    assert.deepEqual(calls,expected);
  }
});

test('a failed topic filter preserves earlier all-category results under their original label', async () => {
  const previous={kind:'topics',status:'completed',result:validateCapture('topics',null,capture('topics'))};
  const {service}=fixture({stored:{version:1,keywords:[],musicTag:['测试一级甲'],musicTagOptions:tagOptions,runs:[{id:'old',status:'completed',groups:[previous]}]},
    collect:async(kind,keyword,_signal,options)=>capture(kind,keyword,{musicTag:kind==='topics'?[]:options.musicTag})});
  await service.start(); await service.job;
  const state=await service.state();
  assert.equal(state.runs[0].groups[1].status,'failed');
  assert.equal(state.runs[0].groups[1].result,undefined);
  const shown=displayedFeiguaGroups(state.runs).find(group=>group.kind==='topics');
  assert.equal(shown.result.filters.category,'全部');
  assert.equal(shown.showingPrevious,true);
});

test('failed music selection write keeps the prior saved choice', async () => {
  const { service } = fixture({ stored: { version: 1, keywords: [], runs: [], musicTag: ['测试一级甲'], musicTagOptions: tagOptions }, write: async () => { throw new Error('disk full'); } });
  await assert.rejects(service.saveMusicTag(['测试一级乙']), /disk full/);
  assert.deepEqual((await service.state()).musicTag, ['测试一级甲']);
});

test('category snapshot is fixed before the login check finishes', async () => {
  let entered, release;
  const checking = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { service, browser } = fixture();
  await service.ready; await service.cacheMusicTags({ options: tagOptions });
  await service.saveMusicTag(['测试一级甲']);
  browser.checkLogin = async () => { entered(); await gate; return { status: 'authenticated' }; };
  const starting = service.start();
  await checking;
  await service.saveMusicTag(['测试一级乙']);
  release(); await starting; await service.job;
  assert.deepEqual((await service.state()).runs[0].musicTag, ['测试一级甲']);
});

test('latest display keeps cached music during a pending or failed update and preserves its original category', () => {
  const old = { kind:'music', status:'completed', result:{ rows:[{title:'已采集'}], filters:{category:'全部'}, collectedAt:'2026-10-01T00:00:00Z' } };
  const runs = [{id:'new',groups:[{kind:'music',status:'failed',musicTag:['另一分类']}]},{id:'old',groups:[old]}];
  const shown = displayedFeiguaGroups(runs);
  assert.equal(shown[0].result.rows.length,1);
  assert.equal(shown[0].result.filters.category,'全部');
  assert.equal(shown[0].showingPrevious,true);
  assert.equal(old.showingPrevious,undefined);
});

test('latest display includes captured keyword videos from another batch without changing current settings', () => {
  const runs=[{id:'new',groups:[{kind:'music',status:'completed',result:{rows:[{}]}}]}, {id:'video',groups:[{kind:'videos',keyword:'原关键词',status:'completed',result:{rows:[{},{}]}}]}];
  const shown=displayedFeiguaGroups(runs);
  assert.equal(shown.length,2);assert.equal(shown[1].keyword,'原关键词');assert.equal(shown[1].result.rows.length,2);
});

test('verified empty results supersede older nonempty data instead of showing stale rows', () => {
  const runs=[{id:'new',groups:[{kind:'music',status:'completed',result:{rows:[]}}]},{id:'old',groups:[{kind:'music',status:'completed',result:{rows:[{}]}}]}];
  assert.deepEqual(displayedFeiguaGroups(runs)[0].result.rows,[]);
});

test('explicit batch selection does not substitute another batch after a failure', () => {
  const group={kind:'music',status:'failed'};
  const runs=[{id:'new',groups:[group]},{id:'old',groups:[{kind:'music',status:'completed',result:{rows:[{}]}}]}];
  assert.deepEqual(displayedFeiguaGroups(runs,'new'),[group]);
});

test('save and refresh persists shared selection and refreshes BGM and topics without touching hotspots or videos', async () => {
  const {service,calls,disk}=fixture();
  await service.ready; await service.cacheMusicTags({options:tagOptions});
  await service.saveKeywords(['保留关键词']);
  await service.saveAndRefreshMusicTag(['测试一级甲','测试二级乙']); await service.job;
  assert.deepEqual(calls,[['music',null],['topics',null]]);
  assert.deepEqual(disk().musicTag,['测试一级甲','测试二级乙']);
  assert.deepEqual(disk().keywords,['保留关键词']);
  assert.equal(disk().runs[0].groups[0].result.filters.category,'测试一级甲 > 测试二级乙');
  assert.equal(disk().runs[0].groups[1].result.filters.category,'测试一级甲 > 测试二级乙');
});

test('save and refresh keeps selection and records a visible failure when login is unavailable', async () => {
  const {service,calls}=fixture({auth:{status:'signed_out'}});
  await service.ready; await service.cacheMusicTags({options:tagOptions});
  await service.saveAndRefreshMusicTag(['测试一级甲']); await service.job;
  const state=await service.state();
  assert.deepEqual(state.musicTag,['测试一级甲']);assert.equal(calls.length,0);
  assert.equal(state.runs[0].status,'failed');assert.match(state.runs[0].groups[0].message,/已保存/);
});

test('busy refresh refuses to overwrite settings or start a second BGM job', async () => {
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const {service}=fixture({collect:async(kind,keyword,_signal,options)=>{await gate;return capture(kind,keyword,{musicTag:options.musicTag});}});
  await service.ready;await service.cacheMusicTags({options:tagOptions});
  await service.saveAndRefreshMusicTag(['测试一级甲']);
  await assert.rejects(service.saveAndRefreshMusicTag(['测试一级乙']),/正在执行/);
  assert.deepEqual((await service.state()).musicTag,['测试一级甲']);
  release();await service.job;
});

test('fallback display exposes the attempted category and refresh failure while retaining old result labels', () => {
  const runs=[{id:'new',groups:[{kind:'music',status:'failed',message:'筛选未完成',musicTag:['新分类']}]},{id:'old',groups:[{kind:'music',status:'completed',result:{rows:[{}],filters:{category:'全部'}}}]}];
  const group=displayedFeiguaGroups(runs)[0];
  assert.equal(group.refreshStatus,'failed');assert.equal(group.refreshMessage,'筛选未完成');
  assert.deepEqual(group.requestedMusicTag,['新分类']);assert.equal(group.result.filters.category,'全部');
});

test('repeated category ranking refreshes do not evict hotspots and videos from the latest results cache', async () => {
  const {service,disk}=fixture();
  await service.saveKeywords(['已采集关键词']);await service.start();await service.job;
  for(let i=0;i<13;i++){await service.saveAndRefreshMusicTag([]);await service.job;}
  const reloaded=fixture({stored:disk()}).service;
  const state=await reloaded.state();
  assert.equal(state.runs.length,12);
  const shown=displayedFeiguaGroups(state.runs,'',state.latestResults);
  assert.equal(shown.length,4);assert.ok(shown.every(group=>group.result.rows.length===5));
});
