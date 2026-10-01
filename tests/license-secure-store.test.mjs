import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LicenseSecureStore } from "../electron/license-secure-store.mjs";

async function withTempDirectory(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "license-secure-store-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("uses the synchronous OS credential store when async encryption is unavailable", async () => {
  await withTempDirectory(async (userDataPath) => {
    const safeStorage = {
      isAsyncEncryptionAvailable: async () => false,
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`secure:${value}`, "utf8"),
      decryptString: (value) => value.toString("utf8").replace(/^secure:/, ""),
    };
    const store = new LicenseSecureStore({ userDataPath, safeStorage });
    const credential = { deviceSession: "session", deviceCredential: "credential", activationCode: "secret" };

    await store.writeCredential(credential);
    assert.deepEqual(await store.readCredential(), credential);
    const raw = await readFile(path.join(userDataPath, "license", "license-credential.v2.bin"));
    assert.notEqual(raw.toString("utf8"), JSON.stringify(credential));
  });
});

test("prefers async safeStorage when both credential backends are available", async () => {
  await withTempDirectory(async (userDataPath) => {
    let syncCalls = 0;
    const safeStorage = {
      isAsyncEncryptionAvailable: async () => true,
      isEncryptionAvailable: () => true,
      encryptStringAsync: async (value) => Buffer.from(`async:${value}`, "utf8"),
      decryptStringAsync: async (value) => ({ result: value.toString("utf8").replace(/^async:/, ""), shouldReEncrypt: false }),
      encryptString: () => { syncCalls += 1; return Buffer.alloc(0); },
      decryptString: () => { syncCalls += 1; return ""; },
    };
    const store = new LicenseSecureStore({ userDataPath, safeStorage });

    await store.writeCredential({ deviceSession: "session", deviceCredential: "credential" });
    assert.equal((await store.readCredential()).deviceSession, "session");
    assert.equal(syncCalls, 0);
  });
});

test("falls back to synchronous OS encryption when the advertised async backend cannot write", async () => {
  await withTempDirectory(async (userDataPath) => {
    let asyncEncryptCalls = 0;
    let syncEncryptCalls = 0;
    const safeStorage = {
      isAsyncEncryptionAvailable: async () => true,
      isEncryptionAvailable: () => true,
      encryptStringAsync: async () => {
        asyncEncryptCalls += 1;
        throw new Error("raw async credential manager failure");
      },
      decryptStringAsync: async () => { throw new Error("not async ciphertext"); },
      encryptString: (value) => {
        syncEncryptCalls += 1;
        return Buffer.from(`sync:${value}`, "utf8");
      },
      decryptString: (value) => value.toString("utf8").replace(/^sync:/, ""),
    };
    const store = new LicenseSecureStore({ userDataPath, safeStorage });
    const credential = { deviceSession: "session", deviceCredential: "credential" };

    await store.writeCredential(credential);

    assert.deepEqual(await store.readCredential(), credential);
    assert.equal(asyncEncryptCalls, 1);
    assert.equal(syncEncryptCalls, 1);
    const raw = await readFile(path.join(userDataPath, "license", "license-credential.v2.bin"), "utf8");
    assert.match(raw, /^sync:/);
    assert.notEqual(raw, JSON.stringify(credential));
  });
});

test("keeps the existing ciphertext unchanged when both encryption backends fail", async () => {
  await withTempDirectory(async (userDataPath) => {
    const licenseDirectory = path.join(userDataPath, "license");
    const credentialPath = path.join(licenseDirectory, "license-credential.v2.bin");
    const original = Buffer.from("existing-os-encrypted-credential", "utf8");
    await mkdir(licenseDirectory, { recursive: true });
    await writeFile(credentialPath, original);
    const safeStorage = {
      isAsyncEncryptionAvailable: async () => true,
      isEncryptionAvailable: () => true,
      encryptStringAsync: async () => { throw new Error("raw async provider failure"); },
      decryptStringAsync: async () => ({ result: "{}", shouldReEncrypt: false }),
      encryptString: () => { throw new Error("raw sync provider failure"); },
      decryptString: () => "{}",
    };
    const store = new LicenseSecureStore({ userDataPath, safeStorage });

    await assert.rejects(
      () => store.writeCredential({ deviceSession: "new-session" }),
      (error) => error?.code === "SECURE_STORAGE_ENCRYPT_FAILED"
        && /\u539f\u6570\u636e\u672a\u4f5c\u66f4\u6539/.test(error.message)
        && !/raw async|raw sync/.test(error.message),
    );
    assert.deepEqual(await readFile(credentialPath), original);
  });
});

test("reads legacy sync ciphertext without rewriting it when async decryption fails", async () => {
  await withTempDirectory(async (userDataPath) => {
    const secret = "c".repeat(64);
    const licenseDirectory = path.join(userDataPath, "license");
    const recoveryPath = path.join(licenseDirectory, "license-canonical-recovery.v1.bin");
    await mkdir(licenseDirectory, { recursive: true });
    await writeFile(recoveryPath, Buffer.from(`sync:${secret}`, "utf8"));
    let syncDecryptCalls = 0;
    const safeStorage = {
      isAsyncEncryptionAvailable: async () => true,
      isEncryptionAvailable: () => true,
      encryptStringAsync: async (value) => Buffer.from(`async:${value}`, "utf8"),
      decryptStringAsync: async (value) => {
        const text = value.toString("utf8");
        if (!text.startsWith("async:")) throw new Error("Error while decrypting the ciphertext provided");
        return { result: text.slice("async:".length), shouldReEncrypt: false };
      },
      encryptString: (value) => Buffer.from(`sync:${value}`, "utf8"),
      decryptString: (value) => {
        syncDecryptCalls += 1;
        const text = value.toString("utf8");
        if (!text.startsWith("sync:")) throw new Error("legacy decrypt failed");
        return text.slice("sync:".length);
      },
    };

    const store = new LicenseSecureStore({ userDataPath, safeStorage });
    assert.equal(await store.readOrCreateActivationRecoverySecret(), secret);
    assert.equal(syncDecryptCalls, 1);
    assert.equal((await readFile(recoveryPath, "utf8")), `sync:${secret}`);

    const restarted = new LicenseSecureStore({ userDataPath, safeStorage });
    assert.equal(await restarted.readOrCreateActivationRecoverySecret(), secret);
    assert.equal(syncDecryptCalls, 2);
    assert.equal((await readFile(recoveryPath, "utf8")), `sync:${secret}`);
  });
});

test("does not rewrite ciphertext when async decrypt recommends re-encryption", async () => {
  await withTempDirectory(async (userDataPath) => {
    const licenseDirectory = path.join(userDataPath, "license");
    const recoveryPath = path.join(licenseDirectory, "license-canonical-recovery.v1.bin");
    const secret = "d".repeat(64);
    const original = Buffer.from(`async-old:${secret}`, "utf8");
    await mkdir(licenseDirectory, { recursive: true });
    await writeFile(recoveryPath, original);
    let encryptCalls = 0;
    const safeStorage = {
      isAsyncEncryptionAvailable: async () => true,
      isEncryptionAvailable: () => true,
      encryptStringAsync: async (value) => {
        encryptCalls += 1;
        return Buffer.from(`async-new:${value}`, "utf8");
      },
      decryptStringAsync: async () => ({ result: secret, shouldReEncrypt: true }),
      encryptString: (value) => Buffer.from(value, "utf8"),
      decryptString: (value) => value.toString("utf8"),
    };

    const store = new LicenseSecureStore({ userDataPath, safeStorage });
    assert.equal(await store.readOrCreateActivationRecoverySecret(), secret);
    assert.equal(encryptCalls, 0);
    assert.deepEqual(await readFile(recoveryPath), original);
  });
});

test("preserves ciphertext and reports a safe error when neither backend can decrypt it", async () => {
  await withTempDirectory(async (userDataPath) => {
    const licenseDirectory = path.join(userDataPath, "license");
    const recoveryPath = path.join(licenseDirectory, "license-canonical-recovery.v1.bin");
    const original = Buffer.from("encrypted-by-another-windows-account", "utf8");
    await mkdir(licenseDirectory, { recursive: true });
    await writeFile(recoveryPath, original);
    const safeStorage = {
      isAsyncEncryptionAvailable: async () => true,
      isEncryptionAvailable: () => true,
      encryptStringAsync: async (value) => Buffer.from(value, "utf8"),
      decryptStringAsync: async () => { throw new Error("raw async provider failure"); },
      encryptString: (value) => Buffer.from(value, "utf8"),
      decryptString: () => { throw new Error("raw sync provider failure"); },
    };

    const store = new LicenseSecureStore({ userDataPath, safeStorage });
    await assert.rejects(
      () => store.readOrCreateActivationRecoverySecret(),
      (error) => error?.code === "SECURE_STORAGE_DECRYPT_FAILED"
        && /\u539f\u6570\u636e\u672a\u4f5c\u66f4\u6539/.test(error.message)
        && !/raw async|raw sync/.test(error.message),
    );
    assert.deepEqual(await readFile(recoveryPath), original);
  });
});

test("reports a stable safe error when availability preflight is stale", async () => {
  await withTempDirectory(async (userDataPath) => {
    const store = new LicenseSecureStore({
      userDataPath,
      safeStorage: {
        isAsyncEncryptionAvailable: async () => false,
        isEncryptionAvailable: () => false,
        encryptString: () => { throw new Error("系统钥匙串拒绝加密"); },
        decryptString: () => { throw new Error("系统钥匙串拒绝解密"); },
      },
    });
    await assert.rejects(
      () => store.writeCredential({ deviceSession: "session" }),
      (error) => error?.code === "SECURE_STORAGE_ENCRYPT_FAILED"
        && !error.message.includes("钥匙串拒绝"),
    );
  });
});

test("malformed credential data fails closed without replacing the encrypted file", async () => {
  await withTempDirectory(async (userDataPath) => {
    const store = new LicenseSecureStore({ userDataPath, safeStorage: synchronousSafeStorage() });
    await store.writeEncrypted("license-credential.v2.bin", "{not-json");
    const credentialPath = path.join(userDataPath, "license", "license-credential.v2.bin");
    const original = await readFile(credentialPath);

    await assert.rejects(
      () => store.readCredential(),
      (error) => error?.code === "SECURE_STORAGE_DATA_INVALID",
    );
    assert.deepEqual(await readFile(credentialPath), original);
  });
});

test("schema-invalid credential data fails closed instead of becoming a new installation", async () => {
  await withTempDirectory(async (userDataPath) => {
    const store = new LicenseSecureStore({ userDataPath, safeStorage: synchronousSafeStorage() });
    await store.writeEncrypted("license-credential.v2.bin", "{}");
    await assert.rejects(
      () => store.readCredential(),
      (error) => error?.code === "SECURE_STORAGE_DATA_INVALID",
    );
  });
});

test("non-missing credential file read errors fail closed", async () => {
  await withTempDirectory(async (userDataPath) => {
    const credentialPath = path.join(userDataPath, "license", "license-credential.v2.bin");
    await mkdir(credentialPath, { recursive: true });
    const store = new LicenseSecureStore({ userDataPath, safeStorage: synchronousSafeStorage() });
    await assert.rejects(
      () => store.readCredential(),
      (error) => error?.code === "SECURE_STORAGE_READ_FAILED",
    );
  });
});

test("malformed machine identity fails closed without generating a replacement", async () => {
  await withTempDirectory(async (userDataPath) => {
    const store = new LicenseSecureStore({ userDataPath, safeStorage: synchronousSafeStorage() });
    await store.writeEncrypted("license-machine-identity.v3.bin", "{not-json");
    const identityPath = path.join(userDataPath, "license", "license-machine-identity.v3.bin");
    const original = await readFile(identityPath);

    await assert.rejects(
      () => store.readMachineIdentity(),
      (error) => error?.code === "SECURE_STORAGE_DATA_INVALID",
    );
    assert.deepEqual(await readFile(identityPath), original);
  });
});

test("schema-invalid machine identity fails closed", async () => {
  await withTempDirectory(async (userDataPath) => {
    const store = new LicenseSecureStore({ userDataPath, safeStorage: synchronousSafeStorage() });
    await store.writeEncrypted("license-machine-identity.v3.bin", "{}");
    await assert.rejects(
      () => store.readMachineIdentity(),
      (error) => error?.code === "SECURE_STORAGE_DATA_INVALID",
    );
  });
});

test("serializes concurrent writes to the same encrypted record", async () => {
  await withTempDirectory(async (userDataPath) => {
    const store = new LicenseSecureStore({ userDataPath, safeStorage: synchronousSafeStorage() });
    const writes = Array.from({ length: 24 }, (_, index) => store.writeCredential({
      codeId: `code-${index}`,
      deviceSession: `session-${index}`,
      deviceCredential: `credential-${index}`,
    }));
    await Promise.all(writes);
    const finalCredential = await store.readCredential();
    assert.equal(finalCredential.codeId, "code-23");
    const licenseDirectory = path.join(userDataPath, "license");
    assert.equal((await readdir(licenseDirectory)).some((name) => name.endsWith(".tmp")), false);
  });
});

function synchronousSafeStorage() {
  return {
    isAsyncEncryptionAvailable: async () => false,
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`secure:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").replace(/^secure:/, ""),
  };
}

test("clearDeviceCredential preserves activation code and machine identity", async () => {
  await withTempDirectory(async (userDataPath) => {
    const store = new LicenseSecureStore({ userDataPath, safeStorage: synchronousSafeStorage() });
    const identity = {
      version: 3,
      active_machine_code: `v2_${"a".repeat(64)}`,
      source_type: "mac_io_platform_uuid",
    };
    await store.writeCredential({
      deviceSession: "session",
      deviceCredential: "credential",
      activationCode: "saved-activation",
      codeId: "code-id",
    });
    await store.writeMachineIdentity(identity);
    await store.writeOfflineGrant({ payload: { displayRemainingDays: 7 }, signature: "signed" });

    await store.clearDeviceCredential();

    assert.deepEqual(await store.readCredential(), { activationCode: "saved-activation", codeId: "code-id" });
    assert.deepEqual(await store.readMachineIdentity(), identity);
    assert.equal(await store.readOfflineGrant(), null);
  });
});

test("stores the offline HMAC key and signed grant only through OS encryption", async () => {
  await withTempDirectory(async (userDataPath) => {
    const store = new LicenseSecureStore({ userDataPath, safeStorage: synchronousSafeStorage() });
    const firstKey = await store.readOrCreateOfflineHmacKey();
    const secondKey = await store.readOrCreateOfflineHmacKey();
    const grant = {
      payload: {
        appName: "ai-media-library",
        credentialBinding: "credential-hash-only",
        displayRemainingDays: 7,
      },
      signature: "signature-hash-only",
    };

    assert.equal(firstKey.length, 32);
    assert.deepEqual(secondKey, firstKey);
    await store.writeOfflineGrant(grant);
    assert.deepEqual(await store.readOfflineGrant(), grant);

    const rawKey = await readFile(path.join(userDataPath, "license", "license-offline-hmac-key.v1.bin"), "utf8");
    const rawGrant = await readFile(path.join(userDataPath, "license", "license-offline-grant.v1.bin"), "utf8");
    assert.notEqual(rawKey, firstKey.toString("base64"));
    assert.notEqual(rawGrant, JSON.stringify(grant));
    assert.match(rawKey, /^secure:/);
    assert.match(rawGrant, /^secure:/);
  });
});

test("observe confirmation is encrypted separately from factor cache and authorization", async () => {
  await withTempDirectory(async (userDataPath) => {
    const safeStorage = {
      isAsyncEncryptionAvailable: async () => false,
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, "utf8").map((byte) => byte ^ 0x5a),
      decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x5a).toString("utf8"),
    };
    const secureStore = new LicenseSecureStore({ userDataPath, safeStorage });
    const confirmation = { version: 1, digest: "a".repeat(64), confirmedAt: 1_700_000_000_000 };
    await secureStore.writeIdentityObserveConfirmation(confirmation);
    assert.deepEqual(await secureStore.readIdentityObserveConfirmation(), confirmation);
    const bytes = await readFile(path.join(userDataPath, "license", "license-machine-identity.observe-confirmed.v1.bin"));
    assert.equal(bytes.toString("utf8").includes(confirmation.digest), false);
    await secureStore.clearOfflineGrant();
    assert.deepEqual(await secureStore.readIdentityObserveConfirmation(), confirmation);
  });
});

test("clearing the offline grant preserves device credentials and its protected signing key", async () => {
  await withTempDirectory(async (userDataPath) => {
    const store = new LicenseSecureStore({ userDataPath, safeStorage: synchronousSafeStorage() });
    const credential = {
      deviceSession: "session",
      deviceCredential: "credential",
      activationCode: "saved-activation",
    };
    await store.writeCredential(credential);
    const key = await store.readOrCreateOfflineHmacKey();
    await store.writeOfflineGrant({ payload: { day: "2026-09-15" }, signature: "signed" });

    await store.clearOfflineGrant();

    assert.equal(await store.readOfflineGrant(), null);
    assert.deepEqual(await store.readCredential(), credential);
    assert.deepEqual(await store.readOrCreateOfflineHmacKey(), key);
  });
});

test("canonical recovery proof is generated once, encrypted, and survives a credential reset", async () => {
  await withTempDirectory(async (userDataPath) => {
    const safeStorage = {
      isAsyncEncryptionAvailable: async () => false,
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, "utf8").map((byte) => byte ^ 0x5a),
      decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x5a).toString("utf8"),
    };
    const store = new LicenseSecureStore({ userDataPath, safeStorage });
    const [first, simultaneous] = await Promise.all([
      store.readOrCreateActivationRecoverySecret(), store.readOrCreateActivationRecoverySecret(),
    ]);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(simultaneous, first);
    const raw = await readFile(path.join(userDataPath, "license", "license-canonical-recovery.v1.bin"));
    assert.equal(raw.toString("utf8").includes(first), false);
    await store.clearDeviceCredential();
    const restarted = new LicenseSecureStore({ userDataPath, safeStorage });
    assert.equal(await restarted.readOrCreateActivationRecoverySecret(), first);
    await restarted.clearAllAuthorizationData();
    assert.notEqual(await restarted.readOrCreateActivationRecoverySecret(), first);
  });
});

test("clearing all authorization data also removes offline grant and key", async () => {
  await withTempDirectory(async (userDataPath) => {
    const store = new LicenseSecureStore({ userDataPath, safeStorage: synchronousSafeStorage() });
    await store.writeCredential({ deviceSession: "session", deviceCredential: "credential" });
    const previousKey = await store.readOrCreateOfflineHmacKey();
    await store.writeOfflineGrant({ payload: { day: "2026-09-15" }, signature: "signed" });
    await store.writeIdentityObserveConfirmation({ version: 1, digest: "b".repeat(64), confirmedAt: 1_700_000_000_000 });

    await store.clearAllAuthorizationData();

    assert.equal(await store.readCredential(), null);
    assert.equal(await store.readOfflineGrant(), null);
    assert.equal(await store.readIdentityObserveConfirmation(), null);
    const replacementKey = await store.readOrCreateOfflineHmacKey();
    assert.notDeepEqual(replacementKey, previousKey);
  });
});

test("clearSavedActivationCode is independent from device credential and machine identity", async () => {
  await withTempDirectory(async (userDataPath) => {
    const store = new LicenseSecureStore({ userDataPath, safeStorage: synchronousSafeStorage() });
    const identity = { version: 3, active_machine_code: `v2_${"b".repeat(64)}` };
    await store.writeCredential({
      deviceSession: "session",
      deviceCredential: "credential",
      activationCode: "saved-activation",
    });
    await store.writeMachineIdentity(identity);

    await store.clearSavedActivationCode();

    assert.deepEqual(await store.readCredential(), { deviceSession: "session", deviceCredential: "credential" });
    assert.deepEqual(await store.readMachineIdentity(), identity);
  });
});

test("machine identity v3 is encrypted and atomically readable", async () => {
  await withTempDirectory(async (userDataPath) => {
    const store = new LicenseSecureStore({ userDataPath, safeStorage: synchronousSafeStorage() });
    const identity = {
      version: 3,
      active_machine_code: `v2_${"c".repeat(64)}`,
      legacy_machine_code: "",
      candidate_machine_code: `v2_${"c".repeat(64)}`,
      source_type: "windows_machine_guid",
      hardware_digest: "anonymous-digest",
      compatibility_mode: false,
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
    };
    await store.writeMachineIdentity(identity);
    assert.deepEqual(await store.readMachineIdentity(), identity);
    const raw = await readFile(path.join(userDataPath, "license", "license-machine-identity.v3.bin"));
    assert.notEqual(raw.toString("utf8"), JSON.stringify(identity));
  });
});

test("clearMachineIdentity is independent from saved authorization", async () => {
  await withTempDirectory(async (userDataPath) => {
    const store = new LicenseSecureStore({ userDataPath, safeStorage: synchronousSafeStorage() });
    await store.writeCredential({ activationCode: "saved", deviceSession: "session", deviceCredential: "credential" });
    await store.writeMachineIdentity({ version: 3, active_machine_code: `v2_${"d".repeat(64)}` });
    await store.writeMachineCode(`v2_${"d".repeat(64)}`);
    await store.writeMachineSeed("seed");
    await store.writeIdentityObserveConfirmation({ version: 1, digest: "c".repeat(64), confirmedAt: 1_700_000_000_000 });

    await store.clearMachineIdentity();

    assert.deepEqual(await store.readCredential(), {
      activationCode: "saved",
      deviceSession: "session",
      deviceCredential: "credential",
    });
    assert.equal(await store.readMachineIdentity(), null);
    assert.equal(await store.readMachineCode(), null);
    assert.equal(await store.readMachineSeed(), null);
    assert.equal(await store.readIdentityObserveConfirmation(), null);
  });
});
