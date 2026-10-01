import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featureRegistry, requireFeatureAccess } from "../electron/feature-registry.mjs";

const now = Date.parse("2026-09-23T00:00:00Z");
const future = (days) => new Date(now + days * 86_400_000).toISOString();
const past = (days) => new Date(now - days * 86_400_000).toISOString();

function licenseState({ baseExpiresAt = future(30), vipExpiresAt = null, phase = "active", authorized = true, offlineUntil = null } = {}) {
  return {
    phase,
    authorized,
    ...(offlineUntil ? { offlineUntil } : {}),
    license: {
      entitlementSchemaVersion: 1,
      baseExpiresAt,
      vipExpiresAt,
      basePermanent: false,
    },
  };
}

async function unusedPort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function request(port, pathname, { method = "GET", body = null } = {}) {
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      agent: false,
      headers: {
        connection: "close",
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.once("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let port;
let dataDirectory;
let backend;
let currentState;
let currentTime = now;
let providerCalls = 0;
let originalFetch;

before(async () => {
  port = await unusedPort();
  dataDirectory = await mkdtemp(join(tmpdir(), "ai-media-voice-auth-"));
  process.env.PORT = String(port);
  process.env.SKILL_STUDIO_DATA_DIR = dataDirectory;
  process.env.MINIMAX_API_KEY = "";
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("测试禁止访问第三方供应商");
  };
  backend = await import(`../electron/voice-backend/server.mjs?authorization-test=${Date.now()}`);
  currentState = licenseState();
  backend.configureVoiceAuthorization(() => requireFeatureAccess(featureRegistry, "voice", currentState, currentTime));
});

after(async () => {
  if (backend?.server?.listening) await new Promise((resolve) => backend.server.close(resolve));
  globalThis.fetch = originalFetch;
  await rm(dataDirectory, { recursive: true, force: true });
});

test("有效免费、VIP 到期及离线 A 的有效基础授权都可直接访问声音业务", async () => {
  currentState = licenseState();
  assert.equal((await request(port, "/api/voices")).status, 200);

  currentState = licenseState({ vipExpiresAt: past(1) });
  assert.equal((await request(port, "/api/voices")).status, 200);

  currentState = licenseState({ phase: "offline_active", offlineUntil: future(2), vipExpiresAt: past(1) });
  assert.equal((await request(port, "/api/voices")).status, 200);
});

test("无效基础授权不能从第二端口读取、写入或下载业务资源", async () => {
  currentState = licenseState({ baseExpiresAt: past(1) });
  for (const [method, pathname] of [["GET", "/api/voices"], ["POST", "/api/app-state"], ["GET", "/outputs/voices/synthetic.mp3"], ["GET", "/uploads/voices/synthetic.wav"], ["GET", "/server.mjs"]]) {
    const response = await request(port, pathname, { method, body: method === "POST" ? {} : null });
    assert.equal(response.status, 403, `${method} ${pathname}`);
    assert.equal(response.json?.error, "feature_not_entitled");
    assert.doesNotMatch(response.json?.message || "", /VIP|购买|升级会员/);
  }
});

test("授权拒绝发生在供应商调用之前", async () => {
  currentState = licenseState({ authorized: false });
  providerCalls = 0;
  const response = await request(port, "/api/config/test-minimax", {
    method: "POST",
    body: { minimaxApiKey: "SYNTHETIC-KEY", minimaxBaseUrl: "https://supplier.invalid/v1" },
  });
  assert.equal(response.status, 403);
  assert.equal(providerCalls, 0);
});

test("有效免费授权缺少 API 时返回配置错误而非 VIP 提示，且不访问供应商", async () => {
  currentState = licenseState({ vipExpiresAt: null });
  providerCalls = 0;
  const response = await request(port, "/api/voice-clone/create", {
    method: "POST",
    body: { attemptId: "synthetic-missing-api" },
  });
  assert.equal(response.status, 500);
  assert.equal(response.json?.error, "minimax_api_missing");
  assert.match(response.json?.message || "", /API Key.*未配置/);
  assert.doesNotMatch(response.json?.message || "", /VIP|购买|升级会员/);
  assert.equal(providerCalls, 0);
});

test("联网撤权和同进程服务重启后仍使用同一实时授权判断", async () => {
  currentState = licenseState();
  assert.equal((await request(port, "/api/voices")).status, 200);

  currentState = { ...licenseState(), phase: "disabled", authorized: false };
  assert.equal((await request(port, "/api/voices")).status, 403);

  await new Promise((resolve) => backend.server.close(resolve));
  await backend.startServer();
  assert.equal((await request(port, "/api/voices")).status, 403);

  currentState = licenseState({ phase: "offline_active", offlineUntil: future(1) });
  assert.equal((await request(port, "/api/voices")).status, 200);
});

test("服务持续运行时基础期限和离线宽限一到期，下一次声音请求立即被拒绝", async () => {
  currentTime = now;
  currentState = licenseState({ baseExpiresAt: future(1), phase: "offline_active", offlineUntil: future(1) });
  assert.equal((await request(port, "/api/voices")).status, 200);

  currentTime = now + 2 * 86_400_000;
  assert.equal((await request(port, "/api/voices")).status, 403);
  currentTime = now;
});

test("第二端口没有公开例外，未知、API 和用户文件路径都默认受保护", () => {
  assert.equal(backend.isProtectedBusinessPath("/index.html"), true);
  assert.equal(backend.isProtectedBusinessPath("/assets/app.js"), true);
  assert.equal(backend.isProtectedBusinessPath("/server.mjs"), true);
  assert.equal(backend.isProtectedBusinessPath("/api/config"), true);
  assert.equal(backend.isProtectedBusinessPath("/api/dreamina/status"), true);
  assert.equal(backend.isProtectedBusinessPath("/outputs/voices/a.mp3"), true);
  assert.equal(backend.isProtectedBusinessPath("/uploads/voices/a.wav"), true);
});
