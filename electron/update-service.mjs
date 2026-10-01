import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";

export const UPDATE_APP_NAME = "ai-media-library";
export const UPDATE_SOFTWARE_NAME = "AI媒体库";
export const UPDATE_BASE_URL = "https://update.dadaozixun.com";
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_STARTUP_DELAY_MS = 8_000;

const RESPONSE_WRAPPERS = ["data", "result", "update"];
const DOWNLOAD_EXTENSIONS = {
  win32: new Set([".exe", ".msi"]),
  darwin: new Set([".dmg", ".pkg"]),
};

export function updatePlatformKey(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") return "windows_x64";
  if (platform === "darwin" && arch === "arm64") return "mac_arm64";
  if (platform === "darwin" && arch === "x64") return "mac_x64";
  return "";
}

function unwrapUpdateResponse(value) {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;
    const wrapper = RESPONSE_WRAPPERS.find((key) => current[key] && typeof current[key] === "object" && !Array.isArray(current[key]));
    if (!wrapper) break;
    current = current[wrapper];
  }
  return current && typeof current === "object" && !Array.isArray(current) ? current : {};
}

function selectedDownloadUrl(source, platformKey) {
  const direct = source.download_url;
  if (typeof direct === "string") return direct.trim();
  if (direct && typeof direct === "object") return String(direct[platformKey] || "").trim();
  const urls = source.download_urls;
  if (urls && typeof urls === "object") return String(urls[platformKey] || "").trim();
  return "";
}

function selectedPlatformValue(value, platformKey) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value[platformKey];
  return value;
}

function normalizedReleaseNotes(source) {
  const notes = source.release_notes ?? source.notes ?? "";
  if (Array.isArray(notes)) return notes.map((note) => String(note).trim()).filter(Boolean).join("\n");
  return String(notes).trim();
}

export function normalizeUpdateResponse(payload, { appName = UPDATE_APP_NAME, platformKey } = {}) {
  const source = unwrapUpdateResponse(payload);
  if (source.app_name && String(source.app_name).trim() !== appName) return null;
  const version = String(source.version || source.latest_version || "").trim().replace(/^v(?=\d)/i, "");
  const downloadUrl = selectedDownloadUrl(source, platformKey);
  if (!version || !downloadUrl) return null;
  return {
    app_name: String(source.app_name || appName).trim() || appName,
    version,
    force_update: [true, 1, "true"].includes(source.force_update ?? source.force),
    release_notes: normalizedReleaseNotes(source),
    sha256: String(selectedPlatformValue(source.sha256, platformKey) || "").trim().toLowerCase(),
    file_size: Math.max(0, Number(selectedPlatformValue(source.file_size, platformKey)) || 0),
    download_url: downloadUrl,
    published_at: String(source.published_at || "").trim(),
  };
}

export function compareUpdateVersions(currentVersion, targetVersion, { allowPrerelease = false } = {}) {
  const current = semver.valid(String(currentVersion || "").trim().replace(/^v(?=\d)/i, ""));
  const target = semver.valid(String(targetVersion || "").trim().replace(/^v(?=\d)/i, ""));
  if (!current || !target) return { valid: false, newer: false, reason: "invalid_version" };
  if (!allowPrerelease && semver.prerelease(target)) return { valid: true, newer: false, reason: "prerelease_disabled" };
  return { valid: true, newer: semver.gt(target, current), reason: semver.gt(target, current) ? "newer" : "not_newer" };
}

export function sanitizeUpdateFileName(downloadUrl, { appName = UPDATE_APP_NAME, version, platform = process.platform } = {}) {
  let candidate = "";
  try {
    candidate = decodeURIComponent(new URL(downloadUrl).pathname.split("/").pop() || "");
  } catch {
    candidate = "";
  }
  candidate = path.basename(candidate).replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]/g, "-").replace(/\.{2,}/g, ".");
  const extension = path.extname(candidate).toLowerCase();
  const allowed = DOWNLOAD_EXTENSIONS[platform] || new Set();
  if (!allowed.has(extension)) throw new Error("更新服务器返回的安装包格式不适用于当前系统");
  const safeBase = candidate.slice(0, -extension.length).replace(/^\.+/, "").slice(0, 120) || `${appName}-${version}`;
  return `${safeBase}${extension}`;
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function todayKey(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function safeErrorCode(error) {
  if (error?.name === "AbortError") return "download_cancelled";
  if (error?.code && /^[a-z0-9_-]{1,80}$/i.test(error.code)) return error.code;
  return "update_failed";
}

export class UpdateService {
  constructor({
    appName = UPDATE_APP_NAME,
    softwareName = UPDATE_SOFTWARE_NAME,
    baseUrl = UPDATE_BASE_URL,
    currentVersion,
    platform = process.platform,
    arch = process.arch,
    userDataPath,
    fetchImpl = globalThis.fetch,
    openInstaller,
    quitApp,
    isBusy = () => false,
    allowPrerelease = false,
    now = () => new Date(),
    onStateChange = () => {},
  }) {
    this.appName = appName;
    this.softwareName = softwareName;
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.currentVersion = currentVersion;
    this.platform = platform;
    this.arch = arch;
    this.platformKey = updatePlatformKey(platform, arch);
    this.userDataPath = userDataPath;
    this.updatesPath = path.join(userDataPath, "updates");
    this.statePath = path.join(this.updatesPath, "update-state.json");
    this.logPath = path.join(this.updatesPath, "update.log");
    this.fetchImpl = fetchImpl;
    this.openInstaller = openInstaller;
    this.quitApp = quitApp;
    this.isBusy = isBusy;
    this.allowPrerelease = allowPrerelease;
    this.now = now;
    this.onStateChange = onStateChange;
    this.abortController = null;
    this.latest = null;
    this.downloadedPath = "";
    this.reminders = {};
    this.installOnQuit = false;
    this.lastCheckedAt = "";
    this.state = {
      phase: "idle",
      currentVersion,
      targetVersion: "",
      forceUpdate: false,
      releaseNotes: "",
      fileSize: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      message: "尚未检查更新",
      checkedAt: "",
      publishedAt: "",
      updateType: "none",
      shouldPrompt: false,
      canRetry: false,
      installOnQuit: false,
      platform: this.platformKey,
    };
  }

  async initialize() {
    await mkdir(this.updatesPath, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.statePath, "utf8"));
      this.latest = saved.latest || null;
      this.downloadedPath = typeof saved.downloadedPath === "string" ? saved.downloadedPath : "";
      this.reminders = saved.reminders && typeof saved.reminders === "object" ? saved.reminders : {};
      this.installOnQuit = Boolean(saved.installOnQuit);
      this.lastCheckedAt = typeof saved.lastCheckedAt === "string" ? saved.lastCheckedAt : "";
      if (this.latest) {
        const comparison = compareUpdateVersions(this.currentVersion, this.latest.version, { allowPrerelease: this.allowPrerelease });
        if (!comparison.valid || !comparison.newer) {
          const obsoletePath = this.downloadedPath;
          this.latest = null;
          this.downloadedPath = "";
          this.installOnQuit = false;
          this.lastCheckedAt = this.now().toISOString();
          this.setState({
            phase: "up-to-date",
            targetVersion: "",
            forceUpdate: false,
            releaseNotes: "",
            fileSize: 0,
            downloadedBytes: 0,
            totalBytes: 0,
            bytesPerSecond: 0,
            message: "当前已是最新版本",
            checkedAt: this.lastCheckedAt,
            publishedAt: "",
            updateType: "none",
            shouldPrompt: false,
            canRetry: false,
            installOnQuit: false,
          });
          if (obsoletePath && path.dirname(path.resolve(obsoletePath)) === path.resolve(this.updatesPath)) {
            await unlink(obsoletePath).catch(() => {});
          }
        } else {
          const downloaded = this.downloadedPath
            ? await this.verifyDownloadedPackage(this.latest, this.downloadedPath, { removeInvalid: true })
            : false;
          if (!downloaded) this.downloadedPath = "";
          this.setState({
            phase: downloaded ? "downloaded" : "available",
            targetVersion: this.latest.version,
            forceUpdate: this.latest.force_update,
            releaseNotes: this.latest.release_notes,
            fileSize: this.latest.file_size,
            downloadedBytes: downloaded ? this.latest.file_size : 0,
            totalBytes: this.latest.file_size,
            message: downloaded ? `新版本 ${this.latest.version} 已下载并通过校验` : `发现新版本 ${this.latest.version}`,
            publishedAt: this.latest.published_at,
            updateType: this.latest.force_update ? "important" : "normal",
            shouldPrompt: this.latest.force_update || this.reminders[this.latest.version] !== todayKey(this.now()),
            installOnQuit: downloaded && this.installOnQuit,
            checkedAt: this.lastCheckedAt,
          });
          if (!downloaded) this.installOnQuit = false;
        }
      }
    } catch {
      // Missing or malformed recovery metadata must never block application startup.
    }
    await this.persist();
    return this.publicState();
  }

  publicState() {
    return { ...this.state };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch, currentVersion: this.currentVersion, platform: this.platformKey };
    this.onStateChange(this.publicState());
  }

  async persist() {
    const snapshot = {
      version: 1,
      latest: this.latest,
      downloadedPath: this.downloadedPath,
      reminders: this.reminders,
      installOnQuit: this.installOnQuit,
      lastCheckedAt: this.lastCheckedAt,
    };
    await writeFile(this.statePath, JSON.stringify(snapshot, null, 2), "utf8");
  }

  async logFailure({ stage, targetVersion = "", httpStatus = 0, sha256Match = null, error }) {
    const record = {
      timestamp: this.now().toISOString(),
      current_version: this.currentVersion,
      target_version: targetVersion,
      platform: this.platformKey,
      arch: this.arch,
      stage,
      http_status: Number(httpStatus) || 0,
      sha256_match: sha256Match,
      error_code: safeErrorCode(error),
    };
    await appendFile(this.logPath, `${JSON.stringify(record)}\n`, "utf8").catch(() => {});
  }

  checkUrl() {
    const url = new URL(`${this.baseUrl}/api/update/latest`);
    url.searchParams.set("app_name", this.appName);
    url.searchParams.set("current_version", this.currentVersion);
    url.searchParams.set("platform", this.platformKey);
    url.searchParams.set("arch", this.arch);
    return url;
  }

  async check({ manual = false } = {}) {
    const previousCheckTime = Date.parse(this.lastCheckedAt);
    if (!manual && Number.isFinite(previousCheckTime) && this.now().getTime() - previousCheckTime < UPDATE_CHECK_INTERVAL_MS) {
      return this.publicState();
    }
    if (!this.platformKey) {
      this.setState({ phase: "up-to-date", message: "当前暂无适用于此设备的更新", checkedAt: this.now().toISOString(), shouldPrompt: false });
      return this.publicState();
    }
    this.setState({ phase: "checking", message: "正在检查更新…", canRetry: false, shouldPrompt: false });
    let response;
    try {
      response = await this.fetchImpl(this.checkUrl(), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (response.status === 404) return this.finishNoUpdate(manual);
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.code = "update_check_http_error";
        await this.logFailure({ stage: "check", httpStatus: response.status, error });
        throw error;
      }
      const normalized = normalizeUpdateResponse(await response.json().catch(() => ({})), { appName: this.appName, platformKey: this.platformKey });
      if (!normalized) return this.finishNoUpdate(manual);
      const comparison = compareUpdateVersions(this.currentVersion, normalized.version, { allowPrerelease: this.allowPrerelease });
      if (!comparison.valid) {
        const error = new Error("更新服务返回的版本号格式不正确");
        error.code = "invalid_update_version";
        await this.logFailure({ stage: "check", targetVersion: normalized.version, error });
        throw error;
      }
      if (!comparison.newer) return this.finishNoUpdate(manual);
      const parsedUrl = new URL(normalized.download_url);
      if (parsedUrl.protocol !== "https:") throw Object.assign(new Error("更新下载地址必须使用 HTTPS"), { code: "unsafe_download_url" });
      sanitizeUpdateFileName(normalized.download_url, { appName: this.appName, version: normalized.version, platform: this.platform });
      this.latest = normalized;
      this.lastCheckedAt = this.now().toISOString();
      const remindedToday = this.reminders[normalized.version] === todayKey(this.now());
      const cached = this.downloadedPath && await this.verifyDownloadedPackage(normalized, this.downloadedPath, { removeInvalid: true });
      this.setState({
        phase: cached ? "downloaded" : "available",
        targetVersion: normalized.version,
        forceUpdate: normalized.force_update,
        releaseNotes: normalized.release_notes,
        fileSize: normalized.file_size,
        downloadedBytes: cached ? normalized.file_size : 0,
        totalBytes: normalized.file_size,
        bytesPerSecond: 0,
        message: cached ? `新版本 ${normalized.version} 已下载并通过校验` : `发现新版本 ${normalized.version}`,
        checkedAt: this.lastCheckedAt,
        publishedAt: normalized.published_at,
        updateType: normalized.force_update ? "important" : "normal",
        shouldPrompt: normalized.force_update || manual || !remindedToday,
        canRetry: false,
        installOnQuit: this.installOnQuit,
      });
      await this.persist();
      return this.publicState();
    } catch (error) {
      if (error?.code === "unsafe_download_url") await this.logFailure({ stage: "check", targetVersion: this.latest?.version || "", error });
      this.lastCheckedAt = this.now().toISOString();
      this.setState({
        phase: "error",
        message: manual ? (error instanceof Error ? error.message : "检查更新失败") : "自动检查暂时不可用",
        checkedAt: this.lastCheckedAt,
        shouldPrompt: false,
        canRetry: manual,
      });
      await this.persist();
      return this.publicState();
    }
  }

  async finishNoUpdate(manual) {
    this.latest = null;
    this.downloadedPath = "";
    this.installOnQuit = false;
    this.lastCheckedAt = this.now().toISOString();
    this.setState({
      phase: "up-to-date",
      targetVersion: "",
      forceUpdate: false,
      releaseNotes: "",
      fileSize: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      message: manual ? "当前暂无适用于此设备的更新" : "当前已是最新版本",
      checkedAt: this.lastCheckedAt,
      updateType: "none",
      shouldPrompt: false,
      canRetry: false,
      installOnQuit: false,
    });
    await this.persist();
    return this.publicState();
  }

  async verifyDownloadedPackage(update, filePath, { removeInvalid = false } = {}) {
    if (!/^[a-f0-9]{64}$/i.test(update?.sha256 || "")) return false;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return false;
      const digest = await sha256File(filePath);
      if (digest.toLowerCase() === update.sha256.toLowerCase()) return true;
      if (removeInvalid) await unlink(filePath).catch(() => {});
    } catch {
      // A missing cached installer simply requires another download.
    }
    return false;
  }

  async download() {
    if (!this.latest) throw new Error("当前没有可下载的更新");
    if (this.state.phase === "downloading") return this.publicState();
    if (!/^[a-f0-9]{64}$/i.test(this.latest.sha256)) {
      const error = Object.assign(new Error("更新配置不完整：缺少有效的 SHA256，无法安全安装"), { code: "sha256_missing" });
      await this.logFailure({ stage: "verify", targetVersion: this.latest.version, sha256Match: false, error });
      this.setState({ phase: "error", message: error.message, canRetry: false, shouldPrompt: true });
      return this.publicState();
    }
    const fileName = sanitizeUpdateFileName(this.latest.download_url, { appName: this.appName, version: this.latest.version, platform: this.platform });
    const finalPath = path.join(this.updatesPath, fileName);
    const partPath = `${finalPath}.part`;
    if (await this.verifyDownloadedPackage(this.latest, finalPath, { removeInvalid: true })) {
      this.downloadedPath = finalPath;
      this.setState({ phase: "downloaded", downloadedBytes: this.latest.file_size, totalBytes: this.latest.file_size, message: "更新包已下载并通过校验", shouldPrompt: true });
      await this.persist();
      return this.publicState();
    }
    let existingBytes = 0;
    try { existingBytes = (await stat(partPath)).size; } catch { existingBytes = 0; }
    this.abortController = new AbortController();
    const startedAt = Date.now();
    this.setState({ phase: "downloading", downloadedBytes: existingBytes, totalBytes: this.latest.file_size, bytesPerSecond: 0, message: "正在下载更新…", canRetry: false, shouldPrompt: true });
    let response;
    try {
      const headers = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {};
      response = await this.fetchImpl(this.latest.download_url, { headers, signal: this.abortController.signal });
      if (!response.ok || (existingBytes > 0 && response.status !== 206)) {
        if (existingBytes > 0 && response.ok && response.status === 200) existingBytes = 0;
        else throw Object.assign(new Error(`更新下载失败（HTTP ${response.status}）`), { code: "download_http_error", httpStatus: response.status });
      }
      if (response.url && new URL(response.url).protocol !== "https:") throw Object.assign(new Error("更新下载重定向不安全"), { code: "unsafe_download_redirect" });
      const contentLength = Math.max(0, Number(response.headers.get("content-length")) || 0);
      const totalBytes = this.latest.file_size || existingBytes + contentLength;
      const file = await open(partPath, existingBytes > 0 ? "a" : "w");
      const reader = response.body?.getReader();
      if (!reader) throw Object.assign(new Error("更新服务器没有返回文件内容"), { code: "empty_download" });
      let downloadedBytes = existingBytes;
      let lastProgressAt = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await file.write(value);
          downloadedBytes += value.byteLength;
          const nowMs = Date.now();
          if (nowMs - lastProgressAt >= 200) {
            lastProgressAt = nowMs;
            this.setState({ downloadedBytes, totalBytes, bytesPerSecond: Math.round((downloadedBytes - existingBytes) / Math.max(1, (nowMs - startedAt) / 1000)) });
          }
        }
      } finally {
        await file.close();
      }
      const digest = await sha256File(partPath);
      if (digest.toLowerCase() !== this.latest.sha256.toLowerCase()) {
        await unlink(partPath).catch(() => {});
        const error = Object.assign(new Error("更新包校验失败，请重新下载"), { code: "sha256_mismatch" });
        await this.logFailure({ stage: "verify", targetVersion: this.latest.version, sha256Match: false, error });
        this.setState({ phase: "error", message: error.message, downloadedBytes: 0, bytesPerSecond: 0, canRetry: true, shouldPrompt: true });
        return this.publicState();
      }
      await unlink(finalPath).catch(() => {});
      await rename(partPath, finalPath);
      this.downloadedPath = finalPath;
      this.setState({ phase: "downloaded", downloadedBytes: totalBytes, totalBytes, bytesPerSecond: 0, message: "更新包已下载并通过 SHA256 校验", canRetry: false, shouldPrompt: true });
      await this.persist();
      return this.publicState();
    } catch (error) {
      if (error?.name === "AbortError") {
        this.setState({ phase: "available", message: "更新下载已取消，可稍后继续", bytesPerSecond: 0, canRetry: true, shouldPrompt: true });
      } else {
        await this.logFailure({ stage: "download", targetVersion: this.latest.version, httpStatus: error?.httpStatus || response?.status || 0, error });
        this.setState({ phase: "error", message: "更新下载失败，请检查网络后重试", bytesPerSecond: 0, canRetry: true, shouldPrompt: true });
      }
      return this.publicState();
    } finally {
      this.abortController = null;
    }
  }

  cancelDownload() {
    this.abortController?.abort();
    return this.publicState();
  }

  async remindLater() {
    if (!this.latest || this.latest.force_update) return this.publicState();
    this.reminders[this.latest.version] = todayKey(this.now());
    this.setState({ shouldPrompt: false, message: `今天不再提醒版本 ${this.latest.version}` });
    await this.persist();
    return this.publicState();
  }

  async setInstallOnQuit() {
    if (!this.downloadedPath || this.state.phase !== "downloaded") throw new Error("更新包尚未下载完成");
    this.installOnQuit = true;
    this.setState({ installOnQuit: true, shouldPrompt: false, message: "退出软件时将启动安装程序" });
    await this.persist();
    return this.publicState();
  }

  async install({ quitAfterLaunch = true } = {}) {
    if (this.isBusy()) throw Object.assign(new Error("当前仍有素材处理任务，请停止任务并保存工作后再安装"), { code: "application_busy" });
    if (!this.latest || !this.downloadedPath || this.state.phase !== "downloaded") throw new Error("更新包尚未准备完成");
    if (!await this.verifyDownloadedPackage(this.latest, this.downloadedPath, { removeInvalid: true })) {
      this.downloadedPath = "";
      const error = Object.assign(new Error("更新包校验失败，请重新下载"), { code: "sha256_mismatch" });
      await this.logFailure({ stage: "pre_install_verify", targetVersion: this.latest.version, sha256Match: false, error });
      this.setState({ phase: "error", message: error.message, canRetry: true, shouldPrompt: true });
      await this.persist();
      return this.publicState();
    }
    this.installOnQuit = false;
    this.setState({ phase: "installing", installOnQuit: false, message: "正在启动系统安装程序…", shouldPrompt: true });
    await this.persist();
    const openError = await this.openInstaller(this.downloadedPath);
    if (openError) {
      const error = Object.assign(new Error("安装程序未能启动，当前版本未受影响"), { code: "installer_launch_failed" });
      await this.logFailure({ stage: "install_launch", targetVersion: this.latest.version, sha256Match: true, error });
      this.setState({ phase: "downloaded", message: error.message, canRetry: true, shouldPrompt: true });
      return this.publicState();
    }
    if (quitAfterLaunch) this.quitApp();
    return this.publicState();
  }

  async installOnApplicationQuit() {
    if (!this.installOnQuit) return false;
    await this.install({ quitAfterLaunch: false });
    return this.state.phase === "installing";
  }
}
