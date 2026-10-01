import {
  buildIdentityPayload,
  createIdentityCacheEnvelope,
  publicIdentityDiagnostics,
  readIdentityCacheEnvelope,
  validCanonicalMachineCode,
} from "./index.mjs";

// Background owner of the v3 identity observation.
//
// Contract with the rest of the application:
//  - start() never throws and never returns a promise the caller must await
//  - payloadForRequest() is synchronous and returns null until collection has
//    finished; it never waits, so an unfinished collection simply means the
//    request goes out as a plain v2 request
//  - nothing here reads or writes the offline grace grant

async function defaultLoadCollector(platform) {
  if (platform === "darwin") {
    const collector = await import("./collectors/macos.mjs");
    return collector.collectMacosFactorHashes;
  }
  if (platform === "win32") {
    const collector = await import("./collectors/windows.mjs");
    return collector.collectWindowsFactorHashes;
  }
  return null;
}

export class MachineIdentityService {
  constructor({
    appName,
    clientVersion,
    secureStore,
    platform = process.platform,
    loadCollector = defaultLoadCollector,
    now = () => Date.now(),
    schedule = (task) => setTimeout(task, 0),
    logger = null,
  } = {}) {
    this.appName = String(appName || "");
    this.clientVersion = String(clientVersion || "");
    this.secureStore = secureStore;
    this.platform = platform;
    this.loadCollector = loadCollector;
    this.now = now;
    this.schedule = schedule;
    this.logger = logger;

    this.result = null;
    this.state = "idle";
    this.lastReason = "";
    this.collectedAt = "";
    this.canonicalMachineCode = "";
    this.phase = "off";
    this.assessment = null;
    this.started = false;
    this.settled = null;
    this.freshThisProcess = false;
    this.activationCollection = null;
  }

  note(message) {
    try {
      this.logger?.(message);
    } catch {
      // Diagnostics must never affect the collection outcome.
    }
  }

  /**
   * Kick off collection off the startup critical path. Safe to call twice.
   * Returns a promise only so tests can await it; production callers ignore it.
   */
  start() {
    if (this.started) return this.settled;
    this.started = true;
    this.state = "pending";
    this.settled = new Promise((resolve) => {
      this.schedule(() => {
        this.run().then(resolve, () => resolve(null));
      });
    });
    return this.settled;
  }

  async run({ skipCache = false } = {}) {
    if (!skipCache) {
      try {
        const cached = await this.readCache();
        if (cached) {
          this.result = cached.result;
          this.collectedAt = cached.collectedAt;
          this.state = "ready";
          this.lastReason = "cache";
          return this.result;
        }
      } catch {
        // A broken cache is not a reason to skip collection.
      }
    }

    let result = null;
    try {
      const collect = await this.loadCollector(this.platform);
      if (typeof collect !== "function") {
        this.state = "unsupported";
        this.lastReason = "unsupported_platform";
        return null;
      }
      result = await collect({ appName: this.appName });
    } catch {
      this.state = "failed";
      this.lastReason = "collector_failed";
      this.note("machine identity collection failed");
      return null;
    }

    if (!result || Number(result.version) !== 3) {
      this.state = "failed";
      this.lastReason = "invalid_result";
      return null;
    }

    this.result = result;
    this.collectedAt = new Date(this.now()).toISOString();
    this.state = "ready";
    this.lastReason = "collected";
    this.freshThisProcess = true;
    await this.writeCache(result);
    return result;
  }

  // Cloned images may include a still-valid factor cache from the source PC.
  // Manual first activation must compare a fresh collection, never that cache.
  collectFreshForActivation() {
    if (this.activationCollection) return this.activationCollection;
    this.activationCollection = (async () => {
      await this.start();
      if (this.freshThisProcess) return this.result;
      // Never leave the copied cached result visible while fresh collection
      // is pending or times out.
      this.result = null;
      this.state = "pending";
      return this.run({ skipCache: true });
    })().finally(() => { this.activationCollection = null; });
    return this.activationCollection;
  }

  async readCache() {
    if (
      typeof this.secureStore?.readMachineIdentityFactors !== "function"
      || typeof this.secureStore?.readOrCreateOfflineHmacKey !== "function"
    ) return null;
    const envelope = await this.secureStore.readMachineIdentityFactors();
    if (!envelope) return null;
    const key = await this.secureStore.readOrCreateOfflineHmacKey();
    const verified = readIdentityCacheEnvelope({
      envelope,
      key,
      appName: this.appName,
      clientVersion: this.clientVersion,
      nowMs: this.now(),
    });
    if (!verified.ok) {
      // Discard only the identity cache. The offline grant is a separate file
      // with a separate binding and must not be touched here.
      await this.clearCache();
      this.note(`machine identity cache rejected: ${verified.reason}`);
      return null;
    }
    return verified;
  }

  async writeCache(result) {
    if (
      typeof this.secureStore?.writeMachineIdentityFactors !== "function"
      || typeof this.secureStore?.readOrCreateOfflineHmacKey !== "function"
    ) return;
    try {
      const key = await this.secureStore.readOrCreateOfflineHmacKey();
      const envelope = createIdentityCacheEnvelope({
        key,
        appName: this.appName,
        result,
        clientVersion: this.clientVersion,
        nowMs: this.now(),
      });
      await this.secureStore.writeMachineIdentityFactors(envelope);
    } catch {
      // An unwritable cache costs a re-collection next launch, nothing more.
    }
  }

  async clearCache() {
    try {
      if (typeof this.secureStore?.clearMachineIdentityFactors === "function") {
        await this.secureStore.clearMachineIdentityFactors();
      }
    } catch {
      // Ignore: the cache is advisory.
    }
  }

  /**
   * The object to merge into an outgoing license request, or null.
   * Never blocks: an unfinished collection yields null by design.
   */
  payloadForRequest() {
    if (this.state !== "ready") return null;
    try {
      return buildIdentityPayload(this.result);
    } catch {
      return null;
    }
  }

  /** Record what the server told us. Display and diagnostics only in 4a. */
  acceptServerIdentity(body) {
    const source = body && typeof body === "object" ? body : {};
    const canonical = validCanonicalMachineCode(
      source.canonical_machine_code ?? source.canonicalMachineCode,
    );
    if (canonical) this.canonicalMachineCode = canonical;

    const phase = String(source.identity_phase ?? source.identityPhase ?? "").trim();
    if (["off", "observe", "migrate", "enforce"].includes(phase)) this.phase = phase;

    const assessment = source.identity_assessment ?? source.identityAssessment;
    if (assessment && typeof assessment === "object") this.assessment = assessment;
    return this.canonicalMachineCode;
  }

  diagnostics() {
    return {
      ...publicIdentityDiagnostics({
        result: this.result,
        canonical: this.canonicalMachineCode,
        phase: this.phase,
        assessment: this.assessment,
      }),
      state: this.state,
      reason: this.lastReason,
      collectedAt: this.collectedAt,
    };
  }
}

export function createMachineIdentityService(options = {}) {
  return new MachineIdentityService(options);
}
