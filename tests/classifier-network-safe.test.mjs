import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitFileToNetwork,
  copyFileWithRetry,
  isClassifierHandoffInput,
  isMappedNetworkPath,
  isRetryableNetworkFailure,
  isUncPath,
  parseMappedNetworkDriveLetters,
  safeModeDescription,
  stageClassifierPhysicalSource,
} from "../electron/classifier-network-safe.mjs";

test("detects UNC and mapped shared-drive paths", () => {
  assert.equal(isUncPath("\\\\192.168.1.20\\素材\\视频.mov"), true);
  assert.equal(isUncPath("C:\\素材\\视频.mov"), false);
  const drives = parseMappedNetworkDriveLetters("OK  Z:  \\\\192.168.1.20\\素材  Microsoft Windows Network");
  assert.equal(isMappedNetworkPath("Z:\\视频\\a.mov", drives), true);
  assert.equal(isMappedNetworkPath("D:\\视频\\a.mov", drives), false);
});

test("recognizes Windows resource and transient SMB failures", () => {
  assert.equal(isRetryableNetworkFailure("[WinError 1450] 系统资源不足"), true);
  assert.equal(isRetryableNetworkFailure("read ECONNRESET"), true);
  assert.equal(isRetryableNetworkFailure("API Key 无效"), false);
});

test("describes both shared input and output", () => {
  assert.equal(safeModeDescription({ inputNetwork: true, outputNetwork: true }), "输入和输出均位于共享网盘");
});

test("recognizes only a generated classifier handoff input directory", () => {
  const userData = "C:\\Users\\Customer\\AppData\\Roaming\\ai-media-library";
  const handoff = path.win32.join(userData, "classifier-handoffs", "22cda9d5-8654-4341-b892-94d06b310b59", "input");
  assert.equal(isClassifierHandoffInput(handoff, userData, path.win32), true);
  assert.equal(isClassifierHandoffInput(path.win32.join(userData, "classifier-handoffs", "other", "input"), userData, path.win32), false);
  assert.equal(isClassifierHandoffInput("F:\\素材\\input", userData, path.win32), false);
  const macUserData = "/Users/Customer/Library/Application Support/ai-media-library";
  assert.equal(isClassifierHandoffInput(path.join(macUserData, "classifier-handoffs", "22cda9d5-8654-4341-b892-94d06b310b59", "input"), macUserData), true);
});

test("cross-volume hard-link failure produces a real staged file, never a symbolic link", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classifier-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source", "clip.mp4");
  const inputRoot = path.join(root, "handoff", "input");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "original-video");
  const staged = await stageClassifierPhysicalSource(source, inputRoot, {
    linkFile: async () => { throw Object.assign(new Error("cross-device link"), { code: "EXDEV" }); },
  });
  assert.equal(staged.method, "copied");
  assert.equal((await lstat(staged.path)).isSymbolicLink(), false);
  assert.equal(path.dirname(await realpath(staged.path)), await realpath(inputRoot));
  assert.equal(await readFile(staged.path, "utf8"), "original-video");
  await writeFile(source, "changed-source");
  assert.equal(await readFile(staged.path, "utf8"), "original-video");
});

test("an escaping link is replaced by a physical copy before classification", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classifier-escape-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.mp4");
  const inputRoot = path.join(root, "handoff", "input");
  await writeFile(source, "video-content");
  const staged = await stageClassifierPhysicalSource(source, inputRoot, {
    linkFile: (from, to) => symlink(from, to),
  });
  assert.equal(staged.method, "copied");
  assert.equal((await lstat(staged.path)).isSymbolicLink(), false);
  assert.equal(path.dirname(await realpath(staged.path)), await realpath(inputRoot));
});

test("same-volume sources can use a real hard link without copying", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classifier-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.mp4");
  await writeFile(source, "video-content");
  const staged = await stageClassifierPhysicalSource(source, path.join(root, "input"));
  assert.equal(staged.method, "linked");
  assert.equal((await lstat(staged.path)).isSymbolicLink(), false);
  assert.equal((await stat(staged.path)).ino, (await stat(source)).ino);
});

test("copies with size verification and commits without leaving a part file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classifier-network-safe-"));
  const source = path.join(root, "source.mov");
  const destination = path.join(root, "share", "result.mov");
  await writeFile(source, Buffer.from("safe-network-output"));
  const staged = path.join(root, "cache", "source.mov");
  await copyFileWithRetry(source, staged, { retryDelays: [] });
  await commitFileToNetwork(staged, destination, { retryDelays: [] });
  assert.equal(await readFile(destination, "utf8"), "safe-network-output");
  assert.equal((await stat(destination)).size, 19);
});
