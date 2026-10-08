import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { FEIGUA_ENDPOINTS, observeFeiguaRequest, validateFeiguaRequest, readFeiguaApi, captureFeiguaResponse } from '../electron/feigua-api.mjs';
import { FEIGUA_SOURCES, validateCapture } from '../electron/feigua-contract.mjs';
import { FeiguaBrowser } from '../electron/feigua-browser.mjs';
import { FeiguaService } from '../electron/feigua-service.mjs';

const contexts = Object.fromEntries(Object.keys(FEIGUA_ENDPOINTS).map(kind => [kind, {
  url:`https://dy.feigua.cn/app/#/${kind}`,period:FEIGUA_SOURCES[kind].period,filtersVerified:true,
  dateRange:kind==='hotspots'?'2026-10-01':kind==='topics'?'2026-09-21 - 2026-09-27':kind==='videos'?'2026-09-26 - 2026-10-02':null,
  keyword:kind==='videos'?'合成词':null,musicTag:[],musicTagId:'0',categoryPath:[],categoryId:'0',tagPath:[],tagId:'0',
}]));
const parameters = {
  music:{'filter.sort':'1'},topics:{sortField:'UserCountIncRatioStr',order:'1',topicRankType:'0',period:'week'},
  hotspots:{rankType:'1',period:'day',dateCode:'20261001'},
  videos:{'q.keyword':'合成词','q.keywordType':'0','q.mSearchType':'2','q.tagMode':'0','q.sort':'8','q.searchType':'2','q.dateFrom':'2026-09-26','q.dateTo':'2026-10-02'},
};
const request = kind => ({kind,endpoint:FEIGUA_ENDPOINTS[kind],params:{...parameters[kind],pageIndex:'1',pageSize:'10',pageType:'1'}});

test('proxy API observation requires the pinned runtime source and exact endpoint', () => {
  const origin = 'http://192.0.2.10:13042';
  const details = {method:'GET',url:`${origin}${FEIGUA_ENDPOINTS.music}?pageIndex=1&pageSize=10&pageType=1&filter.sort=1`};
  assert.equal(observeFeiguaRequest(details), null);
  assert.equal(observeFeiguaRequest(details, 'http://192.0.2.10:13045'), null);
  assert.equal(observeFeiguaRequest(details, origin).kind, 'music');
  assert.equal(observeFeiguaRequest({...details,url:`${origin}/api/v1/user/info`}, origin), null);
  const capture = {...contexts.music,url:`${origin}/app/#/music/index`,sort:FEIGUA_SOURCES.music.sort,direction:'desc',emptyVerified:true,rows:[]};
  assert.throws(()=>validateCapture('music',null,capture),/来源/);
  assert.throws(()=>validateCapture('music',null,capture,{sourceOrigin:'http://192.0.2.10:13045'}),/来源/);
  assert.equal(validateCapture('music',null,capture,{sourceOrigin:origin}).sourceUrl,capture.url);
});
const row = {
  MusicId:'music-1',Title:'合成标题',Author:'合成作者',UserCount:'100w',TodayUserCount:'88.2w',DetailUrl:'https://dy.feigua.cn/synthetic/item',
  TopicId:'topic-1',RankNum:1,topic:{TopicName:'合成话题',TopicFullDetailUrl:'https://dy.feigua.cn/synthetic/topic'},blogger:{BloggerName:'合成发起人',MPlatform_Fans:'10w'},UserCountIncRatioStr:'97.2w%',ViewCountIncRatioStr:'2.1w%',
  HotId:'hot-1',Rank:1,HotValueStr:'1200w',
  AwemeId:'video-1',Desc:'合成视频',BloggerNickName:'合成达人',Fans:'12w',PlayCount:'--',LikeCount:'1000',SalesGmv:'2w-10w',SaleCount:'1000-2500',PubTimeStr:'2026/09/30 10:00',IsHasProduct:true,product:{Title:'合成商品',CosRatioShow:'5.00%',PromotionsCount:1},
};
const response = () => ({code:200,success:true,data:{Total:1,PageIndex:1,TimeRangeStr:null,list:[structuredClone(row)]}});

test('ranking response retains verified public video and product links while ignoring gateway destinations', () => {
  const raw = response(); const entry = raw.data.list[0];
  entry.AwemeId = '7000000000000000001';
  entry.VideoUrl = 'https://www.douyin.com/share/video/7000000000000000001/?mid=7000000000000000002';
  entry.product.PromotionUrl = 'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=3000000000000000001';
  const result = captureFeiguaResponse('videos',request('videos'),contexts.videos,raw).rows[0];
  assert.equal(result.videoUrl, 'https://www.douyin.com/video/7000000000000000001');
  assert.equal(result.products[0].url, entry.product.PromotionUrl);
  entry.product.PromotionUrl = 'https://dy.feigua.cn/app/#/goods-detail/index';
  assert.equal(captureFeiguaResponse('videos',request('videos'),contexts.videos,raw).rows[0].products[0].url, null);
});

test('ranking author links are matched to one source creator and saved without secrets', async () => {
  const old = globalThis.document;
  const entry = {...row, BloggerCreators:[{NickName:row.BloggerNickName,Uid:'700000000001',DouyinBloggerUrl:null,Token:'synthetic-secret'}], ExtInfo:row.product};
  const model = {url:FEIGUA_ENDPOINTS.videos,GET:async()=>({Code:200,Status:true,Data:{Total:1,PageIndex:1,List:[entry]}})};
  globalThis.document = {querySelector:()=>({__vue__:{$api:{video:{list:model}}}})};
  try {
    const parsed = await readFeiguaApi({endpoint:FEIGUA_ENDPOINTS.videos,params:request('videos').params});
    assert.doesNotMatch(JSON.stringify(parsed), /synthetic-secret|Token/);
    const clean = validateCapture('videos','合成词',captureFeiguaResponse('videos',request('videos'),contexts.videos,parsed));
    assert.equal(clean.rows[0].authorUrl,'https://www.iesdouyin.com/share/user/700000000001');
    for (const creators of [[], [{...parsed.data.list[0].creators[0],NickName:'其他达人'}], [parsed.data.list[0].creators[0], {...parsed.data.list[0].creators[0],Uid:'700000000002'}]]) {
      parsed.data.list[0].creators = creators;
      assert.equal(captureFeiguaResponse('videos',request('videos'),contexts.videos,parsed).rows[0].authorUrl,null);
    }
  } finally { globalThis.document = old; }
});

test('observes only verified ranking GET endpoints and excludes transport secrets',()=>{
  for(const kind of Object.keys(FEIGUA_ENDPOINTS)){
    const expected=request(kind);
    const url=`https://dy.feigua.cn${expected.endpoint}?${new URLSearchParams({...expected.params,_:'123'})}`;
    assert.deepEqual(observeFeiguaRequest({method:'GET',url}),expected);
    assert.equal(observeFeiguaRequest({method:'POST',url}),null);
    assert.equal(observeFeiguaRequest({method:'GET',url:url.replace('dy.feigua.cn','evil.example')}),null);
    const denied=observeFeiguaRequest({method:'GET',url:url+'&token=private-credential'});
    assert.equal(denied.invalid,true);assert.doesNotMatch(JSON.stringify(denied),/private-credential/);
    assert.equal(observeFeiguaRequest({method:'GET',url:url+'&pageIndex=2'}).invalid,true);
  }
  assert.equal(observeFeiguaRequest({method:'GET',url:'https://dy.feigua.cn/api/v1/user/info'}),null);
});

for(const kind of Object.keys(FEIGUA_ENDPOINTS))test(`${kind}: requires exact request scope and parses provider values without DOM rows`,()=>{
  const capture=captureFeiguaResponse(kind,request(kind),contexts[kind],response());
  const result=validateCapture(kind,contexts[kind].keyword,capture);
  assert.equal(result.rows.length,1);assert.equal(result.provenance.transport,'provider-api');
  assert.equal(result.provenance.endpoint,FEIGUA_ENDPOINTS[kind]);
  assert.throws(()=>validateFeiguaRequest(kind,{...request(kind),params:{...request(kind).params,pageIndex:'2'}},contexts[kind]),/不一致/);
  assert.throws(()=>validateFeiguaRequest(kind,request(kind),{...contexts[kind],filtersVerified:false}),/尚未核验/);
});

test('rejects previous-keyword, wrong sort, wrong dates and unconfirmed category parameters',()=>{
  const cases=[['music',{'filter.sort':'0'}],['topics',{order:'0'}],['topics',{dateCode:'20260914-20260920'}],['hotspots',{period:'hour'}],['hotspots',{dateCode:'20260930'}],['videos',{'q.keyword':'旧关键词'}],['videos',{'q.sort':'9'}],['videos',{'q.dateFrom':'2026-01-01'}],['videos',{'q.tag':'9'}]];
  for(const [kind,patch] of cases)assert.throws(()=>validateFeiguaRequest(kind,{...request(kind),params:{...request(kind).params,...patch}},contexts[kind]));
  const selected={...contexts.videos,categoryPath:['合成品类'],categoryId:'123',tagPath:['合成标签'],tagId:'456'};
  assert.throws(()=>validateFeiguaRequest('videos',request('videos'),selected),/分类/);
  assert.doesNotThrow(()=>validateFeiguaRequest('videos',{...request('videos'),params:{...request('videos').params,'q.categoryId':'123','q.tag':'456'}},selected));
});

test('parameters from another module cannot be silently carried into a valid ranking request',()=>{
  assert.throws(()=>validateFeiguaRequest('music',{...request('music'),params:{...request('music').params,'q.keyword':'合成词'}},contexts.music),/不属于/);
  assert.throws(()=>validateFeiguaRequest('hotspots',{...request('hotspots'),params:{...request('hotspots').params,tag:'123'}},contexts.hotspots),/不属于/);
});

test('403 quota responses and ExampleData never turn into valid rankings or empty results',()=>{
  for(const remaining of [0,'0'])assert.throws(()=>captureFeiguaResponse('videos',request('videos'),contexts.videos,{code:403,success:false,data:{Remainder:remaining,list:[row],ExampleData:{list:[row]}}}),error=>error.code==='FEIGUA_QUOTA');
  for(const invalid of [{code:403,success:false,data:{list:[row]}},{code:200,success:false,data:{list:[row]}},{code:200,success:true,data:{list:null}}])assert.throws(()=>captureFeiguaResponse('videos',request('videos'),contexts.videos,invalid));
});

test('empty response requires Total zero; malformed or partial pages are rejected',()=>{
  assert.equal(captureFeiguaResponse('videos',request('videos'),contexts.videos,{code:200,success:true,data:{Total:0,PageIndex:1,list:[]}}).emptyVerified,true);
  for(const data of [{Total:1,list:[]},{Total:0,PageIndex:2,list:[]},{Total:20,list:Array(11).fill(row)}])assert.throws(()=>captureFeiguaResponse('videos',request('videos'),contexts.videos,{code:200,success:true,data}));
});

test('fixed API rankings require consecutive source positions and descending numeric peak heat',()=>{
  for(const list of [[{...row,Rank:6}],[row,{...row,Rank:3}],[row,{...row,Rank:2,HotValueStr:'0.2亿'}],[{...row,HotValueStr:'开通会员查看'}]]){
    assert.throws(()=>captureFeiguaResponse('hotspots',request('hotspots'),contexts.hotspots,{...response(),data:{Total:list.length,list}}));
  }
  const list=[row,{...row,Rank:2,HotId:'hot-2',HotValueStr:'1000w'}];
  assert.equal(captureFeiguaResponse('hotspots',request('hotspots'),contexts.hotspots,{...response(),data:{Total:2,list}}).rows.length,2);
});

test('response-provided dates must agree and missing optional values remain missing',()=>{
  assert.throws(()=>captureFeiguaResponse('topics',request('topics'),contexts.topics,{...response(),data:{...response().data,TimeRangeStr:'2026-09-14 - 2026-09-20'}}),/日期/);
  const input=response();input.data.list[0].product.PromotionsCount=3;
  const result=validateCapture('videos','合成词',captureFeiguaResponse('videos',request('videos'),contexts.videos,input));
  assert.equal(result.rows[0].salesCount,'1000-2500');assert.equal(result.rows[0].sales,'2w-10w');
  assert.equal(result.rows[0].missingFields.includes('plays'),false);assert.ok(result.rows[0].missingFields.includes('products'));
});

test('provider client uses observed params and exports only the allowed response fields',async()=>{
  const old=globalThis.document;let options;
  const model={url:FEIGUA_ENDPOINTS.music,GET:async input=>{
    options=input;
    return{Code:200,Status:true,Token:'private-value',Data:{Total:1,List:[{MusicId:'m-1',Title:'合成',Author:'作者',Sign:'private-value',HotAwemes:[{Token:'private-value'}]}]}};
  }};
  globalThis.document={querySelector:()=>({__vue__:{$api:{music:{list:model}}}})};
  try{
    const parsed=await readFeiguaApi({endpoint:FEIGUA_ENDPOINTS.music,params:request('music').params});
    assert.deepEqual(options,{params:request('music').params});assert.equal(parsed.data.list[0].Author,'作者');
    assert.doesNotMatch(JSON.stringify(parsed),/private-value/);
    assert.ok((await readFeiguaApi({endpoint:'/api/v1/user/info',params:{}})).error);
  }finally{globalThis.document=old;}
});

test('successful sample responses retain only a rejection flag and cannot reach capture validation', async () => {
  const old=globalThis.document;
  try {
    for(const nested of [false,true])for(const marker of [true,{Token:'private-sample-data'}]) {
      const data={Total:5,PageIndex:1,List:Array.from({length:5},(_,i)=>({...row,MusicId:`synthetic-${i}`})),...(nested?{ExampleData:marker}:{})};
      const source={Code:200,Status:true,Data:data,...(!nested?{ExampleData:marker}:{})};
      globalThis.document={querySelector:()=>({__vue__:{$api:{music:{list:{url:FEIGUA_ENDPOINTS.music,GET:async()=>source}}}}})};
      const response=await readFeiguaApi({endpoint:FEIGUA_ENDPOINTS.music,params:request('music').params});
      assert.equal(response.exampleData,true);assert.doesNotMatch(JSON.stringify(response),/private-sample-data/);
      assert.throws(()=>captureFeiguaResponse('music',request('music'),contexts.music,response),/示例数据/);
    }
    for(const sample of [{ExampleData:true},{data:{...response().data,ExampleData:true}},{exampleData:true}]) {
      assert.throws(()=>captureFeiguaResponse('music',request('music'),contexts.music,{...response(),...sample}),/示例数据/);
    }
  } finally { globalThis.document=old; }
});

test('sample-response rejection preserves persisted results and cannot replace the latest successful ranking', async () => {
  const oldDocument=globalThis.document;let disk={version:1,loginEntryUrl:'https://dy.feigua.cn/',keywords:[],runs:[]};let sample=false;
  globalThis.document={querySelector:()=>({__vue__:{$api:{music:{list:{url:FEIGUA_ENDPOINTS.music,GET:async()=>({Code:200,Status:true,ExampleData:sample,Data:{Total:1,PageIndex:1,List:[row]}})}}}}})};
  const browser={checkLogin:async()=>({status:'authenticated'}),collect:async(kind)=>kind==='music'
    ? captureFeiguaResponse(kind,request(kind),contexts[kind],await readFeiguaApi({endpoint:FEIGUA_ENDPOINTS.music,params:request('music').params}))
    : captureFeiguaResponse(kind,request(kind),contexts[kind],response())};
  const service=new FeiguaService({userDataPath:'/unused',browser,storage:{read:async()=>structuredClone(disk),write:async next=>{disk=structuredClone(next);}}});
  try {
    await service.start();await service.job;const saved=disk.latestResults.find(group=>group.kind==='music');
    sample=true;await service.start();await service.job;
    assert.equal(disk.runs[0].groups[0].status,'failed');assert.match(disk.runs[0].groups[0].message,/示例数据/);
    assert.equal(disk.runs[0].groups[0].result,undefined);assert.deepEqual(disk.latestResults.find(group=>group.kind==='music'),saved);
  } finally {globalThis.document=oldDocument;}
});

test('browser verifies the actual emitted API request and rejects a response without a new request',async()=>{
  const browser=new FeiguaBrowser({});browser.rankingRequests=[{...request('music'),sequence:1}];browser.requestSequence=1;
  browser.window={webContents:{executeJavaScript:async()=>response()}};
  await assert.rejects(browser.readRanking('music',contexts.music,0),/请求/);
  browser.window.webContents.executeJavaScript=async()=>{browser.rankingRequests.push({...request('music'),sequence:++browser.requestSequence});return response();};
  assert.equal((await browser.readRanking('music',contexts.music,0)).provenance.transport,'provider-api');
  const aborted=new AbortController();aborted.abort();await assert.rejects(browser.readRanking('music',contexts.music,0,aborted.signal),/取消/);
});

test('cancelling a pending API response prevents publication even when it later resolves',async()=>{
  const browser=new FeiguaBrowser({});browser.rankingRequests=[{...request('music'),sequence:1}];browser.requestSequence=1;
  let release;browser.window={webContents:{executeJavaScript:()=>new Promise(resolve=>{release=resolve;})}};
  const controller=new AbortController();const pending=browser.readRanking('music',contexts.music,0,controller.signal);
  controller.abort();await assert.rejects(pending,/取消/);release(response());
});

test('production collection has no DOM-row or screenshot fallback',async()=>{
  const source=await readFile(new URL('../electron/feigua-browser.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/execute\(['"]capture['"]|capturePage|screenshot|OCR/);
  assert.match(source,/readFeiguaApi\.toString/);
});

test('temporary service responses are retryable but authentication and rate-limit responses are terminal',()=>{
  for(const code of [500,502,503,504])assert.throws(()=>captureFeiguaResponse('music',request('music'),contexts.music,{code}),error=>error.code==='FEIGUA_NETWORK');
  assert.throws(()=>captureFeiguaResponse('music',request('music'),contexts.music,{code:401}),error=>error.code==='FEIGUA_AUTH_REQUIRED');
  assert.throws(()=>captureFeiguaResponse('music',request('music'),contexts.music,{code:429}),error=>error.code==='FEIGUA_RATE_LIMIT');
});

test('transport failures preserve error class without exporting raw request or credential details',async()=>{
  const old=globalThis.document;
  try{
    for(const [failure,expected] of [[{response:{status:401}},'FEIGUA_AUTH_REQUIRED'],[{response:{status:403}},'FEIGUA_PERMISSION'],[{response:{status:429}},'FEIGUA_RATE_LIMIT'],[{response:{status:503}},'FEIGUA_NETWORK'],[{code:'ERR_NETWORK'},'FEIGUA_NETWORK'],[{message:'Failed to fetch'},'FEIGUA_NETWORK'],[{},'FEIGUA_API_INVALID']]){
      const model={url:FEIGUA_ENDPOINTS.music,GET:async()=>{throw {message:'private-transport-detail',...failure,config:{authorization:'private-token'}};}};
      globalThis.document={querySelector:()=>({__vue__:{$api:{music:{list:model}}}})};
      const result=await readFeiguaApi({endpoint:FEIGUA_ENDPOINTS.music,params:request('music').params});
      assert.equal(result.errorCode,expected);assert.doesNotMatch(JSON.stringify(result),/private-transport-detail|private-token/);
    }
  }finally{globalThis.document=old;}
});
