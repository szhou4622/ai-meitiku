import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractSupportedLinks, platformForUrl, resolveDownloadCommand, VideoDownloadService } from "../electron/download-service.mjs";

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForPersistedTasks(filePath, predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (true) {
    try {
      const payload = JSON.parse(await readFile(filePath, "utf8"));
      if (predicate(payload.tasks || [])) return payload;
    } catch {
      // Persistence may still be between its temporary write and atomic rename.
    }
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for persisted tasks");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("extractSupportedLinks recognizes and deduplicates Douyin and Xiaohongshu share text", () => {
  const links = extractSupportedLinks(`
    复制打开抖音 https://v.douyin.com/AbC123/ 看作品
    小红书 xhslink.com/m/test123）
    小红书新短链 https://xhslink.cn/o/9hjnZtYGk51 复制后打开
    重复 https://v.douyin.com/AbC123/
  `);
  assert.deepEqual(links, [
    { url: "https://v.douyin.com/AbC123/", platform: "douyin" },
    { url: "https://xhslink.com/m/test123", platform: "xiaohongshu" },
    { url: "https://xhslink.cn/o/9hjnZtYGk51", platform: "xiaohongshu" },
  ]);
});

test("extractSupportedLinks preserves Xiaohongshu access parameters", () => {
  const url = "https://www.xiaohongshu.com/explore/abc123?xsec_token=token-value&xsec_source=pc_feed";
  assert.deepEqual(extractSupportedLinks(url), [{ url, platform: "xiaohongshu" }]);
});

test("platformForUrl rejects lookalike and unsupported hosts", () => {
  assert.equal(platformForUrl("https://www.douyin.com/video/1"), "douyin");
  assert.equal(platformForUrl("https://www.xiaohongshu.com/explore/1"), "xiaohongshu");
  assert.equal(platformForUrl("https://xhslink.cn/o/9hjnZtYGk51"), "xiaohongshu");
  assert.equal(platformForUrl("https://douyin.com.evil.example/video/1"), null);
  assert.equal(platformForUrl("https://example.com/video/1"), null);
});

test("VideoDownloadService queues both platforms and persists completed tasks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-media-download-test-"));
  const output = path.join(root, "downloads");
  const observed = [];
  const service = new VideoDownloadService({
    userDataPath: root,
    appRoot: root,
    resourcesPath: root,
    maxConcurrency: 2,
    onStateChange: (state) => observed.push(state),
    runner: async (task, progress) => {
      progress(55, "下载中");
      return { outputFiles: [path.join(output, `${task.platform}.mp4`)] };
    },
  });
  await service.initialize();
  const result = await service.enqueue({
    input: "https://v.douyin.com/abc/\nhttps://xhslink.com/xyz",
    outputDirectory: output,
    autoImport: true,
  });
  assert.equal(result.added.length, 2);
  await waitFor(() => service.publicState().tasks.every((task) => task.status === "completed"));
  const state = service.publicState();
  assert.deepEqual(new Set(state.tasks.map((task) => task.platform)), new Set(["douyin", "xiaohongshu"]));
  assert.ok(state.tasks.every((task) => task.progress === 100 && task.outputFiles.length === 1));
  assert.ok(observed.some((snapshot) => snapshot.tasks.some((task) => task.status === "running")));
  const persisted = await waitForPersistedTasks(
    path.join(root, "video-downloads", "tasks.json"),
    (tasks) => tasks.length === 2 && tasks.every((task) => task.status === "completed"),
  );
  assert.equal(persisted.tasks.length, 2);
  assert.ok(persisted.tasks.every((task) => task.status === "completed"));
});

test("Xiaohongshu resubmission reuses a complete URL for the same work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-media-xhs-complete-url-"));
  const complete = "https://www.xiaohongshu.com/explore/abc123?xsec_token=token-value&xsec_source=pc_feed";
  const service = new VideoDownloadService({
    userDataPath: root,
    appRoot: root,
    resourcesPath: root,
    runner: async (task) => ({ outputFiles: [path.join(root, `${task.id}.mp4`)] }),
  });
  await service.initialize();
  await service.enqueue({ input: complete });
  await waitFor(() => service.publicState().tasks[0]?.status === "completed");
  const result = await service.enqueue({ input: "https://www.xiaohongshu.com/explore/abc123" });
  assert.equal(result.added[0].url, complete);
});

test("Xiaohongshu retry keeps the exact original URL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-media-xhs-retry-url-"));
  const complete = "https://www.xiaohongshu.com/explore/abc123?xsec_token=token-value&xsec_source=pc_feed";
  const observed = [];
  const service = new VideoDownloadService({
    userDataPath: root,
    appRoot: root,
    resourcesPath: root,
    runner: async (task) => {
      observed.push(task.url);
      if (observed.length === 1) throw new Error("temporary failure");
      return { outputFiles: [path.join(root, `${task.id}.mp4`)] };
    },
  });
  await service.initialize();
  const result = await service.enqueue({ input: complete });
  const taskId = result.added[0].id;
  await waitFor(() => service.publicState().tasks.find((task) => task.id === taskId)?.status === "failed");
  await service.retry(taskId);
  await waitFor(() => service.publicState().tasks.find((task) => task.id === taskId)?.status === "completed");
  assert.deepEqual(observed, [complete, complete]);
});

test("Xiaohongshu tokenless parse failure explains how to retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-media-xhs-actionable-error-"));
  const service = new VideoDownloadService({
    userDataPath: root,
    appRoot: root,
    resourcesPath: root,
    runner: async () => { throw new Error("初始状态中没有作品数据（诊断码：note-state-missing）"); },
  });
  await service.initialize();
  const result = await service.enqueue({ input: "https://www.xiaohongshu.com/explore/abc123" });
  const taskId = result.added[0].id;
  await waitFor(() => service.publicState().tasks.find((task) => task.id === taskId)?.status === "failed");
  assert.match(service.publicState().tasks.find((task) => task.id === taskId).error, /分享.*完整链接|xhslink/);
});

test("VideoDownloadService exports an Excel-compatible download table and keeps its history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-media-download-table-test-"));
  const output = path.join(root, "downloads");
  await mkdir(output, { recursive: true });
  const downloadedFile = path.join(output, "测试作品.mp4");
  const service = new VideoDownloadService({
    userDataPath: root,
    appRoot: root,
    resourcesPath: root,
    runner: async () => {
      await writeFile(downloadedFile, "video", "utf8");
      return { outputFiles: [downloadedFile] };
    },
  });
  await service.initialize();
  await service.enqueue({
    input: "https://v.douyin.com/export-table/",
    outputDirectory: output,
    autoImport: false,
    exportTable: true,
    quality: "1080p",
  });
  await waitFor(() => service.publicState().tasks[0]?.status === "completed");

  const tablePath = path.join(output, "视频下载记录.csv");
  const table = await readFile(tablePath, "utf8");
  assert.ok(table.startsWith("\uFEFF"));
  assert.match(table, /"平台","作品标题","原始链接","下载状态"/);
  assert.match(table, /https:\/\/v\.douyin\.com\/export-table\//);
  assert.match(table, /"已完成"/);
  assert.match(table, /"1080p"/);
  assert.match(table, /测试作品\.mp4/);

  await service.clearCompleted();
  assert.equal(service.publicState().tasks.length, 0);
  assert.match(await readFile(tablePath, "utf8"), /export-table/);
});

test("VideoDownloadService keeps running when the renderer page is no longer mounted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-media-download-background-"));
  let finishDownload;
  const downloadFinished = new Promise((resolve) => { finishDownload = resolve; });
  const service = new VideoDownloadService({
    userDataPath: root,
    appRoot: root,
    resourcesPath: root,
    runner: async (task, progress) => {
      progress(35, "后台下载中");
      await downloadFinished;
      return { outputFiles: [path.join(root, `${task.id}.mp4`)] };
    },
  });
  await service.initialize();
  const result = await service.enqueue({ input: "https://v.douyin.com/background/" });
  const taskId = result.added[0].id;
  await waitFor(() => service.publicState().tasks.find((task) => task.id === taskId)?.status === "running");
  // No renderer callback or workbench instance is retained here. The main
  // process service owns the task and therefore continues across page changes.
  finishDownload();
  await waitFor(() => service.publicState().tasks.find((task) => task.id === taskId)?.status === "completed");
  assert.equal(service.publicState().tasks.find((task) => task.id === taskId).progress, 100);
});

test("VideoDownloadService enforces the batch limit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-media-download-limit-"));
  const service = new VideoDownloadService({ userDataPath: root, appRoot: root, resourcesPath: root, runner: async () => ({ outputFiles: [] }) });
  await service.initialize();
  const input = Array.from({ length: 101 }, (_, index) => `https://v.douyin.com/item-${index}/`).join("\n");
  await assert.rejects(() => service.enqueue({ input }), /最多添加 100 条/);
});

test("VideoDownloadService does not report completion when no file was generated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-media-download-empty-"));
  const service = new VideoDownloadService({
    userDataPath: root,
    appRoot: root,
    resourcesPath: root,
    runner: async () => ({ outputFiles: [] }),
  });
  await service.initialize();
  const result = await service.enqueue({ input: "https://v.douyin.com/no-output/" });
  const taskId = result.added[0].id;
  await waitFor(() => service.publicState().tasks.find((item) => item.id === taskId)?.status === "failed");
  const task = service.publicState().tasks.find((item) => item.id === taskId);
  assert.equal(task.status, "failed");
  assert.match(task.error, /未生成文件/);
});

test("Xiaohongshu downloads are flattened into the selected output directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-media-xhs-output-test-"));
  const output = path.join(root, "selected-output");
  const nested = path.join(output, "download");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(output, "作品.mp4"), "existing", "utf8");
  const service = new VideoDownloadService({
    userDataPath: root,
    appRoot: root,
    resourcesPath: root,
    runner: async () => {
      const generated = path.join(nested, "作品.mp4");
      await writeFile(generated, "new", "utf8");
      return { outputFiles: [generated] };
    },
  });
  await service.initialize();
  const result = await service.enqueue({ input: "https://xhslink.cn/o/output-test", outputDirectory: output });
  const taskId = result.added[0].id;
  await waitFor(() => service.publicState().tasks.find((item) => item.id === taskId)?.status === "completed");
  const task = service.publicState().tasks.find((item) => item.id === taskId);
  assert.deepEqual(task.outputFiles, [path.join(output, "作品 (1).mp4")]);
  assert.equal(await readFile(path.join(output, "作品.mp4"), "utf8"), "existing");
  assert.equal(await readFile(path.join(output, "作品 (1).mp4"), "utf8"), "new");
  await assert.rejects(() => stat(nested), { code: "ENOENT" });
});

test("resolved downloader commands receive local platform login cookies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-media-download-auth-test-"));
  const bundled = path.join(root, "downloaders");
  await mkdir(bundled, { recursive: true });
  const xhsExecutable = path.join(bundled, process.platform === "win32" ? "xhs-downloader.exe" : "xhs-downloader");
  const ytDlpExecutable = path.join(bundled, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  await writeFile(xhsExecutable, "", "utf8");
  await writeFile(ytDlpExecutable, "", "utf8");
  const xhs = resolveDownloadCommand({
    task: { platform: "xiaohongshu", url: "https://xhslink.cn/o/example", outputDirectory: root },
    appRoot: root,
    resourcesPath: root,
    isPackaged: true,
    auth: { cookieHeader: "web_session=local-only", userAgent: "Windows-UA" },
  });
  assert.equal(xhs.command, xhsExecutable);
  assert.equal(xhs.env.XHS_COOKIE, "web_session=local-only");
  assert.equal(xhs.env.XHS_USER_AGENT, "Windows-UA");

  const toolDirectory = path.join(root, "bin", `${process.platform}-${process.arch}`);
  await mkdir(toolDirectory, { recursive: true });
  const ffmpegExecutable = path.join(toolDirectory, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  await writeFile(ffmpegExecutable, "", "utf8");
  const douyin = resolveDownloadCommand({
    task: { platform: "douyin", url: "https://v.douyin.com/example/", outputDirectory: root },
    appRoot: root,
    resourcesPath: root,
    isPackaged: true,
    auth: { cookieFile: path.join(root, "douyin.cookies.txt") },
  });
  assert.equal(douyin.command, ytDlpExecutable);
  assert.deepEqual(douyin.args.slice(-5, -3), ["--ffmpeg-location", ffmpegExecutable]);
  assert.deepEqual(douyin.args.slice(-3), ["--cookies", path.join(root, "douyin.cookies.txt"), "https://v.douyin.com/example/"]);
});

test("packaged Xiaohongshu downloader can use the bundled Python runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-media-xhs-runtime-test-"));
  const runtime = path.join(root, "downloaders", "xhs-runtime");
  await mkdir(runtime, { recursive: true });
  const python = path.join(runtime, process.platform === "win32" ? "python.exe" : "python");
  const launcher = path.join(runtime, "xhs_launcher.py");
  await writeFile(python, "", "utf8");
  await writeFile(launcher, "from xhs_cli.app import app\napp()\n", "utf8");

  const resolved = resolveDownloadCommand({
    task: { platform: "xiaohongshu", url: "https://xhslink.cn/o/example", outputDirectory: root },
    appRoot: root,
    resourcesPath: root,
    isPackaged: true,
    auth: { cookieHeader: "web_session=local-only", userAgent: "Windows-UA" },
  });

  assert.equal(resolved.command, python);
  assert.deepEqual(resolved.args, [launcher, "download", "https://xhslink.cn/o/example", "--output", root]);
  assert.equal(resolved.cwd, runtime);
  assert.equal(resolved.env.XHS_COOKIE, "web_session=local-only");
  assert.equal(resolved.env.XHS_USER_AGENT, "Windows-UA");
});

test("Douyin process failure falls back to the local authenticated browser session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-media-douyin-fallback-test-"));
  const output = path.join(root, "downloads");
  const fallbackFile = path.join(output, "fallback.mp4");
  let fallbackCalls = 0;
  const service = new VideoDownloadService({
    userDataPath: root,
    appRoot: root,
    resourcesPath: root,
    runner: null,
    fallbackRunner: async (task, progress) => {
      fallbackCalls += 1;
      progress(70, "浏览器兜底下载中");
      await mkdir(task.outputDirectory, { recursive: true });
      await writeFile(fallbackFile, "video", "utf8");
      return { outputFiles: [fallbackFile] };
    },
  });
  service.runProcess = async () => { throw new Error("Fresh cookies are needed"); };
  await service.initialize();
  const result = await service.enqueue({ input: "https://v.douyin.com/fallback/", outputDirectory: output });
  const taskId = result.added[0].id;
  await waitFor(() => service.publicState().tasks.find((item) => item.id === taskId)?.status === "completed");
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(service.publicState().tasks.find((item) => item.id === taskId).outputFiles, [fallbackFile]);
});
