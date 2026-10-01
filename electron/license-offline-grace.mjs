import { createHmac, timingSafeEqual } from "node:crypto";

export const OFFLINE_GRANT_SCHEMA_VERSION = 1;
export const OFFLINE_DAY_MS = 24 * 60 * 60 * 1000;
export const OFFLINE_CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1000;

function parseTime(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizedLicense(license) {
  return {
    bindingStatus: String(license?.bindingStatus || "").trim().toLowerCase(),
    licenseType: String(license?.licenseType || "").trim(),
    durationDays: Number(license?.durationDays || 0),
    activatedAt: license?.activatedAt || null,
    expiresAt: license?.expiresAt || null,
    baseExpiresAt: license?.baseExpiresAt || null,
    vipExpiresAt: license?.entitlementSchemaVersion >= 1 ? license?.vipExpiresAt || null : null,
    basePermanent: license?.entitlementSchemaVersion >= 1 && license?.basePermanent === true,
    entitlementSchemaVersion: Number(license?.entitlementSchemaVersion || 0),
    remainingDays: Number(license?.remainingDays || 0),
    transferCount: Number(license?.transferCount || 0),
  };
}

function baseExpiry(license) {
  return license?.entitlementSchemaVersion >= 1 ? license.baseExpiresAt : license?.expiresAt;
}

function isEligibleTimeLicense(license) {
  const type = String(license?.licenseType || "").trim().toLowerCase();
  if (license?.bindingStatus !== "active") return false;
  if (license?.entitlementSchemaVersion >= 1 && license?.basePermanent === true) return true;
  return Boolean(
    type
    && Number.isFinite(license?.durationDays)
    && license.durationDays > 0
    && Boolean(license?.activatedAt)
    && Number.isFinite(parseTime(baseExpiry(license)))
    && !/(point|credit|score|积分|无限|unlimited|permanent|forever)/i.test(type));
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function keyedDigest(key, label, value) {
  return createHmac("sha256", key)
    .update(`ai-media-library-offline-v1\0${label}\0`, "utf8")
    .update(String(value || ""), "utf8")
    .digest("hex");
}

function credentialBinding(key, credential) {
  return keyedDigest(
    key,
    "credential",
    `${credential?.deviceSession || ""}\0${credential?.deviceCredential || ""}`,
  );
}

function signPayload(key, payload) {
  return createHmac("sha256", key)
    .update("ai-media-library-offline-grant-v1\0", "utf8")
    .update(canonicalize(payload), "utf8")
    .digest("hex");
}

function signaturesMatch(key, payload, signature) {
  if (!/^[a-f0-9]{64}$/i.test(String(signature || ""))) return false;
  const expected = Buffer.from(signPayload(key, payload), "hex");
  const supplied = Buffer.from(String(signature), "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function localDayKey(nowMs) {
  const date = new Date(nowMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function remainingDays(deadlineMs, nowMs) {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / OFFLINE_DAY_MS));
}

export function createOfflineGrant({
  key,
  appName,
  machineCode,
  credential,
  license,
  nowMs,
  graceDays,
}) {
  const publicLicense = normalizedLicense(license);
  const expiresAtMs = publicLicense.basePermanent ? Infinity : parseTime(baseExpiry(publicLicense));
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("离线授权签名密钥无效");
  if (!appName || !machineCode || !credential?.codeId || !credential?.deviceSession || !credential?.deviceCredential) {
    throw new Error("离线授权绑定信息不完整");
  }
  if (!isEligibleTimeLicense(publicLicense)) throw new Error("当前授权不能建立离线宽限");
  const safeGraceDays = Math.max(0, Math.floor(Number(graceDays) || 0));
  const deadlineMs = Math.min(nowMs + safeGraceDays * OFFLINE_DAY_MS, expiresAtMs);
  if (deadlineMs <= nowMs) throw new Error("当前授权已经到期");
  const payload = {
    schemaVersion: OFFLINE_GRANT_SCHEMA_VERSION,
    appName,
    codeId: String(credential.codeId),
    machineBinding: keyedDigest(key, "machine", machineCode),
    credentialBinding: credentialBinding(key, credential),
    lastValidatedAt: new Date(nowMs).toISOString(),
    lastSeenAt: new Date(nowMs).toISOString(),
    graceUntil: new Date(deadlineMs).toISOString(),
    displayDay: localDayKey(nowMs),
    displayRemainingDays: remainingDays(deadlineMs, nowMs),
    license: publicLicense,
  };
  return { payload, signature: signPayload(key, payload) };
}

export function verifyAndAdvanceOfflineGrant({
  envelope,
  key,
  appName,
  machineCode,
  credential,
  nowMs,
  graceDays,
}) {
  try {
    const payload = envelope?.payload;
    if (!payload || !Buffer.isBuffer(key) || key.length !== 32) return { ok: false, reason: "missing" };
    if (!signaturesMatch(key, payload, envelope.signature)) return { ok: false, reason: "signature" };
    if (payload.schemaVersion !== OFFLINE_GRANT_SCHEMA_VERSION || payload.appName !== appName) {
      return { ok: false, reason: "scope" };
    }
    if (!credential?.codeId || String(credential.codeId) !== String(payload.codeId)) return { ok: false, reason: "binding" };
    if (payload.machineBinding !== keyedDigest(key, "machine", machineCode)) return { ok: false, reason: "binding" };
    if (payload.credentialBinding !== credentialBinding(key, credential)) return { ok: false, reason: "binding" };

    const license = normalizedLicense(payload.license);
    if (!isEligibleTimeLicense(license)) return { ok: false, reason: "license" };
    const lastValidatedMs = parseTime(payload.lastValidatedAt);
    const lastSeenMs = parseTime(payload.lastSeenAt);
    const expiresAtMs = license.basePermanent ? Infinity : parseTime(baseExpiry(license));
    if (![lastValidatedMs, lastSeenMs].every(Number.isFinite) || !(Number.isFinite(expiresAtMs) || expiresAtMs === Infinity)) return { ok: false, reason: "time" };
    if (nowMs + OFFLINE_CLOCK_ROLLBACK_TOLERANCE_MS < lastSeenMs) return { ok: false, reason: "clock_rollback" };

    const safeGraceDays = Math.max(0, Math.floor(Number(graceDays) || 0));
    const deadlineMs = Math.min(lastValidatedMs + safeGraceDays * OFFLINE_DAY_MS, expiresAtMs);
    if (nowMs >= deadlineMs) return { ok: false, reason: "expired" };

    const currentDay = localDayKey(nowMs);
    const displayRemainingDays = payload.displayDay === currentDay
      ? Math.max(1, Math.floor(Number(payload.displayRemainingDays) || 1))
      : remainingDays(deadlineMs, nowMs);
    const advancedPayload = {
      ...payload,
      lastSeenAt: new Date(Math.max(nowMs, lastSeenMs)).toISOString(),
      graceUntil: new Date(deadlineMs).toISOString(),
      displayDay: currentDay,
      displayRemainingDays,
      license,
    };
    return {
      ok: true,
      envelope: { payload: advancedPayload, signature: signPayload(key, advancedPayload) },
      license,
      remainingDays: displayRemainingDays,
      graceUntil: advancedPayload.graceUntil,
      lastValidatedAt: advancedPayload.lastValidatedAt,
    };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
