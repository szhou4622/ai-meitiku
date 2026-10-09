import test from "node:test";
import assert from "node:assert/strict";
import { PLATFORM_POINTS_FEATURES, POINTS_POLICY, resolveTaskApiMode, requirePlatformPointConsumption } from "../electron/points-policy.mjs";

test("configured customer API takes precedence and cannot debit the software wallet", () => {
  const task = resolveTaskApiMode({ customerApiConfigured: true, platformApiReady: true });
  assert.equal(task.apiPaymentMode, "customer_api");
  assert.equal(task.usesSoftwarePoints, false);
  for (const feature of PLATFORM_POINTS_FEATURES) {
    assert.throws(() => requirePlatformPointConsumption(feature,
      { ...task, platformApiReady: true, serverEnabled: true }), { code: "POINTS_CONSUMPTION_DISABLED" });
  }
});

test("missing customer API cannot consume points before the built-in API is available", () => {
  const task = resolveTaskApiMode();
  assert.equal(task.apiPaymentMode, "platform_api");
  assert.equal(task.ready, false);
  assert.equal(task.usesSoftwarePoints, false);
  assert.equal(task.reason, "PLATFORM_API_UNAVAILABLE");
  assert.throws(() => requirePlatformPointConsumption("classifier", { ...task, serverEnabled: true }),
    { code: "POINTS_CONSUMPTION_DISABLED" });
});

test("future built-in API tasks require a ready API and server billing permission", () => {
  const task = resolveTaskApiMode({ platformApiReady: true });
  assert.equal(task.apiPaymentMode, "platform_api");
  assert.equal(task.ready, true);
  assert.equal(task.usesSoftwarePoints, true);
  for (const feature of PLATFORM_POINTS_FEATURES) {
    assert.throws(() => requirePlatformPointConsumption(feature, { ...task, platformApiReady: true }),
      { code: "POINTS_CONSUMPTION_DISABLED" });
    assert.doesNotThrow(() => requirePlatformPointConsumption(feature,
      { ...task, platformApiReady: true, serverEnabled: true }));
  }
  for (const feature of ["feigua-trends", "downloads", "viral-copy", "viral-visuals", "unknown"]) {
    assert.throws(() => requirePlatformPointConsumption(feature,
      { ...task, platformApiReady: true, serverEnabled: true }), { code: "POINTS_CONSUMPTION_DISABLED" });
  }
});

test("explicit customer API choice never silently falls back to paid platform API", () => {
  const task = resolveTaskApiMode({ apiMode: "customer_api", customerApiConfigured: false, platformApiReady: true });
  assert.equal(task.apiPaymentMode, "customer_api");
  assert.equal(task.ready, false);
  assert.equal(task.usesSoftwarePoints, false);
  assert.equal(task.reason, "CUSTOMER_API_REQUIRED");
  assert.throws(() => resolveTaskApiMode({ apiMode: "invalid" }), { code: "INVALID_API_PAYMENT_MODE" });
});

test("explicit platform API choice remains separate from configured customer credentials", () => {
  const task = resolveTaskApiMode({ apiMode: "platform_api", customerApiConfigured: true, platformApiReady: true });
  assert.equal(task.apiPaymentMode, "platform_api");
  assert.equal(task.usesSoftwarePoints, true);
});

test("billing defaults and eligible features are immutable", () => {
  assert.throws(() => { POINTS_POLICY.platformApiAvailable = true; }, TypeError);
  assert.throws(() => { PLATFORM_POINTS_FEATURES.push("downloads"); }, TypeError);
});
