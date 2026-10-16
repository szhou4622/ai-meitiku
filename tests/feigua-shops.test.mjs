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
test('only observed read-only shop endpoints export allowlisted parameters, never transport credentials', () => {
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

function fixture({ stored, collect, write, auth = { status: 'authenticated' }, time = now } = {}) {
  let disk = structuredClone(stored || { version: 1, shops: [shop], snapshots: [], lastRun: null, lastScheduledDate: null }), calls = 0, authCalls = 0;
  const gateway = { controller: null, operation: null, browser: { checkLogin: async () => { authCalls++; return auth; }, stop() {} },
    exclusive: async action => { if (gateway.controller || gateway.operation) throw new Error('busy'); gateway.operation = Promise.resolve().then(action); try { return await gateway.operation; } finally { gateway.operation = null; } } };
  const service = new FeiguaShopService({ userDataPath: '/unused', gateway, now: () => time,
    collector: { search: async () => [shop], collect: async (...args) => { calls++; return collect ? collect(...args) : snapshot(args[0], args[1]); } },
    storage: { read: async () => structuredClone(disk), write: async data => { await write?.(data); disk = structuredClone(data); } } });
  return { service, gateway, disk: () => disk, calls: () => calls, authCalls: () => authCalls };
}
test('settings enforce the limit before writing and removal preserves all saved weeks', async () => {
  const saved = snapshot(), f = fixture({ stored: { version: 1, shops: [shop], snapshots: [saved] } });
  await assert.rejects(f.service.save(Array.from({ length: 11 }, (_, i) => ({ id: `s-${i}`, name: '店' }))), /10/);
  await f.service.save([]); assert.deepEqual(f.disk().snapshots, [saved]); assert.equal(f.calls(), 0);
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
