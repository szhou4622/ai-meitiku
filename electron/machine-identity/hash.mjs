import { createHash } from "node:crypto";
import { inspectFactorValue } from "./normalize.mjs";

export const FACTOR_HASH_SALT = "license-machine-factor-v3";

export const FACTOR_WEIGHTS = Object.freeze({
  win32: Object.freeze({
    machine_guid: 3,
    bios_uuid: 3,
    baseboard_serial: 2,
    system_disk_serial: 3,
    cpu_processor_id: 1,
    physical_mac: 1,
  }),
  darwin: Object.freeze({
    io_platform_uuid: 3,
    io_platform_serial_number: 3,
    hardware_model: 1,
    physical_mac: 1,
  }),
});

const STRONG_FACTOR_ORDER = Object.freeze({
  win32: Object.freeze(["machine_guid", "bios_uuid", "system_disk_serial"]),
  darwin: Object.freeze(["io_platform_uuid", "io_platform_serial_number"]),
});

function sha256Hex(parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(String(part), "utf8");
  return hash.digest("hex");
}

function cleanAppName(appName) {
  try {
    return String(appName ?? "").trim();
  } catch {
    return "";
  }
}

export function hashFactor({ appName, factorName, value, salt = FACTOR_HASH_SALT }) {
  const app = cleanAppName(appName);
  const factor = cleanAppName(factorName).toLowerCase();
  const inspected = inspectFactorValue(value);
  if (!app || !factor || !inspected.valid) return "";
  return sha256Hex([
    salt,
    "\0",
    app,
    "\0",
    factor,
    "\0",
    inspected.normalized,
  ]).slice(0, 32);
}

export function hashFactorMap({ appName, values, platform }) {
  const weights = FACTOR_WEIGHTS[platform] || {};
  const hashes = {};
  for (const factorName of Object.keys(weights)) {
    hashes[factorName] = hashFactor({
      appName,
      factorName,
      value: values?.[factorName],
    });
  }
  return Object.freeze(hashes);
}

export function deriveV3MachineCode({ appName, platform, factorHashes }) {
  const app = cleanAppName(appName);
  const order = STRONG_FACTOR_ORDER[platform];
  if (!app || !order) return "";

  const parts = order
    .map((name) => [name, String(factorHashes?.[name] || "").toLowerCase()])
    .filter(([, digest]) => /^[a-f0-9]{32}$/.test(digest));
  if (parts.length === 0) return "";

  const digest = sha256Hex([
    "license-machine-code-v3",
    "\0",
    app,
    "\0",
    platform,
    "\0",
    ...parts.flatMap(([name, hash]) => [name, "=", hash, "\0"]),
  ]);
  return `v3_${digest}`;
}

export function factorWeightMap(platform) {
  return FACTOR_WEIGHTS[platform] || Object.freeze({});
}
