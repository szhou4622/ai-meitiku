import { assertMachineIdentityUsable } from "./machine-code.mjs";
import { LICENSE_CONFIG } from "./license-config.mjs";
import { secureStorageErrorMessage } from "./license-secure-store.mjs";
import { createOfflineGrant, verifyAndAdvanceOfflineGrant } from "./license-offline-grace.mjs";
import { featureRegistry, requireFeatureAccess, resolveEntitlements } from "./feature-registry.mjs";
import { createHash } from "node:crypto";

const NETWORK_ERROR_MESSAGE = "当前无法完成联网授权验证，请检查网络、VPN或防火墙；联网后将自动恢复授权验证";
const OFFLINE_GRACE_EXPIRED_MESSAGE = "当前无法完成联网授权验证，请检查网络、VPN 或防火墙。\n您的授权未失效，联网后将自动恢复使用。";
const INVALID_MESSAGE = "当前设备凭证已失效，请使用原激活码重新验证；如无法验证请联系管理员。";

const RESPONSE_CONTAINER_KEYS = Object.freeze(["data", "result", "license", "device", "credentials", "credential"]);
const ACCEPTED_ACTIVATION_ACTIONS = new Set(["", "activated", "rebound", "already_bound", "legacy_primary_adopted"]);
const TEMPORARY_AVAILABILITY_STATUSES = new Set([408, 425, 429]);
const CREDENTIAL_REVOCATION_CODES = new Set([
  "device_credential_revoked",
  "device_credential_mismatch",
  "device_binding_unbound",
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function responseSources(body) {
  if (!isObject(body)) return [];
  const sources = [];
  const seen = new Set();
  const queue = [{ value: body, depth: 0 }];
  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!isObject(value) || seen.has(value)) continue;
    seen.add(value);
    sources.push(value);
    if (depth >= 3) continue;
    for (const key of RESPONSE_CONTAINER_KEYS) {
      if (isObject(value[key])) queue.push({ value: value[key], depth: depth + 1 });
    }
  }
  return sources;
}

function firstDefined(sources, keys, fallback = null) {
  for (const source of sources) {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) return source[key];
    }
  }
  return fallback;
}

function firstPresent(sources, keys, fallback = null) {
  for (const source of sources) {
    for (const key of keys) {
      if (Object.hasOwn(source, key)) return source[key];
    }
  }
  return fallback;
}

function normalizedLicenseRecord(body, previous = {}) {
  const sources = responseSources(body);
  // Every successful online response must assert the entitlement protocol anew.
  // In particular, an explicit null VIP deadline is a revocation, not a reason
  // to reuse the last cached VIP deadline.
  const entitlementSchemaVersion = Number(firstPresent(sources, ["entitlement_schema_version"], 0)) || 0;
  const hasEntitlements = entitlementSchemaVersion >= 1;
  return {
    codeId: firstDefined(sources, ["code_id"], previous.codeId ?? null),
    deviceSession: firstDefined(sources, ["device_session"], previous.deviceSession ?? null),
    deviceCredential: firstDefined(sources, ["device_credential"], previous.deviceCredential ?? null),
    bindingStatus: String(firstDefined(sources, ["binding_status"], previous.bindingStatus ?? "")).toLowerCase(),
    licenseType: String(firstDefined(sources, ["license_type"], previous.licenseType ?? "")),
    durationDays: Number(firstDefined(sources, ["duration_days"], previous.durationDays ?? 0)) || 0,
    activatedAt: firstDefined(sources, ["activated_at"], previous.activatedAt ?? null),
    expiresAt: firstDefined(sources, ["expires_at"], previous.expiresAt ?? null),
    baseExpiresAt: hasEntitlements ? firstPresent(sources, ["base_expires_at"], null) : null,
    vipExpiresAt: hasEntitlements ? firstPresent(sources, ["vip_expires_at"], null) : null,
    basePermanent: hasEntitlements && firstPresent(sources, ["base_permanent"], false) === true,
    entitlementSchemaVersion,
    redemptionProtocolVersion: Number(firstPresent(sources, ["redemption_protocol_version"], 0)) || 0,
    remainingDays: Number(firstDefined(sources, ["remaining_days"], previous.remainingDays ?? 0)) || 0,
    transferCount: Number(firstDefined(sources, ["transfer_count"], previous.transferCount ?? 0)) || 0,
    boundMachineCode: String(firstDefined(sources, ["bound_machine_code", "machine_code", "canonical_machine_code"], previous.boundMachineCode ?? "")).trim().toLowerCase(),
    machineFactorBinding: previous.machineFactorBinding ?? "",
    activationCode: previous.activationCode ?? null,
    serverStatus: String(firstDefined(sources, ["license_status", "status"], previous.serverStatus ?? "")).toLowerCase(),
    action: String(firstDefined(sources, ["action"], previous.action ?? "")).trim().toLowerCase(),
    isExpired: firstDefined(sources, ["is_expired", "expired"], previous.isExpired ?? false) === true,
    isDisabled: firstDefined(sources, ["is_disabled", "disabled"], previous.isDisabled ?? false) === true,
  };
}

function serverMachineCode(body) {
  const value = String(firstDefined(responseSources(body), ["machine_code"], "")).trim().toLowerCase();
  return /^v[23]_[a-f0-9]{64}$/.test(value) ? value : "";
}

function serverMessage(body, fallback) {
  const value = firstDefined(responseSources(body), ["message", "error", "detail"], "");
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function hasCompleteCredential(record) {
  return Boolean(record?.deviceSession && record?.deviceCredential);
}

function hasRefreshableCredential(record) {
  return Boolean(record?.codeId && record?.deviceCredential);
}

function responseErrorCode(body) {
  return String(firstDefined(responseSources(body), ["error_code", "code"], "")).trim().toLowerCase();
}

function serverRequiresUpgrade(result) {
  return result?.response?.status === 426 || ["client_upgrade_required", "protocol_upgrade_required"].includes(responseErrorCode(result?.body));
}

function responseSaysExpired(body, record = null, nowMs = Date.now()) {
  if (responseErrorCode(body) === "license_expired") return true;
  const sources = responseSources(body);
  if (firstDefined(sources, ["is_expired", "expired"], false) === true) return true;
  if (String(firstDefined(sources, ["license_status", "status"], "")).trim().toLowerCase() === "expired") return true;
  const expiresAt = firstDefined(sources, ["expires_at"], record?.expiresAt ?? null);
  const expiryMs = Date.parse(String(expiresAt || ""));
  if (Number.isFinite(expiryMs) && expiryMs <= nowMs) return true;
  return /(?:授权|时间卡).*已过期/.test(serverMessage(body, ""));
}

function identityFactorDigest(identity) {
  if (Number(identity?.version) !== 3 || !["win32", "darwin"].includes(identity?.platform)) return "";
  const strongNames = identity.platform === "win32"
    ? new Set(["machine_guid", "bios_uuid", "system_disk_serial"])
    : new Set(["io_platform_uuid", "io_platform_serial_number"]);
  const hashes = Object.entries(identity.factors || {})
    .filter(([name]) => strongNames.has(name))
    .map(([name, entry]) => [name, String(entry?.hash || "").toLowerCase()])
    .filter(([, hash]) => /^[a-f0-9]{32}$/.test(hash))
    .sort(([a], [b]) => a.localeCompare(b));
  if (hashes.length < 2) return "";
  return createHash("sha256").update(JSON.stringify([identity.platform, hashes])).digest("hex");
}

function isTimeLicense(record) {
  const type = record.licenseType.trim().toLowerCase();
  if (!type || !Number.isFinite(record.durationDays) || record.durationDays <= 0 || !record.activatedAt || !record.expiresAt) return false;
  if (/(point|credit|score|积分|无限|unlimited|permanent|forever)/i.test(type)) return false;
  return true;
}

function isSupportedBaseLicense(record) {
  return isTimeLicense(record) || (record.entitlementSchemaVersion >= 1 && record.basePermanent === true);
}

function publicLicense(record) {
  if (!record) return null;
  return {
    bindingStatus: record.bindingStatus,
    licenseType: record.licenseType,
    durationDays: record.durationDays,
    activatedAt: record.activatedAt,
    expiresAt: record.expiresAt,
    baseExpiresAt: record.baseExpiresAt,
    vipExpiresAt: record.vipExpiresAt,
    basePermanent: record.basePermanent,
    entitlementSchemaVersion: record.entitlementSchemaVersion,
    redemptionProtocolVersion: record.redemptionProtocolVersion,
    remainingDays: record.remainingDays,
    transferCount: record.transferCount,
  };
}

function stateForRecord(record, message = "") {
  const status = record.serverStatus;
  if (record.bindingStatus === "unbound") {
    return { phase: "needs_activation", authorized: false, message: message || "当前设备已解绑，请使用原激活码重新绑定。", license: publicLicense(record) };
  }
  if (record.isDisabled || ["disabled", "revoked", "banned"].includes(status) || ["disabled", "revoked"].includes(record.bindingStatus)) {
    return { phase: "disabled", authorized: false, message: message || "授权已被禁用，请联系管理员", license: publicLicense(record) };
  }
  if (record.isExpired || status === "expired" || record.bindingStatus === "expired") {
    return { phase: "expired", authorized: false, message: message || "授权已到期", license: publicLicense(record) };
  }
  if (record.bindingStatus === "active" && isSupportedBaseLicense(record)) {
    return { phase: "active", authorized: true, message: "", license: publicLicense(record) };
  }
  return { phase: "invalid", authorized: false, message: message || "服务器返回的授权状态无效", license: publicLicense(record) };
}

function explicitDenialState(body, previous) {
  const sources = responseSources(body);
  const bindingStatus = String(firstDefined(sources, ["binding_status"], "")).trim().toLowerCase();
  const serverStatus = String(firstDefined(sources, ["license_status", "status"], "")).trim().toLowerCase();
  const disabled = firstDefined(sources, ["is_disabled", "disabled"], false) === true;
  const expired = firstDefined(sources, ["is_expired", "expired"], false) === true;
  if (
    bindingStatus === "unbound"
    || ["disabled", "revoked", "banned", "expired"].includes(bindingStatus)
    || ["disabled", "revoked", "banned", "expired"].includes(serverStatus)
    || disabled
    || expired
  ) {
    const record = normalizedLicenseRecord(body, previous);
    return { record, state: stateForRecord(record, serverMessage(body, "")) };
  }
  return null;
}

function isTemporaryAvailabilityFailure(response) {
  return TEMPORARY_AVAILABILITY_STATUSES.has(response.status) || response.status >= 500;
}

export class LicenseService {
  constructor({ secureStore, machineCode, clientVersion, fetchImpl = globalThis.fetch, config = LICENSE_CONFIG, onStateChange = () => {}, onOnlineValidated = () => {}, onDiagnostic = () => {}, now = () => Date.now(), machineIdentity = null, localMachineIdentity = null, activationIdentityWaitMs = 8_000, previewAllFeatures = false }) {
    this.secureStore = secureStore;
    this.machineCode = machineCode;
    this.localMachineIdentity = localMachineIdentity;
    // Optional. The v3 identity is an observation carried alongside the
    // request; authorization never depends on it being present.
    this.machineIdentity = machineIdentity;
    this.activationIdentityWaitMs = activationIdentityWaitMs;
    this.previewAllFeatures = previewAllFeatures === true;
    this.clientVersion = clientVersion;
    this.fetchImpl = fetchImpl;
    this.config = config;
    this.onStateChange = onStateChange;
    this.onOnlineValidated = onOnlineValidated;
    this.onDiagnostic = onDiagnostic;
    this.now = now;
    this.hasCredential = false;
    this.hasActivationCode = false;
    this.state = { phase: "checking", authorized: false, message: "正在验证授权", license: null };
    this.diagnostic("info", "license", "授权服务已初始化", {
      clientVersion: this.clientVersion,
      protocolVersion: this.config.protocolVersion,
    });
  }

  diagnostic(level, stage, message, details = {}) {
    try {
      this.onDiagnostic(level, stage, message, details);
    } catch {
      // Diagnostics are observational and must never change authorization.
    }
  }

  publicState() {
    const previewLicense = this.previewAllFeatures
      ? {
          bindingStatus: "active",
          licenseType: "source_preview",
          durationDays: 0,
          activatedAt: null,
          expiresAt: null,
          baseExpiresAt: null,
          vipExpiresAt: null,
          basePermanent: true,
          remainingDays: 0,
          transferCount: 0,
          ...(this.state.license || {}),
          // The source preview renders the current dual-deadline UI without
          // depending on a customer's stored credential or server response.
          entitlementSchemaVersion: 1,
          redemptionProtocolVersion: 1,
        }
      : null;
    const effectiveState = this.previewAllFeatures
      ? {
          ...this.state,
          previewAllFeatures: true,
          authorized: true,
          phase: "active",
          message: "",
          license: previewLicense,
        }
      : this.state;
    const rights = resolveEntitlements(effectiveState, this.now());
    const expiredAtClock = this.state.authorized && !rights.base;
    return {
      appName: this.config.appName,
      softwareName: this.config.softwareName,
      protocolVersion: this.config.protocolVersion,
      ...effectiveState,
      ...(expiredAtClock ? { authorized: false, phase: this.state.phase === "offline_active" ? "network_error" : "expired" } : {}),
      entitlements: rights,
      canUnbind: this.hasCredential,
      hasActivationCode: this.hasActivationCode,
    };
  }

  setState(next) {
    const previousPhase = this.state?.phase || "unknown";
    this.state = next;
    const nextPhase = next?.phase || "unknown";
    const level = next?.authorized
      ? "success"
      : ["invalid", "configuration_error", "disabled"].includes(nextPhase) ? "error"
        : ["network_error", "expired", "credential_missing", "renewal_required"].includes(nextPhase) ? "warning" : "info";
    this.diagnostic(level, "state", `授权状态：${previousPhase} → ${nextPhase}`, {
      authorized: next?.authorized === true,
      hasLicense: Boolean(next?.license),
      message: next?.message || "",
    });
    this.onStateChange(this.publicState());
    return this.publicState();
  }

  async localIdentityFailureState() {
    if (!this.localMachineIdentity) return null;
    try {
      assertMachineIdentityUsable(await this.localMachineIdentity());
      this.diagnostic("success", "machine_identity", "本机机器身份校验通过");
      return null;
    } catch (error) {
      const identityError = String(error?.code || "").startsWith("MACHINE_IDENTITY_");
      this.diagnostic("error", "machine_identity", "本机机器身份校验失败", {
        errorCode: error?.code || error?.name || "unknown",
        message: error?.message || "",
      });
      return this.setState({
        phase: error?.code === "MACHINE_IDENTITY_MISMATCH" ? "invalid" : "configuration_error",
        authorized: false,
        message: identityError ? error.message : secureStorageErrorMessage(error) || "本机机器身份暂时无法读取或保存，原授权已保留，请重试或联系管理员核对。",
        license: this.state.license || null,
      });
    }
  }

  async recoverHistoricalMachineCode(credential) {
    // Read-only recovery for old installs with proof but no machine-code cache.
    // A canonical v3 binding is not a recoverable local v2 alias.
    if (!hasCompleteCredential(credential) || this.effectiveMachineCode(credential)) return "";
    const { response, body } = await this.request("/device/status", {
      method: "GET", headers: this.credentialHeaders(credential),
    });
    if (!response.ok || body?.ok === false) return "";
    const code = serverMachineCode(body);
    return /^v2_[a-f0-9]{64}$/.test(code) ? code : "";
  }

  async clearDeviceCredential() {
    if (typeof this.secureStore.clearDeviceCredential === "function") {
      await this.secureStore.clearDeviceCredential();
      return;
    }
    const credential = await this.secureStore.readCredential();
    if (!credential) return;
    const preserved = { ...credential };
    delete preserved.deviceSession;
    delete preserved.deviceCredential;
    await this.secureStore.writeCredential(preserved);
    await this.clearOfflineGrant();
  }

  async clearOfflineGrant() {
    if (typeof this.secureStore.clearOfflineGrant === "function") {
      await this.secureStore.clearOfflineGrant();
    }
  }

  async recordOnlineValidation(credential, license) {
    if (
      typeof this.secureStore.readOrCreateOfflineHmacKey !== "function"
      || typeof this.secureStore.writeOfflineGrant !== "function"
    ) return;
    try {
      const key = await this.secureStore.readOrCreateOfflineHmacKey();
      const machineCode = this.effectiveMachineCode(credential) || await this.machineCode();
      const grant = createOfflineGrant({
        key,
        appName: this.config.appName,
        machineCode,
        credential,
        license: publicLicense(license),
        nowMs: this.now(),
        graceDays: this.config.offlineGraceDays,
      });
      await this.secureStore.writeOfflineGrant(grant);
    } catch {
      // Online authorization remains valid even when the optional offline cache
      // cannot be protected by the operating-system credential store.
    }
  }

  async offlineStateOrNetworkError(credential) {
    this.diagnostic("warning", "offline", "在线授权不可用，正在核对离线宽限");
    const identityFailure = await this.localIdentityFailureState();
    if (identityFailure) return identityFailure;
    const networkState = {
      phase: "network_error",
      authorized: false,
      message: NETWORK_ERROR_MESSAGE,
      license: publicLicense(credential),
    };
    if (
      typeof this.secureStore.readOfflineGrant !== "function"
      || typeof this.secureStore.readOrCreateOfflineHmacKey !== "function"
      || typeof this.secureStore.writeOfflineGrant !== "function"
    ) return this.setState(networkState);
    try {
      if (this.effectiveMachineCode(credential)) {
        // The v2 code collides by definition on cloned images. Do not let a
        // copied canonical credential/offline grant authorize another PC.
        await this.waitForActivationIdentity();
        const currentDigest = identityFactorDigest(this.machineIdentity?.payloadForRequest?.());
        if (!currentDigest || currentDigest !== credential.machineFactorBinding) {
          return this.setState({ ...networkState, message: "当前无法核对本机硬件身份；请连接网络完成授权验证。" });
        }
      }
      const envelope = await this.secureStore.readOfflineGrant();
      if (!envelope) return this.setState(networkState);
      const key = await this.secureStore.readOrCreateOfflineHmacKey();
      const machineCode = this.effectiveMachineCode(credential) || await this.machineCode();
      const nowMs = this.now();
      const result = verifyAndAdvanceOfflineGrant({
        envelope,
        key,
        appName: this.config.appName,
        machineCode,
        credential,
        nowMs,
        graceDays: this.config.offlineGraceDays,
      });
      if (!result.ok) {
        this.diagnostic("warning", "offline", "离线授权宽限不可用", { reason: result.reason || "unknown" });
        await this.clearOfflineGrant();
        const licenseExpiresAtMs = Date.parse(String(credential?.expiresAt ?? ""));
        const graceExpiredBeforeLicense = result.reason === "expired"
          && Number.isFinite(licenseExpiresAtMs)
          && nowMs < licenseExpiresAtMs;
        return this.setState({
          ...networkState,
          message: graceExpiredBeforeLicense ? OFFLINE_GRACE_EXPIRED_MESSAGE : NETWORK_ERROR_MESSAGE,
        });
      }
      await this.secureStore.writeOfflineGrant(result.envelope);
      this.diagnostic("success", "offline", "离线授权宽限校验通过", { remainingDays: result.remainingDays });
      const urgent = result.remainingDays <= 2;
      return this.setState({
        phase: "offline_active",
        authorized: true,
        message: urgent
          ? `离线模式 · 请在 ${result.remainingDays} 天内连接一次网络，否则将无法继续使用`
          : `离线模式 · 功能正常可用，联网后将自动完成授权验证（剩余 ${result.remainingDays} 天）`,
        license: result.license,
        offlineRemainingDays: result.remainingDays,
        offlineUntil: result.graceUntil,
        lastValidatedAt: result.lastValidatedAt,
      });
    } catch (error) {
      this.diagnostic("error", "offline", "离线授权宽限校验失败", { message: error?.message || "" });
      return this.setState(networkState);
    }
  }

  effectiveMachineCode(credential) {
    const bound = String(credential?.boundMachineCode || "").trim().toLowerCase();
    return /^v3_[a-f0-9]{64}$/.test(bound) ? bound : "";
  }

  async bindingMismatch(body, credential = null, allowIssuedCanonical = false) {
    const remote = serverMachineCode(body);
    if (!remote) return false;
    if (remote === await this.machineCode()) return false;
    if (remote === this.effectiveMachineCode(credential)) return false;
    // An activation may introduce an opaque server-issued canonical only after
    // a successful response with a complete device credential and matching
    // canonical field. Never accept the client candidate as a binding code.
    if (allowIssuedCanonical && /^v3_[a-f0-9]{64}$/.test(remote)) {
      const issued = String(firstDefined(responseSources(body), ["canonical_machine_code"], "")).trim().toLowerCase();
      if (issued === remote) return false;
    }
    // A diagnostic canonical from observe is not proof of an active binding.
    // Only the persisted credential or this verified activation response may
    // authorize a server-issued machine code.
    return true;
  }

  bindingMismatchState(credential) {
    return this.setState({
      phase: "invalid",
      authorized: false,
      message: "设备绑定信息异常",
      machineIdentityMessage: "检测到本机机器身份与历史授权缓存不一致。为保护现有授权，软件未自动替换机器码，请联系管理员处理。",
      license: publicLicense(credential),
    });
  }

  // Never waits for collection. An unfinished or failed collection simply
  // means the request goes out exactly as a v2 client would send it.
  identityRequestFields() {
    try {
      const payload = this.machineIdentity?.payloadForRequest?.();
      return payload ? { machine_identity_v3: payload } : {};
    } catch {
      return {};
    }
  }

  async waitForActivationIdentity() {
    const collection = this.machineIdentity?.collectFreshForActivation?.()
      ?? this.machineIdentity?.start?.();
    if (!collection) return;
    let timer;
    try {
      await Promise.race([
        collection,
        new Promise((resolve) => { timer = setTimeout(resolve, this.activationIdentityWaitMs); }),
      ]);
    } catch {
      // A collection failure leaves the existing v2/manual-review path intact.
    } finally {
      clearTimeout(timer);
    }
  }

  // Tolerates a server that knows nothing about v3: absent fields are ignored.
  noteServerIdentity(body) {
    try {
      this.machineIdentity?.acceptServerIdentity?.(body);
    } catch {
      // Diagnostics only; must never affect the authorization outcome.
    }
  }

  async request(pathname, options = {}) {
    const startedAt = this.now();
    const method = String(options.method || "GET").toUpperCase();
    this.diagnostic("info", "network", `开始请求 ${method} ${pathname}`, { endpoint: pathname, method });
    let response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${pathname}`, {
        ...options,
        redirect: "error",
        headers: {
          accept: "application/json",
          "X-AI-Media-Client-Version": this.clientVersion,
          "X-AI-Media-License-Protocol": String(this.config.protocolVersion),
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...(options.headers ?? {}),
        },
        signal: AbortSignal.timeout(12000),
      });
    } catch (error) {
      this.diagnostic("error", "network", `请求失败 ${method} ${pathname}`, {
        endpoint: pathname,
        method,
        durationMs: Math.max(0, this.now() - startedAt),
        errorType: error?.name || "network_error",
        errorCode: error?.code || error?.cause?.code || "",
        stack: error?.stack || "",
        cause: error?.cause,
        message: error?.message || "",
      });
      const wrapped = new Error(NETWORK_ERROR_MESSAGE);
      wrapped.kind = "network";
      wrapped.cause = error;
      throw wrapped;
    }

    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    this.diagnostic(response.ok ? "success" : response.status >= 500 ? "error" : "warning", "network", `收到授权服务响应 ${response.status}`, {
      endpoint: pathname,
      method,
      httpStatus: response.status,
      durationMs: Math.max(0, this.now() - startedAt),
      errorCode: responseErrorCode(body) || "",
      serverMessage: serverMessage(body, ""),
      bindingStatus: String(firstDefined(responseSources(body), ["binding_status"], "")),
      licenseStatus: String(firstDefined(responseSources(body), ["license_status"], "")),
      action: String(firstDefined(responseSources(body), ["action"], "")),
    });
    return { response, body };
  }

  credentialHeaders(credential) {
    return {
      Authorization: `Bearer ${credential.deviceSession}`,
      "X-Device-Credential": credential.deviceCredential,
    };
  }

  async refreshDeviceSession(credential) {
    if (!hasRefreshableCredential(credential)) return { ok: false, credential, body: {}, response: null };
    this.diagnostic("info", "session", "开始刷新设备会话");
    if (await this.localIdentityFailureState()) return { ok: false, credential, body: {}, response: null };
    let result;
    try {
      result = await this.request("/device/refresh", {
        method: "POST",
        headers: { "X-Device-Credential": credential.deviceCredential },
        body: JSON.stringify({
          app_name: this.config.appName,
          code_id: credential.codeId,
          machine_code: this.effectiveMachineCode(credential) || await this.machineCode(),
          client_version: this.clientVersion,
          license_protocol_version: this.config.protocolVersion,
        }),
      });
    } catch (error) {
      return { ok: false, credential, body: {}, response: null, error };
    }
    if (!result.response.ok) return { ok: false, credential, ...result };
    // Require an explicitly issued session; an empty reply must not inherit
    // the expired session from the previous record.
    const issuedSession = firstDefined(responseSources(result.body), ["device_session"], null);
    if (typeof issuedSession !== "string" || !issuedSession.trim()
      || result.body?.ok === false || result.body?.success === false) {
      return { ok: false, credential, ...result };
    }
    const refreshed = normalizedLicenseRecord(result.body, credential);
    if (firstPresent(responseSources(result.body), ["entitlement_schema_version"], undefined) === undefined) {
      // A session-rotation response may omit rights. They remain provisional
      // until the following status call; do not grant access from this record.
      refreshed.baseExpiresAt = credential.baseExpiresAt ?? null;
      refreshed.vipExpiresAt = credential.vipExpiresAt ?? null;
      refreshed.basePermanent = credential.basePermanent === true;
      refreshed.entitlementSchemaVersion = credential.entitlementSchemaVersion || 0;
      refreshed.redemptionProtocolVersion = credential.redemptionProtocolVersion || 0;
    }
    // /device/refresh intentionally never returns the long-lived credential.
    // Preserve it and update only the short-lived session/status fields.
    refreshed.deviceCredential = credential.deviceCredential;
    refreshed.activationCode = credential.activationCode ?? null;
    refreshed.machineFactorBinding = credential.machineFactorBinding ?? "";
    if (!refreshed.deviceSession) return { ok: false, credential, ...result };
    await this.secureStore.writeCredential(refreshed);
    this.diagnostic("success", "session", "设备会话已刷新并安全保存");
    this.hasCredential = true;
    this.hasActivationCode = Boolean(refreshed.activationCode);
    return { ok: true, credential: refreshed, ...result };
  }

  async initialize() {
    this.diagnostic("info", "startup", "开始读取本地授权凭证");
    const credential = await this.secureStore.readCredential();
    this.hasCredential = hasCompleteCredential(credential);
    this.hasActivationCode = Boolean(credential?.activationCode);
    this.diagnostic(this.hasCredential ? "success" : "info", "secure_storage", this.hasCredential ? "已读取完整设备凭证" : "未找到完整设备凭证", {
      hasCredential: this.hasCredential,
      hasRefreshableCredential: hasRefreshableCredential(credential),
      hasActivationCode: this.hasActivationCode,
    });
    if (this.hasCredential || hasRefreshableCredential(credential)) {
      const identityFailure = await this.localIdentityFailureState();
      if (identityFailure) return identityFailure;
    }
    return this.refresh(credential);
  }

  async activate(activationCode, { stageOnly = false } = {}) {
    const code = String(activationCode ?? "").trim();
    if (!code) return this.setState({ phase: "needs_activation", authorized: false, message: "请输入激活码", license: null });
    if (code.length > 512) return this.setState({ phase: "needs_activation", authorized: false, message: "激活码格式不正确", license: null });

    this.diagnostic("info", "activation", "用户开始激活验证", { activationCodePresent: true });
    // Existing device proof is optional for a new installation. When present,
    // it lets the server distinguish a valid current device from a v2 collision.
    let existingCredential = null;
    try {
      existingCredential = await this.secureStore.readCredential();
    } catch (error) {
      return this.setState({
        phase: "needs_activation", authorized: false,
        message: `${secureStorageErrorMessage(error) || "本机授权凭证读取失败，原数据已保留。请重试或联系管理员核对。"} 未向服务器提交激活请求。`,
        license: null,
      });
    }
    const identityFailure = await this.localIdentityFailureState();
    if (identityFailure) return identityFailure;
    if (existingCredential?.deviceCredential && !hasCompleteCredential(existingCredential)) {
      // A partially readable record is not a new installation. Recover the
      // short session before submitting activation with existing device proof.
      // On failure, keep the record and stop instead of requesting a blind
      // overwrite of the server's existing binding.
      const recoveryState = await this.refresh(existingCredential);
      existingCredential = await this.secureStore.readCredential();
      if (!hasCompleteCredential(existingCredential) || recoveryState.phase === "update_required") {
        return recoveryState;
      }
    }
    const hasExistingProof = hasCompleteCredential(existingCredential);
    this.diagnostic("info", "activation", "本地授权证明检查完成", { hasExistingProof });
    await this.waitForActivationIdentity();
    const identityFields = this.identityRequestFields();
    const identityPayload = identityFields.machine_identity_v3;
    const strongFactorNames = identityPayload?.platform === "win32"
      ? ["machine_guid", "bios_uuid", "system_disk_serial"]
      : identityPayload?.platform === "darwin" ? ["io_platform_uuid", "io_platform_serial_number"] : [];
    const strongFactorCount = strongFactorNames.filter((name) => identityPayload?.factors?.[name]?.hash).length;
    this.diagnostic(identityPayload ? "success" : "warning", "machine_identity", identityPayload ? "激活身份因子采集完成" : "未采集到可随激活请求上传的强身份因子", {
      platform: identityPayload?.platform || process.platform,
      strongFactorCount,
      lowConfidence: identityPayload?.low_confidence === true,
    });
    // The recovery secret is protected by safeStorage and persisted BEFORE the
    // request. An uncertain success can therefore be safely retried.
    let recoverySecret = "";
    try {
      recoverySecret = typeof this.secureStore.readOrCreateActivationRecoverySecret === "function"
        ? await this.secureStore.readOrCreateActivationRecoverySecret()
        : "";
    } catch (error) {
      this.diagnostic("error", "secure_storage", "无法创建激活恢复证明", { message: error?.message || "" });
      return this.setState({
        phase: "needs_activation", authorized: false,
        message: "本机安全凭证存储暂不可用，未向服务器提交激活请求。请检查系统凭证服务后重试。",
        license: null,
      });
    }
    let result;
    try {
      result = await this.request("/activate", {
        method: "POST",
        ...(hasExistingProof ? { headers: this.credentialHeaders(existingCredential) } : {}),
        body: JSON.stringify({
          app_name: this.config.appName,
          activation_code: code,
          machine_code: await this.machineCode(),
          client_version: this.clientVersion,
          license_protocol_version: this.config.protocolVersion,
          ...(hasExistingProof ? { device_credential: existingCredential.deviceCredential } : {}),
          ...(recoverySecret ? { activation_recovery_secret: recoverySecret } : {}),
          ...identityFields,
        }),
      });
    } catch (error) {
      if (error?.kind === "network") {
        return this.setState({ phase: "network_error", authorized: false, message: NETWORK_ERROR_MESSAGE, license: null });
      }
      throw error;
    }
    if (serverRequiresUpgrade(result)) {
      await this.clearOfflineGrant();
      return this.setState({ phase: "update_required", authorized: false, message: serverMessage(result.body, "当前版本需要更新后继续授权"), license: publicLicense(existingCredential) });
    }

    if (!result.response.ok) {
      const message = serverMessage(result.body, "未能完成激活，请核对激活码输入后重试；如仍失败，请复制机器码联系客服查询。");
      const action = String(firstDefined(responseSources(result.body), ["action"], "")).trim().toLowerCase();
      if (action === "renewal_requires_confirmation" && hasExistingProof) {
        return this.setState({
          phase: "renewal_required", authorized: false, action,
          message, license: publicLicense(existingCredential),
        });
      }
      return this.setState({ phase: "needs_activation", authorized: false, message, license: null });
    }

    const record = normalizedLicenseRecord(result.body);
    this.diagnostic(result.response.ok ? "success" : "warning", "activation", "激活响应已解析", {
      action: record.action,
      bindingStatus: record.bindingStatus,
      licenseType: record.licenseType,
      durationDays: record.durationDays,
      expiresAt: record.expiresAt || "",
      hasCompleteCredential: hasCompleteCredential(record),
    });
    if (await this.bindingMismatch(result.body, existingCredential, hasCompleteCredential(record))) return this.bindingMismatchState(null);
    this.noteServerIdentity(result.body);
    const responseMessage = serverMessage(result.body, "");
    if (record.action === "balance_merged") {
      return this.setState({ phase: "invalid", authorized: false, action: record.action, message: responseMessage || "时间授权不能使用积分合并", license: publicLicense(record) });
    }
    if (!ACCEPTED_ACTIVATION_ACTIONS.has(record.action)) {
      return this.setState({ phase: "invalid", authorized: false, action: record.action, message: responseMessage || "授权服务器返回了客户端不支持的激活动作", license: publicLicense(record) });
    }
    if (!hasCompleteCredential(record)) {
      const prefix = responseMessage ? `${responseMessage} ` : "";
      return this.setState({
        phase: "credential_missing",
        authorized: false,
        action: record.action,
        message: `${prefix}授权已被服务器处理，但本机没有收到完整设备凭证。请在后台按机器码重置绑定后重新激活。`,
        license: publicLicense(record),
      });
    }
    if (!isSupportedBaseLicense(record)) {
      return this.setState({ phase: "invalid", authorized: false, message: "当前软件只支持月卡和年卡时间授权", license: publicLicense(record) });
    }

    record.activationCode = code;
    if (this.effectiveMachineCode(record)) {
      record.machineFactorBinding = identityFactorDigest(this.machineIdentity?.payloadForRequest?.());
      if (!record.machineFactorBinding) {
        return this.setState({
          phase: "needs_activation", authorized: false,
          message: "服务器已确认激活，但本机硬件采集结果不足。请保持联网并使用同一激活码重试，不会重算有效期。",
          license: publicLicense(record),
        });
      }
    }
    try {
      await this.secureStore.writeCredential(record);
      this.diagnostic("success", "secure_storage", "设备授权凭证已安全保存");
    } catch (error) {
      this.diagnostic("error", "secure_storage", "设备授权凭证保存失败", { message: error?.message || "" });
      return this.setState({
        phase: "needs_activation", authorized: false,
        message: this.effectiveMachineCode(record)
          ? "服务器已确认激活，但本机安全存储暂时失败。请修复后用同一激活码重试，不会重复消耗或重算有效期。"
          : "服务器已处理激活，但本机安全存储失败。请联系管理员核对后重试。",
        license: publicLicense(record),
      });
    }
    if (stageOnly) return this.setState({ phase: "checking", authorized: false, license: null, message: "服务器已确认，正在保存设备身份" });
    if (this.effectiveMachineCode(record)) {
      try {
        this.machineIdentity?.acceptServerIdentity?.({ canonical_machine_code: record.boundMachineCode });
      } catch {
        // Display-only identity state cannot undo a persisted authorization.
      }
    }
    this.hasCredential = true;
    this.hasActivationCode = true;
    await this.recordOnlineValidation(record, record);
    return this.refresh(record);
  }

  async renewTimeLicense(activationCode) {
    const code = String(activationCode ?? "").trim();
    if (!code) return this.setState({ ...this.state, message: "请输入新的月卡或年卡激活码" });
    if (code.length > 512) return this.setState({ ...this.state, message: "激活码格式不正确" });
    this.diagnostic("info", "renewal", "用户开始时间授权续期", { activationCodePresent: true });
    let credential = await this.secureStore.readCredential();
    if (!hasRefreshableCredential(credential)) {
      return this.setState({ phase: "credential_missing", authorized: false, message: "本机原设备凭证缺失，不能安全使用新码恢复授权；请复制脱敏诊断联系管理员核对。", license: publicLicense(credential) });
    }
    if (!hasCompleteCredential(credential)) {
      const recovered = await this.refreshDeviceSession(credential);
      if (serverRequiresUpgrade(recovered)) {
        await this.clearOfflineGrant();
        return this.setState({ phase: "update_required", authorized: false, message: serverMessage(recovered.body, "当前版本需要更新后续期"), license: publicLicense(credential) });
      }
      if (!recovered.ok) {
        return this.setState({ phase: "expired", authorized: false, message: serverMessage(recovered.body, "无法恢复设备会话，新激活码未使用。请联系管理员核对本机凭证。"), license: publicLicense(credential) });
      }
      credential = recovered.credential;
    }
    if (Number(credential.redemptionProtocolVersion) >= 1) {
      try {
        return await this.redeemTimeCode(code, { allowExpired: true, credential });
      } catch (error) {
        return this.setState({
          phase: this.state.phase === "renewal_required" ? "renewal_required" : "expired",
          authorized: false,
          message: error?.message || "时间码兑换失败，请保留原码重试",
          license: publicLicense(credential),
        });
      }
    }
    const requestId = createHash("sha256")
      .update(`aiml-time-renew-v1\0${credential.codeId}\0${code}`)
      .digest("hex");
    let result;
    try {
      result = await this.request("/time/renew", {
        method: "POST",
        headers: this.credentialHeaders(credential),
        body: JSON.stringify({
          app_name: this.config.appName,
          activation_code: code,
          request_id: requestId,
          confirm_renewal: true,
          client_version: this.clientVersion,
          license_protocol_version: this.config.protocolVersion,
        }),
      });
    } catch (error) {
      if (error?.kind === "network") {
        return this.setState({ phase: this.state.phase === "renewal_required" ? "renewal_required" : "expired", authorized: false, message: `${NETWORK_ERROR_MESSAGE}；新激活码未确认使用。`, license: publicLicense(credential) });
      }
      throw error;
    }
    if (serverRequiresUpgrade(result)) {
      await this.clearOfflineGrant();
      return this.setState({ phase: "update_required", authorized: false, message: serverMessage(result.body, "当前版本需要更新后续期"), license: publicLicense(credential) });
    }
    if (!result.response.ok) {
      return this.setState({
        phase: this.state.phase === "renewal_required" ? "renewal_required" : "expired",
        authorized: false,
        message: serverMessage(result.body, "未能完成续期，新激活码未确认使用；请稍后重试。"),
        license: publicLicense(credential),
      });
    }
    const renewalAction = String(firstDefined(responseSources(result.body), ["action"], "")).trim().toLowerCase();
    if (renewalAction !== "time_renewed") {
      return this.setState({
        phase: this.state.phase === "renewal_required" ? "renewal_required" : "expired",
        authorized: false,
        message: "续期响应无法确认，本机未更改授权缓存。请保留新卡并重试。",
        license: publicLicense(credential),
      });
    }
    const updated = normalizedLicenseRecord(result.body, credential);
    updated.deviceSession = credential.deviceSession;
    updated.deviceCredential = credential.deviceCredential;
    updated.activationCode = credential.activationCode ?? null;
    updated.machineFactorBinding = credential.machineFactorBinding ?? "";
    await this.secureStore.writeCredential(updated);
    this.diagnostic("success", "secure_storage", "续期后的授权状态已安全保存", {
      expiresAt: updated.expiresAt || "",
      durationDays: updated.durationDays,
    });
    this.hasCredential = true;
    this.hasActivationCode = Boolean(updated.activationCode);
    return this.refresh(updated);
  }

  // Enabled only after a compatible server explicitly advertises atomic
  // two-deadline redemption. An old /time/renew must never consume a VIP code.
  async redeemTimeCode(activationCode, { allowExpired = false, credential: suppliedCredential = null } = {}) {
    if (!allowExpired) {
      this.assertAuthorized();
      if (this.state.phase !== "active") throw new Error("兑换时间码需要联网确认，请联网后重新验证授权");
    } else if (!["expired", "renewal_required"].includes(this.state.phase)) {
      throw new Error("当前授权状态不能使用过期续期流程");
    }
    const credential = suppliedCredential ?? await this.secureStore.readCredential();
    if (!hasCompleteCredential(credential)) throw new Error("本机设备凭证不完整，请先恢复设备会话");
    if (Number(credential?.redemptionProtocolVersion) < 1) {
      const error = new Error("当前授权服务尚未支持免费/VIP双期限兑换，请稍后重试");
      error.code = "REDEMPTION_PROTOCOL_UNAVAILABLE";
      throw error;
    }
    const code = String(activationCode ?? "").trim();
    if (!code || code.length > 512) throw new Error("请输入有效时间码");
    const requestId = createHash("sha256").update(`aiml-time-redeem-v1\0${credential.codeId}\0${code}`).digest("hex");
    const result = await this.request("/time/renew", {
      method: "POST",
      headers: this.credentialHeaders(credential),
      body: JSON.stringify({
        app_name: this.config.appName,
        activation_code: code,
        request_id: requestId,
        confirm_renewal: true,
        redemption_protocol_version: 1,
        client_version: this.clientVersion,
        license_protocol_version: this.config.protocolVersion,
      }),
    });
    if (serverRequiresUpgrade(result)) throw new Error(serverMessage(result.body, "当前版本需要更新后兑换时间码"));
    if (!result.response.ok) throw new Error(serverMessage(result.body, "时间码兑换失败；请保留原码重试"));
    if (String(firstDefined(responseSources(result.body), ["action"], "")) !== "time_renewed") {
      throw new Error("兑换响应无法确认；请先重新验证授权，不要更换时间码");
    }
    const sources = responseSources(result.body);
    const codeKind = String(firstDefined(sources, ["code_kind"], "")).trim().toLowerCase();
    const durationDays = Number(firstDefined(sources, ["duration_days"], 0));
    const refreshed = await this.refresh(credential);
    return {
      ...refreshed,
      redemption: codeKind === "base" || codeKind === "vip"
        ? {
            codeKind,
            durationDays: Number.isFinite(durationDays) && durationDays > 0 ? durationDays : null,
            idempotent: firstDefined(sources, ["idempotent"], false) === true,
          }
        : null,
    };
  }

  async refresh(existingCredential = null, allowSessionRefresh = true) {
    this.diagnostic("info", "status", "开始验证设备授权状态", { allowSessionRefresh });
    const credential = existingCredential ?? await this.secureStore.readCredential();
    this.hasCredential = hasCompleteCredential(credential);
    this.hasActivationCode = Boolean(credential?.activationCode);
    if (!this.hasCredential) {
      if (hasRefreshableCredential(credential) && allowSessionRefresh) {
        const recovered = await this.refreshDeviceSession(credential);
        if (serverRequiresUpgrade(recovered)) {
          await this.clearOfflineGrant();
          return this.setState({ phase: "update_required", authorized: false, message: serverMessage(recovered.body, "当前版本需要更新后恢复设备会话"), license: publicLicense(credential) });
        }
        if (recovered.ok) return this.refresh(recovered.credential, false);
        if (CREDENTIAL_REVOCATION_CODES.has(responseErrorCode(recovered.body))) {
          await this.clearDeviceCredential();
          this.hasCredential = false;
          return this.setState({ phase: "invalid", authorized: false, message: INVALID_MESSAGE, license: publicLicense(credential) });
        }
        if (responseSaysExpired(recovered.body, credential, this.now())) {
          return this.setState({ phase: "expired", authorized: false, message: "授权已到期，设备凭证已保留。", license: publicLicense(credential) });
        }
        return this.setState({ phase: "network_error", authorized: false, message: "设备会话暂未恢复，长期凭证已保留，将自动重试。", license: publicLicense(credential) });
      }
      return this.setState({ phase: "needs_activation", authorized: false, message: "请输入激活码以继续使用", license: null });
    }

    const identityFailure = await this.localIdentityFailureState();
    if (identityFailure) return identityFailure;

    let result;
    try {
      result = await this.request("/device/status", {
        method: "GET",
        headers: this.credentialHeaders(credential),
      });
    } catch (error) {
      if (error?.kind === "network") {
        return this.offlineStateOrNetworkError(credential);
      }
      throw error;
    }

    if (serverRequiresUpgrade(result)) {
      await this.clearOfflineGrant();
      return this.setState({ phase: "update_required", authorized: false, message: serverMessage(result.body, "当前版本需要更新后继续验证授权"), license: publicLicense(credential) });
    }

    if (await this.bindingMismatch(result.body, credential)) {
      await this.clearOfflineGrant();
      return this.bindingMismatchState(credential);
    }
    this.noteServerIdentity(result.body);
    if (result.response.status === 401) {
      const errorCode = responseErrorCode(result.body);
      if (CREDENTIAL_REVOCATION_CODES.has(errorCode)) {
        await this.clearDeviceCredential();
        this.hasCredential = false;
        this.hasActivationCode = Boolean(credential?.activationCode);
        return this.setState({ phase: "invalid", authorized: false, message: INVALID_MESSAGE, license: publicLicense(credential) });
      }
      const recovered = allowSessionRefresh
        ? await this.refreshDeviceSession(credential)
        : { ok: false, credential, body: {}, response: null };
      if (serverRequiresUpgrade(recovered)) {
        await this.clearOfflineGrant();
        return this.setState({ phase: "update_required", authorized: false, message: serverMessage(recovered.body, "当前版本需要更新后继续验证授权"), license: publicLicense(credential) });
      }
      if (recovered.ok) {
        if (responseSaysExpired(recovered.body, recovered.credential, this.now())) {
          await this.clearOfflineGrant();
          return this.setState({ phase: "expired", authorized: false, message: serverMessage(recovered.body, "授权已到期，设备凭证已保留。可使用新的月卡或年卡恢复授权。"), license: publicLicense(recovered.credential) });
        }
        return this.refresh(recovered.credential, false);
      }
      if (CREDENTIAL_REVOCATION_CODES.has(responseErrorCode(recovered.body))) {
        await this.clearDeviceCredential();
        this.hasCredential = false;
        this.hasActivationCode = Boolean(credential?.activationCode);
        return this.setState({ phase: "invalid", authorized: false, message: INVALID_MESSAGE, license: publicLicense(credential) });
      }
      if (!responseSaysExpired(result.body, credential, this.now())
        && (recovered.error?.kind === "network"
          || (recovered.response && isTemporaryAvailabilityFailure(recovered.response)))) {
        return this.offlineStateOrNetworkError(credential);
      }
      await this.clearOfflineGrant();
      if (responseSaysExpired(result.body, credential, this.now()) || responseSaysExpired(recovered.body, credential, this.now())) {
        return this.setState({ phase: "expired", authorized: false, message: "授权已到期，设备凭证已保留。可使用新的月卡或年卡恢复授权。", license: publicLicense(credential) });
      }
      this.hasCredential = hasCompleteCredential(credential);
      return this.setState({ phase: "invalid", authorized: false, message: serverMessage(result.body, INVALID_MESSAGE), license: publicLicense(credential) });
    }
    if (result.response.status === 409) {
      await this.clearOfflineGrant();
      return this.setState({ phase: "invalid", authorized: false, message: serverMessage(result.body, "设备授权状态冲突"), license: publicLicense(credential) });
    }
    const explicitDenial = explicitDenialState(result.body, credential);
    if (explicitDenial) {
      if (explicitDenial.record.bindingStatus === "unbound") {
        await this.clearDeviceCredential();
        this.hasCredential = false;
      } else {
        await this.clearOfflineGrant();
      }
      return this.setState(explicitDenial.state);
    }
    if (isTemporaryAvailabilityFailure(result.response)) {
      return this.offlineStateOrNetworkError(credential);
    }
    if (!result.response.ok) {
      await this.clearOfflineGrant();
      return this.setState({ phase: "invalid", authorized: false, message: serverMessage(result.body, "授权验证失败，请重试"), license: publicLicense(credential) });
    }

    if (result.body?.ok === false || result.body?.success === false
      || firstDefined(responseSources(result.body), ["binding_status"], null) !== "active") {
      // A malformed status reply must neither overwrite local proof nor
      // extend the offline grace period as if online validation succeeded.
      return this.offlineStateOrNetworkError(credential);
    }
    const record = normalizedLicenseRecord(result.body, credential);
    // A status response may update entitlement metadata, but it is not a
    // credential-rotation endpoint. Keep both local device secrets unchanged.
    record.deviceSession = credential.deviceSession;
    record.deviceCredential = credential.deviceCredential;
    const next = stateForRecord(record, serverMessage(result.body, ""));
    if (record.bindingStatus === "unbound") {
      await this.clearDeviceCredential();
      this.hasCredential = false;
      this.hasActivationCode = Boolean(credential?.activationCode);
    } else {
      await this.secureStore.writeCredential(record);
      this.diagnostic("success", "secure_storage", "最新授权状态已安全保存");
      this.hasCredential = true;
      this.hasActivationCode = Boolean(record.activationCode);
      if (next.authorized) await this.recordOnlineValidation(record, record);
      else await this.clearOfflineGrant();
    }
    const state = this.setState(next);
    const confirmedBinding = String(firstDefined(responseSources(result.body), ["binding_status"], "")).toLowerCase() === "active";
    if (next.phase === "active" && confirmedBinding) {
      try {
        // The observer is advisory. Never await or expose its failures on the
        // authorization path; only a real online status success fires it.
        void Promise.resolve(this.onOnlineValidated()).catch(() => {});
      } catch {
      }
    }
    return state;
  }

  async unbind(existingCredential = null, allowSessionRefresh = true) {
    this.diagnostic("warning", "unbind", "用户开始解绑当前设备");
    const credential = existingCredential ?? await this.secureStore.readCredential();
    this.hasCredential = hasCompleteCredential(credential);
    this.hasActivationCode = Boolean(credential?.activationCode);
    if (!this.hasCredential) {
      if (hasRefreshableCredential(credential) && allowSessionRefresh) {
        const recovered = await this.refreshDeviceSession(credential);
        if (recovered.ok) return this.unbind(recovered.credential, false);
        if (serverRequiresUpgrade(recovered)) {
          await this.clearOfflineGrant();
          return this.setState({ phase: "update_required", authorized: false, message: serverMessage(recovered.body, "当前版本需要更新后解绑"), license: publicLicense(credential) });
        }
        if (CREDENTIAL_REVOCATION_CODES.has(responseErrorCode(recovered.body))) {
          await this.clearDeviceCredential();
          this.hasCredential = false;
          return this.setState({ phase: "invalid", authorized: false, message: INVALID_MESSAGE, license: publicLicense(credential) });
        }
        return this.setState({ phase: "credential_missing", authorized: false, message: "设备会话暂未恢复，未完成解绑，原凭证已保留。请恢复授权验证后重试。", license: publicLicense(credential) });
      }
      this.hasActivationCode = Boolean(credential?.activationCode);
      return this.setState({ phase: "needs_activation", authorized: false, message: "当前设备没有可用的本地授权凭证", license: null });
    }

    const identityFailure = await this.localIdentityFailureState();
    if (identityFailure) return identityFailure;

    let result;
    try {
      result = await this.request("/device/unbind", {
        method: "POST",
        headers: this.credentialHeaders(credential),
        body: JSON.stringify({
          app_name: this.config.appName,
          machine_code: this.effectiveMachineCode(credential) || await this.machineCode(),
          client_version: this.clientVersion,
          license_protocol_version: this.config.protocolVersion,
        }),
      });
    } catch (error) {
      if (error?.kind === "network") {
        return this.offlineStateOrNetworkError(credential);
      }
      throw error;
    }

    if (serverRequiresUpgrade(result)) {
      await this.clearOfflineGrant();
      return this.setState({ phase: "update_required", authorized: false, message: serverMessage(result.body, "当前版本需要更新后解绑"), license: publicLicense(credential) });
    }
    if (await this.bindingMismatch(result.body, credential)) return this.bindingMismatchState(credential);
    if (result.response.status === 401) {
      if (CREDENTIAL_REVOCATION_CODES.has(responseErrorCode(result.body))) {
        await this.clearDeviceCredential();
        this.hasCredential = false;
        return this.setState({ phase: "invalid", authorized: false, message: INVALID_MESSAGE, license: publicLicense(credential) });
      }
      if (allowSessionRefresh) {
        const recovered = await this.refreshDeviceSession(credential);
        if (recovered.ok) return this.unbind(recovered.credential, false);
        if (serverRequiresUpgrade(recovered)) {
          await this.clearOfflineGrant();
          return this.setState({ phase: "update_required", authorized: false, message: serverMessage(recovered.body, "当前版本需要更新后解绑"), license: publicLicense(credential) });
        }
        if (CREDENTIAL_REVOCATION_CODES.has(responseErrorCode(recovered.body))) {
          await this.clearDeviceCredential();
          this.hasCredential = false;
        }
      }
      return this.setState({ phase: "invalid", authorized: false, message: "解绑验证未完成，请重新验证授权后重试。", license: publicLicense(credential) });
    }
    if (result.response.status === 409) {
      return this.setState({ phase: "invalid", authorized: false, message: serverMessage(result.body, "设备解绑失败"), license: publicLicense(credential) });
    }
    if (!result.response.ok || result.body?.ok === false || result.body?.success === false
      || (result.body?.ok !== true && result.body?.success !== true)) {
      return this.setState({ phase: "invalid", authorized: false, message: serverMessage(result.body, "设备解绑失败"), license: publicLicense(credential) });
    }

    await this.clearDeviceCredential();
    this.diagnostic("success", "unbind", "设备解绑完成，本地设备凭证已清除");
    this.hasCredential = false;
    this.hasActivationCode = Boolean(credential?.activationCode);
    return this.setState({ phase: "needs_activation", authorized: false, message: "当前设备已解绑，请使用原激活码重新绑定。", license: null });
  }

  async resetOfflineCache() {
    await this.clearOfflineGrant();
    return this.refresh();
  }

  async activationCode() {
    this.assertAuthorized();
    const credential = await this.secureStore.readCredential();
    const code = String(credential?.activationCode ?? "").trim();
    if (!hasCompleteCredential(credential) || !code) {
      const error = new Error("本机尚未补录激活码，可在授权管理中补录，或复制机器码联系客服查询。");
      error.code = "ACTIVATION_CODE_UNAVAILABLE";
      throw error;
    }
    return code;
  }

  async saveActivationCode(activationCode) {
    this.assertAuthorized();
    const code = String(activationCode ?? "").trim();
    if (!code) throw new Error("请输入需要补录的激活码");
    if (code.length > 512) throw new Error("激活码格式不正确");
    const credential = await this.secureStore.readCredential();
    if (!hasCompleteCredential(credential)) throw new Error("当前设备凭证不完整，不能补录激活码");
    await this.secureStore.writeCredential({ ...credential, activationCode: code });
    this.hasCredential = true;
    this.hasActivationCode = true;
    return this.setState(this.state);
  }

  assertAuthorized() {
    if (!this.publicState().authorized) {
      const error = new Error("请先完成在线授权验证");
      error.code = "LICENSE_REQUIRED";
      throw error;
    }
  }

  assertFeature(featureId) {
    requireFeatureAccess(featureRegistry, featureId, this.publicState(), this.now());
  }
}

export const licenseMessages = Object.freeze({ NETWORK_ERROR_MESSAGE, INVALID_MESSAGE });
