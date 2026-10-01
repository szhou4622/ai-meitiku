import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LicenseSecureStore } from "../electron/license-secure-store.mjs";
import { LicenseService } from "../electron/license-service.mjs";

function createStore(initial = null) {
  return {
    credential: initial,
    offlineGrant: null,
    offlineHmacKey: Buffer.alloc(32, 0x29),
    machineIdentity: { version: 3, active_machine_code: "v2_local-machine-identity" },
    deleted: false,
    clearDeviceCredentialCalls: 0,
    clearOfflineGrantCalls: 0,
    async readCredential() { return this.credential; },
    async writeCredential(value) { this.credential = structuredClone(value); },
    async readOrCreateOfflineHmacKey() { return this.offlineHmacKey; },
    async readOfflineGrant() { return this.offlineGrant; },
    async writeOfflineGrant(value) { this.offlineGrant = structuredClone(value); },
    async clearOfflineGrant() { this.offlineGrant = null; this.clearOfflineGrantCalls += 1; },
    async deleteCredential() { this.credential = null; this.deleted = true; },
    async clearDeviceCredential() {
      this.clearDeviceCredentialCalls += 1;
      if (this.credential) {
        const preserved = { ...this.credential };
        delete preserved.deviceSession;
        delete preserved.deviceCredential;
        this.credential = Object.keys(preserved).length ? preserved : null;
      }
      await this.clearOfflineGrant();
    },
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const activePayload = {
  ok: true,
  code_id: "code-1",
  device_session: "session-secret",
  device_credential: "credential-secret",
  binding_status: "active",
  license_type: "monthly",
  duration_days: 30,
  activated_at: "2026-08-20T00:00:00Z",
  expires_at: "2027-09-19T00:00:00Z",
  remaining_days: 30,
  transfer_count: 0,
};

function withoutDeviceCredentials(payload) {
  const copy = { ...payload };
  delete copy.device_session;
  delete copy.device_credential;
  return copy;
}

test("requires activation when no secure device credential exists", async () => {
  const service = new LicenseService({
    secureStore: createStore(),
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    fetchImpl: async () => { throw new Error("should not fetch"); },
  });
  const state = await service.initialize();
  assert.equal(state.phase, "needs_activation");
  assert.equal(state.authorized, false);
  assert.equal(state.canUnbind, false);
});

test("keeps a valid bound user authorized when async decrypt and encrypt both require sync fallback", async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "license-service-safe-storage-"));
  try {
    const syncBackend = {
      isAsyncEncryptionAvailable: async () => false,
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`sync:${value}`, "utf8"),
      decryptString: (value) => value.toString("utf8").replace(/^sync:/, ""),
    };
    const initialStore = new LicenseSecureStore({ userDataPath, safeStorage: syncBackend });
    await initialStore.writeCredential({
      codeId: "code-1",
      deviceSession: "session-secret",
      deviceCredential: "credential-secret",
      activationCode: "SAVED-CODE",
      bindingStatus: "active",
      licenseType: "monthly",
      durationDays: 30,
      activatedAt: "2026-08-20T00:00:00Z",
      expiresAt: "2027-09-19T00:00:00Z",
    });

    let asyncDecryptCalls = 0;
    let syncDecryptCalls = 0;
    let asyncEncryptCalls = 0;
    let syncEncryptCalls = 0;
    const affectedBackend = {
      isAsyncEncryptionAvailable: async () => true,
      isEncryptionAvailable: () => true,
      decryptStringAsync: async () => {
        asyncDecryptCalls += 1;
        throw new Error("Error while decrypting the ciphertext provided");
      },
      decryptString: (value) => {
        syncDecryptCalls += 1;
        return value.toString("utf8").replace(/^sync:/, "");
      },
      encryptStringAsync: async () => {
        asyncEncryptCalls += 1;
        throw new Error("Credential Manager async write failed");
      },
      encryptString: (value) => {
        syncEncryptCalls += 1;
        return Buffer.from(`sync:${value}`, "utf8");
      },
    };
    const secureStore = new LicenseSecureStore({ userDataPath, safeStorage: affectedBackend });
    const service = new LicenseService({
      secureStore,
      machineCode: async () => "v2_machine",
      clientVersion: "1.1.8",
      fetchImpl: async (url) => {
        assert.match(url, /\/device\/status$/);
        return jsonResponse(200, activePayload);
      },
    });

    const state = await service.initialize();

    assert.equal(state.phase, "active");
    assert.equal(state.authorized, true);
    assert.ok(asyncDecryptCalls >= 1);
    assert.ok(syncDecryptCalls >= 1);
    assert.ok(asyncEncryptCalls >= 1);
    assert.ok(syncEncryptCalls >= 1);
    assert.equal((await secureStore.readCredential()).deviceSession, "session-secret");
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("activation stops without requests or writes when the encrypted credential cannot be decrypted", async () => {
  const store = createStore();
  const secureError = Object.assign(new Error("raw provider failure"), {
    code: "SECURE_STORAGE_DECRYPT_FAILED",
  });
  let fetchCalls = 0;
  let credentialWrites = 0;
  let recoverySecretCalls = 0;
  store.readCredential = async () => { throw secureError; };
  store.writeCredential = async () => { credentialWrites += 1; };
  store.readOrCreateActivationRecoverySecret = async () => {
    recoverySecretCalls += 1;
    return "a".repeat(64);
  };
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.1.7",
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse(200, activePayload);
    },
  });

  const state = await service.activate("VALID-BUT-NOT-SUBMITTED");
  assert.equal(state.phase, "needs_activation");
  assert.equal(state.authorized, false);
  assert.match(state.message, /加密授权凭证无法读取/);
  assert.doesNotMatch(state.message, /provider/i);
  assert.deepEqual({ fetchCalls, credentialWrites, recoverySecretCalls }, {
    fetchCalls: 0,
    credentialWrites: 0,
    recoverySecretCalls: 0,
  });
});

test("activation fails closed on an unexpected credential read error", async () => {
  const store = createStore();
  let fetchCalls = 0;
  let writes = 0;
  store.readCredential = async () => { throw new Error("simulated EIO"); };
  store.writeCredential = async () => { writes += 1; };
  store.readOrCreateActivationRecoverySecret = async () => "a".repeat(64);
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.1.8",
    fetchImpl: async () => { fetchCalls += 1; return jsonResponse(200, activePayload); },
  });

  const state = await service.activate("MUST-NOT-BE-SUBMITTED");
  assert.equal(state.authorized, false);
  assert.match(state.message, /原数据已保留/);
  assert.deepEqual({ fetchCalls, writes }, { fetchCalls: 0, writes: 0 });
});

test("stores the activation code only inside the secure credential record", async () => {
  const store = createStore();
  let captured;
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.2.3",
    fetchImpl: async (url, options) => {
      if (url.endsWith("/activate")) captured = { url, options };
      return jsonResponse(200, activePayload);
    },
  });

  const state = await service.activate("ACTIVATION-CODE-MUST-NOT-PERSIST");
  assert.equal(state.phase, "active");
  assert.equal(state.authorized, true);
  assert.equal(state.canUnbind, true);
  assert.equal(state.hasActivationCode, true);
  assert.equal(captured.url, "https://license.dadaozixun.com/api/license/activate");
  assert.deepEqual(JSON.parse(captured.options.body), {
    app_name: "ai-media-library",
    activation_code: "ACTIVATION-CODE-MUST-NOT-PERSIST",
    machine_code: "v2_machine",
    client_version: "1.2.3",
    license_protocol_version: 2,
  });
  assert.equal(store.credential.deviceSession, "session-secret");
  assert.equal(store.credential.deviceCredential, "credential-secret");
  assert.equal(store.credential.activationCode, "ACTIVATION-CODE-MUST-NOT-PERSIST");
  assert.equal(JSON.stringify(state).includes("ACTIVATION-CODE-MUST-NOT-PERSIST"), false);
  assert.equal(JSON.stringify(state).includes("session-secret"), false);
  assert.equal(JSON.stringify(state).includes("credential-secret"), false);
});

test("activation fallback asks for verification without implying the purchased license is lost", async () => {
  const service = new LicenseService({
    secureStore: createStore(),
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    fetchImpl: async () => jsonResponse(400, {}),
  });

  const state = await service.activate("CODE-TO-CHECK");
  assert.equal(state.phase, "needs_activation");
  assert.equal(state.authorized, false);
  assert.equal(state.message, "未能完成激活，请核对激活码输入后重试；如仍失败，请复制机器码联系客服查询。");
});

test("an existing device supplies its own proof for a second time card without merging locally", async () => {
  const original = {
    ...activePayload,
    codeId: "original-primary",
    deviceSession: "existing-session",
    deviceCredential: "existing-credential",
    activationCode: "ORIGINAL-CODE",
  };
  const store = createStore(original);
  let request;
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.1.6",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse(409, {
        ok: false,
        error_code: "existing_time_license",
        action: "renewal_requires_confirmation",
        message: "本机已有时间授权，第二张时间卡未使用。请在客户端明确确认续期；续期成功前不会消耗新卡或更换设备身份。",
      });
    },
  });

  const state = await service.activate("SECOND-CODE");
  assert.equal(request.url, "https://license.dadaozixun.com/api/license/activate");
  assert.equal(request.options.headers.Authorization, "Bearer existing-session");
  assert.equal(request.options.headers["X-Device-Credential"], "existing-credential");
  assert.equal(JSON.parse(request.options.body).device_credential, "existing-credential");
  assert.equal(JSON.parse(request.options.body).machine_code, "v2_machine");
  assert.equal(state.authorized, false);
  assert.equal(state.phase, "renewal_required");
  assert.match(state.message, /明确确认续期/);
  assert.deepEqual(store.credential, original);
  assert.equal(JSON.stringify(state).includes("existing-credential"), false);
});

test("an unactivated device sends no credential and shows the structured identity conflict", async () => {
  const store = createStore();
  let options;
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_collision",
    clientVersion: "1.1.6",
    fetchImpl: async (_url, requestOptions) => {
      options = requestOptions;
      return jsonResponse(409, {
        ok: false,
        error_code: "machine_identity_conflict",
        action: "manual_identity_review",
        message: "检测到机器身份冲突，请复制脱敏诊断联系管理员核对。",
      });
    },
  });

  const state = await service.activate("NEW-TIME-CODE");
  assert.equal(options.headers.Authorization, undefined);
  assert.equal(options.headers["X-Device-Credential"], undefined);
  assert.equal(JSON.parse(options.body).device_credential, undefined);
  assert.equal(state.phase, "needs_activation");
  assert.match(state.message, /复制脱敏诊断/);
  assert.equal(store.credential, null);
});

test("combines license and device credentials returned in nested response containers", async () => {
  const store = createStore();
  let calls = 0;
  const licensePayload = withoutDeviceCredentials(activePayload);
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(200, {
          ok: true,
          action: "activated",
          data: {
            license: licensePayload,
            device: {
              device_session: activePayload.device_session,
              device_credential: activePayload.device_credential,
            },
          },
        });
      }
      return jsonResponse(200, { data: { license: licensePayload } });
    },
  });

  const state = await service.activate("NESTED-TIME-CODE");
  assert.equal(calls, 2);
  assert.equal(state.phase, "active");
  assert.equal(state.canUnbind, true);
  assert.equal(store.credential.deviceSession, "session-secret");
  assert.equal(store.credential.deviceCredential, "credential-secret");
  assert.equal(store.credential.activationCode, "NESTED-TIME-CODE");
});

test("reveals a saved activation code only while authorized and preserves it on unbind", async () => {
  const store = createStore();
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    fetchImpl: async (url) => url.endsWith("/device/unbind")
      ? jsonResponse(200, { ok: true })
      : jsonResponse(200, activePayload),
  });

  const activeState = await service.activate("SECURE-VIEW-CODE");
  assert.equal(activeState.hasActivationCode, true);
  assert.equal(await service.activationCode(), "SECURE-VIEW-CODE");
  assert.equal(JSON.stringify(activeState).includes("SECURE-VIEW-CODE"), false);

  const unboundState = await service.unbind();
  assert.equal(unboundState.hasActivationCode, true);
  assert.equal(store.credential.activationCode, "SECURE-VIEW-CODE");
  assert.equal(store.credential.deviceSession, undefined);
  assert.equal(store.credential.deviceCredential, undefined);
  assert.deepEqual(store.machineIdentity, { version: 3, active_machine_code: "v2_local-machine-identity" });
  await assert.rejects(() => service.activationCode(), /请先完成在线授权验证/);
});

test("enrolls an activation code locally without calling the activation endpoint", async () => {
  const store = createStore({
    deviceSession: "session-secret",
    deviceCredential: "credential-secret",
    bindingStatus: "active",
    licenseType: "monthly",
    durationDays: 30,
    activatedAt: activePayload.activated_at,
    expiresAt: activePayload.expires_at,
  });
  const requestedUrls = [];
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return jsonResponse(200, activePayload);
    },
  });

  await service.initialize();
  await assert.rejects(
    () => service.activationCode(),
    /本机尚未补录激活码，可在授权管理中补录，或复制机器码联系客服查询/,
  );
  const state = await service.saveActivationCode("MANUALLY-ENROLLED-CODE");
  assert.equal(state.phase, "active");
  assert.equal(state.hasActivationCode, true);
  assert.equal(store.credential.activationCode, "MANUALLY-ENROLLED-CODE");
  assert.equal(JSON.stringify(state).includes("MANUALLY-ENROLLED-CODE"), false);
  assert.equal(requestedUrls.some((url) => url.endsWith("/activate")), false);
  await assert.rejects(() => service.saveActivationCode("   "), /请输入需要补录的激活码/);
});

test("reports credential recovery state when an already-bound response has no local secrets", async () => {
  const store = createStore();
  const licensePayload = withoutDeviceCredentials(activePayload);
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    fetchImpl: async () => jsonResponse(200, {
      ...licensePayload,
      action: "already_bound",
      message: "该激活码已绑定本机",
    }),
  });

  const state = await service.activate("ALREADY-BOUND-CODE");
  assert.equal(state.phase, "credential_missing");
  assert.equal(state.authorized, false);
  assert.equal(state.canUnbind, false);
  assert.match(state.message, /该激活码已绑定本机/);
  assert.match(state.message, /后台按机器码重置绑定/);
  assert.equal(store.credential, null);
});

test("does not persist a partial device credential", async () => {
  const store = createStore();
  const partialPayload = withoutDeviceCredentials(activePayload);
  partialPayload.device_session = "session-without-credential";
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    fetchImpl: async () => jsonResponse(200, { ...partialPayload, action: "activated" }),
  });

  const state = await service.activate("PARTIAL-CREDENTIAL-CODE");
  assert.equal(state.phase, "credential_missing");
  assert.equal(state.canUnbind, false);
  assert.equal(store.credential, null);
  assert.equal(JSON.stringify(state).includes("session-without-credential"), false);
});

test("rejects unsupported server activation actions without storing credentials", async () => {
  const store = createStore();
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    fetchImpl: async () => jsonResponse(200, { ...activePayload, action: "balance_merged", message: "时间卡不能合并" }),
  });

  const state = await service.activate("TIME-MERGE-CODE");
  assert.equal(state.phase, "invalid");
  assert.equal(state.message, "时间卡不能合并");
  assert.equal(state.canUnbind, false);
  assert.equal(store.credential, null);
});

test("uses the newly signed offline grant when post-activation status verification loses network", async () => {
  const store = createStore();
  let calls = 0;
  const nowMs = new Date("2026-09-15T02:00:00Z").getTime();
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    now: () => nowMs,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(200, { ...activePayload, expires_at: "2026-09-19T00:00:00Z", action: "activated" });
      throw new TypeError("network down");
    },
  });

  const state = await service.activate("NETWORK-AFTER-ACTIVATION");
  assert.equal(state.phase, "offline_active");
  assert.equal(state.authorized, true);
  assert.equal(state.offlineRemainingDays, 4);
  assert.equal(state.message, "离线模式 · 功能正常可用，联网后将自动完成授权验证（剩余 4 天）");
  assert.equal(state.canUnbind, true);
  assert.equal(state.hasActivationCode, true);
  assert.equal(store.deleted, false);
  assert.equal(store.credential.deviceSession, "session-secret");
  assert.equal(store.credential.deviceCredential, "credential-secret");
  assert.equal(store.credential.activationCode, "NETWORK-AFTER-ACTIVATION");
});

test("temporary network failures preserve the secure credential and block entry", async () => {
  const store = createStore({
    deviceSession: "session-secret",
    deviceCredential: "credential-secret",
    bindingStatus: "active",
    licenseType: "yearly",
    durationDays: 365,
    activatedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2027-01-01T00:00:00Z",
  });
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    fetchImpl: async () => { throw new TypeError("network down"); },
  });

  const state = await service.refresh();
  assert.equal(state.phase, "network_error");
  assert.equal(state.authorized, false);
  assert.equal(state.message, "当前无法完成联网授权验证，请检查网络、VPN或防火墙；联网后将自动恢复授权验证");
  assert.equal(state.canUnbind, true);
  assert.equal(store.deleted, false);
  assert.equal(store.credential.deviceSession, "session-secret");
});

test("an online success seeds a signed grant and a later network failure keeps every feature authorized", async () => {
  const now = { value: new Date("2026-09-15T02:00:00Z").getTime() };
  const store = createStore({
    ...activePayload,
    expiresAt: "2026-09-19T00:00:00Z",
    deviceSession: "session-secret",
    deviceCredential: "credential-secret",
    activationCode: "saved-activation",
  });
  let online = true;
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    now: () => now.value,
    fetchImpl: async () => {
      if (!online) throw new TypeError("network down");
      return jsonResponse(200, { ...activePayload, expires_at: "2026-09-19T00:00:00Z" });
    },
  });

  assert.equal((await service.refresh()).phase, "active");
  assert.ok(store.offlineGrant);
  assert.doesNotMatch(JSON.stringify(store.offlineGrant), /session-secret|credential-secret|v2_machine/);
  online = false;
  const offline = await service.refresh();
  assert.equal(offline.phase, "offline_active");
  assert.equal(offline.authorized, true);
  assert.equal(offline.offlineRemainingDays, 4);
  assert.doesNotThrow(() => service.assertAuthorized());
});

test("offline banner becomes urgent at two days and does not jump again on the same natural day", async () => {
  const now = { value: new Date(2026, 8, 15, 8).getTime() };
  const store = createStore({
    ...activePayload,
    deviceSession: "session-secret",
    deviceCredential: "credential-secret",
    expiresAt: new Date(2026, 9, 15, 8).toISOString(),
  });
  let online = true;
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    now: () => now.value,
    fetchImpl: async () => online ? jsonResponse(200, {
      ...activePayload,
      expires_at: new Date(2026, 9, 15, 8).toISOString(),
    }) : Promise.reject(new TypeError("network down")),
  });

  await service.refresh();
  online = false;
  now.value = new Date(2026, 8, 20, 8).getTime();
  const urgent = await service.refresh();
  assert.equal(urgent.offlineRemainingDays, 2);
  assert.equal(urgent.message, "离线模式 · 请在 2 天内连接一次网络，否则将无法继续使用");

  now.value = new Date(2026, 8, 20, 23).getTime();
  const sameDay = await service.refresh();
  assert.equal(sameDay.offlineRemainingDays, 2);
  assert.equal(sameDay.message, urgent.message);
});

test("an expired grace cache blocks entry and is removed", async () => {
  const now = { value: new Date(2026, 8, 15, 8).getTime() };
  const store = createStore({
    ...activePayload,
    deviceSession: "session-secret",
    deviceCredential: "credential-secret",
    expiresAt: new Date(2026, 9, 15, 8).toISOString(),
  });
  let online = true;
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    now: () => now.value,
    fetchImpl: async () => online ? jsonResponse(200, {
      ...activePayload,
      expires_at: new Date(2026, 9, 15, 8).toISOString(),
    }) : Promise.reject(new TypeError("network down")),
  });

  await service.refresh();
  online = false;
  now.value += 7 * 24 * 60 * 60 * 1000;
  const state = await service.refresh();
  assert.equal(state.phase, "network_error");
  assert.equal(state.authorized, false);
  assert.equal(state.message, "当前无法完成联网授权验证，请检查网络、VPN 或防火墙。\n您的授权未失效，联网后将自动恢复使用。");
  assert.equal(store.offlineGrant, null);
});

test("an expired time license never receives the offline-grace reassurance", async () => {
  const now = { value: new Date(2026, 8, 15, 8).getTime() };
  const expiresAt = new Date(2026, 8, 17, 8).toISOString();
  const store = createStore({
    ...activePayload,
    deviceSession: "session-secret",
    deviceCredential: "credential-secret",
    expiresAt,
  });
  let online = true;
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    now: () => now.value,
    fetchImpl: async () => online ? jsonResponse(200, {
      ...activePayload,
      expires_at: expiresAt,
    }) : Promise.reject(new TypeError("network down")),
  });

  await service.refresh();
  online = false;
  now.value = new Date(2026, 8, 18, 8).getTime();
  const state = await service.refresh();
  assert.equal(state.phase, "network_error");
  assert.equal(state.authorized, false);
  assert.doesNotMatch(state.message, /您的授权未失效/);
  assert.equal(store.offlineGrant, null);
});

for (const denial of [
  { status: 401, body: { message: "invalid" }, expected: "invalid" },
  { status: 409, body: { message: "设备冲突" }, expected: "invalid" },
  { status: 200, body: { ...activePayload, binding_status: "disabled" }, expected: "disabled" },
  { status: 503, body: { ...activePayload, binding_status: "unbound" }, expected: "needs_activation" },
]) {
  test(`explicit server denial ${denial.status}/${denial.body.binding_status || "http"} bypasses offline grace`, async () => {
    const nowMs = new Date("2026-09-15T02:00:00Z").getTime();
    const store = createStore({
      ...activePayload,
      deviceSession: "session-secret",
      deviceCredential: "credential-secret",
      activationCode: "saved-activation",
    });
    let requestCount = 0;
    const service = new LicenseService({
      secureStore: store,
      machineCode: async () => "v2_machine",
      clientVersion: "1.0.0",
      now: () => nowMs,
      fetchImpl: async () => {
        requestCount += 1;
        return requestCount === 1 ? jsonResponse(200, activePayload) : jsonResponse(denial.status, denial.body);
      },
    });

    await service.refresh();
    assert.ok(store.offlineGrant);
    const state = await service.refresh();
    assert.equal(state.phase, denial.expected);
    assert.equal(state.authorized, false);
    assert.equal(store.offlineGrant, null);
  });
}

test("temporary HTTP 503 uses offline grace when it contains no explicit rejection", async () => {
  const nowMs = new Date("2026-09-15T02:00:00Z").getTime();
  const store = createStore({
    ...activePayload,
    deviceSession: "session-secret",
    deviceCredential: "credential-secret",
  });
  let requestCount = 0;
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    now: () => nowMs,
    fetchImpl: async () => {
      requestCount += 1;
      return requestCount === 1
        ? jsonResponse(200, activePayload)
        : jsonResponse(503, { message: "upstream unavailable" });
    },
  });

  await service.refresh();
  const state = await service.refresh();
  assert.equal(state.phase, "offline_active");
  assert.equal(state.authorized, true);
});

test("the hidden support reset clears only offline cache and immediately requires an online check", async () => {
  const nowMs = new Date("2026-09-15T02:00:00Z").getTime();
  const store = createStore({
    ...activePayload,
    deviceSession: "session-secret",
    deviceCredential: "credential-secret",
    activationCode: "saved-activation",
  });
  let online = true;
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    now: () => nowMs,
    fetchImpl: async () => online ? jsonResponse(200, activePayload) : Promise.reject(new TypeError("network down")),
  });

  await service.refresh();
  assert.ok(store.offlineGrant);
  online = false;
  const state = await service.resetOfflineCache();
  assert.equal(state.phase, "network_error");
  assert.equal(state.authorized, false);
  assert.equal(store.offlineGrant, null);
  assert.equal(store.credential.activationCode, "saved-activation");
  assert.equal(store.credential.deviceSession, "session-secret");
  assert.equal(store.credential.deviceCredential, "credential-secret");
});

test("generic HTTP 401 preserves the long-lived device credential", async () => {
  const store = createStore({ deviceSession: "old", deviceCredential: "old-credential", activationCode: "saved-activation" });
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    fetchImpl: async () => jsonResponse(401, { message: "server message" }),
  });

  const state = await service.refresh();
  assert.equal(state.phase, "invalid");
  assert.equal(state.message, "server message");
  assert.equal(store.deleted, false);
  assert.equal(store.clearDeviceCredentialCalls, 0);
  assert.equal(store.credential.deviceSession, "old");
  assert.equal(store.credential.deviceCredential, "old-credential");
  assert.deepEqual(store.machineIdentity, { version: 3, active_machine_code: "v2_local-machine-identity" });
  assert.equal(state.hasActivationCode, true);
  assert.equal(state.canUnbind, true);
});

test("an explicit credential revocation code clears only the device proof", async () => {
  const store = createStore({ deviceSession: "old", deviceCredential: "old-credential", activationCode: "saved-activation" });
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    fetchImpl: async () => jsonResponse(401, { error_code: "device_credential_revoked", message: "revoked" }),
  });

  const state = await service.refresh();
  assert.equal(state.phase, "invalid");
  assert.equal(store.clearDeviceCredentialCalls, 1);
  assert.deepEqual(store.credential, { activationCode: "saved-activation" });
  assert.equal(state.hasActivationCode, true);
  assert.equal(state.canUnbind, false);
});

test("a stale session followed by an explicit credential mismatch clears the rejected proof", async () => {
  const store = createStore({
    codeId: "code-1",
    deviceSession: "stale-session",
    deviceCredential: "rejected-proof",
    activationCode: "saved-activation",
    expiresAt: "2027-09-01T00:00:00Z",
  });
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.1.6",
    fetchImpl: async (url) => url.endsWith("/device/status")
      ? jsonResponse(401, { message: "设备会话已过期" })
      : jsonResponse(401, { error_code: "device_credential_mismatch", message: "设备凭证无效。" }),
  });

  const state = await service.refresh();
  assert.equal(state.phase, "invalid");
  assert.equal(store.clearDeviceCredentialCalls, 1);
  assert.deepEqual(store.credential, { codeId: "code-1", activationCode: "saved-activation", expiresAt: "2027-09-01T00:00:00Z" });
});

test("an expired time authorization refreshes the session but preserves the long-lived credential", async () => {
  const store = createStore({
    ...activePayload,
    codeId: "code-1",
    deviceSession: "expired-session",
    deviceCredential: "long-lived-proof",
    activationCode: "original-code",
    licenseType: "monthly",
    durationDays: 30,
    activatedAt: activePayload.activated_at,
    expiresAt: "2026-09-01T00:00:00Z",
  });
  const requests = [];
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.1.6",
    now: () => new Date("2026-09-21T00:00:00Z").getTime(),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/device/status")) return jsonResponse(401, { error_code: "license_expired", message: "授权已过期。" });
      return jsonResponse(200, {
        ...activePayload,
        code_id: "code-1",
        device_session: "fresh-session",
        expires_at: "2026-09-01T00:00:00Z",
        license_status: "expired",
        is_expired: true,
        message: "授权已到期，设备凭证已保留。",
      });
    },
  });

  const state = await service.refresh();
  assert.equal(state.phase, "expired");
  assert.equal(state.authorized, false);
  assert.deepEqual(requests.map(({ url }) => url.split("/api/license")[1]), ["/device/status", "/device/refresh"]);
  assert.equal(store.credential.deviceSession, "fresh-session");
  assert.equal(store.credential.deviceCredential, "long-lived-proof");
  assert.equal(store.credential.activationCode, "original-code");
  assert.equal(store.clearDeviceCredentialCalls, 0);
});

test("a stale short session is refreshed once and status validation resumes", async () => {
  const store = createStore({
    ...activePayload,
    codeId: "code-1",
    deviceSession: "stale-session",
    deviceCredential: "long-lived-proof",
    activationCode: "original-code",
    licenseType: "monthly",
    durationDays: 30,
    activatedAt: activePayload.activated_at,
    expiresAt: "2027-09-01T00:00:00Z",
  });
  let statusCalls = 0;
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.1.6",
    fetchImpl: async (url) => {
      if (url.endsWith("/device/refresh")) return jsonResponse(200, { ...activePayload, code_id: "code-1", device_session: "fresh-session", expires_at: "2027-09-01T00:00:00Z" });
      statusCalls += 1;
      return statusCalls === 1
        ? jsonResponse(401, { message: "设备会话已过期" })
        : jsonResponse(200, { ...activePayload, code_id: "code-1", expires_at: "2027-09-01T00:00:00Z" });
    },
  });

  const state = await service.refresh();
  assert.equal(state.phase, "active");
  assert.equal(statusCalls, 2);
  assert.equal(store.credential.deviceSession, "fresh-session");
  assert.equal(store.credential.deviceCredential, "long-lived-proof");
  assert.equal(store.clearDeviceCredentialCalls, 0);
});

test("using a new time card renews the existing binding without replacing its machine identity", async () => {
  const store = createStore({
    ...activePayload,
    codeId: "original-primary",
    deviceSession: "valid-session",
    deviceCredential: "long-lived-proof",
    activationCode: "original-code",
    boundMachineCode: "v2_machine",
    licenseType: "monthly",
    durationDays: 30,
    activatedAt: activePayload.activated_at,
    expiresAt: "2026-09-01T00:00:00Z",
  });
  let renewalBody;
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.1.6",
    fetchImpl: async (url, options) => {
      if (url.endsWith("/time/renew")) {
        renewalBody = JSON.parse(options.body);
        return jsonResponse(200, { ok: true, action: "time_renewed", duration_days: 365, expires_at: "2027-09-21T00:00:00Z", remaining_days: 365 });
      }
      return jsonResponse(200, { ...activePayload, code_id: "original-primary", expires_at: "2027-09-21T00:00:00Z", machine_code: "v2_machine" });
    },
  });

  const state = await service.renewTimeLicense("new-year-card");
  assert.equal(state.phase, "active");
  assert.equal(renewalBody.confirm_renewal, true);
  assert.equal(renewalBody.activation_code, "new-year-card");
  assert.match(renewalBody.request_id, /^[a-f0-9]{64}$/);
  assert.equal(renewalBody.machine_code, undefined);
  assert.equal(store.credential.codeId, "original-primary");
  assert.equal(store.credential.boundMachineCode, "v2_machine");
  assert.equal(store.credential.deviceCredential, "long-lived-proof");
  assert.equal(store.credential.activationCode, "original-code");
});

test("unbound server status clears the local credential without changing any activation code", async () => {
  const store = createStore({
    ...activePayload,
    deviceSession: "session-secret",
    deviceCredential: "credential-secret",
    bindingStatus: "active",
    licenseType: "monthly",
    durationDays: 30,
    activatedAt: activePayload.activated_at,
    expiresAt: activePayload.expires_at,
    activationCode: "saved-activation",
  });
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    fetchImpl: async () => jsonResponse(200, { ...activePayload, binding_status: "unbound" }),
  });

  const state = await service.refresh();
  assert.equal(state.phase, "needs_activation");
  assert.equal(state.message, "当前设备已解绑，请使用原激活码重新绑定。");
  assert.equal(store.deleted, false);
  assert.equal(store.clearDeviceCredentialCalls, 1);
  assert.equal(store.credential.activationCode, "saved-activation");
  assert.equal(store.credential.deviceSession, undefined);
  assert.deepEqual(store.machineIdentity, { version: 3, active_machine_code: "v2_local-machine-identity" });
  assert.equal(state.hasActivationCode, true);
  assert.equal(state.canUnbind, false);
});

test("HTTP 409 displays the server business message and preserves credentials", async () => {
  const store = createStore({ deviceSession: "session-secret", deviceCredential: "credential-secret" });
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    fetchImpl: async () => jsonResponse(409, { message: "该设备当前不可解绑" }),
  });

  const state = await service.refresh();
  assert.equal(state.message, "该设备当前不可解绑");
  assert.equal(store.deleted, false);
});

test("rejects points or unlimited licenses without storing their device tokens", async () => {
  const store = createStore();
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    fetchImpl: async () => jsonResponse(200, { ...activePayload, license_type: "unlimited_points" }),
  });

  const state = await service.activate("POINT-CODE");
  assert.equal(state.phase, "invalid");
  assert.equal(state.authorized, false);
  assert.equal(store.credential, null);
});

test("unbinds through the existing device endpoint and clears only device credentials", async () => {
  const store = createStore({
    deviceSession: "session-secret",
    deviceCredential: "credential-secret",
    activationCode: "saved-activation",
  });
  let captured;
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => "v2_machine",
    clientVersion: "1.0.0",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return jsonResponse(200, { ok: true, message: "解绑成功" });
    },
  });

  const state = await service.unbind();
  assert.equal(captured.url, "https://license.dadaozixun.com/api/license/device/unbind");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers.Authorization, "Bearer session-secret");
  assert.equal(captured.options.headers["X-Device-Credential"], "credential-secret");
  assert.deepEqual(JSON.parse(captured.options.body), {
    app_name: "ai-media-library",
    machine_code: "v2_machine",
    client_version: "1.0.0",
    license_protocol_version: 2,
  });
  assert.equal(state.phase, "needs_activation");
  assert.equal(state.message, "当前设备已解绑，请使用原激活码重新绑定。");
  assert.equal(store.deleted, false);
  assert.equal(store.clearDeviceCredentialCalls, 1);
  assert.deepEqual(store.credential, { activationCode: "saved-activation" });
  assert.deepEqual(store.machineIdentity, { version: 3, active_machine_code: "v2_local-machine-identity" });
  assert.equal(state.hasActivationCode, true);
  assert.equal(state.canUnbind, false);
});

test("activation and unbind always submit the same active machine code", async () => {
  const activeMachineCode = `v2_${"a".repeat(64)}`;
  const store = createStore();
  const bodies = [];
  let calls = 0;
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => activeMachineCode,
    clientVersion: "1.0.0",
    fetchImpl: async (url, options) => {
      calls += 1;
      if (options?.body) bodies.push({ url, body: JSON.parse(options.body) });
      if (calls === 1) return jsonResponse(200, { ...activePayload, action: "activated" });
      if (url.endsWith("/device/status")) return jsonResponse(200, activePayload);
      return jsonResponse(200, { ok: true });
    },
  });

  await service.activate("CODE");
  await service.unbind();
  assert.deepEqual(bodies.map((item) => item.body.machine_code), [activeMachineCode, activeMachineCode]);
});

test("server machine code mismatch is diagnostic only and never overwrites local identity", async () => {
  const localCode = `v2_${"b".repeat(64)}`;
  const remoteCode = `v2_${"c".repeat(64)}`;
  const store = createStore({
    deviceSession: "session-secret",
    deviceCredential: "credential-secret",
    activationCode: "saved-activation",
  });
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => localCode,
    clientVersion: "1.0.0",
    fetchImpl: async () => jsonResponse(200, { ...activePayload, machine_code: remoteCode }),
  });

  const state = await service.refresh();
  assert.equal(state.phase, "invalid");
  assert.equal(state.message, "设备绑定信息异常");
  assert.match(state.machineIdentityMessage, /软件未自动替换机器码/);
  assert.equal(store.clearDeviceCredentialCalls, 0);
  assert.equal(store.credential.deviceCredential, "credential-secret");
  assert.deepEqual(store.machineIdentity, { version: 3, active_machine_code: "v2_local-machine-identity" });
});

test("online VIP deadline is authoritative and an explicit null removes VIP without removing base", async () => {
  const store = createStore({
    codeId: "base-code", deviceSession: "session-secret", deviceCredential: "credential-secret",
    activationCode: "saved-activation", licenseType: "monthly", durationDays: 30,
    activatedAt: "2026-09-01T00:00:00Z", expiresAt: "2026-10-01T00:00:00Z",
  });
  const now = Date.parse("2026-09-22T00:00:00Z");
  let vipExpiresAt = "2026-10-01T00:00:00Z";
  let online = true;
  const service = new LicenseService({
    secureStore: store, machineCode: async () => "v2_machine", clientVersion: "1.2.3", now: () => now,
    fetchImpl: async (_url, options) => {
      if (!online) throw new TypeError("network down");
      assert.equal(options.headers["X-AI-Media-Client-Version"], "1.2.3");
      return jsonResponse(200, { ...activePayload, expires_at: "2026-10-01T00:00:00Z", entitlement_schema_version: 1,
        base_expires_at: "2026-10-01T00:00:00Z", vip_expires_at: vipExpiresAt });
    },
  });
  assert.equal((await service.refresh()).entitlements.vip, true);
  vipExpiresAt = null;
  const downgraded = await service.refresh();
  assert.equal(downgraded.entitlements.base, true);
  assert.equal(downgraded.entitlements.vip, false);
  assert.equal(store.credential.vipExpiresAt, null);
  online = false;
  const offline = await service.refresh();
  assert.equal(offline.phase, "offline_active");
  assert.equal(offline.entitlements.base, true);
  assert.equal(offline.entitlements.vip, false);
});

test("dual-deadline redemption is gated by server protocol and uses a stable retry key", async () => {
  const store = createStore({ codeId: "base-code", deviceSession: "session-secret", deviceCredential: "credential-secret",
    activationCode: "saved-activation", licenseType: "monthly", durationDays: 30,
    activatedAt: "2026-09-01T00:00:00Z", expiresAt: "2026-10-01T00:00:00Z" });
  const now = Date.parse("2026-09-22T00:00:00Z");
  const requests = [];
  const service = new LicenseService({
    secureStore: store, machineCode: async () => "v2_machine", clientVersion: "1.2.3", now: () => now,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/time/renew")) {
        requests.push(JSON.parse(options.body));
        return jsonResponse(200, { ok: true, action: "time_renewed", code_kind: "vip", duration_days: 30, idempotent: requests.length > 1 });
      }
      return jsonResponse(200, { ...activePayload, expires_at: "2026-10-22T00:00:00Z",
        entitlement_schema_version: 1, redemption_protocol_version: 1,
        base_expires_at: "2026-10-22T00:00:00Z", vip_expires_at: "2026-10-22T00:00:00Z" });
    },
  });
  await assert.rejects(service.redeemTimeCode("VIP-CODE"), /在线授权验证/);
  await service.refresh();
  const redeemed = await service.redeemTimeCode("VIP-CODE");
  assert.equal(redeemed.entitlements.vip, true);
  assert.deepEqual(redeemed.redemption, { codeKind: "vip", durationDays: 30, idempotent: false });
  const replayed = await service.redeemTimeCode("VIP-CODE");
  assert.deepEqual(replayed.redemption, { codeKind: "vip", durationDays: 30, idempotent: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].request_id, requests[1].request_id);
  assert.equal(requests[0].redemption_protocol_version, 1);
  assert.equal(requests[0].app_name, "ai-media-library");
});

test("an explicit server upgrade response blocks cached access without deleting the device proof", async () => {
  const store = createStore({ codeId: "base-code", deviceSession: "session-secret", deviceCredential: "credential-secret",
    licenseType: "monthly", durationDays: 30, activatedAt: "2026-09-01T00:00:00Z", expiresAt: "2026-10-01T00:00:00Z" });
  const service = new LicenseService({
    secureStore: store, machineCode: async () => "v2_machine", clientVersion: "1.2.3",
    now: () => Date.parse("2026-09-22T00:00:00Z"),
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers["X-AI-Media-Client-Version"], "1.2.3");
      return jsonResponse(426, { error_code: "client_upgrade_required", message: "请更新客户端" });
    },
  });
  const state = await service.refresh();
  assert.equal(state.phase, "update_required");
  assert.equal(state.authorized, false);
  assert.equal(store.credential.deviceCredential, "credential-secret");
  assert.equal(store.offlineGrant, null);
});

test("source preview bypasses customer activation and exposes all features", () => {
  const active = new LicenseService({
    secureStore: createStore(),
    machineCode: async () => "v2_preview",
    clientVersion: "test",
    previewAllFeatures: true,
  });
  active.state = {
    phase: "active",
    authorized: true,
    message: "",
    license: { expiresAt: "2099-01-01T00:00:00Z" },
  };
  assert.equal(active.publicState().entitlements.vip, true);
  assert.doesNotThrow(() => active.assertFeature("viral-visuals"));

  const inactive = new LicenseService({
    secureStore: createStore(),
    machineCode: async () => "v2_preview",
    clientVersion: "test",
    previewAllFeatures: true,
  });
  assert.equal(inactive.publicState().authorized, true);
  assert.equal(inactive.publicState().phase, "active");
  assert.equal(inactive.publicState().entitlements.base, true);
  assert.equal(inactive.publicState().entitlements.vip, true);
  assert.equal(inactive.publicState().license.entitlementSchemaVersion, 1);
  assert.equal(inactive.publicState().license.redemptionProtocolVersion, 1);
  assert.doesNotThrow(() => inactive.assertAuthorized());
  assert.doesNotThrow(() => inactive.assertFeature("viral-visuals"));
});
