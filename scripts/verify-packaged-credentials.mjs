import path from "node:path";
import { createRequire } from "node:module";
import { readdir } from "node:fs/promises";
import { inspectCredentialText, verifyCredentialTree } from "./installer-credentials.mjs";
const require = createRequire(import.meta.url);

export async function verifyPackagedCredentials(resources) {
  const asar = require("@electron/asar");
  const archive = path.join(resources, "app.asar");
  for (const file of asar.listPackage(archive)) {
    const entry = asar.statFile(archive, file.replace(/^\//, ""));
    if (entry.files || entry.link) continue;
    const name = path.basename(file);
    if (/^\.env(?:\.|$)|^secure-config\.json$|^api-settings.*\.bin$/.test(name)) throw new Error(`应用归档含凭证文件：${file}`);
    if (/\.(json|mjs|cjs|js|py)$/i.test(name)) inspectCredentialText(asar.extractFile(archive, file.replace(/^\//, "")).toString("utf8"), file);
  }
  // Credentials can be outside ASAR; check each independently copied resource.
  const folders = await readdir(resources, { withFileTypes: true });
  for (const entry of folders) {
    if (["classifier", "app.asar.unpacked"].includes(entry.name) && entry.isDirectory()) await verifyCredentialTree(path.join(resources, entry.name));
  }
}

export default async function afterPack(context) {
  const resources = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  await verifyPackagedCredentials(resources);
}
