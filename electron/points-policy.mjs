export const PLATFORM_POINTS_FEATURES = Object.freeze([
  "schemes", "classifier", "subtitle-removal", "voice", "prompt-library",
]);

// Billing follows each task's API source. The server must verify the same
// source; a client-side decision never authorizes a central-ledger debit.
export const POINTS_POLICY = Object.freeze({
  schemaVersion: 1,
  appName: "ai-media-library",
  walletAuthority: "server",
  walletScope: "account",
  sharedAcrossEntitlements: true,
  apiPaymentMode: "per_task",
  defaultApiMode: "auto",
  platformApiAvailable: false,
  rechargePointsPerCny: 100,
  platformCostPointsPerCny: 200,
  fractionalPointPrecision: 6,
});

export const CURRENT_API_BILLING_NOTICE = "自接 API 由供应商扣费；内置 API 扣软件积分。";
export const CURRENT_PLATFORM_API_NOTICE = "内置 API 暂未开放。";

export function resolveTaskApiMode({ apiMode = POINTS_POLICY.defaultApiMode, customerApiConfigured = false,
  platformApiReady = POINTS_POLICY.platformApiAvailable } = {}) {
  if (!["auto", "customer_api", "platform_api"].includes(apiMode)) {
    throw Object.assign(new Error("API 使用模式无效"), { code: "INVALID_API_PAYMENT_MODE" });
  }
  // A configured customer API remains selected even when its request fails.
  // Failure must never silently turn an unpaid task into a points task.
  if (apiMode === "customer_api" || (apiMode === "auto" && customerApiConfigured === true)) {
    return { apiPaymentMode: "customer_api", ready: customerApiConfigured === true,
      usesSoftwarePoints: false, reason: customerApiConfigured === true ? null : "CUSTOMER_API_REQUIRED" };
  }
  return { apiPaymentMode: "platform_api", ready: platformApiReady === true,
    usesSoftwarePoints: platformApiReady === true,
    reason: platformApiReady === true ? null : "PLATFORM_API_UNAVAILABLE" };
}

export function requirePlatformPointConsumption(featureId, { apiPaymentMode,
  platformApiReady = POINTS_POLICY.platformApiAvailable, serverEnabled } = {}) {
  if (apiPaymentMode !== "platform_api" || platformApiReady !== true || serverEnabled !== true
    || !PLATFORM_POINTS_FEATURES.includes(featureId)) {
    const error = new Error(CURRENT_API_BILLING_NOTICE);
    error.code = "POINTS_CONSUMPTION_DISABLED";
    throw error;
  }
}
