import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  deriveV3MachineCode,
  factorWeightMap,
  hashFactorMap,
} from "../hash.mjs";
import { inspectFactorValue, normalizeFactorValue } from "../normalize.mjs";

const execFileAsync = promisify(execFile);

export const MACOS_COLLECTION_TIMEOUTS = Object.freeze({
  groupMs: 4_000,
  totalMs: 8_000,
});

const FACTOR_NAMES = Object.freeze([
  "io_platform_uuid",
  "io_platform_serial_number",
  "hardware_model",
  "physical_mac",
]);

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

function ioregValue(stdout, key) {
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`"${escaped}"\\s*=\\s*"([^"]+)"`, "i").exec(String(stdout || ""))?.[1] || "";
}

function virtualAdapterText(value) {
  return /(?:VIRTUAL|BRIDGE|LOOPBACK|BLUETOOTH|THUNDERBOLT BRIDGE|VPN|TUNNEL|WIREGUARD|TAILSCALE|UTUN|AWDL|LLW)/i.test(String(value || ""));
}

function validPhysicalMac(value) {
  const normalized = normalizeFactorValue(value);
  if (!/^[A-F0-9]{12}$/.test(normalized) || /^0+$/.test(normalized) || /^F+$/.test(normalized)) return "";
  const firstOctet = Number.parseInt(normalized.slice(0, 2), 16);
  if ((firstOctet & 1) !== 0 || (firstOctet & 2) !== 0) return "";
  return normalized;
}

function parseNetworkSetup(stdout) {
  const values = [];
  for (const block of String(stdout || "").split(/(?:\r?\n){2,}/)) {
    const port = /^Hardware Port:\s*(.+)$/im.exec(block)?.[1]?.trim() || "";
    const device = /^Device:\s*(.+)$/im.exec(block)?.[1]?.trim() || "";
    const rawMac = /^Ethernet Address:\s*(.+)$/im.exec(block)?.[1]?.trim() || "";
    if (!device || virtualAdapterText(`${port} ${device}`)) continue;
    const mac = validPhysicalMac(rawMac);
    if (mac) values.push(mac);
  }
  return [...new Set(values)].sort().join("");
}

function parseIfconfig(stdout) {
  const values = [];
  let currentInterface = "";
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const heading = /^([a-z0-9]+):\s/i.exec(line);
    if (heading) currentInterface = heading[1];
    const rawMac = /^\s*ether\s+([^\s]+)/i.exec(line)?.[1] || "";
    if (!/^en\d+$/i.test(currentInterface) || !rawMac) continue;
    const mac = validPhysicalMac(rawMac);
    if (mac) values.push(mac);
  }
  return [...new Set(values)].sort().join("");
}

function publicResult({ appName, state, startedAt, now, fallbackPaths, totalTimeoutMs }) {
  const values = Object.fromEntries(FACTOR_NAMES.map((name) => [name, state[name].normalized]));
  const factorHashes = hashFactorMap({ appName, values, platform: "darwin" });
  const weights = factorWeightMap("darwin");
  const factorStatus = Object.freeze(Object.fromEntries(FACTOR_NAMES.map((name) => [name, Object.freeze({
    collected: Boolean(factorHashes[name]),
    source: factorHashes[name] ? state[name].source : "unavailable",
    weight: weights[name],
  })])));
  const durationMs = Math.max(0, Math.round(now() - startedAt));
  return Object.freeze({
    version: 3,
    platform: "darwin",
    factor_hashes: factorHashes,
    factor_status: factorStatus,
    candidate_machine_code: deriveV3MachineCode({ appName, platform: "darwin", factorHashes }),
    collection: Object.freeze({
      duration_ms: durationMs,
      fallback_used: fallbackPaths.size > 0,
      fallback_paths: Object.freeze([...fallbackPaths].sort()),
      timed_out: durationMs >= totalTimeoutMs,
    }),
  });
}

export async function collectMacosFactorHashes(options = {}) {
  const appName = String(options.appName || "ai-media-library").trim();
  const execute = typeof options.execute === "function" ? options.execute : defaultExecute;
  const now = typeof options.now === "function" ? options.now : () => performance.now();
  const groupTimeoutMs = boundedTimeout(options.groupTimeoutMs, MACOS_COLLECTION_TIMEOUTS.groupMs, MACOS_COLLECTION_TIMEOUTS.groupMs);
  const totalTimeoutMs = boundedTimeout(options.totalTimeoutMs, MACOS_COLLECTION_TIMEOUTS.totalMs, MACOS_COLLECTION_TIMEOUTS.totalMs);
  const startedAt = now();
  const state = newFactorState();
  const fallbackPaths = new Set();
  const run = createCommandRunner({ execute, startedAt, now, groupTimeoutMs, totalTimeoutMs });

  try {
    const ioreg = await run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    if (ioreg.ok) {
      acceptFactor(state, "io_platform_uuid", ioregValue(ioreg.stdout, "IOPlatformUUID"), "ioreg");
      acceptFactor(state, "io_platform_serial_number", ioregValue(ioreg.stdout, "IOPlatformSerialNumber"), "ioreg");
    }
  } catch {
    // A failed factor group must not make the application startup fail.
  }

  try {
    const model = await run("/usr/sbin/sysctl", ["-n", "hw.model"]);
    if (model.ok) acceptFactor(state, "hardware_model", model.stdout, "sysctl");
  } catch {
    // Keep the factor unavailable without exposing the command error.
  }

  try {
    const network = await run("/usr/sbin/networksetup", ["-listallhardwareports"]);
    if (network.ok) acceptFactor(state, "physical_mac", parseNetworkSetup(network.stdout), "networksetup");
  } catch {
    // The ifconfig fallback below can still provide a physical interface.
  }

  if (!state.physical_mac.normalized && now() - startedAt < totalTimeoutMs) {
    fallbackPaths.add("ifconfig");
    try {
      const network = await run("/sbin/ifconfig", ["-a"]);
      if (network.ok) acceptFactor(state, "physical_mac", parseIfconfig(network.stdout), "ifconfig");
    } catch {
      // Never expose a raw MAC through an error path.
    }
  }

  return publicResult({ appName, state, startedAt, now, fallbackPaths, totalTimeoutMs });
}

export function startMacosFactorCollection(options = {}) {
  const schedule = typeof options.schedule === "function" ? options.schedule : setImmediate;
  const collection = new Promise((resolve) => {
    schedule(() => {
      Promise.resolve(collectMacosFactorHashes(options)).then(resolve);
    });
  });
  return Object.freeze({ result: collection });
}
