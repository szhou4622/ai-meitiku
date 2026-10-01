import path from "node:path";

const CLASSIFIER_MEDIA_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp",
  ".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi",
  ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg",
]);

export function classifierPathInsideRoot(candidatePath, rootPath) {
  if (typeof candidatePath !== "string" || !candidatePath.trim() || typeof rootPath !== "string" || !rootPath.trim()) return false;
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function collectClassifierOutputCandidates({ outputFiles = [], outputMappings = [], logs = [], operationLog = null } = {}) {
  const candidates = [];
  for (const filePath of Array.isArray(outputFiles) ? outputFiles : []) {
    if (typeof filePath === "string" && filePath.trim()) candidates.push(filePath.trim());
  }
  for (const mapping of Array.isArray(outputMappings) ? outputMappings : []) {
    if (typeof mapping?.outputPath === "string" && mapping.outputPath.trim()) candidates.push(mapping.outputPath.trim());
  }
  for (const line of Array.isArray(logs) ? logs : []) {
    const match = String(line || "").trim().match(/^(?:已复制到|已输出：)\s*(.+?)(?:，源文件保留不动|（源文件保留）)$/);
    if (match?.[1]?.trim()) candidates.push(match[1].trim());
  }
  const operations = Array.isArray(operationLog?.operations) ? operationLog.operations : [];
  for (const operation of operations) {
    if (operation?.action !== "copy" || typeof operation?.new_path !== "string" || !operation.new_path.trim()) continue;
    candidates.push(operation.new_path.trim());
  }
  return [...new Set(candidates.map((item) => path.resolve(item)))];
}

export function collectClassifierOperationMappings(operationLog = null) {
  const operations = Array.isArray(operationLog?.operations) ? operationLog.operations : [];
  return operations.flatMap((operation) => (
    operation?.action === "copy"
      && typeof operation?.old_path === "string"
      && operation.old_path.trim()
      && typeof operation?.new_path === "string"
      && operation.new_path.trim()
      ? [{ sourcePath: path.resolve(operation.old_path), outputPath: path.resolve(operation.new_path) }]
      : []
  ));
}

export async function validateClassifierOutputCandidates(outputRoot, candidates, statFile) {
  if (typeof statFile !== "function") throw new TypeError("statFile is required");
  const accepted = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!classifierPathInsideRoot(candidate, outputRoot)) continue;
    if (!CLASSIFIER_MEDIA_EXTENSIONS.has(path.extname(candidate).toLowerCase())) continue;
    try {
      if ((await statFile(candidate)).isFile()) accepted.push(path.resolve(candidate));
    } catch {
      // A listed shared-drive file may be temporarily unavailable. Keep it out
      // of this sync attempt without broadening into a directory scan.
    }
  }
  return [...new Set(accepted)];
}

export function countClassifierCsvDataRows(content) {
  const lines = String(content || "").replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return Math.max(0, lines.length - (lines.length ? 1 : 0));
}

export function diagnoseClassifierFailureList(content) {
  if (/(?:is not in the subpath of|不在.*子路径)/i.test(String(content || ""))) {
    return "素材交接失败：临时输入路径与原素材路径不一致，请重新导入后重试；无需更换 API Key";
  }
  return "";
}

export function remainingGeneratedRetrySources(sourceMappings = [], consumedSourceFiles = []) {
  const consumed = new Set((Array.isArray(consumedSourceFiles) ? consumedSourceFiles : []).filter(Boolean).map((item) => path.resolve(item)));
  return [...new Set((Array.isArray(sourceMappings) ? sourceMappings : []).flatMap((mapping) => {
    const sourcePath = typeof mapping?.sourcePath === "string" ? mapping.sourcePath.trim() : "";
    return sourcePath && !consumed.has(path.resolve(sourcePath)) ? [path.resolve(sourcePath)] : [];
  }))];
}
