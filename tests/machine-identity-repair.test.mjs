import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LicenseService } from "../electron/license-service.mjs";
import { LicenseSecureStore } from "../electron/license-secure-store.mjs";
import { createFreshMachineIdentity, createStableMachineIdentity } from "../electron/machine-code.mjs";
import { MachineIdentityRepair } from "../electron/machine-identity-repair.mjs";

const APP = "ai-media-library";
const OLD = `v2_${"a".repeat(64)}`;
const CODE = "AIM-SYNTHETIC-CARD-B";
const factors = {
  version: 3, platform: "win32", low_confidence: false,
  candidate_machine_code: `v3_${"2".repeat(64)}`,
  factors: { machine_guid: { hash: "a".repeat(32) }, bios_uuid: { hash: "2".repeat(32) },
    system_disk_serial: { hash: "4".repeat(32) } },
};
const factorService = () => ({ start: async () => {}, collectFreshForActivation: async () => {}, payloadForRequest: () => factors });
const candidateProvider = () => createFreshMachineIdentity({ appName: APP, platform: "win32",
  hardwareIdProvider: async () => "12345678-1234-4abc-8def-123456789abc" });

async function fixture(t) {
  const child = spawn("python3", ["-u", "server/tests/local_canonical_http_server.py"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGTERM"));
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data.toString(); });
  const lines = createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("local fixture timeout")), 5000);
    lines.once("line", (line) => { clearTimeout(timer); const match = /^PORT=(\d+)$/.exec(line);
      if (match) resolve(`http://127.0.0.1:${match[1]}/api/license`); else reject(new Error(stderr)); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(stderr)); });
  });
}
async function storeFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiml-identity-repair-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new LicenseSecureStore({ userDataPath: dir, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`synthetic-only:${value}`),
    decryptString: (value) => value.toString().slice("synthetic-only:".length),
  } });
  await store.writeMachineCode(OLD);
  await store.writeMachineIdentity({ version: 3, active_machine_code: OLD, source_type: "windows_machine_guid" });
  return store;
}
function setup(store, baseUrl, fetchImpl = fetch) {
  const local = () => createStableMachineIdentity({ appName: APP, secureStore: store, platform: "win32",
    hardwareIdProvider: async () => "12345678-1234-4abc-8def-123456789abc" });
  const service = new LicenseService({ secureStore: store, fetchImpl, clientVersion: "synthetic-test",
    machineCode: async () => (await local()).active_machine_code, localMachineIdentity: local,
    machineIdentity: factorService(), config: { appName: APP, softwareName: "AI媒体库", baseUrl,
      protocolVersion: 2, offlineGraceDays: 7 } });
  const repair = new MachineIdentityRepair({ service, platform: "win32", candidateProvider, factorProvider: async () => factorService() });
  return { service, repair };
}
async function activateOriginal(baseUrl) {
  const response = await fetch(`${baseUrl}/activate`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_name: APP, activation_code: "AIM-SYNTHETIC-CARD-A", machine_code: OLD,
      license_protocol_version: 2 }) });
  assert.equal(response.status, 200);
  return response.json();
}

test("real HTTP: old GUID conflict is repaired locally and the existing activation endpoint accepts the new code", async (t) => {
  const url = await fixture(t);
  const original = await activateOriginal(url);
  const store = await storeFixture(t);
  const first = setup(store, url);
  assert.equal((await first.service.activate(CODE)).phase, "needs_activation");
  assert.equal(await store.readCredential(), null);
  const before = await store.readMachineIdentity();
  const repaired = setup(store, url);
  const success = await repaired.repair.repair(CODE);
  assert.equal(success.phase, "active", success.message);
  const credential = await store.readCredential();
  assert.equal(credential.boundMachineCode, (await candidateProvider()).active_machine_code);
  assert.notDeepEqual(await store.readMachineIdentity(), before);
  assert.equal((await store.readMachineIdentity()).identity_scheme, "system_uuid_v1");
  assert.equal(await repaired.service.machineCode(), (await candidateProvider()).active_machine_code);
  assert.equal((await store.readIdentityRepair()).phase, "committed");
  // Original card remains authenticated, bound to OLD, with the same expiry.
  const orig = original.license || original;
  const status = await fetch(`${url}/device/status?app_name=${APP}`, { headers: {
    Authorization: `Bearer ${orig.device_session || original.device_session}`,
    "X-Device-Credential": orig.device_credential || original.device_credential,
  } });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.machine_code.toLowerCase(), OLD);
  assert.equal(statusBody.expires_at, orig.expires_at);
});

test("real HTTP: crash during local commit is replayed on startup without reactivation", async (t) => {
  const url = await fixture(t);
  const store = await storeFixture(t);
  const save = store.writeCredential.bind(store);
  store.writeCredential = async () => { throw new Error("synthetic disk failure"); };
  const { repair } = setup(store, url);
  assert.equal((await repair.repair(CODE)).identityRepairPending, true);
  const journal = await store.readIdentityRepair();
  assert.equal(journal.phase, "accepted");
  assert.equal(await store.readCredential(), null);
  store.writeCredential = save;
  let activationRequests = 0;
  const resumed = setup(store, url, async (address, options) => {
    if (options?.method === "POST") activationRequests++;
    return fetch(address, options);
  });
  assert.equal((await resumed.repair.initialize()).phase, "active");
  assert.equal(activationRequests, 0);
  assert.equal((await store.readCredential()).deviceCredential, journal.credential.deviceCredential);
});

test("existing partial credential and offline proof block repair without requests", async (t) => {
  const store = await storeFixture(t);
  let count = 0;
  const { repair } = setup(store, "http://localhost.invalid", async () => { count++; throw new Error("should not request"); });
  await store.writeCredential({ activationCode: "historical" });
  assert.match((await repair.repair(CODE)).message, /历史授权/);
  assert.equal(count, 0);
  assert.equal(await store.readIdentityRepair(), null);
  assert.equal(await store.readMachineCode(), OLD);
});

test("existing activation endpoint rejection preserves the old identity and allows a corrected card", async (t) => {
  const store = await storeFixture(t);
  const addresses = [];
  const { repair } = setup(store, "http://localhost.invalid", async (address) => {
    addresses.push(address);
    return new Response(JSON.stringify({ error: "invalid activation code" }), { status: 400 });
  });
  const state = await repair.repair(CODE);
  assert.match(state.message, /invalid activation code/);
  assert.equal(state.identityRepairPending, false);
  assert.equal(addresses.length, 1);
  assert.ok(addresses[0].endsWith("/activate"));
  assert.equal(await store.readMachineCode(), OLD);
  assert.equal(await store.readCredential(), null);
  assert.equal((await store.readIdentityRepair()).phase, "rejected");
});

test("failed UUID read, failed journal persistence and weak factors never submit", async (t) => {
  const store = await storeFixture(t);
  const { service } = setup(store, "http://localhost.invalid", async () => { assert.fail("unexpected network"); });
  const repair = new MachineIdentityRepair({ service, platform: "win32",
    candidateProvider: async () => { throw new Error("UUID unavailable"); } });
  assert.match((await repair.repair(CODE)).message, /UUID/);
  const weak = new MachineIdentityRepair({ service, platform: "win32", candidateProvider,
    factorProvider: async () => ({ payloadForRequest: () => null }) });
  assert.match((await weak.repair(CODE)).message, /采集不足/);
  store.writeIdentityRepair = async () => { throw new Error("disk unavailable"); };
  const noDisk = new MachineIdentityRepair({ service, platform: "win32", candidateProvider, factorProvider: async () => factorService() });
  assert.match((await noDisk.repair(CODE)).message, /disk unavailable/);
  assert.equal(await store.readMachineCode(), OLD);
});

test("remaining offline grant blocks repair even without a device credential", async (t) => {
  const store = await storeFixture(t);
  await store.writeOfflineGrant({ synthetic: true });
  const { repair } = setup(store, "http://localhost.invalid", async () => assert.fail("unexpected request"));
  assert.match((await repair.repair(CODE)).message, /历史离线授权/);
  assert.equal(await store.readMachineCode(), OLD);
  assert.equal(await store.readIdentityRepair(), null);
});

test("concurrent repair calls share one request; uncertain retry rejection retains recovery proof", async (t) => {
  const store = await storeFixture(t);
  let calls = 0;
  const { repair } = setup(store, "http://localhost.invalid", async () => {
    calls++;
    if (calls === 1) throw new TypeError("synthetic response lost");
    return new Response(JSON.stringify({ message: "needs review" }), { status: 409 });
  });
  const results = await Promise.all([repair.repair(CODE), repair.repair(CODE)]);
  assert.equal(calls, 1);
  assert.equal(results[0].identityRepairPending, true);
  const saved = await store.readIdentityRepair();
  assert.equal((await repair.repair(CODE)).identityRepairPending, true);
  assert.equal((await store.readIdentityRepair()).recoverySecret, saved.recoverySecret);
  assert.equal((await store.readIdentityRepair()).phase, "prepared");
});

test("corrupt repair journal stops startup without changing identity or credential", async (t) => {
  const store = await storeFixture(t);
  await store.writeEncrypted("license-identity-repair.v1.bin", JSON.stringify({ version: 1, phase: "accepted" }));
  const { repair } = setup(store, "http://localhost.invalid", async () => assert.fail("unexpected request"));
  await assert.rejects(repair.initialize(), /格式异常/);
  assert.equal(await store.readMachineCode(), OLD);
  assert.equal(await store.readCredential(), null);
});
