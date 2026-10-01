import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStableMachineIdentity } from "../electron/machine-code.mjs";
import { LicenseService } from "../electron/license-service.mjs";
import { LicenseSecureStore } from "../electron/license-secure-store.mjs";

const APP = "ai-media-library";
const UUID_A = "a1234567-89ab-cdef-0123-456789abcdef";
const UUID_B = "b1234567-89ab-cdef-0123-456789abcdef";
const NOW = Date.parse("2026-09-23T00:00:00Z");
const hashCode = (source) => "v2_" + createHash("sha256").update(`license-machine-code-v2\0${APP}\0${source}`).digest("hex");
const hardware = (rawId, sourceType = "windows_system_uuid") => ({ rawId, normalizedId: rawId.toLowerCase(), sourceType });
const FACTORS = {
  version: 3, platform: "win32", low_confidence: false,
  candidate_machine_code: `v3_${"c".repeat(64)}`,
  factors: { machine_guid: { hash: "a".repeat(32) }, bios_uuid: { hash: "b".repeat(32) }, system_disk_serial: { hash: "c".repeat(32) } },
};
const machineIdentity = { start: async () => {}, payloadForRequest: () => FACTORS, acceptServerIdentity() {} };
const response = (code) => new Response(JSON.stringify({
  ok: true, action: "activated", code_id: "old-license", device_session: "old-session",
  device_credential: "old-credential", machine_code: code,
  ...(code.startsWith("v3_") ? { canonical_machine_code: code } : {}),
  binding_status: "active", license_type: "time_30d", duration_days: 30,
  activated_at: "2026-09-17T00:00:00Z", expires_at: "2026-10-17T00:00:00Z", remaining_days: 24,
}), { status: 200 });

async function fixture(t) {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "aiml-identity-upgrade-"));
  t.after(() => rm(userDataPath, { recursive: true, force: true }));
  // Isolated test codec. Does not access Keychain, DPAPI, or production data.
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`test-only:${value}`),
    decryptString: (value) => {
      const text = value.toString();
      assert.ok(text.startsWith("test-only:"));
      return text.slice(10);
    },
  };
  return () => new LicenseSecureStore({ userDataPath, safeStorage });
}

for (const variant of ["raw-v2", "normalized-v3-record", "random-fallback", "canonical-v3"]) {
  test(`真实临时文件升级：${variant} 保留已激活权益、在线验证及离线授权，无须重新激活`, async (t) => {
    const makeStore = await fixture(t);
    const beforeStore = makeStore();
    const source = variant === "random-fallback" ? "old-seed" : variant === "normalized-v3-record" ? "old-guid" : "OLD-GUID";
    const code = hashCode(source);
    await beforeStore.writeMachineCode(code);
    if (variant === "random-fallback") await beforeStore.writeMachineSeed(source);
    if (variant === "normalized-v3-record" || variant === "canonical-v3") {
      await beforeStore.writeMachineIdentity({ version: 3, active_machine_code: code,
        source_type: "windows_machine_guid", legacy_machine_code: variant === "canonical-v3" ? code : "",
        hardware_digest: createHash("sha256").update(`license-hardware-digest-v1\0${APP}\0old-guid`).digest("hex"),
        machine_identity_mismatch: false,
      });
    }
    const remoteCode = variant === "canonical-v3" ? `v3_${"d".repeat(64)}` : code;
    const oldClient = new LicenseService({ secureStore: beforeStore, machineCode: async () => code,
      machineIdentity, clientVersion: "old-synthetic", fetchImpl: async () => response(remoteCode), now: () => NOW });
    assert.equal((await oldClient.activate("EXISTING-CARD")).authorized, true);
    const originalCredential = await beforeStore.readCredential();

    // Simulate an upgrade/restart with different UUID algorithm available.
    const upgradedStore = makeStore();
    const getIdentity = () => createStableMachineIdentity({ appName: APP, secureStore: upgradedStore,
      platform: "win32", hardwareIdProvider: async () => hardware(UUID_A),
      legacyHardwareIdProvider: async () => hardware("OLD-GUID", "windows_machine_guid") });
    const calls = [];
    const upgraded = new LicenseService({ secureStore: upgradedStore,
      machineCode: async () => (await getIdentity()).active_machine_code, localMachineIdentity: getIdentity,
      machineIdentity, clientVersion: "new-synthetic", now: () => NOW,
      fetchImpl: async (url) => { calls.push(url); return response(remoteCode); },
    });
    assert.equal((await upgraded.initialize()).phase, "active");
    assert.equal((await getIdentity()).active_machine_code, code);
    assert.ok(calls.every((url) => url.endsWith("/device/status")), "upgrade must never activate again");
    const updatedCredential = await upgradedStore.readCredential();
    for (const field of ["codeId", "deviceCredential", "activationCode", "boundMachineCode", "activatedAt", "expiresAt"]) {
      assert.equal(updatedCredential[field], originalCredential[field], field);
    }

    const offlineStore = makeStore();
    const getOfflineIdentity = () => createStableMachineIdentity({ appName: APP, secureStore: offlineStore, platform: "win32",
      hardwareIdProvider: async () => "", legacyHardwareIdProvider: async () => "" });
    const offline = new LicenseService({ secureStore: offlineStore, localMachineIdentity: getOfflineIdentity,
      machineCode: async () => (await getOfflineIdentity()).active_machine_code,
      machineIdentity, clientVersion: "new-synthetic", now: () => NOW + 1000,
      fetchImpl: async () => { throw new Error("offline"); },
    });
    assert.equal((await offline.initialize()).phase, "offline_active");
    assert.equal((await getOfflineIdentity()).active_machine_code, code);
    assert.equal((await offlineStore.readCredential()).deviceCredential, originalCredential.deviceCredential);
  });
}

test("新安装读取失败或持久化失败时不会向服务器消耗激活码", async (t) => {
  const makeStore = await fixture(t);
  for (const scenario of ["read-failed", "write-failed"]) {
    const store = makeStore();
    if (scenario === "write-failed") store.writeMachineIdentity = async () => { throw new Error("unavailable"); };
    const getIdentity = () => createStableMachineIdentity({ appName: APP, secureStore: store, platform: "win32",
      hardwareIdProvider: async () => scenario === "read-failed" ? "" : hardware(UUID_A) });
    let requests = 0;
    const client = new LicenseService({ secureStore: store, localMachineIdentity: getIdentity,
      machineCode: async () => (await getIdentity()).active_machine_code, clientVersion: "test",
      fetchImpl: async () => { requests += 1; return response(hashCode("unused")); },
    });
    const state = await client.activate("UNUSED-CARD");
    assert.equal(state.authorized, false);
    assert.equal(state.phase, "configuration_error");
    assert.equal(requests, 0);
    assert.equal(await store.readCredential(), null);
  }
});

test("复制新 UUID 身份与凭证到异机：在线、离线、激活、刷新、解绑均不能冒用且保留证据", async (t) => {
  const makeStore = await fixture(t);
  const initialStore = makeStore();
  const original = await createStableMachineIdentity({ appName: APP, secureStore: initialStore, platform: "win32",
    hardwareIdProvider: async () => hardware(UUID_A) });
  const oldClient = new LicenseService({ secureStore: initialStore, machineCode: async () => original.active_machine_code,
    clientVersion: "test", fetchImpl: async () => response(original.active_machine_code), now: () => NOW });
  assert.equal((await oldClient.activate("EXISTING-CARD")).authorized, true);
  const credentialBefore = await initialStore.readCredential();
  const grantBefore = await initialStore.readOfflineGrant();
  const foreignStore = makeStore();
  const getIdentity = () => createStableMachineIdentity({ appName: APP, secureStore: foreignStore, platform: "win32",
    hardwareIdProvider: async () => hardware(UUID_B) });
  let requests = 0;
  const foreign = new LicenseService({ secureStore: foreignStore, localMachineIdentity: getIdentity,
    machineCode: async () => (await getIdentity()).active_machine_code, clientVersion: "test", now: () => NOW,
    fetchImpl: async () => { requests += 1; return response(original.active_machine_code); },
  });
  for (const run of [() => foreign.initialize(), () => foreign.refresh(), () => foreign.activate("OTHER-CARD"),
    () => foreign.offlineStateOrNetworkError(credentialBefore), () => foreign.unbind()]) {
    const state = await run();
    assert.equal(state.phase, "invalid");
    assert.equal(state.authorized, false);
  }
  assert.equal((await foreign.refreshDeviceSession(credentialBefore)).ok, false);
  assert.equal(requests, 0);
  assert.deepEqual(await foreignStore.readCredential(), credentialBefore);
  assert.deepEqual(await foreignStore.readOfflineGrant(), grantBefore);
  assert.equal((await getIdentity()).active_machine_code, original.active_machine_code);
});

test("老用户只有凭证没有机器码缓存：通过带原凭证的状态接口恢复精确旧码，无需新激活", async (t) => {
  const makeStore = await fixture(t);
  const store = makeStore();
  const oldCode = hashCode("LEGACY-RAW-GUID");
  const credential = { codeId: "old-license", deviceSession: "old-session", deviceCredential: "old-credential", activationCode: "EXISTING-CARD" };
  await store.writeCredential(credential);
  let client;
  const getIdentity = () => createStableMachineIdentity({ appName: APP, secureStore: store, platform: "win32",
    hardwareIdProvider: async () => hardware(UUID_B), legacyHardwareIdProvider: async () => "",
    recoverMachineCode: (saved) => client.recoverHistoricalMachineCode(saved) });
  const calls = [];
  client = new LicenseService({ secureStore: store, localMachineIdentity: getIdentity,
    machineCode: async () => (await getIdentity()).active_machine_code, clientVersion: "test", now: () => NOW,
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.ok(url.endsWith("/device/status"));
      assert.equal(options.headers.Authorization, "Bearer old-session");
      assert.equal(options.headers["X-Device-Credential"], "old-credential");
      return response(oldCode);
    },
  });
  assert.equal((await client.initialize()).phase, "active");
  assert.equal((await getIdentity()).active_machine_code, oldCode);
  assert.equal(await store.readMachineCode(), oldCode);
  assert.equal((await store.readCredential()).activationCode, credential.activationCode);
  assert.equal(calls.length, 2); // authenticated recovery, then normal status validation
});

test("旧码恢复被服务器拒绝时保留原凭证，不试新 UUID 或偷偷重新激活", async (t) => {
  const makeStore = await fixture(t);
  const store = makeStore();
  const credential = { codeId: "old-license", deviceSession: "old-session", deviceCredential: "old-credential" };
  await store.writeCredential(credential);
  let client;
  const getIdentity = () => createStableMachineIdentity({ appName: APP, secureStore: store, platform: "win32",
    hardwareIdProvider: async () => hardware(UUID_A),
    recoverMachineCode: (saved) => client.recoverHistoricalMachineCode(saved) });
  let calls = 0;
  client = new LicenseService({ secureStore: store, localMachineIdentity: getIdentity,
    machineCode: async () => (await getIdentity()).active_machine_code, clientVersion: "test",
    fetchImpl: async (url) => {
      calls += 1;
      assert.ok(url.endsWith("/device/status"));
      return new Response(JSON.stringify({ ok: false, machine_code: hashCode("must-not-use") }), { status: 403 });
    },
  });
  const state = await client.initialize();
  assert.equal(state.authorized, false);
  assert.equal(state.phase, "configuration_error");
  assert.equal(calls, 1);
  assert.equal(await store.readMachineCode(), null);
  assert.equal(await store.readMachineIdentity(), null);
  assert.deepEqual(await store.readCredential(), credential);
});
