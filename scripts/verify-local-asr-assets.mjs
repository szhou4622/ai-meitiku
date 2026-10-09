import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWindowsDocumentAssets } from "./verify-windows-document-assets.mjs";

export async function verifyLocalAsrAssets(root, target = `${process.platform}-${process.arch}`) {
  const manifest = JSON.parse(await readFile(path.join(root, "local-asr-manifest.json"), "utf8"));
  const targets = target === "all" ? ["darwin-arm64", "darwin-x64", "win32-x64"]
    : target === "darwin-universal" ? ["darwin-arm64", "darwin-x64"] : [target];
  for (const name of targets) {
    if (!manifest.files.some(entry => entry.target === name)) throw new Error(`缺少 ${name} 的 Whisper 组件清单`);
  }
  const files = manifest.files.filter(entry => entry.target === "shared" || targets.includes(entry.target));
  for (const entry of files) {
    const file = path.join(root, entry.path);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size !== entry.bytes) throw new Error(`本地语音组件缺失或不完整：${entry.path}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex") !== entry.sha256) throw new Error(`本地语音组件校验失败：${entry.path}`);
  }
  return { target, checked: files.length };
}

// electron-builder invokes this before copying the platform runtime and model.
export default async function beforePack(context) {
  const arch = typeof context.arch === "string" ? context.arch : { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" }[context.arch];
  await verifyLocalAsrAssets(context.packager.info.appDir, `${context.electronPlatformName}-${arch}`);
  if (context.electronPlatformName === "win32" && arch === "x64") {
    await verifyWindowsDocumentAssets(context.packager.info.appDir);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  console.log(await verifyLocalAsrAssets(root, process.argv[2]));
}
