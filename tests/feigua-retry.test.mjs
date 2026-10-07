import test from 'node:test';
import assert from 'node:assert/strict';
import { FeiguaService } from '../electron/feigua-service.mjs';
import { FEIGUA_SOURCES, validateCapture } from '../electron/feigua-contract.mjs';
import { displayedFeiguaGroups } from '../app/feigua-results.mjs';

const capture=kind=>({url:`https://dy.feigua.cn/synthetic/${kind}`,sort:FEIGUA_SOURCES[kind].sort,direction:'desc',period:FEIGUA_SOURCES[kind].period,filtersVerified:true,musicTag:[],
  dateRange:kind==='topics'?'2026-09-28 - 2026-10-04':kind==='hotspots'?'2026-10-06':null,
  rows:Array.from({length:5},(_,i)=>({id:`synthetic-${kind}-${i}`,title:'合成测试结果',author:'合成作者',followers:'10',totalUsers:'100',yesterdayUsers:'20',participantGrowth:'10%',playGrowth:'20%',peakHeat:String(100-i)}))});
const old={kind:'music',keyword:null,status:'completed',musicTag:[],result:validateCapture('music',null,capture('music'))};
old.result.rows=old.result.rows.map(row=>({...row,id:`cached-${row.id}`,title:'合成缓存旧结果'}));
function fixture({collect,retryWait,write,stored}={}){
  let disk=stored||{version:1,loginEntryUrl:'https://dy.feigua.cn/',keywords:[],runs:[],latestResults:[old],videoFilterOptions:{categoryPath:[{label:'合成',children:[]}],tagPath:[{label:'合成',children:[]}]}};
  const calls=[];
  const browser={checkLogin:async()=>({status:'authenticated'}),collect:async(kind,keyword,signal,options)=>{calls.push(kind);return collect?collect(kind,signal,options):capture(kind);},stop(){}};
  const service=new FeiguaService({userDataPath:'/unused',browser,retryWait,storage:{read:async()=>structuredClone(disk),write:async value=>{await write?.(value);disk=structuredClone(value);}}});
  return {service,calls,disk:()=>disk};
}
const network=()=>Object.assign(new Error('synthetic transport failure'),{code:'FEIGUA_NETWORK',publicMessage:'网络暂时不可用'});

test('network retries wait 10/30 seconds, preserve snapshots and cached results, and do not recollect successful groups',async()=>{
  let count=0;const waits=[];let f;
  f=fixture({collect:async(kind,_signal,options)=>{assert.deepEqual(options.musicTag,[]);if(kind==='music'&&++count<3){options.musicTag.push('不能污染后续尝试');throw network();}return capture(kind);},
    retryWait:async ms=>{waits.push(ms);const s=await f.service.state();assert.equal(s.runs[0].groups[0].status,'retrying');assert.equal(s.latestResults[0].result.rows[0].id,old.result.rows[0].id);const displayed=displayedFeiguaGroups(s.runs,'',s.latestResults);assert.equal(displayed[0].refreshStatus,'retrying');assert.match(displayed[0].refreshMessage,/自动重试/);}});
  await f.service.start();await f.service.job;
  assert.deepEqual(waits,[10000,30000]);assert.deepEqual(f.calls,['music','music','music','topics','hotspots']);
  const state=await f.service.state();assert.equal(state.runs[0].status,'completed');assert.equal(state.runs[0].groups[0].attempts,3);assert.deepEqual(state.musicTag,[]);assert.notEqual(state.latestResults.find(group=>group.kind==='music').result.rows[0].id,old.result.rows[0].id);
});

test('retry exhaustion stops at three attempts and leaves prior successful results available',async()=>{
  const waits=[];const f=fixture({collect:async kind=>{if(kind==='music')throw network();return capture(kind);},retryWait:async ms=>{waits.push(ms);}});
  await f.service.start();await f.service.job;const s=await f.service.state();
  assert.equal(s.runs[0].status,'partial');assert.equal(s.runs[0].groups[0].attempts,3);assert.match(s.runs[0].groups[0].message,/已自动重试 2 次/);
  assert.equal(f.calls.filter(kind=>kind==='music').length,3);assert.deepEqual(waits,[10000,30000]);
  assert.equal(displayedFeiguaGroups(s.runs,'',s.latestResults)[0].result.rows[0].id,old.result.rows[0].id);
});

test('authentication, permission, quota, rate limit, validation and storage failures are never retried',async()=>{
  for(const code of ['FEIGUA_AUTH_REQUIRED','FEIGUA_PERMISSION','FEIGUA_QUOTA','FEIGUA_RATE_LIMIT','FEIGUA_API_INVALID','FEIGUA_PAGE_CHANGED','FEIGUA_STORAGE']){
    const f=fixture({collect:async kind=>{if(kind==='music')throw Object.assign(new Error('synthetic failure'),{code});return capture(kind);},retryWait:async()=>{assert.fail(`unexpected retry: ${code}`);}});
    await f.service.start();await f.service.job;
    assert.equal(f.calls.filter(kind=>kind==='music').length,1);
    if(['FEIGUA_AUTH_REQUIRED','FEIGUA_QUOTA','FEIGUA_RATE_LIMIT','FEIGUA_STORAGE'].includes(code))assert.deepEqual(f.calls,['music']);
  }
});

test('cancel aborts a real backoff timer immediately and prevents later provider calls',async()=>{
  let reached;const backoff=new Promise(resolve=>{reached=resolve;});
  const f=fixture({collect:async()=>{throw network();},write:async value=>{if(value.runs[0]?.groups[0]?.status==='retrying')reached();}});
  await f.service.start();await backoff;await f.service.cancel();await f.service.job;
  assert.deepEqual(f.calls,['music']);const s=await f.service.state();assert.equal(s.runs[0].status,'cancelled');assert.equal(s.runs[0].groups[0].retryDelay,null);
});

test('failure to persist retry intent stops before any retry request',async()=>{
  const f=fixture({collect:async()=>{throw network();},retryWait:async()=>{assert.fail('must not wait after disk failure');},write:async value=>{if(value.runs[0]?.groups[0]?.status==='retrying')throw new Error('synthetic disk failure');}});
  await f.service.start();await f.service.job;const s=await f.service.state();
  assert.deepEqual(f.calls,['music']);assert.equal(s.runs[0].status,'failed');assert.match(s.storageMessage,/停止采集/);assert.equal(s.latestResults[0].result.rows[0].id,old.result.rows[0].id);
});

test('restart marks a pending retry interrupted and does not automatically replay it',async()=>{
  const f=fixture({stored:{version:1,keywords:[],runs:[{id:'synthetic-old',status:'running',groups:[{kind:'music',status:'retrying',attempts:1,retryDelay:10000}]}]}});
  const s=await f.service.state();assert.equal(s.runs[0].status,'interrupted');assert.equal(s.runs[0].groups[0].status,'interrupted');assert.equal(s.runs[0].groups[0].retryDelay,null);assert.deepEqual(f.calls,[]);
});
