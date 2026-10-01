import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifierCategoryDirectory,
  classifierSegmentsDirectoryInfo,
  detectClassifierCategoryFolder,
  groupClassifierOutputFiles,
} from "../electron/classifier-library-sync.mjs";

test("accepts only the exact per-task segments directory", () => {
  const valid = path.join(path.sep, "tmp", "素材输出", "outputs", "task-123", "segments");
  assert.deepEqual(classifierSegmentsDirectoryInfo(valid), {
    path: valid,
    name: "task-123",
    taskDirectory: path.dirname(valid),
    outputsDirectory: path.dirname(path.dirname(valid)),
  });
  assert.equal(classifierSegmentsDirectoryInfo(path.join(path.sep, "tmp", "素材输出")), null);
  assert.equal(classifierSegmentsDirectoryInfo(path.join(path.sep, "tmp", "素材输出", "outputs")), null);
  assert.equal(classifierSegmentsDirectoryInfo(path.join(path.sep, "tmp", "素材输出", "segments")), null);
  assert.equal(classifierSegmentsDirectoryInfo(path.join(path.sep, "tmp", "outputs", "segments")), null);
  assert.equal(classifierSegmentsDirectoryInfo("outputs/task-123/segments"), null);
});

test("groups exact classifier outputs by their first category directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classifier-library-"));
  const scene = path.join(root, "01_使用场景", "办公场景", "scene.mp4");
  const feature = path.join(root, "02_功能演示", "磁吸吸附", "feature.mp4");
  const taggedImage = path.join(root, "03_外观细节", "材质", "detail.jpg");
  const temporary = path.join(root, "outputs", "work", "segment.mp4");
  const frameSnapshot = path.join(root, "outputs", "work", "sheets", "clip", "frames_sheet.jpg");
  const outside = path.join(path.dirname(root), "outside.mp4");

  assert.equal(classifierCategoryDirectory(root, scene), path.join(root, "01_使用场景"));
  assert.equal(classifierCategoryDirectory(root, temporary), null);
  assert.equal(classifierCategoryDirectory(root, outside), null);

  const groups = groupClassifierOutputFiles(root, [scene, feature, taggedImage, scene, temporary, frameSnapshot, outside]);
  assert.deepEqual(groups.map((group) => group.folder.name), ["01_使用场景", "02_功能演示", "03_外观细节"]);
  assert.deepEqual(groups.map((group) => group.files.length), [1, 1, 1]);
  assert.equal(groups.some((group) => group.files.includes(frameSnapshot)), false);
});

test("detects and migrates a previously flattened classifier result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classifier-library-migrate-"));
  const category = path.join(root, "03_外观细节", "材质工艺");
  const outputs = path.join(root, "outputs");
  const video = path.join(category, "detail.mp4");
  await mkdir(category, { recursive: true });
  await mkdir(outputs, { recursive: true });
  await writeFile(video, "video");
  await writeFile(path.join(outputs, "整理日志_20260824.md"), "log");

  assert.deepEqual(await detectClassifierCategoryFolder(video), {
    path: path.join(root, "03_外观细节"),
    name: "03_外观细节",
    available: true,
    parentPath: root,
    indexMode: "exact",
  });
});

test("does not migrate ordinary imported files without classifier markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ordinary-library-"));
  const folder = path.join(root, "普通文件夹");
  const video = path.join(folder, "video.mp4");
  await mkdir(folder, { recursive: true });
  await writeFile(video, "video");
  assert.equal(await detectClassifierCategoryFolder(video), null);
});

test("does not infer a protected broad directory as the classifier output root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classifier-library-protected-"));
  const project = path.join(root, "项目");
  const category = path.join(project, "01_场景");
  const video = path.join(category, "scene.mp4");
  await mkdir(category, { recursive: true });
  await mkdir(path.join(root, "outputs"), { recursive: true });
  await writeFile(video, "video");
  await writeFile(path.join(root, "outputs", "分类清单.csv"), "marker");

  assert.equal(await detectClassifierCategoryFolder(video, { excludedRoots: [root] }), null);
});
