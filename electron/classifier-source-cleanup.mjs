import { stat, unlink } from "node:fs/promises";
import path from "node:path";

function pathInsideRoot(candidatePath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function consumeGeneratedClassifierSources(outputMappings = [], sourceMappings = [], allowedRoots = []) {
  const roots = [...new Set(allowedRoots.filter(Boolean).map((item) => path.resolve(item)))];
  if (!roots.length) return { consumed: [], skipped: [] };

  const approvedSources = new Map();
  for (const mapping of sourceMappings) {
    if (!mapping?.inputPath || !mapping?.sourcePath) continue;
    const inputPath = path.resolve(mapping.inputPath);
    const sourcePath = path.resolve(mapping.sourcePath);
    if (!roots.some((rootPath) => pathInsideRoot(sourcePath, rootPath))) continue;
    approvedSources.set(inputPath, sourcePath);
  }

  const consumed = [];
  const skipped = [];
  for (const mapping of outputMappings) {
    const inputPath = typeof mapping?.sourcePath === "string" ? path.resolve(mapping.sourcePath) : "";
    const outputPath = typeof mapping?.outputPath === "string" ? path.resolve(mapping.outputPath) : "";
    const generatedSourcePath = approvedSources.get(inputPath);
    if (!generatedSourcePath || !outputPath || generatedSourcePath === outputPath) {
      if (generatedSourcePath) skipped.push(generatedSourcePath);
      continue;
    }
    if (!(await isFile(outputPath)) || !(await isFile(generatedSourcePath))) {
      skipped.push(generatedSourcePath);
      continue;
    }
    try {
      await unlink(generatedSourcePath);
      consumed.push(generatedSourcePath);
    } catch {
      skipped.push(generatedSourcePath);
    }
  }
  return { consumed, skipped };
}

export { pathInsideRoot };
