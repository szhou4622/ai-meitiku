import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildClassifierRuntimeEnvironment,
  classifierLegacyUserDataPaths,
  classificationApiKeyForProvider,
  ensureClassifierUserConfig,
  loadClassifierTemplateState,
  writeClassifierActiveTemplate,
  writeClassifierTemplate,
} from "../electron/classifier-user-config.mjs";
import { LicenseSecureStore } from "../electron/license-secure-store.mjs";

test("classifier user config survives a simulated app restart and package update", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classifier-user-config-"));
  const packageRoot = path.join(root, "package");
  const userDataPath = path.join(root, "user-data");
  await mkdir(path.join(packageRoot, "config", "templates"), { recursive: true });
  await writeFile(path.join(packageRoot, "config", "settings.json"), JSON.stringify({ version: "package-v1" }), "utf8");
  await writeFile(path.join(packageRoot, "config", "active_template.json"), JSON.stringify({ template_id: "builtin" }), "utf8");
  await writeFile(path.join(packageRoot, "config", "templates", "builtin.json"), "{}", "utf8");

  const firstRuntime = await ensureClassifierUserConfig({ packageRoot, userDataPath });
  const savedSettingsPath = path.join(firstRuntime, "config", "settings.json");
  await writeFile(savedSettingsPath, JSON.stringify({ version: "user-saved" }), "utf8");

  await writeFile(path.join(packageRoot, "config", "settings.json"), JSON.stringify({ version: "package-v2" }), "utf8");
  await writeFile(path.join(packageRoot, "config", "templates", "new-default.json"), "{}", "utf8");
  const restartedRuntime = await ensureClassifierUserConfig({ packageRoot, userDataPath });

  assert.equal(restartedRuntime, firstRuntime);
  assert.deepEqual(JSON.parse(await readFile(savedSettingsPath, "utf8")), { version: "user-saved" });
  assert.equal(await readFile(path.join(firstRuntime, "config", "templates", "new-default.json"), "utf8"), "{}");
});

test("classifier API remains callable from encrypted storage after a simulated app restart", async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "classifier-secure-api-"));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, ""),
  };
  const profiles = {
    volcengine: { apiKey: "volc-secret" },
    relay: { apiKey: "relay-secret" },
  };
  const firstProcessStore = new LicenseSecureStore({ userDataPath, safeStorage });
  await firstProcessStore.writeEncrypted("api-settings.v1.bin", JSON.stringify(profiles));

  const restartedProcessStore = new LicenseSecureStore({ userDataPath, safeStorage });
  const restartedProfiles = JSON.parse(await restartedProcessStore.readEncrypted("api-settings.v1.bin"));
  const environment = buildClassifierRuntimeEnvironment({ LANG: "zh_CN.UTF-8" }, restartedProfiles, "relay");
  assert.equal(classificationApiKeyForProvider(restartedProfiles, "relay"), "relay-secret");
  assert.equal(environment.ARK_API_KEY, "relay-secret");
  assert.equal(environment.LANG, "zh_CN.UTF-8");
});

async function writePackageConfig(packageRoot) {
  await mkdir(path.join(packageRoot, "config", "templates"), { recursive: true });
  const template = {
    template_id: "builtin",
    name: "默认方案",
    product_name: "默认产品",
    taxonomy: { "01_默认": ["默认"] },
    rules: "default",
    naming_rule: "产品名_序号",
  };
  await writeFile(path.join(packageRoot, "config", "templates", "builtin.json"), JSON.stringify(template), "utf8");
  await writeFile(path.join(packageRoot, "config", "active_template.json"), JSON.stringify({ template_id: "builtin" }), "utf8");
  await writeFile(path.join(packageRoot, "config", "settings.json"), "{}", "utf8");
}

test("legacy product-name user data restores custom schemes without replacing current data", async () => {
  const appDataPath = await mkdtemp(path.join(os.tmpdir(), "classifier-legacy-migration-"));
  const packageRoot = path.join(appDataPath, "package");
  const currentUserData = path.join(appDataPath, "ai-media-library");
  const legacyUserData = path.join(appDataPath, "AI媒体库");
  await writePackageConfig(packageRoot);
  await mkdir(path.join(legacyUserData, "classifier-runtime", "config", "templates"), { recursive: true });
  const legacyTemplate = {
    template_id: "custom-legacy",
    name: "历史自定义方案",
    product_name: "历史产品",
    taxonomy: { "01_场景": ["早餐"] },
    rules: "legacy",
    naming_rule: "产品名_序号",
  };
  await writeFile(path.join(legacyUserData, "classifier-runtime", "config", "templates", "custom-legacy.json"), JSON.stringify(legacyTemplate), "utf8");
  await writeFile(path.join(legacyUserData, "classifier-runtime", "config", "active_template.json"), JSON.stringify({ template_id: "custom-legacy" }), "utf8");

  const legacyPaths = classifierLegacyUserDataPaths({ appDataPath, currentUserDataPath: currentUserData });
  assert.deepEqual(legacyPaths, [path.join(appDataPath, "AI媒体库"), path.join(appDataPath, "AI媒体库-精简版")]);
  const userRoot = await ensureClassifierUserConfig({ packageRoot, userDataPath: currentUserData, legacyUserDataPaths: legacyPaths });
  const state = await loadClassifierTemplateState(userRoot);
  assert.deepEqual(state.templates.map((item) => item.template_id).sort(), ["builtin", "custom-legacy"]);
  assert.equal(state.activeTemplateId, "custom-legacy");
  assert.equal(state.configHealth.recoveredTemplates, 1);

  await rm(path.join(userRoot, "config", "templates", "custom-legacy.json"));
  await ensureClassifierUserConfig({ packageRoot, userDataPath: currentUserData, legacyUserDataPaths: legacyPaths });
  const afterUserDeletion = await loadClassifierTemplateState(userRoot);
  assert.deepEqual(afterUserDeletion.templates.map((item) => item.template_id), ["builtin"]);
  assert.equal(afterUserDeletion.configHealth.recoveredTemplates, 0);
});

test("a legacy ID collision keeps both versions and never changes a valid current active scheme", async () => {
  const appDataPath = await mkdtemp(path.join(os.tmpdir(), "classifier-legacy-conflict-"));
  const packageRoot = path.join(appDataPath, "package");
  const currentUserData = path.join(appDataPath, "ai-media-library");
  const currentRoot = path.join(currentUserData, "classifier-runtime");
  const legacyUserData = path.join(appDataPath, "AI媒体库");
  await writePackageConfig(packageRoot);
  await mkdir(path.join(currentRoot, "config", "templates"), { recursive: true });
  await mkdir(path.join(legacyUserData, "classifier-runtime", "config", "templates"), { recursive: true });
  const current = { template_id: "custom-same", name: "当前方案", product_name: "A", taxonomy: { A: ["1"] } };
  const legacy = { template_id: "custom-same", name: "旧版方案", product_name: "B", taxonomy: { B: ["2"] } };
  await writeFile(path.join(currentRoot, "config", "templates", "custom-same.json"), JSON.stringify(current), "utf8");
  await writeFile(path.join(currentRoot, "config", "active_template.json"), JSON.stringify({ template_id: "custom-same" }), "utf8");
  await writeFile(path.join(legacyUserData, "classifier-runtime", "config", "templates", "custom-same.json"), JSON.stringify(legacy), "utf8");
  await writeFile(path.join(legacyUserData, "classifier-runtime", "config", "active_template.json"), JSON.stringify({ template_id: "custom-same" }), "utf8");

  const userRoot = await ensureClassifierUserConfig({
    packageRoot,
    userDataPath: currentUserData,
    legacyUserDataPaths: classifierLegacyUserDataPaths({ appDataPath, currentUserDataPath: currentUserData }),
  });
  const state = await loadClassifierTemplateState(userRoot);
  assert.equal(state.activeTemplateId, "custom-same");
  assert.equal(state.configHealth.conflictCopies, 1);
  assert.ok(state.templates.some((item) => item.template_id === "custom-same" && item.name === "当前方案"));
  assert.ok(state.templates.some((item) => item.template_id.startsWith("recovered-custom-same-") && item.name === "旧版方案（历史恢复）"));
});

test("template edits are atomic, retain a backup, and recover a later damaged primary", async () => {
  const appDataPath = await mkdtemp(path.join(os.tmpdir(), "classifier-template-backup-"));
  const packageRoot = path.join(appDataPath, "package");
  const userDataPath = path.join(appDataPath, "ai-media-library");
  await writePackageConfig(packageRoot);
  const userRoot = await ensureClassifierUserConfig({ packageRoot, userDataPath });
  const original = { template_id: "custom-backup", name: "初始方案", product_name: "A", taxonomy: { A: ["1"] } };
  const edited = { ...original, name: "已修改方案", taxonomy: { A: ["2"] } };
  await writeClassifierTemplate(userRoot, original, { backupExisting: false });
  await writeClassifierTemplate(userRoot, edited);
  await writeClassifierActiveTemplate(userRoot, "custom-backup");
  const backupDirectory = path.join(userRoot, "config", "template-backups", "custom-backup");
  assert.equal((await readdir(backupDirectory)).length, 1);

  await writeFile(path.join(userRoot, "config", "templates", "custom-backup.json"), "{broken", "utf8");
  await ensureClassifierUserConfig({ packageRoot, userDataPath });
  const state = await loadClassifierTemplateState(userRoot);
  assert.equal(state.configHealth.recoveredFromBackup, 1);
  assert.equal(state.templates.find((item) => item.template_id === "custom-backup")?.name, "初始方案");
  assert.equal((await readdir(path.join(userRoot, "config", "corrupt-templates"))).length, 1);
});

test("an unreadable scheme is preserved and reported instead of silently becoming a valid scheme", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classifier-invalid-template-"));
  const packageRoot = path.join(root, "package");
  const userDataPath = path.join(root, "user-data");
  await writePackageConfig(packageRoot);
  const userRoot = await ensureClassifierUserConfig({ packageRoot, userDataPath });
  const brokenPath = path.join(userRoot, "config", "templates", "custom-broken.json");
  await writeFile(brokenPath, "{not-json", "utf8");
  await ensureClassifierUserConfig({ packageRoot, userDataPath });
  const state = await loadClassifierTemplateState(userRoot);
  assert.equal(state.configHealth.invalidTemplateCount, 1);
  assert.equal(await readFile(brokenPath, "utf8"), "{not-json");
  assert.ok(!state.templates.some((item) => item.template_id === "custom-broken"));
});

test("older valid schemes missing newer optional fields remain visible with safe defaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classifier-older-schema-"));
  const packageRoot = path.join(root, "package");
  const userDataPath = path.join(root, "user-data");
  await writePackageConfig(packageRoot);
  const userRoot = await ensureClassifierUserConfig({ packageRoot, userDataPath });
  await writeFile(
    path.join(userRoot, "config", "templates", "legacy-minimal.json"),
    JSON.stringify({ template_id: "legacy-minimal", name: "旧格式方案" }),
    "utf8",
  );
  const state = await loadClassifierTemplateState(userRoot);
  const restored = state.templates.find((item) => item.template_id === "legacy-minimal");
  assert.equal(restored?.name, "旧格式方案");
  assert.equal(restored?.product_name, "未命名产品");
  assert.deepEqual(restored?.taxonomy, {});
  assert.equal(state.configHealth.invalidTemplateCount, 0);
});
