import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { LicenseService } from "../electron/license-service.mjs";
import { LICENSE_CONFIG } from "../electron/license-config.mjs";
import { redact } from "../electron/application-log.mjs";
import { LicenseDiagnosticLog } from "../electron/license-diagnostic-log.mjs";
import { decodePointsResponse, formatPointUnits, pointsPayload } from "../electron/points-client.mjs";

const code = "AIML-P-" + "A".repeat(32);
const legacyCode = "AIM-AAAA-BBBB-CCCC";
const raw = { ok: true, app_name: "ai-media-library", unit_scale: 1e6, balance_units: 12345678, reserved_units: 1000000, available_units: 11345678 };
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function fixture(fetchImpl, change = {}, options = {}) {
  const store = {
    credential: { codeId: "OWNER", deviceSession: "synthetic", deviceCredential: "synthetic", bindingStatus: "active", ...change },
    async readCredential() { return structuredClone(this.credential); },
    async writeCredential(value) { this.credential = structuredClone(value); },
  };
  const service = new LicenseService({ secureStore: store, machineCode: async () => "v2_test", clientVersion: "1.1.19", fetchImpl, ...options });
  return { store, service };
}

test("client fixes app name and only exposes three public actions", () => {
  assert.deepEqual(pointsPayload("balance"), { app_name: "ai-media-library" });
  for (const action of ["reserve", "commit", "release", "issue-code", "../balance"]) assert.throws(() => pointsPayload(action));
  for (const field of ["app_name", "cost_cny", "account_id", "request_id", "X-AIML-Settlement-Token"]) assert.throws(() => pointsPayload("balance", { [field]: "x" }));
});

test("six decimal display preserves precision without floating point rounding", () => {
  assert.equal(formatPointUnits(2), "0.000002");
  assert.equal(formatPointUnits(24691356), "24.691356");
  assert.equal(formatPointUnits(-24691356, true), "−24.691356");
  assert.equal(formatPointUnits(1e15), "1000000000");
  assert.equal(formatPointUnits(1000000, true), "+1");
});

test("legacy AIM point codes normalize but foreign and malformed formats are rejected", () => {
  assert.equal(pointsPayload("redeem", { code: ` ${legacyCode.toLowerCase()} ` }).code, legacyCode);
  for (const value of ["QLP-AAAA-BBBB-CCCC", "AIM-AAAA-BBBB", "AIM-AAAA-BBBB-CCCC-DDDD", "AIM-AAAA-BBBB-CCC!"]) {
    assert.throws(() => pointsPayload("redeem", { code: value }), { code: "INVALID_REDEEM_CODE" });
  }
});

test("rejects malformed, cross-app, inconsistent or imprecise wallet responses", () => {
  for (const change of [{ ok: false }, { app_name: "ProductOperationReport" }, { unit_scale: 100 },
    { balance_units: 1.2 }, { reserved_units: -1 }, { available_units: 0 }, { balance_units: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => decodePointsResponse({ ...raw, ...change }, "balance"));
  }
});

test("redeem only reports success on confirmed server data and never exposes credentials", async () => {
  let sent;
  const { service } = fixture(async (url, options) => {
    sent = { url, options };
    return response(200, { ...raw, idempotent: false, device_credential: "do-not-return", api_key: "do-not-return" });
  });
  const result = await service.requestPoints("redeem", { code: code.toLowerCase() });
  assert.equal(sent.url, LICENSE_CONFIG.baseUrl + "/ai-media-library/points/redeem");
  const payload = JSON.parse(sent.options.body);
  assert.equal(payload.app_name, "ai-media-library");
  assert.equal(payload.code, code);
  assert.equal(payload.request_id, createHash("sha256").update(`aiml-points-redeem-v1\0OWNER\0${code}`).digest("hex"));
  assert.equal(sent.options.headers.Authorization, "Bearer synthetic");
  assert.equal(sent.options.headers["X-Device-Credential"], "synthetic");
  assert.equal(sent.options.headers["X-AIML-Settlement-Token"], undefined);
  assert.equal(JSON.stringify(result).includes("do-not-return"), false);
});

test("401 session renewal retries the exact same redemption, preserving proof", async () => {
  const bodies = []; let tries = 0;
  const { service, store } = fixture(async (url, options) => {
    if (url.endsWith("/device/refresh")) return response(200, { device_session: "new-session" });
    bodies.push(options.body);
    if (++tries === 1) return response(401, { error_code: "DEVICE_AUTH_FAILED" });
    assert.equal(options.headers.Authorization, "Bearer new-session");
    return response(200, { ...raw, idempotent: true });
  });
  const result = await service.requestPoints("redeem", { code });
  assert.equal(result.idempotent, true); assert.deepEqual(bodies, [bodies[0], bodies[0]]);
  assert.equal(store.credential.deviceCredential, "synthetic");
});

test("missing session recovers before wallet request", async () => {
  const calls = [];
  const { service } = fixture(async url => {
    calls.push(url);
    return url.endsWith("/device/refresh") ? response(200, { device_session: "new-session" }) : response(200, raw);
  }, { deviceSession: null });
  await service.requestPoints("balance");
  assert.ok(calls[0].endsWith("/device/refresh"));
});

test("unavailable session recovery keeps credential and does not retry redeem", async () => {
  let pointCalls = 0;
  const { service, store } = fixture(async url => {
    if (url.endsWith("/device/refresh")) throw new Error("synthetic network failure");
    pointCalls++; return response(401, {});
  });
  await assert.rejects(service.requestPoints("redeem", { code }));
  assert.equal(pointCalls, 1); assert.equal(store.credential.deviceCredential, "synthetic");
});

test("network uncertainty preserves stable request ID for a later retry", async () => {
  const ids = []; let fail = true;
  const { service } = fixture(async (_url, options) => {
    ids.push(JSON.parse(options.body).request_id);
    if (fail) { fail = false; throw new Error("connection lost after commit"); }
    return response(200, { ...raw, idempotent: true });
  });
  await assert.rejects(service.requestPoints("redeem", { code }));
  assert.equal((await service.requestPoints("redeem", { code })).idempotent, true);
  assert.equal(ids[0], ids[1]);
});

test("preview can read real wallet but cannot consume a real redemption code", async () => {
  let calls = 0;
  const { service } = fixture(async () => { calls++; return response(200, raw); }, {}, { previewAllFeatures: true });
  await service.requestPoints("balance");
  await assert.rejects(service.requestPoints("redeem", { code }), { code: "POINTS_PREVIEW_REDEMPTION_DISABLED" });
  assert.equal(calls, 1);
});

test("forbidden app config or incomplete proof makes no HTTP request", async () => {
  let calls = 0;
  const bad = fixture(async () => { calls++; }, {}, { config: { ...LICENSE_CONFIG, appName: "ProductOperationReport" } });
  await assert.rejects(bad.service.requestPoints("balance"), { code: "APP_SCOPE_MISMATCH" });
  const missing = fixture(async () => { calls++; }, { deviceCredential: null });
  await assert.rejects(missing.service.requestPoints("balance"), { code: "POINTS_CREDENTIAL_REQUIRED" });
  assert.equal(calls, 0);
});

test("raw server failures cannot echo redemption code or credentials", async () => {
  const { service } = fixture(async () => response(500, { message: "API SECRET " + code, error_code: "UNKNOWN" }));
  await assert.rejects(service.requestPoints("redeem", { code }), e => !e.message.includes(code));
});

test("ledger is sanitized, scoped, ordered and cursor-checked", () => {
  const payload = { ...raw, items: [{ sequence: 2, kind: "commit", delta_units: -2, balance_units: 999998, task_id: "a".repeat(40), created_at: "2026-10-09T04:00:00Z", api_key: "SECRET" }], next_before_sequence: 2 };
  const result = decodePointsResponse(payload, "transactions");
  assert.equal(result.items[0].deltaUnits, -2); assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.throws(() => decodePointsResponse({ ...payload, next_before_sequence: 1 }, "transactions"));
  assert.throws(() => pointsPayload("transactions", { limit: 101 }));
});

test("real local HTTP and SQLite roundtrip: redemption, repeat, exact settlement and history", async () => {
  const script = `import sys\nsys.path.insert(0,'server-integration/points-20261009')\nfrom test_ai_media_points import SettlementTests\nfrom ai_media_points_service import build_handler\nfrom http.server import ThreadingHTTPServer\nf=SettlementTests();f.setUp();f.issue()\ns=ThreadingHTTPServer(('127.0.0.1',0),build_handler(f.engine))\nprint(s.server_port,flush=True)\ns.serve_forever()\n`;
  const child = spawn("python3", ["-u", "-c", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";child.stderr.on("data", chunk => { stderr += String(chunk); });
  try {
    const port = await new Promise((resolve, reject) => {
      child.stdout.once("data", value => resolve(Number(String(value).trim())));
      child.once("exit", () => reject(new Error("local fixture exited: " + stderr)));
    });
    const baseUrl = `http://127.0.0.1:${port}/api/license`;
    const { service } = fixture(fetch, {}, { config: { ...LICENSE_CONFIG, baseUrl } });
    assert.equal((await service.requestPoints("balance")).balanceUnits, 0);
    assert.equal((await service.requestPoints("redeem", { code })).balanceUnits, 1e9);
    assert.equal((await service.requestPoints("redeem", { code })).idempotent, true);
    const internal = async (action, body) => {
      const r = await fetch(baseUrl + "/ai-media-library/points/internal/" + action, { method: "POST", headers: {
        "Content-Type": "application/json", Authorization: "Bearer synthetic", "X-Device-Credential": "synthetic", "X-AIML-Settlement-Token": "test-only-internal-token-not-production",
      }, body: JSON.stringify({ app_name: "ai-media-library", ...body }) });
      assert.equal(r.status, 200);return r.json();
    };
    const task = await internal("reserve", { request_id: "logical-task", feature: "schemes", api_source: "platform_api", budget_cny: "1" });
    const commit = { task_id: task.task_id, cost_cny: "0.12345678", provider: "volcengine", bill_ref: "bill-1", attempt_id: "attempt-1", billed_model: "ep-test" };
    await internal("commit", commit);await internal("commit", commit);
    const wallet = await service.requestPoints("balance");assert.equal(wallet.balanceUnits, 975308644);
    const ledger = await service.requestPoints("transactions", { limit: 1 });
    assert.equal(ledger.items[0].deltaUnits, -24691356);
    const previous = await service.requestPoints("transactions", { limit: 30, beforeSequence: ledger.nextBeforeSequence });
    assert.equal(previous.items.length, 2);
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
  }
});

test("points codes are redacted from free text and diagnostic fields", () => {
  assert.ok(!JSON.stringify(redact({ redeemCode: code, message: `兑换失败 ${code}`, error_code: "REDEEM_CODE_USED" })).includes(code));
  const log = new LicenseDiagnosticLog();
  log.add("warning", "points", `响应包含 ${code}`, { serverMessage: code, pointsCode: code, errorCode: "REDEEM_CODE_USED" });
  const output = log.toText();
  assert.ok(!output.includes(code));assert.ok(output.includes("REDEEM_CODE_USED"));
  assert.ok(!JSON.stringify(redact({ message: legacyCode.toLowerCase() })).includes(legacyCode.toLowerCase()));
  log.add("warning", "points", legacyCode.toLowerCase());
  assert.ok(!log.toText().includes(legacyCode.toLowerCase()));
});
