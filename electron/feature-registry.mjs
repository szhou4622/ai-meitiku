// Shared by the renderer and Electron main process. A feature owns its group once;
// every declared IPC/HTTP child operation inherits that group's entitlement.
const GROUPS = new Set(["free", "vip"]);

export function registerFreeFeature(definition) {
  return Object.freeze({ discoverableToBase: true, ...definition, group: "free" });
}

export function registerVipFeature(definition) {
  return Object.freeze({ discoverableToBase: true, ...definition, group: "vip" });
}

export const featureDefinitions = Object.freeze([
  registerFreeFeature({ id: "media", label: "媒体库", enabled: true, ipcPrefixes: ["media-"], ipcChannels: ["choose-directory", "open-local-path"], httpPrefixes: ["/__media/"] }),
  registerFreeFeature({ id: "qianchuan-videos", label: "千川视频库", enabled: true, ipcPrefixes: ["qianchuan-"], httpPrefixes: ["/__qianchuan_preview/"] }),
  registerVipFeature({
    id: "viral-visuals",
    label: "爆款画面库",
    enabled: true,
    description: "集中整理高表现图片与视频画面，保留分类、关联数据和素材来源。",
    highlights: ["按画面类型和大分类整理", "关联 CSV 与千川素材数据", "与本地媒体库素材保持关联"],
    ipcPrefixes: ["viral-library-"],
  }),
  registerVipFeature({
    id: "viral-copy",
    label: "爆款文案库",
    enabled: true,
    description: "独立沉淀高表现文案，并与画面、视频及分类信息建立对应关系。",
    highlights: ["独立录入和整理文案", "按分类与确认状态筛选", "关联本地画面和视频素材"],
    ipcPrefixes: ["viral-copy-"],
  }),
  registerFreeFeature({ id: "downloads", label: "视频下载", enabled: true, ipcPrefixes: ["video-download-"] }),
  registerFreeFeature({ id: "subtitle-removal", label: "阿里云去字幕", enabled: true, ipcPrefixes: ["aliyun-subtitle-"] }),
  registerFreeFeature({ id: "schemes", label: "分类方案", enabled: true, ipcChannels: [
    "classifier-bootstrap", "classifier-set-active", "classifier-create-template", "classifier-edit-template",
    "classifier-generate-template-draft", "classifier-import-product-info-files", "classifier-import-product-info-paths",
    "classifier-recognize-scanned-product-info", "classifier-import-template", "classifier-export-template",
  ] }),
  registerFreeFeature({ id: "classifier", label: "素材分类工作台", enabled: true, ipcPrefixes: ["classifier-"] }),
  registerFreeFeature({ id: "voice", label: "声音克隆", enabled: true, httpPrefixes: ["/api/voices", "/api/voice-clone/", "/outputs/voices/", "/uploads/voices/"] }),
  registerFreeFeature({ id: "settings", label: "设置", enabled: true, ipcPrefixes: ["api-settings-", "storage-management-"], ipcChannels: ["open-product-guide", "open-classifier-rules"] }),
]);

export function createFeatureRegistry(definitions) {
  const byId = new Map();
  const ipcExact = new Map();
  const ipcPrefixes = [];
  const httpPrefixes = [];
  for (const feature of definitions) {
    if (!feature || typeof feature.id !== "string" || !feature.id || !GROUPS.has(feature.group) || typeof feature.enabled !== "boolean" || byId.has(feature.id)) {
      throw new Error("功能注册缺失归属、启用状态或存在重复 ID");
    }
    byId.set(feature.id, feature);
    for (const channel of feature.ipcChannels || []) {
      if (typeof channel !== "string" || !channel) throw new Error(`IPC 入口配置无效：${feature.id}`);
      if (ipcExact.has(channel)) throw new Error(`IPC 入口重复注册：${channel}`);
      ipcExact.set(channel, feature.id);
    }
    for (const prefix of feature.ipcPrefixes || []) {
      if (typeof prefix !== "string" || !prefix) throw new Error(`IPC 入口前缀配置无效：${feature.id}`);
      ipcPrefixes.push([prefix, feature.id]);
    }
    for (const prefix of feature.httpPrefixes || []) {
      if (typeof prefix !== "string" || !prefix.startsWith("/")) throw new Error(`HTTP 入口前缀配置无效：${feature.id}`);
      httpPrefixes.push([prefix, feature.id]);
    }
  }
  const assertNoCrossGroupOverlap = (prefixes) => {
    for (let index = 0; index < prefixes.length; index += 1) {
      for (let other = index + 1; other < prefixes.length; other += 1) {
        const [left, leftId] = prefixes[index];
        const [right, rightId] = prefixes[other];
        if ((left.startsWith(right) || right.startsWith(left)) && byId.get(leftId).group !== byId.get(rightId).group) {
          throw new Error(`不同权限组的入口前缀冲突：${left} / ${right}`);
        }
      }
    }
  };
  assertNoCrossGroupOverlap(ipcPrefixes);
  assertNoCrossGroupOverlap(httpPrefixes);
  for (const [channel, exactId] of ipcExact) {
    for (const [prefix, prefixId] of ipcPrefixes) {
      if (channel.startsWith(prefix) && byId.get(exactId).group !== byId.get(prefixId).group) {
        throw new Error(`不同权限组的 IPC 入口冲突：${channel}`);
      }
    }
  }
  const resolvePrefix = (value, prefixes) => {
    const matches = prefixes.filter(([prefix]) => value.startsWith(prefix)).sort((a, b) => b[0].length - a[0].length);
    if (matches.length > 1 && matches[0][0].length === matches[1][0].length) throw new Error(`入口归属冲突：${value}`);
    return matches[0]?.[1] || null;
  };
  return Object.freeze({
    list: () => [...byId.values()],
    get: (id) => byId.get(id) || null,
    forIpc: (channel) => byId.get(ipcExact.get(channel) || resolvePrefix(channel, ipcPrefixes)) || null,
    forHttp: (pathname) => byId.get(resolvePrefix(pathname, httpPrefixes)) || null,
  });
}

export const featureRegistry = createFeatureRegistry(featureDefinitions);

function validFuture(value, nowMs) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) && time > nowMs;
}

export function resolveEntitlements(state, nowMs = Date.now()) {
  // Set only by the unpackaged Electron launcher. A source preview must be
  // usable without a customer activation record; packaged builds never
  // receive this flag.
  if (state?.previewAllFeatures === true) {
    return Object.freeze({ base: true, vip: true, baseExpiresAt: null, vipExpiresAt: null });
  }
  const license = state?.license;
  const activePhase = state?.phase === "active" || state?.phase === "offline_active";
  const baseExpiresAt = license?.entitlementSchemaVersion >= 1 ? license?.baseExpiresAt : license?.expiresAt;
  const basePermanent = license?.basePermanent === true && license?.entitlementSchemaVersion >= 1;
  const offlineValid = state?.phase !== "offline_active" || validFuture(state.offlineUntil, nowMs);
  const base = Boolean(state?.authorized && activePhase && offlineValid && (basePermanent || validFuture(baseExpiresAt, nowMs)));
  const vip = base
    && license?.entitlementSchemaVersion >= 1
    && validFuture(license.vipExpiresAt, nowMs);
  return Object.freeze({ base, vip: Boolean(vip), baseExpiresAt: baseExpiresAt || null, vipExpiresAt: license?.vipExpiresAt || null });
}

export function canAccessFeature(registry, featureId, state, nowMs = Date.now()) {
  const feature = registry.get(featureId);
  if (!feature || !feature.enabled) return false;
  const rights = resolveEntitlements(state, nowMs);
  return feature.group === "vip" ? rights.vip : rights.base;
}

export function canDiscoverFeature(registry, featureId, state, nowMs = Date.now()) {
  const feature = registry.get(featureId);
  if (!feature || !feature.enabled) return false;
  const rights = resolveEntitlements(state, nowMs);
  if (!rights.base) return false;
  return feature.group === "free" || rights.vip || feature.discoverableToBase === true;
}

export function requireFeatureAccess(registry, featureId, state, nowMs = Date.now()) {
  if (canAccessFeature(registry, featureId, state, nowMs)) return;
  const error = new Error(registry.get(featureId) ? "当前授权无权使用此功能" : "功能入口未注册");
  error.code = registry.get(featureId) ? "FEATURE_NOT_ENTITLED" : "FEATURE_UNREGISTERED";
  throw error;
}

export function nextEntitlementBoundary(state, nowMs = Date.now()) {
  const baseExpiresAt = state?.license?.entitlementSchemaVersion >= 1 ? state?.license?.baseExpiresAt : state?.license?.expiresAt;
  const values = [baseExpiresAt, state?.license?.vipExpiresAt, state?.offlineUntil]
    .map((value) => Date.parse(String(value || "")))
    .filter((value) => Number.isFinite(value) && value > nowMs);
  return values.length ? Math.min(...values) : null;
}
