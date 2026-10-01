import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createStableMachineCode,
  createStableMachineIdentity,
  publicMachineIdentity,
  assertMachineIdentityUsable,
} from "../electron/machine-code.mjs";

const APP_NAME = "ai-media-library";

function expectedCode(appName, source) {
  const digest = createHash("sha256")
    .update("license-machine-code-v2\0", "utf8")
    .update(appName, "utf8")
    .update("\0", "utf8")
    .update(source, "utf8")
    .digest("hex");
  return `v2_${digest}`;
}

function memoryStore(initial = {}, sharedState = null) {
  const state = sharedState || { ...initial, writes: 0, seedWrites: 0 };
  return {
    state,
    readMachineIdentity: async () => state.machineIdentity ?? null,
    writeMachineIdentity: async (value) => {
      state.machineIdentity = structuredClone(value);
      state.writes += 1;
    },
    readMachineCode: async () => state.machineCode ?? null,
    writeMachineCode: async (value) => { state.machineCode = value; },
    readMachineSeed: async () => state.machineSeed ?? null,
    writeMachineSeed: async (value) => {
      state.machineSeed = value;
      state.seedWrites += 1;
    },
    readCredential: async () => state.credential ?? null,
  };
}

test("旧版裸机器码升级后继续作为 active_machine_code", async () => {
  const rawId = " AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE ";
  const legacyCode = expectedCode(APP_NAME, rawId.trim());
  const store = memoryStore({ machineCode: legacyCode });
  const identity = await createStableMachineIdentity({
    appName: APP_NAME,
    secureStore: store,
    platform: "darwin",
    hardwareIdProvider: async () => rawId,
  });

  assert.equal(identity.version, 3);
  assert.equal(identity.active_machine_code, legacyCode);
  assert.equal(identity.legacy_machine_code, legacyCode);
  assert.equal(identity.candidate_machine_code, expectedCode(APP_NAME, rawId.trim().toLowerCase()));
  assert.equal(identity.compatibility_mode, true);
  assert.equal(identity.hardware_match, true);
  assert.equal(store.state.machineCode, legacyCode);
});

test("有历史授权时临时读取不到系统 ID 不生成或覆盖机器码", async () => {
  const legacyCode = expectedCode(APP_NAME, "legacy-hardware");
  const store = memoryStore({
    machineCode: legacyCode,
    credential: { activationCode: "saved-code", deviceCredential: "secret" },
  });
  const identity = await createStableMachineIdentity({
    appName: APP_NAME,
    secureStore: store,
    hardwareIdProvider: async () => { throw new Error("temporary failure"); },
  });

  assert.equal(identity.active_machine_code, legacyCode);
  assert.equal(identity.candidate_machine_code, "");
  assert.equal(store.state.seedWrites, 0);
});

test("已激活用户升级机器身份记录时授权凭证保持原样", async () => {
  const legacyCode = expectedCode(APP_NAME, "LEGACY-HARDWARE");
  const credential = {
    activationCode: "saved-activation",
    deviceSession: "saved-session",
    deviceCredential: "saved-credential",
  };
  const store = memoryStore({ machineCode: legacyCode, credential: structuredClone(credential) });
  const identity = await createStableMachineIdentity({
    appName: APP_NAME,
    secureStore: store,
    hardwareIdProvider: async () => "LEGACY-HARDWARE",
  });
  assert.equal(identity.active_machine_code, legacyCode);
  assert.deepEqual(store.state.credential, credential);
});

test("Windows UUID 输入大小写和空格变化不影响新算法", async () => {
  const upper = memoryStore();
  const lower = memoryStore();
  const first = await createStableMachineCode({
    appName: APP_NAME,
    secureStore: upper,
    platform: "win32",
    hardwareIdProvider: async () => "  1234ABCD-EF00  ",
  });
  const second = await createStableMachineCode({
    appName: APP_NAME,
    secureStore: lower,
    platform: "win32",
    hardwareIdProvider: async () => "1234abcd-ef00",
  });
  assert.equal(first, second);
});

test("macOS IOPlatformUUID 大小写和空格变化不影响新算法", async () => {
  const upper = memoryStore();
  const lower = memoryStore();
  const first = await createStableMachineCode({
    appName: APP_NAME,
    secureStore: upper,
    platform: "darwin",
    hardwareIdProvider: async () => "  ABCDEF12-3456-7890  ",
  });
  const second = await createStableMachineCode({
    appName: APP_NAME,
    secureStore: lower,
    platform: "darwin",
    hardwareIdProvider: async () => "abcdef12-3456-7890",
  });
  assert.equal(first, second);
});

test("同一启动并发读取只创建一份持久机器身份", async () => {
  const store = memoryStore();
  let reads = 0;
  const options = {
    appName: APP_NAME,
    secureStore: store,
    hardwareIdProvider: async () => { reads += 1; return "stable-hardware"; },
  };
  const identities = await Promise.all(Array.from({ length: 12 }, () => createStableMachineIdentity(options)));
  assert.equal(new Set(identities.map((item) => item.active_machine_code)).size, 1);
  assert.equal(reads, 1);
  assert.equal(store.state.seedWrites, 0);
  assert.equal(store.state.writes, 1);
});

test("全新安装没有系统 ID 时明确失败，不创建随机回退或写入任何身份", async () => {
  const store = memoryStore();
  await assert.rejects(createStableMachineIdentity({
    appName: APP_NAME, secureStore: store, hardwareIdProvider: async () => "",
  }), { code: "MACHINE_IDENTITY_UNAVAILABLE" });
  assert.equal(store.state.seedWrites, 0);
  assert.equal(store.state.writes, 0);
  assert.equal(store.state.machineCode, undefined);
});

test("只有凭证而无法恢复历史机器码时拒绝创建随机身份", async () => {
  const store = memoryStore({ credential: { activationCode: "historical-code" } });
  await assert.rejects(
    () => createStableMachineIdentity({ appName: APP_NAME, secureStore: store, hardwareIdProvider: async () => "" }),
    /无法恢复原机器码/,
  );
  assert.equal(store.state.seedWrites, 0);
});

test("系统 ID 恢复后只写候选码，不替换旧随机 active_machine_code", async () => {
  const firstStore = memoryStore({ machineSeed: "historical-random-seed" });
  const fallback = await createStableMachineIdentity({
    appName: APP_NAME,
    secureStore: firstStore,
    platform: "darwin",
    hardwareIdProvider: async () => "",
  });
  const restartedStore = memoryStore({}, firstStore.state);
  const recovered = await createStableMachineIdentity({
    appName: APP_NAME,
    secureStore: restartedStore,
    platform: "darwin",
    hardwareIdProvider: async () => "RECOVERED-HARDWARE",
  });
  assert.equal(recovered.active_machine_code, fallback.active_machine_code);
  assert.equal(recovered.source_type, "random_fallback");
  assert.equal(recovered.candidate_machine_code, expectedCode(APP_NAME, "recovered-hardware"));
});

test("外来旧缓存与当前硬件不匹配时只告警不覆盖", async () => {
  const foreignCode = expectedCode(APP_NAME, "foreign-hardware");
  const store = memoryStore({ machineCode: foreignCode });
  const identity = await createStableMachineIdentity({
    appName: APP_NAME,
    secureStore: store,
    platform: "win32",
    hardwareIdProvider: async () => "LOCAL-HARDWARE",
  });
  assert.equal(identity.active_machine_code, foreignCode);
  assert.equal(identity.machine_identity_mismatch, true);
  assert.equal(store.state.machineCode, foreignCode);
  assert.match(publicMachineIdentity(identity).message, /软件未自动替换机器码/);
});

test("重启进程后读取同一 v3 记录保持 active_machine_code", async () => {
  const firstStore = memoryStore();
  const first = await createStableMachineIdentity({
    appName: APP_NAME,
    secureStore: firstStore,
    hardwareIdProvider: async () => "stable-hardware",
  });
  const restartedStore = memoryStore({}, firstStore.state);
  const second = await createStableMachineIdentity({
    appName: APP_NAME,
    secureStore: restartedStore,
    hardwareIdProvider: async () => "stable-hardware",
  });
  assert.equal(second.active_machine_code, first.active_machine_code);
});

test("清理普通缓存和旧 v2 缓存不会删除或改变 v3 机器身份", async () => {
  const firstStore = memoryStore();
  const first = await createStableMachineIdentity({
    appName: APP_NAME,
    secureStore: firstStore,
    hardwareIdProvider: async () => "stable-hardware",
  });
  delete firstStore.state.machineCode;
  delete firstStore.state.machineSeed;
  const restartedStore = memoryStore({}, firstStore.state);
  const second = await createStableMachineIdentity({
    appName: APP_NAME,
    secureStore: restartedStore,
    hardwareIdProvider: async () => "stable-hardware",
  });
  assert.equal(second.active_machine_code, first.active_machine_code);
});

test("不同 app_name 不会生成相同应用机器码", async () => {
  const first = await createStableMachineCode({
    appName: APP_NAME,
    secureStore: memoryStore(),
    hardwareIdProvider: async () => "same-hardware",
  });
  const second = await createStableMachineCode({
    appName: "another-app",
    secureStore: memoryStore(),
    hardwareIdProvider: async () => "same-hardware",
  });
  assert.notEqual(first, second);
});

test("原始硬件 ID 不进入持久化机器身份记录", async () => {
  const rawId = "PRIVATE-HARDWARE-SERIAL-123";
  const store = memoryStore();
  const capturedLogs = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...values) => capturedLogs.push(values.join(" "));
  console.log = (...values) => capturedLogs.push(values.join(" "));
  try {
    await createStableMachineIdentity({
      appName: APP_NAME,
      secureStore: store,
      hardwareIdProvider: async () => rawId,
    });
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  assert.equal(JSON.stringify(store.state).includes(rawId), false);
  assert.equal(JSON.stringify(store.state).includes(rawId.toLowerCase()), false);
  assert.equal(capturedLogs.join("\n").includes(rawId), false);
});

test("新身份无法持久化时不对外返回机器码，也不降级为随机值", async () => {
  const store = memoryStore();
  store.writeMachineIdentity = async () => { throw new Error("identity cache unavailable"); };
  store.writeMachineCode = async () => { throw new Error("legacy cache unavailable"); };
  await assert.rejects(createStableMachineCode({
    appName: APP_NAME, secureStore: store, hardwareIdProvider: async () => "stable-hardware",
  }), /identity cache unavailable/);
  assert.equal(store.state.seedWrites, 0);
});

test("首次身份写入失败时返回错误", async () => {
  const store = memoryStore();
  store.writeMachineIdentity = async () => { throw new Error("identity unavailable"); };
  await assert.rejects(
    () => createStableMachineCode({ appName: APP_NAME, secureStore: store, hardwareIdProvider: async () => "stable-hardware" }),
    /identity unavailable/,
  );
});

test("安全存储解密失败时不把机器身份当作缺失且不写入替代身份", async () => {
  const secureError = Object.assign(new Error("provider details must stay hidden"), {
    code: "SECURE_STORAGE_DECRYPT_FAILED",
  });
  let identityWrites = 0;
  let machineCodeWrites = 0;
  let seedWrites = 0;
  const store = {
    readMachineIdentity: async () => { throw secureError; },
    readMachineCode: async () => null,
    readMachineSeed: async () => null,
    readCredential: async () => null,
    writeMachineIdentity: async () => { identityWrites += 1; },
    writeMachineCode: async () => { machineCodeWrites += 1; },
    writeMachineSeed: async () => { seedWrites += 1; },
  };

  await assert.rejects(
    () => createStableMachineIdentity({
      appName: APP_NAME,
      secureStore: store,
      platform: "win32",
      hardwareIdProvider: async () => "CURRENT-HARDWARE",
    }),
    (error) => error === secureError,
  );
  assert.deepEqual({ identityWrites, machineCodeWrites, seedWrites }, {
    identityWrites: 0,
    machineCodeWrites: 0,
    seedWrites: 0,
  });
});

test("安全存储中的机器身份格式异常时不生成替代身份", async () => {
  const secureError = Object.assign(new Error("corrupt encrypted identity"), {
    code: "SECURE_STORAGE_DATA_INVALID",
  });
  let writes = 0;
  const store = {
    readMachineIdentity: async () => { throw secureError; },
    readMachineCode: async () => null,
    readMachineSeed: async () => null,
    readCredential: async () => null,
    writeMachineIdentity: async () => { writes += 1; },
    writeMachineCode: async () => { writes += 1; },
    writeMachineSeed: async () => { writes += 1; },
  };

  await assert.rejects(
    () => createStableMachineIdentity({
      appName: APP_NAME,
      secureStore: store,
      platform: "win32",
      hardwareIdProvider: async () => "CURRENT-HARDWARE",
    }),
    (error) => error === secureError,
  );
  assert.equal(writes, 0);
});

const UUID_A = "a1234567-89ab-cdef-0123-456789abcdef";
const UUID_B = "b1234567-89ab-cdef-0123-456789abcdef";
const uuidHardware = (uuid) => ({ rawId: uuid, normalizedId: uuid.toLowerCase(), sourceType: "windows_system_uuid" });
const guidHardware = (guid) => ({ rawId: guid, normalizedId: guid.toLowerCase(), sourceType: "windows_machine_guid" });

test("克隆系统 MachineGuid 相同但 UUID 不同，新安装机器码不同且不读取 Guid", async () => {
  let guidReads = 0;
  const readGuid = async () => { guidReads += 1; return guidHardware("CLONED-GUID"); };
  const read = (uuid) => createStableMachineIdentity({
    appName: APP_NAME, platform: "win32", secureStore: memoryStore(),
    hardwareIdProvider: async () => uuidHardware(uuid), legacyHardwareIdProvider: readGuid,
  });
  const a = await read(UUID_A);
  const b = await read(UUID_B);
  assert.notEqual(a.active_machine_code, b.active_machine_code);
  assert.equal(a.source_type, "windows_system_uuid");
  assert.equal(a.identity_scheme, "system_uuid_v1");
  assert.equal(guidReads, 0);
});

test("新安装 UUID 失败不会转读已克隆的 MachineGuid", async () => {
  let guidReads = 0;
  const store = memoryStore();
  await assert.rejects(createStableMachineIdentity({
    appName: APP_NAME, platform: "win32", secureStore: store,
    hardwareIdProvider: async () => "",
    legacyHardwareIdProvider: async () => { guidReads += 1; return guidHardware("CLONED-GUID"); },
  }), { code: "MACHINE_IDENTITY_UNAVAILABLE" });
  assert.equal(guidReads, 0);
  assert.equal(store.state.writes, 0);
});

test("读取失败后同一进程可重试成功，不缓存失败 Promise", async () => {
  const store = memoryStore();
  let available = false;
  const options = { appName: APP_NAME, secureStore: store, platform: "win32",
    hardwareIdProvider: async () => available ? uuidHardware(UUID_A) : "" };
  await assert.rejects(createStableMachineIdentity(options));
  available = true;
  assert.equal((await createStableMachineIdentity(options)).hardware_match, true);
});

test("新 UUID 身份连续 50 次启动读取失败仍保留原码和凭证", async () => {
  const firstStore = memoryStore();
  const initial = await createStableMachineIdentity({
    appName: APP_NAME, platform: "win32", secureStore: firstStore, hardwareIdProvider: async () => uuidHardware(UUID_A),
  });
  firstStore.state.credential = { deviceSession: "session", deviceCredential: "credential", boundMachineCode: initial.active_machine_code };
  const credential = structuredClone(firstStore.state.credential);
  for (let i = 0; i < 50; i += 1) {
    const restarted = memoryStore({}, firstStore.state);
    const identity = await createStableMachineIdentity({
      appName: APP_NAME, platform: "win32", secureStore: restarted,
      hardwareIdProvider: async () => { throw new Error("timeout"); },
    });
    assert.equal(identity.active_machine_code, initial.active_machine_code);
    assert.equal(identity.hardware_match, null);
    assert.equal(identity.machine_identity_mismatch, false);
    assert.doesNotThrow(() => assertMachineIdentityUsable(identity));
    assert.deepEqual(restarted.state.credential, credential);
  }
});

test("复制新身份缓存到另一台电脑后标记冲突并拒绝使用，绝不覆盖原码", async () => {
  const store = memoryStore();
  const first = await createStableMachineIdentity({ appName: APP_NAME, platform: "win32", secureStore: store,
    hardwareIdProvider: async () => uuidHardware(UUID_A) });
  const foreign = await createStableMachineIdentity({ appName: APP_NAME, platform: "win32", secureStore: memoryStore({}, store.state),
    hardwareIdProvider: async () => uuidHardware(UUID_B) });
  assert.equal(foreign.active_machine_code, first.active_machine_code);
  assert.equal(foreign.hardware_digest, first.hardware_digest);
  assert.notEqual(foreign.candidate_machine_code, first.active_machine_code);
  assert.throws(() => assertMachineIdentityUsable(foreign), { code: "MACHINE_IDENTITY_MISMATCH" });
  // Returning to the original hardware clears the conflict; a read failure cannot.
  const unreadable = await createStableMachineIdentity({ appName: APP_NAME, platform: "win32", secureStore: memoryStore({}, store.state), hardwareIdProvider: async () => "" });
  assert.throws(() => assertMachineIdentityUsable(unreadable));
  const original = await createStableMachineIdentity({ appName: APP_NAME, platform: "win32", secureStore: memoryStore({}, store.state), hardwareIdProvider: async () => uuidHardware(UUID_A) });
  assert.doesNotThrow(() => assertMachineIdentityUsable(original));
});

test("旧 Windows 身份升级仍对比 MachineGuid，不把 UUID 变化当作硬件冲突", async () => {
  const guid = "OLD-GUID";
  const code = expectedCode(APP_NAME, guid.toLowerCase());
  const digest = createHash("sha256").update("license-hardware-digest-v1\0" + APP_NAME + "\0" + guid.toLowerCase()).digest("hex");
  const stored = { version: 3, source_type: "windows_machine_guid", active_machine_code: code, hardware_digest: digest,
    compatibility_mode: false, machine_identity_mismatch: false, hardware_match: true };
  const credential = { deviceSession: "session", deviceCredential: "credential", boundMachineCode: code };
  const store = memoryStore({ machineIdentity: stored, machineCode: code, credential });
  let uuidReads = 0;
  const identity = await createStableMachineIdentity({ appName: APP_NAME, platform: "win32", secureStore: store,
    hardwareIdProvider: async () => { uuidReads += 1; return uuidHardware(UUID_B); },
    legacyHardwareIdProvider: async () => guidHardware(guid) });
  assert.equal(identity.active_machine_code, code);
  assert.equal(identity.hardware_match, true);
  assert.equal(uuidReads, 0);
  assert.deepEqual(store.state.credential, credential);
});

test("旧裸缓存支持历史原始大小写及标准化码，升级不会误报冲突", async () => {
  for (const value of ["OLD-GUID", "old-guid"]) {
    const code = expectedCode(APP_NAME, value);
    const identity = await createStableMachineIdentity({ appName: APP_NAME, platform: "win32", secureStore: memoryStore({ machineCode: code }),
      legacyHardwareIdProvider: async () => guidHardware("OLD-GUID") });
    assert.equal(identity.active_machine_code, code);
    assert.equal(identity.hardware_match, true);
  }
});

test("机器码缓存缺失但凭证保存了 v2 绑定码时准确恢复，不用当前 UUID 替换", async () => {
  const code = expectedCode(APP_NAME, "previous-source");
  const credential = { deviceSession: "session", deviceCredential: "secret", boundMachineCode: code };
  const store = memoryStore({ credential });
  const identity = await createStableMachineIdentity({ appName: APP_NAME, platform: "win32", secureStore: store,
    hardwareIdProvider: async () => uuidHardware(UUID_B), legacyHardwareIdProvider: async () => "" });
  assert.equal(identity.active_machine_code, code);
  assert.deepEqual(store.state.credential, credential);
});

test("仅有 v3 绑定凭证且本地 v2 身份丢失时保留凭证，不猜测历史码", async () => {
  const credential = { deviceCredential: "secret", boundMachineCode: `v3_${"a".repeat(64)}` };
  const store = memoryStore({ credential });
  await assert.rejects(createStableMachineIdentity({ appName: APP_NAME, secureStore: store, hardwareIdProvider: async () => UUID_A }),
    { code: "MACHINE_IDENTITY_RECOVERY_REQUIRED" });
  assert.deepEqual(store.state.credential, credential);
  assert.equal(store.state.writes, 0);
});

test("历史随机身份在硬件或缓存更新失败时继续可用，不要求重新激活", async () => {
  const code = expectedCode(APP_NAME, "old-seed");
  const store = memoryStore({ machineIdentity: { version: 3, source_type: "random_fallback", active_machine_code: code } });
  store.writeMachineIdentity = async () => { throw new Error("disk unavailable"); };
  store.writeMachineCode = async () => { throw new Error("disk unavailable"); };
  const identity = await createStableMachineIdentity({ appName: APP_NAME, secureStore: store, hardwareIdProvider: async () => "" });
  assert.equal(identity.active_machine_code, code);
  assert.doesNotThrow(() => assertMachineIdentityUsable(identity));
});

test("外来旧缓存不能把当前电脑摘要登记为其硬件基线", async () => {
  const code = expectedCode(APP_NAME, "foreign-hardware");
  const store = memoryStore({ machineCode: code });
  const identity = await createStableMachineIdentity({ appName: APP_NAME, secureStore: store, hardwareIdProvider: async () => UUID_A });
  assert.equal(identity.machine_identity_mismatch, true);
  assert.equal(identity.hardware_digest, "");
});

test("首次完整身份写入失败时不留下会被误认成旧版的裸缓存", async () => {
  const store = memoryStore();
  store.writeMachineIdentity = async () => { throw new Error("disk full"); };
  await assert.rejects(createStableMachineIdentity({ appName: APP_NAME, secureStore: store,
    platform: "win32", hardwareIdProvider: async () => uuidHardware(UUID_A) }), /disk full/);
  assert.equal(store.state.machineCode, undefined);
  assert.equal(store.state.machineIdentity, undefined);
});

test("旧版裸缓存写入中断仍留下完整新身份，重启后不丢冲突检查", async () => {
  const store = memoryStore();
  store.writeMachineCode = async () => { throw new Error("disk full"); };
  await assert.rejects(createStableMachineIdentity({ appName: APP_NAME, secureStore: store,
    platform: "win32", hardwareIdProvider: async () => uuidHardware(UUID_A) }), /disk full/);
  assert.equal(store.state.machineIdentity.identity_scheme, "system_uuid_v1");
  const restarted = memoryStore({}, store.state);
  const identity = await createStableMachineIdentity({ appName: APP_NAME, secureStore: restarted,
    platform: "win32", hardwareIdProvider: async () => uuidHardware(UUID_B) });
  assert.throws(() => assertMachineIdentityUsable(identity), { code: "MACHINE_IDENTITY_MISMATCH" });
});

test("格式异常的旧缓存不能被当成新安装而覆盖", async () => {
  for (const initial of [{ machineCode: "damaged-code" }, { machineIdentity: { version: 3, active_machine_code: "broken" } }]) {
    const store = memoryStore(initial);
    await assert.rejects(createStableMachineIdentity({ appName: APP_NAME, secureStore: store,
      platform: "win32", hardwareIdProvider: async () => uuidHardware(UUID_A) }), { code: "MACHINE_IDENTITY_RECOVERY_REQUIRED" });
    assert.equal(store.state.writes, 0);
    for (const [key, value] of Object.entries(initial)) assert.deepEqual(store.state[key], value);
  }
});
