import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { countClassifierRetryTasks, readClassifierRetryState } from "../electron/classifier-retry-state.mjs";

const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

test("does not trust a stale retry counter without an exact retry payload or list", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classifier-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const activeJobPath = path.join(root, "active-job.json");
  const payload = {
    command: "classify",
    folder: "/tmp/output/segments",
    output_root: "/tmp/output",
    mode: "balanced",
    workers: 4,
    frames: 8,
  };
  await writeFile(activeJobPath, JSON.stringify({ status: "completed", retryTaskCount: 17, payload }), "utf8");

  const firstBoot = await readClassifierRetryState(activeJobPath, readJson, readFile);
  const secondBoot = await readClassifierRetryState(activeJobPath, readJson, readFile);

  assert.equal(firstBoot.retryTaskCount, 0);
  assert.equal(firstBoot.retryPayload, null);
  assert.deepEqual(secondBoot, firstBoot);
});

test("recovers retry counts from the saved result and clears the button after success", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classifier-retry-result-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const activeJobPath = path.join(root, "active-job.json");
  const resultPath = path.join(root, "result.json");
  const payload = { command: "classify", folder: "/tmp/input", output_root: "/tmp/output" };
  const failedPath = path.join(root, "失败清单.csv");
  const pendingPath = path.join(root, "待筛清单.csv");
  await writeFile(failedPath, "source,error\na.mp4,timeout\nb.mp4,timeout\nc.mp4,timeout\n", "utf8");
  await writeFile(pendingPath, "source,error\nd.mp4,pending\ne.mp4,pending\n", "utf8");
  await writeFile(resultPath, JSON.stringify({ result: { failed_count: 3, pending_count: 2, failed: failedPath, pending: pendingPath } }), "utf8");
  await writeFile(activeJobPath, JSON.stringify({ status: "completed", resultPath, payload }), "utf8");

  const failedState = await readClassifierRetryState(activeJobPath, readJson, readFile);
  assert.equal(countClassifierRetryTasks({ result: { failed_count: 3, pending_count: 2 } }), 5);
  assert.equal(failedState.retryTaskCount, 5);
  assert.equal(failedState.retryPayload.command, "review");

  await writeFile(activeJobPath, JSON.stringify({ status: "completed", retryTaskCount: 0, payload: { ...payload, command: "review" } }), "utf8");
  const successfulState = await readClassifierRetryState(activeJobPath, readJson, readFile);
  assert.deepEqual(successfulState, { retryTaskCount: 0, retryPayload: null });
});

test("shared-drive recovery retries only failed source files through the safe classifier path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classifier-network-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const activeJobPath = path.join(root, "active-job.json");
  const failedSourcePaths = ["\\\\server\\share\\failed-1.mov", "Z:\\failed-2.mov"];
  await writeFile(activeJobPath, JSON.stringify({
    status: "completed",
    retryTaskCount: failedSourcePaths.length,
    payload: { command: "classify", folder: "C:\\cache\\input", output_root: "\\\\server\\share\\output", source_paths: ["old-success.mov"] },
    networkSafe: { enabled: true, failedSourcePaths },
  }), "utf8");

  const state = await readClassifierRetryState(activeJobPath, readJson, readFile);
  assert.equal(state.retryTaskCount, 2);
  assert.equal(state.retryPayload.command, "classify");
  assert.equal(state.retryPayload.workers, 1);
  assert.deepEqual(state.retryPayload.source_paths, failedSourcePaths);
});
