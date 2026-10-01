import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  buildIdentityPayload,
  countStrongFactors,
  createIdentityCacheEnvelope,
  presentableAssessment,
  publicIdentityDiagnostics,
  readIdentityCacheEnvelope,
  IDENTITY_CACHE_MAX_AGE_MS,
} from "../electron/machine-identity/index.mjs";
import { MachineIdentityService } from "../electron/machine-identity/service.mjs";

const APP = "ai-media-library";
const hash = (seed) => seed.repeat(32).slice(0, 32);

function winResult(overrides = {}) {
  return {
    version: 3,
    platform: "win32",
    factor_hashes: {
      machine_guid: hash("a"),
      bios_uuid: hash("b"),
      baseboard_serial: hash("c"),
      system_disk_serial: hash("d"),
      cpu_processor_id: hash("e"),
      physical_mac: hash("f"),
      ...overrides.factor_hashes,
    },
    factor_status: overrides.factor_status || {},
    candidate_machine_code: `v3_${"1".repeat(64)}`,
    collection: { duration_ms: 1200, fallback_used: false, timed_out: false, ...overrides.collection },
  };
}

function memoryStore() {
  const files = new Map();
  const key = randomBytes(32);
  return {
    files,
    async readOrCreateOfflineHmacKey() { return key; },
    async readMachineIdentityFactors() { return files.get("factors") ?? null; },
    async writeMachineIdentityFactors(envelope) { files.set("factors", JSON.parse(JSON.stringify(envelope))); },
    async clearMachineIdentityFactors() { files.delete("factors"); },
  };
}

// ---------------------------------------------------------------- payload

test("上报载荷绝不包含客户端权重，也不包含原始硬件值", () => {
  const payload = buildIdentityPayload(winResult({
    factor_status: { machine_guid: { collected: true, source: "registry", weight: 3 } },
  }));
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /"weight"/);
  assert.doesNotMatch(serialized, /factor_status/);
  // 权重由服务端决定，客户端一个数字都不送
  for (const entry of Object.values(payload.factors)) {
    assert.deepEqual(Object.keys(entry).sort(), ["hash"]);
  }
});

test("未采到的因子上报为 null 并带原因，不静默省略", () => {
  const payload = buildIdentityPayload(winResult({
    factor_hashes: { system_disk_serial: "" },
    factor_status: { system_disk_serial: { source: "unavailable" } },
  }));
  assert.equal(payload.factors.system_disk_serial.hash, null);
  assert.equal(payload.factors.system_disk_serial.reason, "unavailable");
  // 仍列出全部平台因子，服务端才能算出正确分母
  assert.equal(Object.keys(payload.factors).length, 6);
});

test("强因子不足 2 个时标 low_confidence，但仍然上报", () => {
  const payload = buildIdentityPayload(winResult({
    factor_hashes: { bios_uuid: "", system_disk_serial: "" },
  }));
  assert.equal(payload.low_confidence, true);
  assert.equal(countStrongFactors(winResult({ factor_hashes: { bios_uuid: "", system_disk_serial: "" } })), 1);
});

test("零强因子或超时则整个字段省略，绝不上报", () => {
  assert.equal(buildIdentityPayload(winResult({
    factor_hashes: { machine_guid: "", bios_uuid: "", system_disk_serial: "" },
  })), null);
  assert.equal(buildIdentityPayload(winResult({ collection: { timed_out: true } })), null);
});

// ---------------------------------------------------------------- 诊断展示

test("enforce 阶段只给粗粒度状态，不泄露任何数值", () => {
  const assessment = {
    state: "same_device",
    scoreNumerator: 11,
    scoreDenominator: 13,
    threshold: 0.75,
    matchedFactors: ["machine_guid", "bios_uuid"],
  };
  const enforced = presentableAssessment("enforce", assessment);
  assert.deepEqual(enforced, { state: "same_device", detailed: false });
  const serialized = JSON.stringify(enforced);
  for (const leak of ["11", "13", "0.75", "machine_guid"]) {
    assert.doesNotMatch(serialized, new RegExp(leak));
  }
});

test("observe 与 migrate 阶段给出详细分数，便于排查", () => {
  const assessment = { state: "same_device", scoreNumerator: 11, scoreDenominator: 13, threshold: 0.75 };
  for (const phase of ["observe", "migrate"]) {
    const shown = presentableAssessment(phase, assessment);
    assert.equal(shown.detailed, true);
    assert.equal(shown.scoreNumerator, 11);
    assert.equal(shown.scoreDenominator, 13);
  }
});

test("诊断面板只给哈希前 6 位，不给完整哈希", () => {
  const view = publicIdentityDiagnostics({ result: winResult(), phase: "observe" });
  const full = hash("a");
  assert.equal(view.factors.find((f) => f.name === "machine_guid").hashPrefix, full.slice(0, 6));
  assert.doesNotMatch(JSON.stringify(view), new RegExp(full));
  assert.equal(view.factors.find((f) => f.name === "machine_guid").strong, true);
  assert.equal(view.factors.find((f) => f.name === "physical_mac").strong, false);
});

// ---------------------------------------------------------------- 缓存

test("身份缓存签名被篡改时拒绝，且与离线授权互不干扰", () => {
  const key = randomBytes(32);
  const envelope = createIdentityCacheEnvelope({ key, appName: APP, result: winResult(), clientVersion: "1.1.6", nowMs: 1000 });
  const ok = readIdentityCacheEnvelope({ envelope, key, appName: APP, clientVersion: "1.1.6", nowMs: 2000 });
  assert.equal(ok.ok, true);

  const tampered = { ...envelope, payload: { ...envelope.payload, appName: "other-app" } };
  assert.equal(readIdentityCacheEnvelope({ envelope: tampered, key, appName: APP, clientVersion: "1.1.6", nowMs: 2000 }).ok, false);

  // 换一把密钥即无法验证，确认签名确实绑定密钥
  assert.equal(readIdentityCacheEnvelope({ envelope, key: randomBytes(32), appName: APP, clientVersion: "1.1.6", nowMs: 2000 }).ok, false);
});

test("缓存过期、客户端版本变化、时钟回拨都会触发重新采集", () => {
  const key = randomBytes(32);
  const envelope = createIdentityCacheEnvelope({ key, appName: APP, result: winResult(), clientVersion: "1.1.6", nowMs: 10_000_000 });
  const base = { envelope, key, appName: APP, clientVersion: "1.1.6" };
  assert.equal(readIdentityCacheEnvelope({ ...base, nowMs: 10_000_000 + IDENTITY_CACHE_MAX_AGE_MS + 1 }).reason, "expired");
  assert.equal(readIdentityCacheEnvelope({ ...base, clientVersion: "1.1.7", nowMs: 10_000_001 }).reason, "stale_version");
  assert.equal(readIdentityCacheEnvelope({ ...base, nowMs: 1000 }).reason, "clock_rollback");
});

// ---------------------------------------------------------------- 服务

test("采集完成前 payloadForRequest 返回 null，绝不等待", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = new MachineIdentityService({
    appName: APP, clientVersion: "1.1.6", secureStore: memoryStore(), platform: "win32",
    loadCollector: async () => async () => { await gate; return winResult(); },
    schedule: (task) => task(),
  });
  const started = service.start();
  assert.equal(service.payloadForRequest(), null, "采集未完成时必须立即返回 null");
  release();
  await started;
  assert.ok(service.payloadForRequest());
});

test("采集抛异常不影响服务可用，载荷降级为 null", async () => {
  const service = new MachineIdentityService({
    appName: APP, clientVersion: "1.1.6", secureStore: memoryStore(), platform: "win32",
    loadCollector: async () => async () => { throw new Error("wmic exploded"); },
    schedule: (task) => task(),
  });
  await service.start();
  assert.equal(service.state, "failed");
  assert.equal(service.payloadForRequest(), null);
  assert.equal(service.diagnostics().state, "failed");
});

test("不支持的平台安静降级，不抛错", async () => {
  const service = new MachineIdentityService({
    appName: APP, clientVersion: "1.1.6", secureStore: memoryStore(), platform: "linux",
    loadCollector: async () => null,
    schedule: (task) => task(),
  });
  await service.start();
  assert.equal(service.state, "unsupported");
  assert.equal(service.payloadForRequest(), null);
});

test("第二次启动读缓存，不再调用采集器", async () => {
  const store = memoryStore();
  let collectCount = 0;
  const make = () => new MachineIdentityService({
    appName: APP, clientVersion: "1.1.6", secureStore: store, platform: "win32",
    loadCollector: async () => async () => { collectCount += 1; return winResult(); },
    schedule: (task) => task(),
  });
  await make().start();
  assert.equal(collectCount, 1);
  const second = make();
  await second.start();
  assert.equal(collectCount, 1, "缓存命中时不应重复采集");
  assert.equal(second.lastReason, "cache");
});

test("克隆镜像复制的旧因子缓存不能用于首次激活，必须重新采集", async () => {
  const store = memoryStore();
  const source = new MachineIdentityService({
    appName: APP, clientVersion: "1.1.6", secureStore: store, platform: "win32",
    loadCollector: async () => async () => winResult(), schedule: (task) => task(),
  });
  await source.start();
  let freshCalls = 0;
  const cloned = new MachineIdentityService({
    appName: APP, clientVersion: "1.1.6", secureStore: store, platform: "win32",
    loadCollector: async () => async () => {
      freshCalls += 1;
      return winResult({ factor_hashes: { bios_uuid: hash("2"), system_disk_serial: hash("4") } });
    },
    schedule: (task) => task(),
  });
  await cloned.start();
  assert.equal(cloned.lastReason, "cache");
  assert.equal(cloned.payloadForRequest().factors.bios_uuid.hash, hash("b"));
  await cloned.collectFreshForActivation();
  assert.equal(freshCalls, 1);
  assert.equal(cloned.lastReason, "collected");
  assert.equal(cloned.payloadForRequest().factors.bios_uuid.hash, hash("2"));
  assert.equal(cloned.payloadForRequest().factors.system_disk_serial.hash, hash("4"));
});

test("重新采集超时期间绝不回退发送克隆镜像里的旧缓存", async () => {
  const store = memoryStore();
  const source = new MachineIdentityService({
    appName: APP, clientVersion: "1.1.6", secureStore: store, platform: "win32",
    loadCollector: async () => async () => winResult(), schedule: (task) => task(),
  });
  await source.start();
  const cloned = new MachineIdentityService({
    appName: APP, clientVersion: "1.1.6", secureStore: store, platform: "win32",
    loadCollector: async () => async () => new Promise(() => {}), schedule: (task) => task(),
  });
  await cloned.start();
  assert.ok(cloned.payloadForRequest());
  void cloned.collectFreshForActivation();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cloned.payloadForRequest(), null);
});

test("缓存被篡改时只丢身份缓存并重采，不波及其他存储", async () => {
  const store = memoryStore();
  let collectCount = 0;
  const make = () => new MachineIdentityService({
    appName: APP, clientVersion: "1.1.6", secureStore: store, platform: "win32",
    loadCollector: async () => async () => { collectCount += 1; return winResult(); },
    schedule: (task) => task(),
  });
  await make().start();
  const envelope = store.files.get("factors");
  envelope.signature = "00".repeat(32);
  store.files.set("factors", envelope);

  await make().start();
  assert.equal(collectCount, 2, "签名失效应触发重新采集");
  assert.equal(store.files.has("factors"), true);
});

test("服务端不返回任何 v3 字段时，acceptServerIdentity 不产生副作用", () => {
  const service = new MachineIdentityService({ appName: APP, clientVersion: "1.1.6", secureStore: memoryStore() });
  service.acceptServerIdentity({ ok: true, machine_code: `v2_${"a".repeat(64)}` });
  assert.equal(service.canonicalMachineCode, "");
  assert.equal(service.phase, "off");
  assert.equal(service.assessment, null);
  service.acceptServerIdentity(null);
  service.acceptServerIdentity("not an object");
  assert.equal(service.canonicalMachineCode, "");
});

test("格式非法的 canonical 码一律拒绝", () => {
  const service = new MachineIdentityService({ appName: APP, clientVersion: "1.1.6", secureStore: memoryStore() });
  for (const bad of ["", "v4_abc", "v2_zzz", `v2_${"a".repeat(63)}`, 12345, {}]) {
    service.acceptServerIdentity({ canonical_machine_code: bad });
    assert.equal(service.canonicalMachineCode, "");
  }
  const good = `v3_${"b".repeat(64)}`;
  service.acceptServerIdentity({ canonical_machine_code: good });
  assert.equal(service.canonicalMachineCode, good);
});
