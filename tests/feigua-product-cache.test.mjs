import assert from 'node:assert/strict';
import test from 'node:test';
import { retainProductFields, restoreProductFieldsInState } from '../electron/feigua-product-cache.mjs';
import { FeiguaService } from '../electron/feigua-service.mjs';

const url = 'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=3000000000000000001';
const alternate = url.replace('3000000000000000001', '3000000000000000002');
const earlier = '2026-10-08T01:00:00.000Z', later = '2026-10-08T02:00:00.000Z';
const result = (link, at = later) => ({
  kind: 'videos', keyword: '合成词', collectedAt: at, sourceUrl: 'https://dy.feigua.cn/app/#/synthetic/list',
  dateRange: '2026-10-02 - 2026-10-08', period: '近7天',
  provenance: { transport: 'provider-api', endpoint: '/api/v1/aweme/search/listwith', responseCode: 200 },
  filters: { categoryPath: [], tagPath: [] },
  rows: [{ id: '7000000000000000001', title: '合成视频', sales: '10w-25w', likes: '123', missingFields: [],
    products: [{ id: 'synthetic-product', title: '合成商品', commission: '5.00%', url: link }] }],
});
const group = value => ({ kind: 'videos', keyword: '合成词', status: 'completed', result: value });
const product = value => value.rows[0].products[0];
const previous = () => ({ latestResults: [group(result(url, earlier))] });

test('missing product links retain only the address for an exact identity and keep fresh metrics and titles', () => {
  const fresh = result(null);fresh.rows[0].likes = '999';product(fresh).title = '最新商品名称';product(fresh).commission = '9.00%';
  const saved = previous(), before = structuredClone(saved);
  const retained = retainProductFields(fresh, saved), expected = structuredClone(fresh);
  Object.assign(product(expected), { url, urlVerifiedAt: earlier });
  assert.deepEqual(retained, expected);assert.equal(product(fresh).url, null);assert.deepEqual(saved, before);
});

test('link retention rejects mismatched identities, sources, unsafe addresses and ambiguous history', () => {
  const variants = [
    value => { value.rows[0].id = '7000000000000000002'; },
    value => { product(value).id = 'different-product'; },
    value => { product(value).id = '0'; },
    value => { delete product(value).id; },
    value => { value.sourceUrl = 'https://another.example/app/'; },
    value => { value.collectedAt = '2026-10-09T01:00:00Z'; },
    value => { value.provenance.responseCode = 403; },
    value => { value.provenance.transport = 'unverified'; },
    value => { product(value).url = url + '&token=synthetic'; },
    value => { product(value).url = 'javascript:alert(1)'; },
  ];
  for (const change of variants) {const old = result(url, earlier);change(old);assert.equal(product(retainProductFields(result(null), {latestResults:[group(old)]})).url, null);}
  const ambiguous = {latestResults:[group(result(url, earlier)), group(result(alternate, earlier))]};
  assert.equal(product(retainProductFields(result(null), ambiguous)).url, null);
  assert.equal(product(retainProductFields(result(null), {latestResults:[{...group(result(url, earlier)),status:'failed'}]})).url, null);
  const unidentified = result(null);delete product(unidentified).id;
  assert.equal(product(retainProductFields(unidentified, previous())).url, null);
});

test('fresh links win, empty current results stay empty and retained links keep their original verification time', () => {
  assert.deepEqual(retainProductFields(result(alternate), previous()), result(alternate));
  const empty = {...result(null),rows:[]};assert.deepEqual(retainProductFields(empty,previous()),empty);
  const missingProducts = result(null);missingProducts.rows[0].products=[];
  assert.deepEqual(retainProductFields(missingProducts,previous()),missingProducts);
  const retained=retainProductFields(result(null),previous());
  assert.equal(product(retainProductFields(result(null,'2026-10-08T03:00:00Z'),{latestResults:[group(retained)]})).urlVerifiedAt,earlier);
});

test('verified zero commission is recovered with its original date and promotion flag',()=>{
  const old=result(url,earlier);Object.assign(product(old),{commission:'0.00%',hasCommission:false});
  const fresh=result(url);product(fresh).commission=null;fresh.rows[0].missingFields=['products'];fresh.rows[0].fieldAvailability={commission:'restricted'};
  const recovered=retainProductFields(fresh,{latestResults:[group(old)]});
  assert.equal(product(recovered).commission,'0.00%');assert.equal(product(recovered).commissionVerifiedAt,earlier);assert.equal(product(recovered).hasCommission,false);
  assert.deepEqual(recovered.rows[0].missingFields,['products']);assert.deepEqual(recovered.rows[0].fieldAvailability,{commission:'restricted'});assert.equal(recovered.collectedAt,later);
  assert.equal(product(fresh).commission,null);
});

test('fresh rates including zero take priority, while absent or invalid history never invents a commission',()=>{
  for(const rate of ['0.00%','7.50%']){const fresh=result(url);product(fresh).commission=rate;assert.deepEqual(retainProductFields(fresh,previous()),fresh);}
  for(const rate of [null,'--','-',0,'未知','150.00%']){
    const old=result(url,earlier);product(old).commission=rate;const fresh=result(url);product(fresh).commission=null;
    assert.equal(product(retainProductFields(fresh,{latestResults:[group(old)]})).commission,null);
  }
});

test('commission recovery uses the newest actual verification date, not a later cached capture',()=>{
  const cached=result(url,'2026-10-08T01:50:00Z');Object.assign(product(cached),{commission:'5.00%',commissionVerifiedAt:earlier});
  const newer=result(url,'2026-10-08T01:30:00Z');product(newer).commission='8.00%';
  const fresh=result(url);product(fresh).commission=null;
  const recovered=retainProductFields(fresh,{latestResults:[group(cached)],videoHistory:[group(newer)]});
  assert.equal(product(recovered).commission,'8.00%');assert.equal(product(recovered).commissionVerifiedAt,'2026-10-08T01:30:00.000Z');
  const conflict=structuredClone(newer);product(conflict).commission='9.00%';
  assert.equal(product(retainProductFields(fresh,{latestResults:[group(newer),group(conflict)]})).commission,null);
});

test('commission recovery cannot cross a video, product, source or unverified response',()=>{
  for(const change of [old=>{old.rows[0].id='7000000000000000002';},old=>{product(old).id='another';},old=>{old.sourceUrl='https://another.example/app/';},old=>{old.provenance.responseCode=403;}]){
    const old=result(url,earlier);change(old);const fresh=result(url);product(fresh).commission=null;
    assert.equal(product(retainProductFields(fresh,{latestResults:[group(old)]})).commission,null);
  }
});

function storedPartial() {
  const old=group(result(url,earlier)),fresh=group(result(null));
  return {version:1,loginEntryUrl:'https://dy.feigua.cn/',keywords:['合成词'],
    runs:[{id:'fresh',status:'completed',groups:[fresh]},{id:'old',status:'completed',groups:[old]}],
    latestResults:[structuredClone(fresh)],videoHistory:[structuredClone(fresh)],lastMusicCheck:{date:'2026-10-08',musicTag:[]}};
}
function fixture(stored, write) {
  let disk=structuredClone(stored),writes=0;
  const browser={checkLogin:()=>assert.fail('recovery must not access provider'),collect:()=>assert.fail('recovery must not recollect')};
  const service=new FeiguaService({userDataPath:'/unused',browser,storage:{read:async()=>structuredClone(disk),write:async data=>{writes++;await write?.(data);disk=structuredClone(data);}}});
  return {service,disk:()=>disk,writes:()=>writes};
}

test('restart repair persists links consistently in current results, runs and weekly history without source requests',async()=>{
  const stored=storedPartial(),before=structuredClone(stored),f=fixture(stored);
  const s=await f.service.state();assert.equal(f.writes(),1);
  for(const g of [s.latestResults[0],s.runs[0].groups[0],s.videoHistory[0]]) {
    assert.equal(product(g.result).url,url);assert.equal(product(g.result).urlVerifiedAt,earlier);assert.equal(g.result.collectedAt,later);
  }
  assert.deepEqual(stored,before);assert.equal(f.disk().lastMusicCheck.date,'2026-10-08');
  const reloaded=fixture(f.disk());await reloaded.service.state();assert.equal(reloaded.writes(),0);
});

test('commission repair is persisted once across views and remains explicitly historical after restart',async()=>{
  const stored=storedPartial();product(stored.runs[1].groups[0].result).commission='0.00%';
  for(const g of [stored.runs[0].groups[0],stored.latestResults[0],stored.videoHistory[0]])product(g.result).commission=null;
  const f=fixture(stored),s=await f.service.state();assert.equal(f.writes(),1);
  for(const g of [s.runs[0].groups[0],s.latestResults[0],s.videoHistory[0]]){assert.equal(product(g.result).commission,'0.00%');assert.equal(product(g.result).commissionVerifiedAt,earlier);}
  const reloaded=fixture(f.disk());const next=await reloaded.service.state();assert.equal(reloaded.writes(),0);assert.equal(product(next.latestResults[0].result).commissionVerifiedAt,earlier);
});

test('failed repair persistence leaves the existing disk data intact and does not expose unpersisted repairs',async()=>{
  const stored=storedPartial(),f=fixture(stored,async()=>{throw new Error('synthetic disk failure');});
  await assert.rejects(f.service.state(),/disk failure/);assert.deepEqual(f.disk(),stored);
});

test('new captures retain product links only after their durable write and preserve current metrics',async()=>{
  const stored=storedPartial();stored.runs=stored.runs.slice(1);stored.latestResults=[stored.runs[0].groups[0]];stored.videoHistory=[];
  let release,entered;const gate=new Promise(resolve=>{entered=resolve;});
  const f=fixture(stored,async data=>{if(data.runs[0]?.id==='next'&&data.runs[0].groups[0].result){entered();await new Promise(resolve=>{release=resolve;});}});
  await f.service.state();const current={kind:'videos',keyword:'合成词',status:'running'},run={id:'next',status:'running',groups:[current]};
  f.service.data.runs.unshift(run);const fresh=result(null);fresh.rows[0].likes='999';
  const saving=f.service.saveCapturedGroup(run,current,fresh);await gate;
  assert.equal(current.result,undefined);assert.equal((await f.service.state()).latestResults[0].result.rows[0].likes,'123');
  release();await saving;assert.equal(product(current.result).url,url);assert.equal(current.result.rows[0].likes,'999');
  assert.equal(product(f.disk().latestResults[0].result).url,url);assert.equal(product(fresh).url,null);
});

test('failed new capture persistence cannot replace the saved results or publish a repaired link',async()=>{
  const stored=storedPartial();stored.runs=stored.runs.slice(1);stored.latestResults=[stored.runs[0].groups[0]];stored.videoHistory=[];
  const f=fixture(stored,async()=>{throw new Error('synthetic failure');});await f.service.state();
  const current={kind:'videos',keyword:'合成词',status:'running'},run={id:'next',status:'running',groups:[current]};f.service.data.runs.unshift(run);
  await assert.rejects(f.service.saveCapturedGroup(run,current,result(null)),/保存失败/);
  assert.equal(current.result,undefined);assert.deepEqual(f.disk(),stored);assert.equal((await f.service.state()).latestResults[0].result.collectedAt,earlier);
});

test('malformed or unverified cached groups are ignored and historical results never borrow future links',()=>{
  const malformed={runs:[{groups:[null,{kind:'videos',status:'completed',result:{...result(url),rows:[null,{products:[null]}]}}]}],latestResults:{},videoHistory:null};
  assert.doesNotThrow(()=>restoreProductFieldsInState(malformed));
  const old=group(result(null,earlier)),future=group(result(url));
  const recovered=restoreProductFieldsInState({runs:[],latestResults:[future],videoHistory:[old]});
  assert.equal(recovered.changed,false);assert.equal(product(recovered.data.videoHistory[0].result).url,null);
});
