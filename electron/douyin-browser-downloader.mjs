import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

const PAGE_TIMEOUT_MS = 30_000;
const MEDIA_TIMEOUT_MS = 25_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function douyinPageUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return url.protocol === "https:" && ["douyin.com", "iesdouyin.com"].some((root) => host === root || host.endsWith(`.${root}`));
  } catch {
    return false;
  }
}

function safeFilename(value, fallback) {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
}

function availableTarget(outputDirectory, stem) {
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const filename = `${stem}${suffix ? ` (${suffix})` : ""}.mp4`;
    const target = path.join(outputDirectory, filename);
    if (!existsSync(target)) return target;
  }
  throw new Error("无法为抖音视频生成不重复的文件名");
}

const MEDIA_PROBE_SCRIPT = `(() => {
  const candidates = [];
  const add = (value, score = 0) => {
    if (typeof value !== "string" || !/^https:\\/\\//i.test(value)) return;
    const decoded = value.replaceAll("\\u002F", "/").replaceAll("\\/", "/");
    const videoHint = /\\.mp4(?:$|[?#])|\\/video\\/|video_id=|mime_type=video|play_addr|playwm/i.test(decoded);
    if (videoHint) candidates.push({ url: decoded, score });
  };
  for (const video of document.querySelectorAll("video")) {
    add(video.currentSrc, 100);
    add(video.src, 95);
    for (const source of video.querySelectorAll("source")) add(source.src, 90);
    try { void video.play().catch(() => {}); } catch {}
  }
  for (const entry of performance.getEntriesByType("resource")) add(entry.name, 40);
  const unique = [...new Map(candidates.map((item) => [item.url, item])).values()];
  unique.sort((left, right) => right.score - left.score);
  return { url: unique[0]?.url || "", title: document.title || "" };
})()`;

export class DouyinBrowserDownloader {
  constructor({ BrowserWindow, session, partition, userAgent }) {
    this.BrowserWindow = BrowserWindow;
    this.session = session;
    this.partition = partition;
    this.userAgent = userAgent;
    this.activeWindows = new Set();
  }

  async download(task, onProgress = () => {}) {
    if (!douyinPageUrl(task?.url)) throw new Error("抖音浏览器兜底拒绝非官方链接");
    await mkdir(task.outputDirectory, { recursive: true });
    const browserWindow = this.createWindow();
    this.activeWindows.add(browserWindow);
    try {
      onProgress(8, "yt-dlp 解析失败，正在使用本机登录会话解析");
      await this.loadPage(browserWindow, task.url);
      const media = await this.waitForMedia(browserWindow, onProgress);
      const stem = safeFilename(media.title.replace(/\s*[-|_]抖音.*$/i, ""), `抖音作品_${String(task.id || Date.now()).slice(0, 8)}`);
      const target = availableTarget(task.outputDirectory, stem);
      await this.downloadMedia(browserWindow, media.url, target, onProgress);
      const metadata = await stat(target);
      if (!metadata.isFile() || metadata.size === 0) throw new Error("浏览器兜底下载结果为空");
      return { outputFiles: [target] };
    } finally {
      this.activeWindows.delete(browserWindow);
      if (!browserWindow.isDestroyed()) browserWindow.close();
    }
  }

  createWindow() {
    const browserWindow = new this.BrowserWindow({
      width: 960,
      height: 720,
      show: false,
      webPreferences: {
        partition: this.partition,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        devTools: false,
      },
    });
    browserWindow.webContents.setUserAgent(this.userAgent);
    browserWindow.webContents.setAudioMuted(true);
    browserWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const guard = (event, url) => {
      if (!douyinPageUrl(url)) event.preventDefault();
    };
    browserWindow.webContents.on("will-navigate", guard);
    browserWindow.webContents.on("will-redirect", guard);
    return browserWindow;
  }

  async loadPage(browserWindow, url) {
    let timer;
    try {
      await Promise.race([
        browserWindow.loadURL(url),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("抖音页面加载超时")), PAGE_TIMEOUT_MS); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async waitForMedia(browserWindow, onProgress) {
    const deadline = Date.now() + MEDIA_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = await browserWindow.webContents.executeJavaScript(MEDIA_PROBE_SCRIPT, true).catch(() => null);
      if (result?.url) return result;
      onProgress(12, "已打开抖音作品页，正在等待视频流");
      await delay(500);
    }
    throw new Error("未从抖音页面读取到可下载的视频流，请重新登录或完成平台验证");
  }

  downloadMedia(browserWindow, url, target, onProgress) {
    const targetSession = this.session.fromPartition(this.partition, { cache: true });
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        targetSession.removeListener("will-download", handleDownload);
      };
      const handleDownload = (_event, item, sourceWebContents) => {
        if (sourceWebContents && sourceWebContents !== browserWindow.webContents) return;
        item.setSavePath(target);
        item.on("updated", () => {
          const total = Number(item.getTotalBytes());
          const received = Number(item.getReceivedBytes());
          const percent = total > 0 ? 15 + Math.round((received / total) * 80) : 50;
          onProgress(Math.min(95, percent), "正在通过本机登录会话下载抖音视频");
        });
        item.once("done", (_doneEvent, state) => {
          cleanup();
          if (state === "completed") resolve();
          else reject(new Error(`抖音浏览器兜底下载失败：${state}`));
        });
      };
      targetSession.on("will-download", handleDownload);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("抖音浏览器兜底下载超时"));
      }, DOWNLOAD_TIMEOUT_MS);
      try {
        browserWindow.webContents.downloadURL(url, { headers: { Referer: "https://www.douyin.com/" } });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  shutdown() {
    for (const browserWindow of this.activeWindows) {
      if (!browserWindow.isDestroyed()) browserWindow.close();
    }
    this.activeWindows.clear();
  }
}
