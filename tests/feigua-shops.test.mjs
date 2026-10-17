import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeShops, currentShopWeek, validateShopWeek, parseShopMetrics, validateShopSnapshot, retainShopWeeks, SHOP_METRICS } from '../electron/feigua-shop-contract.mjs';
import { observeShopRequest, SHOP_ENDPOINTS, readShopApi } from '../electron/feigua-shop-api.mjs';
import { FeiguaShopCollector } from '../electron/feigua-shop-collector.mjs';
import { FeiguaShopService } from '../electron/feigua-shop-service.mjs';

const now = Date.parse('2026-10-16T00:00:00Z');
const week = { start: '2026-10-12', end: '2026-10-15' };
const shop = { id: 'synthetic-shop', name: '合成店铺' };
const metrics = () => Object.fromEntries(Object.values(SHOP_METRICS).map(k => [k, '0']));
const parts = () => ({ overview: { ...metrics(), SalesGmvStr: '100w-250w', SalesCountStr: '1w-2.5w' },
  days: [12, 13, 14, 15].map(d => ({ DateCode: 20261000 + d, ...metrics() })), events: [], eventTotal: 0, newGoods: [],
  trend: [12, 13, 14, 15].map(d => ({ date: 20261000 + d, count: '0' })) });
const snapshot = (target = shop, period = week) => ({ ...validateShopSnapshot(target, week, parts(), now), weekStart: period.start, through: period.end });
const flush = async () => { for (let n = 0; n < 8; n++) await new Promise(r => setImmediate(r)); };

test('shop settings allow ten unique identities, including duplicate names, but reject unsafe inputs', () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({ id: `shop-${i}`, name: '同名店铺' }));
  assert.equal(normalizeShops(ten).length, 10);
  for (const input of [[...ten, { id: 'another', name: '多余' }], [shop, shop], [{ id: '../secret', name: '店铺' }], [{ id: 'shop', name: '\n' }], [{ id: 'shop', name: 'a'.repeat(101) }]]) assert.throws(() => normalizeShops(input));
});
test('weekly range uses Beijing Monday through yesterday and never invents a Monday day', () => {
  assert.deepEqual(currentShopWeek(now), week);
  assert.equal(currentShopWeek(Date.parse('2026-10-11T16:00:00Z')), null);
  assert.deepEqual(currentShopWeek(Date.parse('2026-10-12T16:00:00Z')), { start: '2026-10-12', end: '2026-10-12' });
  assert.deepEqual(currentShopWeek(Date.parse('2026-10-11T15:59:59Z')), { start: '2026-10-05', end: '2026-10-10' });
  for (const bad of [{ start: '2026-10-13', end: '2026-10-15' }, { start: '2026-10-12', end: '2026-10-16' }, { start: '2026-02-30', end: '2026-03-01' }]) assert.throws(() => validateShopWeek(bad, now));
});
test('metric ranges and real zeroes remain source text while masks and missing values cannot become zero', () => {
  for (const text of ['0', '1000w+', '1w-2.5w', '5,000', '0-250']) assert.equal(parseShopMetrics({ SalesGmvStr: text }).sales, text);
  for (const text of [undefined, null, '--', '-']) assert.equal(parseShopMetrics({ SalesGmvStr: text }).sales, null);
  assert.throws(() => parseShopMetrics({ SalesGmvStr: '会员权限不足' }));
});
test('a weekly snapshot requires every settled day and matching event dates without summing sales ranges', () => {
  const source = parts(); const saved = validateShopSnapshot(shop, week, source, now);
  assert.equal(saved.metrics.sales, '100w-250w'); assert.equal(saved.days.length, 4); assert.equal(saved.days[0].date, '2026-10-15');
  for (const change of [p => p.days.pop(), p => { p.days[1].DateCode = p.days[0].DateCode; }, p => { p.eventTotal = 1; }, p => { p.events = [{ date: 20261011, kind: 'new-creator', changes: [] }]; p.eventTotal = 1; }]) {
    const bad = parts(); change(bad); assert.throws(() => validateShopSnapshot(shop, week, bad, now));
  }
});
test('weekly history replaces only the same shop/week and retains fifty-two weeks independently', () => {
  const other = snapshot({ id: 'other', name: '另一店铺' });
  const old = Array.from({ length: 55 }, (_, i) => ({ ...snapshot(), weekStart: new Date(Date.UTC(2025, 0, 6 + i * 7)).toISOString().slice(0, 10) }));
  const result = retainShopWeeks([other, ...old], snapshot());
  assert.equal(result.filter(r => r.shop.id === shop.id).length, 52); assert.ok(result.includes(other));
  assert.equal(retainShopWeeks(result, snapshot()).filter(r => r.shop.id === shop.id && r.weekStart === week.start).length, 1);
});
test('only observed shop endpoints export allowlisted parameters, never transport credentials', () => {
  const origin = 'https://dy.feigua.cn';
  const body = { period: 30, sort: 0, keyword: '合成', page: 1, pageSize: 10, pageType: 1 };
  const details = { method: 'POST', url: origin + SHOP_ENDPOINTS.search, uploadData: [{ bytes: Buffer.from(JSON.stringify(body)) }] };
  assert.deepEqual(observeShopRequest(details, origin), { kind: 'search', params: Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)])) });
  assert.equal(observeShopRequest({ ...details, method: 'GET' }, origin), null);
  assert.equal(observeShopRequest({ ...details, url: origin + '/api/v1/focus/shop/add' }, origin), null);
  assert.equal(observeShopRequest(details, 'https://other.example'), null);
  assert.equal(observeShopRequest({ ...details, uploadData: [{ bytes: Buffer.from(JSON.stringify({ ...body, token: 'synthetic-secret' })) }] }, origin), null);
  assert.equal(observeShopRequest({ method: 'GET', url: `${origin}${SHOP_ENDPOINTS.days}?shopId=a&shopId=b` }, origin), null);
});
test('page API exports only shop identity and displayed values, excluding signed routes and exact raw metrics', async () => {
  const old = globalThis.document;
  const responses = { search: { Total: 1, ShopDatas: [{ ShopId: shop.id, ShopName: shop.name, DetailUrl: 'synthetic-secret' }] },
    overview: { ...metrics(), SalesGmv: 123456, Token: 'synthetic-secret' } };
  const models = Object.fromEntries(Object.entries(SHOP_ENDPOINTS).map(([kind, url]) => [kind, { url,
    GET: async () => ({ Code: 200, Status: true, Data: responses[kind] }), POST: async () => ({ Code: 200, Status: true, Data: responses[kind] }) }]));
  globalThis.document = { querySelector: () => ({ __vue__: { $api: { shops: models } } }) };
  try {
    const search = await readShopApi({ kind: 'search', params: {} }); assert.deepEqual(search.data.rows, [shop]);
    const overview = await readShopApi({ kind: 'overview', params: {} });
    assert.doesNotMatch(JSON.stringify([search, overview]), /synthetic-secret|123456|DetailUrl/);
    assert.equal((await readShopApi({ kind: 'add', params: {} })).code, 0);
  } finally { globalThis.document = old; }
});

test('collector requires a fresh request for the exact shop, dates and pagination before publishing', async () => {
  let emit = true, mismatch = false;
  const browser = { requestSequence: 0, shopRequests: [], isProviderUrl: () => true };
  browser.window = { isDestroyed: () => false, webContents: { getURL: () => 'https://dy.feigua.cn/app/', executeJavaScript: async () => {
    if (emit) browser.shopRequests.push({ kind: 'overview', params: { shopId: mismatch ? 'wrong' : shop.id }, sequence: ++browser.requestSequence });
    return { code: 200, success: true, data: metrics() };
  } } };
  const collector = new FeiguaShopCollector(browser);
  assert.ok(await collector.request('overview', { shopId: shop.id }));
  emit = false; await assert.rejects(collector.request('overview', { shopId: shop.id }), /真实请求/);
  emit = true; mismatch = true; await assert.rejects(collector.request('overview', { shopId: shop.id }), /真实请求/);
});
test('authentication, quota, permissions, rate limits and sample data never become successful shop data', async () => {
  let response;
  const browser = { requestSequence: 0, shopRequests: [], isProviderUrl: () => true };
  browser.window = { isDestroyed: () => false, webContents: { getURL: () => 'https://dy.feigua.cn/app/', executeJavaScript: async () => {
    browser.shopRequests.push({ kind: 'overview', params: { shopId: shop.id }, sequence: ++browser.requestSequence }); return response;
  } } };
  const collector = new FeiguaShopCollector(browser);
  for (const [value, code] of [
    [{ code: 401 }, 'FEIGUA_AUTH_REQUIRED'], [{ code: 403, quota: true }, 'FEIGUA_QUOTA'],
    [{ code: 403 }, 'FEIGUA_PERMISSION'], [{ code: 429 }, 'FEIGUA_RATE_LIMIT'],
    [{ code: 200, success: true, example: true, data: metrics() }, 'FEIGUA_SHOP_INVALID'],
  ]) { response = value; await assert.rejects(collector.request('overview', { shopId: shop.id }), { code }); }
  const request = { method: 'GET', url: `http://192.0.2.10:13042${SHOP_ENDPOINTS.overview}?shopId=synthetic-shop` };
  assert.ok(observeShopRequest(request, 'http://192.0.2.10:13042'));
  assert.equal(observeShopRequest(request, 'https://dy.feigua.cn'), null);
});
test('complete dynamic pagination is required and a mismatching shop product cannot be published', async () => {
  const collector = new FeiguaShopCollector({}); collector.search = async () => [shop];
  collector.ensureFollowed = async () => {};
  collector.checkReady = async () => {};
  const row = { date: 20261015, productId: 'goods', product: '合成商品', changes: [{ type: 10 }] };
  let incomplete = false, wrongShop = false, duplicate = false;
  collector.request = async (kind, params) => {
    const p = parts();
    if (kind === 'overview') return p.overview;
    if (kind === 'days') return { total: 4, rows: p.days };
    if (kind === 'stat') return metrics();
    if (kind === 'tops') return wrongShop ? [{ id: 'goods', title: '合成商品', shopId: 'wrong' }] : [];
    if (kind === 'trend') return p.trend;
    if (kind === 'options') return { subtypes: [] };
    return { total: 12, rows: params.page === 1 ? Array.from({ length: 10 }, (_, i) => ({ ...row, productId: `goods-${i}` })) : incomplete ? [] : duplicate ? [{ ...row, productId: 'goods-0' }, row] : [{ ...row, productId: 'goods-10' }, { ...row, productId: 'goods-11' }] };
  };
  assert.equal((await collector.collect(shop, week)).events.length, 12);
  incomplete = true; await assert.rejects(collector.collect(shop, week), /分页/);
  incomplete = false; duplicate = true; await assert.rejects(collector.collect(shop, week), /重复/);
  wrongShop = true; await assert.rejects(collector.collect(shop, week), /不属于/);
});

function fixture({ stored, collect, search, unfollow, write, auth = { status: 'authenticated' }, time = now } = {}) {
  let disk = structuredClone(stored || { version: 1, shops: [shop], snapshots: [], lastRun: null, lastScheduledDate: null }), calls = 0, authCalls = 0, unfollows = 0;
  const gateway = { controller: null, operation: null, browser: { checkLogin: async () => { authCalls++; return auth; }, stop() {} },
    exclusive: async action => { if (gateway.controller || gateway.operation) throw new Error('busy'); gateway.operation = Promise.resolve().then(action); try { return await gateway.operation; } finally { gateway.operation = null; } } };
  const service = new FeiguaShopService({ userDataPath: '/unused', gateway, now: () => time,
    collector: { search: async (...args) => search ? search(...args) : [shop], collect: async (...args) => { calls++; return collect ? collect(...args) : snapshot(args[0], args[1]); }, unfollow: async (...args) => { unfollows++; return unfollow ? unfollow(...args) : { remaining: 9 }; } },
    storage: { read: async () => structuredClone(disk), write: async data => { await write?.(data); disk = structuredClone(data); } } });
  return { service, gateway, disk: () => disk, calls: () => calls, authCalls: () => authCalls, unfollows: () => unfollows };
}
test('settings enforce the limit before writing and removal preserves all saved weeks', async () => {
  const saved = snapshot(), f = fixture({ stored: { version: 1, shops: [shop], snapshots: [saved] } });
  await assert.rejects(f.service.save(Array.from({ length: 11 }, (_, i) => ({ id: `s-${i}`, name: '店' }))), /10/);
  await f.service.remove(shop.id); assert.deepEqual(f.disk().snapshots, [saved]); assert.equal(f.calls(), 0);
});
test('results are published only after durable writing and a failed refresh preserves prior data', async () => {
  const old = snapshot(); old.metrics.sales = '上次来源值';
  const f = fixture({ stored: { version: 1, shops: [shop], snapshots: [old] }, write: async data => { if (data.snapshots[0]?.metrics.sales === '100w-250w') throw new Error('disk unavailable'); } });
  await f.service.start(); await f.service.job;
  assert.equal(f.disk().snapshots[0].metrics.sales, '上次来源值');
  assert.equal((await f.service.state()).snapshots[0].metrics.sales, '上次来源值');
});
test('one shop permission failure preserves its old week while other shops can complete', async () => {
  const other = { id: 'other', name: '另一店' };
  const f = fixture({ stored: { version: 1, shops: [shop, other], snapshots: [snapshot()] }, collect: async target => {
    if (target.id === shop.id) throw Object.assign(new Error('请关注并确认权限'), { publicMessage: '请关注并确认权限', code: 'FEIGUA_PERMISSION' });
    return snapshot(target);
  } });
  await f.service.start(); await f.service.job;
  const state = await f.service.state(); assert.equal(state.lastRun.status, 'partial'); assert.equal(state.snapshots.length, 2); assert.match(state.lastRun.shops[0].message, /权限/);
});
test('expired login prevents all source collection and existing snapshots remain available', async () => {
  const f = fixture({ auth: { status: 'expired', message: '请重新登录' } });
  await f.service.start(); await f.service.job;
  assert.equal(f.calls(), 0); assert.equal((await f.service.state()).lastRun.status, 'failed');
});
test('cancellation during the initial save prevents all later provider I/O', async () => {
  let entered, release; const writing = new Promise(r => { entered = r; }); const gate = new Promise(r => { release = r; }); let first = true;
  const f = fixture({ write: async () => { if (first) { first = false; entered(); await gate; } } });
  const starting = f.service.start(); await writing; await f.service.cancel(); release(); await starting; await f.service.job;
  assert.equal(f.authCalls(), 0); assert.equal(f.calls(), 0); assert.equal(f.disk().lastRun.status, 'cancelled');
});
test('cancellation of an in-flight shop never publishes its late result or starts the next shop', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const f = fixture({ collect: async target => { await gate; return snapshot(target); } });
  await f.service.start(); await flush(); await f.service.cancel(); release(); await f.service.job;
  assert.equal(f.disk().snapshots.length, 0); assert.equal(f.disk().lastRun.status, 'cancelled');
});
test('daily monitoring starts after Beijing 07:00, records intent first and deduplicates across restart', async () => {
  const f = fixture();
  await f.service.checkSchedule(Date.parse('2026-10-15T22:59:00Z'), () => true); assert.equal(f.calls(), 0);
  await f.service.checkSchedule(Date.parse('2026-10-15T23:00:00Z'), () => true); await f.service.job; assert.equal(f.calls(), 1);
  const resumed = fixture({ stored: f.disk() }); await resumed.service.checkSchedule(now, () => true); assert.equal(resumed.calls(), 0);
  assert.equal(f.disk().lastScheduledDate, '2026-10-16');
});
test('a successful manual update satisfies the daily scheduler without repeating provider reads', async () => {
  const f = fixture(); await f.service.start(); await f.service.job;
  assert.equal(f.calls(), 1);
  await f.service.checkSchedule(now, () => true);
  assert.equal(f.calls(), 1); assert.equal(f.disk().lastScheduledDate, '2026-10-16');
});
test('damaged shop history fails without rewriting the existing file', async () => {
  const stored = { version: 1, shops: [shop], snapshots: [{ shop }] };
  const f = fixture({ stored }); await assert.rejects(f.service.state(), /损坏/); assert.deepEqual(f.disk(), stored);
});
test('failed schedule persistence, a busy gateway, disabled license and Monday prevent source I/O', async () => {
  const f = fixture({ write: async () => { throw new Error('disk'); } });
  await assert.rejects(f.service.checkSchedule(now, () => true)); assert.equal(f.authCalls(), 0);
  const busy = fixture(); busy.gateway.operation = Promise.resolve(); await busy.service.checkSchedule(now, () => true); assert.equal(busy.calls(), 0);
  const disabled = fixture(); await disabled.service.checkSchedule(now, () => false); assert.equal(disabled.calls(), 0);
  const monday = fixture({ time: Date.parse('2026-10-12T00:00:00Z') }); await assert.rejects(monday.service.start(), /尚无/); assert.equal(monday.calls(), 0);
});
test('restart marks interrupted monitoring without reissuing requests and disposal prevents new work', async () => {
  const f = fixture({ stored: { version: 1, shops: [shop], snapshots: [], lastRun: { status: 'running', shops: [] } } });
  assert.equal((await f.service.state()).lastRun.status, 'interrupted'); assert.equal(f.calls(), 0);
  f.service.dispose(); await assert.rejects(f.service.start());
});

function registration({ followed = false, remaining = 1, confirm = true, failAfterWrite = false } = {}) {
  const collector = new FeiguaShopCollector({}); const calls = [];
  collector.request = async (kind, params) => {
    calls.push({ kind, params });
    if (kind === 'focusList') return { total: followed ? 1 : 0, rows: followed ? [{ ...shop, focusId: 123 }] : [] };
    if (kind === 'focusCount') return { remaining };
    assert.equal(kind, 'follow'); assert.deepEqual(params, { groupId: 0, shopId: shop.id });
    followed = confirm;
    if (failAfterWrite) throw Object.assign(new Error('uncertain write'), { code: 'FEIGUA_NETWORK' });
    return { focusId: 123 };
  };
  return { collector, calls };
}

test('manual collection registers a missing shop once, confirms membership, and never follows an existing shop again', async () => {
  const f = registration();
  await f.collector.ensureFollowed(shop, week, undefined, () => {}, true);
  assert.deepEqual(f.calls.map(c => c.kind), ['focusList', 'focusCount', 'follow', 'focusList']);
  await f.collector.ensureFollowed(shop, week, undefined, () => {}, true);
  assert.equal(f.calls.filter(c => c.kind === 'follow').length, 1);
  const existing = registration({ followed: true, remaining: 0 });
  await existing.collector.ensureFollowed(shop, week, undefined, () => {}, true);
  assert.deepEqual(existing.calls.map(c => c.kind), ['focusList']);
});

test('full or unknown capacity and background updates cannot create source follows', async () => {
  for (const remaining of [0, -1, null, '1', NaN]) {
    const f = registration({ remaining });
    await assert.rejects(f.collector.ensureFollowed(shop, week, undefined, () => {}, true), /名额/);
    assert.ok(!f.calls.some(c => c.kind === 'follow'));
  }
  const background = registration();
  await assert.rejects(background.collector.ensureFollowed(shop, week, undefined, () => {}, false), { code: 'FEIGUA_SHOP_NOT_FOLLOWED' });
  assert.deepEqual(background.calls.map(c => c.kind), ['focusList']);
});

test('a successful response without membership readback cannot unlock collection', async () => {
  const f = registration({ confirm: false });
  await assert.rejects(f.collector.ensureFollowed(shop, week, undefined, () => {}, true), /尚未确认/);
  assert.equal(f.calls.filter(c => c.kind === 'follow').length, 1);
});

test('an uncertain follow write is not retried; the next manual run reads membership before any second write', async () => {
  const f = registration({ failAfterWrite: true });
  await assert.rejects(f.collector.ensureFollowed(shop, week, undefined, () => {}, true), { code: 'FEIGUA_NETWORK' });
  assert.equal(f.calls.filter(c => c.kind === 'follow').length, 1);
  await f.collector.ensureFollowed(shop, week, undefined, () => {}, true);
  assert.equal(f.calls.filter(c => c.kind === 'follow').length, 1);
});

test('cancellation before a follow prevents the write and cancellation after it prevents later reads', async () => {
  for (const phase of ['focusCount', 'follow']) {
    const controller = new AbortController(), f = registration(); const request = f.collector.request.bind(f.collector);
    f.collector.request = async (...args) => { const result = await request(...args); if (args[0] === phase) controller.abort(); return result; };
    await assert.rejects(f.collector.ensureFollowed(shop, week, controller.signal, () => {}, true), { code: 'FEIGUA_CANCELLED' });
    assert.equal(f.calls.filter(c => c.kind === 'follow').length, phase === 'focusCount' ? 0 : 1);
    assert.equal(f.calls.at(-1).kind, phase);
  }
});

test('focus membership requires complete, stable pagination before concluding that a shop is missing', async () => {
  const f = registration(); const first = Array.from({ length: 10 }, (_, i) => ({ id: `another-${i}`, name: '合成其他店铺' }));
  let mode = 'complete';
  f.collector.request = async (kind, p) => {
    assert.equal(kind, 'focusList');
    return p.pageIndex === 1 ? { total: 11, rows: first } : mode === 'complete' ? { total: 11, rows: [{ ...shop, focusId: 123 }] } : mode === 'duplicate' ? { total: 11, rows: [first[0]] } : mode === 'changed' ? { total: 12, rows: [shop] } : { total: 11, rows: [] };
  };
  assert.equal(await f.collector.isFollowed(shop, week), true);
  for (mode of ['duplicate', 'changed', 'missing']) await assert.rejects(f.collector.isFollowed(shop, week), /关注列表/);
});

test('shop identity and settled dates must be valid before any registration call', async () => {
  const collector = new FeiguaShopCollector({}); let reads = 0;
  collector.search = async () => { reads++; return [{ ...shop, id: 'different-shop' }]; };
  collector.ensureFollowed = async () => assert.fail('unconfirmed shop must not be followed');
  await assert.rejects(collector.collect(shop, week), /身份/);
  await assert.rejects(collector.collect({ ...shop, id: '../unsafe' }, week));
  await assert.rejects(collector.collect(shop, { start: week.start, end: '2099-10-17' }));
  assert.equal(reads, 1);
});

test('follow observation accepts only the observed default-group POST and rejects arbitrary writes', () => {
  const details = params => ({ method: 'POST', url: 'https://dy.feigua.cn' + SHOP_ENDPOINTS.follow, uploadData: [{ bytes: Buffer.from(JSON.stringify(params)) }] });
  assert.deepEqual(observeShopRequest(details({ groupId: 0, shopId: shop.id }), 'https://dy.feigua.cn'), { kind: 'follow', params: { groupId: '0', shopId: shop.id } });
  for (const p of [{ groupId: 1, shopId: shop.id }, { groupId: 0, shopId: '../unsafe' }, { groupId: 0, shopId: shop.id, token: 'synthetic-secret' }]) assert.equal(observeShopRequest(details(p), 'https://dy.feigua.cn'), null);
  assert.equal(observeShopRequest({ ...details({ groupId: 0, shopId: shop.id }), method: 'GET' }, 'https://dy.feigua.cn'), null);
  assert.equal(observeShopRequest({ ...details({ groupId: 0, shopId: shop.id }), url: 'https://dy.feigua.cn/api/v1/focus/shop/delete' }, 'https://dy.feigua.cn'), null);
});

test('provider registration uses the exact UI body and returns no unrelated provider fields', async () => {
  const old = globalThis.document, calls = [];
  const responses = { follow: 123, focusList: { TotalCount: 1, Items: [{ ShopId: shop.id, ShopName: shop.name, FocusId: 123, IsDemo: false, SalesGmv: 123456, Token: 'synthetic-secret' }] }, focusCount: { SurplusCount: 2, Token: 'synthetic-secret' }, focusInfo: { ShopId: shop.id, DynamicDataFetchFinish: false, Token: 'synthetic-secret' } };
  const models = Object.fromEntries(Object.entries(SHOP_ENDPOINTS).map(([kind, url]) => [kind, { url, GET: async args => { calls.push({ kind, args }); return { Code: 200, Status: true, Data: responses[kind] }; }, POST: async args => { calls.push({ kind, args }); return { Code: 200, Status: true, Data: responses[kind] }; } }]));
  globalThis.document = { querySelector: () => ({ __vue__: { $api: { shops: models } } }) };
  try {
    for (const p of [{ groupId: 1, shopId: shop.id }, { groupId: 0, shopId: 'bad/id' }, { groupId: 0, shopId: shop.id, extra: 1 }]) assert.equal((await readShopApi({ kind: 'follow', params: p })).code, 0);
    assert.equal(calls.length, 0);
    assert.deepEqual((await readShopApi({ kind: 'follow', params: { groupId: 0, shopId: shop.id } })).data, { focusId: 123 });
    assert.deepEqual(calls[0], { kind: 'follow', args: { data: { groupId: 0, shopId: shop.id } } });
    const list = await readShopApi({ kind: 'focusList', params: {} });
    assert.deepEqual(list.data, { total: 1, rows: [{ ...shop, focusId: 123 }] }); assert.equal(list.example, false);
    assert.deepEqual((await readShopApi({ kind: 'focusCount', params: {} })).data, { remaining: 2 });
    assert.deepEqual((await readShopApi({ kind: 'focusInfo', params: { focusId: 123 } })).data, { shopId: shop.id, ready: false });
    assert.doesNotMatch(JSON.stringify(list), /synthetic-secret|123456|Token|SalesGmv/);
    responses.focusList.Items[0].IsDemo = true;
    assert.equal((await readShopApi({ kind: 'focusList', params: {} })).example, true);
  } finally { globalThis.document = old; }
});

test('manual starts may register confirmed stores while daily background jobs only read existing follows', async () => {
  const modes = [];
  const collect = async (target, period, _signal, _progress, options) => { modes.push(options.allowFollow); return snapshot(target, period); };
  const manual = fixture({ collect }); await manual.service.start(); await manual.service.job;
  const daily = fixture({ collect }); await daily.service.checkSchedule(now, () => true); await daily.service.job;
  assert.deepEqual(modes, [true, false]);
});

test('preparation checks verify identity but a false preparation flag is advisory', async () => {
  const f = registration({ followed: true }); await f.collector.ensureFollowed(shop, week, undefined, () => {}, true);
  let info = { shopId: shop.id, ready: false };
  f.collector.request = async (kind, params) => { assert.equal(kind, 'focusInfo'); assert.deepEqual(params, { focusId: 123 }); return info; };
  assert.equal(await f.collector.checkReady(shop), false);
  info = { shopId: shop.id, ready: null }; await assert.rejects(f.collector.checkReady(shop), /无法核验/);
  info = { shopId: 'different', ready: true }; await assert.rejects(f.collector.checkReady(shop), /无法核验/);
  info = { shopId: shop.id, ready: true }; assert.equal(await f.collector.checkReady(shop), true);
});

test('background retries probe actual availability without public searches and preserve real permission errors', async () => {
  const f = registration({ followed: true }); let searches = 0, weeklyCalls = 0, ready = false;
  const request = f.collector.request.bind(f.collector);
  f.collector.search = async () => { searches++; assert.fail('must not search before readiness'); };
  f.collector.request = async (kind, params) => {
    if (kind === 'focusInfo') return { shopId: shop.id, ready };
    if (kind === 'overview') { weeklyCalls++; throw Object.assign(new Error('source denied'), { code: 'FEIGUA_PERMISSION' }); }
    return request(kind, params);
  };
  await assert.rejects(f.collector.collect(shop, week, undefined, () => {}, { allowFollow: false }), { code: 'FEIGUA_SHOP_INITIALIZING' });
  assert.equal(searches, 0); assert.deepEqual(f.calls.map(c => c.kind), ['focusList']);
  assert.equal(weeklyCalls, 1);
  ready = true;
  await assert.rejects(f.collector.collect(shop, week, undefined, () => {}, { allowFollow: false }), { code: 'FEIGUA_PERMISSION' });
  assert.equal(searches, 0); assert.equal(weeklyCalls, 2);
});

test('complete weekly data is captured even when the source preparation flag remains false', async () => {
  const collector = new FeiguaShopCollector({}); const p = parts(); p.overview.NewBloggerCountStr = '2';
  const events = [14, 15].map(day => ({ date: 20261000 + day, creatorId: `creator-${day}`, creator: '合成达人', fans: '100', changes: [{ type: 41, title: '合成视频' }] }));
  collector.search = async () => assert.fail('background identity comes from verified membership');
  collector.request = async kind => {
    if (kind === 'focusList') return { total: 1, rows: [{ ...shop, focusId: 123 }] };
    if (kind === 'focusInfo') return { shopId: shop.id, ready: false };
    if (kind === 'overview' || kind === 'stat') return p.overview;
    if (kind === 'days') return { total: 4, rows: p.days };
    if (kind === 'tops') return [];
    if (kind === 'trend') return p.trend;
    if (kind === 'options') return { subtypes: [] };
    assert.equal(kind, 'events'); return { total: 2, rows: events };
  };
  const result = await collector.collect(shop, week, undefined, () => {}, { allowFollow: false });
  assert.equal(result.days.length, 4); assert.equal(result.events.length, 2); assert.equal(result.metrics.newCreators, '2');
});

test('initializing stores persist a waiting queue and retry without a second follow after restart', async () => {
  let ready = false, attempts = 0;
  const collect = async (target, period, _signal, _progress, options) => {
    attempts++;
    if (attempts > 1) assert.equal(options.allowFollow, false);
    if (!ready) throw Object.assign(new Error('初始化中'), { code: 'FEIGUA_SHOP_INITIALIZING', publicMessage: '初始化中' });
    return snapshot(target, period);
  };
  const f = fixture({ collect }); await f.service.start(); await f.service.job;
  assert.equal(f.disk().lastRun.status, 'waiting'); assert.equal(f.disk().snapshots.length, 0);
  assert.equal(f.disk().waitingShops[0].attempts, 1);
  const next = Date.parse(f.disk().waitingShops[0].nextCheckAt);
  const resumed = fixture({ stored: { ...f.disk(), lastScheduledDate: '2026-10-16' }, collect });
  await resumed.service.checkSchedule(next - 1, () => true); assert.equal(attempts, 1);
  await resumed.service.checkSchedule(next, () => true); await resumed.service.job;
  assert.equal(attempts, 2); assert.equal(resumed.disk().waitingShops[0].attempts, 2);
  ready = true;
  await resumed.service.checkSchedule(Date.parse(resumed.disk().waitingShops[0].nextCheckAt), () => true); await resumed.service.job;
  assert.equal(attempts, 3); assert.equal(resumed.disk().lastRun.status, 'completed'); assert.equal(resumed.disk().snapshots.length, 1); assert.deepEqual(resumed.disk().waitingShops, []);
});

test('initialization retries record intent before provider I/O, preserve snapshots and stop after removal', async () => {
  const waitingShops = [{ id: shop.id, attempts: 1, nextCheckAt: new Date(now - 1).toISOString() }];
  const stored = { version: 1, shops: [shop], snapshots: [snapshot()], waitingShops };
  const failed = fixture({ stored, write: async () => { throw new Error('disk failure'); } });
  await assert.rejects(failed.service.checkSchedule(now, () => true), /disk failure/); assert.equal(failed.calls(), 0);
  const f = fixture({ stored }); await f.service.remove(shop.id);
  assert.deepEqual(f.disk().waitingShops, []); assert.equal(f.disk().snapshots.length, 1);
  await f.service.checkSchedule(now, () => true); assert.equal(f.calls(), 0);
});

test('cancel and expired login clear automatic initialization retries instead of repeatedly opening a login window', async () => {
  const waitingShops = [{ id: shop.id, attempts: 1, nextCheckAt: new Date(now - 1).toISOString() }];
  const stored = { version: 1, shops: [shop], snapshots: [], waitingShops };
  const expired = fixture({ stored, auth: { status: 'expired' } });
  await expired.service.checkSchedule(now, () => true); await expired.service.job;
  assert.equal(expired.disk().lastRun.status, 'failed'); assert.deepEqual(expired.disk().waitingShops, []);
  let release; const gate = new Promise(r => { release = r; });
  const cancelled = fixture({ stored, collect: async () => { await gate; return snapshot(); } });
  await cancelled.service.start(); await flush(); await cancelled.service.cancel(); release(); await cancelled.service.job;
  assert.deepEqual(cancelled.disk().waitingShops, []);
});

function removalFixture({ followed = true, removable = true, confirm = true, remaining = 8, released = 9, ready = false, uncertain = false } = {}) {
  const collector = new FeiguaShopCollector({}), calls = [];
  collector.request = async (kind, params) => {
    calls.push({ kind, params });
    if (kind === 'focusList') return { total: followed ? 1 : 0, rows: followed ? [{ ...shop, focusId: 123 }] : [] };
    if (kind === 'focusInfo') return { shopId: shop.id, ready, removable, followedAt: '2026/10/17 09:36:13' };
    if (kind === 'focusCount') return { remaining: followed ? remaining : released };
    assert.equal(kind, 'unfollow'); assert.deepEqual(params, { focusId: 123 });
    if (confirm) followed = false;
    if (uncertain) throw Object.assign(new Error('uncertain outcome'), { code: 'FEIGUA_NETWORK' });
    return { acknowledged: true };
  };
  return { collector, calls };
}

test('sync removal uses the confirmed focus ID and verifies absence plus a released quota slot', async () => {
  const f = removalFixture();
  assert.deepEqual(await f.collector.unfollow(shop, undefined, () => {}, now), { remaining: 9 });
  assert.deepEqual(f.calls.map(x => x.kind), ['focusList', 'focusInfo', 'focusCount', 'unfollow', 'focusList', 'focusCount']);
  assert.equal(f.calls.filter(x => x.kind === 'unfollow').length, 1);
  // Product-data readiness does not prevent a source-authorized removal.
  assert.equal(f.calls[3].params.focusId, 123);
});

test('the source 24-hour restriction and unknown removal eligibility prevent every delete write', async () => {
  for (const removable of [false, undefined, null]) {
    const f = removalFixture({ removable });
    if (removable === undefined) { const request = f.collector.request.bind(f.collector); f.collector.request = async (...args) => { const data = await request(...args); if (args[0] === 'focusInfo') delete data.removable; return data; }; }
    await assert.rejects(f.collector.unfollow(shop), removable === false ? { code: 'FEIGUA_SHOP_REMOVE_LOCKED' } : /移除权限/);
    assert.ok(!f.calls.some(x => x.kind === 'unfollow'));
  }
  const blocked = removalFixture({ removable: false });
  await assert.rejects(blocked.collector.unfollow(shop), /2026-10-18 09:36/);
});

test('absent follows remove idempotently and uncertain writes are read back before any retry', async () => {
  const absent = removalFixture({ followed: false });
  assert.equal((await absent.collector.unfollow(shop)).remaining, 9);
  assert.deepEqual(absent.calls.map(x => x.kind), ['focusList', 'focusCount']);
  const uncertain = removalFixture({ uncertain: true });
  await assert.rejects(uncertain.collector.unfollow(shop), { code: 'FEIGUA_NETWORK' });
  assert.equal((await uncertain.collector.unfollow(shop)).remaining, 9);
  assert.equal(uncertain.calls.filter(x => x.kind === 'unfollow').length, 1);
});

test('an unconfirmed cancellation of attention or unreleased slot is never treated as completed removal', async () => {
  const unconfirmed = removalFixture({ confirm: false }); await assert.rejects(unconfirmed.collector.unfollow(shop), /尚未确认/);
  const quota = removalFixture({ released: 8 }); await assert.rejects(quota.collector.unfollow(shop), /名额尚未确认释放/);
  const unknown = removalFixture({ remaining: null }); await assert.rejects(unknown.collector.unfollow(shop), /关注名额/);
  assert.ok(!unknown.calls.some(x => x.kind === 'unfollow'));
  const mismatch = removalFixture(); const request = mismatch.collector.request.bind(mismatch.collector);
  mismatch.collector.request = async (...args) => { const data = await request(...args); return args[0] === 'focusInfo' ? { ...data, shopId: 'another' } : data; };
  await assert.rejects(mismatch.collector.unfollow(shop), /移除权限/); assert.ok(!mismatch.calls.some(x => x.kind === 'unfollow'));
});

test('sync removal works on Monday and cancel before submitting the write prevents deletion', async () => {
  const monday = removalFixture(); await monday.collector.unfollow(shop, undefined, () => {}, Date.parse('2026-10-12T00:00:00Z'));
  assert.deepEqual(monday.calls[0].params, { beginDateCode: '20260912', endDateCode: '20261011', groupId: 0, shopStatSort: 1, sortDirection: 1, pageIndex: 1, pageSize: 10 });
  const f = removalFixture(), controller = new AbortController(), request = f.collector.request.bind(f.collector);
  f.collector.request = async (...args) => { const data = await request(...args); if (args[0] === 'focusCount') controller.abort(); return data; };
  await assert.rejects(f.collector.unfollow(shop, controller.signal), { code: 'FEIGUA_CANCELLED' });
  assert.ok(!f.calls.some(x => x.kind === 'unfollow'));
});

test('local removal requires successful provider synchronization and preserves history and other monitors', async () => {
  const other = { id: 'other', name: '其他店铺' }, historical = snapshot();
  const waitingShops = [{ id: shop.id, attempts: 1, nextCheckAt: new Date(now).toISOString() }];
  const f = fixture({ stored: { version: 1, shops: [shop, other], snapshots: [historical], waitingShops } });
  await assert.rejects(f.service.save([other]), /同步移除/); assert.equal(f.unfollows(), 0);
  const result = await f.service.remove(shop.id);
  assert.equal(result.busy, false); assert.match(result.notice, /剩余 9/);
  assert.deepEqual(f.disk().shops, [other]); assert.deepEqual(f.disk().snapshots, [historical]); assert.deepEqual(f.disk().waitingShops, []);
  await assert.rejects(f.service.remove('not-configured'), /不在当前监控/); assert.equal(f.unfollows(), 1);
});

test('source rejection, expired login and local save failure all retain the local monitor and history', async () => {
  const stored = { version: 1, shops: [shop], snapshots: [snapshot()] };
  const blocked = fixture({ stored, unfollow: async () => { throw Object.assign(new Error('24小时限制'), { code: 'FEIGUA_SHOP_REMOVE_LOCKED' }); } });
  await assert.rejects(blocked.service.remove(shop.id), { code: 'FEIGUA_SHOP_REMOVE_LOCKED' }); assert.deepEqual(blocked.disk(), stored);
  const expired = fixture({ stored, auth: { status: 'expired', message: '请重新登录' } });
  await assert.rejects(expired.service.remove(shop.id), /重新登录/); assert.equal(expired.unfollows(), 0);
  const diskFailure = fixture({ stored, write: async () => { throw new Error('disk unavailable'); } });
  await assert.rejects(diskFailure.service.remove(shop.id), { code: 'FEIGUA_SHOP_REMOVE_SAVE' });
  assert.deepEqual(diskFailure.disk(), stored); assert.equal((await diskFailure.service.state()).busy, false);
});

test('in-flight removal locks settings, collection and other source operations; cancellation preserves the monitor', async () => {
  let entered, release; const started = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  const f = fixture({ unfollow: async (_shop, signal) => { entered(); await gate; assert.equal(signal.aborted, true); return { remaining: 9 }; } });
  const removing = f.service.remove(shop.id); await started;
  await assert.rejects(f.service.save([shop]), /保存/); await assert.rejects(f.service.start(), /正在执行/); await assert.rejects(f.service.search('合成'), /等待/);
  await f.service.checkSchedule(now, () => true); assert.equal(f.calls(), 0);
  await f.service.cancel(); release(); await assert.rejects(removing, { code: 'FEIGUA_CANCELLED' });
  assert.deepEqual(f.disk().shops, [shop]); assert.equal((await f.service.state()).busy, false);
});

test('unfollow observation and provider client accept only the exact single-record POST', async () => {
  const details = params => ({ method: 'POST', url: 'https://dy.feigua.cn' + SHOP_ENDPOINTS.unfollow, uploadData: [{ bytes: Buffer.from(JSON.stringify(params)) }] });
  assert.deepEqual(observeShopRequest(details({ focusId: 123 }), 'https://dy.feigua.cn'), { kind: 'unfollow', params: { focusId: '123' } });
  for (const p of [{ focusId: 0 }, { focusId: '123' }, { focusId: 123, groupId: 0 }, { shopId: shop.id }]) assert.equal(observeShopRequest(details(p), 'https://dy.feigua.cn'), null);
  assert.equal(observeShopRequest({ ...details({ focusId: 123 }), method: 'GET' }, 'https://dy.feigua.cn'), null);
  const old = globalThis.document, calls = []; let response = { Code: 200, Status: true, Data: null };
  globalThis.document = { querySelector: () => ({ __vue__: { $api: { shops: { remove: { url: SHOP_ENDPOINTS.unfollow, POST: async args => { calls.push(args); return response; } } } } } }) };
  try {
    assert.equal((await readShopApi({ kind: 'unfollow', params: { focusId: 123, extra: true } })).code, 0); assert.equal(calls.length, 0);
    assert.equal((await readShopApi({ kind: 'unfollow', params: { focusId: 123 } })).data.acknowledged, true);
    assert.deepEqual(calls[0], { data: { focusId: 123 } });
    response = { Code: -200, Status: false, Msg: '新添加的小店需满24小时方可删除', Data: null };
    assert.equal((await readShopApi({ kind: 'unfollow', params: { focusId: 123 } })).removalLocked, true);
  } finally { globalThis.document = old; }
});

test('stability: transient read failures recover with bounded retries and a fresh observed request', async () => {
  let calls = 0; const waits = [], notices = [];
  const browser = { requestSequence: 0, shopRequests: [], isProviderUrl: () => true };
  browser.window = { isDestroyed: () => false, webContents: { getURL: () => 'https://dy.feigua.cn/app/', executeJavaScript: async () => {
    browser.shopRequests.push({ kind: 'overview', params: { shopId: shop.id }, sequence: ++browser.requestSequence });
    return ++calls < 3 ? { code: 503 } : { code: 200, success: true, data: metrics() };
  } } };
  const collector = new FeiguaShopCollector(browser, { retryWait: async ms => waits.push(ms), onRetry: text => notices.push(text) });
  assert.ok(await collector.request('overview', { shopId: shop.id }));
  assert.equal(calls, 3); assert.deepEqual(waits, [10000, 30000]); assert.equal(notices.length, 2);
});

test('stability: cancelling a shop search releases the source and rejects late results', async () => {
  let entered, release; const started = new Promise(r => { entered = r; });
  const f = fixture({ search: async (_query, signal) => new Promise((resolve, reject) => {
    release = () => resolve([shop]); entered(); signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'FEIGUA_CANCELLED' })), { once: true });
  }) });
  const pending = f.service.search('合成店铺').then(() => 'completed', e => e.code);
  await started; await f.service.cancel(); await flush();
  const outcome = await Promise.race([pending, Promise.resolve('still-running')]);
  release(); await pending;
  assert.equal(outcome, 'FEIGUA_CANCELLED'); assert.equal((await f.service.state()).busy, false);
});

test('stability: a shop launch reserves the shared browser while its initial task is being saved', async () => {
  let entered, release, first = true; const writing = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  const f = fixture({ write: async () => { if (first) { first = false; entered(); await gate; } } });
  const launch = f.service.start(); await writing; const reserved = !!f.gateway.operation;
  release(); await launch; await f.service.job;
  assert.equal(reserved, true);
});

test('stability: settings saved during a schedule write cannot erase the persisted daily marker', async () => {
  let entered, release, first = true; const writing = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  const other = { id: 'another', name: '合成另一店铺' };
  const f = fixture({ write: async data => { if (first && data.lastScheduledDate) { first = false; entered(); await gate; } } });
  const scheduled = f.service.checkSchedule(now, () => true).catch(() => {}); await writing;
  const saved = f.service.save([shop, other]); release(); await saved; await scheduled; await f.service.job;
  assert.deepEqual(f.disk().shops, [shop, other]); assert.equal(f.disk().lastScheduledDate, '2026-10-16');
});

test('stability: terminal status write failure cannot leave an idle task displayed as running', async () => {
  const f = fixture({ write: async data => { if (data.lastRun?.status !== 'running') throw new Error('terminal write failed'); } });
  await f.service.start(); await f.service.job;
  const state = await f.service.state();
  assert.equal(state.busy, false); assert.equal(state.lastRun.status, 'failed'); assert.match(state.error, /保存失败/); assert.equal(state.snapshots.length, 1);
});

test('stability: a failed result write stops subsequent shop reads and preserves saved history', async () => {
  let fail = true; const other = { id: 'another', name: '合成另一店铺' };
  const f = fixture({ stored: { version: 1, shops: [shop, other], snapshots: [] }, write: async data => {
    if (fail && data.snapshots.length) { fail = false; throw new Error('disk full'); }
  } });
  await f.service.start(); await f.service.job;
  assert.equal(f.calls(), 1); assert.equal(f.disk().snapshots.length, 0); assert.equal((await f.service.state()).lastRun.status, 'failed');
});

test('stability: read retry exhaustion is bounded and writes or terminal errors are never automatically replayed', async () => {
  for (const kind of ['overview', 'follow', 'unfollow']) {
    let calls = 0; const waits = [];
    const collector = new FeiguaShopCollector({}, { retryWait: async ms => waits.push(ms) });
    collector.requestOnce = async () => { calls++; throw Object.assign(new Error('transport'), { code: 'FEIGUA_NETWORK' }); };
    await assert.rejects(collector.request(kind, {}), { code: 'FEIGUA_NETWORK' });
    assert.equal(calls, kind === 'overview' ? 3 : 1); assert.equal(waits.length, kind === 'overview' ? 2 : 0);
  }
  for (const code of ['FEIGUA_AUTH_REQUIRED', 'FEIGUA_PERMISSION', 'FEIGUA_QUOTA', 'FEIGUA_RATE_LIMIT', 'FEIGUA_SHOP_INVALID']) {
    let calls = 0;
    const collector = new FeiguaShopCollector({}, { retryWait: async () => assert.fail('terminal failures must not retry') });
    collector.requestOnce = async () => { calls++; throw Object.assign(new Error('terminal'), { code }); };
    await assert.rejects(collector.request('overview', {}), { code }); assert.equal(calls, 1);
  }
});

test('stability: cancellation during read backoff prevents every later request', async () => {
  const controller = new AbortController(); let calls = 0;
  const collector = new FeiguaShopCollector({}, { retryWait: async (_ms, signal) => { assert.equal(signal, controller.signal); controller.abort(); throw new Error('aborted wait'); } });
  collector.requestOnce = async () => { calls++; throw Object.assign(new Error('offline'), { code: 'FEIGUA_NETWORK' }); };
  await assert.rejects(collector.request('overview', {}, controller.signal), { code: 'FEIGUA_CANCELLED' }); assert.equal(calls, 1);
});

test('stability: transport errors are classified without exporting private network fields', async () => {
  const old = globalThis.document;
  try {
    for (const [failure, network] of [[{ response: { status: 503 } }, true], [{ code: 'ERR_NETWORK' }, true], [{ message: 'Failed to fetch' }, true], [{ response: { status: 401 } }, false], [{ response: { status: 403 } }, false], [{ response: { status: 429 } }, false]]) {
      globalThis.document = { querySelector: () => ({ __vue__: { $api: { shop: { read: { url: SHOP_ENDPOINTS.overview, GET: async () => { throw { ...failure, config: { authorization: 'private-token' } }; } } } } } }) };
      const result = await readShopApi({ kind: 'overview', params: {} });
      assert.equal(result.network, network); assert.doesNotMatch(JSON.stringify(result), /private-token|authorization/);
    }
  } finally { globalThis.document = old; }
});

test('stability: a skipped browser lease rejects cleanly instead of hanging or falsely completing', { timeout: 1000 }, async () => {
  for (const method of ['search', 'start', 'remove']) {
    const f = fixture(); f.gateway.exclusive = async () => undefined;
    await assert.rejects(method === 'search' ? f.service.search('合成店铺') : method === 'remove' ? f.service.remove(shop.id) : f.service.start(), { code: 'FEIGUA_CANCELLED' });
    assert.equal((await f.service.state()).busy, false); assert.equal(f.calls(), 0); assert.equal(f.unfollows(), 0); assert.equal(f.disk().lastRun, null);
  }
});

test('stability: failing to save initial intent releases the browser before returning an error', async () => {
  const f = fixture({ write: async () => { throw new Error('disk full'); } });
  await assert.rejects(f.service.start(), /disk full/); await f.service.job;
  assert.equal(f.authCalls(), 0); assert.equal(f.calls(), 0); assert.equal(f.gateway.operation, null); assert.equal(f.gateway.controller, null);
  assert.equal((await f.service.state()).busy, false); assert.equal(f.disk().lastRun, null);
});

test('stability: cancelled search authentication cannot publish a late login or issue a search', async () => {
  let entered, release, searches = 0; const started = new Promise(r => { entered = r; });
  const f = fixture({ search: async () => { searches++; return [shop]; } });
  const oldAuth = { status: 'expired' }; f.gateway.auth = oldAuth;
  f.gateway.browser.checkLogin = async () => { entered(); return new Promise(r => { release = r; }); };
  const search = f.service.search('合成店铺'); await started; await f.service.cancel(); release({ status: 'authenticated' });
  await assert.rejects(search, { code: 'FEIGUA_CANCELLED' }); assert.equal(searches, 0); assert.equal(f.gateway.auth, oldAuth);
});
