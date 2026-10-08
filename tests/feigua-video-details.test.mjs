import test from 'node:test';
import assert from 'node:assert/strict';
import { VIDEO_DETAIL_ENDPOINTS, videoPublishedDate, observeVideoDetailRequest, readVideoDetailsApi, enrichVideoRow } from '../electron/feigua-video-details.mjs';
import { validateCapture, FEIGUA_SOURCES } from '../electron/feigua-contract.mjs';
import { feiguaVideoLink, feiguaProductLink, feiguaAuthorLink } from '../electron/feigua-links.mjs';
import { FeiguaBrowser } from '../electron/feigua-browser.mjs';

const origin='https://dy.feigua.cn',id='synthetic-video',dateCode='20261002';
const row={id,url:`${origin}/app/#/synthetic/detail`,title:'合成视频',author:'合成达人',followers:'100',plays:null,likes:'166',comments:'0',shares:'2',collects:'3',sales:'10w~25w',salesCount:'2500-5000',publishedAt:'2026/10/02 12:11',products:[{id:'synthetic-goods',title:'合成商品',commission:null}],productCount:1};
const detail={state:'verified',videoId:id,dateCode,playsCount:0,playsText:null,products:[{id:'synthetic-goods',title:'合成商品',commission:'0.00%',hasCommission:false}]};

test('author links use public profile identities and discard transport parameters', () => {
  const profile = 'https://www.douyin.com/user/MS4wLjABAAAA_synthetic-author';
  assert.equal(feiguaAuthorLink(profile + '/?token=synthetic-secret#tracking'), profile);
  assert.equal(feiguaAuthorLink(null, '700000000001'), 'https://www.iesdouyin.com/share/user/700000000001');
  assert.equal(feiguaAuthorLink(null, 700000000001), 'https://www.iesdouyin.com/share/user/700000000001');
  assert.equal(feiguaAuthorLink('https://www.iesdouyin.com/share/user/700000000002', '700000000001'), 'https://www.iesdouyin.com/share/user/700000000001');
  for (const candidate of [profile.replace('https:', 'http:'), profile.replace('www.douyin.com', 'www.douyin.com.evil.example'), profile.replace('www.douyin.com', 'user:pass@www.douyin.com'), profile.replace('www.douyin.com', 'www.douyin.com:8443'), 'javascript:alert(1)', 'https://www.douyin.com/user/self', 'https://www.douyin.com/user/700000000001', 'https://dy.feigua.cn/app/#/blogger-detail/index']) assert.equal(feiguaAuthorLink(candidate), null);
  for (const invalid of ['合成达人', 'synthetic-blogger-id', '123', Number.MAX_SAFE_INTEGER + 1, {}, null]) assert.equal(feiguaAuthorLink(null, invalid), null);
});

test('detail authors must match the listed author uniquely and survive durable validation', () => {
  const authors = [{ name: row.author, uid: '700000000001', url: null }];
  const enriched = enrichVideoRow(row, { ...detail, authors });
  const clean = validateCapture('videos', '合成词', {url:`${origin}/app/#/synthetic/list`, keyword:'合成词', period:'近7天', sort:FEIGUA_SOURCES.videos.sort, direction:'desc', filtersVerified:true, categoryPath:[], tagPath:[], dateRange:'2026-10-01 - 2026-10-07', rows:[enriched]}).rows[0];
  assert.equal(clean.authorUrl, 'https://www.iesdouyin.com/share/user/700000000001');
  for (const changed of [{ videoId: 'another-video' }, { dateCode: '20261003' }, { authors: [{ ...authors[0], name: '其他作者' }] }, { authors: [...authors, { ...authors[0], uid: '700000000002' }] }]) assert.ok(!enrichVideoRow(row, { ...detail, authors, ...changed }).authorUrl);
  assert.equal(enrichVideoRow({...row, authorUrl:clean.authorUrl}, {state:'restricted'}).authorUrl, clean.authorUrl);
  assert.equal(enrichVideoRow({...row, authorUrl:clean.authorUrl}, {...detail, authors:[]}).authorUrl, clean.authorUrl);
});

test('public video links require matching source identity and drop tracking or signed parameters', () => {
  const videoId = '7000000000000000001';
  assert.equal(feiguaVideoLink(`https://www.douyin.com/share/video/${videoId}/?mid=7000000000000000002&sign=synthetic-secret`, videoId), `https://www.douyin.com/video/${videoId}`);
  for (const url of [`https://www.douyin.com/video/7000000000000000002`, `https://www.douyin.com.evil.example/video/${videoId}`, `https://user:pass@www.douyin.com/video/${videoId}`, `javascript:alert(1)`, `https://www.douyin.com/redirect?url=evil`, `https://www.douyin.com:8443/video/${videoId}`]) assert.equal(feiguaVideoLink(url, videoId), null);
});

test('public product links allow only the verified destination and unambiguous product parameters', () => {
  const url = 'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=3000000000000000001&origin_type=604';
  assert.equal(feiguaProductLink(url), url);
  for (const candidate of [url + '&id=3000000000000000002', url + '&redirect=https://evil.example', url + '#redirect', url.replace('https:', 'http:'), url.replace('haohuo.jinritemai.com','evil.example'), url.replace('?id=', '?token=')]) assert.equal(feiguaProductLink(candidate), null);
  assert.equal(feiguaProductLink(undefined), null);
});

test('verified detail links survive durable capture but mismatched product or video identity cannot assign links', () => {
  const videoId = '7000000000000000001';
  const videoUrl = `https://www.douyin.com/video/${videoId}`;
  const productUrl = 'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=3000000000000000001';
  const sourceRow = { ...row, id: videoId };
  const sourceDetail = { ...detail, videoId, videoUrl, products: [{ ...detail.products[0], url: productUrl }] };
  const enriched = enrichVideoRow(sourceRow, sourceDetail);
  const clean = validateCapture('videos','合成词',{url:`${origin}/app/#/synthetic/list`,keyword:'合成词',period:'近7天',sort:FEIGUA_SOURCES.videos.sort,direction:'desc',filtersVerified:true,categoryPath:[],tagPath:[],dateRange:'2026-10-01 - 2026-10-07',rows:[enriched]}).rows[0];
  assert.equal(clean.videoUrl, videoUrl); assert.equal(clean.products[0].url, productUrl);
  assert.equal(enrichVideoRow(sourceRow, { ...sourceDetail, videoId: 'wrong' }).videoUrl, undefined);
  assert.equal(enrichVideoRow(sourceRow, { ...sourceDetail, products: [{ ...sourceDetail.products[0], id: 'wrong' }] }).products[0].url, undefined);
});

test('already verified links and commission avoid extra detail navigation even when plays are absent', async () => {
  const browser = new FeiguaBrowser({});
  browser.navigate = async () => { throw new Error('unexpected detail lookup'); };
  const capture = { rows: [{ ...row, authorUrl: 'https://www.iesdouyin.com/share/user/700000000001', videoUrl: 'https://www.douyin.com/video/7000000000000000001', products: [{...row.products[0],commission:'0.00%',url:'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=3000000000000000001'}] }] };
  let progress = 0; browser.onVideoDetailProgress = () => { progress++; };
  await browser.enrichVideoFields(capture);
  assert.equal(progress, 0);
});

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

test('detail API exports only public author fields from the verified video response', async () => {
  await withPage({main:{Code:200,Status:true,Data:{AwemeId:id,DateCode:dateCode,BloggerCreators:[{BloggerName:row.author,BloggerUid:'700000000001',DouyinBloggerUrl:null,Token:'synthetic-secret'}]}}}, async () => {
    const result = await readVideoDetailsApi({videoId:id,dateCode});
    assert.deepEqual(result.authors, [{name:row.author,uid:'700000000001',url:null}]);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|Token/);
  });
});

test('missing author links trigger existing detail enrichment despite complete video and products', async () => {
  const browser = new FeiguaBrowser({}); let navigations = 0;
  browser.navigate = async () => { navigations++; throw new Error('synthetic lookup failure'); };
  const capture = {url:`${origin}/app/#/synthetic/list`, rows:[{...row, videoUrl:'https://www.douyin.com/video/7000000000000000001', products:[{...row.products[0],commission:'0.00%',url:'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=3000000000000000001'}]}]};
  await browser.enrichVideoFields(capture);
  assert.equal(navigations, 1);
  assert.equal(capture.rows[0].author, row.author);
  assert.equal(capture.rows[0].products[0].commission, '0.00%');
  assert.ok(!capture.rows[0].authorUrl);
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
