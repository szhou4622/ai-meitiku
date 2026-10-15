import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FEIGUA_HOME } from '../electron/feigua-contract.mjs';
import { FeiguaBrowser, isFeiguaNavigation } from '../electron/feigua-browser.mjs';
import { FeiguaService } from '../electron/feigua-service.mjs';

const portal = 'http://192.0.2.10:16888/';
const flush = async () => { for (let n = 0; n < 10; n++) await new Promise(resolve => setImmediate(resolve)); };
function serviceFixture(stored = { version: 1, keywords: [], runs: [] }, failWrite = false) {
  let disk = structuredClone(stored), writes = 0, logins = 0;
  const service = new FeiguaService({ userDataPath: '/unused', browser: { openLogin: async () => { logins++; } }, storage: {
    read: async () => structuredClone(disk),
    write: async data => { if (failWrite) throw new Error('磁盘不可写'); disk = structuredClone(data); writes++; },
  } });
  return { service, disk: () => disk, writes: () => writes, logins: () => logins };
}
function browserFixture(t) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const loaded = [], windows = [], notifications = [], partitions = [];
  const partition = new EventEmitter();
  Object.assign(partition, { setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    webRequest: { onBeforeRequest() {}, onCompleted() {}, onErrorOccurred() {} } });
  const state = { authenticated: false, loginVisible: true };
  class Window extends EventEmitter {
    constructor(options) {
      super(); windows.push(this); this.options = options; this.url = ''; this.closed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { getURL: () => this.url, setWindowOpenHandler: handler => { this.popup = handler; },
        executeJavaScript: async () => ({ ...state }) });
    }
    isDestroyed() { return this.closed; }
    show() {}
    focus() {}
    async loadURL(url) { loaded.push(url); this.url = url; }
    close() { this.closed = true; this.emit('closed'); }
    destroy() { this.close(); }
  }
  const browser = new FeiguaBrowser({ BrowserWindow: Window, session: {
    fromPartition: name => { partitions.push(name); return partition; },
  } });
  browser.onAuthChange = auth => notifications.push(auth);
  t.after(() => browser.dispose());
  return { browser, state, loaded, windows, partition, partitions, notifications };
}
test('new installs can log in to official Feigua without entry configuration', async () => {
  const f = serviceFixture();
  assert.equal((await f.service.state()).loginEntryUrl, FEIGUA_HOME);
  await f.service.login({ collectAfterLogin: false });
  assert.equal(f.logins(), 1);
  assert.equal(f.service.autoCollectRequested, false);
  assert.equal(typeof f.service.saveLoginEntryUrl, 'undefined');
});
test('portal migration preserves results, filters and schedule markers and never restores a gateway', async () => {
  const oldResult = { kind: 'music', keyword: null, status: 'completed', result: {
    sourceUrl: 'http://192.0.2.10:13042/app/', collectedAt: '2026-10-14T01:00:00Z', rows: [],
    provenance: { transport: 'provider-api', responseCode: 200 },
  } };
  const stored = { version: 1, loginEntryUrl: portal, workspaceHint: { entryUrl: portal, origin: 'http://192.0.2.10:13042' },
    keywords: ['保留词'], videoQueries: [{ keyword: '保留词', categoryPath: ['自定义分类'], tagPath: [] }],
    musicTag: ['自定义标签'], lastHotspotsScheduleDate: '2026-10-14', lastVideosScheduleDate: '2026-10-12',
    runs: [{ id: 'history', status: 'completed', groups: [oldResult] }], latestResults: [oldResult] };
  const f = serviceFixture(stored);
  const next = await f.service.state();
  assert.equal(next.loginEntryUrl, FEIGUA_HOME);
  assert.equal(Object.hasOwn(next, 'workspaceHint'), false);
  assert.deepEqual(next.videoQueries, stored.videoQueries);
  assert.deepEqual(next.musicTag, stored.musicTag);
  assert.equal(next.runs[0].id, 'history');
  assert.equal(next.latestResults[0].result.sourceUrl, oldResult.result.sourceUrl);
  assert.equal(next.lastHotspotsScheduleDate, stored.lastHotspotsScheduleDate);
  assert.equal(next.lastVideosScheduleDate, stored.lastVideosScheduleDate);
  assert.equal(f.writes(), 1);
  const restarted = serviceFixture(f.disk());
  assert.equal((await restarted.service.state()).loginEntryUrl, FEIGUA_HOME);
  assert.equal(restarted.writes(), 0);
});
test('failed migration preserves old on-disk data and does not open a login window', async () => {
  const stored = { version: 1, loginEntryUrl: portal, keywords: ['保留词'], runs: [] };
  const f = serviceFixture(stored, true);
  await assert.rejects(f.service.login(), /磁盘/);
  assert.deepEqual(f.disk(), stored);
  assert.equal(f.logins(), 0);
});
test('navigation ignores legacy entry trust and accepts only official Feigua and WeChat login', () => {
  for (const url of [FEIGUA_HOME, 'https://dy3.feigua.cn/app/', 'https://open.weixin.qq.com/connect/qrconnect']) assert.equal(isFeiguaNavigation(url, portal), true);
  for (const url of [portal, 'http://192.0.2.10:13042/app/', 'https://dy.feigua.cn.evil.example/',
    'http://dy.feigua.cn/', 'https://dy.feigua.cn:444/', 'https://user:password@dy.feigua.cn/']) assert.equal(isFeiguaNavigation(url, portal), false);
});
test('login opens the official page and waits for the user instead of authenticating a login form', async t => {
  const f = browserFixture(t);
  await f.browser.openLogin(); await flush();
  assert.deepEqual(f.loaded, [FEIGUA_HOME]);
  assert.equal(f.windows[0].closed, false);
  assert.equal(f.notifications.some(auth => auth.status === 'authenticated'), false);
  f.state.authenticated = true; f.state.loginVisible = false;
  t.mock.timers.tick(1000); await flush();
  assert.equal(f.windows[0].closed, true);
  assert.equal(f.notifications.at(-1).status, 'authenticated');
});
test('subsequent checks reuse the persistent official session without a credential preload', async t => {
  const f = browserFixture(t);
  f.state.authenticated = true; f.state.loginVisible = false;
  await f.browser.openLogin(); await flush();
  assert.equal(f.windows[0].closed, true);
  assert.equal((await f.browser.checkLogin()).status, 'authenticated');
  assert.deepEqual(f.partitions, ['persist:feigua-trends']);
  assert.equal(f.windows.length, 2);
  for (const window of f.windows) {
    assert.equal(window.options.webPreferences.session, f.partition);
    assert.equal(window.options.webPreferences.preload, undefined);
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.options.webPreferences.sandbox, true);
  }
});
test('expired official sessions prompt manual login and do not report authenticated', async t => {
  const f = browserFixture(t);
  f.browser.wasAuthenticated = true;
  const auth = await f.browser.checkLogin();
  assert.equal(auth.status, 'expired');
  assert.match(auth.message, /登录官方飞瓜.*重新登录/);
  assert.deepEqual(f.loaded, [FEIGUA_HOME]);
});
test('official login cannot hand off to an old gateway or execute collection scripts there', async t => {
  const f = browserFixture(t);
  await f.browser.openLogin(); await flush();
  const window = f.windows[0];
  let prevented = false;
  window.webContents.emit('will-redirect', { preventDefault: () => { prevented = true; } }, portal);
  assert.equal(prevented, true);
  assert.deepEqual(window.popup({ url: 'http://192.0.2.10:13042/app/' }), { action: 'deny' });
  assert.deepEqual(f.loaded, [FEIGUA_HOME]);
  window.url = portal;
  await assert.rejects(f.browser.execute('capture-context'), /先完成飞瓜登录/);
});
test('a mounting official workspace is awaited rather than reported as expired', async t => {
  const f = browserFixture(t);
  f.browser.ensureWindow(); f.browser.window.url = 'https://dy.feigua.cn/app/';
  let calls = 0;
  f.browser.execute = async () => ++calls === 1 ? { loading: true, authenticated: false } : { authenticated: true };
  assert.equal((await f.browser.resolveAuth()).authenticated, true);
  assert.equal(calls, 2);
});
