import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { IdentityObserveCoordinator, OBSERVE_CONFIRMATION_TTL_MS, observationIdentity } from "../electron/machine-identity/observe.mjs";
import { redactedIdentityDiagnosticText } from "../electron/machine-identity/diagnostics.mjs";
import { LicenseService } from "../electron/license-service.mjs";

const MACHINE = `v2_${"a".repeat(64)}`;
const FACTOR_A = "1".repeat(32);
const FACTOR_B = "2".repeat(32);
const SECRET_SESSION = "session-private-value";
const SECRET_CREDENTIAL = "credential-private-value";
const RAW_SERIAL = "RAW-HARDWARE-SERIAL-SECRET";
const ACTIVE_RESPONSE = {
  code_id: "code-1",
  device_session: SECRET_SESSION,
  device_credential: SECRET_CREDENTIAL,
  binding_status: "active",
  license_type: "monthly",
  duration_days: 30,
  activated_at: "2026-09-01T00:00:00Z",
  expires_at: "2026-10-01T00:00:00Z",
};

function store(credential = { ...ACTIVE_RESPONSE, codeId: "code-1", deviceSession: SECRET_SESSION, deviceCredential: SECRET_CREDENTIAL }) {
  return {
    credential,
    confirmation: null,
    async readCredential() { return this.credential; },
    async writeCredential(value) { this.credential = structuredClone(value); },
    async readOrCreateOfflineHmacKey() { return Buffer.alloc(32, 4); },
    async writeOfflineGrant() {},
    async readIdentityObserveConfirmation() { return this.confirmation; },
    async writeIdentityObserveConfirmation(value) { this.confirmation = structuredClone(value); },
  };
}

function identity(ready = false) {
  return {
    ready,
    acceptCalls: 0,
    payloadForRequest() {
      if (!this.ready) return null;
      return {
        version: 3,
        platform: "win32",
        candidate_machine_code: `v3_${"b".repeat(64)}`,
        factors: {
          machine_guid: { hash: FACTOR_A, raw: RAW_SERIAL },
          bios_uuid: { hash: FACTOR_B },
          system_disk_serial: { hash: null, reason: RAW_SERIAL },
          physical_mac: { hash: null },
        },
        collection: { raw: RAW_SERIAL },
        raw: RAW_SERIAL,
      };
    },
    acceptServerIdentity() { this.acceptCalls += 1; },
  };
}

async function mockServer(handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ url: request.url, method: request.method, headers: request.headers, body });
    const result = await handler(request, body);
    response.writeHead(result.status ?? 200, { "content-type": "application/json" });
    response.end(result.raw ?? JSON.stringify(result.body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/api/license`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function coordinator({ baseUrl, secureStore, machineIdentity, getState, now = () => Date.now(), fetchImpl, timeoutMs, baselineEnabled = false }) {
  return new IdentityObserveCoordinator({
    appName: "ai-media-library", baseUrl, clientVersion: "1.1.6", secureStore,
    machineIdentity, machineCode: async () => MACHINE, getLicenseState: getState,
    now, fetchImpl, timeoutMs, baselineEnabled,
  });
}

test("old v2 device enrolls an authenticated factor baseline only after online status and collection", async (t) => {
  const mock = await mockServer((request) => request.url.endsWith("/device/status")
    ? { body: ACTIVE_RESPONSE }
    : { body: { ok: true, identity_phase: "off", baseline_state: "enrolled" } });
  t.after(mock.close);
  const secureStore = store();
  const machineIdentity = identity(false);
  let license;
  const observer = coordinator({
    baseUrl: mock.url, secureStore, machineIdentity,
    getState: () => license?.state, baselineEnabled: true,
  });
  license = new LicenseService({
    secureStore, machineCode: async () => MACHINE, clientVersion: "1.1.6",
    config: { appName: "ai-media-library", softwareName: "AI媒体库", baseUrl: mock.url, protocolVersion: 2, offlineGraceDays: 7 },
    onOnlineValidated: () => { void observer.onlineValidationSucceeded(); },
  });
  assert.equal((await license.initialize()).phase, "active");
  assert.equal(mock.requests.filter((item) => item.url.endsWith("/identity/baseline")).length, 0);
  machineIdentity.ready = true;
  await observer.maybeSend();
  await waitFor(() => mock.requests.some((item) => item.url.endsWith("/identity/baseline")));
  const baseline = mock.requests.find((item) => item.url.endsWith("/identity/baseline"));
  assert.equal(baseline.headers.authorization, `Bearer ${SECRET_SESSION}`);
  assert.equal(baseline.headers["x-device-credential"], SECRET_CREDENTIAL);
  assert.equal(baseline.body.includes(RAW_SERIAL), false);
  assert.equal(baseline.body.includes(SECRET_CREDENTIAL), false);
  await observer.maybeSend();
  assert.equal(mock.requests.filter((item) => item.url.endsWith("/identity/baseline")).length, 1);
});

test("baseline enrollment waits for a fresh factor read rather than copied cache", async (t) => {
  const mock = await mockServer(() => ({ body: { ok: true, baseline_state: "enrolled" } }));
  t.after(mock.close);
  const machineIdentity = identity(true);
  let freshReads = 0;
  machineIdentity.collectFreshForActivation = async () => {
    freshReads += 1;
    machineIdentity.payloadForRequest = () => ({
      version: 3, platform: "win32", low_confidence: false,
      candidate_machine_code: `v3_${"c".repeat(64)}`,
      factors: { machine_guid: { hash: FACTOR_B }, bios_uuid: { hash: FACTOR_A } },
    });
  };
  const observer = coordinator({
    baseUrl: mock.url, secureStore: store(), machineIdentity,
    getState: () => ({ phase: "active", authorized: true }), baselineEnabled: true,
  });
  await observer.onlineValidationSucceeded();
  await waitFor(() => mock.requests.some((item) => item.url.endsWith("/identity/baseline")));
  const body = JSON.parse(mock.requests.find((item) => item.url.endsWith("/identity/baseline")).body);
  assert.ok(freshReads >= 1);
  assert.equal(body.machine_identity_v3.factors.machine_guid.hash, FACTOR_B);
  assert.equal(body.machine_identity_v3.factors.bios_uuid.hash, FACTOR_A);
});

test("offline grace and canonical clients never enroll an old-v2 baseline", async () => {
  const secureStore = store();
  const machineIdentity = identity(true);
  let calls = 0;
  let state = { phase: "offline_active", authorized: true };
  const observer = coordinator({
    baseUrl: "http://127.0.0.1", secureStore, machineIdentity,
    getState: () => state, baselineEnabled: true,
    fetchImpl: async () => { calls += 1; return new Response("{}"); },
  });
  await observer.onlineValidationSucceeded();
  assert.equal(calls, 0);
  state = { phase: "active", authorized: true };
  secureStore.credential.boundMachineCode = `v3_${"a".repeat(64)}`;
  await observer.onlineValidationSucceeded();
  assert.equal(observer.baselineAttempted, false);
  assert.equal(calls, 1, "the independent observe request may still run");
});

async function waitFor(check) {
  for (let i = 0; i < 80; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for local mock request");
}

test("online validation first, collection later: one local-server POST with only hashes", async (t) => {
  const mock = await mockServer((request) => request.url.endsWith("/device/status")
    ? { body: ACTIVE_RESPONSE }
    : { body: { ok: true, identity_phase: "observe", identity_assessment: { state: "new_device" } } });
  t.after(mock.close);
  const secureStore = store();
  const machineIdentity = identity(false);
  let license;
  const observer = coordinator({ baseUrl: mock.url, secureStore, machineIdentity, getState: () => license?.state });
  license = new LicenseService({
    secureStore, machineCode: async () => MACHINE, clientVersion: "1.1.6",
    config: { appName: "ai-media-library", softwareName: "AI媒体库", baseUrl: mock.url, protocolVersion: 2, offlineGraceDays: 7 },
    onOnlineValidated: () => { void observer.onlineValidationSucceeded(); },
  });
  const state = await license.initialize();
  assert.equal(state.phase, "active");
  assert.equal(mock.requests.filter((item) => item.url.endsWith("/identity/observe")).length, 0);
  machineIdentity.ready = true;
  await observer.maybeSend();
  await observer.maybeSend();
  const posts = mock.requests.filter((item) => item.url.endsWith("/identity/observe"));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers.authorization, `Bearer ${SECRET_SESSION}`);
  assert.equal(posts[0].headers["x-device-credential"], SECRET_CREDENTIAL);
  const payload = JSON.parse(posts[0].body);
  assert.equal(payload.machine_code, MACHINE);
  assert.equal(payload.machine_identity_v3.factors.machine_guid.hash, FACTOR_A);
  assert.equal(JSON.stringify(payload).includes(RAW_SERIAL), false);
  assert.equal(JSON.stringify(payload).includes(SECRET_SESSION), false);
  assert.equal(JSON.stringify(payload).includes(SECRET_CREDENTIAL), false);
  assert.equal(secureStore.confirmation.version, 1);
  assert.equal(state.phase, license.state.phase);
});

test("collection first, authorization later: status success schedules background POST", async (t) => {
  const mock = await mockServer((request) => request.url.endsWith("/device/status")
    ? { body: ACTIVE_RESPONSE }
    : { body: { ok: true, identity_phase: "observe", identity_assessment: { state: "same_device" } } });
  t.after(mock.close);
  const secureStore = store();
  const machineIdentity = identity(true);
  let license;
  const observer = coordinator({ baseUrl: mock.url, secureStore, machineIdentity, getState: () => license?.state });
  await observer.maybeSend();
  license = new LicenseService({
    secureStore, machineCode: async () => MACHINE, clientVersion: "1.1.6",
    config: { appName: "ai-media-library", softwareName: "AI媒体库", baseUrl: mock.url, protocolVersion: 2, offlineGraceDays: 7 },
    onOnlineValidated: () => { void observer.onlineValidationSucceeded(); },
  });
  await license.initialize();
  await waitFor(() => mock.requests.some((item) => item.url.endsWith("/identity/observe")));
  await waitFor(() => Boolean(secureStore.confirmation));
  assert.equal(mock.requests.filter((item) => item.url.endsWith("/identity/observe")).length, 1);
});

test("collection completion during the pending authorization check is not lost", async () => {
  const secureStore = store();
  const machineIdentity = identity(false);
  let posts = 0;
  const observer = coordinator({ baseUrl: "http://127.0.0.1", secureStore, machineIdentity,
    getState: () => ({ phase: "active", authorized: true }),
    fetchImpl: async () => {
      posts += 1;
      return new Response(JSON.stringify({ ok: true, identity_phase: "observe", identity_assessment: { state: "new_device" } }));
    } });
  const first = observer.onlineValidationSucceeded();
  machineIdentity.ready = true;
  await observer.maybeSend();
  await first;
  assert.equal(posts, 1);
});

test("offline grace and missing credentials never report", async () => {
  const secureStore = store();
  const machineIdentity = identity(true);
  let posts = 0;
  let state = { phase: "offline_active", authorized: true };
  const observer = coordinator({ baseUrl: "http://127.0.0.1", secureStore, machineIdentity,
    getState: () => state, fetchImpl: async () => { posts += 1; return new Response("{}"); } });
  await observer.onlineValidationSucceeded();
  assert.equal(posts, 0);
  state = { phase: "active", authorized: true };
  secureStore.credential = { codeId: "code-1", deviceSession: SECRET_SESSION };
  await observer.maybeSend();
  assert.equal(posts, 0);
  assert.equal(observer.attempted, false);
});

test("an offline transition cancels stale validation evidence until the next real online success", async () => {
  const secureStore = store();
  const machineIdentity = identity(false);
  let posts = 0;
  let state = { phase: "active", authorized: true };
  const observer = coordinator({ baseUrl: "http://127.0.0.1", secureStore, machineIdentity,
    getState: () => state,
    fetchImpl: async () => {
      posts += 1;
      return new Response(JSON.stringify({ ok: true, identity_phase: "observe", identity_assessment: { state: "new_device" } }));
    } });
  await observer.onlineValidationSucceeded();
  state = { phase: "offline_active", authorized: true };
  observer.noteLicenseState(state);
  machineIdentity.ready = true;
  await observer.maybeSend();
  assert.equal(posts, 0);
  state = { phase: "active", authorized: true };
  await observer.maybeSend();
  assert.equal(posts, 0);
  await observer.onlineValidationSucceeded();
  assert.equal(posts, 1);
});

test("a nominal 200 without an explicit active binding is not online-validation evidence", async () => {
  const secureStore = store();
  secureStore.credential = {
    codeId: "code-1", deviceSession: SECRET_SESSION, deviceCredential: SECRET_CREDENTIAL,
    bindingStatus: "active", licenseType: "monthly", durationDays: 30,
    activatedAt: "2026-09-01T00:00:00Z", expiresAt: "2026-10-01T00:00:00Z",
  };
  let signals = 0;
  const license = new LicenseService({
    secureStore, machineCode: async () => MACHINE, clientVersion: "1.1.6",
    fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    onOnlineValidated: () => { signals += 1; },
  });
  const state = await license.initialize();
  assert.equal(state.phase, "active");
  assert.equal(signals, 0);
});

test("a rejected observer callback cannot reject a successful authorization", async () => {
  const secureStore = store();
  const license = new LicenseService({
    secureStore, machineCode: async () => MACHINE, clientVersion: "1.1.6",
    fetchImpl: async () => new Response(JSON.stringify(ACTIVE_RESPONSE), { status: 200 }),
    onOnlineValidated: async () => { throw new Error("observer failure"); },
  });
  const state = await license.initialize();
  assert.equal(state.phase, "active");
  assert.equal(state.authorized, true);
});

test("off, 404 and 500 are attempts, not confirmation; next startup retries", async (t) => {
  let response = { status: 200, body: { ok: true, identity_phase: "off" } };
  const mock = await mockServer(() => response);
  t.after(mock.close);
  const secureStore = store();
  const machineIdentity = identity(true);
  const active = () => ({ phase: "active", authorized: true });
  await coordinator({ baseUrl: mock.url, secureStore, machineIdentity, getState: active }).onlineValidationSucceeded();
  assert.equal(secureStore.confirmation, null);
  response = { status: 404, body: { ok: false } };
  await coordinator({ baseUrl: mock.url, secureStore, machineIdentity, getState: active }).onlineValidationSucceeded();
  assert.equal(secureStore.confirmation, null);
  response = { status: 500, body: { ok: false } };
  await coordinator({ baseUrl: mock.url, secureStore, machineIdentity, getState: active }).onlineValidationSucceeded();
  assert.equal(secureStore.confirmation, null);
  response = { status: 200, body: { ok: true, identity_phase: "observe", identity_assessment: { state: "new_device" } } };
  await coordinator({ baseUrl: mock.url, secureStore, machineIdentity, getState: active }).onlineValidationSucceeded();
  assert.equal(mock.requests.length, 4);
  assert.ok(secureStore.confirmation);
});

test("even a valid observe response with canonical does not apply it to authorization", async () => {
  const secureStore = store();
  const machineIdentity = identity(true);
  const state = { phase: "active", authorized: true };
  const observer = coordinator({ baseUrl: "http://127.0.0.1", secureStore, machineIdentity,
    getState: () => state,
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true, identity_phase: "observe", canonical_machine_code: `v3_${"f".repeat(64)}`,
      identity_assessment: { state: "same_device" },
    }), { status: 200 }) });
  assert.equal(await observer.onlineValidationSucceeded(), true);
  assert.equal(machineIdentity.acceptCalls, 0);
  assert.equal(state.phase, "active");
  assert.equal(secureStore.credential.deviceSession, SECRET_SESSION);
});

test("network failure is silent, sends only once in a launch, and retries after a new launch", async () => {
  const secureStore = store();
  const machineIdentity = identity(true);
  const state = { phase: "active", authorized: true };
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    if (count === 1) throw new Error("private network detail");
    return new Response(JSON.stringify({ ok: true, identity_phase: "observe", identity_assessment: { state: "new_device" } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const args = { baseUrl: "http://127.0.0.1", secureStore, machineIdentity, getState: () => state, fetchImpl };
  const firstLaunch = coordinator(args);
  assert.equal(await firstLaunch.onlineValidationSucceeded(), false);
  await firstLaunch.maybeSend();
  assert.equal(count, 1);
  assert.equal(secureStore.confirmation, null);
  assert.deepEqual(state, { phase: "active", authorized: true });
  assert.equal(await coordinator(args).onlineValidationSucceeded(), true);
  assert.equal(count, 2);
  assert.ok(secureStore.confirmation);
});

test("same confirmed identity deduplicates for 24 hours; changed identity or elapsed TTL sends", async (t) => {
  const mock = await mockServer(() => ({ body: { ok: true, identity_phase: "observe", identity_assessment: { state: "needs_review" } } }));
  t.after(mock.close);
  const secureStore = store();
  const machineIdentity = identity(true);
  let current = Date.parse("2026-09-17T00:00:00Z");
  const args = { baseUrl: mock.url, secureStore, machineIdentity,
    getState: () => ({ phase: "active", authorized: true }), now: () => current };
  await coordinator(args).onlineValidationSucceeded();
  current += OBSERVE_CONFIRMATION_TTL_MS - 1;
  await coordinator(args).onlineValidationSucceeded();
  assert.equal(mock.requests.length, 1);
  current += 1;
  await coordinator(args).onlineValidationSucceeded();
  assert.equal(mock.requests.length, 2);
  const oldPayload = machineIdentity.payloadForRequest.bind(machineIdentity);
  machineIdentity.payloadForRequest = () => {
    const payload = oldPayload();
    payload.factors.bios_uuid.hash = "3".repeat(32);
    return payload;
  };
  await coordinator(args).onlineValidationSucceeded();
  assert.equal(mock.requests.length, 3);
});

test("timeout, malformed response and unexpected canonical never change authorization or identity", async (t) => {
  let response = { raw: "not-json" };
  const mock = await mockServer(() => response);
  t.after(mock.close);
  const secureStore = store();
  const machineIdentity = identity(true);
  const state = { phase: "active", authorized: true };
  const args = { baseUrl: mock.url, secureStore, machineIdentity, getState: () => state };
  await coordinator(args).onlineValidationSucceeded();
  assert.equal(secureStore.confirmation, null);
  response = { body: { ok: true, identity_phase: "migrate", canonical_machine_code: `v3_${"f".repeat(64)}` } };
  await coordinator(args).onlineValidationSucceeded();
  assert.equal(secureStore.confirmation, null);
  assert.equal(machineIdentity.acceptCalls, 0);
  response = { body: { ok: true, identity_phase: "observe" } };
  await coordinator(args).onlineValidationSucceeded();
  assert.equal(secureStore.confirmation, null);
  assert.deepEqual(state, { phase: "active", authorized: true });
  assert.equal(machineIdentity.ready, true);
  assert.equal(secureStore.credential.deviceSession, SECRET_SESSION);
  const hanging = coordinator({ ...args, timeoutMs: 15, fetchImpl: () => new Promise(() => {}) });
  await hanging.onlineValidationSucceeded();
  assert.equal(hanging.attempted, true);
  assert.equal(secureStore.confirmation, null);
});

test("diagnostic and observation whitelist remove raw values, credentials and arbitrary properties", () => {
  const source = identity(true).payloadForRequest();
  const outbound = observationIdentity(source);
  assert.equal(JSON.stringify(outbound).includes(RAW_SERIAL), false);
  assert.equal(Object.hasOwn(outbound, "raw"), false);
  const diagnostic = redactedIdentityDiagnosticText({
    platform: "win32", state: "ready", candidateCodePrefix: `v3_${"a".repeat(6)}`,
    factors: [{ name: "machine_guid", hashPrefix: "abcdef", raw: RAW_SERIAL },
      { name: "not_allowed", hashPrefix: RAW_SERIAL }],
    raw: RAW_SERIAL, deviceSession: SECRET_SESSION, deviceCredential: SECRET_CREDENTIAL,
  });
  assert.match(diagnostic, /abcdef/);
  assert.equal(diagnostic.includes(RAW_SERIAL), false);
  assert.equal(diagnostic.includes(SECRET_SESSION), false);
  assert.equal(diagnostic.includes(SECRET_CREDENTIAL), false);
  assert.equal(diagnostic.includes(MACHINE), false);
});
