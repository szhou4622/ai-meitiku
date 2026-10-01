import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  deriveV3MachineCode,
  factorWeightMap,
  hashFactorMap,
} from "../hash.mjs";
import { inspectFactorValue, normalizeFactorValue } from "../normalize.mjs";

const execFileAsync = promisify(execFile);

export const WINDOWS_COLLECTION_TIMEOUTS = Object.freeze({
  groupMs: 4_000,
  totalMs: 8_000,
});

const FACTOR_NAMES = Object.freeze([
  "machine_guid",
  "bios_uuid",
  "baseboard_serial",
  "system_disk_serial",
  "cpu_processor_id",
  "physical_mac",
]);

const POWERSHELL_CIM_SCRIPT = String.raw`
$ErrorActionPreference = "SilentlyContinue"
function Try-Read([scriptblock]$Block) {
  try { return (& $Block) } catch { return $null }
}
$cimAvailable = $false
$machineGuid = Try-Read { (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Cryptography" -Name MachineGuid).MachineGuid }
$os = Try-Read { Get-CimInstance -ClassName Win32_OperatingSystem -OperationTimeoutSec 4 }
if ($null -ne $os) { $cimAvailable = $true }
$biosUuid = Try-Read { (Get-CimInstance -ClassName Win32_ComputerSystemProduct -OperationTimeoutSec 4 | Select-Object -First 1).UUID }
$baseboardSerial = Try-Read { (Get-CimInstance -ClassName Win32_BaseBoard -OperationTimeoutSec 4 | Select-Object -First 1).SerialNumber }
$cpuIds = @(Try-Read { Get-CimInstance -ClassName Win32_Processor -OperationTimeoutSec 4 | ForEach-Object { $_.ProcessorId } })
$systemDiskSerial = $null
try {
  $systemDrive = if ($null -ne $os -and $os.SystemDrive) { $os.SystemDrive } else { $env:SystemDrive }
  $logical = Get-CimInstance -ClassName Win32_LogicalDisk -Filter ("DeviceID='" + $systemDrive + "'") -OperationTimeoutSec 4 | Select-Object -First 1
  $partition = Get-CimAssociatedInstance -InputObject $logical -ResultClassName Win32_DiskPartition -OperationTimeoutSec 4 | Select-Object -First 1
  $disk = Get-CimAssociatedInstance -InputObject $partition -ResultClassName Win32_DiskDrive -OperationTimeoutSec 4 | Select-Object -First 1
  $systemDiskSerial = $disk.SerialNumber
} catch { $systemDiskSerial = $null }
$adapters = @()
try {
  $adapters = @(Get-CimInstance -ClassName Win32_NetworkAdapter -Filter "PhysicalAdapter=True AND MACAddress IS NOT NULL" -OperationTimeoutSec 4 | ForEach-Object {
    [ordered]@{ mac = $_.MACAddress; name = $_.Name; description = $_.Description }
  })
} catch { $adapters = @() }
[ordered]@{
  cim_available = $cimAvailable
  machine_guid = $machineGuid
  bios_uuid = $biosUuid
  baseboard_serial = $baseboardSerial
  system_disk_serial = $systemDiskSerial
  cpu_processor_id = $cpuIds
  network_adapters = $adapters
} | ConvertTo-Json -Compress -Depth 5
`;

function boundedTimeout(value, maximum, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), maximum));
}

async function defaultExecute(command, args, { timeoutMs }) {
  return execFileAsync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

function safeOutput(value) {
  try {
    return String(value?.stdout ?? value ?? "");
  } catch {
    return "";
  }
}

function createCommandRunner({ execute, startedAt, now, groupTimeoutMs, totalTimeoutMs }) {
  return async (command, args) => {
    const remaining = totalTimeoutMs - (now() - startedAt);
    if (remaining <= 0) return { ok: false, reason: "total_timeout", stdout: "" };
    const timeoutMs = Math.max(1, Math.min(groupTimeoutMs, Math.ceil(remaining)));
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("collector_timeout");
          error.code = "COLLECTOR_TIMEOUT";
          reject(error);
        }, timeoutMs);
      });
      const result = await Promise.race([
        Promise.resolve(execute(command, args, { timeoutMs })),
        timeout,
      ]);
      return { ok: true, reason: "ok", stdout: safeOutput(result) };
    } catch (error) {
      const code = String(error?.code || "");
      const reason = code === "COLLECTOR_TIMEOUT" || code === "ETIMEDOUT"
        ? "group_timeout"
        : code === "ENOENT" ? "command_unavailable" : "command_failed";
      return { ok: false, reason, stdout: "" };
    } finally {
      clearTimeout(timer);
    }
  };
}

function parsePowerShellJson(stdout) {
  const lines = String(stdout || "").replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith("{")) continue;
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Try the previous line; no parser input is included in any returned error.
    }
  }
  return null;
}

function parseWmicValues(stdout, key) {
  const values = [];
  const matcher = new RegExp(`^${key}\\s*=\\s*(.*)$`, "i");
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const matched = matcher.exec(line.trim());
    if (matched?.[1]) values.push(matched[1].trim());
  }
  return values;
}

function parseWmicBlocks(stdout) {
  return String(stdout || "")
    .split(/(?:\r?\n){2,}/)
    .map((block) => {
      const result = {};
      for (const line of block.split(/\r?\n/)) {
        const separator = line.indexOf("=");
        if (separator <= 0) continue;
        result[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
      }
      return result;
    })
    .filter((block) => Object.keys(block).length > 0);
}

function virtualAdapterText(value) {
  return /(?:VIRTUAL|HYPER[- ]?V|VMWARE|VBOX|VIRTUALBOX|TAP|TUNNEL|LOOPBACK|BLUETOOTH|MINIPORT|VPN|WIREGUARD|TAILSCALE|HAMACHI|DOCKER|WSL)/i.test(String(value || ""));
}

function validPhysicalMac(value) {
  const normalized = normalizeFactorValue(value);
  if (!/^[A-F0-9]{12}$/.test(normalized) || /^0+$/.test(normalized) || /^F+$/.test(normalized)) return "";
  const firstOctet = Number.parseInt(normalized.slice(0, 2), 16);
  if ((firstOctet & 1) !== 0 || (firstOctet & 2) !== 0) return "";
  return normalized;
}

function physicalMacFactor(adapters) {
  const hashes = [];
  for (const adapter of Array.isArray(adapters) ? adapters : []) {
    const label = `${adapter?.name || ""} ${adapter?.description || ""}`;
    if (virtualAdapterText(label)) continue;
    const mac = validPhysicalMac(adapter?.mac || adapter?.macaddress);
    if (mac) hashes.push(mac);
  }
  return [...new Set(hashes)].sort().join("");
}

function combinedValidValues(values) {
  const normalized = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const inspected = inspectFactorValue(value);
    if (inspected.valid) normalized.push(inspected.normalized);
  }
  return [...new Set(normalized)].sort().join("");
}

function newFactorState() {
  return Object.fromEntries(FACTOR_NAMES.map((name) => [name, {
    normalized: "",
    source: "unavailable",
  }]));
}

function acceptFactor(state, name, value, source) {
  if (!FACTOR_NAMES.includes(name) || state[name].normalized) return false;
  const inspected = inspectFactorValue(value);
  if (!inspected.valid) return false;
  state[name] = { normalized: inspected.normalized, source };
  return true;
}

function missing(state, name) {
  return !state[name].normalized;
}

async function collectFallbacks({ run, state, fallbackPaths, systemDrive }) {
  if (missing(state, "machine_guid")) {
    fallbackPaths.add("reg.exe");
    const result = await run("reg.exe", [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
      "/v",
      "MachineGuid",
    ]);
    if (result.ok) {
      const value = /MachineGuid\s+REG_SZ\s+([^\r\n]+)/i.exec(result.stdout)?.[1] || "";
      acceptFactor(state, "machine_guid", value, "reg.exe");
    }
  }

  const wmicQueries = [
    ["bios_uuid", ["csproduct", "get", "UUID", "/value"], "UUID"],
    ["baseboard_serial", ["baseboard", "get", "SerialNumber", "/value"], "SerialNumber"],
    ["cpu_processor_id", ["cpu", "get", "ProcessorId", "/value"], "ProcessorId"],
  ];
  for (const [factorName, args, key] of wmicQueries) {
    if (!missing(state, factorName)) continue;
    fallbackPaths.add("wmic.exe");
    const result = await run("wmic.exe", args);
    if (!result.ok) continue;
    const values = parseWmicValues(result.stdout, key);
    acceptFactor(state, factorName, combinedValidValues(values), "wmic.exe");
  }

  if (missing(state, "system_disk_serial")) {
    fallbackPaths.add("wmic.exe");
    const associations = await run("wmic.exe", [
      "path",
      "Win32_LogicalDiskToPartition",
      "get",
      "Antecedent,Dependent",
      "/format:list",
    ]);
    const normalizedDrive = String(systemDrive || "C:").trim().toUpperCase();
    const diskIndex = associations.ok
      ? parseWmicBlocks(associations.stdout)
        .filter((block) => String(block.dependent || "").toUpperCase().includes(normalizedDrive))
        .map((block) => /Disk\s+#(\d+)/i.exec(block.antecedent || "")?.[1])
        .find(Boolean)
      : "";
    if (diskIndex !== "") {
      const disk = await run("wmic.exe", [
        "diskdrive",
        "where",
        `Index=${diskIndex}`,
        "get",
        "SerialNumber",
        "/value",
      ]);
      if (disk.ok) acceptFactor(
        state,
        "system_disk_serial",
        parseWmicValues(disk.stdout, "SerialNumber")[0] || "",
        "wmic.exe",
      );
    }
  }

  if (missing(state, "physical_mac")) {
    fallbackPaths.add("wmic.exe");
    const result = await run("wmic.exe", [
      "nic",
      "where",
      "PhysicalAdapter=True and MACAddress is not null",
      "get",
      "MACAddress,Name,Description",
      "/format:list",
    ]);
    if (result.ok) {
      const mac = physicalMacFactor(parseWmicBlocks(result.stdout).map((block) => ({
        mac: block.macaddress,
        name: block.name,
        description: block.description,
      })));
      acceptFactor(state, "physical_mac", mac, "wmic.exe");
    }
  }
}

function publicResult({ appName, state, startedAt, now, cimAvailable, fallbackPaths, totalTimeoutMs }) {
  const values = Object.fromEntries(FACTOR_NAMES.map((name) => [name, state[name].normalized]));
  const factorHashes = hashFactorMap({ appName, values, platform: "win32" });
  const weights = factorWeightMap("win32");
  const factorStatus = Object.freeze(Object.fromEntries(FACTOR_NAMES.map((name) => [name, Object.freeze({
    collected: Boolean(factorHashes[name]),
    source: factorHashes[name] ? state[name].source : "unavailable",
    weight: weights[name],
  })])));
  const durationMs = Math.max(0, Math.round(now() - startedAt));
  return Object.freeze({
    version: 3,
    platform: "win32",
    factor_hashes: factorHashes,
    factor_status: factorStatus,
    candidate_machine_code: deriveV3MachineCode({ appName, platform: "win32", factorHashes }),
    collection: Object.freeze({
      duration_ms: durationMs,
      powershell_cim_available: Boolean(cimAvailable),
      fallback_used: fallbackPaths.size > 0,
      fallback_paths: Object.freeze([...fallbackPaths].sort()),
      timed_out: durationMs >= totalTimeoutMs,
    }),
  });
}

export async function collectWindowsFactorHashes(options = {}) {
  const appName = String(options.appName || "ai-media-library").trim();
  const execute = typeof options.execute === "function" ? options.execute : defaultExecute;
  const now = typeof options.now === "function" ? options.now : () => performance.now();
  const groupTimeoutMs = boundedTimeout(options.groupTimeoutMs, WINDOWS_COLLECTION_TIMEOUTS.groupMs, WINDOWS_COLLECTION_TIMEOUTS.groupMs);
  const totalTimeoutMs = boundedTimeout(options.totalTimeoutMs, WINDOWS_COLLECTION_TIMEOUTS.totalMs, WINDOWS_COLLECTION_TIMEOUTS.totalMs);
  const startedAt = now();
  const state = newFactorState();
  const fallbackPaths = new Set();
  const run = createCommandRunner({ execute, startedAt, now, groupTimeoutMs, totalTimeoutMs });
  let cimAvailable = false;

  try {
    const powershell = await run("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      POWERSHELL_CIM_SCRIPT,
    ]);
    const parsed = powershell.ok ? parsePowerShellJson(powershell.stdout) : null;
    if (parsed) {
      cimAvailable = parsed.cim_available === true;
      acceptFactor(state, "machine_guid", parsed.machine_guid, "powershell_registry");
      acceptFactor(state, "bios_uuid", parsed.bios_uuid, "powershell_cim");
      acceptFactor(state, "baseboard_serial", parsed.baseboard_serial, "powershell_cim");
      acceptFactor(state, "system_disk_serial", parsed.system_disk_serial, "powershell_cim");
      acceptFactor(state, "cpu_processor_id", combinedValidValues(parsed.cpu_processor_id), "powershell_cim");
      acceptFactor(state, "physical_mac", physicalMacFactor(parsed.network_adapters), "powershell_cim");
    }
  } catch {
    // Collection errors are converted into unavailable factor statuses.
  }

  try {
    if (FACTOR_NAMES.some((name) => missing(state, name)) && now() - startedAt < totalTimeoutMs) {
      await collectFallbacks({
        run,
        state,
        fallbackPaths,
        systemDrive: options.systemDrive || process.env.SystemDrive || "C:",
      });
    }
  } catch {
    // Never return command errors, output, or raw identifiers to callers.
  }

  return publicResult({ appName, state, startedAt, now, cimAvailable, fallbackPaths, totalTimeoutMs });
}

export function startWindowsFactorCollection(options = {}) {
  const schedule = typeof options.schedule === "function" ? options.schedule : setImmediate;
  const collection = new Promise((resolve) => {
    schedule(() => {
      Promise.resolve(collectWindowsFactorHashes(options)).then(resolve);
    });
  });
  return Object.freeze({ result: collection });
}
