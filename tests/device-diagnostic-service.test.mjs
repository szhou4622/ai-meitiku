import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeviceDiagnosticRequest,
  deviceDiagnosticErrorMessage,
  normalizeDeviceDiagnosticCode,
  prepareDeviceDiagnosticRequest,
  submitDeviceDiagnostic,
} from "../electron/device-diagnostic-service.mjs";

function identityResult() {
  return {
    version: 3,
    platform: "win32",
    factor_hashes: {
      machine_guid: "1".repeat(32),
      bios_uuid: "2".repeat(32),
      baseboard_serial: "3".repeat(32),
      system_disk_serial: "4".repeat(32),
      cpu_processor_id: "5".repeat(32),
      physical_mac: "6".repeat(32),
    },
    factor_status: {
      machine_guid: { source: "registry", raw: "MUST_NOT_LEAVE_DEVICE" },
      bios_uuid: { source: "cim" },
      baseboard_serial: { source: "cim" },
      system_disk_serial: { source: "cim" },
      cpu_processor_id: { source: "cim" },
      physical_mac: { source: "cim" },
    },
    candidate_machine_code: `v3_${"a".repeat(64)}`,
    collection: { duration_ms: 10, fallback_used: false, timed_out: false },
  };
}

test("normalizes a human one-time code and rejects ambiguous characters", () => {
  assert.equal(normalizeDeviceDiagnosticCode("abcd-2345"), "ABCD-2345");
  assert.throws(() => normalizeDeviceDiagnosticCode("ABCO-2345"), /8 位/);
  assert.throws(() => normalizeDeviceDiagnosticCode("short"), /8 位/);
});

test("builds a scoped hash-only diagnostic payload", () => {
  const request = buildDeviceDiagnosticRequest({
    appName: "ai-media-library",
    verificationCode: "ABCD-2345",
    machineCode: `v2_${"b".repeat(64)}`,
    recoverySecret: "c".repeat(64),
    identityResult: identityResult(),
  });
  assert.equal(request.app_name, "ai-media-library");
  assert.equal(request.machine_identity_v3.factors.machine_guid.hash, "1".repeat(32));
  assert.equal(request.machine_identity_v3.factors.machine_guid.reason, undefined);
  assert.doesNotMatch(JSON.stringify(request), /MUST_NOT_LEAVE_DEVICE/);
  assert.doesNotMatch(JSON.stringify(request), /weight/i);
});

test("rejects low-confidence identity before a recovery secret is needed", () => {
  const lowConfidence = identityResult();
  lowConfidence.factor_hashes = { machine_guid: "1".repeat(32) };
  lowConfidence.factor_status = { machine_guid: { source: "registry" } };
  assert.throws(
    () => prepareDeviceDiagnosticRequest({
      appName: "ai-media-library",
      verificationCode: "ABCD-2345",
      machineCode: `v2_${"b".repeat(64)}`,
      identityResult: lowConfidence,
    }),
    /身份因子不足/,
  );
});

test("submits only to the fixed device diagnostic route", async () => {
  let seenUrl = "";
  let seenOptions = null;
  const result = await submitDeviceDiagnostic({
    baseUrl: "https://license.dadaozixun.com/api/license/",
    request: { app_name: "ai-media-library" },
    fetchImpl: async (url, options) => {
      seenUrl = url;
      seenOptions = options;
      return { ok: true, json: async () => ({ ok: true, report_id: "diag_test", message: "ok" }) };
    },
  });
  assert.equal(seenUrl, "https://license.dadaozixun.com/api/license/device-diagnostic/submit");
  assert.equal(seenOptions.method, "POST");
  assert.equal(seenOptions.redirect, "error");
  assert.equal(result.reportId, "diag_test");
});

test("does not expose a remote stack when submission fails", async () => {
  await assert.rejects(
    submitDeviceDiagnostic({
      baseUrl: "https://license.dadaozixun.com/api/license",
      request: {},
      fetchImpl: async () => ({
        ok: false,
        json: async () => ({ message: "核验码已过期", stack: "SECRET SERVER STACK" }),
      }),
    }),
    (error) => error.message === "核验码已过期" && !error.message.includes("STACK"),
  );
});

test("rejects an unexpected diagnostic origin before sending the recovery proof", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    submitDeviceDiagnostic({
      baseUrl: "https://attacker.example/api/license",
      request: { activation_recovery_secret: "a".repeat(64) },
      fetchImpl: async () => { fetchCalls += 1; },
    }),
    /服务地址不正确/,
  );
  assert.equal(fetchCalls, 0);
});

test("replaces secure-storage provider failures with a safe Chinese message", () => {
  const error = new Error("Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync");
  const message = deviceDiagnosticErrorMessage(error);
  assert.match(message, /加密授权凭证无法读取/);
  assert.doesNotMatch(message, /decrypt|ciphertext|safeStorage/i);
});

test("maps encrypted-write and malformed-data failures without leaking provider details", () => {
  const encryptError = Object.assign(new Error("raw Credential Manager failure"), {
    code: "SECURE_STORAGE_ENCRYPT_FAILED",
  });
  const invalidError = Object.assign(new Error("raw corrupt JSON"), {
    code: "SECURE_STORAGE_DATA_INVALID",
  });

  const encryptMessage = deviceDiagnosticErrorMessage(encryptError);
  const invalidMessage = deviceDiagnosticErrorMessage(invalidError);
  assert.match(encryptMessage, /安全凭证无法保存/);
  assert.match(invalidMessage, /数据格式异常/);
  assert.doesNotMatch(`${encryptMessage}\n${invalidMessage}`, /Credential Manager|corrupt JSON/i);
});
