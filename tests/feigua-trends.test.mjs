import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { FEIGUA_SOURCES, normalizeKeywords, validateCapture, isFeiguaDataUrl } from '../electron/feigua-contract.mjs';
import { FeiguaService } from '../electron/feigua-service.mjs';
import { FeiguaBrowser, isFeiguaNavigation } from '../electron/feigua-browser.mjs';
import { featureRegistry, requireFeatureAccess } from '../electron/feature-registry.mjs';

const capture = (kind, keyword = null, extra = {}) => ({
  url: `https://dy.feigua.cn/test/${kind}`, keyword, sort: FEIGUA_SOURCES[kind].sort, direction: 'desc', period: FEIGUA_SOURCES[kind].period,
  filtersVerified: true, dateRange: '2026-09-25 - 2026-10-01',
  rows: Array.from({ length: 7 }, (_, index) => ({ id: `${kind}-${index}`, title: `合成测试标题${index}`, author: '合成测试作者', yesterdayUsers: '10w', participantGrowth: '20%', peakHeat: '100w', sales: '10w~25w', products: [{ title: '合成测试商品', commission: '5.00%' }] })),
  ...extra,
});

function fixture({ stored, collect, auth, write } = {}) {
  let disk = stored || { version: 1, keywords: [], runs: [] };
  const calls = [];
  const browser = {
    async openLogin() {}, async checkLogin() { return auth || { status: 'authenticated', message: '已登录' }; },
    async collect(kind, keyword, signal) { calls.push([kind, keyword]); return collect ? collect(kind, keyword, signal) : capture(kind, keyword); },
    stop() {}, dispose() {},
  };
  const service = new FeiguaService({ userDataPath: '/unused', browser, storage: {
    read: async () => structuredClone(disk), write: async value => { if (write) await write(value); disk = structuredClone(value); },
  } });
  return { service, calls, disk: () => disk, browser };
}

test('keywords are validated and deduplicated without grouping distinct terms', () => {
  assert.deepEqual(normalizeKeywords([' 素颜霜 ', '粉底液', '素颜霜', '']), ['素颜霜', '粉底液']);
  for (const invalid of [[3], ['a\nb'], ['a'.repeat(61)], Array(51).fill('a'), 'abc']) assert.throws(() => normalizeKeywords(invalid));
});

test('only verified provider ranking is accepted; sales ranges remain unchanged', () => {
  const result = validateCapture('videos', '测试', capture('videos', '测试'));
  assert.equal(result.rows.length, 5);
  assert.equal(result.rows[0].sales, '10w~25w');
  assert.equal(result.rows[0].products[0].commission, '5.00%');
  assert.equal(result.rows[0].plays, null);
  assert.ok(result.rows[0].missingFields.includes('plays'));
  assert.equal(result.filters.publishedAt, '不限');
  for (const invalid of [{ sort: '视频销量' }, { direction: 'asc' }, { period: '本周' }, { keyword: '其他词' }, { filtersVerified: false }, { dateRange: null }, { rows: [] }, { url: 'https://evil.example/' }]) {
    assert.throws(() => validateCapture('videos', '测试', capture('videos', '测试', invalid)));
  }
  assert.equal(validateCapture('videos', '测试', capture('videos', '测试', { rows: [], emptyVerified: true })).rows.length, 0);
});

test('deduplicate stable IDs within each group and never expose unrecognized payload fields', () => {
  const row = capture('music').rows[0];
  const result = validateCapture('music', null, capture('music', null, { rows: [row, row, { ...row, id: 'another', extra: 'private-test-value' }], cookies: 'private-test-value' }));
  assert.equal(result.rows.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /private-test-value/);
  assert.throws(() => validateCapture('music', null, capture('music', null, { rows: [{ title: 'a', yesterdayUsers: '1' }] })), /标识/);
});

test('empty configuration still collects the three independent leaderboards', async () => {
  const { service, calls, disk } = fixture();
  await service.start(); await service.job;
  assert.deepEqual(calls.map(call => call[0]), ['music', 'topics', 'hotspots']);
  assert.equal(disk().runs[0].status, 'completed');
  assert.equal((await service.state()).busy, false);
});

test('keyword snapshot is fixed during a run; edits persist for the next run', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, calls, disk } = fixture({ collect: async (kind, keyword) => { if (kind === 'music') await gate; return capture(kind, keyword); } });
  await service.saveKeywords(['测试甲', '测试乙']);
  await service.start();
  await assert.rejects(service.start(), /正在执行/);
  await assert.rejects(service.login(), /正在执行/);
  await service.saveKeywords(['测试丙']);
  release(); await service.job;
  assert.deepEqual(calls.filter(([kind]) => kind === 'videos').map(([, keyword]) => keyword), ['测试甲', '测试乙']);
  assert.deepEqual(disk().keywords, ['测试丙']);
  assert.deepEqual(disk().runs[0].keywords, ['测试甲', '测试乙']);
});

test('login required prevents collection and does not create a fake successful run', async () => {
  const { service, calls } = fixture({ auth: { status: 'signed_out', message: '请先登录飞瓜' } });
  await assert.rejects(service.start(), /请先登录/);
  assert.equal(calls.length, 0); assert.equal((await service.state()).runs.length, 0);
});

test('session expiry halts remaining groups and preserves successful groups', async () => {
  const { service, calls } = fixture({ collect: async (kind, keyword) => {
    if (kind === 'topics') throw Object.assign(new Error('private network detail'), { code: 'FEIGUA_AUTH_REQUIRED', publicMessage: '请重新登录' });
    return capture(kind, keyword);
  } });
  await service.start(); await service.job;
  const state = await service.state();
  assert.equal(state.auth.status, 'expired'); assert.equal(state.runs[0].status, 'partial');
  assert.equal(state.runs[0].groups[2].status, 'skipped'); assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(state), /private network detail/);
});

test('failed refresh does not overwrite older successful results', async () => {
  const { service, browser } = fixture();
  await service.start(); await service.job;
  browser.collect = async () => { throw new Error('secret test payload'); };
  await service.start(); await service.job;
  const state = await service.state();
  assert.equal(state.runs[0].status, 'failed'); assert.equal(state.runs[1].status, 'completed');
  assert.equal(state.runs[1].groups[0].result.rows.length, 5);
  assert.doesNotMatch(JSON.stringify(state), /secret test payload/);
});

test('cancellation does not save in-flight results or start later groups', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, calls, disk } = fixture({ collect: async kind => { await gate; return capture(kind); } });
  await service.start(); await service.cancel(); release(); await service.job;
  assert.equal(disk().runs[0].status, 'cancelled');
  assert.equal(calls.length, 1); assert.ok(disk().runs[0].groups.every(group => !group.result));
});

test('restart marks interrupted work without automatically replaying provider reads', async () => {
  const { service, calls, disk } = fixture({ stored: { version: 1, keywords: [], runs: [{ id: 'test', status: 'running', groups: [{ kind: 'music', status: 'running' }, { kind: 'topics', status: 'completed', result: { rows: [] } }] }] } });
  assert.equal((await service.state()).runs[0].status, 'interrupted');
  assert.equal(disk().runs[0].groups[1].status, 'completed'); assert.equal(calls.length, 0);
});

test('storage failure before provider I/O prevents collection', async () => {
  const { service, calls } = fixture({ write: async () => { throw new Error('disk full'); } });
  await assert.rejects(service.start(), /disk full/); assert.equal(calls.length, 0);
  assert.equal((await service.state()).runs.length, 0);
  await assert.rejects(service.saveKeywords(['测试']), /disk full/);
  assert.deepEqual((await service.state()).keywords, []);
});

test('all Feigua operations retain base-license authorization', () => {
  for (const method of ['state', 'save-keywords', 'login', 'check-login', 'start', 'cancel']) {
    assert.equal(featureRegistry.forIpc(`feigua-${method}`).id, 'feigua-trends');
  }
  assert.throws(() => requireFeatureAccess(featureRegistry, 'feigua-trends', { authorized: false }), /无权/);
});

test('navigation rejects foreign hosts, credentials and non-HTTPS URLs', () => {
  for (const url of ['http://dy.feigua.cn/', 'https://dy.feigua.cn.evil.example/', 'https://u:p@dy.feigua.cn/', 'https://dy.feigua.cn:444/', 'file:///etc/passwd', 'javascript:alert(1)']) assert.equal(isFeiguaNavigation(url), false);
  assert.equal(isFeiguaDataUrl('https://dy3.feigua.cn/ranking'), true);
  assert.equal(isFeiguaNavigation('https://open.weixin.qq.com/connect/qrconnect'), true);
  assert.equal(isFeiguaDataUrl('https://open.weixin.qq.com/connect/qrconnect'), false);
});

test('provider window is sandboxed and reuses its own persistent session without a preload', async () => {
  let options, permissions, popup;
  const partition = new EventEmitter();
  Object.assign(partition, { setPermissionRequestHandler: handler => { permissions = handler; }, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {}, onCompleted() {}, onErrorOccurred() {} } });
  class Window extends EventEmitter {
    constructor(opts) { super(); options = opts; this.webContents = new EventEmitter(); Object.assign(this.webContents, { setWindowOpenHandler: handler => { popup = handler; } }); }
    isDestroyed() { return false; } show() {} focus() {} loadURL() { return Promise.resolve(); }
  }
  const browser = new FeiguaBrowser({ BrowserWindow: Window, session: { fromPartition: name => { assert.equal(name, 'persist:feigua-trends'); return partition; } } });
  assert.equal(browser.ensureWindow(), browser.ensureWindow());
  assert.equal(options.webPreferences.sandbox, true); assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.preload, undefined);
  permissions(null, 'camera', result => assert.equal(result, false));
  assert.deepEqual(popup({ url: 'https://evil.example' }), { action: 'deny' });
  let blocked = false;
  browser.window.webContents.emit('will-navigate', { preventDefault() { blocked = true; } }, 'https://evil.example');
  assert.equal(blocked, true);
});

test('successful login closes its window automatically and notifies the service without clearing the session', async () => {
  let authenticated = false, closed = 0, notified;
  const browser = new FeiguaBrowser({});
  browser.partition = { marker: 'persistent-session' };
  browser.window = { isDestroyed: () => false, webContents: { getURL: () => 'https://dy.feigua.cn/member' }, close: () => { closed++; } };
  browser.execute = async () => ({ authenticated });
  browser.onAuthChange = auth => { notified = auth; };
  browser.startLoginWatch();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 0); assert.equal(notified, undefined);
  authenticated = true;
  browser.startLoginWatch();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1); assert.equal(notified.status, 'authenticated');
  assert.equal(browser.loginTimer, null); assert.equal(browser.partition.marker, 'persistent-session');
  assert.equal(browser.wasAuthenticated, true);
});

test('automatic login notification reaches the state polled by the media library', async () => {
  const { service, browser } = fixture();
  browser.onAuthChange({ status: 'authenticated', message: '已登录飞瓜' });
  assert.equal((await service.state()).auth.status, 'authenticated');
});
