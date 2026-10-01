const INVALID_CANONICAL_VALUES = new Set([
  "TOBEFILLEDBYOEM",
  "DEFAULTSTRING",
  "SYSTEMSERIALNUMBER",
  "NONE",
  "NOTSPECIFIED",
]);

function safeString(value) {
  try {
    return String(value ?? "");
  } catch {
    return "";
  }
}

export function normalizeFactorValue(value) {
  return safeString(value)
    .trim()
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function inspectFactorValue(value) {
  const normalized = normalizeFactorValue(value);
  let reason = "valid";

  if (!normalized) reason = "empty";
  else if (normalized.length < 6) reason = "too_short";
  else if (/^0+$/.test(normalized)) reason = "all_zero";
  else if (/^F+$/.test(normalized)) reason = "all_f";
  else if (INVALID_CANONICAL_VALUES.has(normalized)) reason = "placeholder";

  return Object.freeze({
    normalized: reason === "valid" ? normalized : "",
    valid: reason === "valid",
    reason,
  });
}

export function isValidFactorValue(value) {
  return inspectFactorValue(value).valid;
}

export const INVALID_FACTOR_CANONICAL_VALUES = Object.freeze([
  ...INVALID_CANONICAL_VALUES,
]);
