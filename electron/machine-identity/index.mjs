import { createHmac, timingSafeEqual } from "node:crypto";
import { factorWeightMap } from "./hash.mjs";

// The v3 identity is an observation of the machine, never an authorization
// input. Nothing in this module may block startup, alter the v2 machine code,
// or touch the offline grace grant.

export const IDENTITY_CACHE_SCHEMA_VERSION = 1;
export const IDENTITY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const IDENTITY_HMAC_DOMAIN = "identity_v3";

// Only these factors can ever prove "this is the same machine". Weak factors
// (model, MAC) may support a match but can never establish one on their own.
const STRONG_FACTORS = Object.freeze({
  win32: Object.freeze(["machine_guid", "bios_uuid", "system_disk_serial"]),
  darwin: Object.freeze(["io_platform_uuid", "io_platform_serial_number"]),
});

export const MINIMUM_STRONG_FACTORS = 2;

const HASH_PATTERN = /^[a-f0-9]{32}$/;
const V3_CODE_PATTERN = /^v3_[a-f0-9]{64}$/;
const CANONICAL_CODE_PATTERN = /^v[23]_[a-f0-9]{64}$/;

function supportedPlatform(platform) {
  return platform === "win32" || platform === "darwin" ? platform : "";
}

function validHash(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return HASH_PATTERN.test(normalized) ? normalized : "";
}

export function validCanonicalMachineCode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return CANONICAL_CODE_PATTERN.test(normalized) ? normalized : "";
}

function validCandidateCode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return V3_CODE_PATTERN.test(normalized) ? normalized : "";
}

export function strongFactorNames(platform) {
  return STRONG_FACTORS[supportedPlatform(platform)] || Object.freeze([]);
}

export function countStrongFactors(result) {
  const names = strongFactorNames(result?.platform);
  let count = 0;
  for (const name of names) {
    if (validHash(result?.factor_hashes?.[name])) count += 1;
  }
  return count;
}

// Canonical JSON so the cache signature does not depend on key order.
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function signPayload(key, payload) {
  return createHmac("sha256", key)
    .update(IDENTITY_HMAC_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(canonicalize(payload), "utf8")
    .digest("hex");
}

function signaturesMatch(key, payload, signature) {
  const provided = Buffer.from(String(signature || ""), "hex");
  const expected = Buffer.from(signPayload(key, payload), "hex");
  if (provided.length !== expected.length || expected.length === 0) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Strip the collector result down to what may leave this machine.
 *
 * Two things are deliberately dropped:
 *  - raw hardware values never exist here at all (the collectors discard them)
 *  - `factor_status[].weight` is the CLIENT weight table; the server decides
 *    weights on its own and must never be handed a client-supplied number.
 */
export function buildIdentityPayload(result) {
  const platform = supportedPlatform(result?.platform);
  if (!platform || Number(result?.version) !== 3) return null;

  const strongCount = countStrongFactors(result);
  // No strong factor means we learned nothing useful. Reporting an all-weak
  // payload invites the server to treat a partial read as a different device.
  if (strongCount === 0) return null;
  if (result?.collection?.timed_out === true) return null;

  const factors = {};
  for (const name of Object.keys(factorWeightMap(platform))) {
    const hash = validHash(result?.factor_hashes?.[name]);
    factors[name] = hash
      ? { hash }
      : { hash: null, reason: String(result?.factor_status?.[name]?.source || "unavailable") };
  }

  return {
    version: 3,
    platform,
    candidate_machine_code: validCandidateCode(result?.candidate_machine_code),
    factors,
    collection: {
      duration_ms: Number(result?.collection?.duration_ms) || 0,
      fallback_used: Boolean(result?.collection?.fallback_used),
      timed_out: Boolean(result?.collection?.timed_out),
    },
    low_confidence: strongCount < MINIMUM_STRONG_FACTORS,
  };
}

/** Diagnostic view. Hash prefixes only, never a raw value. */
export function publicIdentityDiagnostics({ result, canonical = null, phase = "off", assessment = null } = {}) {
  const platform = supportedPlatform(result?.platform);
  const weights = factorWeightMap(platform);
  const strongNames = strongFactorNames(platform);
  const factors = Object.keys(weights).map((name) => {
    const hash = validHash(result?.factor_hashes?.[name]);
    return {
      name,
      collected: Boolean(hash),
      strong: strongNames.includes(name),
      source: String(result?.factor_status?.[name]?.source || "unavailable"),
      hashPrefix: hash ? hash.slice(0, 6) : "",
      referenceWeight: weights[name],
    };
  });

  const candidate = validCandidateCode(result?.candidate_machine_code);
  return {
    available: Boolean(platform),
    platform: platform || "unsupported",
    factors,
    strongFactorCount: countStrongFactors(result),
    minimumStrongFactors: MINIMUM_STRONG_FACTORS,
    candidateCodePrefix: candidate ? candidate.slice(0, 9) : "",
    canonicalCodePrefix: validCanonicalMachineCode(canonical) ? String(canonical).slice(0, 9) : "",
    collection: {
      durationMs: Number(result?.collection?.duration_ms) || 0,
      fallbackUsed: Boolean(result?.collection?.fallback_used),
      timedOut: Boolean(result?.collection?.timed_out),
    },
    phase: String(phase || "off"),
    // Detailed scores are only ever shown before enforce. Once enforcement is
    // live an exact score becomes a tuning oracle: an attacker can vary one
    // factor at a time and read the threshold and weights back off the number.
    assessment: presentableAssessment(phase, assessment),
  };
}

export function presentableAssessment(phase, assessment) {
  if (!assessment || typeof assessment !== "object") return null;
  const state = String(assessment.state || "unknown");
  if (String(phase) === "enforce") {
    return { state, detailed: false };
  }
  return {
    state,
    detailed: true,
    scoreNumerator: Number(assessment.scoreNumerator) || 0,
    scoreDenominator: Number(assessment.scoreDenominator) || 0,
    threshold: Number(assessment.threshold) || 0,
    matchedFactors: Array.isArray(assessment.matchedFactors) ? [...assessment.matchedFactors] : [],
    conflictingFactors: Array.isArray(assessment.conflictingFactors) ? [...assessment.conflictingFactors] : [],
  };
}

export function createIdentityCacheEnvelope({ key, appName, result, clientVersion, nowMs }) {
  const payload = {
    schemaVersion: IDENTITY_CACHE_SCHEMA_VERSION,
    appName: String(appName || ""),
    clientVersion: String(clientVersion || ""),
    collectedAt: new Date(Number(nowMs) || Date.now()).toISOString(),
    result,
  };
  return { payload, signature: signPayload(key, payload) };
}

export function readIdentityCacheEnvelope({ envelope, key, appName, clientVersion, nowMs, maxAgeMs = IDENTITY_CACHE_MAX_AGE_MS }) {
  try {
    const payload = envelope?.payload;
    if (!payload || !Buffer.isBuffer(key) || key.length !== 32) return { ok: false, reason: "missing" };
    if (!signaturesMatch(key, payload, envelope.signature)) return { ok: false, reason: "signature" };
    if (payload.schemaVersion !== IDENTITY_CACHE_SCHEMA_VERSION) return { ok: false, reason: "schema" };
    if (payload.appName !== String(appName || "")) return { ok: false, reason: "scope" };
    if (String(payload.clientVersion || "") !== String(clientVersion || "")) return { ok: false, reason: "stale_version" };

    const collectedAtMs = Date.parse(String(payload.collectedAt || ""));
    if (!Number.isFinite(collectedAtMs)) return { ok: false, reason: "time" };
    const now = Number(nowMs) || Date.now();
    // A cache written in the future means the clock moved; re-collect instead
    // of trusting it.
    if (collectedAtMs > now + 60_000) return { ok: false, reason: "clock_rollback" };
    if (now - collectedAtMs > maxAgeMs) return { ok: false, reason: "expired" };
    if (Number(payload.result?.version) !== 3) return { ok: false, reason: "invalid" };

    return { ok: true, reason: "ok", result: payload.result, collectedAt: payload.collectedAt };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
