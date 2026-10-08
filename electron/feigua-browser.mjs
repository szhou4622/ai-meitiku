import { setTimeout as delay } from 'node:timers/promises';
import { FEIGUA_HOME, FEIGUA_SOURCES, isFeiguaDataUrl, normalizeMusicTag, normalizeVideoPath } from './feigua-contract.mjs';
import { feiguaPage } from './feigua-page.mjs';
import { normalizeLoginEntryUrl, isLoginEntryNavigation, isLoginEntryHandoff, normalizeWorkspaceHint } from './feigua-login-entry.mjs';
import { FEIGUA_ENDPOINTS, observeFeiguaRequest, validateFeiguaRequest, readFeiguaApi, captureFeiguaResponse } from './feigua-api.mjs';
import { normalizeLoginCredentials, loginFormMemory } from './feigua-login-credentials.mjs';
import { fileURLToPath } from 'node:url';
import { VIDEO_DETAIL_ENDPOINTS, observeVideoDetailRequest, readVideoDetailsApi, enrichVideoRow, videoPublishedDate } from './feigua-video-details.mjs';

function issue(message, code = 'FEIGUA_PAGE_CHANGED') {
  return Object.assign(new Error(message), { code, publicMessage: message });
}

export function isCollectionLoadingRequest(details, windowId, sourceOrigin) {
  if (windowId == null || details.webContentsId !== windowId || !isFeiguaDataUrl(details.url, sourceOrigin)) return false;
  if (details.resourceType === 'mainFrame') return true;
  try { return ['xhr', 'fetch'].includes(details.resourceType) && [...Object.values(FEIGUA_ENDPOINTS), ...Object.values(VIDEO_DETAIL_ENDPOINTS)].includes(new URL(details.url).pathname); }
  catch { return false; }
}

export function isFeiguaNavigation(value, loginEntryUrl = '') {
  if (isFeiguaDataUrl(value)) return true;
  if (isLoginEntryNavigation(value, loginEntryUrl)) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'open.weixin.qq.com' && !url.port && !url.username && !url.password; }
  catch { return false; }
}

export class FeiguaBrowser {
  constructor({ BrowserWindow, session, credentialStore, ipcMain }) {
    this.BrowserWindow = BrowserWindow; this.session = session;
    this.window = null; this.pending = new Set(); this.lastNetwork = 0;
    this.wasAuthenticated = false;
    this.loginTimer = null; this.loginWatchGeneration = 0;
    this.verificationTimer = null; this.verificationGeneration = 0; this.verificationWindow = null; this.verificationSeen = false;
    this.onAuthChange = null;
    this.loginEntryUrl = '';
    this.loginRelayOrigins = new Set();
    this.requestSequence = 0;
    this.rankingRequests = [];
    this.detailRequests = [];
    this.verifiedSourceOrigin = null;
    this.workspaceHint = null;
    this.credentialStore = credentialStore;
    this.credentialTimer = null;
    this.credentialContext = null;
    this.credentialPending = false;
    this.credentialMessage = null;
    this.ipcMain = ipcMain;
    this.credentialListener = (event, payload) => {
      event.returnValue = false;
      const window = this.window;
      if (!window || window.isDestroyed() || !event.senderFrame || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isLoginEntryNavigation(event.senderFrame.url, this.loginEntryUrl)) return;
      event.returnValue = this.rememberLoginCredentials(payload);
    };
    if (credentialStore && ipcMain) ipcMain.on('feigua-private-login-memory', this.credentialListener);
  }

  setLoginEntryUrl(value) {
    const next = normalizeLoginEntryUrl(value);
    if (next === this.loginEntryUrl) return;
    this.stopLoginWatch();
    this.stopVerificationWatch();
    this.wasAuthenticated = false;
    this.loginRelayOrigins.clear();
    this.verifiedSourceOrigin = null;
    this.workspaceHint = null;
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.loginEntryUrl = next;
  }

  sourceOrigin() { return this.verifiedSourceOrigin; }

  stopCredentialMemory() {
    clearInterval(this.credentialTimer);
    this.credentialTimer = null;
    this.credentialContext = null;
  }

  async runLoginMemory(window, command, credentials) {
    const entryUrl = this.loginEntryUrl;
    if (this.window !== window || window.isDestroyed() || !isLoginEntryNavigation(window.webContents.getURL(), entryUrl)) return { installed: false };
    const argument = { command, origin: new URL(entryUrl).origin, credentials };
    const result = await window.webContents.executeJavaScriptInIsolatedWorld(47, [{ code: `(() => { try { return (${loginFormMemory.toString()})(${JSON.stringify(argument)}); } catch { return { installed: false, failed: true }; } })()` }]);
    if (this.window !== window || window.isDestroyed() || this.loginEntryUrl !== entryUrl || !isLoginEntryNavigation(window.webContents.getURL(), entryUrl)) return { installed: false };
    return result;
  }

  async installCredentialMemory(window) {
    this.stopCredentialMemory();
    if (!this.credentialStore || !isLoginEntryNavigation(window.webContents.getURL(), this.loginEntryUrl)) return;
    const entryUrl = this.loginEntryUrl;
    try {
      let credentials;
      try { credentials = await this.credentialStore.read(entryUrl); }
      catch { this.credentialMessage = '已保存的登录信息暂时无法读取，请手动输入'; }
      if (this.loginEntryUrl !== entryUrl || this.window !== window || window.isDestroyed()) return;
      const result = await this.runLoginMemory(window, 'install', credentials);
      if (!result?.installed) return;
      this.credentialContext = { entryUrl, windowId: window.webContents.id, lastSequence: 0 };
      const tick = () => void this.captureCredentialChanges(window).catch(() => {
        this.credentialMessage = '登录信息未能加密保存，请手动输入；当前登录仍可继续';
      });
      this.credentialTimer = setInterval(tick, 300);
      this.credentialTimer.unref?.();
      tick();
    } catch { this.credentialMessage = '登录信息自动回填未完成，请手动输入'; }
  }

  async captureCredentialChanges(window) {
    if (this.credentialPending || !this.credentialContext) return;
    this.credentialPending = true;
    const entryUrl = this.credentialContext.entryUrl;
    try {
      const state = await this.runLoginMemory(window, 'take');
      if (!state?.installed || !state.credentials) return;
      if (this.credentialContext?.entryUrl === entryUrl) this.rememberLoginCredentials(state);
    } finally { this.credentialPending = false; }
  }

  rememberLoginCredentials(payload) {
    const context = this.credentialContext;
    if (!context || !this.credentialStore || this.loginEntryUrl !== context.entryUrl || !Number.isSafeInteger(payload?.sequence) || payload.sequence <= context.lastSequence || ![true, false].includes(payload.remember)) return false;
    const credentials = payload.remember ? normalizeLoginCredentials(payload.credentials) : null;
    if (payload.remember && !credentials) return false;
    context.lastSequence = payload.sequence;
    void this.credentialStore.write(context.entryUrl, credentials).then(() => {
      if (this.loginEntryUrl === context.entryUrl) this.credentialMessage = null;
    }).catch(() => { this.credentialMessage = '登录信息未能加密保存，请手动输入；当前登录仍可继续'; });
    return true;
  }

  setWorkspaceHint(value) {
    this.workspaceHint = normalizeWorkspaceHint(value, this.loginEntryUrl);
    if (this.workspaceHint) this.loginRelayOrigins.add(this.workspaceHint.origin);
  }

  async verifyWorkspace(auth, window = this.window, isCurrent = () => true) {
    if (!auth.authenticated) return;
    const valid = () => isCurrent() && window && this.window === window && !window.isDestroyed?.();
    if (!valid()) throw issue('登录检查已取消或窗口已关闭', 'FEIGUA_CANCELLED');
    if (!this.isRelayWorkspace(window.webContents.getURL())) return;
    const origin = new URL(window.webContents.getURL()).origin;
    const hint = normalizeWorkspaceHint({ entryUrl: this.loginEntryUrl, origin }, this.loginEntryUrl);
    if (JSON.stringify(hint) !== JSON.stringify(this.workspaceHint)) await this.onWorkspaceVerified?.(hint);
    if (!valid()) throw issue('登录检查已取消或窗口已关闭', 'FEIGUA_CANCELLED');
    this.workspaceHint = hint;
    this.verifiedSourceOrigin = origin;
  }

  isProviderUrl(url) { return isFeiguaDataUrl(url, this.verifiedSourceOrigin); }

  isRelayWorkspace(url) {
    try { return new URL(url).pathname.startsWith('/app/') && [...this.loginRelayOrigins].some(origin => isLoginEntryNavigation(url, origin)); }
    catch { return false; }
  }

  ensureWindow(show = false) {
    if (this.window && !this.window.isDestroyed()) { if (show) { this.window.show(); this.window.focus(); } return this.window; }
    if (!this.partition) {
      this.partition = this.session.fromPartition('persist:feigua-trends');
      this.partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      this.partition.setPermissionCheckHandler(() => false);
      this.partition.on('will-download', event => event.preventDefault());
      this.partition.webRequest.onBeforeRequest((details, callback) => {
        if (isCollectionLoadingRequest(details, this.window?.webContents.id, this.verifiedSourceOrigin)) { this.pending.add(details.id); this.lastNetwork = Date.now(); }
        if (this.window && details.webContentsId === this.window.webContents.id) {
          const request = observeFeiguaRequest(details, this.verifiedSourceOrigin);
          if (request) this.rankingRequests = [...this.rankingRequests, { ...request, sequence: ++this.requestSequence }].slice(-30);
          const detailRequest = observeVideoDetailRequest(details, this.verifiedSourceOrigin);
          if (detailRequest) this.detailRequests = [...this.detailRequests, { ...detailRequest, sequence: ++this.requestSequence }].slice(-30);
        }
        callback({});
      });
      const done = details => { if (this.pending.delete(details.id)) this.lastNetwork = Date.now(); };
      this.partition.webRequest.onCompleted(done);
      this.partition.webRequest.onErrorOccurred(done);
    }
    const window = new this.BrowserWindow({ width: 1320, height: 900, show, title: '飞瓜 · 热点采集',
      webPreferences: { session: this.partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        ...(this.credentialStore ? { preload: fileURLToPath(new URL('./feigua-login-preload.cjs', import.meta.url)) } : {}) } });
    this.window = window;
    window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.stopCredentialMemory();
    });
    window.webContents.on('did-finish-load', () => { void this.installCredentialMemory(window); });
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
    window.on('closed', () => { this.stopCredentialMemory(); this.stopLoginWatch(); if (this.window === window) { this.stopVerificationWatch(); this.window = null; } this.pending.clear(); this.rankingRequests = []; });
    return window;
  }

  async navigate(url) {
    if (!this.isProviderUrl(url)) throw issue('飞瓜来源地址不受支持');
    const window = this.ensureWindow();
    try { await window.loadURL(url); }
    catch { throw issue('飞瓜页面加载失败，请检查网络后重试', 'FEIGUA_NETWORK'); }
  }

  async execute(command, argument = {}, retryNotice = true) {
    if (!this.window || this.window.isDestroyed()) throw issue('飞瓜窗口已关闭，请重新打开');
    const window = this.window, generation = this.loginWatchGeneration, verificationGeneration = this.verificationGeneration;
    const isCurrent = () => this.window === window && !window.isDestroyed() && generation === this.loginWatchGeneration && verificationGeneration === this.verificationGeneration;
    const currentUrl = window.webContents.getURL();
    if (!this.isProviderUrl(currentUrl) && !this.isRelayWorkspace(currentUrl)) throw issue('请先完成飞瓜登录', 'FEIGUA_AUTH_REQUIRED');
    if (!this.isProviderUrl(currentUrl) && !['auth', 'accept-terms'].includes(command)) throw issue('请先核验代理工作台登录', 'FEIGUA_AUTH_REQUIRED');
    let result;
    try { result = await window.webContents.executeJavaScript(`(${feiguaPage.toString()})(${JSON.stringify(command)}, ${JSON.stringify(argument)})`); }
    catch { if (!isCurrent()) throw issue('页面读取已取消', 'FEIGUA_CANCELLED'); throw issue('飞瓜页面暂不可读取，请检查页面后重试'); }
    if (!isCurrent()) throw issue('页面读取已取消', 'FEIGUA_CANCELLED');
    if (result?.actionRequired === 'verification') {
      if (command === 'auth' && argument.passiveVerification === true) return result;
      this.requireVerification(true);
    }
    if (result?.authRequired) throw issue('飞瓜登录已失效，请重新登录', 'FEIGUA_AUTH_REQUIRED');
    if (command !== 'auth' && result?.actionRequired) {
      if (retryNotice) { await this.resolveAuth(); return this.execute(command, argument, false); }
      throw issue('飞瓜声明确认后仍未消失，已停止重复操作', 'FEIGUA_NOTICE_FAILED');
    }
    if (result?.error) throw issue(result.error);
    return result;
  }

  requireVerification(observed = false) {
    const message = '飞瓜需要图形验证，请在已打开的飞瓜窗口完成验证后重新采集';
    this.stopLoginWatch();
    this.ensureWindow(true);
    this.onAuthChange?.({ status: 'verification_required', message });
    this.startVerificationWatch(observed);
    throw issue(message, 'FEIGUA_VERIFICATION_REQUIRED');
  }

  stopVerificationWatch() {
    this.verificationGeneration++;
    clearInterval(this.verificationTimer);
    this.verificationTimer = null; this.verificationWindow = null; this.verificationSeen = false;
  }

  startVerificationWatch(observed = false) {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    if (this.verificationTimer && this.verificationWindow === window) { this.verificationSeen ||= observed; return; }
    this.stopVerificationWatch();
    this.verificationWindow = window;
    this.verificationSeen = observed;
    const generation = this.verificationGeneration;
    const isCurrent = () => generation === this.verificationGeneration && this.window === window && !window.isDestroyed();
    let pending = false;
    const check = async () => {
      if (pending || !isCurrent()) return;
      pending = true;
      try {
        // Observe only. Never navigate, accept a notice or submit a CAPTCHA.
        const auth = await this.execute('auth', { passiveVerification: true });
        if (!isCurrent()) return;
        if (auth.actionRequired === 'verification') this.verificationSeen = true;
        if (auth.actionRequired || auth.loading) return;
        if (auth.authenticated && this.verificationSeen) {
          await this.verifyWorkspace(auth, window, isCurrent);
          if (!isCurrent()) return;
          this.wasAuthenticated = true;
          window.hide?.(); // Keep the same verified window available for a retry.
          this.stopVerificationWatch();
          this.onAuthChange?.({ status: 'authenticated', message: '飞瓜页面已就绪，可以重新采集' });
        } else if (auth.loginVisible) {
          this.stopVerificationWatch();
          this.onAuthChange?.({ status: 'expired', message: '飞瓜登录已失效，请重新登录' });
        }
      } catch (error) {
        if (isCurrent() && error.code === 'FEIGUA_AUTH_REQUIRED') {
          this.stopVerificationWatch();
          this.onAuthChange?.({ status: 'expired', message: '飞瓜登录已失效，请重新登录' });
        }
      } finally { pending = false; }
    };
    this.verificationTimer = setInterval(() => void check(), 1000);
    this.verificationTimer.unref?.();
    void check();
  }

  async resolveAuth(signal, isCurrent = () => true) {
    const window = this.window;
    const assertCurrent = () => {
      if (signal?.aborted || !isCurrent() || !window || this.window !== window || window.isDestroyed?.()) throw issue('登录检查已取消或窗口已关闭', 'FEIGUA_CANCELLED');
    };
    assertCurrent();
    let auth = await this.execute('auth');
    assertCurrent();
    const deadline = Date.now() + 15000;
    while (auth.loading && Date.now() < deadline) {
      if (signal?.aborted) throw issue('已取消采集', 'FEIGUA_CANCELLED');
      await delay(300, undefined, { signal });
      assertCurrent();
      auth = await this.execute('auth');
      assertCurrent();
    }
    if (auth.loading) throw issue('飞瓜工作台尚未加载完成，请稍后重试', 'FEIGUA_NETWORK');
    await this.verifyWorkspace(auth, window, isCurrent);
    assertCurrent();
    if (auth.actionRequired !== 'terms') return auth;
    this.onAuthChange?.({ status: 'checking', message: '正在自动处理飞瓜声明…' });
    await this.execute('accept-terms');
    assertCurrent();
    for (let attempt = 0; attempt < 25; attempt++) {
      await delay(300, undefined, { signal });
      assertCurrent();
      auth = await this.execute('auth');
      assertCurrent();
      if (!auth.actionRequired) {
        await this.verifyWorkspace(auth, window, isCurrent);
        assertCurrent();
        return auth;
      }
    }
    throw issue('飞瓜声明确认未生效，请稍后重试', 'FEIGUA_NOTICE_FAILED');
  }

  async settle(signal, { navigationOnly = false } = {}) {
    const deadline = Date.now() + 25000;
    let stable = 0;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw issue('已取消采集', 'FEIGUA_CANCELLED');
      await delay(300, undefined, { signal });
      const ready = await this.execute('ready', { navigationOnly });
      if (ready.ready && !this.pending.size && Date.now() - this.lastNetwork > 600) stable++; else stable = 0;
      if (stable >= 2) return;
    }
    throw issue('飞瓜页面加载超时，本组未保存', 'FEIGUA_NETWORK');
  }

  async openLogin() {
    if (!this.loginEntryUrl) throw issue('请先配置并保存登录入口网址', 'FEIGUA_ENTRY_REQUIRED');
    this.stopLoginWatch();
    this.stopVerificationWatch();
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
    this.loginWatchGeneration++;
    if (this.loginTimer) clearInterval(this.loginTimer);
    this.loginTimer = null;
  }

  startLoginWatch() {
    this.stopVerificationWatch();
    this.stopLoginWatch();
    const generation = this.loginWatchGeneration;
    const enteredUrls = new Set();
    let pending = false;
    const check = async () => {
      if (pending || generation !== this.loginWatchGeneration || !this.window || this.window.isDestroyed()) return;
      pending = true;
      const loginWindow = this.window;
      const isCurrent = () => generation === this.loginWatchGeneration && this.window === loginWindow && !loginWindow.isDestroyed();
      try {
        if (!this.isProviderUrl(loginWindow.webContents.getURL()) && !this.isRelayWorkspace(loginWindow.webContents.getURL())) return;
        const auth = await this.resolveAuth(undefined, isCurrent);
        if (!isCurrent()) return;
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
        if (isCurrent() && error.code === 'FEIGUA_NOTICE_FAILED') {
          this.stopLoginWatch();
          this.onAuthChange?.({ status: 'error', message: error.publicMessage });
        }
      }
      finally { pending = false; }
    };
    this.loginTimer = setInterval(() => void check(), 1000);
    this.loginTimer.unref?.();
    void check();
  }

  async checkLogin() {
    // A task takes ownership of the shared window. Invalidate even an already
    // pending monitor so it cannot close the window when its old check resolves.
    const watching = Boolean(this.loginTimer || this.verificationTimer);
    this.stopVerificationWatch();
    this.stopLoginWatch();
    const generation = this.loginWatchGeneration;
    const isCurrent = () => generation === this.loginWatchGeneration;
    try {
      const auth = await this.checkLoginSession(isCurrent);
      if (!isCurrent()) throw issue('登录检查已取消', 'FEIGUA_CANCELLED');
      if (watching && auth.status === 'authenticated') {
        this.window?.hide?.();
        this.onAuthChange?.(auth);
      } else if (watching && this.window && !this.window.isDestroyed?.()) this.startLoginWatch();
      return auth;
    } catch (error) {
      if (watching && isCurrent() && this.window && !this.window.isDestroyed?.()) this.startLoginWatch();
      throw error;
    }
  }

  async checkLoginSession(isCurrent) {
    if (!this.loginEntryUrl && (!this.window || this.window.isDestroyed?.())) return { status: 'signed_out', message: '请先配置并保存登录入口网址' };
    this.ensureWindow();
    if (!isCurrent()) throw issue('登录检查已取消', 'FEIGUA_CANCELLED');
    const currentUrl = this.window.webContents.getURL();
    if (!currentUrl || this.workspaceHint && isLoginEntryNavigation(currentUrl, this.loginEntryUrl) && !this.isRelayWorkspace(currentUrl)) {
      if (!this.loginEntryUrl) return { status: 'signed_out', message: '请先配置并保存登录入口网址' };
      const workspaceOrigin = this.verifiedSourceOrigin || this.workspaceHint?.origin;
      try { await this.window.loadURL(workspaceOrigin ? `${workspaceOrigin}/app/` : this.loginEntryUrl); }
      catch { throw issue('登录入口加载失败，请检查网址和网络后重试', 'FEIGUA_NETWORK'); }
      if (!isCurrent()) throw issue('登录检查已取消', 'FEIGUA_CANCELLED');
    }
    if (!this.isProviderUrl(this.window.webContents.getURL()) && !this.isRelayWorkspace(this.window.webContents.getURL())) return this.wasAuthenticated || this.workspaceHint
      ? { status: 'expired', message: '飞瓜登录已失效，请点击“打开登录入口”重新登录' }
      : { status: 'signed_out', message: '请点击“打开登录入口”完成登录，并进入飞瓜工作台' };
    let auth = await this.resolveAuth(undefined, isCurrent);
    if (!auth.authenticated && auth.workspaceAvailable) {
      await this.enterWorkspace();
      if (!isCurrent()) throw issue('登录检查已取消', 'FEIGUA_CANCELLED');
      auth = await this.waitForWorkspace(undefined, isCurrent);
    }
    if (auth.authenticated) { this.wasAuthenticated = true; return { status: 'authenticated', message: '已登录飞瓜' }; }
    return { status: this.wasAuthenticated || this.workspaceHint ? 'expired' : 'signed_out', message: this.wasAuthenticated || this.workspaceHint ? '飞瓜登录已失效，请点击“打开登录入口”重新登录' : '请点击“打开登录入口”完成飞瓜登录' };
  }

  async enterWorkspace() {
    const entry = await this.execute('enter-workspace');
    if (entry.url) await this.navigate(entry.url);
  }

  async waitForWorkspace(signal, isCurrent = () => true) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw issue('已取消采集', 'FEIGUA_CANCELLED');
      const auth = await this.resolveAuth(signal, isCurrent);
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

  async chooseVideoPeriod(signal) {
    if (signal?.aborted) throw issue('已取消采集', 'FEIGUA_CANCELLED');
    const selected = await this.execute('video-period');
    if (selected.verified) return;
    if (selected.calendar) {
      if (signal?.aborted) throw issue('已取消采集', 'FEIGUA_CANCELLED');
      await this.execute('video-period', { phase: 'open' });
      await this.settle(signal);
      for (const phase of ['start', 'end']) {
        let picked = false;
        for (let attempt = 0; attempt < 13; attempt++) {
          if (signal?.aborted) throw issue('已取消采集', 'FEIGUA_CANCELLED');
          const result = await this.execute('video-period', { phase });
          if (result.picked) { picked = true; break; }
          if (!result.moved) throw issue('视频统计日期选择未完成');
          await this.settle(signal);
        }
        if (!picked) throw issue('视频统计日期跨度过大，请打开飞瓜核对时间周期');
      }
    }
    await this.settle(signal);
    if (!(await this.execute('video-period', { verify: true })).verified) throw issue('未能确认近7天统计日期，已停止本组采集');
  }

  async openSource(kind, signal) {
    const source = FEIGUA_SOURCES[kind];
    if (!source) throw issue('未知飞瓜来源');
    if (signal?.aborted) throw issue('已取消采集');
    // Discover routes from the signed-in application's menu; never guess API paths.
    await this.navigate(this.verifiedSourceOrigin ? `${this.verifiedSourceOrigin}/app/` : FEIGUA_HOME);
    const auth = await this.resolveAuth(signal);
    if (auth.workspaceAvailable) {
      await this.enterWorkspace();
      await this.waitForWorkspace(signal);
    }
    await this.settle(signal, { navigationOnly: true });
    const previousUrl = this.window.webContents.getURL();
    let destination = await this.execute('navigate', { labels: source.navigation });
    if (destination.expanded) { await this.settle(signal, { navigationOnly: true }); destination = await this.execute('navigate', { labels: source.navigation, expanded: true }); }
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
    const since = this.requestSequence;
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
      await this.chooseVideoPeriod(signal);
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
    // The fixed hotspot ranking is verified from the API's Rank/HotValueStr.
    let sorted = kind === 'hotspots';
    for (let attempt = 0; !sorted && attempt < 3; attempt++) {
      const result = await this.execute('sort', { label: source.sort, verify: attempt === 2 });
      if (result.verified) { sorted = true; break; }
      await this.settle(signal);
    }
    if (!sorted) throw issue('无法确认降序排列');
    const args = { kind, keyword, period: source.period };
    const context = await this.execute('capture-context', args);
    const capture = await this.readRanking(kind, context, since, signal);
    await this.settle(signal);
    const after = await this.execute('capture-context', args);
    if (JSON.stringify(after) !== JSON.stringify(context)) throw issue('接口返回期间页面筛选发生变化，本组未保存');
    // Read catalogs from this already visited source page. A separate catalog
    // navigation must never delay the first ranking after login.
    try {
      if (kind === 'music') {
        const catalog = await this.execute('music-tag-options');
        capture.musicTagOptions = catalog.options;
        capture.musicTagRestricted = catalog.restricted;
      } else if (kind === 'videos') capture.videoFilterOptions = await this.execute('video-filter-options');
    } catch (error) {
      if (error.code === 'FEIGUA_VERIFICATION_REQUIRED') throw error;
      capture.catalogWarning = '分类目录更新暂未完成，保留已有目录；本次数据仍按实际筛选校验';
    }
    if (kind === 'videos' && Array.isArray(capture.rows)) await this.enrichVideoFields(capture, signal);
    return capture;
  }

  async enrichVideoFields(capture, signal) {
    let blocked = null;
    for (let index = 0; index < Math.min(capture.rows.length, 5); index++) {
      if (signal?.aborted) throw issue('已取消采集', 'FEIGUA_CANCELLED');
      const row = capture.rows[index];
      if (row.videoUrl && !row.productsIncomplete && row.products?.length && row.products.every(product => product.commission && product.url)) continue;
      this.onVideoDetailProgress?.({ index: index + 1, total: Math.min(capture.rows.length, 5) });
      let detail = { state: blocked || 'lookup_failed' };
      const dateCode = videoPublishedDate(row.publishedAt);
      if (!blocked && row.url && dateCode && new URL(row.url).origin === new URL(capture.url).origin) {
        try {
          await this.navigate(row.url);
          await this.resolveAuth(signal);
          await this.settle(signal);
          const since = this.requestSequence;
          const response = this.window.webContents.executeJavaScript(`(${readVideoDetailsApi.toString()})(${JSON.stringify({ videoId: String(row.id), dateCode })})`);
          detail = await new Promise((resolve, reject) => {
            const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
            const abort = () => { cleanup(); reject(issue('已取消采集', 'FEIGUA_CANCELLED')); };
            const timer = setTimeout(() => { cleanup(); reject(issue('视频详情核验超时', 'FEIGUA_NETWORK')); }, 25000);
            signal?.addEventListener('abort', abort, { once: true });
            Promise.resolve(response).then(value => { cleanup(); resolve(value); }, () => { cleanup(); resolve({ state: 'lookup_failed' }); });
            if (signal?.aborted) abort();
          });
          if (detail?.state === 'verified') {
            const observed = this.detailRequests.filter(request => request.sequence > since);
            const verified = Object.values(VIDEO_DETAIL_ENDPOINTS).every(endpoint => observed.some(request => request.endpoint === endpoint && request.videoId === String(row.id) && request.dateCode === dateCode));
            if (!verified || new URL(this.window.webContents.getURL()).origin !== new URL(capture.url).origin) detail = { state: 'lookup_failed' };
          }
        } catch (error) {
          if (signal?.aborted) throw issue('已取消采集', 'FEIGUA_CANCELLED');
          if (error.code === 'FEIGUA_VERIFICATION_REQUIRED') throw error;
          detail = { state: error.code === 'FEIGUA_AUTH_REQUIRED' ? 'auth_required' : 'lookup_failed' };
        }
      }
      if (detail?.state === 'verification_required') this.requireVerification();
      if (['auth_required', 'quota_exhausted', 'rate_limited'].includes(detail?.state)) {
        blocked = detail.state;
        capture.detailStopReason = detail.state;
      }
      if (detail?.state === 'auth_required') this.onAuthChange?.({ status: 'expired', message: '飞瓜登录已失效，列表已保留，请重新登录后补充详情' });
      capture.rows[index] = enrichVideoRow(row, detail);
    }
  }

  async readRanking(kind, context, since, signal) {
    const observed = this.rankingRequests.filter(request => request.kind === kind && request.sequence > since).at(-1);
    if (!observed || observed.invalid) throw issue('未监听到本组榜单请求，请重新采集', 'FEIGUA_API_INVALID');
    const request = structuredClone(observed);
    // Replay exactly the observed query. Adding a date parameter to a default
    // week would turn it into a different (historical) provider operation.
    validateFeiguaRequest(kind, request, context);
    if (signal?.aborted) throw issue('已取消采集', 'FEIGUA_CANCELLED');
    const beforeApi = this.requestSequence;
    const result = this.window.webContents.executeJavaScript(`(${readFeiguaApi.toString()})(${JSON.stringify({ endpoint: request.endpoint, params: request.params })})`);
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(issue('飞瓜接口响应超时', 'FEIGUA_NETWORK')); }, 25000);
      const abort = () => { cleanup(); reject(issue('已取消采集', 'FEIGUA_CANCELLED')); };
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      signal?.addEventListener('abort', abort, { once: true });
      Promise.resolve(result).then(value => { cleanup(); resolve(value); }, () => { cleanup(); reject(issue('飞瓜接口请求失败，请检查网络或登录状态', 'FEIGUA_NETWORK')); });
      if (signal?.aborted) abort();
    });
    if (response?.code === 430) this.requireVerification();
    if (response?.error) throw issue(response.error, ['FEIGUA_NETWORK', 'FEIGUA_AUTH_REQUIRED', 'FEIGUA_PERMISSION', 'FEIGUA_RATE_LIMIT'].includes(response.errorCode) ? response.errorCode : 'FEIGUA_API_INVALID');
    const sent = this.rankingRequests.filter(record => record.kind === kind && record.sequence > beforeApi).at(-1);
    validateFeiguaRequest(kind, sent, context);
    if (JSON.stringify(Object.entries(sent.params).sort()) !== JSON.stringify(Object.entries(request.params).sort())) throw issue('实际发出的接口参数与任务不一致，本组未保存');
    return captureFeiguaResponse(kind, sent, context, response);
  }

  stop() { this.stopLoginWatch(); this.stopVerificationWatch(); this.window?.webContents.stop?.(); }
  dispose() { this.ipcMain?.removeListener('feigua-private-login-memory', this.credentialListener); this.stopCredentialMemory(); this.stopLoginWatch(); this.stopVerificationWatch(); this.window?.destroy(); this.window = null; this.rankingRequests = []; }
}
