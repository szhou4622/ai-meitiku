import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { verifyWindowsDocumentAssets } from "../scripts/verify-windows-document-assets.mjs";

test("Windows PDF packaging rejects a missing, mismatched or wrong-platform native dependency", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "windows-document-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), "{}");
  for (const name of ["officeparser", "pdfjs-dist", "@napi-rs/canvas"]) {
    const dir = path.join(root, "node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, main: "package.json",
      optionalDependencies: { "@napi-rs/canvas-win32-x64-msvc": "1.0.8" } }));
  }
  await assert.rejects(verifyWindowsDocumentAssets(root), /组件缺失/);
  const nativeDir = path.join(root, "node_modules", "@napi-rs/canvas-win32-x64-msvc");
  await mkdir(nativeDir, { recursive: true });
  const manifest = path.join(nativeDir, "package.json");
  await writeFile(manifest, JSON.stringify({ version: "1.0.9" }));
  await assert.rejects(verifyWindowsDocumentAssets(root), /版本/);
  await writeFile(manifest, JSON.stringify({ version: "1.0.8" }));
  const file = path.join(nativeDir, "skia.win32-x64-msvc.node");
  await writeFile(file, "Mac native bytes");
  await assert.rejects(verifyWindowsDocumentAssets(root), /Windows x64/);
  const bytes = Buffer.alloc(2048);
  bytes.write("MZ"); bytes.writeUInt32LE(128, 0x3c); bytes.write("PE\0\0", 128);
  bytes.writeUInt16LE(0xaa64, 132);
  await writeFile(file, bytes);
  await assert.rejects(verifyWindowsDocumentAssets(root), /Windows x64/);
  bytes.writeUInt16LE(0x8664, 132);
  await writeFile(file, bytes);
  const result = await verifyWindowsDocumentAssets(root);
  assert.equal(result.version, "1.0.8");
  assert.equal(result.bytes, 2048);
});
