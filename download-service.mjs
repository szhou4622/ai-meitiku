import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import { copyFile, link, mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const XIAOHONGSHU_ACCESS_URL_REUSE_MS = 24 * 60 * 60 * 1000;
const MEDIA_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".jpg", ".jpeg", ".png", ".webp"]);
const DOWNLOAD_TABLE_FILENAME = "视频下载记录.csv";
const DOWNLOAD_STATUS_LABELS = {
  queued: "等待中",
  parsing: "解析中",
  running: "下载中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
const PLATFORM_HOSTS = {
  douyin: ["douyin.com", "iesdouyin.com"],
  xiaohongshu: ["xiaohongshu.com", "xhslink.com", "xhslink.cn"],
};

function hostMatches(hostname, roots) {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return roots.some((root) => host === root || host.endsWith(`.${root}`));
}

export function platformForUrl(input) {
  try {
    const candidate = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    const url = new URL(candidate);
    if (hostMatches(url.hostname, PLATFORM_HOSTS.douyin)) return "douyin";
    if (hostMatches(url.hostname, PLATFORM_HOSTS.xiaohongshu)) return "xiaohongshu";
  } catch {
    return null;
  }
  return null;
}

export function extractSupportedLinks(input) {
  const text = String(input ?? "");
  const pattern = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:douyin\.com|iesdouyin\.com|xiaohongshu\.com|xhslink\.(?:com|cn))(?:\/[^\s<>"']*)?/gi;
  const unique = new Map();
  for (const rawMatch of text.match(pattern) ?? []) {
    const trimmed = rawMatch.replace(/[，。！？；：、)）\]}】>]+$/g, "");
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const platform = platformForUrl(normalized);
    if (!platform) continue;
    unique.set(normalized, { url: normalized, platform });
  }
  return [...unique.values()];
}

function xiaohongshuDirectWorkKey(input) {
  try {
    const url = new URL(input);
    if (!hostMatches(url.hostname, ["xiaohongshu.com"])) return "";
    const segments = url.pathname.split("/").filter(Boolean);
    const supportedPath = (segments.length === 2 && segments[0] === "explore")
      || (segments.length === 3 && segments[0] === "discovery" && segments[1] === "item");
    return supportedPath ? segments.at(-1) || "" : "";
  } catch {
    return "";
  }
}

function hasXiaohongshuAccessToken(input) {
  try {
    return Boolean(new URL(input).searchParams.get("xsec_token")?.trim());
  } catch {
    return false;
  }
}

function preferExistingCompleteXiaohongshuUrl(tasks, candidate) {
  if (candidate.platform !== "xiaohongshu" || hasXiaohongshuAccessToken(candidate.url)) return candidate.url;
  const workKey = xiaohongshuDirectWorkKey(candidate.url);
  if (!workKey) return candidate.url;
  const previous = [...tasks].reverse().find((task) => task.platform === "xiaohongshu"
    && xiaohongshuDirectWorkKey(task.url) === workKey
    && hasXiaohongshuAccessToken(task.url)
    && Number.isFinite(Date.parse(task.updatedAt || task.createdAt || ""))
    && Date.now() - Date.parse(task.updatedAt || task.createdAt) <= XIAOHONGSHU_ACCESS_URL_REUSE_MS);
  return previous?.url || candidate.url;
}

function actionableXiaohongshuError(task, message) {
  if (task.platform !== "xiaohongshu"
    || !xiaohongshuDirectWorkKey(task.url)
    || hasXiaohongshuAccessToken(task.url)
    || !/initial-state|note-state|\u521d\u59cb\u72b6\u6001|\u4f5c\u54c1\u6570\u636e/.test(message)) return message;
  return `${message}\uff1b\u5f53\u524d\u94fe\u63a5\u7f3a\u5c11\u5c0f\u7ea2\u4e66\u4f5c\u54c1\u8bbf\u95ee\u53c2\u6570\uff0c\u8bf7\u4ece\u201c\u5206\u4eab\u201d\u91cd\u65b0\u590d\u5236\u5b8c\u6574\u94fe\u63a5\u6216 xhslink \u77ed\u94fe\u540e\u518d\u8bd5`;
}

async function scanDownloadedFiles(root, sinceMs) {
  const files = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        try {
          const info = await stat(entryPath);
          if (info.mtimeMs >= sinceMs - 2000) files.push(entryPath);
        } catch {
          // A downloader may atomically rename a file while the directory is scanned.
        }
      }
      if (files.length >= 5000) return;
    }
  }
  await walk(root);
  return files;
}

function isInsideDirectory(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function numberedOutputPath(outputDirectory, filename, suffix) {
  if (!suffix) return path.join(outputDirectory, filename);
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  return path.join(outputDirectory, `${stem} (${suffix})${extension}`);
}

async function moveFileWithoutOverwrite(source, outputDirectory) {
  for (let suffix = 0; suffix < 10000; suffix += 1) {
    const target = numberedOutputPath(outputDirectory, path.basename(source), suffix);
    try {
      await link(source, target);
      await unlink(source);
      return target;
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      if (!["EPERM", "EACCES", "ENOSYS", "EOPNOTSUPP", "EXDEV"].includes(error?.code)) throw error;
      try {
        await copyFile(source, target, fsConstants.COPYFILE_EXCL);
        await unlink(source);
        return target;
      } catch (copyError) {
        if (copyError?.code === "EEXIST") continue;
        throw copyError;
      }
    }
  }
  throw new Error(`无法为下载文件生成不重复的名称：${path.basename(source)}`);
}

export async function flattenXiaohongshuOutput(files, outputDirectory) {
  const outputRoot = path.resolve(outputDirectory);
  const downloaderFolder = path.join(outputRoot, "download");
  const flattened = [];
  for (const file of files) {
    const resolved = path.resolve(file);
    if (isInsideDirectory(resolved, downloaderFolder)) {
      flattened.push(await moveFileWithoutOverwrite(resolved, outputRoot));
    } else {
      flattened.push(resolved);
    }
  }
  try {
    await rmdir(downloaderFolder);
  } catch {
    // Keep the downloader folder when it still contains older or unrelated files.
  }
  return flattened;
}

function executableName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function browserCookieSource() {
  if (process.platform === "darwin") {
    if (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")) return "chrome";
    if (existsSync("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")) return "edge";
    if (existsSync("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser")) return "brave";
    if (existsSync("/Applications/Chromium.app/Contents/MacOS/Chromium")) return "chromium";
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    if (existsSync(path.join(local, "Google", "Chrome", "User Data"))) return "chrome";
    if (existsSync(path.join(local, "Microsoft", "Edge", "User Data"))) return "edge";
    if (existsSync(path.join(local, "BraveSoftware", "Brave-Browser", "User Data"))) return "brave";
  }
  return "";
}

function bundledFfmpegPath(resourcesPath) {
  const binary = executableName("ffmpeg");
  const platformTag = `${process.platform}-${process.arch}`;
  return [
    path.join(resourcesPath, "bin", platformTag, binary),
    path.join(resourcesPath, "downloaders", binary),
  ].find((candidate) => existsSync(candidate)) || "";
}

function ytDlpArgs(task, auth = null, ffmpegLocation = "") {
  const args = [
    "--newline",
    "--no-playlist",
    "--trim-filenames", "180",
    "--print", "after_move:AI_MEDIA_OUTPUT:%(filepath)s",
    "-P", task.outputDirectory,
    "-o", "%(title).180B_%(id)s.%(ext)s",
  ];
  if (ffmpegLocation) args.push("--ffmpeg-location", ffmpegLocation);
  if (auth?.cookieFile) {
    args.push("--cookies", auth.cookieFile);
  } else {
    const cookiesFrom = browserCookieSource();
    if (cookiesFrom) args.push("--cookies-from-browser", cookiesFrom);
  }
  args.push(task.url);
  return args;
}

function xiaohongshuAuthEnvironment(auth) {
  return {
    ...(auth?.cookieHeader ? { XHS_COOKIE: auth.cookieHeader } : {}),
    ...(auth?.userAgent ? { XHS_USER_AGENT: auth.userAgent } : {}),
  };
}

export function resolveDownloadCommand({ task, appRoot, resourcesPath, isPackaged, auth = null }) {
  const bundledRoot = path.join(resourcesPath, "downloaders");
  const bundledYtDlp = path.join(bundledRoot, executableName("yt-dlp"));
  const bundledName = task.platform === "douyin" ? "douyin-downloader" : "xhs-downloader";
  const bundledExecutable = path.join(bundledRoot, executableName(bundledName));
  if (task.platform === "xiaohongshu" && existsSync(bundledExecutable)) {
    return {
      command: bundledExecutable,
      args: ["download", task.url, "--output", task.outputDirectory],
      cwd: bundledRoot,
      env: xiaohongshuAuthEnvironment(auth),
    };
  }
  const bundledXhsRuntime = path.join(bundledRoot, "xhs-runtime");
  const bundledXhsPython = path.join(bundledXhsRuntime, executableName("python"));
  const bundledXhsLauncher = path.join(bundledXhsRuntime, "xhs_launcher.py");
  if (task.platform === "xiaohongshu" && existsSync(bundledXhsPython) && existsSync(bundledXhsLauncher)) {
    return {
      command: bundledXhsPython,
      args: [bundledXhsLauncher, "download", task.url, "--output", task.outputDirectory],
      cwd: bundledXhsRuntime,
      env: xiaohongshuAuthEnvironment(auth),
    };
  }
  if (task.platform === "douyin" && existsSync(bundledYtDlp)) {
    return {
      command: bundledYtDlp,
      args: ytDlpArgs(task, auth, bundledFfmpegPath(resourcesPath)),
      cwd: bundledRoot,
    };
  }
  if (task.platform === "douyin" && existsSync(bundledExecutable)) {
    const args = task.platform === "douyin"
      ? ["-u", task.url, "-p", task.outputDirectory, "--show-warnings"]
      : ["download", task.url, "--output", task.outputDirectory];
    return { command: bundledExecutable, args, cwd: bundledRoot };
  }
  if (isPackaged) throw new Error(`${task.platform === "douyin" ? "抖音" : "小红书"}下载后端未包含在安装包中`);

  const sourceRoot = path.join(appRoot, "third_party", "video-downloaders", task.platform === "douyin" ? "douyin" : "xhs");
  const developmentBin = path.join(appRoot, ".download-runtime", process.platform === "win32" ? "Scripts" : "bin");
  if (task.platform === "douyin") {
    const localYtDlp = path.join(developmentBin, executableName("yt-dlp"));
    if (existsSync(localYtDlp)) {
      return { command: localYtDlp, args: ytDlpArgs(task, auth, bundledFfmpegPath(resourcesPath)), cwd: sourceRoot };
    }
    const localPython = path.join(developmentBin, process.platform === "win32" ? "python.exe" : "python");
    const python = process.env.AI_MEDIA_PYTHON || (existsSync(localPython) ? localPython : existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3");
    return {
      command: python,
      args: [path.join(sourceRoot, "run.py"), "-c", path.join(sourceRoot, "config.yml"), "-u", task.url, "-p", task.outputDirectory, "--show-warnings"],
      cwd: sourceRoot,
    };
  }
  const localXhs = path.join(developmentBin, executableName("xhs-downloader"));
  if (existsSync(localXhs)) {
    return {
      command: localXhs,
      args: ["download", task.url, "--output", task.outputDirectory],
      cwd: sourceRoot,
      env: xiaohongshuAuthEnvironment(auth),
    };
  }
  return {
    command: process.env.AI_MEDIA_UV || "uv",
    args: ["run", "--project", sourceRoot, "--package", "xhs-cli", "xhs-downloader", "download", task.url, "--output", task.outputDirectory],
    cwd: sourceRoot,
    env: xiaohongshuAuthEnvironment(auth),
  };
}

function publicTask(task) {
  const result = { ...task };
  delete result.process;
  return result;
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join("\n") : String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function exportRecordForTask(task) {
  return {
    id: task.id,
    outputDirectory: task.outputDirectory,
    platform: task.platform,
    title: task.title,
    url: task.url,
    status: task.status,
    quality: task.quality,
    outputFiles: Array.isArray(task.outputFiles) ? task.outputFiles : [],
    autoImport: Boolean(task.autoImport),
    importedAt: task.importedAt || "",
    createdAt: task.createdAt || "",
    completedAt: task.completedAt || "",
    error: task.error || "",
  };
}

function downloadTableCsv(records) {
  const headers = ["平台", "作品标题", "原始链接", "下载状态", "下载画质", "本地文件", "自动入库", "创建时间", "完成时间", "失败原因"];
  const rows = records.map((record) => [
    record.platform === "douyin" ? "抖音" : "小红书",
    record.title,
    record.url,
    DOWNLOAD_STATUS_LABELS[record.status] || record.status,
    record.quality,
    record.outputFiles,
    record.autoImport ? record.importedAt ? "已入库" : "已开启" : "未开启",
    record.createdAt,
    record.completedAt,
    record.error,
  ].map(csvCell).join(","));
  return `\uFEFF${headers.map(csvCell).join(",")}\r\n${rows.join("\r\n")}${rows.length ? "\r\n" : ""}`;
}

export class VideoDownloadService {
  constructor({ userDataPath, appRoot, resourcesPath, isPackaged = false, maxConcurrency = 2, onStateChange = () => {}, onDiagnostic = () => {}, runner = null, authProvider = null, fallbackRunner = null }) {
    this.userDataPath = userDataPath;
    this.appRoot = appRoot;
    this.resourcesPath = resourcesPath;
    this.isPackaged = isPackaged;
    this.maxConcurrency = Math.max(1, Math.min(4, maxConcurrency));
    this.onStateChange = onStateChange;
    this.onDiagnostic = onDiagnostic;
    this.runner = runner;
    this.authProvider = authProvider;
    this.fallbackRunner = fallbackRunner;
    this.tasks = [];
    this.paused = false;
    this.active = 0;
    this.initialized = false;
    this.persistence = Promise.resolve();
    this.exportPersistence = Promise.resolve();
    this.exportRecords = [];
    this.statePath = path.join(userDataPath, "video-downloads", "tasks.json");
    this.defaultOutputDirectory = path.join(userDataPath, "video-downloads", "media");
  }

  async initialize() {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    await mkdir(this.defaultOutputDirectory, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.statePath, "utf8"));
      this.defaultOutputDirectory = path.isAbsolute(saved.defaultOutputDirectory || "") ? saved.defaultOutputDirectory : this.defaultOutputDirectory;
      this.paused = Boolean(saved.paused);
      this.exportRecords = Array.isArray(saved.exportRecords)
        ? saved.exportRecords.filter((record) => record && typeof record.id === "string" && path.isAbsolute(record.outputDirectory || "")).slice(-10000)
        : [];
      this.tasks = Array.isArray(saved.tasks) ? saved.tasks.map((task) => ({
        ...task,
        status: task.status === "running" || task.status === "parsing" ? "queued" : task.status,
        progress: task.status === "running" || task.status === "parsing" ? 0 : Number(task.progress || 0),
        message: task.status === "running" || task.status === "parsing" ? "软件重启后已重新排队" : String(task.message || ""),
        exportTable: Boolean(task.exportTable),
        exportError: String(task.exportError || ""),
        process: null,
      })) : [];
    } catch {
      this.tasks = [];
    }
    this.initialized = true;
    await this.persist();
    this.schedule();
    return this.publicState();
  }

  publicState() {
    return {
      ready: this.initialized,
      paused: this.paused,
      defaultOutputDirectory: this.defaultOutputDirectory,
      tasks: [...this.tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicTask),
    };
  }

  async setDefaultOutputDirectory(directory) {
    if (!path.isAbsolute(directory || "")) throw new Error("下载目录必须是本机绝对路径");
    await mkdir(directory, { recursive: true });
    this.defaultOutputDirectory = directory;
    await this.publish();
    return this.publicState();
  }

  async enqueue({ input, outputDirectory, autoImport = true, exportTable = false, quality = "best" }) {
    const links = extractSupportedLinks(input);
    if (!links.length) throw new Error("没有识别到抖音或小红书链接");
    if (links.length > 100) throw new Error("单次最多添加 100 条链接");
    const destination = path.isAbsolute(outputDirectory || "") ? outputDirectory : this.defaultOutputDirectory;
    await mkdir(destination, { recursive: true });
    const createdAt = new Date().toISOString();
    const newTasks = links.map((candidate) => {
      const { platform } = candidate;
      const url = preferExistingCompleteXiaohongshuUrl(this.tasks, candidate);
      return {
        id: randomUUID(),
        platform,
        url,
        title: platform === "douyin" ? "抖音作品" : "小红书作品",
        status: "queued",
        progress: 0,
        message: "等待下载",
        error: "",
        quality: quality === "best" ? "best" : String(quality || "best"),
        outputDirectory: destination,
        outputFiles: [],
        autoImport: Boolean(autoImport),
        exportTable: Boolean(exportTable),
        exportError: "",
        importedAt: "",
        createdAt,
        updatedAt: createdAt,
        startedAt: "",
        completedAt: "",
        process: null,
      };
    });
    this.tasks.push(...newTasks);
    await this.updateExportTables(newTasks);
    await this.publish();
    this.schedule();
    return { state: this.publicState(), added: newTasks.map(publicTask) };
  }

  async retry(taskId) {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("下载任务不存在");
    if (!TERMINAL_STATES.has(task.status)) throw new Error("当前任务无需重试");
    Object.assign(task, { status: "queued", progress: 0, error: "", message: "已重新排队", outputFiles: [], completedAt: "", exportError: "", updatedAt: new Date().toISOString() });
    await this.updateExportTables([task]);
    await this.publish();
    this.schedule();
    return this.publicState();
  }

  async cancel(taskId) {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("下载任务不存在");
    task.process?.kill?.();
    Object.assign(task, { status: "cancelled", message: "已取消", progress: 0, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), process: null });
    await this.updateExportTables([task]);
    await this.publish();
    return this.publicState();
  }

  async setPaused(paused) {
    this.paused = Boolean(paused);
    await this.publish();
    if (!this.paused) this.schedule();
    return this.publicState();
  }

  async clearCompleted() {
    this.tasks = this.tasks.filter((task) => !TERMINAL_STATES.has(task.status));
    await this.publish();
    return this.publicState();
  }

  async markImported(taskId) {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) return this.publicState();
    task.importedAt = new Date().toISOString();
    task.updatedAt = task.importedAt;
    await this.updateExportTables([task]);
    await this.publish();
    return this.publicState();
  }

  rememberExportRecord(task) {
    if (!task.exportTable || !path.isAbsolute(task.outputDirectory || "")) return;
    const record = exportRecordForTask(task);
    const index = this.exportRecords.findIndex((item) => item.id === task.id);
    if (index >= 0) this.exportRecords[index] = record;
    else this.exportRecords.push(record);
    if (this.exportRecords.length > 10000) this.exportRecords = this.exportRecords.slice(-10000);
  }

  async updateExportTables(tasks) {
    const enabled = tasks.filter((task) => task.exportTable && path.isAbsolute(task.outputDirectory || ""));
    if (!enabled.length) return;
    enabled.forEach((task) => this.rememberExportRecord(task));
    const directories = [...new Set(enabled.map((task) => task.outputDirectory))];
    try {
      this.exportPersistence = this.exportPersistence.catch(() => {}).then(async () => {
        for (const directory of directories) {
          await mkdir(directory, { recursive: true });
          const records = this.exportRecords
            .filter((record) => record.outputDirectory === directory)
            .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
          await writeFile(path.join(directory, DOWNLOAD_TABLE_FILENAME), downloadTableCsv(records), "utf8");
        }
      });
      await this.exportPersistence;
      for (const task of enabled) task.exportError = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const task of enabled) {
        task.exportError = message;
        if (TERMINAL_STATES.has(task.status)) task.message = `${task.message}；表格导出失败：${message}`;
        this.rememberExportRecord(task);
      }
    }
  }

  async persist() {
    const payload = {
      version: 2,
      paused: this.paused,
      defaultOutputDirectory: this.defaultOutputDirectory,
      exportRecords: this.exportRecords,
      tasks: this.tasks.map(publicTask),
    };
    const serialized = JSON.stringify(payload, null, 2);
    const temporaryPath = `${this.statePath}.tmp`;
    this.persistence = this.persistence.catch(() => {}).then(async () => {
      await writeFile(temporaryPath, serialized, "utf8");
      await rename(temporaryPath, this.statePath);
    });
    await this.persistence;
  }

  async publish() {
    await this.persist();
    this.onStateChange(this.publicState());
  }

  schedule() {
    if (!this.initialized || this.paused) return;
    while (this.active < this.maxConcurrency) {
      const task = this.tasks.find((item) => item.status === "queued");
      if (!task) return;
      this.active += 1;
      task.status = "parsing";
      task.message = "正在解析分享链接";
      task.updatedAt = new Date().toISOString();
      void this.publish();
      void this.run(task).finally(() => {
        this.active = Math.max(0, this.active - 1);
        this.schedule();
      });
    }
  }

  async run(task) {
    const startedMs = Date.now();
    task.startedAt = new Date(startedMs).toISOString();
    task.status = "running";
    task.progress = 2;
    task.message = "正在启动下载后端";
    task.updatedAt = task.startedAt;
    await this.publish();
    try {
      if (this.runner) {
        const result = await this.runner(publicTask(task), (progress, message) => this.updateProgress(task, progress, message));
        task.outputFiles = Array.isArray(result?.outputFiles) ? result.outputFiles : [];
      } else {
        let result;
        try {
          result = await this.runProcess(task);
        } catch (error) {
          if (task.platform !== "douyin" || !this.fallbackRunner) throw error;
          const primaryMessage = error instanceof Error ? error.message : String(error);
          this.updateProgress(task, 8, "常规解析失败，正在尝试本机登录会话");
          try {
            result = await this.fallbackRunner(publicTask(task), (progress, message) => this.updateProgress(task, progress, message));
          } catch (fallbackError) {
            const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            throw new Error(`常规下载失败：${primaryMessage}；浏览器兜底失败：${fallbackMessage}`);
          }
        }
        const scannedFiles = await scanDownloadedFiles(task.outputDirectory, startedMs);
        task.outputFiles = [...new Set([...(result?.outputFiles || []), ...scannedFiles])];
      }
      if (task.platform === "xiaohongshu") {
        task.outputFiles = await flattenXiaohongshuOutput(task.outputFiles, task.outputDirectory);
      }
      if (task.status === "cancelled") return;
      if (!task.outputFiles.length) {
        throw new Error("下载后端未生成文件，请检查链接是否有效，或是否需要登录/平台验证");
      }
      task.status = "completed";
      task.progress = 100;
      task.message = task.outputFiles.length ? `下载完成，共 ${task.outputFiles.length} 个文件` : "下载完成";
      task.completedAt = new Date().toISOString();
      task.updatedAt = task.completedAt;
      await this.updateExportTables([task]);
      await this.publish();
    } catch (error) {
      if (task.status === "cancelled") return;
      task.status = "failed";
      const message = error instanceof Error ? error.message : String(error);
      task.error = actionableXiaohongshuError(task, message);
      task.message = task.error;
      task.completedAt = new Date().toISOString();
      task.updatedAt = task.completedAt;
      task.process = null;
      await this.updateExportTables([task]);
      await this.publish();
    }
  }

  updateProgress(task, progress, message) {
    if (Number.isFinite(progress)) task.progress = Math.max(task.progress, Math.min(99, Number(progress)));
    if (message) task.message = String(message).slice(-240);
    task.updatedAt = new Date().toISOString();
    void this.publish();
  }

  async runProcess(task) {
    const auth = this.authProvider ? await this.authProvider(task.platform) : null;
    const resolved = resolveDownloadCommand({ task, appRoot: this.appRoot, resourcesPath: this.resourcesPath, isPackaged: this.isPackaged, auth });
    return new Promise((resolve, reject) => {
      const child = spawn(resolved.command, resolved.args, {
        cwd: resolved.cwd,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
          ...(resolved.env || {}),
        },
      });
      task.process = child;
      child.stdout?.setEncoding?.("utf8");
      child.stderr?.setEncoding?.("utf8");
      let recentError = "";
      const outputFiles = new Set();
      const consume = (chunk, isError = false) => {
        this.onDiagnostic({ taskId: task.id, platform: task.platform, stream: isError ? "stderr" : "stdout", text: String(chunk) });
        const text = String(chunk).trim();
        if (!text) return;
        for (const line of text.split(/\r?\n/)) {
          const marker = line.indexOf("AI_MEDIA_OUTPUT:");
          if (marker >= 0) {
            const outputPath = line.slice(marker + "AI_MEDIA_OUTPUT:".length).trim();
            if (path.isAbsolute(outputPath)) outputFiles.add(outputPath);
          }
        }
        const percent = text.match(/(?:^|\s)(\d{1,3}(?:\.\d+)?)\s*%/);
        if (percent) this.updateProgress(task, Number(percent[1]), text.split(/\r?\n/).at(-1));
        else this.updateProgress(task, Math.min(95, task.progress + 1), text.split(/\r?\n/).at(-1));
        if (isError) recentError = text.slice(-1000);
      };
      child.stdout?.on("data", (chunk) => consume(chunk));
      child.stderr?.on("data", (chunk) => consume(chunk, true));
      child.once("error", (error) => reject(new Error(`无法启动下载后端：${error.message}`)));
      child.once("close", (code, signal) => {
        this.onDiagnostic({ taskId: task.id, phase: "exit", code, signal });
        task.process = null;
        if (task.status === "cancelled" || signal) return resolve({ outputFiles: [] });
        if (code === 0) resolve({ outputFiles: [...outputFiles] });
        else reject(new Error(recentError || `下载后端退出，代码 ${code}`));
      });
    });
  }

  shutdown() {
    for (const task of this.tasks) task.process?.kill?.();
  }
}
