import assert from "node:assert/strict";
import test from "node:test";
import {
  OFFLINE_DAY_MS,
  createOfflineGrant,
  localDayKey,
  verifyAndAdvanceOfflineGrant,
} from "../electron/license-offline-grace.mjs";
import { resolveEntitlements } from "../electron/feature-registry.mjs";

const key = Buffer.alloc(32, 0x37);
const appName = "ai-media-library";
const machineCode = `v2_${"a".repeat(64)}`;
const credential = {
  codeId: "code-1",
  deviceSession: "session-must-never-be-cached",
  deviceCredential: "credential-must-never-be-cached",
};

function localTime(day, hour = 10) {
  return new Date(2026, 8, day, hour, 0, 0, 0).getTime();
}

function license(expiresAt = new Date(localTime(30)).toISOString()) {
  return {
    bindingStatus: "active",
    licenseType: "monthly",
    durationDays: 30,
    activatedAt: new Date(localTime(1)).toISOString(),
    expiresAt,
    remainingDays: 15,
    transferCount: 0,
  };
}

function create(nowMs = localTime(15), overrides = {}) {
  return createOfflineGrant({
    key,
    appName,
    machineCode,
    credential,
    license: license(),
    nowMs,
    graceDays: 7,
    ...overrides,
  });
}

function verify(envelope, nowMs, overrides = {}) {
  return verifyAndAdvanceOfflineGrant({
    envelope,
    key,
    appName,
    machineCode,
    credential,
    nowMs,
    graceDays: 7,
    ...overrides,
  });
}

test("creates a signed seven-day grant without caching raw device secrets", () => {
  const nowMs = localTime(15);
  const envelope = create(nowMs);
  const serialized = JSON.stringify(envelope);

  assert.equal(envelope.payload.displayRemainingDays, 7);
  assert.equal(envelope.payload.displayDay, localDayKey(nowMs));
  assert.equal(Date.parse(envelope.payload.graceUntil), nowMs + 7 * OFFLINE_DAY_MS);
  assert.match(envelope.signature, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(serialized, /session-must-never-be-cached/);
  assert.doesNotMatch(serialized, /credential-must-never-be-cached/);
  assert.doesNotMatch(serialized, new RegExp(machineCode));
});

test("signed offline VIP rights stop at V while free base and the original grace continue", () => {
  const nowMs = localTime(15);
  const baseExpiresAt = new Date(nowMs + 30 * OFFLINE_DAY_MS).toISOString();
  const vipExpiresAt = new Date(nowMs + 2 * OFFLINE_DAY_MS).toISOString();
  const envelope = create(nowMs, { license: {
    ...license(baseExpiresAt), entitlementSchemaVersion: 1, baseExpiresAt, vipExpiresAt,
  } });
  const first = verify(envelope, nowMs + OFFLINE_DAY_MS);
  assert.equal(first.ok, true);
  assert.equal(resolveEntitlements({ authorized: true, phase: "offline_active", offlineUntil: first.graceUntil, license: first.license }, nowMs + OFFLINE_DAY_MS).vip, true);
  const afterVip = verify(first.envelope, nowMs + 3 * OFFLINE_DAY_MS);
  assert.equal(afterVip.ok, true);
  const rights = resolveEntitlements({ authorized: true, phase: "offline_active", offlineUntil: afterVip.graceUntil, license: afterVip.license }, nowMs + 3 * OFFLINE_DAY_MS);
  assert.equal(rights.base, true);
  assert.equal(rights.vip, false);
  assert.equal(afterVip.lastValidatedAt, first.lastValidatedAt);
  assert.equal(afterVip.graceUntil, first.graceUntil);
});

test("keeps the displayed remaining days stable during one natural day", () => {
  const envelope = create(localTime(15, 1));
  const morning = verify(envelope, localTime(15, 8));
  const evening = verify(morning.envelope, localTime(15, 23));

  assert.equal(morning.ok, true);
  assert.equal(evening.ok, true);
  assert.equal(morning.remainingDays, 7);
  assert.equal(evening.remainingDays, 7);
  assert.equal(evening.envelope.payload.displayDay, "2026-09-15");
});

test("updates the displayed remaining days only after the local calendar day changes", () => {
  const envelope = create(localTime(15, 10));
  const nextDay = verify(envelope, localTime(16, 10));
  const sameDayAgain = verify(nextDay.envelope, localTime(16, 22));

  assert.equal(nextDay.ok, true);
  assert.equal(nextDay.remainingDays, 6);
  assert.equal(sameDayAgain.remainingDays, 6);
  assert.equal(sameDayAgain.envelope.payload.displayDay, "2026-09-16");
});

test("checks the security deadline on every launch even when the displayed day is cached", () => {
  const nowMs = localTime(15, 10);
  const envelope = create(nowMs);
  const expired = verify(envelope, nowMs + 7 * OFFLINE_DAY_MS);

  assert.deepEqual(expired, { ok: false, reason: "expired" });
});

test("never extends beyond the server-provided license expiry", () => {
  const nowMs = localTime(15, 10);
  const expiresAt = new Date(nowMs + 2 * OFFLINE_DAY_MS + 1000).toISOString();
  const envelope = create(nowMs, { license: license(expiresAt) });

  assert.equal(envelope.payload.displayRemainingDays, 3);
  assert.equal(envelope.payload.graceUntil, expiresAt);
  assert.equal(verify(envelope, Date.parse(expiresAt)).reason, "expired");
});

test("rejects tampering, a copied cache, changed credentials, and clock rollback", () => {
  const nowMs = localTime(15, 10);
  const envelope = create(nowMs);
  const tampered = structuredClone(envelope);
  tampered.payload.displayRemainingDays = 99;

  assert.equal(verify(tampered, nowMs).reason, "signature");
  assert.equal(verify(envelope, nowMs, { machineCode: `v2_${"b".repeat(64)}` }).reason, "binding");
  assert.equal(verify(envelope, nowMs, {
    credential: { ...credential, deviceCredential: "different-credential" },
  }).reason, "binding");

  const advanced = verify(envelope, nowMs + OFFLINE_DAY_MS);
  assert.equal(advanced.ok, true);
  assert.equal(verify(advanced.envelope, nowMs - 10 * 60 * 1000).reason, "clock_rollback");
});

test("refuses points licenses and incomplete device bindings", () => {
  assert.throws(() => create(localTime(15), {
    license: { ...license(), licenseType: "points", durationDays: 100 },
  }), /不能建立离线宽限/);
  assert.throws(() => create(localTime(15), {
    credential: { codeId: "code-1", deviceSession: "session" },
  }), /绑定信息不完整/);
});
