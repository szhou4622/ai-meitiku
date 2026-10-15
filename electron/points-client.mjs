export const POINTS_APP_NAME = "ai-media-library";
export const POINTS_UNIT_SCALE = 1_000_000;

const MESSAGES = Object.freeze({
  APP_SCOPE_MISMATCH: "积分请求的应用标识不匹配，请更新客户端。",
  APP_CREDENTIAL_MISMATCH: "当前设备凭证不属于媒体库，请重新验证设备授权。",
  DEVICE_AUTH_FAILED: "设备验证未通过，请在授权管理中重新验证。",
  DEVICE_CHANGED: "设备绑定已变更，请重新验证设备授权。",
  LICENSE_DISABLED: "当前授权已停用，请联系管理员。",
  REDEEM_CODE_NOT_FOUND: "积分码无效，请核对后重试。",
  REDEEM_CODE_USED: "积分码已被其他账户兑换。",
  INVALID_REDEEM_CODE: "请输入有效的媒体库积分码。",
  IDEMPOTENCY_CONFLICT: "兑换请求冲突，请保留原积分码并联系管理员。",
  LEGACY_BALANCE_REVIEW_REQUIRED: "历史积分余额需管理员核对后迁移。",
  LEGACY_CODE_REVIEW_REQUIRED: "该旧码需管理员核对，不能直接作为积分码兑换。",
  SETTLEMENT_UNAVAILABLE: "积分服务暂时不可用，请稍后刷新。",
});

export function pointsError(code, fallback = "积分请求未完成，请稍后重试。") {
  const error = new Error(MESSAGES[code] || fallback);
  error.code = code || "POINTS_REQUEST_FAILED";
  return error;
}

export function normalizePointsCode(input) {
  if (typeof input !== "string") throw pointsError("INVALID_REDEEM_CODE");
  const code = input.trim().toUpperCase();
  if (!/^(?:AIML-P-[A-Z0-9]{24,64}|AIM-(?:[A-Z0-9]{4}-){2}[A-Z0-9]{4})$/.test(code)) throw pointsError("INVALID_REDEEM_CODE");
  return code;
}

export function pointsPayload(action, input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw pointsError("INVALID_POINTS_ARGUMENTS");
  const keys = action === "balance" ? [] : action === "transactions" ? ["beforeSequence", "limit"] : action === "redeem" ? ["code"] : null;
  if (!keys || Object.keys(input).some(key => !keys.includes(key))) throw pointsError("INVALID_POINTS_ARGUMENTS");
  const payload = { app_name: POINTS_APP_NAME };
  if (action === "redeem") payload.code = normalizePointsCode(input.code);
  if (action === "transactions") {
    const limit = input.limit ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw pointsError("INVALID_POINTS_ARGUMENTS");
    payload.limit = limit;
    if (input.beforeSequence !== undefined && input.beforeSequence !== null) {
      if (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence <= 0) throw pointsError("INVALID_POINTS_ARGUMENTS");
      payload.before_sequence = input.beforeSequence;
    }
  }
  return payload;
}

export function formatPointUnits(units, signed = false) {
  if (!Number.isSafeInteger(units)) return "—";
  const value = BigInt(units);
  const magnitude = value < 0 ? -value : value;
  const fraction = String(magnitude % BigInt(POINTS_UNIT_SCALE)).padStart(6, "0").replace(/0+$/, "");
  const prefix = value < 0 ? "−" : signed && value > 0 ? "+" : "";
  return `${prefix}${magnitude / BigInt(POINTS_UNIT_SCALE)}${fraction ? `.${fraction}` : ""}`;
}

export function decodePointsResponse(body, action) {
  const invalid = () => { throw pointsError("INVALID_POINTS_RESPONSE", "无法确认服务器积分数据，请刷新后重试。"); };
  if (!body || body.ok !== true || body.app_name !== POINTS_APP_NAME || body.unit_scale !== POINTS_UNIT_SCALE) invalid();
  for (const field of ["balance_units", "reserved_units", "available_units"]) {
    if (!Number.isSafeInteger(body[field]) || body[field] < 0 || body[field] > 1e15) invalid();
  }
  if (body.balance_units - body.reserved_units !== body.available_units) invalid();
  const result = {
    appName: POINTS_APP_NAME, balanceUnits: body.balance_units, reservedUnits: body.reserved_units,
    availableUnits: body.available_units, unitScale: POINTS_UNIT_SCALE,
  };
  if (action === "redeem") {
    if (typeof body.idempotent !== "boolean") invalid();
    result.idempotent = body.idempotent;
  }
  if (action === "transactions") {
    if (!Array.isArray(body.items) || body.items.length > 100) invalid();
    let previous = Number.MAX_SAFE_INTEGER;
    result.items = body.items.map(item => {
      if (!item || !Number.isSafeInteger(item.sequence) || item.sequence <= 0 || item.sequence >= previous
        || !["recharge", "reserve", "commit", "release"].includes(item.kind)
        || !Number.isSafeInteger(item.delta_units) || Math.abs(item.delta_units) > 1e15
        || !Number.isSafeInteger(item.balance_units) || item.balance_units < 0 || item.balance_units > 1e15
        || typeof item.created_at !== "string" || !Number.isFinite(Date.parse(item.created_at))
        || (item.task_id !== null && !/^[a-f0-9]{40}$/.test(item.task_id || ""))) invalid();
      previous = item.sequence;
      return { sequence: item.sequence, kind: item.kind, deltaUnits: item.delta_units,
        balanceUnits: item.balance_units, taskId: item.task_id, createdAt: item.created_at };
    });
    if (body.next_before_sequence !== (result.items.at(-1)?.sequence ?? null)) invalid();
    result.nextBeforeSequence = body.next_before_sequence;
  }
  return result;
}
