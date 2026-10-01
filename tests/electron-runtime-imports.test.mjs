import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyElectronRuntimeImports } from "../scripts/verify-electron-runtime-imports.mjs";

test("current Electron main-process imports are declared runtime dependencies", async () => {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const result = await verifyElectronRuntimeImports({ projectRoot });
  assert.ok(result.checkedFiles > 0);
});

test("packaging preflight rejects an undeclared Electron runtime import", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "ai-media-runtime-import-"));
  await mkdir(path.join(projectRoot, "electron"));
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ dependencies: { semver: "1.0.0" } }));
  await writeFile(path.join(projectRoot, "electron", "main.mjs"), 'import "@xenova/transformers";\nimport semver from "semver";\n');
  await assert.rejects(
    () => verifyElectronRuntimeImports({ projectRoot }),
    /@xenova\/transformers.*缺少 dependencies\.@xenova\/transformers/,
  );
});

test("packaging preflight rejects a relative main-process import omitted from build.files", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "ai-media-runtime-file-"));
  await mkdir(path.join(projectRoot, "electron"));
  await mkdir(path.join(projectRoot, "app"));
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    dependencies: {},
    build: { files: ["electron/**/*", "package.json"] },
  }));
  await writeFile(path.join(projectRoot, "electron", "main.mjs"), 'import "../app/shared.mjs";\n');
  await writeFile(path.join(projectRoot, "app", "shared.mjs"), "export const shared = true;\n");
  await assert.rejects(
    () => verifyElectronRuntimeImports({ projectRoot }),
    /app\/shared\.mjs 未包含在 build\.files/,
  );
});

test("packaging preflight accepts a packaged relative import and checks its nested closure", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "ai-media-runtime-file-"));
  await mkdir(path.join(projectRoot, "electron"));
  await mkdir(path.join(projectRoot, "app"));
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    dependencies: {},
    build: { files: ["electron/**/*", "app/shared.mjs", "app/nested.mjs", "package.json"] },
  }));
  await writeFile(path.join(projectRoot, "electron", "main.mjs"), 'import "../app/shared.mjs";\n');
  await writeFile(path.join(projectRoot, "app", "shared.mjs"), 'export { nested } from "./nested.mjs";\n');
  await writeFile(path.join(projectRoot, "app", "nested.mjs"), "export const nested = true;\n");
  const result = await verifyElectronRuntimeImports({ projectRoot });
  assert.equal(result.checkedFiles, 3);
});

test("Windows and every macOS packaging entry run the shared runtime preflight", async () => {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  for (const name of ["desktop:win", "desktop:win:dir", "desktop:pack", "desktop:dmg:arm64:unsigned", "desktop:dmg:x64:unsigned", "desktop:dmg:universal:unsigned"]) {
    assert.match(manifest.scripts[name], /runtime:verify/, `${name} must run runtime:verify`);
  }
  const notarized = await readFile(path.join(projectRoot, "scripts", "build-macos-notarized.sh"), "utf8");
  assert.match(notarized, /verify-electron-runtime-imports\.mjs/);
});
