import { constants as fsConstants } from "node:fs";
import { access, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWindowsXhsSourceParity } from "./sync-windows-xhs-source.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supportedTargets = new Set(["darwin-arm64", "darwin-x64", "darwin-universal", "win32-x64"]);

function requiredAssets(target) {
  const windows = target === "win32-x64";
  const downloaderDirectory = path.join(projectRoot, "bundled-downloaders", target);
  const toolDirectory = path.join(projectRoot, "bundled-tools", target);
  const assets = [
    { label: "抖音下载后端 yt-dlp", file: path.join(downloaderDirectory, windows ? "yt-dlp.exe" : "yt-dlp") },
    { label: "媒体合并工具 FFmpeg", file: path.join(toolDirectory, windows ? "ffmpeg.exe" : "ffmpeg") },
  ];
  assets.push(windows
    ? { label: "小红书下载后端 Python 运行时", file: path.join(downloaderDirectory, "xhs-runtime", "python.exe"), minSize: 64 * 1024 }
    : { label: "小红书下载后端 xhs-downloader", file: path.join(downloaderDirectory, "xhs-downloader") });
  return assets;
}

function requiredClassifierFiles(target) {
  if (target !== "win32-x64") return [];
  const classifierRoot = path.join(projectRoot, "bundled-classifier", "bin", target, "engine");
  const sitePackages = path.join(projectRoot, "bundled-downloaders", target, "xhs-runtime", "Lib", "site-packages");
  return [
    { label: "Windows 分类引擎入口", file: path.join(classifierRoot, "engine_entry.py") },
    { label: "Windows 分类引擎核心", file: path.join(classifierRoot, "src", "xiaoguan_classifier", "app.pyc") },
    { label: "Windows 精细切割模块", file: path.join(classifierRoot, "src", "xiaoguan_classifier", "shot_splitter.pyc") },
    { label: "Windows 图像依赖 Pillow", file: path.join(sitePackages, "PIL", "__init__.py") },
    { label: "Windows 视频依赖 imageio", file: path.join(sitePackages, "imageio", "__init__.py") },
    { label: "Windows FFmpeg 桥接依赖", file: path.join(sitePackages, "imageio_ffmpeg", "__init__.py") },
    { label: "Windows 数值计算依赖", file: path.join(sitePackages, "numpy", "__init__.py") },
    { label: "Windows 网络请求依赖", file: path.join(sitePackages, "requests", "__init__.py") },
    { label: "Windows 加密存储依赖", file: path.join(sitePackages, "cryptography", "__init__.py") },
    { label: "Windows 小红书 Click 依赖", file: path.join(sitePackages, "click", "__init__.py") },
    { label: "Windows 小红书 Click 版本信息", file: path.join(sitePackages, "click-8.4.2.dist-info", "METADATA") },
    { label: "Windows 小红书终端颜色依赖", file: path.join(sitePackages, "colorama", "__init__.py") },
    { label: "Windows 小红书终端颜色依赖版本信息", file: path.join(sitePackages, "colorama-0.4.6.dist-info", "METADATA") },
    { label: "Windows 小红书文件时间依赖", file: path.join(sitePackages, "win32_setctime", "__init__.py") },
    { label: "Windows 小红书文件时间依赖版本信息", file: path.join(sitePackages, "win32_setctime-1.2.0.dist-info", "METADATA") },
  ];
}

async function validateWindowsXhsPythonPath(target) {
  if (target !== "win32-x64") return;
  const runtimeRoot = path.join(projectRoot, "bundled-downloaders", target, "xhs-runtime");
  const pythonPathConfig = await readFile(path.join(runtimeRoot, "python312._pth"), "utf8");
  const normalizedLines = pythonPathConfig.split(/\r?\n/).map((line) => line.trim().replace(/\\/g, "/")).filter(Boolean);
  if (!normalizedLines.includes("Lib/site-packages") || !normalizedLines.includes("import site")) {
    throw new Error("Windows 小红书 Python 运行时未启用 Lib/site-packages 或 site 初始化");
  }
  const clickMetadata = await readFile(path.join(runtimeRoot, "Lib", "site-packages", "click-8.4.2.dist-info", "METADATA"), "utf8");
  const coloramaMetadata = await readFile(path.join(runtimeRoot, "Lib", "site-packages", "colorama-0.4.6.dist-info", "METADATA"), "utf8");
  const setctimeMetadata = await readFile(path.join(runtimeRoot, "Lib", "site-packages", "win32_setctime-1.2.0.dist-info", "METADATA"), "utf8");
  if (!/^Version: 8\.4\.2$/m.test(clickMetadata)) throw new Error("Windows 小红书 Click 版本不是锁定的 8.4.2");
  if (!/^Version: 0\.4\.6$/m.test(coloramaMetadata)) throw new Error("Windows 小红书 colorama 版本不是锁定的 0.4.6");
  if (!/^Version: 1\.2\.0$/m.test(setctimeMetadata)) throw new Error("Windows 小红书 win32-setctime 版本不是锁定的 1.2.0");
}

async function validateWindowsXhsSourceParity(target) {
  if (target !== "win32-x64") return;
  const result = await verifyWindowsXhsSourceParity({ projectRoot });
  if (result.failures.length) {
    throw new Error([
      `Windows 小红书运行时源码不同步（已检查 ${result.checked} 个文件）`,
      ...result.failures.map((failure) => `- ${failure}`),
    ].join("\n"));
  }
}

async function validateXhsLauncher(target) {
  if (target !== "win32-x64") return;
  const launcher = path.join(projectRoot, "bundled-downloaders", target, "xhs-runtime", "xhs_launcher.py");
  await access(launcher, fsConstants.R_OK);
  const source = await readFile(launcher, "utf8");
  if (!source.includes("xhs_cli.app")) throw new Error(`小红书下载启动器无效：${launcher}`);
}

async function validateExecutable(target, asset) {
  await access(asset.file, fsConstants.R_OK | fsConstants.X_OK);
  const metadata = await stat(asset.file);
  if (!metadata.isFile() || metadata.size < (asset.minSize ?? 1024 * 1024)) {
    throw new Error(`${asset.label}不是完整的独立可执行文件：${asset.file}`);
  }
  const handle = await open(asset.file, "r");
  try {
    const header = Buffer.alloc(4);
    await handle.read(header, 0, header.length, 0);
    const signature = header.toString("hex");
    if (target === "win32-x64" && signature.slice(0, 4) !== "4d5a") {
      throw new Error(`${asset.label}不是 Windows PE 可执行文件：${asset.file}`);
    }
    const machOSignatures = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);
    if (target.startsWith("darwin-") && !machOSignatures.has(signature)) {
      throw new Error(`${asset.label}不是 macOS Mach-O 可执行文件：${asset.file}`);
    }
  } finally {
    await handle.close();
  }
}

async function verifyTarget(target) {
  if (!supportedTargets.has(target)) throw new Error(`不支持的视频下载运行时目标：${target}`);
  const failures = [];
  for (const asset of requiredAssets(target)) {
    try {
      await validateExecutable(target, asset);
    } catch (error) {
      const detail = error?.code === "ENOENT"
        ? `${asset.label}缺失：${asset.file}`
        : error instanceof Error ? error.message : String(error);
      failures.push(detail);
    }
  }
  for (const asset of requiredClassifierFiles(target)) {
    try {
      await access(asset.file, fsConstants.R_OK);
      const metadata = await stat(asset.file);
      if (!metadata.isFile() || metadata.size === 0) throw new Error(`${asset.label}无效：${asset.file}`);
    } catch (error) {
      const detail = error?.code === "ENOENT"
        ? `${asset.label}缺失：${asset.file}`
        : error instanceof Error ? error.message : String(error);
      failures.push(detail);
    }
  }
  try {
    await validateXhsLauncher(target);
  } catch (error) {
    failures.push(error?.code === "ENOENT" ? `小红书下载启动器缺失` : error instanceof Error ? error.message : String(error));
  }
  try {
    await validateWindowsXhsPythonPath(target);
  } catch (error) {
    failures.push(error?.code === "ENOENT" ? `Windows 小红书 Python 路径配置缺失` : error instanceof Error ? error.message : String(error));
  }
  try {
    await validateWindowsXhsSourceParity(target);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (failures.length) {
    throw new Error([
      `${target} 视频下载运行时不完整，已阻止生成不可用安装包：`,
      ...failures.map((message) => `- ${message}`),
    ].join("\n"));
  }
  console.log(`${target} 视频下载运行时检查通过`);
}

const requestedTarget = process.argv[2] || "all";
const targets = requestedTarget === "all"
  ? ["darwin-arm64", "darwin-x64", "win32-x64"]
  : [requestedTarget];

const targetFailures = [];
for (const target of targets) {
  try {
    await verifyTarget(target);
  } catch (error) {
    targetFailures.push(error instanceof Error ? error.message : String(error));
  }
}
if (targetFailures.length) throw new Error(targetFailures.join("\n\n"));
