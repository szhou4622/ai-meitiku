import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

const CREDENTIAL_FILE = "license-credential.v2.bin";
const MACHINE_SEED_FILE = "license-machine-seed.v2.bin";
const MACHINE_CODE_FILE = "license-machine-code.v2.bin";
const MACHINE_IDENTITY_FILE = "license-machine-identity.v3.bin";
const OFFLINE_HMAC_KEY_FILE = "license-offline-hmac-key.v1.bin";
const OFFLINE_GRANT_FILE = "license-offline-grant.v1.bin";
// The v3 factor observation lives in its own file. It must never share a slot
// with the offline grant: the grant is bound to the v2 machine code and a
// hardware change must not be able to invalidate it.
const MACHINE_IDENTITY_FACTORS_FILE = "license-machine-identity.v3-factors.bin";
const IDENTITY_OBSERVE_CONFIRMATION_FILE = "license-machine-identity.observe-confirmed.v1.bin";
const ACTIVATION_RECOVERY_SECRET_FILE = "license-canonical-recovery.v1.bin";

function decryptionUnavailableError() {
  const error = new Error(
    "本机安全凭证无法解密，原数据未作更改。请使用创建该凭证时的同一系统账户，或联系管理员核对。",
  );
  error.code = "SECURE_STORAGE_DECRYPT_FAILED";
  return error;
}

function encryptionUnavailableError() {
  const error = new Error(
    "本机安全凭证无法保存，原数据未作更改。请关闭其他正在运行的软件窗口后重试，或联系管理员核对。",
  );
  error.code = "SECURE_STORAGE_ENCRYPT_FAILED";
  return error;
}

function invalidSecureDataError() {
  const error = new Error("本机加密授权数据格式异常，原数据未作更改。请联系管理员核对。");
  error.code = "SECURE_STORAGE_DATA_INVALID";
  return error;
}

function secureReadUnavailableError() {
  const error = new Error("本机加密授权数据暂时无法读取，原数据未作更改。请重试或联系管理员核对。");
  error.code = "SECURE_STORAGE_READ_FAILED";
  return error;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validPersistedCredential(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) return false;
  return [
    "codeId", "code_id", "deviceSession", "device_session",
    "deviceCredential", "device_credential", "activationCode", "activation_code",
  ].some((key) => typeof value[key] === "string" && value[key].trim());
}

function validPersistedMachineIdentity(value) {
  return isPlainObject(value)
    && Number(value.version) === 3
    && /^v2_[a-f0-9]{64}$/.test(String(value.active_machine_code || "").trim().toLowerCase());
}

export function secureStorageErrorMessage(error) {
  if (error?.code === "SECURE_STORAGE_DECRYPT_FAILED") {
    return "本机加密授权凭证无法读取，原数据已保留。请确认正在使用原系统账户，或联系管理员核对。";
  }
  if (error?.code === "SECURE_STORAGE_ENCRYPT_FAILED") {
    return "本机安全凭证无法保存，原数据已保留。请完全退出其他正在运行的 AI媒体库窗口后重试；如仍失败请联系管理员。";
  }
  if (error?.code === "SECURE_STORAGE_DATA_INVALID") {
    return "本机加密授权数据格式异常，原数据已保留。请联系管理员核对。";
  }
  if (error?.code === "SECURE_STORAGE_READ_FAILED") {
    return "本机加密授权数据暂时无法读取，原数据已保留。请重试或联系管理员核对。";
  }
  return "";
}

export class LicenseSecureStore {
  constructor({ userDataPath, safeStorage }) {
    this.userDataPath = userDataPath;
    this.safeStorage = safeStorage;
    this.activationRecoverySecretPromise = null;
    this.writeQueues = new Map();
  }

  async assertAvailable() {
    try {
      if (
        typeof this.safeStorage.isAsyncEncryptionAvailable === "function"
        && typeof this.safeStorage.encryptStringAsync === "function"
        && typeof this.safeStorage.decryptStringAsync === "function"
        && await this.safeStorage.isAsyncEncryptionAvailable()
      ) {
        return "async";
      }
    } catch {
      // The asynchronous backend can be unavailable for an otherwise healthy
      // macOS Keychain or Windows credential store. Try Electron's established
      // synchronous safeStorage API before treating the system store as broken.
    }
    if (
      typeof this.safeStorage.encryptString === "function"
      && typeof this.safeStorage.decryptString === "function"
    ) {
      try {
        if (typeof this.safeStorage.isEncryptionAvailable !== "function" || this.safeStorage.isEncryptionAvailable()) {
          return "sync";
        }
      } catch {
        // Fall through and let the real secure operation make the final call.
      }
      // Electron can transiently report false here even though an existing
      // Keychain/Credential Manager record is decryptable. Never fall back to
      // plaintext; attempt the real safeStorage operation and surface its error.
      return "sync";
    }
    throw new Error("当前系统安全凭证存储不可用");
  }

  filePath(name) {
    return path.join(this.userDataPath, "license", name);
  }

  async readEncrypted(name) {
    const mode = await this.assertAvailable();
    let encrypted;
    try {
      encrypted = await readFile(this.filePath(name));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw secureReadUnavailableError();
    }
    if (mode === "async") {
      let decrypted;
      try {
        decrypted = await this.safeStorage.decryptStringAsync(encrypted);
      } catch {
        // Electron's async safeStorage backend cannot decrypt ciphertext written
        // by the established synchronous backend on some Windows upgrades. Try
        // the OS-backed legacy reader against the same bytes. Do not rewrite here:
        // the main app and diagnostic tool share this store, so a read-triggered
        // migration could race with a newer credential write in another process.
        if (typeof this.safeStorage.decryptString !== "function") {
          throw decryptionUnavailableError();
        }
        try {
          return this.safeStorage.decryptString(encrypted);
        } catch {
          throw decryptionUnavailableError();
        }
      }
      // Do not migrate ciphertext as a side effect of reading it. The main app
      // and diagnostic tool intentionally share this store, so even a valid
      // read-side re-encryption can overwrite a newer cross-process write.
      return decrypted.result;
    }
    try {
      return this.safeStorage.decryptString(encrypted);
    } catch {
      throw decryptionUnavailableError();
    }
  }

  async writeEncrypted(name, plainText) {
    const previous = this.writeQueues.get(name) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.writeEncryptedAtomic(name, plainText));
    this.writeQueues.set(name, current);
    try {
      return await current;
    } finally {
      if (this.writeQueues.get(name) === current) this.writeQueues.delete(name);
    }
  }

  async writeEncryptedAtomic(name, plainText) {
    const mode = await this.assertAvailable();
    const directory = path.join(this.userDataPath, "license");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let encrypted;
    if (mode === "async") {
      try {
        encrypted = await this.safeStorage.encryptStringAsync(plainText);
      } catch {
        // Keep write compatibility symmetric with read compatibility. Some
        // Windows upgrades report the async backend as available while its
        // Credential Manager operation still fails. The established sync API
        // remains OS-backed; this is never a plaintext fallback.
        if (typeof this.safeStorage.encryptString !== "function") {
          throw encryptionUnavailableError();
        }
        try {
          encrypted = this.safeStorage.encryptString(plainText);
        } catch {
          throw encryptionUnavailableError();
        }
      }
    } else {
      try {
        encrypted = this.safeStorage.encryptString(plainText);
      } catch {
        throw encryptionUnavailableError();
      }
    }
    const targetPath = this.filePath(name);
    const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporaryPath, encrypted, { mode: 0o600 });
      await rename(temporaryPath, targetPath);
    } finally {
      // Cleanup is best-effort and must not turn an already committed atomic
      // rename into a reported failure.
      await unlink(temporaryPath).catch(() => {});
    }
  }

  async deleteEncrypted(name) {
    try {
      await unlink(this.filePath(name));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async readCredential() {
    const payload = await this.readEncrypted(CREDENTIAL_FILE);
    if (!payload) return null;
    try {
      const parsed = JSON.parse(payload);
      if (!validPersistedCredential(parsed)) throw invalidSecureDataError();
      return parsed;
    } catch {
      // Corruption is not equivalent to a new installation. Preserve the file
      // and stop before activation can replace an existing device credential.
      throw invalidSecureDataError();
    }
  }

  async writeCredential(credential) {
    await this.writeEncrypted(CREDENTIAL_FILE, JSON.stringify(credential));
  }

  // Persist before any first-activation request. A lost success response can
  // then be retried without consuming a second card or replacing a credential.
  async readOrCreateActivationRecoverySecret() {
    if (!this.activationRecoverySecretPromise) {
      this.activationRecoverySecretPromise = (async () => {
        const prior = await this.readEncrypted(ACTIVATION_RECOVERY_SECRET_FILE);
        if (prior) {
          if (/^[a-f0-9]{64}$/.test(prior)) return prior;
          throw new Error("本机激活恢复密钥已损坏，请联系管理员核对");
        }
        const secret = randomBytes(32).toString("hex");
        await this.writeEncrypted(ACTIVATION_RECOVERY_SECRET_FILE, secret);
        return secret;
      })().catch((error) => {
        this.activationRecoverySecretPromise = null;
        throw error;
      });
    }
    return this.activationRecoverySecretPromise;
  }

  async readIdentityRepair() {
    const text = await this.readEncrypted("license-identity-repair.v1.bin");
    if (!text) return null;
    let value;
    try { value = JSON.parse(text); } catch { throw invalidSecureDataError(); }
    if (value?.version !== 1 || !["prepared", "accepted", "committed", "rejected"].includes(value.phase)
      || !validPersistedMachineIdentity(value.candidate)
      || value.candidate.identity_scheme !== "system_uuid_v1"
      || !isPlainObject(value.original)
      || !/^[a-f0-9]{64}$/.test(value.recoverySecret || "")
      || typeof value.activationCode !== "string"
      || !value.activationCode || value.activationCode.length > 512
      || (["accepted", "committed"].includes(value.phase) && (!validPersistedCredential(value.credential)
        || !value.credential.deviceCredential || !value.credential.deviceSession || !value.credential.codeId
        || !(
          /^v3_[a-f0-9]{64}$/.test(value.credential.boundMachineCode || "")
          || String(value.credential.boundMachineCode || "").toLowerCase() === value.candidate.active_machine_code
        )))) {
      throw invalidSecureDataError();
    }
    return value;
  }

  async writeIdentityRepair(value) {
    await this.writeEncrypted("license-identity-repair.v1.bin", JSON.stringify(value));
  }

  async writeActivationRecoverySecret(secret) {
    if (!/^[a-f0-9]{64}$/.test(secret || "")) throw invalidSecureDataError();
    await this.writeEncrypted(ACTIVATION_RECOVERY_SECRET_FILE, secret);
    this.activationRecoverySecretPromise = Promise.resolve(secret);
  }

  async clearAllAuthorizationData() {
    await Promise.all([
      this.deleteEncrypted(CREDENTIAL_FILE),
      this.deleteEncrypted(OFFLINE_GRANT_FILE),
      this.deleteEncrypted(OFFLINE_HMAC_KEY_FILE),
      this.deleteEncrypted(IDENTITY_OBSERVE_CONFIRMATION_FILE),
      this.deleteEncrypted(ACTIVATION_RECOVERY_SECRET_FILE),
    ]);
    this.activationRecoverySecretPromise = null;
  }

  async clearDeviceCredential() {
    const credential = await this.readCredential();
    if (credential) {
      const preserved = { ...credential };
      delete preserved.deviceSession;
      delete preserved.deviceCredential;
      if (Object.keys(preserved).length) await this.writeCredential(preserved);
      else await this.deleteEncrypted(CREDENTIAL_FILE);
    }
    await this.clearOfflineGrant();
  }

  async clearSavedActivationCode() {
    const credential = await this.readCredential();
    if (!credential) return;
    const preserved = { ...credential };
    delete preserved.activationCode;
    if (Object.keys(preserved).length) await this.writeCredential(preserved);
    else await this.deleteEncrypted(CREDENTIAL_FILE);
  }

  async readMachineSeed() {
    return this.readEncrypted(MACHINE_SEED_FILE);
  }

  async writeMachineSeed(seed) {
    await this.writeEncrypted(MACHINE_SEED_FILE, seed);
  }

  async readMachineCode() {
    return this.readEncrypted(MACHINE_CODE_FILE);
  }

  async writeMachineCode(machineCode) {
    await this.writeEncrypted(MACHINE_CODE_FILE, machineCode);
  }

  async readMachineIdentity() {
    const payload = await this.readEncrypted(MACHINE_IDENTITY_FILE);
    if (!payload) return null;
    try {
      const parsed = JSON.parse(payload);
      if (!validPersistedMachineIdentity(parsed)) throw invalidSecureDataError();
      return parsed;
    } catch {
      // A malformed persisted identity must never be silently regenerated.
      throw invalidSecureDataError();
    }
  }

  async writeMachineIdentity(identity) {
    await this.writeEncrypted(MACHINE_IDENTITY_FILE, JSON.stringify(identity));
  }

  async readOrCreateOfflineHmacKey() {
    const existing = await this.readEncrypted(OFFLINE_HMAC_KEY_FILE);
    if (existing) {
      const decoded = Buffer.from(existing, "base64");
      if (decoded.length === 32 && decoded.toString("base64") === existing) return decoded;
      throw new Error("离线授权签名密钥已损坏");
    }
    const key = randomBytes(32);
    await this.writeEncrypted(OFFLINE_HMAC_KEY_FILE, key.toString("base64"));
    return key;
  }

  async readOfflineGrant() {
    const payload = await this.readEncrypted(OFFLINE_GRANT_FILE);
    if (!payload) return null;
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }

  async writeOfflineGrant(grant) {
    await this.writeEncrypted(OFFLINE_GRANT_FILE, JSON.stringify(grant));
  }

  async clearOfflineGrant() {
    await this.deleteEncrypted(OFFLINE_GRANT_FILE);
  }

  async readMachineIdentityFactors() {
    const payload = await this.readEncrypted(MACHINE_IDENTITY_FACTORS_FILE);
    if (!payload) return null;
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }

  async writeMachineIdentityFactors(envelope) {
    await this.writeEncrypted(MACHINE_IDENTITY_FACTORS_FILE, JSON.stringify(envelope));
  }

  async clearMachineIdentityFactors() {
    await this.deleteEncrypted(MACHINE_IDENTITY_FACTORS_FILE);
  }

  async readIdentityObserveConfirmation() {
    const payload = await this.readEncrypted(IDENTITY_OBSERVE_CONFIRMATION_FILE);
    if (!payload) return null;
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }

  async writeIdentityObserveConfirmation(confirmation) {
    await this.writeEncrypted(IDENTITY_OBSERVE_CONFIRMATION_FILE, JSON.stringify(confirmation));
  }

  async clearMachineIdentity() {
    await Promise.all([
      this.deleteEncrypted(MACHINE_IDENTITY_FILE),
      this.deleteEncrypted(MACHINE_CODE_FILE),
      this.deleteEncrypted(MACHINE_SEED_FILE),
      this.deleteEncrypted(MACHINE_IDENTITY_FACTORS_FILE),
      this.deleteEncrypted(IDENTITY_OBSERVE_CONFIRMATION_FILE),
    ]);
  }
}
