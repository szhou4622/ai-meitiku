import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const CONTACT_CONFIG_URL = "https://update.dadaozixun.com/api/contact";
export const CONTACT_CACHE_FILENAME = "contact-config.json";
export const BUNDLED_CONTACT_IMAGE_URL = "/favicon.svg";

export function contactCachePath(userDataPath) {
  return path.join(userDataPath, CONTACT_CACHE_FILENAME);
}

function contactStatus(config) {
  if (!config.enabled) return "disabled";
  if (!config.qr_image_url) return "missing_image";
  return "ready";
}

function contactMessage(status, source) {
  if (status === "disabled") return "联系方式暂未开放";
  if (status === "missing_image") return "联系方式图片暂未配置";
  if (source === "cache") return "网络暂不可用，已显示最近一次有效联系方式";
  return "";
}

export function validateContactConfig(payload, appName) {
  const candidate = payload && typeof payload === "object" && payload.data && typeof payload.data === "object"
    ? payload.data
    : payload;
  if (!candidate || typeof candidate !== "object") throw new Error("contact_config_invalid");
  if (candidate.app_name !== appName) throw new Error("contact_app_name_mismatch");
  if (typeof candidate.enabled !== "boolean") throw new Error("contact_enabled_invalid");

  const rawImageUrl = typeof candidate.qr_image_url === "string" ? candidate.qr_image_url.trim() : "";
  if (rawImageUrl) {
    let parsed;
    try {
      parsed = new URL(rawImageUrl);
    } catch {
      throw new Error("contact_image_url_invalid");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("contact_image_url_not_https");
    }
  }

  return {
    app_name: candidate.app_name,
    enabled: candidate.enabled,
    qr_image_url: candidate.enabled ? rawImageUrl || null : null,
    updated_at: typeof candidate.updated_at === "string" ? candidate.updated_at : null,
  };
}

function present(config, source, bundledImageUrl, message = "") {
  const status = contactStatus(config);
  return {
    ...config,
    source,
    status,
    message: message || contactMessage(status, source),
    fallback_image_url: bundledImageUrl,
  };
}

function bundledFallback(appName, bundledImageUrl, message = "") {
  return {
    app_name: appName,
    enabled: true,
    qr_image_url: null,
    updated_at: null,
    source: "bundled",
    status: "fallback",
    message,
    fallback_image_url: bundledImageUrl,
  };
}

export class ContactService {
  constructor({
    appName,
    userDataPath,
    fetchImpl = globalThis.fetch,
    bundledImageUrl = BUNDLED_CONTACT_IMAGE_URL,
    requestTimeoutMs = 6000,
  }) {
    if (!appName) throw new Error("contact_app_name_required");
    if (!userDataPath) throw new Error("contact_user_data_path_required");
    this.appName = appName;
    this.fetchImpl = fetchImpl;
    this.bundledImageUrl = bundledImageUrl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.cachePath = contactCachePath(userDataPath);
  }

  async readCache() {
    try {
      const parsed = JSON.parse(await readFile(this.cachePath, "utf8"));
      return validateContactConfig(parsed, this.appName);
    } catch {
      return null;
    }
  }

  async writeCache(config) {
    await mkdir(path.dirname(this.cachePath), { recursive: true });
    const temporaryPath = `${this.cachePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.cachePath);
  }

  async fallbackFromCache(message = "") {
    const cached = await this.readCache();
    if (cached) return present(cached, "cache", this.bundledImageUrl, message);
    return bundledFallback(this.appName, this.bundledImageUrl, message);
  }

  async getContactConfig() {
    const endpoint = `${CONTACT_CONFIG_URL}?app_name=${encodeURIComponent(this.appName)}`;
    let response;
    try {
      response = await this.fetchImpl(endpoint, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      return this.fallbackFromCache("网络暂不可用，已使用本地联系方式");
    }

    if (response.status === 404) {
      return bundledFallback(this.appName, this.bundledImageUrl, "后台暂未配置联系方式，已显示内置图片");
    }
    if (!response.ok) {
      return this.fallbackFromCache("联系配置服务暂不可用，已使用本地联系方式");
    }

    let config;
    try {
      config = validateContactConfig(await response.json(), this.appName);
    } catch {
      return this.fallbackFromCache("远程联系配置未通过安全校验，已使用本地联系方式");
    }
    try {
      await this.writeCache(config);
    } catch {
      // A read-only cache directory must not hide a valid live configuration.
    }
    return present(config, "remote", this.bundledImageUrl);
  }
}

export function createContactService(options) {
  return new ContactService(options);
}
