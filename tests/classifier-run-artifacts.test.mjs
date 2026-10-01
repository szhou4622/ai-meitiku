import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifierPathInsideRoot,
  collectClassifierOperationMappings,
  collectClassifierOutputCandidates,
  countClassifierCsvDataRows,
  diagnoseClassifierFailureList,
  remainingGeneratedRetrySources,
  validateClassifierOutputCandidates,
} from "../electron/classifier-run-artifacts.mjs";

test("recovers exact current-run outputs without scanning the output root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classifier-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const category = path.join(root, "01_痛点");
  await mkdir(category, { recursive: true });
  const first = path.join(category, "镜头01.mp4");
  const second = path.join(category, "镜头02.jpg");
  const unrelated = path.join(category, "旧素材.mp4");
  await Promise.all([writeFile(first, "1"), writeFile(second, "2"), writeFile(unrelated, "old")]);

  const candidates = collectClassifierOutputCandidates({
    outputMappings: [{ sourcePath: "/input/1.mp4", outputPath: first }],
    operationLog: { operations: [{ action: "copy", new_path: second }] },
  });
  const accepted = await validateClassifierOutputCandidates(root, candidates, stat);

  assert.deepEqual(new Set(accepted), new Set([first, second]));
  assert.equal(accepted.includes(unrelated), false);
  assert.deepEqual(collectClassifierOperationMappings({ operations: [{ action: "copy", old_path: "/input/1.mp4", new_path: first }] }), [{
    sourcePath: path.resolve("/input/1.mp4"),
    outputPath: first,
  }]);
});

test("rejects traversal, unsupported files, and missing listed files", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "classifier-boundary-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "output");
  await mkdir(root);
  const report = path.join(root, "report.json");
  const outside = path.join(parent, "outside.mp4");
  await Promise.all([writeFile(report, "{}"), writeFile(outside, "x")]);

  assert.equal(classifierPathInsideRoot(outside, root), false);
  assert.deepEqual(await validateClassifierOutputCandidates(root, [report, outside, path.join(root, "missing.mp4")], stat), []);
});

test("retry state uses real rows and exact unconsumed generated sources", () => {
  assert.equal(countClassifierCsvDataRows("source,error\nA.mp4,timeout\nB.mp4,pending\n"), 2);
  assert.equal(countClassifierCsvDataRows("source,error\n"), 0);
  assert.deepEqual(
    remainingGeneratedRetrySources(
      [{ sourcePath: "/segments/1.mp4" }, { sourcePath: "/segments/2.mp4" }],
      ["/segments/1.mp4"],
    ),
    [path.resolve("/segments/2.mp4")],
  );
});

test("reports cross-root handoff errors as local input failures without exposing file paths", () => {
  const csv = "失败类型,原因\n接口报错,\"'F:\\clip.mp4' is not in the subpath of 'C:\\handoff\\input'\"\n";
  assert.equal(
    diagnoseClassifierFailureList(csv),
    "素材交接失败：临时输入路径与原素材路径不一致，请重新导入后重试；无需更换 API Key",
  );
  assert.equal(diagnoseClassifierFailureList("失败类型,原因\n接口报错,HTTP 401\n"), "");
});
