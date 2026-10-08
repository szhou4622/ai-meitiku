import assert from 'node:assert/strict';
import test from 'node:test';
import { pendingTopicCheck, settledTopicPeriod, topicScheduleSlot } from '../electron/feigua-topic-schedule.mjs';
import { FeiguaService } from '../electron/feigua-service.mjs';
import { FEIGUA_SOURCES } from '../electron/feigua-contract.mjs';

const monday=Date.parse('2026-10-05T01:00:00Z');
const expected='2026-09-28 - 2026-10-04',previous='2026-09-21 - 2026-09-27';
const saved=(period=expected,musicTag=[])=>({kind:'topics',keyword:null,status:'completed',musicTag,result:{period:'周榜',dateRange:period,collectedAt:'2026-10-05T01:01:00Z',filters:{categoryPath:musicTag},rows:[]}});
const makeCapture=(range,options)=>({url:'https://dy.feigua.cn/app/#/synthetic-topics',period:'周榜',dateRange:range,musicTag:options.musicTag,sort:'参与人数增长率',direction:'desc',filtersVerified:true,rows:[{id:'synthetic-topic',title:'合成话题',author:'合成作者',followers:'10',participantGrowth:'20%',playGrowth:'30%'}]});

function fixture({stored={},range=expected,auth='authenticated',write}={}) {
  let disk={version:1,loginEntryUrl:'https://dy.feigua.cn/',keywords:[],musicTag:[],runs:[],lastHotspotsScheduleDate:'2026-10-31',...stored};
  const calls=[];const browser={checkLogin:async()=>({status:auth,message:auth==='authenticated'?'已登录':'请重新登录'}),collect:async(kind,keyword,signal,options)=>{calls.push(kind);return kind==='topics'?makeCapture(typeof range==='function'?range():range,options):{url:'https://dy.feigua.cn/synthetic',period:FEIGUA_SOURCES[kind].period,sort:FEIGUA_SOURCES[kind].sort,direction:'desc',filtersVerified:true,musicTag:options.musicTag||[],dateRange:kind==='hotspots'?'2026-10-01':null,rows:[{id:'synthetic-'+kind,title:'合成标题',author:'合成作者',totalUsers:'1',yesterdayUsers:'1',peakHeat:'1'}]};},stop(){}};
  const service=new FeiguaService({userDataPath:'/unused',browser,storage:{read:async()=>structuredClone(disk),write:async data=>{await write?.(data);disk=structuredClone(data);}}});
  return {service,browser,calls,disk:()=>disk};
}

test('topic checks start Monday 09:00 Beijing and retry slots advance at daily 09:00',()=>{
  assert.equal(topicScheduleSlot(monday-1),null);
  assert.equal(topicScheduleSlot(monday).slot,'2026-10-05');
  assert.equal(topicScheduleSlot(monday).expectedPeriod,expected);
  assert.equal(topicScheduleSlot(monday+86400000-1).slot,'2026-10-05');
  assert.equal(topicScheduleSlot(monday+86400000).slot,'2026-10-06');
  assert.equal(topicScheduleSlot(Date.parse('2027-01-04T01:00:00Z')).expectedPeriod,'2026-12-28 - 2027-01-03');
});

test('only closed natural weeks can satisfy publication, including empty verified rankings',()=>{
  assert.equal(settledTopicPeriod(expected,monday),expected);
  for(const invalid of ['2026-10-06 - 2026-10-12','2026-10-12 - 2026-10-18','2026-02-30 - 2026-03-08'])assert.equal(settledTopicPeriod(invalid,monday),null);
  assert.equal(pendingTopicCheck({musicTag:[],latestResults:[saved()]},monday),null);
  assert.ok(pendingTopicCheck({musicTag:['新分类'],latestResults:[saved()]},monday));
  assert.ok(pendingTopicCheck({musicTag:[],latestResults:[saved(previous)]},monday));
});

test('successful scheduled topic collection is durable and prevents same-week repeats across restart',async()=>{
  const f=fixture();await f.service.checkDailySchedule(monday,()=>true);await f.service.job;
  assert.deepEqual(f.calls,['topics']);assert.equal(f.disk().runs[0].trigger,'weekly-topics');assert.equal(f.disk().runs[0].status,'completed');
  assert.equal(f.disk().latestResults[0].result.dateRange,expected);
  const reloaded=fixture({stored:f.disk()});await reloaded.service.checkDailySchedule(monday+86400000,()=>true);
  assert.deepEqual(reloaded.calls,[]);assert.equal((await reloaded.service.state()).runs.length,1);
});

test('an unpublished week keeps old results, waits until the next check slot and then saves the new week',async()=>{
  let range=previous;const old=saved(previous),f=fixture({stored:{latestResults:[old]},range:()=>range});
  await f.service.checkDailySchedule(monday,()=>true);await f.service.job;
  assert.equal(f.disk().runs[0].status,'waiting');assert.equal(f.disk().runs[0].groups[0].result,undefined);
  assert.deepEqual(f.disk().latestResults,[old]);
  await f.service.checkDailySchedule(monday+86400000-1,()=>true);assert.equal(f.calls.length,1);
  range=expected;await f.service.checkDailySchedule(monday+86400000,()=>true);await f.service.job;
  assert.equal(f.calls.length,2);assert.equal(f.disk().runs[0].status,'completed');assert.equal(f.disk().latestResults[0].result.dateRange,expected);
});

test('opening before 09:00 on a later day catches up a missed check without rechecking an attempted slot',async()=>{
  const now=monday+86400000-3600000,f=fixture({range:previous});
  await f.service.checkDailySchedule(now,()=>true);await f.service.job;assert.equal(f.calls.length,1);
  const reloaded=fixture({stored:f.disk(),range:previous});await reloaded.service.checkDailySchedule(now+1000,()=>true);assert.equal(reloaded.calls.length,0);
  await reloaded.service.checkDailySchedule(monday+86400000,()=>true);await reloaded.service.job;assert.equal(reloaded.calls.length,1);
});

test('login and collection failures preserve retry eligibility without a completion marker',async()=>{
  const f=fixture({auth:'expired'});await f.service.checkDailySchedule(monday,()=>true);await f.service.job;
  assert.equal(f.disk().runs[0].status,'failed');assert.equal(f.disk().latestResults.length,0);assert.deepEqual(f.calls,[]);
  const reloaded=fixture({stored:f.disk()});await reloaded.service.checkDailySchedule(monday+86400000,()=>true);await reloaded.service.job;
  assert.deepEqual(reloaded.calls,['topics']);assert.equal(reloaded.disk().runs[0].status,'completed');
});

test('manual successful results migrate into schedule deduplication and no source I/O is needed',async()=>{
  const f=fixture({stored:{latestResults:[saved()]}});await f.service.checkDailySchedule(monday,()=>true);
  assert.deepEqual(f.calls,[]);assert.equal((await f.service.state()).runs.length,0);
});

test('saving the check intent must succeed before login or collection begins',async()=>{
  const f=fixture({write:async()=>{throw new Error('disk full');}});let checks=0;f.browser.checkLogin=async()=>{checks++;return{status:'authenticated'};};
  await assert.rejects(f.service.checkDailySchedule(monday,()=>true),/disk full/);
  assert.equal(checks,0);assert.deepEqual(f.calls,[]);assert.equal((await f.service.state()).lastTopicsCheck,null);
});

test('results are not marked complete if durable result saving fails',async()=>{
  const f=fixture({write:async data=>{if(data.latestResults.length)throw new Error('disk full');}});
  await f.service.checkDailySchedule(monday,()=>true);await f.service.job;
  assert.equal(f.disk().latestResults.length,0);assert.ok(pendingTopicCheck(await f.service.state(),monday+86400000));
});

test('cancelled topic login does not complete the week and can be retried at the next daily slot',async()=>{
  const f=fixture();let release;f.browser.checkLogin=()=>new Promise(resolve=>{release=resolve;});
  await f.service.checkDailySchedule(monday,()=>true);await f.service.cancel();release({status:'authenticated'});await f.service.job;
  assert.equal(f.disk().runs[0].status,'cancelled');assert.deepEqual(f.calls,[]);
  await f.service.checkDailySchedule(monday+1000,()=>true);assert.equal(f.disk().runs.length,1);
  f.browser.checkLogin=async()=>({status:'authenticated'});
  await f.service.checkDailySchedule(monday+86400000,()=>true);await f.service.job;
  assert.deepEqual(f.calls,['topics']);assert.equal(f.disk().runs[0].status,'completed');
});

test('network retries remain bounded and failure never suppresses the next daily topic check',async()=>{
  const f=fixture();f.service.retryWait=async()=>{};
  f.browser.collect=async()=>{f.calls.push('topics');throw Object.assign(new Error('temporary'),{code:'FEIGUA_NETWORK'});};
  await f.service.checkDailySchedule(monday,()=>true);await f.service.job;
  assert.equal(f.calls.length,3);assert.equal(f.disk().runs[0].status,'failed');assert.equal(f.disk().latestResults.length,0);
  assert.equal(pendingTopicCheck(await f.service.state(),monday+1000),null);
  assert.ok(pendingTopicCheck(await f.service.state(),monday+86400000));
});

test('an arbitrary seven-day result cannot be saved as the weekly scheduled ranking',async()=>{
  const old=saved(previous),f=fixture({stored:{latestResults:[old]},range:'2026-09-29 - 2026-10-05'});
  await f.service.checkDailySchedule(monday,()=>true);await f.service.job;
  assert.equal(f.disk().runs[0].status,'failed');assert.match(f.disk().runs[0].groups[0].message,/完整自然周/);
  assert.deepEqual(f.disk().latestResults,[old]);
});

test('automatic login does not recollect an already completed topic week',async t=>{
  t.mock.method(Date,'now',()=>monday);
  const f=fixture({stored:{latestResults:[saved()]}});
  await f.service.start({trigger:'login'});await f.service.job;
  assert.deepEqual(f.calls,['music','hotspots']);assert.equal(f.disk().runs[0].status,'completed');
});

test('successful re-login may retry a failed check slot, while a successful week remains deduplicated',async t=>{
  t.mock.method(Date,'now',()=>monday);
  const plan=topicScheduleSlot(monday),f=fixture({stored:{lastTopicsCheck:{...plan,musicTag:[]}}});
  assert.equal(pendingTopicCheck(await f.service.state(),monday),null);
  await f.service.start({trigger:'login'});await f.service.job;
  assert.equal(f.calls.filter(kind=>kind==='topics').length,1);assert.equal(f.disk().runs[0].status,'completed');
  await f.service.start({trigger:'login'});await f.service.job;
  assert.equal(f.calls.filter(kind=>kind==='topics').length,1);
});
