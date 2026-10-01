"use client";

import { AliyunSubtitleAutoSync, AliyunSubtitleSettings, AliyunSubtitleWorkbench, type AliyunSubtitleBridge } from "./aliyun-subtitle";

import {
  AlertTriangle,
  ArrowLeft,
  ArrowDownUp,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Check,
  Copy,
  DatabaseBackup,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  Film,
  Folder,
  FolderOpen,
  Grid2X2,
  GripVertical,
  Globe2,
  HardDrive,
  Heart,
  Image as ImageIcon,
  Images,
  List,
  KeyRound,
  LockKeyhole,
  Mic2,
  MoreHorizontal,
  Music2,
  Pause,
  PackageOpen,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareCheck,
  Star,
  Tag,
  Trash2,
  Upload,
  Unlink,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { ChangeEvent, DragEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { licenseDisplayDetails } from "./license-display.mjs";
import { toggleMarqueeSelection } from "./media-selection.mjs";
import { canAccessFeature, canDiscoverFeature, featureRegistry, resolveEntitlements } from "../electron/feature-registry.mjs";
import { defaultViralDisplayColumns } from "./viral-display-columns.mjs";
import { matchViralVisualCsv } from "./viral-visual-csv.mjs";
import { matchesViralLibrarySearch } from "./viral-library-search.mjs";
import { classifyViralVisualLocally, localClipModel } from "./local-ai";
import {
  chooseLibraryDirectory,
  FileSystemDirectoryHandleLike,
  formatFileSize,
  getDirectoryPermission,
  loadLibraryDirectory,
  scanLibraryDirectory,
  stableLocalId,
  supportsLocalFolders,
  type LocalFileRecord,
} from "./local-media";

type AssetType = "image" | "video" | "audio";

type QianchuanBinding = {
  advertiserId: string;
  advertiserName: string;
  materialId: string;
  videoId?: string;
  awemeItemId?: string;
  source: "qianchuan" | "douyin";
  boundAt: string;
  lastSyncedAt?: string;
};

type QianchuanAccount = { advertiser_id: string; name: string; role: string };
type QianchuanBootstrap = {
  success: boolean;
  authorization_id: string;
  authorization_updated_at: string;
  accounts: QianchuanAccount[];
  default_advertiser_id: string;
};
type QianchuanIntegrationAuthorization = {
  authorization_id: string;
  account_id: string;
  account_name: string;
  material_authorized: boolean;
  updated_at: string;
};
type QianchuanIntegrationStatus = {
  success: boolean;
  configured: boolean;
  app_id: string;
  secret_configured: boolean;
  callback_url: string;
  callback_confirmed: boolean;
  tested: boolean;
  tested_at: string;
  authorized: boolean;
  material_authorized: boolean;
  authorizations: QianchuanIntegrationAuthorization[];
  message?: string;
};
type QianchuanOAuthPollState = {
  success: boolean;
  status: "pending" | "processing" | "success" | "failed" | "expired";
  authorization_id: string;
  message: string;
};
type QianchuanBrowserMode = "embedded" | "system";
type QianchuanVideo = {
  advertiser_id: string;
  material_id: string;
  video_id: string;
  aweme_item_id?: string;
  filename: string;
  created_at: string;
  duration_seconds: number;
  file_size_bytes: number;
  width: number;
  height: number;
  format: string;
  source: string;
  is_ai_created: boolean;
  poster_url: string;
  download_available: boolean;
  download_reason: string;
};
type QianchuanPerformance = {
  advertiser_id: string;
  material_id: string;
  video_id?: string;
  filename: string;
  material_type: string;
  created_at?: string;
  poster_url?: string;
  duration_seconds?: number;
  width?: number;
  height?: number;
  download_available?: boolean;
  spend: number;
  live_impressions: number;
  // Legacy server field names: these are overall clicks and click-through rate, not viewers or conversion rate.
  live_viewers: number;
  live_conversion_rate_percent: number;
  paid_orders: number;
  paid_gmv: number;
  paid_roi: number;
  video_plays: number;
  video_completion_rate_percent: number;
  video_likes: number;
  video_comments: number;
  video_average_watch_seconds: number;
  video_3s_play_rate_percent: number;
};
type QianchuanInsights = {
  available: boolean;
  metrics: Record<string, number | null>;
  material: {
    status?: string[];
    advice?: string[];
    created_at?: string[];
    uploaded_at?: string[];
    bid_type_codes?: string[];
    order_platform_codes?: string[];
  };
  daily_trend: Array<{ date: string; spend: number; paid_gmv: number; paid_roi: number; video_plays: number }>;
  unavailable_groups?: Array<number | string>;
};
type QianchuanInsightCacheEntry = {
  insights: QianchuanInsights | null;
  synced_at: string;
};
type QianchuanLibraryQuery = {
  material_mode: "recent" | "created_range";
  material_limit: 50 | 100 | 300 | 500;
  material_start_date: string;
  material_end_date: string;
  report_start_date: string;
  report_end_date: string;
};
type QianchuanLibraryCacheRecord = {
  query: QianchuanLibraryQuery;
  start_date: string;
  end_date: string;
  items: QianchuanPerformance[];
  synced_at: string;
  scanned_count: number;
  total_number: number;
  has_more: boolean;
  insights_by_material?: Record<string, QianchuanInsightCacheEntry>;
  insights_completed?: number;
  insights_total?: number;
};
type QianchuanLibraryCacheState = {
  success: boolean;
  cache: QianchuanLibraryCacheRecord | null;
  resumable: boolean;
  checkpoint: null | {
    query: QianchuanLibraryQuery;
    scanned_count: number;
    collected_count: number;
    stage: string;
  };
};
type QianchuanLibrarySyncProgress = {
  advertiser_id: string;
  stage: "materials" | "performance" | "insights" | "complete" | "cancelled";
  page?: number;
  total_pages?: number;
  scanned_count: number;
  collected_count: number;
  insights_completed?: number;
  insights_total?: number;
  insights_failed?: number;
  items?: QianchuanPerformance[];
  query?: QianchuanLibraryQuery;
  start_date?: string;
  end_date?: string;
  synced_at?: string;
  has_more?: boolean;
  insights_by_material?: Record<string, QianchuanInsightCacheEntry>;
  insight_material_id?: string;
  insight?: QianchuanInsights | null;
  insight_synced_at?: string;
  insight_failed?: boolean;
  message: string;
};

type ViralCopySegment = {
  id: string;
  text: string;
  start: number | null;
  end: number | null;
  category: string;
  classifications?: Array<{ field: string; value: string }>;
  data_fields?: Array<{ name: string; value: string }>;
  confirmed: boolean;
  visual_asset_id?: number | null;
};
type ViralCopyTarget = { key: string; index: number; segmentId: string; updatedAt: string };
type ViralCopyRecord = {
  key: string;
  advertiser_id: string;
  material_id: string;
  asset_id?: number | null;
  association_id?: string;
  title?: string;
  major_category?: string;
  segments: ViralCopySegment[];
  source: string;
  updated_at: string;
  created_at?: string;
};
type ViralCsvColumns = { associationId: number; media: number; copy: number; category: number[]; data: number[]; majorCategory: number; title: number };
type ViralCsvRow = { rowNumber: number; associationId: string; mediaPath: string; copy: string; category: string; majorCategory: string; classifications: Array<{ field: string; value: string }>; dataFields: Array<{ name: string; value: string }>; title: string };
type ViralCsvImportResult = { cancelled: boolean; fileName?: string; rows: ViralCsvRow[]; warnings: string[]; mappingRequired?: false };
type ViralCsvInspection = {
  cancelled: false;
  mappingRequired: true;
  token: string;
  fileName: string;
  headers: string[];
  columns: ViralCsvColumns;
  previewRows: string[][];
  rowCount: number;
};
type ViralDataCsvInspection = { cancelled: false; token: string; fileName: string; headers: string[]; rowCount: number; matchColumn: number; copyColumn: number; visualTypeColumn: number; displayColumns: number[]; previewRows: string[][] };
type ViralDataCsvResult = { cancelled: false; fileName: string; headers: string[]; rows: Array<{ rowNumber: number; matchValue: string; fields: Array<{ name: string; value: string }>; copyText: string; visualTypes: string[] }> };
const viralCsvMappingFields: Array<{ key: Exclude<keyof ViralCsvColumns, "category" | "data">; label: string; hint: string }> = [
  { key: "media", label: "画面路径", hint: "图片或视频的本地文件路径" },
  { key: "copy", label: "文案", hint: "口播、脚本或字幕内容" },
  { key: "associationId", label: "关联 ID", hint: "用于将画面和文案配对" },
  { key: "title", label: "标题", hint: "画面或文案的显示名称" },
  { key: "majorCategory", label: "大分类（画面／文案分组）", hint: "可选；用于页面分组，不要选择 3.x 等细分类列" },
];

function desktopErrorMessage(failure: unknown, fallback: string) {
  const message = failure instanceof Error ? failure.message : fallback;
  return message.replace(/^Error invoking remote method '[^']+': Error:\s*/i, "").trim() || fallback;
}

const QIANCHUAN_PROJECT_COLLECTION = "千川素材";
const LEGACY_QIANCHUAN_PROJECT_COLLECTION = "千川导入";
const VIRAL_FRAME_COLLECTION = "爆款画面";
const DEFAULT_VIRAL_VISUAL_TYPES = ["痛点展示", "使用演示", "效果对比", "产品特写", "场景应用", "价格促单钩子", "证言共鸣", "人工标注"] as const;
const defaultProjectCollections = ["视频下载", "素材分类", QIANCHUAN_PROJECT_COLLECTION, VIRAL_FRAME_COLLECTION];
const legacyDemoCollections = new Set(["示例项目", "灵感收藏", "AI 实验室"]);

function normalizeAssetCollection(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim() === LEGACY_QIANCHUAN_PROJECT_COLLECTION ? QIANCHUAN_PROJECT_COLLECTION : value.trim();
}

function normalizeProjectCollections(value: unknown) {
  const savedCollections = Array.isArray(value)
    ? value.map(normalizeAssetCollection).filter((item): item is string => Boolean(item))
    : [];
  const customCollections = savedCollections.filter((item) => !defaultProjectCollections.includes(item) && !legacyDemoCollections.has(item));
  return [...defaultProjectCollections, ...new Set(customCollections)];
}

function normalizeCollectionAliases(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, string>;
  return Object.fromEntries(Object.entries(value)
    .flatMap(([key, label]) => typeof label === "string" && key.trim() && label.trim()
      ? [[key.trim(), label.trim().slice(0, 100)] as const]
      : []));
}

function normalizeHiddenCollections(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return [...new Set(value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []))];
}

type Asset = {
  id: number;
  name: string;
  type: AssetType;
  size: string;
  src: string;
  duration?: string;
  tags: string[];
  /** Business-facing visual categories from CSV or the built-in recognizer. */
  visualTypes?: string[];
  favorite?: boolean;
  collection?: string;
  majorCategory?: string;
  description?: string;
  broken?: boolean;
  deleted?: boolean;
  sourceKind?: "demo" | "folder" | "file";
  localPath?: string;
  modifiedAt?: number;
  available?: boolean;
  sourceRoot?: string;
  qianchuan?: QianchuanBinding;
  csvData?: { sourceFile: string; importedAt: string; rowNumber: number; fields: Array<{ name: string; value: string }> };
};

const LEGACY_NON_VISUAL_TAGS = new Set([
  "精选", "已发布", "待处理", "AI 生成", "参考图", "口播", "产品", "特写", "氛围", "蓝莓酒", "工艺", "音频", "仓储",
  VIRAL_FRAME_COLLECTION, QIANCHUAN_PROJECT_COLLECTION, LEGACY_QIANCHUAN_PROJECT_COLLECTION,
]);

function normalizeViralVisualTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim().slice(0, 100)] : []))].slice(0, 24);
}

function viralVisualTypesForAsset(asset: Asset): string[] {
  if (Array.isArray(asset.visualTypes)) return normalizeViralVisualTypes(asset.visualTypes);
  // Older library indexes stored the visual category only in the generic tags
  // array. Recover those values without turning status/collection tags into
  // filter options; all newly written assets use visualTypes explicitly.
  return normalizeViralVisualTypes(asset.tags.filter((tag) => !LEGACY_NON_VISUAL_TAGS.has(tag)));
}

const MEDIA_ASSET_PAGE_SIZE = 48;

function DeferredAssetPreview({ asset }: { asset: Asset }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [shouldLoad, setShouldLoad] = useState(false);

  useEffect(() => {
    if (!asset.src || shouldLoad) return;
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setShouldLoad(true);
      observer.disconnect();
    }, { rootMargin: "240px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [asset.src, shouldLoad]);

  return (
    <div className="deferred-asset-preview" ref={containerRef}>
      {asset.type === "image" && shouldLoad && <img src={asset.src} alt="" loading="lazy" decoding="async" />}
      {asset.type === "video" && (
        <video
          src={shouldLoad ? asset.src : undefined}
          data-media-src={asset.src}
          muted
          loop
          playsInline
          preload={shouldLoad ? "metadata" : "none"}
          data-hover-preview
        />
      )}
    </div>
  );
}

const seedAssets: Asset[] = [
  {
    id: 1,
    name: "douyin_如果你也受够了内耗",
    type: "video",
    size: "7.0 MB",
    duration: "00:18",
    src: "https://images.unsplash.com/photo-1547595628-c61a29f496f0?auto=format&fit=crop&w=760&q=82",
    tags: ["精选", "口播"],
  },
  {
    id: 2,
    name: "douyin_蓝板骨依旧很蓝",
    type: "video",
    size: "2.2 MB",
    duration: "00:12",
    src: "https://images.unsplash.com/photo-1518791841217-8f162f1e1131?auto=format&fit=crop&w=760&q=82",
    tags: ["参考图"],
    favorite: true,
  },
  {
    id: 3,
    name: "蓝莓干酒_分镜003_原料筛选",
    type: "video",
    size: "2.3 MB",
    duration: "00:08",
    src: "https://images.unsplash.com/photo-1425934398893-310a009a77f9?auto=format&fit=crop&w=760&q=82",
    tags: ["已发布", "蓝莓酒"],
  },
  {
    id: 4,
    name: "蓝莓干酒_分镜008_灌装线",
    type: "video",
    size: "1.4 MB",
    duration: "00:06",
    src: "https://images.unsplash.com/photo-1566995541428-f2246c17cda1?auto=format&fit=crop&w=760&q=82",
    tags: ["AI 生成"],
  },
  {
    id: 5,
    name: "蓝莓干酒_分镜006_成品展示",
    type: "image",
    size: "738.2 KB",
    src: "https://images.unsplash.com/photo-1506377247377-2a5b3b417ebb?auto=format&fit=crop&w=760&q=82",
    tags: ["精选", "产品"],
  },
  {
    id: 6,
    name: "蓝莓原料_近景_清洗",
    type: "video",
    size: "1.2 MB",
    duration: "00:11",
    src: "https://images.unsplash.com/photo-1490474418585-ba9bad8fd0ea?auto=format&fit=crop&w=760&q=82",
    tags: ["待处理"],
  },
  {
    id: 7,
    name: "生产车间_质检员_蓝色工服",
    type: "video",
    size: "1.1 MB",
    duration: "00:09",
    src: "https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?auto=format&fit=crop&w=760&q=82",
    tags: ["已发布", "人物"],
  },
  {
    id: 8,
    name: "产品陈列_瓶身标签特写",
    type: "image",
    size: "1.0 MB",
    src: "https://images.unsplash.com/photo-1510812431401-41d2bd2722f3?auto=format&fit=crop&w=760&q=82",
    tags: ["产品", "特写"],
    broken: true,
  },
  {
    id: 9,
    name: "蓝莓酒_倒酒慢镜头_004",
    type: "video",
    size: "914.5 KB",
    duration: "00:07",
    src: "https://images.unsplash.com/photo-1566452348683-79a7b90f284f?auto=format&fit=crop&w=760&q=82",
    tags: ["精选", "氛围"],
    favorite: true,
  },
  {
    id: 10,
    name: "发酵工艺_搅拌罐_过程记录",
    type: "video",
    size: "2.0 MB",
    duration: "00:14",
    src: "https://images.unsplash.com/photo-1516594915697-87eb3b1c14ea?auto=format&fit=crop&w=760&q=82",
    tags: ["蓝莓酒", "工艺"],
  },
  {
    id: 11,
    name: "礼盒套装_桌面俯拍_秋季",
    type: "image",
    size: "846.7 KB",
    src: "https://images.unsplash.com/photo-1527156231393-7023794f363c?auto=format&fit=crop&w=760&q=82",
    tags: ["产品", "参考图"],
  },
  {
    id: 12,
    name: "蓝莓果园_晨光_采摘",
    type: "image",
    size: "1.6 MB",
    src: "https://images.unsplash.com/photo-1595231776515-ddffb1f4eb73?auto=format&fit=crop&w=760&q=82",
    tags: ["已发布", "产地"],
  },
  {
    id: 13,
    name: "包装线_瓶盖检测_012",
    type: "video",
    size: "2.8 MB",
    duration: "00:16",
    src: "https://images.unsplash.com/photo-1581092335397-9583eb92d232?auto=format&fit=crop&w=760&q=82",
    tags: ["工艺", "AI 生成"],
    broken: true,
  },
  {
    id: 14,
    name: "品牌音乐_轻奢氛围_30s",
    type: "audio",
    size: "3.4 MB",
    duration: "00:30",
    src: "https://images.unsplash.com/photo-1511379938547-c1f69419868d?auto=format&fit=crop&w=760&q=82",
    tags: ["音频", "精选"],
  },
  {
    id: 15,
    name: "成品仓库_整齐陈列_横版",
    type: "image",
    size: "980.4 KB",
    src: "https://images.unsplash.com/photo-1553413077-190dd305871c?auto=format&fit=crop&w=760&q=82",
    tags: ["仓储"],
  },
];

seedAssets.forEach((asset) => { asset.sourceKind = "demo"; });

type LocalStatus = "checking" | "idle" | "permission" | "scanning" | "connected" | "unsupported" | "error";

const defaultTagColors: Record<string, string> = {
  精选: "#f6cf55",
  已发布: "#69d19b",
  待处理: "#ff7979",
  "AI 生成": "#bb7cf6",
  参考图: "#70d4e8",
};

type SortBy = "recent" | "name" | "size";
type InputDialog = "tag" | "collection" | null;
type DesktopMediaRecord = {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: number;
  type: AssetType;
  url: string;
  sourceRoot?: string;
};

function desktopRecordAsset(record: DesktopMediaRecord, sourceKind: "file" | "folder", collection?: string, previous?: Asset): Asset {
  return {
    id: previous?.id ?? stableLocalId(`${record.path}:${record.sizeBytes}:${record.modifiedAt}`),
    name: record.name.replace(/\.[^.]+$/, ""),
    type: record.type,
    size: formatFileSize(record.sizeBytes),
    src: record.url,
    duration: record.type === "image" ? undefined : "--:--",
    tags: previous?.tags ?? ["待处理"],
    visualTypes: previous?.visualTypes,
    favorite: previous?.favorite,
    collection: collection ?? normalizeAssetCollection(previous?.collection),
    majorCategory: previous?.majorCategory,
    description: previous?.description ?? `本地素材 · ${record.path}`,
    qianchuan: previous?.qianchuan,
    csvData: previous?.csvData,
    broken: false,
    deleted: previous?.deleted,
    sourceKind,
    sourceRoot: record.sourceRoot ?? previous?.sourceRoot,
    localPath: record.path,
    modifiedAt: record.modifiedAt,
    available: true,
  };
}

type ClassifierPreviewMetadata = {
  title: string;
  fileName: string;
  sourceName: string;
  tags: string[];
  segmentIndex: number | null;
  startMs: number | null;
  endMs: number | null;
  timeRange: string;
};

type ClassifierPreviewMediaRecord = DesktopMediaRecord & {
  preview: ClassifierPreviewMetadata;
};

type ClassifierPreviewItem = {
  id: string;
  title: string;
  sourceName: string;
  path: string;
  kind: "tag" | "segment";
  status: "processing" | "completed" | "failed";
  tags: string[];
  timeRange: string;
  media?: ClassifierPreviewMediaRecord;
  message?: string;
};

type LocalFolderSource = {
  path: string;
  name: string;
  available?: boolean;
  parentPath?: string;
  indexMode?: "scan" | "exact";
};

type FolderRelinkPlan = {
  oldRoot: string;
  newRoot: string;
  folders: LocalFolderSource[];
  assets: Array<Asset & { sizeBytes?: number }>;
  newRecords: DesktopMediaRecord[];
  pathMappings: Array<{ from: string; to: string }>;
  stats: {
    folders: number;
    newFolders: number;
    reconnectedAssets: number;
    missingAssets: number;
    newAssets: number;
  };
};

type FolderDeleteMode = "delete-local" | "remove-folder" | "clear-assets";

function folderTreePaths(folders: LocalFolderSource[], rootPath: string) {
  const paths = new Set([rootPath]);
  const pending = [rootPath];
  while (pending.length) {
    const parentPath = pending.shift();
    for (const folder of folders) {
      if (folder.parentPath === parentPath && !paths.has(folder.path)) {
        paths.add(folder.path);
        pending.push(folder.path);
      }
    }
  }
  return paths;
}

type VideoDownloadStatus = "queued" | "parsing" | "running" | "completed" | "failed" | "cancelled";

type VideoDownloadTask = {
  id: string;
  platform: "douyin" | "xiaohongshu";
  url: string;
  title: string;
  status: VideoDownloadStatus;
  progress: number;
  message: string;
  error: string;
  quality: string;
  outputDirectory: string;
  outputFiles: string[];
  autoImport: boolean;
  exportTable: boolean;
  exportError: string;
  importedAt: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  completedAt: string;
};

type VideoDownloadState = {
  ready: boolean;
  paused: boolean;
  defaultOutputDirectory: string;
  tasks: VideoDownloadTask[];
};

type VideoDownloadAuthPlatformState = {
  platform: "douyin" | "xiaohongshu";
  label: string;
  loggedIn: boolean;
  status: "logged-in" | "not-logged-in";
  cookieCount: number;
  message: string;
  checkedAt: string;
};

type VideoDownloadAuthState = {
  douyin: VideoDownloadAuthPlatformState;
  xiaohongshu: VideoDownloadAuthPlatformState;
};

const initialVideoDownloadAuthState: VideoDownloadAuthState = {
  douyin: { platform: "douyin", label: "抖音", loggedIn: false, status: "not-logged-in", cookieCount: 0, message: "未登录", checkedAt: "" },
  xiaohongshu: { platform: "xiaohongshu", label: "小红书", loggedIn: false, status: "not-logged-in", cookieCount: 0, message: "未登录", checkedAt: "" },
};

type LicensePhase = "checking" | "needs_activation" | "renewal_required" | "active" | "offline_active" | "expired" | "update_required" | "disabled" | "unbound" | "invalid" | "credential_missing" | "network_error" | "configuration_error";

type PublicLicense = {
  bindingStatus: string;
  licenseType: string;
  durationDays: number;
  activatedAt: string | null;
  expiresAt: string | null;
  baseExpiresAt?: string | null;
  vipExpiresAt?: string | null;
  basePermanent?: boolean;
  entitlementSchemaVersion?: number;
  redemptionProtocolVersion?: number;
  remainingDays: number;
  transferCount: number;
};

type LicenseState = {
  appName: string;
  softwareName: string;
  protocolVersion: number;
  canUnbind: boolean;
  hasActivationCode: boolean;
  action?: string;
  phase: LicensePhase;
  authorized: boolean;
  message: string;
  machineIdentityMessage?: string;
  identityRepairPending?: boolean;
  previewAllFeatures?: boolean;
  offlineRemainingDays?: number;
  offlineUntil?: string;
  lastValidatedAt?: string;
  license: PublicLicense | null;
  redemption?: {
    codeKind: "base" | "vip";
    durationDays: number | null;
    idempotent: boolean;
  } | null;
};

type MachineIdentityDiagnostic = {
  maskedMachineCode: string;
  sourceType: string;
  compatibilityMode: boolean;
  hardwareMatch: "match" | "mismatch" | "unknown";
  message: string;
};

type LicenseDiagnosticEntry = {
  id: number;
  timestamp: string;
  level: "info" | "success" | "warning" | "error";
  stage: string;
  message: string;
  details: Record<string, string | number | boolean | null | string[]>;
};

type LicenseDiagnosticSnapshot = {
  entries: LicenseDiagnosticEntry[];
  generatedAt: string;
  maxEntries: number;
};

type UpdatePhase = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "installing" | "error";

type UpdateState = {
  phase: UpdatePhase;
  currentVersion: string;
  targetVersion: string;
  forceUpdate: boolean;
  releaseNotes: string;
  fileSize: number;
  downloadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  message: string;
  checkedAt: string;
  publishedAt: string;
  updateType: "none" | "normal" | "important";
  shouldPrompt: boolean;
  canRetry: boolean;
  installOnQuit: boolean;
  platform: string;
};

const initialUpdateState: UpdateState = {
  phase: "idle",
  currentVersion: "0.1.0",
  targetVersion: "",
  forceUpdate: false,
  releaseNotes: "",
  fileSize: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  bytesPerSecond: 0,
  message: "尚未检查更新",
  checkedAt: "",
  publishedAt: "",
  updateType: "none",
  shouldPrompt: false,
  canRetry: false,
  installOnQuit: false,
  platform: "",
};

type ProductInfoScanCandidate = {
  name: string;
  path: string;
  extension: ".pdf";
  size: number;
  reason: string;
  sourceId?: string;
  pages?: number[];
  totalPages?: number;
};

type ProductInfoDocument = { name: string; text: string; sourceId: string };
type ClassifierDraftQuality = { passed: boolean; issues: Array<{ code: string; severity: "warning" | "error"; message: string }>; checkedAt: string };

declare global {
  interface Window {
    desktopBridge?: {
      aliyunSubtitle: AliyunSubtitleBridge;
      licenseBootstrap: () => Promise<LicenseState>;
      licenseDiagnosticLog: () => Promise<LicenseDiagnosticSnapshot>;
      licenseCopyDiagnosticLog: () => Promise<{ ok: boolean }>;
      licenseClearDiagnosticLog: () => Promise<LicenseDiagnosticSnapshot>;
      licenseOnDiagnosticLogChanged: (callback: (snapshot: LicenseDiagnosticSnapshot) => void) => void;
      licenseMachineCode: () => Promise<string>;
      licenseMachineIdentity: () => Promise<MachineIdentityDiagnostic>;
      licenseCopyIdentityDiagnostics: () => Promise<{ ok: boolean; reason?: string }>;
      licenseCopyMachineCode: () => Promise<{ ok: boolean }>;
      licenseRevealActivationCode: () => Promise<string>;
      licenseCopyActivationCode: () => Promise<{ ok: boolean }>;
      licenseSaveActivationCode: (activationCode: string) => Promise<LicenseState>;
      licenseRepairIdentity: (activationCode: string) => Promise<LicenseState>;
      licenseActivate: (activationCode: string) => Promise<LicenseState>;
      licenseRenewTime: (activationCode: string) => Promise<LicenseState>;
      licenseRedeemTime: (activationCode: string) => Promise<LicenseState>;
      licenseRefresh: (options?: { resetOfflineCache?: boolean }) => Promise<LicenseState>;
      licenseUnbind: () => Promise<LicenseState>;
      licenseOnStateChanged: (callback: (state: LicenseState) => void) => void;
      updateBootstrap: () => Promise<UpdateState | null>;
      updateCheck: () => Promise<UpdateState>;
      updateDownload: () => Promise<UpdateState>;
      updateCancelDownload: () => Promise<UpdateState>;
      updateRemindLater: () => Promise<UpdateState>;
      updateInstallNow: () => Promise<UpdateState>;
      updateInstallOnQuit: () => Promise<UpdateState>;
      updateExit: () => Promise<{ ok: boolean }>;
      updateOnStateChanged: (callback: (state: UpdateState) => void) => void;
      chooseDirectory: () => Promise<string | null>;
      mediaChooseFiles: (options?: { visualOnly?: boolean }) => Promise<DesktopMediaRecord[]>;
      mediaChooseFolder: () => Promise<{ folder: LocalFolderSource; records: DesktopMediaRecord[] } | null>;
      mediaRelinkFolder: (oldRoot: string, folders: LocalFolderSource[], assets: Asset[]) => Promise<FolderRelinkPlan | null>;
      mediaPathForFile: (file: File) => string;
      mediaImportPaths: (paths: string[]) => Promise<{ records: DesktopMediaRecord[]; folders: LocalFolderSource[]; sourceKind: "file" | "folder" }>;
      mediaImportClassifierOutput: (outputRoot: string, outputFiles: string[]) => Promise<{ records: DesktopMediaRecord[]; folders: LocalFolderSource[]; sourceKind: "file" | "folder" }>;
      mediaImportClassifierSegments: (segmentDirectory: string) => Promise<{ records: DesktopMediaRecord[]; folders: LocalFolderSource[]; sourceKind: "file" | "folder" }>;
      mediaStartDrag: (paths: string[]) => void;
      mediaScanFolder: (folderPath: string) => Promise<DesktopMediaRecord[]>;
      mediaLoadLibrary: () => Promise<{ exists: boolean; assets: Array<Asset & { sizeBytes?: number }>; folders?: LocalFolderSource[] }>;
      mediaSaveLibrary: (assets: Asset[], folders: LocalFolderSource[]) => Promise<{ ok: boolean }>;
      mediaRevealFile: (targetPath: string) => Promise<{ ok: boolean }>;
      mediaTrashFolder: (folderPath: string) => Promise<{ ok: boolean; path: string }>;
      qianchuanBootstrap: () => Promise<QianchuanBootstrap>;
      qianchuanConfigStatus: () => Promise<QianchuanIntegrationStatus>;
      qianchuanConfigSave: (payload: { app_id: string; app_secret: string }) => Promise<QianchuanIntegrationStatus>;
      qianchuanConfigConfirmCallback: () => Promise<QianchuanIntegrationStatus>;
      qianchuanConfigTest: () => Promise<QianchuanIntegrationStatus>;
      qianchuanOpenDeveloperPortal: (browserMode?: QianchuanBrowserMode) => Promise<{ ok: boolean; browser_mode?: QianchuanBrowserMode }>;
      qianchuanOAuthStart: (browserMode?: QianchuanBrowserMode) => Promise<{ success: boolean; flow_id: string; expires_in: number; opened: boolean; browser_mode?: QianchuanBrowserMode }>;
      qianchuanOAuthReopen: (flowId: string, browserMode?: QianchuanBrowserMode) => Promise<{ ok: boolean; opened: boolean; browser_mode?: QianchuanBrowserMode }>;
      qianchuanOAuthPoll: (flowId: string) => Promise<QianchuanOAuthPollState>;
      qianchuanOAuthRevoke: (authorizationId: string) => Promise<{ success: boolean }>;
      qianchuanVideos: (payload: { authorization_id: string; advertiser_id: string; page: number; page_size: number }) => Promise<{ success: boolean; items: QianchuanVideo[]; page_info: { page?: number; total_page?: number; total_number?: number } }>;
      qianchuanResolve: (payload: { authorization_id: string; advertiser_id: string; reference: string }) => Promise<{ success: boolean; video: QianchuanVideo }>;
      qianchuanPreview: (payload: { authorization_id: string; advertiser_id: string; reference: string }) => Promise<{ success: boolean; video: QianchuanVideo; preview_url: string }>;
      qianchuanReport: (payload: { authorization_id: string; advertiser_id: string; material_id: string; start_date?: string; end_date?: string; include_insights?: boolean }) => Promise<{ success: boolean; found: boolean; start_date: string; end_date: string; data: QianchuanPerformance | null; insights?: QianchuanInsights }>;
      qianchuanTop: (payload: { authorization_id: string; advertiser_id: string; start_date?: string; end_date?: string; limit?: number }) => Promise<{ success: boolean; start_date: string; end_date: string; items: QianchuanPerformance[] }>;
      qianchuanLibraryCache: (payload: { authorization_id: string; advertiser_id: string }) => Promise<QianchuanLibraryCacheState>;
      qianchuanLibrarySync: (payload: { authorization_id: string; advertiser_id: string } & QianchuanLibraryQuery) => Promise<({ success: true; from_cache: boolean; insights_failed?: number } & QianchuanLibraryCacheRecord) | { success: false; cancelled: true; message: string }>;
      qianchuanLibraryCancel: () => Promise<{ success: boolean; cancelled: boolean }>;
      qianchuanLibraryOnProgress: (callback: (progress: QianchuanLibrarySyncProgress) => void) => () => void;
      qianchuanImport: (payload: { authorization_id: string; advertiser_id: string; reference: string }) => Promise<{ success: boolean; record: DesktopMediaRecord; video: QianchuanVideo; outputDirectory: string }>;
      viralCopyList: () => Promise<ViralCopyRecord[]>;
      viralCopyCapabilities: () => Promise<{ transcribeAvailable: boolean; message: string }>;
      viralCopySave: (payload: { assetId: number; majorCategory?: string; segments: ViralCopySegment[] }) => Promise<ViralCopyRecord>;
      viralCopyParse: (text: string) => Promise<ViralCopySegment[]>;
      viralCopyTranscribe: (assetId: number) => Promise<{ segments: ViralCopySegment[]; source: string }>;
      viralCopySaveReference: (payload: { assetId?: number; mediaUrl?: string; referenceId?: string; title: string; associationId?: string; source?: string; majorCategory?: string; segments: ViralCopySegment[] }) => Promise<ViralCopyRecord>;
      viralCopyDeleteSegments: (targets: ViralCopyTarget[]) => Promise<{ deletedCount: number; records: ViralCopyRecord[] }>;
      viralCopySetConfirmed: (targets: ViralCopyTarget[], confirmed: boolean) => Promise<{ updatedCount: number; records: ViralCopyRecord[] }>;
      viralCopyUpdateText: (target: ViralCopyTarget, text: string) => Promise<ViralCopyRecord>;
      viralCopyLinkVisual: (target: ViralCopyTarget, assetId: number | null) => Promise<ViralCopyRecord>;
      viralCopyTranscribeMedia: (payload: { assetId: number; mediaUrl: string; title: string; associationId?: string; majorCategory?: string }) => Promise<{ segments: ViralCopySegment[]; source: string; record: ViralCopyRecord }>;
      viralLibraryImportCsv: (payload?: { token: string; columns: ViralCsvColumns }) => Promise<ViralCsvImportResult | ViralCsvInspection | { cancelled: true; rows: []; warnings: [] }>;
      viralLibraryAuthorizeWrite: () => Promise<{ authorized: true }>;
      viralLibraryClassifyVisuals: (records: Array<{ path: string; type: "image" | "video" }>) => Promise<{ items: Array<{ path: string; visualType: string; confidence: number; reason: string }>; warning?: string }>;
      viralLibraryOnClassificationProgress: (callback: (progress: { completed: number; total: number; name: string }) => void) => () => void;
      viralLibraryDataCsv: (payload?: { path?: string; token?: string; matchColumn?: number; displayColumns?: number[]; copyColumn?: number; visualTypeColumn?: number }) => Promise<ViralDataCsvInspection | ViralDataCsvResult | { cancelled: true }>;
      classifierPreviewMedia: (paths: string[]) => Promise<ClassifierPreviewMediaRecord[]>;
      videoDownloadBootstrap: () => Promise<VideoDownloadState | null>;
      videoDownloadImportSpreadsheet: () => Promise<{ cancelled: boolean; fileName?: string; links: Array<{ url: string; platform: "douyin" | "xiaohongshu" }>; foundCount: number; importedCount: number; truncatedCount: number }>;
      videoDownloadEnqueue: (payload: { input: string; outputDirectory: string; autoImport: boolean; exportTable: boolean; quality: string }) => Promise<{ state: VideoDownloadState; added: VideoDownloadTask[] }>;
      videoDownloadRetry: (taskId: string) => Promise<VideoDownloadState>;
      videoDownloadCancel: (taskId: string) => Promise<VideoDownloadState>;
      videoDownloadPause: (paused: boolean) => Promise<VideoDownloadState>;
      videoDownloadClearCompleted: () => Promise<VideoDownloadState>;
      videoDownloadSetOutput: (directory: string) => Promise<VideoDownloadState>;
      videoDownloadMarkImported: (taskId: string) => Promise<VideoDownloadState>;
      videoDownloadAuthBootstrap: () => Promise<VideoDownloadAuthState | null>;
      videoDownloadAuthOpen: (platform: "douyin" | "xiaohongshu") => Promise<VideoDownloadAuthState>;
      videoDownloadAuthRefresh: () => Promise<VideoDownloadAuthState>;
      videoDownloadAuthOnStateChanged: (callback: (state: VideoDownloadAuthState) => void) => void;
      videoDownloadOnStateChanged: (callback: (state: VideoDownloadState) => void) => void;
      classifierPrepareInput: (paths: string[]) => Promise<{ folder: string; count: number; label: string; kind: "folder" | "files"; mediaCounts: ClassifierMediaCounts; methods: { linked: number; symbolic: number; copied: number }; sourceMappings: Array<{ inputPath: string; sourcePath: string }> }>;
      classifierValidateOutputDirectory: (outputRoot: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
      classifierBootstrap: () => Promise<ClassifierState>;
      classifierMarkOutputSynced: (jobId: string) => Promise<{ ok: boolean }>;
      classifierSetActive: (templateId: string) => Promise<ClassifierState>;
      classifierSaveConfig: (payload: { baseUrl: string; model: string; apiKey: string }) => Promise<{ ok: boolean }>;
      apiSettingsGet: () => Promise<ApiSettingsState>;
      apiSettingsSave: (payload: ApiSettingsSavePayload) => Promise<ApiSettingsState>;
      apiSettingsTest: (kind: "classification" | "minimax", payload: ApiSettingsSavePayload) => Promise<{ ok: boolean; message: string; latencyMs: number }>;
      storageManagementGet: () => Promise<StorageManagementState>;
      storageManagementSave: (settings: Partial<StorageManagementSettings>) => Promise<StorageManagementState>;
      storageManagementClear: (category: "classifier" | "updates" | "web") => Promise<{ result: StorageCleanupResult; state: StorageManagementState }>;
      classifierCreateTemplate: (payload: ClassifierTemplatePayload) => Promise<ClassifierState>;
      classifierEditTemplate: (payload: ClassifierTemplatePayload & { templateId: string }) => Promise<ClassifierState>;
      classifierGenerateTemplateDraft: (productBrief: string) => Promise<Omit<ClassifierTemplate, "template_id"> & { quality?: ClassifierDraftQuality; repairedCount?: number }>;
      classifierDraftOnProgress: (callback: (progress: { stage: string; current?: number; total?: number }) => void) => () => void;
      classifierImportProductInfoFiles: () => Promise<{ cancelled?: boolean; text: string; files: Array<{ name: string; extension: string; size: number; sourceId?: string }>; documents?: ProductInfoDocument[]; warnings: string[]; scanCandidates: ProductInfoScanCandidate[] }>;
      classifierImportProductInfoPaths: (filePaths: string[]) => Promise<{ cancelled?: boolean; text: string; files: Array<{ name: string; extension: string; size: number; sourceId?: string }>; documents?: ProductInfoDocument[]; warnings: string[]; scanCandidates: ProductInfoScanCandidate[] }>;
      classifierRecognizeScannedProductInfo: (files: ProductInfoScanCandidate[]) => Promise<{ text: string; files: Array<{ name: string; path: string; extension: string; size: number; sourceId?: string; recognitionId?: string; recognizedPages?: number[] }>; documents?: ProductInfoDocument[]; warnings: string[] }>;
      classifierImportTemplate: () => Promise<ClassifierState & { cancelled?: boolean; importedName?: string }>;
      classifierExportTemplate: (templateId: string) => Promise<{ ok: boolean; cancelled?: boolean; filePath?: string }>;
      classifierRun: (payload: ClassifierRunPayload) => Promise<{ ok: boolean; jobId?: string; error?: string; diagnostic?: string; result?: ClassifierRunResult | ClassifierSplitResult[]; logs?: string[]; outputFiles?: string[]; outputMappings?: Array<{ sourcePath: string; outputPath: string }>; consumedSourceFiles?: string[]; retryTaskCount?: number; retryPayload?: ClassifierRunPayload | null; networkSafe?: { enabled: boolean; reason?: string; total?: number; completed?: number; failed?: number; failedSourcePaths?: string[] } }>;
      classifierCancel: () => Promise<{ ok: boolean }>;
      classifierOnProgress: (callback: (progress: { jobId: string; command: ClassifierRunPayload["command"]; lines: string[] }) => void) => () => void;
      openLocalPath: (targetPath: string) => Promise<{ error?: string }>;
      openProductGuide: () => Promise<{ ok: boolean }>;
      openClassifierRules: () => Promise<{ error?: string }>;
    };
  }
}

type ClassifierTemplate = {
  template_id: string;
  name: string;
  product_name: string;
  taxonomy?: Record<string, string[]>;
  rules?: string;
  naming_rule?: string;
};

type ClassifierTemplatePayload = {
  name: string;
  productName: string;
  taxonomy: Record<string, string[]>;
  rules: string;
  namingRule: string;
};

type ClassifierNamingField = "product_name" | "subcategory" | "detail" | "form" | "shoot_date" | "sequence";
type ClassifierNamingPart =
  | { id: string; kind: "field"; field: ClassifierNamingField }
  | { id: string; kind: "literal"; value: string };

const defaultClassifierNamingRule = "产品名_二级分类_具体画面_景别或形态_素材拍摄日期_序号";
const classifierNamingFields: Array<{ field: ClassifierNamingField; label: string; token: string; example: string }> = [
  { field: "product_name", label: "产品名", token: "产品名", example: "产品名称" },
  { field: "subcategory", label: "二级分类", token: "二级分类", example: "取当前方案首个二级分类" },
  { field: "detail", label: "具体画面", token: "具体画面", example: "由素材识别生成" },
  { field: "form", label: "景别或形态", token: "景别或形态", example: "由素材识别生成" },
  { field: "shoot_date", label: "素材拍摄日期", token: "素材拍摄日期", example: "260823" },
  { field: "sequence", label: "序号", token: "序号", example: "01" },
];

const classifierNamingTokenAliases = new Map<string, ClassifierNamingField>([
  ["产品名", "product_name"], ["产品名称", "product_name"], ["品名", "product_name"],
  ["二级分类", "subcategory"], ["二级类目", "subcategory"],
  ["具体画面", "detail"], ["画面内容", "detail"], ["画面", "detail"],
  ["景别", "form"], ["景别或形态", "form"], ["形态", "form"],
  ["素材拍摄日期", "shoot_date"], ["拍摄日期", "shoot_date"], ["日期", "shoot_date"],
  ["序号", "sequence"], ["编号", "sequence"],
]);

function classifierNamingPartId(index: number, value: string) {
  return `naming-${index}-${value.replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")}`;
}

function parseClassifierNamingRule(rule: string | undefined, productName = ""): ClassifierNamingPart[] {
  const source = rule?.trim() || defaultClassifierNamingRule;
  const seenFields = new Set<ClassifierNamingField>();
  return source.split("_").map((rawToken) => rawToken.trim()).filter(Boolean).flatMap<ClassifierNamingPart>((token, index) => {
    const field = classifierNamingTokenAliases.get(token)
      ?? (productName.trim() && token === productName.trim() ? "product_name" : undefined);
    if (field && !seenFields.has(field)) {
      seenFields.add(field);
      return [{ id: classifierNamingPartId(index, field), kind: "field" as const, field }];
    }
    const value = token.replace(/[\\/:*?"<>|\r\n]+/g, "-").trim();
    return value ? [{ id: classifierNamingPartId(index, `literal-${value}`), kind: "literal" as const, value }] : [];
  });
}

function serializeClassifierNamingRule(parts: ClassifierNamingPart[]) {
  return parts.map((part) => part.kind === "field"
    ? classifierNamingFields.find((item) => item.field === part.field)?.token ?? ""
    : part.value.replace(/[\\/:*?"<>|_\r\n]+/g, "-").trim())
    .filter(Boolean)
    .join("_");
}

function firstClassifierSubcategoryFromText(taxonomyText: string) {
  for (const rawLine of taxonomyText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const separator = line.search(/[:：]/);
    if (separator <= 0) continue;
    const firstItem = line.slice(separator + 1).split(/[,，、]/).map((item) => item.trim()).find(Boolean);
    if (firstItem) return firstItem;
  }
  return "";
}

function classifierNamingFieldPreview(field: ClassifierNamingField, productName: string, taxonomyText: string) {
  if (field === "product_name") return productName.trim() || "产品名称";
  if (field === "subcategory") return firstClassifierSubcategoryFromText(taxonomyText) || "二级分类由素材识别生成";
  if (field === "detail") return "具体画面由素材识别生成";
  if (field === "form") return "景别由素材识别生成";
  return classifierNamingFields.find((item) => item.field === field)?.example ?? "";
}

function previewClassifierNamingRule(parts: ClassifierNamingPart[], productName: string, taxonomyText: string) {
  return parts.map((part) => {
    if (part.kind === "literal") return part.value.trim();
    return classifierNamingFieldPreview(part.field, productName, taxonomyText);
  }).filter(Boolean).join("_");
}

type ClassifierState = {
  settings: {
    vision_model?: { base_url?: string; model?: string };
  };
  activeTemplateId: string;
  templates: ClassifierTemplate[];
  recovery?: ClassifierRecovery | null;
  retryTaskCount?: number;
  retryPayload?: ClassifierRunPayload | null;
  recentOutput?: { jobId: string; outputRoot: string; outputFiles: string[] } | null;
  configHealth?: {
    recoveredTemplates: number;
    conflictCopies: number;
    recoveredFromBackup: number;
    invalidTemplateCount: number;
  };
};

type ApiSettingsState = {
  classification: {
    provider: "volcengine" | "relay";
    volcengine: {
      endpointId: string;
      apiKeyConfigured: boolean;
    };
    relay: {
      baseUrl: string;
      textModel: string;
      visionModel: string;
      apiKeyConfigured: boolean;
    };
  };
  minimax: {
    provider: "minimax";
    baseUrl: string;
    model: string;
    groupId: string;
    apiKeyConfigured: boolean;
  };
};

type ApiSettingsSavePayload = {
  classification: {
    provider: "volcengine" | "relay";
    volcengine: { endpointId: string; apiKey: string };
    relay: { baseUrl: string; textModel: string; visionModel: string; apiKey: string };
  };
  minimax: {
    model: string;
    groupId: string;
    apiKey: string;
  };
};

type StorageManagementSettings = {
  version: number;
  autoCleanupClassifierCache: boolean;
  classifierRetentionHours: number;
  lastAutomaticCleanupAt: string;
};

type StorageCategoryState = { bytes: number; path: string };

type StorageManagementState = {
  settings: StorageManagementSettings;
  categories: Record<"classifier" | "video" | "voice" | "updates" | "web" | "localModel" | "platformLogin", StorageCategoryState>;
  totalBytes: number;
  classifierCleanupBlockedReason: string;
  videoDirectory: string;
  videoDirectoryInsideAppData: boolean;
};

type StorageCleanupResult = {
  ok: boolean;
  blocked?: boolean;
  reclaimedBytes: number;
  message: string;
};

type ClassifierRunPayload = {
  command: "classify" | "review" | "split" | "correction-create" | "correction-apply" | "self-check";
  folder: string;
  output_root: string;
  mode?: string;
  workers?: number;
  frames?: number;
  split_precision?: "rough" | "fine";
  naming?: {
    preserveOriginalName: boolean;
    addSequence: boolean;
  };
  consume_generated_sources?: boolean;
  source_paths?: string[];
  consume_source_roots?: string[];
  consume_source_mappings?: Array<{ inputPath: string; sourcePath: string }>;
};

type ClassifierRecovery = {
  jobId: string;
  status: "running" | "interrupted";
  command: ClassifierRunPayload["command"];
  payload: ClassifierRunPayload;
  createdAt?: string;
  updatedAt?: string;
  logs?: string[];
};

type ClassifierRunResult = {
  count?: number;
  todo_count?: number;
  copied_count?: number;
  skipped_count?: number;
  failed_count?: number;
  pending_count?: number;
  failed?: string;
  classification_root?: string;
  output_files?: string[];
};

type ClassifierSplitResult = {
  source: string;
  output_dir: string;
  segment_count: number;
};

type ClassifierHandoff = {
  id: string;
  folder: string;
  label: string;
  count: number;
  kind: "folder" | "files";
  mediaCounts: ClassifierMediaCounts;
  paths?: string[];
};

type ClassifierMediaCounts = {
  image: number;
  video: number;
};

type ClassifierLogEntry = {
  id: string;
  time: string;
  splitStatus: string;
  taggingStatus: string;
  message: string;
};

function classifierLogTime() {
  return new Date().toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function createClassifierLog(message: string, splitStatus: string, taggingStatus: string): ClassifierLogEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    time: classifierLogTime(),
    splitStatus,
    taggingStatus,
    message,
  };
}

function classifierLogTone(entry: ClassifierLogEntry) {
  const status = `${entry.splitStatus} ${entry.taggingStatus}`;
  if (status.includes("失败") || status.includes("中断") || entry.message.includes("失败")) return "error";
  if (
    status.includes("完成")
    || /(?:检测到|已分割|处理完成|拆镜头完成|已同步|成功\s*\d+)/.test(entry.message)
  ) return "success";
  return "neutral";
}

type VoiceLibraryItem = {
  id: string;
  name: string;
  provider: string;
  sampleAudioUrl: string;
  previewText: string;
  previewAudioUrl: string;
  status: string;
  createdAt: string;
  errorMessage?: string;
  legacyNotice?: string;
  audios?: Array<{ id?: string; audioUrl: string; text?: string; createdAt?: string }>;
};

const voiceWorkbenchTabStorageKey = "voice-workbench-tab-v1";
const voiceSelectedIdStorageKey = "voice-library-selected-id-v1";

async function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("声音文件读取失败"));
    reader.readAsDataURL(file);
  });
}

async function readAudioDuration(file: File) {
  return new Promise<number>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const cleanup = () => URL.revokeObjectURL(url);
    audio.onloadedmetadata = () => { const duration = audio.duration; cleanup(); resolve(duration); };
    audio.onerror = () => { cleanup(); reject(new Error("无法读取声音时长")); };
    audio.src = url;
  });
}

async function voiceApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  const data: unknown = await response.json().catch(() => ({}));
  const errorData = data && typeof data === "object" ? data as { message?: unknown; error?: unknown } : {};
  if (!response.ok) throw new Error(String(errorData.message || errorData.error || "声音服务请求失败"));
  return data as T;
}

type ContactConfigResponse = {
  app_name: string;
  enabled: boolean;
  qr_image_url: string | null;
  updated_at: string | null;
  source?: "remote" | "cache" | "bundled";
  status?: "ready" | "disabled" | "missing_image" | "fallback";
  message?: string;
};

const CONTACT_FALLBACK_IMAGE_URL = "/favicon.svg";
const contactConfigRequests = new Map<string, Promise<ContactConfigResponse>>();

function validateLocalContactConfig(value: unknown, appName: string): ContactConfigResponse {
  if (!value || typeof value !== "object") throw new Error("联系配置格式不正确");
  const candidate = value as Partial<ContactConfigResponse>;
  if (candidate.app_name !== appName) throw new Error("联系配置与当前软件不匹配");
  if (typeof candidate.enabled !== "boolean") throw new Error("联系配置状态无效");
  const imageUrl = typeof candidate.qr_image_url === "string" ? candidate.qr_image_url.trim() : "";
  if (imageUrl) {
    const parsed = new URL(imageUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("联系方式图片地址不安全");
  }
  return {
    app_name: candidate.app_name,
    enabled: candidate.enabled,
    qr_image_url: imageUrl || null,
    updated_at: typeof candidate.updated_at === "string" ? candidate.updated_at : null,
    source: candidate.source,
    status: candidate.status,
    message: typeof candidate.message === "string" ? candidate.message : "",
  };
}

function requestContactConfig(appName: string) {
  const existing = contactConfigRequests.get(appName);
  if (existing) return existing;
  const request = fetch("/api/contact", {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
  })
    .then(async (response) => {
      if (!response.ok) throw new Error("联系配置服务暂不可用");
      return validateLocalContactConfig(await response.json(), appName);
    })
    .catch(() => ({
      app_name: appName,
      enabled: true,
      qr_image_url: null,
      updated_at: null,
      source: "bundled" as const,
      status: "fallback" as const,
      message: "暂时无法连接联系配置服务，已显示内置图片",
    }));
  contactConfigRequests.set(appName, request);
  return request;
}

function preloadContactImage(url: string) {
  return new Promise<void>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("contact_image_load_failed"));
    image.src = url;
  });
}

function ContactAuthorButton({ appName }: { appName: string }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [loading, setLoading] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(CONTACT_FALLBACK_IMAGE_URL);
  const [imageKind, setImageKind] = useState<"remote" | "fallback">("fallback");
  const [message, setMessage] = useState("首次打开时获取最新联系方式");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const requested = useRef(false);
  const active = useRef(true);
  const open = hovered || pinned;

  useEffect(() => () => { active.current = false; }, []);

  const loadContact = () => {
    if (requested.current) return;
    requested.current = true;
    setLoading(true);
    void requestContactConfig(appName).then(async (config) => {
      if (!config.enabled) {
        if (!active.current) return;
        setImageUrl(null);
        setMessage("联系方式暂未开放");
        setUpdatedAt(config.updated_at);
        return;
      }
      if (config.qr_image_url) {
        try {
          await preloadContactImage(config.qr_image_url);
          if (!active.current) return;
          setImageUrl(config.qr_image_url);
          setImageKind("remote");
          setMessage(config.message || "请使用手机查看联系方式");
          setUpdatedAt(config.updated_at);
          return;
        } catch {
          if (!active.current) return;
          setImageUrl(CONTACT_FALLBACK_IMAGE_URL);
          setImageKind("fallback");
          setMessage("联系方式图片加载失败，已显示内置图片");
          setUpdatedAt(config.updated_at);
          return;
        }
      }
      if (!active.current) return;
      if (config.status === "missing_image") {
        setImageUrl(null);
        setMessage("联系方式图片暂未配置");
      } else {
        setImageUrl(CONTACT_FALLBACK_IMAGE_URL);
        setImageKind("fallback");
        setMessage(config.message || "已显示内置联系方式图片");
      }
      setUpdatedAt(config.updated_at);
    }).finally(() => {
      if (active.current) setLoading(false);
    });
  };

  const reveal = () => {
    setHovered(true);
    loadContact();
  };

  return (
    <div
      className="contact-author"
      onMouseEnter={reveal}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={reveal}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setHovered(false);
          setPinned(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setHovered(false);
          setPinned(false);
          event.currentTarget.querySelector("button")?.focus();
        }
      }}
    >
      <button
        className="contact-author-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          loadContact();
          setPinned((value) => !value);
        }}
      >联系作者</button>
      {open && (
        <section className="contact-author-popover" role="dialog" aria-label="联系作者">
          <strong>联系作者</strong>
          <div className={`contact-author-image ${imageKind === "fallback" ? "fallback" : ""}`}>
            {imageUrl ? <img src={imageUrl} alt={imageKind === "remote" ? "联系作者联系方式" : "内置联系方式图片"} onError={() => { setImageUrl(CONTACT_FALLBACK_IMAGE_URL); setImageKind("fallback"); setMessage("联系方式图片加载失败，已显示内置图片"); }} /> : <CircleHelp size={34} />}
          </div>
          <p>{loading ? "正在获取最新联系方式…" : message}</p>
          {updatedAt && <small>更新时间：{formatServerDate(updatedAt)}</small>}
        </section>
      )}
    </div>
  );
}

function formatAudioTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "00:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function VoiceAudioPlayer({ src, compact = false }: { src: string; compact?: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      await audio.play().catch(() => undefined);
    } else {
      audio.pause();
    }
  };

  const toggleMute = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = !audio.muted;
    setMuted(audio.muted);
  };

  return (
    <div className={`voice-audio-player ${compact ? "compact" : ""}`} onClick={(event) => event.stopPropagation()}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
      />
      <button className="voice-player-play" type="button" onClick={togglePlayback} aria-label={playing ? "暂停" : "播放"}>{playing ? <Pause size={14} /> : <Play size={14} fill="currentColor" />}</button>
      <div className="voice-player-track">
        <span className="voice-waveform" aria-hidden="true">{Array.from({ length: compact ? 18 : 28 }, (_, index) => <i key={index} style={{ height: `${8 + ((index * 7) % 17)}px` }} />)}</span>
        <span className="voice-player-time"><b>{formatAudioTime(currentTime)}</b><b>{formatAudioTime(duration)}</b></span>
      </div>
      <button className="voice-player-tool" type="button" onClick={toggleMute} aria-label={muted ? "取消静音" : "静音"}>{muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
      <a className="voice-player-tool" href={src} download aria-label="下载音频"><Download size={14} /></a>
    </div>
  );
}

function VoiceCloneWorkbench({ notify, appName }: { notify: (message: string) => void; appName: string }) {
  const [tab, setTab] = useState<"upload" | "library">(() => {
    if (typeof window === "undefined") return "upload";
    return window.localStorage.getItem(voiceWorkbenchTabStorageKey) === "library" ? "library" : "upload";
  });
  const [voices, setVoices] = useState<VoiceLibraryItem[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [voiceName, setVoiceName] = useState("");
  const [sampleFile, setSampleFile] = useState<File | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resultAudioUrl, setResultAudioUrl] = useState("");
  const [resultVoiceName, setResultVoiceName] = useState("");
  const [serviceError, setServiceError] = useState("");

  const applyVoiceLibrary = (items: VoiceLibraryItem[], requestedId = "") => {
    setVoices(items);
    const storedId = typeof window === "undefined" ? "" : window.localStorage.getItem(voiceSelectedIdStorageKey) || "";
    const preferred = items.find((voice) => voice.id === requestedId)
      || items.find((voice) => voice.id === selectedVoiceId)
      || items.find((voice) => voice.id === storedId)
      || items[0]
      || null;
    if (!preferred) {
      setSelectedVoiceId("");
      setResultAudioUrl("");
      setResultVoiceName("");
      return;
    }
    const recentAudio = preferred.audios?.[preferred.audios.length - 1];
    setSelectedVoiceId(preferred.id);
    setResultVoiceName(preferred.name);
    setResultAudioUrl(recentAudio?.audioUrl || preferred.previewAudioUrl || "");
  };

  const loadVoices = async (silent = false, requestedId = "") => {
    try {
      const data = await voiceApi<{ voices: VoiceLibraryItem[] }>("/api/voices");
      applyVoiceLibrary(Array.isArray(data.voices) ? data.voices : [], requestedId);
      setServiceError("");
      if (!silent) notify("试听记录已刷新");
    } catch (error) {
      setServiceError(error instanceof Error ? error.message : "声音服务不可用");
    }
  };

  useEffect(() => {
    let cancelled = false;
    void voiceApi<{ voices: VoiceLibraryItem[] }>("/api/voices")
      .then((data) => {
        if (cancelled) return;
        applyVoiceLibrary(Array.isArray(data.voices) ? data.voices : []);
        setServiceError("");
      })
      .catch((error) => {
        if (!cancelled) setServiceError(error instanceof Error ? error.message : "声音服务不可用");
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(voiceWorkbenchTabStorageKey, tab);
  }, [tab]);

  useEffect(() => {
    if (selectedVoiceId) window.localStorage.setItem(voiceSelectedIdStorageKey, selectedVoiceId);
    else window.localStorage.removeItem(voiceSelectedIdStorageKey);
  }, [selectedVoiceId]);

  const selectedVoice = voices.find((voice) => voice.id === selectedVoiceId) ?? null;
  const createReady = Boolean(voiceName.trim() && sampleFile && previewText.trim() && consent);
  const missingCreateFields = [
    !voiceName.trim() ? "声音名称" : "",
    !sampleFile ? "声音样本" : "",
    !previewText.trim() ? "试听文本" : "",
    !consent ? "授权确认" : "",
  ].filter(Boolean);

  const createClone = async () => {
    if (!createReady || !sampleFile) {
      notify(`请先完成：${missingCreateFields.join("、")}`);
      return;
    }
    if (sampleFile.size > 20 * 1024 * 1024) {
      notify("声音样本不能超过 20MB");
      return;
    }
    setLoading(true);
    setServiceError("");
    try {
      const [dataUrl, duration] = await Promise.all([fileToDataUrl(sampleFile), readAudioDuration(sampleFile)]);
      const data = await voiceApi<{ voice: VoiceLibraryItem; audio?: { audioUrl?: string } }>("/api/voice-clone/create", {
        method: "POST",
        body: JSON.stringify({
          name: voiceName.trim(),
          attemptId: `voice-clone-${crypto.randomUUID()}`,
          previewText: previewText.trim(),
          consent: true,
          audio: { name: sampleFile.name, type: sampleFile.type, dataUrl, duration },
        }),
      });
      const audioUrl = data.audio?.audioUrl || data.voice.previewAudioUrl || "";
      setResultAudioUrl(audioUrl);
      setResultVoiceName(data.voice.name || voiceName.trim());
      setSelectedVoiceId(data.voice.id);
      await loadVoices(true, data.voice.id);
      if (audioUrl) {
        const downloadLink = document.createElement("a");
        downloadLink.href = audioUrl;
        downloadLink.download = `${voiceName.trim().replace(/[\\/:*?"<>|]/g, "-") || "声音试听"}.mp3`;
        document.body.appendChild(downloadLink);
        downloadLink.click();
        downloadLink.remove();
      }
      notify("试听已生成并开始下载，不会正式启用音色");
    } catch (error) {
      const message = error instanceof Error ? error.message : "试听生成失败";
      setServiceError(message);
      notify(message);
    } finally {
      setLoading(false);
    }
  };

  const renameVoice = async (voice: VoiceLibraryItem) => {
    const nextName = window.prompt("声音名称", voice.name)?.trim();
    if (!nextName || nextName === voice.name) return;
    try {
      await voiceApi(`/api/voices/${encodeURIComponent(voice.id)}`, { method: "PATCH", body: JSON.stringify({ name: nextName }) });
      if (resultVoiceName === voice.name) setResultVoiceName(nextName);
      await loadVoices(true);
      notify("声音名称已更新");
    } catch (error) {
      notify(error instanceof Error ? error.message : "重命名失败");
    }
  };

  const deleteVoice = async (voice: VoiceLibraryItem) => {
    if (!window.confirm(`确认删除声音“${voice.name}”？`)) return;
    try {
      await voiceApi(`/api/voices/${encodeURIComponent(voice.id)}`, { method: "DELETE" });
      if (selectedVoiceId === voice.id) {
        setSelectedVoiceId("");
        setResultAudioUrl("");
        setResultVoiceName("");
      }
      await loadVoices(true);
      notify("声音已删除");
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除失败");
    }
  };

  const formatVoiceDate = (value?: string) => {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "暂无记录";
  };

  return (
    <section className="voice-workbench">
      <header className="voice-workbench-head">
        <div className="voice-heading-icon workspace-heading-icon"><Mic2 /></div>
        <div><div className="feature-title-line"><h1>声音克隆</h1><ContactAuthorButton appName={appName} /></div><p>上传已授权的声音样本，只生成可下载试听，不正式启用音色</p></div>
        <span className="voice-provider">MiniMax · 试听模式</span>
      </header>
      <div className="voice-content">
        <nav className="voice-tabs two" aria-label="声音复刻模块">
          <button className={tab === "upload" ? "active" : ""} onClick={() => setTab("upload")}>上传新声音</button>
          <button className={tab === "library" ? "active" : ""} onClick={() => setTab("library")}>试听记录</button>
        </nav>
        {serviceError && <div className="voice-service-error"><AlertTriangle size={15} /><span>{serviceError}</span></div>}
        <div className="voice-studio-layout">
          <section className="voice-panel voice-main-panel">
            {tab === "upload" && (
              <div className="voice-pane">
                <label className="voice-field"><span>声音名称</span><input value={voiceName} maxLength={20} onChange={(event) => setVoiceName(event.target.value)} placeholder="请输入声音名称，例如：温柔女声、老板口播、产品讲解男声" /><small>必填，最多 20 个字</small></label>
                <label className={`voice-upload ${sampleFile ? "has-file" : ""}`}>
                  <input type="file" accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4" onChange={(event) => setSampleFile(event.target.files?.[0] || null)} />
                  <Upload size={25} /><strong>{sampleFile ? sampleFile.name : "上传声音样本"}</strong><small>{sampleFile ? `${(sampleFile.size / 1024 / 1024).toFixed(1)} MB` : "建议 10 秒-5 分钟，单人清晰人声，文件不超过 20MB"}</small>
                </label>
                <p className="voice-field-help">支持 mp3 / wav / m4a，时长 10 秒-5 分钟，不超过 20MB</p>
                <label className="voice-field"><span>试听文本</span><textarea value={previewText} maxLength={500} onChange={(event) => setPreviewText(event.target.value)} placeholder="请输入想要合成的试听文本内容…" /><small>必填，最多 500 字</small></label>
                <label className="voice-consent-row"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>我确认拥有该声音样本的使用授权，并同意仅用于合法内容生成。</span></label>
                {missingCreateFields.length > 0 && <p className="voice-action-hint error">还需完成：{missingCreateFields.join("、")}</p>}
                <p className="voice-action-hint">仅收取 MiniMax 试听字符费用；不会发起正式 T2A 合成或启用音色。</p>
                <button className="voice-primary" disabled={loading || !createReady} onClick={createClone}>{loading ? "正在生成…" : "生成并下载试听"}</button>
              </div>
            )}

            {tab === "library" && (
              <div className="voice-pane">
                <div className="voice-panel-title"><div><p className="voice-eyebrow">PREVIEW HISTORY</p><h2>试听记录</h2></div><button onClick={() => loadVoices()}><RotateCcw size={14} />刷新记录</button></div>
                {voices.length ? <div className="voice-grid">{voices.map((voice) => {
                  const recentAudio = voice.audios?.[voice.audios.length - 1];
                  const audioUrl = recentAudio?.audioUrl || voice.previewAudioUrl;
                  return (
                    <article className="voice-card" key={voice.id}>
                      <div className="voice-card-copy"><strong>{voice.name}<i className={voice.legacyNotice ? "legacy" : voice.errorMessage ? "failed" : ""}>{voice.status}</i></strong><span>创建时间：{formatVoiceDate(voice.createdAt)}</span><span>最近使用：{formatVoiceDate(recentAudio?.createdAt)}</span></div>
                      {voice.legacyNotice && <p className="voice-card-notice">{voice.legacyNotice}</p>}
                      {voice.errorMessage && <p className="voice-card-error"><AlertTriangle size={13} /><span>{voice.errorMessage}</span></p>}
                      {audioUrl && <VoiceAudioPlayer src={audioUrl} compact />}
                      <div className="voice-card-actions"><button onClick={() => renameVoice(voice)}>重命名</button><button className="danger" onClick={() => deleteVoice(voice)}>删除</button></div>
                    </article>
                  );
                })}</div> : <div className="voice-library-empty"><Mic2 size={35} /><strong>暂无试听记录</strong><span>生成的试听音频会保存在本机，不会正式启用 MiniMax 音色</span></div>}
              </div>
            )}
          </section>

          <aside className="voice-result-panel">
            <p>RESULT PREVIEW</p><h2>结果预览</h2>
            {resultAudioUrl ? (
              <div className="voice-result-body"><span>当前试听名称</span><strong>{resultVoiceName || selectedVoice?.name || "未命名试听"}</strong><VoiceAudioPlayer key={resultAudioUrl} src={resultAudioUrl} /><a className="voice-regenerate" href={resultAudioUrl} download><Download size={14} />下载试听音频</a></div>
            ) : (
              <div className="voice-empty-result"><Volume2 size={34} /><span>上传声音样本并输入文本后开始生成</span></div>
            )}
          </aside>
        </div>
      </div>
    </section>
  );
}

const sortLabels: Record<SortBy, string> = {
  recent: "最近导入",
  name: "名称 A–Z",
  size: "文件大小",
};

const classifierProductBriefTemplate = `产品名称：
项目名称：
产品品类：
分类目标：例如剪辑检索、投放素材库、达人素材沉淀、自有素材沉淀
目标人群：
核心痛点：
核心卖点：
常见使用/消费场景：
必须单独成类的镜头：例如产品镜头、痛点镜头、使用镜头、卖点镜头、真人口播、达人素材、AI生成
容易混淆的边界：例如试喝 vs 使用、达人口播 vs 真人口播、配料表 vs 配料干净低负担
已有素材来源：例如自有拍摄、达人原片、直播切片、AI生成
不希望出现的类目或命名：
错分纠正样例：例如“背景有多瓶但主体一瓶”仍按主体一瓶分类`;

function classifierBriefMissingFields(brief: string) {
  const required = ["产品名称", "分类目标", "核心卖点", "常见使用/消费场景"];
  return required.filter((label) => {
    const match = String(brief || "").match(new RegExp(`(?:^|\\n)\\s*${label}\\s*[：:]\\s*([^\\n]*)`, "u"));
    const value = match?.[1]?.trim() || "";
    return !value || /^(?:例如|示例)/u.test(value);
  });
}

function classifierTaxonomyToText(taxonomy: Record<string, string[]> | undefined) {
  return Object.entries(taxonomy || {}).map(([group, items]) => `${group}：${items.join("，")}`).join("\n");
}

function parseClassifierTaxonomy(value: string) {
  const taxonomy: Record<string, string[]> = {};
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.search(/[:：]/);
    if (separator <= 0) throw new Error(`分类结构格式不正确：${line}`);
    const group = line.slice(0, separator).trim();
    const items = line.slice(separator + 1).split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
    if (!items.length) throw new Error(`分类“${group}”缺少二级分类`);
    taxonomy[group] = items;
  }
  if (!Object.keys(taxonomy).length) throw new Error("请至少填写一个一级分类");
  return taxonomy;
}

const initialApiSettings: ApiSettingsState = {
  classification: {
    provider: "volcengine",
    volcengine: { endpointId: "", apiKeyConfigured: false },
    relay: { baseUrl: "", textModel: "", visionModel: "", apiKeyConfigured: false },
  },
  minimax: {
    provider: "minimax",
    baseUrl: "https://api.minimaxi.com/v1",
    model: "speech-2.8-turbo",
    groupId: "",
    apiKeyConfigured: false,
  },
};

const initialLicenseState: LicenseState = {
  appName: "ai-media-library",
  softwareName: "AI媒体库",
  protocolVersion: 2,
  canUnbind: false,
  hasActivationCode: false,
  phase: "checking",
  authorized: false,
  message: "正在验证授权",
  license: null,
};

function formatServerDate(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
}

function licenseStatusLabel(state: LicenseState) {
  if (state.previewAllFeatures) return "源码预览";
  if (state.phase === "active") return "已激活";
  if (state.phase === "offline_active") return "离线可用";
  if (state.phase === "expired") return "已到期";
  if (state.phase === "renewal_required") return "待确认续期";
  if (state.phase === "update_required") return "需要更新软件";
  if (state.phase === "disabled") return "已禁用";
  if (state.phase === "network_error") return "等待联网验证";
  if (state.phase === "credential_missing") return "凭证缺失";
  if (state.phase === "needs_activation") return "当前设备未绑定";
  return "授权状态待确认";
}

function OfflineLicenseBanner({ state }: { state: LicenseState }) {
  if (state.phase !== "offline_active" || !state.authorized) return null;
  const urgent = (state.offlineRemainingDays ?? 0) <= 2;
  return (
    <div className={`license-offline-banner ${urgent ? "urgent" : "normal"}`} role="status" aria-live="polite">
      <ShieldCheck size={15} />
      <span>{state.message}</span>
    </div>
  );
}

function MachineCodeField({ compact = false }: { compact?: boolean }) {
  const [diagnostic, setDiagnostic] = useState<MachineIdentityDiagnostic | null>(null);
  const [copied, setCopied] = useState(false);
  const [diagnosticCopyMessage, setDiagnosticCopyMessage] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const bridge = window.desktopBridge;
    if (!bridge?.licenseMachineIdentity) {
      window.queueMicrotask(() => {
        if (active) setLoadFailed(true);
      });
      return () => { active = false; };
    }
    bridge.licenseMachineIdentity()
      .then((value) => {
        if (active) setDiagnostic(value);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => { active = false; };
  }, []);

  const copyMachineCode = async () => {
    if (!diagnostic) return;
    try {
      if (window.desktopBridge?.licenseCopyMachineCode) {
        await window.desktopBridge.licenseCopyMachineCode();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const copyRedactedDiagnostic = async () => {
    try {
      const result = await window.desktopBridge?.licenseCopyIdentityDiagnostics?.();
      setDiagnosticCopyMessage(result?.ok ? "脱敏诊断已复制" : ["idle", "pending"].includes(result?.reason || "")
        ? "硬件身份仍在采集，请稍后重试" : "硬件因子暂未采集成功，请复制机器码联系客服");
    } catch {
      setDiagnosticCopyMessage("暂时无法复制诊断，请稍后重试");
    }
    window.setTimeout(() => setDiagnosticCopyMessage(""), 3000);
  };

  return (
    <div className={`license-machine-code ${compact ? "compact" : ""}`}>
      <div className="license-machine-code-heading">
        <span>机器身份诊断</span>
        <div className="license-machine-code-actions">
          <button type="button" onClick={copyRedactedDiagnostic} title="复制因子哈希前 6 位，不含序列号或设备凭证">
            <Copy size={13} />复制脱敏诊断
          </button>
          <button type="button" onClick={copyMachineCode} disabled={!diagnostic} title="复制完整机器码">
            {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "已复制" : "复制机器码"}
          </button>
        </div>
      </div>
      {diagnosticCopyMessage && <small role="status">{diagnosticCopyMessage}</small>}
      <code>{loadFailed ? "机器码获取失败，请重启软件" : diagnostic?.maskedMachineCode || "正在获取机器码…"}</code>
      {diagnostic && <div className="license-machine-diagnostic-grid">
        <span>身份来源<strong>{diagnostic.sourceType === "windows_system_uuid" ? "Windows设备UUID" : diagnostic.sourceType === "windows_machine_guid" ? "Windows系统标识（兼容）" : diagnostic.sourceType === "mac_io_platform_uuid" ? "macOS平台标识" : diagnostic.sourceType === "random_fallback" ? "本机安全回退" : "系统标识"}</strong></span>
        <span>兼容模式<strong>{diagnostic.compatibilityMode ? "已开启" : "未开启"}</strong></span>
        <span>硬件状态<strong className={diagnostic.hardwareMatch}>{diagnostic.hardwareMatch === "match" ? "匹配" : diagnostic.hardwareMatch === "mismatch" ? "不匹配" : "待确认"}</strong></span>
      </div>}
      {diagnostic?.message && <small className="mismatch">{diagnostic.message}</small>}
      {!compact && !diagnostic?.message && <small>后台查询设备时，可复制完整机器码。</small>}
    </div>
  );
}

function licenseDiagnosticTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "--:--:--";
  return parsed.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function LicenseDiagnosticLogPanel() {
  const [snapshot, setSnapshot] = useState<LicenseDiagnosticSnapshot>({ entries: [], generatedAt: "", maxEntries: 240 });
  const [copyMessage, setCopyMessage] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const bridge = window.desktopBridge;
    if (!bridge?.licenseDiagnosticLog) return () => { active = false; };
    bridge.licenseDiagnosticLog().then((next) => { if (active && next) setSnapshot(next); }).catch(() => {});
    bridge.licenseOnDiagnosticLogChanged?.((next) => { if (active && next) setSnapshot(next); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [snapshot.entries.length]);

  const copyLogs = async () => {
    try {
      await window.desktopBridge?.licenseCopyDiagnosticLog?.();
      setCopyMessage("已复制脱敏日志");
    } catch {
      setCopyMessage("复制失败");
    }
    window.setTimeout(() => setCopyMessage(""), 2200);
  };

  const clearLogs = async () => {
    try {
      const next = await window.desktopBridge?.licenseClearDiagnosticLog?.();
      if (next) setSnapshot(next);
    } catch {
      setCopyMessage("清空失败");
    }
  };

  const latest = snapshot.entries.at(-1);
  const warningCount = snapshot.entries.filter((entry) => entry.level === "warning" || entry.level === "error").length;
  return (
    <details className="license-diagnostic-panel">
      <summary>
        <span><List size={14} />运行诊断日志</span>
        <span className={`license-diagnostic-summary ${latest?.level || "info"}`}>
          {warningCount ? `${warningCount} 条需关注` : snapshot.entries.length ? "运行正常" : "正在收集"}
          <ChevronDown size={13} />
        </span>
      </summary>
      <div className="license-diagnostic-toolbar">
        <span>当前会话最多保留 {snapshot.maxEntries} 条，复制内容已强制脱敏。</span>
        <div>
          {copyMessage && <small role="status">{copyMessage}</small>}
          <button type="button" onClick={() => void copyLogs()}><Copy size={12} />复制日志</button>
          <button type="button" onClick={() => void clearLogs()}><Trash2 size={12} />清空</button>
        </div>
      </div>
      <div className="license-diagnostic-list" ref={listRef} role="log" aria-live="polite">
        {snapshot.entries.length ? snapshot.entries.map((entry) => {
          const details = Object.entries(entry.details || {})
            .filter(([, value]) => value !== "" && value !== null)
            .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`)
            .join(" · ");
          return <div className={`license-diagnostic-entry ${entry.level}`} key={entry.id}>
            <time>{licenseDiagnosticTime(entry.timestamp)}</time>
            <span className="license-diagnostic-stage">{entry.stage}</span>
            <div><strong>{entry.message}</strong>{details && <small>{details}</small>}</div>
          </div>;
        }) : <div className="license-diagnostic-empty">正在等待桌面客户端运行日志…</div>}
      </div>
    </details>
  );
}

function LicenseGate({ state, onStateChange, children }: {
  state: LicenseState;
  onStateChange: (state: LicenseState) => void;
  children: React.ReactNode;
}) {
  const [activationCode, setActivationCode] = useState("");
  const [working, setWorking] = useState(false);
  const [localError, setLocalError] = useState("");
  const [gateUpdateState, setGateUpdateState] = useState<UpdateState>(initialUpdateState);
  const isLicensed = state.previewAllFeatures === true
    || (state.authorized && (state.phase === "active" || state.phase === "offline_active"));
  useEffect(() => {
    if (isLicensed) return;
    const bridge = window.desktopBridge;
    bridge?.updateBootstrap?.().then((next) => { if (next) setGateUpdateState(next); }).catch(() => {});
    bridge?.updateOnStateChanged?.(setGateUpdateState);
  }, [isLicensed]);

  if (isLicensed) return children;

  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const canActivate = state.identityRepairPending || state.phase === "needs_activation" || ((state.phase === "invalid" || state.phase === "update_required" || state.phase === "network_error" || state.phase === "configuration_error") && !state.license && !state.canUnbind);
  const canRenew = state.phase === "expired" || state.phase === "renewal_required" || (state.phase === "update_required" && !!state.license);
  const submitActivation = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!bridge?.licenseActivate || !activationCode.trim()) {
      setLocalError(!bridge?.licenseActivate ? "在线授权仅支持桌面客户端" : "请输入激活码");
      return;
    }
    setWorking(true);
    setLocalError("");
    try {
      const next = await bridge.licenseActivate(activationCode);
      if (next.authorized) setActivationCode("");
      onStateChange(next);
    } catch {
      setLocalError("授权服务器暂时无法连接，请重试");
    } finally {
      setWorking(false);
    }
  };

  const repairIdentity = async () => {
    if (!bridge?.licenseRepairIdentity || !activationCode.trim()) {
      setLocalError(!bridge?.licenseRepairIdentity ? "请更新桌面客户端后使用设备识别修复" : "请先输入全新、未绑定的激活码");
      return;
    }
    setWorking(true);
    setLocalError("");
    try {
      const next = await bridge.licenseRepairIdentity(activationCode);
      if (next.authorized) setActivationCode("");
      onStateChange(next);
    } catch {
      setLocalError("修复未完成，请保留同一张激活码后重试，或复制诊断联系管理员。");
    } finally {
      setWorking(false);
    }
  };

  const submitRenewal = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!bridge?.licenseRenewTime || !activationCode.trim()) {
      setLocalError(!bridge?.licenseRenewTime ? "续期功能仅支持桌面客户端" : "请输入新的月卡或年卡激活码");
      return;
    }
    const confirmed = window.confirm(
      state.phase === "expired"
        ? "确认使用这张新时间卡恢复当前设备授权吗？\n\n机器码和设备凭证不会改变，新卡只会增加可用时间。"
        : "确认使用这张新时间卡续期当前授权吗？\n\n本次不会更换机器码或设备凭证。",
    );
    if (!confirmed) return;
    setWorking(true);
    setLocalError("");
    try {
      const next = await bridge.licenseRenewTime(activationCode);
      if (next.authorized) setActivationCode("");
      onStateChange(next);
    } catch {
      setLocalError("未能完成续期，新激活码未确认使用；请检查网络后重试。");
    } finally {
      setWorking(false);
    }
  };

  const retry = async () => {
    if (!bridge?.licenseRefresh) return;
    setWorking(true);
    setLocalError("");
    try {
      onStateChange(await bridge.licenseRefresh());
    } catch {
      setLocalError("授权服务器暂时无法连接，请重试");
    } finally {
      setWorking(false);
    }
  };

  const unbind = async () => {
    if (!state.canUnbind || !bridge?.licenseUnbind || !window.confirm("确定解绑当前设备吗？解绑后需要重新激活才能使用软件。")) return;
    setWorking(true);
    setLocalError("");
    try {
      onStateChange(await bridge.licenseUnbind());
    } catch {
      setLocalError("授权服务器暂时无法连接，请重试");
    } finally {
      setWorking(false);
    }
  };

  return (
    <main className="license-gate-shell">
      <section className="license-gate-card" aria-live="polite">
        <div className="license-brand-icon"><ShieldCheck size={34} /></div>
        <p className="license-kicker">ONLINE LICENSE</p>
        <h1>{state.softwareName}</h1>
        {state.phase === "checking" ? (
          <div className="license-checking"><RefreshCw size={18} /><span>正在验证设备授权…</span></div>
        ) : canActivate ? (
          <form onSubmit={submitActivation} className="license-activation-form">
            <p>请输入月卡或年卡激活码，验证成功后即可进入软件。</p>
            <label><span>激活码</span><div><KeyRound size={17} /><input type="password" value={activationCode} onChange={(event) => setActivationCode(event.target.value)} placeholder="请输入激活码" autoComplete="off" spellCheck={false} autoFocus /></div></label>
            <MachineCodeField />
            {(localError || state.message) && <div className="license-error"><AlertTriangle size={15} /><span>{localError || state.message}</span></div>}
            <button type="submit" disabled={working || !activationCode.trim() || state.identityRepairPending}>{working ? "正在核对设备身份并激活…" : "立即激活"}</button>
            {!state.canUnbind && !state.license && <div className="license-identity-repair">
              <button type="button" className="license-renewal-retry" onClick={repairIdentity} disabled={working || !activationCode.trim()}><RefreshCw size={15} />{working ? "正在处理，请稍候…" : state.identityRepairPending ? "继续修复设备识别" : "修复设备识别"}</button>
              <p>重新检测本机设备信息，处理旧机器码冲突。已有授权将先核验，再决定是否迁移。</p>
              <p>本次仅适用于全新、未绑定的激活码。本地先生成新的机器码，激活成功后才切换身份；发现历史授权会停止修复。中断后请用同一张码继续。</p>
            </div>}
          </form>
        ) : canRenew ? (
          <form onSubmit={submitRenewal} className="license-activation-form license-renewal-form">
            <span className={`license-state-badge ${state.phase}`}>{licenseStatusLabel(state)}</span>
            <h2>{state.phase === "expired" ? "使用新码恢复当前设备授权" : "确认续期原授权"}</h2>
            <p>机器码和长期设备凭证保持不变。新的月卡或年卡只增加可用时间，不会把本机当成新电脑。</p>
            <label><span>新时间卡激活码</span><div><KeyRound size={17} /><input type="password" value={activationCode} onChange={(event) => setActivationCode(event.target.value)} placeholder="请输入新的月卡或年卡" autoComplete="off" spellCheck={false} autoFocus /></div></label>
            <MachineCodeField compact />
            {(localError || state.message) && <div className="license-error"><AlertTriangle size={15} /><span>{localError || state.message}</span></div>}
            <button type="submit" disabled={working || !activationCode.trim()}>{working ? "正在验证并恢复…" : state.phase === "expired" ? "使用新码恢复授权" : "确认续期原授权"}</button>
            <button type="button" className="license-renewal-retry" onClick={retry} disabled={working}><RefreshCw size={15} />先重新验证原授权</button>
          </form>
        ) : (
          <div className="license-blocked-state">
            <span className={`license-state-badge ${state.phase}`}>{licenseStatusLabel(state)}</span>
            <h2>{localError || state.message}</h2>
            {state.machineIdentityMessage && <p className="license-machine-identity-warning">{state.machineIdentityMessage}</p>}
            {state.license?.expiresAt && <p>授权到期时间：{formatServerDate(state.license.expiresAt)}</p>}
            {state.phase === "credential_missing" && <MachineCodeField />}
            <div className="license-gate-actions">
              {state.canUnbind && <button type="button" onClick={retry} disabled={working}><RefreshCw size={15} />{working ? "正在验证" : "重新验证"}</button>}
              {state.phase === "credential_missing" && <button type="button" onClick={() => onStateChange({ ...state, phase: "needs_activation", message: "请输入激活码以继续使用", license: null })}>返回激活页面</button>}
              {state.canUnbind && <button type="button" className="secondary" onClick={unbind} disabled={working}><Unlink size={15} />解绑此设备</button>}
            </div>
          </div>
        )}
        <button type="button" className="license-renewal-retry" onClick={() => void bridge?.updateCheck?.().then(setGateUpdateState).catch(() => setLocalError("检查更新失败，请稍后重试"))}>检查软件更新</button>
        <LicenseDiagnosticLogPanel />
        <footer><LockKeyhole size={13} />设备凭证由系统安全存储保护 · 协议 v{state.protocolVersion}</footer>
      </section>
      <UpdateDialog state={gateUpdateState} notify={setLocalError} />
    </main>
  );
}

function LicenseManagement({ state, onStateChange, notify }: {
  state: LicenseState;
  onStateChange: (state: LicenseState) => void;
  notify: (message: string) => void;
}) {
  const [working, setWorking] = useState(false);
  const [activationCode, setActivationCode] = useState("");
  const [activationCodeVisible, setActivationCodeVisible] = useState(false);
  const [activationCodeLoading, setActivationCodeLoading] = useState(false);
  const [activationCodeCopied, setActivationCodeCopied] = useState(false);
  const [activationCodeDraft, setActivationCodeDraft] = useState("");
  const [activationCodeSaving, setActivationCodeSaving] = useState(false);
  const [redeemCode, setRedeemCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [rebindOpen, setRebindOpen] = useState(false);
  const [rebindCode, setRebindCode] = useState("");
  const [rebindCodeLoading, setRebindCodeLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const licenseDisplay = state.previewAllFeatures
    ? { typeLabel: "源码预览", durationTitle: "授权时长", durationLabel: "预览可用", accumulated: false }
    : licenseDisplayDetails(state.license);
  const rights = resolveEntitlements(state);

  const redeemTimeCode = async () => {
    if (state.previewAllFeatures) {
      notify("源码预览不会提交真实时间码；正式客户端会按双期限协议兑换。");
      return;
    }
    if (!redeemCode.trim() || !window.desktopBridge?.licenseRedeemTime) return;
    if (!window.confirm("确认兑换这张时间码吗？兑换成功后不能再次使用。")) return;
    setRedeeming(true);
    try {
      const next = await window.desktopBridge.licenseRedeemTime(redeemCode);
      onStateChange(next);
      setRedeemCode("");
      if (next.redemption?.durationDays) {
        const codeLabel = next.redemption.codeKind === "vip" ? "VIP 权益时间码" : "基础时间码";
        notify(`兑换成功：${codeLabel}，增加 ${next.redemption.durationDays} 天`);
      } else {
        notify("时间码兑换成功，权益已更新");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "兑换失败，请保留时间码重试");
    } finally {
      setRedeeming(false);
    }
  };

  const refresh = async () => {
    if (!window.desktopBridge?.licenseRefresh) return notify("在线授权仅支持桌面客户端");
    setWorking(true);
    try {
      const next = await window.desktopBridge.licenseRefresh();
      onStateChange(next);
      notify(next.authorized ? "设备授权有效" : next.message);
    } catch {
      notify("授权服务器暂时无法连接，请重试");
    } finally {
      setWorking(false);
    }
  };

  const readActivationCode = async () => {
    if (!window.desktopBridge?.licenseRevealActivationCode) throw new Error("桌面授权接口不可用");
    return window.desktopBridge.licenseRevealActivationCode();
  };

  const toggleActivationCode = async () => {
    if (activationCodeVisible) {
      setActivationCodeVisible(false);
      setActivationCode("");
      return;
    }
    if (!state.hasActivationCode) return notify("本机尚未补录激活码，可在授权管理中补录，或复制机器码联系客服查询。");
    setActivationCodeLoading(true);
    try {
      setActivationCode(await readActivationCode());
      setActivationCodeVisible(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : "激活码读取失败");
    } finally {
      setActivationCodeLoading(false);
    }
  };

  const copyActivationCode = async () => {
    if (!state.hasActivationCode || !window.desktopBridge?.licenseCopyActivationCode) return notify("当前没有可复制的激活码");
    try {
      await window.desktopBridge.licenseCopyActivationCode();
      setActivationCodeCopied(true);
      window.setTimeout(() => setActivationCodeCopied(false), 1600);
    } catch (error) {
      notify(error instanceof Error ? error.message : "激活码复制失败");
    }
  };

  const saveActivationCode = async () => {
    const code = activationCodeDraft.trim();
    if (!code || !window.desktopBridge?.licenseSaveActivationCode) return notify(code ? "桌面授权接口不可用" : "请输入激活码");
    setActivationCodeSaving(true);
    try {
      const next = await window.desktopBridge.licenseSaveActivationCode(code);
      onStateChange(next);
      setActivationCodeDraft("");
      notify("激活码已加密保存到系统安全存储");
    } catch (error) {
      notify(error instanceof Error ? error.message : "激活码补录失败");
    } finally {
      setActivationCodeSaving(false);
    }
  };

  const openRebind = async () => {
    setRebindOpen(true);
    setRebindCode("");
    if (!state.hasActivationCode) return;
    setRebindCodeLoading(true);
    try {
      setRebindCode(await readActivationCode());
    } catch (error) {
      notify(error instanceof Error ? error.message : "激活码读取失败");
    } finally {
      setRebindCodeLoading(false);
    }
  };

  const closeRebind = () => {
    if (working) return;
    setRebindOpen(false);
    setRebindCode("");
  };

  const confirmRebind = async () => {
    if (!state.canUnbind || !window.desktopBridge?.licenseUnbind) return notify("当前设备没有可用于解绑的本地凭证");
    setWorking(true);
    try {
      onStateChange(await window.desktopBridge.licenseUnbind());
      setRebindOpen(false);
      setRebindCode("");
    } catch {
      notify("授权服务器暂时无法连接，请重试");
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <section className="api-settings-card license-management-card">
        <div
          className="api-settings-card-title license-management-toggle"
          role="button"
          tabIndex={0}
          aria-expanded={!collapsed}
          aria-controls="license-management-details"
          onClick={() => setCollapsed((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setCollapsed((value) => !value);
            }
          }}
        >
          <div><span className="api-settings-kicker">LICENSE</span><h2>授权管理</h2><p>授权信息以服务器返回为准；激活码和设备凭证加密保存在当前电脑。</p></div>
          <div className="license-management-toggle-meta">
            <span className={`api-config-status ${state.authorized ? "ready" : "empty"}`}>{licenseStatusLabel(state)}</span>
            <span className={`license-management-chevron ${collapsed ? "collapsed" : ""}`} aria-hidden="true"><ChevronDown size={17} /></span>
          </div>
        </div>
        {!collapsed && <div id="license-management-details">
        <div className="license-detail-grid">
          <div><span>软件中文名</span><strong>{state.softwareName}</strong></div>
          <div><span>授权类型</span><strong>{licenseDisplay.typeLabel}</strong></div>
          <div><span>授权状态</span><strong>{licenseStatusLabel(state)}</strong></div>
          <div><span>{licenseDisplay.durationTitle}</span><strong>{licenseDisplay.durationLabel}</strong></div>
          <div><span>激活时间</span><strong>{state.previewAllFeatures ? "预览无需激活" : formatServerDate(state.license?.activatedAt ?? null)}</strong></div>
          <div><span>基础授权到期</span><strong>{state.previewAllFeatures ? "预览可用" : state.license?.basePermanent ? "永久" : formatServerDate(rights.baseExpiresAt)}</strong></div>
          <div><span>VIP 权益到期</span><strong>{state.previewAllFeatures ? "预览可用" : rights.vipExpiresAt ? formatServerDate(rights.vipExpiresAt) : "未开通"}</strong></div>
          <div className="license-code-detail">
            <span>激活码</span>
            {state.previewAllFeatures ? (
              <div><strong>预览无需激活码</strong></div>
            ) : state.hasActivationCode ? (
              <div>
                <strong title={activationCodeVisible ? activationCode : ""}>{activationCodeVisible ? activationCode : "••••••••••••••••"}</strong>
                <button type="button" onClick={toggleActivationCode} disabled={activationCodeLoading} title={activationCodeVisible ? "隐藏激活码" : "查看激活码"} aria-label={activationCodeVisible ? "隐藏激活码" : "查看激活码"}>
                  {activationCodeVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button type="button" onClick={copyActivationCode} title="复制激活码" aria-label="复制激活码">
                  {activationCodeCopied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            ) : (
              <div className="license-code-enroll">
                <input type="password" value={activationCodeDraft} onChange={(event) => setActivationCodeDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveActivationCode(); }} placeholder="输入当前激活码" autoComplete="off" spellCheck={false} />
                <button type="button" className="license-code-enroll-button" onClick={saveActivationCode} disabled={!activationCodeDraft.trim() || activationCodeSaving}>{activationCodeSaving ? "保存中" : "补录"}</button>
              </div>
            )}
          </div>
          <div><span>换机次数</span><strong>{state.previewAllFeatures ? "预览不计次" : state.license?.transferCount ?? "—"}</strong></div>
          <div className="license-redemption-card">
            <span>时间码兑换</span>
            <div className="license-redemption-controls">
              <input type="password" value={redeemCode} onChange={(event) => setRedeemCode(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void redeemTimeCode(); }} placeholder="输入基础或 VIP 时间码" autoComplete="off" spellCheck={false} aria-label="基础或 VIP 时间码" disabled={state.previewAllFeatures} />
              <button type="button" onClick={() => void redeemTimeCode()} disabled={state.previewAllFeatures || !redeemCode.trim() || redeeming || state.phase !== "active" || (state.license?.redemptionProtocolVersion || 0) < 1}>{redeeming ? "兑换中" : "兑换"}</button>
            </div>
            {state.previewAllFeatures
              ? <small className="preview-ready">双期限兑换界面已启用；源码预览不提交真实时间码。</small>
              : (state.license?.redemptionProtocolVersion || 0) < 1 && <small>服务端尚未启用双期限兑换，暂不可提交。</small>}
          </div>
        </div>
        <MachineCodeField compact />
        <div className="license-management-actions">
          <span><LockKeyhole size={13} />激活码与设备凭证均由系统安全存储保护。</span>
          {!state.previewAllFeatures && <button type="button" onClick={refresh} disabled={working}><RefreshCw size={14} />重新验证</button>}
          {state.canUnbind && <button type="button" className="danger" onClick={openRebind} disabled={working}><Unlink size={14} />换绑设备</button>}
        </div>
        </div>}
      </section>
      {rebindOpen && createPortal(
        <div className="modal-backdrop license-rebind-backdrop" onMouseDown={closeRebind}>
          <div className="compact-modal danger-modal license-rebind-modal" role="dialog" aria-modal="true" aria-labelledby="license-rebind-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={closeRebind} disabled={working} aria-label="关闭"><X size={18} /></button>
            <div className="compact-modal-icon"><Unlink size={20} /></div>
            <h2 id="license-rebind-title">换绑设备</h2>
            <p>确认后会解绑当前设备。请先复制并保存激活码，再到新设备完成激活。</p>
            <div className="license-rebind-code">
              <span>当前激活码</span>
              <code>{rebindCodeLoading ? "正在安全读取…" : rebindCode || "本机尚未补录激活码，可在授权管理中补录，或复制机器码联系客服查询。"}</code>
              <button type="button" onClick={copyActivationCode} disabled={!state.hasActivationCode || rebindCodeLoading}><Copy size={14} />复制激活码</button>
            </div>
            <div className="modal-actions">
              <button type="button" onClick={closeRebind} disabled={working}>取消</button>
              <button type="button" className="danger-confirm" onClick={confirmRebind} disabled={working}>{working ? "正在解绑…" : "确认解绑并换绑"}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function formatUpdateBytes(value: number) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function SoftwareUpdateCard({ state, onCheck, onOfflineReset }: {
  state: UpdateState;
  onCheck: () => void;
  onOfflineReset: () => Promise<void>;
}) {
  const checking = state.phase === "checking";
  const [collapsed, setCollapsed] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resettingOffline, setResettingOffline] = useState(false);
  const versionClicks = useRef({ count: 0, startedAt: 0 });

  const registerVersionClick = () => {
    const now = Date.now();
    const current = versionClicks.current;
    if (!current.startedAt || now - current.startedAt > 3000) {
      versionClicks.current = { count: 1, startedAt: now };
      return;
    }
    const count = current.count + 1;
    if (count >= 5) {
      versionClicks.current = { count: 0, startedAt: 0 };
      setResetConfirmOpen(true);
      return;
    }
    versionClicks.current = { count, startedAt: current.startedAt };
  };

  const confirmOfflineReset = async () => {
    setResettingOffline(true);
    try {
      await onOfflineReset();
      setResetConfirmOpen(false);
    } catch {
      // The settings page reports the actionable error. Keep the confirmation
      // open so support can retry after restoring the network connection.
    } finally {
      setResettingOffline(false);
    }
  };

  return (
    <>
    <section className="api-settings-card software-update-card">
      <div
        className="api-settings-card-title license-management-toggle"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-controls="software-update-details"
        onClick={() => setCollapsed((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setCollapsed((value) => !value);
          }
        }}
      >
        <div><span className="api-settings-kicker">ABOUT & UPDATE</span><h2>关于与软件更新</h2><p>更新包由主进程下载并校验，不会修改授权凭证和用户业务数据。</p></div>
        <div className="license-management-toggle-meta">
          <span className={`api-config-status ${state.phase === "error" ? "empty" : "ready"}`}>{state.phase === "available" || state.phase === "downloaded" ? "发现更新" : state.phase === "error" ? "检查失败" : "自动检查"}</span>
          <span className={`license-management-chevron ${collapsed ? "collapsed" : ""}`} aria-hidden="true"><ChevronDown size={17} /></span>
        </div>
      </div>
      {!collapsed && <div className="software-update-body" id="software-update-details">
        <div><span>当前版本</span><button type="button" className="software-version-trigger" onClick={(event) => { event.stopPropagation(); registerVersionClick(); }} onKeyDown={(event) => event.stopPropagation()}>{state.currentVersion}</button></div>
        <div><span>更新状态</span><strong>{state.message}</strong></div>
        <div><span>适用平台</span><strong>{state.platform || "当前设备"}</strong></div>
        <button type="button" disabled={checking || state.phase === "downloading" || state.phase === "installing"} onClick={onCheck}><RefreshCw size={14} />{checking ? "正在检查…" : "检查更新"}</button>
      </div>}
    </section>
    {resetConfirmOpen && createPortal(
      <div className="modal-backdrop license-offline-reset-backdrop" onMouseDown={() => { if (!resettingOffline) setResetConfirmOpen(false); }}>
        <div className="compact-modal license-offline-reset-modal" role="dialog" aria-modal="true" aria-labelledby="offline-reset-title" onMouseDown={(event) => event.stopPropagation()}>
          <button className="modal-close" type="button" aria-label="关闭" disabled={resettingOffline} onClick={() => setResetConfirmOpen(false)}><X size={18} /></button>
          <div className="compact-modal-icon"><RotateCcw size={20} /></div>
          <h2 id="offline-reset-title">重置离线授权缓存</h2>
          <p>此操作只会清除离线宽限记录并立即重新联网验证，不会删除激活码或设备凭证。</p>
          <div className="modal-actions">
            <button type="button" disabled={resettingOffline} onClick={() => setResetConfirmOpen(false)}>取消</button>
            <button type="button" className="offline-reset-confirm" disabled={resettingOffline} onClick={() => void confirmOfflineReset()}>{resettingOffline ? "正在验证…" : "清除并联网验证"}</button>
          </div>
        </div>
      </div>,
      document.body,
    )}
    </>
  );
}

function UpdateDialog({ state, notify }: { state: UpdateState; notify: (message: string) => void }) {
  const [confirmingInstall, setConfirmingInstall] = useState(false);
  if (!state.shouldPrompt || !state.targetVersion) return null;
  const progress = state.totalBytes > 0 ? Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100)) : 0;
  const invoke = async (action: (() => Promise<UpdateState>) | undefined, fallback: string) => {
    if (!action) return;
    try {
      const next = await action();
      if (next?.message) notify(next.message);
    } catch (error) {
      notify(error instanceof Error ? error.message : fallback);
    }
  };
  const bridge = window.desktopBridge;
  const retry = () => state.targetVersion ? invoke(bridge?.updateDownload, "更新下载重试失败") : invoke(bridge?.updateCheck, "更新检查失败");
  return createPortal(
    <div className="update-modal-backdrop" role="presentation">
      <section className={`update-modal ${state.forceUpdate ? "important" : ""}`} role="dialog" aria-modal="true" aria-labelledby="software-update-title">
        <div className="update-modal-icon"><Download size={22} /></div>
        <span className={`update-kind ${state.forceUpdate ? "important" : "normal"}`}>{state.forceUpdate ? "重要更新" : "普通更新"}</span>
        <h2 id="software-update-title">发现新版本 {state.targetVersion}</h2>
        <p className="update-version-line">当前版本 {state.currentVersion} · 新版本 {state.targetVersion}{state.fileSize > 0 ? ` · ${formatUpdateBytes(state.fileSize)}` : ""}</p>
        {state.releaseNotes && <div className="update-release-notes"><strong>更新说明</strong><p>{state.releaseNotes}</p></div>}

        {state.phase === "downloading" && <div className="update-download-progress">
          <div><span>正在下载 {progress}%</span><span>{formatUpdateBytes(state.downloadedBytes)} / {state.totalBytes ? formatUpdateBytes(state.totalBytes) : "未知大小"}</span></div>
          <div className="update-progress-track"><i style={{ width: `${progress}%` }} /></div>
          <small>下载速度 {formatUpdateBytes(state.bytesPerSecond)}/s</small>
        </div>}

        {state.phase === "downloaded" && confirmingInstall && <div className="update-save-warning"><AlertTriangle size={17} /><div><strong>安装前请保存当前工作</strong><span>确认后软件会退出并启动系统安装程序；授权和用户数据不会被删除。</span></div></div>}
        {state.phase === "error" && <div className="update-error-message"><AlertTriangle size={16} />{state.message}</div>}

        <div className="update-modal-actions">
          {state.phase === "available" && <>
            <button className="primary" onClick={() => void invoke(bridge?.updateDownload, "更新下载失败")}>立即更新</button>
            {!state.forceUpdate && <button onClick={() => void invoke(bridge?.updateRemindLater, "稍后提醒设置失败")}>稍后提醒</button>}
          </>}
          {state.phase === "downloading" && <button onClick={() => void invoke(bridge?.updateCancelDownload, "取消下载失败")}>取消下载</button>}
          {state.phase === "downloaded" && !confirmingInstall && <>
            <button className="primary" onClick={() => setConfirmingInstall(true)}>立即重启并安装</button>
            {!state.forceUpdate && <button onClick={() => void invoke(bridge?.updateInstallOnQuit, "退出安装设置失败")}>退出时安装</button>}
            {!state.forceUpdate && <button onClick={() => void invoke(bridge?.updateRemindLater, "稍后安装设置失败")}>稍后安装</button>}
          </>}
          {state.phase === "downloaded" && confirmingInstall && <>
            <button className="primary" onClick={() => void invoke(bridge?.updateInstallNow, "安装程序启动失败")}>已保存，退出并安装</button>
            <button onClick={() => setConfirmingInstall(false)}>返回</button>
          </>}
          {state.phase === "error" && <>
            {state.canRetry && <button className="primary" onClick={retry}>重试</button>}
            {state.forceUpdate ? <button className="danger" onClick={() => void bridge?.updateExit()}>退出软件</button> : <button onClick={() => void invoke(bridge?.updateRemindLater, "稍后提醒设置失败")}>稍后提醒</button>}
          </>}
          {state.phase === "installing" && <button disabled>正在启动安装程序…</button>}
        </div>
      </section>
    </div>,
    document.body,
  );
}

const storageCategoryMetadata = [
  { key: "classifier", label: "打标临时缓存", description: "已完成任务产生的临时素材，可安全清理", icon: Tag, tone: "teal" },
  { key: "video", label: "视频下载文件", description: "默认下载目录中的视频文件", icon: Download, tone: "cyan" },
  { key: "voice", label: "声音克隆文件", description: "上传样本和已生成音频", icon: Mic2, tone: "mint" },
  { key: "updates", label: "更新安装包", description: "已下载的旧版本安装程序", icon: PackageOpen, tone: "amber" },
  { key: "web", label: "网页缓存", description: "页面和图形缓存，不包含平台登录状态", icon: Globe2, tone: "slate" },
  { key: "localModel", label: "本地 AI 模型", description: "本地图像检索所需的模型数据", icon: HardDrive, tone: "violet" },
  { key: "platformLogin", label: "平台登录数据", description: "抖音和小红书的本机登录会话", icon: ShieldCheck, tone: "blue" },
] as const;

function StorageManagementPanel({ notify }: { notify: (message: string) => void }) {
  const [state, setState] = useState<StorageManagementState | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState<"classifier" | "updates" | "web" | null>(null);
  const bridge = window.desktopBridge;

  const refresh = async () => {
    if (!bridge?.storageManagementGet) {
      setLoading(false);
      return;
    }
    try {
      setState(await bridge.storageManagementGet());
    } catch (error) {
      notify(error instanceof Error ? error.message : "存储占用读取失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const desktopBridge = window.desktopBridge;
    if (!desktopBridge?.storageManagementGet) {
      const timer = window.setTimeout(() => setLoading(false), 0);
      return () => window.clearTimeout(timer);
    }
    desktopBridge.storageManagementGet()
      .then(setState)
      .catch((error) => notify(error instanceof Error ? error.message : "存储占用读取失败"))
      .finally(() => setLoading(false));
    return undefined;
  }, []);

  const clearCategory = async (category: "classifier" | "updates" | "web") => {
    if (!bridge?.storageManagementClear) return notify("清理功能仅支持桌面版");
    const prompts = {
      classifier: "只会清理打标临时文件，不会删除原素材和输出结果。继续吗？",
      updates: "将删除不再使用的旧版本更新安装包。继续吗？",
      web: "将清理页面缓存，平台登录状态会保留。继续吗？",
    };
    if (!window.confirm(prompts[category])) return;
    setClearing(category);
    try {
      const response = await bridge.storageManagementClear(category);
      setState(response.state);
      notify(response.result.message);
    } catch (error) {
      notify(error instanceof Error ? error.message : "清理失败");
    } finally {
      setClearing(null);
    }
  };

  const saveAutoCleanup = async (patch: Partial<StorageManagementSettings>) => {
    if (!bridge?.storageManagementSave || !state) return;
    try {
      setState(await bridge.storageManagementSave(patch));
      notify("自动清理设置已保存");
    } catch (error) {
      notify(error instanceof Error ? error.message : "自动清理设置保存失败");
    }
  };

  const openDirectory = (targetPath: string) => {
    if (!targetPath) return;
    void bridge?.openLocalPath(targetPath).then((result) => result?.error && notify(result.error));
  };

  const changeVideoDirectory = async () => {
    if (!bridge?.chooseDirectory || !bridge.videoDownloadSetOutput) return notify("更改下载位置仅支持桌面版");
    const directory = await bridge.chooseDirectory();
    if (!directory) return;
    await bridge.videoDownloadSetOutput(directory);
    await refresh();
    notify("视频默认下载位置已更改");
  };

  if (loading) return <div className="storage-loading"><RefreshCw size={18} />正在统计本机存储占用…</div>;
  if (!state) return <div className="storage-loading"><AlertTriangle size={18} />网页预览不会读取或清理电脑文件，请在桌面版中使用。</div>;

  const barKeys: Array<keyof StorageManagementState["categories"]> = ["classifier", "video", "voice", "updates", "web", "localModel", "platformLogin"];
  const total = Math.max(1, state.totalBytes);
  return <div className="storage-management-content">
    <section className="storage-summary-card">
      <div><span>本机存储占用</span><strong>{formatFileSize(state.totalBytes)}</strong></div>
      <div className="storage-summary-visual">
        <div className="storage-usage-bar">{barKeys.map((key) => <i key={key} className={`storage-segment ${key}`} style={{ width: `${(state.categories[key].bytes / total) * 100}%` }} />)}</div>
        <p>仅统计 AI媒体库相关目录，不包含用户自行选择的其他输出目录。</p>
      </div>
      <button type="button" onClick={() => void refresh()}><RefreshCw size={14} />重新统计</button>
    </section>

    <section className="storage-category-list">
      {storageCategoryMetadata.map(({ key, label, description, icon: Icon, tone }) => {
        const item = state.categories[key];
        return <article className="storage-category-row" key={key}>
          <span className={`storage-category-icon ${tone}`}><Icon size={19} /></span>
          <div className="storage-category-copy"><strong>{label}</strong><span>{description}</span>{key === "video" && state.videoDirectoryInsideAppData && <em>当前默认保存在系统盘，建议更改位置。</em>}</div>
          <b>{formatFileSize(item.bytes)}</b>
          <div className="storage-category-actions">
            {key === "classifier" && <button className="primary" disabled={clearing !== null || Boolean(state.classifierCleanupBlockedReason)} title={state.classifierCleanupBlockedReason || ""} onClick={() => void clearCategory("classifier")}>{clearing === "classifier" ? "清理中…" : "立即清理"}</button>}
            {key === "video" && <><button onClick={() => openDirectory(state.videoDirectory)}>打开目录</button><button onClick={() => void changeVideoDirectory()}>更改位置</button></>}
            {key === "voice" && <button onClick={() => openDirectory(item.path)}>管理文件</button>}
            {key === "updates" && <button disabled={clearing !== null} onClick={() => void clearCategory("updates")}>{clearing === "updates" ? "清理中…" : "清理旧版本"}</button>}
            {key === "web" && <button disabled={clearing !== null} onClick={() => void clearCategory("web")}>{clearing === "web" ? "清理中…" : "清理缓存"}</button>}
            {key === "localModel" && <span>保留</span>}
            {key === "platformLogin" && <span>平台登录中管理</span>}
          </div>
        </article>;
      })}
    </section>

    <section className="storage-auto-cleanup">
      <span className="storage-category-icon teal"><RefreshCw size={19} /></span>
      <div><strong>自动清理已完成任务缓存</strong><span>只清理已完成的打标临时文件，不影响原素材、输出结果和失败重跑任务。</span></div>
      <select value={state.settings.classifierRetentionHours} disabled={!state.settings.autoCleanupClassifierCache} onChange={(event) => void saveAutoCleanup({ classifierRetentionHours: Number(event.target.value) })} aria-label="自动清理保留时间">
        <option value={24}>24 小时后</option><option value={72}>3 天后</option><option value={168}>7 天后</option><option value={720}>30 天后</option>
      </select>
      <button type="button" role="switch" aria-checked={state.settings.autoCleanupClassifierCache} className={`storage-switch ${state.settings.autoCleanupClassifierCache ? "on" : ""}`} onClick={() => void saveAutoCleanup({ autoCleanupClassifierCache: !state.settings.autoCleanupClassifierCache })}><i /></button>
    </section>
    {state.classifierCleanupBlockedReason && <p className="storage-blocked-note"><AlertTriangle size={14} />{state.classifierCleanupBlockedReason}，相关打标缓存已保留，不会自动清理。</p>}
    <p className="storage-safety-note"><ShieldCheck size={15} />不会清理分类方案、API 配置、授权信息、媒体库索引、原素材、输出结果或正在运行的任务。</p>
  </div>;
}

const emptyQianchuanIntegrationStatus: QianchuanIntegrationStatus = {
  success: true,
  configured: false,
  app_id: "",
  secret_configured: false,
  callback_url: "https://api.dadaozixun.com/qianchuan/callback",
  callback_confirmed: false,
  tested: false,
  tested_at: "",
  authorized: false,
  material_authorized: false,
  authorizations: [],
};

const qianchuanBrowserPreferenceKey = "ai-media-library:qianchuan-browser-mode";

function QianchuanIntegrationPanel({ notify }: { notify: (message: string) => void }) {
  const [status, setStatus] = useState<QianchuanIntegrationStatus>(emptyQianchuanIntegrationStatus);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "callback" | "test" | "portal" | "authorize" | "revoke" | null>(null);
  const [flowId, setFlowId] = useState("");
  const [oauthState, setOauthState] = useState<QianchuanOAuthPollState | null>(null);
  const [authorizationHealthError, setAuthorizationHealthError] = useState("");
  const [error, setError] = useState("");
  const [browserMode, setBrowserMode] = useState<QianchuanBrowserMode>(() => {
    if (typeof window === "undefined") return "embedded";
    return window.localStorage.getItem(qianchuanBrowserPreferenceKey) === "system" ? "system" : "embedded";
  });

  useEffect(() => {
    window.localStorage.setItem(qianchuanBrowserPreferenceKey, browserMode);
  }, [browserMode]);

  const applyStatus = useCallback((next: QianchuanIntegrationStatus) => {
    setStatus(next);
    setAppId(next.app_id || "");
  }, []);

  const loadStatus = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge?.qianchuanConfigStatus) {
      setStatus(emptyQianchuanIntegrationStatus);
      setLoading(false);
      return;
    }
    try {
      const next = await bridge.qianchuanConfigStatus();
      applyStatus(next);
      setError("");
      if ((next.authorized || next.authorizations.length > 0) && bridge.qianchuanBootstrap) {
        try {
          await bridge.qianchuanBootstrap();
          setAuthorizationHealthError("");
        } catch (bootstrapError) {
          const message = bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError);
          setAuthorizationHealthError(/(?:授权已过期|重新授权)/.test(message)
            ? "千川账户访问授权已过期；应用配置无需修改，请重新完成一次官方授权。"
            : "");
        }
      } else {
        setAuthorizationHealthError("");
      }
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : "千川接入状态读取失败");
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadStatus(), 0);
    return () => window.clearTimeout(timer);
  }, [loadStatus]);

  useEffect(() => {
    if (!flowId || !window.desktopBridge?.qianchuanOAuthPoll) return undefined;
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await window.desktopBridge!.qianchuanOAuthPoll(flowId);
        if (stopped) return;
        setOauthState(next);
        if (next.status === "success") {
          window.clearInterval(timer);
          setFlowId("");
          await loadStatus();
          notify("千川账户授权成功");
        } else if (next.status === "failed" || next.status === "expired") {
          window.clearInterval(timer);
          setFlowId("");
          setError(next.message);
        }
      } catch (pollError) {
        if (!stopped) setError(pollError instanceof Error ? pollError.message : "授权状态读取失败");
      }
    };
    timer = window.setInterval(() => void poll(), 2000);
    void poll();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [flowId, loadStatus, notify]);

  const copyCallback = async () => {
    try {
      await navigator.clipboard.writeText(status.callback_url);
      notify("回调地址已复制，请粘贴到巨量引擎开放平台");
    } catch {
      setError("回调地址复制失败，请选中地址后手动复制");
    }
  };

  const openDeveloperPortal = async () => {
    const bridge = window.desktopBridge;
    if (!bridge?.qianchuanOpenDeveloperPortal) return notify("巨量引擎开发者后台仅支持桌面版内置浏览器");
    setBusy("portal");
    setError("");
    try {
      await bridge.qianchuanOpenDeveloperPortal(browserMode);
      notify(browserMode === "system" ? "已用系统默认浏览器打开巨量引擎开发者后台" : "已在软件内打开巨量引擎开发者后台");
    } catch (portalError) {
      setError(portalError instanceof Error ? portalError.message : "开发者后台打开失败");
    } finally {
      setBusy(null);
    }
  };

  const saveConfig = async () => {
    const bridge = window.desktopBridge;
    if (!bridge?.qianchuanConfigSave) return notify("千川接入配置仅支持桌面版");
    setBusy("save");
    setError("");
    try {
      const next = await bridge.qianchuanConfigSave({ app_id: appId.trim(), app_secret: appSecret.trim() });
      applyStatus(next);
      setAppSecret("");
      setShowSecret(false);
      setOauthState(null);
      notify("千川应用信息已加密保存");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "千川应用信息保存失败");
    } finally {
      setBusy(null);
    }
  };

  const confirmCallback = async () => {
    const bridge = window.desktopBridge;
    if (!bridge?.qianchuanConfigConfirmCallback) return notify("千川接入配置仅支持桌面版");
    setBusy("callback");
    setError("");
    try {
      applyStatus(await bridge.qianchuanConfigConfirmCallback());
      notify("已确认回调地址，下一步请测试配置");
    } catch (callbackError) {
      setError(callbackError instanceof Error ? callbackError.message : "回调地址确认失败");
    } finally {
      setBusy(null);
    }
  };

  const testConfig = async () => {
    const bridge = window.desktopBridge;
    if (!bridge?.qianchuanConfigTest) return notify("千川接入配置仅支持桌面版");
    setBusy("test");
    setError("");
    try {
      const next = await bridge.qianchuanConfigTest();
      applyStatus(next);
      notify(next.message || "千川配置检查通过");
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "千川配置测试失败");
    } finally {
      setBusy(null);
    }
  };

  const startAuthorization = async () => {
    const bridge = window.desktopBridge;
    if (!bridge?.qianchuanOAuthStart) return notify("千川官方授权仅支持桌面版");
    setBusy("authorize");
    setError("");
    setOauthState(null);
    try {
      const result = await bridge.qianchuanOAuthStart(browserMode);
      setFlowId(result.flow_id);
      setOauthState({ success: true, status: "pending", authorization_id: "", message: `请在${browserMode === "system" ? "系统默认浏览器" : "软件内置浏览器"}的官方页面完成授权，并按需要勾选敏感物料权限` });
      notify(`已用${browserMode === "system" ? "系统默认浏览器" : "软件内置浏览器"}打开千川官方授权页面`);
    } catch (authorizeError) {
      setError(authorizeError instanceof Error ? authorizeError.message : "千川授权页面打开失败");
    } finally {
      setBusy(null);
    }
  };

  const reopenAuthorization = async () => {
    const bridge = window.desktopBridge;
    if (!flowId || !bridge?.qianchuanOAuthReopen) return notify("当前没有可重新打开的授权流程");
    setBusy("authorize");
    setError("");
    try {
      await bridge.qianchuanOAuthReopen(flowId, browserMode);
      notify(`已用${browserMode === "system" ? "系统默认浏览器" : "软件内置浏览器"}重新打开本次授权页面`);
    } catch (reopenError) {
      setFlowId("");
      setOauthState(null);
      setError(reopenError instanceof Error ? reopenError.message : "千川授权页面重新打开失败");
    } finally {
      setBusy(null);
    }
  };

  const revokeAuthorization = async (authorizationId: string) => {
    const bridge = window.desktopBridge;
    if (!bridge?.qianchuanOAuthRevoke) return notify("解除千川授权仅支持桌面版");
    setBusy("revoke");
    setError("");
    try {
      await bridge.qianchuanOAuthRevoke(authorizationId);
      await loadStatus();
      notify("已解除该千川账户授权");
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "解除千川授权失败");
    } finally {
      setBusy(null);
    }
  };

  const coreStepState = [
    status.configured,
    status.callback_confirmed,
    status.tested,
  ];
  const hasAccountAuthorization = status.authorized || status.authorizations.length > 0;
  const needsFirstAuthorization = status.tested && !hasAccountAuthorization;
  const needsMaterialAuthorization = status.tested && hasAccountAuthorization && !status.material_authorized;
  const authorizationExpired = Boolean(authorizationHealthError);
  const showAuthorizationAssist = Boolean(flowId || needsFirstAuthorization || needsMaterialAuthorization || authorizationExpired);
  const connectionReady = status.tested && hasAccountAuthorization && !authorizationExpired;

  return <div className="qianchuan-integration-content">
    <section className="qianchuan-integration-hero">
      <div><span className="api-settings-kicker">QIANCHUAN OPEN API</span><h2>千川 API 接入</h2><p>完成应用、回调和配置测试后，已有有效账户授权的用户可以直接使用；首次连接或缺少敏感物料权限时再补充官方授权。</p></div>
      <div className="qianchuan-hero-actions"><fieldset className="qianchuan-browser-choice"><legend>网页打开方式</legend><button type="button" className={browserMode === "system" ? "active" : ""} onClick={() => setBrowserMode("system")}>系统默认浏览器</button><button type="button" className={browserMode === "embedded" ? "active" : ""} onClick={() => setBrowserMode("embedded")}>软件内置浏览器</button></fieldset><span className={`api-config-status ${connectionReady ? "ready" : "empty"}`}>{authorizationExpired ? "需重新授权" : connectionReady ? status.material_authorized ? "可直接使用" : "基础授权可用" : status.tested ? "需首次授权" : status.configured ? "配置中" : "未配置"}</span></div>
    </section>

    <ol className="qianchuan-setup-steps" aria-label="千川接入进度">
      {["配置应用", "设置回调", "测试配置"].map((label, index) => <li key={label} className={`${coreStepState[index] ? "done" : ""} ${!coreStepState[index] && (index === 0 || coreStepState[index - 1]) ? "current" : ""}`}><i>{coreStepState[index] ? <Check size={14} /> : index + 1}</i><span><small>步骤 {index + 1}</small><strong>{label}</strong></span>{index < 2 && <b />}</li>)}
    </ol>

    <div className={`qianchuan-setup-grid ${showAuthorizationAssist ? "needs-authorization" : "ready"}`}>
      <section className={`qianchuan-step-card ${status.configured ? "complete" : "active"}`}>
        <header><i>1</i><div><h3>填写自己的开放平台应用</h3><p>在巨量引擎开放平台创建应用后，复制 APP ID 和 APP Secret。</p></div></header>
        <div className="qianchuan-config-fields">
          <label><span>APP ID</span><input value={appId} onChange={(event) => setAppId(event.target.value.replace(/\D/g, "").slice(0, 32))} inputMode="numeric" placeholder="请输入开放平台 APP ID" disabled={loading || busy !== null} /></label>
          <label><span>APP Secret</span><div><input type={showSecret ? "text" : "password"} value={appSecret} onChange={(event) => setAppSecret(event.target.value)} placeholder={status.secret_configured ? "已加密保存；留空保持不变" : "请输入开放平台 APP Secret"} autoComplete="new-password" disabled={loading || busy !== null} /><button type="button" aria-label={showSecret ? "隐藏 APP Secret" : "显示 APP Secret"} onClick={() => setShowSecret((value) => !value)} disabled={!appSecret}>{showSecret ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>
        </div>
        <footer><button type="button" className="secondary" disabled={busy !== null} onClick={() => void openDeveloperPortal()}><Globe2 size={14} />{busy === "portal" ? "正在打开…" : "打开开发者后台"}</button><button type="button" className="primary" disabled={busy !== null || !/^\d{8,32}$/.test(appId) || (!status.secret_configured && appSecret.trim().length < 8)} onClick={() => void saveConfig()}>{busy === "save" ? "正在保存…" : status.configured ? "更新应用信息" : "保存并进入下一步"}</button></footer>
      </section>

      <section className={`qianchuan-step-card ${status.callback_confirmed ? "complete" : status.configured ? "active" : "locked"}`}>
        <header><i>2</i><div><h3>设置固定回调地址</h3><p>复制下方地址，粘贴到开放平台应用的“回调地址”中并保存。</p></div></header>
        <div className="qianchuan-callback-box"><code>{status.callback_url}</code><button type="button" onClick={() => void copyCallback()} disabled={!status.configured}><Copy size={14} />复制</button></div>
        <footer><span>回调地址由软件固定，不能改成其他地址。</span><button type="button" className="primary" disabled={!status.configured || busy !== null} onClick={() => void confirmCallback()}>{busy === "callback" ? "正在确认…" : status.callback_confirmed ? "重新确认" : "我已在后台设置完成"}</button></footer>
      </section>

      <section className={`qianchuan-step-card ${status.tested ? "complete" : status.callback_confirmed ? "active" : "locked"}`}>
        <header><i>3</i><div><h3>测试应用配置</h3><p>检查 APP ID、Secret 加密状态及回调流程；官方授权会最终验证 Secret。</p></div></header>
        <div className="qianchuan-check-list"><span><ShieldCheck size={15} />APP Secret 仅加密保存在服务器，不写入本机配置和日志</span><span><ShieldCheck size={15} />请求按当前软件授权设备隔离，其他用户无法读取</span></div>
        <footer><span>{status.tested ? `最近通过：${formatServerDate(status.tested_at)}` : "完成前两步后即可测试"}</span><button type="button" className="primary" disabled={!status.callback_confirmed || busy !== null} onClick={() => void testConfig()}><RefreshCw size={14} className={busy === "test" ? "spin" : ""} />{busy === "test" ? "正在测试…" : status.tested ? "重新测试" : "测试配置"}</button></footer>
      </section>

      {showAuthorizationAssist && <section className={`qianchuan-step-card qianchuan-optional-authorization ${flowId ? "active" : "attention"}`}>
        <header><i><KeyRound size={14} /></i><div><h3>{authorizationExpired ? "重新授权千川账户" : needsMaterialAuthorization ? "补充敏感物料权限" : "首次连接千川账户"}<em>{authorizationExpired ? "需要处理" : "按需操作"}</em></h3><p>{authorizationExpired ? "APP ID、APP Secret 和回调地址都不需修改；只需重新完成一次千川官方 OAuth 授权。" : needsMaterialAuthorization ? "基础账户已经授权；只有读取、预览或下载视频原文件时，才需要重新授权敏感物料。" : "配置测试只验证开发者应用，第一次读取客户账户数据仍需完成一次千川官方 OAuth 授权。"}</p></div></header>
        <div className={`qianchuan-oauth-state ${oauthState?.status || (authorizationExpired ? "expired" : "idle")}`}>{flowId && <RefreshCw size={15} className="spin" />}<span>{oauthState?.message || authorizationHealthError || (needsMaterialAuthorization ? "检测到现有账户缺少敏感物料权限" : "尚未发现当前应用的有效账户授权")}</span></div>
        <footer><span>{flowId ? "授权页关闭后可以重新打开同一次流程。" : `将使用${browserMode === "system" ? "系统默认浏览器" : "软件内置浏览器"}；账号密码仅在千川官方页面输入。`}</span><button type="button" className="primary" disabled={!status.tested || busy !== null} onClick={() => void (flowId ? reopenAuthorization() : startAuthorization())}><KeyRound size={14} />{busy === "authorize" ? "正在打开…" : flowId ? "重新打开授权页面" : authorizationExpired ? "重新授权千川账户" : needsMaterialAuthorization ? "补充敏感物料授权" : "首次授权账户"}</button></footer>
      </section>}
    </div>

    <section className="qianchuan-authorized-card">
      <header><div><h3>已授权账户</h3><p>这里只显示账户标识，不显示访问令牌或 APP Secret。</p></div><div className="qianchuan-authorized-actions"><button type="button" onClick={() => void startAuthorization()} disabled={!status.tested || busy !== null}><KeyRound size={14} />授权其他账户</button><button type="button" onClick={() => void loadStatus()} disabled={loading || busy !== null}><RefreshCw size={14} />刷新</button></div></header>
      {status.authorizations.length ? <div className="qianchuan-authorized-list">{status.authorizations.map((authorization) => <div key={authorization.authorization_id} className={authorization.material_authorized ? "" : "permission-missing"}><span className="qianchuan-account-mark">{authorization.material_authorized ? <Check size={15} /> : <AlertTriangle size={15} />}</span><div><strong>{authorization.account_name}</strong><small>{authorization.account_id ? `账户 ID ${authorization.account_id}` : "账户信息同步中"} · {formatServerDate(authorization.updated_at)}</small></div><em>{authorization.material_authorized ? "素材权限已授权" : "缺少敏感物料权限"}</em><button type="button" disabled={busy !== null} onClick={() => void revokeAuthorization(authorization.authorization_id)}>解除授权</button></div>)}</div> : <div className="qianchuan-empty-authorization"><KeyRound size={20} /><span>{loading ? "正在读取千川接入状态…" : "尚未授权千川账户，完成上方步骤后会显示在这里。"}</span></div>}
    </section>

    {error && <div className="qianchuan-integration-error" role="alert"><AlertTriangle size={15} />{error}</div>}
    <p className="qianchuan-security-note"><LockKeyhole size={14} />媒体库不会保存千川账号密码；APP Secret 和授权令牌均不会出现在普通日志、前端源码或本地配置中。</p>
  </div>;
}

function ApiSettingsPage({ notify, licenseState, onLicenseStateChange, updateState, onUpdateCheck, onOpenSubtitles, initialSection = "api" }: {
  onOpenSubtitles: () => void;
  initialSection?: "api" | "aliyun";
  notify: (message: string) => void;
  licenseState: LicenseState;
  onLicenseStateChange: (state: LicenseState) => void;
  updateState: UpdateState;
  onUpdateCheck: () => void;
}) {
  const [settings, setSettings] = useState<ApiSettingsState>(initialApiSettings);
  const [volcengineKey, setVolcengineKey] = useState("");
  const [relayKey, setRelayKey] = useState("");
  const [minimaxKey, setMinimaxKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState<"classification" | "minimax" | null>(null);
  const [connectionResults, setConnectionResults] = useState<Record<"classification" | "minimax", { ok: boolean; message: string } | null>>({ classification: null, minimax: null });
  const [settingsSection, setSettingsSection] = useState<"api" | "qianchuan" | "storage" | "models" | "aliyun">(initialSection);

  useEffect(() => {
    // 只在设置页挂载时读取一次，避免父页面刷新时用已保存值覆盖用户正在输入的 Endpoint ID。
    const bridge = window.desktopBridge;
    if (!bridge?.apiSettingsGet) {
      const timer = window.setTimeout(() => setLoading(false), 0);
      return () => window.clearTimeout(timer);
    }
    bridge.apiSettingsGet()
      .then(setSettings)
      .catch((error) => notify(error instanceof Error ? error.message : "API 设置读取失败"))
      .finally(() => setLoading(false));
    return undefined;
  }, []);

  const selectClassificationProvider = (provider: "volcengine" | "relay") => {
    setSettings((current) => ({ ...current, classification: { ...current.classification, provider } }));
    setConnectionResults((current) => ({ ...current, classification: null }));
  };

  const updateVolcengine = (endpointId: string) => {
    setSettings((current) => ({
      ...current,
      classification: { ...current.classification, volcengine: { ...current.classification.volcengine, endpointId } },
    }));
    setConnectionResults((current) => ({ ...current, classification: null }));
  };

  const updateRelay = <K extends keyof ApiSettingsState["classification"]["relay"]>(
    key: K,
    value: ApiSettingsState["classification"]["relay"][K],
  ) => {
    setSettings((current) => ({
      ...current,
      classification: { ...current.classification, relay: { ...current.classification.relay, [key]: value } },
    }));
    setConnectionResults((current) => ({ ...current, classification: null }));
  };

  const classificationReady = settings.classification.provider === "volcengine"
    ? settings.classification.volcengine.endpointId.trim().startsWith("ep-")
      && (settings.classification.volcengine.apiKeyConfigured || Boolean(volcengineKey.trim()))
    : Boolean(
      settings.classification.relay.baseUrl.trim()
      && settings.classification.relay.textModel.trim()
      && settings.classification.relay.visionModel.trim()
      && (settings.classification.relay.apiKeyConfigured || relayKey.trim()),
    );
  const minimaxReady = Boolean(
    settings.minimax.model.trim()
    && (settings.minimax.apiKeyConfigured || minimaxKey.trim()),
  );
  const settingsIncomplete = !classificationReady || !minimaxReady;

  const updateMinimax = <K extends keyof ApiSettingsState["minimax"]>(
    key: K,
    value: ApiSettingsState["minimax"][K],
  ) => {
    setSettings((current) => ({ ...current, minimax: { ...current.minimax, [key]: value } }));
    setConnectionResults((current) => ({ ...current, minimax: null }));
  };

  const settingsPayload = (): ApiSettingsSavePayload => ({
    classification: {
      provider: settings.classification.provider,
      volcengine: { endpointId: settings.classification.volcengine.endpointId, apiKey: volcengineKey },
      relay: {
        baseUrl: settings.classification.relay.baseUrl,
        textModel: settings.classification.relay.textModel,
        visionModel: settings.classification.relay.visionModel,
        apiKey: relayKey,
      },
    },
    minimax: {
      model: settings.minimax.model,
      groupId: settings.minimax.groupId,
      apiKey: minimaxKey,
    },
  });

  const testConnection = async (kind: "classification" | "minimax") => {
    const bridge = window.desktopBridge;
    if (!bridge?.apiSettingsTest) {
      notify("连接测试仅支持桌面版");
      return;
    }
    setTestingConnection(kind);
    setConnectionResults((current) => ({ ...current, [kind]: null }));
    try {
      const result = await bridge.apiSettingsTest(kind, settingsPayload());
      setConnectionResults((current) => ({ ...current, [kind]: { ok: true, message: result.message } }));
      notify(result.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "连接测试失败";
      setConnectionResults((current) => ({ ...current, [kind]: { ok: false, message } }));
      notify(message);
    } finally {
      setTestingConnection(null);
    }
  };

  const save = async () => {
    const bridge = window.desktopBridge;
    if (!bridge?.apiSettingsSave) {
      notify("API 设置仅支持桌面版");
      return;
    }
    setSaving(true);
    try {
      const next = await bridge.apiSettingsSave(settingsPayload());
      setSettings(next);
      setVolcengineKey("");
      setRelayKey("");
      setMinimaxKey("");
      notify("API 设置已保存并立即生效");
    } catch (error) {
      notify(error instanceof Error ? error.message : "API 设置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const resetOfflineAuthorization = async () => {
    const bridge = window.desktopBridge;
    if (!bridge?.licenseRefresh) {
      notify("桌面授权接口不可用");
      throw new Error("桌面授权接口不可用");
    }
    try {
      const next = await bridge.licenseRefresh({ resetOfflineCache: true });
      onLicenseStateChange(next);
      notify(next.authorized ? "离线缓存已重置，联网授权验证成功" : next.message || "离线缓存已清除，请连接网络完成授权验证");
    } catch (error) {
      notify(error instanceof Error ? error.message : "离线缓存重置失败");
      throw error;
    }
  };

  return (
    <section className="api-settings-page">
      <header className="api-settings-heading">
        <div className="api-settings-heading-icon workspace-heading-icon"><Settings /></div>
        <div><div className="feature-title-line"><h1>设置</h1><ContactAuthorButton appName={licenseState.appName} /></div><p>{settingsSection === "storage" ? "管理软件占用、自动清理与本地文件。" : settingsSection === "qianchuan" ? "按顺序连接用户自己的巨量千川开放平台应用与账户。" : settingsSection === "models" ? "由使用者填写自己的模型 API，密钥仅保存在当前电脑。" : settingsSection === "aliyun" ? "阿里云去字幕服务的独立配置入口。" : "管理软件授权、查看版本与检查更新。"}</p></div>
      </header>

      <nav className="settings-section-tabs" aria-label="设置分类">
        <button type="button" className={settingsSection === "api" ? "active" : ""} onClick={() => setSettingsSection("api")}><Settings size={15} />授权与更新</button>
        <button type="button" className={settingsSection === "qianchuan" ? "active" : ""} onClick={() => setSettingsSection("qianchuan")}><KeyRound size={15} />千川接入</button>
        <button type="button" className={settingsSection === "storage" ? "active" : ""} onClick={() => setSettingsSection("storage")}><HardDrive size={15} />存储管理</button>
        <button type="button" className={settingsSection === "models" ? "active" : ""} onClick={() => setSettingsSection("models")}><Mic2 size={15} />火山引擎与 MiniMax</button>
        <button type="button" className={settingsSection === "aliyun" ? "active" : ""} onClick={() => setSettingsSection("aliyun")}><Film size={15} />阿里云去字幕</button>
      </nav>

      {settingsSection === "storage" && <StorageManagementPanel notify={notify} />}
      {settingsSection === "qianchuan" && <QianchuanIntegrationPanel notify={notify} />}
      {settingsSection === "api" && <div className="api-settings-content">
        <LicenseManagement state={licenseState} onStateChange={onLicenseStateChange} notify={notify} />
        <SoftwareUpdateCard state={updateState} onCheck={onUpdateCheck} onOfflineReset={resetOfflineAuthorization} />
      </div>}
      {settingsSection === "models" && <div className="api-settings-content">
        <section className="api-settings-card classification-api-card">
          <div className="api-settings-card-title">
            <div><span className="api-settings-kicker">CLASSIFICATION API</span><h2>分类模型</h2><p>{settings.classification.provider === "volcengine" ? "同一个推理接入点同时用于分类方案和素材分类。" : "可分别填写分类方案文本模型与素材分类视觉模型。"}</p></div>
            <span className={`api-config-status ${(settings.classification.provider === "volcengine" ? settings.classification.volcengine.apiKeyConfigured : settings.classification.relay.apiKeyConfigured) ? "ready" : "empty"}`}>{(settings.classification.provider === "volcengine" ? settings.classification.volcengine.apiKeyConfigured : settings.classification.relay.apiKeyConfigured) ? "已配置" : "未配置"}</span>
          </div>

          <div className="api-provider-options" role="radiogroup" aria-label="分类 API 类型">
            <button type="button" role="radio" aria-checked={settings.classification.provider === "volcengine"} className={settings.classification.provider === "volcengine" ? "active" : ""} onClick={() => selectClassificationProvider("volcengine")}>
              <strong>火山引擎</strong><span>固定使用火山方舟 OpenAI 兼容接口</span>
            </button>
            <button type="button" role="radio" aria-checked={settings.classification.provider === "relay"} className={settings.classification.provider === "relay" ? "active" : ""} onClick={() => selectClassificationProvider("relay")}>
              <strong>任意中转</strong><span>填写支持 /chat/completions 的中转地址</span>
            </button>
          </div>

          <div className="api-settings-form-grid">
            {settings.classification.provider === "volcengine" ? (
              <>
                <label className="api-setting-field api-setting-wide"><span>火山引擎 Base URL</span><input value="https://ark.cn-beijing.volces.com/api/v3" readOnly /><small>火山引擎地址固定，无需修改。</small></label>
                <label className="api-setting-field api-setting-wide"><span>火山引擎 Endpoint ID</span><input value={settings.classification.volcengine.endpointId} onChange={(event) => updateVolcengine(event.target.value)} placeholder="ep-xxxxxxxx" /><small>填写火山方舟控制台中以 ep- 开头的推理接入点 ID。</small></label>
                <label className="api-setting-field api-setting-wide"><span>火山引擎 API Key</span><input type="password" value={volcengineKey} onChange={(event) => { setVolcengineKey(event.target.value); setConnectionResults((current) => ({ ...current, classification: null })); }} placeholder={settings.classification.volcengine.apiKeyConfigured ? "火山引擎 Key 已保存；留空保持不变" : "请输入火山引擎 API Key"} autoComplete="new-password" /><small>只用于火山方舟，不与中转 API Key 共用。</small></label>
              </>
            ) : (
              <>
                <label className="api-setting-field api-setting-wide"><span>中转 Base URL</span><input value={settings.classification.relay.baseUrl} onChange={(event) => updateRelay("baseUrl", event.target.value)} placeholder="https://example.com/v1" /><small>填写支持 /chat/completions 的完整版本路径。</small></label>
                <label className="api-setting-field"><span>中转文本模型</span><input value={settings.classification.relay.textModel} onChange={(event) => updateRelay("textModel", event.target.value)} placeholder="gpt-5.5" /></label>
                <label className="api-setting-field"><span>中转视觉模型</span><input value={settings.classification.relay.visionModel} onChange={(event) => updateRelay("visionModel", event.target.value)} placeholder="gpt-5.5" /></label>
                <label className="api-setting-field api-setting-wide"><span>中转 API Key</span><input type="password" value={relayKey} onChange={(event) => { setRelayKey(event.target.value); setConnectionResults((current) => ({ ...current, classification: null })); }} placeholder={settings.classification.relay.apiKeyConfigured ? "中转 Key 已保存；留空保持不变" : "请输入中转 API Key"} autoComplete="new-password" /><small>只用于任意中转，不与火山引擎 API Key 共用。</small></label>
              </>
            )}
          </div>
          <div className="api-test-row">
            <button type="button" disabled={loading || saving || testingConnection !== null} onClick={() => void testConnection("classification")}><RefreshCw size={13} />{testingConnection === "classification" ? "正在测试…" : "测试分类模型连接"}</button>
            {connectionResults.classification && <span className={connectionResults.classification.ok ? "success" : "error"} role="status">{connectionResults.classification.message}</span>}
          </div>
        </section>

        <section className="api-settings-card minimax-api-card">
          <div className="api-settings-card-title">
            <div><span className="api-settings-kicker">VOICE API</span><h2>MiniMax 声音克隆</h2><p>仅用于上传新声音并生成可下载试听，不正式启用音色。</p></div>
            <span className={`api-config-status ${settings.minimax.apiKeyConfigured ? "ready" : "empty"}`}>{settings.minimax.apiKeyConfigured ? "已配置" : "未配置"}</span>
          </div>
          <div className="api-settings-form-grid">
            <label className="api-setting-field"><span>服务商</span><input value="MiniMax" readOnly /></label>
            <label className="api-setting-field"><span>Base URL</span><input value={settings.minimax.baseUrl} readOnly /><small>默认使用 MiniMax 中国区接口</small></label>
            <label className="api-setting-field"><span>语音模型</span><select value={settings.minimax.model} onChange={(event) => updateMinimax("model", event.target.value)}><option value="speech-2.8-turbo">speech-2.8-turbo</option><option value="speech-2.8-hd">speech-2.8-hd</option><option value="speech-2.6-turbo">speech-2.6-turbo</option><option value="speech-2.6-hd">speech-2.6-hd</option></select></label>
            <label className="api-setting-field"><span>Group ID（选填）</span><input value={settings.minimax.groupId} onChange={(event) => updateMinimax("groupId", event.target.value)} placeholder="新版 API Key 通常无需填写" /></label>
            <label className="api-setting-field api-setting-wide"><span>MiniMax API Key</span><input type="password" value={minimaxKey} onChange={(event) => { setMinimaxKey(event.target.value); setConnectionResults((current) => ({ ...current, minimax: null })); }} placeholder={settings.minimax.apiKeyConfigured ? "已保存；留空保持不变" : "请输入 MiniMax API Key"} autoComplete="new-password" /></label>
          </div>
          <div className="api-test-row">
            <button type="button" disabled={loading || saving || testingConnection !== null} onClick={() => void testConnection("minimax")}><RefreshCw size={13} />{testingConnection === "minimax" ? "正在测试…" : "测试 MiniMax 连接"}</button>
            {connectionResults.minimax && <span className={connectionResults.minimax.ok ? "success" : "error"} role="status">{connectionResults.minimax.message}</span>}
          </div>
        </section>

        <footer className="api-settings-actions">
          <div><strong>本地直连</strong><span>软件直接请求所选模型服务，不经过统一中转后台。</span></div>
          <div className="api-settings-action-buttons">
            <button className="secondary" type="button" onClick={() => window.desktopBridge?.openProductGuide()}>产品使用教程</button>
            <div className="api-settings-save-area">
              {settingsIncomplete && <span className="api-settings-incomplete-hint" role="status">请补全必填项；保存时会校验格式</span>}
              <button type="button" disabled={loading || saving} onClick={save}>{loading ? "正在读取" : saving ? "正在保存" : "保存 API 设置"}</button>
            </div>
          </div>
        </footer>
      </div>}
      {settingsSection === "aliyun" && <AliyunSubtitleSettings notify={notify} onStart={onOpenSubtitles} />}
    </section>
  );
}

const classifierOutputDirectoryStorageKey = "classifier-output-directory-v1";
const classifierNamingOptionsStorageKey = "classifier-run-naming-options-v1";
const classifierSplitPrecisionStorageKey = "classifier-split-precision-v1";
const classifierTemplateDraftStorageKey = "classifier-template-editor-draft-v1";
const activeApplicationModuleStorageKey = "active-application-module-v1";
const applicationModules = featureRegistry.list().map((feature) => feature.id);
type ApplicationModule = string;
const featureMenuIcons: Record<string, typeof Images> = {
  media: Images, "qianchuan-videos": Film, "viral-visuals": Images, "viral-copy": FileSpreadsheet,
  "subtitle-removal": Film, downloads: Download, schemes: Tag, classifier: Boxes, voice: Mic2, settings: Settings,
};

function formatClassifierProgressLogs(messages: string[], command: ClassifierRunPayload["command"]) {
  return messages.flatMap((sourceMessage) => {
    const message = sourceMessage.trim();
    if (!message) return [];

    const discovery = message.match(/^找到\s+(\d+)\s+个素材，本次需要识别\s+(\d+)\s+个。(.*)$/);
    if (discovery) {
      const [, total, pending, details] = discovery;
      return [
        `打标模式：${details.trim().replace(/[.。]$/, "")}`,
        `找到 ${total} 个素材文件，本次准备打标 ${pending} 个...`,
      ];
    }

    const recognized = message.match(/^\[(\d+)\/(\d+)\]\s+已识别\s+(.+?)\s+->\s+(.+)$/);
    if (recognized) {
      const [, current, total, fileName, result] = recognized;
      return [
        `开始处理：${fileName}`,
        `打标结果：${result}`,
        `打标进度：${current}/${total}`,
      ];
    }

    const failed = message.match(/^\[(\d+)\/(\d+)\]\s+识别失败\s+(.+?)(?:，(.*))?$/);
    if (failed) {
      const [, current, total, fileName, reason] = failed;
      return [
        `开始处理：${fileName}`,
        `打标失败：${fileName}${reason ? `；${reason}` : ""}`,
        `打标进度：${current}/${total}`,
      ];
    }

    const splitStart = message.match(/^\[(\d+)\/(\d+)\]\s+拆解\s+(.+)$/);
    if (splitStart) {
      const [, current, total, fileName] = splitStart;
      return [
        `开始处理：${fileName}`,
        `开始场景检测：${fileName}`,
        `视频进度：${current}/${total}`,
      ];
    }

    const splitDetected = message.match(/^检测到\s+(\d+)\s+个镜头，并行导出\s+(\d+)\s+路$/);
    if (splitDetected) {
      const shotCount = Number(splitDetected[1]);
      return [
        `检测到 ${Math.max(0, shotCount - 1)} 个场景变化点`,
        `已分割为 ${shotCount} 个分镜（并行导出 ${splitDetected[2]} 路）`,
      ];
    }

    const shotProgress = message.match(/^镜头\s+(\d+)\/(\d+)$/);
    if (shotProgress) return [`分析分镜 ${shotProgress[1]}/${shotProgress[2]}`];
    if (message === "整理完成。" && command !== "split") return ["打标完成。"];
    if (message.startsWith("已复制到 ")) return [message.replace(/^已复制到 /, "已输出：").replace(/，源文件保留不动$/, "（源文件保留）")];
    if (message.startsWith("请求账本：")) return [message.replace("请求账本：", "模型请求：")];
    return [message];
  });
}

function extractClassifierOutputFiles(messages: string[]) {
  return [...new Set(messages.flatMap((sourceMessage) => {
    const match = sourceMessage.trim().match(/^已复制到\s+(.+?)，源文件保留不动$/);
    return match?.[1]?.trim() ? [match[1].trim()] : [];
  }))];
}

function classifierPreviewLabels(value: string) {
  return [...new Set(value
    .split(/\s*(?:\/|\\|>|→|｜|\||—|–)\s*/)
    .map((item) => item.replace(/^\d+[_\s.-]*/, "").trim())
    .filter((item) => item && item.length <= 36))].slice(0, 6);
}

function classifierPreviewItemFromMedia(record: ClassifierPreviewMediaRecord): ClassifierPreviewItem {
  const isSegment = record.preview.tags.length === 0
    && (record.preview.segmentIndex !== null || Boolean(record.preview.timeRange));
  return {
    id: `media:${record.path}`,
    title: record.preview.title || record.name,
    sourceName: record.preview.sourceName || record.name,
    path: record.path,
    kind: isSegment ? "segment" : "tag",
    status: "completed",
    tags: record.preview.tags,
    timeRange: record.preview.timeRange,
    media: record,
  };
}

function mergeClassifierPreviewItems(current: ClassifierPreviewItem[], incoming: ClassifierPreviewItem[]) {
  const next = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) next.set(item.id, item);
  return [...next.values()];
}

function classifierPreviewBaseName(value: string) {
  return String(value || "").replace(/\\/g, "/").split("/").pop()?.trim().toLowerCase() || "";
}

function classifierPreviewMatchesSource(item: ClassifierPreviewItem, sourceName: string) {
  const expected = classifierPreviewBaseName(sourceName);
  if (!expected) return false;
  return [item.sourceName, item.path, item.media?.name || ""]
    .some((candidate) => classifierPreviewBaseName(candidate) === expected);
}

function ClassifierWorkbench({
  notify,
  handoff,
  onClearHandoff,
  onCompleted,
  appName,
  view = "workbench",
}: {
  notify: (message: string) => void;
  handoff: ClassifierHandoff | null;
  onClearHandoff: () => void;
  onCompleted: (outputPath: string, outputFiles?: string[], allowGeneratedFolderScan?: boolean) => Promise<number>;
  appName: string;
  view?: "workbench" | "schemes";
}) {
  const [folder, setFolder] = useState(handoff?.folder ?? "");
  const [inputLabel, setInputLabel] = useState(handoff?.label ?? "");
  const [inputCount, setInputCount] = useState(handoff?.count ?? 0);
  const [inputMediaCounts, setInputMediaCounts] = useState<ClassifierMediaCounts>(handoff?.mediaCounts ?? { image: 0, video: 0 });
  const [inputPaths, setInputPaths] = useState<string[]>(() => handoff?.paths?.length ? handoff.paths : handoff?.folder ? [handoff.folder] : []);
  const [preparingInput, setPreparingInput] = useState(false);
  const [inputDragActive, setInputDragActive] = useState(false);
  const [outputRoot, setOutputRoot] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(classifierOutputDirectoryStorageKey) ?? "";
  });
  const [templates, setTemplates] = useState<ClassifierTemplate[]>([]);
  const [activeTemplateId, setActiveTemplateId] = useState("");
  const [mode, setMode] = useState("balanced");
  const [workers, setWorkers] = useState(4);
  const [frames, setFrames] = useState(8);
  const [running, setRunning] = useState(false);
  const [networkSafeMessage, setNetworkSafeMessage] = useState("");
  const [runningAction, setRunningAction] = useState<ClassifierRunPayload["command"] | "split-rename" | null>(null);
  const [processMethod, setProcessMethod] = useState<"classify" | "split" | "split-rename">("classify");
  const [splitPrecision, setSplitPrecision] = useState<"rough" | "fine">(() => {
    if (typeof window === "undefined") return "fine";
    return window.localStorage.getItem(classifierSplitPrecisionStorageKey) === "rough" ? "rough" : "fine";
  });
  const [namingOptions, setNamingOptions] = useState(() => {
    const defaults = { remember: false, preserveOriginalName: true, addSequence: true };
    if (typeof window === "undefined") return defaults;
    try {
      const saved = JSON.parse(window.localStorage.getItem(classifierNamingOptionsStorageKey) || "null");
      return saved?.remember === true ? {
        remember: true,
        preserveOriginalName: saved.preserveOriginalName !== false,
        addSequence: saved.addSequence !== false,
      } : defaults;
    } catch {
      return defaults;
    }
  });
  const [recovery, setRecovery] = useState<ClassifierRecovery | null>(null);
  const [retryTaskCount, setRetryTaskCount] = useState(0);
  const [retryPayload, setRetryPayload] = useState<ClassifierRunPayload | null>(null);
  const [recentOutput, setRecentOutput] = useState<ClassifierState["recentOutput"]>(null);
  const [configHealth, setConfigHealth] = useState<ClassifierState["configHealth"] | null>(null);
  const [recentOutputSyncing, setRecentOutputSyncing] = useState(false);
  const announcedRecoveryRef = useRef("");
  const [schemeDialog, setSchemeDialog] = useState<"create" | "edit" | null>(null);
  const [schemeEditTemplateId, setSchemeEditTemplateId] = useState("");
  const [expandedSchemeId, setExpandedSchemeId] = useState("");
  const [schemeName, setSchemeName] = useState("");
  const [schemeProductName, setSchemeProductName] = useState("");
  const [schemeProductBrief, setSchemeProductBrief] = useState(classifierProductBriefTemplate);
  const [schemeTaxonomyText, setSchemeTaxonomyText] = useState("");
  const [schemeRules, setSchemeRules] = useState("");
  const [schemeNamingParts, setSchemeNamingParts] = useState<ClassifierNamingPart[]>(() => parseClassifierNamingRule(defaultClassifierNamingRule));
  const namingDragIndex = useRef<number | null>(null);
  const [schemeGenerating, setSchemeGenerating] = useState(false);
  const [schemeGenerationStage, setSchemeGenerationStage] = useState("");
  const [schemeDraftQuality, setSchemeDraftQuality] = useState<ClassifierDraftQuality | null>(null);
  const [schemeImportingProductFiles, setSchemeImportingProductFiles] = useState(false);
  const [schemeRecognizingScannedPdfs, setSchemeRecognizingScannedPdfs] = useState(false);
  const [schemeImportedProductFiles, setSchemeImportedProductFiles] = useState<string[]>([]);
  const [schemeImportedProductSourceIds, setSchemeImportedProductSourceIds] = useState<string[]>([]);
  const [schemeProductScanCandidates, setSchemeProductScanCandidates] = useState<ProductInfoScanCandidate[]>([]);
  const [schemeProductFileDragActive, setSchemeProductFileDragActive] = useState(false);
  const schemeProductFileDragDepth = useRef(0);
  const [schemeSaving, setSchemeSaving] = useState(false);
  const [logs, setLogs] = useState<ClassifierLogEntry[]>([]);
  const [previewItems, setPreviewItems] = useState<ClassifierPreviewItem[]>([]);
  const [previewExpanded, setPreviewExpanded] = useState(true);
  const [previewDrawerId, setPreviewDrawerId] = useState("");
  const logBodyRef = useRef<HTMLDivElement>(null);
  const previewCurrentSourceRef = useRef("");
  const previewCurrentTagSourceRef = useRef("");
  const previewSplitTotalRef = useRef(0);
  const appliedHandoffId = useRef(handoff?.id ?? "");
  const streamedProgressLineCount = useRef(0);
  const schemeDraftRestored = useRef(false);

  useEffect(() => {
    const body = logBodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [logs]);

  useEffect(() => {
    if (namingOptions.remember) {
      window.localStorage.setItem(classifierNamingOptionsStorageKey, JSON.stringify(namingOptions));
    } else {
      window.localStorage.removeItem(classifierNamingOptionsStorageKey);
    }
  }, [namingOptions]);

  useEffect(() => {
    window.localStorage.setItem(classifierSplitPrecisionStorageKey, splitPrecision);
  }, [splitPrecision]);

  useEffect(() => window.desktopBridge?.classifierDraftOnProgress?.((progress) => {
    const suffix = progress.total && progress.total > 1 ? ` ${progress.current || 0}/${progress.total}` : "";
    setSchemeGenerationStage(`${progress.stage}${suffix}`);
  }), []);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(classifierTemplateDraftStorageKey) || "null");
      if (saved?.version === 1 && (saved.dialog === "create" || saved.dialog === "edit")) {
        setSchemeDialog(saved.dialog);
        setSchemeEditTemplateId(String(saved.editTemplateId || ""));
        setExpandedSchemeId(String(saved.expandedSchemeId || (saved.dialog === "create" ? "__new__" : saved.editTemplateId || "")));
        setSchemeName(String(saved.name || ""));
        setSchemeProductName(String(saved.productName || ""));
        setSchemeProductBrief(String(saved.productBrief || classifierProductBriefTemplate));
        setSchemeTaxonomyText(String(saved.taxonomyText || ""));
        setSchemeRules(String(saved.rules || ""));
        setSchemeNamingParts(parseClassifierNamingRule(String(saved.namingRule || defaultClassifierNamingRule), String(saved.productName || "")));
        setSchemeImportedProductFiles(Array.isArray(saved.importedFiles) ? saved.importedFiles.map(String) : []);
        setSchemeImportedProductSourceIds(Array.isArray(saved.importedSourceIds) ? saved.importedSourceIds.map(String) : []);
        setSchemeProductScanCandidates(Array.isArray(saved.scanCandidates) ? saved.scanCandidates : []);
        setSchemeDraftQuality(saved.quality || null);
      }
    } catch {
      window.localStorage.removeItem(classifierTemplateDraftStorageKey);
    } finally {
      schemeDraftRestored.current = true;
    }
  }, []);

  const appendLogs = (messages: string[], splitStatus: string, taggingStatus: string) => {
    if (!messages.length) return;
    setLogs((current) => [...current, ...messages.map((message) => createClassifierLog(message, splitStatus, taggingStatus))]);
  };

  const appendLog = (message: string, splitStatus: string, taggingStatus: string) => {
    appendLogs([message], splitStatus, taggingStatus);
  };

  const startLogSession = (messages: string[], splitStatus: string, taggingStatus: string) => {
    setLogs(messages.map((message) => createClassifierLog(message, splitStatus, taggingStatus)));
  };

  const startPreviewSession = () => {
    previewCurrentSourceRef.current = "";
    previewCurrentTagSourceRef.current = "";
    previewSplitTotalRef.current = 0;
    setPreviewItems([]);
    setPreviewDrawerId("");
    setPreviewExpanded(true);
  };

  const loadClassifierPreview = async (paths: string[]) => {
    const usablePaths = [...new Set(paths.filter(Boolean))];
    if (!usablePaths.length || !window.desktopBridge?.classifierPreviewMedia) return [];
    try {
      const records = await window.desktopBridge.classifierPreviewMedia(usablePaths);
      return records.map(classifierPreviewItemFromMedia);
    } catch {
      return [];
    }
  };

  const hydrateClassifierPreview = async (paths: string[], replace = false) => {
    try {
      const items = await loadClassifierPreview(paths);
      setPreviewItems((current) => replace ? items : mergeClassifierPreviewItems(current, items));
      return items;
    } catch {
      return [];
    }
  };

  const replaceClassifierPreviewOutput = async (sourceName: string, outputPath: string) => {
    const [outputItem] = await loadClassifierPreview([outputPath]);
    if (!outputItem) return;
    setPreviewItems((current) => {
      const index = current.findIndex((item) => classifierPreviewMatchesSource(item, sourceName));
      if (index < 0) return mergeClassifierPreviewItems(current, [outputItem]);
      const previous = current[index];
      const replacement: ClassifierPreviewItem = {
        ...outputItem,
        id: previous.id,
        kind: previous.kind === "segment" ? "segment" : outputItem.kind,
        tags: outputItem.tags.length ? outputItem.tags : previous.tags,
        timeRange: previous.timeRange || outputItem.timeRange,
        message: "打标和命名已完成",
      };
      return current
        .filter((item, itemIndex) => itemIndex === index || item.path !== outputItem.path)
        .map((item, itemIndex) => itemIndex === index ? replacement : item);
    });
  };

  const applyClassifierPreviewProgress = (messages: string[], command: ClassifierRunPayload["command"]) => {
    const incoming: ClassifierPreviewItem[] = [];
    for (const sourceMessage of messages) {
      const message = sourceMessage.trim();
      const recognized = message.match(/^\[(\d+)\/(\d+)\]\s+已识别\s+(.+?)\s+->\s+(.+)$/);
      if (recognized) {
        const [, , , fileName, result] = recognized;
        previewCurrentTagSourceRef.current = fileName;
        setPreviewItems((current) => {
          const index = current.findIndex((item) => classifierPreviewMatchesSource(item, fileName));
          if (index < 0) return [...current, {
            id: `progress:${fileName}`,
            title: fileName,
            sourceName: fileName,
            path: "",
            kind: "tag",
            status: "processing",
            tags: classifierPreviewLabels(result),
            timeRange: "",
            message: "正在应用打标名称",
          }];
          return current.map((item, itemIndex) => itemIndex === index ? {
            ...item,
            status: "processing",
            tags: classifierPreviewLabels(result),
            message: "正在应用打标名称",
          } : item);
        });
        continue;
      }
      const failed = message.match(/^\[(\d+)\/(\d+)\]\s+识别失败\s+(.+?)(?:，(.*))?$/);
      if (failed) {
        const [, , , fileName, reason] = failed;
        setPreviewItems((current) => {
          const index = current.findIndex((item) => classifierPreviewMatchesSource(item, fileName));
          if (index < 0) return [...current, {
            id: `progress:${fileName}`,
            title: fileName,
            sourceName: fileName,
            path: "",
            kind: "tag",
            status: "failed",
            tags: [],
            timeRange: "",
            message: reason || "识别失败",
          }];
          return current.map((item, itemIndex) => itemIndex === index ? {
            ...item,
            status: "failed",
            message: reason || "识别失败",
          } : item);
        });
        continue;
      }
      const splitStart = message.match(/^\[(\d+)\/(\d+)\]\s+拆解\s+(.+)$/);
      if (splitStart) {
        previewCurrentSourceRef.current = splitStart[3];
        continue;
      }
      const splitDetected = message.match(/^检测到\s+(\d+)\s+个镜头/);
      if (splitDetected && command === "split") {
        previewSplitTotalRef.current = Math.min(500, Math.max(0, Number(splitDetected[1]) || 0));
        continue;
      }
      const shotProgress = message.match(/^镜头\s+(\d+)\/(\d+)$/);
      if (shotProgress && command === "split") {
        const index = Math.max(1, Number(shotProgress[1]) || 1);
        const total = Math.max(index, Number(shotProgress[2]) || previewSplitTotalRef.current || index);
        const sourceName = previewCurrentSourceRef.current || "当前视频";
        incoming.push({
          id: `segment:${sourceName}:${index}`,
          title: `${sourceName} · 分镜 ${index}`,
          sourceName,
          path: "",
          kind: "segment",
          status: "completed",
          tags: [],
          timeRange: "",
          message: `分镜已生成（${index}/${total}）`,
        });
        continue;
      }
      const copied = message.match(/^已复制到\s+(.+?)，源文件保留不动$/);
      if (copied?.[1]) {
        const sourceName = previewCurrentTagSourceRef.current;
        if (sourceName) void replaceClassifierPreviewOutput(sourceName, copied[1]);
        else void hydrateClassifierPreview([copied[1]]);
      }
    }
    if (incoming.length) setPreviewItems((current) => mergeClassifierPreviewItems(current, incoming));
  };

  const applyState = (state: ClassifierState) => {
    setTemplates(state.templates);
    setActiveTemplateId(state.activeTemplateId);
    setRecovery(state.recovery ?? null);
    setRetryTaskCount(Math.max(0, Number(state.retryTaskCount) || 0));
    setRetryPayload(state.retryPayload ?? null);
    setRecentOutput(state.recentOutput ?? null);
    setConfigHealth(state.configHealth ?? null);
    setExpandedSchemeId((current) => current || state.activeTemplateId || state.templates[0]?.template_id || "");
  };

  useEffect(() => {
    window.desktopBridge?.classifierBootstrap().then(applyState).catch((error) => {
      setLogs([createClassifierLog(`分类模块初始化失败：${error instanceof Error ? error.message : String(error)}`, "未开始", "初始化失败")]);
    });
  }, []);

  useEffect(() => {
    const unsubscribe = window.desktopBridge?.classifierOnProgress?.((progress) => {
      if (!Array.isArray(progress.lines) || !progress.lines.length) return;
      const safeModeLine = progress.lines.find((line) => line.startsWith("共享网盘安全模式已启用："));
      if (safeModeLine) setNetworkSafeMessage(safeModeLine.replace(/^共享网盘安全模式已启用：/, "").replace(/。$/, ""));
      streamedProgressLineCount.current += progress.lines.length;
      applyClassifierPreviewProgress(progress.lines, progress.command);
      const isSplitProgress = progress.command === "split";
      appendLogs(
        formatClassifierProgressLogs(progress.lines, progress.command),
        isSplitProgress ? "切割中" : "不执行",
        isSplitProgress ? "不执行" : "打标中",
      );
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!handoff || appliedHandoffId.current === handoff.id) return;
    appliedHandoffId.current = handoff.id;
    setFolder(handoff.folder);
    setInputLabel(handoff.label);
    setInputCount(handoff.count);
    setInputMediaCounts(handoff.mediaCounts);
    setInputPaths(handoff.paths?.length ? handoff.paths : [handoff.folder]);
    appendLog(`已接收媒体库素材：${handoff.label}（${handoff.count} 个）`, "待开始", "待开始");
  }, [handoff]);

  useEffect(() => {
    if (!recovery || announcedRecoveryRef.current === recovery.jobId) return;
    announcedRecoveryRef.current = recovery.jobId;
    const recoveryIsSplit = recovery.command === "split";
    appendLogs(
      [...formatClassifierProgressLogs(recovery.logs ?? [], recovery.command), "检测到上次未完成任务：已完成的文件和断点均已保存，可继续处理剩余素材。"],
      recoveryIsSplit ? "切割中断" : "不执行",
      recoveryIsSplit ? "不执行" : "打标中断",
    );
  }, [recovery]);

  const activeTemplate = templates.find((item) => item.template_id === activeTemplateId) ?? templates[0];
  const selectedPreviewItem = previewItems.find((item) => item.id === previewDrawerId) ?? null;

  const chooseOutputFolder = async () => {
    const selected = await window.desktopBridge?.chooseDirectory();
    if (!selected) return;
    const validation = await window.desktopBridge?.classifierValidateOutputDirectory?.(selected);
    if (validation && !validation.ok) {
      notify(validation.error || "该目录不能用作分类输出目录");
      return;
    }
    const validPath = validation?.path || selected;
    setOutputRoot(validPath);
    window.localStorage.setItem(classifierOutputDirectoryStorageKey, validPath);
    notify("输出目录已保存为默认目录");
  };

  const prepareInputPaths = async (paths: string[]) => {
    if (preparingInput) return;
    if (!window.desktopBridge?.classifierPrepareInput) {
      notify("素材导入仅支持桌面版");
      return;
    }
    const usablePaths = [...new Set(paths.filter(Boolean))];
    if (!usablePaths.length) {
      notify("没有读取到可用的文件或文件夹");
      return;
    }
    const combinedPaths = [...new Set([...inputPaths, ...usablePaths])];
    const isAppending = inputPaths.length > 0 && Boolean(folder);
    setPreparingInput(true);
    try {
      const prepared = await window.desktopBridge.classifierPrepareInput(combinedPaths);
      setFolder(prepared.folder);
      setInputLabel(prepared.label);
      setInputCount(prepared.count);
      setInputMediaCounts(prepared.mediaCounts);
      setInputPaths(combinedPaths);
      if (prepared.mediaCounts.video === 0) setProcessMethod("classify");
      appendLog(`${isAppending ? "已追加" : "已导入"}：${prepared.label}（当前共 ${prepared.count} 个素材）`, "待开始", "待开始");
      const copiedHint = prepared.methods.copied ? `，其中 ${prepared.methods.copied} 个文件已建立工作副本` : "";
      notify(`${isAppending ? "素材已追加" : "素材已导入"}，当前共 ${prepared.count} 个${copiedHint}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "素材导入失败");
    } finally {
      setPreparingInput(false);
      setInputDragActive(false);
    }
  };

  const clearClassifierInput = () => {
    if (preparingInput || running) return;
    setFolder("");
    setInputLabel("");
    setInputCount(0);
    setInputMediaCounts({ image: 0, video: 0 });
    setInputPaths([]);
    setInputDragActive(false);
    setNetworkSafeMessage("");
    onClearHandoff();
    appendLog("已清空待处理素材，可重新上传文件、文件夹或拖入素材。", "待开始", "待开始");
    notify("已清空待处理素材");
  };

  const chooseInputFiles = async () => {
    const records = await window.desktopBridge?.mediaChooseFiles();
    if (records?.length) await prepareInputPaths(records.map((record) => record.path));
  };

  const chooseInputFolder = async () => {
    const selected = await window.desktopBridge?.chooseDirectory();
    if (selected) await prepareInputPaths([selected]);
  };

  const hasVideoInput = inputMediaCounts.video > 0;
  const inputTypeSummary = [
    inputMediaCounts.image ? `${inputMediaCounts.image} 张图片` : "",
    inputMediaCounts.video ? `${inputMediaCounts.video} 个视频` : "",
  ].filter(Boolean).join("、");

  const dropClassifierInput = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const bridge = window.desktopBridge;
    if (!bridge?.mediaPathForFile) {
      notify("拖入文件仅支持桌面版");
      setInputDragActive(false);
      return;
    }
    const paths = Array.from(event.dataTransfer.files).map((file) => bridge.mediaPathForFile(file)).filter(Boolean);
    await prepareInputPaths(paths);
  };

  const run = async (command: ClassifierRunPayload["command"], resumePayload?: ClassifierRunPayload) => {
    const runFolder = resumePayload?.folder || folder;
    const runOutputRoot = resumePayload?.output_root || outputRoot;
    const runMode = resumePayload?.mode || mode;
    const runWorkers = resumePayload?.workers || workers;
    const runFrames = resumePayload?.frames || frames;
    const runSplitPrecision = resumePayload?.split_precision === "rough" || resumePayload?.split_precision === "fine"
      ? resumePayload.split_precision
      : splitPrecision;
    const runNaming = resumePayload?.naming ?? {
      preserveOriginalName: namingOptions.preserveOriginalName,
      addSequence: namingOptions.addSequence,
    };
    if (!runFolder) {
      notify("请先选择素材文件夹");
      return;
    }
    if ((handoff || inputLabel || resumePayload) && (command === "classify" || command === "review" || command === "split") && !runOutputRoot) {
      notify("请先选择输出目录，完成后会自动同步到媒体库");
      return;
    }
    if (!window.desktopBridge) {
      notify("分类引擎仅在桌面版中运行");
      return;
    }
    const outputValidation = await window.desktopBridge.classifierValidateOutputDirectory?.(runOutputRoot);
    if (outputValidation && !outputValidation.ok) {
      notify(outputValidation.error || "请重新选择分类输出目录");
      return;
    }
    setRunningAction(command);
    setRunning(true);
    setNetworkSafeMessage("");
    startPreviewSession();
    streamedProgressLineCount.current = 0;
    setRecovery(null);
    const isSplitCommand = command === "split";
    const activeSplitStatus = isSplitCommand ? "切割中" : "不执行";
    const activeTaggingStatus = isSplitCommand ? "不执行" : "打标中";
    const detectedCount = command === "split"
      ? (inputMediaCounts.video > 0 ? inputMediaCounts.video : null)
      : (inputCount > 0 ? inputCount : null);
    const startMessages = resumePayload
      ? [
          "断点续跑模式：已读取上次任务进度，只处理尚未完成的素材。",
          detectedCount ? `找到 ${detectedCount} 个待处理素材，正在核对失败和待筛清单...` : "正在核对失败和待筛清单...",
        ]
      : command === "split"
        ? [
            `切割模式：已加载${runSplitPrecision === "rough" ? "粗略" : "精细"}切割规则。`,
            detectedCount ? `找到 ${detectedCount} 个视频文件，准备处理...` : "正在扫描视频文件，准备处理...",
            "开始场景检测...",
          ]
        : command === "review"
          ? [
              `重跑模式：已加载“${activeTemplate?.name || "当前分类方案"}”分类规则。`,
              detectedCount ? `找到 ${detectedCount} 个素材文件，准备重跑失败或待筛素材...` : "正在读取失败和待筛素材...",
            ]
          : [
              `打标模式：已加载“${activeTemplate?.name || "当前分类方案"}”分类规则。`,
              detectedCount ? `找到 ${detectedCount} 个素材文件，准备处理...` : "正在扫描素材文件，准备处理...",
              "开始素材识别与打标...",
            ];
    startLogSession(startMessages, activeSplitStatus, activeTaggingStatus);
    try {
      const response = await window.desktopBridge.classifierRun({ command, folder: runFolder, output_root: runOutputRoot, mode: runMode, workers: runWorkers, frames: runFrames, split_precision: runSplitPrecision, naming: runNaming, source_paths: resumePayload?.source_paths || inputPaths });
      if (response.networkSafe?.enabled) setNetworkSafeMessage(response.networkSafe.reason || "共享网盘安全处理已启用");
      const outputCommand = command === "classify" || command === "review" || command === "split";
      const resultItems = Array.isArray(response.result) ? response.result : [];
      const result = Array.isArray(response.result) ? {} : response.result || {};
      const todoCount = Number(result.todo_count ?? 0);
      const copiedCount = Number(result.copied_count ?? 0);
      const failedCount = Number(result.failed_count ?? 0);
      const pendingCount = Number(result.pending_count ?? 0);
      if (command === "classify" || command === "review") {
        const nextRetryTaskCount = Number.isFinite(Number(response.retryTaskCount))
          ? Math.max(0, Number(response.retryTaskCount))
          : Math.max(0, failedCount + pendingCount);
        setRetryTaskCount(nextRetryTaskCount);
        setRetryPayload(response.retryPayload ?? (nextRetryTaskCount > 0 ? {
          command: response.networkSafe?.failedSourcePaths?.length ? "classify" : "review",
          folder: runFolder,
          output_root: runOutputRoot,
          mode: runMode,
          workers: runWorkers,
          frames: runFrames,
          split_precision: runSplitPrecision,
          naming: runNaming,
          source_paths: response.networkSafe?.failedSourcePaths?.length ? response.networkSafe.failedSourcePaths : resumePayload?.source_paths || inputPaths,
        } : null));
      }
      const allFailed = Boolean(response.ok && outputCommand && todoCount > 0 && failedCount >= todoCount && copiedCount === 0);
      const effectiveOk = response.ok && !allFailed;
      let syncMessage = "";
      if (effectiveOk && outputCommand) {
        const outputFiles = response.outputFiles?.length ? response.outputFiles : extractClassifierOutputFiles(response.logs ?? []);
        const syncRoots = command === "split"
          ? [...new Set(resultItems.map((item) => item?.output_dir).filter((item): item is string => typeof item === "string" && Boolean(item.trim())))]
          : typeof result.classification_root === "string" && result.classification_root.trim()
            ? [result.classification_root]
            : [];
        const previewPaths = command === "split" ? syncRoots : outputFiles;
        if (previewPaths.length) await hydrateClassifierPreview(previewPaths, true);
        try {
          if (!syncRoots.length) {
            syncMessage = "处理已完成，但引擎未返回明确的输出子目录，未自动扫描总输出目录。";
          } else if (command !== "split" && !outputFiles.length && copiedCount === 0) {
            syncMessage = "处理已完成，本次没有新增素材，无需同步媒体库。";
          } else {
            let syncedCount = 0;
            if (command === "split") {
              for (const syncRoot of syncRoots) syncedCount += await onCompleted(syncRoot, [], true);
            } else {
              syncedCount = await onCompleted(syncRoots[0], outputFiles);
            }
            syncMessage = syncedCount > 0
              ? `已同步到媒体库：${syncedCount} 个输出素材。`
              : "本次没有可入库的正式素材；分析用帧快照已自动排除。";
            if (response.jobId) {
              await window.desktopBridge.classifierMarkOutputSynced(response.jobId).catch(() => ({ ok: false }));
              setRecentOutput(null);
            }
          }
        } catch (error) {
          syncMessage = `媒体库同步失败：${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const statusMessage = allFailed
        ? response.diagnostic || `分类失败：${failedCount} 个素材均未生成结果，请检查 API 配置或失败清单。`
        : effectiveOk
          ? failedCount > 0 ? `处理完成：成功 ${copiedCount} 个，失败 ${failedCount} 个。` : "处理完成。"
          : `处理失败：${response.error ?? "未知错误"}`;
      if (streamedProgressLineCount.current === 0) {
        appendLogs(formatClassifierProgressLogs(response.logs ?? [], command), activeSplitStatus, activeTaggingStatus);
      }
      appendLogs(
        [statusMessage, ...(syncMessage ? [syncMessage] : [])],
        isSplitCommand ? (effectiveOk ? "切割完成" : "切割失败") : "不执行",
        isSplitCommand ? "不执行" : (effectiveOk ? "打标完成" : "打标失败"),
      );
      notify(effectiveOk ? (syncMessage || statusMessage) : statusMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : "分类引擎调用失败";
      appendLog(`处理失败：${message}`, isSplitCommand ? "切割失败" : "不执行", isSplitCommand ? "不执行" : "打标失败");
      notify(message);
    } finally {
      setRunning(false);
      setRunningAction(null);
      try {
        const next = await window.desktopBridge!.classifierBootstrap();
        applyState(next);
      } catch {
        // The completed output remains available even if refreshing recovery state fails.
      }
    }
  };

  const resumeLastTask = () => {
    if (!recovery) return;
    const payload = recovery.payload;
    setFolder(payload.folder);
    setInputPaths([payload.folder]);
    setOutputRoot(payload.output_root);
    setMode(payload.mode || mode);
    setWorkers(payload.workers || workers);
    setFrames(payload.frames || frames);
    if (payload.split_precision === "rough" || payload.split_precision === "fine") setSplitPrecision(payload.split_precision);
    if (payload.naming) {
      setNamingOptions((current) => ({ ...current, ...payload.naming }));
    }
    setInputLabel("上次未完成任务");
    void run(recovery.command, payload);
  };

  const splitAndRename = async () => {
    if (!folder) {
      notify("请先上传需要拆镜头的视频或文件夹");
      return;
    }
    if (!outputRoot) {
      notify("请先选择输出目录");
      return;
    }
    const bridge = window.desktopBridge;
    if (!bridge) {
      notify("分割+打标仅支持桌面版");
      return;
    }
    const outputValidation = await bridge.classifierValidateOutputDirectory?.(outputRoot);
    if (outputValidation && !outputValidation.ok) {
      notify(outputValidation.error || "请重新选择分类输出目录");
      return;
    }
    setRunningAction("split-rename");
    setRunning(true);
    startPreviewSession();
    streamedProgressLineCount.current = 0;
    let splitCompleted = false;
    startLogSession([
      `组合模式：先按${splitPrecision === "rough" ? "粗略" : "精细"}切割视频镜头，再按“${activeTemplate?.name || "当前分类方案"}”进行素材打标和命名。`,
      inputMediaCounts.video > 0 ? `找到 ${inputMediaCounts.video} 个视频文件，准备处理...` : "正在扫描视频文件，准备处理...",
      "开始场景检测...",
    ], "切割中", "等待切割");
    try {
      const currentNaming = {
        preserveOriginalName: namingOptions.preserveOriginalName,
        addSequence: namingOptions.addSequence,
      };
      const splitResponse = await bridge.classifierRun({ command: "split", folder, output_root: outputRoot, mode, workers, frames, split_precision: splitPrecision, naming: currentNaming, source_paths: inputPaths });
      if (streamedProgressLineCount.current === 0) appendLogs(formatClassifierProgressLogs(splitResponse.logs ?? [], "split"), "切割中", "等待切割");
      if (!splitResponse.ok) throw new Error(splitResponse.error || "批量拆镜头失败");
      const splitResults = Array.isArray(splitResponse.result) ? splitResponse.result : [];
      const segmentDirs = [...new Set(splitResults.map((item) => item.output_dir).filter(Boolean))];
      const segmentCount = splitResults.reduce((total, item) => total + Number(item.segment_count || 0), 0);
      if (!segmentDirs.length || segmentCount < 1) throw new Error("拆镜头完成，但没有生成可重命名的镜头切片");
      splitCompleted = true;
      await hydrateClassifierPreview(segmentDirs, true);
      appendLog(`拆镜头完成：共生成 ${segmentCount} 个镜头，正在准备识别和重命名。`, "切割完成", "打标准备中");

      const prepared = await bridge.classifierPrepareInput(segmentDirs);
      if (!prepared.count) throw new Error("没有读取到可重命名的镜头切片");
      const consumeGeneratedSources = {
        consume_generated_sources: true,
        consume_source_roots: segmentDirs,
        consume_source_mappings: prepared.sourceMappings,
      };
      const renameResponse = await bridge.classifierRun({ command: "classify", folder: prepared.folder, output_root: outputRoot, mode, workers, frames, naming: currentNaming, source_paths: segmentDirs, ...consumeGeneratedSources });
      if (streamedProgressLineCount.current === 0) appendLogs(formatClassifierProgressLogs(renameResponse.logs ?? [], "classify"), "切割完成", "打标中");
      const renameResult = Array.isArray(renameResponse.result) ? {} : renameResponse.result || {};
      const todoCount = Number(renameResult.todo_count ?? prepared.count);
      const copiedCount = Number(renameResult.copied_count ?? 0);
      const failedCount = Number(renameResult.failed_count ?? 0);
      const pendingCount = Number(renameResult.pending_count ?? 0);
      const nextRetryTaskCount = Number.isFinite(Number(renameResponse.retryTaskCount))
        ? Math.max(0, Number(renameResponse.retryTaskCount))
        : Math.max(0, failedCount + pendingCount);
      setRetryTaskCount(nextRetryTaskCount);
      setRetryPayload(renameResponse.retryPayload ?? (nextRetryTaskCount > 0 ? {
        command: "review",
        folder: prepared.folder,
        output_root: outputRoot,
        mode,
        workers,
        frames,
        split_precision: splitPrecision,
        naming: currentNaming,
        source_paths: segmentDirs,
        ...consumeGeneratedSources,
      } : null));
      const allFailed = todoCount > 0 && failedCount >= todoCount && copiedCount === 0;
      if (!renameResponse.ok || allFailed) {
        throw new Error(allFailed ? `${failedCount} 个镜头均未成功重命名，请检查 API 配置或失败清单` : renameResponse.error || "镜头重命名失败");
      }

      const syncRoot = typeof renameResult.classification_root === "string" ? renameResult.classification_root.trim() : "";
      const renameOutputFiles = renameResponse.outputFiles?.length ? renameResponse.outputFiles : extractClassifierOutputFiles(renameResponse.logs ?? []);
      if (renameOutputFiles.length) await hydrateClassifierPreview(renameOutputFiles, true);
      const noNewOutput = copiedCount === 0 && renameOutputFiles.length === 0;
      const syncedCount = syncRoot && !noNewOutput ? await onCompleted(syncRoot, renameOutputFiles) : 0;
      if (renameResponse.jobId && syncRoot && !noNewOutput) {
        await bridge.classifierMarkOutputSynced(renameResponse.jobId).catch(() => ({ ok: false }));
        setRecentOutput(null);
      }
      const syncStatus = syncRoot
        ? noNewOutput ? "；本次没有新增素材，无需同步媒体库" : `；已同步媒体库 ${syncedCount} 个素材`
        : "；引擎未返回明确的输出子目录，未自动扫描总输出目录";
      const status = `处理完成：拆分 ${segmentCount} 个镜头，成功识别并重命名 ${copiedCount || prepared.count} 个${failedCount ? `，失败 ${failedCount} 个` : ""}${syncStatus}。`;
      appendLog(status, "切割完成", "打标完成");
      notify(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : "分割+打标失败";
      appendLog(`处理失败：${message}`, splitCompleted ? "切割完成" : "切割失败", splitCompleted ? "打标失败" : "未开始");
      notify(message);
    } finally {
      setRunning(false);
      setRunningAction(null);
      try {
        const next = await bridge.classifierBootstrap();
        applyState(next);
      } catch {
        // Keep the in-memory retry payload available when refreshing state fails.
      }
    }
  };

  const rerunFailedTasks = async () => {
    const payload = retryPayload ?? {
      command: "review" as const,
      folder,
      output_root: outputRoot,
      mode,
      workers,
      frames,
      naming: {
        preserveOriginalName: namingOptions.preserveOriginalName,
        addSequence: namingOptions.addSequence,
      },
    };
    const retryCommand = payload.command === "classify" || payload.command === "split" ? payload.command : "review";
    if (retryCommand === "classify" && payload.source_paths?.length && window.desktopBridge?.classifierPrepareInput) {
      try {
        notify(`正在准备 ${payload.source_paths.length} 个失败素材…`);
        const prepared = await window.desktopBridge.classifierPrepareInput(payload.source_paths);
        void run("classify", {
          ...payload,
          command: "classify",
          folder: prepared.folder,
          source_paths: payload.source_paths,
          ...(payload.consume_generated_sources === true ? { consume_source_mappings: prepared.sourceMappings } : {}),
        });
      } catch (error) {
        setRetryTaskCount(0);
        setRetryPayload(null);
        notify(error instanceof Error ? error.message : "失败素材已不存在，无法重试");
      }
      return;
    }
    void run(retryCommand, { ...payload, command: retryCommand });
  };

  const syncRecentClassifierOutput = async () => {
    if (!recentOutput || recentOutputSyncing) return;
    setRecentOutputSyncing(true);
    try {
      const count = await onCompleted(recentOutput.outputRoot, recentOutput.outputFiles);
      await window.desktopBridge?.classifierMarkOutputSynced(recentOutput.jobId);
      setRecentOutput(null);
      notify(`已补同步最近一次分类结果：${count} 个素材`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "最近一次分类结果补同步失败");
    } finally {
      setRecentOutputSyncing(false);
    }
  };

  const startSelectedProcess = () => {
    if (processMethod !== "classify" && inputCount > 0 && !hasVideoInput) {
      notify("当前输入只有图片；图片可直接打标，不支持拆镜头");
      setProcessMethod("classify");
      return;
    }
    if (processMethod === "split-rename") {
      void splitAndRename();
      return;
    }
    void run(processMethod);
  };

  const selectedProcessLabel = processMethod === "classify"
    ? "仅打标"
    : processMethod === "split"
      ? "仅分割"
      : "分割+打标";
  const runningProcessLabel = runningAction === "review"
    ? "重跑失败任务"
    : runningAction === "classify"
      ? "仅打标"
      : runningAction === "split"
        ? "仅分割"
        : runningAction === "split-rename"
          ? "分割+打标"
          : selectedProcessLabel;
  const schemeNamingRule = serializeClassifierNamingRule(schemeNamingParts);
  const schemeNamingPreview = previewClassifierNamingRule(schemeNamingParts, schemeProductName, schemeTaxonomyText);
  const schemeBriefMissingFields = useMemo(() => classifierBriefMissingFields(schemeProductBrief), [schemeProductBrief]);

  useEffect(() => {
    if (!schemeDraftRestored.current) return;
    if (!schemeDialog) return;
    const timeout = window.setTimeout(() => window.localStorage.setItem(classifierTemplateDraftStorageKey, JSON.stringify({
      version: 1,
      dialog: schemeDialog,
      editTemplateId: schemeEditTemplateId,
      expandedSchemeId,
      name: schemeName,
      productName: schemeProductName,
      productBrief: schemeProductBrief,
      taxonomyText: schemeTaxonomyText,
      rules: schemeRules,
      namingRule: schemeNamingRule,
      importedFiles: schemeImportedProductFiles,
      importedSourceIds: schemeImportedProductSourceIds,
      scanCandidates: schemeProductScanCandidates,
      quality: schemeDraftQuality,
      savedAt: new Date().toISOString(),
    })), 350);
    return () => window.clearTimeout(timeout);
  }, [schemeDialog, schemeEditTemplateId, expandedSchemeId, schemeName, schemeProductName, schemeProductBrief, schemeTaxonomyText, schemeRules, schemeNamingRule, schemeImportedProductFiles, schemeImportedProductSourceIds, schemeProductScanCandidates, schemeDraftQuality]);

  const setNamingRulePartsFromString = (rule: string | undefined, productName: string) => {
    setSchemeNamingParts(parseClassifierNamingRule(rule, productName));
  };

  const addNamingField = (field: ClassifierNamingField) => {
    setSchemeNamingParts((current) => current.some((part) => part.kind === "field" && part.field === field)
      ? current
      : [...current, { id: `naming-field-${field}-${Date.now()}`, kind: "field", field }]);
  };

  const addNamingLiteral = () => {
    setSchemeNamingParts((current) => [...current, { id: `naming-literal-${Date.now()}-${current.length}`, kind: "literal", value: "固定文字" }]);
  };

  const updateNamingLiteral = (id: string, value: string) => {
    const safeValue = value.replace(/[\\/:*?"<>|_\r\n]+/g, "-");
    setSchemeNamingParts((current) => current.map((part) => part.id === id && part.kind === "literal" ? { ...part, value: safeValue } : part));
  };

  const removeNamingPart = (id: string) => {
    setSchemeNamingParts((current) => current.filter((part) => part.id !== id));
  };

  const dropNamingPart = (targetIndex: number) => {
    const sourceIndex = namingDragIndex.current;
    namingDragIndex.current = null;
    if (sourceIndex === null || sourceIndex === targetIndex) return;
    setSchemeNamingParts((current) => {
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      if (!moved) return current;
      next.splice(targetIndex, 0, moved);
      return next;
    });
  };

  const openCreateTemplate = () => {
    setSchemeEditTemplateId("");
    setSchemeName("新分类方案");
    setSchemeProductName("新产品");
    setSchemeProductBrief(classifierProductBriefTemplate);
    setSchemeTaxonomyText("");
    setSchemeRules("");
    setSchemeImportedProductFiles([]);
    setSchemeImportedProductSourceIds([]);
    setSchemeProductScanCandidates([]);
    setSchemeDraftQuality(null);
    setNamingRulePartsFromString(defaultClassifierNamingRule, "新产品");
    setSchemeDialog("create");
    setExpandedSchemeId("__new__");
  };

  const openEditTemplate = (template: ClassifierTemplate | undefined = activeTemplate) => {
    if (!template) {
      notify("当前没有可编辑的方案");
      return;
    }
    setSchemeEditTemplateId(template.template_id);
    setSchemeName(template.name);
    setSchemeProductName(template.product_name);
    setSchemeProductBrief(classifierProductBriefTemplate.replace("产品名称：", `产品名称：${template.product_name}`).replace("项目名称：", `项目名称：${template.name}`));
    setSchemeTaxonomyText(classifierTaxonomyToText(template.taxonomy));
    setSchemeRules(template.rules || "");
    setSchemeImportedProductFiles([]);
    setSchemeImportedProductSourceIds([]);
    setSchemeProductScanCandidates([]);
    setSchemeDraftQuality(null);
    setNamingRulePartsFromString(template.naming_rule || defaultClassifierNamingRule, template.product_name);
    setSchemeDialog("edit");
    setExpandedSchemeId(template.template_id);
  };

  const importProductInfoFiles = async (droppedPaths: string[] = []) => {
    const bridge = window.desktopBridge;
    if (!bridge?.classifierImportProductInfoFiles || (droppedPaths.length > 0 && !bridge.classifierImportProductInfoPaths)) {
      notify("产品资料导入仅支持桌面版");
      return;
    }
    setSchemeImportingProductFiles(true);
    try {
      const result = droppedPaths.length > 0
        ? await bridge.classifierImportProductInfoPaths(droppedPaths)
        : await bridge.classifierImportProductInfoFiles();
      if (result.cancelled) return;
      const knownSources = new Set(schemeImportedProductSourceIds);
      const documents = [...new Map((result.documents || [])
        .filter((document) => document.sourceId && !knownSources.has(document.sourceId))
        .map((document) => [document.sourceId, document])).values()];
      const addedText = documents.length
        ? documents.map((document) => `【产品资料：${document.name}】\n${document.text}`).join("\n\n")
        : result.files.some((file) => file.sourceId && knownSources.has(file.sourceId || "")) ? "" : result.text.trim();
      const current = schemeProductBrief.trim();
      const combined = [current, addedText].filter(Boolean).join("\n\n");
      setSchemeProductBrief(combined);
      setSchemeImportedProductFiles((files) => [...new Set([...files, ...result.files.map((file) => file.name)])]);
      setSchemeImportedProductSourceIds((ids) => [...new Set([...ids, ...result.files.map((file) => file.sourceId).filter((value): value is string => Boolean(value))])]);
      setSchemeProductScanCandidates((candidates) => {
        const merged = new Map(candidates.map((candidate) => [candidate.sourceId || candidate.path, candidate]));
        for (const candidate of result.scanCandidates || []) merged.set(candidate.sourceId || candidate.path, candidate);
        return [...merged.values()];
      });
      const warning = result.warnings.length ? `；${result.warnings.length} 个文件未能读取` : "";
      const scanPages = (result.scanCandidates || []).reduce((total, candidate) => total + (candidate.pages?.length || 0), 0);
      const scanned = result.scanCandidates?.length ? `；${scanPages ? `${scanPages} 页` : `${result.scanCandidates.length} 个 PDF`}需要手动 AI 识别` : "";
      const duplicate = result.files.length > documents.length ? `；${result.files.length - documents.length} 个重复文件未再次追加` : "";
      notify(`已读取 ${documents.length || result.files.length} 个产品资料文件${duplicate}${scanned}${warning}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "产品资料读取失败");
    } finally {
      setSchemeImportingProductFiles(false);
    }
  };

  const recognizeScannedProductInfo = async () => {
    const bridge = window.desktopBridge;
    if (!bridge?.classifierRecognizeScannedProductInfo || !schemeProductScanCandidates.length) return;
    setSchemeRecognizingScannedPdfs(true);
    try {
      const result = await bridge.classifierRecognizeScannedProductInfo(schemeProductScanCandidates);
      const current = schemeProductBrief.trim();
      const recognizedText = result.documents?.length
        ? result.documents.map((document) => `【AI 识别扫描件：${document.name}】\n${document.text}`).join("\n\n")
        : result.text.trim();
      const combined = [current, recognizedText].filter(Boolean).join("\n\n");
      setSchemeProductBrief(combined);
      setSchemeImportedProductFiles((files) => [...new Set([...files, ...result.files.map((file) => file.name)])]);
      setSchemeImportedProductSourceIds((ids) => [...new Set([...ids, ...result.files.map((file) => file.recognitionId).filter((value): value is string => Boolean(value))])]);
      const recognizedKeys = new Set(result.files.map((file) => file.sourceId || file.path));
      setSchemeProductScanCandidates((candidates) => candidates.filter((candidate) => !recognizedKeys.has(candidate.sourceId || candidate.path)));
      const warning = result.warnings.length ? `；${result.warnings.length} 页未能识别` : "";
      notify(`AI 已识别 ${result.files.length} 个扫描型 PDF，并回填产品资料${warning}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "扫描件 AI 识别失败");
    } finally {
      setSchemeRecognizingScannedPdfs(false);
    }
  };

  const dropProductInfoFiles = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    schemeProductFileDragDepth.current = 0;
    setSchemeProductFileDragActive(false);
    if (schemeGenerating || schemeSaving || schemeImportingProductFiles || schemeRecognizingScannedPdfs) return;
    const bridge = window.desktopBridge;
    if (!bridge?.mediaPathForFile || !bridge.classifierImportProductInfoPaths) {
      notify("拖入产品资料仅支持桌面版");
      return;
    }
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => bridge.mediaPathForFile(file))
      .filter((filePath) => typeof filePath === "string" && filePath.length > 0);
    if (!paths.length) {
      notify("请拖入产品资料文件");
      return;
    }
    void importProductInfoFiles(paths);
  };

  const generateTemplateDraft = async () => {
    if (!window.desktopBridge?.classifierGenerateTemplateDraft) {
      notify("AI 生成草案仅支持桌面版");
      return;
    }
    if (!schemeProductBrief.trim()) {
      notify("请先填写产品信息、卖点、场景和素材需求");
      return;
    }
    setSchemeGenerating(true);
    setSchemeGenerationStage("正在整理产品资料");
    setSchemeDraftQuality(null);
    try {
      const draft = await window.desktopBridge.classifierGenerateTemplateDraft(schemeProductBrief);
      setSchemeName(draft.name || schemeName);
      const nextProductName = draft.product_name || schemeProductName;
      setSchemeProductName(nextProductName);
      setSchemeTaxonomyText(classifierTaxonomyToText(draft.taxonomy));
      setSchemeRules(draft.rules || "");
      setNamingRulePartsFromString(draft.naming_rule || defaultClassifierNamingRule, nextProductName);
      setSchemeDraftQuality(draft.quality || null);
      const qualityMessage = draft.quality?.issues?.length ? `；质量检查发现 ${draft.quality.issues.length} 项需要确认` : "；质量检查通过";
      const repairedMessage = draft.repairedCount ? `，已自动修复 ${draft.repairedCount} 项` : "";
      notify(`AI 已生成分类草案${repairedMessage}${qualityMessage}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "AI 生成草案失败");
    } finally {
      setSchemeGenerating(false);
      setSchemeGenerationStage("");
    }
  };

  const saveTemplateDialog = async () => {
    if (!window.desktopBridge || !schemeDialog || !schemeName.trim() || !schemeProductName.trim()) return;
    setSchemeSaving(true);
    try {
      const templatePayload: ClassifierTemplatePayload = {
        name: schemeName.trim(),
        productName: schemeProductName.trim(),
        taxonomy: parseClassifierTaxonomy(schemeTaxonomyText),
        rules: schemeRules.trim(),
        namingRule: schemeNamingRule.trim() || defaultClassifierNamingRule,
      };
      const next = schemeDialog === "create"
        ? await window.desktopBridge.classifierCreateTemplate(templatePayload)
        : schemeEditTemplateId
          ? await window.desktopBridge.classifierEditTemplate({ templateId: schemeEditTemplateId, ...templatePayload })
          : null;
      if (!next) throw new Error("当前没有可编辑的方案");
      applyState(next);
      setExpandedSchemeId("");
      setSchemeDialog(null);
      window.localStorage.removeItem(classifierTemplateDraftStorageKey);
      notify(schemeDialog === "create" ? "新方案已创建并切换" : "方案已更新");
    } catch (error) {
      notify(error instanceof Error ? error.message : "方案保存失败");
    } finally {
      setSchemeSaving(false);
    }
  };

  const importTemplate = async () => {
    if (!window.desktopBridge) return;
    try {
      const next = await window.desktopBridge.classifierImportTemplate();
      if (next.cancelled) return;
      applyState(next);
      setExpandedSchemeId("");
      notify(`方案“${next.importedName || "导入方案"}”已导入并切换`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "方案导入失败");
    }
  };

  const exportTemplate = async (templateId = activeTemplateId) => {
    if (!window.desktopBridge || !templateId) {
      notify("当前没有可导出的方案");
      return;
    }
    try {
      const result = await window.desktopBridge.classifierExportTemplate(templateId);
      if (!result.cancelled) notify(result.ok ? "方案已导出" : "方案导出失败");
    } catch (error) {
      notify(error instanceof Error ? error.message : "方案导出失败");
    }
  };

  const setActiveScheme = async (templateId: string) => {
    if (!window.desktopBridge || templateId === activeTemplateId) return;
    try {
      applyState(await window.desktopBridge.classifierSetActive(templateId));
      setExpandedSchemeId(templateId);
      notify("分类方案已切换");
    } catch (error) {
      notify(error instanceof Error ? error.message : "分类方案切换失败");
    }
  };

  const closeSchemeEditor = () => {
    if (schemeSaving || schemeGenerating || schemeImportingProductFiles || schemeRecognizingScannedPdfs) return;
    setSchemeDialog(null);
    window.localStorage.removeItem(classifierTemplateDraftStorageKey);
    setSchemeEditTemplateId("");
    setExpandedSchemeId("");
  };

  const schemeEditor = schemeDialog && (
      <div className="classifier-inline-template-editor" aria-label={schemeDialog === "create" ? "新建分类方案" : "编辑分类方案"}>
        <div className="classifier-inline-editor-heading"><div className="compact-modal-icon"><Boxes size={20} /></div><div><h3>{schemeDialog === "create" ? "新建分类方案" : `编辑分类方案：${schemeName}`}</h3><p>先填写产品和素材信息，可用文本模型生成草案，再修改分类结构、边界规则与命名规则。</p></div></div>
        <div className="classifier-template-editor-scroll">
          <section className="classifier-ai-draft-panel">
            <div><strong>AI 辅助生成草案</strong><span>示例提示保留在模板中，填写越具体，分类越贴近实际素材。</span></div>
            <div
              className={`classifier-product-file-import ${schemeProductFileDragActive ? "drag-active" : ""}`}
              onDragEnter={(event) => { event.preventDefault(); schemeProductFileDragDepth.current += 1; if (!schemeImportingProductFiles) setSchemeProductFileDragActive(true); }}
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; if (!schemeImportingProductFiles) setSchemeProductFileDragActive(true); }}
              onDragLeave={() => { schemeProductFileDragDepth.current = Math.max(0, schemeProductFileDragDepth.current - 1); if (schemeProductFileDragDepth.current === 0) setSchemeProductFileDragActive(false); }}
              onDrop={dropProductInfoFiles}
            >
              <button type="button" disabled={schemeGenerating || schemeSaving || schemeImportingProductFiles || schemeRecognizingScannedPdfs} onClick={() => void importProductInfoFiles()}><Upload size={14} />{schemeImportingProductFiles ? "正在读取产品资料…" : "上传产品资料"}</button>
              <span>{schemeProductFileDragActive ? "松开即可读取这些文件" : "点击上传或将文件拖到这里；支持 PPT/PPTX、图片、HTML、PDF、Word、Excel、TXT/Markdown/CSV 等常见格式"}</span>
            </div>
            {schemeImportedProductFiles.length > 0 && <div className="classifier-product-file-list" aria-label="已读取产品资料"><strong>已读取 {schemeImportedProductFiles.length} 个文件</strong><span title={schemeImportedProductFiles.join("、")}>{schemeImportedProductFiles.join("、")}</span></div>}
            {schemeProductScanCandidates.length > 0 && (
              <div className="classifier-product-scan-recovery" aria-label="未提取到文字的扫描型 PDF">
                <div><strong>{schemeProductScanCandidates.reduce((total, candidate) => total + (candidate.pages?.length || 0), 0) > 0 ? `还有 ${schemeProductScanCandidates.reduce((total, candidate) => total + (candidate.pages?.length || 0), 0)} 页需要 AI 识别` : `${schemeProductScanCandidates.length} 个 PDF 未提取到正常文字`}</strong><span title={schemeProductScanCandidates.map((candidate) => candidate.name).join("、")}>{schemeProductScanCandidates.map((candidate) => candidate.pages?.length ? `${candidate.name}（第 ${candidate.pages.join("、")} 页）` : candidate.name).join("、")}</span></div>
                <button
                  type="button"
                  className="classifier-scan-ai-action"
                  data-tooltip="逐页调用当前设置中的视觉模型识别扫描型 PDF，只回填产品资料，不会自动执行“AI 生成草案”；API 用量由用户自己的密钥产生。"
                  aria-label="AI 识别扫描件：逐页调用视觉模型，只回填产品资料，不生成分类草案"
                  disabled={schemeGenerating || schemeSaving || schemeImportingProductFiles || schemeRecognizingScannedPdfs}
                  onClick={() => void recognizeScannedProductInfo()}
                ><Eye size={14} />{schemeRecognizingScannedPdfs ? "正在 AI 识别扫描件…" : "AI 识别扫描件"}</button>
              </div>
            )}
            <textarea value={schemeProductBrief} rows={11} onChange={(event) => setSchemeProductBrief(event.target.value)} />
            {schemeBriefMissingFields.length > 0 && <div className="classifier-draft-check warning" role="status"><strong>资料检查：还缺少 {schemeBriefMissingFields.join("、")}</strong><span>仍可继续生成，但草案的覆盖范围和准确度可能不完整。</span></div>}
            {schemeDraftQuality && <div className={`classifier-draft-check ${schemeDraftQuality.passed ? "passed" : "warning"}`} role="status"><strong>{schemeDraftQuality.passed ? "生成后质量检查通过" : `生成后质量检查：${schemeDraftQuality.issues.length} 项需要确认`}</strong>{schemeDraftQuality.issues.length > 0 && <ul>{schemeDraftQuality.issues.map((issue) => <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>)}</ul>}</div>}
            <button type="button" disabled={schemeGenerating || schemeSaving || schemeImportingProductFiles || schemeRecognizingScannedPdfs} onClick={() => void generateTemplateDraft()}><Sparkles size={15} />{schemeGenerating ? `${schemeGenerationStage || "正在生成草案"}…` : "AI 生成草案"}</button>
          </section>
          <div className="classifier-scheme-form classifier-template-full-form">
            <div className="classifier-template-name-grid">
              <label><span>方案名称</span><input value={schemeName} maxLength={60} onChange={(event) => setSchemeName(event.target.value)} /></label>
              <label><span>产品/项目名称</span><input value={schemeProductName} maxLength={60} onChange={(event) => setSchemeProductName(event.target.value)} /></label>
            </div>
            <label><span>分类结构</span><small>每行一个一级分类，格式：一级分类：二级1，二级2，二级3</small><textarea value={schemeTaxonomyText} rows={8} onChange={(event) => setSchemeTaxonomyText(event.target.value)} placeholder="01_痛点：早餐赶时间，孩子不爱吃\n02_产品：商品全貌，包装展示" /></label>
            <label><span>分类规则 / 边界说明</span><textarea value={schemeRules} rows={6} onChange={(event) => setSchemeRules(event.target.value)} placeholder="写明分类原则、容易混淆的边界以及错分纠正样例" /></label>
            <section className="classifier-naming-builder" aria-label="命名规则编辑器">
              <div className="classifier-naming-heading"><div><strong>命名规则</strong><small>点击添加可用字段，拖动字段块调整顺序；固定文字会原样写入文件名。</small></div><span>{schemeNamingParts.length} 项</span></div>
              <div className="classifier-naming-options" aria-label="可用命名字段">
                {classifierNamingFields.map((item) => {
                  const used = schemeNamingParts.some((part) => part.kind === "field" && part.field === item.field);
                  return <button type="button" key={item.field} disabled={used} onClick={() => addNamingField(item.field)}><Plus size={12} />{item.label}{used ? " · 已添加" : ""}</button>;
                })}
                <button type="button" className="literal" onClick={addNamingLiteral}><Plus size={12} />固定文字</button>
              </div>
              <div className="classifier-naming-parts" aria-label="当前命名字段顺序">
                {schemeNamingParts.map((part, index) => {
                  const field = part.kind === "field" ? classifierNamingFields.find((item) => item.field === part.field) : null;
                  return (
                    <div
                      className={`classifier-naming-part ${part.kind}`}
                      draggable
                      key={part.id}
                      onDragStart={(event) => { namingDragIndex.current = index; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(index)); }}
                      onDragEnd={() => { namingDragIndex.current = null; }}
                      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
                      onDrop={(event) => { event.preventDefault(); dropNamingPart(index); }}
                    >
                      <span className="classifier-naming-drag" title="拖动调整顺序"><GripVertical size={14} /></span>
                      {part.kind === "field"
                        ? <div><strong>{field?.label}</strong><small>{classifierNamingFieldPreview(part.field, schemeProductName, schemeTaxonomyText)}</small></div>
                        : <input aria-label="固定文字" value={part.value} maxLength={40} onChange={(event) => updateNamingLiteral(part.id, event.target.value)} placeholder="输入固定文字" />}
                      <button type="button" className="remove" aria-label={`删除${part.kind === "field" ? field?.label ?? "字段" : "固定文字"}`} onClick={() => removeNamingPart(part.id)}><X size={13} /></button>
                    </div>
                  );
                })}
                {!schemeNamingParts.length && <div className="classifier-naming-empty">请从上方至少添加一个命名字段</div>}
              </div>
              <div className="classifier-naming-preview"><span>文件名预览</span><code>{schemeNamingPreview || "请添加命名字段"}.mp4</code></div>
              <p className="classifier-naming-note">系统会自动过滤文件名非法字符；同名文件仍会安全追加序号，不覆盖已有文件。</p>
            </section>
          </div>
        </div>
        <div className="classifier-inline-editor-footer">
          <div>{schemeDialog === "edit" && <><button className={schemeEditTemplateId === activeTemplateId ? "current" : "primary"} disabled={schemeEditTemplateId === activeTemplateId} onClick={() => void setActiveScheme(schemeEditTemplateId)}>{schemeEditTemplateId === activeTemplateId ? "正在使用" : "设为当前"}</button><button onClick={() => void exportTemplate(schemeEditTemplateId)}>导出</button></>}</div>
          <div><button onClick={closeSchemeEditor} disabled={schemeSaving || schemeGenerating}>收起</button><button className="primary" disabled={schemeSaving || schemeGenerating || !schemeName.trim() || !schemeProductName.trim() || !schemeTaxonomyText.trim() || !schemeNamingRule} onClick={() => void saveTemplateDialog()}>{schemeSaving ? "正在保存…" : "保存并使用"}</button></div>
        </div>
      </div>
  );

  if (view === "schemes") {
    return (
      <section className="classifier-page classifier-schemes-page">
        <div className="classifier-scroll">
          <div className="classifier-title-row">
            <div className="classifier-heading-icon workspace-heading-icon"><Tag /></div>
            <div className="classifier-title-copy"><div className="feature-title-line"><h1>分类方案</h1><ContactAuthorButton appName={appName} /></div><p>切换、创建和管理素材分类规则</p></div>
            <span>{templates.length} 个方案</span>
          </div>
          {Boolean(configHealth?.recoveredTemplates || configHealth?.recoveredFromBackup) && <div className="classifier-draft-check passed" role="status">
            <strong>已恢复 {Number(configHealth?.recoveredTemplates || 0) + Number(configHealth?.recoveredFromBackup || 0)} 个分类方案</strong>
            <span>{configHealth?.conflictCopies ? `其中 ${configHealth.conflictCopies} 个与现有方案同 ID，已保留为独立的“历史恢复”副本。` : "方案来自本机旧版数据或安全恢复副本，现有方案未被覆盖。"}</span>
          </div>}
          {Boolean(configHealth?.invalidTemplateCount) && <div className="classifier-draft-check warning" role="alert">
            <strong>发现 {configHealth?.invalidTemplateCount} 个无法读取的分类方案文件</strong>
            <span>原文件已保留，软件没有删除或用默认方案覆盖；可联系作者进一步恢复。</span>
          </div>}
          <div className="classifier-card classifier-scheme-page-card">
            <div className="classifier-scheme-page-heading">
              <div><h2>方案管理</h2><p>当前方案会直接用于素材分类工作台的一键分类。</p></div>
              <div className="classifier-scheme-toolbar"><button onClick={openCreateTemplate}><Plus size={14} />新建方案</button><button onClick={() => void importTemplate()}><Upload size={14} />导入方案</button></div>
            </div>
            <div className="classifier-scheme-list">
              {schemeDialog === "create" && expandedSchemeId === "__new__" && <article className="classifier-scheme-row classifier-scheme-new-row expanded">
                <button className="classifier-scheme-summary" type="button" aria-expanded="true" onClick={closeSchemeEditor}>
                  <span className="classifier-scheme-card-icon"><Plus size={18} /></span>
                  <span className="classifier-scheme-summary-copy"><strong>新建分类方案</strong><small>填写资料或使用 AI 生成完整分类草案</small></span>
                  <i>未保存</i><span className="classifier-scheme-chevron"><ChevronDown size={18} /></span>
                </button>
                {schemeEditor}
              </article>}
              {templates.map((item) => {
                const isActive = item.template_id === activeTemplateId;
                const isExpanded = item.template_id === expandedSchemeId;
                return (
                  <article className={`classifier-scheme-row ${isActive ? "active" : ""} ${isExpanded ? "expanded" : ""}`} key={item.template_id}>
                    <button className="classifier-scheme-summary" type="button" aria-expanded={isExpanded} onClick={() => isExpanded ? closeSchemeEditor() : openEditTemplate(item)}>
                      <span className="classifier-scheme-card-icon"><Boxes size={18} /></span>
                      <span className="classifier-scheme-summary-copy"><strong>{item.name}</strong><small>{item.product_name}</small></span>
                      {isActive && <i>当前方案</i>}
                      <span className="classifier-scheme-chevron">{isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</span>
                    </button>
                    {isExpanded && schemeDialog === "edit" && schemeEditTemplateId === item.template_id && schemeEditor}
                  </article>
                );
              })}
              {!templates.length && schemeDialog !== "create" && <div className="classifier-scheme-empty"><Boxes size={28} /><strong>暂无分类方案</strong><span>点击“新建方案”创建第一个分类方案</span></div>}
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="classifier-page">
      <div className="classifier-scroll">
        <div className="classifier-title-row">
          <div className="classifier-heading-icon workspace-heading-icon"><Boxes /></div>
          <div className="classifier-title-copy"><div className="feature-title-line"><h1>素材分类工作台</h1><ContactAuthorButton appName={appName} /></div><p>{activeTemplate ? `${activeTemplate.name} | ${activeTemplate.product_name}` : "正在加载分类方案"}</p></div>
          <span>当前分类方案</span>
        </div>

        <div className="classifier-card">
          <div className="classifier-input-card-heading">
            <h2>素材与输出</h2>
            <button type="button" disabled={!folder || preparingInput || running} onClick={clearClassifierInput}><Trash2 size={13} />清空素材</button>
          </div>
          {handoff && folder === handoff.folder && <div className="classifier-handoff-banner"><Send size={15} /><div><strong>来自媒体库：{handoff.label}</strong><span>{handoff.kind === "folder" ? "整个文件夹" : `${handoff.count} 个素材`}已接入；处理完成后会自动同步回媒体库。</span></div></div>}
          {networkSafeMessage && <div className="classifier-network-safe-banner"><ShieldCheck size={16} /><div><strong>共享网盘安全模式</strong><span>{networkSafeMessage}；已锁定单并发，并采用单文件缓存与校验回写。</span></div></div>}
          <div
            className={`classifier-input-dropzone ${inputDragActive ? "drag-active" : ""} ${folder ? "has-input" : ""}`}
            onDragEnter={(event) => { event.preventDefault(); setInputDragActive(true); }}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setInputDragActive(true); }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInputDragActive(false); }}
            onDrop={(event) => void dropClassifierInput(event)}
          >
            <div className="classifier-input-copy"><Upload size={20} /><div><label>素材文件或文件夹</label><strong title={folder}>{inputLabel ? `${inputLabel} · ${inputTypeSummary || `${inputCount} 个素材`}` : "上传或拖入待处理素材"}</strong><span>{preparingInput ? "正在读取素材…" : folder ? "继续上传或拖入会追加素材，不会替换当前列表" : "支持图片和视频；可多选文件，也可拖入整个文件夹"}</span></div></div>
            <div className="classifier-input-actions"><button disabled={preparingInput || running} onClick={() => void chooseInputFiles()}><Upload size={13} />上传文件</button><button disabled={preparingInput || running} onClick={() => void chooseInputFolder()}><FolderOpen size={13} />上传文件夹</button></div>
          </div>
          <div className="classifier-field">
            <label>输出目录</label>
            <input value={outputRoot} readOnly placeholder="首次选择后将自动记住" />
            <button onClick={() => void chooseOutputFolder()}>选择输出目录</button>
            <button onClick={() => outputRoot ? window.desktopBridge?.openLocalPath(outputRoot) : notify("请先选择输出目录")}>打开输出</button>
          </div>
        </div>

        <div className="classifier-card classifier-start-card">
            <h2>开始处理</h2><p>选择一种处理方式，确认后再从下方统一开始任务。</p>
            {recovery && <div className="classifier-recovery-banner">
              <DatabaseBackup size={18} />
              <div><strong>检测到上次未完成任务</strong><span>已完成内容和断点均已保存，继续时只处理剩余素材，不会从头重复。</span></div>
              <button type="button" disabled={running} onClick={resumeLastTask}>继续上次任务</button>
            </div>}
            <div className="classifier-workbench-scheme-picker">
              <label htmlFor="classifier-workbench-scheme">选择分类方案</label>
              <select id="classifier-workbench-scheme" value={activeTemplateId} disabled={!templates.length || running} onChange={(event) => void setActiveScheme(event.target.value)}>
                {templates.map((item) => <option key={item.template_id} value={item.template_id}>{item.name} | {item.product_name}</option>)}
              </select>
              <span>方案来自左侧“分类方案”栏目，切换后立即用于本次分类。</span>
            </div>
            <div className="classifier-options">
              <label>分类模式</label><select value={mode} onChange={(event) => setMode(event.target.value)}><option value="fast">fast 极速</option><option value="balanced">balanced 稳准</option><option value="refine">refine 精修</option></select>
              <label
                className="classifier-option-help"
                tabIndex={0}
                data-tooltip="同时处理的素材任务数量。数值越大处理越快，但会占用更多电脑性能和 API 并发额度，建议设置为 2–4。"
              >并发数</label><input type="number" value={networkSafeMessage ? 1 : workers} disabled={Boolean(networkSafeMessage)} onChange={(event) => setWorkers(Number(event.target.value))} min={1} max={12} />
              {(!inputCount || hasVideoInput) && <><label
                className="classifier-option-help"
                tabIndex={0}
                data-tooltip="仅用于视频：每个视频均匀提取并交给模型分析的画面数量。图片会直接识别，不受此项影响。"
              >视频抽帧数</label><input type="number" value={frames} onChange={(event) => setFrames(Number(event.target.value))} min={1} max={30} /></>}
            </div>
            <div className="classifier-process-methods" role="radiogroup" aria-label="选择处理方式">
              <span className="classifier-process-label">选择处理方式</span>
              <div className="classifier-process-grid">
                <button type="button" role="radio" aria-checked={processMethod === "classify"} className={`classifier-process-card ${processMethod === "classify" ? "active" : ""}`} disabled={running} onClick={() => setProcessMethod("classify")}>
                  <span className="classifier-process-radio" aria-hidden="true" />
                  <span className="classifier-process-icon"><Tag size={18} /></span>
                  <span className="classifier-process-copy"><strong>仅打标</strong><small>保留原文件，按分类方案打标并重命名</small></span>
                </button>
                <button type="button" role="radio" aria-checked={processMethod === "split"} className={`classifier-process-card ${processMethod === "split" ? "active" : ""}`} disabled={running || (inputCount > 0 && !hasVideoInput)} onClick={() => setProcessMethod("split")}>
                  <span className="classifier-process-radio" aria-hidden="true" />
                  <span className="classifier-process-icon"><Film size={18} /></span>
                  <span className="classifier-process-copy"><strong>仅分割</strong><small>只输出视频片段，不分类、不重命名</small></span>
                </button>
                <button type="button" role="radio" aria-checked={processMethod === "split-rename"} className={`classifier-process-card ${processMethod === "split-rename" ? "active" : ""}`} disabled={running || (inputCount > 0 && !hasVideoInput)} onClick={() => setProcessMethod("split-rename")}>
                  <span className="classifier-process-radio" aria-hidden="true" />
                  <span className="classifier-process-icon"><Boxes size={18} /></span>
                  <span className="classifier-process-copy"><strong>分割+打标</strong><small>先分割镜头，再按分类方案打标并重命名</small></span>
                </button>
              </div>
            </div>
            {processMethod !== "classify" && (
              <div className="classifier-split-precision" role="radiogroup" aria-label="选择切割精度">
                <div className="classifier-split-precision-heading">
                  <strong>切割精度</strong>
                  <small>仅影响视频场景检测和最短镜头时长</small>
                </div>
                <div className="classifier-split-precision-options">
                  <button type="button" role="radio" aria-checked={splitPrecision === "rough"} className={splitPrecision === "rough" ? "active" : ""} disabled={running} onClick={() => setSplitPrecision("rough")}>
                    <span className="classifier-process-radio" aria-hidden="true" />
                    <span><strong>粗略切割</strong><small>忽略轻微画面变化，减少碎片，镜头最短约 2.4 秒</small></span>
                  </button>
                  <button type="button" role="radio" aria-checked={splitPrecision === "fine"} className={splitPrecision === "fine" ? "active" : ""} disabled={running} onClick={() => setSplitPrecision("fine")}>
                    <span className="classifier-process-radio" aria-hidden="true" />
                    <span><strong>精细切割</strong><small>提高场景变化敏感度，保留更多短镜头，最短约 0.8 秒</small></span>
                  </button>
                </div>
              </div>
            )}
            <div className={`classifier-run-naming ${processMethod === "split" ? "disabled" : ""}`} aria-label="运行命名规则">
              <div className="classifier-run-naming-heading">
                <span>
                  <strong>命名规则</strong>
                  <small>{processMethod === "split" ? "仅分割模式不会应用命名规则" : "控制输出文件是否沿用原名以及是否附加序号"}</small>
                </span>
                <label className="classifier-remember-option">
                  <input
                    type="checkbox"
                    checked={namingOptions.remember}
                    disabled={running}
                    onChange={(event) => setNamingOptions((current) => ({ ...current, remember: event.target.checked }))}
                  />
                  <span>记住</span>
                </label>
              </div>
              <div className="classifier-run-naming-options">
                <label className="classifier-toggle-option">
                  <span><strong>保留原名</strong><small>在规则生成的名称前保留原文件名</small></span>
                  <input
                    type="checkbox"
                    checked={namingOptions.preserveOriginalName}
                    disabled={running || processMethod === "split"}
                    onChange={(event) => setNamingOptions((current) => ({ ...current, preserveOriginalName: event.target.checked }))}
                  />
                  <i aria-hidden="true" />
                </label>
                <label className="classifier-toggle-option">
                  <span><strong>添加序号</strong><small>按命名规则追加素材序号，避免同名</small></span>
                  <input
                    type="checkbox"
                    checked={namingOptions.addSequence}
                    disabled={running || processMethod === "split"}
                    onChange={(event) => setNamingOptions((current) => ({ ...current, addSequence: event.target.checked }))}
                  />
                  <i aria-hidden="true" />
                </label>
              </div>
            </div>
            <div className={`classifier-process-actions ${running ? "running" : ""}`}>
              <button type="button" className="classifier-process-primary" disabled={running} onClick={startSelectedProcess}>{running ? `正在${runningProcessLabel}…` : `开始${selectedProcessLabel}`}</button>
              {running ? (
                <button type="button" className="classifier-process-stop" onClick={async () => {
                  await window.desktopBridge?.classifierCancel();
                  appendLog("用户已停止当前任务。", runningAction === "split" || runningAction === "split-rename" ? "切割中断" : "不执行", runningAction === "split-rename" || runningAction === "classify" || runningAction === "review" ? "打标中断" : "不执行");
                  setRunning(false);
                  setRunningAction(null);
                  notify("任务已停止");
                }}>停止当前任务</button>
              ) : (
                <>
                  {retryTaskCount > 0 ? (
                    <button type="button" className="classifier-process-review" onClick={() => void rerunFailedTasks()}><RotateCcw size={14} />继续重跑失败任务（{retryTaskCount}）</button>
                  ) : null}
                  {recentOutput?.outputFiles.length ? (
                    <button type="button" className="classifier-process-review" disabled={recentOutputSyncing} onClick={() => void syncRecentClassifierOutput()}>
                      <RotateCcw size={14} />{recentOutputSyncing ? "正在补同步…" : `补同步最近结果（${recentOutput.outputFiles.length}）`}
                    </button>
                  ) : null}
                </>
              )}
            </div>
        </div>

        <div className="classifier-card classifier-preview-card">
          <div className="classifier-preview-heading">
            <div>
              <h2>处理结果预览 <span>{running ? "实时更新中" : previewItems.length ? `共 ${previewItems.length} 项` : "等待任务开始"}</span></h2>
              <p>切割时间段、分类标签和输出文件会逐条显示；视频悬停即可静音预览。</p>
            </div>
            <button type="button" aria-expanded={previewExpanded} onClick={() => setPreviewExpanded((current) => !current)}>
              {previewExpanded ? "收起" : "展开"}<ChevronDown size={15} className={previewExpanded ? "expanded" : ""} />
            </button>
          </div>
          {previewExpanded && (
            <div className="classifier-preview-list" aria-live="polite">
              {previewItems.length ? previewItems.map((item) => (
                <article className={`classifier-preview-row ${item.status}`} key={item.id} onClick={() => setPreviewDrawerId(item.id)}>
                  <div className="classifier-preview-media">
                    {item.media?.type === "video" ? (
                      <video
                        src={item.media.url}
                        muted
                        loop
                        playsInline
                        preload="metadata"
                        onMouseEnter={(event) => { void event.currentTarget.play().catch(() => undefined); }}
                        onMouseLeave={(event) => { event.currentTarget.pause(); event.currentTarget.currentTime = 0; }}
                      />
                    ) : item.media?.type === "image" ? (
                      <img src={item.media.url} alt="" />
                    ) : (
                      <span><Film size={22} /></span>
                    )}
                    {item.media?.type === "video" && <i>{item.timeRange || "悬停预览"}</i>}
                  </div>
                  <div className="classifier-preview-copy">
                    <div>
                      <strong title={item.title}>{item.title}</strong>
                      {item.timeRange && <time>{item.timeRange}</time>}
                    </div>
                    <div className="classifier-preview-tags">
                      {item.tags.length ? item.tags.map((tagName) => <span key={`${item.id}-${tagName}`}>{tagName}</span>) : (
                        <span className="muted">{item.status === "processing" ? "正在检测镜头边界" : item.message || (item.kind === "segment" ? "分镜已生成" : "等待分类标签")}</span>
                      )}
                    </div>
                  </div>
                  <span className={`classifier-preview-status ${item.status}`}>{item.status === "processing" ? "处理中" : item.status === "failed" ? "失败" : "已完成"}</span>
                  <button type="button" aria-label={`查看 ${item.title} 详情`} onClick={(event) => { event.stopPropagation(); setPreviewDrawerId(item.id); }}><ChevronRight size={17} /></button>
                </article>
              )) : (
                <div className="classifier-preview-empty">
                  <Film size={28} />
                  <strong>{running ? "正在读取首条处理结果…" : "暂无处理结果"}</strong>
                  <span>开始仅打标、仅分割或分割+打标后，预览会出现在这里。</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="classifier-card classifier-log-card">
          <h2>运行日志 <span>按执行顺序逐行输出处理进度</span></h2>
          <div className="classifier-terminal" role="log" aria-label="分类任务终端输出" aria-live="polite">
            <div className="classifier-terminal-toolbar">
              <span className="classifier-terminal-prompt" aria-hidden="true">›_</span>
              <span>终端输出</span>
            </div>
            <div className="classifier-terminal-body" ref={logBodyRef}>
              {logs.map((entry) => (
                <div className={`classifier-terminal-line ${classifierLogTone(entry)}`} key={entry.id}>
                  <time>[{entry.time}]</time>
                  <span>{entry.message}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        {selectedPreviewItem && typeof document !== "undefined" && createPortal(
          <div className="classifier-preview-drawer-backdrop" onMouseDown={() => setPreviewDrawerId("")}>
            <aside className="classifier-preview-drawer" aria-label="处理结果详情" onMouseDown={(event) => event.stopPropagation()}>
              <header>
                <div><span>处理结果详情</span><strong>{selectedPreviewItem.title}</strong></div>
                <button type="button" aria-label="关闭详情" onClick={() => setPreviewDrawerId("")}><X size={18} /></button>
              </header>
              <div className="classifier-preview-drawer-media">
                {selectedPreviewItem.media?.type === "video" ? (
                  <video src={selectedPreviewItem.media.url} controls muted playsInline preload="metadata" />
                ) : selectedPreviewItem.media?.type === "image" ? (
                  <img src={selectedPreviewItem.media.url} alt={selectedPreviewItem.title} />
                ) : (
                  <span><Film size={38} />当前结果还没有可播放文件</span>
                )}
              </div>
              <dl>
                <div><dt>来源</dt><dd>{selectedPreviewItem.sourceName}</dd></div>
                {selectedPreviewItem.timeRange && <div><dt>片段时间</dt><dd>{selectedPreviewItem.timeRange}</dd></div>}
                <div><dt>处理状态</dt><dd>{selectedPreviewItem.status === "processing" ? "处理中" : selectedPreviewItem.status === "failed" ? "失败" : "已完成"}</dd></div>
              </dl>
              <section>
                <strong>打标结果</strong>
                <div className="classifier-preview-tags">
                  {selectedPreviewItem.tags.length ? selectedPreviewItem.tags.map((tagName) => <span key={`drawer-${tagName}`}>{tagName}</span>) : <span className="muted">暂无标签</span>}
                </div>
              </section>
              {selectedPreviewItem.path && <code>{selectedPreviewItem.path}</code>}
              <footer>
                <button type="button" disabled={!selectedPreviewItem.path} onClick={() => selectedPreviewItem.path && window.desktopBridge?.mediaRevealFile(selectedPreviewItem.path)}><FolderOpen size={15} />在访达/文件夹中显示</button>
              </footer>
            </aside>
          </div>,
          document.body,
        )}
      </div>
    </section>
  );
}

function downloadLinksFromText(input: string) {
  const pattern = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:douyin\.com|iesdouyin\.com|xiaohongshu\.com|xhslink\.(?:com|cn))(?:\/[^\s<>"']*)?/gi;
  const links = new Map<string, "douyin" | "xiaohongshu">();
  for (const match of input.match(pattern) ?? []) {
    const cleaned = match.replace(/[，。！？；：、)）\]}】>]+$/g, "");
    const url = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
    links.set(url, /(?:xiaohongshu\.com|xhslink\.(?:com|cn))/i.test(url) ? "xiaohongshu" : "douyin");
  }
  return [...links].map(([url, platform]) => ({ url, platform }));
}

function downloadStatusLabel(status: VideoDownloadStatus) {
  return ({ queued: "等待中", parsing: "解析中", running: "下载中", completed: "已完成", failed: "失败", cancelled: "已取消" } as const)[status];
}

function VideoDownloadWorkbench({ notify, appName, input, setInput, onImport }: {
  notify: (message: string) => void;
  appName: string;
  input: string;
  setInput: (value: string) => void;
  onImport: (records: DesktopMediaRecord[], folders: LocalFolderSource[], sourceKind: "file" | "folder") => void;
}) {
  const [platformFilter, setPlatformFilter] = useState<"auto" | "douyin" | "xiaohongshu">("auto");
  const [quality, setQuality] = useState("best");
  const [autoImport, setAutoImport] = useState(true);
  const [importingSpreadsheet, setImportingSpreadsheet] = useState(false);
  const [spreadsheetImport, setSpreadsheetImport] = useState<{ fileName: string; importedCount: number } | null>(null);
  const [agreed, setAgreed] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [state, setState] = useState<VideoDownloadState>({ ready: false, paused: false, defaultOutputDirectory: "", tasks: [] });
  const [authState, setAuthState] = useState<VideoDownloadAuthState>(initialVideoDownloadAuthState);
  const [openingAuth, setOpeningAuth] = useState<"douyin" | "xiaohongshu" | null>(null);
  const importingTasks = useRef(new Set<string>());
  const links = useMemo(() => downloadLinksFromText(input), [input]);
  const acceptedLinks = useMemo(() => platformFilter === "auto" ? links : links.filter((item) => item.platform === platformFilter), [links, platformFilter]);
  const isDesktop = Boolean(typeof window !== "undefined" && window.desktopBridge?.videoDownloadBootstrap);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.videoDownloadBootstrap) {
      window.queueMicrotask(() => setState((current) => ({ ...current, ready: true, defaultOutputDirectory: "下载 / 短视频素材" })));
      return;
    }
    bridge.videoDownloadBootstrap().then((next) => { if (next) setState(next); }).catch((error) => notify(error instanceof Error ? error.message : "下载服务连接失败"));
    bridge.videoDownloadOnStateChanged?.((next) => setState(next));
  }, []);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.videoDownloadAuthBootstrap) return;
    bridge.videoDownloadAuthBootstrap().then((next) => { if (next) setAuthState(next); }).catch((error) => notify(error instanceof Error ? error.message : "登录状态读取失败"));
    bridge.videoDownloadAuthOnStateChanged?.((next) => setAuthState(next));
  }, []);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.mediaImportPaths || !bridge.videoDownloadMarkImported) return;
    state.tasks.filter((task) => task.status === "completed" && task.autoImport && !task.importedAt && task.outputFiles.length).forEach((task) => {
      if (importingTasks.current.has(task.id)) return;
      importingTasks.current.add(task.id);
      void bridge.mediaImportPaths(task.outputFiles).then((result) => {
        onImport(result.records, result.folders, result.sourceKind);
        return bridge.videoDownloadMarkImported(task.id);
      }).then(setState).catch((error) => notify(error instanceof Error ? error.message : "下载文件自动入库失败")).finally(() => importingTasks.current.delete(task.id));
    });
  }, [state.tasks]);

  const chooseOutputDirectory = async () => {
    const bridge = window.desktopBridge;
    if (!bridge?.chooseDirectory || !bridge.videoDownloadSetOutput) {
      notify("网页预览中使用示例下载目录");
      return;
    }
    const selected = await bridge.chooseDirectory();
    if (!selected) return;
    setState(await bridge.videoDownloadSetOutput(selected));
  };

  const importSpreadsheetLinks = async () => {
    const bridge = window.desktopBridge;
    if (!bridge?.videoDownloadImportSpreadsheet) return notify("上传 Excel 仅支持桌面客户端");
    setImportingSpreadsheet(true);
    try {
      const result = await bridge.videoDownloadImportSpreadsheet();
      if (result.cancelled) return;
      const combined = new Map<string, { url: string; platform: "douyin" | "xiaohongshu" }>();
      [...links, ...result.links].forEach((item) => combined.set(item.url, item));
      const accepted = [...combined.values()].slice(0, 100);
      const omitted = result.truncatedCount + Math.max(0, combined.size - 100);
      setInput(accepted.map((item) => item.url).join("\n"));
      setPlatformFilter("auto");
      setSpreadsheetImport({ fileName: result.fileName || "Excel 文档", importedCount: result.importedCount });
      notify(omitted > 0
        ? `已从 ${result.fileName || "Excel"} 读取前 ${accepted.length} 条链接，另有 ${omitted} 条超出单批限制`
        : `已从 ${result.fileName || "Excel"} 读取 ${result.importedCount} 条链接`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Excel 链接读取失败");
    } finally {
      setImportingSpreadsheet(false);
    }
  };

  const submit = async () => {
    if (!agreed) return notify("请先确认只下载本人拥有或已获授权的内容");
    if (!acceptedLinks.length) return notify("请粘贴抖音或小红书分享链接");
    const preparedInput = acceptedLinks.map((item) => item.url).join("\n");
    const bridge = window.desktopBridge;
    if (!bridge?.videoDownloadEnqueue) {
      const now = new Date().toISOString();
      const previewTasks: VideoDownloadTask[] = acceptedLinks.map((item, index) => ({
        id: `preview-${Date.now()}-${index}`,
        platform: item.platform,
        url: item.url,
        title: item.platform === "douyin" ? "抖音作品（网页预览）" : "小红书作品（网页预览）",
        status: "queued",
        progress: 0,
        message: "网页端仅预览，桌面客户端会在此开始下载",
        error: "",
        quality,
        outputDirectory: state.defaultOutputDirectory,
        outputFiles: [],
        autoImport,
        exportTable: false,
        exportError: "",
        importedAt: "",
        createdAt: now,
        updatedAt: now,
        startedAt: "",
        completedAt: "",
      }));
      setState((current) => ({ ...current, tasks: [...previewTasks, ...current.tasks] }));
      setInput("");
      notify(`网页预览已加入 ${previewTasks.length} 条示例任务`);
      return;
    }
    setSubmitting(true);
    try {
      const result = await bridge.videoDownloadEnqueue({ input: preparedInput, outputDirectory: state.defaultOutputDirectory, autoImport, exportTable: false, quality });
      setState(result.state);
      setInput("");
      notify(`已加入 ${result.added.length} 条下载任务`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "添加下载任务失败");
    } finally {
      setSubmitting(false);
    }
  };

  const setPaused = async () => {
    if (!window.desktopBridge?.videoDownloadPause) return notify("网页预览不执行真实下载");
    setState(await window.desktopBridge.videoDownloadPause(!state.paused));
  };

  const retry = async (taskId: string) => {
    if (!window.desktopBridge?.videoDownloadRetry) return notify("网页预览不执行真实下载");
    try { setState(await window.desktopBridge.videoDownloadRetry(taskId)); } catch (error) { notify(error instanceof Error ? error.message : "重试失败"); }
  };

  const cancel = async (taskId: string) => {
    if (!window.desktopBridge?.videoDownloadCancel) {
      setState((current) => ({ ...current, tasks: current.tasks.filter((task) => task.id !== taskId) }));
      return;
    }
    try { setState(await window.desktopBridge.videoDownloadCancel(taskId)); } catch (error) { notify(error instanceof Error ? error.message : "取消失败"); }
  };

  const openPlatformLogin = async (platform: "douyin" | "xiaohongshu") => {
    const bridge = window.desktopBridge;
    if (!bridge?.videoDownloadAuthOpen) return notify("平台登录仅支持桌面客户端");
    setOpeningAuth(platform);
    try {
      setAuthState(await bridge.videoDownloadAuthOpen(platform));
      notify(`已打开${platform === "douyin" ? "抖音" : "小红书"}官方登录窗口，请在窗口内完成登录`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "登录窗口打开失败");
    } finally {
      setOpeningAuth(null);
    }
  };

  const refreshPlatformLogin = async () => {
    if (!window.desktopBridge?.videoDownloadAuthRefresh) return notify("平台登录状态仅支持桌面客户端");
    try {
      const next = await window.desktopBridge.videoDownloadAuthRefresh();
      setAuthState(next);
      notify("登录状态已刷新");
    } catch (error) {
      notify(error instanceof Error ? error.message : "登录状态刷新失败");
    }
  };

  const counts = useMemo(() => ({
    completed: state.tasks.filter((task) => task.status === "completed").length,
    active: state.tasks.filter((task) => task.status === "running" || task.status === "parsing").length,
    queued: state.tasks.filter((task) => task.status === "queued").length,
  }), [state.tasks]);

  return (
    <section className="video-download-page">
      <header className="video-download-heading">
        <div className="video-download-heading-main"><div className="video-download-icon workspace-heading-icon"><Download /></div><div><div className="feature-title-line"><h1>视频下载</h1><ContactAuthorButton appName={appName} /></div><p>粘贴抖音或小红书分享链接，下载完成后可自动加入媒体库</p></div></div>
        <span className={`video-download-service ${state.ready ? "ready" : ""}`}><i />{isDesktop ? state.ready ? "本地下载服务运行正常" : "正在连接本地下载服务" : "网页预览模式"}</span>
      </header>

      <div className="video-download-content">
        <div className="video-download-compose-grid">
          <section className="video-download-card video-download-compose">
            <div className="video-download-card-head"><div><h2>添加下载任务</h2><p>支持批量粘贴，每行一个分享链接或包含链接的分享文案</p></div><div className="video-download-segments" role="radiogroup" aria-label="下载平台">{([['auto', '自动识别'], ['douyin', '抖音'], ['xiaohongshu', '小红书']] as const).map(([value, label]) => <button key={value} type="button" className={platformFilter === value ? "active" : ""} onClick={() => setPlatformFilter(value)}>{label}</button>)}</div></div>
            <textarea className="video-download-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder={'粘贴分享文案或链接，例如：\nhttps://v.douyin.com/...\nhttps://xhslink.cn/...'} />
            <div className="video-download-input-meta"><span>已识别 {acceptedLinks.length} 条链接 · 抖音 {acceptedLinks.filter((item) => item.platform === "douyin").length} 条 · 小红书 {acceptedLinks.filter((item) => item.platform === "xiaohongshu").length} 条</span><button type="button" onClick={() => setInput("")}>清空全部</button></div>
            <div className="video-download-options">
              <button className="video-download-option folder" type="button" onClick={chooseOutputDirectory}><span>保存位置</span><strong><FolderOpen size={16} />{state.defaultOutputDirectory || "选择下载目录"}</strong></button>
              <label className="video-download-option"><span>下载画质</span><select value={quality} onChange={(event) => setQuality(event.target.value)}><option value="best">最佳可用画质</option><option value="1080p">优先 1080P</option><option value="720p">优先 720P</option></select></label>
              <button className="video-download-option" type="button" onClick={() => setAutoImport((value) => !value)}><span>下载后处理</span><strong><i className={`video-download-toggle ${autoImport ? "on" : ""}`} />{autoImport ? "自动入库" : "仅保存文件"}</strong></button>
              <button className="video-download-option spreadsheet" type="button" disabled={importingSpreadsheet} onClick={() => void importSpreadsheetLinks()}><span>Excel 批量导入</span><strong title={spreadsheetImport?.fileName}><FileSpreadsheet size={16} />{importingSpreadsheet ? "正在读取…" : spreadsheetImport ? `${spreadsheetImport.fileName} · ${spreadsheetImport.importedCount} 条` : "上传 Excel 读取链接"}</strong></button>
            </div>
            <div className="video-download-submit-row"><button type="button" className="video-download-agreement" onClick={() => setAgreed((value) => !value)}><i className={agreed ? "checked" : ""}>{agreed && <Check size={11} />}</i>我确认仅下载本人拥有或已获授权的内容</button><button type="button" className="video-download-primary" disabled={submitting || !acceptedLinks.length} onClick={submit}>{submitting ? "正在添加…" : "解析并加入队列"}</button></div>
          </section>

          <aside className="video-download-card video-download-preview">
            <div className="video-download-card-head"><div><h2>解析预览</h2><p>确认平台与链接数量后加入队列</p></div><span className="video-download-count">{acceptedLinks.length} 个作品</span></div>
            {acceptedLinks.length ? <div className="video-download-preview-list">{acceptedLinks.slice(0, 3).map((item, index) => <article key={item.url}><i className={item.platform}>{item.platform === "douyin" ? "抖" : "红"}</i><div><strong>{item.platform === "douyin" ? "抖音作品" : "小红书作品"} {index + 1}</strong><span>{item.url}</span></div><Check size={16} /></article>)}{acceptedLinks.length > 3 && <small>另有 {acceptedLinks.length - 3} 条链接将在提交后依次解析</small>}</div> : <div className="video-download-preview-empty"><Film size={28} /><strong>等待粘贴分享链接</strong><span>支持抖音、小红书单条或批量链接</span></div>}
            <div className="video-download-auth-panel">
              <div className="video-download-auth-head"><div><strong>平台登录</strong><span>登录信息仅保存在本机</span></div><button type="button" onClick={() => void refreshPlatformLogin()} aria-label="刷新平台登录状态"><RefreshCw size={13} /></button></div>
              <div className="video-download-auth-actions">
                {(["douyin", "xiaohongshu"] as const).map((platform) => {
                  const auth = authState[platform];
                  return <button className={`video-download-auth-button ${platform} ${auth.loggedIn ? "logged-in" : ""}`} type="button" onClick={() => void openPlatformLogin(platform)} key={platform}>
                    <i>{platform === "douyin" ? "抖" : "红"}</i>
                    <span><strong>{auth.label}</strong><small>{auth.loggedIn ? "已检测登录态" : "未登录"}</small></span>
                    <b>{openingAuth === platform ? "正在打开…" : auth.loggedIn ? "重新登录" : "登录"}</b>
                  </button>;
                })}
              </div>
            </div>
            <p className="video-download-warning"><ShieldCheck size={15} />部分内容需要登录或完成平台验证；软件只在本机使用登录状态，不上传 Cookie。</p>
          </aside>
        </div>

        <section className="video-download-card video-download-queue">
          <div className="video-download-card-head"><div><h2>下载队列</h2><p>关闭页面不会中断任务，失败项可以单独重试</p></div><div className="video-download-queue-actions"><button type="button" disabled={!state.tasks.some((task) => task.status === "completed")} onClick={async () => { if (window.desktopBridge?.videoDownloadClearCompleted) setState(await window.desktopBridge.videoDownloadClearCompleted()); else setState((current) => ({ ...current, tasks: current.tasks.filter((task) => task.status !== "completed") })); }}><Trash2 size={14} />清除已完成</button><button type="button" onClick={setPaused}>{state.paused ? <Play size={14} /> : <Pause size={14} />}{state.paused ? "继续全部" : "暂停全部"}</button><button type="button" onClick={() => state.defaultOutputDirectory ? window.desktopBridge?.openLocalPath(state.defaultOutputDirectory) : notify("请先选择下载目录")}><FolderOpen size={14} />打开下载目录</button></div></div>
          {state.tasks.length ? <div className="video-download-task-list">{state.tasks.map((task) => <article className="video-download-task" key={task.id}><i className={`video-download-platform ${task.platform}`}>{task.platform === "douyin" ? "抖" : "红"}</i><div className="video-download-task-name"><strong>{task.title}</strong><span title={task.url}>{task.url}</span></div><div className="video-download-progress"><div><i style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }} /></div><span>{task.message || downloadStatusLabel(task.status)}</span></div><div className={`video-download-task-state ${task.status}`}>{downloadStatusLabel(task.status)}{task.status === "running" ? ` ${Math.round(task.progress)}%` : ""}</div><div className="video-download-task-actions">{task.status === "failed" || task.status === "cancelled" ? <button type="button" onClick={() => void retry(task.id)}><RotateCcw size={14} />重试</button> : task.status === "queued" || task.status === "running" || task.status === "parsing" ? <button type="button" onClick={() => void cancel(task.id)}><X size={14} />取消</button> : <button type="button" onClick={() => task.outputDirectory && window.desktopBridge?.openLocalPath(task.outputDirectory)}><FolderOpen size={14} />打开</button>}</div></article>)}</div> : <div className="video-download-queue-empty"><Download size={30} /><strong>暂无下载任务</strong><span>粘贴抖音或小红书链接后，任务会显示在这里</span></div>}
          <footer className="video-download-queue-footer"><div><span className="completed">已完成 {counts.completed}</span><span className="active">下载中 {counts.active}</span><span>等待中 {counts.queued}</span></div></footer>
        </section>
      </div>
    </section>
  );
}

function qianchuanMetric(value: number, digits = 0) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(Number(value || 0));
}

function QianchuanInsightsPanel({ insights, loading = false, error = "" }: { insights: QianchuanInsights | null; loading?: boolean; error?: string }) {
  const heading = (state: "loading" | "ready" | "unavailable" | "error", label: string) => <header className="qianchuan-insight-heading">
    <div><h3>扩展分析数据</h3><p>与基础数据在同一次同步任务中采集并缓存，包括流量、视频吸引力、成交质量和趋势。</p></div>
    <span className={state}>{state === "loading" && <RefreshCw size={12} className="spin" />}{label}</span>
  </header>;
  if (loading) return <section className="qianchuan-insights-shell" role="status" aria-live="polite" aria-busy="true">
    {heading("loading", "同步中")}
    <div className="qianchuan-insight-skeleton">
      {["流量与转化", "视频吸引力", "成交质量", "长周期结算", "按日趋势"].map((title) => <div key={title}><strong>{title}</strong><span /><span /></div>)}
    </div>
    <p className="qianchuan-insight-progress-note">正在同步扩展指标，上方已加载的基础数据可以先查看。</p>
  </section>;
  if (error) return <section className="qianchuan-insights-shell">
    {heading("error", "同步失败")}
    <div className="qianchuan-insight-state error">扩展分析数据同步失败：{error}。基础投放数据不受影响，重新打开详情即可重试。</div>
  </section>;
  if (!insights) return <section className="qianchuan-insights-shell">
    {heading("unavailable", "暂未返回")}
    <div className="qianchuan-insight-state">千川当前未返回扩展分析数据，基础投放数据仍可正常查看。</div>
  </section>;
  if (!insights.available) {
    const groupNames: Record<string, string> = {
      traffic_conversion: "流量与转化",
      video_attraction: "视频吸引力",
      transaction_quality: "成交质量",
      refund_1h: "1 小时退款",
      settlement_amounts: "结算金额",
      settlement_roi: "结算 ROI",
      delivery_split: "投放拆分",
      daily_trend: "按日趋势",
    };
    const unavailable = (insights.unavailable_groups || []).map((value) => groupNames[String(value)] || String(value)).join("、");
    return <section className="qianchuan-insights-shell">
      {heading("unavailable", "暂不可用")}
      <div className="qianchuan-insight-state">千川当前未返回扩展指标{unavailable ? `（${unavailable}）` : ""}，基础投放数据仍可正常查看。</div>
    </section>;
  }

  const groups: Array<{ title: string; note?: string; fields: Array<[string, string, "money" | "percent" | "count" | "ratio"]> }> = [
    { title: "流量与转化", fields: [["整体转化率", "conversion_rate_percent", "percent"], ["千次展现费用", "cpm", "money"], ["点击单价", "cpc", "money"], ["成交订单成本", "order_cost", "money"]] },
    { title: "视频吸引力", fields: [["2 秒播放率", "video_2s_rate_percent", "percent"], ["5 秒播放率", "video_5s_rate_percent", "percent"], ["10 秒播放率", "video_10s_rate_percent", "percent"], ["视频完播数", "video_completions", "count"], ["新增粉丝数", "new_followers", "count"]] },
    { title: "成交质量", note: "成交金额含优惠券、补贴等；实际支付与净成交采用千川各自口径，不应直接相加。", fields: [["用户实际支付金额", "actual_paid_gmv", "money"], ["智能优惠券金额", "coupon_amount", "money"], ["平台补贴金额", "platform_subsidy_amount", "money"], ["净成交金额（1小时退款口径）", "net_gmv_1h", "money"], ["1小时内退款订单数", "refund_orders_1h", "count"], ["1小时内退款金额", "refund_amount_1h", "money"], ["1小时内退款率", "refund_rate_1h", "percent"]] },
    { title: "长周期结算", note: "结算 ROI 会随退款和结算进度变化，请以相同统计周期比较。", fields: [["7 日结算金额", "settlement_gmv_7d", "money"], ["7 日结算 ROI", "settlement_roi_7d", "ratio"], ["14 日结算金额", "settlement_gmv_14d", "money"], ["14 日结算 ROI", "settlement_roi_14d", "ratio"], ["30 日结算金额", "settlement_gmv_30d", "money"], ["30 日结算 ROI", "settlement_roi_30d", "ratio"], ["90 日结算金额", "settlement_gmv_90d", "money"], ["90 日结算 ROI", "settlement_roi_90d", "ratio"]] },
    { title: "投放拆分", fields: [["基础消耗", "base_spend", "money"], ["追投消耗", "boost_spend", "money"], ["追投成交金额", "boost_gmv", "money"], ["追投 ROI", "boost_roi", "ratio"]] },
  ];
  const formatValue = (key: string, kind: "money" | "percent" | "count" | "ratio") => {
    const value = insights.metrics?.[key];
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    if (kind === "money") return `¥${qianchuanMetric(value, 2)}`;
    if (kind === "percent") return `${qianchuanMetric(value, 2)}%`;
    return qianchuanMetric(value, kind === "ratio" ? 2 : 0);
  };
  const material = insights.material;
  const materialFields: Array<[string, string[] | undefined]> = [
    ["素材状态", material.status], ["素材建议", material.advice],
    ["素材创建时间", material.created_at], ["素材上传时间", material.uploaded_at],
    ["投放类型", material.bid_type_codes?.map((code) => code === "7" ? "放量投放（7）" : code === "0" ? "控成本投放（0）" : `未知类型（${code}）`)],
    ["下单平台", material.order_platform_codes?.map((code) => code === "1" ? "千川 PC（1）" : code === "2" ? "小店随心推（2）" : `未知平台（${code}）`)],
  ];
  const maxDailySpend = Math.max(1, ...(insights.daily_trend || []).map((day) => day.spend));
  return <section className="qianchuan-insights-shell">
    {heading("ready", insights.unavailable_groups?.length ? "部分已同步" : "已同步")}
    <div className="qianchuan-insight-panel">
      {insights.unavailable_groups?.length ? <p className="qianchuan-insight-warning">部分扩展字段当前不可用，显示“—”的项目不代表数值为 0。</p> : null}
      {groups.map((group) => <section className="qianchuan-insight-group" key={group.title}>
        <h4>{group.title}</h4>{group.note && <p>{group.note}</p>}
        <div className="qianchuan-insight-grid">{group.fields.map(([label, key, kind]) => <div key={key}><span>{label}</span><strong>{formatValue(key, kind)}</strong></div>)}</div>
      </section>)}
      {materialFields.some(([, values]) => values?.length) && <section className="qianchuan-insight-group"><h4>素材与投放信息</h4><p>投放类型和平台名称依照千川返回的可用值配置显示，并保留原始编码。{!material.status?.length && !material.advice?.length ? "当前账户的素材状态和素材建议仅可用于千川报表筛选，暂不能逐条返回。" : ""}</p><div className="qianchuan-insight-grid">{materialFields.filter(([, values]) => values?.length).map(([label, values]) => <div key={label}><span>{label}</span><strong>{values?.join("、")}</strong></div>)}</div></section>}
      <section className="qianchuan-insight-group"><h4>按日趋势</h4>{insights.daily_trend?.length ? <div className="qianchuan-trend-list">{insights.daily_trend.map((day) => <div className="qianchuan-trend-row" key={day.date}><span>{day.date}</span><i><b style={{ width: `${Math.max(0, Math.min(100, day.spend / maxDailySpend * 100))}%` }} /></i><strong>¥{qianchuanMetric(day.spend, 2)}</strong><small>成交 ¥{qianchuanMetric(day.paid_gmv, 2)} · ROI {qianchuanMetric(day.paid_roi, 2)}</small></div>)}</div> : <p>当前周期暂无可用的按日趋势。</p>}</section>
    </div>
  </section>;
}

function qianchuanDateDaysAgo(days: number) {
  const value = new Date();
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() - days);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultQianchuanLibraryQuery(): QianchuanLibraryQuery {
  return {
    material_mode: "recent",
    material_limit: 100,
    material_start_date: qianchuanDateDaysAgo(29),
    material_end_date: qianchuanDateDaysAgo(0),
    report_start_date: qianchuanDateDaysAgo(29),
    report_end_date: qianchuanDateDaysAgo(0),
  };
}

function qianchuanReportPreset(query: QianchuanLibraryQuery): "7" | "30" | "90" | "custom" {
  if (query.report_end_date !== qianchuanDateDaysAgo(0)) return "custom";
  if (query.report_start_date === qianchuanDateDaysAgo(6)) return "7";
  if (query.report_start_date === qianchuanDateDaysAgo(29)) return "30";
  if (query.report_start_date === qianchuanDateDaysAgo(89)) return "90";
  return "custom";
}

function qianchuanCompactMetric(value: number, digits = 1) {
  const numeric = Number(value || 0);
  if (Math.abs(numeric) < 10000) return qianchuanMetric(numeric, Number.isInteger(numeric) ? 0 : digits);
  return `${qianchuanMetric(numeric / 10000, digits)}万`;
}

function qianchuanDuration(seconds?: number) {
  const value = Math.max(0, Math.round(Number(seconds || 0)));
  if (!value) return "--:--";
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function qianchuanTopCutoff(items: QianchuanPerformance[], read: (item: QianchuanPerformance) => number) {
  const values = items.map(read).filter((value) => Number.isFinite(value) && value > 0).sort((left, right) => right - left);
  if (!values.length) return Number.POSITIVE_INFINITY;
  return values[Math.max(0, Math.ceil(values.length * 0.1) - 1)];
}

type ViralLibraryFilter = "all" | "high-spend" | "high-roi" | "high-gmv" | "linked" | "unlinked";
type ViralLibrarySort = "comprehensive" | "spend" | "roi" | "gmv" | "orders" | "newest";

function QianchuanVideoLibrary({ bootstrap, loading, error, ensureBootstrap, onImport, assets, onLocate }: {
  bootstrap: QianchuanBootstrap | null;
  loading: boolean;
  error: string;
  ensureBootstrap: (force?: boolean) => Promise<QianchuanBootstrap>;
  onImport: (item: QianchuanPerformance, account: QianchuanAccount) => Promise<void>;
  assets: Asset[];
  onLocate: (asset: Asset) => void;
}) {
  const [advertiserId, setAdvertiserId] = useState("");
  const [items, setItems] = useState<QianchuanPerformance[]>([]);
  const [query, setQuery] = useState<QianchuanLibraryQuery>(defaultQianchuanLibraryQuery);
  const [cachedQuery, setCachedQuery] = useState<QianchuanLibraryQuery | null>(null);
  const [reportPreset, setReportPreset] = useState<"7" | "30" | "90" | "custom">("30");
  const [range, setRange] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState("");
  const [cacheLoading, setCacheLoading] = useState(false);
  const [resumable, setResumable] = useState(false);
  const [cacheHasMore, setCacheHasMore] = useState(false);
  const [syncProgress, setSyncProgress] = useState<QianchuanLibrarySyncProgress | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [importingId, setImportingId] = useState("");
  const [pageError, setPageError] = useState("");
  const [gridPage, setGridPage] = useState(1);
  const [searchText, setSearchText] = useState("");
  const [libraryFilter, setLibraryFilter] = useState<ViralLibraryFilter>("all");
  const [librarySort, setLibrarySort] = useState<ViralLibrarySort>("comprehensive");
  const [selectedMaterialId, setSelectedMaterialId] = useState("");
  const [detailVideo, setDetailVideo] = useState<QianchuanVideo | null>(null);
  const [detailResolving, setDetailResolving] = useState(false);
  const [detailInsights, setDetailInsights] = useState<QianchuanInsights | null>(null);
  const [detailInsightsLoading, setDetailInsightsLoading] = useState(false);
  const [detailInsightsError, setDetailInsightsError] = useState("");
  const [insightsByMaterial, setInsightsByMaterial] = useState<Record<string, QianchuanInsightCacheEntry>>({});
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const detailRequestSerial = useRef(0);
  const previewRequestSerial = useRef(0);

  useEffect(() => { void ensureBootstrap().catch(() => {}); }, []);
  const activeAdvertiserId = advertiserId || bootstrap?.default_advertiser_id || bootstrap?.accounts[0]?.advertiser_id || "";

  useEffect(() => {
    const unsubscribe = window.desktopBridge?.qianchuanLibraryOnProgress?.((progress) => {
      if (progress.advertiser_id !== activeAdvertiserId) return;
      setSyncProgress(progress);
      if (progress.items) {
        setItems(progress.items);
        setGridPage(1);
        if (progress.query) setCachedQuery(progress.query);
        if (progress.start_date && progress.end_date) setRange(`${progress.start_date} 至 ${progress.end_date}`);
        if (progress.synced_at) setLastSyncedAt(progress.synced_at);
        if (typeof progress.has_more === "boolean") setCacheHasMore(progress.has_more);
      }
      if (progress.insights_by_material) setInsightsByMaterial(progress.insights_by_material);
      if (progress.insight_material_id && !progress.insight_failed && progress.insight_synced_at) {
        const entry = { insights: progress.insight ?? null, synced_at: progress.insight_synced_at };
        setInsightsByMaterial((current) => ({ ...current, [progress.insight_material_id!]: entry }));
        if (selectedMaterialId === progress.insight_material_id) {
          setDetailInsights(entry.insights);
          setDetailInsightsLoading(false);
          setDetailInsightsError("");
        }
      }
    });
    return unsubscribe;
  }, [activeAdvertiserId, selectedMaterialId]);

  useEffect(() => {
    if (!activeAdvertiserId || !bootstrap?.authorization_id || !window.desktopBridge?.qianchuanLibraryCache) return;
    let cancelled = false;
    setCacheLoading(true);
    setPageError("");
    setGridPage(1);
    window.desktopBridge.qianchuanLibraryCache({
      authorization_id: bootstrap.authorization_id,
      advertiser_id: activeAdvertiserId,
    }).then((state) => {
      if (cancelled) return;
      const cached = state.cache;
      setResumable(state.resumable);
      setSyncProgress(state.checkpoint ? {
        advertiser_id: activeAdvertiserId,
        stage: state.checkpoint.stage === "insights" ? "insights" : state.checkpoint.stage === "performance" ? "performance" : "materials",
        scanned_count: state.checkpoint.scanned_count,
        collected_count: state.checkpoint.collected_count,
        message: `发现未完成同步：已扫描 ${state.checkpoint.scanned_count} 条，已选取 ${state.checkpoint.collected_count} 条`,
      } : null);
      if (!cached) {
        setItems([]);
        setInsightsByMaterial({});
        setCachedQuery(null);
        setRange("");
        setLastSyncedAt("");
        setCacheHasMore(false);
        if (state.checkpoint?.query) {
          setQuery(state.checkpoint.query);
          setReportPreset(qianchuanReportPreset(state.checkpoint.query));
        }
        return;
      }
      const restoredQuery = state.checkpoint?.query || cached.query;
      setItems(cached.items || []);
      setInsightsByMaterial(cached.insights_by_material || {});
      setQuery(restoredQuery);
      setCachedQuery(cached.query);
      setReportPreset(qianchuanReportPreset(restoredQuery));
      setRange(cached.start_date && cached.end_date ? `${cached.start_date} 至 ${cached.end_date}` : "");
      setLastSyncedAt(cached.synced_at);
      setCacheHasMore(Boolean(cached.has_more));
    }).catch((cacheError) => {
      if (!cancelled) setPageError(cacheError instanceof Error ? cacheError.message : "千川本地缓存读取失败");
    }).finally(() => {
      if (!cancelled) setCacheLoading(false);
    });
    return () => { cancelled = true; };
  }, [activeAdvertiserId, bootstrap?.authorization_id]);

  const refresh = async (requestedAdvertiserId = activeAdvertiserId) => {
    const ready = await ensureBootstrap();
    const selected = requestedAdvertiserId || ready.default_advertiser_id || ready.accounts[0]?.advertiser_id;
    if (!selected || !window.desktopBridge?.qianchuanLibrarySync) throw new Error("没有可用的千川账户");
    if (query.material_mode === "created_range" && query.material_start_date > query.material_end_date) {
      setPageError("素材创建日期的开始日期不能晚于结束日期");
      return;
    }
    if (query.report_start_date > query.report_end_date) {
      setPageError("数据统计周期的开始日期不能晚于结束日期");
      return;
    }
    setSyncing(true);
    setPageError("");
    setSyncProgress({ advertiser_id: selected, stage: "materials", scanned_count: 0, collected_count: 0, message: "正在准备同步…" });
    try {
      const result = await window.desktopBridge.qianchuanLibrarySync({
        authorization_id: ready.authorization_id,
        advertiser_id: selected,
        ...query,
      });
      if (!result.success) {
        setResumable(true);
        return;
      }
      setItems(result.items || []);
      setInsightsByMaterial(result.insights_by_material || {});
      setCachedQuery(result.query);
      setRange(result.start_date && result.end_date ? `${result.start_date} 至 ${result.end_date}` : "最近 30 天");
      setLastSyncedAt(result.synced_at);
      setCacheHasMore(Boolean(result.has_more));
      setResumable(false);
      setGridPage(1);
    } catch (requestError) {
      setPageError(requestError instanceof Error ? requestError.message : "千川数据读取失败");
    } finally {
      setSyncing(false);
    }
  };

  const cancelSync = async () => {
    await window.desktopBridge?.qianchuanLibraryCancel?.();
    setSyncProgress((current) => current ? { ...current, message: "正在安全停止，当前分页完成后会保存进度…" } : current);
  };

  const changeReportPreset = (value: "7" | "30" | "90" | "custom") => {
    setReportPreset(value);
    if (value === "custom") return;
    const days = Number(value);
    setQuery((current) => ({
      ...current,
      report_start_date: qianchuanDateDaysAgo(days - 1),
      report_end_date: qianchuanDateDaysAgo(0),
    }));
  };

  const selectedAccount = bootstrap?.accounts.find((account) => account.advertiser_id === activeAdvertiserId) ?? null;
  const queryChanged = Boolean(cachedQuery && JSON.stringify(cachedQuery) !== JSON.stringify(query));
  const cachedInsightCount = Object.keys(insightsByMaterial).length;
  const linkedAssetsByMaterial = useMemo(() => {
    const linked = new Map<string, Asset>();
    for (const asset of assets) {
      if (asset.deleted || asset.type !== "video" || !asset.qianchuan) continue;
      linked.set(`${asset.qianchuan.advertiserId}:${asset.qianchuan.materialId}`, asset);
    }
    return linked;
  }, [assets]);
  const linkedAssetFor = (item: QianchuanPerformance) => linkedAssetsByMaterial.get(`${activeAdvertiserId}:${item.material_id}`) ?? null;
  const performanceThresholds = useMemo(() => ({
    spend: qianchuanTopCutoff(items, (item) => item.spend),
    roi: qianchuanTopCutoff(items, (item) => item.paid_roi),
    gmv: qianchuanTopCutoff(items, (item) => item.paid_gmv),
  }), [items]);
  const metricMaximums = useMemo(() => ({
    spend: Math.max(1, ...items.map((item) => item.spend)),
    roi: Math.max(1, ...items.map((item) => item.paid_roi)),
    gmv: Math.max(1, ...items.map((item) => item.paid_gmv)),
    orders: Math.max(1, ...items.map((item) => item.paid_orders)),
    plays: Math.max(1, ...items.map((item) => item.video_plays)),
  }), [items]);
  const comprehensiveScore = (item: QianchuanPerformance) => (
    (item.spend / metricMaximums.spend) * 0.3
    + (item.paid_gmv / metricMaximums.gmv) * 0.25
    + (item.paid_orders / metricMaximums.orders) * 0.15
    + (item.paid_roi / metricMaximums.roi) * 0.2
    + (item.video_plays / metricMaximums.plays) * 0.1
  );
  const filteredItems = useMemo(() => {
    const normalized = searchText.trim().toLowerCase();
    const filtered = items.filter((item) => {
      if (normalized && !`${item.filename} ${item.material_id} ${item.video_id || ""}`.toLowerCase().includes(normalized)) return false;
      const linked = Boolean(linkedAssetsByMaterial.get(`${activeAdvertiserId}:${item.material_id}`));
      if (libraryFilter === "high-spend") return item.spend > 0 && item.spend >= performanceThresholds.spend;
      if (libraryFilter === "high-roi") return item.paid_roi > 0 && item.paid_roi >= performanceThresholds.roi;
      if (libraryFilter === "high-gmv") return item.paid_gmv > 0 && item.paid_gmv >= performanceThresholds.gmv;
      if (libraryFilter === "linked") return linked;
      if (libraryFilter === "unlinked") return !linked;
      return true;
    });
    return filtered.sort((left, right) => {
      if (librarySort === "spend") return right.spend - left.spend;
      if (librarySort === "roi") return right.paid_roi - left.paid_roi;
      if (librarySort === "gmv") return right.paid_gmv - left.paid_gmv;
      if (librarySort === "orders") return right.paid_orders - left.paid_orders;
      if (librarySort === "newest") return Date.parse(String(right.created_at || "").replace(" ", "T")) - Date.parse(String(left.created_at || "").replace(" ", "T"));
      return comprehensiveScore(right) - comprehensiveScore(left);
    });
  }, [activeAdvertiserId, items, libraryFilter, librarySort, linkedAssetsByMaterial, metricMaximums, performanceThresholds, searchText]);
  const pageSize = 24;
  const gridPageCount = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const visibleItems = filteredItems.slice((gridPage - 1) * pageSize, gridPage * pageSize);
  const selectedItem = items.find((item) => item.material_id === selectedMaterialId) ?? null;
  const selectedLinkedAsset = selectedItem ? linkedAssetFor(selectedItem) : null;
  const detailPoster = detailVideo?.poster_url || selectedItem?.poster_url || selectedLinkedAsset?.src || "";

  useEffect(() => { setGridPage(1); }, [searchText, libraryFilter, librarySort]);
  useEffect(() => {
    if (!selectedMaterialId) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        detailRequestSerial.current += 1;
        previewRequestSerial.current += 1;
        setSelectedMaterialId("");
        setPreviewUrl("");
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [selectedMaterialId]);

  const closeDetails = () => {
    detailRequestSerial.current += 1;
    previewRequestSerial.current += 1;
    setSelectedMaterialId("");
    setDetailVideo(null);
    setDetailInsights(null);
    setDetailInsightsLoading(false);
    setDetailInsightsError("");
    setPreviewUrl("");
    setPreviewError("");
  };

  const openDetails = (item: QianchuanPerformance) => {
    const serial = ++detailRequestSerial.current;
    previewRequestSerial.current += 1;
    setSelectedMaterialId(item.material_id);
    setDetailVideo(null);
    const hasCachedInsight = Object.prototype.hasOwnProperty.call(insightsByMaterial, item.material_id);
    const cachedInsight = hasCachedInsight ? insightsByMaterial[item.material_id] : null;
    setDetailInsights(cachedInsight?.insights ?? null);
    setDetailInsightsLoading(false);
    setDetailInsightsError("");
    setPreviewUrl("");
    setPreviewError("");
    if (!selectedAccount || !bootstrap?.authorization_id || !window.desktopBridge?.qianchuanResolve) return;
    if (window.desktopBridge.qianchuanReport && !hasCachedInsight) {
      const reportQuery = cachedQuery || query;
      setDetailInsightsLoading(true);
      setDetailInsightsError("");
      window.desktopBridge.qianchuanReport({
        authorization_id: bootstrap.authorization_id,
        advertiser_id: selectedAccount.advertiser_id,
        material_id: item.material_id,
        start_date: reportQuery.report_start_date,
        end_date: reportQuery.report_end_date,
        include_insights: true,
      }).then((result) => {
        if (detailRequestSerial.current === serial) {
          const insight = result.insights ?? null;
          setDetailInsights(insight);
          setInsightsByMaterial((current) => ({
            ...current,
            [item.material_id]: { insights: insight, synced_at: new Date().toISOString() },
          }));
        }
      }).catch((insightError) => {
        if (detailRequestSerial.current === serial) setDetailInsightsError(insightError instanceof Error ? insightError.message : "千川扩展数据同步失败");
      }).finally(() => {
        if (detailRequestSerial.current === serial) setDetailInsightsLoading(false);
      });
    }
    setDetailResolving(true);
    window.desktopBridge.qianchuanResolve({
      authorization_id: bootstrap.authorization_id,
      advertiser_id: selectedAccount.advertiser_id,
      reference: item.material_id,
    }).then((result) => {
      if (detailRequestSerial.current === serial) setDetailVideo(result.video);
    }).catch(() => {
      // Cached performance data remains usable when an optional detail refresh fails.
    }).finally(() => {
      if (detailRequestSerial.current === serial) setDetailResolving(false);
    });
  };

  const loadPreview = async (item: QianchuanPerformance) => {
    const localAsset = linkedAssetFor(item);
    const serial = ++previewRequestSerial.current;
    setPreviewError("");
    if (localAsset?.src) {
      setPreviewUrl(localAsset.src);
      return;
    }
    if (!window.desktopBridge?.qianchuanPreview) {
      setPreviewError("千川视频预览仅支持桌面版");
      return;
    }
    setPreviewLoading(true);
    try {
      const ready = await ensureBootstrap();
      const result = await window.desktopBridge.qianchuanPreview({
        authorization_id: ready.authorization_id,
        advertiser_id: activeAdvertiserId,
        reference: item.material_id,
      });
      if (previewRequestSerial.current !== serial) return;
      setDetailVideo(result.video);
      setPreviewUrl(result.preview_url);
    } catch (previewFailure) {
      if (previewRequestSerial.current === serial) setPreviewError(previewFailure instanceof Error ? previewFailure.message : "视频预览加载失败");
    } finally {
      if (previewRequestSerial.current === serial) setPreviewLoading(false);
    }
  };

  const importItem = async (item: QianchuanPerformance) => {
    if (!selectedAccount || importingId) return;
    setImportingId(item.material_id);
    try {
      await onImport(item, selectedAccount);
    } finally {
      setImportingId("");
    }
  };

  const cardBadges = (item: QianchuanPerformance) => {
    const badges: Array<{ label: string; tone: string }> = [];
    if (linkedAssetFor(item)) badges.push({ label: "已入库", tone: "linked" });
    if (item.spend > 0 && item.spend >= performanceThresholds.spend) badges.push({ label: "高消耗", tone: "amber" });
    if (item.paid_roi > 0 && item.paid_roi >= performanceThresholds.roi) badges.push({ label: "高 ROI", tone: "green" });
    if (item.paid_gmv > 0 && item.paid_gmv >= performanceThresholds.gmv) badges.push({ label: "高成交", tone: "violet" });
    if (!badges.length) badges.push({ label: "千川素材", tone: "neutral" });
    return badges.slice(0, 3);
  };

  return (
    <section className="viral-library-page">
      <header className="viral-library-heading">
        <span className="viral-heading-icon"><Film size={22} /></span>
        <div><h1>千川视频库</h1><p>集中查看千川视频与投放表现，并与本地媒体库使用同一份素材关系</p></div>
      </header>
      <div className="viral-toolbar viral-filter-panel">
        <label className="viral-account-field"><span>千川账户</span><select value={activeAdvertiserId} onChange={(event) => setAdvertiserId(event.target.value)} disabled={loading || syncing}>
          {!bootstrap?.accounts.length && <option value="">暂无可用账户</option>}
          {bootstrap?.accounts.map((account) => <option key={account.advertiser_id} value={account.advertiser_id}>{account.name} · {account.advertiser_id}</option>)}
        </select></label>
        <div className="viral-scope-field"><span>素材范围</span><div className="viral-segmented"><button type="button" className={query.material_mode === "recent" ? "active" : ""} disabled={syncing} onClick={() => setQuery((current) => ({ ...current, material_mode: "recent" }))}>最近素材</button><button type="button" className={query.material_mode === "created_range" ? "active" : ""} disabled={syncing} onClick={() => setQuery((current) => ({ ...current, material_mode: "created_range" }))}>创建日期</button></div></div>
        {query.material_mode === "recent" ? <label className="viral-count-field"><span>选取数量</span><select value={query.material_limit} disabled={syncing} onChange={(event) => setQuery((current) => ({ ...current, material_limit: Number(event.target.value) as 50 | 100 | 300 | 500 }))}><option value={50}>最近 50 条</option><option value={100}>最近 100 条</option><option value={300}>最近 300 条</option><option value={500}>最近 500 条</option></select></label> : <div className="viral-date-field"><span>素材创建日期</span><div><input type="date" value={query.material_start_date} max={query.material_end_date} disabled={syncing} onChange={(event) => setQuery((current) => ({ ...current, material_start_date: event.target.value }))} /><i>至</i><input type="date" value={query.material_end_date} min={query.material_start_date} disabled={syncing} onChange={(event) => setQuery((current) => ({ ...current, material_end_date: event.target.value }))} /></div></div>}
        <label className="viral-report-field"><span>数据统计周期</span><select value={reportPreset} disabled={syncing} onChange={(event) => changeReportPreset(event.target.value as "7" | "30" | "90" | "custom")}><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option><option value="custom">自定义日期</option></select></label>
        {reportPreset === "custom" && <div className="viral-date-field report"><span>投放数据日期</span><div><input type="date" value={query.report_start_date} max={query.report_end_date} disabled={syncing} onChange={(event) => setQuery((current) => ({ ...current, report_start_date: event.target.value }))} /><i>至</i><input type="date" value={query.report_end_date} min={query.report_start_date} disabled={syncing} onChange={(event) => setQuery((current) => ({ ...current, report_end_date: event.target.value }))} /></div></div>}
        <div className="viral-sync-actions">{syncing ? <button type="button" className="secondary" onClick={() => void cancelSync()}>取消同步</button> : null}<button type="button" onClick={() => void refresh(activeAdvertiserId)} disabled={loading || syncing || cacheLoading || !activeAdvertiserId}><RefreshCw size={15} className={syncing ? "spin" : ""} />{syncing ? "正在同步" : resumable ? "继续同步" : lastSyncedAt ? "刷新当前结果" : "同步当前范围"}</button></div>
      </div>
      <div className={`viral-cache-status ${queryChanged ? "changed" : ""}`}><div><strong>{cacheLoading ? "正在读取本地缓存…" : lastSyncedAt ? `上次同步：${formatServerDate(lastSyncedAt)}` : "当前账户还没有本地缓存"}</strong><span>{lastSyncedAt ? `已缓存 ${items.length} 条素材 · 扩展分析 ${cachedInsightCount}/${items.length} · 数据周期 ${range || "—"}` : "设置素材范围和数据统计周期后开始同步；以后进入页面会直接显示缓存。"}</span></div>{queryChanged && <em>筛选条件已修改，点击“刷新当前结果”后生效</em>}{resumable && !syncing && <em>检测到未完成同步，可以从上次分页继续</em>}{syncProgress && (syncing || syncProgress.stage === "complete") && <em>{syncProgress.message}</em>}</div>
      {(error || pageError) && <div className="viral-alert"><AlertTriangle size={16} /><span>{pageError || error}</span><button type="button" onClick={() => void ensureBootstrap(true).then(() => refresh(activeAdvertiserId)).catch(() => {})}>重试</button></div>}
      <div className="viral-view-toolbar">
        <label className="viral-search-field"><Search size={16} /><input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="搜索素材名称、素材 ID…" /></label>
        <div className="viral-performance-filters" role="tablist" aria-label="千川素材筛选">
          {([
            ["all", "全部"], ["high-spend", "高消耗"], ["high-roi", "高 ROI"], ["high-gmv", "高成交"], ["linked", "已入库"], ["unlinked", "未入库"],
          ] as Array<[ViralLibraryFilter, string]>).map(([value, label]) => <button type="button" role="tab" aria-selected={libraryFilter === value} className={libraryFilter === value ? "active" : ""} key={value} onClick={() => setLibraryFilter(value)}>{label}</button>)}
        </div>
        <label className="viral-sort-field"><ArrowDownUp size={14} /><select aria-label="爆款素材排序" value={librarySort} onChange={(event) => setLibrarySort(event.target.value as ViralLibrarySort)}><option value="comprehensive">综合表现</option><option value="spend">消耗最高</option><option value="roi">ROI 最高</option><option value="gmv">成交额最高</option><option value="orders">订单最多</option><option value="newest">创建时间最新</option></select></label>
      </div>
      <div className="viral-summary-grid">
        <div><span>已读取素材</span><strong>{items.length}</strong></div>
        <div><span>总消耗</span><strong>¥{qianchuanMetric(items.reduce((sum, item) => sum + item.spend, 0), 2)}</strong></div>
        <div><span>累计播放</span><strong>{qianchuanMetric(items.reduce((sum, item) => sum + item.video_plays, 0))}</strong></div>
        <div><span>已导入媒体库</span><strong>{items.filter((item) => linkedAssetFor(item)).length}</strong></div>
      </div>
      {items.length ? (
        <div className="viral-card-results">
          {filteredItems.length ? <div className="viral-card-grid">{visibleItems.map((item) => {
            const linkedAsset = linkedAssetFor(item);
            const localVideoUrl = linkedAsset?.type === "video" ? linkedAsset.src : "";
            const poster = item.poster_url || (linkedAsset?.type === "image" ? linkedAsset.src : "");
            return <article className={`viral-video-card ${selectedMaterialId === item.material_id ? "selected" : ""}`} key={item.material_id} role="button" tabIndex={0} onClick={() => openDetails(item)} onKeyDown={(event) => { if (event.key === "Enter") openDetails(item); }}>
              <div className="viral-card-preview">
                <div className="viral-card-placeholder"><Film size={36} /><span>千川视频素材</span></div>
                {localVideoUrl ? <video src={localVideoUrl} poster={poster || undefined} muted playsInline preload="metadata" /> : poster && <img src={poster} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
                <div className="viral-card-badges">{cardBadges(item).map((badge) => <span className={badge.tone} key={badge.label}>{badge.label}</span>)}</div>
                <button type="button" className="viral-card-play" aria-label={`预览 ${item.filename}`} onClick={(event) => { event.stopPropagation(); openDetails(item); void loadPreview(item); }}><Play size={18} fill="currentColor" /></button>
                <span className="viral-card-duration">{qianchuanDuration(item.duration_seconds)}</span>
              </div>
              <div className="viral-card-body">
                <strong title={item.filename}>{item.filename}</strong>
                <small>素材 ID {item.material_id}{item.created_at ? ` · ${item.created_at.slice(0, 10)}` : ""}</small>
                <div className="viral-card-metrics"><div><span>消耗</span><b>¥{qianchuanCompactMetric(item.spend)}</b></div><div><span>成交 ROI</span><b className="accent">{qianchuanMetric(item.paid_roi, 2)}</b></div><div><span>成交金额</span><b>¥{qianchuanCompactMetric(item.paid_gmv)}</b></div><div><span>成交订单</span><b>{qianchuanCompactMetric(item.paid_orders)}</b></div></div>
              </div>
              <footer><span>{item.video_3s_play_rate_percent > 0 ? `3秒播放率 ${qianchuanMetric(item.video_3s_play_rate_percent, 1)}%` : `播放 ${qianchuanCompactMetric(item.video_plays)}`}</span>{linkedAsset ? <button type="button" onClick={(event) => { event.stopPropagation(); onLocate(linkedAsset); }}><FolderOpen size={13} />媒体库查看</button> : <button type="button" disabled={!selectedAccount || importingId === item.material_id} onClick={(event) => { event.stopPropagation(); void importItem(item); }}><Download size={13} />{importingId === item.material_id ? "正在导入" : "导入媒体库"}</button>}</footer>
            </article>;
          })}</div> : <div className="viral-filter-empty"><Search size={28} /><strong>没有符合当前筛选的素材</strong><button type="button" onClick={() => { setSearchText(""); setLibraryFilter("all"); }}>清除筛选</button></div>}
          {gridPageCount > 1 && <div className="viral-pagination"><button type="button" disabled={gridPage <= 1} onClick={() => setGridPage((current) => Math.max(1, current - 1))}>上一页</button><span>第 {gridPage}/{gridPageCount} 页 · 共 {filteredItems.length} 条</span><button type="button" disabled={gridPage >= gridPageCount} onClick={() => setGridPage((current) => Math.min(gridPageCount, current + 1))}>下一页</button></div>}{cacheHasMore && <p className="viral-truncated-note">当前结果已按所选范围截取；如需更多素材，请提高数量或改用创建日期范围。</p>}
        </div>
      ) : !syncing && !error && !pageError ? (
        <div className="viral-empty"><Film size={34} /><strong>暂无可展示的千川画面数据</strong><span>选择素材范围和数据统计周期后点击“同步当前范围”。</span></div>
      ) : null}
      {selectedItem && createPortal(<div className="viral-detail-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDetails(); }}>
        <aside className="viral-detail-drawer" role="dialog" aria-modal="true" aria-label="千川素材详情" onMouseDown={(event) => event.stopPropagation()}>
          <header><div><span>千川素材详情</span><strong title={selectedItem.filename}>{selectedItem.filename}</strong></div><button type="button" onClick={closeDetails} aria-label="关闭素材详情"><X size={18} /></button></header>
          <div className="viral-detail-scroll">
            <div className="viral-detail-preview">
              <div className="viral-card-placeholder"><Film size={42} /><span>{previewLoading ? "正在获取安全预览…" : "点击播放当前素材"}</span></div>
              {!previewUrl && detailPoster && <img src={detailPoster} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
              {previewUrl && <video src={previewUrl} poster={detailPoster || undefined} controls autoPlay playsInline preload="metadata" onError={() => setPreviewError("视频预览加载失败，可导入媒体库后播放")} />}
              {!previewUrl && <button type="button" className="viral-detail-play" disabled={previewLoading} onClick={() => void loadPreview(selectedItem)}>{previewLoading ? <RefreshCw size={18} className="spin" /> : <Play size={20} fill="currentColor" />}{previewLoading ? "加载中" : "播放预览"}</button>}
            </div>
            {previewError && <div className="viral-detail-error"><AlertTriangle size={14} />{previewError}</div>}
            <div className="viral-detail-identity"><span>素材 ID {selectedItem.material_id}</span><span>{selectedAccount?.name || "千川账户"}</span><span>{selectedItem.created_at ? `创建 ${selectedItem.created_at}` : "创建时间未返回"}</span>{detailResolving && <em>正在刷新素材信息…</em>}{detailInsightsLoading && <em className="insights"><RefreshCw size={10} className="spin" />扩展数据同步中…</em>}</div>
            <section className="viral-detail-section"><h3>所选周期核心数据</h3><p>{range || `${query.report_start_date} 至 ${query.report_end_date}`}</p><div className="viral-detail-primary-metrics"><div><span>消耗</span><strong>¥{qianchuanMetric(selectedItem.spend, 2)}</strong></div><div><span>成交金额</span><strong>¥{qianchuanMetric(selectedItem.paid_gmv, 2)}</strong></div><div><span>成交 ROI</span><strong className="accent">{qianchuanMetric(selectedItem.paid_roi, 2)}</strong></div><div><span>成交订单</span><strong>{qianchuanMetric(selectedItem.paid_orders)}</strong></div></div></section>
            <section className="viral-detail-section"><h3>播放与互动</h3><div className="viral-detail-metric-list"><div><span>累计播放</span><strong>{qianchuanMetric(selectedItem.video_plays)}</strong></div><div><span>整体展现次数</span><strong>{qianchuanMetric(selectedItem.live_impressions)}</strong></div><div><span>整体点击次数</span><strong>{qianchuanMetric(selectedItem.live_viewers)}</strong></div><div><span>整体点击率</span><strong>{qianchuanMetric(selectedItem.live_conversion_rate_percent, 2)}%</strong></div><div><span>点赞</span><strong>{qianchuanMetric(selectedItem.video_likes)}</strong></div><div><span>评论</span><strong>{qianchuanMetric(selectedItem.video_comments)}</strong></div><div><span>平均观看时长</span><strong>{qianchuanMetric(selectedItem.video_average_watch_seconds, 1)} 秒</strong></div></div><div className="viral-rate-bars"><div><span>3 秒播放率</span><i><b style={{ width: `${Math.max(0, Math.min(100, selectedItem.video_3s_play_rate_percent))}%` }} /></i><strong>{qianchuanMetric(selectedItem.video_3s_play_rate_percent, 2)}%</strong></div><div><span>完播率</span><i><b style={{ width: `${Math.max(0, Math.min(100, selectedItem.video_completion_rate_percent))}%` }} /></i><strong>{qianchuanMetric(selectedItem.video_completion_rate_percent, 2)}%</strong></div></div></section>
            <QianchuanInsightsPanel insights={detailInsights} loading={detailInsightsLoading} error={detailInsightsError} />
            <section className="viral-detail-section viral-media-link"><h3>媒体库关联</h3>{selectedLinkedAsset ? <><div className="viral-linked-state"><ShieldCheck size={16} /><div><strong>已导入媒体库</strong><span>{selectedLinkedAsset.collection || QIANCHUAN_PROJECT_COLLECTION} · {selectedLinkedAsset.name}</span></div></div><button type="button" onClick={() => onLocate(selectedLinkedAsset)}><FolderOpen size={14} />在媒体库中查看</button></> : <><div className="viral-linked-state unlinked"><Unlink size={16} /><div><strong>尚未导入媒体库</strong><span>当前只缓存千川素材信息，导入时才下载原视频。</span></div></div><button type="button" disabled={!selectedAccount || importingId === selectedItem.material_id} onClick={() => void importItem(selectedItem)}><Download size={14} />{importingId === selectedItem.material_id ? "正在导入…" : "导入媒体库"}</button></>}</section>
          </div>
        </aside>
      </div>, document.body)}
    </section>
  );
}

function groupViralLibraryItems<T>(items: T[], getCategory: (item: T) => string | undefined) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = getCategory(item)?.trim() || "未分组";
    groups.set(name, [...(groups.get(name) || []), item]);
  }
  return [...groups].map(([name, groupedItems]) => ({ name, items: groupedItems }));
}

function ViralCategorySelect({ name, selectedCount, totalCount, disabled = false, onToggle }: {
  name: string;
  selectedCount: number;
  totalCount: number;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const checkboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = selectedCount > 0 && selectedCount < totalCount;
  }, [selectedCount, totalCount]);
  return <label className="viral-category-select"><input ref={checkboxRef} type="checkbox" checked={totalCount > 0 && selectedCount === totalCount} disabled={disabled || totalCount === 0} onChange={onToggle} aria-label={`全选大分类：${name}`} /><span>{name}</span></label>;
}

function ViralLibraryTabs({ section, onNavigate }: {
  section: "viral-visuals" | "viral-copy";
  onNavigate: (section: "viral-visuals" | "viral-copy") => void;
}) {
  return <div className="viral-heading-tabs"><button type="button" className={section === "viral-visuals" ? "active" : ""} onClick={() => onNavigate("viral-visuals")}>画面</button><button type="button" className={section === "viral-copy" ? "active" : ""} onClick={() => onNavigate("viral-copy")}>文案</button></div>;
}

function ViralLibrarySearch({ value, onChange }: {
  value: string;
  onChange: (value: string) => void;
}) {
  return <label className="viral-guidance-search"><Search size={15} /><input value={value} onChange={(event) => onChange(event.target.value)} placeholder="搜索画面、文案或大分类" aria-label="搜索画面和文案" /></label>;
}

function csvDataFieldPresentation(field: { name: string; value: string }) {
  const value = String(field.value ?? "");
  const lineCount = value.split(/\r?\n/).length;
  return {
    wide: value.length > 90 || lineCount > 2,
    long: value.length > 320 || lineCount > 8,
  };
}

function csvDataDialogLayout(fields: Array<{ name: string; value: string }>) {
  const wideFieldCount = fields.filter((field) => csvDataFieldPresentation(field).wide).length;
  if (fields.length <= 2 && wideFieldCount === 0) return "compact";
  if (fields.length <= 6 && wideFieldCount === 0) return "medium";
  return "wide";
}

function ViralVisualLibrary({ assets, searchQuery, onSearchQueryChange, onNavigate, onLocate, onPreview, onUpload, onImportCsv, onDropFiles, onRemove, onSetCategory, onViewData, onBindData }: {
  assets: Asset[];
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onNavigate: (section: "viral-visuals" | "viral-copy") => void;
  onLocate: (asset: Asset) => void;
  onPreview: (asset: Asset) => void;
  onUpload: () => Promise<void>;
  onImportCsv: () => Promise<void>;
  onDropFiles: (files: File[]) => Promise<void>;
  onRemove: (ids: number[], mode: "library" | "trash") => void;
  onSetCategory: (ids: number[], category: string) => void;
  onViewData: (asset: Asset) => void;
  onBindData: (asset: Asset) => void;
}) {
  const [visualTypeFilter, setVisualTypeFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [dataFilter, setDataFilter] = useState<"all" | "linked" | "csv" | "qianchuan" | "none">("all");
  const [sortMode, setSortMode] = useState<"recent" | "oldest" | "name-asc" | "name-desc">("recent");
  const frames = assets.filter((asset) => (
    !asset.deleted
    && (asset.type === "image" || asset.type === "video")
    && (asset.collection === VIRAL_FRAME_COLLECTION || asset.tags.includes(VIRAL_FRAME_COLLECTION))
  ));
  const categoryOptions = [...new Set(frames.map((asset) => asset.majorCategory?.trim()).filter((item): item is string => Boolean(item)))].sort((left, right) => left.localeCompare(right, "zh-CN"));
  const visualTypeOptions = [...new Set([
    ...DEFAULT_VIRAL_VISUAL_TYPES,
    ...frames.flatMap(viralVisualTypesForAsset),
  ])].sort((left, right) => {
    const leftDefault = DEFAULT_VIRAL_VISUAL_TYPES.indexOf(left as typeof DEFAULT_VIRAL_VISUAL_TYPES[number]);
    const rightDefault = DEFAULT_VIRAL_VISUAL_TYPES.indexOf(right as typeof DEFAULT_VIRAL_VISUAL_TYPES[number]);
    if (leftDefault >= 0 && rightDefault >= 0) return leftDefault - rightDefault;
    if (leftDefault >= 0) return -1;
    if (rightDefault >= 0) return 1;
    return left.localeCompare(right, "zh-CN");
  });
  const matchingFrames = frames.filter((asset) => {
    if (!matchesViralLibrarySearch(searchQuery, [asset.name, asset.majorCategory, asset.description, asset.tags.join(" "), viralVisualTypesForAsset(asset).join(" "), asset.qianchuan?.materialId, ...(asset.csvData?.fields || []).flatMap((field) => [field.name, field.value])])) return false;
    if (visualTypeFilter !== "all" && !viralVisualTypesForAsset(asset).includes(visualTypeFilter)) return false;
    const category = asset.majorCategory?.trim() || "";
    if (categoryFilter === "ungrouped" && category) return false;
    if (categoryFilter !== "all" && categoryFilter !== "ungrouped" && category !== categoryFilter) return false;
    const hasCsvData = Boolean(asset.csvData);
    const hasQianchuanData = Boolean(asset.qianchuan);
    if (dataFilter === "linked" && !hasCsvData && !hasQianchuanData) return false;
    if (dataFilter === "csv" && !hasCsvData) return false;
    if (dataFilter === "qianchuan" && !hasQianchuanData) return false;
    if (dataFilter === "none" && (hasCsvData || hasQianchuanData)) return false;
    return true;
  }).sort((left, right) => {
    if (sortMode === "name-asc") return left.name.localeCompare(right.name, "zh-CN", { numeric: true });
    if (sortMode === "name-desc") return right.name.localeCompare(left.name, "zh-CN", { numeric: true });
    const leftTime = left.modifiedAt || 0;
    const rightTime = right.modifiedAt || 0;
    return sortMode === "oldest" ? leftTime - rightTime : rightTime - leftTime;
  });
  const frameGroups = groupViralLibraryItems(matchingFrames, (asset) => asset.majorCategory);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [deleteIds, setDeleteIds] = useState<number[]>([]);
  const [deleteMode, setDeleteMode] = useState<"library" | "trash">("library");
  const [dragActive, setDragActive] = useState(false);
  const [csvDataAssetId, setCsvDataAssetId] = useState<number | null>(null);
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [categoryDraft, setCategoryDraft] = useState("");
  const selectionAnchor = useRef<number | null>(null);
  const visibleIds = matchingFrames.map((asset) => asset.id);
  const selectedVisibleIds = visibleIds.filter((id) => selectedIds.includes(id));
  const csvDataAsset = frames.find((asset) => asset.id === csvDataAssetId);
  const csvDataFields = csvDataAsset?.csvData?.fields || [];
  const csvDataLayout = csvDataDialogLayout(csvDataFields);
  const selectFrame = (event: ReactMouseEvent<HTMLElement>, id: number, toggle = false) => {
    const additive = event.metaKey || event.ctrlKey;
    if (event.shiftKey && selectionAnchor.current !== null) {
      const first = visibleIds.indexOf(selectionAnchor.current);
      const last = visibleIds.indexOf(id);
      if (first >= 0 && last >= 0) {
        const range = visibleIds.slice(Math.min(first, last), Math.max(first, last) + 1);
        setSelectedIds((current) => additive ? [...new Set([...current, ...range])] : range);
        return;
      }
    }
    setSelectedIds((current) => toggle || additive
      ? current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      : [id]);
    selectionAnchor.current = id;
  };
  const openDelete = (ids: number[]) => { setDeleteIds(ids); setDeleteMode("library"); };
  const openCategory = (ids: number[]) => { setCategoryIds(ids); setCategoryDraft(ids.length === 1 ? frames.find((asset) => asset.id === ids[0])?.majorCategory || "" : ""); };
  const toggleFrameGroup = (ids: number[]) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
      ids.forEach((id) => { if (allSelected) next.delete(id); else next.add(id); });
      return [...next];
    });
    selectionAnchor.current = ids[0] ?? null;
  };
  const confirmDelete = () => {
    if (!deleteIds.length) return;
    onRemove(deleteIds, deleteMode);
    setSelectedIds((current) => current.filter((id) => !deleteIds.includes(id)));
    selectionAnchor.current = null;
    setDeleteIds([]);
  };
  return (
    <section className={`viral-library-page viral-frame-page ${dragActive ? "drag-active" : ""}`} onDragOver={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragActive(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragActive(false); }} onDrop={(event) => { event.preventDefault(); setDragActive(false); void onDropFiles(Array.from(event.dataTransfer.files)); }}>
      <header className="viral-library-heading">
        <span className="viral-heading-icon frames"><Images size={22} /></span>
        <div><h1>爆款画面库</h1><p>卡片网格展示图片与视频；原文件仍保存在本地媒体库</p></div>
        <ViralLibraryTabs section="viral-visuals" onNavigate={onNavigate} />
      </header>
      <div className="viral-frame-guidance"><Sparkles size={18} /><div className="viral-guidance-copy"><strong>画面与文案可独立，也可关联</strong><span>点击或拖入单个／多个画面；支持 JPG、JPEG、PNG、WEBP、GIF、AVIF、BMP、MP4、MOV、M4V、WEBM、MKV、AVI。上传时可同步导入 CSV 数据；独立 CSV 导入也可按实际表头自选对应字段。</span></div><ViralLibrarySearch value={searchQuery} onChange={onSearchQueryChange} /><div className="viral-guidance-actions"><button type="button" onClick={() => void onUpload()}><Upload size={14} />上传画面（单个／多个）</button><button type="button" onClick={() => void onImportCsv()}><FileSpreadsheet size={14} />导入 CSV</button></div></div>
      {dragActive && <div className="viral-frame-drop-hint">松开即可添加画面，可同时拖入一个 CSV 数据文件</div>}
      <div className="viral-frame-filterbar" aria-label="画面筛选和排序">
        <label><span>大分类</span><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">全部大分类</option><option value="ungrouped">未分组</option>{categoryOptions.map((category) => <option value={category} key={category}>{category}</option>)}</select></label>
        <label><span>画面类型</span><select value={visualTypeFilter} onChange={(event) => setVisualTypeFilter(event.target.value)}><option value="all">全部画面类型</option>{visualTypeOptions.map((visualType) => <option value={visualType} key={visualType}>{visualType}</option>)}</select></label>
        <label><span>数据状态</span><select value={dataFilter} onChange={(event) => setDataFilter(event.target.value as typeof dataFilter)}><option value="all">全部数据</option><option value="linked">已关联数据</option><option value="csv">CSV 数据</option><option value="qianchuan">千川数据</option><option value="none">无关联数据</option></select></label>
        <label><span><ArrowDownUp size={12} />排序</span><select value={sortMode} onChange={(event) => setSortMode(event.target.value as typeof sortMode)}><option value="recent">最近修改</option><option value="oldest">最早修改</option><option value="name-asc">名称 A–Z</option><option value="name-desc">名称 Z–A</option></select></label>
        <span className="viral-frame-result-count">显示 {matchingFrames.length} / {frames.length} 个画面</span>
        {(searchQuery.trim() || visualTypeFilter !== "all" || categoryFilter !== "all" || dataFilter !== "all" || sortMode !== "recent") && <button type="button" onClick={() => { onSearchQueryChange(""); setVisualTypeFilter("all"); setCategoryFilter("all"); setDataFilter("all"); setSortMode("recent"); }}>重置筛选</button>}
      </div>
      {matchingFrames.length > 0 && <div className="viral-frame-selection-toolbar"><label><input type="checkbox" checked={selectedVisibleIds.length === matchingFrames.length} onChange={() => { setSelectedIds(selectedVisibleIds.length === matchingFrames.length ? [] : visibleIds); selectionAnchor.current = matchingFrames[0]?.id ?? null; }} />全选当前结果</label><span>已选 {selectedVisibleIds.length} 个 · 点击单选，⌘/Ctrl 点击追加，Shift 连选</span><button type="button" disabled={!selectedVisibleIds.length} onClick={() => openCategory(selectedVisibleIds)}>设置大分类</button><button type="button" disabled={!selectedVisibleIds.length} onClick={() => openDelete(selectedVisibleIds)}><Trash2 size={13} />删除所选</button></div>}
      {matchingFrames.length ? <div className="viral-category-sections">{frameGroups.map((group) => {
        const groupIds = group.items.map((asset) => asset.id);
        const groupSelectedCount = groupIds.filter((id) => selectedIds.includes(id)).length;
        return <section className="viral-category-section" key={group.name}><header><ViralCategorySelect name={group.name} selectedCount={groupSelectedCount} totalCount={groupIds.length} onToggle={() => toggleFrameGroup(groupIds)} /><small>{group.items.length} 个画面</small></header><div className="viral-frame-grid">{group.items.map((asset) => <article className={`viral-frame-card ${selectedIds.includes(asset.id) ? "selected" : ""}`} key={asset.id} onClick={(event) => selectFrame(event, asset.id)}>
        <label className="viral-frame-select" title="选择画面" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selectedIds.includes(asset.id)} readOnly onClick={(event) => { event.stopPropagation(); selectFrame(event, asset.id, true); }} aria-label={`选择画面：${asset.name}`} /></label>
        <div className="viral-frame-preview">{asset.src ? asset.type === "video" ? <><video src={asset.src} preload="metadata" muted playsInline /><button type="button" className="viral-frame-play" aria-label={`播放预览：${asset.name}`} onClick={(event) => { event.stopPropagation(); onPreview(asset); }}><Play size={20} fill="currentColor" /></button></> : <img src={asset.src} alt="" loading="lazy" /> : <div><ImageIcon size={30} /><span>等待本地文件授权</span></div>}</div>
        <div className="viral-frame-info"><strong title={asset.name}>{asset.name}</strong><span>{asset.type === "video" ? "视频" : "图片"} · {asset.size}{asset.tags.length ? ` · ${asset.tags.slice(0, 2).join(" / ")}` : ""}</span><button type="button" className="viral-frame-delete danger icon-only" aria-label={`删除画面：${asset.name}`} title="删除画面" onClick={(event) => { event.stopPropagation(); openDelete([asset.id]); }}><Trash2 size={13} /></button><div className="viral-frame-actions"><button type="button" onClick={(event) => { event.stopPropagation(); openCategory([asset.id]); }}>大分类</button><button type="button" className="icon-only" aria-label={`在媒体库中查看：${asset.name}`} title="在媒体库中查看" onClick={(event) => { event.stopPropagation(); onLocate(asset); }}><FolderOpen size={14} /></button>{asset.csvData && <button type="button" onClick={(event) => { event.stopPropagation(); setCsvDataAssetId(asset.id); }}>全部数据</button>}{asset.type === "video" && <button type="button" onClick={(event) => { event.stopPropagation(); (asset.qianchuan ? onViewData : onBindData)(asset); }}>{asset.qianchuan ? "查看千川数据" : "绑定千川数据"}</button>}</div>{visualCardUploadedData(asset).length > 0 && <dl className="viral-frame-data-summary" aria-label="画面数据摘要">{visualCardUploadedData(asset).map((field, fieldIndex) => <div key={`${field.name}-${fieldIndex}`} title={`${field.name}：${field.value}`}><dt>{field.name}</dt><dd>{field.value}</dd></div>)}</dl>}</div>
      </article>)}</div></section>;
      })}</div> : <div className="viral-empty"><Images size={34} /><strong>{frames.length ? "没有符合当前筛选的画面" : "还没有收录爆款画面"}</strong><span>{frames.length ? "可重置筛选，或尝试其他名称、大分类与数据状态。" : "上传图片或视频后，可按自定义大分类查看。"}</span></div>}
      {deleteIds.length > 0 && createPortal(<div className="copy-modal-backdrop" role="presentation"><section className="copy-action-dialog" role="alertdialog" aria-modal="true" aria-label="删除画面"><h2>处理 {deleteIds.length} 个画面？</h2><p>只处理媒体库索引，不删除磁盘上的原图片或视频；已保存的文案也会保留。</p><label className="viral-frame-delete-option"><input type="radio" name="viral-frame-delete-mode" checked={deleteMode === "library"} onChange={() => setDeleteMode("library")} />仅从爆款画面库移除，媒体库仍可查看</label><label className="viral-frame-delete-option"><input type="radio" name="viral-frame-delete-mode" checked={deleteMode === "trash"} onChange={() => setDeleteMode("trash")} />移入媒体库回收站</label><footer><button type="button" onClick={() => setDeleteIds([])}>取消</button><button type="button" className="danger" onClick={confirmDelete}>确认处理</button></footer></section></div>, document.body)}
      {categoryIds.length > 0 && createPortal(<div className="copy-modal-backdrop" role="presentation"><section className="copy-action-dialog" role="dialog" aria-modal="true" aria-label="设置画面大分类"><h2>设置 {categoryIds.length} 个画面的大分类</h2><p>名称由你填写；留空并保存会将所选画面移到“未分组”。</p><label className="viral-major-category-field"><span>大分类</span><input autoFocus value={categoryDraft} maxLength={100} onChange={(event) => setCategoryDraft(event.target.value)} placeholder="输入大分类名称" /></label><footer><button type="button" onClick={() => setCategoryIds([])}>取消</button><button type="button" onClick={() => { onSetCategory(categoryIds, categoryDraft.trim()); setCategoryIds([]); }}>保存分类</button></footer></section></div>, document.body)}
      {csvDataAsset?.csvData && createPortal(
        <div className="copy-modal-backdrop" role="presentation" onMouseDown={() => setCsvDataAssetId(null)}>
          <section className={`copy-action-dialog viral-csv-data-dialog ${csvDataLayout}`} role="dialog" aria-modal="true" aria-label="查看 CSV 数据" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div className="viral-csv-data-heading"><h2 title={csvDataAsset.name}>{csvDataAsset.name} · CSV 数据</h2><small>{csvDataFields.length} 个字段</small></div>
              <button type="button" aria-label="关闭" title="关闭" onClick={() => setCsvDataAssetId(null)}><X size={17} /></button>
            </header>
            <p className="viral-csv-data-meta">来源：{csvDataAsset.csvData.sourceFile} · 第 {csvDataAsset.csvData.rowNumber} 行 · 导入 {formatServerDate(csvDataAsset.csvData.importedAt)}</p>
            <dl className="viral-csv-data-fields">{csvDataFields.map((field, index) => {
              const presentation = csvDataFieldPresentation(field);
              return <div className={`viral-csv-data-field ${presentation.wide ? "wide" : ""} ${presentation.long ? "long" : ""}`} key={`${field.name}-${index}`}><dt title={field.name}>{field.name}</dt><dd>{field.value || "—"}</dd></div>;
            })}</dl>
            <footer><button type="button" onClick={() => setCsvDataAssetId(null)}>关闭</button></footer>
          </section>
        </div>, document.body
      )}
    </section>
  );
}

const viralCopyCategories = ["未分类", "开头钩子", "痛点共鸣", "产品卖点", "效果描述", "信任背书", "价格利益", "促单引导"];

function copyTime(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--";
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

function copyClassifications(segment: ViralCopySegment | null): Array<{ field: string; value: string }> {
  if (!segment) return [];
  return segment.classifications?.length ? segment.classifications : [{ field: "分类", value: segment.category || "未分类" }];
}

function editableCopyClassifications(segment: ViralCopySegment): Array<{ field: string; value: string }> {
  return segment.classifications ?? [{ field: "分类", value: segment.category || "未分类" }];
}

function copyClassificationKey(item: { field: string; value: string }) {
  return JSON.stringify([item.field, item.value]);
}

type ViralCopyCategoryContext = {
  majorCategory: string;
  classifications: Array<{ field: string; value: string }>;
};

function viralCopyCategoryContext(record: ViralCopyRecord | undefined, segment: ViralCopySegment | null, visualAsset?: Asset | null): ViralCopyCategoryContext {
  const recordMajorCategory = record?.major_category?.trim() || "";
  const visualMajorCategory = visualAsset?.majorCategory?.trim() || "";
  const explicitClassifications = (segment?.classifications || [])
    .map((item) => ({ field: item.field.trim(), value: item.value.trim() }))
    .filter((item) => item.field && item.value);
  const legacyFineCategoryField = recordMajorCategory && visualMajorCategory && recordMajorCategory !== visualMajorCategory
    ? visualAsset?.csvData?.fields.find((field) => {
      const name = field.name.trim();
      return /\u5206\u7c7b|\u7c7b\u76ee|\u7c7b\u578b|\u6807\u7b7e/.test(name) && field.value.trim() === recordMajorCategory;
    })
    : undefined;
  const hasLegacyCategoryMixup = explicitClassifications.length === 0 && Boolean(legacyFineCategoryField);
  return {
    majorCategory: hasLegacyCategoryMixup ? visualMajorCategory : recordMajorCategory || visualMajorCategory,
    classifications: explicitClassifications.length
      ? explicitClassifications
      : hasLegacyCategoryMixup && legacyFineCategoryField
        ? [{ field: legacyFineCategoryField.name.trim() || "\u5206\u7c7b", value: recordMajorCategory }]
        : copyClassifications(segment),
  };
}

function viralCopyTarget(record: ViralCopyRecord, segment: ViralCopySegment, index: number): ViralCopyTarget {
  return { key: record.key, index, segmentId: segment.id, updatedAt: record.updated_at };
}

function viralCopySelectionKey(target: ViralCopyTarget) {
  return JSON.stringify([target.key, target.index, target.segmentId]);
}

function copyCardUploadedData(asset?: Asset | null, segment?: ViralCopySegment | null): Array<{ name: string; value: string }> {
  const copyFields = (segment?.data_fields || [])
    .map((field) => ({ name: field.name.trim(), value: field.value.trim() }))
    .filter((field) => field.name && field.value);
  if (copyFields.length) return copyFields.slice(0, 6);
  const uploaded = (asset?.csvData?.fields || [])
    .map((field) => ({ name: field.name.trim(), value: field.value.trim() }))
    .filter((field) => field.name && field.value);
  if (uploaded.length) return uploaded.slice(0, 6);
  if (!asset?.qianchuan) return [];
  return [
    { name: "千川账户", value: asset.qianchuan.advertiserName || asset.qianchuan.advertiserId },
    { name: "素材 ID", value: asset.qianchuan.materialId },
  ].filter((field) => field.value);
}

function visualCardUploadedData(asset: Asset): Array<{ name: string; value: string }> {
  const fields = (asset.csvData?.fields || [])
    .map((field) => ({ name: field.name.trim(), value: field.value.trim() }))
    .filter((field) => field.name && field.value);
  return defaultViralDisplayColumns(fields.map((field) => field.name)).map((index) => fields[index]);
}

function ViralCopyCard({ record, segment, index, visualAsset, classifications, selected, onToggle, onDelete, onLink, onEdit, onInlineSave, onPreview, onError }: {
  record?: ViralCopyRecord;
  segment: ViralCopySegment | null;
  index: number;
  visualAsset?: Asset | null;
  classifications?: Array<{ field: string; value: string }>;
  selected: boolean;
  onToggle: (target: ViralCopyTarget, event: ReactMouseEvent<HTMLInputElement>) => void;
  onDelete: (target: ViralCopyTarget) => void;
  onLink: (target: ViralCopyTarget, currentVisualId: number | null) => void;
  onEdit: () => void;
  onInlineSave: (target: ViralCopyTarget, text: string) => Promise<void>;
  onPreview: (asset: Asset) => void;
  onError: (message: string) => void;
}) {
  const target = record && segment ? viralCopyTarget(record, segment, index) : null;
  const uploadedData = copyCardUploadedData(visualAsset, segment);
  const [inlineEditing, setInlineEditing] = useState(false);
  const [inlineSaving, setInlineSaving] = useState(false);
  const [inlineError, setInlineError] = useState("");
  const inlineDraftRef = useRef(segment?.text || "");
  const inlineEditorRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!inlineEditing) return;
    const frame = requestAnimationFrame(() => {
      const editor = inlineEditorRef.current;
      if (!editor) return;
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    return () => cancelAnimationFrame(frame);
  }, [inlineEditing]);
  const beginInlineEdit = () => {
    if (!target || !segment) { onEdit(); return; }
    inlineDraftRef.current = segment.text;
    setInlineError("");
    setInlineEditing(true);
  };
  const cancelInlineEdit = () => {
    inlineDraftRef.current = segment?.text || "";
    setInlineError("");
    setInlineEditing(false);
  };
  const saveInlineEdit = async () => {
    const text = inlineDraftRef.current.trim();
    if (!target || !segment || inlineSaving) return;
    if (!text) { setInlineError("文案内容不能为空；如需移除请使用删除按钮"); return; }
    if (text === segment.text) { setInlineEditing(false); setInlineError(""); return; }
    setInlineSaving(true);
    setInlineError("");
    try {
      await onInlineSave(target, text);
      setInlineEditing(false);
    } catch (failure) {
      setInlineError(failure instanceof Error ? failure.message : "文案保存失败，请刷新后重试");
    } finally {
      setInlineSaving(false);
    }
  };
  return <article className={`copy-card ${selected ? "selected" : ""}`}>
    <div className="copy-card-body">
      <div className="copy-card-top">
        {target && segment && <label className="copy-card-select"><input type="checkbox" checked={selected} readOnly onClick={(event) => onToggle(target, event)} aria-label={`选择文案：${segment.text.slice(0, 30)}`} /><span>选择</span></label>}
        <span className={`copy-status ${segment?.confirmed ? "confirmed" : ""}`}>{segment ? segment.confirmed ? "已确认" : "待确认" : "待提取"}</span>
        {(classifications || copyClassifications(segment)).map((item) => <span className="copy-category" key={copyClassificationKey(item)}>{item.value}</span>)}
        {segment?.start !== null && segment?.start !== undefined && <span className="copy-time">{copyTime(segment.start)}–{copyTime(segment.end)}</span>}
        <div className="copy-card-quick-actions" aria-label="文案操作">
          {segment && <button type="button" title="复制文案" aria-label="复制文案" onClick={() => void navigator.clipboard.writeText(segment.text).catch(() => onError("复制失败，请手动选择文案"))}><Copy size={13} /></button>}
          {target && segment && <button type="button" title={visualAsset ? "更换画面" : "关联画面"} aria-label={visualAsset ? "更换画面" : "关联画面"} onClick={() => onLink(target, segment.visual_asset_id || null)}><Images size={13} /></button>}
          <button type="button" title={segment ? "编辑文案" : "提取或补录文案"} aria-label={segment ? "编辑文案" : "提取或补录文案"} onClick={onEdit}><Pencil size={13} /></button>
          {target && <button type="button" className="copy-delete-button" title="删除文案" aria-label="删除文案" onClick={() => onDelete(target)}><Trash2 size={13} /></button>}
        </div>
      </div>
      {inlineEditing && segment && target ? <>
        <strong ref={inlineEditorRef} className="copy-card-editable-text editing" contentEditable={!inlineSaving} suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="直接修改文案" onInput={(event) => { inlineDraftRef.current = event.currentTarget.innerText || ""; }} onBlur={(event) => {
          const nextFocus = event.relatedTarget as HTMLElement | null;
          if (nextFocus?.closest("[data-inline-cancel]")) return;
          void saveInlineEdit();
        }} onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); cancelInlineEdit(); }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void saveInlineEdit(); }
        }}>{segment.text}</strong>
        <div className="copy-card-inline-controls">{inlineError ? <small role="alert">{inlineError}</small> : <span>{inlineSaving ? "正在自动保存…" : "点击其他位置自动保存"}</span>}<button type="button" data-inline-cancel disabled={inlineSaving} onClick={cancelInlineEdit}>取消</button></div>
      </> : <strong
        className="copy-card-editable-text"
        role="button"
        tabIndex={0}
        title={segment ? "双击编辑文案" : "双击补录文案"}
        aria-label={segment ? `双击编辑文案：${segment.text.slice(0, 30)}` : "双击补录文案"}
        onDoubleClick={(event) => { event.stopPropagation(); beginInlineEdit(); }}
        onKeyDown={(event) => { if (event.key === "Enter") beginInlineEdit(); }}
      >{segment?.text || "原视频已关联，尚未提取或补录文案"}</strong>}
      <div className="copy-card-meta-row">
        {record && <small className="copy-card-upload-time">{record.created_at ? formatServerDate(record.created_at) : "未记录"}</small>}
        {visualAsset ? <button type="button" className="copy-card-visual linked" aria-label={`已链接画面：${visualAsset.name}，点击预览`} onClick={() => onPreview(visualAsset)}><Images size={13} /><span>已链接</span><span className="copy-card-hover-preview" aria-hidden="true">{visualAsset.type === "video" ? <video src={visualAsset.src} muted playsInline preload="metadata" /> : <img src={visualAsset.src} alt="" loading="lazy" />}</span></button> : segment && <div className="copy-card-visual unlinked"><Images size={13} /><span>未关联画面</span></div>}
      </div>
      {uploadedData.length > 0 && <dl className="copy-card-data-summary" aria-label="上传数据摘要">{uploadedData.map((field, fieldIndex) => <div key={`${field.name}-${fieldIndex}`} title={`${field.name}：${field.value}`}><dt>{field.name}</dt><dd>{field.value}</dd></div>)}</dl>}
    </div>
  </article>;
}

const VIRAL_COPY_CONFIRM_HELP = "已确认表示文案内容与分类已由你人工核对；未勾选也会正常保存，只显示为待确认。";

function ViralCopyLibrary({ assets, searchQuery, onSearchQueryChange, onNavigate, onPreview, onUploadVisual, onImportCsv, revision }: {
  assets: Asset[];
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onNavigate: (section: "viral-visuals" | "viral-copy") => void;
  onPreview: (asset: Asset) => void;
  onUploadVisual: () => Promise<void>;
  onImportCsv: () => Promise<void>;
  revision: number;
}) {
  const availableAssets = useMemo(() => assets.filter((asset) => !asset.deleted && (asset.type === "video" || asset.type === "image")), [assets]);
  const visualChoices = useMemo(() => availableAssets.filter((asset) => asset.sourceKind !== "demo"), [availableAssets]);
  const assetById = useMemo(() => new Map(availableAssets.map((asset) => [asset.id, asset])), [availableAssets]);
  const [records, setRecords] = useState<ViralCopyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [majorCategoryFilter, setMajorCategoryFilter] = useState("all");
  const [classificationFilter, setClassificationFilter] = useState("all");
  const [status, setStatus] = useState<"all" | "pending" | "review" | "confirmed">("all");
  const [editorAssetId, setEditorAssetId] = useState<number | null>(null);
  const [standaloneEditor, setStandaloneEditor] = useState(false);
  const [standaloneKey, setStandaloneKey] = useState("");
  const [editorTitle, setEditorTitle] = useState("");
  const [editorMajorCategory, setEditorMajorCategory] = useState("");
  const [editorSegments, setEditorSegments] = useState<ViralCopySegment[]>([]);
  const [editorConfirmOnImport, setEditorConfirmOnImport] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const [replacementAction, setReplacementAction] = useState<"paste" | "transcribe" | null>(null);
  const [transcribeCapability, setTranscribeCapability] = useState<{ transcribeAvailable: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const copySelectionAnchor = useRef<string | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<ViralCopyTarget[]>([]);
  const [visualTarget, setVisualTarget] = useState<ViralCopyTarget | null>(null);
  const [visualChoiceId, setVisualChoiceId] = useState<number | null>(null);
  const [visualSearch, setVisualSearch] = useState("");

  useEffect(() => {
    let active = true;
    if (!window.desktopBridge?.viralCopyList) {
      queueMicrotask(() => { if (active) setLoading(false); });
      return () => { active = false; };
    }
    window.desktopBridge.viralCopyList().then((items) => {
      if (active) { setRecords(items); setSelectedKeys(new Set()); }
    }).catch((failure) => {
      if (active) setError(failure instanceof Error ? failure.message : "文案记录读取失败");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);

  useEffect(() => {
    let active = true;
    window.desktopBridge?.viralCopyCapabilities?.().then((result) => {
      if (active) setTranscribeCapability(result);
    }).catch(() => { /* Manual transcript entry remains available. */ });
    return () => { active = false; };
  }, []);

  const recordByKey = useMemo(() => new Map(records.map((record) => [record.key, record])), [records]);
  const linked = useMemo(() => availableAssets.filter((asset) => {
    const key = asset.qianchuan ? `${asset.qianchuan.advertiserId}:${asset.qianchuan.materialId}` : `asset:${asset.id}`;
    return asset.collection === VIRAL_FRAME_COLLECTION || asset.tags.includes(VIRAL_FRAME_COLLECTION) || recordByKey.has(key);
  }), [availableAssets, recordByKey]);
  const cards = linked.flatMap((asset) => {
    const key = asset.qianchuan ? `${asset.qianchuan.advertiserId}:${asset.qianchuan.materialId}` : `asset:${asset.id}`;
    const record = recordByKey.get(key);
    const segments = record?.segments || [];
    return (segments.length ? segments : [null]).map((segment, index) => ({ asset, key, record, segment, index, categoryContext: viralCopyCategoryContext(record, segment, asset) }));
  });
  const linkedKeys = new Set(linked.map((asset) => asset.qianchuan
    ? `${asset.qianchuan.advertiserId}:${asset.qianchuan.materialId}`
    : `asset:${asset.id}`));
  const independentCards = records.flatMap((record) => linkedKeys.has(record.key) ? [] : record.segments.map((segment, index) => ({ record, segment, index, categoryContext: viralCopyCategoryContext(record, segment) })));
  const majorCategoryOptions = [...new Set([
    ...cards.map((item) => item.categoryContext.majorCategory),
    ...independentCards.map((item) => item.categoryContext.majorCategory),
  ].filter(Boolean))].sort((left, right) => left.localeCompare(right, "zh-CN"));
  const classificationOptions = [...new Map([
    ...cards.flatMap((item) => item.categoryContext.classifications),
    ...independentCards.flatMap((item) => item.categoryContext.classifications),
  ].map((item) => [copyClassificationKey(item), item] as const)).entries()];
  const matchesCopyCategories = (context: ViralCopyCategoryContext) => {
    if (majorCategoryFilter === "ungrouped" && context.majorCategory) return false;
    if (majorCategoryFilter !== "all" && majorCategoryFilter !== "ungrouped" && context.majorCategory !== majorCategoryFilter) return false;
    if (classificationFilter !== "all" && !context.classifications.some((item) => copyClassificationKey(item) === classificationFilter)) return false;
    return true;
  };
  const visible = cards.filter(({ asset, segment, categoryContext }) => {
    if (!segment && status !== "pending") return false;
    if (status === "pending" && segment) return false;
    if (status === "review" && (!segment || segment.confirmed)) return false;
    if (status === "confirmed" && !segment?.confirmed) return false;
    if (!matchesCopyCategories(categoryContext)) return false;
    return matchesViralLibrarySearch(searchQuery, [asset.name, categoryContext.majorCategory, asset.qianchuan?.materialId, segment?.text, ...categoryContext.classifications.flatMap((item) => [item.field, item.value])]);
  });
  const independent = independentCards.filter(({ record, segment, categoryContext }) => {
    if (status === "pending") return false;
    if (status === "review" && segment.confirmed) return false;
    if (status === "confirmed" && !segment.confirmed) return false;
    if (!matchesCopyCategories(categoryContext)) return false;
    return matchesViralLibrarySearch(searchQuery, [record.title, record.association_id, categoryContext.majorCategory, segment.text, ...categoryContext.classifications.flatMap((item) => [item.field, item.value])]);
  });
  const shownLinked = visible.slice(0, 200);
  const shownIndependent = independent.slice(0, Math.max(0, 200 - shownLinked.length));
  const groupedCopyCards = groupViralLibraryItems([
    ...shownLinked.map((item) => ({ kind: "linked" as const, item })),
    ...shownIndependent.map((item) => ({ kind: "independent" as const, item })),
  ], (entry) => entry.item.categoryContext.majorCategory);
  const shownTargets = [
    ...shownLinked.flatMap(({ record, segment, index }) => record && segment ? [viralCopyTarget(record, segment, index)] : []),
    ...shownIndependent.map(({ record, segment, index }) => viralCopyTarget(record, segment, index)),
  ];
  const selectedTargets = shownTargets.filter((target) => selectedKeys.has(viralCopySelectionKey(target)));
  const matchingVisuals = visualChoices.filter((asset) => asset.name.toLowerCase().includes(visualSearch.trim().toLowerCase()));
  const editorAsset = linked.find((asset) => asset.id === editorAssetId) || null;

  const toggleSelected = (target: ViralCopyTarget, event: ReactMouseEvent<HTMLInputElement>) => {
    const key = viralCopySelectionKey(target);
    const keys = shownTargets.map(viralCopySelectionKey);
    const first = copySelectionAnchor.current === null ? -1 : keys.indexOf(copySelectionAnchor.current);
    const last = keys.indexOf(key);
    if (event.shiftKey && first >= 0 && last >= 0) {
      const range = keys.slice(Math.min(first, last), Math.max(first, last) + 1);
      setSelectedKeys((current) => event.metaKey || event.ctrlKey ? new Set([...current, ...range]) : new Set(range));
      return;
    }
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    copySelectionAnchor.current = key;
  };
  const toggleAllShown = () => setSelectedKeys((current) => {
    const next = new Set(current);
    const allSelected = shownTargets.length > 0 && shownTargets.every((target) => next.has(viralCopySelectionKey(target)));
    shownTargets.forEach((target) => { if (allSelected) next.delete(viralCopySelectionKey(target)); else next.add(viralCopySelectionKey(target)); });
    copySelectionAnchor.current = allSelected ? null : viralCopySelectionKey(shownTargets[0]);
    return next;
  });
  const toggleCopyGroup = (targets: ViralCopyTarget[]) => setSelectedKeys((current) => {
    const next = new Set(current);
    const keys = targets.map(viralCopySelectionKey);
    const allSelected = keys.length > 0 && keys.every((key) => next.has(key));
    keys.forEach((key) => { if (allSelected) next.delete(key); else next.add(key); });
    copySelectionAnchor.current = allSelected ? null : keys[0] || null;
    return next;
  });
  const removeSelected = async () => {
    if (!deleteTargets.length) return;
    if (!window.desktopBridge?.viralCopyDeleteSegments) { setError("请在桌面版操作文案删除"); return; }
    setBusy(true);
    setError("");
    try {
      const result = await window.desktopBridge.viralCopyDeleteSegments(deleteTargets);
      setRecords(result.records);
      setSelectedKeys(new Set());
      setDeleteTargets([]);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "删除文案失败，请刷新后重试"); }
    finally { setBusy(false); }
  };
  const setSelectedConfirmation = async (confirmed: boolean) => {
    if (!selectedTargets.length) return;
    if (!window.desktopBridge?.viralCopySetConfirmed) { setError("请在桌面版修改文案确认状态"); return; }
    setBusy(true);
    setError("");
    try {
      const result = await window.desktopBridge.viralCopySetConfirmed(selectedTargets, confirmed);
      setRecords(result.records);
      setSelectedKeys(new Set());
    } catch (failure) { setError(failure instanceof Error ? failure.message : "批量修改失败，请刷新后重试"); }
    finally { setBusy(false); }
  };
  const saveInlineText = async (target: ViralCopyTarget, text: string) => {
    if (!window.desktopBridge?.viralCopyUpdateText) throw new Error("请在桌面版直接修改文案");
    const updated = await window.desktopBridge.viralCopyUpdateText(target, text);
    setRecords((current) => current.map((record) => record.key === updated.key ? updated : record));
    setSelectedKeys(new Set());
  };
  const saveVisualLink = async () => {
    if (!visualTarget) return;
    if (!window.desktopBridge?.viralCopyLinkVisual) { setError("请在桌面版关联画面"); return; }
    setBusy(true);
    setError("");
    try {
      const updated = await window.desktopBridge.viralCopyLinkVisual(visualTarget, visualChoiceId);
      setRecords((current) => current.map((record) => record.key === updated.key ? updated : record));
      setSelectedKeys(new Set());
      setVisualTarget(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "关联画面失败，请刷新后重试"); }
    finally { setBusy(false); }
  };

  const openEditor = (asset: Asset) => {
    const key = asset.qianchuan ? `${asset.qianchuan.advertiserId}:${asset.qianchuan.materialId}` : `asset:${asset.id}`;
    const existingRecord = recordByKey.get(key);
    const existingSegments = existingRecord?.segments || [];
    setEditorAssetId(asset.id);
    setStandaloneEditor(false);
    setEditorTitle(asset.name);
    setEditorMajorCategory(viralCopyCategoryContext(existingRecord, existingSegments[0] || null, asset).majorCategory);
    setEditorSegments(existingSegments.map((segment) => ({ ...segment, classifications: viralCopyCategoryContext(existingRecord, segment, asset).classifications.map((item) => ({ ...item })) })));
    setEditorConfirmOnImport(existingSegments.length > 0 && existingSegments.every((segment) => segment.confirmed));
    setPastedText("");
    setReplacementAction(null);
    setError("");
  };
  const openStandaloneEditor = (record?: ViralCopyRecord) => {
    setEditorAssetId(null);
    setStandaloneEditor(true);
    setStandaloneKey(record?.key.startsWith("standalone:") ? record.key.slice("standalone:".length) : "");
    setEditorTitle(record?.title || "");
    setEditorMajorCategory(record?.major_category || "");
    setEditorSegments(record?.segments.map((segment) => ({ ...segment, classifications: segment.classifications?.map((item) => ({ ...item })) })) || [{ id: `S${Date.now()}`, text: "", start: null, end: null, category: "未分类", classifications: [{ field: "分类", value: "未分类" }], confirmed: false }]);
    setEditorConfirmOnImport(Boolean(record?.segments.length && record.segments.every((segment) => segment.confirmed)));
    setPastedText("");
    setReplacementAction(null);
    setError("");
  };
  const updateSegment = (index: number, change: Partial<ViralCopySegment>) => {
    setEditorSegments((current) => current.map((segment, itemIndex) => itemIndex === index ? { ...segment, ...change } : segment));
  };
  const updateClassifications = (index: number, classifications: Array<{ field: string; value: string }>) => {
    updateSegment(index, { classifications, category: classifications.find((item) => item.field.trim() && item.value.trim())?.value || "未分类" });
  };
  const addSegment = () => setEditorSegments((current) => [...current, {
    id: `S${Date.now()}`, text: "", start: null, end: null, category: "未分类", classifications: [{ field: "分类", value: "未分类" }], confirmed: editorConfirmOnImport,
  }]);
  const importPastedText = async (replaceApproved = false) => {
    if (!window.desktopBridge?.viralCopyParse || !pastedText.trim()) return;
    if (editorSegments.some((segment) => segment.text.trim()) && !replaceApproved) { setReplacementAction("paste"); return; }
    setReplacementAction(null);
    try {
      const segments = await window.desktopBridge.viralCopyParse(pastedText);
      if (!segments.length) throw new Error("没有识别到文案，请检查粘贴内容");
      setEditorSegments(segments.map((segment) => ({ ...segment, confirmed: editorConfirmOnImport })));
      setError("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "文本导入失败"); }
  };
  const transcribe = async (replaceApproved = false) => {
    if (!editorAsset || !window.desktopBridge?.viralCopyTranscribe) return;
    if (editorSegments.some((segment) => segment.text.trim()) && !replaceApproved) { setReplacementAction("transcribe"); return; }
    setReplacementAction(null);
    setBusy(true);
    setError("");
    try {
      const result = await window.desktopBridge.viralCopyTranscribe(editorAsset.id);
      setEditorSegments(result.segments.map((segment) => ({ ...segment, confirmed: editorConfirmOnImport })));
    } catch (failure) { setError(failure instanceof Error ? failure.message : "本地转写失败"); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if ((!editorAsset && !standaloneEditor) || !window.desktopBridge?.viralCopySave) return;
    const valid = editorSegments.filter((segment) => segment.text.trim());
    if (!valid.length) { setError("请先录入至少一段文案"); return; }
    setBusy(true);
    setError("");
    try {
      const record = editorAsset
        ? await window.desktopBridge.viralCopySave({ assetId: editorAsset.id, majorCategory: editorMajorCategory.trim(), segments: valid })
        : await window.desktopBridge.viralCopySaveReference({ referenceId: standaloneKey || undefined, title: editorTitle.trim() || "独立文案", source: "manual", majorCategory: editorMajorCategory.trim(), segments: valid });
      setRecords((current) => [...current.filter((item) => item.key !== record.key), record]);
      setSelectedKeys(new Set());
      setEditorAssetId(null);
      setStandaloneEditor(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "文案保存失败"); }
    finally { setBusy(false); }
  };

  return (
    <section className="viral-library-page viral-copy-page">
      <header className="viral-library-heading">
        <span className="viral-heading-icon copy"><FileSpreadsheet size={22} /></span>
        <div><h1>爆款文案库</h1><p>可独立收录文案，也可与本地画面、视频或千川素材对应</p></div>
        <ViralLibraryTabs section="viral-copy" onNavigate={onNavigate} />
      </header>
      <div className="copy-guidance"><Sparkles size={18} /><div className="viral-guidance-copy"><strong>画面库与文案库独立计数</strong><span>独立上传的文案不需要关联画面，会始终保留并显示；只有没有文案内容的千川缓存占位数据不会进入文案库。</span></div><ViralLibrarySearch value={searchQuery} onChange={(value) => { onSearchQueryChange(value); setSelectedKeys(new Set()); }} /><div className="viral-guidance-actions"><button type="button" onClick={() => openStandaloneEditor()}><Plus size={14} />手动录入文案</button><button type="button" onClick={() => void onUploadVisual()}><Upload size={14} />上传画面</button><button type="button" onClick={() => void onImportCsv()}><FileSpreadsheet size={14} />导入 CSV</button></div></div>
      <div className="copy-toolbar">
        <select aria-label="文案大分类" value={majorCategoryFilter} onChange={(event) => { setMajorCategoryFilter(event.target.value); setSelectedKeys(new Set()); }}><option value="all">全部大分类</option><option value="ungrouped">未分组</option>{majorCategoryOptions.map((category) => <option key={category} value={category}>{category}</option>)}</select>
        <select aria-label="文案细分类" value={classificationFilter} onChange={(event) => { setClassificationFilter(event.target.value); setSelectedKeys(new Set()); }}><option value="all">全部细分类</option>{classificationOptions.map(([key, item]) => <option key={key} value={key}>{item.value}</option>)}</select>
        <select aria-label="文案状态" value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setSelectedKeys(new Set()); }}><option value="all">全部状态</option><option value="pending">待提取</option><option value="review">待确认</option><option value="confirmed">已确认</option></select>
        <span>共 {visible.length + independent.length} 段／条</span>
      </div>
      <div className="copy-selection-toolbar">
        <label><input type="checkbox" checked={shownTargets.length > 0 && selectedTargets.length === shownTargets.length} disabled={!shownTargets.length || busy} onChange={toggleAllShown} />全选当前显示的文案</label>
        <span>已选 {selectedTargets.length} 条 · Shift 连选{visible.length + independent.length > 200 ? " · 每次最多显示 200 条" : ""}</span>
        <button type="button" className="copy-confirm-selected" disabled={!selectedTargets.length || busy} onClick={() => void setSelectedConfirmation(true)}>确认所选{selectedTargets.length ? `（${selectedTargets.length}）` : ""}</button>
        <button type="button" className="copy-unconfirm-selected" disabled={!selectedTargets.length || busy} onClick={() => void setSelectedConfirmation(false)}>取消确认</button>
        <button type="button" className="copy-delete-selected" disabled={!selectedTargets.length || busy} onClick={() => { setError(""); setDeleteTargets(selectedTargets); }}><Trash2 size={14} />删除所选{selectedTargets.length ? `（${selectedTargets.length}）` : ""}</button>
      </div>
      {error && !editorAsset && !standaloneEditor && <div className="viral-alert"><AlertTriangle size={16} />{error}</div>}
      {loading ? <div className="viral-empty"><span>正在读取文案库…</span></div> : visible.length || independent.length ? <div className="viral-category-sections">{groupedCopyCards.map((group) => {
        const groupTargets = group.items.flatMap((entry) => {
          if (entry.kind === "linked") {
            const { record, segment, index } = entry.item;
            return record && segment ? [viralCopyTarget(record, segment, index)] : [];
          }
          return [viralCopyTarget(entry.item.record, entry.item.segment, entry.item.index)];
        });
        const groupSelectedCount = groupTargets.filter((target) => selectedKeys.has(viralCopySelectionKey(target))).length;
        return <section className="viral-category-section" key={group.name}><header><ViralCategorySelect name={group.name} selectedCount={groupSelectedCount} totalCount={groupTargets.length} disabled={busy} onToggle={() => toggleCopyGroup(groupTargets)} /><small>{group.items.length} 条文案</small></header><div className="copy-card-list">
        {group.items.filter((entry) => entry.kind === "linked").map((entry) => {
          const { asset, key, record, segment, index } = entry.item;
          const target = record && segment ? viralCopyTarget(record, segment, index) : null;
          const visualAsset = segment?.visual_asset_id ? assetById.get(segment.visual_asset_id) || null : asset;
          return <ViralCopyCard key={`${key}-${segment?.id || "pending"}-${index}`} record={record} segment={segment} index={index} visualAsset={visualAsset} classifications={entry.item.categoryContext.classifications} selected={!!target && selectedKeys.has(viralCopySelectionKey(target))} onToggle={toggleSelected} onDelete={(item) => { setError(""); setDeleteTargets([item]); }} onLink={(item, currentId) => { setVisualTarget(item); setVisualChoiceId(currentId); setVisualSearch(""); setError(""); }} onEdit={() => openEditor(asset)} onInlineSave={saveInlineText} onPreview={onPreview} onError={setError} />;
        })}
        {group.items.filter((entry) => entry.kind === "independent").map((entry) => {
          const { record, segment, index } = entry.item;
          const target = viralCopyTarget(record, segment, index);
          const visualAsset = segment.visual_asset_id ? assetById.get(segment.visual_asset_id) || null : null;
          return <ViralCopyCard key={`${record.key}-${segment.id}-${index}`} record={record} segment={segment} index={index} visualAsset={visualAsset} classifications={entry.item.categoryContext.classifications} selected={selectedKeys.has(viralCopySelectionKey(target))} onToggle={toggleSelected} onDelete={(item) => { setError(""); setDeleteTargets([item]); }} onLink={(item, currentId) => { setVisualTarget(item); setVisualChoiceId(currentId); setVisualSearch(""); setError(""); }} onEdit={() => openStandaloneEditor(record)} onInlineSave={saveInlineText} onPreview={onPreview} onError={setError} />;
        })}
      </div></section>;
      })}{visible.length + independent.length > 200 && <p className="copy-more-note">当前显示前 200 条，请用搜索和筛选缩小范围。</p>}</div> : <div className="viral-empty"><FileSpreadsheet size={34} /><strong>{records.length ? "没有匹配的文案" : "还没有文案"}</strong><span>{records.length ? "试试其他文案、画面或大分类关键词。" : "可手动录入独立脚本，或在“待提取”中为已有画面补录文案。"}</span></div>}
      {deleteTargets.length > 0 && createPortal(<div className="copy-modal-backdrop" role="presentation"><section className="copy-action-dialog" role="alertdialog" aria-modal="true" aria-label="确认删除文案"><h2>删除 {deleteTargets.length} 条文案？</h2><p>只删除选中的文案片段及其画面关联，不删除媒体库素材、原视频或画面文件。删除后不能从页面撤销。</p>{error && <p className="copy-action-error" role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={() => { setDeleteTargets([]); setError(""); }}>取消</button><button type="button" className="danger" disabled={busy} onClick={() => void removeSelected()}>{busy ? "正在删除…" : "确认删除"}</button></footer></section></div>, document.body)}
      {visualTarget && createPortal(<div className="copy-modal-backdrop" role="presentation"><section className="copy-action-dialog copy-visual-picker" role="dialog" aria-modal="true" aria-label="手动关联画面"><header><h2>关联画面</h2><button type="button" aria-label="关闭" disabled={busy} onClick={() => { setVisualTarget(null); setError(""); }}><X size={17} /></button></header><p>从本地媒体库选择图片或视频。文案与画面独立保存，可随时更换或取消关联。</p><input className="copy-visual-search" value={visualSearch} onChange={(event) => setVisualSearch(event.target.value)} placeholder="搜索画面或视频名称" aria-label="搜索画面或视频名称" /><div className="copy-visual-list"><label className="copy-visual-option"><input type="radio" name="copy-visual-choice" checked={visualChoiceId === null} onChange={() => setVisualChoiceId(null)} /><span>不设置手动关联{visualTarget.key.startsWith("asset:") || visualTarget.key.includes(":") && !visualTarget.key.startsWith("standalone:") ? "（保留原素材画面）" : ""}</span></label>{matchingVisuals.slice(0, 100).map((asset) => <label key={asset.id} className="copy-visual-option"><input type="radio" name="copy-visual-choice" checked={visualChoiceId === asset.id} onChange={() => setVisualChoiceId(asset.id)} />{asset.type === "image" && asset.src ? <img src={asset.src} alt="" loading="lazy" /> : <span className="copy-visual-icon"><Images size={18} /></span>}<span className="copy-visual-name"><strong>{asset.name}</strong><small>{asset.type === "video" ? "视频" : "图片"}{asset.collection ? ` · ${asset.collection}` : ""}</small></span></label>)}{matchingVisuals.length === 0 && <p className="copy-visual-empty">没有找到可关联的本地图片或视频。可先在媒体库上传素材。</p>}{matchingVisuals.length > 100 && <p className="copy-visual-empty">只显示前 100 项，请搜索名称缩小范围。</p>}</div>{error && <p className="copy-action-error" role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={() => { setVisualTarget(null); setError(""); }}>取消</button><button type="button" disabled={busy} onClick={() => void saveVisualLink()}>{busy ? "正在保存…" : "保存关联"}</button></footer></section></div>, document.body)}
      {(editorAsset || standaloneEditor) && createPortal(<div className="copy-modal-backdrop" role="presentation"><section className="copy-editor" role="dialog" aria-modal="true" aria-label="编辑爆款文案">
        <header><div><strong>{editorAsset ? "提取与校正文案" : "录入独立文案"}</strong><small>{editorAsset ? `${editorAsset.name}${editorAsset.qianchuan?.materialId ? ` · 素材 ID ${editorAsset.qianchuan.materialId}` : " · 本地素材"}` : "不关联画面也可单独保存和筛选"}</small></div><button type="button" disabled={busy} aria-label="关闭" onClick={() => { setEditorAssetId(null); setStandaloneEditor(false); }}><X size={18} /></button></header>
        <div className="copy-editor-content">
          {!editorAsset && <label className="copy-title-field"><span>文案标题</span><input value={editorTitle} onChange={(event) => setEditorTitle(event.target.value)} placeholder="例如：痛点共鸣开场" /></label>}
          <label className="copy-title-field"><span>大分类（可选，自行填写）</span><input value={editorMajorCategory} maxLength={100} onChange={(event) => setEditorMajorCategory(event.target.value)} placeholder="输入大分类名称；留空归入未分组" /></label>
          <p className="copy-editor-note">可粘贴逐行文案或 SRT/VTT 字幕。{editorAsset ? `${transcribeCapability?.message || "正在检测本地转写组件…"} 自动转写内容默认“待确认”，勾选下方选项后可保存为“已确认”。` : "独立文案不需要上传画面。"}</p>
          <div className="copy-confirm-option"><label title={VIRAL_COPY_CONFIRM_HELP}><input type="checkbox" checked={editorConfirmOnImport} disabled={busy} onChange={(event) => { setEditorConfirmOnImport(event.target.checked); setEditorSegments((current) => current.map((segment) => ({ ...segment, confirmed: event.target.checked }))); }} />本次录入标记为已确认</label><span className="copy-confirm-help" tabIndex={0} title={VIRAL_COPY_CONFIRM_HELP} aria-label={VIRAL_COPY_CONFIRM_HELP} data-tooltip={VIRAL_COPY_CONFIRM_HELP}>?</span></div>
          <textarea className="copy-paste" value={pastedText} onChange={(event) => setPastedText(event.target.value)} placeholder="在此粘贴口播文案或带时间码的字幕内容…" />
          <div className="copy-editor-tools"><button type="button" disabled={busy || !pastedText.trim()} onClick={() => void importPastedText()}>导入粘贴文本</button>{editorAsset?.type === "video" && <button type="button" disabled={busy || !editorAsset.src || !transcribeCapability?.transcribeAvailable} onClick={() => void transcribe()}>{busy ? "正在处理…" : "本地转写原视频"}</button>}<button type="button" disabled={busy} onClick={addSegment}><Plus size={13} />新增片段</button></div>
          <datalist id="viral-copy-category-suggestions">{viralCopyCategories.filter((item) => item !== "未分类").map((item) => <option key={item} value={item} />)}</datalist>
          {replacementAction && <div className="copy-replace-confirm" role="alert"><span>这会替换当前编辑中的片段；已保存的文案要等点击“保存文案”才会更新。</span><button type="button" onClick={() => setReplacementAction(null)}>取消</button><button type="button" onClick={() => void (replacementAction === "paste" ? importPastedText(true) : transcribe(true))}>继续替换</button></div>}
          {editorSegments.map((segment, index) => <div className="copy-segment-editor" key={`${segment.id}-${index}`}>
            <div className="copy-segment-heading"><strong>片段 {index + 1}</strong><button type="button" disabled={busy} onClick={() => setEditorSegments((current) => current.filter((_, itemIndex) => itemIndex !== index))}>移除</button></div>
            <textarea aria-label={`片段 ${index + 1} 文案`} value={segment.text} onChange={(event) => updateSegment(index, { text: event.target.value })} placeholder="输入原视频中的真实口播或字幕" />
            <div className="copy-segment-fields"><label>开始（秒）<input type="number" min="0" step="0.1" value={segment.start ?? ""} onChange={(event) => updateSegment(index, { start: event.target.value === "" ? null : Number(event.target.value) })} /></label><label>结束（秒）<input type="number" min="0" step="0.1" value={segment.end ?? ""} onChange={(event) => updateSegment(index, { end: event.target.value === "" ? null : Number(event.target.value) })} /></label><label className="copy-confirm" title={VIRAL_COPY_CONFIRM_HELP}><input type="checkbox" checked={segment.confirmed} onChange={(event) => { updateSegment(index, { confirmed: event.target.checked }); setEditorConfirmOnImport(event.target.checked && editorSegments.every((item, itemIndex) => itemIndex === index || item.confirmed)); }} />已人工核对</label></div>
            <div className="copy-classification-editor"><div><strong>分类字段</strong><button type="button" disabled={busy || editableCopyClassifications(segment).length >= 24} onClick={() => updateClassifications(index, [...editableCopyClassifications(segment), { field: "分类", value: "" }])}><Plus size={12} />添加分类</button></div>{editableCopyClassifications(segment).map((item, classificationIndex) => <div className="copy-classification-row" key={`${index}-${classificationIndex}`}><input aria-label={`片段 ${index + 1} 分类字段 ${classificationIndex + 1}`} value={item.field} placeholder="字段名" onChange={(event) => updateClassifications(index, editableCopyClassifications(segment).map((entry, entryIndex) => entryIndex === classificationIndex ? { ...entry, field: event.target.value } : entry))} /><input aria-label={`片段 ${index + 1} 分类值 ${classificationIndex + 1}`} list="viral-copy-category-suggestions" value={item.value} placeholder="分类值" onChange={(event) => updateClassifications(index, editableCopyClassifications(segment).map((entry, entryIndex) => entryIndex === classificationIndex ? { ...entry, value: event.target.value } : entry))} /><button type="button" disabled={busy} onClick={() => updateClassifications(index, editableCopyClassifications(segment).filter((_, entryIndex) => entryIndex !== classificationIndex))}>移除</button></div>)}</div>
          </div>)}
          {error && <p className="copy-editor-error" role="alert">{error}</p>}
        </div>
        <footer><span>只保存文案和来源关系，不复制或修改原视频。</span><button type="button" disabled={busy} onClick={() => { setEditorAssetId(null); setStandaloneEditor(false); }}>取消</button><button type="button" disabled={busy} onClick={() => void save()}>保存文案</button></footer>
      </section></div>, document.body)}
    </section>
  );
}

function VipFeatureLockedPage({ feature, onRedeem, onBack }: {
  feature: { id: string; label: string; description?: string; highlights?: readonly string[] };
  onRedeem: () => void;
  onBack: () => void;
}) {
  const Icon = featureMenuIcons[feature.id] || Sparkles;
  const highlights = feature.highlights?.length
    ? feature.highlights
    : ["开通后自动解锁完整功能", "统一继承VIP权益期限", "不会迁移或删除已有素材"];
  return (
    <section className="vip-feature-locked-page" aria-labelledby="vip-feature-locked-title">
      <header className="vip-feature-locked-heading">
        <span><Icon size={22} /></span>
        <div><h1>{feature.label}</h1><p>{feature.description || "该功能属于AI媒体库VIP权益。"}</p></div>
        <em><LockKeyhole size={12} />VIP专属</em>
      </header>
      <div className="vip-feature-locked-content">
        <div className={`vip-feature-locked-backdrop ${feature.id === "viral-copy" ? "copy" : "visual"}`} aria-hidden="true">
          <div className="vip-lock-preview-toolbar">
            <span className="search">{feature.id === "viral-copy" ? "搜索文案、画面或大分类" : "搜索画面、文案或大分类"}</span>
            <span>全部大分类</span>
            <span>{feature.id === "viral-copy" ? "全部状态" : "全部类型"}</span>
            <i>{feature.id === "viral-copy" ? "新建文案" : "上传画面"}</i>
          </div>
          {feature.id === "viral-copy" ? (
            <section className="vip-lock-preview-section">
              <header><strong>热门文案</strong><span>12 条文案</span></header>
              <div className="vip-lock-copy-preview">
                {Array.from({ length: 7 }, (_, index) => (
                  <article key={index}>
                    <div className="vip-lock-copy-thumb" />
                    <div className="vip-lock-copy-lines"><strong>爆款文案片段 {index + 1}</strong><span /><span /></div>
                    <em>查看文案</em>
                  </article>
                ))}
              </div>
            </section>
          ) : (
            <section className="vip-lock-preview-section">
              <header><strong>热门画面</strong><span>15 个画面</span></header>
              <div className="vip-lock-visual-preview">
                {Array.from({ length: 10 }, (_, index) => (
                  <article key={index}>
                    <div className="vip-lock-visual-thumb"><Images size={24} /></div>
                    <strong>画面素材_{String(index + 1).padStart(2, "0")}</strong>
                    <span>视频 · 待处理</span>
                    <footer><i>播放</i><i>大分类</i><i>媒体库</i></footer>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
        <div className="vip-feature-locked-veil" aria-hidden="true" />
        <section className="vip-feature-locked-card">
          <div className="vip-feature-lock-icon"><LockKeyhole size={28} /></div>
          <span className="vip-feature-eyebrow">VIP FEATURE</span>
          <h2 id="vip-feature-locked-title">当前基础授权暂未包含此功能</h2>
          <p>兑换有效的VIP时间码后即可使用；基础授权期限、设备绑定和已有素材不会因此改变。</p>
          <div className="vip-feature-highlights">
            {highlights.map((highlight) => <div key={highlight}><ShieldCheck size={16} /><span>{highlight}</span></div>)}
          </div>
          <div className="vip-feature-locked-actions">
            <button type="button" className="primary" onClick={onRedeem}><KeyRound size={15} />前往兑换VIP时间码</button>
            <button type="button" onClick={onBack}>返回媒体库</button>
          </div>
          <small>这里只展示功能介绍，不会加载VIP库内容或执行VIP专属操作。</small>
        </section>
      </div>
    </section>
  );
}

function LicensedApplication({ licenseState, onLicenseStateChange }: {
  licenseState: LicenseState;
  onLicenseStateChange: (state: LicenseState) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [aliyunSettingsRequested, setAliyunSettingsRequested] = useState(false);
  const [requestedModule, setActiveModule] = useState<ApplicationModule>("media");
  const requestedFeature = featureRegistry.get(requestedModule);
  const activeModule = canDiscoverFeature(featureRegistry, requestedModule, licenseState) ? requestedModule : "media";
  const lockedVipFeature = requestedFeature?.group === "vip"
    && activeModule === requestedModule
    && !canAccessFeature(featureRegistry, requestedModule, licenseState)
    ? requestedFeature
    : null;
  const [videoDownloadDraft, setVideoDownloadDraft] = useState("");
  const [classifierHandoff, setClassifierHandoff] = useState<ClassifierHandoff | null>(null);
  const [assets, setAssets] = useState(seedAssets);
  const [viralLibraryRevision, setViralLibraryRevision] = useState(0);
  const [viralSearchQuery, setViralSearchQuery] = useState("");
  const [viralUploadSelection, setViralUploadSelection] = useState<DesktopMediaRecord[] | null>(null);
  const [viralUploadMajorCategory, setViralUploadMajorCategory] = useState("");
  const [viralUploadSyncData, setViralUploadSyncData] = useState(false);
  const [viralDataCsvInspection, setViralDataCsvInspection] = useState<ViralDataCsvInspection | null>(null);
  const [viralDataCsvMatchColumn, setViralDataCsvMatchColumn] = useState(-1);
  const [viralDataCsvDisplayColumns, setViralDataCsvDisplayColumns] = useState<number[]>([]);
  const [viralDataCsvVisualTypeColumn, setViralDataCsvVisualTypeColumn] = useState(-1);
  const [viralVisualRecognitionMode, setViralVisualRecognitionMode] = useState<"local" | "api">("local");
  const [viralUploadSyncCopy, setViralUploadSyncCopy] = useState(false);
  const [viralUploadCopySource, setViralUploadCopySource] = useState<"csv" | "local">("csv");
  const [viralUploadCopyColumn, setViralUploadCopyColumn] = useState(-1);
  const [viralUploadBusy, setViralUploadBusy] = useState(false);
  const [viralUploadError, setViralUploadError] = useState("");
  const [viralUploadProgress, setViralUploadProgress] = useState("");
  const [viralCsvInspection, setViralCsvInspection] = useState<ViralCsvInspection | null>(null);
  const [viralCsvColumns, setViralCsvColumns] = useState<ViralCsvColumns>({ associationId: -1, media: -1, copy: -1, category: [], data: [], majorCategory: -1, title: -1 });
  const [viralCsvConfirmed, setViralCsvConfirmed] = useState(false);
  const [viralCsvMajorCategoryFallback, setViralCsvMajorCategoryFallback] = useState("");
  const [viralCsvImportBusy, setViralCsvImportBusy] = useState(false);
  const [viralCsvImportError, setViralCsvImportError] = useState("");
  const [folders, setFolders] = useState<LocalFolderSource[]>([]);
  const [activeFolderPath, setActiveFolderPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | AssetType>("all");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [assetPagination, setAssetPagination] = useState({ key: "", page: 1 });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedAssetIds, setSelectedAssetIds] = useState<number[]>([]);
  const [assetMarqueeRect, setAssetMarqueeRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [classifierPreparing, setClassifierPreparing] = useState(false);
  const [previewAssetId, setPreviewAssetId] = useState<number | null>(null);
  const [hoverPreviewAssetId, setHoverPreviewAssetId] = useState<number | null>(null);
  const [collection, setCollection] = useState("全部素材");
  const [sortOpen, setSortOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>("recent");
  const [tagColors, setTagColors] = useState(defaultTagColors);
  const [collections, setCollections] = useState(() => normalizeProjectCollections(null));
  const [collectionAliases, setCollectionAliases] = useState<Record<string, string>>({});
  const [hiddenCollections, setHiddenCollections] = useState<string[]>([]);
  const [collectionRenameTarget, setCollectionRenameTarget] = useState<string | null>(null);
  const [collectionRenameValue, setCollectionRenameValue] = useState("");
  const collectionRenameInputRef = useRef<HTMLInputElement>(null);
  const [collectionDeleteTarget, setCollectionDeleteTarget] = useState<string | null>(null);
  const [projectExpanded, setProjectExpanded] = useState(true);
  const [inputDialog, setInputDialog] = useState<InputDialog>(null);
  const [dialogValue, setDialogValue] = useState("");
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [assetMenu, setAssetMenu] = useState<number | null>(null);
  const [assetMenuPosition, setAssetMenuPosition] = useState({ top: 0, left: 0 });
  const [folderMenuPath, setFolderMenuPath] = useState<string | null>(null);
  const [folderMenuPosition, setFolderMenuPosition] = useState({ top: 0, left: 0 });
  const [folderDeleteTarget, setFolderDeleteTarget] = useState<LocalFolderSource | null>(null);
  const [folderDeleteMode, setFolderDeleteMode] = useState<FolderDeleteMode>("remove-folder");
  const [folderDeleteBusy, setFolderDeleteBusy] = useState(false);
  const [folderDeleteError, setFolderDeleteError] = useState("");
  const [folderRelinkBusyPath, setFolderRelinkBusyPath] = useState<string | null>(null);
  const [folderRelinkPlan, setFolderRelinkPlan] = useState<FolderRelinkPlan | null>(null);
  const [repairTargetId, setRepairTargetId] = useState<number | null>(null);
  const [toast, setToast] = useState("");
  const [localStatus, setLocalStatus] = useState<LocalStatus>("checking");
  const [directoryName, setDirectoryName] = useState("");
  const [scanCount, setScanCount] = useState(0);
  const [mediaDragActive, setMediaDragActive] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>(initialUpdateState);
  const [qianchuanBootstrap, setQianchuanBootstrap] = useState<QianchuanBootstrap | null>(null);
  const [qianchuanBootstrapLoading, setQianchuanBootstrapLoading] = useState(false);
  const [qianchuanBootstrapError, setQianchuanBootstrapError] = useState("");
  const [qianchuanDialog, setQianchuanDialog] = useState<{ mode: "bind" | "view"; assetId: number } | null>(null);
  const [qianchuanReference, setQianchuanReference] = useState("");
  const [qianchuanAdvertiserId, setQianchuanAdvertiserId] = useState("");
  const [qianchuanDialogBusy, setQianchuanDialogBusy] = useState(false);
  const [qianchuanDialogError, setQianchuanDialogError] = useState("");
  const [qianchuanDialogVideo, setQianchuanDialogVideo] = useState<QianchuanVideo | null>(null);
  const [qianchuanDialogReport, setQianchuanDialogReport] = useState<QianchuanPerformance | null>(null);
  const [qianchuanDialogInsights, setQianchuanDialogInsights] = useState<QianchuanInsights | null>(null);
  const [qianchuanDialogInsightsLoading, setQianchuanDialogInsightsLoading] = useState(false);
  const [qianchuanDialogInsightsError, setQianchuanDialogInsightsError] = useState("");
  const [qianchuanDialogRange, setQianchuanDialogRange] = useState("");
  const directoryHandle = useRef<FileSystemDirectoryHandleLike | null>(null);
  const mediaDragDepth = useRef(0);
  const selectionAnchorId = useRef<number | null>(null);
  const assetGridRef = useRef<HTMLDivElement | null>(null);
  const assetMarquee = useRef<{
    startX: number;
    startY: number;
    baseIds: number[];
    selectableIds: Set<number>;
  } | null>(null);
  const qianchuanInsightSerial = useRef(0);
  const desktopLibraryReady = useRef(false);
  const objectUrls = useRef<string[]>([]);
  const hoverPreviewVideo = useRef<HTMLVideoElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const restoreInput = useRef<HTMLInputElement>(null);
  const repairInput = useRef<HTMLInputElement>(null);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  };

  const ensureQianchuanBootstrap = async (force = false) => {
    if (!force && qianchuanBootstrap) return qianchuanBootstrap;
    if (!window.desktopBridge?.qianchuanBootstrap) throw new Error("千川数据功能仅支持桌面版");
    setQianchuanBootstrapLoading(true);
    setQianchuanBootstrapError("");
    try {
      const state = await window.desktopBridge.qianchuanBootstrap();
      setQianchuanBootstrap(state);
      setQianchuanAdvertiserId((current) => current || state.default_advertiser_id || state.accounts[0]?.advertiser_id || "");
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : "千川授权读取失败";
      setQianchuanBootstrapError(message);
      throw new Error(message);
    } finally {
      setQianchuanBootstrapLoading(false);
    }
  };

  const loadQianchuanAssetInsights = (payload: { authorization_id: string; advertiser_id: string; material_id: string }) => {
    if (!window.desktopBridge?.qianchuanReport) return;
    const serial = ++qianchuanInsightSerial.current;
    setQianchuanDialogInsightsLoading(true);
    setQianchuanDialogInsightsError("");
    void window.desktopBridge.qianchuanReport({ ...payload, include_insights: true }).then((report) => {
      if (serial === qianchuanInsightSerial.current) setQianchuanDialogInsights(report.insights ?? null);
    }).catch((insightError) => {
      if (serial === qianchuanInsightSerial.current) setQianchuanDialogInsightsError(insightError instanceof Error ? insightError.message : "千川扩展数据同步失败");
    }).finally(() => {
      if (serial === qianchuanInsightSerial.current) setQianchuanDialogInsightsLoading(false);
    });
  };
  const closeQianchuanDialog = () => {
    qianchuanInsightSerial.current += 1;
    setQianchuanDialog(null);
  };

  const openQianchuanBinding = async (asset: Asset) => {
    qianchuanInsightSerial.current += 1;
    setAssetMenu(null);
    setQianchuanDialog({ mode: "bind", assetId: asset.id });
    setQianchuanReference("");
    setQianchuanDialogVideo(null);
    setQianchuanDialogReport(null);
    setQianchuanDialogInsights(null);
    setQianchuanDialogInsightsLoading(false);
    setQianchuanDialogInsightsError("");
    setQianchuanDialogRange("");
    setQianchuanDialogError("");
    try {
      await ensureQianchuanBootstrap();
    } catch (error) {
      setQianchuanDialogError(error instanceof Error ? error.message : "千川授权读取失败");
    }
  };

  const loadQianchuanAssetData = async (asset: Asset) => {
    if (!asset.qianchuan) return;
    qianchuanInsightSerial.current += 1;
    setAssetMenu(null);
    setQianchuanDialog({ mode: "view", assetId: asset.id });
    setQianchuanDialogVideo(null);
    setQianchuanDialogReport(null);
    setQianchuanDialogInsights(null);
    setQianchuanDialogInsightsLoading(false);
    setQianchuanDialogInsightsError("");
    setQianchuanDialogRange("");
    setQianchuanDialogError("");
    setQianchuanDialogBusy(true);
    try {
      const ready = await ensureQianchuanBootstrap();
      const payload = {
        authorization_id: ready.authorization_id,
        advertiser_id: asset.qianchuan.advertiserId,
      };
      const [resolved, report] = await Promise.all([
        window.desktopBridge?.qianchuanResolve({ ...payload, reference: asset.qianchuan.materialId }),
        window.desktopBridge?.qianchuanReport({ ...payload, material_id: asset.qianchuan.materialId }),
      ]);
      setQianchuanDialogVideo(resolved?.video ?? null);
      setQianchuanDialogReport(report?.data ?? null);
      if (report?.data) loadQianchuanAssetInsights({ ...payload, material_id: asset.qianchuan.materialId });
      setQianchuanDialogRange(report?.start_date && report?.end_date ? `${report.start_date} 至 ${report.end_date}` : "最近 30 天");
      setAssets((current) => current.map((item) => item.id === asset.id && item.qianchuan ? {
        ...item,
        qianchuan: { ...item.qianchuan, lastSyncedAt: new Date().toISOString() },
      } : item));
    } catch (error) {
      setQianchuanDialogError(error instanceof Error ? error.message : "千川数据读取失败");
    } finally {
      setQianchuanDialogBusy(false);
    }
  };

  const submitQianchuanBinding = async () => {
    if (!qianchuanDialog || qianchuanDialog.mode !== "bind") return;
    const reference = qianchuanReference.trim();
    if (!reference) {
      setQianchuanDialogError("请输入素材 ID、视频 ID 或抖音作品 ID");
      return;
    }
    setQianchuanDialogBusy(true);
    setQianchuanDialogError("");
    try {
      const ready = await ensureQianchuanBootstrap();
      const advertiserId = qianchuanAdvertiserId || ready.default_advertiser_id;
      const account = ready.accounts.find((item) => item.advertiser_id === advertiserId);
      if (!account) throw new Error("请选择素材所属的千川账户");
      if (!window.desktopBridge?.qianchuanResolve) throw new Error("千川数据功能仅支持桌面版");
      const resolved = await window.desktopBridge.qianchuanResolve({
        authorization_id: ready.authorization_id,
        advertiser_id: advertiserId,
        reference,
      });
      const video = resolved.video;
      const now = new Date().toISOString();
      const binding: QianchuanBinding = {
        advertiserId,
        advertiserName: account.name,
        materialId: video.material_id,
        videoId: video.video_id || undefined,
        awemeItemId: video.aweme_item_id || undefined,
        source: video.aweme_item_id ? "douyin" : "qianchuan",
        boundAt: now,
        lastSyncedAt: now,
      };
      setAssets((current) => current.map((asset) => asset.id === qianchuanDialog.assetId ? { ...asset, qianchuan: binding } : asset));
      setQianchuanDialog({ mode: "view", assetId: qianchuanDialog.assetId });
      setQianchuanDialogVideo(video);
      const report = await window.desktopBridge.qianchuanReport({
        authorization_id: ready.authorization_id,
        advertiser_id: advertiserId,
        material_id: video.material_id,
      });
      setQianchuanDialogReport(report.data);
      if (report.data) loadQianchuanAssetInsights({
        authorization_id: ready.authorization_id,
        advertiser_id: advertiserId,
        material_id: video.material_id,
      });
      setQianchuanDialogRange(`${report.start_date} 至 ${report.end_date}`);
      notify("已绑定千川素材数据");
    } catch (error) {
      setQianchuanDialogError(error instanceof Error ? error.message : "千川素材绑定失败");
    } finally {
      setQianchuanDialogBusy(false);
    }
  };

  const importQianchuanPerformance = async (item: QianchuanPerformance, account: QianchuanAccount) => {
    try {
      const ready = await ensureQianchuanBootstrap();
      if (!window.desktopBridge?.qianchuanImport) throw new Error("千川视频导入仅支持桌面版");
      const result = await window.desktopBridge.qianchuanImport({
        authorization_id: ready.authorization_id,
        advertiser_id: account.advertiser_id,
        reference: item.material_id,
      });
      installDesktopAssets([result.record], "file", QIANCHUAN_PROJECT_COLLECTION);
      setCollections((current) => normalizeProjectCollections([...current, QIANCHUAN_PROJECT_COLLECTION]));
      const binding: QianchuanBinding = {
        advertiserId: account.advertiser_id,
        advertiserName: account.name,
        materialId: result.video.material_id,
        videoId: result.video.video_id || undefined,
        awemeItemId: result.video.aweme_item_id || undefined,
        source: result.video.aweme_item_id ? "douyin" : "qianchuan",
        boundAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      };
      setAssets((current) => current.map((asset) => asset.localPath === result.record.path ? { ...asset, qianchuan: binding } : asset));
      notify(`已导入媒体库：${result.record.name}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "千川视频导入失败");
    }
  };

  const resetHoverPreviewVideo = (video: HTMLVideoElement) => {
    video.pause();
    try {
      video.currentTime = 0;
    } catch {
      // A browser may reject seeking before metadata is available.
    }
  };

  const startVideoHoverPreview = (assetId: number, video: HTMLVideoElement) => {
    const previousVideo = hoverPreviewVideo.current;
    if (previousVideo && previousVideo !== video) resetHoverPreviewVideo(previousVideo);

    hoverPreviewVideo.current = video;
    const deferredSource = video.dataset.mediaSrc;
    if (!video.getAttribute("src") && deferredSource) {
      video.preload = "metadata";
      video.src = deferredSource;
      video.load();
    }
    video.muted = true;
    video.loop = true;
    video.playsInline = true;

    void video.play().then(() => {
      if (hoverPreviewVideo.current === video) setHoverPreviewAssetId(assetId);
    }).catch(() => {
      if (hoverPreviewVideo.current === video) {
        hoverPreviewVideo.current = null;
        setHoverPreviewAssetId(null);
      }
    });
  };

  const stopVideoHoverPreview = (assetId: number, video: HTMLVideoElement) => {
    if (hoverPreviewVideo.current === video) hoverPreviewVideo.current = null;
    resetHoverPreviewVideo(video);
    setHoverPreviewAssetId((current) => current === assetId ? null : current);
  };

  const stopActiveHoverPreview = () => {
    const video = hoverPreviewVideo.current;
    hoverPreviewVideo.current = null;
    if (video) resetHoverPreviewVideo(video);
    setHoverPreviewAssetId(null);
  };

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.updateBootstrap) return;
    bridge.updateBootstrap().then((state) => { if (state) setUpdateState(state); }).catch(() => {});
    bridge.updateOnStateChanged?.((state) => setUpdateState(state));
  }, []);

  const checkForUpdates = async () => {
    const bridge = window.desktopBridge;
    if (!bridge?.updateCheck) {
      notify("自动更新仅支持桌面安装版");
      return;
    }
    try {
      const state = await bridge.updateCheck();
      setUpdateState(state);
      if (!state.shouldPrompt) notify(state.message);
    } catch (error) {
      notify(error instanceof Error ? error.message : "检查更新失败");
    }
  };

  const selectCollection = (nextCollection: string) => {
    setCollection(nextCollection);
    // A collection click means "show this collection". Keeping an old text
    // query made an already-selected project appear unresponsive and could
    // hide most of its assets while the sidebar still showed the full count.
    setQuery("");
    setActiveFolderPath(null);
    setFolderMenuPath(null);
  };

  const installScannedAssets = (records: LocalFileRecord[]) => {
    setAssets((current) => {
      const previousByPath = new Map(current.filter((asset) => asset.localPath).map((asset) => [asset.localPath, asset]));
      objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrls.current = [];
      return records.map((record) => {
        const previous = previousByPath.get(record.path);
        const src = URL.createObjectURL(record.file);
        objectUrls.current.push(src);
        return {
          id: previous?.id ?? stableLocalId(record.key),
          name: record.file.name.replace(/\.[^.]+$/, ""),
          type: record.type,
          size: formatFileSize(record.file.size),
          src,
          duration: record.type === "image" ? undefined : "--:--",
          tags: previous?.tags ?? ["待处理"],
          visualTypes: previous?.visualTypes,
          favorite: previous?.favorite,
          collection: normalizeAssetCollection(previous?.collection),
          majorCategory: previous?.majorCategory,
          description: previous?.description ?? `本地素材 · ${record.path}`,
          qianchuan: previous?.qianchuan,
          csvData: previous?.csvData,
          broken: false,
          deleted: previous?.deleted,
          sourceKind: "folder" as const,
          localPath: record.path,
          modifiedAt: record.file.lastModified,
          available: true,
        };
      });
    });
  };

  const installDesktopAssets = (records: DesktopMediaRecord[], sourceKind: "file" | "folder", targetCollection?: string) => {
    if (!records.length) {
      notify("没有找到可导入的图片、视频或音频");
      return;
    }
    setAssets((current) => {
      const existing = current.filter((asset) => asset.sourceKind !== "demo");
      const previousByPath = new Map(existing.filter((asset) => asset.localPath).map((asset) => [asset.localPath, asset]));
      const importedPaths = new Set(records.map((record) => record.path));
      const imported = records.map((record) => desktopRecordAsset(record, sourceKind, targetCollection, previousByPath.get(record.path)));
      return [...imported, ...existing.filter((asset) => !asset.localPath || !importedPaths.has(asset.localPath))];
    });
    setCollection("全部素材");
    setLocalStatus("connected");
    notify(`已导入 ${records.length} 个素材，并保存到本地媒体库`);
  };

  const importedViralAssets = (records: DesktopMediaRecord[], sourceKind: "file" | "folder" = "file") => {
    const previousByPath = new Map(assets.filter((asset) => asset.localPath).map((asset) => [asset.localPath!, asset]));
    return records.map((record) => desktopRecordAsset(record, sourceKind, VIRAL_FRAME_COLLECTION, previousByPath.get(record.path)));
  };

  const autoTranscribeViralVideos = async (items: Asset[], associationByPath = new Map<string, string>()) => {
    const bridge = window.desktopBridge;
    if (!bridge?.viralCopyTranscribeMedia) return { completed: 0, failed: 0 };
    let completed = 0;
    let failed = 0;
    for (const asset of items.filter((item) => item.type === "video")) {
      try {
        await bridge.viralCopyTranscribeMedia({ assetId: asset.id, mediaUrl: asset.src, title: asset.name, associationId: associationByPath.get(asset.localPath || ""), majorCategory: asset.majorCategory });
        completed += 1;
      } catch { failed += 1; }
    }
    if (completed) setViralLibraryRevision((value) => value + 1);
    return { completed, failed };
  };

  const uploadViralVisuals = async () => {
    const records = await window.desktopBridge?.mediaChooseFiles?.({ visualOnly: true });
    if (!records?.length) return;
    setViralUploadSelection(records);
    setViralUploadMajorCategory("");
    setViralUploadSyncData(false);
    setViralDataCsvInspection(null);
    setViralDataCsvMatchColumn(-1);
    setViralDataCsvDisplayColumns([]);
    setViralDataCsvVisualTypeColumn(-1);
    setViralVisualRecognitionMode("local");
    setViralUploadSyncCopy(false);
    setViralUploadCopySource("csv");
    setViralUploadCopyColumn(-1);
    setViralUploadError("");
    setViralUploadProgress("");
  };

  const loadViralDataCsv = async (csvPath?: string) => {
    const bridge = window.desktopBridge;
    if (!bridge?.viralLibraryDataCsv) throw new Error("CSV 数据导入仅支持桌面版");
    try {
      const result = await bridge.viralLibraryDataCsv(csvPath ? { path: csvPath } : undefined);
      if (result.cancelled || !("token" in result)) return;
      setViralDataCsvInspection(result);
      setViralDataCsvMatchColumn(result.matchColumn);
      setViralDataCsvDisplayColumns(result.displayColumns);
      setViralDataCsvVisualTypeColumn(result.visualTypeColumn);
      setViralUploadCopyColumn(result.copyColumn);
      if (result.copyColumn >= 0) setViralUploadCopySource("csv");
      setViralUploadSyncData(true);
      setViralUploadError("");
    } catch (failure) {
      setViralDataCsvInspection(null);
      setViralDataCsvMatchColumn(-1);
      setViralDataCsvDisplayColumns([]);
      setViralDataCsvVisualTypeColumn(-1);
      setViralUploadCopyColumn(-1);
      throw failure;
    }
  };

  const dropViralVisualFiles = async (files: File[]) => {
    const bridge = window.desktopBridge;
    if (!bridge?.mediaPathForFile || !bridge.mediaImportPaths || !files.length) return;
    try {
      const paths = files.map((file) => bridge.mediaPathForFile(file)).filter(Boolean);
      const csvPaths = paths.filter((value) => /\.csv$/i.test(value));
      const mediaPaths = paths.filter((value) => !/\.csv$/i.test(value));
      if (csvPaths.length > 1) { notify("每次最多拖入一个 CSV 数据文件"); return; }
      if (!mediaPaths.length) { notify("请同时拖入图片或视频；独立导入 CSV 可使用页面上的“导入 CSV”按钮"); return; }
      const result = await bridge.mediaImportPaths(mediaPaths);
      const visuals = result.records.filter((record) => record.type === "image" || record.type === "video");
      if (!visuals.length) { notify("没有可上传的图片或视频文件"); return; }
      setViralUploadSelection(visuals);
      setViralUploadMajorCategory("");
      setViralUploadSyncData(false);
      setViralDataCsvInspection(null);
      setViralDataCsvMatchColumn(-1);
      setViralDataCsvDisplayColumns([]);
      setViralDataCsvVisualTypeColumn(-1);
      setViralVisualRecognitionMode("local");
      setViralUploadSyncCopy(false);
      setViralUploadCopySource("csv");
      setViralUploadCopyColumn(-1);
      setViralUploadError("");
      if (csvPaths[0]) await loadViralDataCsv(csvPaths[0]);
    } catch (failure) { const message = desktopErrorMessage(failure, "拖入画面失败"); setViralUploadError(message); notify(message); }
  };

  const confirmViralVisualUpload = async () => {
    const records = viralUploadSelection;
    if (!records?.length) return;
    const bridge = window.desktopBridge;
    setViralUploadBusy(true);
    setViralUploadError("");
    setViralUploadProgress("");
    try {
      if (!bridge?.viralLibraryAuthorizeWrite) throw new Error("当前版本不支持爆款画面库写入鉴权");
      await bridge.viralLibraryAuthorizeWrite();
      const csvDataByPath = new Map<string, Asset["csvData"]>();
      const csvCopyByPath = new Map<string, { text: string; rowNumber: number }>();
      const visualTypesByPath = new Map<string, string[]>();
      let unmatchedCount = 0;
      const needsCsv = viralUploadSyncData || (viralUploadSyncCopy && viralUploadCopySource === "csv");
      if (needsCsv) {
        if (!bridge?.viralLibraryDataCsv || !viralDataCsvInspection) throw new Error("请先选择包含数据的 CSV 文件");
        if (viralDataCsvMatchColumn < 0) throw new Error("请选择 CSV 中用于匹配画面文件的列");
        if (viralUploadSyncCopy && viralUploadCopySource === "csv" && viralUploadCopyColumn < 0) throw new Error("请选择 CSV 中的文案字段");
        setViralUploadProgress("正在核对 CSV 行与画面文件…");
        const csvResult = await bridge.viralLibraryDataCsv({
          token: viralDataCsvInspection.token,
          matchColumn: viralDataCsvMatchColumn,
          displayColumns: viralUploadSyncData ? viralDataCsvDisplayColumns : [],
          copyColumn: viralUploadSyncCopy && viralUploadCopySource === "csv" ? viralUploadCopyColumn : -1,
          visualTypeColumn: viralDataCsvVisualTypeColumn,
        });
        if (csvResult.cancelled || !("rows" in csvResult)) throw new Error("CSV 数据读取失败，请重新选择文件");
        const comparison = matchViralVisualCsv(records.map((record) => record.path), csvResult.rows);
        if (comparison.ambiguous.length) throw new Error(`${comparison.ambiguous.length} 个画面匹配到重复文件名或多行数据，请在 CSV 中使用完整文件路径或清理重复行`);
        if (!comparison.matches.length) throw new Error("CSV 没有匹配到本次选择的画面；请核对文件名／路径对应列");
        unmatchedCount = comparison.unmatched.length;
        const importedAt = new Date().toISOString();
        for (const item of comparison.matches) {
          if (viralUploadSyncData) csvDataByPath.set(item.path, { sourceFile: csvResult.fileName, importedAt, rowNumber: item.row.rowNumber, fields: item.row.fields });
          if (viralUploadSyncCopy && viralUploadCopySource === "csv" && item.row.copyText.trim()) csvCopyByPath.set(item.path, { text: item.row.copyText.trim(), rowNumber: item.row.rowNumber });
          if (item.row.visualTypes.length) visualTypesByPath.set(item.path, item.row.visualTypes);
        }
      }
      const recordsToClassify = records.filter((record): record is DesktopMediaRecord & { type: "image" | "video" } =>
        (record.type === "image" || record.type === "video") && !visualTypesByPath.get(record.path)?.length,
      );
      let classificationWarning = "";
      if (recordsToClassify.length) {
        if (viralVisualRecognitionMode === "local") {
          for (let index = 0; index < recordsToClassify.length; index += 1) {
            const record = recordsToClassify[index];
            setViralUploadProgress(`正在本地识别画面 ${index + 1}/${recordsToClassify.length}：${record.name}`);
            try {
              const result = await classifyViralVisualLocally(record.url, record.type, (progress, file) => {
                setViralUploadProgress(`正在准备本地模型 ${progress}%：${file}`);
              });
              visualTypesByPath.set(record.path, [result.visualType]);
            } catch {
              visualTypesByPath.set(record.path, ["人工标注"]);
            }
          }
          const manualCount = recordsToClassify.filter((record) => visualTypesByPath.get(record.path)?.includes("人工标注")).length;
          if (manualCount) classificationWarning = `${manualCount} 个画面本地识别不确定，已归入人工标注`;
        } else {
          if (!bridge?.viralLibraryClassifyVisuals) throw new Error("当前版本不支持 API 画面识别");
          const stopProgress = bridge.viralLibraryOnClassificationProgress?.((progress) => {
            setViralUploadProgress(`正在用 API 识别画面 ${progress.completed}/${progress.total}：${progress.name}`);
          });
          try {
            const response = await bridge.viralLibraryClassifyVisuals(recordsToClassify.map((record) => ({ path: record.path, type: record.type })));
            for (const item of response.items) visualTypesByPath.set(item.path, [item.visualType]);
            classificationWarning = response.warning || "";
          } finally {
            stopProgress?.();
          }
        }
      }
      installDesktopAssets(records, "file", VIRAL_FRAME_COLLECTION);
      const importedPaths = new Set(records.map((record) => record.path));
      const majorCategory = viralUploadMajorCategory.trim().slice(0, 100);
      setAssets((current) => current.map((asset) => {
        if (!asset.localPath || !importedPaths.has(asset.localPath)) return asset;
        const visualTypes = visualTypesByPath.get(asset.localPath) || ["人工标注"];
        return {
          ...asset,
          majorCategory: majorCategory || asset.majorCategory,
          csvData: csvDataByPath.get(asset.localPath) || asset.csvData,
          visualTypes,
          tags: [...new Set([...asset.tags, ...visualTypes])],
        };
      }));
      const imported = importedViralAssets(records).map((asset) => ({
        ...asset,
        majorCategory: majorCategory || asset.majorCategory,
        visualTypes: visualTypesByPath.get(asset.localPath || "") || ["人工标注"],
        tags: [...new Set([...asset.tags, ...(visualTypesByPath.get(asset.localPath || "") || ["人工标注"])])],
      }));
      let copyCompleted = 0;
      let copyFailed = 0;
      if (viralUploadSyncCopy && viralUploadCopySource === "local") {
        setViralUploadProgress("正在用本机转写视频文案…");
        const result = await autoTranscribeViralVideos(imported);
        copyCompleted = result.completed;
        copyFailed = result.failed;
      } else if (viralUploadSyncCopy && viralUploadCopySource === "csv") {
        setViralUploadProgress("正在将 CSV 文案同步到爆款文案库…");
        if (!bridge?.viralCopySaveReference) throw new Error("当前版本不支持文案库写入");
        for (const asset of imported) {
          const copy = asset.localPath ? csvCopyByPath.get(asset.localPath) : null;
          if (!copy) continue;
          try {
            await bridge.viralCopySaveReference({
              assetId: asset.id,
              mediaUrl: asset.src,
              title: asset.name,
              associationId: `csv-data-${copy.rowNumber}`,
              source: "csv-data",
              majorCategory: asset.majorCategory,
              segments: [{ id: "S1", text: copy.text, start: null, end: null, category: "未分类", classifications: [], confirmed: false }],
            });
            copyCompleted += 1;
          } catch { copyFailed += 1; }
        }
        if (copyCompleted) setViralLibraryRevision((value) => value + 1);
      } else {
        setViralUploadProgress("正在保存画面…");
      }
      setViralUploadSelection(null);
      setViralUploadProgress("");
      const dataMessage = csvDataByPath.size ? `；${csvDataByPath.size} 个画面已关联 CSV 数据${unmatchedCount ? `，${unmatchedCount} 个未匹配` : ""}` : "";
      const copyMessage = copyCompleted ? `；${copyCompleted} 条文案已同步到爆款文案库${copyFailed ? `，${copyFailed} 条失败` : ""}` : copyFailed ? `；${copyFailed} 条文案未能同步` : viralUploadSyncCopy && viralUploadCopySource === "csv" ? "；CSV 匹配行中没有可同步的文案" : "";
      const classificationMessage = classificationWarning ? `；${classificationWarning}` : recordsToClassify.length ? `；${recordsToClassify.length} 个画面已自动打标` : "";
      notify(`已上传 ${records.length} 个画面${dataMessage}${copyMessage}${classificationMessage}`);
    } catch (failure) {
      setViralUploadError(desktopErrorMessage(failure, "画面上传失败"));
      setViralUploadProgress("");
    } finally {
      setViralUploadBusy(false);
    }
  };

  const removeViralVisuals = async (ids: number[], mode: "library" | "trash") => {
    if (!ids.length) return;
    try {
      if (!window.desktopBridge?.viralLibraryAuthorizeWrite) throw new Error("当前版本不支持爆款画面库写入鉴权");
      await window.desktopBridge.viralLibraryAuthorizeWrite();
    }
    catch (failure) { notify(desktopErrorMessage(failure, "当前无权修改爆款画面库")); return; }
    const selected = new Set(ids);
    setAssets((current) => current.map((asset) => {
      if (!selected.has(asset.id)) return asset;
      if (mode === "trash") return { ...asset, deleted: true };
      return {
        ...asset,
        collection: asset.collection === VIRAL_FRAME_COLLECTION ? undefined : asset.collection,
        tags: asset.tags.filter((tag) => tag !== VIRAL_FRAME_COLLECTION),
      };
    }));
    notify(mode === "trash" ? `已将 ${ids.length} 个画面移入回收站，原文件未删除` : `已从爆款画面库移除 ${ids.length} 个画面，媒体库素材保留`);
  };

  const setViralVisualCategory = async (ids: number[], category: string) => {
    try {
      if (!window.desktopBridge?.viralLibraryAuthorizeWrite) throw new Error("当前版本不支持爆款画面库写入鉴权");
      await window.desktopBridge.viralLibraryAuthorizeWrite();
    }
    catch (failure) { notify(desktopErrorMessage(failure, "当前无权修改爆款画面库")); return; }
    const selected = new Set(ids);
    setAssets((current) => current.map((asset) => selected.has(asset.id) ? { ...asset, majorCategory: category } : asset));
    notify(`已更新 ${ids.length} 个画面的大分类`);
  };

  const applyViralCsvImport = async (importedCsv: ViralCsvImportResult, confirmedOnImport = false, categoryFallback = "") => {
    const bridge = window.desktopBridge;
    if (!bridge?.mediaImportPaths || !bridge.viralCopySaveReference || !bridge.viralLibraryAuthorizeWrite) return;
    await bridge.viralLibraryAuthorizeWrite();
    const rows = importedCsv.rows.map((row) => ({ ...row, majorCategory: row.majorCategory || categoryFallback.trim().slice(0, 100) }));
    const mediaPaths = [...new Set(rows.map((row) => row.mediaPath).filter(Boolean))];
    const categoryByPath = new Map<string, string>();
    const categoryByAssociation = new Map<string, string>();
    for (const row of rows) {
      if (row.copy && row.majorCategory) {
        const previousAssociationCategory = categoryByAssociation.get(row.associationId);
        if (previousAssociationCategory && previousAssociationCategory !== row.majorCategory) throw new Error(`同一关联编号在 CSV 中对应多个大分类：第 ${row.rowNumber} 行，请先统一分类`);
        categoryByAssociation.set(row.associationId, row.majorCategory);
      }
      if (!row.mediaPath || !row.majorCategory) continue;
      const previous = categoryByPath.get(row.mediaPath);
      if (previous && previous !== row.majorCategory) throw new Error(`同一画面在 CSV 中对应多个大分类：第 ${row.rowNumber} 行，请先统一分类`);
      categoryByPath.set(row.mediaPath, row.majorCategory);
    }
    const mediaResult = mediaPaths.length ? await bridge.mediaImportPaths(mediaPaths) : { records: [], folders: [], sourceKind: "file" as const };
    if (mediaResult.records.length) installDesktopAssets(mediaResult.records, mediaResult.sourceKind, VIRAL_FRAME_COLLECTION);
    if (categoryByPath.size) setAssets((current) => current.map((asset) => asset.localPath && categoryByPath.has(asset.localPath) ? { ...asset, majorCategory: categoryByPath.get(asset.localPath) } : asset));
    const importedAssets = importedViralAssets(mediaResult.records, mediaResult.sourceKind).map((asset) => ({ ...asset, majorCategory: categoryByPath.get(asset.localPath || "") || asset.majorCategory }));
    const assetByPath = new Map(importedAssets.map((asset) => [asset.localPath || "", asset]));
    const assetByAssociation = new Map(rows.flatMap((row) => {
      const asset = row.mediaPath ? assetByPath.get(row.mediaPath) : undefined;
      return asset ? [[row.associationId, asset] as const] : [];
    }));
    const copyGroups = new Map<string, { asset?: Asset; associationId: string; title: string; majorCategory: string; segments: ViralCopySegment[] }>();
    rows.forEach((row) => {
      if (!row.copy.trim()) return;
      const asset = (row.mediaPath ? assetByPath.get(row.mediaPath) : undefined) || assetByAssociation.get(row.associationId);
      const groupKey = asset ? `asset:${asset.id}` : `standalone:${row.associationId}`;
      const group = copyGroups.get(groupKey) || { asset, associationId: row.associationId, title: row.title, majorCategory: row.majorCategory, segments: [] };
      if (row.majorCategory && group.majorCategory && row.majorCategory !== group.majorCategory) throw new Error(`同一文案组在 CSV 中对应多个大分类：第 ${row.rowNumber} 行，请先统一分类`);
      if (row.majorCategory) group.majorCategory = row.majorCategory;
      group.segments.push({ id: `S${group.segments.length + 1}`, text: row.copy.trim(), start: null, end: null, category: row.classifications[0]?.value || "未分类", classifications: row.classifications, data_fields: row.dataFields, confirmed: confirmedOnImport });
      copyGroups.set(groupKey, group);
    });
    for (const group of copyGroups.values()) {
      await bridge.viralCopySaveReference({
        ...(group.asset ? { assetId: group.asset.id, mediaUrl: group.asset.src } : { referenceId: group.associationId }),
        title: group.title,
        associationId: group.associationId,
        source: "csv",
        majorCategory: group.majorCategory,
        segments: group.segments,
      });
    }
    const assetIdsWithCopy = new Set([...copyGroups.values()].flatMap((group) => group.asset ? [group.asset.id] : []));
    const associationByPath = new Map(rows.filter((row) => row.mediaPath).map((row) => [row.mediaPath, row.associationId]));
    const transcribed = await autoTranscribeViralVideos(importedAssets.filter((asset) => !assetIdsWithCopy.has(asset.id)), associationByPath);
    setViralLibraryRevision((value) => value + 1);
    const warning = importedCsv.warnings.length ? `；${importedCsv.warnings.length} 行画面路径无效，其文案已按独立文案处理` : "";
    const asr = transcribed.failed ? `；${transcribed.failed} 条视频未能自动转写` : "";
    notify(`CSV 导入完成：${mediaResult.records.length} 个画面，${copyGroups.size} 组文案${warning}${asr}`);
  };

  const importViralCsv = async () => {
    const bridge = window.desktopBridge;
    if (!bridge?.viralLibraryImportCsv) return;
    try {
      const result = await bridge.viralLibraryImportCsv();
      if (result.cancelled) return;
      if (result.mappingRequired) {
        setViralCsvInspection(result);
        setViralCsvColumns(result.columns);
        setViralCsvConfirmed(false);
        setViralCsvMajorCategoryFallback("");
        setViralCsvImportError("");
        return;
      }
      await applyViralCsvImport(result);
    } catch (failure) {
      notify(desktopErrorMessage(failure, "CSV 导入失败"));
    }
  };

  const confirmViralCsvImport = async () => {
    const bridge = window.desktopBridge;
    if (!viralCsvInspection || !bridge?.viralLibraryImportCsv) return;
    if (viralCsvColumns.media < 0 && viralCsvColumns.copy < 0) {
      setViralCsvImportError("请至少选择一个“画面路径”或“文案”字段");
      return;
    }
    setViralCsvImportBusy(true);
    setViralCsvImportError("");
    try {
      const result = await bridge.viralLibraryImportCsv({ token: viralCsvInspection.token, columns: viralCsvColumns });
      if (result.cancelled || result.mappingRequired) throw new Error("CSV 字段映射未生效，请重新选择文件");
      await applyViralCsvImport(result, viralCsvConfirmed, viralCsvMajorCategoryFallback);
      setViralCsvInspection(null);
    } catch (failure) {
      setViralCsvImportError(desktopErrorMessage(failure, "CSV 导入失败"));
    } finally {
      setViralCsvImportBusy(false);
    }
  };

  const installFolderSources = (incomingFolders: LocalFolderSource[]) => {
    if (!incomingFolders.length) return;
    setFolders((current) => {
      const byPath = new Map(current.map((folder) => [folder.path, folder]));
      incomingFolders.forEach((folder) => byPath.set(folder.path, { ...byPath.get(folder.path), ...folder }));
      return [...byPath.values()];
    });
  };

  const sendAssetsToClassifier = async (paths: string[], label: string) => {
    if (classifierPreparing) return;
    if (!window.desktopBridge?.classifierPrepareInput) {
      notify("发送到素材工作台仅支持桌面版");
      return;
    }
    const usablePaths = [...new Set(paths.filter(Boolean))];
    if (!usablePaths.length) {
      notify("请选择可用的本地图片或视频");
      return;
    }
    setClassifierPreparing(true);
    setClassifierHandoff(null);
    notify("正在准备素材并打开分类工作台…");
    setActiveModule("classifier");
    try {
      const prepared = await window.desktopBridge.classifierPrepareInput(usablePaths);
      setClassifierHandoff({ id: crypto.randomUUID(), folder: prepared.folder, label, count: prepared.count, kind: "files", mediaCounts: prepared.mediaCounts, paths: usablePaths });
      setSelectedAssetIds([]);
      setAssetMenu(null);
      const copiedHint = prepared.methods.copied ? `；其中 ${prepared.methods.copied} 个文件已建立工作副本` : "";
      notify(`已发送 ${prepared.count} 个素材到素材工作台${copiedHint}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "发送到素材工作台失败");
    } finally {
      setClassifierPreparing(false);
    }
  };

  const sendFolderToClassifier = (folderSource: LocalFolderSource) => {
    if (folderSource.available === false) {
      notify("该文件夹已失联，无法发送到素材工作台");
      return;
    }
    const sourcePaths = folderTreePaths(folders, folderSource.path);
    const folderAssets = assets.filter((asset) => !asset.deleted && asset.sourceRoot && sourcePaths.has(asset.sourceRoot) && (asset.type === "image" || asset.type === "video"));
    const mediaCounts = folderAssets.reduce<ClassifierMediaCounts>((counts, asset) => {
      if (asset.type === "image" || asset.type === "video") counts[asset.type] += 1;
      return counts;
    }, { image: 0, video: 0 });
    setClassifierHandoff({ id: crypto.randomUUID(), folder: folderSource.path, label: folderSource.name, count: folderAssets.length, kind: "folder", mediaCounts, paths: [folderSource.path] });
    setSelectedAssetIds([]);
    setActiveModule("classifier");
    notify(`文件夹“${folderSource.name}”已发送到素材工作台`);
  };

  const syncClassifierOutput = async (outputPath: string, outputFiles: string[] = [], allowGeneratedFolderScan = false) => {
    const bridge = window.desktopBridge;
    if (!bridge?.mediaImportPaths) throw new Error("桌面媒体库接口不可用");
    const exactOutputFiles = [...new Set(outputFiles.map((item) => item.trim()).filter(Boolean))];
    if (exactOutputFiles.length) {
      if (bridge.mediaImportClassifierOutput) {
        const grouped = await bridge.mediaImportClassifierOutput(outputPath, exactOutputFiles);
        if (grouped.records.length && grouped.folders.length) {
          installFolderSources(grouped.folders);
          installDesktopAssets(grouped.records, "folder", "素材分类");
        }
        // The classifier-specific importer deliberately rejects analysis-only
        // artifacts under outputs/ (for example sheets/*/frames_sheet.jpg).
        // A zero-result response is authoritative: falling back to the generic
        // file importer here would add those frame snapshots to the library.
        return grouped.records.length;
      }
      const imported = await bridge.mediaImportPaths(exactOutputFiles);
      installDesktopAssets(imported.records, "file", "素材分类");
      return imported.records.length;
    }
    if (allowGeneratedFolderScan) {
      if (!bridge.mediaImportClassifierSegments) throw new Error("当前桌面版本不支持安全导入切割结果");
      const imported = await bridge.mediaImportClassifierSegments(outputPath);
      if (!imported.records.length || !imported.folders.length) throw new Error("本次切割结果目录中没有可导入的媒体文件");
      installFolderSources(imported.folders);
      installDesktopAssets(imported.records, "folder", "素材分类");
      return imported.records.length;
    }
    throw new Error("未读取到本次生成文件清单，已取消自动入库，不会连接或扫描总输出目录");
  };

  const scanConnectedDirectory = async (handle: FileSystemDirectoryHandleLike) => {
    setLocalStatus("scanning");
    setScanCount(0);
    try {
      const records = await scanLibraryDirectory(handle, (count) => setScanCount(count));
      installScannedAssets(records);
      setDirectoryName(handle.name);
      window.localStorage.setItem("media-library-directory-name", handle.name);
      setLocalStatus("connected");
      setCollection("全部素材");
      notify(`已建立本地索引，共 ${records.length} 个素材`);
    } catch {
      setLocalStatus("error");
      notify("文件夹扫描失败，请重新连接");
    }
  };

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setMounted(true);
      try {
        if (!window.desktopBridge?.mediaLoadLibrary) {
          const savedIndex = window.localStorage.getItem("media-library-index-v2");
          if (savedIndex) {
            const indexedAssets = JSON.parse(savedIndex) as Asset[];
            if (Array.isArray(indexedAssets) && indexedAssets.length) {
              setAssets(indexedAssets.map((asset) => ({ ...asset, collection: normalizeAssetCollection(asset.collection), src: "", available: false })));
            }
          }
        }
        const saved = window.localStorage.getItem("media-library-preferences-v1");
        if (saved) {
          const data = JSON.parse(saved);
          if (data.view === "grid" || data.view === "list") setView(data.view);
          if (data.sortBy && sortLabels[data.sortBy as SortBy]) setSortBy(data.sortBy);
          if (data.tagColors && typeof data.tagColors === "object") setTagColors(data.tagColors);
          setCollections(normalizeProjectCollections(data.collections));
          setCollectionAliases(normalizeCollectionAliases(data.collectionAliases));
          setHiddenCollections(normalizeHiddenCollections(data.hiddenCollections));
          if (Array.isArray(data.assetFlags)) {
            setAssets((current) => current.map((asset) => {
              const flags = data.assetFlags.find((item: { id: number }) => item.id === asset.id);
              return flags ? { ...asset, ...flags, collection: normalizeAssetCollection(flags.collection ?? asset.collection) } : asset;
            }));
          }
        }
        const savedModule = window.localStorage.getItem(activeApplicationModuleStorageKey);
        if (applicationModules.includes(savedModule) && canDiscoverFeature(featureRegistry, savedModule, licenseState)) {
          setActiveModule(savedModule as ApplicationModule);
        }
      } catch {
        window.localStorage.removeItem("media-library-preferences-v1");
      } finally {
        setPreferencesReady(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    const reconnect = async () => {
      if (window.desktopBridge?.mediaLoadLibrary) {
        try {
          const state = await window.desktopBridge.mediaLoadLibrary();
          if (cancelled) return;
          const restoredAssets = state.assets.map((asset) => ({
            ...asset,
            collection: normalizeAssetCollection(asset.collection),
            size: asset.size || (asset.sizeBytes ? formatFileSize(asset.sizeBytes) : ""),
          }));
          setAssets(restoredAssets);
          setFolders(state.folders ?? []);
          setDirectoryName(restoredAssets.length ? `${restoredAssets.length} 个本地素材` : "");
          setLocalStatus(restoredAssets.some((asset) => asset.available)
            ? "connected"
            : restoredAssets.length ? "error" : "idle");
        } catch {
          if (!cancelled) {
            setAssets([]);
            setLocalStatus("error");
          }
        } finally {
          if (!cancelled) desktopLibraryReady.current = true;
        }
        return;
      }
      if (!supportsLocalFolders()) {
        setLocalStatus("unsupported");
        return;
      }
      setDirectoryName(window.localStorage.getItem("media-library-directory-name") ?? "");
      try {
        const handle = await loadLibraryDirectory();
        if (!handle || cancelled) {
          setLocalStatus("idle");
          return;
        }
        directoryHandle.current = handle;
        setDirectoryName(handle.name);
        const permission = await getDirectoryPermission(handle);
        if (cancelled) return;
        if (permission === "granted") await scanConnectedDirectory(handle);
        else setLocalStatus("permission");
      } catch {
        if (!cancelled) setLocalStatus("idle");
      }
    };
    reconnect();
    return () => { cancelled = true; };
    // The reconnect check intentionally runs once after the client mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  useEffect(() => () => {
    const video = hoverPreviewVideo.current;
    hoverPreviewVideo.current = null;
    if (video) resetHoverPreviewVideo(video);
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => {
    if (!preferencesReady) return;
    window.localStorage.setItem(activeApplicationModuleStorageKey, activeModule);
  }, [activeModule, preferencesReady]);

  useEffect(() => {
    if (!preferencesReady) return;
    const localAssets = assets.filter((asset) => asset.sourceKind !== "demo").map((asset) => ({ ...asset, src: "", available: false }));
    if (window.desktopBridge?.mediaSaveLibrary) {
      if (!desktopLibraryReady.current) return;
      void window.desktopBridge.mediaSaveLibrary(localAssets, folders).catch(() => {
        setLocalStatus("error");
        notify("本地媒体库保存失败，请检查应用数据目录权限");
      });
      return;
    }
    if (localAssets.length || assets.every((asset) => asset.sourceKind !== "demo")) {
      window.localStorage.setItem("media-library-index-v2", JSON.stringify(localAssets));
    }
  }, [assets, folders, preferencesReady]);

  useEffect(() => {
    if (!preferencesReady) return;
    window.localStorage.setItem("media-library-preferences-v1", JSON.stringify({
      view,
      sortBy,
      tagColors,
      collections,
      collectionAliases,
      hiddenCollections,
      assetFlags: assets.filter((asset) => asset.id <= 15).map(({ id, favorite, deleted, broken, tags, collection: assetCollection }) => ({
        id, favorite, deleted, broken, tags, collection: assetCollection,
      })),
    }));
  }, [assets, collectionAliases, collections, hiddenCollections, preferencesReady, sortBy, tagColors, view]);

  useEffect(() => {
    if (assetMenu === null && folderMenuPath === null) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAssetMenu(null);
        setFolderMenuPath(null);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [assetMenu, folderMenuPath]);

  useEffect(() => {
    if (previewAssetId === null) return;
    const closePreview = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewAssetId(null);
    };
    document.addEventListener("keydown", closePreview);
    return () => document.removeEventListener("keydown", closePreview);
  }, [previewAssetId]);

  const uploadLocalFiles = async () => {
    if (window.desktopBridge?.mediaChooseFiles) {
      const records = await window.desktopBridge.mediaChooseFiles();
      if (records.length) installDesktopAssets(records, "file");
      return;
    }
    fileInput.current?.click();
  };

  const uploadLocalFolder = async () => {
    if (window.desktopBridge?.mediaChooseFolder) {
      const selection = await window.desktopBridge.mediaChooseFolder();
      if (!selection) return;
      installFolderSources([selection.folder]);
      installDesktopAssets(selection.records, "folder");
      setDirectoryName(selection.folder.name);
      setLocalStatus("connected");
      window.localStorage.setItem("media-library-directory-name", selection.folder.name);
      return;
    }
    if (!supportsLocalFolders()) {
      folderInput.current?.click();
      notify("请选择要导入的素材文件夹");
      return;
    }
    try {
      const handle = await chooseLibraryDirectory();
      directoryHandle.current = handle;
      if (handle) await scanConnectedDirectory(handle);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLocalStatus("error");
      notify("未能读取文件夹，请重试");
    }
  };

  const refreshLocalLibrary = async () => {
    setLocalStatus("scanning");
    setScanCount(assets.filter((asset) => asset.sourceKind !== "demo").length);
    try {
      if (window.desktopBridge?.mediaLoadLibrary && window.desktopBridge.mediaSaveLibrary) {
        const localAssets = assets.filter((asset) => asset.sourceKind !== "demo");
        await window.desktopBridge.mediaSaveLibrary(localAssets, folders);
        const state = await window.desktopBridge.mediaLoadLibrary();
        const restoredAssets = state.assets.map((asset) => ({
          ...asset,
          size: asset.size || (asset.sizeBytes ? formatFileSize(asset.sizeBytes) : ""),
        }));
        const availableCount = restoredAssets.filter((asset) => asset.available).length;
        const brokenCountAfterRefresh = restoredAssets.length - availableCount;
        setAssets(restoredAssets);
        setFolders(state.folders ?? []);
        setDirectoryName(restoredAssets.length ? `${restoredAssets.length} 个本地素材` : "");
        setLocalStatus(availableCount ? "connected" : restoredAssets.length ? "error" : "idle");
        notify(brokenCountAfterRefresh
          ? `刷新完成：${availableCount} 个可用，${brokenCountAfterRefresh} 个失联`
          : `刷新完成：${availableCount} 个素材可用`);
        return;
      }
      if (directoryHandle.current) {
        await scanConnectedDirectory(directoryHandle.current);
        return;
      }
      setLocalStatus(assets.some((asset) => asset.available) ? "connected" : "idle");
      notify("当前素材已是最新状态");
    } catch {
      setLocalStatus("error");
      notify("刷新失败，请稍后重试");
    }
  };

  const openFolderSource = async (folder: LocalFolderSource) => {
    if (!folder.available) {
      notify("该文件夹已失联，请点击“重新关联”选择移动后的新位置");
      return;
    }
    try {
      if (folder.indexMode !== "exact" && window.desktopBridge?.mediaScanFolder) {
        setLocalStatus("scanning");
        const records = await window.desktopBridge.mediaScanFolder(folder.path);
        installDesktopAssets(records, "folder");
      }
      setActiveFolderPath(folder.path);
      setDirectoryName(folder.name);
      if (!collections.includes(collection)) setCollection("全部素材");
      setLocalStatus("connected");
    } catch {
      setLocalStatus("error");
      notify("文件夹读取失败，请检查文件夹是否被移动或删除");
    }
  };

  const isProjectCollection = collections.includes(collection);
  const filteredAssets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const folderNavigationEnabled = (collection === "全部素材" || collection === "失联素材" || isProjectCollection) && !normalized && type === "all";
    const results = assets.filter((asset) => {
      const deletedMatch = collection === "回收站" ? asset.deleted : !asset.deleted;
      const typeMatch = type === "all" || asset.type === type;
      const collectionMatch =
        collection === "全部素材" ||
        (collection === "收藏" && asset.favorite) ||
        (collection === "失联素材" && asset.broken) ||
        collection === "回收站" ||
        asset.tags.includes(collection) ||
        asset.collection === collection;
      const searchMatch =
        !normalized ||
        `${asset.name} ${asset.description ?? ""} ${asset.tags.join(" ")}`.toLowerCase().includes(normalized);
      const folderMatch = activeFolderPath
        ? asset.sourceRoot === activeFolderPath
        : collection === "失联素材" && folderNavigationEnabled
          ? !asset.sourceRoot || !folders.some((folder) => folder.path === asset.sourceRoot)
        : folderNavigationEnabled
          ? !asset.sourceRoot
          : true;
      return deletedMatch && typeMatch && collectionMatch && searchMatch && folderMatch;
    });
    return [...results].sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name, "zh-CN");
      if (sortBy === "size") return Number.parseFloat(b.size) - Number.parseFloat(a.size);
      return b.id - a.id;
    });
  }, [activeFolderPath, assets, collection, folders, isProjectCollection, query, sortBy, type]);

  const assetPageCount = Math.max(1, Math.ceil(filteredAssets.length / MEDIA_ASSET_PAGE_SIZE));
  const assetPageKey = `${activeFolderPath ?? ""}\u0000${collection}\u0000${query}\u0000${sortBy}\u0000${type}`;
  const assetPage = assetPagination.key === assetPageKey ? Math.min(assetPagination.page, assetPageCount) : 1;
  const pagedAssets = useMemo(
    () => filteredAssets.slice((assetPage - 1) * MEDIA_ASSET_PAGE_SIZE, assetPage * MEDIA_ASSET_PAGE_SIZE),
    [assetPage, filteredAssets],
  );

  const visibleFolders = useMemo(() => {
    if ((collection !== "全部素材" && collection !== "失联素材" && !isProjectCollection) || type !== "all" || query.trim()) return [];
    return folders.filter((folder) => {
      if (collection === "失联素材") {
        if (folder.available !== false) return false;
        if (activeFolderPath) return folder.parentPath === activeFolderPath;
        const parent = folder.parentPath ? folders.find((candidate) => candidate.path === folder.parentPath) : null;
        return !parent || parent.available !== false;
      }
      if ((folder.parentPath ?? null) !== (activeFolderPath ?? null)) return false;
      if (!isProjectCollection) return true;
      const sourcePaths = folderTreePaths(folders, folder.path);
      return assets.some((asset) => !asset.deleted && asset.collection === collection && asset.sourceRoot && sourcePaths.has(asset.sourceRoot));
    });
  }, [activeFolderPath, assets, collection, folders, isProjectCollection, query, type]);
  const activeFolder = activeFolderPath ? folders.find((folder) => folder.path === activeFolderPath) ?? null : null;
  const folderDeleteStats = useMemo(() => {
    if (!folderDeleteTarget) return { total: 0, image: 0, video: 0, audio: 0, folders: 0 };
    const sourcePaths = folderTreePaths(folders, folderDeleteTarget.path);
    const folderAssets = assets.filter((asset) => asset.sourceRoot && sourcePaths.has(asset.sourceRoot));
    return {
      total: folderAssets.length,
      image: folderAssets.filter((asset) => asset.type === "image").length,
      video: folderAssets.filter((asset) => asset.type === "video").length,
      audio: folderAssets.filter((asset) => asset.type === "audio").length,
      folders: sourcePaths.size,
    };
  }, [assets, folderDeleteTarget, folders]);

  const activeAssets = assets.filter((asset) => !asset.deleted);
  const rangeSelectableAssetIds = useMemo(() => filteredAssets
    .filter((asset) => Boolean(asset.localPath && asset.available && !asset.broken))
    .map((asset) => asset.id), [filteredAssets]);
  const visibleFolderAssetIds = useMemo(() => visibleFolders.flatMap((folder) => {
    const sourcePaths = folderTreePaths(folders, folder.path);
    return assets
      .filter((asset) => !asset.deleted && asset.available && !asset.broken && (!isProjectCollection || asset.collection === collection) && asset.sourceRoot && sourcePaths.has(asset.sourceRoot) && asset.localPath)
      .map((asset) => asset.id);
  }), [assets, collection, folders, isProjectCollection, visibleFolders]);
  const selectableAssetIds = useMemo(() => [...new Set([...visibleFolderAssetIds, ...rangeSelectableAssetIds])], [rangeSelectableAssetIds, visibleFolderAssetIds]);
  const allVisibleSelected = selectableAssetIds.length > 0 && selectableAssetIds.every((id) => selectedAssetIds.includes(id));
  const selectedDragPaths = selectedAssetIds
    .map((id) => assets.find((asset) => asset.id === id))
    .filter((asset): asset is Asset => Boolean(asset?.localPath && asset.available && !asset.broken && !asset.deleted))
    .map((asset) => asset.localPath as string);
  const selectedClassifierPaths = selectedAssetIds
    .map((id) => assets.find((asset) => asset.id === id))
    .filter((asset): asset is Asset => Boolean((asset?.type === "image" || asset?.type === "video") && asset.localPath && asset.available && !asset.broken && !asset.deleted))
    .map((asset) => asset.localPath as string);
  const brokenCount = activeAssets.filter((asset) => asset.broken).length;

  const clearAssetSelection = () => {
    setSelectedAssetIds([]);
    selectionAnchorId.current = null;
  };

  const selectAssetFromPointer = (event: ReactMouseEvent<HTMLElement>, id: number, allowPlainToggle = false) => {
    const additive = event.metaKey || event.ctrlKey;
    if (event.shiftKey) {
      const anchor = selectionAnchorId.current;
      const anchorIndex = anchor === null ? -1 : rangeSelectableAssetIds.indexOf(anchor);
      const targetIndex = rangeSelectableAssetIds.indexOf(id);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const range = rangeSelectableAssetIds.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1);
        setSelectedAssetIds((current) => additive ? [...new Set([...current, ...range])] : range);
        return;
      }
    }
    if (additive || allowPlainToggle) {
      setSelectedAssetIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
      selectionAnchorId.current = id;
    }
  };

  const selectAssetCardFromPointer = (event: ReactMouseEvent<HTMLElement>, asset: Asset) => {
    setSelectedId(asset.id);
    if (!asset.localPath || asset.available === false || asset.broken) {
      if (event.metaKey || event.ctrlKey || event.shiftKey) notify("该素材没有可用的本地文件，不能加入多选");
      return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      selectAssetFromPointer(event, asset.id, event.metaKey || event.ctrlKey);
      return;
    }
    setSelectedAssetIds([asset.id]);
    selectionAnchorId.current = asset.id;
  };

  const beginAssetMarquee = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest(".asset-card, .asset-meta, .asset-pagination, .empty-state, .multi-select-bar, button, input, select, textarea, a")) return;
    const sectionRect = event.currentTarget.getBoundingClientRect();
    const verticalScrollbarWidth = event.currentTarget.offsetWidth - event.currentTarget.clientWidth;
    const horizontalScrollbarHeight = event.currentTarget.offsetHeight - event.currentTarget.clientHeight;
    if ((verticalScrollbarWidth > 0 && event.clientX >= sectionRect.right - verticalScrollbarWidth)
      || (horizontalScrollbarHeight > 0 && event.clientY >= sectionRect.bottom - horizontalScrollbarHeight)) return;
    event.preventDefault();
    stopActiveHoverPreview();
    assetMarquee.current = {
      startX: event.clientX,
      startY: event.clientY,
      baseIds: [...selectedAssetIds],
      selectableIds: new Set(selectableAssetIds),
    };
    setSelectedId(null);
    selectionAnchorId.current = null;
    setAssetMarqueeRect({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
  };

  const assetMarqueeActive = assetMarqueeRect !== null;

  useEffect(() => {
    if (!assetMarqueeActive) return;
    document.body.classList.add("media-marquee-active");
    const move = (event: MouseEvent) => {
      const active = assetMarquee.current;
      const grid = assetGridRef.current;
      if (!active || !grid) return;
      const left = Math.min(active.startX, event.clientX);
      const top = Math.min(active.startY, event.clientY);
      const right = Math.max(active.startX, event.clientX);
      const bottom = Math.max(active.startY, event.clientY);
      const hitIds = Array.from(grid.querySelectorAll<HTMLElement>("[data-asset-id]")).flatMap((card) => {
        const id = Number(card.dataset.assetId);
        if (!Number.isFinite(id) || !active.selectableIds.has(id)) return [];
        const rect = card.getBoundingClientRect();
        return rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom ? [id] : [];
      });
      setAssetMarqueeRect({ left, top, width: right - left, height: bottom - top });
      setSelectedAssetIds(toggleMarqueeSelection(active.baseIds, hitIds));
      if (hitIds.length) selectionAnchorId.current = hitIds[0];
    };
    const finish = () => {
      assetMarquee.current = null;
      setAssetMarqueeRect(null);
      document.body.classList.remove("media-marquee-active");
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", finish, { once: true });
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", finish);
      document.body.classList.remove("media-marquee-active");
    };
  }, [assetMarqueeActive]);

  const toggleFolderSelection = (ids: number[]) => {
    if (!ids.length) return;
    setSelectedAssetIds((current) => {
      const allSelected = ids.every((id) => current.includes(id));
      return allSelected ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])];
    });
    selectionAnchorId.current = null;
  };

  const toggleSelectAllVisible = () => {
    setSelectedAssetIds((current) => allVisibleSelected
      ? current.filter((id) => !selectableAssetIds.includes(id))
      : [...new Set([...current, ...selectableAssetIds])]);
    selectionAnchorId.current = allVisibleSelected ? null : rangeSelectableAssetIds[0] ?? null;
  };

  const addTagToSelection = (tagName: string) => {
    if (!tagName || !selectedAssetIds.length) return;
    const selected = new Set(selectedAssetIds);
    setAssets((current) => current.map((asset) => selected.has(asset.id) && !asset.tags.includes(tagName) ? { ...asset, tags: [...asset.tags, tagName] } : asset));
    notify(`已为 ${selectedAssetIds.length} 个素材添加标签“${tagName}”`);
  };

  const moveSelectionToCollection = (targetCollection: string) => {
    if (!targetCollection || !selectedAssetIds.length) return;
    const selected = new Set(selectedAssetIds);
    setAssets((current) => current.map((asset) => selected.has(asset.id) ? { ...asset, collection: targetCollection } : asset));
    notify(`已将 ${selectedAssetIds.length} 个素材加入“${targetCollection}”`);
  };

  const deleteSelection = () => {
    if (!selectedAssetIds.length) return;
    const count = selectedAssetIds.length;
    const selected = new Set(selectedAssetIds);
    setAssets((current) => current.map((asset) => selected.has(asset.id) ? { ...asset, deleted: true } : asset));
    clearAssetSelection();
    setSelectedId(null);
    notify(`已将 ${count} 个素材移入回收站`);
  };

  useEffect(() => {
    if (activeModule !== "media") return;
    const handleSelectionShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      const editing = target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);
      if (editing) return;
      if (event.key === "Escape") {
        clearAssetSelection();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedAssetIds((current) => [...new Set([...current, ...selectableAssetIds])]);
        selectionAnchorId.current = rangeSelectableAssetIds[0] ?? null;
      }
    };
    document.addEventListener("keydown", handleSelectionShortcut);
    return () => document.removeEventListener("keydown", handleSelectionShortcut);
  }, [activeModule, selectableAssetIds, rangeSelectableAssetIds]);

  const importBrowserFiles = (files: File[]) => {
    if (!files.length) return;
    const importedFolderName = files.find((file) => file.webkitRelativePath)?.webkitRelativePath.split("/")[0] ?? "";
    const uniqueFiles = files.filter((file) => !assets.some((asset) => asset.name === file.name.replace(/\.[^.]+$/, "") && asset.size === `${(file.size / 1024 / 1024).toFixed(1)} MB`));
    const newAssets: Asset[] = uniqueFiles.map((file, index) => {
      const src = URL.createObjectURL(file);
      objectUrls.current.push(src);
      const detectedType: AssetType = file.type.startsWith("video")
        ? "video"
        : file.type.startsWith("audio")
          ? "audio"
          : "image";
      return {
        id: Date.now() + index,
        name: file.name.replace(/\.[^.]+$/, ""),
        type: detectedType,
        size: `${(file.size / 1024 / 1024).toFixed(1)} MB`,
        duration: detectedType === "image" ? undefined : "--:--",
        src,
        tags: ["待处理"],
        description: "刚刚从本机导入，等待补充描述",
        sourceKind: "file",
        localPath: file.webkitRelativePath || file.name,
        modifiedAt: file.lastModified,
        available: true,
      };
    });
    setAssets((current) => [...newAssets, ...current.filter((asset) => asset.sourceKind !== "demo")]);
    if (importedFolderName) {
      setDirectoryName(importedFolderName);
      setLocalStatus("connected");
      window.localStorage.setItem("media-library-directory-name", importedFolderName);
    }
    setCollection("全部素材");
    notify(uniqueFiles.length === files.length ? `已导入 ${newAssets.length} 个素材` : `已导入 ${newAssets.length} 个素材，跳过 ${files.length - uniqueFiles.length} 个重复文件`);
  };

  const onImport = (event: ChangeEvent<HTMLInputElement>) => {
    importBrowserFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const handleMediaDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    mediaDragDepth.current += 1;
    setMediaDragActive(true);
  };

  const handleMediaDragOver = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleMediaDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    mediaDragDepth.current = Math.max(0, mediaDragDepth.current - 1);
    if (mediaDragDepth.current === 0) setMediaDragActive(false);
  };

  const handleMediaDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    mediaDragDepth.current = 0;
    setMediaDragActive(false);
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) {
      notify("没有检测到可导入的文件或文件夹");
      return;
    }
    try {
      if (window.desktopBridge?.mediaPathForFile && window.desktopBridge.mediaImportPaths) {
        const paths = files.map((file) => window.desktopBridge?.mediaPathForFile(file) ?? "").filter(Boolean);
        const imported = await window.desktopBridge.mediaImportPaths(paths);
        installFolderSources(imported.folders);
        installDesktopAssets(imported.records, imported.sourceKind);
        if (imported.folders.length) {
          setDirectoryName(imported.folders.length === 1 ? imported.folders[0].name : `${imported.folders.length} 个本地文件夹`);
          setLocalStatus("connected");
        }
        return;
      }
      importBrowserFiles(files);
    } catch {
      setLocalStatus("error");
      notify("拖入失败，请重新拖入或使用右上角上传按钮");
    }
  };

  const startNativeMediaDrag = (event: DragEvent<HTMLElement>, paths: string[]) => {
    event.preventDefault();
    event.stopPropagation();
    const usablePaths = [...new Set(paths.filter(Boolean))];
    if (!usablePaths.length) {
      notify("该素材没有可用的本地文件，无法拖到剪映");
      return;
    }
    if (!window.desktopBridge?.mediaStartDrag) {
      notify("拖到剪映功能仅在桌面版中可用");
      return;
    }
    setAssetMenu(null);
    event.dataTransfer.effectAllowed = "copy";
    window.desktopBridge.mediaStartDrag(usablePaths);
  };

  const toggleFavorite = (id: number) => {
    setAssets((current) =>
      current.map((asset) => (asset.id === id ? { ...asset, favorite: !asset.favorite } : asset)),
    );
  };

  const openAssetPreview = (asset: Asset) => {
    stopActiveHoverPreview();
    setSelectedId(asset.id);
    if (!asset.src || asset.broken || asset.available === false) {
      notify("该素材暂时无法预览，请重新上传或授权素材文件夹");
      return;
    }
    setPreviewAssetId(asset.id);
  };

  const revealAssetInFolder = async (asset: Asset) => {
    setAssetMenu(null);
    if (!asset.localPath || asset.available === false || asset.broken) {
      notify("该素材没有可用的本地文件路径");
      return;
    }
    const bridge = window.desktopBridge;
    if (!bridge?.mediaRevealFile) {
      notify("在访达或文件夹中打开仅支持桌面版");
      return;
    }
    try {
      await bridge.mediaRevealFile(asset.localPath);
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法在访达或文件夹中定位该素材");
    }
  };

  const openOriginalFolder = async (folderSource: LocalFolderSource) => {
    setFolderMenuPath(null);
    if (folderSource.available === false) {
      notify("该文件夹已失联，无法打开原文件夹位置");
      return;
    }
    const bridge = window.desktopBridge;
    if (!bridge?.openLocalPath) {
      notify("查看原文件夹位置仅支持桌面版");
      return;
    }
    try {
      const result = await bridge.openLocalPath(folderSource.path);
      if (result?.error) throw new Error(result.error);
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法打开原文件夹位置");
    }
  };

  const beginFolderRelink = async (folderSource: LocalFolderSource) => {
    setFolderMenuPath(null);
    const bridge = window.desktopBridge;
    if (!bridge?.mediaRelinkFolder) {
      notify("重新关联文件夹仅支持桌面版");
      return;
    }
    setFolderRelinkBusyPath(folderSource.path);
    try {
      const plan = await bridge.mediaRelinkFolder(
        folderSource.path,
        folders,
        assets.filter((asset) => asset.sourceKind !== "demo"),
      );
      if (plan) setFolderRelinkPlan(plan);
    } catch (error) {
      notify(error instanceof Error ? error.message : "文件夹重新关联失败");
    } finally {
      setFolderRelinkBusyPath(null);
    }
  };

  const confirmFolderRelink = () => {
    if (!folderRelinkPlan) return;
    const plan = folderRelinkPlan;
    const oldFolderPaths = new Set(plan.pathMappings.map((mapping) => mapping.from));
    const inheritedCollection = assets.find((asset) => asset.sourceRoot && oldFolderPaths.has(asset.sourceRoot))?.collection;
    const restoredAssets = plan.assets.map((asset) => ({
      ...asset,
      size: asset.sizeBytes ? formatFileSize(asset.sizeBytes) : asset.size,
    }));
    const addedAssets = plan.newRecords.map((record) => ({
      id: stableLocalId(`${record.path}:${record.sizeBytes}:${record.modifiedAt}`),
      name: record.name.replace(/\.[^.]+$/, ""),
      type: record.type,
      size: formatFileSize(record.sizeBytes),
      src: record.url,
      duration: record.type === "image" ? undefined : "--:--",
      tags: ["待处理"],
      collection: inheritedCollection,
      description: `本地素材 · ${record.path}`,
      broken: false,
      sourceKind: "folder" as const,
      sourceRoot: record.sourceRoot || plan.newRoot,
      localPath: record.path,
      modifiedAt: record.modifiedAt,
      available: true,
    } satisfies Asset));

    setFolders(plan.folders);
    setAssets([...addedAssets, ...restoredAssets, ...assets.filter((asset) => asset.sourceKind === "demo")]);
    setActiveFolderPath((current) => current
      ? plan.pathMappings.find((mapping) => mapping.from === current)?.to ?? current
      : current);
    setDirectoryName(plan.folders.find((folder) => folder.path === plan.newRoot)?.name || "已重新关联文件夹");
    setLocalStatus("connected");
    setFolderRelinkPlan(null);
    notify(`已重新关联 ${plan.stats.folders} 个文件夹、${plan.stats.reconnectedAssets} 个素材`);
  };

  const moveFolderToCollection = (folderSource: LocalFolderSource, targetCollection: string) => {
    if (!targetCollection) return;
    const sourcePaths = folderTreePaths(folders, folderSource.path);
    const folderAssetIds = new Set(assets
      .filter((asset) => !asset.deleted && asset.sourceRoot && sourcePaths.has(asset.sourceRoot))
      .map((asset) => asset.id));
    setFolderMenuPath(null);
    if (!folderAssetIds.size) {
      notify("该文件夹中没有可归入项目的素材");
      return;
    }
    setAssets((current) => current.map((asset) => folderAssetIds.has(asset.id) ? { ...asset, collection: targetCollection } : asset));
    notify(`已将文件夹“${folderSource.name}”中的 ${folderAssetIds.size} 个素材加入“${targetCollection}”`);
  };

  const openFolderDeleteDialog = (folderSource: LocalFolderSource) => {
    setFolderMenuPath(null);
    setFolderDeleteTarget(folderSource);
    setFolderDeleteMode("remove-folder");
    setFolderDeleteError("");
  };

  const removeFolderRecords = (folderSource: LocalFolderSource, mode: FolderDeleteMode) => {
    const sourcePaths = folderTreePaths(folders, folderSource.path);
    const removedAssetIds = new Set(assets
      .filter((asset) => asset.sourceRoot && sourcePaths.has(asset.sourceRoot))
      .map((asset) => asset.id));

    setAssets((current) => current.filter((asset) => !asset.sourceRoot || !sourcePaths.has(asset.sourceRoot)));
    setSelectedAssetIds((current) => current.filter((id) => !removedAssetIds.has(id)));
    setSelectedId((current) => current !== null && removedAssetIds.has(current) ? null : current);
    setPreviewAssetId((current) => current !== null && removedAssetIds.has(current) ? null : current);

    if (mode !== "clear-assets") {
      setFolders((current) => current.filter((folder) => !sourcePaths.has(folder.path)));
      if (activeFolderPath && sourcePaths.has(activeFolderPath)) {
        const parentFolder = folderSource.parentPath
          ? folders.find((folder) => folder.path === folderSource.parentPath)
          : null;
        setActiveFolderPath(folderSource.parentPath ?? null);
        setDirectoryName(parentFolder?.name ?? "");
      }
    }
    return removedAssetIds.size;
  };

  const confirmFolderDeletion = async () => {
    if (!folderDeleteTarget || folderDeleteBusy) return;
    const target = folderDeleteTarget;
    setFolderDeleteBusy(true);
    setFolderDeleteError("");
    try {
      if (folderDeleteMode === "delete-local") {
        const bridge = window.desktopBridge;
        if (!bridge?.mediaTrashFolder) throw new Error("删除本地文件夹仅支持桌面版");
        await bridge.mediaTrashFolder(target.path);
      }
      const removedCount = removeFolderRecords(target, folderDeleteMode);
      setFolderDeleteTarget(null);
      if (folderDeleteMode === "delete-local") {
        notify(`文件夹“${target.name}”已移入系统废纸篓，并从媒体库移除`);
      } else if (folderDeleteMode === "remove-folder") {
        notify(`已从媒体库移除文件夹“${target.name}”，本地文件夹已保留`);
      } else {
        notify(`已清空文件夹“${target.name}”内的 ${removedCount} 个素材，本地文件已保留`);
      }
    } catch (error) {
      setFolderDeleteError(error instanceof Error ? error.message : "文件夹删除失败，请稍后重试");
    } finally {
      setFolderDeleteBusy(false);
    }
  };

  const softDelete = (id: number) => {
    setAssets((current) => current.map((asset) => asset.id === id ? { ...asset, deleted: true } : asset));
    setAssetMenu(null);
    setSelectedId(null);
    notify("素材已移入回收站");
  };

  const restoreAsset = (id: number) => {
    setAssets((current) => current.map((asset) => asset.id === id ? { ...asset, deleted: false } : asset));
    setAssetMenu(null);
    notify("素材已恢复");
  };

  const openAssetMenu = (id: number, target: HTMLButtonElement) => {
    if (assetMenu === id) {
      setAssetMenu(null);
      return;
    }
    const rect = target.getBoundingClientRect();
    const menuWidth = 236;
    const menuAsset = assets.find((asset) => asset.id === id);
    const estimatedHeight = menuAsset?.type === "video" ? 390 : menuAsset?.broken ? 318 : 276;
    const canOpenRight = rect.right + 8 + menuWidth <= window.innerWidth - 12;
    const left = canOpenRight ? rect.right + 8 : Math.max(12, rect.left - menuWidth - 8);
    const top = Math.max(12, Math.min(window.innerHeight - estimatedHeight - 12, rect.top - 10));
    setSelectedId(id);
    setFolderMenuPath(null);
    setAssetMenuPosition({ top, left });
    setAssetMenu(id);
  };

  const openAssetContextMenu = (event: ReactMouseEvent<HTMLElement>, id: number) => {
    event.preventDefault();
    const menuWidth = 236;
    const estimatedHeight = assets.find((asset) => asset.id === id)?.type === "video" ? 390 : 318;
    const left = Math.max(12, Math.min(window.innerWidth - menuWidth - 12, event.clientX));
    const top = Math.max(12, Math.min(window.innerHeight - estimatedHeight - 12, event.clientY));
    setSelectedId(id);
    setFolderMenuPath(null);
    setAssetMenuPosition({ top, left });
    setAssetMenu(id);
  };

  const openFolderMenu = (folderPath: string, target: HTMLButtonElement) => {
    if (folderMenuPath === folderPath) {
      setFolderMenuPath(null);
      return;
    }
    const rect = target.getBoundingClientRect();
    const menuWidth = 236;
    const estimatedHeight = folders.find((folder) => folder.path === folderPath)?.available === false ? 328 : 280;
    const canOpenRight = rect.right + 8 + menuWidth <= window.innerWidth - 12;
    const left = canOpenRight ? rect.right + 8 : Math.max(12, rect.left - menuWidth - 8);
    const top = Math.max(12, Math.min(window.innerHeight - estimatedHeight - 12, rect.top - 10));
    setAssetMenu(null);
    setFolderMenuPosition({ top, left });
    setFolderMenuPath(folderPath);
  };

  const beginRepairAsset = (id: number) => {
    setRepairTargetId(id);
    setAssetMenu(null);
    window.setTimeout(() => repairInput.current?.click(), 0);
  };

  const repairAsset = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || repairTargetId === null) return;
    const src = URL.createObjectURL(file);
    objectUrls.current.push(src);
    setAssets((current) => current.map((asset) => asset.id === repairTargetId ? {
      ...asset,
      src,
      size: formatFileSize(file.size),
      broken: false,
      available: true,
      sourceKind: "file",
      localPath: file.name,
      modifiedAt: file.lastModified,
    } : asset));
    setRepairTargetId(null);
    event.target.value = "";
    notify(`已重新关联“${file.name}”`);
  };

  const addSelectedTag = (id: number, tagName: string) => {
    const target = assets.find((asset) => asset.id === id);
    if (target?.tags.includes(tagName)) {
      setAssetMenu(null);
      notify(`“${tagName}”标签已存在`);
      return;
    }
    setAssets((current) => current.map((asset) => asset.id === id && !asset.tags.includes(tagName) ? { ...asset, tags: [...asset.tags, tagName] } : asset));
    setAssetMenu(null);
    notify(`已添加标签“${tagName}”`);
  };

  const moveSelectedAsset = (id: number, targetCollection: string) => {
    const target = assets.find((asset) => asset.id === id);
    if (target?.collection === targetCollection) {
      setAssetMenu(null);
      notify(`素材已在“${targetCollection}”中`);
      return;
    }
    setAssets((current) => current.map((asset) => asset.id === id ? { ...asset, collection: targetCollection } : asset));
    setAssetMenu(null);
    notify(`已移动到“${targetCollection}”`);
  };

  const collectionLabelFor = (item: string) => collectionAliases[item]?.trim() || item;

  const beginCollectionRename = (item: string) => {
    setCollectionRenameTarget(item);
    setCollectionRenameValue(collectionLabelFor(item));
  };

  const saveCollectionRename = () => {
    if (!collectionRenameTarget) return;
    const value = collectionRenameValue.trim();
    if (!value) {
      setCollectionRenameTarget(null);
      setCollectionRenameValue("");
      return;
    }
    if (["全部素材", "收藏", "失联素材", "回收站"].includes(value)
      || collections.some((item) => item !== collectionRenameTarget && collectionLabelFor(item) === value)) {
      notify("该项目名称已存在");
      window.setTimeout(() => { collectionRenameInputRef.current?.focus(); collectionRenameInputRef.current?.select(); }, 0);
      return;
    }
    setCollectionAliases((current) => {
      const next = { ...current };
      if (value === collectionRenameTarget) delete next[collectionRenameTarget];
      else next[collectionRenameTarget] = value.slice(0, 100);
      return next;
    });
    setCollectionRenameTarget(null);
    setCollectionRenameValue("");
    notify(`项目已重命名为“${value}”`);
  };

  const confirmCollectionDelete = () => {
    if (!collectionDeleteTarget) return;
    const target = collectionDeleteTarget;
    setHiddenCollections((current) => [...new Set([...current, target])]);
    if (collection === target) {
      setCollection("全部素材");
      setActiveFolderPath(null);
    }
    setCollectionDeleteTarget(null);
    notify(`已删除项目“${collectionLabelFor(target)}”，素材仍保留在全部素材中`);
  };

  const submitInputDialog = () => {
    const value = dialogValue.trim();
    if (!value) return;
    if (inputDialog === "tag") {
      if (tagColors[value]) {
        notify("该标签已存在");
      } else {
        const palette = ["#f6cf55", "#69d19b", "#ff7979", "#bb7cf6", "#70d4e8", "#76a8ff"];
        setTagColors((current) => ({ ...current, [value]: palette[Object.keys(current).length % palette.length] }));
        notify(`已创建标签“${value}”`);
      }
    }
    if (inputDialog === "collection") {
      const hiddenMatch = hiddenCollections.find((item) => item === value || collectionLabelFor(item) === value);
      if (hiddenMatch) {
        setHiddenCollections((current) => current.filter((item) => item !== hiddenMatch));
        notify(`已恢复项目“${collectionLabelFor(hiddenMatch)}”`);
      } else if (collections.some((item) => item === value || collectionLabelFor(item) === value)) {
        notify("该集合已存在");
      } else {
        setCollections((current) => [...current, value]);
        notify(`已创建集合“${value}”`);
      }
    }
    setDialogValue("");
    setInputDialog(null);
  };

  const backupDatabase = () => {
    const payload = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      assets: assets.map(({ src, ...asset }) => ({ ...asset, sourcePreview: src.startsWith("blob:") ? null : src })),
      folders,
      tagColors,
      collections,
      collectionAliases,
      hiddenCollections,
      settings: { view, sortBy },
    }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `media-library-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    notify("数据库备份已导出");
  };

  const restoreDatabase = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.version !== 1 || !Array.isArray(data.assets)) throw new Error("invalid backup");
      const restored: Asset[] = data.assets.map((asset: Asset & { sourcePreview?: string }) => ({
        ...asset,
        collection: normalizeAssetCollection(asset.collection),
        src: asset.sourcePreview || seedAssets.find((item) => item.id === asset.id)?.src || seedAssets[0].src,
      }));
      setAssets(restored);
      if (Array.isArray(data.folders)) setFolders(data.folders);
      if (data.tagColors) setTagColors(data.tagColors);
      setCollections(normalizeProjectCollections(data.collections));
      setCollectionAliases(normalizeCollectionAliases(data.collectionAliases));
      setHiddenCollections(normalizeHiddenCollections(data.hiddenCollections));
      if (data.settings) {
        if (data.settings.view === "grid" || data.settings.view === "list") setView(data.settings.view);
        if (data.settings.sortBy && sortLabels[data.settings.sortBy as SortBy]) setSortBy(data.settings.sortBy);
      }
      notify(`已还原 ${restored.length} 条素材记录`);
    } catch {
      notify("备份文件无效，未修改当前数据");
    }
    event.target.value = "";
  };

  const activeMenuAsset = assetMenu === null ? null : assets.find((asset) => asset.id === assetMenu) ?? null;
  const activeMenuFolder = folderMenuPath === null ? null : folders.find((folder) => folder.path === folderMenuPath) ?? null;
  const previewAsset = previewAssetId === null ? null : assets.find((asset) => asset.id === previewAssetId) ?? null;
  const qianchuanDialogAsset = qianchuanDialog ? assets.find((asset) => asset.id === qianchuanDialog.assetId) ?? null : null;

  const vipAvailable = resolveEntitlements(licenseState).vip;
  const visibleCollections = collections.filter((item) => !hiddenCollections.includes(item) && (vipAvailable || item !== VIRAL_FRAME_COLLECTION));
  useEffect(() => {
    if (requestedModule !== activeModule) setActiveModule("media");
    if (vipAvailable) return;
    if (collection === VIRAL_FRAME_COLLECTION) setCollection("全部素材");
    setViralUploadSelection(null);
    setViralDataCsvInspection(null);
    setViralCsvInspection(null);
    setViralSearchQuery("");
  }, [requestedModule, activeModule, vipAvailable, collection]);

  const aliyunLibrarySnapshot = useRef({ assets, folders });
  aliyunLibrarySnapshot.current = { assets, folders };
  const importAliyunResult = async (outputPath: string) => {
    const imported = await window.desktopBridge?.mediaImportPaths([outputPath]);
    if (!imported?.records.length) throw new Error("成片文件不存在或无法导入");
    // Mark the task only after its media index entry is saved successfully.
    const snapshot = aliyunLibrarySnapshot.current;
    const existing = snapshot.assets.filter((asset) => asset.sourceKind !== "demo");
    const importedPaths = new Set(imported.records.map((record) => record.path));
    const incoming = imported.records.map((record) => desktopRecordAsset(record, imported.sourceKind, "阿里云去字幕", existing.find((asset) => asset.localPath === record.path)));
    const savedAssets = [...incoming, ...existing.filter((asset) => !asset.localPath || !importedPaths.has(asset.localPath))];
    await window.desktopBridge!.mediaSaveLibrary(savedAssets, snapshot.folders);
    aliyunLibrarySnapshot.current = { assets: savedAssets, folders: snapshot.folders };
    installFolderSources(imported.folders);
    setAssets((current) => {
      const latest = current.filter((asset) => asset.sourceKind !== "demo");
      const additions = imported.records.map((record) => desktopRecordAsset(record, imported.sourceKind, "阿里云去字幕", latest.find((asset) => asset.localPath === record.path)));
      return [...additions, ...latest.filter((asset) => !asset.localPath || !importedPaths.has(asset.localPath))];
    });
    setLocalStatus("connected");
  };

  if (!mounted) {
    return (
      <main className="app-shell boot-shell">
        <div className="boot-loader"><Images size={24} /><span>正在打开媒体库</span></div>
      </main>
    );
  }

  return (
    <main className={`app-shell ${activeModule === "media" || activeModule === "qianchuan-videos" || activeModule === "viral-visuals" || activeModule === "viral-copy" ? "library-light" : activeModule === "downloads" || activeModule === "subtitle-removal" ? "download-light" : activeModule === "voice" ? "voice-light" : "classifier-light"}`}>
      <OfflineLicenseBanner state={licenseState} />
      <AliyunSubtitleAutoSync ready={() => preferencesReady && desktopLibraryReady.current && localStatus !== "error" && canAccessFeature(featureRegistry, "subtitle-removal", licenseState)} onImport={importAliyunResult} notify={notify} />
      <div className="workspace">
        <aside className="main-sidebar compact-sidebar">
          <div className="sidebar-window-drag-region" aria-hidden="true" />
          <div className="sidebar-scroll">
            <p className="nav-label">核心功能</p>
            {featureRegistry.list().filter((feature) => canDiscoverFeature(featureRegistry, feature.id, licenseState)).map((feature) => {
              const Icon = featureMenuIcons[feature.id] || Images;
              const accessible = canAccessFeature(featureRegistry, feature.id, licenseState);
              const iconHelp = feature.id === "viral-visuals"
                ? "爆款画面库：管理图片、视频及关联数据"
                : feature.id === "viral-copy"
                  ? "爆款文案库：管理文案、分类及画面关联"
                  : "";
              return <button key={feature.id} className={`nav-item ${feature.group === "vip" ? "viral-nav" : ""} ${!accessible ? "locked" : ""} ${activeModule === feature.id ? "active" : ""}`} onClick={() => setActiveModule(feature.id)}>
                <span className={`nav-item-icon ${iconHelp ? "has-help" : ""}`} data-tooltip={iconHelp || undefined} title={iconHelp || undefined} aria-label={iconHelp || undefined}><Icon size={18} /></span><span>{feature.label}</span>{feature.group === "vip" && <small>{!accessible && <LockKeyhole size={9} />}VIP</small>}
              </button>;
            })}
          </div>
        </aside>

        {lockedVipFeature ? (
          <VipFeatureLockedPage feature={lockedVipFeature} onRedeem={() => setActiveModule("settings")} onBack={() => setActiveModule("media")} />
        ) : activeModule === "media" ? (
        <section
          className={`library-page ${mediaDragActive ? "media-drag-active" : ""}`}
          onDragEnter={handleMediaDragEnter}
          onDragOver={handleMediaDragOver}
          onDragLeave={handleMediaDragLeave}
          onDrop={handleMediaDrop}
        >
          <>
          {mediaDragActive && (
            <div className="media-drop-overlay" aria-hidden="true">
              <div><Upload size={30} /><strong>松开即可导入</strong><span>支持图片、视频、音频及整个文件夹</span></div>
            </div>
          )}
          <div className="library-heading">
            <div className="library-icon workspace-heading-icon"><Images /></div>
            <div>
              <div className="heading-row">
                <h1>媒体库</h1>
                <span className="plan-badge local">本地版</span>
                <ContactAuthorButton appName={licenseState.appName} />
              </div>
              <p>原始文件保留在电脑中，仅在本机建立索引、标签与搜索数据</p>
            </div>
          </div>

          <div className="toolbar-wrap">
            <div className="search-row">
              <div className="search-box">
                <Search size={18} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索素材名称、描述、标签..."
                  aria-label="搜索素材"
                />
                {query && <button onClick={() => setQuery("")} aria-label="清空搜索"><X size={15} /></button>}
              </div>
              <div className={`local-source ${localStatus}`}>
                <span className="local-source-dot" />
                <div className="local-source-info">
                  <strong>{localStatus === "connected" ? directoryName : localStatus === "scanning" ? `正在扫描 ${scanCount} 项` : localStatus === "permission" ? `${directoryName || "素材文件夹"} 需要授权` : localStatus === "unsupported" ? "兼容模式" : "尚未连接本地素材"}</strong>
                  <small>{localStatus === "connected" ? "文件夹已连接 · 素材不会上传" : localStatus === "unsupported" ? "可选择文件导入当前会话" : "选择一个文件夹建立本地媒体库"}</small>
                </div>
                <div className="local-source-actions">
                  <button onClick={refreshLocalLibrary} disabled={localStatus === "scanning"} aria-label="刷新本地媒体库">
                    <RotateCcw size={14} />刷新
                  </button>
                  <button onClick={uploadLocalFiles} disabled={localStatus === "scanning"}>
                    <Upload size={14} />上传文件
                  </button>
                  <button onClick={uploadLocalFolder} disabled={localStatus === "scanning"}>
                    <FolderOpen size={14} />上传文件夹
                  </button>
                </div>
              </div>
              <div className="toolbar-actions">
                <div className="sort-wrap">
                  <button className="icon-button" onClick={() => setSortOpen((value) => !value)} aria-label="排序"><ArrowDownUp size={18} /></button>
                  {sortOpen && (
                    <div className="sort-menu">
                      {(Object.keys(sortLabels) as SortBy[]).map((key) => (
                        <button className={sortBy === key ? "selected" : ""} onClick={() => { setSortBy(key); setSortOpen(false); notify(`已按“${sortLabels[key]}”排序`); }} key={key}>
                          {sortLabels[key]}{sortBy === key && <span>✓</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="view-switch">
                  <button className={view === "grid" ? "active" : ""} onClick={() => setView("grid")} aria-label="网格视图"><Grid2X2 size={18} /></button>
                  <button className={view === "list" ? "active" : ""} onClick={() => setView("list")} aria-label="列表视图"><List size={18} /></button>
                </div>
                <button className={`multi-select-toggle ${allVisibleSelected ? "active" : ""}`} onClick={toggleSelectAllVisible} aria-pressed={allVisibleSelected} disabled={!selectableAssetIds.length} title="Command/Ctrl+A">
                  <SquareCheck size={15} />{allVisibleSelected ? "取消全选" : "全选当前"}
                </button>
                <button className={`icon-button ${localStatus === "connected" ? "active" : ""}`} onClick={uploadLocalFolder} aria-label="上传本地素材文件夹"><FolderOpen size={18} /></button>
                <button className="icon-button" onClick={uploadLocalFiles} aria-label="上传本地素材文件"><Upload size={18} /></button>
                <button className="icon-button" onClick={() => { selectCollection("失联素材"); setDrawerOpen(false); }} aria-label="查看失联素材"><AlertTriangle size={18} />{brokenCount > 0 && <span className="tiny-count">{brokenCount}</span>}</button>
                <button className={`icon-button ${drawerOpen ? "active" : ""}`} onClick={() => setDrawerOpen((value) => !value)} aria-label="数据管理"><Settings size={18} /></button>
                <input ref={fileInput} type="file" accept="image/*,video/*,audio/*" multiple hidden onChange={onImport} />
                <input
                  ref={folderInput}
                  type="file"
                  accept="image/*,video/*,audio/*"
                  multiple
                  hidden
                  onChange={onImport}
                  {...({ webkitdirectory: "", directory: "" } as { webkitdirectory: string; directory: string })}
                />
              </div>
            </div>

            <div className="type-tabs" role="tablist" aria-label="素材类型">
              <button className={type === "all" ? "active" : ""} onClick={() => setType("all")}><Boxes size={16} />全部类型</button>
              <button className={type === "image" ? "active" : ""} onClick={() => setType("image")}><ImageIcon size={16} />图片</button>
              <button className={type === "video" ? "active" : ""} onClick={() => setType("video")}><Film size={16} />视频</button>
              <button className={type === "audio" ? "active" : ""} onClick={() => setType("audio")}><Music2 size={16} />音频</button>
            </div>
          </div>

          <div className="content-area">
            <aside className="filter-sidebar">
              <button className={collection === "全部素材" ? "selected" : ""} onClick={() => selectCollection("全部素材")}><Images size={16} />全部素材<span>{activeAssets.length}</span></button>
              <button className={collection === "收藏" ? "selected" : ""} onClick={() => selectCollection("收藏")}><Star size={16} />收藏<span>{activeAssets.filter((asset) => asset.favorite).length}</span></button>
              <button className={collection === "失联素材" ? "selected" : ""} onClick={() => selectCollection("失联素材")}><AlertTriangle size={16} />失联素材<span>{brokenCount}</span></button>
              <div className="filter-divider" />
              <div className="filter-title"><span>标签</span><button onClick={() => { setInputDialog("tag"); setDialogValue(""); }} aria-label="新建标签"><Plus size={16} /></button></div>
              {Object.entries(tagColors).map(([tagName, color]) => (
                <button className={`tag-filter ${collection === tagName ? "selected" : ""}`} onClick={() => selectCollection(tagName)} key={tagName}>
                  <i style={{ background: color }} />{tagName}<span>{activeAssets.filter((asset) => asset.tags.includes(tagName)).length}</span>
                </button>
              ))}
              <div className="filter-divider" />
              <div className="filter-title"><span>集合</span><button onClick={() => { setInputDialog("collection"); setDialogValue(""); }} aria-label="新建集合"><Plus size={16} /></button></div>
              <button className="tree-item" onClick={() => setProjectExpanded((value) => !value)}>{projectExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<FolderOpen size={16} />我的项目<span>{activeAssets.filter((asset) => asset.collection && collections.includes(asset.collection)).length}</span></button>
              {projectExpanded && visibleCollections.map((item) => (
                <div className={`project-tree-row ${collection === item ? "selected" : ""}`} key={item}>
                  {collectionRenameTarget === item ? <div className="tree-item nested project-tree-editor"><Folder size={15} /><input ref={collectionRenameInputRef} className="project-tree-edit-input" autoFocus maxLength={100} value={collectionRenameValue} aria-label={`修改项目名称：${collectionLabelFor(item)}`} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setCollectionRenameValue(event.target.value)} onBlur={saveCollectionRename} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } else if (event.key === "Escape") { event.preventDefault(); setCollectionRenameTarget(null); setCollectionRenameValue(""); } }} /><span className="project-tree-count">{activeAssets.filter((asset) => asset.collection === item).length}</span></div> : <button className="tree-item nested" title="双击重命名项目" onClick={() => selectCollection(item)} onDoubleClick={(event) => { event.preventDefault(); beginCollectionRename(item); }}><Folder size={15} /><span className="project-tree-name">{collectionLabelFor(item)}</span><span className="project-tree-count">{activeAssets.filter((asset) => asset.collection === item).length}</span></button>}
                  <button className="project-tree-delete" title={`删除项目“${collectionLabelFor(item)}”`} aria-label={`删除项目：${collectionLabelFor(item)}`} onClick={(event) => { event.stopPropagation(); setCollectionDeleteTarget(item); }}><Trash2 size={13} /></button>
                </div>
              ))}
              <button className={`trash-item ${collection === "回收站" ? "selected" : ""}`} onClick={() => selectCollection("回收站")}><Trash2 size={15} />回收站<span>{assets.filter((asset) => asset.deleted).length}</span></button>
            </aside>

            <section className={`asset-section ${selectedAssetIds.length > 0 ? "has-batch-bar" : ""}`} onMouseDown={beginAssetMarquee}>
              <div className="asset-meta">
                <span>{activeFolder ? <button className="meta-action folder-back" onClick={() => setActiveFolderPath(activeFolder.parentPath ?? null)}><ArrowLeft size={13} />返回{activeFolder.parentPath ? folders.find((folder) => folder.path === activeFolder.parentPath)?.name ?? "上一级" : isProjectCollection ? collectionLabelFor(collection) : "全部素材"} · {activeFolder.name}</button> : collection === "回收站" && assets.some((asset) => asset.deleted) ? <button className="meta-action danger" onClick={() => setPurgeOpen(true)}><Trash2 size={13} />清空回收站</button> : isProjectCollection ? `${collectionLabelFor(collection)} · 文件夹视图` : localStatus === "connected" ? `本地索引 · ${directoryName}` : "演示数据 · 请连接本地文件夹"}</span>
                <span>{sortLabels[sortBy]} · 共 {visibleFolders.length + filteredAssets.length} 项</span>
              </div>
              {visibleFolders.length || filteredAssets.length ? (
                <div className={`asset-grid ${view}`} ref={assetGridRef}>
                  {visibleFolders.map((folder) => {
                    const sourcePaths = folderTreePaths(folders, folder.path);
                    const folderAssets = assets.filter((asset) => !asset.deleted && (!isProjectCollection || asset.collection === collection) && asset.sourceRoot && sourcePaths.has(asset.sourceRoot));
                    const folderAssetCount = folderAssets.length;
                    const folderDragPaths = assets
                      .filter((asset) => !asset.deleted && asset.available && !asset.broken && (!isProjectCollection || asset.collection === collection) && asset.sourceRoot && sourcePaths.has(asset.sourceRoot) && asset.localPath)
                      .map((asset) => asset.localPath as string);
                    const folderSelectableIds = assets
                      .filter((asset) => !asset.deleted && asset.available && !asset.broken && (!isProjectCollection || asset.collection === collection) && asset.sourceRoot && sourcePaths.has(asset.sourceRoot) && asset.localPath)
                      .map((asset) => asset.id);
                    const folderMultiSelected = folderSelectableIds.length > 0 && folderSelectableIds.every((id) => selectedAssetIds.includes(id));
                    return (
                      <article
                        className={`asset-card folder-card ${folderDragPaths.length ? "native-draggable" : ""} ${folderMultiSelected ? "multi-selected" : ""} ${folder.available === false ? "folder-missing" : ""}`}
                        key={folder.path}
                        draggable={folderDragPaths.length > 0}
                        onDragStart={(event) => startNativeMediaDrag(event, folderMultiSelected && selectedDragPaths.length ? selectedDragPaths : folderDragPaths)}
                        onClick={(event) => { if (event.metaKey || event.ctrlKey) toggleFolderSelection(folderSelectableIds); }}
                        onDoubleClick={() => void openFolderSource(folder)}
                        onKeyDown={(event) => { if (event.key === "Enter") void openFolderSource(folder); }}
                        tabIndex={0}
                        title={`${folder.path} · ${folderDragPaths.length ? "可拖到剪映导入，双击打开" : "双击打开"}`}
                      >
                        {folderSelectableIds.length > 0 && (
                          <button type="button" className={`asset-select-check ${folderMultiSelected ? "checked" : ""}`} aria-label={`选择文件夹 ${folder.name} 中的素材`} aria-pressed={folderMultiSelected} onClick={(event) => { event.stopPropagation(); toggleFolderSelection(folderSelectableIds); }}><SquareCheck size={16} /></button>
                        )}
                        <div className="folder-visual"><FolderOpen size={54} /><span>{folder.available === false ? "文件夹失联" : "双击打开"}</span></div>
                        <div className="asset-info">
                          <div className="asset-name" title={folder.name}>{folder.name}</div>
                          <div className="asset-subline"><span>文件夹 · {folderAssetCount} 个素材</span></div>
                          <div className="asset-tags">
                            <span>本地文件夹</span>
                            {folder.available === false && (
                              <button
                                className="folder-relink-inline"
                                type="button"
                                disabled={folderRelinkBusyPath === folder.path}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void beginFolderRelink(folder);
                                }}
                              >
                                <RotateCcw size={12} />{folderRelinkBusyPath === folder.path ? "检查中…" : "重新关联"}
                              </button>
                            )}
                            <button
                              className={`folder-more ${folderMenuPath === folder.path ? "active" : ""}`}
                              type="button"
                              aria-label={`打开文件夹 ${folder.name} 操作菜单`}
                              aria-haspopup="menu"
                              aria-expanded={folderMenuPath === folder.path}
                              onClick={(event) => {
                                event.stopPropagation();
                                openFolderMenu(folder.path, event.currentTarget);
                              }}
                            >
                              <MoreHorizontal size={16} />
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                  {pagedAssets.map((asset) => (
                    <article
                      className={`asset-card ${asset.localPath && asset.available && !asset.broken ? "native-draggable" : ""} ${selectedAssetIds.includes(asset.id) ? "multi-selected" : ""} ${selectedId === asset.id ? "selected" : ""} ${assetMenu === asset.id ? "menu-open" : ""} ${hoverPreviewAssetId === asset.id ? "hover-previewing" : ""}`}
                      key={asset.id}
                      data-asset-id={asset.id}
                      draggable={Boolean(asset.localPath && asset.available && !asset.broken)}
                      onDragStart={(event) => startNativeMediaDrag(event, selectedAssetIds.includes(asset.id) && selectedDragPaths.length ? selectedDragPaths : asset.localPath ? [asset.localPath] : [])}
                      onContextMenu={(event) => openAssetContextMenu(event, asset.id)}
                      onMouseEnter={(event) => {
                        if (asset.type !== "video" || !asset.src || asset.broken || asset.available === false) return;
                        const video = event.currentTarget.querySelector<HTMLVideoElement>("video[data-hover-preview]");
                        if (video) startVideoHoverPreview(asset.id, video);
                      }}
                      onMouseLeave={(event) => {
                        if (asset.type !== "video") return;
                        const video = event.currentTarget.querySelector<HTMLVideoElement>("video[data-hover-preview]");
                        if (video) stopVideoHoverPreview(asset.id, video);
                      }}
                      onClick={(event) => {
                        selectAssetCardFromPointer(event, asset);
                      }}
                      onDoubleClick={() => openAssetPreview(asset)}
                      title={`${asset.localPath || asset.name} · 单击选择，双击预览${asset.localPath && asset.available && !asset.broken ? "，可拖到剪映导入" : ""}`}
                    >
                      {asset.localPath && asset.available && !asset.broken && (
                        <button type="button" className={`asset-select-check ${selectedAssetIds.includes(asset.id) ? "checked" : ""}`} aria-label={`选择素材 ${asset.name}`} aria-pressed={selectedAssetIds.includes(asset.id)} onClick={(event) => { event.stopPropagation(); selectAssetFromPointer(event, asset.id, true); }}><SquareCheck size={16} /></button>
                      )}
                      <div className="asset-visual">
                        {asset.src && (asset.type === "image" || asset.type === "video") && <DeferredAssetPreview asset={asset} />}
                        {asset.src && asset.type === "audio" && <div className="audio-cover"><Music2 size={26} /></div>}
                        {!asset.src && <div className="local-preview-missing"><FolderOpen size={25} /><span>等待本地授权</span></div>}
                        {asset.broken && <span className="broken-chip"><AlertTriangle size={12} />文件失联</span>}
                        {asset.sourceKind === "folder" && asset.available && <span className="local-chip">本地</span>}
                        {asset.qianchuan && <span className="qianchuan-chip">千川已绑定</span>}
                        {asset.type === "video" && (
                          <span
                            className="play-chip"
                            aria-hidden="true"
                          ><Play size={14} fill="currentColor" /></span>
                        )}
                        {asset.type === "audio" && <span className="audio-wave">▂▄▆█▅▃▇</span>}
                        {asset.duration && <span className="duration">{asset.duration}</span>}
                        <button
                          className={`favorite ${asset.favorite ? "active" : ""}`}
                          onClick={(event) => { event.stopPropagation(); toggleFavorite(asset.id); }}
                          aria-label="收藏"
                        ><Heart size={16} fill={asset.favorite ? "currentColor" : "none"} /></button>
                      </div>
                      <div className="asset-info">
                        <div className="asset-name" title={asset.name}>{asset.name}</div>
                        <div className="asset-subline">
                          <span>{asset.type === "video" ? "视频" : asset.type === "image" ? "图片" : "音频"} · {asset.size}</span>
                          <button
                            className={`asset-more ${assetMenu === asset.id ? "active" : ""}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              openAssetMenu(asset.id, event.currentTarget);
                            }}
                            aria-label={`打开 ${asset.name} 的更多操作`}
                            aria-expanded={assetMenu === asset.id}
                            aria-haspopup="menu"
                            data-testid={`asset-menu-trigger-${asset.id}`}
                          ><MoreHorizontal size={16} /></button>
                        </div>
                        <div className="asset-tags">
                          {asset.tags.slice(0, 2).map((tagName) => <span key={tagName}>{tagName}</span>)}
                        </div>
                      </div>
                    </article>
                  ))}
                  {assetPageCount > 1 && (
                    <div className="asset-pagination">
                      <button type="button" disabled={assetPage <= 1} onClick={() => setAssetPagination({ key: assetPageKey, page: Math.max(1, assetPage - 1) })}>上一页</button>
                      <span>第 {assetPage}/{assetPageCount} 页 · 每页最多 {MEDIA_ASSET_PAGE_SIZE} 个素材</span>
                      <button type="button" disabled={assetPage >= assetPageCount} onClick={() => setAssetPagination({ key: assetPageKey, page: Math.min(assetPageCount, assetPage + 1) })}>下一页</button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="empty-state">
                  <Search size={34} />
                  <h3>没有找到相关素材</h3>
                  <p>{collection === "回收站" ? "这里暂时没有被删除的素材。" : "换个关键词或清除筛选后再试。"}</p>
                  <button onClick={() => { setQuery(""); setType("all"); setCollection("全部素材"); setActiveFolderPath(null); }}>清除筛选</button>
                </div>
              )}
            </section>
            {selectedAssetIds.length > 0 && (
              <div className="multi-select-bar" role="toolbar" aria-label="批量素材操作">
                <strong>已选择 {selectedAssetIds.length} 个文件</strong>
                <span>拖动空白处框选切换 · 框内已选取消、未选勾选 · Shift 连选 · ⌘/Ctrl+A 全选 · Esc 清空</span>
                <button className="send-classifier" onClick={() => void sendAssetsToClassifier(selectedClassifierPaths, `${selectedClassifierPaths.length} 个已选素材`)} disabled={!selectedClassifierPaths.length || classifierPreparing}><Send size={12} />{classifierPreparing ? "正在发送…" : `发送到工作台（${selectedClassifierPaths.length}）`}</button>
                <label className="batch-select"><Tag size={12} /><select aria-label="批量添加标签" defaultValue="" onChange={(event) => { addTagToSelection(event.target.value); event.currentTarget.value = ""; }}><option value="" disabled>添加标签</option>{Object.keys(tagColors).map((tagName) => <option value={tagName} key={tagName}>{tagName}</option>)}</select></label>
                <label className="batch-select"><Folder size={12} /><select aria-label="批量加入项目" defaultValue="" onChange={(event) => { moveSelectionToCollection(event.target.value); event.currentTarget.value = ""; }}><option value="" disabled>加入项目</option>{visibleCollections.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
                <button className="danger" onClick={deleteSelection}><Trash2 size={12} />移入回收站</button>
                <button onClick={clearAssetSelection}>清空选择</button>
              </div>
            )}
          </div>

          {drawerOpen && (
            <aside className="engine-panel data-management-panel">
              <div className="panel-head">
                <div><span className="panel-icon"><DatabaseBackup size={17} /></span><strong>数据管理</strong></div>
                <button onClick={() => setDrawerOpen(false)} aria-label="关闭"><X size={18} /></button>
              </div>
              <div className="panel-body">
                <p className="data-management-copy">导出或恢复标签、描述、集合和本地素材索引记录。</p>
                <div className="backup-actions">
                  <button onClick={backupDatabase}><DatabaseBackup size={15} />备份数据库</button>
                  <button onClick={() => restoreInput.current?.click()}><Download size={15} />还原数据库</button>
                </div>
                <input ref={restoreInput} type="file" accept="application/json,.json" hidden onChange={restoreDatabase} />
                <p className="backup-note">备份不包含原始素材文件；还原前不会修改当前数据。</p>
              </div>
            </aside>
          )}
          </>
        </section>
        ) : activeModule === "qianchuan-videos" ? (
          <QianchuanVideoLibrary
            bootstrap={qianchuanBootstrap}
            loading={qianchuanBootstrapLoading}
            error={qianchuanBootstrapError}
            ensureBootstrap={ensureQianchuanBootstrap}
            onImport={importQianchuanPerformance}
            assets={assets}
            onLocate={(asset) => {
              setActiveModule("media");
              setCollection(QIANCHUAN_PROJECT_COLLECTION);
              setActiveFolderPath(null);
              setQuery(asset.name);
              setSelectedId(asset.id);
            }}
          />
        ) : activeModule === "viral-visuals" ? (
          <ViralVisualLibrary assets={assets} searchQuery={viralSearchQuery} onSearchQueryChange={setViralSearchQuery} onNavigate={setActiveModule} onPreview={openAssetPreview} onUpload={uploadViralVisuals} onImportCsv={importViralCsv} onDropFiles={dropViralVisualFiles} onRemove={removeViralVisuals} onSetCategory={setViralVisualCategory} onViewData={(asset) => { void loadQianchuanAssetData(asset); }} onBindData={(asset) => { void openQianchuanBinding(asset); }} onLocate={(asset) => {
            setActiveModule("media");
            setCollection(VIRAL_FRAME_COLLECTION);
            setActiveFolderPath(null);
            setQuery(asset.name);
            setSelectedId(asset.id);
          }} />
        ) : activeModule === "viral-copy" ? (
          <ViralCopyLibrary assets={assets} searchQuery={viralSearchQuery} onSearchQueryChange={setViralSearchQuery} onNavigate={setActiveModule} revision={viralLibraryRevision} onUploadVisual={uploadViralVisuals} onImportCsv={importViralCsv} onPreview={openAssetPreview} />
        ) : activeModule === "subtitle-removal" ? (
          <AliyunSubtitleWorkbench notify={notify} assets={assets} contactAuthor={<ContactAuthorButton appName={licenseState.appName} />} onConfigure={() => { setAliyunSettingsRequested(true); setActiveModule("settings"); }} onImport={importAliyunResult} />
        ) : activeModule === "downloads" ? (
          <VideoDownloadWorkbench
            notify={notify}
            appName={licenseState.appName}
            input={videoDownloadDraft}
            setInput={setVideoDownloadDraft}
            onImport={(records, incomingFolders, sourceKind) => {
              installFolderSources(incomingFolders);
              installDesktopAssets(records, sourceKind, "视频下载");
            }}
          />
        ) : activeModule === "schemes" || activeModule === "classifier" ? (
          null
        ) : activeModule === "voice" ? (
          null
        ) : (
          <ApiSettingsPage onOpenSubtitles={() => setActiveModule("subtitle-removal")} initialSection={aliyunSettingsRequested ? "aliyun" : "api"} notify={notify} licenseState={licenseState} onLicenseStateChange={onLicenseStateChange} updateState={updateState} onUpdateCheck={() => void checkForUpdates()} />
        )}
        <div className="persistent-classifier-host" hidden={activeModule !== "schemes" && activeModule !== "classifier"}>
          <ClassifierWorkbench
            view={activeModule === "schemes" ? "schemes" : "workbench"}
            notify={notify}
            handoff={classifierHandoff}
            onClearHandoff={() => setClassifierHandoff(null)}
            onCompleted={syncClassifierOutput}
            appName={licenseState.appName}
          />
        </div>
        <div className="persistent-voice-host" hidden={activeModule !== "voice"}>
          <VoiceCloneWorkbench notify={notify} appName={licenseState.appName} />
        </div>
      </div>

      <input ref={repairInput} type="file" accept="image/*,video/*,audio/*" hidden onChange={repairAsset} />

      {assetMarqueeRect && createPortal(
        <div
          className="asset-marquee-rect"
          aria-hidden="true"
          style={{
            left: assetMarqueeRect.left,
            top: assetMarqueeRect.top,
            width: assetMarqueeRect.width,
            height: assetMarqueeRect.height,
          }}
        />,
        document.body,
      )}

      {previewAsset && createPortal(
        <div className="preview-backdrop" role="presentation" onMouseDown={() => setPreviewAssetId(null)}>
          <section
            className="preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`预览 ${previewAsset.name}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="preview-header">
              <div>
                <strong>{previewAsset.name}</strong>
                <span>{previewAsset.type === "video" ? "视频" : previewAsset.type === "audio" ? "音频" : "图片"} · {previewAsset.size}</span>
              </div>
              <button type="button" onClick={() => setPreviewAssetId(null)} aria-label="关闭预览"><X size={19} /></button>
            </header>
            <div className="preview-stage">
              {previewAsset.type === "video" && (
                <video key={previewAsset.src} src={previewAsset.src} controls autoPlay playsInline preload="metadata" />
              )}
              {previewAsset.type === "audio" && (
                <audio key={previewAsset.src} src={previewAsset.src} controls autoPlay preload="metadata" />
              )}
              {previewAsset.type === "image" && <img src={previewAsset.src} alt={previewAsset.name} />}
            </div>
            <footer className="preview-footer">
              <span>{previewAsset.localPath || "本地素材"}</span>
              <span>按 Esc 关闭</span>
            </footer>
          </section>
        </div>,
        document.body,
      )}

      {qianchuanDialog && qianchuanDialogAsset && createPortal(
        <div className="modal-backdrop qianchuan-modal-backdrop" onMouseDown={() => { if (!qianchuanDialogBusy) closeQianchuanDialog(); }}>
          <section className="qianchuan-dialog" role="dialog" aria-modal="true" aria-labelledby="qianchuan-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><span className="qianchuan-dialog-icon"><Film size={20} /></span><div><h2 id="qianchuan-dialog-title">{qianchuanDialog.mode === "bind" ? "绑定千川数据" : "千川素材数据"}</h2><p>{qianchuanDialogAsset.name}</p></div></div><button type="button" aria-label="关闭" disabled={qianchuanDialogBusy} onClick={closeQianchuanDialog}><X size={18} /></button></header>
            {qianchuanDialog.mode === "bind" ? (
              <div className="qianchuan-bind-body">
                <label><span>素材所属千川账户</span><select value={qianchuanAdvertiserId} onChange={(event) => setQianchuanAdvertiserId(event.target.value)} disabled={qianchuanBootstrapLoading || qianchuanDialogBusy}>
                  {!qianchuanBootstrap?.accounts.length && <option value="">暂无可用账户</option>}
                  {qianchuanBootstrap?.accounts.map((account) => <option key={account.advertiser_id} value={account.advertiser_id}>{account.name} · {account.advertiser_id}</option>)}
                </select></label>
                <label><span>素材 ID / 视频 ID / 抖音作品 ID</span><input value={qianchuanReference} onChange={(event) => setQianchuanReference(event.target.value)} placeholder="例如 7672387281139712063 或 v02..." disabled={qianchuanDialogBusy} onKeyDown={(event) => { if (event.key === "Enter") void submitQianchuanBinding(); }} /></label>
                <div className="qianchuan-bind-note"><CircleHelp size={16} /><span>优先填写千川报表中的素材 ID；也支持以 v0 开头的视频 ID。只会把数据关系写入本地媒体库，不会修改千川后台素材。</span></div>
              </div>
            ) : (
              <div className="qianchuan-data-body">
                <div className="qianchuan-identity-grid"><div><span>账户</span><strong>{qianchuanDialogAsset.qianchuan?.advertiserName}</strong></div><div><span>素材 ID</span><strong>{qianchuanDialogAsset.qianchuan?.materialId}</strong></div><div><span>视频 ID</span><strong>{qianchuanDialogVideo?.video_id || qianchuanDialogAsset.qianchuan?.videoId || "—"}</strong></div><div><span>数据周期</span><strong>{qianchuanDialogRange || "最近 30 天"}</strong></div></div>
                {qianchuanDialogBusy ? <div className="qianchuan-loading"><RefreshCw size={18} className="spin" />正在读取千川数据…</div> : qianchuanDialogReport ? <>
                  <div className="qianchuan-metric-grid">
                    <div><span>消耗</span><strong>¥{qianchuanMetric(qianchuanDialogReport.spend, 2)}</strong></div><div><span>视频播放</span><strong>{qianchuanMetric(qianchuanDialogReport.video_plays)}</strong></div><div><span>整体点击次数</span><strong>{qianchuanMetric(qianchuanDialogReport.live_viewers)}</strong></div><div><span>整体点击率</span><strong>{qianchuanMetric(qianchuanDialogReport.live_conversion_rate_percent, 2)}%</strong></div><div><span>3 秒播放率</span><strong>{qianchuanMetric(qianchuanDialogReport.video_3s_play_rate_percent, 2)}%</strong></div><div><span>完播率</span><strong>{qianchuanMetric(qianchuanDialogReport.video_completion_rate_percent, 2)}%</strong></div><div><span>平均观看</span><strong>{qianchuanMetric(qianchuanDialogReport.video_average_watch_seconds, 2)} 秒</strong></div><div><span>成交 ROI</span><strong>{qianchuanMetric(qianchuanDialogReport.paid_roi, 2)}</strong></div><div><span>成交订单</span><strong>{qianchuanMetric(qianchuanDialogReport.paid_orders)}</strong></div><div><span>成交金额</span><strong>¥{qianchuanMetric(qianchuanDialogReport.paid_gmv, 2)}</strong></div>
                  </div>
                  <QianchuanInsightsPanel insights={qianchuanDialogInsights} loading={qianchuanDialogInsightsLoading} error={qianchuanDialogInsightsError} />
                  <div className={`qianchuan-download-state ${qianchuanDialogVideo?.download_available ? "available" : "blocked"}`}><span>{qianchuanDialogVideo?.download_available ? "该素材允许从千川直接导入视频" : "已绑定数据，但千川未开放该素材的视频 URL"}</span>{qianchuanDialogVideo?.download_reason && <small>{qianchuanDialogVideo.download_reason}</small>}</div>
                </> : <div className="qianchuan-no-report"><AlertTriangle size={18} /><span>当前周期内没有查到这条素材的投放数据，绑定关系仍会保留。</span></div>}
              </div>
            )}
            {qianchuanDialogError && <div className="qianchuan-dialog-error"><AlertTriangle size={15} />{qianchuanDialogError}</div>}
            <footer><button type="button" onClick={closeQianchuanDialog} disabled={qianchuanDialogBusy}>关闭</button>{qianchuanDialog.mode === "bind" ? <button type="button" className="primary" onClick={() => void submitQianchuanBinding()} disabled={qianchuanDialogBusy || !qianchuanReference.trim() || !qianchuanAdvertiserId}>{qianchuanDialogBusy ? "正在核对" : "确认绑定"}</button> : <button type="button" className="primary" onClick={() => void loadQianchuanAssetData(qianchuanDialogAsset)} disabled={qianchuanDialogBusy}><RefreshCw size={14} />刷新数据</button>}</footer>
          </section>
        </div>,
        document.body,
      )}

      {activeMenuAsset && createPortal(
        <div className="asset-menu-layer" onPointerDown={() => setAssetMenu(null)}>
          <div
            className={`asset-menu floating ${assetMenuPosition.left + 432 > window.innerWidth ? "submenu-left" : ""}`}
            role="menu"
            aria-label={`${activeMenuAsset.name} 的素材操作`}
            style={{ top: assetMenuPosition.top, left: assetMenuPosition.left }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="asset-menu-head">
              <div><span>素材操作</span><strong>{activeMenuAsset.name}</strong></div>
              <span className="asset-type-badge">{activeMenuAsset.type === "video" ? "视频" : activeMenuAsset.type === "image" ? "图片" : "音频"}</span>
            </div>
            <div className="asset-menu-group">
              <button
                role="menuitem"
                aria-label={`在访达或文件夹中打开 ${activeMenuAsset.name}`}
                data-testid="asset-action-reveal"
                disabled={!activeMenuAsset.localPath || activeMenuAsset.available === false || activeMenuAsset.broken}
                onClick={() => void revealAssetInFolder(activeMenuAsset)}
              >
                <span className="menu-icon"><FolderOpen size={14} /></span><span className="menu-copy"><strong>在访达/文件夹中打开</strong><small>{activeMenuAsset.localPath && activeMenuAsset.available !== false && !activeMenuAsset.broken ? "定位并选中本地原文件" : "该素材没有可用的本地路径"}</small></span>
              </button>
              {activeMenuAsset.deleted ? (
                <button role="menuitem" aria-label={`恢复素材 ${activeMenuAsset.name}`} data-testid="asset-action-restore" onClick={() => restoreAsset(activeMenuAsset.id)}>
                  <span className="menu-icon"><RotateCcw size={14} /></span><span className="menu-copy"><strong>恢复素材</strong><small>移回全部素材</small></span>
                </button>
              ) : (
                <>
                  <button role="menuitem" aria-label={`${activeMenuAsset.favorite ? "取消收藏" : "加入收藏"} ${activeMenuAsset.name}`} data-testid="asset-action-favorite" onClick={() => { toggleFavorite(activeMenuAsset.id); setAssetMenu(null); notify(activeMenuAsset.favorite ? "已取消收藏" : "已加入收藏"); }}>
                    <span className="menu-icon"><Heart size={14} fill={activeMenuAsset.favorite ? "currentColor" : "none"} /></span><span className="menu-copy"><strong>{activeMenuAsset.favorite ? "取消收藏" : "加入收藏"}</strong><small>{activeMenuAsset.favorite ? "从收藏视图移除" : "方便之后快速找到"}</small></span>
                  </button>
                  {(activeMenuAsset.type === "image" || activeMenuAsset.type === "video") && activeMenuAsset.localPath && activeMenuAsset.available && !activeMenuAsset.broken && (
                    <button role="menuitem" aria-label={`发送 ${activeMenuAsset.name} 到素材工作台`} data-testid="asset-action-classifier" onClick={() => void sendAssetsToClassifier([activeMenuAsset.localPath as string], activeMenuAsset.name)}>
                      <span className="menu-icon"><Send size={14} /></span><span className="menu-copy"><strong>发送到素材工作台</strong><small>自动带入图片或视频并开始分类</small></span>
                    </button>
                  )}
                  {activeMenuAsset.type === "video" && (activeMenuAsset.qianchuan ? (
                    <button role="menuitem" aria-label={`查看 ${activeMenuAsset.name} 的千川数据`} data-testid="asset-action-qianchuan-view" onClick={() => void loadQianchuanAssetData(activeMenuAsset)}>
                      <span className="menu-icon qianchuan"><Film size={14} /></span><span className="menu-copy"><strong>查看千川数据</strong><small>{activeMenuAsset.qianchuan.advertiserName} · 素材 ID {activeMenuAsset.qianchuan.materialId}</small></span>
                    </button>
                  ) : (
                    <button role="menuitem" aria-label={`绑定 ${activeMenuAsset.name} 的千川数据`} data-testid="asset-action-qianchuan-bind" onClick={() => void openQianchuanBinding(activeMenuAsset)}>
                      <span className="menu-icon qianchuan"><Film size={14} /></span><span className="menu-copy"><strong>绑定千川数据</strong><small>输入素材 ID、视频 ID 或抖音作品 ID</small></span>
                    </button>
                  ))}
                  {activeMenuAsset.broken && (
                    <button role="menuitem" aria-label={`重新关联文件 ${activeMenuAsset.name}`} data-testid="asset-action-repair" onClick={() => beginRepairAsset(activeMenuAsset.id)}>
                      <span className="menu-icon warning"><RotateCcw size={14} /></span><span className="menu-copy"><strong>重新关联文件</strong><small>选择新的本地文件路径</small></span>
                    </button>
                  )}
                  <div className="asset-submenu-wrap">
                    <button role="menuitem" aria-haspopup="menu" aria-label={`为 ${activeMenuAsset.name} 添加标签`} data-testid="asset-action-tag">
                      <span className="menu-icon"><Tag size={14} /></span><span className="menu-copy"><strong>添加标签</strong><small>悬停后选择标签</small></span><ChevronRight className="menu-chevron" size={14} />
                    </button>
                    <div className="asset-submenu" role="menu" aria-label="选择标签">
                      <div className="asset-submenu-title">全部标签</div>
                      {Object.entries(tagColors).map(([tagName, color]) => (
                        <button role="menuitem" key={tagName} onClick={() => addSelectedTag(activeMenuAsset.id, tagName)}>
                          <i className="submenu-color" style={{ background: color }} /><span>{tagName}</span>{activeMenuAsset.tags.includes(tagName) && <b>✓</b>}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="asset-submenu-wrap">
                    <button role="menuitem" aria-haspopup="menu" aria-label={`将 ${activeMenuAsset.name} 添加至项目`} data-testid="asset-action-move">
                      <span className="menu-icon"><Folder size={14} /></span><span className="menu-copy"><strong>添加至项目</strong><small>悬停后选择项目</small></span><ChevronRight className="menu-chevron" size={14} />
                    </button>
                    <div className="asset-submenu" role="menu" aria-label="选择项目">
                      <div className="asset-submenu-title">全部项目</div>
                      {visibleCollections.map((projectName) => (
                        <button role="menuitem" key={projectName} onClick={() => moveSelectedAsset(activeMenuAsset.id, projectName)}>
                          <Folder size={13} /><span>{collectionLabelFor(projectName)}</span>{activeMenuAsset.collection === projectName && <b>✓</b>}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="asset-menu-divider" />
                  <button role="menuitem" aria-label={`移入回收站 ${activeMenuAsset.name}`} data-testid="asset-action-delete" className="danger" onClick={() => softDelete(activeMenuAsset.id)}>
                    <span className="menu-icon"><Trash2 size={14} /></span><span className="menu-copy"><strong>移入回收站</strong><small>只删除索引记录，可随时恢复</small></span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {activeMenuFolder && createPortal(
        <div className="asset-menu-layer" onPointerDown={() => setFolderMenuPath(null)}>
          <div
            className={`asset-menu floating ${folderMenuPosition.left + 432 > window.innerWidth ? "submenu-left" : ""}`}
            role="menu"
            aria-label={`${activeMenuFolder.name} 的文件夹操作`}
            style={{ top: folderMenuPosition.top, left: folderMenuPosition.left }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="asset-menu-head">
              <div><span>文件夹操作</span><strong>{activeMenuFolder.name}</strong></div>
              <span className="asset-type-badge">文件夹</span>
            </div>
            <div className="asset-menu-group">
              <button
                role="menuitem"
                aria-label={`发送文件夹 ${activeMenuFolder.name} 到素材工作台`}
                data-testid="folder-action-classifier"
                disabled={activeMenuFolder.available === false}
                onClick={() => {
                  setFolderMenuPath(null);
                  sendFolderToClassifier(activeMenuFolder);
                }}
              >
                <span className="menu-icon"><Send size={14} /></span><span className="menu-copy"><strong>发送到素材工作台</strong><small>将文件夹及子文件夹素材带入分类</small></span>
              </button>
              <button
                role="menuitem"
                aria-label={`查看 ${activeMenuFolder.name} 的原文件夹位置`}
                data-testid="folder-action-reveal"
                disabled={activeMenuFolder.available === false}
                onClick={() => void openOriginalFolder(activeMenuFolder)}
              >
                <span className="menu-icon"><FolderOpen size={14} /></span><span className="menu-copy"><strong>查看原文件夹位置</strong><small>在访达或资源管理器中打开</small></span>
              </button>
              {activeMenuFolder.available === false && (
                <button
                  role="menuitem"
                  aria-label={`重新关联文件夹 ${activeMenuFolder.name}`}
                  data-testid="folder-action-relink"
                  disabled={folderRelinkBusyPath === activeMenuFolder.path}
                  onClick={() => void beginFolderRelink(activeMenuFolder)}
                >
                  <span className="menu-icon warning"><RotateCcw size={14} /></span><span className="menu-copy"><strong>重新关联文件夹</strong><small>选择移动后的新位置</small></span>
                </button>
              )}
              <div className="asset-submenu-wrap">
                <button role="menuitem" aria-haspopup="menu" aria-label={`为文件夹 ${activeMenuFolder.name} 选择项目`} data-testid="folder-action-project">
                  <span className="menu-icon"><Folder size={14} /></span><span className="menu-copy"><strong>选择项目</strong><small>将文件夹内素材统一归入项目</small></span><ChevronRight className="menu-chevron" size={14} />
                </button>
                <div className="asset-submenu" role="menu" aria-label="选择文件夹项目">
                  <div className="asset-submenu-title">全部项目</div>
                  {visibleCollections.map((projectName) => {
                    const sourcePaths = folderTreePaths(folders, activeMenuFolder.path);
                    const folderAssets = assets.filter((asset) => !asset.deleted && asset.sourceRoot && sourcePaths.has(asset.sourceRoot));
                    const alreadyInProject = folderAssets.length > 0 && folderAssets.every((asset) => asset.collection === projectName);
                    return (
                      <button role="menuitem" key={projectName} onClick={() => moveFolderToCollection(activeMenuFolder, projectName)}>
                        <Folder size={13} /><span>{collectionLabelFor(projectName)}</span>{alreadyInProject && <b>✓</b>}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="asset-menu-divider" />
              <button
                role="menuitem"
                aria-label={`删除文件夹 ${activeMenuFolder.name}`}
                data-testid="folder-action-delete"
                className="danger"
                onClick={() => openFolderDeleteDialog(activeMenuFolder)}
              >
                <span className="menu-icon"><Trash2 size={14} /></span><span className="menu-copy"><strong>删除文件夹</strong><small>选择是否同时删除本地文件夹</small></span>
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {folderRelinkPlan && (
        <div className="modal-backdrop" onMouseDown={() => setFolderRelinkPlan(null)}>
          <div className="compact-modal folder-relink-modal" role="dialog" aria-modal="true" aria-labelledby="folder-relink-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setFolderRelinkPlan(null)}><X size={18} /></button>
            <div className="compact-modal-icon"><RotateCcw size={20} /></div>
            <h2 id="folder-relink-title">确认重新关联文件夹</h2>
            <div className="folder-relink-paths">
              <span><b>原位置</b><code title={folderRelinkPlan.oldRoot}>{folderRelinkPlan.oldRoot}</code></span>
              <span><b>新位置</b><code title={folderRelinkPlan.newRoot}>{folderRelinkPlan.newRoot}</code></span>
            </div>
            <div className="folder-delete-summary">
              <strong>{folderRelinkPlan.stats.folders} 个文件夹</strong>
              {folderRelinkPlan.stats.newFolders > 0 && <span>新发现 {folderRelinkPlan.stats.newFolders} 个子文件夹</span>}
              <span>可恢复 {folderRelinkPlan.stats.reconnectedAssets} 个素材</span>
              <span>新发现 {folderRelinkPlan.stats.newAssets} 个素材</span>
              <span>仍失联 {folderRelinkPlan.stats.missingAssets} 个素材</span>
            </div>
            <p className="folder-relink-note">只更新媒体库索引和目录层级，不会移动、复制或删除本地文件。</p>
            {folderRelinkPlan.stats.missingAssets > 0 && <div className="folder-delete-error" role="status"><AlertTriangle size={14} />未匹配的素材会继续保留为失联记录。</div>}
            <div className="modal-actions">
              <button onClick={() => setFolderRelinkPlan(null)}>取消</button>
              <button className="primary" onClick={confirmFolderRelink}>确认重新关联</button>
            </div>
          </div>
        </div>
      )}

      {folderDeleteTarget && (
        <div className="modal-backdrop" onMouseDown={() => { if (!folderDeleteBusy) setFolderDeleteTarget(null); }}>
          <div className="compact-modal folder-delete-modal" role="dialog" aria-modal="true" aria-labelledby="folder-delete-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" disabled={folderDeleteBusy} onClick={() => setFolderDeleteTarget(null)}><X size={18} /></button>
            <div className="compact-modal-icon"><Trash2 size={20} /></div>
            <h2 id="folder-delete-title">删除文件夹“{folderDeleteTarget.name}”</h2>
            <p className="folder-delete-path" title={folderDeleteTarget.path}>{folderDeleteTarget.path}</p>
            <div className="folder-delete-summary">
              <strong>{folderDeleteStats.total} 个素材</strong>
              <span>图片 {folderDeleteStats.image}</span>
              <span>视频 {folderDeleteStats.video}</span>
              <span>音频 {folderDeleteStats.audio}</span>
              {folderDeleteStats.folders > 1 && <span>含 {folderDeleteStats.folders - 1} 个子文件夹</span>}
            </div>
            <div className="folder-delete-options" role="radiogroup" aria-label="文件夹删除方式">
              <label className={`folder-delete-option dangerous ${folderDeleteMode === "delete-local" ? "selected" : ""} ${folderDeleteTarget.available === false || !window.desktopBridge?.mediaTrashFolder ? "disabled" : ""}`}>
                <input type="radio" name="folder-delete-mode" value="delete-local" checked={folderDeleteMode === "delete-local"} disabled={folderDeleteTarget.available === false || !window.desktopBridge?.mediaTrashFolder} onChange={() => setFolderDeleteMode("delete-local")} />
                <span><strong>删除文件夹及本地文件夹</strong><small>从媒体库移除，并将实际文件夹移入系统废纸篓</small></span>
              </label>
              <label className={`folder-delete-option ${folderDeleteMode === "remove-folder" ? "selected" : ""}`}>
                <input type="radio" name="folder-delete-mode" value="remove-folder" checked={folderDeleteMode === "remove-folder"} onChange={() => setFolderDeleteMode("remove-folder")} />
                <span><strong>仅删除文件夹，保留本地文件夹</strong><small>移除文件夹及其中全部素材记录，本地文件不变</small></span>
                <b className="folder-delete-badge">推荐</b>
              </label>
              <label className={`folder-delete-option ${folderDeleteMode === "clear-assets" ? "selected" : ""} ${folderDeleteStats.total === 0 ? "disabled" : ""}`}>
                <input type="radio" name="folder-delete-mode" value="clear-assets" checked={folderDeleteMode === "clear-assets"} disabled={folderDeleteStats.total === 0} onChange={() => setFolderDeleteMode("clear-assets")} />
                <span><strong>仅删除文件夹内的素材</strong><small>保留媒体库文件夹卡片，仅清空图片、视频和音频记录；本地文件不变</small></span>
              </label>
            </div>
            {folderDeleteError && <div className="folder-delete-error" role="alert"><AlertTriangle size={14} />{folderDeleteError}</div>}
            <div className="modal-actions">
              <button disabled={folderDeleteBusy} onClick={() => setFolderDeleteTarget(null)}>取消</button>
              <button className={folderDeleteMode === "delete-local" ? "danger-confirm" : "primary"} disabled={folderDeleteBusy || (folderDeleteMode === "clear-assets" && folderDeleteStats.total === 0)} onClick={() => void confirmFolderDeletion()}>{folderDeleteBusy ? "处理中…" : "确认执行"}</button>
            </div>
          </div>
        </div>
      )}

      {collectionDeleteTarget && (
        <div className="modal-backdrop" onMouseDown={() => setCollectionDeleteTarget(null)}>
          <div className="compact-modal" role="alertdialog" aria-modal="true" aria-labelledby="collection-delete-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setCollectionDeleteTarget(null)}><X size={18} /></button>
            <div className="compact-modal-icon"><Trash2 size={20} /></div>
            <h2 id="collection-delete-title">删除项目“{collectionLabelFor(collectionDeleteTarget)}”？</h2>
            <p>项目将从左侧移除；其中的素材仍保留在“全部素材”，不会删除本地图片、视频或音频文件。</p>
            <div className="modal-actions"><button onClick={() => setCollectionDeleteTarget(null)}>取消</button><button className="danger-confirm" onClick={confirmCollectionDelete}>删除项目</button></div>
          </div>
        </div>
      )}

      {inputDialog && (
        <div className="modal-backdrop" onMouseDown={() => setInputDialog(null)}>
          <div className="compact-modal" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setInputDialog(null)}><X size={18} /></button>
            <div className="compact-modal-icon">{inputDialog === "tag" ? <Tag size={20} /> : <Folder size={20} />}</div>
            <h2>{inputDialog === "tag" ? "新建标签" : "新建集合"}</h2>
            <p>{inputDialog === "tag" ? "标签可用于筛选和文本搜索。" : "集合用于按项目组织素材。"}</p>
            <input autoFocus value={dialogValue} onChange={(event) => setDialogValue(event.target.value)} onKeyDown={(event) => event.key === "Enter" && submitInputDialog()} placeholder={inputDialog === "tag" ? "输入标签名称" : "输入集合名称"} />
            <div className="modal-actions"><button onClick={() => setInputDialog(null)}>取消</button><button className="primary" disabled={!dialogValue.trim()} onClick={submitInputDialog}>创建</button></div>
          </div>
        </div>
      )}

      {vipAvailable && viralUploadSelection && (
        <div className="modal-backdrop" onMouseDown={() => { if (!viralUploadBusy) setViralUploadSelection(null); }}>
          <div className="compact-modal viral-upload-modal" role="dialog" aria-modal="true" aria-labelledby="viral-upload-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" disabled={viralUploadBusy} aria-label="关闭上传画面" onClick={() => setViralUploadSelection(null)}><X size={18} /></button>
            <div className="compact-modal-icon"><Images size={20} /></div>
            <h2 id="viral-upload-title">上传 {viralUploadSelection.length} 个画面</h2>
            <p>可单个或批量上传图片、视频；原文件留在本机。若同时有数据 CSV，选择对应文件名／路径列后，会把该行其余数据附在画面上供查看。</p>
            <div className="viral-upload-file-list">{viralUploadSelection.map((record) => <div key={record.path}><span>{record.type === "video" ? "视频" : "图片"}</span><strong title={record.name}>{record.name}</strong></div>)}</div>
            <label className="viral-major-category-field"><span>大分类（可选，用户自填）</span><input value={viralUploadMajorCategory} maxLength={100} disabled={viralUploadBusy} onChange={(event) => setViralUploadMajorCategory(event.target.value)} placeholder="输入本批画面所属的大分类；留空则新画面未分组" /></label>
            <section className="viral-upload-visual-types" aria-label="画面类型自动识别">
              <header><strong>画面类型自动识别</strong><small>CSV 未提供类型时执行</small></header>
              <p>CSV 有“画面类型”时直接采用；选择“没有此列”或单元格为空时，自动从以下分类打一个主标签。</p>
              <div className="viral-upload-visual-type-list">{DEFAULT_VIRAL_VISUAL_TYPES.map((visualType) => <span key={visualType}>{visualType}</span>)}</div>
              <div className="viral-visual-recognition-options" role="radiogroup" aria-label="画面识别方式">
                <label className={viralVisualRecognitionMode === "local" ? "selected" : ""}><input type="radio" name="viral-visual-recognition-mode" value="local" checked={viralVisualRecognitionMode === "local"} disabled={viralUploadBusy} onChange={() => setViralVisualRecognitionMode("local")} /><span><strong>本地识别（默认）</strong><small>安装包内置 {localClipModel.approximateSize}模型；如缺失会自动补全，不调 API、不产生 API 费用</small></span></label>
                <label className={viralVisualRecognitionMode === "api" ? "selected" : ""}><input type="radio" name="viral-visual-recognition-mode" value="api" checked={viralVisualRecognitionMode === "api"} disabled={viralUploadBusy} onChange={() => setViralVisualRecognitionMode("api")} /><span><strong>API 识别（更准）</strong><small>复用“设置 → API 配置”中的视觉模型；视频只上传代表帧</small></span></label>
              </div>
              <p>两种方式均在低置信度或识别失败时自动归入“人工标注”。</p>
            </section>
            <label className="viral-upload-sync-option"><input type="checkbox" checked={viralUploadSyncData} disabled={viralUploadBusy} onChange={(event) => { setViralUploadSyncData(event.target.checked); setViralUploadError(""); }} />同时导入 CSV 中的画面数据（可选）</label>
            {viralUploadSyncData && <div className="viral-upload-data-fields" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={(event) => { event.preventDefault(); const file = Array.from(event.dataTransfer.files).find((item) => /\.csv$/i.test(item.name)); const csvPath = file && window.desktopBridge?.mediaPathForFile?.(file); if (csvPath) void loadViralDataCsv(csvPath).catch((failure) => setViralUploadError(desktopErrorMessage(failure, "CSV 读取失败"))); else setViralUploadError("请拖入 CSV 格式的数据文件"); }}>
              <p>选择或拖入 CSV。用文件名／路径精确匹配画面；只保存你选中的展示字段，不调用千川 API。</p>
              <button type="button" disabled={viralUploadBusy} onClick={() => void loadViralDataCsv().catch((failure) => setViralUploadError(desktopErrorMessage(failure, "CSV 读取失败")))}><FileSpreadsheet size={14} />{viralDataCsvInspection ? "更换 CSV" : "选择 CSV 文件"}</button>
              {viralDataCsvInspection && <>
                <strong>{viralDataCsvInspection.fileName} · {viralDataCsvInspection.rowCount} 行</strong>
                <label>匹配画面的列<select value={viralDataCsvMatchColumn} disabled={viralUploadBusy} onChange={(event) => {
                  const nextColumn = Number(event.target.value);
                  const previousColumn = viralDataCsvMatchColumn;
                  setViralDataCsvMatchColumn(nextColumn);
                  setViralDataCsvDisplayColumns((current) => current.includes(nextColumn)
                    ? defaultViralDisplayColumns(viralDataCsvInspection.headers, [nextColumn, viralUploadCopyColumn])
                    : [...new Set([...current.filter((index) => index !== nextColumn), ...(previousColumn >= 0 && previousColumn !== nextColumn ? [previousColumn] : [])])].slice(0, 4));
                }}><option value={-1}>请选择文件名或路径列</option>{viralDataCsvInspection.headers.map((header, index) => <option key={`${header}-${index}`} value={index}>{header}</option>)}</select></label>
                <label>画面类型列<select value={viralDataCsvVisualTypeColumn} disabled={viralUploadBusy} onChange={(event) => {
                  const nextColumn = Number(event.target.value);
                  setViralDataCsvVisualTypeColumn(nextColumn);
                  setViralDataCsvDisplayColumns((current) => current.includes(nextColumn)
                    ? defaultViralDisplayColumns(viralDataCsvInspection.headers, [viralDataCsvMatchColumn, viralUploadCopyColumn, nextColumn])
                    : current.filter((index) => index !== nextColumn));
                }}><option value={-1}>没有此列，自动识别默认分类</option>{viralDataCsvInspection.headers.map((header, index) => <option key={`visual-type-${header}-${index}`} value={index}>{header}</option>)}</select></label>
                <div className="viral-upload-display-fields">
                  <header><span>打开画面后显示的字段</span><button type="button" disabled={viralUploadBusy} onClick={() => setViralDataCsvDisplayColumns(defaultViralDisplayColumns(viralDataCsvInspection.headers, [viralDataCsvMatchColumn, viralUploadCopyColumn, viralDataCsvVisualTypeColumn]))}>恢复推荐 4 项</button></header>
                  <p>默认优先选择消耗、ROI、成交金额、3 秒播放／完播类指标共 4 项；仍可手动删除或补充字段。</p>
                  <div className="viral-upload-field-chips">{viralDataCsvDisplayColumns.map((column) => <button type="button" key={`${viralDataCsvInspection.headers[column]}-${column}`} disabled={viralUploadBusy} aria-label={`删除展示字段：${viralDataCsvInspection.headers[column]}`} onClick={() => setViralDataCsvDisplayColumns((current) => current.filter((item) => item !== column))}><span>{viralDataCsvInspection.headers[column]}</span><X size={12} /></button>)}{!viralDataCsvDisplayColumns.length && <small>已移除全部展示字段</small>}</div>
                  {viralDataCsvInspection.headers.some((_, index) => index !== viralDataCsvMatchColumn && !viralDataCsvDisplayColumns.includes(index)) && <label>重新添加字段<select value="" disabled={viralUploadBusy} onChange={(event) => { const column = Number(event.target.value); if (column >= 0) setViralDataCsvDisplayColumns((current) => [...new Set([...current, column])].sort((left, right) => left - right)); }}><option value="">选择已移除的字段</option>{viralDataCsvInspection.headers.map((header, index) => index !== viralDataCsvMatchColumn && !viralDataCsvDisplayColumns.includes(index) ? <option key={`${header}-${index}`} value={index}>{header}</option> : null)}</select></label>}
                </div>
                <div className="viral-upload-csv-preview"><span>前 {viralDataCsvInspection.previewRows.length} 行预览</span>{viralDataCsvInspection.previewRows.map((row, index) => <div key={index}>{row.join(" · ")}</div>)}</div>
              </>}
            </div>}
            <label className="viral-upload-sync-option"><input type="checkbox" checked={viralUploadSyncCopy} disabled={viralUploadBusy} onChange={(event) => { setViralUploadSyncCopy(event.target.checked); setViralUploadError(""); if (event.target.checked && (!viralUploadSyncData || !viralDataCsvInspection)) setViralUploadCopySource("local"); }} />同步文案到爆款文案库（可选）</label>
            {viralUploadSyncCopy && <fieldset className="viral-upload-copy-source">
              <legend>文案来源</legend>
              <label className={!viralUploadSyncData || !viralDataCsvInspection ? "disabled" : ""}><input type="radio" name="viral-upload-copy-source" value="csv" checked={viralUploadCopySource === "csv"} disabled={viralUploadBusy || !viralUploadSyncData || !viralDataCsvInspection} onChange={() => setViralUploadCopySource("csv")} /><span><strong>使用 CSV 已有文案字段</strong><small>按匹配行同步，不会自动改写原文</small></span></label>
              <label><input type="radio" name="viral-upload-copy-source" value="local" checked={viralUploadCopySource === "local"} disabled={viralUploadBusy} onChange={() => setViralUploadCopySource("local")} /><span><strong>本机生成文案</strong><small>仅处理视频，使用本机转写组件；图片会跳过</small></span></label>
              {viralUploadCopySource === "csv" && viralDataCsvInspection && <label className="viral-upload-copy-column"><span>选择文案字段</span><select value={viralUploadCopyColumn} disabled={viralUploadBusy} onChange={(event) => setViralUploadCopyColumn(Number(event.target.value))}><option value={-1}>请选择文案列</option>{viralDataCsvInspection.headers.map((header, index) => <option key={`${header}-${index}`} value={index}>{header}</option>)}</select></label>}
            </fieldset>}
            {viralUploadProgress && <p className="viral-upload-progress" role="status">{viralUploadProgress}</p>}
            {viralUploadError && <div className="viral-csv-error" role="alert"><AlertTriangle size={14} />{viralUploadError}</div>}
            <div className="modal-actions"><button type="button" disabled={viralUploadBusy} onClick={() => setViralUploadSelection(null)}>取消</button><button type="button" className="primary" disabled={viralUploadBusy || (viralUploadSyncData && (!viralDataCsvInspection || viralDataCsvMatchColumn < 0)) || (viralUploadSyncCopy && viralUploadCopySource === "csv" && (!viralUploadSyncData || !viralDataCsvInspection || viralDataCsvMatchColumn < 0 || viralUploadCopyColumn < 0))} onClick={() => void confirmViralVisualUpload()}>{viralUploadBusy ? "正在上传…" : "确认上传"}</button></div>
          </div>
        </div>
      )}

      {vipAvailable && viralCsvInspection && (
        <div className="modal-backdrop" onMouseDown={() => { if (!viralCsvImportBusy) setViralCsvInspection(null); }}>
          <div className="compact-modal viral-csv-mapping-modal" role="dialog" aria-modal="true" aria-labelledby="viral-csv-mapping-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" disabled={viralCsvImportBusy} onClick={() => setViralCsvInspection(null)}><X size={18} /></button>
            <div className="compact-modal-icon"><FileSpreadsheet size={20} /></div>
            <h2 id="viral-csv-mapping-title">CSV 字段对应</h2>
            <p>{viralCsvInspection.fileName} 共 {viralCsvInspection.rowCount} 行。外显数据默认推荐 4 项并可手动增减；分类字段仍可独立多选。“画面路径”和“文案”至少选一项。</p>
            <div className="viral-csv-fields">
              {viralCsvMappingFields.map((field) => <label key={field.key}><span><strong>{field.label}</strong><small>{field.hint}</small></span><select value={viralCsvColumns[field.key]} onChange={(event) => { const column = Number(event.target.value); setViralCsvColumns((current) => field.key === "majorCategory" ? { ...current, majorCategory: column, category: current.category.filter((item) => item !== column) } : { ...current, [field.key]: column }); }}><option value={-1}>不导入此字段</option>{viralCsvInspection.headers.map((header, index) => <option key={`${field.key}-${index}`} value={index}>{header}</option>)}</select></label>)}
            </div>
            <div className="viral-upload-display-fields viral-copy-data-fields">
              <header><span>文案卡片显示的数据字段</span><button type="button" disabled={viralCsvImportBusy} onClick={() => setViralCsvColumns((current) => ({ ...current, data: defaultViralDisplayColumns(viralCsvInspection.headers, [current.media, current.copy, current.associationId, current.majorCategory, current.title, ...current.category]) }))}>恢复推荐 4 项</button></header>
              <p>默认优先选择消耗、ROI、成交金额、3 秒播放／完播类指标共 4 项；仍可手动删除或补充，不影响其他字段映射。</p>
              <div className="viral-upload-field-chips">{viralCsvColumns.data.map((column) => <button type="button" key={`${viralCsvInspection.headers[column]}-${column}`} disabled={viralCsvImportBusy} aria-label={`删除文案数据字段：${viralCsvInspection.headers[column]}`} onClick={() => setViralCsvColumns((current) => ({ ...current, data: current.data.filter((item) => item !== column) }))}><span>{viralCsvInspection.headers[column]}</span><X size={12} /></button>)}{!viralCsvColumns.data.length && <small>已移除全部数据字段</small>}</div>
              {viralCsvInspection.headers.some((_, index) => !viralCsvColumns.data.includes(index)) && <label>重新添加字段<select value="" disabled={viralCsvImportBusy} onChange={(event) => { const column = Number(event.target.value); if (column >= 0) setViralCsvColumns((current) => ({ ...current, data: [...new Set([...current.data, column])].sort((left, right) => left - right) })); }}><option value="">选择已移除的字段</option>{viralCsvInspection.headers.map((header, index) => !viralCsvColumns.data.includes(index) ? <option key={`${header}-${index}`} value={index}>{header}</option> : null)}</select></label>}
            </div>
            <label className="viral-major-category-field"><span>统一大分类（可选；仅用于 CSV 行未填大分类时）</span><input value={viralCsvMajorCategoryFallback} maxLength={100} onChange={(event) => setViralCsvMajorCategoryFallback(event.target.value)} placeholder="输入本次导入的大分类名称" /></label>
            <fieldset className="viral-csv-category-fields">
              <legend>细分类字段（可多选）</legend>
              <p>勾选任意列，最多 24 列；每条文案会保留各列的字段名和实际值。已用作大分类的列不能重复勾选。</p>
              <div>{viralCsvInspection.headers.map((header, index) => <label key={`${header}-${index}`}>
                <input type="checkbox" checked={viralCsvColumns.category.includes(index)} disabled={index === viralCsvColumns.majorCategory || (!viralCsvColumns.category.includes(index) && viralCsvColumns.category.length >= 24)} onChange={(event) => setViralCsvColumns((current) => index === current.majorCategory ? current : { ...current, category: event.target.checked ? [...current.category, index].sort((a, b) => a - b) : current.category.filter((item) => item !== index) })} />
                <span><strong>{header}</strong><small>{viralCsvInspection.previewRows[0]?.[index] || "首行为空"}</small></span>
              </label>)}</div>
            </fieldset>
            <div className="viral-csv-confirm-option copy-confirm-option"><label title={VIRAL_COPY_CONFIRM_HELP}><input type="checkbox" checked={viralCsvConfirmed} disabled={viralCsvImportBusy || viralCsvColumns.copy < 0} onChange={(event) => setViralCsvConfirmed(event.target.checked)} />导入文案时标记为已确认</label><span className="copy-confirm-help" tabIndex={0} title={VIRAL_COPY_CONFIRM_HELP} aria-label={VIRAL_COPY_CONFIRM_HELP} data-tooltip={VIRAL_COPY_CONFIRM_HELP}>?</span>{viralCsvColumns.copy < 0 && <small>未选择文案列时不可勾选</small>}</div>
            <div className="viral-csv-preview"><strong>数据预览（前 {viralCsvInspection.previewRows.length} 行）</strong><div><table><thead><tr>{viralCsvInspection.headers.map((header, index) => <th key={`${header}-${index}`}>{header}</th>)}</tr></thead><tbody>{viralCsvInspection.previewRows.map((row, rowIndex) => <tr key={rowIndex}>{viralCsvInspection.headers.map((_, columnIndex) => <td key={columnIndex}>{row[columnIndex] || "—"}</td>)}</tr>)}</tbody></table></div></div>
            {viralCsvImportError && <div className="viral-csv-error" role="alert"><AlertTriangle size={14} />{viralCsvImportError}</div>}
            <div className="modal-actions"><button disabled={viralCsvImportBusy} onClick={() => setViralCsvInspection(null)}>取消</button><button className="primary" disabled={viralCsvImportBusy || (viralCsvColumns.media < 0 && viralCsvColumns.copy < 0)} onClick={() => void confirmViralCsvImport()}>{viralCsvImportBusy ? "正在导入…" : "确认导入"}</button></div>
          </div>
        </div>
      )}

      {purgeOpen && (
        <div className="modal-backdrop" onMouseDown={() => setPurgeOpen(false)}>
          <div className="compact-modal danger-modal" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setPurgeOpen(false)}><X size={18} /></button>
            <div className="compact-modal-icon"><Trash2 size={20} /></div>
            <h2>永久清空回收站？</h2>
            <p>将永久删除 {assets.filter((asset) => asset.deleted).length} 条素材记录，此操作无法撤销。</p>
            <div className="modal-actions"><button onClick={() => setPurgeOpen(false)}>取消</button><button className="danger-confirm" onClick={() => { setAssets((current) => current.filter((asset) => !asset.deleted)); setPurgeOpen(false); notify("回收站已清空"); }}>永久删除</button></div>
          </div>
        </div>
      )}

      <UpdateDialog key={updateState.targetVersion || "no-update"} state={updateState} notify={notify} />

      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </main>
  );
}

export default function Home() {
  const [licenseState, setLicenseState] = useState<LicenseState>(initialLicenseState);

  useEffect(() => {
    let active = true;
    const bridge = window.desktopBridge;
    const isLocalBrowserPreview = process.env.NODE_ENV === "development" && !bridge;
    if (isLocalBrowserPreview) {
      queueMicrotask(() => {
        if (active) setLicenseState({
          ...initialLicenseState,
          previewAllFeatures: true,
          phase: "active",
          authorized: true,
          message: "",
          license: {
            entitlementSchemaVersion: 1,
            baseExpiresAt: "2099-01-01T00:00:00Z",
            vipExpiresAt: "2099-01-01T00:00:00Z",
            basePermanent: false,
            redemptionProtocolVersion: 1,
          } as LicenseState["license"],
        });
      });
      return () => { active = false; };
    }
    if (!bridge?.licenseBootstrap) {
      queueMicrotask(() => {
        if (active) setLicenseState({
          ...initialLicenseState,
          phase: "configuration_error",
          message: "在线授权仅支持 AI媒体库桌面客户端",
        });
      });
      return () => { active = false; };
    }
    bridge.licenseOnStateChanged?.((next) => {
      if (active) setLicenseState(next);
    });
    bridge.licenseBootstrap()
      .then((next) => { if (active) setLicenseState(next); })
      .catch(() => {
        if (active) setLicenseState({ ...initialLicenseState, phase: "network_error", message: "授权服务初始化失败，请重新启动软件" });
      });
    return () => { active = false; };
  }, []);

  return (
    <LicenseGate state={licenseState} onStateChange={setLicenseState}>
      <LicensedApplication licenseState={licenseState} onLicenseStateChange={setLicenseState} />
    </LicenseGate>
  );
}
