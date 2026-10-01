import { setTimeout as delay } from 'node:timers/promises';
import { FEIGUA_HOME, FEIGUA_SOURCES, isFeiguaDataUrl } from './feigua-contract.mjs';
import { feiguaPage } from './feigua-page.mjs';

function issue(message, code = 'FEIGUA_PAGE_CHANGED') {
  return Object.assign(new Error(message), { code, publicMessage: message });
}

export function isFeiguaNavigation(value) {
  if (isFeiguaDataUrl(value)) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'open.weixin.qq.com' && !url.port && !url.username && !url.password; }
  catch { return false; }
}

export class FeiguaBrowser {
  constructor({ BrowserWindow, session }) {
    this.BrowserWindow = BrowserWindow; this.session = session;
    this.window = null; this.pending = new Set(); this.lastNetwork = 0;
    this.wasAuthenticated = false;
    this.loginTimer = null; this.loginCheckPending = false;
    this.onAuthChange = null;
  }

  ensureWindow(show = false) {
    if (this.window && !this.window.isDestroyed()) { if (show) { this.window.show(); this.window.focus(); } return this.window; }
    if (!this.partition) {
      this.partition = this.session.fromPartition('persist:feigua-trends');
      this.partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      this.partition.setPermissionCheckHandler(() => false);
      this.partition.on('will-download', event => event.preventDefault());
      this.partition.webRequest.onBeforeRequest((details, callback) => {
        if (['xhr', 'mainFrame'].includes(details.resourceType)) { this.pending.add(details.id); this.lastNetwork = Date.now(); }
        callback({});
      });
      const done = details => { this.pending.delete(details.id); this.lastNetwork = Date.now(); };
      this.partition.webRequest.onCompleted(done);
      this.partition.webRequest.onErrorOccurred(done);
    }
    const window = new this.BrowserWindow({ width: 1320, height: 900, show, title: '飞瓜 · 热点采集',
      webPreferences: { session: this.partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    this.window = window;
    const guard = (event, url) => { if (!isFeiguaNavigation(url)) event.preventDefault(); };
    window.webContents.on('will-navigate', guard);
    window.webContents.on('will-redirect', guard);
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isFeiguaNavigation(url)) void window.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    window.on('closed', () => { this.stopLoginWatch(); if (this.window === window) this.window = null; this.pending.clear(); });
    return window;
  }

  async navigate(url) {
    if (!isFeiguaDataUrl(url)) throw issue('飞瓜来源地址不受支持');
    const window = this.ensureWindow();
    try { await window.loadURL(url); }
    catch { throw issue('飞瓜页面加载失败，请检查网络后重试', 'FEIGUA_NETWORK'); }
  }

  async execute(command, argument = {}) {
    if (!this.window || this.window.isDestroyed()) throw issue('飞瓜窗口已关闭，请重新打开');
    if (!isFeiguaDataUrl(this.window.webContents.getURL())) throw issue('请先完成飞瓜登录', 'FEIGUA_AUTH_REQUIRED');
    let result;
    try { result = await this.window.webContents.executeJavaScript(`(${feiguaPage.toString()})(${JSON.stringify(command)}, ${JSON.stringify(argument)})`); }
    catch { throw issue('飞瓜页面暂不可读取，请检查页面后重试'); }
    if (result?.authRequired) throw issue('飞瓜登录已失效，请重新登录', 'FEIGUA_AUTH_REQUIRED');
    if (result?.error) throw issue(result.error);
    return result;
  }

  async settle(signal) {
    const deadline = Date.now() + 25000;
    let stable = 0;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw issue('已取消采集', 'FEIGUA_CANCELLED');
      await delay(300, undefined, { signal });
      const ready = await this.execute('ready');
      if (ready.ready && !this.pending.size && Date.now() - this.lastNetwork > 600) stable++; else stable = 0;
      if (stable >= 2) return;
    }
    throw issue('飞瓜页面加载超时，本组未保存', 'FEIGUA_NETWORK');
  }

  async openLogin() {
    this.ensureWindow(true);
    if (!isFeiguaDataUrl(this.window.webContents.getURL())) await this.navigate(FEIGUA_HOME);
    const auth = await this.execute('auth');
    if (!auth.authenticated && !auth.workspaceAvailable) await this.execute('login');
    this.startLoginWatch();
  }

  stopLoginWatch() {
    if (this.loginTimer) clearInterval(this.loginTimer);
    this.loginTimer = null;
  }

  startLoginWatch() {
    this.stopLoginWatch();
    const enteredUrls = new Set();
    const check = async () => {
      if (this.loginCheckPending || !this.window || this.window.isDestroyed()) return;
      this.loginCheckPending = true;
      const loginWindow = this.window;
      try {
        if (!isFeiguaDataUrl(loginWindow.webContents.getURL())) return;
        const auth = await this.execute('auth');
        if (!auth.authenticated && auth.workspaceAvailable) {
          const currentUrl = loginWindow.webContents.getURL();
          if (enteredUrls.has(currentUrl)) return;
          enteredUrls.add(currentUrl);
          this.onAuthChange?.({ status: 'checking', message: '登录已完成，正在进入飞瓜工作台核验…' });
          await this.enterWorkspace();
          return;
        }
        if (!auth.authenticated || this.window !== loginWindow) return;
        this.wasAuthenticated = true;
        this.onAuthChange?.({ status: 'authenticated', message: '已登录飞瓜' });
        this.stopLoginWatch();
        loginWindow.close(); // Session is persistent; closing only dismisses the login UI.
      } catch { /* The user may be navigating, scanning, or closing the login page. */ }
      finally { this.loginCheckPending = false; }
    };
    this.loginTimer = setInterval(() => void check(), 1000);
    this.loginTimer.unref?.();
    void check();
  }

  async checkLogin() {
    this.ensureWindow();
    if (!this.window.webContents.getURL()) await this.navigate(FEIGUA_HOME);
    if (!isFeiguaDataUrl(this.window.webContents.getURL())) return { status: 'signed_out', message: '请在飞瓜窗口完成登录' };
    let auth = await this.execute('auth');
    if (!auth.authenticated && auth.workspaceAvailable) {
      await this.enterWorkspace();
      auth = await this.waitForWorkspace();
    }
    if (auth.authenticated) { this.wasAuthenticated = true; return { status: 'authenticated', message: '已登录飞瓜' }; }
    return { status: this.wasAuthenticated ? 'expired' : 'signed_out', message: this.wasAuthenticated ? '飞瓜登录已失效，请重新登录' : '请先在飞瓜窗口完成登录' };
  }

  async enterWorkspace() {
    const entry = await this.execute('enter-workspace');
    if (entry.url) await this.navigate(entry.url);
  }

  async waitForWorkspace(signal) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw issue('已取消采集', 'FEIGUA_CANCELLED');
      const auth = await this.execute('auth');
      if (auth.authenticated || auth.loginVisible) return auth;
      await delay(300, undefined, { signal });
    }
    throw issue('未能进入飞瓜工作台，请打开登录窗口核对页面', 'FEIGUA_WORKSPACE_UNAVAILABLE');
  }

  async choose(command, args, signal) {
    const result = await this.execute(command, args);
    if (result.verified) return;
    await this.settle(signal);
    const verified = await this.execute(command, { ...args, verify: true });
    if (!verified.verified) throw issue('未能确认筛选条件，已停止本组采集');
  }

  async collect(kind, keyword, signal) {
    const source = FEIGUA_SOURCES[kind];
    if (!source) throw issue('未知飞瓜来源');
    if (signal.aborted) throw issue('已取消采集');
    // Discover routes from the signed-in application's menu; never guess API paths.
    await this.navigate(FEIGUA_HOME);
    const auth = await this.execute('auth');
    if (auth.workspaceAvailable) {
      await this.enterWorkspace();
      await this.waitForWorkspace(signal);
    }
    await this.settle(signal);
    let destination = await this.execute('navigate', { labels: source.navigation });
    if (destination.expanded) { await this.settle(signal); destination = await this.execute('navigate', { labels: source.navigation, expanded: true }); }
    await this.navigate(destination.url);
    await this.settle(signal);
    if (kind === 'videos') {
      await this.execute('clear'); await this.settle(signal);
      await this.choose('category', { label: '带货品类' }, signal);
      await this.choose('category', { label: '视频标签' }, signal);
      await this.choose('choice', { label: '近7天' }, signal);
      await this.choose('keyword', { keyword }, signal);
    } else {
      if (kind === 'topics') {
        await this.choose('choice', { label: '话题总榜' }, signal);
        await this.choose('choice', { label: '周榜' }, signal);
        await this.choose('category', { label: '话题分类' }, signal);
        await this.choose('category', { label: '话题类型' }, signal);
      } else {
        await this.choose('category', { label: kind === 'music' ? '视频标签' : '热点标签' }, signal);
        if (kind === 'hotspots') await this.choose('choice', { label: '近7天' }, signal);
      }
    }
    await this.execute('optional-filters');
    // At most two clicks to cycle ascending -> descending; unknown direction blocks capture.
    let sorted = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.execute('sort', { label: source.sort, verify: attempt === 2 });
      if (result.verified) { sorted = true; break; }
      await this.settle(signal);
    }
    if (!sorted) throw issue('无法确认降序排列');
    return this.execute('capture', { kind, keyword, sort: source.sort, period: source.period });
  }

  stop() { this.window?.webContents.stop(); }
  dispose() { this.stopLoginWatch(); this.window?.destroy(); this.window = null; }
}
