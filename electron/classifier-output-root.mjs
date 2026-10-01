import path from "node:path";

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function pathKey(value, platform) {
  const api = pathApi(platform);
  const resolved = api.resolve(String(value || "").trim());
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function validateClassifierOutputRoot(candidate, {
  platform = process.platform,
  protectedRoots = [],
} = {}) {
  const api = pathApi(platform);
  const value = typeof candidate === "string" ? candidate.trim() : "";
  if (!value || !api.isAbsolute(value)) {
    return { ok: false, error: "请选择有效的分类输出目录" };
  }

  const resolvedPath = api.resolve(value);
  const key = pathKey(resolvedPath, platform);
  const filesystemRoot = pathKey(api.parse(resolvedPath).root, platform);
  const protectedKeys = new Set(protectedRoots
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => pathKey(item, platform)));
  protectedKeys.add(filesystemRoot);

  if (protectedKeys.has(key)) {
    return {
      ok: false,
      error: "不能把系统总目录直接作为分类输出目录，请在其中新建或选择一个项目文件夹",
    };
  }

  return { ok: true, path: resolvedPath };
}

export function isProtectedClassifierRoot(candidate, options = {}) {
  return !validateClassifierOutputRoot(candidate, options).ok;
}
