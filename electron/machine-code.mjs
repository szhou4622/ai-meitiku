import { createHash } from "node:crypto";
import { platformHardwareId, legacyPlatformHardwareId } from "./machine-identity/system-id.mjs";

const MACHINE_CODE_PATTERN = /^v2_[a-f0-9]{64}$/;
const MACHINE_IDENTITY_VERSION = 3;
const IDENTITY_SCHEME = "system_uuid_v1";
const identityPromises = new WeakMap();

function normalizeSystemId(value) {
  return String(value ?? "").trim().toLowerCase();
}

function sourceTypeForPlatform(platform) {
  if (platform === "darwin") return "mac_io_platform_uuid";
  if (platform === "win32") return "windows_system_uuid";
  if (platform === "linux") return "linux_machine_id";
  return "unknown";
}

function normalizeHardwareResult(value, platform) {
  if (value && typeof value === "object") {
    const rawId = String(value.rawId ?? value.normalizedId ?? "").trim();
    return {
      rawId,
      normalizedId: normalizeSystemId(value.normalizedId ?? rawId),
      sourceType: String(value.sourceType || sourceTypeForPlatform(platform)),
      reason: String(value.reason || (rawId ? "ok" : "empty_result")),
    };
  }
  const rawId = String(value ?? "").trim();
  return { rawId, normalizedId: normalizeSystemId(rawId), sourceType: sourceTypeForPlatform(platform), reason: rawId ? "ok" : "empty_result" };
}

function deriveMachineCode(appName, stableSource) {
  const digest = createHash("sha256")
    .update("license-machine-code-v2\0", "utf8")
    .update(String(appName), "utf8")
    .update("\0", "utf8")
    .update(String(stableSource), "utf8")
    .digest("hex");
  return `v2_${digest}`;
}

function deriveHardwareDigest(appName, stableSource) {
  return createHash("sha256")
    .update("license-hardware-digest-v1\0", "utf8")
    .update(String(appName), "utf8")
    .update("\0", "utf8")
    .update(String(stableSource), "utf8")
    .digest("hex");
}

function validMachineCode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return MACHINE_CODE_PATTERN.test(normalized) ? normalized : "";
}

function validIdentity(value) {
  return Boolean(value && Number(value.version) === MACHINE_IDENTITY_VERSION && validMachineCode(value.active_machine_code));
}

function hasHistoricalAuthorization(credential) {
  return Boolean(credential && (credential.deviceSession || credential.deviceCredential || credential.activationCode || credential.codeId));
}

async function readHardware(platform, hardwareIdProvider) {
  try {
    return normalizeHardwareResult(await hardwareIdProvider(platform), platform);
  } catch {
    return { rawId: "", normalizedId: "", sourceType: sourceTypeForPlatform(platform), reason: "read_failed" };
  }
}

async function readOptional(reader, fallback = null) {
  // An unreadable value is not an absent value. Never turn an I/O/decryption
  // failure into a fresh installation and replace a historical identity.
  return typeof reader === "function" ? await reader() : fallback;
}

function nowIso(now) {
  return new Date(now()).toISOString();
}

async function persistIdentity(secureStore, identity, { requirePersistence = false } = {}) {
  let identityError = null;
  let legacyCacheError = null;
  try {
    if (typeof secureStore.writeMachineIdentity !== "function") throw new Error("机器身份记录存储不可用");
    await secureStore.writeMachineIdentity(identity);
  } catch (error) {
    identityError = error;
  }
  // A new UUID code without its scheme/digest would look like a legacy code
  // next launch and bypass the UUID conflict check. Commit the full record first.
  if (requirePersistence && identityError) throw identityError;
  try {
    // Preserve the v2 cache so the pre-repair implementation can be restored immediately.
    if (typeof secureStore.writeMachineCode !== "function") throw new Error("旧版机器码缓存存储不可用");
    await secureStore.writeMachineCode(identity.active_machine_code);
  } catch (error) {
    legacyCacheError = error;
  }
  if (requirePersistence && (identityError || legacyCacheError)) {
    throw identityError || legacyCacheError;
  }
}

function machineIdentityError(code, message) {
  return Object.assign(new Error(message), { code });
}

function currentMachineCode(appName, hardware) {
  if (!hardware.normalizedId) return "";
  // Keep the server-compatible v2 envelope, but distinguish UUID from the old
  // Windows registry namespace. macOS/Linux keep their original formula.
  const source = hardware.sourceType === "windows_system_uuid"
    ? `windows_system_uuid\0${hardware.normalizedId}` : hardware.normalizedId;
  return deriveMachineCode(appName, source);
}

function matchesLegacyCode(appName, hardware, code) {
  return Boolean(hardware.normalizedId && (
    deriveMachineCode(appName, hardware.rawId) === code
    || deriveMachineCode(appName, hardware.normalizedId) === code
  ));
}

function refreshExistingIdentity({ identity, hardware, appName, timestamp }) {
  const active = validMachineCode(identity.active_machine_code);
  const legacy = validMachineCode(identity.legacy_machine_code);
  const isCurrent = identity.identity_scheme === IDENTITY_SCHEME;
  const candidate = isCurrent ? currentMachineCode(appName, hardware)
    : hardware.normalizedId ? deriveMachineCode(appName, hardware.normalizedId) : "";
  const digest = hardware.normalizedId ? deriveHardwareDigest(appName, hardware.normalizedId) : "";
  let hardwareMatch = null;
  let mismatch = identity.machine_identity_mismatch === true;
  if (digest && identity.source_type !== "random_fallback") {
    hardwareMatch = identity.hardware_digest ? identity.hardware_digest === digest
      : isCurrent ? candidate === active : matchesLegacyCode(appName, hardware, legacy || active);
    mismatch = !hardwareMatch;
  }
  return {
    ...identity,
    active_machine_code: active,
    legacy_machine_code: legacy,
    candidate_machine_code: candidate || validMachineCode(identity.candidate_machine_code),
    // A foreign cache must not acquire the current PC's digest as its baseline.
    hardware_digest: identity.hardware_digest || (hardwareMatch === true ? digest : ""),
    hardware_match: hardwareMatch,
    machine_identity_mismatch: mismatch,
    hardware_read_status: hardware.normalizedId ? "ok" : hardware.reason,
    updated_at: timestamp,
  };
}

async function buildMachineIdentity({ appName, secureStore, platform, hardwareIdProvider, legacyHardwareIdProvider, recoverMachineCode, now }) {
  const timestamp = nowIso(now);
  const [storedIdentity, oldMachineCode, credential, storedSeed] = await Promise.all([
    readOptional(() => secureStore.readMachineIdentity()),
    readOptional(() => secureStore.readMachineCode(), ""),
    readOptional(() => secureStore.readCredential()),
    readOptional(() => secureStore.readMachineSeed(), ""),
  ]);

  if (validIdentity(storedIdentity)) {
    // Do not compare a historical MachineGuid digest with a new system UUID.
    const provider = platform === "win32" && storedIdentity.identity_scheme !== IDENTITY_SCHEME
      ? legacyHardwareIdProvider : hardwareIdProvider;
    const hardware = await readHardware(platform, provider);
    const identity = refreshExistingIdentity({ identity: storedIdentity, hardware, appName, timestamp });
    // Existing durable identities remain usable even if a diagnostic refresh
    // cannot be written. This includes random identities issued by old builds.
    await persistIdentity(secureStore, identity);
    return identity;
  }

  const cachedLegacy = validMachineCode(oldMachineCode);
  if (storedIdentity || (oldMachineCode && !cachedLegacy)) {
    throw machineIdentityError("MACHINE_IDENTITY_RECOVERY_REQUIRED",
      "已有机器身份记录格式异常，原数据已保留；软件未生成替代机器码，请联系管理员核对");
  }
  const boundLegacy = validMachineCode(credential?.boundMachineCode);
  const fallbackCandidate = storedSeed ? deriveMachineCode(appName, storedSeed) : "";
  const hasHistory = Boolean(cachedLegacy || boundLegacy || storedSeed || hasHistoricalAuthorization(credential));
  if (hasHistory) {
    // Recover an exact saved code, never guess which historical normalization
    // was used from today's hardware. A v3 server binding remains in credential.
    let active = cachedLegacy || boundLegacy || fallbackCandidate;
    if (!active && typeof recoverMachineCode === "function") {
      // Some old builds allowed a deterministic code even when its cache could
      // not be written. Recover only the exact authenticated server binding.
      // Do not activate again or guess raw-vs-normalized hashes from hardware.
      try { active = validMachineCode(await recoverMachineCode(credential)); } catch { /* Preserve all local proof. */ }
    }
    if (!active) throw machineIdentityError("MACHINE_IDENTITY_RECOVERY_REQUIRED",
      "检测到历史授权，但当前无法恢复原机器码；原授权已保留，软件未创建或替换机器身份，请联系管理员核对");
    const hardware = await readHardware(platform, platform === "win32" ? legacyHardwareIdProvider : hardwareIdProvider);
    const fallbackMatch = Boolean(fallbackCandidate && active === fallbackCandidate);
    const hardwareMatch = fallbackMatch || !hardware.normalizedId ? null : matchesLegacyCode(appName, hardware, active);
    const identity = {
      version: MACHINE_IDENTITY_VERSION,
      active_machine_code: active,
      legacy_machine_code: active,
      candidate_machine_code: hardware.normalizedId ? deriveMachineCode(appName, hardware.normalizedId) : "",
      source_type: fallbackMatch ? "random_fallback" : platform === "win32" ? "windows_machine_guid" : hardware.sourceType,
      hardware_digest: fallbackMatch ? deriveHardwareDigest(appName, storedSeed)
        : hardwareMatch === true ? deriveHardwareDigest(appName, hardware.normalizedId) : "",
      compatibility_mode: true,
      hardware_match: hardwareMatch,
      machine_identity_mismatch: hardwareMatch === false,
      hardware_read_status: hardware.normalizedId ? "ok" : hardware.reason,
      created_at: timestamp,
      updated_at: timestamp,
    };
    await persistIdentity(secureStore, identity);
    return identity;
  }

  const hardware = await readHardware(platform, hardwareIdProvider);
  if (!hardware.normalizedId) {
    const reasons = { timeout: "设备查询超时", command_unavailable: "设备查询程序不可用",
      permission_denied: "设备查询权限不足", invalid_identifier: "系统返回的设备标识无效", empty_result: "系统未返回设备标识" };
    throw Object.assign(machineIdentityError("MACHINE_IDENTITY_UNAVAILABLE",
      `${reasons[hardware.reason] || "暂时无法读取有效的本机设备标识"}，重试后仍未成功；未生成替代机器码，请稍后重试或联系管理员核对`),
    { reason: hardware.reason });
  }
  const active = currentMachineCode(appName, hardware);
  const identity = {
    version: MACHINE_IDENTITY_VERSION,
    identity_scheme: IDENTITY_SCHEME,
    active_machine_code: active,
    legacy_machine_code: "",
    candidate_machine_code: active,
    source_type: hardware.sourceType,
    hardware_digest: deriveHardwareDigest(appName, hardware.normalizedId),
    compatibility_mode: false,
    hardware_match: true,
    machine_identity_mismatch: false,
    hardware_read_status: "ok",
    created_at: timestamp,
    updated_at: timestamp,
  };
  // Never expose a first-install code before both durable caches are saved.
  await persistIdentity(secureStore, identity, { requirePersistence: true });
  return identity;
}

// Enforced only for identities created under the new scheme. Old mismatches
// still go through the existing credential/canonical server compatibility path.
export function assertMachineIdentityUsable(identity) {
  if (identity?.identity_scheme === IDENTITY_SCHEME && identity.machine_identity_mismatch === true) {
    throw machineIdentityError("MACHINE_IDENTITY_MISMATCH",
      "本机设备标识与已保存的机器身份不一致；原机器码和授权已保留，请联系管理员核对，软件未自动换码或换绑");
  }
}

export async function createStableMachineIdentity({
  appName,
  secureStore,
  platform = process.platform,
  hardwareIdProvider = platformHardwareId,
  legacyHardwareIdProvider = hardwareIdProvider === platformHardwareId ? legacyPlatformHardwareId : hardwareIdProvider,
  recoverMachineCode = null,
  now = Date.now,
} = {}) {
  if (!secureStore || typeof secureStore !== "object") throw new Error("机器身份安全存储不可用");
  let pending = identityPromises.get(secureStore);
  if (!pending) {
    pending = buildMachineIdentity({ appName, secureStore, platform, hardwareIdProvider, legacyHardwareIdProvider, recoverMachineCode, now });
    identityPromises.set(secureStore, pending);
    pending.catch(() => identityPromises.delete(secureStore));
  }
  return pending;
}

export async function createStableMachineCode(options = {}) {
  return (await createStableMachineIdentity(options)).active_machine_code;
}

export function publicMachineIdentity(identity) {
  const machineCode = validMachineCode(identity?.active_machine_code);
  return {
    maskedMachineCode: machineCode ? `${machineCode.slice(0, 11)}…${machineCode.slice(-6)}` : "不可用",
    sourceType: String(identity?.source_type || "unknown"),
    compatibilityMode: Boolean(identity?.compatibility_mode),
    readStatus: String(identity?.hardware_read_status || "unknown"),
    hardwareMatch: identity?.machine_identity_mismatch === true ? "mismatch" : identity?.hardware_match === true ? "match" : "unknown",
    message: identity?.machine_identity_mismatch === true
      ? "检测到本机机器身份与历史授权缓存不一致。为保护现有授权，软件未自动替换机器码，请联系管理员处理。"
      : "",
  };
}

// Repair builds a candidate in an isolated store; the live identity is untouched.
export async function createFreshMachineIdentity(options = {}) {
  const scratch = {
    readMachineIdentity: async () => null, readMachineCode: async () => "",
    readCredential: async () => null, readMachineSeed: async () => "",
    writeMachineIdentity: async () => {}, writeMachineCode: async () => {},
  };
  return createStableMachineIdentity({ ...options, secureStore: scratch });
}

export function invalidateMachineIdentity(secureStore) {
  identityPromises.delete(secureStore);
}
