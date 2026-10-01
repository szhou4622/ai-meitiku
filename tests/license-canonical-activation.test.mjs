import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { LicenseService } from "../electron/license-service.mjs";

const V2 = `v2_${"a".repeat(64)}`;
const CANONICAL = `v3_${"b".repeat(64)}`;
const SECRET = "f".repeat(64);
const HASH = "1".repeat(32);
const identity = {
  version: 3, platform: "win32", candidate_machine_code: `v3_${"c".repeat(64)}`,
  low_confidence: false,
  factors: {
    machine_guid: { hash: HASH }, bios_uuid: { hash: "2".repeat(32) },
    system_disk_serial: { hash: "3".repeat(32) },
  },
};
const license = {
  action: "activated", code_id: "SYNTHETIC-CODE-B", machine_code: CANONICAL,
  canonical_machine_code: CANONICAL, device_session: "synthetic-session",
  device_credential: "synthetic-credential", binding_status: "active",
  license_type: "time_30d", duration_days: 30,
  activated_at: "2026-09-17T00:00:00Z", expires_at: "2026-10-17T00:00:00Z",
  remaining_days: 30, transfer_count: 0,
};
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
const boundDigest = (code) => createHmac("sha256", Buffer.alloc(32, 3))
  .update("ai-media-library-offline-v1\0machine\0" + code).digest("hex");
const factorDigest = createHash("sha256").update(JSON.stringify([identity.platform,
  Object.entries(identity.factors).map(([name, entry]) => [name, entry.hash]).sort(([a], [b]) => a.localeCompare(b)),
])).digest("hex");

function store() {
  return {
    credential: null, secretCalls: 0, writes: 0, grant: null,
    async readCredential() { return this.credential; },
    async writeCredential(value) { this.writes += 1; this.credential = structuredClone(value); },
    async readOrCreateActivationRecoverySecret() { this.secretCalls += 1; return SECRET; },
    async readOrCreateOfflineHmacKey() { return Buffer.alloc(32, 3); },
    async readOfflineGrant() { return this.grant; },
    async writeOfflineGrant(value) { this.grant = value; },
    async clearOfflineGrant() { this.grant = null; },
  };
}

function service(secureStore, fetchImpl, machineIdentity = null) {
  return new LicenseService({
    secureStore, machineCode: async () => V2, clientVersion: "synthetic-test",
    fetchImpl, machineIdentity, now: () => Date.parse("2026-09-17T12:00:00Z"),
  });
}

test("first activation waits for factor collection, sends recovery proof, then persists only server-issued canonical", async () => {
  const secureStore = store();
  let collected;
  const machineIdentity = {
    start() { return new Promise((resolve) => { collected = resolve; }); },
    payloadForRequest() { return collected ? identity : null; },
  };
  const calls = [];
  const licenseService = service(secureStore, async (url, options) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (url.endsWith("/activate")) return reply({ ok: true, action: "activated", license });
    return reply({ ...license, action: undefined });
  }, machineIdentity);
  const pending = licenseService.activate("SYNTHETIC-CARD-B");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0, "network must not race ahead of first factor collection");
  collected();
  const state = await pending;
  assert.equal(state.phase, "active");
  assert.equal(calls[0].body.machine_code, V2);
  assert.equal(calls[0].body.activation_recovery_secret, SECRET);
  assert.deepEqual(calls[0].body.machine_identity_v3, identity);
  assert.equal(secureStore.credential.boundMachineCode, CANONICAL);
  assert.notEqual(secureStore.credential.boundMachineCode, identity.candidate_machine_code);
  assert.equal(secureStore.grant.payload.machineBinding, boundDigest(CANONICAL));
});

test("lost success response retries using the same pre-persisted proof without a new entitlement", async () => {
  const secureStore = store();
  let attempts = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/activate")) {
      attempts += 1;
      if (attempts === 1) throw new Error("reply lost after server commit");
      return reply({ ok: true, action: "already_bound", license: { ...license, action: "already_bound" } });
    }
    return reply(license);
  };
  const first = service(secureStore, fetchImpl, { start: async () => {}, payloadForRequest: () => identity });
  assert.equal((await first.activate("SYNTHETIC-CARD-B")).phase, "network_error");
  assert.equal(secureStore.credential, null);
  const restarted = service(secureStore, fetchImpl, { start: async () => {}, payloadForRequest: () => identity });
  assert.equal((await restarted.activate("SYNTHETIC-CARD-B")).phase, "active");
  assert.equal(secureStore.secretCalls, 2);
  assert.equal(secureStore.credential.expiresAt, license.expires_at);
});

test("safe-store failure after server commit leaves retry available", async () => {
  const secureStore = store();
  const actualWrite = secureStore.writeCredential.bind(secureStore);
  let fail = true;
  secureStore.writeCredential = async (value) => {
    if (fail) { fail = false; throw new Error("OS credential store failed"); }
    return actualWrite(value);
  };
  const fetchImpl = async (url) => url.endsWith("/activate")
    ? reply({ ok: true, action: "activated", license }) : reply(license);
  const client = service(secureStore, fetchImpl, { start: async () => {}, payloadForRequest: () => identity });
  const first = await client.activate("SYNTHETIC-CARD-B");
  assert.equal(first.phase, "needs_activation");
  assert.match(first.message, /同一激活码重试/);
  assert.equal(secureStore.credential, null);
  assert.equal((await client.activate("SYNTHETIC-CARD-B")).phase, "active");
});

test("canonical status and offline grant survive process restart without changing v2", async () => {
  const secureStore = store();
  secureStore.credential = {
    codeId: license.code_id, deviceSession: license.device_session,
    deviceCredential: license.device_credential, boundMachineCode: CANONICAL,
    machineFactorBinding: factorDigest,
    licenseType: license.license_type, durationDays: 30,
    activatedAt: license.activated_at, expiresAt: license.expires_at,
    bindingStatus: "active", activationCode: "SYNTHETIC-CARD-B",
  };
  let online = true;
  const fetchImpl = async () => {
    if (!online) throw new Error("offline");
    return reply({ ...license, action: undefined });
  };
  const machineIdentity = { start: async () => {}, payloadForRequest: () => identity };
  const first = service(secureStore, fetchImpl, machineIdentity);
  assert.equal((await first.initialize()).phase, "active");
  online = false;
  const restarted = service(secureStore, fetchImpl, machineIdentity);
  const offline = await restarted.initialize();
  assert.equal(offline.phase, "offline_active");
  assert.equal(offline.authorized, true);
  assert.equal(secureStore.grant.payload.machineBinding, boundDigest(CANONICAL));
  assert.equal(await restarted.machineCode(), V2);
});

test("copied canonical credential and offline cache cannot authorize a machine with different fresh factors", async () => {
  const secureStore = store();
  secureStore.credential = {
    codeId: license.code_id, deviceSession: license.device_session,
    deviceCredential: license.device_credential, boundMachineCode: CANONICAL,
    machineFactorBinding: factorDigest, licenseType: license.license_type,
    durationDays: 30, activatedAt: license.activated_at,
    expiresAt: license.expires_at, bindingStatus: "active",
  };
  const original = service(secureStore, async () => reply(license),
    { start: async () => {}, payloadForRequest: () => identity });
  assert.equal((await original.initialize()).phase, "active");
  const different = structuredClone(identity);
  different.factors.bios_uuid.hash = "9".repeat(32);
  different.factors.system_disk_serial.hash = "8".repeat(32);
  const clone = service(secureStore, async () => { throw new Error("offline"); },
    { collectFreshForActivation: async () => {}, payloadForRequest: () => different });
  const state = await clone.initialize();
  assert.equal(state.phase, "network_error");
  assert.equal(state.authorized, false);
  assert.ok(secureStore.grant, "a mismatch must not erase the original machine's grant");
});

test("a weak network-card change does not invalidate canonical offline grace", async () => {
  const secureStore = store();
  secureStore.credential = {
    codeId: license.code_id, deviceSession: license.device_session,
    deviceCredential: license.device_credential, boundMachineCode: CANONICAL,
    machineFactorBinding: factorDigest, licenseType: license.license_type,
    durationDays: 30, activatedAt: license.activated_at,
    expiresAt: license.expires_at, bindingStatus: "active",
  };
  const first = service(secureStore, async () => reply(license),
    { start: async () => {}, payloadForRequest: () => identity });
  assert.equal((await first.initialize()).phase, "active");
  const changed = structuredClone(identity);
  changed.factors.physical_mac = { hash: "9".repeat(32) };
  const restarted = service(secureStore, async () => { throw new Error("offline"); },
    { collectFreshForActivation: async () => {}, payloadForRequest: () => changed });
  assert.equal((await restarted.initialize()).phase, "offline_active");
});

test("unsigned v3 code is not accepted merely because it resembles a candidate", async () => {
  const secureStore = store();
  const client = service(secureStore, async () => reply({ ok: true, action: "activated", license: {
    ...license, canonical_machine_code: undefined,
  } }), { start: async () => {}, payloadForRequest: () => identity });
  assert.equal((await client.activate("SYNTHETIC-CARD-B")).phase, "invalid");
  assert.equal(secureStore.credential, null);
});
