import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { DouyinBrowserDownloader } from "./douyin-browser-downloader.mjs";

const PLATFORM_CONFIG = {
  douyin: {
    label: "抖音",
    loginUrl: "https://www.douyin.com/",
    cookieUrl: "https://www.douyin.com/",
    allowedDomains: ["douyin.com", "iesdouyin.com"],
    loginCookieNames: ["sessionid", "sessionid_ss", "sid_tt"],
  },
  xiaohongshu: {
    label: "小红书",
    loginUrl: "https://www.xiaohongshu.com/explore",
    cookieUrl: "https://www.xiaohongshu.com/",
    allowedDomains: ["xiaohongshu.com", "xhslink.com", "xhslink.cn"],
    loginCookieNames: ["web_session"],
  },
};

function configFor(platform) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) throw new Error("不支持的登录平台");
  return config;
}

function normalizedDomain(value) {
  return String(value || "").toLowerCase().replace(/^\./, "");
}

function domainMatches(domain, roots) {
  const candidate = normalizedDomain(domain);
  return roots.some((root) => candidate === root || candidate.endsWith(`.${root}`));
}

export function isAllowedDownloadLoginUrl(platform, input) {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:") return false;
    return domainMatches(url.hostname, configFor(platform).allowedDomains);
  } catch {
    return false;
  }
}

export function hasPlatformLoginCookie(platform, cookies) {
  const required = new Set(configFor(platform).loginCookieNames);
  return (Array.isArray(cookies) ? cookies : []).some((cookie) => required.has(String(cookie?.name || "")) && Boolean(cookie?.value));
}

export function cookiesToHeader(cookies) {
  const values = new Map();
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    const name = String(cookie?.name || "").trim();
    const value = String(cookie?.value || "").trim();
    if (name && value && !/[;\r\n]/.test(name) && !/[\r\n]/.test(value)) values.set(name, value);
  }
  return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function cookiesToNetscape(cookies) {
  const rows = ["# Netscape HTTP Cookie File", "# Generated locally by AI Media Library. Do not share this file."];
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    const domain = String(cookie?.domain || "").trim();
    const name = String(cookie?.name || "").trim();
    const value = String(cookie?.value || "").replace(/[\t\r\n]/g, "");
    if (!domain || !name || !value || /[\t\r\n]/.test(domain) || /[\t\r\n]/.test(name)) continue;
    const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
    const cookiePath = String(cookie?.path || "/").replace(/[\t\r\n]/g, "") || "/";
    const secure = cookie?.secure ? "TRUE" : "FALSE";
    const expires = Number.isFinite(Number(cookie?.expirationDate)) ? Math.max(0, Math.floor(Number(cookie.expirationDate))) : 0;
    rows.push([domain, includeSubdomains, cookiePath, secure, expires, name, value].join("\t"));
  }
  return `${rows.join("\n")}\n`;
}

export function browserUserAgent(chromeVersion, platform) {
  const system = platform === "win32" ? "Windows NT 10.0; Win64; x64" : "Macintosh; Intel Mac OS X 10_15_7";
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion || "136.0.0.0"} Safari/537.36`;
}

export class DownloadAuthService {
  constructor({ BrowserWindow, session, userDataPath, parentWindow = () => null, openExternal = () => {}, onStateChange = () => {}, chromeVersion = "", platform = process.platform }) {
    this.BrowserWindow = BrowserWindow;
    this.session = session;
    this.userDataPath = userDataPath;
    this.parentWindow = parentWindow;
    this.openExternal = openExternal;
    this.onStateChange = onStateChange;
    this.chromeVersion = chromeVersion;
    this.platform = platform;
    this.windows = new Map();
    this.observedPartitions = new Set();
    this.publishTimer = null;
    this.douyinBrowserDownloader = new DouyinBrowserDownloader({
      BrowserWindow,
      session,
      partition: this.partition("douyin"),
      userAgent: browserUserAgent(chromeVersion, platform),
    });
  }

  partition(platform) {
    configFor(platform);
    return `persist:ai-media-download-${platform}`;
  }

  platformSession(platform) {
    const partition = this.partition(platform);
    const target = this.session.fromPartition(partition, { cache: true });
    if (!this.observedPartitions.has(partition)) {
      this.observedPartitions.add(partition);
      target.cookies.on("changed", () => this.schedulePublish());
    }
    return target;
  }

  async platformCookies(platform) {
    const config = configFor(platform);
    const cookies = await this.platformSession(platform).cookies.get({ url: config.cookieUrl });
    return cookies.filter((cookie) => domainMatches(cookie.domain, config.allowedDomains));
  }

  async platformState(platform) {
    const config = configFor(platform);
    const cookies = await this.platformCookies(platform);
    const loggedIn = hasPlatformLoginCookie(platform, cookies);
    return {
      platform,
      label: config.label,
      loggedIn,
      status: loggedIn ? "logged-in" : "not-logged-in",
      cookieCount: cookies.length,
      message: loggedIn ? "已检测到登录 Cookie，实际可用性以下载结果为准" : "未登录，受限内容可能下载失败",
      checkedAt: new Date().toISOString(),
    };
  }

  async publicState() {
    const [douyin, xiaohongshu] = await Promise.all([
      this.platformState("douyin"),
      this.platformState("xiaohongshu"),
    ]);
    return { douyin, xiaohongshu };
  }

  schedulePublish() {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      void this.publicState().then(this.onStateChange).catch(() => {});
    }, 250);
  }

  async openLogin(platform) {
    const config = configFor(platform);
    const existing = this.windows.get(platform);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return this.publicState();
    }

    const loginWindow = new this.BrowserWindow({
      width: 1120,
      height: 780,
      minWidth: 760,
      minHeight: 560,
      parent: this.parentWindow() || undefined,
      modal: false,
      show: false,
      title: `${config.label}登录 · AI媒体库`,
      backgroundColor: "#ffffff",
      webPreferences: {
        partition: this.partition(platform),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        devTools: false,
      },
    });
    this.windows.set(platform, loginWindow);
    loginWindow.webContents.setUserAgent(browserUserAgent(this.chromeVersion, this.platform));
    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedDownloadLoginUrl(platform, url)) {
        void loginWindow.loadURL(url);
      } else if (/^https:/i.test(url)) {
        void this.openExternal(url);
      }
      return { action: "deny" };
    });
    loginWindow.webContents.on("will-navigate", (event, url) => {
      if (isAllowedDownloadLoginUrl(platform, url)) return;
      event.preventDefault();
      if (/^https:/i.test(url)) void this.openExternal(url);
    });
    loginWindow.webContents.on("did-navigate", () => this.schedulePublish());
    loginWindow.webContents.on("did-navigate-in-page", () => this.schedulePublish());
    loginWindow.once("ready-to-show", () => {
      loginWindow.show();
      loginWindow.focus();
    });
    loginWindow.on("closed", () => {
      this.windows.delete(platform);
      this.schedulePublish();
    });
    await loginWindow.loadURL(config.loginUrl);
    return this.publicState();
  }

  async prepareDownloadAuth(platform) {
    const cookies = await this.platformCookies(platform);
    const cookieHeader = cookiesToHeader(cookies);
    let cookieFile = "";
    if (cookies.length) {
      const authDirectory = path.join(this.userDataPath, "video-downloads", "auth");
      await mkdir(authDirectory, { recursive: true });
      cookieFile = path.join(authDirectory, `${platform}.cookies.txt`);
      await writeFile(cookieFile, cookiesToNetscape(cookies), { encoding: "utf8", mode: 0o600 });
      try { await chmod(cookieFile, 0o600); } catch { /* Windows does not expose POSIX modes. */ }
    }
    return {
      loggedIn: hasPlatformLoginCookie(platform, cookies),
      cookieHeader,
      cookieFile,
      userAgent: browserUserAgent(this.chromeVersion, this.platform),
    };
  }

  downloadDouyinWithBrowser(task, onProgress) {
    return this.douyinBrowserDownloader.download(task, onProgress);
  }

  shutdown() {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = null;
    this.douyinBrowserDownloader.shutdown();
    for (const loginWindow of this.windows.values()) {
      if (!loginWindow.isDestroyed()) loginWindow.close();
    }
    this.windows.clear();
  }
}
