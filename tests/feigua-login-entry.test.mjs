import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeLoginEntryUrl, isLoginEntryHandoff, normalizeWorkspaceHint } from '../electron/feigua-login-entry.mjs';
import { FeiguaBrowser, isFeiguaNavigation } from '../electron/feigua-browser.mjs';
import { FeiguaService } from '../electron/feigua-service.mjs';

const entry = 'http://192.0.2.10:16888/'; // Documentation-only address, never contacted.
function fixture({ stored = { version: 1, keywords: ['保留词'], runs: [] }, failWrite = false, providerBrowser } = {}) {
  let disk = structuredClone(stored);
  const calls = [];
  const browser = providerBrowser || { setLoginEntryUrl: url => calls.push(['configure', url]), openLogin: async () => calls.push(['login']), stopLoginWatch() {} };
  const service = new FeiguaService({ userDataPath: '/unused', browser, storage: {
    read: async () => structuredClone(disk),
    write: async data => { if (failWrite) throw new Error('磁盘不可写'); disk = structuredClone(data); },
  } });
  return { service, browser, calls, disk: () => disk };
}

test('entry supports HTTP with a port and HTTPS, and limits navigation to the exact configured origin', () => {
  assert.equal(normalizeLoginEntryUrl('  http://192.0.2.10:16888  '), entry);
  assert.equal(normalizeLoginEntryUrl('https://portal.example/login?next=workspace'), 'https://portal.example/login?next=workspace');
  assert.equal(normalizeLoginEntryUrl(''), '');
  for (const value of ['http:portal.example', 'file:///tmp/test', 'javascript:alert(1)', 'ftp://portal.example/', 'https://user:password@portal.example/', 'https://portal.example/a\nb', null]) assert.throws(() => normalizeLoginEntryUrl(value));
  assert.equal(isFeiguaNavigation(`${entry}admin/workspace`, entry), true);
  for (const value of ['http://192.0.2.10:16889/', 'https://192.0.2.10:16888/', 'http://192.0.2.11:16888/', `${entry.slice(0, -1)}.evil/`, 'http://user:pass@192.0.2.10:16888/']) assert.equal(isFeiguaNavigation(value, entry), false);
  assert.equal(isFeiguaNavigation('https://dy.feigua.cn/app/', entry), true);
  assert.equal(isFeiguaNavigation('https://open.weixin.qq.com/connect/qrconnect', entry), true);
});

test('old data has no implicit direct login; saving and reloading preserves entry, keywords and results', async () => {
  const stored = { version: 1, keywords: ['保留词'], runs: [{ id: 'history', status: 'completed', groups: [] }] };
  const { service, calls, disk } = fixture({ stored });
  assert.equal((await service.state()).loginEntryUrl, '');
  await assert.rejects(service.login(), /先配置/);
  assert.equal(calls.some(([kind]) => kind === 'login'), false);
  await service.saveLoginEntryUrl(entry);
  assert.equal((await service.state()).auth.status, 'signed_out');
  await service.login({ collectAfterLogin: false });
  assert.equal(calls.at(-1)[0], 'login');
  const restored = fixture({ stored: disk() });
  const state = await restored.service.state();
  assert.equal(state.loginEntryUrl, entry);
  assert.deepEqual(state.keywords, ['保留词']);
  assert.equal(state.runs[0].id, 'history');
  assert.deepEqual(restored.calls[0], ['configure', entry]);
  await service.saveLoginEntryUrl('https://new-portal.example/');
  assert.equal(service.autoCollectRequested, false);
  assert.equal(service.autoCatalogRequested, false);
  await service.saveLoginEntryUrl('');
  await assert.rejects(service.login(), /先配置/);
});

test('a failed save keeps the previous entry and browser session active', async () => {
  const { service, calls } = fixture({ stored: { version: 1, loginEntryUrl: entry, keywords: [], runs: [] }, failWrite: true });
  await service.ready;
  service.auth = { status: 'authenticated', message: '已登录' };
  await assert.rejects(service.saveLoginEntryUrl('https://new-portal.example/'), /磁盘/);
  assert.equal((await service.state()).loginEntryUrl, entry);
  assert.equal((await service.state()).auth.status, 'authenticated');
  assert.deepEqual(calls, [['configure', entry]]);
});

test('a reload hint is bound to the saved entry and cannot contain credentials or signed paths', () => {
  const hint = {entryUrl:entry,origin:'http://192.0.2.10:13042'};
  assert.deepEqual(normalizeWorkspaceHint(hint,entry),hint);
  assert.equal(normalizeWorkspaceHint(hint,`${entry}different-entry`),null);
  for (const origin of ['http://foreign.example:13042','https://192.0.2.10:13042','http://user:password@192.0.2.10:13042','http://192.0.2.10:13042/?token=synthetic','http://192.0.2.10:13042/login']) assert.equal(normalizeWorkspaceHint({...hint,origin},entry),null);
});

test('restart rechecks the saved workspace session before trusting it, without reopening the portal', async () => {
  const hint = {entryUrl:entry,origin:'http://192.0.2.10:13042'};
  const {browser,loaded}=browserFixture();
  const {service,disk}=fixture({providerBrowser:browser,stored:{version:1,loginEntryUrl:entry,workspaceHint:hint,keywords:[],runs:[]}});
  await service.ready;
  assert.equal(browser.sourceOrigin(),null);
  const state=await service.checkLogin();
  assert.equal(state.auth.status,'authenticated');
  assert.deepEqual(loaded,[`${hint.origin}/app/`]);
  assert.equal(browser.sourceOrigin(),hint.origin);
  await browser.onWorkspaceVerified(hint);
  assert.deepEqual(disk().workspaceHint,hint);
  await service.saveLoginEntryUrl(`${entry}new-entry`);
  assert.equal(disk().workspaceHint,null);
  assert.equal(browser.workspaceHint,null);
});

test('an expired saved session gives a relogin prompt and never enables collection scripts', async () => {
  const {browser,loaded}=browserFixture();
  browser.setLoginEntryUrl(entry);
  browser.setWorkspaceHint({entryUrl:entry,origin:'http://192.0.2.10:13042'});
  browser.ensureWindow();
  browser.window.webContents.executeJavaScript=async()=>({authenticated:false,loginVisible:true});
  const auth=await browser.checkLogin();
  assert.equal(auth.status,'expired');
  assert.match(auth.message,/打开登录入口.*重新登录/);
  assert.deepEqual(loaded,['http://192.0.2.10:13042/app/']);
  assert.equal(browser.sourceOrigin(),null);
  await assert.rejects(browser.execute('capture-context'),/先核验/);
});

test('a saved gateway redirecting to its login page prompts relogin without executing provider code', async () => {
  const {browser,executed}=browserFixture();
  browser.setLoginEntryUrl(entry);
  browser.setWorkspaceHint({entryUrl:entry,origin:'http://192.0.2.10:13042'});
  browser.ensureWindow();
  browser.window.loadURL=async()=>{browser.window.url='http://192.0.2.10:13042/login';};
  const auth=await browser.checkLogin();
  assert.equal(auth.status,'expired');
  assert.match(auth.message,/重新登录/);
  assert.equal(browser.sourceOrigin(),null);
  assert.deepEqual(executed,[]);
});

test('legacy verified API results provide a recheck hint, but an explicit reset cannot resurrect it', async () => {
  const result={sourceUrl:'http://192.0.2.10:13042/app/#/music/index',rows:[],provenance:{transport:'provider-api',responseCode:200}};
  const base={version:1,loginEntryUrl:entry,keywords:[],runs:[],latestResults:[{kind:'music',keyword:null,result}]};
  const migrated=fixture({stored:base});
  assert.deepEqual((await migrated.service.state()).workspaceHint,{entryUrl:entry,origin:'http://192.0.2.10:13042'});
  assert.equal((await fixture({stored:{...base,workspaceHint:null}}).service.state()).workspaceHint,null);
  assert.equal((await fixture({stored:{...base,loginEntryUrl:'http://other.example/'}}).service.state()).workspaceHint,null);
});

test('a portal may open its same-server gateway on another port without trusting unrelated hosts', async () => {
  const { browser, loaded, handlers } = browserFixture();
  browser.setLoginEntryUrl(entry);
  await browser.openLogin();
  const gateway = 'http://192.0.2.10:13042/login?session=synthetic';
  assert.equal(isFeiguaNavigation(gateway, entry), false);
  assert.equal(isLoginEntryHandoff(gateway, entry), true);
  for (const url of ['http://foreign.example:13042/', 'http://user:password@192.0.2.10:13042/', 'https://192.0.2.10:13042/']) assert.equal(isLoginEntryHandoff(url, entry), false);
  handlers.get('popup')({ url: gateway });
  assert.equal(loaded.at(-1), gateway);
  let prevented = false;
  browser.window.webContents.emit('will-redirect', { preventDefault: () => { prevented = true; } }, 'http://192.0.2.10:13042/workspace');
  assert.equal(prevented, false);
  browser.window.webContents.emit('will-redirect', { preventDefault: () => { prevented = true; } }, 'http://192.0.2.10:13045/workspace');
  assert.equal(prevented, true);
  handlers.get('popup')({ url: 'http://192.0.2.10:13045/' });
  assert.equal(loaded.at(-1), gateway); // A gateway cannot grant itself new ports.
  browser.setLoginEntryUrl('https://new-portal.example/');
  assert.equal(browser.loginRelayOrigins.size, 0);
  browser.stopLoginWatch();
});

test('only a selected gateway workspace passing auth may become the collection source', async () => {
  const { browser, loaded, handlers } = browserFixture();
  browser.setLoginEntryUrl(entry);
  await browser.openLogin();
  assert.equal(browser.sourceOrigin(), null);
  const gateway = 'http://192.0.2.10:13042/app/#/brand-compare/index';
  handlers.get('popup')({ url: gateway });
  await assert.rejects(browser.execute('capture-context'), /先核验/);
  assert.equal((await browser.checkLogin()).status, 'authenticated');
  assert.equal(browser.sourceOrigin(), 'http://192.0.2.10:13042');
  await browser.navigate('http://192.0.2.10:13042/app/#/music/index');
  assert.equal(loaded.at(-1), 'http://192.0.2.10:13042/app/#/music/index');
  await assert.rejects(browser.navigate('http://192.0.2.10:13045/app/'), /来源地址/);
  browser.setLoginEntryUrl('https://new-portal.example/');
  assert.equal(browser.sourceOrigin(), null);
  browser.stopLoginWatch();
});

function browserFixture() {
  const loaded = [], executed = [], handlers = new Map();
  const partition = new EventEmitter();
  Object.assign(partition, { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {}, onCompleted() {}, onErrorOccurred() {} } });
  class Window extends EventEmitter {
    constructor() {
      super(); this.url = ''; this.closed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { getURL: () => this.url, setWindowOpenHandler: handler => handlers.set('popup', handler), executeJavaScript: async source => { executed.push(source); return { authenticated: true }; } });
    }
    isDestroyed() { return this.closed; }
    show() {}
    focus() {}
    async loadURL(url) { loaded.push(url); this.url = url; }
    close() { this.closed = true; this.emit('closed'); }
  }
  return { browser: new FeiguaBrowser({ BrowserWindow: Window, session: { fromPartition: () => partition } }), loaded, executed, handlers };
}

test('a mounting workspace is awaited rather than misreported as an expired login', async () => {
  const { browser } = browserFixture();
  let calls = 0;
  browser.ensureWindow();
  browser.window.url = 'https://dy.feigua.cn/app/';
  browser.execute = async () => ++calls === 1 ? {loading:true,authenticated:false} : {loading:false,authenticated:true};
  assert.equal((await browser.resolveAuth()).authenticated, true);
  assert.equal(calls, 2);
});

test('login always opens the saved portal, never runs provider scripts on it, and follows its allowed popup', async () => {
  const { browser, loaded, executed, handlers } = browserFixture();
  await assert.rejects(browser.openLogin(), /先配置/);
  assert.deepEqual(loaded, []);
  assert.equal((await browser.checkLogin()).status, 'signed_out');
  assert.deepEqual(loaded, []);
  browser.setLoginEntryUrl(entry);
  await browser.openLogin();
  assert.deepEqual(loaded, [entry]);
  assert.deepEqual(executed, []);
  assert.equal((await browser.checkLogin()).status, 'signed_out');
  const window = browser.window;
  let blocked = false;
  window.webContents.emit('will-redirect', { preventDefault: () => { blocked = true; } }, 'https://foreign.example/');
  assert.equal(blocked, true);
  assert.deepEqual(handlers.get('popup')({ url: 'https://dy.feigua.cn/app/' }), { action: 'deny' });
  assert.equal((await browser.checkLogin()).status, 'authenticated');
  assert.equal(loaded[0], entry);
  assert.ok(executed.length > 0);
  browser.setLoginEntryUrl('https://new-portal.example/');
  assert.equal(window.closed, true);
  assert.equal(browser.wasAuthenticated, false);
  assert.equal(browser.loginTimer, null);
  await browser.openLogin();
  assert.equal(loaded.at(-1), 'https://new-portal.example/');
  browser.stopLoginWatch();
});
