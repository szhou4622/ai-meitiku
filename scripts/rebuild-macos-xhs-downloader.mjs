import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const xhsRoot = path.join(projectRoot, "third_party", "video-downloaders", "xhs");
const python = path.join(xhsRoot, ".venv", "bin", "python");
const targetArch = process.argv[2] || process.arch;
const nativeArch = process.arch === "x64" ? "x64" : "arm64";

if (process.platform !== "darwin") throw new Error("小红书 macOS 后端只能在 macOS 构建");
if (!["arm64", "x64"].includes(targetArch)) throw new Error(`不支持的 macOS 架构：${targetArch}`);
if (targetArch !== nativeArch) {
  throw new Error(`当前 Python 是 ${nativeArch}，不能构建 ${targetArch} 后端；请在对应架构环境构建`);
}

const versionSource = await readFile(
  path.join(xhsRoot, "packages", "xhs-core", "src", "xhs_core", "version.py"),
  "utf8",
);
const expectedVersion = versionSource.match(/^VERSION\s*=\s*["']([^"']+)["']/m)?.[1];
if (!expectedVersion) throw new Error("无法读取小红书下载器源码版本");

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aiml-xhs-build-"));
const distPath = path.join(temporaryRoot, "dist");
const workPath = path.join(temporaryRoot, "work");
const specPath = path.join(temporaryRoot, "spec");
const builtExecutable = path.join(distPath, "xhs-downloader");
const targetDirectory = path.join(projectRoot, "bundled-downloaders", `darwin-${targetArch}`);
const targetExecutable = path.join(targetDirectory, "xhs-downloader");
const temporaryTarget = `${targetExecutable}.${process.pid}.tmp`;
const targetManifest = path.join(targetDirectory, "xhs-downloader.build.json");
const temporaryManifest = `${targetManifest}.${process.pid}.tmp`;

try {
  const args = [
    "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
    "--name", "xhs-downloader", "--distpath", distPath,
    "--workpath", workPath, "--specpath", specPath,
    "--paths", path.join(xhsRoot, "apps", "cli", "src"),
    "--paths", path.join(xhsRoot, "packages", "xhs-adapters", "src"),
    "--paths", path.join(xhsRoot, "packages", "xhs-core", "src"),
    "--paths", path.join(xhsRoot, "packages", "xhs-sdk", "src"),
    "--collect-all", "xhs_adapters",
    "--collect-all", "xhs_core",
    "--collect-all", "xhs_cli",
    "--collect-all", "lxml",
    "--collect-all", "playwright",
    path.join(xhsRoot, "main.py"),
  ];
  await execFileAsync(python, args, { cwd: xhsRoot, maxBuffer: 8 * 1024 * 1024 });

  const builtStats = await stat(builtExecutable);
  if (!builtStats.isFile() || builtStats.size < 20 * 1024 * 1024) {
    throw new Error("新构建的小红书后端不是完整可执行文件");
  }
  const { stdout } = await execFileAsync(builtExecutable, ["version"], { cwd: temporaryRoot, timeout: 10_000 });
  if (!stdout.includes(expectedVersion)) {
    throw new Error(`后端版本与当前源码不一致（源码 ${expectedVersion}）`);
  }

  await mkdir(targetDirectory, { recursive: true });
  await copyFile(builtExecutable, temporaryTarget);
  await chmod(temporaryTarget, 0o755);
  await rename(temporaryTarget, targetExecutable);
  const digest = createHash("sha256").update(await readFile(targetExecutable)).digest("hex");
  const manifest = {
    target: `darwin-${targetArch}`,
    version: expectedVersion,
    bytes: builtStats.size,
    sha256: digest,
  };
  await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  await rename(temporaryManifest, targetManifest);
  console.log(JSON.stringify(manifest));
} finally {
  await rm(temporaryTarget, { force: true }).catch(() => {});
  await rm(temporaryManifest, { force: true }).catch(() => {});
  await rm(temporaryRoot, { recursive: true, force: true });
}
