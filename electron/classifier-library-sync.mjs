import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const CLASSIFIER_MARKERS = [
  /^整理日志_.+\.md$/i,
  /^分类清单\.csv$/i,
  /^整理断点记录\.jsonl$/i,
];

function isInside(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function classifierSegmentsDirectoryInfo(segmentDirectory) {
  if (typeof segmentDirectory !== "string" || !segmentDirectory.trim() || !path.isAbsolute(segmentDirectory.trim())) return null;
  const resolvedPath = path.resolve(segmentDirectory.trim());
  if (path.basename(resolvedPath).toLowerCase() !== "segments") return null;
  const taskDirectory = path.dirname(resolvedPath);
  const outputsDirectory = path.dirname(taskDirectory);
  if (taskDirectory === outputsDirectory || path.basename(outputsDirectory).toLowerCase() !== "outputs") return null;
  const taskName = path.basename(taskDirectory);
  if (!taskName || taskName === "." || taskName === ".." || taskName.toLowerCase() === "outputs") return null;
  return { path: resolvedPath, name: taskName, taskDirectory, outputsDirectory };
}

export function classifierCategoryDirectory(outputRoot, filePath) {
  if (!outputRoot || !filePath || !isInside(outputRoot, filePath)) return null;
  const relative = path.relative(path.resolve(outputRoot), path.resolve(filePath));
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length < 2 || parts[0].toLowerCase() === "outputs") return null;
  return path.join(path.resolve(outputRoot), parts[0]);
}

export function groupClassifierOutputFiles(outputRoot, outputFiles) {
  const groups = new Map();
  for (const filePath of [...new Set(Array.isArray(outputFiles) ? outputFiles : [])]) {
    if (typeof filePath !== "string" || !filePath.trim()) continue;
    const categoryPath = classifierCategoryDirectory(outputRoot, filePath.trim());
    if (!categoryPath) continue;
    if (!groups.has(categoryPath)) groups.set(categoryPath, []);
    groups.get(categoryPath).push(path.resolve(filePath.trim()));
  }
  return [...groups].map(([folderPath, files]) => ({
    folder: { path: folderPath, name: path.basename(folderPath), available: true },
    files,
  }));
}

async function hasClassifierMarker(outputRoot, readDirectory) {
  try {
    const names = await readDirectory(path.join(outputRoot, "outputs"));
    return names.some((name) => CLASSIFIER_MARKERS.some((pattern) => pattern.test(String(name))));
  } catch {
    return false;
  }
}

export async function detectClassifierCategoryFolder(filePath, {
  readDirectory = readdir,
  statPath = stat,
  markerCache = new Map(),
  maxDepth = 6,
  excludedRoots = [],
} = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  const resolvedFile = path.resolve(filePath);
  const pathKey = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const excludedRootKeys = new Set(excludedRoots
    .filter((item) => typeof item === "string" && item.trim())
    .map(pathKey));
  let candidateRoot = path.dirname(resolvedFile);

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (excludedRootKeys.has(pathKey(candidateRoot))) break;
    let marked = markerCache.get(candidateRoot);
    if (marked === undefined) {
      marked = await hasClassifierMarker(candidateRoot, readDirectory);
      markerCache.set(candidateRoot, marked);
    }
    if (marked) {
      const categoryPath = classifierCategoryDirectory(candidateRoot, resolvedFile);
      if (!categoryPath) return null;
      try {
        if (!(await statPath(categoryPath)).isDirectory()) return null;
      } catch {
        return null;
      }
      return {
        path: categoryPath,
        name: path.basename(categoryPath),
        available: true,
        parentPath: candidateRoot,
        indexMode: "exact",
      };
    }
    const parent = path.dirname(candidateRoot);
    if (parent === candidateRoot) break;
    candidateRoot = parent;
  }
  return null;
}
