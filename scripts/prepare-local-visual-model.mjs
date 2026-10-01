import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  LOCAL_VISUAL_MODEL_FILES,
  LOCAL_VISUAL_MODEL_ID,
  LOCAL_VISUAL_MODEL_REVISION,
  localVisualModelDirectory,
  localVisualModelFile,
  sha256File,
  verifyLocalVisualModel,
} from "../electron/local-visual-model.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelRoot = localVisualModelDirectory(projectRoot);
const verifyOnly = process.argv.includes("--verify-only");

async function fileMatches(expected) {
  const filePath = localVisualModelFile(modelRoot, expected.path);
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size !== expected.size) return false;
    return await sha256File(filePath) === expected.sha256;
  } catch {
    return false;
  }
}

async function downloadFile(expected) {
  const target = localVisualModelFile(modelRoot, expected.path);
  const temporary = `${target}.partial-${process.pid}`;
  const source = `https://huggingface.co/${LOCAL_VISUAL_MODEL_ID}/resolve/${LOCAL_VISUAL_MODEL_REVISION}/${expected.path}`;
  await mkdir(path.dirname(target), { recursive: true });
  await rm(temporary, { force: true });
  process.stdout.write(`下载本地画面识别模型：${expected.path}\n`);
  const response = await fetch(source, { redirect: "follow", signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`${expected.path} 下载失败（HTTP ${response.status}）`);
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx", mode: 0o644 }));
    const metadata = await stat(temporary);
    if (metadata.size !== expected.size) throw new Error(`${expected.path} 大小不匹配（${metadata.size}/${expected.size}）`);
    const actualHash = await sha256File(temporary);
    if (actualHash !== expected.sha256) throw new Error(`${expected.path} SHA-256 不匹配`);
    // Windows cannot atomically replace an existing file with rename(). The
    // new payload is already fully verified, so remove only the stale target.
    await rm(target, { force: true });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

if (verifyOnly) {
  const result = await verifyLocalVisualModel(modelRoot);
  if (!result.ok) {
    throw new Error(["本地画面识别模型不完整，已阻止打包：", ...result.failures.map((failure) => `- ${failure}`)].join("\n"));
  }
  console.log(`本地画面识别模型校验通过（${(result.totalBytes / 1024 / 1024).toFixed(1)} MiB）`);
  process.exit(0);
}

for (const expected of LOCAL_VISUAL_MODEL_FILES) {
  if (!await fileMatches(expected)) await downloadFile(expected);
}

const result = await verifyLocalVisualModel(modelRoot);
if (!result.ok) throw new Error(result.failures.join("\n"));
console.log(`本地画面识别模型已准备并完成校验（${(result.totalBytes / 1024 / 1024).toFixed(1)} MiB）`);
