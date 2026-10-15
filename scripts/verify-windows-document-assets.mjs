import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Follow the same dependency chain used by PDF import, including pnpm links.
export async function verifyWindowsDocumentAssets(root) {
  const appRequire = createRequire(path.join(root, "package.json"));
  const officeRequire = createRequire(appRequire.resolve("officeparser"));
  const pdfRequire = createRequire(officeRequire.resolve("pdfjs-dist/package.json"));
  const canvasPath = pdfRequire.resolve("@napi-rs/canvas/package.json");
  const canvas = JSON.parse(await readFile(canvasPath, "utf8"));
  const canvasRequire = createRequire(canvasPath);
  const nativeName = "@napi-rs/canvas-win32-x64-msvc";
  let nativePath;
  try { nativePath = canvasRequire.resolve(`${nativeName}/package.json`); }
  catch { throw new Error("Windows PDF 导入组件缺失，请按 pnpm-workspace.yaml 安装 Windows 可选依赖后再打包"); }
  const native = JSON.parse(await readFile(nativePath, "utf8"));
  if (native.version !== canvas.optionalDependencies?.[nativeName]) {
    throw new Error("Windows PDF 导入组件版本与 canvas 不一致");
  }
  const bytes = await readFile(path.join(path.dirname(nativePath), "skia.win32-x64-msvc.node"));
  const peOffset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : -1;
  if (bytes.length < 1024 || bytes.toString("ascii", 0, 2) !== "MZ"
    || peOffset < 64 || peOffset + 6 > bytes.length
    || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0"
    || bytes.readUInt16LE(peOffset + 4) !== 0x8664) {
    throw new Error("Windows PDF 导入组件不是完整的 Windows x64 原生文件");
  }
  return { version: native.version, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}
