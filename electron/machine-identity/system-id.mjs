import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const executeFile = promisify(execFile);
const INVALID_UUIDS = new Set([
  "03000200040005000006000700080009", // Common unconfigured SMBIOS value.
  "00020003000400050006000700080009",
  "123456781234123412341234567890ab",
]);

export function normalizeSystemUuid(value) {
  const raw = String(value ?? "").trim().replace(/^\{(.+)\}$/, "$1");
  if (!/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(raw)) return "";
  const compact = raw.replaceAll("-", "").toLowerCase();
  if (/^(.)\1+$/.test(compact) || INVALID_UUIDS.has(compact)) return "";
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function systemExecutable(name, environment) {
  const root = environment.SystemRoot || environment.windir || "C:\\Windows";
  // A 32-bit process on 64-bit Windows must bypass filesystem redirection.
  const directory = environment.PROCESSOR_ARCHITEW6432 ? "Sysnative" : "System32";
  return path.win32.join(root, directory, name);
}

function failureReason(error) {
  if (error?.killed || ["ETIMEDOUT", "ABORT_ERR"].includes(error?.code)) return "timeout";
  if (error?.code === "ENOENT") return "command_unavailable";
  if (["EACCES", "EPERM"].includes(error?.code)) return "permission_denied";
  return "command_failed";
}

// One UUID query, one 8-second budget per attempt, one retry after 500 ms.
// Never substitute MachineGuid, a MAC address, hostname, or a random value.
// Raw command errors/output are deliberately absent from returned diagnostics.
export async function readSystemHardwareId(platform, {
  execute = executeFile, read = readFile, sleep = delay, environment = process.env,
  legacyWindows = false,
} = {}) {
  const sourceType = platform === "win32"
    ? legacyWindows ? "windows_machine_guid" : "windows_system_uuid"
    : platform === "darwin" ? "mac_io_platform_uuid" : platform === "linux" ? "linux_machine_id" : "unknown";
  let reason = "unsupported_platform";
  if (sourceType === "unknown") return { rawId: "", normalizedId: "", sourceType, reason, attempts: 0 };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let rawId = "";
    try {
      const options = { encoding: "utf8", timeout: 8_000, windowsHide: true, maxBuffer: 256 * 1024 };
      if (platform === "win32" && legacyWindows) {
        const { stdout } = await execute(systemExecutable("reg.exe", environment), [
          "query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64",
        ], options);
        rawId = /MachineGuid\s+REG_SZ\s+([^\r\n]+)/i.exec(stdout)?.[1]?.trim() || "";
      } else if (platform === "win32") {
        const { stdout } = await execute(systemExecutable("WindowsPowerShell\\v1.0\\powershell.exe", environment), [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
          "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; (Get-CimInstance -ClassName Win32_ComputerSystemProduct -OperationTimeoutSec 6 | Select-Object -First 1 -ExpandProperty UUID)",
        ], options);
        rawId = String(stdout || "").replace(/^\uFEFF/, "").trim();
      } else if (platform === "darwin") {
        const { stdout } = await execute("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], options);
        rawId = /"IOPlatformUUID"\s*=\s*"([^"]+)"/i.exec(stdout)?.[1]?.trim() || "";
      } else {
        for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
          try {
            const value = (await read(file, "utf8")).trim();
            if (/^[a-f\d]{32}$/i.test(value) && !/^(.)\1+$/.test(value.toLowerCase())) { rawId = value; break; }
          } catch { /* Try the OS fallback file. */ }
        }
      }
      const normalizedId = legacyWindows || platform === "linux"
        ? rawId.toLowerCase() : normalizeSystemUuid(rawId);
      if (normalizedId) return { rawId, normalizedId, sourceType, reason: "ok", attempts: attempt };
      reason = rawId ? "invalid_identifier" : "empty_result";
    } catch (error) {
      reason = failureReason(error);
    }
    if (attempt === 1) await sleep(500);
  }
  return { rawId: "", normalizedId: "", sourceType, reason, attempts: 2 };
}

export const platformHardwareId = (platform) => readSystemHardwareId(platform);
// Used ONLY to check or recover pre-upgrade identities, never for new installs.
export const legacyPlatformHardwareId = (platform) => readSystemHardwareId(platform, { legacyWindows: platform === "win32" });
