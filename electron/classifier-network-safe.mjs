import { randomUUID } from "node:crypto";
import { copyFile, link, mkdir, realpath, rename, stat, unlink, utimes } from "node:fs/promises";
import path from "node:path";

export const NETWORK_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 45_000]);

const RETRYABLE_NETWORK_ERROR = /(?:WinError\s*(?:64|121|1450|1451|1452|1453|1455)|ERROR_NO_SYSTEM_RESOURCES|ECONNRESET|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|网络(?:连接|路径|名称).*?(?:中断|不可用)|系统资源不足|文件大小校验失败|回写.*校验失败)/i;

export function isUncPath(value) {
  const source = String(value || "").trim();
  return /^\\\\[^\\]+\\[^\\]+/.test(source) || /^\/\/[^/]+\/[^/]+/.test(source);
}

export function parseMappedNetworkDriveLetters(source) {
  const matches = String(source || "").matchAll(/(?:^|\s)([A-Za-z]:)\s+\\\\[^\s]+/gm);
  return new Set([...matches].map((match) => match[1].toUpperCase()));
}

export function isMappedNetworkPath(value, driveLetters = new Set()) {
  const match = String(value || "").trim().match(/^([A-Za-z]:)[\\/]/);
  return Boolean(match && driveLetters.has(match[1].toUpperCase()));
}

export function isRetryableNetworkFailure(value) {
  return RETRYABLE_NETWORK_ERROR.test(String(value || ""));
}

export function safeModeDescription({ inputNetwork = false, outputNetwork = false } = {}) {
  if (inputNetwork && outputNetwork) return "输入和输出均位于共享网盘";
  if (inputNetwork) return "输入位于共享网盘";
  if (outputNetwork) return "输出位于共享网盘";
  return "";
}

export function isClassifierHandoffInput(folder, userDataPath, pathApi = path) {
  if (typeof folder !== "string" || !folder.trim() || typeof userDataPath !== "string" || !userDataPath.trim()) return false;
  const handoffRoot = pathApi.join(userDataPath, "classifier-handoffs");
  const relative = pathApi.relative(handoffRoot, folder);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[\\/]input$/i.test(relative);
}

async function preserveTimes(sourcePath, targetPath) {
  const info = await stat(sourcePath);
  await utimes(targetPath, info.atime, info.mtime);
  return info;
}

export async function copyFileWithRetry(sourcePath, targetPath, {
  retryDelays = NETWORK_RETRY_DELAYS_MS,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  onRetry = () => {},
} = {}) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  let lastError;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      await copyFile(sourcePath, targetPath);
      const [sourceInfo, targetInfo] = await Promise.all([stat(sourcePath), stat(targetPath)]);
      if (sourceInfo.size !== targetInfo.size) throw new Error(`文件大小校验失败：${sourceInfo.size} != ${targetInfo.size}`);
      await preserveTimes(sourcePath, targetPath);
      return { size: targetInfo.size, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (attempt >= retryDelays.length || !isRetryableNetworkFailure(error?.message || error)) throw error;
      onRetry({ attempt: attempt + 1, delay: retryDelays[attempt], error });
      await sleep(retryDelays[attempt]);
    }
  }
  throw lastError;
}

export async function stageClassifierPhysicalSource(sourcePath, inputRoot, {
  forceCopy = false,
  onRetry = () => {},
  linkFile = link,
} = {}) {
  await mkdir(inputRoot, { recursive: true });
  const targetPath = path.join(inputRoot, path.basename(sourcePath));
  const assertInsideInput = async () => {
    const [root, candidate] = await Promise.all([realpath(inputRoot), realpath(targetPath)]);
    const relative = path.relative(root, candidate);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("素材交接失败：暂存文件解析后不在本机输入目录内");
    }
  };
  if (!forceCopy) {
    try {
      await linkFile(sourcePath, targetPath);
      await assertInsideInput();
      return { path: targetPath, method: "linked" };
    } catch {
      // Cross-volume hard links are impossible. A symbolic link would resolve
      // outside inputRoot and break the classifier's relative-path check.
      await unlink(targetPath).catch(() => {});
    }
  }
  await copyFileWithRetry(sourcePath, targetPath, { onRetry });
  await assertInsideInput();
  return { path: targetPath, method: "copied" };
}

export async function commitFileToNetwork(sourcePath, desiredPath, options = {}) {
  const destinationDirectory = path.dirname(desiredPath);
  await mkdir(destinationDirectory, { recursive: true });
  const temporaryPath = path.join(destinationDirectory, `.${path.basename(desiredPath)}.ai-media-${randomUUID()}.part`);
  try {
    const copied = await copyFileWithRetry(sourcePath, temporaryPath, options);
    await rename(temporaryPath, desiredPath);
    const destinationInfo = await stat(desiredPath);
    if (destinationInfo.size !== copied.size) throw new Error("共享网盘回写后的文件大小校验失败");
    return { path: desiredPath, size: destinationInfo.size, attempts: copied.attempts };
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
