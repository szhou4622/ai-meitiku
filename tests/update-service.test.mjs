import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compareUpdateVersions,
  normalizeUpdateResponse,
  sanitizeUpdateFileName,
  UpdateService,
  updatePlatformKey,
  UPDATE_APP_NAME,
} from "../electron/update-service.mjs";

const fixedNow = new Date("2026-08-20T10:00:00.000Z");

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function fixture(t, { platform = "darwin", arch = "arm64", fetchHandler, openInstaller = async () => "", isBusy = () => false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ai-media-update-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let handler = fetchHandler || (async () => new Response("", { status: 404 }));
  let quitCount = 0;
  const service = new UpdateService({
    currentVersion: "1.2.9",
    platform,
    arch,
    userDataPath: root,
    fetchImpl: (...args) => handler(...args),
    openInstaller,
    quitApp: () => { quitCount += 1; },
    isBusy,
    now: () => new Date(fixedNow),
  });
  await service.initialize();
  return { root, service, setFetch: (next) => { handler = next; }, getQuitCount: () => quitCount };
}

function updatePayload({ version = "1.2.10", force = false, sha256 = "a".repeat(64), fileSize = 12, urls } = {}) {
  return {
    app_name: UPDATE_APP_NAME,
    latest_version: version,
    force_update: force,
    release_notes: "修复分类与下载稳定性",
    sha256,
    file_size: fileSize,
    download_urls: urls || {
      windows_x64: "https://downloads.example.com/AI媒体库-1.2.10-win-x64.exe",
      mac_arm64: "https://downloads.example.com/AI媒体库-1.2.10-mac-arm64.dmg",
      mac_x64: "https://downloads.example.com/AI媒体库-1.2.10-mac-x64.dmg",
    },
    published_at: "2026-08-20T08:00:00Z",
  };
}

test("maps only the three supported release architectures", () => {
  assert.equal(updatePlatformKey("win32", "x64"), "windows_x64");
  assert.equal(updatePlatformKey("darwin", "arm64"), "mac_arm64");
  assert.equal(updatePlatformKey("darwin", "x64"), "mac_x64");
  assert.equal(updatePlatformKey("win32", "arm64"), "");
});

test("normalizes direct and wrapped update responses up to four levels", () => {
  const normalized = normalizeUpdateResponse({ data: { result: { update: { data: updatePayload() } } } }, { platformKey: "mac_arm64" });
  assert.equal(normalized.version, "1.2.10");
  assert.equal(normalized.download_url, "https://downloads.example.com/AI媒体库-1.2.10-mac-arm64.dmg");
  assert.equal(normalized.force_update, false);
  assert.equal(normalized.release_notes, "修复分类与下载稳定性");
  assert.equal(normalized.file_size, 12);
  assert.equal(normalizeUpdateResponse({ version: "2.0.0", download_url: "https://downloads.example.com/app.dmg" }, { platformKey: "mac_arm64" }).version, "2.0.0");
});

test("normalizes the deployed update server schema with platform hashes and note arrays", () => {
  const normalized = normalizeUpdateResponse({
    app_name: UPDATE_APP_NAME,
    version: "1.2.11",
    download_url: {
      windows_x64: "https://update.example.com/app.exe",
      mac_arm64: "https://update.example.com/app-arm64.dmg",
      mac_x64: "https://update.example.com/app-x64.dmg",
    },
    sha256: { mac_arm64: "B".repeat(64), mac_x64: "C".repeat(64) },
    file_size: { mac_arm64: 2048, mac_x64: 4096 },
    notes: ["修复更新检查", "提高下载稳定性"],
    force: true,
  }, { platformKey: "mac_arm64" });
  assert.equal(normalized.sha256, "b".repeat(64));
  assert.equal(normalized.file_size, 2048);
  assert.equal(normalized.release_notes, "修复更新检查\n提高下载稳定性");
  assert.equal(normalized.force_update, true);
});

test("rejects missing fields, wrong app names, and unavailable platform packages", () => {
  assert.equal(normalizeUpdateResponse({ version: "1.0.0" }, { platformKey: "mac_arm64" }), null);
  assert.equal(normalizeUpdateResponse({ download_url: "https://example.com/a.dmg" }, { platformKey: "mac_arm64" }), null);
  assert.equal(normalizeUpdateResponse(updatePayload({ urls: { windows_x64: "https://example.com/a.exe" } }), { platformKey: "mac_arm64" }), null);
  assert.equal(normalizeUpdateResponse({ ...updatePayload(), app_name: "another-app" }, { platformKey: "mac_arm64" }), null);
});

test("uses semantic version ordering and excludes prereleases by default", () => {
  assert.equal(compareUpdateVersions("1.2.9", "1.2.10").newer, true);
  assert.equal(compareUpdateVersions("1.99.99", "2.0.0").newer, true);
  assert.equal(compareUpdateVersions("2.0.0", "2.0.0").newer, false);
  assert.equal(compareUpdateVersions("2.1.0", "2.0.0").newer, false);
  assert.equal(compareUpdateVersions("1.2.9", "1.3.0-beta.1").newer, false);
  assert.equal(compareUpdateVersions("1.2.9", "1.3.0-beta.1", { allowPrerelease: true }).newer, true);
  assert.equal(compareUpdateVersions("invalid", "1.0.0").valid, false);
});

test("selects the correct URL for Windows, Apple Silicon, and Intel Mac", () => {
  const payload = updatePayload();
  assert.match(normalizeUpdateResponse(payload, { platformKey: "windows_x64" }).download_url, /win-x64\.exe$/);
  assert.match(normalizeUpdateResponse(payload, { platformKey: "mac_arm64" }).download_url, /mac-arm64\.dmg$/);
  assert.match(normalizeUpdateResponse(payload, { platformKey: "mac_x64" }).download_url, /mac-x64\.dmg$/);
});

test("sanitizes installer names and rejects traversal or unsupported installer types", () => {
  assert.equal(sanitizeUpdateFileName("https://example.com/releases/%2E%2E%2Fevil.dmg", { version: "1.0.0", platform: "darwin" }), "evil.dmg");
  assert.throws(() => sanitizeUpdateFileName("https://example.com/release/script.sh", { version: "1.0.0", platform: "darwin" }), /安装包格式/);
  assert.throws(() => sanitizeUpdateFileName("https://example.com/release/app.exe", { version: "1.0.0", platform: "darwin" }), /安装包格式/);
});

test("404 and missing configuration are non-blocking and manual checks explain no update", async (t) => {
  const { service, setFetch } = await fixture(t);
  assert.equal((await service.check({ manual: true })).message, "当前暂无适用于此设备的更新");
  setFetch(async () => new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } }));
  const state = await service.check({ manual: true });
  assert.equal(state.phase, "up-to-date");
  assert.equal(state.shouldPrompt, false);
});

test("new normal and forced versions produce different update flows", async (t) => {
  const { service, setFetch } = await fixture(t);
  setFetch(async () => new Response(JSON.stringify(updatePayload()), { status: 200 }));
  let state = await service.check({ manual: false });
  assert.equal(state.phase, "available");
  assert.equal(state.updateType, "normal");
  assert.equal(state.forceUpdate, false);
  assert.equal(state.shouldPrompt, true);

  setFetch(async () => new Response(JSON.stringify(updatePayload({ version: "1.3.0", force: true })), { status: 200 }));
  state = await service.check({ manual: true });
  assert.equal(state.updateType, "important");
  assert.equal(state.forceUpdate, true);
  assert.equal(state.shouldPrompt, true);
});

test("same, older, and prerelease versions never prompt or downgrade", async (t) => {
  const { service, setFetch } = await fixture(t);
  for (const version of ["1.2.9", "1.2.8", "1.3.0-beta.1"]) {
    setFetch(async () => new Response(JSON.stringify(updatePayload({ version })), { status: 200 }));
    const state = await service.check({ manual: true });
    assert.equal(state.phase, "up-to-date");
    assert.equal(state.shouldPrompt, false);
  }
});

test("restart after installing the cached version clears the obsolete prompt and package", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ai-media-update-restart-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const updatesPath = path.join(root, "updates");
  await mkdir(updatesPath, { recursive: true });
  const installer = Buffer.from("already-installed-package");
  const downloadedPath = path.join(updatesPath, "AI媒体库-1.1.3-mac-arm64-安装程序.dmg");
  await writeFile(downloadedPath, installer);
  await writeFile(path.join(updatesPath, "update-state.json"), JSON.stringify({
    version: 1,
    latest: normalizeUpdateResponse(updatePayload({
      version: "1.1.3",
      sha256: digest(installer),
      fileSize: installer.length,
      urls: { mac_arm64: "https://downloads.example.com/AI媒体库-1.1.3-mac-arm64.dmg" },
    }), { platformKey: "mac_arm64" }),
    downloadedPath,
    reminders: {},
    installOnQuit: true,
    lastCheckedAt: fixedNow.toISOString(),
  }), "utf8");

  const service = new UpdateService({
    currentVersion: "1.1.3", platform: "darwin", arch: "arm64", userDataPath: root,
    fetchImpl: async () => new Response("", { status: 404 }),
    openInstaller: async () => "", quitApp: () => {}, now: () => new Date(fixedNow),
  });
  const state = await service.initialize();
  assert.equal(state.phase, "up-to-date");
  assert.equal(state.targetVersion, "");
  assert.equal(state.shouldPrompt, false);
  assert.equal(state.installOnQuit, false);
  await assert.rejects(() => readFile(downloadedPath), { code: "ENOENT" });
  const saved = JSON.parse(await readFile(path.join(updatesPath, "update-state.json"), "utf8"));
  assert.equal(saved.latest, null);
  assert.equal(saved.downloadedPath, "");
  assert.equal(saved.installOnQuit, false);
});

test("restart keeps a genuinely newer cached update available", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ai-media-update-newer-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const updatesPath = path.join(root, "updates");
  await mkdir(updatesPath, { recursive: true });
  const latest = normalizeUpdateResponse(updatePayload({
    version: "1.1.4",
    urls: { mac_arm64: "https://downloads.example.com/AI媒体库-1.1.4-mac-arm64.dmg" },
  }), { platformKey: "mac_arm64" });
  await writeFile(path.join(updatesPath, "update-state.json"), JSON.stringify({
    version: 1,
    latest,
    downloadedPath: "",
    reminders: {},
    installOnQuit: false,
    lastCheckedAt: fixedNow.toISOString(),
  }), "utf8");

  const service = new UpdateService({
    currentVersion: "1.1.3", platform: "darwin", arch: "arm64", userDataPath: root,
    fetchImpl: async () => new Response("", { status: 404 }),
    openInstaller: async () => "", quitApp: () => {}, now: () => new Date(fixedNow),
  });
  const state = await service.initialize();
  assert.equal(state.phase, "available");
  assert.equal(state.targetVersion, "1.1.4");
  assert.equal(state.shouldPrompt, true);
});

test("later reminder suppresses the same version for the rest of the day and survives restart", async (t) => {
  const { root, service, setFetch } = await fixture(t);
  setFetch(async () => new Response(JSON.stringify(updatePayload()), { status: 200 }));
  await service.check({ manual: false });
  assert.equal((await service.remindLater()).shouldPrompt, false);
  assert.equal((await service.check({ manual: false })).shouldPrompt, false);

  const restarted = new UpdateService({
    currentVersion: "1.2.9", platform: "darwin", arch: "arm64", userDataPath: root,
    fetchImpl: async () => new Response(JSON.stringify(updatePayload()), { status: 200 }),
    openInstaller: async () => "", quitApp: () => {}, now: () => new Date(fixedNow),
  });
  await restarted.initialize();
  assert.equal((await restarted.check({ manual: false })).shouldPrompt, false);
});

test("automatic checks respect the persisted 24 hour interval", async (t) => {
  let calls = 0;
  const { service } = await fixture(t, { fetchHandler: async () => { calls += 1; return new Response("", { status: 404 }); } });
  await service.check({ manual: false });
  await service.check({ manual: false });
  assert.equal(calls, 1);
  await service.check({ manual: true });
  assert.equal(calls, 2);
});

test("update check sends only non-sensitive app and platform query fields", async (t) => {
  let captured;
  const { service } = await fixture(t, { fetchHandler: async (url) => { captured = new URL(url); return new Response("", { status: 404 }); } });
  await service.check({ manual: true });
  assert.deepEqual([...captured.searchParams.keys()].sort(), ["app_name", "arch", "current_version", "platform"]);
  assert.equal(captured.searchParams.get("app_name"), UPDATE_APP_NAME);
  assert.doesNotMatch(captured.toString(), /activation|credential|session|api_key/i);
});

test("downloads with progress, verifies SHA256, and reuses a complete package", async (t) => {
  const installer = Buffer.from("signed-notarized-dmg-fixture");
  let downloadCalls = 0;
  const payload = updatePayload({ sha256: digest(installer), fileSize: installer.length });
  const { root, service } = await fixture(t, { fetchHandler: async (url) => {
    if (new URL(url).pathname.includes("latest")) return new Response(JSON.stringify(payload), { status: 200 });
    downloadCalls += 1;
    return new Response(installer, { status: 200, headers: { "content-length": String(installer.length) } });
  } });
  await service.check({ manual: true });
  const state = await service.download();
  assert.equal(state.phase, "downloaded");
  assert.equal(state.downloadedBytes, installer.length);
  assert.equal(downloadCalls, 1);
  await service.download();
  assert.equal(downloadCalls, 1);
  const files = await readdir(path.join(root, "updates"));
  assert.equal(files.some((name) => name.endsWith(".dmg")), true);
});

test("SHA256 mismatch refuses installation and deletes the damaged package", async (t) => {
  const installer = Buffer.from("damaged-package");
  const payload = updatePayload({ sha256: digest(Buffer.from("expected-package")), fileSize: installer.length });
  const { root, service } = await fixture(t, { fetchHandler: async (url) => new URL(url).pathname.includes("latest")
    ? new Response(JSON.stringify(payload), { status: 200 })
    : new Response(installer, { status: 200 }) });
  await service.check({ manual: true });
  const state = await service.download();
  assert.equal(state.phase, "error");
  assert.match(state.message, /校验失败/);
  const files = await readdir(path.join(root, "updates"));
  assert.equal(files.some((name) => name.endsWith(".dmg") || name.endsWith(".part")), false);
});

test("network interruption can retry safely and cancellation does not damage the current app", async (t) => {
  const installer = Buffer.from("retry-package");
  const payload = updatePayload({ sha256: digest(installer), fileSize: installer.length });
  let downloadAttempt = 0;
  const { service, setFetch } = await fixture(t, { fetchHandler: async (url) => {
    if (new URL(url).pathname.includes("latest")) return new Response(JSON.stringify(payload), { status: 200 });
    downloadAttempt += 1;
    if (downloadAttempt === 1) throw Object.assign(new Error("offline"), { code: "network_offline" });
    return new Response(installer, { status: 200 });
  } });
  await service.check({ manual: true });
  assert.equal((await service.download()).canRetry, true);
  assert.equal((await service.download()).phase, "downloaded");

  const payload2 = updatePayload({
    version: "1.3.0",
    sha256: digest(Buffer.from("new-version-package")),
    fileSize: 19,
    urls: { mac_arm64: "https://downloads.example.com/AI媒体库-1.3.0-mac-arm64.dmg" },
  });
  setFetch(async (url, options) => {
    if (new URL(url).pathname.includes("latest")) return new Response(JSON.stringify(payload2), { status: 200 });
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
  });
  await service.check({ manual: true });
  const pending = service.download();
  for (let attempt = 0; attempt < 20 && service.publicState().phase !== "downloading"; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  service.cancelDownload();
  assert.equal((await pending).phase, "available");
});

test("installation is blocked while busy and launcher failure preserves the verified package", async (t) => {
  const installer = Buffer.from("verified-installer");
  const payload = updatePayload({ sha256: digest(installer), fileSize: installer.length });
  let openedPath = "";
  const { root, service, getQuitCount } = await fixture(t, {
    fetchHandler: async (url) => new URL(url).pathname.includes("latest") ? new Response(JSON.stringify(payload), { status: 200 }) : new Response(installer, { status: 200 }),
    openInstaller: async (filePath) => { openedPath = filePath; return "launch failed"; },
  });
  await service.check({ manual: true });
  await service.download();
  service.isBusy = () => true;
  await assert.rejects(() => service.install(), /素材处理任务/);
  service.isBusy = () => false;
  const state = await service.install();
  assert.equal(state.phase, "downloaded");
  assert.equal(getQuitCount(), 0);
  assert.equal(Buffer.compare(await readFile(openedPath), installer), 0);
  assert.equal((await readdir(path.join(root, "updates"))).some((name) => name.endsWith(".dmg")), true);
});

test("successful install handoff and exit-install use only the verified internal path", async (t) => {
  const installer = Buffer.from("verified-installer-success");
  const payload = updatePayload({ sha256: digest(installer), fileSize: installer.length });
  const opened = [];
  const { service, getQuitCount } = await fixture(t, {
    fetchHandler: async (url) => new URL(url).pathname.includes("latest") ? new Response(JSON.stringify(payload), { status: 200 }) : new Response(installer, { status: 200 }),
    openInstaller: async (filePath) => { opened.push(filePath); return ""; },
  });
  await service.check({ manual: true });
  await service.download();
  await service.setInstallOnQuit();
  assert.equal(service.publicState().installOnQuit, true);
  assert.equal(await service.installOnApplicationQuit(), true);
  assert.equal(opened.length, 1);
  assert.equal(getQuitCount(), 0);
});

test("update files and logs never modify or expose authorization and user data", async (t) => {
  const installer = Buffer.from("data-protection-installer");
  const payload = updatePayload({ sha256: digest(installer), fileSize: installer.length });
  const { root, service, setFetch } = await fixture(t, { fetchHandler: async (url) => new URL(url).pathname.includes("latest") ? new Response(JSON.stringify(payload), { status: 200 }) : new Response(installer, { status: 200 }) });
  const protectedFiles = {
    "license-credential.v2.bin": Buffer.from("device_session secret-device-credential"),
    "license-machine-seed.v2.bin": Buffer.from("stable-machine-code-seed"),
    "media-library.json": Buffer.from('{"assets":[1]}'),
  };
  for (const [name, content] of Object.entries(protectedFiles)) await writeFile(path.join(root, name), content);
  await service.check({ manual: true });
  await service.download();
  for (const [name, content] of Object.entries(protectedFiles)) assert.equal(Buffer.compare(await readFile(path.join(root, name)), content), 0);

  setFetch(async () => new Response("", { status: 500 }));
  await service.check({ manual: true });
  const log = await readFile(path.join(root, "updates", "update.log"), "utf8");
  assert.doesNotMatch(log, /device_session|device_credential|activation|api.?key|stable-machine-code-seed/i);
  assert.match(log, /current_version/);
  assert.match(log, /http_status/);
});
