import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyWindowsXhsSourceParity } from "../scripts/sync-windows-xhs-source.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(projectRoot, "bundled-downloaders", "win32-x64", "xhs-runtime");
const sitePackages = path.join(runtimeRoot, "Lib", "site-packages");

test("Windows Xiaohongshu runtime contains its locked CLI imports", async () => {
  const required = [
    path.join(sitePackages, "click", "__init__.py"),
    path.join(sitePackages, "colorama", "__init__.py"),
    path.join(sitePackages, "win32_setctime", "__init__.py"),
    path.join(sitePackages, "xhs_cli", "app.py"),
  ];
  await Promise.all(required.map((filePath) => access(filePath)));

  const [clickMetadata, coloramaMetadata, setctimeMetadata, pythonPath] = await Promise.all([
    readFile(path.join(sitePackages, "click-8.4.2.dist-info", "METADATA"), "utf8"),
    readFile(path.join(sitePackages, "colorama-0.4.6.dist-info", "METADATA"), "utf8"),
    readFile(path.join(sitePackages, "win32_setctime-1.2.0.dist-info", "METADATA"), "utf8"),
    readFile(path.join(runtimeRoot, "python312._pth"), "utf8"),
  ]);
  assert.match(clickMetadata, /^Version: 8\.4\.2$/m);
  assert.match(coloramaMetadata, /^Version: 0\.4\.6$/m);
  assert.match(setctimeMetadata, /^Version: 1\.2\.0$/m);
  assert.match(pythonPath.replace(/\\/g, "/"), /^Lib\/site-packages$/m);
  assert.match(pythonPath, /^import site$/m);
});

test("packaging preflight rejects a Windows runtime missing any locked dependency", async () => {
  const verifier = await readFile(path.join(projectRoot, "scripts", "verify-video-downloader-assets.mjs"), "utf8");
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  assert.match(verifier, /click-8\.4\.2\.dist-info/);
  assert.match(verifier, /colorama-0\.4\.6\.dist-info/);
  assert.match(verifier, /win32_setctime-1\.2\.0\.dist-info/);
  assert.match(verifier, /Lib\/site-packages/);
  assert.match(packageJson.scripts["desktop:win"], /verify-video-downloader-assets\.mjs win32-x64/);
  assert.match(packageJson.scripts["downloaders:vendor:win-xhs"], /vendor-windows-xhs-runtime\.mjs/);
  assert.match(packageJson.scripts["desktop:win"], /xhs:sync:win/);
});

test("Windows Xiaohongshu bundled source exactly matches the reviewed source tree", async () => {
  const result = await verifyWindowsXhsSourceParity({ projectRoot });
  assert.ok(result.checked > 0);
  assert.deepEqual(result.failures, []);
});
