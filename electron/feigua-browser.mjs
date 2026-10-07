import { setTimeout as delay } from 'node:timers/promises';
import { FEIGUA_HOME, FEIGUA_SOURCES, isFeiguaDataUrl, normalizeMusicTag, normalizeVideoPath } from './feigua-contract.mjs';
import { feiguaPage } from './feigua-page.mjs';
import { normalizeLoginEntryUrl, isLoginEntryNavigation, isLoginEntryHandoff } from './feigua-login-entry.mjs';

function issue(message, code = 'FEIGUA_PAGE_CHANGED') {
  return Object.assign(new Error(message), { code, publicMessage: message });
}

export function isFeiguaNavigation(value, loginEntryUrl = '') {
  if (isFeiguaDataUrl(value)) return true;
  if (isLoginEntryNavigation(value, loginEntryUrl)) return true;
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
    this.loginEntryUrl = '';
    this.loginRelayOrigins = new Set();
  }

  setLoginEntryUrl(value) {
    const next = normalizeLoginEntryUrl(value);
    if (next === this.loginEntryUrl) return;
    this.stopLoginWatch();
    this.wasAuthenticated = false;
    this.loginRelayOrigins.clear();
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.loginEntryUrl = next;
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
    const allowedNavigation = url => isFeiguaNavigation(url, this.loginEntryUrl) || [...this.loginRelayOrigins].some(origin => isLoginEntryNavigation(url, origin));
    const guard = (event, url) => { if (!allowedNavigation(url)) event.preventDefault(); };
    window.webContents.on('will-navigate', guard);
    window.webContents.on('will-redirect', guard);
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.setWindowOpenHandler(({ url }) => {
      const fromPortal = isLoginEntryNavigation(window.webContents.getURL(), this.loginEntryUrl);
      if (fromPortal && isLoginEntryHandoff(url, this.loginEntryUrl)) this.loginRelayOrigins.add(new URL(url).origin);
      const allowed = allowedNavigation(url);
      try { const parsed = new URL(url); this.lastNavigation = { path: parsed.origin + parsed.pathname, allowed }; } catch { this.lastNavigation = { allowed: false }; }
      if (allowed) void window.loadURL(url).catch(() => {});
      else this.onAuthChange?.({ status: 'signed_out', message: '入口跳转地址尚不支持，请返回入口重试或核对网址' });
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

  async execute(command, argument = {}, retryNotice = true) {
    if (!this.window || this.window.isDestroyed()) throw issue('飞瓜窗口已关闭，请重新打开');
    if (!isFeiguaDataUrl(this.window.webContents.getURL())) throw issue('请先完成飞瓜登录', 'FEIGUA_AUTH_REQUIRED');
    let result;
    try { result = await this.window.webContents.executeJavaScript(`(${feiguaPage.toString()})(${JSON.stringify(command)}, ${JSON.stringify(argument)})`); }
    catch { throw issue('飞瓜页面暂不可读取，请检查页面后重试'); }
    if (result?.authRequired) throw issue('飞瓜登录已失效，请重新登录', 'FEIGUA_AUTH_REQUIRED');
    if (command !== 'auth' && result?.actionRequired) {
      if (retryNotice) { await this.resolveAuth(); return this.execute(command, argument, false); }
      throw issue('飞瓜声明确认后仍未消失，已停止重复操作', 'FEIGUA_NOTICE_FAILED');
    }
    if (result?.error) throw issue(result.error);
    return result;
  }

  async resolveAuth(signal) {
    let auth = await this.execute('auth');
    if (auth.actionRequired !== 'terms') return auth;
    this.onAuthChange?.({ status: 'checking', message: '正在自动处理飞瓜声明…' });
    await this.execute('accept-terms');
    for (let attempt = 0; attempt < 25; attempt++) {
      await delay(300, undefined, { signal });
      auth = await this.execute('auth');
      if (!auth.actionRequired) return auth;
    }
    throw issue('飞瓜声明确认未生效，请稍后重试', 'FEIGUA_NOTICE_FAILED');
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
    if (!this.loginEntryUrl) throw issue('请先配置并保存登录入口网址', 'FEIGUA_ENTRY_REQUIRED');
    this.stopLoginWatch();
    this.onAuthChange?.({ status: 'signed_out', message: '请在登录入口完成登录，并进入飞瓜工作台' });
    this.ensureWindow(true);
    try { await this.window.loadURL(this.loginEntryUrl); }
    catch { throw issue('登录入口加载失败，请检查网址和网络后重试', 'FEIGUA_NETWORK'); }
    if (isFeiguaDataUrl(this.window.webContents.getURL())) {
      const auth = await this.execute('auth');
      if (!auth.authenticated && !auth.workspaceAvailable && !auth.actionRequired) await this.execute('login');
    }
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
        const auth = await this.resolveAuth();
        if (this.window !== loginWindow || loginWindow.isDestroyed()) return;
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
      } catch (error) {
        if (error.code === 'FEIGUA_NOTICE_FAILED') {
          this.stopLoginWatch();
          this.onAuthChange?.({ status: 'error', message: error.publicMessage });
        }
      }
      finally { this.loginCheckPending = false; }
    };
    this.loginTimer = setInterval(() => void check(), 1000);
    this.loginTimer.unref?.();
    void check();
  }

  async checkLogin() {
    if (!this.loginEntryUrl && (!this.window || this.window.isDestroyed?.())) return { status: 'signed_out', message: '请先配置并保存登录入口网址' };
    this.ensureWindow();
    if (!this.window.webContents.getURL()) {
      if (!this.loginEntryUrl) return { status: 'signed_out', message: '请先配置并保存登录入口网址' };
      try { await this.window.loadURL(this.loginEntryUrl); }
      catch { throw issue('登录入口加载失败，请检查网址和网络后重试', 'FEIGUA_NETWORK'); }
    }
    if (!isFeiguaDataUrl(this.window.webContents.getURL())) return { status: 'signed_out', message: '请在登录入口完成登录，并进入飞瓜工作台；代理页面的采集登录状态尚未核验' };
    let auth = await this.resolveAuth();
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
      const auth = await this.resolveAuth(signal);
      if (auth.authenticated || auth.loginVisible || auth.actionRequired) return auth;
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

  async openSource(kind, signal) {
    const source = FEIGUA_SOURCES[kind];
    if (!source) throw issue('未知飞瓜来源');
    if (signal?.aborted) throw issue('已取消采集');
    // Discover routes from the signed-in application's menu; never guess API paths.
    await this.navigate(FEIGUA_HOME);
    const auth = await this.resolveAuth(signal);
    if (auth.workspaceAvailable) {
      await this.enterWorkspace();
      await this.waitForWorkspace(signal);
    }
    await this.settle(signal);
    const previousUrl = this.window.webContents.getURL();
    let destination = await this.execute('navigate', { labels: source.navigation });
    if (destination.expanded) { await this.settle(signal); destination = await this.execute('navigate', { labels: source.navigation, expanded: true }); }
    if (destination.url) await this.navigate(destination.url);
    if (destination.clicked) {
      for (let attempt = 0; attempt < 40 && this.window.webContents.getURL() === previousUrl; attempt++) await delay(250, undefined, { signal });
      if (this.window.webContents.getURL() === previousUrl) throw issue('飞瓜菜单未完成跳转，已停止读取旧页面');
    }
    await this.settle(signal);
  }

  async getMusicTags(signal) {
    await this.openSource('music', signal);
    return this.execute('music-tag-options');
  }

  async getVideoFilters(signal) {
    await this.openSource('videos', signal);
    return this.execute('video-filter-options');
  }

  async collect(kind, keyword, signal, options = {}) {
    const source = FEIGUA_SOURCES[kind];
    await this.openSource(kind, signal);
    const musicTag = ['music', 'topics'].includes(kind) ? normalizeMusicTag(options.musicTag) : [];
    if (kind === 'videos') {
      await this.execute('clear'); await this.settle(signal);
      for (const [key, label] of [['categoryPath', '带货品类'], ['tagPath', '视频标签']]) {
        const path = normalizeVideoPath(options[key]);
        for (let depth = 0; depth < path.length - 1; depth++) {
          await this.execute('video-filter', { label, path, phase: 'expand', depth });
          await this.settle(signal);
        }
        await this.choose('video-filter', { label, path, phase: 'select' }, signal);
      }
      await this.choose('choice', { label: '近7天' }, signal);
      await this.choose('keyword', { keyword }, signal);
    } else {
      if (kind === 'topics') {
        await this.choose('choice', { label: '话题总榜' }, signal);
        await this.choose('choice', { label: '周榜' }, signal);
        if (musicTag.length > 1) { await this.execute('music-tag', { kind, path: musicTag, phase: 'expand' }); await this.settle(signal); }
        await this.choose('music-tag', { kind, path: musicTag, phase: 'select' }, signal);
        await this.choose('category', { label: '话题类型' }, signal);
      } else {
        if (kind === 'music') {
          if (musicTag.length > 1) { await this.execute('music-tag', { path: musicTag, phase: 'expand' }); await this.settle(signal); }
          await this.choose('music-tag', { path: musicTag, phase: 'select' }, signal);
        } else {
          await this.choose('choice', { label: '热点榜' }, signal);
          await this.choose('choice', { label: source.period }, signal);
        }
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
