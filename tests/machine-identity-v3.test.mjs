import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  deriveV3MachineCode,
  hashFactor,
  hashFactorMap,
} from "../electron/machine-identity/hash.mjs";
import {
  inspectFactorValue,
  normalizeFactorValue,
} from "../electron/machine-identity/normalize.mjs";
import {
  collectWindowsFactorHashes,
  startWindowsFactorCollection,
  WINDOWS_COLLECTION_TIMEOUTS,
} from "../electron/machine-identity/collectors/windows.mjs";
import {
  collectMacosFactorHashes,
  startMacosFactorCollection,
  MACOS_COLLECTION_TIMEOUTS,
} from "../electron/machine-identity/collectors/macos.mjs";

const APP_NAME = "ai-media-library";

function windowsCimPayload(overrides = {}) {
  return JSON.stringify({
    cim_available: true,
    machine_guid: "A1B2C3D4-E5F6-7788-99AA-BBCCDDEEFF00",
    bios_uuid: "11112222-3333-4444-5555-666677778888",
    baseboard_serial: "BOARD-SERIAL-908172",
    system_disk_serial: "DISK-SERIAL-123456",
    cpu_processor_id: ["CPU-ABCDEF-123456"],
    network_adapters: [
      { mac: "00:11:22:33:44:55", name: "Intel Ethernet", description: "Physical LAN" },
      { mac: "00:22:33:44:55:66", name: "VMware Virtual Adapter", description: "Virtual" },
      { mac: "02:12:34:56:78:90", name: "Wi-Fi", description: "Randomized MAC" },
    ],
    ...overrides,
  });
}

test("v3 因子归一化统一去分隔符并转大写", () => {
  assert.equal(normalizeFactorValue("  ab-cd:12 34_ef  "), "ABCD1234EF");
  assert.equal(normalizeFactorValue(" 序列-号 123 "), "序列号123");
});

test("v3 无效值过滤覆盖占位值、全零、全 F 和短值", () => {
  const invalid = [
    "",
    "0000-0000-0000",
    "FFFF-FFFF-FFFF",
    "To be filled by O.E.M.",
    "Default string",
    "System Serial Number",
    "None",
    "Not Specified",
    "A-12",
  ];
  for (const value of invalid) {
    assert.equal(inspectFactorValue(value).valid, false, value);
    assert.equal(inspectFactorValue(value).normalized, "", value);
  }
  assert.deepEqual(inspectFactorValue(" real-serial-123 "), {
    normalized: "REALSERIAL123",
    valid: true,
    reason: "valid",
  });
});

test("每个因子独立散列，app_name 和因子名都参与散列", () => {
  const first = hashFactor({ appName: APP_NAME, factorName: "bios_uuid", value: "AA-BB-CC-11-22-33" });
  const sameNormalized = hashFactor({ appName: APP_NAME, factorName: "bios_uuid", value: "aabbcc112233" });
  const differentFactor = hashFactor({ appName: APP_NAME, factorName: "machine_guid", value: "AA-BB-CC-11-22-33" });
  const differentApp = hashFactor({ appName: "another-app", factorName: "bios_uuid", value: "AA-BB-CC-11-22-33" });
  assert.match(first, /^[a-f0-9]{32}$/);
  assert.equal(first, sameNormalized);
  assert.notEqual(first, differentFactor);
  assert.notEqual(first, differentApp);
  assert.equal(hashFactor({ appName: APP_NAME, factorName: "bios_uuid", value: "Default string" }), "");
});

test("候选 v3 码只由指定强因子的 hash 组合生成", () => {
  const hashes = hashFactorMap({
    appName: APP_NAME,
    platform: "win32",
    values: {
      machine_guid: "GUID-123456",
      bios_uuid: "BIOS-123456",
      system_disk_serial: "DISK-123456",
      cpu_processor_id: "CPU-123456",
    },
  });
  const first = deriveV3MachineCode({ appName: APP_NAME, platform: "win32", factorHashes: hashes });
  const changedWeakFactor = deriveV3MachineCode({
    appName: APP_NAME,
    platform: "win32",
    factorHashes: { ...hashes, cpu_processor_id: "f".repeat(32) },
  });
  assert.match(first, /^v3_[a-f0-9]{64}$/);
  assert.equal(first, changedWeakFactor);
});

test("Windows 优先使用 PowerShell CIM，返回结果仅含 hash 和脱敏诊断", async () => {
  const rawValues = [
    "A1B2C3D4-E5F6-7788-99AA-BBCCDDEEFF00",
    "11112222-3333-4444-5555-666677778888",
    "BOARD-SERIAL-908172",
    "DISK-SERIAL-123456",
    "CPU-ABCDEF-123456",
    "00:11:22:33:44:55",
  ];
  const calls = [];
  const result = await collectWindowsFactorHashes({
    appName: APP_NAME,
    execute: async (command, args, options) => {
      calls.push({ command, args, options });
      assert.equal(command, "powershell.exe");
      return { stdout: windowsCimPayload() };
    },
  });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].options.timeoutMs <= 4_000);
  assert.equal(result.collection.powershell_cim_available, true);
  assert.equal(result.collection.fallback_used, false);
  assert.equal(result.factor_status.machine_guid.source, "powershell_registry");
  assert.equal(result.factor_status.bios_uuid.source, "powershell_cim");
  assert.match(result.candidate_machine_code, /^v3_[a-f0-9]{64}$/);
  for (const digest of Object.values(result.factor_hashes)) assert.match(digest, /^[a-f0-9]{32}$/);
  const serialized = JSON.stringify(result);
  for (const raw of rawValues) assert.equal(serialized.includes(raw), false, raw);
});

test("Windows 在 PowerShell 被禁用时使用 reg.exe 和 wmic.exe 回退", async () => {
  const calls = [];
  const execute = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "powershell.exe") {
      const error = new Error("PowerShell disabled by policy");
      error.code = "ENOENT";
      throw error;
    }
    if (command === "reg.exe") return { stdout: "MachineGuid    REG_SZ    FALLBACK-GUID-123456\r\n" };
    const joined = args.join(" ");
    if (joined.startsWith("csproduct")) return { stdout: "UUID=FALLBACK-BIOS-123456\r\n" };
    if (joined.startsWith("baseboard")) return { stdout: "SerialNumber=Default string\r\n" };
    if (joined.startsWith("cpu")) return { stdout: "ProcessorId=FALLBACK-CPU-123456\r\n" };
    if (joined.includes("Win32_LogicalDiskToPartition")) {
      return { stdout: 'Antecedent=\\\\HOST\\root\\cimv2:Win32_DiskPartition.DeviceID="Disk #2, Partition #1"\r\nDependent=\\\\HOST\\root\\cimv2:Win32_LogicalDisk.DeviceID="C:"\r\n\r\n' };
    }
    if (joined.includes("Index=2")) return { stdout: "SerialNumber=FALLBACK-DISK-123456\r\n" };
    if (joined.startsWith("nic")) {
      return { stdout: "Description=Physical Ethernet\r\nMACAddress=00:A1:B2:C3:D4:E5\r\nName=Intel LAN\r\n\r\n" };
    }
    return { stdout: "" };
  };

  const result = await collectWindowsFactorHashes({ appName: APP_NAME, execute, systemDrive: "C:" });
  assert.equal(result.collection.powershell_cim_available, false);
  assert.equal(result.collection.fallback_used, true);
  assert.deepEqual(result.collection.fallback_paths, ["reg.exe", "wmic.exe"]);
  assert.equal(result.factor_status.machine_guid.source, "reg.exe");
  assert.equal(result.factor_status.system_disk_serial.source, "wmic.exe");
  assert.equal(result.factor_status.baseboard_serial.collected, false);
  assert.ok(calls.some((line) => line.startsWith("reg.exe query")));
  assert.ok(calls.some((line) => line.startsWith("wmic.exe csproduct")));
  assert.match(result.candidate_machine_code, /^v3_[a-f0-9]{64}$/);
});

test("macOS 采集 IOPlatform 、型号和物理 MAC，对外不返回原值", async () => {
  const secrets = ["MAC-UUID-PRIVATE-123456", "MAC-SERIAL-PRIVATE-987654", "00:11:22:33:44:66"];
  const execute = async (command) => {
    if (command === "/usr/sbin/ioreg") {
      return { stdout: `"IOPlatformUUID" = "${secrets[0]}"\n"IOPlatformSerialNumber" = "${secrets[1]}"\n` };
    }
    if (command === "/usr/sbin/sysctl") return { stdout: "Mac14,7\n" };
    if (command === "/usr/sbin/networksetup") {
      return { stdout: `Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: ${secrets[2]}\n\nHardware Port: Bluetooth PAN\nDevice: en8\nEthernet Address: 00:22:33:44:55:77\n` };
    }
    throw new Error("unexpected command");
  };
  const result = await collectMacosFactorHashes({ appName: APP_NAME, execute });
  assert.equal(result.collection.fallback_used, false);
  assert.match(result.candidate_machine_code, /^v3_[a-f0-9]{64}$/);
  assert.equal(result.factor_status.io_platform_uuid.source, "ioreg");
  assert.equal(result.factor_status.physical_mac.source, "networksetup");
  const serialized = JSON.stringify(result);
  for (const raw of secrets) assert.equal(serialized.includes(raw), false, raw);
});

test("后台入口在调用栈返回前不执行采集", async () => {
  let windowsScheduled;
  let windowsCalls = 0;
  const windows = startWindowsFactorCollection({
    execute: async () => { windowsCalls += 1; return { stdout: windowsCimPayload() }; },
    schedule: (callback) => { windowsScheduled = callback; },
  });
  assert.equal(windowsCalls, 0);
  assert.equal(typeof windowsScheduled, "function");
  windowsScheduled();
  await windows.result;
  assert.equal(windowsCalls, 1);

  let macScheduled;
  let macCalls = 0;
  const mac = startMacosFactorCollection({
    execute: async () => { macCalls += 1; return { stdout: "" }; },
    schedule: (callback) => { macScheduled = callback; },
  });
  assert.equal(macCalls, 0);
  macScheduled();
  await mac.result;
  assert.ok(macCalls > 0);
});

test("单组与总超时有硬上限，卡住的采集不抛错", async () => {
  assert.deepEqual(WINDOWS_COLLECTION_TIMEOUTS, { groupMs: 4_000, totalMs: 8_000 });
  assert.deepEqual(MACOS_COLLECTION_TIMEOUTS, { groupMs: 4_000, totalMs: 8_000 });
  const started = performance.now();
  const result = await collectWindowsFactorHashes({
    execute: async () => new Promise(() => {}),
    groupTimeoutMs: 20,
    totalTimeoutMs: 55,
  });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 250, `elapsed=${elapsed}`);
  assert.equal(result.collection.timed_out, true);
  assert.equal(result.candidate_machine_code, "");
});

test("原始硬件标识不进入返回值、日志或被暴露的异常栈", async () => {
  const secret = "PRIVATE-HARDWARE-SERIAL-DO-NOT-LEAK-998877";
  const captured = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...values) => captured.push(values.join(" "));
  console.error = (...values) => captured.push(values.join(" "));
  console.warn = (...values) => captured.push(values.join(" "));
  let thrown = null;
  let result;
  try {
    result = await collectWindowsFactorHashes({
      execute: async () => {
        const error = new Error(`collection failed for ${secret}`);
        error.stack = `Error: ${secret}\n at private-hardware-provider`;
        throw error;
      },
      groupTimeoutMs: 5,
      totalTimeoutMs: 30,
    });
  } catch (error) {
    thrown = error;
  } finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
  }
  assert.equal(thrown, null);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(captured.join("\n").includes(secret), false);
});

test("储备采集器没有接入现有 machine-code 或 Electron 入口", async () => {
  const [machineCode, main] = await Promise.all([
    readFile(new URL("../electron/machine-code.mjs", import.meta.url), "utf8"),
    readFile(new URL("../electron/main.mjs", import.meta.url), "utf8"),
  ]);
  assert.equal(machineCode.includes("machine-identity/collectors"), false);
  assert.equal(main.includes("machine-identity/collectors"), false);
});

test("Windows 真机诊断脚本是只读且不包含网络或注册表写入命令", async () => {
  const source = await readFile(new URL("../scripts/diagnose-windows-machine-identity.ps1", import.meta.url), "utf8");
  assert.match(source, /Get-CimInstance/);
  assert.match(source, /reg\.exe query/);
  assert.match(source, /wmic\.exe/);
  assert.match(source, /current_v2_machine_code/);
  assert.match(source, /candidate_v3_machine_code/);
  assert.match(source, /MACHINE: \$env:COMPUTERNAME/);
  assert.match(source, /Set-Clipboard -Value \$ClipboardText/);
  assert.doesNotMatch(source, /`\s*(?:\r?\n)/);
  assert.doesNotMatch(source, /\$PSScriptRoot/);
  assert.doesNotMatch(source, /Invoke-WebRequest|Invoke-RestMethod|System\.Net\.WebClient|Start-BitsTransfer/i);
  assert.doesNotMatch(source, /Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|reg\.exe\s+(?:add|delete)/i);
  assert.doesNotMatch(source, /wmic\.exe[^\r\n]*(?:call|set)\b/i);
});

test("诊断脚本与 JS 储备模块使用同一 v3 组合字节序列", () => {
  const factorHashes = {
    machine_guid: "1".repeat(32),
    bios_uuid: "2".repeat(32),
    system_disk_serial: "3".repeat(32),
  };
  const payload = [
    "license-machine-code-v3",
    "\0",
    APP_NAME,
    "\0win32\0",
    "machine_guid=", factorHashes.machine_guid, "\0",
    "bios_uuid=", factorHashes.bios_uuid, "\0",
    "system_disk_serial=", factorHashes.system_disk_serial, "\0",
  ].join("");
  const expected = `v3_${createHash("sha256").update(payload, "utf8").digest("hex")}`;
  assert.equal(deriveV3MachineCode({ appName: APP_NAME, platform: "win32", factorHashes }), expected);
});
