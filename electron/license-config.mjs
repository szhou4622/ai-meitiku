export const LICENSE_CONFIG = Object.freeze({
  appName: "ai-media-library",
  softwareName: "AI媒体库",
  baseUrl: "https://license.dadaozixun.com/api/license",
  protocolVersion: 2,
  offlineGraceDays: 7,
});

export const TEST_LICENSE_BASE_URL_ENV = "AI_MEDIA_LIBRARY_TEST_LICENSE_BASE_URL";

export function licenseConfigForRuntime({ isPackaged, environment = process.env } = {}) {
  const requested = String(environment?.[TEST_LICENSE_BASE_URL_ENV] || "").trim();
  if (isPackaged || !requested) return LICENSE_CONFIG;

  let parsed;
  try {
    parsed = new URL(requested);
  } catch {
    throw new Error(`${TEST_LICENSE_BASE_URL_ENV} 必须是有效的本机测试 URL`);
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || !parsed.port
    || pathname !== "/api/license"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`${TEST_LICENSE_BASE_URL_ENV} 只允许 http://127.0.0.1:<端口>/api/license`);
  }
  return Object.freeze({ ...LICENSE_CONFIG, baseUrl: `${parsed.origin}${pathname}` });
}
