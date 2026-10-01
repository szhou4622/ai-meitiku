import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

export const LOCAL_VISUAL_MODEL_ID = "Xenova/clip-vit-base-patch32";
export const LOCAL_VISUAL_MODEL_REVISION = "d15189d7028b43f1d3e65039190477f6af591c2a";
export const LOCAL_VISUAL_MODEL_ROUTE = "/__local_visual_model/";

export const LOCAL_VISUAL_MODEL_FILES = Object.freeze([
  { path: "config.json", size: 4524, sha256: "493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495" },
  { path: "merges.txt", size: 524619, sha256: "9fd691f7c8039210e0fced15865466c65820d09b63988b0174bfe25de299051a" },
  { path: "preprocessor_config.json", size: 520, sha256: "6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f" },
  { path: "special_tokens_map.json", size: 472, sha256: "c4864a9376a8401918425bed71fc14fc0e81f9b59ec45c1cf96cccb2df508eac" },
  { path: "tokenizer.json", size: 2224119, sha256: "f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd" },
  { path: "tokenizer_config.json", size: 775, sha256: "60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967" },
  { path: "vocab.json", size: 862328, sha256: "5047b556ce86ccaf6aa22b3ffccfc52d391ea4accdab9c2f2407da5b742d4363" },
  { path: "onnx/text_model_quantized.onnx", size: 64504507, sha256: "73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a" },
  { path: "onnx/vision_model_quantized.onnx", size: 89117001, sha256: "583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299" },
]);

const allowedModelFiles = new Set(LOCAL_VISUAL_MODEL_FILES.map((file) => `${LOCAL_VISUAL_MODEL_ID}/${file.path}`));

export function localVisualModelDirectory(projectRoot) {
  return path.join(projectRoot, "bundled-models");
}

export function localVisualModelFile(rootDirectory, relativeFile) {
  return path.join(rootDirectory, LOCAL_VISUAL_MODEL_ID, relativeFile);
}

export function resolveLocalVisualModelRequest(rootDirectory, requestPathname) {
  if (!requestPathname.startsWith(LOCAL_VISUAL_MODEL_ROUTE)) return null;
  let relativeFile;
  try {
    relativeFile = decodeURIComponent(requestPathname.slice(LOCAL_VISUAL_MODEL_ROUTE.length));
  } catch {
    return null;
  }
  if (!allowedModelFiles.has(relativeFile)) return null;
  const resolved = path.resolve(rootDirectory, relativeFile);
  const relative = path.relative(rootDirectory, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

export async function verifyLocalVisualModel(rootDirectory, { checksum = true } = {}) {
  const failures = [];
  for (const expected of LOCAL_VISUAL_MODEL_FILES) {
    const filePath = localVisualModelFile(rootDirectory, expected.path);
    try {
      const metadata = await stat(filePath);
      if (!metadata.isFile()) {
        failures.push(`${expected.path}: 不是文件`);
        continue;
      }
      if (metadata.size !== expected.size) {
        failures.push(`${expected.path}: 大小异常（${metadata.size}/${expected.size}）`);
        continue;
      }
      if (checksum) {
        const actualHash = await sha256File(filePath);
        if (actualHash !== expected.sha256) failures.push(`${expected.path}: SHA-256 不匹配`);
      }
    } catch (error) {
      failures.push(`${expected.path}: ${error?.code === "ENOENT" ? "缺失" : error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    totalBytes: LOCAL_VISUAL_MODEL_FILES.reduce((sum, file) => sum + file.size, 0),
  };
}
