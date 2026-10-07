import test from 'node:test';
import assert from 'node:assert/strict';
import { VIDEO_DETAIL_ENDPOINTS, videoPublishedDate, observeVideoDetailRequest, readVideoDetailsApi, enrichVideoRow } from '../electron/feigua-video-details.mjs';
import { validateCapture, FEIGUA_SOURCES } from '../electron/feigua-contract.mjs';

const origin='https://dy.feigua.cn',id='synthetic-video',dateCode='20261002';
const row={id,url:`${origin}/app/#/synthetic/detail`,title:'合成视频',author:'合成达人',followers:'100',plays:null,likes:'166',comments:'0',shares:'2',collects:'3',sales:'10w~25w',salesCount:'2500-5000',publishedAt:'2026/10/02 12:11',products:[{id:'synthetic-goods',title:'合成商品',commission:null}],productCount:1};
const detail={state:'verified',videoId:id,dateCode,playsCount:0,playsText:null,products:[{id:'synthetic-goods',title:'合成商品',commission:'0.00%',hasCommission:false}]};

test('source-provided 0.00% is displayed while raw zero playback placeholders remain unavailable',()=>{
  const enriched=enrichVideoRow(row,detail);
  assert.equal(enriched.products[0].commission,'0.00%');assert.equal(enriched.products[0].hasCommission,false);
  assert.equal(enriched.plays,null);assert.equal(enriched.fieldAvailability.plays,'source_unavailable');
  assert.equal(row.products[0].commission,null);
});
test('commission placeholders never become invented zero percentages',()=>{
  for(const ratio of [null,'--','-',0,'private-unknown'])assert.equal(enrichVideoRow(row,{...detail,products:[{...detail.products[0],commission:ratio}]}).products[0].commission,null);
});
test('valid detail playback values retain cumulative scope and an explicitly formatted zero can be preserved',()=>{
  for(const playsText of ['1.2w','0']){const enriched=enrichVideoRow(row,{...detail,playsText});assert.equal(enriched.plays,playsText);assert.equal(enriched.playsScope,'detail-total');}
  assert.equal(enrichVideoRow(row,{...detail,playsCount:1200}).plays,'1200');
});
test('mismatched video/date/product identities cannot overwrite source data',()=>{
  for(const changed of [{videoId:'wrong-video'},{dateCode:'20261003'}]){const enriched=enrichVideoRow(row,{...detail,...changed});assert.equal(enriched.products[0].commission,null);assert.equal(enriched.fieldAvailability.commission,'lookup_failed');}
  assert.equal(enrichVideoRow(row,{...detail,products:[{...detail.products[0],id:'wrong-goods'}]}).products[0].commission,null);
  assert.equal(enrichVideoRow({...row,productCount:2,productsIncomplete:true},detail).productsIncomplete,true);
});
test('already collected commissions are preserved and blocked lookups have explicit availability',()=>{
  assert.equal(enrichVideoRow({...row,products:[{...row.products[0],commission:'27.00%'}]},detail).products[0].commission,'27.00%');
  for(const state of ['restricted','auth_required','quota_exhausted','rate_limited'])assert.equal(enrichVideoRow(row,{state}).fieldAvailability.plays,'restricted');
  assert.equal(enrichVideoRow(row,{state:'lookup_failed'}).fieldAvailability.plays,'lookup_failed');
});
test('detail observation drops signatures and limits endpoint, origin and unique business parameters',()=>{
  const request={method:'GET',url:`${origin}${VIDEO_DETAIL_ENDPOINTS.main}?awemeId=${id}&dateCode=${dateCode}&sign=synthetic-secret&ts=synthetic-time`};
  assert.deepEqual(observeVideoDetailRequest(request,origin),{endpoint:VIDEO_DETAIL_ENDPOINTS.main,videoId:id,dateCode});
  assert.doesNotMatch(JSON.stringify(observeVideoDetailRequest(request,origin)),/synthetic-secret|synthetic-time/);
  assert.equal(observeVideoDetailRequest(request,'https://other.example'),null);
  assert.equal(observeVideoDetailRequest({...request,url:request.url+'&awemeId=other'},origin),null);
  assert.equal(videoPublishedDate(row.publishedAt),dateCode);
});

async function withPage({main,products,entries,mask}={},operation){
  const oldDoc=globalThis.document,oldLocation=globalThis.location,oldStyle=globalThis.getComputedStyle,oldEntries=performance.getEntriesByType;
  const calls=[];
  const models={main:{url:VIDEO_DETAIL_ENDPOINTS.main,GET:async({params})=>{calls.push('main');assert.equal(params.awemeId,id);return main||{Code:200,Status:true,Data:{AwemeId:id,DateCode:dateCode,PlayCount:0,PlayCountStr:null,Sign:'synthetic-secret'}};}},products:{url:VIDEO_DETAIL_ENDPOINTS.products,GET:async()=>{calls.push('products');return products||{Code:200,Status:true,Data:[{Goods:{Gid:'synthetic-goods',Title:'合成商品',CosRatio:'0.00%',HasCos:false,Token:'synthetic-secret'}}]};}}};
  globalThis.document={querySelector:()=>({__vue__:{$api:{videoDetail:models}}}),querySelectorAll:()=>mask?[{getClientRects:()=>[{}]}]:[]};
  globalThis.location={origin};globalThis.getComputedStyle=()=>({visibility:'visible'});
  performance.getEntriesByType=()=>entries||Object.values(VIDEO_DETAIL_ENDPOINTS).map(path=>({name:`${origin}${path}?awemeId=${id}&dateCode=${dateCode}${path===VIDEO_DETAIL_ENDPOINTS.main?'&sign=synthetic-secret&ts=123':''}`}));
  try{return await operation(calls);}finally{globalThis.document=oldDoc;globalThis.location=oldLocation;globalThis.getComputedStyle=oldStyle;performance.getEntriesByType=oldEntries;}
}
test('detail API reuses observed source requests and exports only whitelisted metrics',async()=>{
  await withPage({},async calls=>{const result=await readVideoDetailsApi({videoId:id,dateCode});assert.equal(result.state,'verified');assert.equal(result.products[0].commission,'0.00%');assert.deepEqual(calls,['main','products']);assert.doesNotMatch(JSON.stringify(result),/synthetic-secret|"(?:Token|Sign|ts)"/);});
});
test('missing observed requests and permission masks prevent guessed or unauthorized lookups',async()=>{
  for(const options of [{entries:[]},{mask:true}])await withPage(options,async calls=>{assert.notEqual((await readVideoDetailsApi({videoId:id,dateCode})).state,'verified');assert.deepEqual(calls,[]);});
});
test('quota, login and sample responses stop subsequent detail calls without publishing data',async()=>{
  for(const main of [{Code:401},{Code:403,Data:{Remainder:0}},{Code:200,Status:true,ExampleData:true,Data:{AwemeId:id}}])await withPage({main},async calls=>{assert.notEqual((await readVideoDetailsApi({videoId:id,dateCode})).state,'verified');assert.deepEqual(calls,['main']);});
});
test('saved video rows retain availability, supplemental engagement, zero commission and safe provenance',()=>{
  const enriched=enrichVideoRow(row,detail);
  const clean=validateCapture('videos','合成词',{url:`${origin}/app/#/synthetic/list`,keyword:'合成词',period:'近7天',sort:FEIGUA_SOURCES.videos.sort,direction:'desc',filtersVerified:true,categoryPath:[],tagPath:[],dateRange:'2026-10-01 - 2026-10-07',rows:[enriched]});
  assert.equal(clean.rows[0].products[0].commission,'0.00%');assert.equal(clean.rows[0].products[0].hasCommission,false);assert.equal(clean.rows[0].salesCount,'2500-5000');assert.deepEqual(clean.rows[0].missingFields,[]);
  assert.deepEqual(clean.rows[0].detailProvenance.endpoints,Object.values(VIDEO_DETAIL_ENDPOINTS));
});
