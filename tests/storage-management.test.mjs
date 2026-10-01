import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { directorySize, StorageManagementService } from "../electron/storage-management.mjs";

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-media-storage-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeSizedFile(filePath, size) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.alloc(size, 1));
}

async function writeHandoff(root, name, status, timestamp = "2026-08-01T00:00:00.000Z") {
  const handoff = path.join(root, "classifier-handoffs", name);
  await writeSizedFile(path.join(handoff, "input", `${name}.mp4`), 16);
  await writeFile(path.join(handoff, ".handoff.json"), JSON.stringify({ version: 1, status, createdAt: timestamp, updatedAt: timestamp, ...(status === "completed" ? { completedAt: timestamp } : {}) }), "utf8");
  return handoff;
}

test("directorySize totals files without following missing paths", async (t) => {
  const root = await temporaryRoot(t);
  await writeSizedFile(path.join(root, "a.bin"), 12);
  await writeSizedFile(path.join(root, "nested", "b.bin"), 20);
  assert.equal(await directorySize(root), 32);
  assert.equal(await directorySize(path.join(root, "missing")), 0);
});

test("manual classifier cleanup removes completed and legacy caches but preserves pending work", async (t) => {
  const root = await temporaryRoot(t);
  const service = new StorageManagementService({ userDataPath: root });
  await service.initialize();
  const completed = await writeHandoff(root, "completed", "completed");
  const prepared = await writeHandoff(root, "prepared", "prepared");
  const retry = await writeHandoff(root, "retry", "retry_pending");
  const legacy = path.join(root, "classifier-handoffs", "legacy");
  await writeSizedFile(path.join(legacy, "input", "legacy.mp4"), 16);
  await writeSizedFile(path.join(root, "classifier-network-cache", "batch", "temp.mp4"), 16);

  const result = await service.clearClassifierCache({ automatic: false });
  assert.equal(result.ok, true);
  await assert.rejects(() => stat(completed), { code: "ENOENT" });
  await assert.rejects(() => stat(legacy), { code: "ENOENT" });
  await stat(prepared);
  await stat(retry);
  await assert.rejects(() => stat(path.join(root, "classifier-network-cache")), { code: "ENOENT" });
});

test("automatic cleanup only removes expired completed or abandoned handoffs", async (t) => {
  const root = await temporaryRoot(t);
  const now = new Date("2026-09-08T12:00:00.000Z");
  const service = new StorageManagementService({ userDataPath: root, now: () => now });
  await service.initialize();
  const expired = await writeHandoff(root, "expired", "completed", "2026-09-01T00:00:00.000Z");
  const abandoned = await writeHandoff(root, "abandoned", "abandoned", "2026-09-01T00:00:00.000Z");
  const fresh = await writeHandoff(root, "fresh", "completed", "2026-09-08T06:00:00.000Z");
  const retry = await writeHandoff(root, "retry", "retry_pending", "2026-09-01T00:00:00.000Z");

  await service.clearClassifierCache({ automatic: true });
  await assert.rejects(() => stat(expired), { code: "ENOENT" });
  await assert.rejects(() => stat(abandoned), { code: "ENOENT" });
  await stat(fresh);
  await stat(retry);
});

test("classifier cleanup is blocked while a task is running or retry is pending", async (t) => {
  const root = await temporaryRoot(t);
  const service = new StorageManagementService({ userDataPath: root, getClassifierRetryCount: async () => 2 });
  await service.initialize();
  await writeSizedFile(path.join(root, "classifier-handoffs", "keep", "input", "a.mp4"), 16);
  const result = await service.clear("classifier");
  assert.equal(result.blocked, true);
  await stat(path.join(root, "classifier-handoffs", "keep", "input", "a.mp4"));
});

test("creating a new handoff marks the previous unstarted handoff abandoned", async (t) => {
  const root = await temporaryRoot(t);
  const service = new StorageManagementService({ userDataPath: root });
  await service.initialize();
  const first = path.join(root, "classifier-handoffs", "first");
  const second = path.join(root, "classifier-handoffs", "second");
  await mkdir(first, { recursive: true });
  await service.createClassifierHandoffRecord(first);
  await mkdir(second, { recursive: true });
  await service.createClassifierHandoffRecord(second);
  const firstMarker = JSON.parse(await readFile(path.join(first, ".handoff.json"), "utf8"));
  const secondMarker = JSON.parse(await readFile(path.join(second, ".handoff.json"), "utf8"));
  assert.equal(firstMarker.status, "abandoned");
  assert.equal(secondMarker.status, "prepared");
});

test("update cleanup preserves the currently downloaded installer", async (t) => {
  const root = await temporaryRoot(t);
  const current = path.join(root, "updates", "AI媒体库-current.exe");
  const old = path.join(root, "updates", "AI媒体库-old.exe");
  await writeSizedFile(current, 20);
  await writeSizedFile(old, 30);
  const service = new StorageManagementService({ userDataPath: root, getProtectedUpdatePath: () => current });
  await service.initialize();
  const result = await service.clear("updates");
  assert.equal(result.reclaimedBytes, 30);
  await stat(current);
  await assert.rejects(() => stat(old), { code: "ENOENT" });
});

test("web cache cleanup does not touch platform login partitions", async (t) => {
  const root = await temporaryRoot(t);
  let clearCalls = 0;
  await writeSizedFile(path.join(root, "Cache", "cache.bin"), 20);
  await writeSizedFile(path.join(root, "Partitions", "douyin", "Cookies"), 30);
  const service = new StorageManagementService({ userDataPath: root, clearBrowserCache: async () => { clearCalls += 1; } });
  await service.initialize();
  await service.clear("web");
  assert.equal(clearCalls, 1);
  await assert.rejects(() => stat(path.join(root, "Cache")), { code: "ENOENT" });
  await stat(path.join(root, "Partitions", "douyin", "Cookies"));
});

test("automatic cleanup preferences persist atomically", async (t) => {
  const root = await temporaryRoot(t);
  const first = new StorageManagementService({ userDataPath: root });
  await first.initialize();
  await first.saveSettings({ autoCleanupClassifierCache: false, classifierRetentionHours: 168 });
  const second = new StorageManagementService({ userDataPath: root });
  const snapshot = await second.initialize();
  assert.equal(snapshot.settings.autoCleanupClassifierCache, false);
  assert.equal(snapshot.settings.classifierRetentionHours, 168);
});

test("a broad user-selected download directory counts only files tracked by the app", async (t) => {
  const root = await temporaryRoot(t);
  const downloads = await temporaryRoot(t);
  const tracked = path.join(downloads, "tracked.mp4");
  await writeSizedFile(tracked, 25);
  await writeSizedFile(path.join(downloads, "unrelated-user-file.mp4"), 100);
  const service = new StorageManagementService({
    userDataPath: root,
    getVideoDownloadDirectory: () => downloads,
    getVideoDownloadFiles: () => [tracked],
  });
  const snapshot = await service.initialize();
  assert.equal(snapshot.categories.video.bytes, 25);
  assert.equal(snapshot.videoDirectoryInsideAppData, false);
});
