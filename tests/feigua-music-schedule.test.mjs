import assert from 'node:assert/strict';
import test from 'node:test';
import { dueMusicDate, musicCollectionDate, pendingMusicCheck } from '../electron/feigua-music-schedule.mjs';
import { FeiguaService } from '../electron/feigua-service.mjs';
import { FEIGUA_SOURCES } from '../electron/feigua-contract.mjs';

const atEight=Date.parse('2026-10-05T00:00:00Z'),DAY=86400000;
const saved=(at='2026-10-05T00:01:00Z',musicTag=[])=>({kind:'music',keyword:null,status:'completed',musicTag,result:{period:'昨日使用人数',collectedAt:at,filters:{categoryPath:musicTag},rows:[]}});
const capture=(kind,options)=>({url:'https://dy.feigua.cn/synthetic/'+kind,period:FEIGUA_SOURCES[kind].period,sort:FEIGUA_SOURCES[kind].sort,direction:'desc',filtersVerified:true,musicTag:options.musicTag||[],dateRange:kind==='hotspots'?'2026-10-04':kind==='topics'?'2026-09-28 - 2026-10-04':null,rows:[{id:'synthetic-'+kind,title:'合成标题',author:'合成作者',totalUsers:'100',yesterdayUsers:'10',peakHeat:'100',followers:'20',participantGrowth:'20%',playGrowth:'30%'}]});
function fixture({stored={},auth='authenticated',write}={}) {
  let disk={version:1,loginEntryUrl:'https://dy.feigua.cn/',keywords:[],musicTag:[],runs:[],lastHotspotsScheduleDate:'2026-10-31',...stored};
  if(!disk.latestResults?.some(group=>group.kind==='topics'))disk.latestResults=[...(disk.latestResults||[]),{kind:'topics',status:'completed',result:{period:'周榜',dateRange:'2026-09-28 - 2026-10-04',filters:{categoryPath:[]},rows:[]}}];
  let checks=0;const calls=[];
  const browser={checkLogin:async()=>{checks++;return{status:auth,message:auth==='authenticated'?'已登录':'请重新登录'};},collect:async(kind,_keyword,_signal,options)=>{calls.push(kind);return capture(kind,options);},stop(){}};
  const service=new FeiguaService({userDataPath:'/unused',browser,storage:{read:async()=>structuredClone(disk),write:async next=>{await write?.(next);disk=structuredClone(next);}}});
  return{service,browser,calls,disk:()=>disk,checks:()=>checks};
}
const clock=(t,now=atEight)=>t.mock.timers.enable({apis:['Date'],now});

test('BGM is due every day at exactly 08:00 Beijing, including weekends and UTC date boundaries',()=>{
  assert.equal(dueMusicDate(atEight-1),null);assert.equal(dueMusicDate(atEight),'2026-10-05');
  assert.equal(dueMusicDate(atEight+16*3600000-1),'2026-10-05');assert.equal(dueMusicDate(atEight+16*3600000),null);
  assert.equal(dueMusicDate(Date.parse('2026-10-04T00:00:00Z')),'2026-10-04');
  assert.equal(musicCollectionDate('2026-10-04T16:00:00Z'),'2026-10-05');assert.equal(musicCollectionDate('invalid'),null);
});

test('successful results are deduplicated by Beijing collection date and category',()=>{
  assert.equal(pendingMusicCheck({musicTag:[],latestResults:[saved()]},atEight),null);
  assert.ok(pendingMusicCheck({musicTag:['新分类'],latestResults:[saved()]},atEight));
  assert.ok(pendingMusicCheck({musicTag:[],latestResults:[saved('2026-10-04T01:00:00Z')]},atEight));
  assert.ok(pendingMusicCheck({latestResults:[{...saved(),status:'failed'}]},atEight));
});

test('08:00 collects only BGM once and completion survives a restart',async t=>{
  clock(t);const f=fixture();await f.service.checkDailySchedule(atEight-1,()=>true);assert.equal(f.checks(),0);
  await f.service.checkDailySchedule(atEight,()=>true);await f.service.job;
  assert.deepEqual(f.calls,['music']);assert.equal(f.disk().runs[0].trigger,'daily-music');assert.equal(f.disk().runs[0].status,'completed');
  assert.equal(f.disk().latestResults.find(group=>group.kind==='music').result.collectedAt,new Date(atEight).toISOString());
  const restored=fixture({stored:f.disk()});await restored.service.checkDailySchedule(atEight+3600000,()=>true);
  assert.equal(restored.checks(),0);assert.deepEqual(restored.calls,[]);
});

test('late opening catches up the current day and the next day is eligible again',async t=>{
  clock(t,atEight+5*3600000);const f=fixture();await f.service.checkDailySchedule(Date.now(),()=>true);await f.service.job;
  assert.deepEqual(f.calls,['music']);await f.service.checkDailySchedule(Date.now()+1000,()=>true);assert.equal(f.calls.length,1);
  t.mock.timers.tick(DAY);await f.service.checkDailySchedule(Date.now(),()=>true);await f.service.job;
  assert.deepEqual(f.calls,['music','music']);assert.equal(f.disk().lastMusicCheck.date,'2026-10-06');
});

test('legacy successful BGM results already collected today prevent an upgrade from collecting twice',async t=>{
  clock(t);const f=fixture({stored:{latestResults:[saved()]}});
  await f.service.checkDailySchedule(Date.now(),()=>true);assert.equal(f.checks(),0);assert.equal(f.disk().runs.length,0);
});

test('failure preserves old results and permits re-login or next-day recovery without a 30-second loop',async t=>{
  clock(t);const old=saved('2026-10-04T00:00:00Z'),f=fixture({stored:{latestResults:[old]},auth:'expired'});
  await f.service.checkDailySchedule(Date.now(),()=>true);await f.service.job;
  assert.equal(f.disk().runs[0].status,'failed');assert.deepEqual(f.disk().latestResults.find(g=>g.kind==='music'),old);
  await f.service.checkDailySchedule(Date.now()+30000,()=>true);assert.equal(f.checks(),1);
  assert.ok(pendingMusicCheck(await f.service.state(),Date.now(),{ignorePreviousCheck:true}));
  t.mock.timers.tick(DAY);const restored=fixture({stored:f.disk()});await restored.service.checkDailySchedule(Date.now(),()=>true);await restored.service.job;
  assert.deepEqual(restored.calls,['music']);assert.equal(restored.disk().runs[0].status,'completed');
});

test('re-login retries an unfinished day, then subsequent automatic login skips BGM while manual refresh remains available',async t=>{
  clock(t);const f=fixture({stored:{lastMusicCheck:{date:'2026-10-05',musicTag:[]}}});
  await f.service.start({trigger:'login'});await f.service.job;assert.equal(f.calls.filter(k=>k==='music').length,1);
  await f.service.start({trigger:'login'});await f.service.job;assert.equal(f.calls.filter(k=>k==='music').length,1);
  await f.service.start();await f.service.job;assert.equal(f.calls.filter(k=>k==='music').length,2);
});

test('automatic login before 08:00 does not start BGM early',async t=>{
  clock(t,atEight-1);const f=fixture();await f.service.start({trigger:'login'});await f.service.job;
  assert.equal(f.calls.includes('music'),false);
});

test('a failed intent save prevents all provider access and rolls back the attempt marker',async t=>{
  clock(t);const f=fixture({write:async()=>{throw new Error('disk full');}});
  await assert.rejects(f.service.checkDailySchedule(Date.now(),()=>true),/disk full/);
  assert.equal(f.checks(),0);assert.deepEqual(f.calls,[]);assert.equal((await f.service.state()).lastMusicCheck,null);
});

test('a failed result save cannot publish unsaved BGM or mark the day complete',async t=>{
  clock(t);const f=fixture({write:async data=>{if(data.latestResults.some(g=>g.kind==='music'))throw new Error('disk full');}});
  await f.service.checkDailySchedule(Date.now(),()=>true);await f.service.job;
  assert.equal(f.disk().latestResults.some(g=>g.kind==='music'),false);
  assert.ok(pendingMusicCheck(await f.service.state(),Date.now(),{ignorePreviousCheck:true}));
});

test('cancelled BGM authentication leaves completion unset and another manual attempt possible',async t=>{
  clock(t);const f=fixture();let release;f.browser.checkLogin=()=>new Promise(resolve=>{release=resolve;});
  await f.service.checkDailySchedule(Date.now(),()=>true);await f.service.cancel();release({status:'authenticated'});await f.service.job;
  assert.equal(f.disk().runs[0].status,'cancelled');assert.deepEqual(f.calls,[]);
  assert.ok(pendingMusicCheck(await f.service.state(),Date.now(),{ignorePreviousCheck:true}));
});
