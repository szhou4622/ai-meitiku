import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSystemUuid, readSystemHardwareId } from "../electron/machine-identity/system-id.mjs";

const UUID = "A1234567-89AB-CDEF-0123-456789ABCDEF";

test("UUID 清洗统一大小写和格式，过滤空值、全零、全 F 及 SMBIOS 默认值", () => {
  assert.equal(normalizeSystemUuid(` {${UUID}} `), UUID.toLowerCase());
  assert.equal(normalizeSystemUuid(UUID.replaceAll("-", "")), UUID.toLowerCase());
  for (const invalid of ["", "UNKNOWN", "To Be Filled By O.E.M.", "Default string", "123456789", "0".repeat(32), "F".repeat(32), "A".repeat(32),
    "03000200-0400-0500-0006-000700080009", "00020003-0004-0005-0006-000700080009", "12345678-1234-1234-1234-1234567890AB"]) {
    assert.equal(normalizeSystemUuid(invalid), "", invalid);
  }
});

test("Windows 仅查系统 UUID，使用完整 PowerShell 路径、独立超时、无 Profile", async () => {
  const calls = [];
  const result = await readSystemHardwareId("win32", { environment: { SystemRoot: "D:\\Windows" },
    execute: async (...args) => { calls.push(args); return { stdout: `\uFEFF${UUID}\r\n` }; },
    sleep: async () => assert.fail("successful read must not sleep"),
  });
  assert.equal(result.normalizedId, UUID.toLowerCase());
  assert.equal(result.sourceType, "windows_system_uuid");
  assert.equal(result.attempts, 1);
  assert.equal(calls[0][0], "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.ok(calls[0][1].includes("-NoProfile"));
  assert.ok(calls[0][1].includes("-NonInteractive"));
  assert.match(calls[0][1].at(-1), /Win32_ComputerSystemProduct/);
  assert.doesNotMatch(calls[0][1].at(-1), /Win32_BIOS|Win32_BaseBoard|MachineGuid/);
  assert.equal(calls[0][2].timeout, 8000);
  assert.equal(calls[0][2].windowsHide, true);
});

test("首次超时或空值或无效 UUID 后等待 500ms 重试成功", async () => {
  for (const first of [null, "", "00000000-0000-0000-0000-000000000000"]) {
    let calls = 0;
    const sleeps = [];
    const result = await readSystemHardwareId("win32", {
      execute: async () => {
        calls += 1;
        if (calls === 1 && first === null) throw Object.assign(new Error("private output"), { killed: true });
        return { stdout: calls === 1 ? first : UUID };
      }, sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.equal(result.attempts, 2);
    assert.equal(result.normalizedId, UUID.toLowerCase());
    assert.deepEqual(sleeps, [500]);
  }
});

test("连续失败分类但不返回原始命令错误，绝不降级注册表或随机值", async () => {
  for (const [code, reason] of [["ENOENT", "command_unavailable"], ["ETIMEDOUT", "timeout"], ["EACCES", "permission_denied"], [1, "command_failed"]]) {
    const commands = [];
    const result = await readSystemHardwareId("win32", {
      execute: async (command) => { commands.push(command); throw Object.assign(new Error("PRIVATE-SERIAL-ABC"), { code }); },
      sleep: async () => {},
    });
    assert.equal(commands.length, 2);
    assert.ok(commands.every((command) => command.endsWith("powershell.exe")));
    assert.equal(result.reason, reason);
    assert.equal(result.normalizedId, "");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-SERIAL/);
  }
});

test("32 位进程通过 Sysnative 读取，避免重定向到错误的系统目录", async () => {
  let command;
  await readSystemHardwareId("win32", { environment: { SystemRoot: "C:\\Windows", PROCESSOR_ARCHITEW6432: "AMD64" },
    execute: async (value) => { command = value; return { stdout: UUID }; },
  });
  assert.equal(command, "C:\\Windows\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe");
});

test("历史 Windows 路径仍可读取原始大小写 MachineGuid，只用于兼容", async () => {
  let command;
  const result = await readSystemHardwareId("win32", { legacyWindows: true, environment: { SystemRoot: "C:\\Windows" },
    execute: async (file, args) => { command = file; assert.ok(args.includes("/reg:64")); return { stdout: ` MachineGuid REG_SZ ${UUID}\r\n` }; },
  });
  assert.equal(command, "C:\\Windows\\System32\\reg.exe");
  assert.equal(result.rawId, UUID);
  assert.equal(result.sourceType, "windows_machine_guid");
});

test("Mac 只读平台 UUID，短暂失败后重试，不混入序列号", async () => {
  let calls = 0;
  const result = await readSystemHardwareId("darwin", {
    execute: async (command) => {
      assert.equal(command, "/usr/sbin/ioreg");
      calls += 1;
      return { stdout: calls === 1 ? "" : `"IOPlatformUUID" = "${UUID}"\n"IOPlatformSerialNumber" = "PRIVATE-SERIAL"` };
    }, sleep: async () => {},
  });
  assert.equal(result.sourceType, "mac_io_platform_uuid");
  assert.equal(result.normalizedId, UUID.toLowerCase());
  assert.equal(calls, 2);
});

test("Linux 保留原 machine-id 格式及备用路径", async () => {
  const id = "a123456789abcdef0123456789abcdef";
  const files = [];
  const result = await readSystemHardwareId("linux", {
    read: async (file) => { files.push(file); if (file === "/etc/machine-id") throw new Error("missing"); return id; },
  });
  assert.deepEqual(files, ["/etc/machine-id", "/var/lib/dbus/machine-id"]);
  assert.equal(result.normalizedId, id);
});
