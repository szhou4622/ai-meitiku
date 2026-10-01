import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";
import { LicenseService } from "../electron/license-service.mjs";

const APP = "ai-media-library";
const V2 = `v2_${"a".repeat(64)}`;
const factor = (character) => character.repeat(32);
const identity = (variant) => ({
  version: 3, platform: "win32", low_confidence: false,
  candidate_machine_code: `v3_${(variant === "a" ? "1" : "2").repeat(64)}`,
  factors: {
    machine_guid: { hash: factor("a") },
    bios_uuid: { hash: factor(variant === "a" ? "1" : "2") },
    system_disk_serial: { hash: factor(variant === "a" ? "3" : "4") },
    cpu_processor_id: { hash: factor("5") },
  },
});

function secureStore(secret) {
  return {
    credential: null, grant: null,
    async readCredential() { return this.credential; },
    async writeCredential(value) { this.credential = structuredClone(value); },
    async readOrCreateActivationRecoverySecret() { return secret; },
    async readOrCreateOfflineHmacKey() { return Buffer.alloc(32, 7); },
    async readOfflineGrant() { return this.grant; },
    async writeOfflineGrant(value) { this.grant = value; },
    async clearOfflineGrant() { this.grant = null; },
  };
}

function client(baseUrl, store, factors) {
  return new LicenseService({
    secureStore: store, machineCode: async () => V2, clientVersion: "e2e-synthetic",
    machineIdentity: { start: async () => factors, payloadForRequest: () => factors,
      acceptServerIdentity() {} },
    config: { appName: APP, softwareName: "AI媒体库", baseUrl, protocolVersion: 2, offlineGraceDays: 7 },
  });
}

async function fixture(t) {
  const child = spawn("python3", ["-u", "server/tests/local_canonical_http_server.py"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { child.kill("SIGTERM"); });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const lines = createInterface({ input: child.stdout });
  const port = await Promise.race([
    new Promise((resolve, reject) => {
      lines.once("line", (line) => {
        const match = /^PORT=(\d+)$/.exec(line);
        if (match) resolve(Number(match[1]));
        else reject(new Error(`fixture failed: ${stderr.slice(0, 300)}`));
      });
      child.once("exit", () => reject(new Error(`fixture exited: ${stderr.slice(0, 300)}`)));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("fixture start timeout")), 5_000)),
  ]);
  return `http://127.0.0.1:${port}/api/license`;
}

test("real local HTTP: cloned v2 devices activate independent time cards through client and server", async (t) => {
  const baseUrl = await fixture(t);
  const aStore = secureStore("a".repeat(64));
  const bStore = secureStore("f".repeat(64));
  const a = client(baseUrl, aStore, identity("a"));
  const b = client(baseUrl, bStore, identity("b"));
  assert.equal((await a.activate("AIM-SYNTHETIC-CARD-A")).phase, "active");
  const aBefore = structuredClone(aStore.credential);
  const baseline = await fetch(`${baseUrl}/identity/baseline`, {
    method: "POST", headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${aStore.credential.deviceSession}`,
      "X-Device-Credential": aStore.credential.deviceCredential,
    },
    body: JSON.stringify({ app_name: APP, machine_code: V2, machine_identity_v3: identity("a") }),
  });
  assert.equal(baseline.status, 200);
  assert.equal((await baseline.json()).baseline_state, "enrolled");
  assert.equal((await b.activate("AIM-SYNTHETIC-CARD-B")).phase, "active");
  assert.equal(aStore.credential.codeId, aBefore.codeId);
  assert.equal(aStore.credential.deviceCredential, aBefore.deviceCredential);
  assert.equal(aStore.credential.expiresAt, aBefore.expiresAt);
  assert.equal(aStore.credential.boundMachineCode, V2);
  assert.match(bStore.credential.boundMachineCode, /^v3_[a-f0-9]{64}$/);
  assert.notEqual(bStore.credential.boundMachineCode, identity("b").candidate_machine_code);
  const bBefore = structuredClone(bStore.credential);
  assert.equal((await client(baseUrl, aStore, identity("a")).initialize()).phase, "active");
  assert.equal((await client(baseUrl, bStore, identity("b")).initialize()).phase, "active");
  assert.equal(bStore.credential.expiresAt, bBefore.expiresAt);
  assert.equal(bStore.credential.boundMachineCode, bBefore.boundMachineCode);
  const takeover = await fetch(`${baseUrl}/activate`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      app_name: APP, activation_code: "AIM-SYNTHETIC-CARD-A", machine_code: V2,
      license_protocol_version: 2, client_version: "e2e-synthetic",
      activation_recovery_secret: "f".repeat(64), machine_identity_v3: identity("b"),
    }),
  });
  assert.equal(takeover.status, 400);
  assert.equal((await client(baseUrl, aStore, identity("a")).initialize()).phase, "active");
});
