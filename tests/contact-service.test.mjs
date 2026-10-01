import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BUNDLED_CONTACT_IMAGE_URL,
  CONTACT_CONFIG_URL,
  ContactService,
  contactCachePath,
} from "../electron/contact-service.mjs";

const APP_NAME = "ai-media-library";
const REMOTE_IMAGE = "https://cdn.example.com/contact/ai-media-library.png";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-media-contact-test-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("uses and caches a valid remote contact image", async () => withTempDirectory(async (userDataPath) => {
  let requestedUrl = "";
  const service = new ContactService({
    appName: APP_NAME,
    userDataPath,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return jsonResponse({
        app_name: APP_NAME,
        enabled: true,
        qr_image_url: REMOTE_IMAGE,
        updated_at: "2026-08-20T05:00:00Z",
      });
    },
  });

  const result = await service.getContactConfig();
  assert.equal(requestedUrl, `${CONTACT_CONFIG_URL}?app_name=${APP_NAME}`);
  assert.equal(result.source, "remote");
  assert.equal(result.status, "ready");
  assert.equal(result.qr_image_url, REMOTE_IMAGE);
  const cached = JSON.parse(await readFile(contactCachePath(userDataPath), "utf8"));
  assert.equal(cached.qr_image_url, REMOTE_IMAGE);
}));

test("uses the bundled image when the backend has no configuration", async () => withTempDirectory(async (userDataPath) => {
  const service = new ContactService({
    appName: APP_NAME,
    userDataPath,
    fetchImpl: async () => jsonResponse({ ok: false, error: "该软件暂未配置联系信息" }, 404),
  });

  const result = await service.getContactConfig();
  assert.equal(result.source, "bundled");
  assert.equal(result.status, "fallback");
  assert.equal(result.fallback_image_url, BUNDLED_CONTACT_IMAGE_URL);
  assert.equal(result.qr_image_url, null);
}));

test("uses the latest valid cache when the network is unavailable", async () => withTempDirectory(async (userDataPath) => {
  const online = new ContactService({
    appName: APP_NAME,
    userDataPath,
    fetchImpl: async () => jsonResponse({ app_name: APP_NAME, enabled: true, qr_image_url: REMOTE_IMAGE, updated_at: "2026-08-20T05:00:00Z" }),
  });
  await online.getContactConfig();

  const offline = new ContactService({
    appName: APP_NAME,
    userDataPath,
    fetchImpl: async () => { throw new Error("offline"); },
  });
  const result = await offline.getContactConfig();
  assert.equal(result.source, "cache");
  assert.equal(result.qr_image_url, REMOTE_IMAGE);
}));

test("enabled=false replaces an old cached image and never exposes it", async () => withTempDirectory(async (userDataPath) => {
  const oldConfig = new ContactService({
    appName: APP_NAME,
    userDataPath,
    fetchImpl: async () => jsonResponse({ app_name: APP_NAME, enabled: true, qr_image_url: REMOTE_IMAGE, updated_at: "2026-08-19T05:00:00Z" }),
  });
  await oldConfig.getContactConfig();

  const disabled = new ContactService({
    appName: APP_NAME,
    userDataPath,
    fetchImpl: async () => jsonResponse({ app_name: APP_NAME, enabled: false, qr_image_url: REMOTE_IMAGE, updated_at: "2026-08-20T05:00:00Z" }),
  });
  const result = await disabled.getContactConfig();
  assert.equal(result.status, "disabled");
  assert.equal(result.message, "联系方式暂未开放");
  assert.equal(result.qr_image_url, null);

  const offline = new ContactService({ appName: APP_NAME, userDataPath, fetchImpl: async () => { throw new Error("offline"); } });
  const cached = await offline.getContactConfig();
  assert.equal(cached.status, "disabled");
  assert.equal(cached.qr_image_url, null);
}));

test("rejects non-HTTPS image URLs", async () => withTempDirectory(async (userDataPath) => {
  const service = new ContactService({
    appName: APP_NAME,
    userDataPath,
    fetchImpl: async () => jsonResponse({ app_name: APP_NAME, enabled: true, qr_image_url: "http://example.com/contact.png", updated_at: null }),
  });
  const result = await service.getContactConfig();
  assert.equal(result.source, "bundled");
  assert.equal(result.qr_image_url, null);
  assert.match(result.message, /安全校验/);
}));

test("rejects a contact configuration for another app", async () => withTempDirectory(async (userDataPath) => {
  const service = new ContactService({
    appName: APP_NAME,
    userDataPath,
    fetchImpl: async () => jsonResponse({ app_name: "another-app", enabled: true, qr_image_url: REMOTE_IMAGE, updated_at: null }),
  });
  const result = await service.getContactConfig();
  assert.equal(result.source, "bundled");
  assert.equal(result.qr_image_url, null);
  assert.match(result.message, /安全校验/);
}));

test("includes the contact module and built client assets in Windows and macOS packages", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(packageJson.build.files.includes("electron/contact-service.mjs"));
  assert.ok(packageJson.build.files.includes("dist/client/**/*"));
  assert.deepEqual(packageJson.build.win.target, ["nsis"]);
  assert.deepEqual(packageJson.build.mac.target, ["dir", "dmg"]);
});
