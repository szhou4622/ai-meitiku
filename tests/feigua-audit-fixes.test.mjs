import assert from 'node:assert/strict';
import test from 'node:test';
import { FeiguaBrowser } from '../electron/feigua-browser.mjs';
import { FeiguaService } from '../electron/feigua-service.mjs';
import { FEIGUA_SOURCES } from '../electron/feigua-contract.mjs';
import { VIDEO_DETAIL_ENDPOINTS } from '../electron/feigua-video-details.mjs';

const origin='https://dy.feigua.cn';
const flush=async()=>{for(let n=0;n<12;n++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const catalog={categoryPath:[{label:'合成分类',children:[]}],tagPath:[{label:'合成标签',children:[]}]};
const capture=(kind,keyword=null)=>({url:`${origin}/app/#/synthetic/${kind}`,keyword,sort:FEIGUA_SOURCES[kind].sort,direction:'desc',period:FEIGUA_SOURCES[kind].period,
  filtersVerified:true,musicTag:[],categoryPath:[],tagPath:[],dateRange:kind==='hotspots'?'2026-10-07':kind==='topics'?'2026-09-28 - 2026-10-04':'2026-10-02 - 2026-10-08',
  rows:[0,1].map(i=>({id:`700000000000000000${i}`,url:`${origin}/app/#/synthetic/detail/${i}`,title:'合成结果',author:'合成作者',followers:'10',totalUsers:'100',yesterdayUsers:'10',participantGrowth:'10%',playGrowth:'20%',peakHeat:String(100-i),sales:'10w-25w',salesCount:'10',likes:'1',publishedAt:'2026/10/08 09:00',products:[{id:`synthetic-product-${i}`,title:'合成商品',commission:null}]}))});
function fixture(browser={},write){
  let disk={version:1,loginEntryUrl:origin+'/',keywords:[],runs:[]},writes=0;
  const service=new FeiguaService({userDataPath:'/unused',browser,storage:{read:async()=>structuredClone(disk),write:async data=>{writes++;await write?.(data);disk=structuredClone(data);}},retryWait:async()=>assert.fail('terminal conditions must not retry')});
  return {service,disk:()=>disk,writes:()=>writes,browser};
}
function verificationFixture(t){
  t.mock.timers.enable({apis:['setInterval']});
  const browser=new FeiguaBrowser({}),calls=[],commands=[];
  const page={auth:{authenticated:false,actionRequired:'verification'}};
  let destroyed=false;
  browser.loginEntryUrl=origin+'/';
  browser.window={isDestroyed:()=>destroyed,show:()=>calls.push('show'),focus:()=>calls.push('focus'),hide:()=>calls.push('hide'),close:()=>{calls.push('close');destroyed=true;},destroy:()=>{destroyed=true;},
    loadURL:async()=>assert.fail('verification watcher must not navigate'),webContents:{getURL:()=>origin+'/app/',stop:()=>calls.push('stop'),executeJavaScript:async()=>page.auth}};
  const execute=browser.execute.bind(browser);browser.execute=(command,...args)=>{commands.push(command);return execute(command,...args);};
  browser.collect=async(kind,keyword)=>{calls.push(`collect:${kind}`);return capture(kind,keyword);};
  const f=fixture(browser);t.after(()=>f.service.dispose());return{...f,page,calls,commands};
}

test('manual verification restores service readiness on the same window and permits a checked retry',async t=>{
  const f=verificationFixture(t);await f.service.ready;
  await assert.rejects(f.service.start(),{code:'FEIGUA_VERIFICATION_REQUIRED'});await flush();
  assert.equal((await f.service.state()).auth.status,'verification_required');assert.ok(f.browser.verificationTimer);
  f.page.auth={authenticated:true};t.mock.timers.tick(1000);await flush();
  assert.equal((await f.service.state()).auth.status,'authenticated');assert.equal(f.browser.verificationTimer,null);
  assert.deepEqual(f.calls,['show','focus','hide']);assert.ok(f.commands.every(command=>command==='auth'));
  await f.service.start();await f.service.job;assert.equal((await f.service.state()).runs[0].status,'completed');
  assert.equal(f.calls.filter(call=>call.startsWith('collect:')).length,3);assert.ok(!f.calls.includes('close'));
});

test('430 without an observed dialog does not prematurely mark verification complete',async t=>{
  const f=verificationFixture(t);await f.service.ready;f.page.auth={authenticated:true};
  assert.throws(()=>f.browser.requireVerification(),{code:'FEIGUA_VERIFICATION_REQUIRED'});await flush();t.mock.timers.tick(1000);await flush();
  assert.equal((await f.service.state()).auth.status,'verification_required');assert.ok(!f.calls.includes('hide'));
  f.page.auth={authenticated:false,actionRequired:'verification'};t.mock.timers.tick(1000);await flush();
  f.page.auth={authenticated:true};t.mock.timers.tick(1000);await flush();assert.equal((await f.service.state()).auth.status,'authenticated');
});

test('automatic login flows keep verification state instead of masking it as a generic startup error',async t=>{
  const f=verificationFixture(t);await f.service.ready;f.browser.openLogin=async()=>{};
  for(const collectAfterLogin of [false,true]){
    f.page.auth=collectAfterLogin?{authenticated:false,actionRequired:'verification'}:{authenticated:true};
    f.browser.getMusicTags=async()=>f.browser.requireVerification();
    f.browser.getVideoFilters=async()=>assert.fail('must not leave a verification prompt');
    await f.service.login({collectAfterLogin});f.browser.onAuthChange({status:'authenticated'});await f.service.autoStart;await flush();
    assert.equal((await f.service.state()).auth.status,'verification_required');assert.ok(f.browser.verificationTimer);
    assert.ok(!f.calls.some(call=>call.startsWith('collect:')));f.browser.stopVerificationWatch();
  }
});

test('cancelling a pending verification observation prevents late readiness or auto-restart',async t=>{
  const f=verificationFixture(t);await f.service.ready;const gate=deferred();
  f.browser.window.webContents.executeJavaScript=()=>gate.promise;
  assert.throws(()=>f.browser.requireVerification(true),{code:'FEIGUA_VERIFICATION_REQUIRED'});
  await f.service.cancel();gate.resolve({authenticated:true});await flush();
  assert.equal(f.browser.verificationTimer,null);assert.equal((await f.service.state()).auth.status,'verification_required');assert.ok(!f.calls.includes('hide'));
  assert.ok(!f.calls.some(call=>call.startsWith('collect:')));
});

test('a cancelled foreground auth read cannot reopen verification or restart its observer',async()=>{
  for(const reject of [false,true]){
    const browser=new FeiguaBrowser({}),gate=deferred(),events=[],calls=[];
    browser.window={isDestroyed:()=>false,show:()=>calls.push('show'),focus:()=>calls.push('focus'),webContents:{getURL:()=>origin+'/app/',executeJavaScript:()=>gate.promise,stop:()=>calls.push('stop')}};
    browser.onAuthChange=auth=>events.push(auth.status);const checking=browser.checkLogin();browser.stop();
    if(reject)gate.reject(new Error('synthetic cancelled read'));else gate.resolve({authenticated:false,actionRequired:'verification'});
    await assert.rejects(checking,{code:'FEIGUA_CANCELLED'});assert.deepEqual(events,[]);assert.deepEqual(calls,['stop']);assert.equal(browser.verificationTimer,null);
  }
});

test('task takeover and replacement windows invalidate a pending verification observer',async t=>{
  const f=verificationFixture(t);await f.service.ready;const gate=deferred();let reads=0;
  f.browser.window.webContents.executeJavaScript=()=>++reads===1?gate.promise:Promise.resolve({authenticated:true});
  assert.throws(()=>f.browser.requireVerification(true));
  assert.equal((await f.browser.checkLogin()).status,'authenticated');const hidden=f.calls.filter(v=>v==='hide').length;
  gate.resolve({authenticated:true});await flush();assert.equal(f.calls.filter(v=>v==='hide').length,hidden);assert.equal(f.browser.verificationTimer,null);
  const old=f.browser.window,second=deferred();old.webContents.executeJavaScript=()=>second.promise;
  assert.throws(()=>f.browser.requireVerification(true));f.browser.window={...old,hide:()=>assert.fail('old observer hid the replacement')};
  second.resolve({authenticated:true});await flush();f.browser.stopVerificationWatch();
});

test('automatic catalog cancellation stops both successful and failed late reads before another request',async()=>{
  for(const stage of ['music','video'])for(const rejects of [false,true])for(const dispose of [false,true]){
    const gate=deferred(),entered=deferred(),calls=[];let signal;
    const read=async(kind,s)=>{calls.push(kind);signal=s;if(kind===stage){entered.resolve();return gate.promise;}return kind==='music'?{options:[{label:'合成一级',children:[]}]}:catalog;};
    const f=fixture({openLogin:async()=>{},checkLogin:async()=>({status:'authenticated'}),stop:()=>calls.push('stop'),dispose:()=>calls.push('dispose'),getMusicTags:s=>read('music',s),getVideoFilters:s=>read('video',s)});
    await f.service.login({collectAfterLogin:false});f.browser.onAuthChange({status:'authenticated'});await entered.promise;
    const before=f.writes();if(dispose)f.service.dispose();else await f.service.cancel();assert.equal(signal.aborted,true);
    if(rejects)gate.reject(Object.assign(new Error('synthetic abort'),{code:'FEIGUA_NETWORK'}));else gate.resolve(stage==='music'?{options:[{label:'迟到目录',children:[]}]}:catalog);
    await f.service.autoStart;assert.equal(f.writes(),before);assert.equal((await f.service.state()).busy,false);assert.equal(f.service.controller,null);
    assert.deepEqual(calls,stage==='music'?['music',dispose?'dispose':'stop']:['music','video',dispose?'dispose':'stop']);
  }
});

test('cancelling catalog updates while their write is queued prevents new storage side effects',async()=>{
  for(const type of ['music','video']){
    const gate=deferred(),controller=new AbortController(),f=fixture();await f.service.ready;f.service.writeQueue=gate.promise;
    const updating=type==='music'?f.service.cacheMusicTags({options:[{label:'合成一级',children:[]}]},controller.signal):f.service.cacheVideoFilters(catalog,controller.signal);
    controller.abort();gate.resolve();await assert.rejects(updating,{code:'FEIGUA_CANCELLED'});assert.equal(f.writes(),0);
  }
});

test('catalog cancellation permits an already-started atomic write but never the next source',async()=>{
  const entered=deferred(),gate=deferred(),calls=[];
  const f=fixture({openLogin:async()=>{},checkLogin:async()=>({status:'authenticated'}),stop:()=>{},getMusicTags:async()=>({options:[{label:'已取得目录',children:[]}]}),getVideoFilters:async()=>{calls.push('video');return catalog;}},async()=>{entered.resolve();await gate.promise;});
  await f.service.login({collectAfterLogin:false});f.browser.onAuthChange({status:'authenticated'});await entered.promise;
  await f.service.cancel();gate.resolve();await f.service.autoStart;assert.deepEqual(calls,[]);assert.equal(f.writes(),1);
  assert.deepEqual((await f.service.state()).musicTagOptions,f.disk().musicTagOptions);
});

async function withDetailTerminal(response,operation){
  const old={document:globalThis.document,location:globalThis.location,style:globalThis.getComputedStyle,entries:performance.getEntriesByType};
  const browser=new FeiguaBrowser({});browser.loginEntryUrl=origin+'/';let currentId,detailCalls=0,currentUrl=origin+'/app/';
  const models=Object.fromEntries(Object.values(VIDEO_DETAIL_ENDPOINTS).map(endpoint=>[endpoint,{url:endpoint,GET:async()=>{detailCalls++;return response;}}]));
  globalThis.document={querySelector:()=>({__vue__:{$api:{detail:models}}}),querySelectorAll:()=>[]};globalThis.location={origin};globalThis.getComputedStyle=()=>({visibility:'visible'});
  performance.getEntriesByType=()=>Object.values(VIDEO_DETAIL_ENDPOINTS).map(endpoint=>({name:`${origin}${endpoint}?awemeId=${currentId}&dateCode=20261008`}));
  browser.window={isDestroyed:()=>false,webContents:{getURL:()=>currentUrl,executeJavaScript:source=>(0,eval)(source)}};
  browser.navigate=async url=>{currentUrl=url;currentId=url.endsWith('/0')?'7000000000000000000':'7000000000000000001';};browser.resolveAuth=async()=>({authenticated:true});browser.settle=async()=>{};
  try {await operation(browser,()=>detailCalls);} finally {globalThis.document=old.document;globalThis.location=old.location;globalThis.getComputedStyle=old.style;performance.getEntriesByType=old.entries;}
}

test('detail quota, rate limit and expiry preserve verified rows but terminate later keyword groups',async()=>{
  for(const response of [{Code:403,Data:{Remainder:0}},{Code:429},{Code:401}])for(const invalid of [false,true]){
    await withDetailTerminal(response,async(browser,detailCalls)=>{
      const calls=[];browser.checkLogin=async()=>({status:'authenticated'});browser.collect=async(kind,keyword,signal)=>{calls.push(keyword);const value=capture(kind,keyword);await browser.enrichVideoFields(value,signal);if(invalid)value.rows[0].sales='--';return value;};
      const f=fixture(browser);await f.service.saveAndRefreshVideoQueries([{keyword:'合成甲',categoryPath:[],tagPath:[]},{keyword:'合成乙',categoryPath:[],tagPath:[]}]);await f.service.job;
      const s=await f.service.state();assert.deepEqual(calls,['合成甲']);assert.equal(detailCalls(),1);assert.equal(s.runs[0].groups[1].status,'skipped');
      assert.match(s.runs[0].groups[1].message,/停止后续/);assert.equal(s.runs[0].status,invalid?'failed':'partial');
      assert.equal(s.latestResults.length,invalid?0:1);if(!invalid)assert.equal(s.latestResults[0].result.rows.length,2);
      if(response.Code===401)assert.equal(s.auth.status,'expired');
    });
  }
});
