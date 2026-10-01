import assert from "node:assert/strict";
import test from "node:test";
import { LicenseService } from "../electron/license-service.mjs";
import { MachineIdentityService } from "../electron/machine-identity/service.mjs";

// 4a 的验收核心：服务端此刻完全不认识 machine_identity_v3。
// 这组测试锁定"服务端零支持时客户端行为与今天完全一致"。

const MACHINE = `v2_${"a".repeat(64)}`;
const hash = (seed) => seed.repeat(32).slice(0, 32);

function createStore(initial = null) {
  return {
    credential: initial,
    offlineGrant: null,
    offlineHmacKey: Buffer.alloc(32, 0x29),
    async readCredential() { return this.credential; },
    async writeCredential(value) { this.credential = structuredClone(value); },
    async readOrCreateOfflineHmacKey() { return this.offlineHmacKey; },
    async readOfflineGrant() { return this.offlineGrant; },
    async writeOfflineGrant(value) { this.offlineGrant = structuredClone(value); },
    async clearOfflineGrant() { this.offlineGrant = null; },
    async deleteCredential() { this.credential = null; },
    async clearDeviceCredential() {
      if (this.credential) {
        const preserved = { ...this.credential };
        delete preserved.deviceSession;
        delete preserved.deviceCredential;
        this.credential = Object.keys(preserved).length ? preserved : null;
      }
      await this.clearOfflineGrant();
    },
    async readMachineIdentityFactors() { return this.factors ?? null; },
    async writeMachineIdentityFactors(envelope) { this.factors = structuredClone(envelope); },
    async clearMachineIdentityFactors() { this.factors = null; },
  };
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

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

function macResult() {
  return {
    version: 3,
    platform: "darwin",
    factor_hashes: {
      io_platform_uuid: hash("a"),
      io_platform_serial_number: hash("b"),
      hardware_model: hash("c"),
      physical_mac: hash("d"),
    },
    factor_status: {},
    candidate_machine_code: `v3_${"1".repeat(64)}`,
    collection: { duration_ms: 900, fallback_used: false, timed_out: false },
  };
}

async function readyIdentityService(store) {
  const service = new MachineIdentityService({
    appName: "ai-media-library",
    clientVersion: "1.1.6",
    secureStore: store,
    platform: "darwin",
    loadCollector: async () => async () => macResult(),
    schedule: (task) => task(),
  });
  await service.start();
  return service;
}

// -------------------------------------------------- 服务端零支持

test("服务端完全忽略 v3 字段时，激活照常成功", async () => {
  const store = createStore();
  const identity = await readyIdentityService(store);
  let sentBody = null;
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => MACHINE,
    clientVersion: "1.1.6",
    machineIdentity: identity,
    // 模拟当前线上服务端：只读已知字段，未知字段静默忽略
    fetchImpl: async (_url, options) => {
      if (options?.body) sentBody = JSON.parse(options.body);
      return json(200, { ...activePayload, machine_code: MACHINE });
    },
  });
  const state = await service.activate("CODE-1");
  assert.equal(state.authorized, true);
  assert.equal(state.phase, "active");
  // 字段确实发出去了
  assert.equal(sentBody.machine_identity_v3.version, 3);
  // 现有字段一个不少、一个不变
  assert.equal(sentBody.app_name, "ai-media-library");
  assert.equal(sentBody.machine_code, MACHINE);
  assert.equal(sentBody.license_protocol_version, 2);
});

test("响应里没有任何 v3 字段时不改变状态，也不污染绑定校验", async () => {
  const store = createStore();
  const identity = await readyIdentityService(store);
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => MACHINE,
    clientVersion: "1.1.6",
    machineIdentity: identity,
    fetchImpl: async () => json(200, { ...activePayload, machine_code: MACHINE }),
  });
  const state = await service.activate("CODE-1");
  assert.equal(state.authorized, true);
  assert.equal(identity.canonicalMachineCode, "");
  assert.equal(identity.phase, "off");
});

test("未注入身份服务时行为与改动前完全一致", async () => {
  let sentBody = null;
  const service = new LicenseService({
    secureStore: createStore(),
    machineCode: async () => MACHINE,
    clientVersion: "1.1.6",
    // machineIdentity 缺省
    fetchImpl: async (_url, options) => {
      if (options?.body) sentBody = JSON.parse(options.body);
      return json(200, { ...activePayload, machine_code: MACHINE });
    },
  });
  const state = await service.activate("CODE-1");
  assert.equal(state.authorized, true);
  assert.equal("machine_identity_v3" in sentBody, false, "无身份服务时不得出现该字段");
});

test("首次激活有界等待采集，超时后不发送不完整 v3 因子", async () => {
  const store = createStore();
  const identity = new MachineIdentityService({
    appName: "ai-media-library",
    clientVersion: "1.1.6",
    secureStore: store,
    platform: "darwin",
    loadCollector: async () => async () => new Promise(() => {}), // 永不完成
    schedule: (task) => task(),
  });
  identity.start();

  let sentBody = null;
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => MACHINE,
    clientVersion: "1.1.6",
    machineIdentity: identity,
    activationIdentityWaitMs: 20,
    fetchImpl: async (_url, options) => {
      if (options?.body) sentBody = JSON.parse(options.body);
      return json(200, { ...activePayload, machine_code: MACHINE });
    },
  });
  const state = await service.activate("CODE-1");
  assert.equal(state.authorized, true);
  assert.equal("machine_identity_v3" in sentBody, false);
});

test("身份服务抛异常不得影响授权", async () => {
  const hostile = {
    payloadForRequest() { throw new Error("identity exploded"); },
    acceptServerIdentity() { throw new Error("identity exploded"); },
    canonicalMachineCode: "",
  };
  const service = new LicenseService({
    secureStore: createStore(),
    machineCode: async () => MACHINE,
    clientVersion: "1.1.6",
    machineIdentity: hostile,
    fetchImpl: async () => json(200, { ...activePayload, machine_code: MACHINE }),
  });
  const state = await service.activate("CODE-1");
  assert.equal(state.authorized, true);
});

// -------------------------------------------------- 绑定校验仍然 fail-closed

test("未收到 canonical 时，机器码不一致仍然硬失败", async () => {
  const store = createStore();
  const identity = await readyIdentityService(store);
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => MACHINE,
    clientVersion: "1.1.6",
    machineIdentity: identity,
    fetchImpl: async () => json(200, { ...activePayload, machine_code: `v2_${"b".repeat(64)}` }),
  });
  const state = await service.activate("CODE-1");
  assert.equal(state.phase, "invalid");
  assert.equal(state.message, "设备绑定信息异常");
});

test("绑定异常路径不得记录 canonical，canonical 只能来自成功的交互", async () => {
  const store = createStore();
  const identity = await readyIdentityService(store);
  const other = `v2_${"b".repeat(64)}`;

  // 服务端给出不同的 v2 机器码，同时附带 canonical。
  // 本次尚未记录过 canonical，必须照旧判为绑定异常，且不得顺手记录。
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => MACHINE,
    clientVersion: "1.1.6",
    machineIdentity: identity,
    fetchImpl: async () => json(200, { ...activePayload, machine_code: other, canonical_machine_code: other }),
  });
  assert.equal((await service.activate("CODE-1")).phase, "invalid");
  assert.equal(identity.canonicalMachineCode, "", "绑定异常路径不得记录 canonical");
});

test("仅诊断记录的 canonical 不得充当设备绑定依据", async () => {
  const store = createStore();
  const identity = await readyIdentityService(store);
  const canonical = `v2_${"c".repeat(64)}`;
  // 模拟此前某次成功交互已记录 canonical
  identity.acceptServerIdentity({ canonical_machine_code: canonical });
  assert.equal(identity.canonicalMachineCode, canonical);

  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => MACHINE,
    clientVersion: "1.1.6",
    machineIdentity: identity,
    fetchImpl: async () => json(200, { ...activePayload, machine_code: canonical }),
  });
  const state = await service.activate("CODE-1");
  assert.equal(state.authorized, false, "未持久保存到设备凭证的 canonical 不能授权");
  assert.equal(state.phase, "invalid");
});

test("未明确签发的 v3 机器码必须触发绑定异常", async () => {
  const store = createStore();
  const identity = await readyIdentityService(store);
  const service = new LicenseService({
    secureStore: store,
    machineCode: async () => MACHINE,
    clientVersion: "1.1.6",
    machineIdentity: identity,
    fetchImpl: async () => json(200, { ...activePayload, machine_code: `v3_${"d".repeat(64)}` }),
  });
  const state = await service.activate("CODE-1");
  assert.equal(state.phase, "invalid");
  assert.equal(store.credential, null);
});

test("离线宽限授权不受身份采集影响", async () => {
  const store = createStore({
    codeId: "code-1",
    deviceSession: "session-secret",
    deviceCredential: "credential-secret",
    activationCode: "CODE-1",
    licenseType: "monthly",
    expiresAt: "2026-09-19T00:00:00Z",
  });
  const identity = await readyIdentityService(store);

  // 先在线成功一次以写出离线授权
  const online = new LicenseService({
    secureStore: store,
    machineCode: async () => MACHINE,
    clientVersion: "1.1.6",
    machineIdentity: identity,
    now: () => Date.parse("2026-09-01T00:00:00Z"),
    fetchImpl: async () => json(200, { ...activePayload, machine_code: MACHINE }),
  });
  await online.refresh();
  const grantAfterOnline = structuredClone(store.offlineGrant);
  assert.ok(grantAfterOnline, "应已写出离线授权");

  // 断网后离线宽限仍然可用：身份缓存与它无关
  const offline = new LicenseService({
    secureStore: store,
    machineCode: async () => MACHINE,
    clientVersion: "1.1.6",
    machineIdentity: identity,
    now: () => Date.parse("2026-09-02T00:00:00Z"),
    fetchImpl: async () => { throw new Error("network down"); },
  });
  const state = await offline.refresh();
  assert.equal(state.authorized, true, "离线宽限必须仍然放行");
  assert.equal(state.phase, "offline_active");
});
