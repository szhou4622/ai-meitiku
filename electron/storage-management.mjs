import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const STORAGE_SETTINGS_FILE = "storage-management.json";
export const DEFAULT_STORAGE_SETTINGS = Object.freeze({
  version: 1,
  autoCleanupClassifierCache: true,
  classifierRetentionHours: 24,
  lastAutomaticCleanupAt: "",
});

const browserCacheRelativePaths = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  path.join("Shared Dictionary", "cache"),
];

const updatePackageExtensions = new Set([".exe", ".msi", ".dmg", ".pkg", ".zip", ".7z", ".blockmap"]);

function normalizedSettings(value = {}) {
  const retention = Number(value.classifierRetentionHours);
  return {
    ...DEFAULT_STORAGE_SETTINGS,
    autoCleanupClassifierCache: value.autoCleanupClassifierCache !== false,
    classifierRetentionHours: [24, 72, 168, 720].includes(retention) ? retention : 24,
    lastAutomaticCleanupAt: typeof value.lastAutomaticCleanupAt === "string" ? value.lastAutomaticCleanupAt : "",
  };
}

async function pathInfo(targetPath) {
  try {
    return await lstat(targetPath);
  } catch {
    return null;
  }
}

export async function directorySize(targetPath) {
  const info = await pathInfo(targetPath);
  if (!info) return 0;
  if (!info.isDirectory() || info.isSymbolicLink()) return info.size;
  let total = 0;
  const entries = await readdir(targetPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) total += await directorySize(path.join(targetPath, entry.name));
  return total;
}

async function newestModifiedTime(targetPath) {
  const info = await pathInfo(targetPath);
  if (!info) return 0;
  if (!info.isDirectory() || info.isSymbolicLink()) return info.mtimeMs;
  let newest = info.mtimeMs;
  const entries = await readdir(targetPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) newest = Math.max(newest, await newestModifiedTime(path.join(targetPath, entry.name)));
  return newest;
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isInside(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class StorageManagementService {
  constructor({
    userDataPath,
    getVideoDownloadDirectory = () => path.join(userDataPath, "video-downloads", "media"),
    getVideoDownloadFiles = () => [],
    isClassifierBusy = () => false,
    getClassifierRetryCount = async () => 0,
    clearBrowserCache = async () => {},
    getProtectedUpdatePath = () => "",
    now = () => new Date(),
  }) {
    this.userDataPath = path.resolve(userDataPath);
    this.settingsPath = path.join(this.userDataPath, STORAGE_SETTINGS_FILE);
    this.getVideoDownloadDirectory = getVideoDownloadDirectory;
    this.getVideoDownloadFiles = getVideoDownloadFiles;
    this.isClassifierBusy = isClassifierBusy;
    this.getClassifierRetryCount = getClassifierRetryCount;
    this.clearBrowserCache = clearBrowserCache;
    this.getProtectedUpdatePath = getProtectedUpdatePath;
    this.now = now;
    this.settings = { ...DEFAULT_STORAGE_SETTINGS };
  }

  classifierHandoffsRoot() { return path.join(this.userDataPath, "classifier-handoffs"); }
  classifierNetworkRoot() { return path.join(this.userDataPath, "classifier-network-cache"); }
  classifierJobsRoot() { return path.join(this.userDataPath, "classifier-jobs"); }
  voiceRoot() { return path.join(this.userDataPath, "voice-clone"); }
  updatesRoot() { return path.join(this.userDataPath, "updates"); }

  async initialize() {
    this.settings = normalizedSettings(await readJson(this.settingsPath) || {});
    if (!await pathInfo(this.settingsPath)) await atomicWriteJson(this.settingsPath, this.settings);
    await this.abandonPreparedHandoffs();
    await this.runAutomaticCleanup({ force: false });
    return this.snapshot();
  }

  async saveSettings(patch = {}) {
    this.settings = normalizedSettings({ ...this.settings, ...patch });
    await atomicWriteJson(this.settingsPath, this.settings);
    return this.snapshot();
  }

  async classifierCleanupBlocked() {
    if (this.isClassifierBusy()) return "有打标或切割任务正在运行";
    if (await this.getClassifierRetryCount() > 0) return "存在等待重跑的失败任务";
    return "";
  }

  async markClassifierHandoff(folderPath, status) {
    const handoffsRoot = this.classifierHandoffsRoot();
    if (!folderPath || !isInside(handoffsRoot, folderPath)) return false;
    const relative = path.relative(handoffsRoot, path.resolve(folderPath));
    const [handoffName] = relative.split(path.sep);
    if (!handoffName) return false;
    const handoffRoot = path.join(handoffsRoot, handoffName);
    if (!await pathInfo(handoffRoot)) return false;
    const current = await readJson(path.join(handoffRoot, ".handoff.json")) || {};
    const timestamp = this.now().toISOString();
    await atomicWriteJson(path.join(handoffRoot, ".handoff.json"), {
      version: 1,
      createdAt: current.createdAt || timestamp,
      status,
      updatedAt: timestamp,
      ...(status === "completed" ? { completedAt: timestamp } : {}),
    });
    return true;
  }

  async createClassifierHandoffRecord(handoffRoot) {
    if (!isInside(this.classifierHandoffsRoot(), handoffRoot)) throw new Error("打标缓存路径不安全");
    await this.abandonPreparedHandoffs();
    const timestamp = this.now().toISOString();
    await atomicWriteJson(path.join(handoffRoot, ".handoff.json"), {
      version: 1,
      createdAt: timestamp,
      status: "prepared",
      updatedAt: timestamp,
    });
  }

  async abandonPreparedHandoffs() {
    const entries = await readdir(this.classifierHandoffsRoot(), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const markerPath = path.join(this.classifierHandoffsRoot(), entry.name, ".handoff.json");
      const marker = await readJson(markerPath);
      if (marker?.status !== "prepared") continue;
      await atomicWriteJson(markerPath, { ...marker, status: "abandoned", updatedAt: this.now().toISOString() });
    }
  }

  async clearClassifierCache({ automatic = false } = {}) {
    const blockedReason = await this.classifierCleanupBlocked();
    if (blockedReason) return { ok: false, blocked: true, message: `${blockedReason}，已保留相关缓存。`, reclaimedBytes: 0 };
    const before = await directorySize(this.classifierHandoffsRoot()) + await directorySize(this.classifierNetworkRoot());
    if (!automatic) {
      const handoffs = await readdir(this.classifierHandoffsRoot(), { withFileTypes: true }).catch(() => []);
      for (const entry of handoffs) {
        if (!entry.isDirectory()) continue;
        const handoffRoot = path.join(this.classifierHandoffsRoot(), entry.name);
        const marker = await readJson(path.join(handoffRoot, ".handoff.json"));
        if (["prepared", "running", "retry_pending"].includes(marker?.status)) continue;
        await rm(handoffRoot, { recursive: true, force: true });
      }
      await rm(this.classifierNetworkRoot(), { recursive: true, force: true });
      const after = await directorySize(this.classifierHandoffsRoot());
      return { ok: true, reclaimedBytes: Math.max(0, before - after), message: "可安全删除的打标临时缓存已清理" };
    }
    const cutoff = this.now().getTime() - this.settings.classifierRetentionHours * 60 * 60 * 1000;
    let reclaimedBytes = 0;
    const handoffs = await readdir(this.classifierHandoffsRoot(), { withFileTypes: true }).catch(() => []);
    for (const entry of handoffs) {
      if (!entry.isDirectory()) continue;
      const handoffRoot = path.join(this.classifierHandoffsRoot(), entry.name);
      const marker = await readJson(path.join(handoffRoot, ".handoff.json"));
      if (!["completed", "abandoned"].includes(marker?.status)) continue;
      const completedAt = Date.parse(marker.completedAt || marker.updatedAt || "");
      if (!Number.isFinite(completedAt) || completedAt > cutoff) continue;
      reclaimedBytes += await directorySize(handoffRoot);
      await rm(handoffRoot, { recursive: true, force: true });
    }
    const networkBatches = await readdir(this.classifierNetworkRoot(), { withFileTypes: true }).catch(() => []);
    for (const entry of networkBatches) {
      if (!entry.isDirectory()) continue;
      const batchRoot = path.join(this.classifierNetworkRoot(), entry.name);
      if (await newestModifiedTime(batchRoot) > cutoff) continue;
      reclaimedBytes += await directorySize(batchRoot);
      await rm(batchRoot, { recursive: true, force: true });
    }
    return { ok: true, reclaimedBytes, message: reclaimedBytes ? "已自动清理过期的已完成任务缓存" : "没有需要自动清理的缓存" };
  }

  async clearUpdatePackages() {
    const protectedPath = path.resolve(this.getProtectedUpdatePath() || path.join(this.updatesRoot(), "__none__"));
    let reclaimedBytes = 0;
    const entries = await readdir(this.updatesRoot(), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !updatePackageExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      const targetPath = path.join(this.updatesRoot(), entry.name);
      if (path.resolve(targetPath) === protectedPath) continue;
      reclaimedBytes += (await stat(targetPath).catch(() => ({ size: 0 }))).size;
      await rm(targetPath, { force: true });
    }
    return { ok: true, reclaimedBytes, message: "旧版本更新安装包已清理" };
  }

  async clearWebCache() {
    const before = await this.browserCacheSize();
    await this.clearBrowserCache();
    for (const relativePath of browserCacheRelativePaths) {
      await rm(path.join(this.userDataPath, relativePath), { recursive: true, force: true }).catch(() => {});
    }
    const after = await this.browserCacheSize();
    return { ok: true, reclaimedBytes: Math.max(0, before - after), message: "网页缓存已清理，平台登录状态已保留" };
  }

  async browserCacheSize() {
    let total = 0;
    for (const relativePath of browserCacheRelativePaths) total += await directorySize(path.join(this.userDataPath, relativePath));
    return total;
  }

  async clear(category) {
    if (category === "classifier") return this.clearClassifierCache({ automatic: false });
    if (category === "updates") return this.clearUpdatePackages();
    if (category === "web") return this.clearWebCache();
    throw new Error("不支持清理该类数据");
  }

  async runAutomaticCleanup({ force = false } = {}) {
    if (!this.settings.autoCleanupClassifierCache) return { ok: true, skipped: true, reason: "disabled" };
    const previous = Date.parse(this.settings.lastAutomaticCleanupAt || "");
    if (!force && Number.isFinite(previous) && this.now().getTime() - previous < 24 * 60 * 60 * 1000) {
      return { ok: true, skipped: true, reason: "not_due" };
    }
    const result = await this.clearClassifierCache({ automatic: true });
    if (!result.blocked) {
      this.settings = { ...this.settings, lastAutomaticCleanupAt: this.now().toISOString() };
      await atomicWriteJson(this.settingsPath, this.settings);
    }
    return result;
  }

  async snapshot() {
    const videoDirectory = path.resolve(this.getVideoDownloadDirectory() || path.join(this.userDataPath, "video-downloads", "media"));
    const videoDirectoryInsideAppData = isInside(this.userDataPath, videoDirectory);
    const trackedVideoFiles = [...new Set(this.getVideoDownloadFiles())]
      .filter((filePath) => typeof filePath === "string" && path.isAbsolute(filePath) && isInside(videoDirectory, filePath));
    const paths = {
      classifier: [this.classifierHandoffsRoot(), this.classifierNetworkRoot()],
      // The app-owned default directory can be measured in full. For a user-selected
      // broad folder, count only files recorded by this app and never scan unrelated data.
      video: videoDirectoryInsideAppData ? [videoDirectory] : trackedVideoFiles,
      voice: [path.join(this.voiceRoot(), "uploads"), path.join(this.voiceRoot(), "outputs")],
      updates: [this.updatesRoot()],
      web: browserCacheRelativePaths.map((relativePath) => path.join(this.userDataPath, relativePath)),
      localModel: [path.join(this.userDataPath, "Service Worker", "CacheStorage")],
      platformLogin: [path.join(this.userDataPath, "Partitions")],
      logs: [path.join(this.userDataPath, "diagnostic-logs")],
    };
    const sizeOf = async (items) => {
      let total = 0;
      for (const item of items) total += await directorySize(item);
      return total;
    };
    const categories = {};
    for (const [key, items] of Object.entries(paths)) categories[key] = { bytes: await sizeOf(items), path: items[0] };
    categories.voice.path = this.voiceRoot();
    const blockedReason = await this.classifierCleanupBlocked();
    return {
      settings: { ...this.settings },
      categories,
      totalBytes: Object.values(categories).reduce((sum, item) => sum + item.bytes, 0),
      classifierCleanupBlockedReason: blockedReason,
      videoDirectory,
      videoDirectoryInsideAppData,
    };
  }
}
