#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const manifestPath = resolve(projectRoot, "bundled-manifest.json");
const allowedTargets = new Set(["darwin-arm64", "darwin-x64", "win32-x64"]);

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function currentTarget() {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64";
  throw new Error(`Unsupported host: ${process.platform}-${process.arch}`);
}

function requestedTargets(argv) {
  if (argv.includes("--all")) return allowedTargets;
  const inline = argv.find((argument) => argument.startsWith("--target="));
  const index = argv.indexOf("--target");
  const value = inline?.slice("--target=".length) || (index >= 0 ? argv[index + 1] : currentTarget());
  if (!allowedTargets.has(value)) throw new Error(`Unsupported target: ${value || "(missing)"}`);
  return new Set([value]);
}

function runtimeTargets(runtime) {
  const paths = runtime.extract_paths || [runtime.extract_path];
  return paths.map((path) => {
    if (path.includes("/darwin-arm64/")) return ["darwin-arm64", path];
    if (path.includes("/darwin-x64/")) return ["darwin-x64", path];
    if (path.includes("/darwin-universal/")) return ["darwin-arm64", path];
    if (path.includes("/win32-x64/")) return ["win32-x64", path];
    throw new Error(`Runtime has no recognized target path: ${runtime.name}`);
  });
}

function safeOutputPath(relativePath) {
  if (typeof relativePath !== "string" || !/^bundled-(classifier|downloaders|tools)\//.test(relativePath)) {
    throw new Error(`Refusing unsafe output path: ${String(relativePath)}`);
  }
  const outputPath = resolve(projectRoot, relativePath);
  if (!outputPath.startsWith(`${projectRoot}${sep}`)) throw new Error(`Path escaped project root: ${relativePath}`);
  return outputPath;
}

async function download(runtime) {
  const response = await fetch(runtime.source_url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${runtime.name}: download failed with HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const expected = runtime.download_sha256 || runtime.sha256;
  const actual = sha256(data);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${runtime.name}: download SHA-256 mismatch`);
  }
  return data;
}

function extractPayload(runtime, downloadData) {
  if (runtime.archive_type === "file") return downloadData;
  throw new Error(`${runtime.name}: unsupported archive configuration`);
}

async function wheelPayload(runtime, downloadData) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ai-media-bundled-"));
  const wheelPath = join(temporaryDirectory, `${runtime.name}.whl`);
  await writeFile(wheelPath, downloadData, { mode: 0o600 });
  try {
    return execFileSync("unzip", ["-p", wheelPath, runtime.archive_member], {
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function install(runtime, selectedTargets) {
  const destinations = runtimeTargets(runtime).filter(([target]) => selectedTargets.has(target));
  if (destinations.length === 0) return false;

  process.stdout.write(`Fetching ${runtime.name} ${runtime.version}...\n`);
  const archive = await download(runtime);
  const payload = runtime.archive_type === "wheel-member"
    ? await wheelPayload(runtime, archive)
    : extractPayload(runtime, archive);

  if (!Buffer.isBuffer(payload)) throw new Error(`${runtime.name}: extraction failed`);
  if (sha256(payload).toLowerCase() !== runtime.sha256.toLowerCase()) {
    throw new Error(`${runtime.name}: installed-file SHA-256 mismatch`);
  }

  for (const [, relativePath] of destinations) {
    const outputPath = safeOutputPath(relativePath);
    const temporaryPath = `${outputPath}.download-${process.pid}`;
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(temporaryPath, payload, { mode: 0o755 });
    await rename(temporaryPath, outputPath);
    if (process.platform !== "win32") await chmod(outputPath, 0o755);
    process.stdout.write(`Installed ${relativePath}\n`);
  }
  return true;
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const targets = requestedTargets(process.argv.slice(2));
let installed = 0;

for (const runtime of manifest.runtimes) {
  if (runtime.automatic && await install(runtime, targets)) installed += 1;
}

process.stdout.write(`Done. Restored ${installed} public runtime artifact(s).\n`);
process.stdout.write("Private classifier, xhs runtime, and historical Windows FFmpeg files still require the private backup.\n");
