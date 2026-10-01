import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 将 PowerShell 诊断器封装成可独立双击的单文件 CMD。 */
export function buildDiagnosticCommand(source) {
  const normalized = String(source).replace(/^\uFEFF/, "");
  const payload = gzipSync(Buffer.from(normalized, "utf8"), { level: 9 }).toString("base64");
  const chunks = payload.match(/.{1,6000}/g) || [];
  const assignments = chunks.map((chunk, index) => `set "P${index}=${chunk}"`);
  const expression = chunks.map((_, index) => `$env:P${index}`).join("+");
  const command = [
    "$ErrorActionPreference='Stop'",
    `$encoded=${expression}`,
    "$bytes=[Convert]::FromBase64String($encoded)",
    "$memory=New-Object IO.MemoryStream(,$bytes)",
    "$gzip=New-Object IO.Compression.GzipStream($memory,[IO.Compression.CompressionMode]::Decompress)",
    "$reader=New-Object IO.StreamReader($gzip,[Text.Encoding]::UTF8)",
    "$script=$reader.ReadToEnd()",
    "& ([ScriptBlock]::Create($script))",
  ].join(";");
  return [
    "@echo off",
    "setlocal",
    ...assignments,
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${command}"`,
    "set \"DIAGNOSTIC_EXIT=%ERRORLEVEL%\"",
    "echo.",
    "if not \"%DIAGNOSTIC_EXIT%\"==\"0\" echo Diagnostic failed. Please send the failure log shown above.",
    "if \"%DIAGNOSTIC_EXIT%\"==\"0\" echo Diagnostic finished. Please send the ZIP path shown above.",
    "pause",
    "exit /b %DIAGNOSTIC_EXIT%",
    "",
  ].join("\r\n");
}

async function main() {
  const sourcePath = path.join(projectRoot, "scripts", "collect-xhs-download-diagnostics.ps1");
  const outputPath = path.resolve(
    process.argv[2] || path.join(projectRoot, "release", "AI媒体库-小红书下载诊断工具.cmd"),
  );
  const source = await readFile(sourcePath, "utf8");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buildDiagnosticCommand(source), "ascii");
  console.log(outputPath);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
