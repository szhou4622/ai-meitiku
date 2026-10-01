import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "../..");
const stagingRoot = path.join(projectRoot, "build", "device-diagnostic-app");

const files = [
  "device-diagnostic-main.mjs",
  "device-diagnostic-document.mjs",
  "device-diagnostic-preload.cjs",
  "device-diagnostic-service.mjs",
  "device-diagnostic.html",
  "device-diagnostic.css",
  "device-diagnostic-renderer.js",
  "license-config.mjs",
  "license-secure-store.mjs",
  "machine-code.mjs",
];

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(path.join(stagingRoot, "electron"), { recursive: true });
for (const file of files) {
  await cp(path.join(projectRoot, "electron", file), path.join(stagingRoot, "electron", file));
}
await cp(
  path.join(projectRoot, "electron", "machine-identity"),
  path.join(stagingRoot, "electron", "machine-identity"),
  { recursive: true },
);

const rootPackage = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const packageJson = {
  name: "ai-media-device-diagnostic",
  version: rootPackage.version,
  private: true,
  description: "AI媒体库设备冲突安全核验工具",
  author: "梅小倩",
  main: "electron/device-diagnostic-main.mjs",
  type: "module",
};
await writeFile(path.join(stagingRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
