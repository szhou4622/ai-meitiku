import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

export const API_SETTINGS_STORE_FILE = "api-settings.v1.bin";
// Fingerprints of credentials accidentally distributed in legacy installers.
// Never include the credential itself, including in migration code or tests.
const leakedKeys = new Set(["0cd74e03db87fb42c23fb81f8766d780917a313c9f90fc03d921796204b3797d"]);
const leakedEndpoints = new Set(["c14080c2dc0d158fb0820551557a68842737a346dac3a8905211693152c86a53"]);
const fingerprint = value => createHash("sha256").update(String(value || "").trim()).digest("hex");
export const isLeakedApiKey = value => leakedKeys.has(fingerprint(value));
export const isLeakedEndpoint = value => leakedEndpoints.has(fingerprint(value));

export function customerProfiles(stored, { isLeakedKey = isLeakedApiKey, isLeakedId = isLeakedEndpoint } = {}) {
  const profiles = {
    provider: stored?.provider === "relay" ? "relay" : "volcengine",
    volcengine: { endpointId: String(stored?.volcengine?.endpointId || ""), apiKey: String(stored?.volcengine?.apiKey || "") },
    relay: { baseUrl: String(stored?.relay?.baseUrl || ""), textModel: String(stored?.relay?.textModel || ""),
      visionModel: String(stored?.relay?.visionModel || ""), apiKey: String(stored?.relay?.apiKey || "") },
  };
  let removed = false;
  for (const provider of ["volcengine", "relay"]) {
    const selected = profiles[provider];
    if (isLeakedKey(selected.apiKey)) { selected.apiKey = ""; removed = true; }
    // Keep personal endpoint choices whenever a different user credential exists.
    if (!selected.apiKey) {
      for (const field of provider === "volcengine" ? ["endpointId"] : ["textModel", "visionModel"]) {
        if (isLeakedId(selected[field])) { selected[field] = ""; removed = true; }
      }
    }
  }
  return { profiles, removed };
}

export async function loadCustomerProfiles(secureStore, { legacyProvider } = {}) {
  if (!secureStore) throw new Error("系统安全凭证存储尚未就绪");
  const raw = await secureStore.readEncrypted(API_SETTINGS_STORE_FILE);
  let stored = null;
  if (raw) {
    try { stored = JSON.parse(raw); }
    catch { throw new Error("分类 API 独立配置无法读取，请检查系统安全凭证存储"); }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error("分类 API 独立配置格式无效");
  }
  if (stored && !stored.provider && legacyProvider) stored.provider = await legacyProvider();
  const { profiles, removed } = customerProfiles(stored);
  if (removed) await secureStore.writeEncrypted(API_SETTINGS_STORE_FILE, JSON.stringify(profiles));
  return profiles;
}

export async function cleanLegacyRuntimeCredentials(root, { isLeakedKey = isLeakedApiKey } = {}) {
  for (const name of [".env", ".env.local"]) {
    const file = path.join(root, name);
    let text;
    try { text = await readFile(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const clean = text.split(/\r?\n/).filter(line => {
      if (line.trim().startsWith("#")) return true;
      const match = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z_0-9]*\s*=\s*(.*?)\s*$/);
      return !match || !isLeakedKey(match[1].replace(/^['"]|['"]$/g, ""));
    }).join("\n");
    if (clean !== text) {
      const temp = `${file}.${randomUUID()}.credential-cleanup.tmp`;
      await writeFile(temp, clean, { mode: 0o600 });
      await rename(temp, file);
    }
  }
}
