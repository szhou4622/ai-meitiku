import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_BASE_URL = "https://api.dadaozixun.com";
const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;
const QIANCHUAN_AUTH_HOST = "qianchuan.jinritemai.com";
const QIANCHUAN_CALLBACK_URL = "https://api.dadaozixun.com/qianchuan/callback";
const QIANCHUAN_DOWNLOAD_REFERER = "https://qianchuan.jinritemai.com/";
const QIANCHUAN_LIBRARY_CACHE_VERSION = 1;
const QIANCHUAN_LIBRARY_MAX_ITEMS = 500;
const QIANCHUAN_LIBRARY_PAGE_SIZE = 50;
const QIANCHUAN_LIBRARY_DATE_SCAN_PAGES = 50;
const QIANCHUAN_INSIGHT_SYNC_CONCURRENCY = 3;
const QIANCHUAN_INSIGHT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const QIANCHUAN_INSIGHT_METRIC_ALIASES = Object.freeze({
  conversion_rate_percent: "live_convert_rate_for_roi2_v2",
  cpm: "total_ecpm_for_roi2",
  cpc: "total_cpc_for_roi2",
  order_cost: "total_cost_per_pay_order_for_roi2",
  video_2s_rate_percent: "video_play_duration_2s_rate_for_roi2",
  video_5s_rate_percent: "video_play_duration_5s_rate_for_roi2",
  video_10s_rate_percent: "video_play_duration_10s_rate_for_roi2",
  video_completions: "video_play_finish_count_for_roi2_v2",
  new_followers: "video_follow_count_for_roi2",
  actual_paid_gmv: "total_pay_order_gmv_for_roi2",
  coupon_amount: "total_pay_order_coupon_amount_for_roi2",
  platform_subsidy_amount: "total_ecom_platform_subsidy_amount_for_roi2",
  net_gmv_1h: "total_order_settle_amount_for_roi2_1h",
  refund_orders_1h: "total_refund_order_count_for_roi2_1h",
  refund_amount_1h: "total_refund_order_gmv_for_roi2_1h_all",
  refund_rate_1h: "total_refund_order_gmv_for_roi2_1h_rate",
  settlement_gmv_7d: "total_order_settle_amount_for_roi2_7d",
  settlement_gmv_14d: "total_order_settle_amount_for_roi2_14d",
  settlement_gmv_30d: "total_order_settle_amount_for_roi2_30d",
  settlement_gmv_90d: "total_order_settle_amount_for_roi2_90d",
  settlement_roi_7d: "total_prepay_and_pay_settle_roi2_7d",
  settlement_roi_14d: "total_prepay_and_pay_settle_roi2_14d",
  settlement_roi_30d: "total_prepay_and_pay_settle_roi2_30d",
  settlement_roi_90d: "total_prepay_and_pay_settle_roi2_90d",
  base_spend: "basic_stat_cost_for_roi2_v2",
  boost_spend: "heat_stat_cost_for_roi2",
  boost_gmv: "heat_total_pay_order_gmv_for_roi2",
  boost_roi: "heat_total_prepay_and_pay_order_roi2",
});
const QIANCHUAN_OAUTH_HOST_SUFFIXES = Object.freeze([
  "jinritemai.com",
  "oceanengine.com",
  "douyin.com",
  "bytedance.com",
]);

function responseMessage(body, fallback) {
  return String(body?.detail || body?.message || fallback);
}

function optionalFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function normalizedStringList(...values) {
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value ?? "").trim()).filter(Boolean))].slice(0, 20);
}

function normalizedQianchuanDate(value) {
  const source = String(value ?? "").trim();
  const calendarDate = source.match(/^(\d{4}-\d{2}-\d{2})/);
  if (calendarDate) return calendarDate[1];
  if (!/^\d{10,13}$/.test(source)) return "";
  const timestamp = Number(source) * (source.length === 10 ? 1000 : 1);
  const parsed = new Date(timestamp);
  // Qianchuan reports day buckets at China Standard Time midnight, while the
  // epoch value serializes that boundary in UTC. Preserve the provider's day.
  return Number.isFinite(timestamp) && !Number.isNaN(parsed.getTime())
    ? new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : "";
}

function normalizeQianchuanInsights(source) {
  if (!source || typeof source !== "object") return null;
  const rawMetrics = source.metrics && typeof source.metrics === "object" ? source.metrics : {};
  const metrics = Object.fromEntries(Object.entries(QIANCHUAN_INSIGHT_METRIC_ALIASES).map(([clientKey, providerKey]) => [
    clientKey,
    optionalFiniteNumber(rawMetrics[clientKey], rawMetrics[providerKey]),
  ]));
  const rawMaterial = source.material && typeof source.material === "object" ? source.material : {};
  const material = {
    status: normalizedStringList(rawMaterial.status, rawMaterial.material_status),
    advice: normalizedStringList(rawMaterial.advice, rawMaterial.material_advice),
    created_at: normalizedStringList(rawMaterial.created_at, rawMaterial.material_create_time_v2),
    uploaded_at: normalizedStringList(rawMaterial.uploaded_at, rawMaterial.roi2_material_upload_time),
    bid_type_codes: normalizedStringList(rawMaterial.bid_type_codes, rawMaterial.aggregate_smart_bid_type),
    order_platform_codes: normalizedStringList(rawMaterial.order_platform_codes, rawMaterial.ecp_app_id),
  };
  const dailyTrend = (Array.isArray(source.daily_trend) ? source.daily_trend : []).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const date = normalizedQianchuanDate(item.date ?? item.stat_time_day);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    const spend = optionalFiniteNumber(item.spend, item.stat_cost_for_roi2) ?? 0;
    const paidGmv = optionalFiniteNumber(item.paid_gmv, item.gmv, item.total_pay_order_gmv_include_coupon_for_roi2) ?? 0;
    return [{
      date,
      spend,
      paid_gmv: paidGmv,
      paid_roi: optionalFiniteNumber(item.paid_roi, item.roi, item.total_prepay_and_pay_order_roi2) ?? (spend ? paidGmv / spend : 0),
      video_plays: optionalFiniteNumber(item.video_plays, item.video_play_count_for_roi2_v2) ?? 0,
    }];
  });
  const hasMetric = Object.values(metrics).some((value) => value !== null);
  const hasMaterial = Object.values(material).some((values) => values.length > 0);
  return {
    available: Boolean(source.available) || hasMetric || hasMaterial || dailyTrend.length > 0,
    metrics,
    material,
    daily_trend: dailyTrend,
    unavailable_groups: Array.isArray(source.unavailable_groups) ? source.unavailable_groups.slice(0, 32) : [],
  };
}

function normalizeQianchuanReportResponse(response) {
  if (!response || typeof response !== "object" || !("insights" in response)) return response;
  return { ...response, insights: normalizeQianchuanInsights(response.insights) };
}

function assertSafeDownloadUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error("千川未返回有效的视频下载地址");
  }
  if (parsed.protocol !== "https:") throw new Error("千川视频下载地址不安全，已拒绝下载");
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("千川视频下载地址不安全，已拒绝下载");
  if (isIP(host)) {
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === "::1") {
      throw new Error("千川视频下载地址不安全，已拒绝下载");
    }
  }
  return parsed;
}

function safeFilename(value, fallback = "千川素材.mp4") {
  const source = path.basename(String(value || fallback)).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").trim();
  const withExtension = path.extname(source) ? source : `${source}.mp4`;
  return withExtension.slice(0, 180) || fallback;
}

function qianchuanDownloadHeaders() {
  return {
    Referer: QIANCHUAN_DOWNLOAD_REFERER,
    Range: "bytes=0-",
  };
}

function localIsoDate(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function daysBeforeIsoDate(days) {
  const value = new Date();
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() - days);
  return localIsoDate(value);
}

function normalizedLibraryQuery(payload = {}) {
  const materialMode = payload.material_mode === "created_range" ? "created_range" : "recent";
  const requestedLimit = Number(payload.material_limit || 100);
  const materialLimit = [50, 100, 300, 500].includes(requestedLimit) ? requestedLimit : 100;
  const reportEndDate = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.report_end_date || ""))
    ? String(payload.report_end_date)
    : localIsoDate();
  const reportStartDate = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.report_start_date || ""))
    ? String(payload.report_start_date)
    : daysBeforeIsoDate(29);
  const materialStartDate = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.material_start_date || ""))
    ? String(payload.material_start_date)
    : daysBeforeIsoDate(29);
  const materialEndDate = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.material_end_date || ""))
    ? String(payload.material_end_date)
    : localIsoDate();
  if (reportStartDate > reportEndDate) throw new Error("数据统计周期的开始日期不能晚于结束日期");
  if (materialMode === "created_range" && materialStartDate > materialEndDate) {
    throw new Error("素材创建日期的开始日期不能晚于结束日期");
  }
  return {
    material_mode: materialMode,
    material_limit: materialLimit,
    material_start_date: materialMode === "created_range" ? materialStartDate : "",
    material_end_date: materialMode === "created_range" ? materialEndDate : "",
    report_start_date: reportStartDate,
    report_end_date: reportEndDate,
  };
}

function materialCreatedDate(value) {
  const source = String(value || "").trim();
  const direct = source.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];
  if (/^\d{10,13}$/.test(source)) {
    const numeric = Number(source);
    const parsed = new Date(source.length === 10 ? numeric * 1000 : numeric);
    if (!Number.isNaN(parsed.getTime())) return localIsoDate(parsed);
  }
  return "";
}

function emptyPerformanceForVideo(video) {
  return {
    advertiser_id: String(video?.advertiser_id || ""),
    material_id: String(video?.material_id || ""),
    video_id: String(video?.video_id || ""),
    filename: String(video?.filename || "未命名千川素材"),
    material_type: String(video?.source || "千川视频"),
    created_at: String(video?.created_at || ""),
    poster_url: String(video?.poster_url || ""),
    duration_seconds: Number(video?.duration_seconds || 0),
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    download_available: Boolean(video?.download_available),
    spend: 0,
    live_impressions: 0,
    // Keep the existing server/cache keys for compatibility; both represent click metrics.
    live_viewers: 0,
    live_conversion_rate_percent: 0,
    paid_orders: 0,
    paid_gmv: 0,
    paid_roi: 0,
    video_plays: 0,
    video_completion_rate_percent: 0,
    video_likes: 0,
    video_comments: 0,
    video_average_watch_seconds: 0,
    video_3s_play_rate_percent: 0,
  };
}

function sanitizedPerformanceItem(item) {
  const safe = emptyPerformanceForVideo(item);
  safe.material_type = String(item?.material_type || item?.source || "千川视频").slice(0, 64);
  safe.poster_url = String(item?.poster_url || "").slice(0, 4096);
  safe.download_available = Boolean(item?.download_available);
  for (const key of [
    "duration_seconds", "width", "height",
    "spend", "live_impressions", "live_viewers", "live_conversion_rate_percent",
    "paid_orders", "paid_gmv", "paid_roi", "video_plays",
    "video_completion_rate_percent", "video_likes", "video_comments",
    "video_average_watch_seconds", "video_3s_play_rate_percent",
  ]) safe[key] = Number(item?.[key] || 0);
  return safe;
}

function sanitizedVideoCandidate(item) {
  return {
    advertiser_id: String(item?.advertiser_id || ""),
    material_id: String(item?.material_id || ""),
    video_id: String(item?.video_id || ""),
    filename: String(item?.filename || "未命名千川素材").slice(0, 500),
    source: String(item?.source || "QIANCHUAN").slice(0, 64),
    created_at: String(item?.created_at || "").slice(0, 64),
    poster_url: String(item?.poster_url || "").slice(0, 4096),
    duration_seconds: Number(item?.duration_seconds || 0),
    width: Number(item?.width || 0),
    height: Number(item?.height || 0),
    download_available: Boolean(item?.download_available),
  };
}

function libraryCacheKey(authorizationId, advertiserId) {
  return `${authorizationId}:${advertiserId}`;
}

function assertSafeAuthorizationUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error("千川官方授权地址无效，已取消打开");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== QIANCHUAN_AUTH_HOST
    || parsed.pathname !== "/openapi/qc/audit/oauth.html"
    || !/^\d{8,32}$/.test(parsed.searchParams.get("app_id") || "")
    || parsed.searchParams.get("redirect_uri") !== QIANCHUAN_CALLBACK_URL
    || !parsed.searchParams.get("state")
  ) {
    throw new Error("千川官方授权地址校验失败，已取消打开");
  }
  return parsed;
}

function normalizeQianchuanBrowserMode(value) {
  return value === "system" ? "system" : "embedded";
}

function isAllowedQianchuanOauthNavigation(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "api.dadaozixun.com" && parsed.pathname === "/qianchuan/callback") return true;
  return QIANCHUAN_OAUTH_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function assertSafeQianchuanOauthNavigation(value) {
  if (!isAllowedQianchuanOauthNavigation(value)) {
    throw new Error("千川授权页面尝试跳转到非官方地址，已阻止打开");
  }
  return new URL(String(value));
}

function isQianchuanOauthCallback(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return false;
  }
  return parsed.protocol === "https:"
    && parsed.hostname.toLowerCase() === "api.dadaozixun.com"
    && parsed.pathname === "/qianchuan/callback";
}

async function availableTarget(directory, filename) {
  const extension = path.extname(filename);
  const base = path.basename(filename, extension);
  for (let suffix = 0; suffix < 10000; suffix += 1) {
    const target = path.join(directory, suffix ? `${base}_${suffix + 1}${extension}` : filename);
    try {
      await stat(target);
    } catch (error) {
      if (error?.code === "ENOENT") return target;
      throw error;
    }
  }
  throw new Error("目标文件夹中同名文件过多，请更换文件夹");
}

export class QianchuanService {
  constructor({ secureStore, userDataPath = "", baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch }) {
    this.secureStore = secureStore;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.session = null;
    this.libraryCachePath = userDataPath
      ? path.join(userDataPath, "qianchuan", "viral-library-cache.v1.json")
      : "";
    this.libraryCacheWrite = Promise.resolve();
    this.activeLibrarySync = null;
  }

  async exchangeSession() {
    const credential = await this.secureStore?.readCredential();
    if (!credential?.deviceSession || !credential?.deviceCredential) {
      throw new Error("设备授权凭证不完整，请重新验证软件授权");
    }
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/v1/qianchuan/session/exchange`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential.deviceSession}`,
          "X-Device-Credential": credential.deviceCredential,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error("千川服务暂时无法连接，请重试");
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body?.access_token) {
      throw new Error(responseMessage(body, "千川会话建立失败，请重试"));
    }
    this.session = {
      token: body.access_token,
      expiresAt: Date.now() + Math.max(60, Number(body.expires_in || 300) - 60) * 1000,
    };
    return this.session.token;
  }

  async accessToken(force = false) {
    if (!force && this.session?.token && this.session.expiresAt > Date.now()) return this.session.token;
    return this.exchangeSession();
  }

  async request(endpoint, payload = {}, retry = true) {
    const token = await this.accessToken();
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(90000),
      });
    } catch {
      throw new Error("千川服务暂时无法连接，请重试");
    }
    if (response.status === 401 && retry) {
      this.session = null;
      await this.accessToken(true);
      return this.request(endpoint, payload, false);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(responseMessage(body, "千川请求失败，请重试"));
    return body;
  }

  bootstrap() {
    return this.request("/api/v1/qianchuan/media/bootstrap");
  }

  configStatus() {
    return this.request("/api/v1/qianchuan/app-config/status");
  }

  saveAppConfig(payload) {
    const appId = String(payload?.app_id || "").trim();
    const appSecret = String(payload?.app_secret || "").trim();
    if (!/^\d{8,32}$/.test(appId)) throw new Error("请输入正确的千川 APP ID");
    if (appSecret && (appSecret.length < 8 || appSecret.length > 256)) {
      throw new Error("千川 APP Secret 格式不正确");
    }
    return this.request("/api/v1/qianchuan/app-config/save", { app_id: appId, app_secret: appSecret });
  }

  confirmCallback() {
    return this.request("/api/v1/qianchuan/app-config/confirm-callback");
  }

  testAppConfig() {
    return this.request("/api/v1/qianchuan/app-config/test");
  }

  async startAuthorization() {
    const result = await this.request("/api/v1/qianchuan/oauth/start");
    assertSafeAuthorizationUrl(result?.auth_url);
    return result;
  }

  pollAuthorization(flowId) {
    const normalized = String(flowId || "").trim();
    if (!/^qcf_[a-f0-9]{16,}$/.test(normalized)) throw new Error("千川授权流程编号无效");
    return this.request("/api/v1/qianchuan/oauth/poll", { flow_id: normalized });
  }

  revokeAuthorization(authorizationId) {
    const normalized = String(authorizationId || "").trim();
    if (!/^qca_[a-f0-9]{16,}$/.test(normalized)) throw new Error("千川授权编号无效");
    return this.request("/api/v1/qianchuan/oauth/revoke", { authorization_id: normalized });
  }

  videos(payload) {
    return this.request("/api/v1/qianchuan/media/videos", payload);
  }

  async resolve(payload, { includeDownloadUrl = false } = {}) {
    const result = await this.request("/api/v1/qianchuan/media/resolve", payload);
    if (!includeDownloadUrl && result?.video) {
      const safeVideo = { ...result.video };
      delete safeVideo.download_url;
      return { ...result, video: safeVideo };
    }
    return result;
  }

  async report(payload, { persistInsight = true } = {}) {
    const result = normalizeQianchuanReportResponse(await this.request("/api/v1/qianchuan/media/report", payload));
    if (persistInsight && this.libraryCachePath && result && typeof result === "object" && "insights" in result) {
      const authorizationId = String(payload?.authorization_id || "").trim();
      const advertiserId = String(payload?.advertiser_id || "").trim();
      const materialId = String(payload?.material_id || "").trim();
      const startDate = String(payload?.start_date || "").trim();
      const endDate = String(payload?.end_date || "").trim();
      if (authorizationId && /^\d{6,32}$/.test(advertiserId) && materialId) {
        const syncedAt = new Date().toISOString();
        await this.updateLibraryCacheStore(libraryCacheKey(authorizationId, advertiserId), (entry) => {
          const complete = entry.complete;
          if (!complete
            || complete.start_date !== startDate
            || complete.end_date !== endDate
            || !Array.isArray(complete.items)
            || !complete.items.some((item) => item?.material_id === materialId)) return entry;
          const insightsByMaterial = {
            ...(complete.insights_by_material && typeof complete.insights_by_material === "object" ? complete.insights_by_material : {}),
            [materialId]: { insights: result.insights ?? null, synced_at: syncedAt },
          };
          return {
            ...entry,
            complete: {
              ...complete,
              insights_by_material: insightsByMaterial,
              insights_completed: Object.keys(insightsByMaterial).length,
              insights_total: complete.items.length,
            },
            updated_at: syncedAt,
          };
        }).catch(() => {});
      }
    }
    return result;
  }

  top(payload) {
    return this.request("/api/v1/qianchuan/media/top", payload);
  }

  async readLibraryCacheStore() {
    if (!this.libraryCachePath) return { version: QIANCHUAN_LIBRARY_CACHE_VERSION, records: {} };
    await this.libraryCacheWrite.catch(() => {});
    try {
      const parsed = JSON.parse(await readFile(this.libraryCachePath, "utf8"));
      if (parsed?.version !== QIANCHUAN_LIBRARY_CACHE_VERSION || !parsed.records || typeof parsed.records !== "object") {
        return { version: QIANCHUAN_LIBRARY_CACHE_VERSION, records: {} };
      }
      return parsed;
    } catch {
      return { version: QIANCHUAN_LIBRARY_CACHE_VERSION, records: {} };
    }
  }

  updateLibraryCacheStore(key, update) {
    if (!this.libraryCachePath) return Promise.resolve();
    this.libraryCacheWrite = this.libraryCacheWrite.catch(() => {}).then(async () => {
      let store;
      try {
        store = JSON.parse(await readFile(this.libraryCachePath, "utf8"));
      } catch {
        store = null;
      }
      if (store?.version !== QIANCHUAN_LIBRARY_CACHE_VERSION || !store.records || typeof store.records !== "object") {
        store = { version: QIANCHUAN_LIBRARY_CACHE_VERSION, records: {} };
      }
      const previous = store.records[key] && typeof store.records[key] === "object" ? store.records[key] : {};
      const next = update(previous);
      if (next) store.records[key] = next;
      else delete store.records[key];
      const entries = Object.entries(store.records).sort((left, right) =>
        String(right[1]?.updated_at || "").localeCompare(String(left[1]?.updated_at || ""))
      );
      store.records = Object.fromEntries(entries.slice(0, 24));
      const directory = path.dirname(this.libraryCachePath);
      const temporaryPath = `${this.libraryCachePath}.${process.pid}.${Date.now()}.tmp`;
      await mkdir(directory, { recursive: true });
      try {
        await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporaryPath, this.libraryCachePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
      }
    });
    return this.libraryCacheWrite;
  }

  async libraryCache(payload) {
    const authorizationId = String(payload?.authorization_id || "").trim();
    const advertiserId = String(payload?.advertiser_id || "").trim();
    if (!authorizationId || !/^\d{6,32}$/.test(advertiserId)) throw new Error("千川账户参数无效");
    const store = await this.readLibraryCacheStore();
    const entry = store.records[libraryCacheKey(authorizationId, advertiserId)];
    return {
      success: true,
      cache: entry?.complete || null,
      resumable: Boolean(entry?.checkpoint),
      checkpoint: entry?.checkpoint ? {
        query: entry.checkpoint.query,
        scanned_count: Number(entry.checkpoint.scanned_count || 0),
        collected_count: Array.isArray(entry.checkpoint.candidates) ? entry.checkpoint.candidates.length : 0,
        stage: String(entry.checkpoint.stage || "materials"),
      } : null,
    };
  }

  cancelLibrarySync() {
    if (!this.activeLibrarySync) return { success: true, cancelled: false };
    this.activeLibrarySync.cancelled = true;
    return { success: true, cancelled: true };
  }

  async syncLibrary(payload, onProgress = () => {}) {
    const authorizationId = String(payload?.authorization_id || "").trim();
    const advertiserId = String(payload?.advertiser_id || "").trim();
    if (!authorizationId || !/^\d{6,32}$/.test(advertiserId)) throw new Error("千川账户参数无效");
    const query = normalizedLibraryQuery(payload);
    this.cancelLibrarySync();
    const run = { cancelled: false };
    this.activeLibrarySync = run;
    const key = libraryCacheKey(authorizationId, advertiserId);
    const store = await this.readLibraryCacheStore();
    const previousEntry = store.records[key] || {};
    const resumable = previousEntry.checkpoint
      && JSON.stringify(previousEntry.checkpoint.query) === JSON.stringify(query);
    let candidates = resumable && Array.isArray(previousEntry.checkpoint.candidates)
      ? previousEntry.checkpoint.candidates.map(sanitizedVideoCandidate).slice(0, QIANCHUAN_LIBRARY_MAX_ITEMS)
      : [];
    let page = resumable ? Math.max(1, Number(previousEntry.checkpoint.next_page || 1)) : 1;
    let scannedCount = resumable ? Math.max(0, Number(previousEntry.checkpoint.scanned_count || 0)) : 0;
    let totalPages = resumable ? Math.max(0, Number(previousEntry.checkpoint.total_pages || 0)) : 0;
    let totalNumber = resumable ? Math.max(0, Number(previousEntry.checkpoint.total_number || 0)) : 0;
    let hasMore = false;
    let stage = resumable ? String(previousEntry.checkpoint.stage || "materials") : "materials";

    const emit = (progress) => {
      try { onProgress({ advertiser_id: advertiserId, ...progress }); } catch {}
    };
    const saveCheckpoint = async () => {
      const checkpoint = {
        query,
        stage,
        next_page: page,
        scanned_count: scannedCount,
        total_pages: totalPages,
        total_number: totalNumber,
        candidates: candidates.slice(0, QIANCHUAN_LIBRARY_MAX_ITEMS),
        updated_at: new Date().toISOString(),
      };
      await this.updateLibraryCacheStore(key, (entry) => ({
        ...entry,
        authorization_id: authorizationId,
        advertiser_id: advertiserId,
        checkpoint,
        updated_at: checkpoint.updated_at,
      }));
    };
    const cancelledResult = async () => {
      await saveCheckpoint();
      emit({ stage: "cancelled", scanned_count: scannedCount, collected_count: candidates.length, message: "同步已取消，进度已保存" });
      return { success: false, cancelled: true, message: "同步已取消，进度已保存" };
    };

    try {
      if (stage === "materials") {
        const seen = new Set(candidates.map((item) => item.material_id));
        while (page <= QIANCHUAN_LIBRARY_DATE_SCAN_PAGES) {
          if (run.cancelled) return await cancelledResult();
          const result = await this.videos({
            authorization_id: authorizationId,
            advertiser_id: advertiserId,
            page,
            page_size: QIANCHUAN_LIBRARY_PAGE_SIZE,
          });
          if (run.cancelled) return await cancelledResult();
          const pageItems = (Array.isArray(result?.items) ? result.items : []).map(sanitizedVideoCandidate);
          scannedCount += pageItems.length;
          totalPages = Math.max(totalPages, Number(result?.page_info?.total_page || page));
          totalNumber = Math.max(totalNumber, Number(result?.page_info?.total_number || 0));
          for (const item of pageItems) {
            if (!item.material_id || seen.has(item.material_id)) continue;
            const createdDate = materialCreatedDate(item.created_at);
            if (query.material_mode === "created_range"
              && (!createdDate || createdDate < query.material_start_date || createdDate > query.material_end_date)) continue;
            seen.add(item.material_id);
            candidates.push(item);
            if (candidates.length >= query.material_limit) break;
          }
          const pageDates = pageItems.map((item) => materialCreatedDate(item.created_at)).filter(Boolean);
          const pageIsBeforeRange = query.material_mode === "created_range"
            && pageDates.length > 0
            && pageDates.every((createdDate) => createdDate < query.material_start_date);
          hasMore = page < totalPages || (totalNumber > 0 && scannedCount < totalNumber);
          page += 1;
          await saveCheckpoint();
          emit({
            stage: "materials",
            page: page - 1,
            total_pages: totalPages,
            scanned_count: scannedCount,
            collected_count: candidates.length,
            message: `正在读取素材，第 ${page - 1}${totalPages ? `/${totalPages}` : ""} 页，已获取 ${candidates.length} 条`,
          });
          if (!hasMore || candidates.length >= query.material_limit || pageIsBeforeRange || pageItems.length === 0) break;
        }
        stage = "performance";
        await saveCheckpoint();
      }

      if (run.cancelled) return await cancelledResult();
      emit({ stage: "performance", scanned_count: scannedCount, collected_count: candidates.length, message: "正在读取所选周期的投放数据" });
      const report = await this.top({
        authorization_id: authorizationId,
        advertiser_id: advertiserId,
        start_date: query.report_start_date,
        end_date: query.report_end_date,
        limit: QIANCHUAN_LIBRARY_MAX_ITEMS,
      });
      if (run.cancelled) return await cancelledResult();
      const performanceById = new Map(
        (Array.isArray(report?.items) ? report.items : [])
          .map(sanitizedPerformanceItem)
          .map((item) => [item.material_id, item]),
      );
      const items = candidates.map((candidate) => {
        const performance = performanceById.get(candidate.material_id);
        return sanitizedPerformanceItem({
          ...emptyPerformanceForVideo(candidate),
          ...(performance || {}),
          advertiser_id: advertiserId,
          material_id: candidate.material_id,
          video_id: candidate.video_id,
          filename: candidate.filename || performance?.filename,
          material_type: performance?.material_type || candidate.source,
          created_at: candidate.created_at,
          poster_url: candidate.poster_url,
          duration_seconds: candidate.duration_seconds,
          width: candidate.width,
          height: candidate.height,
          download_available: candidate.download_available,
        });
      }).sort((left, right) => (right.spend - left.spend) || (right.video_plays - left.video_plays));
      const baseCompletedAt = new Date().toISOString();
      const previousComplete = previousEntry.complete && typeof previousEntry.complete === "object"
        ? previousEntry.complete
        : null;
      const canReuseInsights = Boolean(previousComplete
        && previousComplete.start_date === query.report_start_date
        && previousComplete.end_date === query.report_end_date);
      const materialIds = new Set(items.map((item) => item.material_id));
      const insightsByMaterial = {};
      if (canReuseInsights && previousComplete.insights_by_material && typeof previousComplete.insights_by_material === "object") {
        for (const [materialId, cachedInsight] of Object.entries(previousComplete.insights_by_material)) {
          const syncedAt = Date.parse(String(cachedInsight?.synced_at || ""));
          if (!materialIds.has(materialId) || !Number.isFinite(syncedAt) || Date.now() - syncedAt > QIANCHUAN_INSIGHT_CACHE_TTL_MS) continue;
          insightsByMaterial[materialId] = {
            insights: cachedInsight?.insights ?? null,
            synced_at: new Date(syncedAt).toISOString(),
          };
        }
      }
      const completeSnapshot = (syncedAt = baseCompletedAt) => ({
        query,
        start_date: query.report_start_date,
        end_date: query.report_end_date,
        items,
        synced_at: syncedAt,
        scanned_count: scannedCount,
        total_number: totalNumber,
        has_more: hasMore || (candidates.length >= query.material_limit && totalNumber > candidates.length),
        insights_by_material: { ...insightsByMaterial },
        insights_completed: Object.keys(insightsByMaterial).length,
        insights_total: items.length,
      });
      stage = "insights";
      await this.updateLibraryCacheStore(key, (entry) => ({
        ...entry,
        authorization_id: authorizationId,
        advertiser_id: advertiserId,
        complete: completeSnapshot(),
        checkpoint: null,
        updated_at: baseCompletedAt,
      }));
      emit({
        stage: "insights",
        scanned_count: scannedCount,
        collected_count: items.length,
        insights_completed: Object.keys(insightsByMaterial).length,
        insights_total: items.length,
        items,
        query,
        start_date: query.report_start_date,
        end_date: query.report_end_date,
        synced_at: baseCompletedAt,
        has_more: completeSnapshot().has_more,
        insights_by_material: { ...insightsByMaterial },
        message: `基础数据已完成，正在同步扩展分析 ${Object.keys(insightsByMaterial).length}/${items.length}`,
      });

      const pendingItems = items.filter((item) => !(item.material_id in insightsByMaterial));
      let pendingIndex = 0;
      let processedNew = 0;
      let failedInsights = 0;
      let completedSincePersist = 0;
      const persistInsights = async () => {
        const persistedAt = new Date().toISOString();
        const snapshot = completeSnapshot(persistedAt);
        await this.updateLibraryCacheStore(key, (entry) => ({
          ...entry,
          authorization_id: authorizationId,
          advertiser_id: advertiserId,
          complete: snapshot,
          updated_at: persistedAt,
        }));
      };
      const insightWorker = async () => {
        while (!run.cancelled) {
          const itemIndex = pendingIndex;
          pendingIndex += 1;
          if (itemIndex >= pendingItems.length) return;
          const item = pendingItems[itemIndex];
          let insight = null;
          let failed = false;
          try {
            const detail = await this.report({
              authorization_id: authorizationId,
              advertiser_id: advertiserId,
              material_id: item.material_id,
              start_date: query.report_start_date,
              end_date: query.report_end_date,
              include_insights: true,
            }, { persistInsight: false });
            insight = detail?.insights ?? null;
            insightsByMaterial[item.material_id] = { insights: insight, synced_at: new Date().toISOString() };
          } catch {
            failed = true;
            failedInsights += 1;
          }
          processedNew += 1;
          completedSincePersist += 1;
          if (completedSincePersist >= 5) {
            completedSincePersist = 0;
            await persistInsights();
          }
          const processed = Object.keys(insightsByMaterial).length + failedInsights;
          emit({
            stage: "insights",
            scanned_count: scannedCount,
            collected_count: items.length,
            insights_completed: processed,
            insights_total: items.length,
            insight_material_id: item.material_id,
            insight: failed ? undefined : insight,
            insight_synced_at: failed ? undefined : insightsByMaterial[item.material_id]?.synced_at,
            insight_failed: failed,
            message: `基础数据已完成，正在同步扩展分析 ${processed}/${items.length}${failedInsights ? `，${failedInsights} 条待重试` : ""}`,
          });
        }
      };
      await Promise.all(Array.from(
        { length: Math.min(QIANCHUAN_INSIGHT_SYNC_CONCURRENCY, pendingItems.length) },
        () => insightWorker(),
      ));
      if (run.cancelled) return await cancelledResult();
      if (processedNew || completedSincePersist) await persistInsights();
      const completedAt = new Date().toISOString();
      const complete = completeSnapshot(completedAt);
      await this.updateLibraryCacheStore(key, (entry) => ({
        ...entry,
        authorization_id: authorizationId,
        advertiser_id: advertiserId,
        complete,
        checkpoint: null,
        updated_at: completedAt,
      }));
      emit({
        stage: "complete",
        scanned_count: scannedCount,
        collected_count: items.length,
        insights_completed: Object.keys(insightsByMaterial).length + failedInsights,
        insights_total: items.length,
        insights_failed: failedInsights,
        message: failedInsights
          ? `同步完成，共缓存 ${items.length} 条素材；${failedInsights} 条扩展分析稍后可重试`
          : `同步完成，共缓存 ${items.length} 条素材和扩展分析`,
      });
      return { success: true, from_cache: false, insights_failed: failedInsights, ...complete };
    } finally {
      if (this.activeLibrarySync === run) this.activeLibrarySync = null;
    }
  }

  async importVideo(payload, outputDirectory) {
    const resolved = await this.resolve(payload, { includeDownloadUrl: true });
    const video = resolved?.video;
    if (!video?.download_available || !video?.download_url) {
      throw new Error(video?.download_reason || "当前素材只能读取千川数据，暂时不能下载原视频");
    }
    const remoteUrl = assertSafeDownloadUrl(video.download_url);
    await mkdir(outputDirectory, { recursive: true });
    const target = await availableTarget(outputDirectory, safeFilename(video.filename));
    const temporary = `${target}.${process.pid}.part`;
    let response;
    try {
      response = await this.fetchImpl(remoteUrl, {
        redirect: "follow",
        headers: qianchuanDownloadHeaders(),
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
      assertSafeDownloadUrl(response.url || remoteUrl.href);
      if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）`);
      const declaredSize = Number(response.headers.get("content-length") || 0);
      if (declaredSize > MAX_IMPORT_BYTES) throw new Error("千川视频超过 2GB，已取消导入");
      let received = 0;
      const meter = new TransformStream({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > MAX_IMPORT_BYTES) throw new Error("千川视频超过 2GB，已取消导入");
          controller.enqueue(chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body.pipeThrough(meter)), createWriteStream(temporary, { mode: 0o600 }));
      await rename(temporary, target);
      return { video, path: target };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error instanceof Error ? error : new Error("千川视频下载失败，请重试");
    }
  }
}

export const qianchuanInternals = Object.freeze({
  assertSafeAuthorizationUrl,
  assertSafeQianchuanOauthNavigation,
  assertSafeDownloadUrl,
  isQianchuanOauthCallback,
  normalizeQianchuanBrowserMode,
  qianchuanDownloadHeaders,
  normalizeQianchuanReportResponse,
  safeFilename,
});
