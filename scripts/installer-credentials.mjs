import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLeakedApiKey, isLeakedEndpoint } from "../electron/customer-api-profiles.mjs";
import verifyAssets from "./verify-local-asr-assets.mjs";

const forbiddenFile = name => /^\.env(?:\.|$)/i.test(name) || /^(?:api-settings.*\.bin|secure-config\.json|platform-api.*|points-internal\.token|device-auth\.env)$/.test(name);
const secretField = /^(?:apiKey|api_key|ARK_API_KEY|MINIMAX_API_KEY|accessKeySecret|accessKeyId|clientSecret|deviceCredential|deviceSession)$/i;
export function inspectCredentialText(text, filename) {
  const assignments = text.matchAll(/\b(?:ARK_API_KEY|MINIMAX_API_KEY|apiKey|api_key|accessKeySecret)\b["']?\s*[:=]\s*["']([^"'\r\n]+)["']/g);
  for (const match of assignments) {
    if (match[1].length >= 20 && /[A-Za-z]/.test(match[1]) && /[0-9]/.test(match[1]))
      throw new Error(`安装资源含硬编码凭证：${filename}`);
  }
  // Detect the known incident in code, data and binary string representations,
  // without keeping or printing any credential in the checker.
  for (const value of text.match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}|ep-[A-Za-z0-9_-]+/gi) || []) {
    if (isLeakedApiKey(value) || isLeakedEndpoint(value)) throw new Error(`安装资源含历史泄露配置：${filename}`);
  }
  if (filename.endsWith(".json")) {
    let data;
    try { data = JSON.parse(text); } catch { return; }
    const inspect = value => {
      if (!value || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        if (secretField.test(key) && typeof entry === "string" && entry.trim()) throw new Error(`安装资源含凭证字段：${filename}`);
        if (key === "model" && typeof entry === "string" && entry.startsWith("ep-")) throw new Error(`安装资源含个人接入点：${filename}`);
        inspect(entry);
      }
    };
    inspect(data);
  }
}

export async function verifyCredentialTree(root) {
  let checked = 0;
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) {
        if (forbiddenFile(entry.name) || /\.(json|mjs|js|py|ini|cfg)$/.test(entry.name)) throw new Error(`安装配置不允许符号链接：${file}`);
        continue;
      }
      if (entry.isDirectory()) { await walk(file); continue; }
      if (forbiddenFile(entry.name)) throw new Error(`安装资源禁止携带用户或开发凭证文件：${file}`);
      if (/\.(json|mjs|cjs|js|py|txt|yaml|yml|ini|cfg)$/i.test(entry.name)) {
        inspectCredentialText(await readFile(file, "utf8"), file); checked++;
      }
    }
  }
  await walk(root);
  return { checked };
}

export async function verifyInstallerInputs(root) {
  // Classifier defaults are shipped verbatim; never permit personal model IDs.
  await verifyCredentialTree(path.join(root, "bundled-classifier", "config"));
  for (const folder of ["bundled-classifier", "electron/voice-backend"]) {
    for (const entry of await readdir(path.join(root, folder))) {
      if (forbiddenFile(entry)) throw new Error(`打包输入含凭证文件：${folder}/${entry}`);
    }
  }
}

export default async function beforePack(context) {
  await verifyInstallerInputs(context.packager.info.appDir);
  await verifyAssets(context);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyInstallerInputs(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  console.log("安装包凭证输入检查通过");
}
