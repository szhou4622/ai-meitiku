import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const CLASSIFIER_USER_DIRECTORY = "classifier-runtime";
export const CLASSIFIER_LEGACY_MIGRATION_FILE = ".legacy-template-migration-v1.json";
export const CLASSIFIER_TEMPLATE_BACKUP_DIRECTORY = "template-backups";
const LEGACY_USER_DATA_DIRECTORY_NAMES = Object.freeze(["AI媒体库", "AI媒体库-精简版"]);
const runtimeReports = new Map();
const configInitializations = new Map();

export function classifierUserRoot(userDataPath) {
  return path.join(userDataPath, CLASSIFIER_USER_DIRECTORY);
}

export function classifierLegacyUserDataPaths({ appDataPath, currentUserDataPath }) {
  const current = path.resolve(currentUserDataPath);
  return LEGACY_USER_DATA_DIRECTORY_NAMES
    .map((name) => path.join(appDataPath, name))
    .filter((candidate) => path.resolve(candidate) !== current);
}

function safeTemplateId(value) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new Error("分类方案 ID 无效");
  return id;
}

function normalizeTemplate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const templateId = String(value.template_id || "").trim();
  const name = String(value.name || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(templateId) || !name) return null;
  const taxonomy = value.taxonomy && typeof value.taxonomy === "object" && !Array.isArray(value.taxonomy)
    ? value.taxonomy
    : {};
  return {
    ...value,
    template_id: templateId,
    name,
    product_name: String(value.product_name || "未命名产品").trim() || "未命名产品",
    taxonomy,
    rules: typeof value.rules === "string" ? value.rules : "",
    naming_rule: String(value.naming_rule || "产品名_二级分类_具体画面_景别_素材拍摄日期_序号"),
  };
}

function validTemplate(value) {
  return Boolean(normalizeTemplate(value));
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function contentDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function uniqueRecoveredTemplateId(templateRoot, sourceId, template) {
  const digest = contentDigest(template).slice(0, 10);
  const stem = `recovered-${sourceId}`.slice(0, 100);
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = `${stem}-${digest}${suffix ? `-${suffix}` : ""}`.slice(0, 120);
    if (!await pathExists(path.join(templateRoot, `${candidate}.json`))) return candidate;
  }
  throw new Error("无法为历史分类方案生成唯一 ID");
}

function legacyConfigDirectories(legacyUserDataPaths) {
  const result = [];
  const seen = new Set();
  for (const userRoot of legacyUserDataPaths || []) {
    for (const configRoot of [
      path.join(userRoot, CLASSIFIER_USER_DIRECTORY, "config"),
      path.join(userRoot, "classifier", "config"),
      path.join(userRoot, "config"),
    ]) {
      const key = path.resolve(configRoot);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(configRoot);
      }
    }
  }
  return result;
}

async function migrateLegacyTemplates({ targetConfig, legacyUserDataPaths }) {
  const markerPath = path.join(targetConfig, CLASSIFIER_LEGACY_MIGRATION_FILE);
  const existingMarker = await readJsonOrNull(markerPath);
  if (existingMarker?.version === 1) return { ...existingMarker, justCompleted: false };

  const templateRoot = path.join(targetConfig, "templates");
  await mkdir(templateRoot, { recursive: true });
  const report = {
    version: 1,
    completedAt: new Date().toISOString(),
    recoveredTemplates: 0,
    conflictCopies: 0,
    invalidLegacyTemplates: 0,
    activeTemplateRestored: false,
    scannedLegacyConfigs: 0,
  };
  let preferredActiveId = "";
  const currentActive = await readJsonOrNull(path.join(targetConfig, "active_template.json"));
  const currentActiveId = /^[a-zA-Z0-9_-]{1,120}$/.test(String(currentActive?.template_id || ""))
    ? String(currentActive.template_id)
    : "";

  for (const legacyConfig of legacyConfigDirectories(legacyUserDataPaths)) {
    const legacyTemplateRoot = path.join(legacyConfig, "templates");
    let entries;
    try {
      entries = await readdir(legacyTemplateRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    report.scannedLegacyConfigs += 1;
    const idMap = new Map();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
      const sourcePath = path.join(legacyTemplateRoot, entry.name);
      const template = normalizeTemplate(await readJsonOrNull(sourcePath));
      if (!template) {
        report.invalidLegacyTemplates += 1;
        continue;
      }
      const sourceId = safeTemplateId(template.template_id);
      let targetId = sourceId;
      let targetPath = path.join(templateRoot, `${targetId}.json`);
      const existing = await readJsonOrNull(targetPath);
      if (existing) {
        if (contentDigest(existing) === contentDigest(template)) {
          idMap.set(sourceId, targetId);
          continue;
        }
        targetId = await uniqueRecoveredTemplateId(templateRoot, sourceId, template);
        targetPath = path.join(templateRoot, `${targetId}.json`);
        template.template_id = targetId;
        template.name = `${template.name.trim()}（历史恢复）`;
        report.conflictCopies += 1;
      }
      await atomicWriteJson(targetPath, template);
      idMap.set(sourceId, targetId);
      preferredActiveId ||= targetId;
      report.recoveredTemplates += 1;
    }
    const legacyActive = await readJsonOrNull(path.join(legacyConfig, "active_template.json"));
    const legacyActiveId = String(legacyActive?.template_id || "");
    if (idMap.has(legacyActiveId)) preferredActiveId = idMap.get(legacyActiveId);
  }

  const currentActiveTemplate = normalizeTemplate(await readJsonOrNull(path.join(templateRoot, `${currentActiveId}.json`)));
  const currentActiveValid = currentActiveId && currentActiveTemplate?.template_id === currentActiveId;
  if (!currentActiveValid && preferredActiveId) {
    await atomicWriteJson(path.join(targetConfig, "active_template.json"), { template_id: preferredActiveId });
    report.activeTemplateRestored = true;
  }
  await atomicWriteJson(markerPath, report);
  return { ...report, justCompleted: true };
}

async function recoverInvalidTemplatesFromBackups(configRoot) {
  const templateRoot = path.join(configRoot, "templates");
  const backupRoot = path.join(configRoot, CLASSIFIER_TEMPLATE_BACKUP_DIRECTORY);
  const corruptRoot = path.join(configRoot, "corrupt-templates");
  const recovered = [];
  const entries = await readdir(templateRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const templatePath = path.join(templateRoot, entry.name);
    const templateId = path.basename(entry.name, ".json");
    const primary = normalizeTemplate(await readJsonOrNull(templatePath));
    if (primary?.template_id === templateId) continue;
    const backups = (await readdir(path.join(backupRoot, templateId), { withFileTypes: true }).catch(() => []))
      .filter((item) => item.isFile() && item.name.endsWith(".json"))
      .map((item) => item.name)
      .sort()
      .reverse();
    for (const backupName of backups) {
      const backup = normalizeTemplate(await readJsonOrNull(path.join(backupRoot, templateId, backupName)));
      if (!backup || backup.template_id !== templateId) continue;
      await mkdir(corruptRoot, { recursive: true });
      await copyFile(templatePath, path.join(corruptRoot, `${templateId}-${Date.now()}.json`));
      await atomicWriteJson(templatePath, backup);
      recovered.push(templateId);
      break;
    }
  }
  return recovered;
}

async function initializeClassifierUserConfig({ packageRoot, userDataPath, legacyUserDataPaths = [] }) {
  const userRoot = classifierUserRoot(userDataPath);
  const sourceConfig = path.join(packageRoot, "config");
  const targetConfig = path.join(userRoot, "config");
  await mkdir(targetConfig, { recursive: true });
  const migration = await migrateLegacyTemplates({ targetConfig, legacyUserDataPaths });
  // Merge newly shipped defaults, but never replace a user's saved settings,
  // active template, custom templates, or rule documents on app restart/update.
  await cp(sourceConfig, targetConfig, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  const recoveredFromBackup = await recoverInvalidTemplatesFromBackups(targetConfig);
  runtimeReports.set(path.resolve(userRoot), { migration, recoveredFromBackup });
  return userRoot;
}

export async function ensureClassifierUserConfig(options) {
  // Several feature bootstraps share this directory. Serialize default copies
  // and migrations so a fresh installation cannot race on directory creation.
  const key = path.resolve(classifierUserRoot(options.userDataPath));
  const previous = configInitializations.get(key);
  const operation = previous
    ? previous.catch(() => {}).then(() => initializeClassifierUserConfig(options))
    : initializeClassifierUserConfig(options);
  configInitializations.set(key, operation);
  try {
    return await operation;
  } finally {
    if (configInitializations.get(key) === operation) configInitializations.delete(key);
  }
}

export async function loadClassifierTemplateState(userRoot) {
  const configRoot = path.join(userRoot, "config");
  const templateRoot = path.join(configRoot, "templates");
  const entries = await readdir(templateRoot, { withFileTypes: true }).catch(() => []);
  const templates = [];
  let invalidTemplateCount = 0;
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const template = normalizeTemplate(await readJsonOrNull(path.join(templateRoot, entry.name)));
    if (!template || path.basename(entry.name, ".json") !== template.template_id || seen.has(template.template_id)) {
      invalidTemplateCount += 1;
      continue;
    }
    seen.add(template.template_id);
    templates.push(template);
  }
  const active = await readJsonOrNull(path.join(configRoot, "active_template.json"));
  const requestedActiveId = String(active?.template_id || "");
  const activeTemplateId = seen.has(requestedActiveId) ? requestedActiveId : templates[0]?.template_id || "";
  if (activeTemplateId && activeTemplateId !== requestedActiveId) {
    await atomicWriteJson(path.join(configRoot, "active_template.json"), { template_id: activeTemplateId });
  }
  const report = runtimeReports.get(path.resolve(userRoot)) || {};
  return {
    templates,
    activeTemplateId,
    configHealth: {
      recoveredTemplates: Number(report.migration?.justCompleted ? report.migration.recoveredTemplates : 0) || 0,
      conflictCopies: Number(report.migration?.justCompleted ? report.migration.conflictCopies : 0) || 0,
      recoveredFromBackup: Array.isArray(report.recoveredFromBackup) ? report.recoveredFromBackup.length : 0,
      invalidTemplateCount: invalidTemplateCount + (Number(report.migration?.justCompleted ? report.migration.invalidLegacyTemplates : 0) || 0),
    },
  };
}

export async function writeClassifierActiveTemplate(userRoot, templateId) {
  const safeId = safeTemplateId(templateId);
  const template = await readJsonOrNull(path.join(userRoot, "config", "templates", `${safeId}.json`));
  if (!validTemplate(template) || template.template_id !== safeId) throw new Error("当前分类方案不存在或已损坏");
  await atomicWriteJson(path.join(userRoot, "config", "active_template.json"), { template_id: safeId });
}

export async function writeClassifierTemplate(userRoot, template, { backupExisting = true } = {}) {
  const normalized = normalizeTemplate(template);
  if (!normalized) throw new Error("分类方案内容不完整");
  const templateId = safeTemplateId(normalized.template_id);
  const templatePath = path.join(userRoot, "config", "templates", `${templateId}.json`);
  if (backupExisting && await pathExists(templatePath)) {
    const existing = await readFile(templatePath);
    const backupDirectory = path.join(userRoot, "config", CLASSIFIER_TEMPLATE_BACKUP_DIRECTORY, templateId);
    const backupPath = path.join(backupDirectory, `${Date.now()}-${createHash("sha256").update(existing).digest("hex").slice(0, 10)}.json`);
    await mkdir(backupDirectory, { recursive: true });
    if (!await pathExists(backupPath)) await copyFile(templatePath, backupPath);
  }
  await atomicWriteJson(templatePath, normalized);
  return templatePath;
}

export function classificationProviderFromSettings(settings = {}) {
  const vision = settings.vision_model || {};
  return vision.connection_type === "relay" || vision.provider === "openai" ? "relay" : "volcengine";
}

export function classificationApiKeyForProvider(profiles = {}, provider) {
  return String(provider === "relay" ? profiles?.relay?.apiKey || "" : profiles?.volcengine?.apiKey || "").trim();
}

export function buildClassifierRuntimeEnvironment(baseEnvironment, profiles, provider) {
  const apiKey = classificationApiKeyForProvider(profiles, provider);
  return {
    ...baseEnvironment,
    ...(apiKey ? { ARK_API_KEY: apiKey } : {}),
  };
}
