import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.AI_MEDIA_PYTHON || (process.platform === "win32" ? "python" : "python3");
const target = path.join(projectRoot, "bundled-downloaders", "win32-x64", "xhs-runtime", "Lib", "site-packages");
const requirements = path.join(projectRoot, "scripts", "windows-xhs-runtime-requirements.txt");
const syncScript = path.join(projectRoot, "scripts", "sync-windows-xhs-source.mjs");

const install = spawnSync(python, [
  "-m", "pip", "install",
  "--disable-pip-version-check",
  "--no-deps",
  "--upgrade",
  "--target", target,
  "-r", requirements,
], { cwd: projectRoot, stdio: "inherit", windowsHide: true });

if (install.error) throw install.error;
if (install.status !== 0) throw new Error(`Windows 小红书运行时依赖写入失败（退出码 ${install.status}）`);

const sync = spawnSync(process.execPath, [syncScript], {
  cwd: projectRoot,
  stdio: "inherit",
  windowsHide: true,
});
if (sync.error) throw sync.error;
if (sync.status !== 0) throw new Error(`Windows 小红书源码同步失败（退出码 ${sync.status}）`);

const verify = spawnSync(process.execPath, [path.join(projectRoot, "scripts", "verify-video-downloader-assets.mjs"), "win32-x64"], {
  cwd: projectRoot,
  stdio: "inherit",
  windowsHide: true,
});
if (verify.error) throw verify.error;
if (verify.status !== 0) throw new Error(`Windows 小红书运行时校验失败（退出码 ${verify.status}）`);

console.log("Windows 小红书独立运行时依赖已写入并校验，不需要客户电脑安装 Python 或 pip。");
