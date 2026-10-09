import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  canAccessFeature,
  canDiscoverFeature,
  createFeatureRegistry,
  featureDefinitions,
  featureRegistry,
  registerVipFeature,
  requireFeatureAccess,
  resolveEntitlements,
} from "../electron/feature-registry.mjs";
import { protectedIpcHandler } from "../electron/feature-guard.mjs";

const now = Date.parse("2026-09-22T00:00:00Z");
const later = (days) => new Date(now + days * 86_400_000).toISOString();
const state = (baseDays, vipDays = null, phase = "active", offlineDays = null) => ({
  phase,
  authorized: true,
  ...(offlineDays === null ? {} : { offlineUntil: later(offlineDays) }),
  license: {
    entitlementSchemaVersion: 1,
    baseExpiresAt: later(baseDays),
    vipExpiresAt: vipDays === null ? null : later(vipDays),
  },
});

test("subtitle removal appears immediately above the prompt library", () => {
  const ids = featureRegistry.list().map(feature => feature.id);
  assert.equal(ids.indexOf("subtitle-removal"), ids.indexOf("prompt-library") - 1);
});

test("published VIP features inherit one registered group without per-user grants", () => {
  const registry = createFeatureRegistry([
    ...featureDefinitions,
    registerVipFeature({ id: "temporary-vip", label: "测试功能", enabled: true, ipcPrefixes: ["temporary-vip-"] }),
  ]);
  const child = registry.forIpc("temporary-vip-child-create");
  assert.equal(child?.id, "temporary-vip");
  assert.equal(canAccessFeature(registry, child.id, state(300, 30), now), true);
  assert.equal(canAccessFeature(registry, child.id, state(300), now), false);
  assert.throws(() => requireFeatureAccess(registry, child.id, state(300), now), /无权/);
  assert.equal(canAccessFeature(registry, child.id, state(300, 0), now), false);
  assert.equal(canAccessFeature(registry, child.id, state(300, 30, "offline_active", 0), now), false);
  assert.equal(canDiscoverFeature(registry, child.id, state(300), now), true);
  assert.equal(canDiscoverFeature(registry, child.id, state(0), now), false);
});

test("a temporary VIP child execution route is denied before side effects", async () => {
  const registry = createFeatureRegistry([
    ...featureDefinitions,
    registerVipFeature({ id: "temporary-vip", label: "测试功能", enabled: true, ipcPrefixes: ["temporary-vip-"] }),
  ]);
  let current = state(300);
  let writes = 0;
  const service = { assertFeature(featureId) { requireFeatureAccess(registry, featureId, current, now); } };
  const invoke = protectedIpcHandler(registry, "temporary-vip-child-write", () => service, async () => { writes += 1; });
  await assert.rejects(invoke(null, { featureId: "media" }), /无权/);
  assert.equal(writes, 0);
  current = state(300, 30);
  await invoke();
  assert.equal(writes, 1);
  current = state(300, 0);
  await assert.rejects(invoke(), /无权/);
  assert.equal(writes, 1);
  assert.throws(() => protectedIpcHandler(registry, "unregistered-write", () => service, () => {}), /未注册/);
});

test("free modules remain available after VIP expiry, but base expiry blocks both groups", () => {
  assert.equal(resolveEntitlements(state(300, 0), now).base, true);
  assert.equal(canAccessFeature(featureRegistry, "media", state(300, 0), now), true);
  assert.equal(canAccessFeature(featureRegistry, "viral-visuals", state(300, 0), now), false);
  assert.equal(canAccessFeature(featureRegistry, "viral-copy", state(300, 0), now), false);
  assert.equal(canAccessFeature(featureRegistry, "media", state(0, 30), now), false);
  assert.equal(canAccessFeature(featureRegistry, "viral-copy", state(0, 30), now), false);
  assert.equal(canDiscoverFeature(featureRegistry, "viral-visuals", state(300, 0), now), true);
  assert.equal(canDiscoverFeature(featureRegistry, "viral-copy", state(300, 0), now), true);
  assert.equal(canDiscoverFeature(featureRegistry, "viral-copy", state(0, 30), now), false);
});

test("legacy caches never imply VIP; unknown, disabled, or unowned entrypoints fail closed", () => {
  const legacy = { authorized: true, phase: "active", license: { expiresAt: later(30) } };
  assert.equal(canAccessFeature(featureRegistry, "media", legacy, now), true);
  assert.equal(canAccessFeature(featureRegistry, "viral-copy", legacy, now), false);
  assert.equal(canAccessFeature(featureRegistry, "not-registered", state(30, 30), now), false);
  assert.equal(featureRegistry.forIpc("not-registered-write"), null);
  assert.throws(() => requireFeatureAccess(featureRegistry, "not-registered", state(30, 30), now), /未注册/);
  assert.throws(() => createFeatureRegistry([{ id: "bad", enabled: true }]), /缺失归属/);
  assert.throws(() => createFeatureRegistry([
    ...featureDefinitions,
    registerVipFeature({ id: "bad-prefix", enabled: true, ipcPrefixes: ["media-special-"] }),
  ]), /前缀冲突/);
  const disabled = createFeatureRegistry([registerVipFeature({ id: "disabled", enabled: false })]);
  assert.equal(canAccessFeature(disabled, "disabled", state(30, 30), now), false);
  assert.equal(canDiscoverFeature(disabled, "disabled", state(30, 30), now), false);
});

test("every declared production IPC route resolves to exactly one feature", () => {
  for (const definition of featureDefinitions) {
    for (const channel of definition.ipcChannels || []) assert.equal(featureRegistry.forIpc(channel)?.id, definition.id);
  }
  assert.equal(featureRegistry.forIpc("viral-library-authorize-write")?.id, "viral-visuals");
  assert.equal(featureRegistry.forIpc("viral-copy-save")?.id, "viral-copy");
  assert.equal(featureRegistry.forIpc("media-save-library")?.id, "media");
});

test("subtitle and prompt workflows inherit VIP across every actual protected IPC operation", async () => {
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const channels = [...main.matchAll(/registerProtectedHandle\("((?:aliyun-subtitle-|prompt-library-)[^"]+)"/g)].map(match => match[1]);
  assert.ok(channels.length >= 30, "actual workflow IPC routes must be inspected");
  for (const channel of channels) {
    const feature = featureRegistry.forIpc(channel);
    assert.equal(feature.group, "vip", channel);
    assert.equal(canDiscoverFeature(featureRegistry, feature.id, state(300), now), true, channel);
    let current = state(300);
    let executions = 0;
    const handler = protectedIpcHandler(featureRegistry, channel, () => ({
      assertFeature(id) { requireFeatureAccess(featureRegistry, id, current, now); },
    }), () => { executions++; });
    await assert.rejects(handler(null, { featureId: "media", isVip: true }), /无权/, channel);
    assert.equal(executions, 0);
    current = state(300, 30);
    await handler();
    assert.equal(executions, 1);
    for (const denied of [state(300, 0), state(300), state(300, 30, "offline_active", 0), { ...state(300, 30), authorized: false }]) {
      current = denied;
      await assert.rejects(handler(), /无权/);
    }
    current = state(300, 30, "offline_active", 7);
    await handler();
    assert.equal(executions, 2);
  }
  for (const id of ["media", "qianchuan-videos", "downloads", "voice", "schemes", "classifier", "settings"]) {
    assert.equal(canAccessFeature(featureRegistry, id, state(300, 0), now), true, id);
  }
});
