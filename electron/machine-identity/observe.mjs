import { createHash } from "node:crypto";
import { factorWeightMap } from "./hash.mjs";
import { strongFactorNames } from "./index.mjs";

export const OBSERVE_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
export const OBSERVE_TIMEOUT_MS = 8_000;
const V2_PATTERN = /^v2_[a-f0-9]{64}$/;
const V3_PATTERN = /^v3_[a-f0-9]{64}$/;
const HASH_PATTERN = /^[a-f0-9]{32}$/;
const CONFIRMED_STATES = new Set(["same_device", "needs_review", "new_device"]);

// A second whitelist at the network boundary: collector metadata, source
// strings, raw hardware values and client-side weights cannot leave here.
export function observationIdentity(source) {
  if (Number(source?.version) !== 3) return null;
  const platform = source?.platform;
  if (platform !== "win32" && platform !== "darwin") return null;
  const factors = {};
  for (const name of Object.keys(factorWeightMap(platform))) {
    const hash = String(source?.factors?.[name]?.hash ?? "").toLowerCase();
    factors[name] = { hash: HASH_PATTERN.test(hash) ? hash : null };
  }
  if (!strongFactorNames(platform).some((name) => factors[name]?.hash)) return null;
  const candidate = String(source?.candidate_machine_code ?? "").toLowerCase();
  return {
    version: 3,
    platform,
    candidate_machine_code: V3_PATTERN.test(candidate) ? candidate : "",
    factors,
    low_confidence: Boolean(source?.low_confidence),
  };
}

export function observationDigest({ appName, codeId, machineCode, identity }) {
  const hashes = Object.keys(identity.factors).sort().map((name) => [name, identity.factors[name].hash]);
  return createHash("sha256")
    .update(JSON.stringify([appName, String(codeId ?? ""), machineCode, identity.platform, identity.candidate_machine_code, hashes]))
    .digest("hex");
}

export function confirmedRecently(record, digest, nowMs, ttlMs = OBSERVE_CONFIRMATION_TTL_MS) {
  if (record?.version !== 1 || record.digest !== digest) return false;
  const confirmedAt = Number(record.confirmedAt);
  return Number.isFinite(confirmedAt) && confirmedAt > 0 && nowMs >= confirmedAt && nowMs - confirmedAt < ttlMs;
}

async function withTimeout(task, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([task(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class IdentityObserveCoordinator {
  constructor({ appName, baseUrl, clientVersion, secureStore, machineIdentity, machineCode, getLicenseState,
    fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = OBSERVE_TIMEOUT_MS,
    baselineEnabled = false } = {}) {
    this.appName = appName;
    this.baseUrl = baseUrl;
    this.clientVersion = clientVersion;
    this.secureStore = secureStore;
    this.machineIdentity = machineIdentity;
    this.machineCode = machineCode;
    this.getLicenseState = getLicenseState;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.baselineEnabled = baselineEnabled;
    this.baselineAttempted = false;
    this.onlineValidated = false;
    this.attempted = false;
    this.pending = null;
    this.retryRequested = false;
  }

  onlineValidationSucceeded() {
    this.onlineValidated = true;
    if (this.baselineEnabled) void this.maybeEnrollBaseline();
    return this.maybeSend();
  }

  noteLicenseState(state) {
    if (state?.phase !== "active" || state.authorized !== true) this.onlineValidated = false;
  }

  maybeSend() {
    if (this.baselineEnabled) void this.maybeEnrollBaseline();
    if (this.pending) {
      // Collection may finish in the same microtask turn as online validation.
      // Re-evaluate once after the in-flight prerequisite check settles.
      this.retryRequested = true;
      return this.pending.then((result) => {
        if (!this.retryRequested || this.attempted) return result;
        this.retryRequested = false;
        return this.maybeSend();
      });
    }
    if (this.attempted || !this.onlineValidated) return Promise.resolve(false);
    this.pending = this.sendIfReady().catch(() => false).finally(() => { this.pending = null; });
    return this.pending;
  }

  async maybeEnrollBaseline() {
    if (this.baselineAttempted || !this.onlineValidated) return false;
    const active = this.getLicenseState?.();
    if (active?.phase !== "active" || active.authorized !== true) return false;
    // A disk image can copy the old device's local factor cache. A baseline
    // trusted for later collision decisions must come from this process's
    // fresh hardware collection, never just from that cached snapshot.
    try {
      await this.machineIdentity?.collectFreshForActivation?.();
    } catch {
      return false;
    }
    const identity = observationIdentity(this.machineIdentity?.payloadForRequest?.());
    if (!identity || identity.low_confidence) return false;
    try {
      const credential = await this.secureStore?.readCredential?.();
      if (!credential?.deviceSession || !credential?.deviceCredential) return false;
      // Only old v2 bindings need a baseline. A newly issued canonical already
      // persisted its factors in the same transaction as its activation.
      if (/^v3_[a-f0-9]{64}$/.test(String(credential.boundMachineCode || ""))) return false;
      const machineCode = await this.machineCode?.();
      if (!V2_PATTERN.test(String(machineCode || ""))) return false;
      const current = this.getLicenseState?.();
      if (this.baselineAttempted || current?.phase !== "active" || current.authorized !== true) return false;
      this.baselineAttempted = true;
      const response = await withTimeout((signal) => this.fetchImpl(`${this.baseUrl}/identity/baseline`, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          Authorization: `Bearer ${credential.deviceSession}`,
          "X-Device-Credential": credential.deviceCredential,
        },
        body: JSON.stringify({
          app_name: this.appName,
          machine_code: machineCode,
          machine_identity_v3: identity,
        }),
        signal,
      }), this.timeoutMs);
      return response?.status === 200;
    } catch {
      return false;
    }
  }

  async sendIfReady() {
    const active = this.getLicenseState?.();
    if (active?.phase !== "active" || active.authorized !== true) return false;
    const identity = observationIdentity(this.machineIdentity?.payloadForRequest?.());
    if (!identity) return false;

    const credential = await this.secureStore?.readCredential?.();
    if (!credential?.deviceSession || !credential?.deviceCredential) return false;
    const machineCode = await this.machineCode?.();
    if (!V2_PATTERN.test(String(machineCode ?? ""))) return false;
    const digest = observationDigest({ appName: this.appName, codeId: credential.codeId, machineCode, identity });
    try {
      const prior = await this.secureStore?.readIdentityObserveConfirmation?.();
      if (confirmedRecently(prior, digest, this.now())) return false;
    } catch {
      // Storage failure only removes deduplication; it never blocks license use.
    }

    // Recheck after the asynchronous secure-store reads. An offline transition
    // between validation and collection is not an online authorization.
    const current = this.getLicenseState?.();
    if (this.attempted || current?.phase !== "active" || current.authorized !== true) return false;
    this.attempted = true;
    let response;
    try {
      response = await withTimeout((signal) => this.fetchImpl(`${this.baseUrl}/identity/observe`, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          Authorization: `Bearer ${credential.deviceSession}`,
          "X-Device-Credential": credential.deviceCredential,
        },
        body: JSON.stringify({
          app_name: this.appName,
          client_version: this.clientVersion,
          machine_code: machineCode,
          machine_identity_v3: identity,
        }),
        signal,
      }).then(async (reply) => {
        if (reply?.status !== 200) return null;
        const body = await reply.json();
        return body && typeof body === "object" ? body : null;
      }), this.timeoutMs);
    } catch {
      return false;
    }
    // No response field is ever applied to the active code, binding, offline
    // grant or MachineIdentityService. A surprise migrate/enforce/canonical
    // response is ignored rather than enabling a new authorization policy.
    if (response?.ok !== true || response.identity_phase !== "observe"
      || !CONFIRMED_STATES.has(response.identity_assessment?.state)) return false;
    try {
      await this.secureStore?.writeIdentityObserveConfirmation?.({ version: 1, digest, confirmedAt: this.now() });
    } catch {
      // A write failure means a retry next startup, never an auth failure.
    }
    return true;
  }
}
