import { createServer } from "node:http";
import { copyFile, readFile, writeFile, mkdir, stat, readdir, rename, rm } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const root = resolve(import.meta.dirname);
const packagedResourcesRoot = process.resourcesPath || root;
const writableRoot = process.env.SKILL_STUDIO_DATA_DIR ? resolve(process.env.SKILL_STUDIO_DATA_DIR) : root;
const outputDir = join(writableRoot, "outputs");
const uploadDir = join(writableRoot, "uploads");
const dataDir = join(writableRoot, "data");
const secureConfigPath = process.env.SECURE_CONFIG_PATH || join(dataDir, "secure-config.json");
const submissionsPath = join(dataDir, "dreamina-submissions.json");
const appStatePath = join(dataDir, "app-state.json");
const assetManifestPath = join(dataDir, "asset-manifest.json");
const imageAttemptsPath = join(dataDir, "image-attempts.json");
const voiceAttemptsPath = join(dataDir, "voice-attempts.json");
const voicesPath = join(dataDir, "voices.json");
const voicesBackupPath = join(dataDir, "voices.backup.json");
// 1 = 旧版可合成音色；2 = 仅试听模式，存量记录已标记为历史记录。
const VOICE_STORE_SCHEMA_VERSION = 2;
const LEGACY_VOICE_STATUS = "历史记录（合成已停用）";
const LEGACY_VOICE_NOTICE = "这条记录由旧版本创建。当前版本只生成可下载的试听音频，已不再提供语音合成，因此无法再用它合成新音频。已保存的试听文件仍可播放和下载。";
const digitalModelsPath = join(dataDir, "digital-models.json");
const digitalModelsUploadDir = join(uploadDir, "digital-models");
const imageReferenceCacheDir = join(dataDir, "image-reference-cache");
const assetManifestVersion = 3;
const apiProtocolVersion = 5;
const remakeAnalysisVersion = 2;
const imageReferenceLimit = Number(process.env.IMAGE_REFERENCE_LIMIT || 12);
const imageReferenceNormalizeThresholdBytes = Number(
  process.env.IMAGE_REFERENCE_NORMALIZE_THRESHOLD_BYTES || 4 * 1024 * 1024
);
const imageReferenceMaxSide = Number(process.env.IMAGE_REFERENCE_MAX_SIDE || 1600);
const dreaminaReferenceLimit = Number(process.env.DREAMINA_REFERENCE_LIMIT || 9);
const dreaminaFallbackCreditPerSecond = Number(process.env.DREAMINA_FALLBACK_CREDIT_PER_SECOND || 9);
let assetManifestMutationQueue = Promise.resolve();
let voiceStoreMutationQueue = Promise.resolve();
let digitalModelMutationQueue = Promise.resolve();
let imageAttemptMutationQueue = Promise.resolve();
let voiceAttemptMutationQueue = Promise.resolve();
const imageReferenceNormalizationJobs = new Map();
// A browser refresh, duplicate event listener, or transport retry must never
// submit the same provider request twice. The key uses the full ownership
// tuple rather than a title or file name.
const imageAttemptInFlight = new Map();
const imageAttemptResults = new Map();
const imageAttemptResultLimit = 1000;
// Keep a dedicated journal and lock so a double click, refresh, or transport
// retry cannot submit the same MiniMax request twice.
const voiceAttemptInFlight = new Map();
const voiceAttemptResults = new Map();
const voiceAttemptResultLimit = 1000;
let assertVoiceFeatureAccess = null;

export function configureVoiceAuthorization(assertAccess) {
  if (typeof assertAccess !== "function") throw new TypeError("声音服务授权检查器必须是函数");
  assertVoiceFeatureAccess = assertAccess;
}

function isProtectedBusinessPath(pathname) {
  // This port has no activation, updater, health-check, or other public route.
  // Fail closed for unknown/static paths as well, so adding a new route cannot
  // silently create an authorization bypass.
  return typeof pathname === "string";
}

function requireVoiceFeatureAccess(pathname) {
  if (!isProtectedBusinessPath(pathname)) return;
  if (!assertVoiceFeatureAccess) {
    const error = new Error("声音服务授权检查尚未就绪");
    error.status = 503;
    error.code = "authorization_not_ready";
    throw error;
  }
  try {
    assertVoiceFeatureAccess();
  } catch (cause) {
    const error = new Error("当前授权无权使用声音功能");
    error.status = 403;
    error.code = "feature_not_entitled";
    error.cause = cause;
    throw error;
  }
}

loadDotEnv(join(root, ".env"));
const secureConfig = loadSecureConfigSync();

const config = {
  apiBaseUrl:
    process.env.CCG_API_BASE_URL ||
    secureConfig.CCG_API_BASE_URL ||
    process.env.COOL_API_BASE_URL ||
    secureConfig.COOL_API_BASE_URL ||
    "https://ccg-cli.online/v1",
  apiKey:
    process.env.CCG_API_KEY ||
    secureConfig.CCG_API_KEY ||
    process.env.COOL_API_KEY ||
    secureConfig.COOL_API_KEY ||
    "",
  minimaxApiBaseUrl: normalizeMinimaxApiBaseUrl(
    process.env.MINIMAX_API_BASE_URL || secureConfig.MINIMAX_API_BASE_URL || "https://api.minimaxi.com/v1"
  ),
  minimaxApiKey: process.env.MINIMAX_API_KEY || secureConfig.MINIMAX_API_KEY || "",
  minimaxGroupId: process.env.MINIMAX_GROUP_ID || secureConfig.MINIMAX_GROUP_ID || "",
  minimaxTtsModel: process.env.MINIMAX_TTS_MODEL || secureConfig.MINIMAX_TTS_MODEL || "speech-2.8-turbo",
  textModel: process.env.TEXT_MODEL || secureConfig.TEXT_MODEL || "gpt-5.5",
  visionModel:
    process.env.VISION_MODEL ||
    secureConfig.VISION_MODEL ||
    process.env.TEXT_MODEL ||
    secureConfig.TEXT_MODEL ||
    "gpt-5.5",
  imageModel: process.env.IMAGE_MODEL || secureConfig.IMAGE_MODEL || "gpt-image-2",
  port: Number(process.env.PORT || 8787),
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".txt": "text/plain; charset=utf-8",
};

await mkdir(outputDir, { recursive: true });
await mkdir(uploadDir, { recursive: true });
await mkdir(dataDir, { recursive: true });
await mkdir(imageReferenceCacheDir, { recursive: true });

// 声音库索引损坏时不应拖垮整个服务，迁移失败就保持原样，下次启动再试。
try {
  const migratedVoiceCount = await migrateVoiceStoreToPreviewOnly();
  if (migratedVoiceCount) {
    console.log(`voice store migrated to preview-only: ${migratedVoiceCount} legacy record(s)`);
  }
} catch (error) {
  console.warn("voice store migration skipped:", error?.message || error);
}

function createVoiceServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      // The second loopback port is reachable without going through Electron's
      // primary HTTP proxy. Reuse the primary LicenseService decision before any
      // API, output, or upload business path can read data or cause side effects.
      requireVoiceFeatureAccess(url.pathname);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      await serveStatic(req, res, url.pathname);
    } catch (error) {
      sendJson(res, Number(error?.status || 500), {
        error: error?.code || "server_error",
        message: error?.message || "服务端处理失败",
      });
    }
  });
}

let server = createVoiceServer();
let serverHasStarted = false;

export async function startServer() {
  if (server.listening) return Promise.resolve(server);
  // Node permits close/listen reuse in simple cases, but connections that are
  // winding down can make the first request after a license transition reset.
  // A fresh Server keeps the request guard while avoiding stale sockets.
  if (serverHasStarted) server = createVoiceServer();
  serverHasStarted = true;
  return new Promise((resolveStart, rejectStart) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectStart(error);
    };
    const onListening = () => {
      server.off("error", onError);
      console.log(`Video Skill Studio running at http://localhost:${config.port}/`);
      resolveStart(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, "127.0.0.1");
  });
}

await startServer();

export { server };
export { isProtectedBusinessPath };

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      apiProtocolVersion,
      apiConfigured: Boolean(config.apiKey),
      secureConfigLoaded: Boolean(secureConfig.CCG_API_KEY || secureConfig.COOL_API_KEY),
      baseUrl: config.apiBaseUrl,
      textModel: config.textModel,
      visionModel: config.visionModel,
      imageModel: config.imageModel,
      minimaxConfigured: Boolean(config.minimaxApiKey),
      minimaxBaseUrl: config.minimaxApiBaseUrl,
      minimaxTtsModel: config.minimaxTtsModel,
      minimaxGroupId: config.minimaxGroupId,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config") {
    const body = await readJson(req, 64 * 1024);
    const minimaxBaseUrl = normalizeMinimaxApiBaseUrl(body.minimaxBaseUrl || config.minimaxApiBaseUrl);
    const minimaxTtsModel = String(body.minimaxTtsModel || config.minimaxTtsModel || "speech-2.8-turbo").trim();
    const minimaxGroupId = String(body.minimaxGroupId ?? config.minimaxGroupId ?? "").trim();
    const minimaxApiKey = String(body.minimaxApiKey || "").trim();
    if (!minimaxTtsModel) {
      const error = new Error("请填写 MiniMax 语音模型");
      error.status = 400;
      throw error;
    }
    config.minimaxApiBaseUrl = minimaxBaseUrl;
    config.minimaxTtsModel = minimaxTtsModel;
    config.minimaxGroupId = minimaxGroupId;
    secureConfig.MINIMAX_API_BASE_URL = minimaxBaseUrl;
    secureConfig.MINIMAX_TTS_MODEL = minimaxTtsModel;
    secureConfig.MINIMAX_GROUP_ID = minimaxGroupId;
    if (minimaxApiKey) {
      config.minimaxApiKey = minimaxApiKey;
      secureConfig.MINIMAX_API_KEY = minimaxApiKey;
    }
    await saveSecureConfig();
    sendJson(res, 200, {
      ok: true,
      minimaxConfigured: Boolean(config.minimaxApiKey),
      minimaxBaseUrl: config.minimaxApiBaseUrl,
      minimaxTtsModel: config.minimaxTtsModel,
      minimaxGroupId: config.minimaxGroupId,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/test-minimax") {
    const body = await readJson(req, 64 * 1024);
    const baseUrl = normalizeMinimaxApiBaseUrl(body.minimaxBaseUrl || config.minimaxApiBaseUrl);
    const apiKey = String(body.minimaxApiKey || config.minimaxApiKey || "").trim();
    const groupId = String(body.minimaxGroupId ?? config.minimaxGroupId ?? "").trim();
    if (!apiKey) {
      const error = new Error("请填写 MiniMax API Key");
      error.status = 400;
      throw error;
    }
    const providerUrl = new URL(`${baseUrl.replace(/\/+$/, "")}/get_voice`);
    if (groupId) providerUrl.searchParams.set("GroupId", groupId);
    let providerResponse;
    try {
      providerResponse = await fetch(providerUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({ voice_type: "system" }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (error?.name === "TimeoutError") {
        const timeoutError = new Error("MiniMax 连接超时，请检查网络或接口地址");
        timeoutError.status = 504;
        throw timeoutError;
      }
      throw error;
    }
    const providerResult = await providerResponse.json().catch(() => ({}));
    assertMinimaxResponse(providerResult, providerResponse.status, providerResponse.ok, "MiniMax 连接测试失败");
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/app-state") {
    sendJson(res, 200, { ok: true, state: await readAppState() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/digital-models") {
    const store = await readDigitalModelStore();
    const search = String(url.searchParams.get("search") || "").trim().toLocaleLowerCase("zh-CN");
    const status = String(url.searchParams.get("status") || "").trim();
    const sort = String(url.searchParams.get("sort") || "recent").trim();
    const models = store.models
      .filter((model) => !search || model.name.toLocaleLowerCase("zh-CN").includes(search))
      .filter((model) => !status || status === "all" || model.status === status)
      .sort((left, right) => compareDigitalModels(left, right, sort))
      .map(publicDigitalModel);
    sendJson(res, 200, { ok: true, models });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/digital-models") {
    const body = await readJson(req, 112 * 1024 * 1024);
    const model = await createDigitalModel(body);
    sendJson(res, 201, { ok: true, model: publicDigitalModel(model) });
    return;
  }

  const digitalModelMatch = url.pathname.match(/^\/api\/digital-models\/([^/]+)$/);
  if (digitalModelMatch && req.method === "GET") {
    const model = await getDigitalModel(decodeURIComponent(digitalModelMatch[1]));
    sendJson(res, 200, { ok: true, model: publicDigitalModel(model) });
    return;
  }

  if (digitalModelMatch && req.method === "PATCH") {
    const body = await readJson(req, 24 * 1024 * 1024);
    const model = await updateDigitalModel(decodeURIComponent(digitalModelMatch[1]), body);
    sendJson(res, 200, { ok: true, model: publicDigitalModel(model) });
    return;
  }

  if (digitalModelMatch && req.method === "DELETE") {
    await deleteDigitalModel(decodeURIComponent(digitalModelMatch[1]));
    sendJson(res, 200, { ok: true });
    return;
  }

  const digitalModelImagesMatch = url.pathname.match(/^\/api\/digital-models\/([^/]+)\/images$/);
  if (digitalModelImagesMatch && req.method === "POST") {
    const body = await readJson(req, 112 * 1024 * 1024);
    const model = await addDigitalModelImages(decodeURIComponent(digitalModelImagesMatch[1]), body);
    sendJson(res, 200, { ok: true, model: publicDigitalModel(model) });
    return;
  }

  if (digitalModelImagesMatch && req.method === "PATCH") {
    const body = await readJson(req);
    const model = await arrangeDigitalModelImages(decodeURIComponent(digitalModelImagesMatch[1]), body);
    sendJson(res, 200, { ok: true, model: publicDigitalModel(model) });
    return;
  }

  const digitalModelImageMatch = url.pathname.match(/^\/api\/digital-models\/([^/]+)\/images\/([^/]+)$/);
  if (digitalModelImageMatch && req.method === "DELETE") {
    const model = await deleteDigitalModelImage(
      decodeURIComponent(digitalModelImageMatch[1]),
      decodeURIComponent(digitalModelImageMatch[2])
    );
    sendJson(res, 200, { ok: true, model: publicDigitalModel(model) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/voices") {
    const store = await readVoiceStore();
    sendJson(res, 200, {
      ok: true,
      voices: store.voices
        .map(publicVoiceItem)
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/voice-clone/create") {
    const body = await readJson(req);
    try {
      const result = await runVoiceAttempt({
        operation: "voice_clone",
        attemptId: requireVoiceAttemptId(body.attemptId),
        title: "生成声音试听",
        execute: () => createMinimaxVoiceClone(body),
      });
      sendJson(res, result.status, result.payload);
    } catch (error) {
      sendJson(res, Number(error?.status || 502), {
        ok: false,
        error: error?.code || "voice_clone_failed",
        message: normalizePublicError(error, "试听生成失败，请检查音频样本后重试。"),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/voice-clone/generate") {
    sendJson(res, 410, {
      ok: false,
      error: "voice_synthesis_disabled",
      message: "当前为只生成试听模式，不会正式启用或继续合成 MiniMax 音色。",
    });
    return;
  }

  const voicePatchMatch = url.pathname.match(/^\/api\/voices\/([^/]+)$/);
  if (voicePatchMatch && req.method === "PATCH") {
    const body = await readJson(req);
    try {
      const voice = await renameVoiceItem(voicePatchMatch[1], body.name);
      sendJson(res, 200, { ok: true, voice: publicVoiceItem(voice) });
    } catch (error) {
      sendJson(res, Number(error?.status || 400), {
        ok: false,
        error: error?.code || "voice_update_failed",
        message: error?.message || "声音重命名失败",
      });
    }
    return;
  }

  if (voicePatchMatch && req.method === "DELETE") {
    try {
      await deleteVoiceItem(voicePatchMatch[1]);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, Number(error?.status || 400), {
        ok: false,
        error: error?.code || "voice_delete_failed",
        message: error?.message || "声音删除失败",
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/app-state") {
    const body = await readJson(req);
    const state = body?.state && typeof body.state === "object" ? body.state : body;
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      sendJson(res, 400, { error: "invalid_state", message: "state is required" });
      return;
    }
    await writeAppState(state);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/models") {
    requireApiKey();
    const response = await fetch(`${config.apiBaseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    const data = await response.json();
    sendJson(res, response.status, data);
    return;
  }

  if (
    req.method === "POST" &&
    ["/api/uploads/products", "/api/uploads/portraits", "/api/uploads/scenes"].includes(url.pathname)
  ) {
    const body = await readJson(req);
    const files = Array.isArray(body.files) ? body.files : [];
    const kind = url.pathname.endsWith("/portraits")
      ? "portrait"
      : url.pathname.endsWith("/scenes")
        ? "scene"
        : "product";
    const projectId = requireIdentityValue(body.projectId, "projectId");
    const workflowId = requireIdentityValue(body.workflowId, "workflowId");
    const workflowType = requireWorkflowType(body.workflowType);
    if (kind === "scene" && workflowType !== "remake") {
      const error = new Error("场景替换参考图只允许绑定到视频复刻工作流");
      error.status = 409;
      error.code = "workflow_type_mismatch";
      throw error;
    }
    const branchId = storageScopeSegment(body.branchId, kind);
    const assetType = kind === "portrait"
      ? "portrait_upload"
      : kind === "scene"
        ? "scene_reference_upload"
        : "product_upload";
    const scopedUploadDir = join(uploadDir, "projects", projectId, workflowId, branchId);
    const publicUploadPrefix = `/uploads/projects/${projectId}/${workflowId}/${branchId}/`;
    await mkdir(scopedUploadDir, { recursive: true });
    const items = [];
    for (const [index, file] of files.entries()) {
      let parsed;
      try {
        parsed = parseDataUrl(file.dataUrl);
      } catch {
        continue;
      }
      const defaultName = kind === "portrait"
        ? `人物替换图${index + 1}`
        : kind === "scene"
          ? `场景替换图${index + 1}`
          : `产品替换图${index + 1}`;
      const originalName = String(file.name || defaultName).trim();
      const ext = extensionForMime(parsed.mimeType) || extname(originalName) || ".png";
      const assetId = requireIdentityValue(file.assetId, "assetId");
      const fileName = `${Date.now()}-${assetId}-${slugify(originalName)}-${randomUUID().slice(0, 8)}${ext}`;
      const filePath = join(scopedUploadDir, fileName);
      await writeFile(filePath, parsed.buffer);
      const item = {
        id: assetId,
        assetId,
        assetType,
        projectId,
        workflowId,
        workflowType,
        branchId,
        name: originalName || fileName,
        url: `${publicUploadPrefix}${fileName}`,
      };
      items.push(item);
      await upsertAssetManifest({
        ...item,
        path: item.url,
        status: "ready",
        sourceKind: "upload",
        createdAt: new Date().toISOString(),
      });
    }
    sendJson(
      res,
      200,
      kind === "portrait" ? { portraits: items } : kind === "scene" ? { scenes: items } : { products: items }
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/digital-models/bind-to-workflow") {
    const body = await readJson(req);
    const projectId = requireIdentityValue(body.projectId, "projectId");
    const workflowId = requireIdentityValue(body.workflowId, "workflowId");
    const workflowType = requireWorkflowType(body.workflowType);
    const branchId = storageScopeSegment(body.branchId, "digital-employees");
    assertDigitalEmployeeBindingScope(workflowType, branchId);
    const modelId = requireIdentityValue(body.digitalModelId, "digitalModelId");
    const roleKey = String(body.roleKey || "").trim().slice(0, 120);
    if (!roleKey) {
      const error = new Error("请先选择数字角色要应用的当前工作流角色");
      error.status = 400;
      error.code = "digital_employee_role_required";
      throw error;
    }
    const binding = await bindDigitalModelToWorkflow({
      projectId,
      workflowId,
      workflowType,
      branchId,
      modelId,
      roleKey,
    });
    sendJson(res, 201, { ok: true, ...binding });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/assets") {
    const projectId = requireIdentityValue(url.searchParams.get("projectId"), "projectId");
    const workflowId = requireIdentityValue(url.searchParams.get("workflowId"), "workflowId");
    const workflowType = requireWorkflowType(url.searchParams.get("workflowType"));
    const manifest = await readAssetManifest();
    sendJson(res, 200, {
      assets: manifest.assets.filter(
        (asset) =>
          asset.projectId === projectId &&
          asset.workflowId === workflowId &&
          asset.workflowType === workflowType
      ),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/remake/reconcile-uploads") {
    const body = await readJson(req);
    const projectId = requireIdentityValue(body.projectId, "projectId");
    const workflowId = requireIdentityValue(body.workflowId, "workflowId");
    const workflowType = requireWorkflowType(body.workflowType);
    if (workflowType !== "remake") {
      const error = new Error("历史上传补登记只允许用于视频复刻工作流");
      error.status = 409;
      error.code = "workflow_type_mismatch";
      throw error;
    }
    const expectedBranches = {
      product_upload: "remake-products",
      portrait_upload: "remake-portraits",
      scene_reference_upload: "remake-scenes",
    };
    const assets = Array.isArray(body.assets) ? body.assets : [];
    const reconciled = [];
    for (const asset of assets) {
      const assetId = requireIdentityValue(asset.assetId, "assetId");
      const assetType = requireIdentityValue(asset.assetType, "assetType");
      const branchId = expectedBranches[assetType];
      if (!branchId) {
        const error = new Error(`资产 ${assetId} 不是可补登记的复刻上传类型`);
        error.status = 400;
        error.code = "invalid_reconcile_asset_type";
        throw error;
      }
      if (
        asset.projectId !== projectId ||
        asset.workflowId !== workflowId ||
        asset.workflowType !== workflowType
      ) {
        const error = new Error(`资产 ${assetId} 不属于当前复刻项目工作流`);
        error.status = 409;
        error.code = "asset_scope_mismatch";
        throw error;
      }
      const path = requireAssetPathValue(asset.path || asset.url, "asset.path");
      const expectedPrefix = `/uploads/projects/${projectId}/${workflowId}/${branchId}/`;
      if (!path.startsWith(expectedPrefix)) {
        const error = new Error(`资产 ${assetId} 的复刻分支身份不匹配`);
        error.status = 409;
        error.code = "asset_branch_mismatch";
        throw error;
      }
      const filePath = resolveOutputAssetPath(path);
      if (!filePath || !existsSync(filePath)) {
        const error = new Error(`资产 ${assetId} 的上传文件不存在`);
        error.status = 404;
        error.code = "asset_file_missing";
        throw error;
      }
      const record = await upsertAssetManifest({
        projectId,
        workflowId,
        workflowType,
        branchId,
        assetId,
        assetType,
        name: String(asset.name || basename(filePath)),
        path,
        status: "ready",
        sourceKind: "reconciled_upload",
        reconciledAt: new Date().toISOString(),
      });
      reconciled.push(record);
    }
    sendJson(res, 200, { assets: reconciled });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/uploads/videos") {
    const body = await readJson(req);
    const files = Array.isArray(body.files) ? body.files : [];
    const projectId = requireIdentityValue(body.projectId, "projectId");
    const workflowId = requireIdentityValue(body.workflowId, "workflowId");
    const workflowType = requireWorkflowType(body.workflowType);
    if (workflowType !== "remake") {
      const error = new Error("参考视频只允许绑定到视频复刻工作流");
      error.status = 409;
      error.code = "workflow_type_mismatch";
      throw error;
    }
    const branchId = storageScopeSegment(body.branchId, "remake-video");
    const scopedUploadDir = join(uploadDir, "projects", projectId, workflowId, branchId);
    const publicUploadPrefix = `/uploads/projects/${projectId}/${workflowId}/${branchId}/`;
    await mkdir(scopedUploadDir, { recursive: true });
    const items = [];
    for (const [index, file] of files.entries()) {
      let parsed;
      try {
        parsed = parseDataUrl(file.dataUrl);
      } catch {
        continue;
      }
      if (!String(parsed.mimeType || "").toLowerCase().startsWith("video/")) continue;
      const defaultName = `参考视频${index + 1}`;
      const originalName = String(file.name || defaultName).trim();
      const ext = extensionForMime(parsed.mimeType) || extname(originalName) || ".mp4";
      const assetId = requireIdentityValue(file.assetId, "assetId");
      const fileName = `${Date.now()}-${assetId}-${slugify(originalName)}-${randomUUID().slice(0, 8)}${ext}`;
      const filePath = join(scopedUploadDir, fileName);
      await writeFile(filePath, parsed.buffer);
      const item = {
        id: assetId,
        assetId,
        assetType: "reference_video_upload",
        projectId,
        workflowId,
        workflowType,
        branchId,
        name: originalName || fileName,
        url: `${publicUploadPrefix}${fileName}`,
      };
      items.push(item);
      await upsertAssetManifest({
        ...item,
        path: item.url,
        status: "ready",
        sourceKind: "upload",
        createdAt: new Date().toISOString(),
      });
    }
    sendJson(res, 200, { videos: items });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/remake/analyze-video") {
    const body = await readJson(req);
    const projectId = requireIdentityValue(body.projectId, "projectId");
    const workflowId = requireIdentityValue(body.workflowId, "workflowId");
    const workflowType = requireWorkflowType(body.workflowType);
    if (workflowType !== "remake") {
      const error = new Error("视频解析只允许在视频复刻工作流中运行");
      error.status = 409;
      error.code = "workflow_type_mismatch";
      throw error;
    }
    const attemptId = requireIdentityValue(body.attemptId, "attemptId");
    const [videoAsset] = await validateStoredAssetReferences(
      [body.videoAsset],
      { projectId, workflowId, workflowType, allowedTypes: ["reference_video_upload"] },
      1
    );
    const videoPath = videoAsset?.filePath || "";
    if (!videoPath || !existsSync(videoPath)) {
      sendJson(res, 400, { error: "video_not_found", message: "没有找到已上传的参考视频，请重新上传一次。" });
      return;
    }
    const duration = Math.max(1, Number(body.duration || 0));
    const segmentSeconds = clampInt(body.segmentSeconds, 4, 30, 10);
    const productInfo = body.productInfo && typeof body.productInfo === "object" ? body.productInfo : {};
    try {
      const result = await analyzeRemakeVideoFrames({
        videoPath,
        duration,
        segmentSeconds,
        productInfo,
        projectId,
        workflowId,
        workflowType,
        attemptId,
      });
      sendJson(res, result.ok ? 200 : 501, result);
    } catch (error) {
      sendJson(res, 200, makeFallbackRemakeAnalysisResult({ duration, segmentSeconds, error }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/remake/frame-sheet") {
    const body = await readJson(req);
    const projectId = requireIdentityValue(body.projectId, "projectId");
    const workflowId = requireIdentityValue(body.workflowId, "workflowId");
    const workflowType = requireWorkflowType(body.workflowType);
    const segmentId = requireIdentityValue(body.segmentId, "segmentId");
    const assetId = requireIdentityValue(body.assetId, "assetId");
    const attemptId = requireIdentityValue(body.attemptId, "attemptId");
    if (workflowType !== "remake") {
      sendJson(res, 409, {
        error: "workflow_type_mismatch",
        message: "原片关键帧整图只允许在视频复刻工作流中生成。",
      });
      return;
    }
    const frameReferences = Array.isArray(body.frames) ? body.frames : [];
    if (!frameReferences.length) {
      sendJson(res, 400, {
        error: "missing_remake_frames",
        message: "当前提交段没有可用于拼接的原片关键帧。",
      });
      return;
    }
    const frameAssetIds = frameReferences.map((frame) => requireIdentityValue(frame?.assetId, "frame.assetId"));
    if (new Set(frameAssetIds).size !== frameAssetIds.length) {
      sendJson(res, 409, {
        error: "duplicate_remake_frames",
        message: "原片关键帧身份重复，已阻止生成整图。",
      });
      return;
    }
    const frames = await validateStoredAssetReferences(
      frameReferences,
      { projectId, workflowId, workflowType, allowedTypes: ["remake_frame"] },
      100
    );
    if (frames.length !== frameReferences.length) {
      sendJson(res, 409, {
        error: "incomplete_remake_frames",
        message: "原片关键帧没有被完整读取，已阻止生成整图。",
      });
      return;
    }
    const asset = await createRemakeFrameSheet({
      frames,
      projectId,
      workflowId,
      workflowType,
      segmentId,
      assetId,
      attemptId,
    });
    sendJson(res, 200, { ok: true, asset });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/remake/search-product") {
    const body = await readJson(req);
    try {
      const result = await searchRemakeProductName(body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        error: "search_failed",
        message: normalizePublicError(error, "联网搜索旧品名失败，请稍后重试或手动填写。"),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/remake/optimize-dialogue") {
    requireApiKey();
    const body = await readJson(req);
    const projectId = requireIdentityValue(body.projectId, "projectId");
    const workflowId = requireIdentityValue(body.workflowId, "workflowId");
    const workflowType = requireWorkflowType(body.workflowType);
    if (workflowType !== "remake") {
      sendJson(res, 409, { error: "workflow_type_mismatch", message: "总口播优化只允许在视频复刻工作流中运行。" });
      return;
    }
    try {
      const result = await optimizeRemakeDialogue({ ...body, projectId, workflowId, workflowType });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, Number(error?.status || 502), {
        ok: false,
        error: error?.code || "dialogue_optimization_failed",
        message: normalizeTextModelError(error, "总口播优化失败，请稍后重试。"),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/generate-image") {
    requireApiKey();
    const body = await readJson(req);
    const prompt = String(body.prompt || "").trim();
    const projectId = requireIdentityValue(body.projectId, "projectId");
    const workflowId = requireIdentityValue(body.workflowId, "workflowId");
    const workflowType = requireWorkflowType(body.workflowType);
    const assetId = requireIdentityValue(body.assetId, "assetId");
    const assetType = requireIdentityValue(body.assetType, "assetType");
    const attemptId = requireIdentityValue(body.attemptId, "attemptId");
    const segmentId = String(body.segmentId || "").trim();
    const assetTitle = String(body.assetTitle || "generated-image");
    if (!prompt) {
      sendJson(res, 400, { error: "missing_prompt", message: "prompt is required" });
      return;
    }
    if (!["role", "scene", "storyboard", "review"].includes(assetType)) {
      sendJson(res, 400, { error: "invalid_asset_type", message: "图片类型不受支持，已阻止生成。" });
      return;
    }
    if (assetType === "storyboard" && !segmentId) {
      sendJson(res, 400, { error: "missing_segment_id", message: "故事面板缺少分镜 ID，已阻止生成。" });
      return;
    }
    const startedAt = new Date().toISOString();
    const referenceImages = await validateInlineReferenceImages(
      Array.isArray(body.referenceImages) ? body.referenceImages : [],
      { projectId, workflowId, workflowType, segmentId }
    );
    const requestedReferenceAssetIds = normalizeReferenceAssetIds(body.referenceAssetIds);
    const requiredReferenceAssetIds = normalizeReferenceAssetIds(body.requiredReferenceAssetIds);
    const actualReferenceAssetIds = referenceImages.map((image) => image.assetId);
    assertReferenceAssetIdsMatch(
      requestedReferenceAssetIds,
      actualReferenceAssetIds,
      "请求声明的参考图与实际读取到的参考图不一致，已阻止生成。"
    );
    if (requiredReferenceAssetIds.length) {
      assertRequiredReferenceAssetIdsIncluded(
        requiredReferenceAssetIds,
        actualReferenceAssetIds,
        "角色绑定的人像参考没有被完整提交，已阻止无参考生图。"
      );
    }
    const imageAttemptKey = buildImageAttemptKey({
      projectId,
      workflowId,
      workflowType,
      assetId,
      assetType,
      segmentId,
      attemptId,
    });
    const completedAttempt = imageAttemptResults.get(imageAttemptKey);
    if (completedAttempt) {
      console.warn(`[image] duplicate-completed project=${projectId} workflow=${workflowId} asset=${assetId} attempt=${attemptId}`);
      sendJson(res, completedAttempt.status, completedAttempt.payload);
      return;
    }
    const persistedAttempt = await findPersistedImageAttempt(imageAttemptKey);
    if (persistedAttempt?.state === "completed" && persistedAttempt.result) {
      console.warn(`[image] duplicate-persisted project=${projectId} workflow=${workflowId} asset=${assetId} attempt=${attemptId}`);
      sendJson(res, persistedAttempt.result.status, persistedAttempt.result.payload);
      return;
    }
    if (persistedAttempt?.state === "processing") {
      console.warn(`[image] duplicate-stale-processing project=${projectId} workflow=${workflowId} asset=${assetId} attempt=${attemptId}`);
      sendJson(res, 409, {
        error: "image_attempt_state_unknown",
        message: "该图片任务上次提交后状态未确认。为避免重复调用 API，已停止自动重发；请点击“重新生成”创建新任务。",
      });
      return;
    }
    const inFlightAttempt = imageAttemptInFlight.get(imageAttemptKey);
    if (inFlightAttempt) {
      console.warn(`[image] duplicate-inflight project=${projectId} workflow=${workflowId} asset=${assetId} attempt=${attemptId}`);
      const result = await inFlightAttempt;
      sendJson(res, result.status, result.payload);
      return;
    }
    // Claim the full attempt identity before asynchronous provider work begins.
    let resolveInFlightAttempt;
    const inFlightPromise = new Promise((resolveAttempt) => {
      resolveInFlightAttempt = resolveAttempt;
    });
    imageAttemptInFlight.set(imageAttemptKey, inFlightPromise);
    try {
      await markImageAttemptProcessing(imageAttemptKey, {
        projectId,
        workflowId,
        workflowType,
        assetId,
        assetType,
        segmentId,
        attemptId,
        startedAt,
      });
    } catch (error) {
      imageAttemptInFlight.delete(imageAttemptKey);
      resolveInFlightAttempt({
        status: 500,
        payload: { error: "image_attempt_journal_failed", message: "图片任务审计记录失败，已阻止提交以避免重复调用 API。" },
      });
      sendJson(res, 500, { error: "image_attempt_journal_failed", message: "图片任务审计记录失败，已阻止提交以避免重复调用 API。" });
      return;
    }
    let imageAttemptFinished = false;
    const finishImageAttempt = (status, payload) => {
      if (imageAttemptFinished) return;
      imageAttemptFinished = true;
      const result = { status, payload };
      rememberImageAttemptResult(imageAttemptKey, result);
      imageAttemptInFlight.delete(imageAttemptKey);
      resolveInFlightAttempt(result);
      void markImageAttemptCompleted(imageAttemptKey, result).catch((error) => {
        console.error(`[image] attempt-journal-write-failed attempt=${attemptId} error=${String(error?.message || error)}`);
      });
      sendJson(res, status, payload);
    };
    let imageResponse;
    const referenceBytes = referenceImages.reduce((total, image) => total + Number(image.byteLength || 0), 0);
    const requestStartedAt = Date.now();
    console.info(
      `[image] start project=${projectId} workflow=${workflowId} asset=${assetId} attempt=${attemptId} refs=${referenceImages.length} bytes=${referenceBytes}`
    );
    try {
      imageResponse = referenceImages.length
        ? await callImageEdits({ prompt, referenceImages, size: body.size, model: body.model })
        : await callImageGenerations({ prompt, size: body.size, model: body.model });
      console.info(
        `[image] response project=${projectId} workflow=${workflowId} asset=${assetId} attempt=${attemptId} status=${imageResponse.status} elapsedMs=${Date.now() - requestStartedAt}`
      );
      const data = await safeResponseJson(imageResponse);
      if (!imageResponse.ok) {
        const providerMessage = data?.error?.message || data?.message || imageResponse.statusText || "图片生成失败";
        finishImageAttempt(imageResponse.status, {
          error: "image_generation_failed",
          message: providerMessage,
          reason: classifyImageFailure(providerMessage, imageResponse.status),
          riskyTerms: detectPromptRiskTerms(prompt),
          provider: scrubProviderResponse(data),
        });
        return;
      }

      const first = data?.data?.[0] || {};
      const scopedOutputDir = join(outputDir, "projects", projectId, workflowId);
      const publicOutputPrefix = `/outputs/projects/${projectId}/${workflowId}/`;
      await mkdir(scopedOutputDir, { recursive: true });
      const fileName = `${Date.now()}-${assetId}-${slugify(assetTitle)}-${randomUUID().slice(0, 8)}.png`;
      const filePath = join(scopedOutputDir, fileName);
      if (first.b64_json) {
        await writeFile(filePath, Buffer.from(first.b64_json, "base64"));
      } else if (first.url) {
        let remote;
        try {
          remote = await fetch(first.url);
        } catch (error) {
          finishImageAttempt(502, buildImageRequestFailure(error, prompt, "生成结果下载失败，请稍后重试。"));
          return;
        }
        if (!remote.ok) {
          finishImageAttempt(502, {
            error: "image_download_failed",
            message: `生成结果下载失败：${remote.status}`,
            reason: "network",
            riskyTerms: detectPromptRiskTerms(prompt),
          });
          return;
        }
        await writeFile(filePath, Buffer.from(await remote.arrayBuffer()));
      } else {
        finishImageAttempt(502, {
          error: "image_payload_missing",
          message: "图片服务没有返回可保存的图片，已停止本次任务。",
        });
        return;
      }

      const completedAt = new Date().toISOString();
      const assetRecord = {
        projectId,
        workflowId,
        workflowType,
        assetId,
        assetType,
        segmentId,
        attemptId,
        path: `${publicOutputPrefix}${fileName}`,
        status: "ready",
        sourceKind: "generated",
        referenceAssetIds: actualReferenceAssetIds,
        referenceImageNames: referenceImages.map((image) => image.name),
        createdAt: startedAt,
        completedAt,
      };
      try {
        await upsertAssetManifest(assetRecord);
      } catch (error) {
        finishImageAttempt(Number(error?.status || 500), {
          error: error?.code || "asset_manifest_failed",
          message: error?.message || "图片已返回但资产登记失败，已停止后续重试。",
        });
        return;
      }

      finishImageAttempt(200, {
        output: `${publicOutputPrefix}${fileName}`,
        asset: assetRecord,
        usage: data.usage || null,
        startedAt,
        completedAt,
      });
      return;
    } catch (error) {
      console.error(
        `[image] failed project=${projectId} workflow=${workflowId} asset=${assetId} attempt=${attemptId} elapsedMs=${Date.now() - requestStartedAt} error=${String(error?.message || error)}`
      );
      finishImageAttempt(Number(error?.status || 502), buildImageRequestFailure(error, prompt));
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/dreamina/status") {
    const version = await runDreamina(["version"], { timeout: 10000, allowFailure: true });
    const credit = await runDreamina(["user_credit"], { timeout: 15000, allowFailure: true });
    const error = buildDreaminaStatusMessage(version, credit);
    sendJson(res, 200, {
      cliAvailable: version.ok,
      loggedIn: credit.ok,
      version: version.ok ? version.output : "",
      credit: credit.ok ? credit.output : "",
      error,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dreamina/submissions") {
    const submissions = await readSubmissions();
    sendJson(res, 200, { submissions: submissions.slice(-100).reverse() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dreamina/login/start") {
    const body = await readJson(req);
    const force = Boolean(body.force);
    const result = await runDreamina([force ? "relogin" : "login", "--headless"], { timeout: 30000, allowFailure: true });
    const auth = parseDreaminaLogin(result.output);
    const openedExternal = auth.verificationUri ? await openExternalUrl(auth.verificationUri) : false;
    sendJson(res, result.ok ? 200 : 500, {
      ok: result.ok,
      ...auth,
      openedExternal,
      message: result.ok ? "" : formatDreaminaCliError(result.output),
      raw: result.output,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/open-external") {
    const body = await readJson(req);
    const targetUrl = String(body.url || "").trim();
    const opened = await openExternalUrl(targetUrl);
    sendJson(res, opened ? 200 : 400, {
      ok: opened,
      message: opened ? "已调用系统默认浏览器打开链接。" : "链接没有打开，请复制链接到浏览器。",
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dreamina/login/check") {
    const body = await readJson(req);
    const deviceCode = String(body.deviceCode || "").trim();
    if (!deviceCode) {
      sendJson(res, 400, { error: "missing_device_code", message: "deviceCode is required" });
      return;
    }
    const result = await runDreamina(["login", "checklogin", `--device_code=${deviceCode}`, "--poll=0"], { timeout: 15000, allowFailure: true });
    sendJson(res, result.ok ? 200 : 409, {
      ok: result.ok,
      message: result.ok ? "" : "授权尚未完成。请在浏览器完成即梦登录后，再点击“完成授权检查”。",
      output: result.ok ? result.output : "",
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dreamina/submit-segment") {
    const body = await readJson(req);
    const prompt = String(body.prompt || "").trim();
    const projectId = requireIdentityValue(body.projectId, "projectId");
    const workflowId = requireIdentityValue(body.workflowId, "workflowId");
    const workflowType = requireWorkflowType(body.workflowType);
    const workflowTitle = String(body.workflowTitle || "").trim();
    const segmentId = requireIdentityValue(body.segmentId, "segmentId");
    const attemptId = requireIdentityValue(body.attemptId, "attemptId");
    const segmentLabel = String(body.segmentLabel || "").trim();
    const duration = clampInt(body.duration, 4, 15, 5);
    const ratio = String(body.ratio || "9:16");
    const modelVersion = String(body.modelVersion || "seedance2.0mini");
    const videoResolution = String(body.videoResolution || "720p");
    const poll = clampInt(body.poll, 0, 900, 0);
    const promptAsset = validatePromptAssetReference(body.promptAsset, { projectId, workflowId, workflowType, segmentId });
    const imageAssets = await validateStoredAssetReferences(
      Array.isArray(body.images) ? body.images : [],
      { projectId, workflowId, workflowType, segmentId },
      dreaminaReferenceLimit
    );
    const audioAssets = await validateStoredAssetReferences(
      Array.isArray(body.audios) ? body.audios : [],
      {
        projectId,
        workflowId,
        workflowType,
        segmentId,
        allowedTypes: ["digital_employee_voice"],
      },
      3
    );
    for (const asset of audioAssets) {
      const durationSeconds = Number(asset.duration || 0);
      if (!/\.(mp3|wav|m4a)$/i.test(String(asset.path || "")) || durationSeconds < 2 || durationSeconds > 15) {
        sendJson(res, 422, {
          error: "invalid_digital_voice_asset",
          message: "数字角色声音必须是 2-15 秒的 mp3、wav 或 m4a 文件；请在数字角色中更换声音后重试。",
        });
        return;
      }
    }
    const imagePaths = imageAssets.map((asset) => asset.filePath);
    const audioPaths = audioAssets.map((asset) => asset.filePath);
    if (!prompt) {
      sendJson(res, 400, { error: "missing_prompt", message: "prompt is required" });
      return;
    }
    if (!imagePaths.length) {
      sendJson(res, 400, { error: "missing_images", message: "至少需要一张已生成的参考图" });
      return;
    }
    const recordId = randomUUID();
    const record = {
      id: recordId,
      projectId,
      workflowId,
      workflowType,
      attemptId,
      workflowTitle,
      segmentId,
      segmentLabel,
      duration,
      ratio,
      modelVersion,
      videoResolution,
      dreaminaCost: 0,
      status: "submitting",
      promptPreview: prompt.slice(0, 200),
      promptAsset,
      imageAssets: imageAssets.map(stripResolvedAssetPath),
      audioAssets: audioAssets.map(stripResolvedAssetPath),
      startedAt: new Date().toISOString(),
      completedAt: "",
      submitId: "",
      genStatus: "",
      failReason: "",
      output: "",
      submitOutput: "",
      queryOutput: "",
      videos: [],
    };
    await upsertSubmission(record);
    const cliImagePaths = await prepareDreaminaInputFiles(imagePaths, recordId);
    const cliAudioPaths = await prepareDreaminaInputFiles(audioPaths, `${recordId}-audio`);
    const args = ["multimodal2video"];
    cliImagePaths.forEach((imagePath) => args.push("--image", imagePath));
    cliAudioPaths.forEach((audioPath) => args.push("--audio", audioPath));
    args.push("--prompt", prompt, `--duration=${duration}`, `--ratio=${ratio}`, `--video_resolution=${videoResolution}`, `--model_version=${modelVersion}`, `--poll=${poll}`);
    const downloadDir = join(tmpdir(), "video-skill-dreamina-downloads", recordId);
    await mkdir(downloadDir, { recursive: true });
    const beforeVideos = await listVideoFiles(downloadDir);
    const result = await runDreamina(args, { timeout: Math.max(60000, (poll + 30) * 1000), allowFailure: true });
    const parsed = parseDreaminaSubmit(result.output);
    const accepted = isDreaminaAcceptedSubmission(parsed);
    const query =
      accepted && (poll > 0 || isDreaminaCompletedStatus(parsed.genStatus))
        ? await queryDreaminaResult(parsed.submitId, downloadDir, beforeVideos, record)
        : null;
    const queryFailed = isDreaminaExplicitFailure(query?.parsed);
    const ok = accepted;
    const failMessage = !ok
      ? parsed.submitId
        ? formatDreaminaCliError(parsed.failReason || result.output)
        : "即梦命令没有返回任务 ID，系统已停止认领，避免绑定到其他项目的任务。请重新提交本分镜。"
      : queryFailed
        ? formatDreaminaCliError(query?.parsed?.failReason || query?.output)
        : "";
    const returnedVideos = query?.videos?.length
      ? query.videos
      : accepted
        ? await recoverDreaminaVideosFromSubmitOutput({ ...record, submitOutput: result.output }, record)
        : [];
    const completed = !ok || queryFailed || returnedVideos.length > 0;
    const nextRecord = {
      ...record,
      // A returned video is stronger evidence than a stale query error. Keep
      // the exact submission successful once its own scoped media is present.
      status: returnedVideos.length ? "success" : !ok || queryFailed ? "failed" : "submitted",
      completedAt: completed ? new Date().toISOString() : "",
      submitId: parsed.submitId || "",
      genStatus: query?.parsed?.genStatus || parsed.genStatus || "",
      failReason: returnedVideos.length ? "" : failMessage || query?.parsed?.failReason || parsed.failReason || "",
      output: result.output,
      submitOutput: result.output,
      queryOutput: query?.output || "",
      videos: returnedVideos,
    };
    nextRecord.dreaminaCost = getSubmissionDreaminaCost(nextRecord);
    await upsertSubmission({
      ...nextRecord,
    });
    const dreaminaUsage = calculateDreaminaUsage(await readSubmissions());
    // The client needs this exact record ID even for a rejected request, so it
    // can display the real reason without guessing a task from another project.
    sendJson(res, 200, {
      ok,
      message: failMessage,
      output: ok ? result.output : failMessage,
      parsed,
      query,
      videos: returnedVideos,
      submissionRecordId: recordId,
      dreaminaCost: nextRecord.dreaminaCost,
      dreaminaUsage,
      recovered: false,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dreamina/recover-submission") {
    const body = await readJson(req);
    const recordId = requireIdentityValue(body.submissionRecordId, "submissionRecordId");
    const projectId = requireIdentityValue(body.projectId, "projectId");
    const workflowId = requireIdentityValue(body.workflowId, "workflowId");
    const workflowType = requireWorkflowType(body.workflowType);
    const segmentId = requireIdentityValue(body.segmentId, "segmentId");
    const attemptId = requireIdentityValue(body.attemptId, "attemptId");
    const submissions = await readSubmissions();
    const submission = submissions.find(
      (item) =>
        item.id === recordId &&
        item.projectId === projectId &&
        item.workflowId === workflowId &&
        item.workflowType === workflowType &&
        item.segmentId === segmentId &&
        item.attemptId === attemptId
    );
    if (!submission) {
      sendJson(res, 409, {
        error: "submission_scope_mismatch",
        message: "没有找到与当前项目、工作流、分镜和本次提交完全一致的即梦记录，已停止恢复。",
      });
      return;
    }
    const parsed = parseDreaminaSubmit(submission.submitOutput || submission.output);
    if (!parsed.submitId) {
      sendJson(res, 200, {
        ok: false,
        recovered: false,
        parsed,
        message: "这次提交确实没有返回即梦任务 ID，无法安全恢复，也不会绑定到其他项目的任务。",
        submissionRecordId: submission.id,
      });
      return;
    }
    if (isDreaminaExplicitFailure(parsed)) {
      const message = formatDreaminaCliError(parsed.failReason || submission.output);
      await updateSubmissionByIdentity(submission, {
        status: "failed",
        completedAt: new Date().toISOString(),
        submitId: parsed.submitId,
        genStatus: parsed.genStatus || "failed",
        failReason: message,
      });
      const dreaminaUsage = calculateDreaminaUsage(await readSubmissions());
      sendJson(res, 200, { ok: false, recovered: false, parsed, message, submissionRecordId: submission.id, dreaminaUsage });
      return;
    }
    const downloadDir = join(tmpdir(), "video-skill-dreamina-downloads", submission.id);
    await mkdir(downloadDir, { recursive: true });
    const query = await queryDreaminaResult(parsed.submitId, downloadDir, await listVideoFiles(downloadDir), submission);
    const queryFailed = isDreaminaExplicitFailure(query.parsed);
    const videos = query.videos?.length ? query.videos : await recoverDreaminaVideosFromSubmitOutput(submission, submission);
    const recovered = videos.length > 0;
    const nextStatus = recovered ? "success" : queryFailed ? "failed" : "submitted";
    const message = recovered
      ? "已恢复本次即梦任务并绑定返回视频。"
      : queryFailed
      ? formatDreaminaCliError(query.parsed.failReason || query.output)
      : "已恢复本次即梦任务 ID，视频仍在生成或下载中。";
    await updateSubmissionByIdentity(submission, {
      status: nextStatus,
      completedAt: recovered || queryFailed ? new Date().toISOString() : "",
      submitId: parsed.submitId,
      genStatus: query.parsed?.genStatus || parsed.genStatus || "submitted",
      failReason: recovered ? "" : queryFailed ? message : "",
      queryOutput: query.output || submission.queryOutput || "",
      videos,
    });
    const dreaminaUsage = calculateDreaminaUsage(await readSubmissions());
    sendJson(res, 200, {
      ok: !queryFailed,
      recovered,
      message,
      parsed: { ...parsed, genStatus: query.parsed?.genStatus || parsed.genStatus || "submitted" },
      query,
      videos,
      submissionRecordId: submission.id,
      dreaminaUsage,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dreamina/stitch-videos") {
    const body = await readJson(req);
    const projectId = requireIdentityValue(body.projectId, "projectId");
    const workflowId = requireIdentityValue(body.workflowId, "workflowId");
    const workflowType = requireWorkflowType(body.workflowType);
    const assetId = requireIdentityValue(body.assetId, "assetId");
    const attemptId = requireIdentityValue(body.attemptId, "attemptId");
    const videoAssets = await validateStoredAssetReferences(
      Array.isArray(body.videos) ? body.videos : [],
      { projectId, workflowId, workflowType, allowedTypes: ["segment_video"] }
    );
    if (videoAssets.length < 2) {
      sendJson(res, 400, { error: "not_enough_videos", message: "至少需要 2 段已返回视频才能拼接" });
      return;
    }
    const stitched = await stitchVideos(videoAssets.map((asset) => asset.filePath), {
      projectId,
      workflowId,
      workflowType,
      assetId,
      attemptId,
      inputAssetIds: videoAssets.map((asset) => asset.assetId),
    });
    sendJson(res, stitched.ok ? 200 : 501, stitched);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dreamina/query-video") {
    const body = await readJson(req);
    const submitId = String(body.submitId || "").trim();
    const projectId = requireIdentityValue(body.projectId, "projectId");
    const workflowId = requireIdentityValue(body.workflowId, "workflowId");
    const workflowType = requireWorkflowType(body.workflowType);
    const segmentId = requireIdentityValue(body.segmentId, "segmentId");
    const attemptId = requireIdentityValue(body.attemptId, "attemptId");
    if (!submitId) {
      sendJson(res, 400, { error: "missing_submit_id", message: "submitId is required" });
      return;
    }
    const submissions = await readSubmissions();
    const submission = submissions.find(
      (item) =>
        item.submitId === submitId &&
        item.projectId === projectId &&
        item.workflowId === workflowId &&
        item.workflowType === workflowType &&
        item.segmentId === segmentId &&
        item.attemptId === attemptId
    );
    if (!submission) {
      sendJson(res, 409, {
        error: "submission_scope_mismatch",
        message: "没有找到与当前项目、工作流、分镜和本次提交完全一致的即梦记录，已停止回传。",
      });
      return;
    }
    const downloadDir = join(tmpdir(), "video-skill-dreamina-downloads", submission.id);
    await mkdir(downloadDir, { recursive: true });
    const beforeVideos = await listVideoFiles(downloadDir);
    const query = await queryDreaminaResult(submitId, downloadDir, beforeVideos, submission);
    const queryFailed = isDreaminaExplicitFailure(query.parsed);
    const videos = query.videos?.length ? query.videos : await recoverDreaminaVideosFromSubmitOutput(submission, submission);
    await updateSubmissionByIdentity(submission, {
      status: videos.length ? "success" : queryFailed ? "failed" : "querying",
      completedAt: videos.length || queryFailed ? new Date().toISOString() : "",
      genStatus: query.parsed?.genStatus || "",
      failReason: queryFailed ? formatDreaminaCliError(query.parsed?.failReason || query.output) : "",
      queryOutput: query.output || submission.queryOutput || "",
      videos,
    });
    const dreaminaUsage = calculateDreaminaUsage(await readSubmissions());
    sendJson(res, query.ok || videos.length ? 200 : 202, { ...query, videos, dreaminaUsage });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

async function createMinimaxVoiceClone(body = {}) {
  requireMinimaxApiKey();
  const name = normalizeVoiceName(body.name);
  const previewText = normalizeVoiceText(body.previewText);
  if (!body.consent) {
    const error = new Error("请先勾选声音授权确认");
    error.status = 400;
    error.code = "missing_consent";
    throw error;
  }
  const file = body.audio || {};
  const parsed = parseDataUrl(file.dataUrl);
  assertVoiceAudioFile({ fileName: file.name, mimeType: parsed.mimeType, size: parsed.buffer.length, duration: file.duration });

  const voiceId = randomUUID();
  const providerVoiceId = `vs_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const voiceDir = join(outputDir, "voices", voiceId);
  const uploadVoiceDir = join(uploadDir, "voices", voiceId);
  await mkdir(voiceDir, { recursive: true });
  await mkdir(uploadVoiceDir, { recursive: true });

  const ext = extensionForVoiceMime(parsed.mimeType, file.name);
  const sampleFileName = `sample-${Date.now()}${ext}`;
  const sampleFilePath = join(uploadVoiceDir, sampleFileName);
  await writeFile(sampleFilePath, parsed.buffer);
  const sampleAudioUrl = `/uploads/voices/${voiceId}/${sampleFileName}`;
  const now = new Date().toISOString();

  const baseVoice = {
    id: voiceId,
    name,
    provider: "minimax",
    providerVoiceId,
    providerFileId: "",
    sampleAudioUrl,
    previewText,
    previewAudioUrl: "",
    status: "生成失败",
    createdAt: now,
    activatedAt: "",
    lastUsedAt: "",
    errorMessage: "",
    audios: [],
  };

  try {
    const uploaded = await uploadMinimaxVoiceFile({
      buffer: parsed.buffer,
      mimeType: parsed.mimeType,
      fileName: String(file.name || `voice-sample${ext}`),
    });
    const providerFileId = extractMinimaxFileId(uploaded);
    if (!providerFileId) {
      throw new Error("MiniMax 没有返回文件 ID，请重新上传音频样本。");
    }
    const cloneResult = await cloneMinimaxVoice({ providerFileId, providerVoiceId, previewText });
    const previewBuffer = await extractMinimaxAudioBuffer(cloneResult);
    if (!previewBuffer?.length) {
      const error = new Error("MiniMax 没有返回可下载的试听音频，未发起正式语音合成。");
      error.status = 502;
      error.code = "minimax_preview_missing";
      throw error;
    }
    const audioRecord = await saveVoiceAudioBuffer({
      voiceId,
      buffer: previewBuffer,
      text: previewText,
      duration: Number(cloneResult?.extra_info?.audio_length || cloneResult?.data?.extra_info?.audio_length || 0),
      prefix: "preview",
      format: "mp3",
    });
    const completedAt = new Date().toISOString();
    const voice = {
      ...baseVoice,
      providerVoiceId: "",
      providerFileId: "",
      previewAudioUrl: audioRecord.audioUrl,
      status: "试听已生成",
      activatedAt: "",
      lastUsedAt: completedAt,
      audios: [audioRecord],
    };
    await upsertVoiceItem(voice);
    return { ok: true, voice: publicVoiceItem(voice), audio: audioRecord };
  } catch (error) {
    // 临时目录一律清掉，但失败痕迹要留在试听记录里，方便用户自查和客服定位。
    await Promise.allSettled([
      rm(voiceDir, { recursive: true, force: true }),
      rm(uploadVoiceDir, { recursive: true, force: true }),
    ]);
    const failedVoice = {
      ...baseVoice,
      // 目录已删除，对应的音频地址不再可用，避免界面挂出 404 链接。
      sampleAudioUrl: "",
      previewAudioUrl: "",
      // 与成功路径保持一致：不保留 MiniMax 音色与文件 ID。
      providerVoiceId: "",
      providerFileId: "",
      status: "生成失败",
      failedAt: new Date().toISOString(),
      errorMessage: normalizePublicError(error, "MiniMax 试听生成失败，请检查音频样本后重试。"),
    };
    // 写记录失败不应该掩盖真正的错误，因此单独兜住。
    await Promise.allSettled([upsertVoiceItem(failedVoice)]);
    throw error;
  }
}

async function uploadMinimaxVoiceFile({ buffer, mimeType, fileName }) {
  const form = new FormData();
  form.append("purpose", "voice_clone");
  form.append("file", new Blob([buffer], { type: mimeType }), fileName || "voice-sample.mp3");
  const response = await fetchWithRetry(buildMinimaxUrl("/files/upload"), {
    method: "POST",
    headers: minimaxHeaders(),
    body: form,
    timeoutMs: 10 * 60 * 1000,
  }, 0);
  const data = await safeResponseJson(response);
  assertMinimaxResponse(data, response.status, response.ok, "MiniMax 文件上传失败");
  return data;
}

async function cloneMinimaxVoice({ providerFileId, providerVoiceId, previewText }) {
  const response = await fetchWithRetry(buildMinimaxUrl("/voice_clone"), {
    method: "POST",
    headers: {
      ...minimaxHeaders(),
      "Content-Type": "application/json",
    },
    body: stringifyMinimaxCloneRequest({
      file_id: providerFileId,
      voice_id: providerVoiceId,
      text: previewText,
      model: config.minimaxTtsModel,
      need_noise_reduction: true,
      need_volume_normalization: true,
    }),
    timeoutMs: 10 * 60 * 1000,
  }, 0);
  const data = await safeResponseJson(response);
  assertMinimaxResponse(data, response.status, response.ok, "MiniMax 声音复刻失败");
  return data;
}

function stringifyMinimaxCloneRequest(payload) {
  const fileId = String(payload?.file_id || "").trim();
  if (!/^\d+$/.test(fileId)) {
    const error = new Error("MiniMax 返回的文件 ID 无效，请重新上传音频样本。");
    error.status = 502;
    error.code = "invalid_minimax_file_id";
    throw error;
  }
  const marker = "__MINIMAX_INT64_FILE_ID__";
  return JSON.stringify({ ...payload, file_id: marker }).replace(`"${marker}"`, fileId);
}

async function extractMinimaxAudioBuffer(data) {
  const candidates = [
    data?.demo_audio,
    data?.data?.demo_audio,
    data?.data?.audio,
    data?.audio,
    data?.data?.audio_file,
    data?.audio_file,
    data?.data?.url,
    data?.url,
  ].filter(Boolean);
  for (const value of candidates) {
    const text = String(value || "").trim();
    if (!text) continue;
    if (/^https?:\/\//i.test(text)) {
      const remote = await fetchWithRetry(text, { method: "GET", timeoutMs: 10 * 60 * 1000 }, 0);
      if (!remote.ok) continue;
      return Buffer.from(await remote.arrayBuffer());
    }
    if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) {
      return Buffer.from(text, "hex");
    }
    try {
      return Buffer.from(text, "base64");
    } catch {
      // Try next candidate.
    }
  }
  return Buffer.alloc(0);
}

async function saveVoiceAudioBuffer({ voiceId, buffer, text, duration, prefix, format = "mp3" }) {
  const audioId = randomUUID();
  const voiceDir = join(outputDir, "voices", voiceId);
  await mkdir(voiceDir, { recursive: true });
  const safeFormat = ["mp3", "wav", "flac"].includes(String(format).toLowerCase())
    ? String(format).toLowerCase()
    : "mp3";
  const fileName = `${prefix || "audio"}-${Date.now()}-${audioId.slice(0, 8)}.${safeFormat}`;
  await writeFile(join(voiceDir, fileName), buffer);
  return {
    id: audioId,
    voiceId,
    text,
    audioUrl: `/outputs/voices/${voiceId}/${fileName}`,
    duration: Number(duration || 0),
    format: safeFormat,
    createdAt: new Date().toISOString(),
  };
}

function buildMinimaxUrl(pathname) {
  const base = String(config.minimaxApiBaseUrl || "https://api.minimaxi.com/v1").replace(/\/+$/, "");
  const url = new URL(`${base}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
  if (config.minimaxGroupId && !url.searchParams.has("GroupId")) {
    url.searchParams.set("GroupId", config.minimaxGroupId);
  }
  return url.toString();
}

function normalizeMinimaxApiBaseUrl(value) {
  const base = String(value || "").trim().replace(/\/+$/, "");
  // Existing installs used the international host. Migrate them to the China API
  // because the bundled MiniMax key is issued by the China platform.
  if (base === "https://api.minimax.io/v1") return "https://api.minimaxi.com/v1";
  return base || "https://api.minimaxi.com/v1";
}

function minimaxHeaders() {
  return { Authorization: `Bearer ${config.minimaxApiKey}` };
}

function assertMinimaxResponse(data, status, httpOk, fallback) {
  const rawCode =
    data?.base_resp?.status_code ??
    data?.data?.base_resp?.status_code ??
    data?.status_code ??
    data?.code;
  const businessCode = rawCode === undefined || rawCode === null || rawCode === "" ? 0 : Number(rawCode);
  if (!httpOk || (Number.isFinite(businessCode) && businessCode !== 0)) {
    throw makeMinimaxError(data, status, fallback, businessCode);
  }
}

function makeMinimaxError(data, status, fallback, businessCode = 0) {
  const providerMessage =
    data?.base_resp?.status_msg ||
    data?.data?.base_resp?.status_msg ||
    data?.error?.message ||
    data?.message ||
    data?.status_msg ||
    fallback;
  const publicMessages = {
    1004: "MiniMax 鉴权失败，请检查 API Key 和接口区域。",
    2013: "MiniMax 拒绝了本次请求参数。软件已完成输入校验，请稍后重试；若仍失败，请检查 MiniMax 接口配置。",
    20132: "声音样本或音色 ID 无效，请重新上传样本后再试。",
    2037: "声音样本时长不符合要求，请上传 10 秒至 5 分钟的音频。",
    2039: "该音色标识已存在，请重新发起复刻。",
    2049: "MiniMax API Key 无效或与接口区域不匹配，请检查后端配置。",
    2056: "MiniMax 当前额度或并发资源不足，请稍后再试。",
  };
  const message = publicMessages[businessCode] || providerMessage || fallback;
  const error = new Error(message);
  error.status = Number(status) >= 400 ? Number(status) : 502;
  error.code = "minimax_failed";
  error.providerCode = businessCode || undefined;
  error.provider = data;
  return error;
}

function extractMinimaxFileId(data) {
  return String(
    data?.file_id ||
      data?.id ||
      data?.data?.file_id ||
      data?.data?.id ||
      data?.data?.file?.file_id ||
      data?.data?.file?.id ||
      data?.file?.file_id ||
      data?.file?.id ||
      data?.file_info?.file_id ||
      data?.data?.file_info?.file_id ||
      ""
  ).trim();
}

function requireMinimaxApiKey() {
  if (!config.minimaxApiKey) {
    const error = new Error("MiniMax API Key 未配置，请先在后端配置后再使用声音复刻。");
    error.status = 500;
    error.code = "minimax_api_missing";
    throw error;
  }
}

function normalizeVoiceName(value) {
  const name = String(value || "").trim();
  if (!name) {
    const error = new Error("请输入声音名称");
    error.status = 400;
    error.code = "missing_voice_name";
    throw error;
  }
  if ([...name].length > 20) {
    const error = new Error("声音名称最多 20 个字");
    error.status = 400;
    error.code = "voice_name_too_long";
    throw error;
  }
  return name;
}

function normalizeVoiceText(value) {
  const text = String(value || "").trim();
  if (!text) {
    const error = new Error("请输入试听文本");
    error.status = 400;
    error.code = "missing_voice_text";
    throw error;
  }
  if ([...text].length > 500) {
    const error = new Error("试听文本最多 500 字");
    error.status = 400;
    error.code = "voice_text_too_long";
    throw error;
  }
  return text;
}

function assertVoiceAudioFile({ fileName, mimeType, size, duration }) {
  const ext = extname(String(fileName || "")).toLowerCase();
  const mime = String(mimeType || "").toLowerCase();
  const allowedExts = new Set([".mp3", ".wav", ".m4a"]);
  const allowedMimes = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4", "audio/m4a", "audio/x-m4a"]);
  if (!allowedExts.has(ext) && !allowedMimes.has(mime)) {
    const error = new Error("文件格式不支持，请上传 mp3 / wav / m4a");
    error.status = 400;
    error.code = "unsupported_audio_format";
    throw error;
  }
  if (Number(size || 0) > 20 * 1024 * 1024) {
    const error = new Error("音频文件超过 20MB，请压缩后再上传");
    error.status = 400;
    error.code = "audio_too_large";
    throw error;
  }
  const seconds = Number(duration);
  if (Number.isFinite(seconds) && (seconds < 10 || seconds > 300)) {
    const error = new Error(seconds < 10 ? "音频时长不足 10 秒" : "音频时长超过 5 分钟");
    error.status = 400;
    error.code = "audio_duration_invalid";
    throw error;
  }
}

function extensionForVoiceMime(mimeType, fileName = "") {
  const ext = extname(String(fileName || "")).toLowerCase();
  if ([".mp3", ".wav", ".m4a"].includes(ext)) return ext;
  const value = String(mimeType || "").toLowerCase();
  if (value.includes("wav")) return ".wav";
  if (value.includes("mp4") || value.includes("m4a")) return ".m4a";
  return ".mp3";
}

async function readVoiceStoreFile(filePath) {
  const data = JSON.parse(await readFile(filePath, "utf8"));
  if (!data || typeof data !== "object" || !Array.isArray(data.voices)) {
    throw new Error("invalid voice store shape");
  }
  return { schemaVersion: Number(data.schemaVersion) || 1, voices: data.voices };
}

async function restoreVoiceStorePrimary(store) {
  await mkdir(dataDir, { recursive: true });
  const tempPath = `${voicesPath}.${process.pid}.${randomUUID()}.restore.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(store, null, 2));
    await rename(tempPath, voicesPath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

async function readVoiceStore() {
  try {
    return await readVoiceStoreFile(voicesPath);
  } catch (primaryError) {
    try {
      const backup = await readVoiceStoreFile(voicesBackupPath);
      await restoreVoiceStorePrimary(backup);
      return backup;
    } catch (backupError) {
      if (primaryError?.code === "ENOENT" && backupError?.code === "ENOENT") {
        return { schemaVersion: VOICE_STORE_SCHEMA_VERSION, voices: [] };
      }
      const error = new Error("声音库索引文件无法读取。为避免覆盖已有声音，系统已停止写入；请保留 voice-clone 数据目录并从备份恢复。");
      error.status = 500;
      error.code = "voice_store_unreadable";
      throw error;
    }
  }
}

async function writeVoiceStore(store) {
  await mkdir(dataDir, { recursive: true });
  const next = {
    schemaVersion: Number(store?.schemaVersion) || VOICE_STORE_SCHEMA_VERSION,
    voices: Array.isArray(store?.voices) ? store.voices : [],
  };
  const tempPath = `${voicesPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    if (existsSync(voicesPath)) {
      await copyFile(voicesPath, voicesBackupPath);
    }
    await writeFile(tempPath, JSON.stringify(next, null, 2));
    await rename(tempPath, voicesPath);
    if (!existsSync(voicesBackupPath)) {
      await copyFile(voicesPath, voicesBackupPath);
    }
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

async function mutateVoiceStore(mutator) {
  const operation = voiceStoreMutationQueue.then(async () => {
    const store = await readVoiceStore();
    const result = await mutator(store);
    await writeVoiceStore(store);
    return result;
  });
  voiceStoreMutationQueue = operation.catch(() => {});
  return operation;
}

async function upsertVoiceItem(voice) {
  return mutateVoiceStore((store) => {
    const index = store.voices.findIndex((item) => item.id === voice.id);
    if (index >= 0) store.voices[index] = voice;
    else store.voices.push(voice);
    return voice;
  });
}

// 一次性迁移：旧版本记录带着可用的 MiniMax 音色 ID 且状态为"已激活"，
// 但仅试听模式下已经没有任何合成入口，直接列出来会让用户以为功能坏了。
// providerVoiceId 按要求保留，日后恢复合成能力时仍可直接使用；
// publicVoiceItem 不会把它送到前端，因此界面上既看不到也用不到。
async function migrateVoiceStoreToPreviewOnly() {
  return mutateVoiceStore((store) => {
    if (Number(store.schemaVersion) >= VOICE_STORE_SCHEMA_VERSION) return 0;
    let migrated = 0;
    for (const voice of store.voices) {
      if (!voice || typeof voice !== "object") continue;
      if (!voice.providerVoiceId && voice.status !== "已激活") continue;
      voice.status = LEGACY_VOICE_STATUS;
      voice.legacyNotice = LEGACY_VOICE_NOTICE;
      voice.migratedAt = new Date().toISOString();
      migrated += 1;
    }
    store.schemaVersion = VOICE_STORE_SCHEMA_VERSION;
    return migrated;
  });
}

async function renameVoiceItem(id, name) {
  const nextName = normalizeVoiceName(name);
  return mutateVoiceStore((store) => {
    const voice = store.voices.find((item) => item.id === id);
    if (!voice) {
      const error = new Error("没有找到这个声音");
      error.status = 404;
      error.code = "voice_not_found";
      throw error;
    }
    voice.name = nextName;
    voice.updatedAt = new Date().toISOString();
    return voice;
  });
}

async function deleteVoiceItem(id) {
  return mutateVoiceStore((store) => {
    const before = store.voices.length;
    store.voices = store.voices.filter((item) => item.id !== id);
    if (store.voices.length === before) {
      const error = new Error("没有找到这个声音");
      error.status = 404;
      error.code = "voice_not_found";
      throw error;
    }
    return true;
  });
}

function publicVoiceItem(voice) {
  if (!voice) return null;
  return {
    id: voice.id,
    name: voice.name,
    provider: voice.provider || "minimax",
    sampleAudioUrl: voice.sampleAudioUrl || "",
    previewText: voice.previewText || "",
    previewAudioUrl: voice.previewAudioUrl || "",
    status: voice.status || "可能过期",
    createdAt: voice.createdAt || "",
    activatedAt: voice.activatedAt || "",
    lastUsedAt: voice.lastUsedAt || "",
    errorMessage: voice.errorMessage || "",
    legacyNotice: voice.legacyNotice || "",
    audios: Array.isArray(voice.audios) ? voice.audios.slice(-20) : [],
  };
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  if (requested.startsWith("/outputs/") || requested.startsWith("/uploads/")) {
    await serveWritableStatic(req, requested, res);
    return;
  }
  const filePath = normalize(join(root, requested));
  if (!isInsidePath(root, filePath)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    sendFile(req, res, filePath, info);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function serveWritableStatic(req, requested, res) {
  const baseDir = requested.startsWith("/outputs/") ? outputDir : uploadDir;
  const prefix = requested.startsWith("/outputs/") ? "/outputs/" : "/uploads/";
  const relativePath = requested.slice(prefix.length);
  const filePath = normalize(join(baseDir, relativePath));
  if (!isInsidePath(baseDir, filePath)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    sendFile(req, res, filePath, info);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function sendFile(req, res, filePath, info) {
  const contentType = mimeTypes[extname(filePath)] || "application/octet-stream";
  const range = req.headers.range;
  const extension = extname(filePath).toLowerCase();
  const headers = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    ...(extension === ".html" || extension === ".js" || extension === ".css"
      ? { "Cache-Control": "no-store, max-age=0", Pragma: "no-cache", Expires: "0" }
      : {}),
  };
  if (!range || !isRangeMediaFile(filePath)) {
    res.writeHead(200, { ...headers, "Content-Length": info.size });
    createReadStream(filePath).pipe(res);
    return;
  }
  const match = String(range).match(/bytes=(\d*)-(\d*)/);
  if (!match) {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${info.size}` });
    res.end();
    return;
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : info.size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= info.size) {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${info.size}` });
    res.end();
    return;
  }
  const safeEnd = Math.min(end, info.size - 1);
  res.writeHead(206, {
    ...headers,
    "Content-Length": safeEnd - start + 1,
    "Content-Range": `bytes ${start}-${safeEnd}/${info.size}`,
  });
  createReadStream(filePath, { start, end: safeEnd }).pipe(res);
}

async function readJson(req, maxBytes = Infinity) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      const error = new Error("上传内容过大，请减少图片数量或压缩图片后重试。");
      error.status = 413;
      error.code = "request_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.end(JSON.stringify(data));
}

function buildImageAttemptKey(identity = {}) {
  return [
    identity.projectId,
    identity.workflowId,
    identity.workflowType,
    identity.assetId,
    identity.assetType,
    identity.segmentId || "",
    identity.attemptId,
  ]
    .map((value) => String(value || "").trim())
    .join("|");
}

function requireVoiceAttemptId(value) {
  const attemptId = String(value || "").trim();
  if (!attemptId || attemptId.length > 200) {
    const error = new Error("声音任务缺少尝试 ID，已停止提交以避免重复调用 API。");
    error.status = 400;
    error.code = "missing_voice_attempt_id";
    throw error;
  }
  return attemptId;
}

function buildVoiceAttemptKey({ operation, attemptId, voiceId = "" } = {}) {
  return ["voice", operation, voiceId, attemptId].map((value) => String(value || "").trim()).join("|");
}

function rememberVoiceAttemptResult(key, result) {
  voiceAttemptResults.set(key, result);
  while (voiceAttemptResults.size > voiceAttemptResultLimit) {
    const oldestKey = voiceAttemptResults.keys().next().value;
    if (!oldestKey) break;
    voiceAttemptResults.delete(oldestKey);
  }
}

async function readVoiceAttemptJournal() {
  try {
    const parsed = JSON.parse(await readFile(voiceAttemptsPath, "utf8"));
    const attempts = Array.isArray(parsed?.attempts) ? parsed.attempts : [];
    return {
      version: 1,
      attempts: attempts.filter((attempt) => attempt && typeof attempt === "object").slice(-voiceAttemptResultLimit),
    };
  } catch {
    return { version: 1, attempts: [] };
  }
}

async function writeVoiceAttemptJournal(journal) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    voiceAttemptsPath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        attempts: (Array.isArray(journal?.attempts) ? journal.attempts : []).slice(-voiceAttemptResultLimit),
      },
      null,
      2
    )
  );
}

async function mutateVoiceAttemptJournal(mutator) {
  const operation = voiceAttemptMutationQueue.then(async () => {
    const journal = await readVoiceAttemptJournal();
    const result = await mutator(journal);
    await writeVoiceAttemptJournal(journal);
    return result;
  });
  voiceAttemptMutationQueue = operation.catch(() => undefined);
  return operation;
}

async function findPersistedVoiceAttempt(key) {
  const journal = await readVoiceAttemptJournal();
  return journal.attempts.find((attempt) => String(attempt?.key || "") === key) || null;
}

async function markVoiceAttemptProcessing(key, identity) {
  return mutateVoiceAttemptJournal((journal) => {
    const index = journal.attempts.findIndex((attempt) => String(attempt?.key || "") === key);
    const entry = {
      key,
      state: "processing",
      identity: { ...identity },
      startedAt: identity.startedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (index >= 0) journal.attempts[index] = entry;
    else journal.attempts.push(entry);
    return entry;
  });
}

async function markVoiceAttemptCompleted(key, result) {
  return mutateVoiceAttemptJournal((journal) => {
    const index = journal.attempts.findIndex((attempt) => String(attempt?.key || "") === key);
    if (index < 0) return null;
    journal.attempts[index] = {
      ...journal.attempts[index],
      state: "completed",
      result: {
        status: Number(result?.status || 500),
        payload: result?.payload || { error: "voice_attempt_result_missing", message: "声音任务结果不可用。" },
      },
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return journal.attempts[index];
  });
}

async function runVoiceAttempt({ operation, attemptId, title, voiceId = "", execute }) {
  const startedAt = new Date().toISOString();
  const attemptKey = buildVoiceAttemptKey({ operation, attemptId, voiceId });
  const completedAttempt = voiceAttemptResults.get(attemptKey);
  if (completedAttempt) return completedAttempt;
  const inFlightAttempt = voiceAttemptInFlight.get(attemptKey);
  if (inFlightAttempt) return inFlightAttempt;

  let resolveInFlightAttempt;
  const inFlightPromise = new Promise((resolveAttempt) => {
    resolveInFlightAttempt = resolveAttempt;
  });
  voiceAttemptInFlight.set(attemptKey, inFlightPromise);
  const identity = { operation, attemptId, voiceId, title, startedAt };
  const finish = async (status, payload) => {
    const result = { status, payload };
    rememberVoiceAttemptResult(attemptKey, result);
    voiceAttemptInFlight.delete(attemptKey);
    resolveInFlightAttempt(result);
    try {
      await markVoiceAttemptCompleted(attemptKey, result);
    } catch (error) {
      console.error(`[voice] attempt-journal-write-failed attempt=${attemptId} error=${String(error?.message || error)}`);
    }
    return result;
  };

  try {
    // Claim the in-memory lock before any asynchronous read so a duplicate
    // request cannot submit the same provider operation twice.
    const persistedAttempt = await findPersistedVoiceAttempt(attemptKey);
    if (persistedAttempt?.state === "completed" && persistedAttempt.result) {
      return finish(persistedAttempt.result.status, persistedAttempt.result.payload);
    }
    if (persistedAttempt?.state === "processing") {
      return finish(409, {
        error: "voice_attempt_state_unknown",
        message: "该声音任务上次提交后状态未确认。为避免重复调用 API，已停止自动重发；请重新点击操作按钮创建新任务。",
      });
    }
    await markVoiceAttemptProcessing(attemptKey, identity);
  } catch (error) {
    const result = {
      status: 500,
      payload: { error: "voice_attempt_journal_failed", message: "声音任务审计记录失败，已停止提交以避免重复调用 API。" },
    };
    voiceAttemptInFlight.delete(attemptKey);
    resolveInFlightAttempt(result);
    return result;
  }

  let output;
  try {
    output = await execute();
  } catch (error) {
    return finish(Number(error?.status || 502), {
      ok: false,
      error: error?.code || `${operation}_failed`,
      message: normalizePublicError(error, operation === "voice_clone" ? "声音复刻失败，请检查音频样本后重试。" : "试听音频生成失败，请稍后重试。"),
    });
  }

  const completedAt = new Date().toISOString();
  return finish(200, { ...output, startedAt, completedAt });
}

function rememberImageAttemptResult(key, result) {
  imageAttemptResults.set(key, result);
  while (imageAttemptResults.size > imageAttemptResultLimit) {
    const oldestKey = imageAttemptResults.keys().next().value;
    if (!oldestKey) break;
    imageAttemptResults.delete(oldestKey);
  }
}

async function readImageAttemptJournal() {
  try {
    const parsed = JSON.parse(await readFile(imageAttemptsPath, "utf8"));
    const attempts = Array.isArray(parsed?.attempts) ? parsed.attempts : [];
    return {
      version: 1,
      attempts: attempts.filter((attempt) => attempt && typeof attempt === "object").slice(-imageAttemptResultLimit),
    };
  } catch {
    return { version: 1, attempts: [] };
  }
}

async function writeImageAttemptJournal(journal) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    imageAttemptsPath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        attempts: (Array.isArray(journal?.attempts) ? journal.attempts : []).slice(-imageAttemptResultLimit),
      },
      null,
      2
    )
  );
}

async function findPersistedImageAttempt(key) {
  const journal = await readImageAttemptJournal();
  return journal.attempts.find((attempt) => String(attempt?.key || "") === key) || null;
}

async function mutateImageAttemptJournal(mutator) {
  const operation = imageAttemptMutationQueue.then(async () => {
    const journal = await readImageAttemptJournal();
    const result = await mutator(journal);
    await writeImageAttemptJournal(journal);
    return result;
  });
  imageAttemptMutationQueue = operation.catch(() => undefined);
  return operation;
}

async function markImageAttemptProcessing(key, identity) {
  return mutateImageAttemptJournal((journal) => {
    const index = journal.attempts.findIndex((attempt) => String(attempt?.key || "") === key);
    const entry = {
      key,
      state: "processing",
      identity: { ...identity },
      startedAt: identity.startedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (index >= 0) journal.attempts[index] = entry;
    else journal.attempts.push(entry);
    return entry;
  });
}

async function markImageAttemptCompleted(key, result) {
  return mutateImageAttemptJournal((journal) => {
    const index = journal.attempts.findIndex((attempt) => String(attempt?.key || "") === key);
    if (index < 0) return null;
    journal.attempts[index] = {
      ...journal.attempts[index],
      state: "completed",
      result: {
        status: Number(result?.status || 500),
        payload: result?.payload || { error: "image_attempt_result_missing", message: "图片任务结果不可用。" },
      },
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return journal.attempts[index];
  });
}

async function safeResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return { message: response.statusText || "上游返回了无法解析的内容" };
  }
}

function buildImageRequestFailure(error, prompt, fallbackMessage = "") {
  const rawMessage = error?.message || String(error);
  return {
    error: "image_request_failed",
    message: fallbackMessage || humanizeTransportError(rawMessage),
    reason: classifyImageFailure(rawMessage, 502),
    rawMessage,
    riskyTerms: detectPromptRiskTerms(prompt),
  };
}

function humanizeTransportError(message) {
  const text = String(message || "");
  if (/abort|timeout|timed out/i.test(text)) return "图片接口等待太久没有返回，已中断。可以直接重试。";
  if (/fetch failed|socket|network|ECONN|ETIMEDOUT|UND_ERR/i.test(text)) return "图片接口连接中断，不是明确违规。请直接重试，或稍后再试。";
  return "图片接口请求失败，请重试。";
}

function classifyImageFailure(message, status = 0) {
  const text = String(message || "");
  if (/policy|safety|safe|content|moderation|violation|blocked|disallowed|违规|安全|审核|拦截|敏感/i.test(text)) return "safety";
  if (/billing|insufficient(?:[_ -]?quota)?|credit|余额|积分|额度不足|欠费/i.test(text) || status === 402) return "quota";
  if (/rate.?limit|too many requests|concurr|限流|并发|请求频繁|繁忙|稍后重试/i.test(text) || status === 429) return "rate_limit";
  if (/quota|额度/i.test(text)) return "quota";
  if (/fetch failed|socket|network|ECONN|ETIMEDOUT|UND_ERR|timeout|abort/i.test(text) || status >= 500) return "network";
  return "unknown";
}

function detectPromptRiskTerms(prompt) {
  const text = String(prompt || "");
  const rules = [
    ["拉黑", "攻击性/惩罚性表达，改成“拒绝”或“不接受”更稳"],
    ["缺德", "贬损词，改成“太离谱”更稳"],
    ["洗脑", "敏感负面操控词，改成“被推荐算法影响”更稳"],
    ["0糖0脂0卡", "绝对化健康/功效表述，画面提示词中改成“低负担饮品信息”更稳"],
    ["减肥", "身材/健康承诺词，画面提示词中弱化为“轻负担选择”"],
    ["破戒", "饮食管控强词，改成“没忍住”或“改变选择”"],
    ["拉黑十年", "惩罚性威胁表达，改成“我会拒绝你”"],
  ];
  return rules.filter(([term]) => text.includes(term)).map(([term, suggestion]) => ({ term, suggestion }));
}

async function callImageGenerations({ prompt, size, model }) {
  return fetchWithRetry(`${config.apiBaseUrl}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model || config.imageModel,
      prompt,
      size: size || "1536x1024",
      n: 1,
    }),
  });
}

async function callImageEdits({ prompt, referenceImages, size, model }) {
  const preparedImages = await Promise.all(referenceImages.slice(0, imageReferenceLimit).map(prepareReferenceImageForUpstream));
  const form = new FormData();
  form.append("model", model || config.imageModel);
  form.append("prompt", prompt);
  form.append("size", size || "1536x1024");
  form.append("n", "1");
  preparedImages.forEach((image, index) => {
    const fileName = image.name || `reference-${index + 1}.png`;
    form.append("image[]", new Blob([image.buffer], { type: image.mimeType }), fileName);
  });
  let response = await fetchWithRetry(`${config.apiBaseUrl}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
  });

  if (response.ok || preparedImages.length !== 1) return response;

  const firstError = await response.text();
  const fallbackForm = new FormData();
  fallbackForm.append("model", model || config.imageModel);
  fallbackForm.append("prompt", prompt);
  fallbackForm.append("size", size || "1536x1024");
  fallbackForm.append("n", "1");
  const firstImage = preparedImages[0];
  fallbackForm.append(
    "image",
    new Blob([firstImage.buffer], { type: firstImage.mimeType }),
    firstImage.name || "reference.png"
  );
  response = await fetchWithRetry(`${config.apiBaseUrl}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: fallbackForm,
  });
  response.firstError = firstError;
  return response;
}

async function prepareReferenceImageForUpstream(image) {
  const sourcePath = String(image?.filePath || "");
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new Error(`参考图 ${image?.assetId || ""} 的本地文件不存在`);
  }
  const sourceInfo = await stat(sourcePath);
  const sourceExt = extname(sourcePath).toLowerCase();
  const sourceMimeType = mimeTypes[sourceExt]?.split(";")[0] || "application/octet-stream";
  const supportedWithoutConversion = [".png", ".jpg", ".jpeg", ".webp"].includes(sourceExt);
  if (sourceInfo.size <= imageReferenceNormalizeThresholdBytes && supportedWithoutConversion) {
    return {
      ...image,
      name: image.name || basename(sourcePath),
      mimeType: sourceMimeType,
      buffer: await readFile(sourcePath),
      originalByteLength: sourceInfo.size,
      normalizedByteLength: sourceInfo.size,
    };
  }

  const cacheKey = createHash("sha256")
    .update(`${sourcePath}:${sourceInfo.size}:${sourceInfo.mtimeMs}:${imageReferenceMaxSide}:jpeg-v1`)
    .digest("hex");
  const cachePath = join(imageReferenceCacheDir, `${cacheKey}.jpg`);
  let job = imageReferenceNormalizationJobs.get(cachePath);
  if (!job) {
    job = normalizeReferenceImageFile(sourcePath, cachePath);
    imageReferenceNormalizationJobs.set(cachePath, job);
  }
  try {
    await job;
  } finally {
    if (imageReferenceNormalizationJobs.get(cachePath) === job) {
      imageReferenceNormalizationJobs.delete(cachePath);
    }
  }
  const normalizedInfo = await stat(cachePath);
  console.info(
    `[image] normalized reference asset=${image.assetId} originalBytes=${sourceInfo.size} normalizedBytes=${normalizedInfo.size}`
  );
  return {
    ...image,
    name: `${basename(image.name || sourcePath, extname(image.name || sourcePath))}.jpg`,
    mimeType: "image/jpeg",
    buffer: await readFile(cachePath),
    originalByteLength: sourceInfo.size,
    normalizedByteLength: normalizedInfo.size,
  };
}

async function normalizeReferenceImageFile(sourcePath, cachePath) {
  if (existsSync(cachePath) && (await stat(cachePath)).size > 0) return;
  const ffmpegCommand = await resolveFfmpegCommand();
  if (!ffmpegCommand) {
    throw new Error("参考图体积较大，但未找到内置图片处理组件。请重新安装完整版本后重试。");
  }
  const temporaryPath = `${cachePath}.${randomUUID()}.tmp.jpg`;
  const result = await runExternal(
    ffmpegCommand,
    [
      "-y",
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${imageReferenceMaxSide}:${imageReferenceMaxSide}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
      "-q:v",
      "3",
      "-pix_fmt",
      "yuvj420p",
      "-map_metadata",
      "-1",
      temporaryPath,
    ],
    { timeout: 120000, allowFailure: true }
  );
  if (!result.ok || !existsSync(temporaryPath)) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw new Error("参考图体积较大，自动优化失败。请把该图片另存为 JPG 后重新上传。");
  }
  await rename(temporaryPath, cachePath);
}

// A transport failure after a POST does not prove that the upstream service
// did not accept the job. Paid creation endpoints must therefore opt in to a
// retry explicitly; image/video/voice creation never retry silently.
async function fetchWithRetry(url, options, retries = 0) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const timeoutMs = Number(options.timeoutMs || 20 * 60 * 1000);
      const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
      return await fetch(url, {
        ...fetchOptions,
        signal: options.signal || AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = error;
      if (!isTransientFetchError(error) || attempt === retries) break;
      await delay(1500);
    }
  }
  throw lastError;
}

function isTransientFetchError(error) {
  return /fetch failed|socket|network|ECONN|ETIMEDOUT|UND_ERR|timeout|abort/i.test(error?.message || String(error));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("invalid reference image data URL");
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64"),
  };
}

async function runDreamina(args, options = {}) {
  return runExternal(resolveDreaminaCommand(), args, options);
}

function resolveDreaminaCommand() {
  const platformBinary = process.platform === "win32" ? "dreamina.exe" : "dreamina";
  const embeddedArchDir = `${process.platform}-${process.arch}`;
  const candidates = [
    process.env.DREAMINA_BIN,
    join(packagedResourcesRoot, "bin", embeddedArchDir, platformBinary),
    join(root, "bin", embeddedArchDir, platformBinary),
    join(homedir(), ".local", "bin", platformBinary),
    join(homedir(), "bin", platformBinary),
    "/opt/homebrew/bin/dreamina",
    "/usr/local/bin/dreamina",
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Programs", "dreamina", "dreamina.exe")
      : "",
    process.platform === "win32" && process.env.APPDATA ? join(process.env.APPDATA, "dreamina", "dreamina.exe") : "",
    "dreamina",
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === "dreamina" || existsSync(candidate)) || "dreamina";
}

function buildDreaminaStatusMessage(version, credit) {
  if (credit.ok) return "";
  if (!version.ok) return formatDreaminaCliError(version.output);
  const text = String(credit.output || "");
  if (/login|unauthorized|token|Command failed/i.test(text)) {
    return "即梦账号还没有授权，请点击“开始授权”，软件会打开即梦授权网页。";
  }
  return formatDreaminaCliError(text);
}

async function openExternalUrl(targetUrl) {
  let parsed;
  try {
    parsed = new URL(String(targetUrl || "").trim());
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  try {
    if (process.platform === "darwin") {
      await execFileAsync("open", [parsed.href], { timeout: 10000 });
    } else if (process.platform === "win32") {
      await execFileAsync("cmd", ["/c", "start", "", parsed.href], { timeout: 10000, windowsHide: true });
    } else {
      await execFileAsync("xdg-open", [parsed.href], { timeout: 10000 });
    }
    return true;
  } catch {
    return false;
  }
}

async function runExternal(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: options.timeout || 30000,
      maxBuffer: 1024 * 1024 * 8,
    });
    return { ok: true, output: [stdout, stderr].filter(Boolean).join("\n").trim() };
  } catch (error) {
    const detail = [error.stderr, error.stdout].filter(Boolean).join("\n").trim();
    const output = detail || (error.code === "ENOENT" ? error.message : `command failed: ${error.code || error.signal || "unknown"}`);
    if (options.allowFailure) return { ok: false, output: output || error.code || "command failed" };
    throw error;
  }
}

function formatDreaminaCliError(output) {
  const text = String(output || "");
  if (/Command failed:.*dreamina\s+multimodal2video/i.test(text)) {
    const withoutCommand = stripDreaminaCommandFailure(text);
    if (withoutCommand && withoutCommand !== text) return formatDreaminaCliError(withoutCommand);
    return "即梦视频提交失败：任务没有被即梦成功接收。请先点“检查登录/积分”确认账号可用，再重新提交这个分镜。";
  }
  if (/ENOENT|not found|executable file not found|no such file/i.test(text)) {
    return "没有找到 dreamina CLI。请先安装即梦 CLI，或把 dreamina 加入系统 PATH 后重启软件。";
  }
  if (/unauthorized|login|token/i.test(text)) {
    return "即梦登录状态异常，请点击“开始授权”重新登录。";
  }
  if (/CreditPreDeductNotEnough|credit[_\s-]*(not[_\s-]*enough|insufficient)|积分不足|额度不足/i.test(text)) {
    return "即梦账号积分不足，任务没有被受理。请先在即梦账号补充积分后，再重新提交这个分镜。";
  }
  if (/network|timeout|ECONN|TLS|certificate/i.test(text)) {
    return "连接即梦服务失败，请检查网络或代理后重试。";
  }
  return text || "发起即梦授权失败，请确认 dreamina CLI 已安装并能在终端运行。";
}

function stripDreaminaCommandFailure(output) {
  const text = String(output || "").trim();
  const stripped = text
    .split("\n")
    .filter((line) => !/^\s*Command failed:.*dreamina\s+multimodal2video/i.test(line))
    .filter((line) => !/^\s*(--image|--prompt|--duration=|--ratio=|--video_resolution=|--model_version=|--poll=)/i.test(line))
    .join("\n")
    .trim();
  if (/参考图清单|视觉与内容要求|分秒同步执行|角色一致性|最高优先级|注意事项/.test(stripped)) return "";
  if (/--duration=|--ratio=|--model_version=|--video_resolution=/.test(stripped)) return "";
  return stripped;
}

function parseDreaminaLogin(output) {
  const text = String(output || "");
  return {
    verificationUri: matchLineValue(text, /verification[_\s-]*uri(?:_complete)?\s*[:=]\s*(\S+)/i) || matchLineValue(text, /(https?:\/\/\S+)/i),
    userCode: matchLineValue(text, /user[_\s-]*code\s*[:=]\s*([A-Z0-9-]+)/i),
    deviceCode: matchLineValue(text, /device[_\s-]*code\s*[:=]\s*([A-Za-z0-9._-]+)/i),
  };
}

function parseDreaminaSubmit(output) {
  const text = String(output || "");
  const parsedJson = parseEmbeddedDreaminaJson(text);
  const submitId = cleanDreaminaField(
    parsedJson?.submit_id || matchLineValue(text, /["']?submit[_\s-]*id["']?\s*[:=]\s*["']?([A-Za-z0-9._-]+)["']?/i)
  );
  const genStatus = cleanDreaminaField(
    parsedJson?.gen_status || matchLineValue(text, /["']?gen[_\s-]*status["']?\s*[:=]\s*["']?([A-Za-z0-9._-]+)["']?/i)
  );
  const failReason = cleanDreaminaField(
    parsedJson?.fail_reason || matchLineValue(text, /["']?fail[_\s-]*reason["']?\s*[:=]\s*(.+)/i)
  );
  return {
    submitId,
    genStatus,
    failReason,
    videoUrls: extractDreaminaVideoUrls(parsedJson || text),
  };
}

function parseEmbeddedDreaminaJson(text) {
  const source = String(text || "");
  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') {
        quoted = true;
        continue;
      }
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
      if (depth !== 0) continue;
      try {
        const candidate = JSON.parse(source.slice(start, index + 1));
        if (candidate?.submit_id || candidate?.gen_status || candidate?.result_json || candidate?.fail_reason) return candidate;
      } catch {
        // The command output can contain shell text before or after the JSON.
      }
      break;
    }
  }
  return null;
}

function cleanDreaminaField(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\n/g, "\n")
    .replace(/[),，。]+$/g, "");
}

function extractDreaminaVideoUrls(source) {
  const value = typeof source === "string" ? source : JSON.stringify(source || {});
  const urls = [];
  const seen = new Set();
  const expression = /["']?video_url["']?\s*[:=]\s*["'](https:\/\/[^"'\s]+)["']/gi;
  let match;
  while ((match = expression.exec(value))) {
    const url = cleanDreaminaField(match[1]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function isDreaminaExplicitFailure(parsed = {}) {
  const status = String(parsed?.genStatus || "").trim().toLowerCase();
  return ["fail", "failed", "error", "rejected", "cancelled", "canceled"].includes(status) || Boolean(parsed?.failReason);
}

function isDreaminaCompletedStatus(status = "") {
  return ["success", "succeeded", "completed", "complete", "finished", "done"].includes(String(status).trim().toLowerCase());
}

function isDreaminaAcceptedSubmission(parsed = {}) {
  return Boolean(String(parsed?.submitId || "").trim()) && !isDreaminaExplicitFailure(parsed);
}

async function queryDreaminaResult(submitId, downloadDir, beforeVideos = [], scope = {}) {
  const before = new Set(beforeVideos.map((filePath) => normalize(filePath)));
  const result = await runDreamina(["query_result", `--submit_id=${submitId}`, `--download_dir=${downloadDir}`], {
    timeout: 60000,
    allowFailure: true,
  });
  const afterVideos = await listVideoFiles(downloadDir);
  const downloaded = afterVideos.filter((filePath) => !before.has(normalize(filePath)));
  const outputVideos = downloaded.length
    ? downloaded
    : extractVideoPaths(result.output).filter((filePath) => existsSync(filePath));
  const publishedVideos = await publishDreaminaVideos(outputVideos, scope);
  return {
    ok: result.ok,
    output: result.output,
    parsed: parseDreaminaSubmit(result.output),
    videos: publishedVideos,
  };
}

async function recoverDreaminaVideosFromSubmitOutput(submission, scope = {}) {
  const parsed = parseDreaminaSubmit(submission?.submitOutput || submission?.output);
  if (!parsed.videoUrls.length) return [];
  const downloadDir = join(tmpdir(), "video-skill-dreamina-recovery", String(submission?.id || randomUUID()));
  await mkdir(downloadDir, { recursive: true });
  const downloaded = [];
  for (const [index, remoteUrl] of parsed.videoUrls.entries()) {
    let safeUrl;
    try {
      safeUrl = new URL(remoteUrl);
    } catch {
      continue;
    }
    if (safeUrl.protocol !== "https:" || isLocalOrPrivateHost(safeUrl.hostname)) continue;
    const response = await fetchWithRetry(safeUrl.href, { method: "GET", timeoutMs: 120000 }, 1).catch(() => null);
    if (!response?.ok) continue;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1024) continue;
    const target = join(downloadDir, `returned-${index + 1}.mp4`);
    await writeFile(target, bytes);
    downloaded.push(target);
  }
  return publishDreaminaVideos(downloaded, scope);
}

function isLocalOrPrivateHost(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  return (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host === "::1"
  );
}

async function publishDreaminaVideos(videoPaths, scope = {}) {
  const projectId = requireIdentityValue(scope.projectId, "projectId");
  const workflowId = requireIdentityValue(scope.workflowId, "workflowId");
  const workflowType = requireWorkflowType(scope.workflowType);
  const segmentId = requireIdentityValue(scope.segmentId, "segmentId");
  const attemptId = requireIdentityValue(scope.attemptId, "attemptId");
  const dir = join(outputDir, "projects", projectId, workflowId);
  await mkdir(dir, { recursive: true });
  return await Promise.all(
    videoPaths.map(async (filePath, index) => {
      const ext = extname(filePath).toLowerCase() || ".mp4";
      const assetId = `segment-video-${segmentId}-${index + 1}`;
      const target = join(dir, `${Date.now()}-${assetId}-${randomUUID().slice(0, 8)}${ext}`);
      if (normalize(filePath) !== normalize(target)) await copyFile(filePath, target);
      const record = {
        projectId,
        workflowId,
        workflowType,
        segmentId,
        assetId,
        assetType: "segment_video",
        attemptId,
        path: toPublicPath(target),
        name: basename(target),
        status: "ready",
        sourceKind: "dreamina",
        createdAt: new Date().toISOString(),
      };
      await upsertAssetManifest(record);
      return record;
    })
  );
}

async function prepareDreaminaInputFiles(imagePaths, recordId) {
  const dir = join(tmpdir(), "video-skill-dreamina-inputs", recordId);
  await mkdir(dir, { recursive: true });
  return await Promise.all(
    imagePaths.map(async (imagePath, index) => {
      const ext = extname(imagePath).toLowerCase() || ".png";
      const target = join(dir, `ref-${String(index + 1).padStart(2, "0")}${ext}`);
      await copyFile(imagePath, target);
      return target;
    })
  );
}

async function listVideoFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const filePath = join(dir, entry.name);
        if (entry.isDirectory()) return listVideoFiles(filePath);
        return isVideoFile(filePath) ? [filePath] : [];
      })
    );
    return nested.flat();
  } catch {
    return [];
  }
}

function extractVideoPaths(output) {
  const text = String(output || "");
  const unixMatches = text.match(/(?:\/[^\s"'<>]+?\.(?:mp4|mov|webm|m4v))/gi) || [];
  const windowsMatches = text.match(/(?:[A-Za-z]:\\[^\r\n"'<>]+?\.(?:mp4|mov|webm|m4v))/gi) || [];
  return [...unixMatches, ...windowsMatches].map((filePath) => normalize(filePath));
}

function isVideoFile(filePath) {
  return [".mp4", ".mov", ".webm", ".m4v"].includes(extname(filePath).toLowerCase());
}

function isRangeMediaFile(filePath) {
  return [".mp4", ".mov", ".webm", ".m4v", ".mp3", ".wav", ".m4a"].includes(extname(filePath).toLowerCase());
}

function toPublicPath(filePath) {
  const raw = String(filePath || "");
  if (raw.startsWith("/outputs/") || raw.startsWith("/uploads/")) return raw;
  const normalized = normalize(raw);
  return publicPathFromBase(outputDir, "/outputs/", normalized) || publicPathFromBase(uploadDir, "/uploads/", normalized) || "";
}

function publicPathFromBase(baseDir, publicPrefix, filePath) {
  const rel = relative(baseDir, filePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return "";
  return `${publicPrefix}${rel.replace(/\\/g, "/")}`;
}

function isInsidePath(baseDir, filePath) {
  const rel = relative(baseDir, filePath);
  return Boolean(rel && !rel.startsWith("..") && !isAbsolute(rel));
}

async function stitchVideos(videoPaths, scope = {}) {
  const ffmpegCommand = await resolveFfmpegCommand();
  if (!ffmpegCommand) {
    return {
      ok: false,
      error: "ffmpeg_missing",
      message: "未找到可用 ffmpeg。已检查系统 PATH 和本地工具目录，请确认 ffmpeg 文件仍在。",
    };
  }
  const projectId = requireIdentityValue(scope.projectId, "projectId");
  const workflowId = requireIdentityValue(scope.workflowId, "workflowId");
  const workflowType = requireWorkflowType(scope.workflowType);
  const assetId = requireIdentityValue(scope.assetId, "assetId");
  const attemptId = requireIdentityValue(scope.attemptId, "attemptId");
  const scopedOutputDir = join(outputDir, "projects", projectId, workflowId);
  await mkdir(scopedOutputDir, { recursive: true });
  const listPath = join(scopedOutputDir, `concat-${Date.now()}-${randomUUID().slice(0, 8)}.txt`);
  const outputPath = join(scopedOutputDir, `${Date.now()}-${assetId}-${randomUUID().slice(0, 8)}.mp4`);
  const listBody = videoPaths.map((filePath) => `file '${filePath.replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(listPath, listBody);
  let result = await runExternal(ffmpegCommand, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath], {
    timeout: 10 * 60 * 1000,
    allowFailure: true,
  });
  if (!result.ok) {
    result = await runExternal(
      ffmpegCommand,
      ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", outputPath],
      { timeout: 20 * 60 * 1000, allowFailure: true }
    );
  }
  if (!result.ok) {
    return {
      ok: false,
      error: "stitch_failed",
      message: result.output || "视频拼接失败",
    };
  }
  const video = {
    projectId,
    workflowId,
    workflowType,
    assetId,
    assetType: "stitched_video",
    attemptId,
    inputAssetIds: Array.isArray(scope.inputAssetIds) ? scope.inputAssetIds : [],
    path: toPublicPath(outputPath),
    name: basename(outputPath),
    status: "ready",
    sourceKind: "stitch",
    createdAt: new Date().toISOString(),
  };
  await upsertAssetManifest(video);
  return {
    ok: true,
    video,
    ffmpeg: ffmpegCommand,
    output: result.output,
  };
}

function normalizePublicError(error, fallback) {
  const text = String(error?.message || error || "").trim();
  if (!text) return fallback;
  if (/fetch failed|Failed to fetch|network|timeout|ETIMEDOUT|ECONN|AbortError/i.test(text)) {
    return "联网搜索暂时没有拿到结果，可能是网络波动或搜索源访问失败，请稍后重试。";
  }
  return text.length > 120 ? fallback : text;
}

function normalizeTextModelError(error, fallback) {
  const text = String(error?.message || error || "").trim();
  if (!text) return fallback;
  if (/fetch failed|Failed to fetch|network|timeout|ETIMEDOUT|ECONN|AbortError/i.test(text)) {
    return "文本模型连接失败或等待超时，请稍后重试。";
  }
  return text.length > 160 ? fallback : text;
}

async function optimizeRemakeDialogue(body = {}) {
  const shots = (Array.isArray(body.shots) ? body.shots : []).slice(0, 80).map((shot, index) => {
    const id = requireIdentityValue(shot?.id || `shot-${index + 1}`, `shots[${index}].id`);
    const start = Number(shot?.start);
    const end = Number(shot?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      const error = new Error(`镜头 ${id} 的时间段无效，已阻止优化。`);
      error.status = 400;
      error.code = "invalid_shot_range";
      throw error;
    }
    return {
      id,
      start,
      end,
      scene: String(shot?.scene || "").trim().slice(0, 300),
      visual: String(shot?.visual || "").trim().slice(0, 1200),
      dialogue: String(shot?.dialogue || "").trim().slice(0, 600),
    };
  });
  if (!shots.length) {
    const error = new Error("没有可用于优化口播的复刻镜头。");
    error.status = 400;
    error.code = "missing_remake_shots";
    throw error;
  }
  const originalDialogue = String(body.originalDialogue || "").replace(/\s+/g, " ").trim().slice(0, 12000);
  if (!originalDialogue) {
    const error = new Error("原口播为空，无法执行复刻改写。");
    error.status = 400;
    error.code = "missing_original_dialogue";
    throw error;
  }
  const productInfo = body.productInfo && typeof body.productInfo === "object" ? body.productInfo : {};
  const promotion = body.promotion && typeof body.promotion === "object" ? body.promotion : {};
  const providedSettings = body.remakeSettings && typeof body.remakeSettings === "object" ? body.remakeSettings : {};
  const settings = {
    targetName: providedSettings.targetName || productInfo.name || productInfo.category || "",
    personaBrand: providedSettings.personaBrand || "",
    categoryScene: providedSettings.categoryScene || productInfo.category || "",
    sellingPoints: providedSettings.sellingPoints || productInfo.sellingPoints || "",
    specificationDelivery: providedSettings.specificationDelivery || "",
    priceDiscount: providedSettings.priceDiscount || (promotion.enabled ? promotion.mechanism : "") || "",
    trustEndorsement: providedSettings.trustEndorsement || "",
    targetAudience: providedSettings.targetAudience || "",
    competitorPainPoints: providedSettings.competitorPainPoints || "",
    usageScene: providedSettings.usageScene || "",
    bannedWords: providedSettings.bannedWords || "",
    actionGuidance: providedSettings.actionGuidance || "",
  };
  const settingsText = [
    ["目标名称", settings.targetName],
    ["人设/品牌", settings.personaBrand],
    ["品类/场景", settings.categoryScene],
    ["核心卖点", settings.sellingPoints],
    ["规格/交付内容", settings.specificationDelivery],
    ["价格/优惠", settings.priceDiscount],
    ["信任背书", settings.trustEndorsement],
    ["目标用户", settings.targetAudience],
    ["竞品/替代方案痛点", settings.competitorPainPoints],
    ["使用/体验/购买/转化场景", settings.usageScene],
    ["禁用词或合规要求", settings.bannedWords],
    ["行动引导", settings.actionGuidance],
  ].filter(([, value]) => String(value || "").trim()).map(([label, value]) => `${label}：${String(value).trim()}`).join("\n");
  const prompt = `你是一个爆款短视频脚本复刻改写专家。

你的任务：根据【复刻设置】和【原口播脚本】，在严格保留对标脚本的情绪节奏、句式结构、冲突点、信任建立方式、成交钩子和长度结构的前提下，把脚本内容改写成适合【复刻产品】的新脚本。

【复刻设置】（有的内容就使用，没有的内容就跳过）
${settingsText || "（当前没有额外复刻设置，仅按原口播结构改写，不补充未知信息）"}

【原口播脚本】
${originalDialogue}

【改写要求】
1. 只输出改写后的脚本文案，不要输出分析、解释、标题、字数统计、注意事项。
2. 保留原脚本的开头冲击力、情绪走向、句式节奏、段落结构、成交逼单方式。
3. 只替换必须替换的内容：品牌名、产品名、人名、品类、卖点、场景、价格、行动引导等。
4. 不要删除原脚本里的逻辑链条、案例描述、情绪渲染、具体步骤、数据感表达和信任背书结构。
5. 如果原脚本超过200字，必须逐句对应改写，不允许合并句子，不允许大幅压缩。
6. 改写后字数必须接近原脚本：短脚本不少于原文90%，中等脚本保持95%-110%，长脚本保持90%-105%。
7. 不要编造未提供的认证、数据、功效、承诺、官方背书或优惠。
8. 结尾必须保留清晰行动引导，例如点击链接、进直播间、私信、预约、下单、领取优惠等。
9. 最终脚本要像原脚本一样有吸引力和成交感，但主角必须完全变成【目标名称】。`;
  const response = await callChatCompletions({
    model: config.textModel,
    messages: [
      { role: "system", content: "严格按用户规则改写，只输出最终复刻脚本文案，不输出任何分析、标题、标签、Markdown 或额外说明。" },
      { role: "user", content: prompt },
    ],
    temperature: 0.35,
  }, Number(process.env.REMAKE_DIALOGUE_TIMEOUT_MS || 90000));
  const data = await safeResponseJson(response);
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || "文本模型优化失败。");
    error.status = response.status;
    error.code = "text_model_failed";
    throw error;
  }
  const raw = data.choices?.[0]?.message?.content || data.output_text || "";
  const parsed = parseLooseJson(raw);
  const optimized = String(parsed?.dialogue || raw || "")
    .replace(/^```(?:text|markdown)?\s*|\s*```$/gi, "")
    .replace(/^(?:复刻口播|改写脚本|脚本文案)\s*[:：]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!optimized) {
    const error = new Error("文本模型没有返回有效的完整口播，请重试。");
    error.status = 502;
    error.code = "invalid_text_model_output";
    throw error;
  }
  return {
    ok: true,
    dialogue: optimized.slice(0, 6000),
    engine: config.textModel,
    projectId: body.projectId,
    workflowId: body.workflowId,
    workflowType: body.workflowType,
  };
}

async function searchRemakeProductName(body = {}) {
  const queryText = String(body.queryText || "").trim();
  if (!queryText) return { ok: false, query: "", results: [], suggestions: [], message: "缺少可搜索的原片信息。" };
  const query = buildRemakeProductSearchQuery(body);
  if (!query) return { ok: false, query: "", results: [], suggestions: [], message: "没有提取到可搜索关键词。" };
  const searchUrls = [
    `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  ];
  let results = [];
  let lastError = null;
  for (const searchUrl of searchUrls) {
    try {
      const response = await fetchWithRetry(
        searchUrl,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
            Accept: "text/html,application/xhtml+xml",
          },
          timeoutMs: 12000,
        },
        0
      );
      const html = await response.text();
      results = parseSearchHtml(html, searchUrl.includes("bing.com") ? "bing" : "duckduckgo");
      if (results.length) break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!results.length && lastError) throw lastError;
  const suggestions = makeProductNameSuggestions(results, queryText);
  return {
    ok: true,
    query,
    results: results.slice(0, 6),
    suggestions,
    message: suggestions.length ? "" : "没有从搜索结果里提取到明确产品名。",
  };
}

function buildRemakeProductSearchQuery(body = {}) {
  const product = body.productInfo && typeof body.productInfo === "object" ? body.productInfo : {};
  const newProductTerms = [product.name, product.category]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  let text = [body.videoTitle, body.queryText].map((item) => String(item || "")).join(" ");
  newProductTerms.forEach((term) => {
    text = text.replace(new RegExp(escapeRegExp(term), "gi"), " ");
  });
  text = htmlDecode(text)
    .replace(/未识别到明确原片旧产品名|新产品|产品替换|自然植入/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const directCandidate = inferLikelyProductNameFromText(text);
  if (directCandidate) return `"${directCandidate}" 产品名 品牌`.slice(0, 160);
  const brandCandidate = inferLikelyBrandFromText(text);
  if (brandCandidate) return `"${brandCandidate}" 产品名 品牌 官网`.slice(0, 160);
  const latinTokens = Array.from(new Set(text.match(/[A-Za-z][A-Za-z0-9+._-]*(?:\s+[A-Za-z][A-Za-z0-9+._-]*)?/g) || []))
    .filter((token) => !/mp4|mov|remake|video|life$/i.test(token))
    .slice(0, 4);
  const productHints = Array.from(new Set(text.match(/[\u4e00-\u9fa5]{0,8}(?:益生菌|奶粉|饮料|茶|咖啡|面膜|精华|牙膏|洗发水|零食|保健品|玩具|服饰|家电)[\u4e00-\u9fa5]{0,6}/g) || []))
    .slice(0, 4);
  if (latinTokens.length || productHints.length) {
    const quotedLatin = latinTokens.map((token) => (/\s/.test(token) ? `"${token}"` : token));
    return [...quotedLatin, ...productHints, "产品名"].join(" ").slice(0, 160);
  }
  return `${text.slice(0, 120)} 产品名`;
}

function parseSearchHtml(html, source) {
  const text = String(html || "");
  const results = [];
  if (source === "bing") {
    const regex = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/gi;
    let match;
    while ((match = regex.exec(text)) && results.length < 8) {
      results.push(makeSearchResult(match[2], match[3], match[1]));
    }
    return results.filter((item) => item.title);
  }
  const regex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>)?/gi;
  let match;
  while ((match = regex.exec(text)) && results.length < 8) {
    results.push(makeSearchResult(match[2], match[3] || match[4], decodeDuckDuckGoUrl(match[1])));
  }
  return results.filter((item) => item.title);
}

function makeSearchResult(titleHtml, snippetHtml, url) {
  return {
    title: cleanSearchText(titleHtml),
    snippet: cleanSearchText(snippetHtml),
    url: htmlDecode(String(url || "")),
  };
}

function makeProductNameSuggestions(results, queryText) {
  const seen = new Set();
  const direct = inferLikelyProductNameFromText(queryText);
  const suggestions = [];
  if (direct) {
    const source = findSupportingSearchResult(results, direct);
    seen.add(normalizeCandidateKey(direct));
    suggestions.push({
      name: direct,
      title: source?.title || "根据原片口播关键词推断",
      snippet: source?.snippet || "已从原片文本中提取到品牌/产品名组合，请结合画面确认。",
      url: source?.url || "",
    });
  }
  results
    .map((result) => {
      const name = inferProductName(`${result.title} ${result.snippet}`, queryText);
      const key = normalizeCandidateKey(name);
      if (!name || seen.has(key)) return null;
      seen.add(key);
      return { name, title: result.title, snippet: result.snippet, url: result.url };
    })
    .filter(Boolean)
    .forEach((item) => suggestions.push(item));
  return suggestions.slice(0, 5);
}

function inferProductName(title, queryText) {
  const text = cleanSearchText(title);
  if (!text) return "";
  if (isNonProductSearchResult(text)) return "";
  const productTerm = (text + " " + queryText).match(/益生菌|奶粉|饮料|小罐茶|茶饮|茶|咖啡|面膜|精华|牙膏|洗发水|零食|保健品|玩具|服饰|家电/)?.[0] || "";
  const likelyBrand = inferLikelyBrandFromText(queryText);
  const resultBrand = inferLikelyBrandFromText(text);
  const normalizedLikelyBrand = normalizeBrandAlias(likelyBrand);
  const normalizedResultBrand = normalizeBrandAlias(resultBrand);
  if (likelyBrand && resultBrand && normalizedLikelyBrand !== normalizedResultBrand && !text.toLowerCase().includes(likelyBrand.toLowerCase())) return "";
  if (productTerm && !text.includes(productTerm) && likelyBrand && !text.toLowerCase().includes(likelyBrand.toLowerCase())) return "";
  const brand = (text.match(/\b[A-Z][A-Za-z0-9+]*(?:\s+[A-Z][A-Za-z0-9+]*){0,2}\b/) || [])[0] || "";
  const candidate = brand && productTerm && !new RegExp(productTerm, "i").test(brand)
    ? `${normalizeDisplayBrand(brand)} ${productTerm}`.trim()
    : text
    .split(/\s[-_|—–]\s|[|｜]/)[0]
    .replace(/(官方旗舰店|官方网站|官网|价格|多少钱|怎么样|推荐|购买|京东|淘宝|抖音|小红书|百度百科).*/g, "")
    .trim()
    .slice(0, 36);
  return isProductNameCandidate(candidate, queryText) ? candidate : "";
}

function inferLikelyProductNameFromText(value) {
  const text = cleanSearchText(value);
  const brand = inferLikelyBrandFromText(text);
  const productTerm = (text.match(/益生菌|奶粉|饮料|小罐茶|茶饮|茶|咖啡|面膜|精华|牙膏|洗发水|零食|保健品|玩具|服饰|家电/) || [])[0] || "";
  if (brand && productTerm) return `${normalizeDisplayBrand(brand)} ${productTerm}`.trim();
  return "";
}

function inferLikelyBrandFromText(value) {
  const text = cleanSearchText(value);
  const normalizedText = text.replace(/life\s*space|lifespace/ig, "Life Space");
  return (
    (normalizedText.match(/\b[A-Z][A-Za-z0-9+._-]+(?:\s+[A-Z][A-Za-z0-9+._-]+){1,3}\b/) || [])[0] ||
    (normalizedText.match(/\b[A-Z][A-Za-z0-9+._-]{2,}\b/) || [])[0] ||
    ""
  );
}

function findSupportingSearchResult(results = [], candidate = "") {
  const key = normalizeCandidateKey(candidate);
  return results.find((result) => normalizeCandidateKey(`${result.title} ${result.snippet}`).includes(key.split(" ").filter(Boolean)[0] || key));
}

function isNonProductSearchResult(text = "") {
  return /智学网|Excel|微信|文件存储|登录|脚本抄写|剧本|作文|论文|招聘|下载|教程|英文单词|翻译|词典|Open Access Journal|MDPI|百科|知乎|百度知道|CSDN|博客园/i.test(text)
    && !/(益生菌|奶粉|饮料|小罐茶|茶饮|咖啡|面膜|精华|保健品|官方旗舰店|产品|品牌|官网)/.test(text);
}

function isProductNameCandidate(candidate = "", queryText = "") {
  const text = cleanSearchText(candidate);
  if (!text || text.length < 2 || text.length > 40) return false;
  if (isNonProductSearchResult(text)) return false;
  const hasProductTerm = /(益生菌|奶粉|饮料|小罐茶|茶饮|茶|咖啡|面膜|精华|牙膏|洗发水|零食|保健品|玩具|服饰|家电)/.test(`${text} ${queryText}`);
  const hasBrand = Boolean(inferLikelyBrandFromText(text) || /[\u4e00-\u9fa5]{2,}(?:牌|堂|氏|源|生物|健康|食品|饮品|茶业|药业)/.test(text));
  return hasProductTerm && hasBrand;
}

function normalizeCandidateKey(value = "") {
  return normalizeBrandAlias(cleanSearchText(value)).replace(/[^\w\u4e00-\u9fa5]+/g, " ").trim().toLowerCase();
}

function normalizeDisplayBrand(brand = "") {
  const text = cleanSearchText(brand);
  if (/^lifespace$/i.test(text.replace(/\s+/g, ""))) return "Life Space";
  return text;
}

function normalizeBrandAlias(value = "") {
  return cleanSearchText(value).replace(/life\s*space|lifespace/ig, "Life Space").toLowerCase();
}

function cleanSearchText(value) {
  return htmlDecode(stripHtml(String(value || "")))
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function htmlDecode(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function decodeDuckDuckGoUrl(value) {
  const raw = htmlDecode(String(value || ""));
  try {
    const parsed = new URL(raw, "https://duckduckgo.com");
    return parsed.searchParams.get("uddg") || raw;
  } catch {
    return raw;
  }
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function analyzeRemakeVideoFrames({
  videoPath,
  duration,
  segmentSeconds,
  productInfo = {},
  projectId,
  workflowId,
  workflowType,
  attemptId,
}) {
  if (requireWorkflowType(workflowType) !== "remake") {
    const error = new Error("视频解析工作流类型不匹配");
    error.status = 409;
    error.code = "workflow_type_mismatch";
    throw error;
  }
  const ffmpegCommand = await resolveFfmpegCommand();
  if (!ffmpegCommand) {
    return {
      analysisVersion: remakeAnalysisVersion,
      ok: false,
      error: "ffmpeg_missing",
      message: "本机没有找到 ffmpeg，所以暂时不能抽取原片关键帧。请确认安装包内置 ffmpeg 文件仍在，或安装 ffmpeg 后重试。",
    };
  }
  const safeDuration = Math.max(1, Number(duration || segmentSeconds || 10));
  const safeSegmentSeconds = Math.max(4, Number(segmentSeconds || 10));
  const shotDetection = await detectRemakeShotRanges({
    ffmpegCommand,
    videoPath,
    duration: safeDuration,
    fallbackSegmentSeconds: safeSegmentSeconds,
  });
  const shotRanges = Array.isArray(shotDetection.ranges) && shotDetection.ranges.length
    ? shotDetection.ranges
    : makeFixedRemakeShotRanges(safeDuration, safeSegmentSeconds, "fallback-time");
  const frameDir = join(outputDir, "projects", projectId, workflowId, "remake-frames", attemptId);
  await mkdir(frameDir, { recursive: true });
  const frames = [];
  for (let index = 0; index < shotRanges.length; index += 1) {
    const range = shotRanges[index];
    const start = Math.max(0, Number(range.start || 0));
    const end = Math.min(safeDuration, Math.max(start + 0.05, Number(range.end || start + safeSegmentSeconds)));
    const at = Math.min(Math.max(start + (end - start) / 2, 0), Math.max(0, safeDuration - 0.01));
    const fileName = `remake-frame-${String(index + 1).padStart(2, "0")}.jpg`;
    const outputPath = join(frameDir, fileName);
    const result = await runExternal(
      ffmpegCommand,
      ["-y", "-ss", at.toFixed(2), "-i", videoPath, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "3", outputPath],
      { timeout: 30000, allowFailure: true }
    );
    const frameRecord = {
      projectId,
      workflowId,
      workflowType,
      assetId: createScopedFrameAssetId(index + 1),
      assetType: "remake_frame",
      segmentId: `frame-${index + 1}`,
      attemptId,
      path: result.ok && existsSync(outputPath) ? toPublicPath(outputPath) : "",
      name: fileName,
      status: result.ok && existsSync(outputPath) ? "ready" : "failed",
      sourceKind: "remake-analysis",
      createdAt: new Date().toISOString(),
    };
    if (frameRecord.path) await upsertAssetManifest(frameRecord);
    frames.push({
      index: index + 1,
      start,
      end,
      at,
      shotReason: range.reason || shotDetection.mode || "scene-change",
      ok: result.ok && existsSync(outputPath),
      url: frameRecord.path,
      asset: frameRecord.path ? frameRecord : null,
      error: result.ok ? "" : result.output,
    });
  }
  const okFrames = frames.filter((frame) => frame.ok);
  const transcript = okFrames.length
    ? await transcribeRemakeAudio({ ffmpegCommand, videoPath, duration: safeDuration })
    : makeUnavailableTranscript("frame_extract_failed", "关键帧抽取失败，暂未继续语音识别。");
  const vision = okFrames.length
    ? await analyzeRemakeVisionSemantics({ frames: okFrames, transcript, productInfo })
    : makeUnavailableVision("frame_extract_failed", "关键帧抽取失败，暂未继续视觉语义解析。");
  return {
    analysisVersion: remakeAnalysisVersion,
    ok: Boolean(okFrames.length),
    error: okFrames.length ? "" : "frame_extract_failed",
    message: okFrames.length ? "" : "参考视频已上传，但关键帧抽取失败。请确认视频文件可以正常播放，或换一个 mp4 文件重试。",
    ffmpeg: ffmpegCommand,
    shotDetection,
    frames,
    transcript,
    vision,
  };
}

function createScopedFrameAssetId(index) {
  return `remake-frame-${String(index).padStart(3, "0")}-${randomUUID()}`;
}

async function createRemakeFrameSheet({
  frames,
  projectId,
  workflowId,
  workflowType,
  segmentId,
  assetId,
  attemptId,
}) {
  const ffmpegCommand = await resolveFfmpegCommand();
  if (!ffmpegCommand) {
    const error = new Error("本机没有找到 ffmpeg，无法在本地合成原片关键帧整图。");
    error.status = 501;
    error.code = "ffmpeg_missing";
    throw error;
  }
  const count = frames.length;
  const canvasWidth = 1536;
  const canvasHeight = 1024;
  const columns = Math.max(1, Math.ceil(Math.sqrt(count * (canvasWidth / canvasHeight))));
  const rows = Math.max(1, Math.ceil(count / columns));
  const cellWidth = Math.max(2, Math.floor(canvasWidth / columns / 2) * 2);
  const cellHeight = Math.max(2, Math.floor(canvasHeight / rows / 2) * 2);
  const inputArgs = frames.flatMap((frame) => ["-i", frame.filePath]);
  const filters = frames.map(
    (_, index) =>
      `[${index}:v]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,` +
      `pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:color=black[frame${index}]`
  );
  const layout = frames
    .map((_, index) => `${(index % columns) * cellWidth}_${Math.floor(index / columns) * cellHeight}`)
    .join("|");
  const inputs = frames.map((_, index) => `[frame${index}]`).join("");
  filters.push(
    `${inputs}xstack=inputs=${count}:layout=${layout}:fill=black,` +
      `pad=${columns * cellWidth}:${rows * cellHeight}:0:0:color=black,` +
      `scale=${canvasWidth}:${canvasHeight}:force_original_aspect_ratio=decrease,` +
      `pad=${canvasWidth}:${canvasHeight}:(ow-iw)/2:(oh-ih)/2:color=black[sheet]`
  );
  const frameSheetDir = join(
    outputDir,
    "projects",
    projectId,
    workflowId,
    "remake-frame-sheets",
    attemptId
  );
  await mkdir(frameSheetDir, { recursive: true });
  const fileName = `${assetId}.jpg`;
  const outputPath = join(frameSheetDir, fileName);
  const result = await runExternal(
    ffmpegCommand,
    [
      "-y",
      ...inputArgs,
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[sheet]",
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outputPath,
    ],
    { timeout: 120000, allowFailure: true }
  );
  if (!result.ok || !existsSync(outputPath)) {
    const error = new Error(`本地合成原片关键帧整图失败：${result.output || "未知错误"}`);
    error.status = 500;
    error.code = "remake_frame_sheet_failed";
    throw error;
  }
  const asset = {
    projectId,
    workflowId,
    workflowType,
    assetId,
    assetType: "remake_frame_sheet",
    segmentId,
    attemptId,
    path: toPublicPath(outputPath),
    name: fileName,
    status: "ready",
    sourceKind: "local-remake-frame-sheet",
    sourceFrameAssetIds: frames.map((frame) => frame.assetId),
    shotCount: count,
    layout: {
      columns,
      rows,
      order: "left-to-right-top-to-bottom",
      width: canvasWidth,
      height: canvasHeight,
    },
    createdAt: new Date().toISOString(),
  };
  await upsertAssetManifest(asset);
  return asset;
}

function makeFallbackRemakeAnalysisResult({ duration, segmentSeconds, error }) {
  const safeDuration = Math.max(1, Number(duration || segmentSeconds || 10));
  const safeSegmentSeconds = Math.max(4, Number(segmentSeconds || 10));
  const ranges = makeFixedRemakeShotRanges(safeDuration, safeSegmentSeconds, "fallback-time");
  const message = normalizeRemakeServerError(error);
  return {
    analysisVersion: remakeAnalysisVersion,
    ok: false,
    error: "remake_analysis_failed",
    message,
    ffmpeg: "",
    shotDetection: {
      ok: false,
      mode: "fallback-time",
      threshold: 0,
      message: "原片自动解析失败，已按固定时长返回可编辑分镜草稿。",
      changeTimes: [],
      ranges,
    },
    frames: ranges.map((range, index) => ({
      index: index + 1,
      start: range.start,
      end: range.end,
      at: range.start + Math.max(0.5, (range.end - range.start) / 2),
      shotReason: "fallback-time",
      ok: false,
      url: "",
      error: message,
    })),
    transcript: makeUnavailableTranscript("remake_analysis_failed", "原片解析中断，本次没有拿到口播识别结果。"),
    vision: makeUnavailableVision("remake_analysis_failed", "原片解析中断，本次没有拿到画面语义结果。"),
  };
}

function normalizeRemakeServerError(error) {
  const text = String(error?.message || error || "");
  if (/fetch failed|network|ECONN|ETIMEDOUT|timeout|UND_ERR/i.test(text)) {
    return "原片解析时网络请求中断或超时，已先返回固定时长兜底分镜。请稍后重新生成解析。";
  }
  return text || "原片解析失败，已先返回固定时长兜底分镜。";
}

async function detectRemakeShotRanges({ ffmpegCommand, videoPath, duration, fallbackSegmentSeconds }) {
  const safeDuration = Math.max(1, Number(duration || fallbackSegmentSeconds || 10));
  const safeFallback = Math.max(4, Number(fallbackSegmentSeconds || 10));
  const threshold = 0.22;
  const fallbackRanges = makeFixedRemakeShotRanges(safeDuration, safeFallback, "fallback-time");
  const result = await runExternal(
    ffmpegCommand,
    ["-hide_banner", "-i", videoPath, "-filter:v", `select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"],
    { timeout: Math.min(180000, Math.max(60000, Math.ceil(safeDuration * 2500))), allowFailure: true }
  );
  const changeTimes = parseSceneChangeTimes(result.output, safeDuration);
  if (!changeTimes.length) {
    return {
      ok: true,
      mode: "fallback-time",
      threshold,
      message: "没有检测到明显转场，已按固定时长兜底拆分。",
      changeTimes,
      ranges: fallbackRanges,
    };
  }
  const detectedRanges = buildRemakeShotRangesFromChanges(changeTimes, safeDuration, safeFallback);
  const ranges = detectedRanges.length > 1 ? detectedRanges : fallbackRanges;
  return {
    ok: true,
    mode: detectedRanges.length > 1 ? "scene-change" : "fallback-time",
    threshold,
    message: detectedRanges.length > 1 ? "已按画面变化自动识别分镜头。" : "转场结果过少，已按固定时长兜底拆分。",
    changeTimes,
    ranges,
  };
}

function parseSceneChangeTimes(output, duration) {
  const safeDuration = Math.max(1, Number(duration || 0));
  const times = [];
  const regex = /pts_time:([0-9.]+)/g;
  let match;
  while ((match = regex.exec(String(output || "")))) {
    const time = Number(match[1]);
    if (!Number.isFinite(time)) continue;
    if (time < 0.12 || time > safeDuration - 0.12) continue;
    const rounded = Math.round(time * 10) / 10;
    if (!times.some((item) => Math.abs(item - rounded) < 0.12)) times.push(rounded);
  }
  return times.sort((a, b) => a - b);
}

function buildRemakeShotRangesFromChanges(changeTimes, duration, fallbackSegmentSeconds) {
  const safeDuration = Math.max(1, Number(duration || 0));
  const maxRange = Math.min(15, Math.max(6, Number(fallbackSegmentSeconds || 10) * 1.5));
  const flashFrameSeconds = 0.25;
  const boundaries = [0, ...changeTimes, safeDuration]
    .map((time) => Math.max(0, Math.min(safeDuration, Number(time || 0))))
    .sort((a, b) => a - b);
  const raw = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (end - start >= 0.05) raw.push({ start, end, reason: "scene-change" });
  }
  const merged = [];
  raw.forEach((range, index) => {
    if (range.end - range.start >= flashFrameSeconds || raw.length === 1) {
      merged.push({ ...range });
      return;
    }
    if (merged.length) {
      merged[merged.length - 1].end = range.end;
      merged[merged.length - 1].reason = "scene-change-flash-filtered";
      return;
    }
    if (raw[index + 1]) raw[index + 1].start = range.start;
  });
  const split = [];
  merged.forEach((range) => {
    if (range.end - range.start <= maxRange) {
      split.push(range);
      return;
    }
    const parts = Math.ceil((range.end - range.start) / maxRange);
    const partSize = (range.end - range.start) / parts;
    for (let index = 0; index < parts; index += 1) {
      split.push({
        start: range.start + partSize * index,
        end: index === parts - 1 ? range.end : range.start + partSize * (index + 1),
        reason: "scene-change-long-split",
      });
    }
  });
  return split.map((range) => ({
    start: Number(range.start.toFixed(2)),
    end: Number(range.end.toFixed(2)),
    reason: range.reason,
  }));
}

function makeFixedRemakeShotRanges(duration, segmentSeconds, reason = "fallback-time") {
  const safeDuration = Math.max(1, Number(duration || segmentSeconds || 10));
  const safeSegmentSeconds = Math.max(4, Number(segmentSeconds || 10));
  const count = Math.max(1, Math.ceil(safeDuration / safeSegmentSeconds));
  return Array.from({ length: count }, (_, index) => ({
    start: Number((index * safeSegmentSeconds).toFixed(2)),
    end: Number(Math.min(safeDuration, (index + 1) * safeSegmentSeconds).toFixed(2)),
    reason,
  }));
}

async function transcribeRemakeAudio({ ffmpegCommand, videoPath, duration }) {
  const whisper = await resolveWhisperCommand();
  if (!whisper) {
    return makeUnavailableTranscript(
      "whisper_missing",
      "没有找到软件内置的本地语音识别组件。请重新安装最新版软件，或联系提供方检查安装包是否完整。"
    );
  }
  const modelPath = resolveWhisperModelPath();
  if (whisper.engine === "whisper.cpp" && !modelPath) {
    return makeUnavailableTranscript(
      "whisper_model_missing",
      "本地语音识别组件存在，但缺少识别模型文件。请重新安装最新版软件，或联系提供方检查安装包是否完整。"
    );
  }
  const workDir = join(outputDir, "remake-audio", `${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(workDir, { recursive: true });
  const audioPath = join(workDir, "audio.wav");
  const extract = await runExternal(
    ffmpegCommand,
    ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-t", String(Math.ceil(Number(duration || 0) || 3600)), audioPath],
    { timeout: 120000, allowFailure: true }
  );
  if (!extract.ok || !existsSync(audioPath)) {
    return makeUnavailableTranscript("audio_extract_failed", "视频音频提取失败，暂时无法识别口播。");
  }
  const asr =
    whisper.engine === "whisper.cpp"
      ? await runWhisperCpp({ whisperCommand: whisper.command, modelPath, audioPath, workDir })
      : await runPythonWhisper({ whisperCommand: whisper.command, audioPath, workDir });
  if (!asr.ok) {
    return makeUnavailableTranscript("whisper_failed", `Whisper 识别失败：${asr.output || "未知错误"}`);
  }
  const jsonPath = asr.jsonPath || join(workDir, "audio.json");
  try {
    const data = JSON.parse(await readFile(jsonPath, "utf8"));
    const sourceSegments = Array.isArray(data.segments)
      ? data.segments
      : Array.isArray(data.transcription)
        ? data.transcription
        : [];
    const segments = sourceSegments.map((segment, index) => {
      const offsetStart = Number(segment.offsets?.from);
      const offsetEnd = Number(segment.offsets?.to);
      return {
        id: `T${index + 1}`,
        start: Number.isFinite(Number(segment.start))
          ? Number(segment.start)
          : Number.isFinite(offsetStart)
            ? offsetStart / 1000
            : parseWhisperTimestamp(segment.timestamps?.from),
        end: Number.isFinite(Number(segment.end))
          ? Number(segment.end)
          : Number.isFinite(offsetEnd)
            ? offsetEnd / 1000
            : parseWhisperTimestamp(segment.timestamps?.to),
        text: String(segment.text || "").trim(),
        confidence: Number.isFinite(Number(segment.avg_logprob)) ? Number(segment.avg_logprob) : null,
      };
    });
    return {
      ok: true,
      engine: whisper.engine,
      command: whisper.command,
      model: modelPath || "",
      text: String(data.text || segments.map((segment) => segment.text).join(" ")).trim(),
      segments,
      message: segments.length ? "" : "Whisper 已运行，但没有识别到有效口播。",
    };
  } catch (error) {
    return makeUnavailableTranscript("whisper_parse_failed", `Whisper 结果解析失败：${error.message}`);
  }
}

function parseWhisperTimestamp(value) {
  const parts = String(value || "")
    .replace(",", ".")
    .split(":")
    .map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

async function runPythonWhisper({ whisperCommand, audioPath, workDir }) {
  const result = await runExternal(
    whisperCommand,
    [
      audioPath,
      "--language",
      "Chinese",
      "--task",
      "transcribe",
      "--output_format",
      "json",
      "--output_dir",
      workDir,
      "--fp16",
      "False",
    ],
    { timeout: Number(process.env.REMAKE_WHISPER_TIMEOUT_MS || 45000), allowFailure: true }
  );
  return {
    ...result,
    jsonPath: join(workDir, "audio.json"),
  };
}

async function runWhisperCpp({ whisperCommand, modelPath, audioPath, workDir }) {
  const outputBase = join(workDir, "audio");
  const result = await runExternal(
    whisperCommand,
    ["-m", modelPath, "-f", audioPath, "-l", "zh", "-oj", "-of", outputBase],
    { timeout: Number(process.env.REMAKE_WHISPER_TIMEOUT_MS || 45000), allowFailure: true }
  );
  return {
    ...result,
    jsonPath: `${outputBase}.json`,
  };
}

function makeUnavailableTranscript(error, message) {
  return {
    ok: false,
    engine: "",
    error,
    message,
    text: "",
    segments: [],
  };
}

async function analyzeRemakeVisionSemantics({ frames, transcript, productInfo }) {
  if (!config.apiKey) return makeUnavailableVision("api_key_missing", "未配置视觉解析 API key，暂时只显示关键帧证据。");
  const frameInputs = [];
  for (const frame of frames.slice(0, 8)) {
    const framePath = resolveOutputAssetPath(frame.url);
    if (!framePath) continue;
    try {
      const buffer = await readFile(framePath);
      frameInputs.push({
        frame,
        dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
      });
    } catch {
      // Skip unreadable frame.
    }
  }
  if (!frameInputs.length) return makeUnavailableVision("missing_frames", "没有可发送给视觉模型的关键帧。");
  const prompt = buildRemakeVisionPrompt({ frames: frameInputs.map((item) => item.frame), transcript, productInfo });
  const content = [
    { type: "text", text: prompt },
    ...frameInputs.flatMap((item, index) => [
      { type: "text", text: `关键帧${index + 1}：${item.frame.start}-${item.frame.end}s，中点 ${item.frame.at}s` },
      { type: "image_url", image_url: { url: item.dataUrl } },
    ]),
  ];
  try {
    const response = await callChatCompletions({
      model: config.visionModel,
      messages: [{ role: "user", content }],
      temperature: 0.2,
    }, Number(process.env.REMAKE_VISION_TIMEOUT_MS || 180000));
    const data = await safeResponseJson(response);
    if (!response.ok) {
      return makeUnavailableVision("vision_api_failed", data.message || data.error?.message || "视觉模型解析失败。");
    }
    const text = data.choices?.[0]?.message?.content || data.output_text || "";
    const parsed = parseLooseJson(text);
    return {
      ok: Boolean(parsed),
      engine: config.visionModel,
      raw: text,
      ...(parsed || {}),
      message: parsed ? "" : "视觉模型返回内容不是标准 JSON，已保留原文但未自动合并。",
    };
  } catch (error) {
    return makeUnavailableVision("vision_request_failed", humanizeTransportError(error.message || String(error)));
  }
}

function makeUnavailableVision(error, message) {
  return {
    ok: false,
    engine: "",
    error,
    message,
    segments: [],
    roles: [],
    scenes: [],
    products: [],
  };
}

function buildRemakeVisionPrompt({ frames, transcript, productInfo }) {
  return `你是短视频复刻导演。请只根据我提供的关键帧和语音识别文本，输出严格 JSON，不要 Markdown。

任务：
1. 对每个关键帧对应的时间段识别场景、人物数量/身份推断、人物关系、动作、道具/产品露出、镜头景别、情绪功能。
2. 合并全片角色候选，给出是否需要角色参考图。
3. 合并固定场景候选，重复场景只保留一个。
4. 结合语音识别文本，给每段匹配口播/字幕；不确定就写“需人工确认”，不要编台词。

产品信息：
${JSON.stringify(productInfo || {}, null, 2)}

语音识别结果：
${transcript?.ok ? JSON.stringify(transcript.segments || [], null, 2) : transcript?.message || "未识别到口播"}

关键帧时间段：
${JSON.stringify(frames.map(({ index, start, end, at }) => ({ index, start, end, at })), null, 2)}

JSON 格式：
{
  "summary": "一句话原片结构",
  "roles": [{"name":"真实人物角色名或稳定功能名，不能填写时间段、参考帧、产品字段或镜头标签","description":"年龄/身份/外观/剧情功能","relation":"人物关系推断","segmentIndexes":[1],"needsReference":true}],
  "scenes": [{"name":"场景名","description":"环境特征","segmentIndexes":[1],"needsReference":true}],
  "products": [{"name":"画面中的产品或道具","description":"出现方式","segmentIndexes":[1]}],
  "segments": [{
    "index": 1,
    "scene": "具体场景",
    "visual": "画面里真实可见的信息，不要虚构",
    "people": "人物数量、位置、关系推断",
    "actions": "动作与互动",
    "props": "道具/产品露出",
    "camera": "景别/机位/构图",
    "emotion": "情绪功能",
    "dialogue": "匹配到的口播/字幕，无法确认则写需人工确认",
    "confidence": "high|medium|low"
  }]
}`;
}

async function callChatCompletions(payload, timeoutMs = 20 * 60 * 1000) {
  return fetchWithRetry(
    `${config.apiBaseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      timeoutMs,
    },
    0
  );
}

function parseLooseJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  const candidate = fenced || (firstBrace >= 0 && lastBrace > firstBrace ? raw.slice(firstBrace, lastBrace + 1) : "");
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

async function resolveWhisperCommand() {
  for (const candidate of resolveWhisperCandidates()) {
    const result = await runExternal(candidate, ["--help"], { timeout: 10000, allowFailure: true });
    if (result.ok) return { command: candidate, engine: inferWhisperEngine(candidate, result.output) };
    if (!/ENOENT|not found|no such file|spawn/i.test(result.output || "") && /usage/i.test(result.output || "")) {
      return { command: candidate, engine: inferWhisperEngine(candidate, result.output) };
    }
  }
  return null;
}

function resolveWhisperCandidates() {
  const platformBinaries =
    process.platform === "win32"
      ? ["whisper-cli.exe", "whisper-cpp.exe", "main.exe", "whisper.exe"]
      : ["whisper-cli", "whisper-cpp", "main", "whisper"];
  const embeddedArchDir = `${process.platform}-${process.arch}`;
  return [
    process.env.WHISPER_BIN,
    ...platformBinaries.flatMap((binary) => [
      join(packagedResourcesRoot, "bin", embeddedArchDir, binary),
      join(root, "bin", embeddedArchDir, binary),
      join(homedir(), ".local", "bin", binary),
      join(homedir(), "bin", binary),
    ]),
    "/opt/homebrew/bin/whisper-cli",
    "/usr/local/bin/whisper-cli",
    "/opt/homebrew/bin/whisper-cpp",
    "/usr/local/bin/whisper-cpp",
    "/opt/homebrew/bin/whisper",
    "/usr/local/bin/whisper",
    "whisper-cli",
    "whisper-cpp",
    "whisper",
  ].filter(Boolean);
}

function inferWhisperEngine(command, helpText = "") {
  const text = `${command}\n${helpText}`;
  if (/whisper-cli|whisper-cpp|ggml|whisper\.cpp|\s-m\s|--model/i.test(text)) return "whisper.cpp";
  return "python-whisper";
}

function resolveWhisperModelPath() {
  const candidates = [
    process.env.WHISPER_MODEL,
    join(packagedResourcesRoot, "models", "whisper", "ggml-small.bin"),
    join(packagedResourcesRoot, "models", "whisper", "ggml-base.bin"),
    join(packagedResourcesRoot, "models", "whisper", "ggml-medium.bin"),
    join(root, "models", "whisper", "ggml-small.bin"),
    join(root, "models", "whisper", "ggml-base.bin"),
    join(root, "models", "whisper", "ggml-medium.bin"),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

async function resolveFfmpegCommand() {
  for (const candidate of resolveFfmpegCandidates()) {
    const result = await runExternal(candidate, ["-version"], { timeout: 5000, allowFailure: true });
    if (result.ok) return candidate;
  }
  return "";
}

function resolveFfmpegCandidates() {
  const platformBinary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const embeddedArchDir = `${process.platform}-${process.arch}`;
  return [
    process.env.FFMPEG_BIN,
    join(packagedResourcesRoot, "bin", embeddedArchDir, platformBinary),
    join(root, "bin", embeddedArchDir, platformBinary),
    process.platform === "darwin" ? "/opt/homebrew/bin/ffmpeg" : "",
    process.platform === "darwin" ? "/usr/local/bin/ffmpeg" : "",
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Programs", "ffmpeg", "bin", "ffmpeg.exe")
      : "",
    "ffmpeg",
  ].filter(Boolean);
}

function matchLineValue(text, pattern) {
  const match = String(text || "").match(pattern);
  return match ? match[1].replace(/[),，。]+$/g, "") : "";
}

function resolveOutputAssetPath(value) {
  const raw = String(value || "");
  if (!raw.startsWith("/outputs/") && !raw.startsWith("/uploads/")) return "";
  const baseDir = raw.startsWith("/outputs/") ? outputDir : uploadDir;
  const prefix = raw.startsWith("/outputs/") ? "/outputs/" : "/uploads/";
  const filePath = normalize(join(baseDir, raw.slice(prefix.length)));
  if (raw.startsWith("/outputs/")) return isInsidePath(outputDir, filePath) ? filePath : "";
  if (raw.startsWith("/uploads/")) return isInsidePath(uploadDir, filePath) ? filePath : "";
  return "";
}

function requireIdentityValue(value, label) {
  const raw = String(value || "").trim();
  if (!raw) {
    const error = new Error(`${label} is required`);
    error.status = 400;
    error.code = "missing_asset_identity";
    throw error;
  }
  const normalized = storageScopeSegment(raw, "");
  if (!normalized || normalized !== raw) {
    const error = new Error(`${label} contains unsupported characters`);
    error.status = 400;
    error.code = "invalid_asset_identity";
    throw error;
  }
  return normalized;
}

function requireWorkflowType(value) {
  const workflowType = requireIdentityValue(value, "workflowType");
  if (!["original-script", "original-product-display", "remake"].includes(workflowType)) {
    const error = new Error("workflowType is invalid");
    error.status = 400;
    error.code = "invalid_workflow_type";
    throw error;
  }
  return workflowType;
}

function assertDigitalEmployeeBindingScope(workflowType, branchId) {
  const expectedBranchByWorkflowType = {
    "original-script": "script",
    "original-product-display": "product-display",
    remake: "remake-portraits",
  };
  if (expectedBranchByWorkflowType[workflowType] !== branchId) {
    const error = new Error("digital employee branch does not match workflow type");
    error.status = 409;
    error.code = "digital_employee_scope_mismatch";
    throw error;
  }
}

async function readAssetManifest() {
  try {
    const parsed = JSON.parse(await readFile(assetManifestPath, "utf8"));
    const assets = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.assets) ? parsed.assets : [];
    const legacyAssets = Array.isArray(parsed?.legacyAssets) ? parsed.legacyAssets.filter(Boolean) : [];
    const boundAssets = [];
    assets.filter((asset) => asset && typeof asset === "object").forEach((asset) => {
      if (isBoundManifestAsset(asset)) boundAssets.push(asset);
      else legacyAssets.push({ ...asset, quarantinedAt: asset.quarantinedAt || new Date().toISOString() });
    });
    return {
      version: assetManifestVersion,
      assets: boundAssets,
      legacyAssets: legacyAssets.slice(-5000),
      updatedAt: String(parsed?.updatedAt || ""),
    };
  } catch {
    return { version: assetManifestVersion, assets: [], legacyAssets: [], updatedAt: "" };
  }
}

async function writeAssetManifest(manifest) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    assetManifestPath,
    JSON.stringify(
      {
        version: assetManifestVersion,
        updatedAt: new Date().toISOString(),
        assets: (Array.isArray(manifest?.assets) ? manifest.assets : []).slice(-5000),
        legacyAssets: (Array.isArray(manifest?.legacyAssets) ? manifest.legacyAssets : []).slice(-5000),
      },
      null,
      2
    )
  );
}

function isBoundManifestAsset(asset = {}) {
  const required = ["projectId", "workflowId", "workflowType", "assetId", "assetType", "path"];
  if (!required.every((key) => String(asset[key] || "").trim())) return false;
  if (!["original-script", "original-product-display", "remake"].includes(String(asset.workflowType || ""))) return false;
  const path = String(asset.path || "").replace(/\\/g, "/");
  if (!resolveOutputAssetPath(path)) return false;
  const uploadPrefix = `/uploads/projects/${asset.projectId}/${asset.workflowId}/`;
  const outputPrefix = `/outputs/projects/${asset.projectId}/${asset.workflowId}/`;
  if (path.startsWith("/uploads/") && !path.startsWith(uploadPrefix)) return false;
  if (
    path.startsWith("/outputs/") &&
    (!path.startsWith(outputPrefix) || !String(asset.attemptId || "").trim())
  ) {
    return false;
  }
  if (!path.startsWith("/uploads/") && !path.startsWith("/outputs/")) return false;
  if (
    ["storyboard", "segment_video", "remake_frame", "remake_frame_sheet"].includes(String(asset.assetType || "")) &&
    !String(asset.segmentId || "").trim()
  ) {
    return false;
  }
  return true;
}

function assetManifestIdentityKey(asset = {}) {
  return [
    asset.projectId,
    asset.workflowId,
    asset.workflowType,
    asset.assetId,
    asset.assetType,
    asset.segmentId || "",
    asset.attemptId || "",
    asset.path || asset.url || "",
  ]
    .map((value) => String(value || "").trim())
    .join("|");
}

async function upsertAssetManifest(record = {}) {
  const projectId = requireIdentityValue(record.projectId, "projectId");
  const workflowId = requireIdentityValue(record.workflowId, "workflowId");
  const workflowType = requireWorkflowType(record.workflowType);
  const assetId = requireIdentityValue(record.assetId, "assetId");
  const assetType = requireIdentityValue(record.assetType, "assetType");
  const path = String(record.path || record.url || "").trim();
  if (!path || !resolveOutputAssetPath(path)) {
    const error = new Error("asset path is missing or outside managed storage");
    error.status = 400;
    error.code = "invalid_asset_path";
    throw error;
  }
  const normalized = {
    ...record,
    id: assetId,
    assetId,
    assetType,
    projectId,
    workflowId,
    workflowType,
    segmentId: String(record.segmentId || "").trim(),
    attemptId: String(record.attemptId || "").trim(),
    path,
    url: path,
  };
  if (!isBoundManifestAsset(normalized)) {
    const error = new Error("asset manifest identity is incomplete");
    error.status = 400;
    error.code = "incomplete_asset_manifest";
    throw error;
  }
  const operation = assetManifestMutationQueue.then(async () => {
    const manifest = await readAssetManifest();
    const key = assetManifestIdentityKey(normalized);
    const index = manifest.assets.findIndex((asset) => assetManifestIdentityKey(asset) === key);
    if (index >= 0) manifest.assets[index] = { ...manifest.assets[index], ...normalized };
    else manifest.assets.push(normalized);
    await writeAssetManifest(manifest);
    return normalized;
  });
  assetManifestMutationQueue = operation.catch(() => undefined);
  return operation;
}

function sameAssetScope(asset = {}, scope = {}) {
  return (
    String(asset.projectId || "") === String(scope.projectId || "") &&
    String(asset.workflowId || "") === String(scope.workflowId || "") &&
    String(asset.workflowType || "") === String(scope.workflowType || "")
  );
}

function findManifestAsset(manifest, ref = {}, scope = {}) {
  const path = String(ref.path || ref.url || ref.sourcePath || "").trim();
  const segmentId = String(ref.segmentId || "").trim();
  const attemptId = String(ref.attemptId || "").trim();
  return (manifest.assets || [])
    .slice()
    .reverse()
    .find(
      (asset) =>
        sameAssetScope(asset, scope) &&
        String(asset.assetId || "") === String(ref.assetId || "") &&
        String(asset.assetType || "") === String(ref.assetType || "") &&
        String(asset.segmentId || "") === segmentId &&
        String(asset.attemptId || "") === attemptId &&
        String(asset.path || asset.url || "") === path
    );
}

async function validateInlineReferenceImages(references, scope) {
  const manifest = await readAssetManifest();
  const validated = [];
  for (const ref of references.slice(0, imageReferenceLimit)) {
    const assetId = requireIdentityValue(ref?.assetId, "reference.assetId");
    const assetType = requireIdentityValue(ref?.assetType, "reference.assetType");
    requireAssetPathValue(ref?.path || ref?.url, "reference.path");
    if (!sameAssetScope(ref, scope)) {
      const error = new Error(`参考图 ${assetId} 不属于当前项目工作流`);
      error.status = 409;
      error.code = "asset_scope_mismatch";
      throw error;
    }
    if (
      assetType === "remake_frame_sheet" &&
      (!scope.segmentId || String(ref.segmentId || "") !== String(scope.segmentId))
    ) {
      const error = new Error(`原片关键帧整图 ${assetId} 不属于当前提交段`);
      error.status = 409;
      error.code = "segment_scope_mismatch";
      throw error;
    }
    const manifestAsset = findManifestAsset(manifest, { ...ref, assetId, assetType }, scope);
    if (!manifestAsset) {
      const error = new Error(`参考图 ${assetId} 未登记或身份不匹配`);
      error.status = 409;
      error.code = "asset_manifest_mismatch";
      throw error;
    }
    const filePath = resolveOutputAssetPath(manifestAsset.path);
    if (!filePath || !existsSync(filePath)) {
      const error = new Error(`参考图 ${assetId} 的文件不存在`);
      error.status = 404;
      error.code = "asset_file_missing";
      throw error;
    }
    const mimeType = mimeTypes[extname(filePath).toLowerCase()]?.split(";")[0] || "image/png";
    const fileInfo = await stat(filePath);
    validated.push({
      projectId: scope.projectId,
      workflowId: scope.workflowId,
      workflowType: scope.workflowType,
      assetId,
      assetType,
      segmentId: String(ref.segmentId || manifestAsset.segmentId || ""),
      name: String(ref.name || manifestAsset.name || basename(filePath)),
      mimeType,
      filePath,
      byteLength: fileInfo.size,
    });
  }
  return validated;
}

function normalizeReferenceAssetIds(values) {
  if (values == null) return [];
  if (!Array.isArray(values)) {
    const error = new Error("referenceAssetIds must be an array");
    error.status = 400;
    error.code = "invalid_reference_asset_ids";
    throw error;
  }
  const normalized = values.map((value) => requireIdentityValue(value, "referenceAssetId"));
  if (new Set(normalized).size !== normalized.length) {
    const error = new Error("参考图资产 ID 重复，已阻止生成。");
    error.status = 409;
    error.code = "duplicate_reference_asset_ids";
    throw error;
  }
  return normalized;
}

function assertReferenceAssetIdsMatch(expected, actual, message) {
  const left = [...expected].sort();
  const right = [...actual].sort();
  if (left.length === right.length && left.every((value, index) => value === right[index])) return;
  const error = new Error(message);
  error.status = 409;
  error.code = "reference_asset_mismatch";
  throw error;
}

function assertRequiredReferenceAssetIdsIncluded(required, actual, message) {
  const actualIds = new Set(actual);
  if (required.every((assetId) => actualIds.has(assetId))) return;
  const error = new Error(message);
  error.status = 409;
  error.code = "required_reference_asset_missing";
  throw error;
}

function validatePromptAssetReference(ref, scope) {
  const assetId = requireIdentityValue(ref?.assetId, "promptAsset.assetId");
  const assetType = requireIdentityValue(ref?.assetType, "promptAsset.assetType");
  const segmentId = requireIdentityValue(ref?.segmentId, "promptAsset.segmentId");
  if (assetType !== "video_prompt" || segmentId !== scope.segmentId || !sameAssetScope(ref, scope)) {
    const error = new Error("视频提示词身份与当前分镜不一致");
    error.status = 409;
    error.code = "prompt_scope_mismatch";
    throw error;
  }
  return {
    projectId: scope.projectId,
    workflowId: scope.workflowId,
    workflowType: scope.workflowType,
    segmentId,
    assetId,
    assetType,
    contentHash: String(ref.contentHash || ""),
  };
}

async function validateStoredAssetReferences(references, scope, limit = 100) {
  const manifest = await readAssetManifest();
  const allowedTypes = Array.isArray(scope.allowedTypes)
    ? scope.allowedTypes
    : [
        "role",
        "scene",
        "storyboard",
        "product_upload",
        "portrait_upload",
        "scene_reference_upload",
        "reference_video_upload",
        "remake_frame",
        "remake_frame_sheet",
        "segment_video",
        "stitched_video",
      ];
  const validated = [];
  for (const ref of references.slice(0, limit)) {
    const assetId = requireIdentityValue(ref?.assetId, "asset.assetId");
    const assetType = requireIdentityValue(ref?.assetType, "asset.assetType");
    requireAssetPathValue(ref?.path || ref?.url, "asset.path");
    if (!allowedTypes.includes(assetType) || !sameAssetScope(ref, scope)) {
      const error = new Error(`资产 ${assetId} 不属于当前项目工作流或类型不允许`);
      error.status = 409;
      error.code = "asset_scope_mismatch";
      throw error;
    }
    if (
      ["storyboard", "segment_video"].includes(assetType) &&
      scope.segmentId &&
      String(ref.segmentId || "") !== String(scope.segmentId)
    ) {
      const error = new Error(`资产 ${assetId} 不属于当前分镜`);
      error.status = 409;
      error.code = "segment_scope_mismatch";
      throw error;
    }
    const manifestAsset = findManifestAsset(manifest, { ...ref, assetId, assetType }, scope);
    if (!manifestAsset) {
      const error = new Error(`资产 ${assetId} 未登记或路径与身份不匹配`);
      error.status = 409;
      error.code = "asset_manifest_mismatch";
      throw error;
    }
    const filePath = resolveOutputAssetPath(manifestAsset.path);
    if (!filePath || !existsSync(filePath)) {
      const error = new Error(`资产 ${assetId} 的文件不存在`);
      error.status = 404;
      error.code = "asset_file_missing";
      throw error;
    }
    validated.push({ ...manifestAsset, filePath });
  }
  return validated;
}

function stripResolvedAssetPath(asset = {}) {
  const { filePath: _filePath, ...record } = asset;
  return record;
}

function requireAssetPathValue(value, label) {
  const path = String(value || "").trim();
  if (!path || (!path.startsWith("/uploads/") && !path.startsWith("/outputs/"))) {
    const error = new Error(`${label} is required and must use managed storage`);
    error.status = 400;
    error.code = "invalid_asset_path";
    throw error;
  }
  return path;
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function calculateDreaminaUsage(submissions = [], now = new Date()) {
  const todayKey = toLocalDateKey(now);
  return (Array.isArray(submissions) ? submissions : []).reduce(
    (summary, submission) => {
      const cost = getSubmissionDreaminaCost(submission);
      if (!cost) return summary;
      summary.totalSpent += cost;
      const spentAt = submission.startedAt || submission.completedAt;
      if (toLocalDateKey(spentAt) === todayKey) summary.todaySpent += cost;
      return summary;
    },
    { todaySpent: 0, totalSpent: 0 }
  );
}

function getSubmissionDreaminaCost(submission = {}) {
  if (!isChargeableDreaminaSubmission(submission)) return 0;
  const stored = Number(submission.dreaminaCost || 0);
  if (Number.isFinite(stored) && stored > 0) return Math.round(stored);
  const parsed = parseDreaminaCreditCount(submission.output);
  if (parsed > 0) return parsed;
  const duration = Number(submission.duration || parseDreaminaDuration(submission.output) || 0);
  if (!duration) return 0;
  return Math.max(1, Math.round(duration * dreaminaFallbackCreditPerSecond));
}

function parseDreaminaCreditCount(output = "") {
  const text = String(output || "");
  const match = text.match(/"credit_count"\s*:\s*(\d+(?:\.\d+)?)/i) || text.match(/credit_count['"]?\s*[:=]\s*(\d+(?:\.\d+)?)/i);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function parseDreaminaDuration(output = "") {
  const text = String(output || "");
  const argMatch = text.match(/--duration=(\d+(?:\.\d+)?)/i);
  if (argMatch) return Number(argMatch[1]) || 0;
  const jsonMatch = text.match(/"duration"\s*:\s*(\d+(?:\.\d+)?)/i);
  if (jsonMatch) return Number(jsonMatch[1]) || 0;
  return 0;
}

function isChargeableDreaminaSubmission(submission = {}) {
  if (Array.isArray(submission.videos) && submission.videos.length > 0) return true;
  if (parseDreaminaCreditCount(submission.submitOutput || submission.output) > 0) return true;
  return isDreaminaCompletedStatus(submission.genStatus) && !isDreaminaExplicitFailure(submission);
}

function toLocalDateKey(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function readSubmissions() {
  try {
    const data = JSON.parse(await readFile(submissionsPath, "utf8"));
    return Array.isArray(data) ? data.map(normalizeSubmissionRecord) : [];
  } catch {
    return [];
  }
}

function normalizeSubmissionRecord(record) {
  return {
    ...record,
    duration: Number(record?.duration || 0),
    dreaminaCost: Number(record?.dreaminaCost || 0),
    videos: Array.isArray(record?.videos)
      ? record.videos.map((video) => ({
          ...video,
          path: toPublicPath(video.path) || video.path || "",
        }))
      : [],
  };
}

async function writeSubmissions(submissions) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(submissionsPath, JSON.stringify(submissions.slice(-300), null, 2));
}

async function readDigitalModelStore() {
  try {
    const raw = await readFile(digitalModelsPath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || !Array.isArray(data.models)) {
      throw new Error("invalid digital model store shape");
    }
    return {
      version: 1,
      models: Array.isArray(data?.models) ? data.models.map(normalizeDigitalModel).filter(Boolean) : [],
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, models: [] };
    throw digitalModelError(
      500,
      "digital_model_store_unreadable",
      "数字角色数据文件无法读取。为避免覆盖已有角色，系统已停止写入，请检查数据文件或从备份恢复后重试。"
    );
  }
}

async function writeDigitalModelStore(store) {
  await mkdir(dataDir, { recursive: true });
  const next = {
    version: 1,
    models: Array.isArray(store?.models) ? store.models.map(normalizeDigitalModel).filter(Boolean) : [],
  };
  const tempPath = `${digitalModelsPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(next, null, 2));
    await rename(tempPath, digitalModelsPath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

function mutateDigitalModelStore(mutator) {
  const operation = digitalModelMutationQueue.then(async () => {
    const store = await readDigitalModelStore();
    const result = await mutator(store);
    await writeDigitalModelStore(store);
    return result;
  });
  digitalModelMutationQueue = operation.catch(() => {});
  return operation;
}

function normalizeDigitalModel(model) {
  if (!model || typeof model !== "object" || !String(model.id || "").trim()) return null;
  const images = Array.isArray(model.referenceImages)
    ? model.referenceImages
        .map((image, index) => normalizeDigitalModelImage(image, model.id, index))
        .filter(Boolean)
        .sort((left, right) => left.sortOrder - right.sortOrder)
    : [];
  const cover = images.find((image) => image.isCover) || images[0] || null;
  images.forEach((image, index) => {
    image.sortOrder = index;
    image.isCover = Boolean(cover && image.id === cover.id);
  });
  return {
    id: String(model.id),
    name: String(model.name || "").trim().slice(0, 20),
    description: String(model.description || "").trim().slice(0, 200),
    coverImageUrl: cover?.imageUrl || "",
    referenceImages: images,
    appearance: normalizeDigitalModelAppearance(model.appearance),
    voiceBinding: normalizeDigitalModelVoiceBinding(model.voiceBinding, model.id),
    creationMode: "reference_images",
    provider: model.provider ? String(model.provider) : null,
    providerModelId: model.providerModelId ? String(model.providerModelId) : null,
    status: ["draft", "ready", "disabled"].includes(model.status) ? model.status : "ready",
    consentConfirmed: Boolean(model.consentConfirmed),
    createdAt: String(model.createdAt || new Date().toISOString()),
    updatedAt: String(model.updatedAt || model.createdAt || new Date().toISOString()),
    lastUsedAt: model.lastUsedAt ? String(model.lastUsedAt) : null,
  };
}

function normalizeDigitalModelImage(image, modelId, fallbackOrder = 0) {
  if (!image || typeof image !== "object" || !String(image.id || "").trim()) return null;
  const imageUrl = String(image.imageUrl || "").trim();
  if (!imageUrl.startsWith(`/uploads/digital-models/${modelId}/`)) return null;
  return {
    id: String(image.id),
    modelId: String(modelId),
    imageUrl,
    sortOrder: Number.isFinite(Number(image.sortOrder)) ? Number(image.sortOrder) : fallbackOrder,
    isCover: Boolean(image.isCover),
    createdAt: String(image.createdAt || new Date().toISOString()),
    originalName: String(image.originalName || "角色参考图").slice(0, 180),
  };
}

function normalizeDigitalModelAppearance(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ageStyle: String(source.ageStyle || "").trim().slice(0, 60),
    temperament: String(source.temperament || "").trim().slice(0, 100),
    hairstyle: String(source.hairstyle || "").trim().slice(0, 100),
    bodyType: String(source.bodyType || "").trim().slice(0, 100),
    clothingStyle: String(source.clothingStyle || "").trim().slice(0, 100),
    commonScene: String(source.commonScene || "").trim().slice(0, 120),
  };
}

function normalizeDigitalModelVoiceBinding(value, modelId) {
  if (!value || typeof value !== "object") return null;
  const source = String(value.source || "");
  if (source === "library") {
    const voiceId = String(value.voiceId || "").trim();
    if (!voiceId) return null;
    return {
      source,
      voiceId,
      name: String(value.name || "声音库声音").trim().slice(0, 80),
      sampleAudioUrl: String(value.sampleAudioUrl || "").trim(),
      previewAudioUrl: String(value.previewAudioUrl || "").trim(),
      status: String(value.status || "").trim(),
    };
  }
  if (source === "upload") {
    const voiceAssetId = String(value.voiceAssetId || "").trim();
    const sampleAudioUrl = String(value.sampleAudioUrl || "").trim();
    if (!voiceAssetId || !sampleAudioUrl.startsWith(`/uploads/digital-models/${modelId}/`)) return null;
    return {
      source,
      voiceAssetId,
      name: String(value.name || "角色声音").trim().slice(0, 180),
      sampleAudioUrl,
      previewAudioUrl: sampleAudioUrl,
      mimeType: String(value.mimeType || "audio/mpeg").trim(),
      size: Math.max(0, Number(value.size || 0)),
      duration: Math.max(0, Number(value.duration || 0)),
      status: "ready",
      createdAt: String(value.createdAt || new Date().toISOString()),
    };
  }
  return null;
}

function publicDigitalModel(model) {
  return normalizeDigitalModel(model);
}

function compareDigitalModels(left, right, sort) {
  if (sort === "oldest") return String(left.createdAt).localeCompare(String(right.createdAt));
  if (sort === "updated") return String(right.updatedAt).localeCompare(String(left.updatedAt));
  return String(right.createdAt).localeCompare(String(left.createdAt));
}

async function getDigitalModel(modelId) {
  const store = await readDigitalModelStore();
  const model = store.models.find((item) => item.id === modelId);
  if (!model) throw digitalModelError(404, "digital_model_not_found", "没有找到这个数字角色，它可能已被删除。");
  return model;
}

// A digital model is a reusable library record. Before it can participate in a
// workflow, copy its source files into that workflow's owned asset scope.
async function bindDigitalModelToWorkflow(scope) {
  const model = await getDigitalModel(scope.modelId);
  if (model.status !== "ready") {
    throw digitalModelError(409, "digital_model_unavailable", "这个数字角色当前不可用，请在数字角色库中确认它是可用状态。");
  }
  const bindingId = `digital-binding-${randomUUID()}`;
  const bindingDir = join(uploadDir, "projects", scope.projectId, scope.workflowId, scope.branchId, bindingId);
  const publicPrefix = `/uploads/projects/${scope.projectId}/${scope.workflowId}/${scope.branchId}/${bindingId}/`;
  await mkdir(bindingDir, { recursive: true });
  const copiedPaths = [];
  try {
    const portraits = [];
    for (const [index, image] of model.referenceImages.entries()) {
      const sourcePath = digitalModelImageFilePath(image.imageUrl);
      if (!existsSync(sourcePath)) {
        throw digitalModelError(409, "digital_model_image_missing", `数字角色「${model.name}」的参考图已丢失，请在数字角色库中重新上传。`);
      }
      const assetId = `digital-portrait-${randomUUID()}`;
      const ext = extname(sourcePath).toLowerCase() || ".png";
      const fileName = `${String(index + 1).padStart(2, "0")}-${assetId}${ext}`;
      const targetPath = join(bindingDir, fileName);
      await copyFile(sourcePath, targetPath);
      copiedPaths.push(targetPath);
      const portrait = {
        id: assetId,
        assetId,
        assetType: "portrait_upload",
        projectId: scope.projectId,
        workflowId: scope.workflowId,
        workflowType: scope.workflowType,
        branchId: scope.branchId,
        name: `${model.name} 数字角色参考图 ${index + 1}`,
        url: `${publicPrefix}${fileName}`,
        roleName: scope.roleKey,
        skipRoleReference: false,
        roleAssignmentPending: false,
        digitalBinding: {
          bindingId,
          digitalModelId: model.id,
          snapshotName: model.name,
          roleKey: scope.roleKey,
          isDigitalEmployee: true,
          snapshotAt: new Date().toISOString(),
        },
      };
      await upsertAssetManifest({
        ...portrait,
        path: portrait.url,
        status: "ready",
        sourceKind: "digital_model_snapshot",
        createdAt: new Date().toISOString(),
      });
      portraits.push(portrait);
    }

    let voice = null;
    const binding = model.voiceBinding;
    // Only locally uploaded sound can be snapshotted without claiming a library
    // voice was synthesized for dialogue. Library voices remain metadata until
    // a dedicated per-line synthesis step is requested.
    if (binding?.source === "upload" && binding.sampleAudioUrl) {
      const sourcePath = digitalModelImageFilePath(binding.sampleAudioUrl);
      if (existsSync(sourcePath)) {
        const assetId = `digital-voice-${randomUUID()}`;
        const ext = extname(sourcePath).toLowerCase() || ".mp3";
        const fileName = `voice-${assetId}${ext}`;
        const targetPath = join(bindingDir, fileName);
        await copyFile(sourcePath, targetPath);
        copiedPaths.push(targetPath);
        voice = {
          id: assetId,
          assetId,
          assetType: "digital_employee_voice",
          projectId: scope.projectId,
          workflowId: scope.workflowId,
          workflowType: scope.workflowType,
          branchId: scope.branchId,
          name: `${model.name} 数字角色声音`,
          url: `${publicPrefix}${fileName}`,
          roleName: scope.roleKey,
          duration: Number(binding.duration || 0),
          digitalBinding: {
            bindingId,
            digitalModelId: model.id,
            snapshotName: model.name,
            roleKey: scope.roleKey,
            isDigitalEmployee: true,
            source: "upload",
            snapshotAt: new Date().toISOString(),
          },
        };
        await upsertAssetManifest({
          ...voice,
          path: voice.url,
          status: "ready",
          sourceKind: "digital_model_voice_snapshot",
          createdAt: new Date().toISOString(),
        });
      }
    }
    await mutateDigitalModelStore((store) => {
      const item = store.models.find((candidate) => candidate.id === model.id);
      if (item) item.lastUsedAt = new Date().toISOString();
    });
    return {
      binding: {
        bindingId,
        projectId: scope.projectId,
        workflowId: scope.workflowId,
        workflowType: scope.workflowType,
        branchId: scope.branchId,
        roleKey: scope.roleKey,
        digitalModelId: model.id,
        snapshotName: model.name,
        snapshotDescription: model.description,
        portraitAssetIds: portraits.map((portrait) => portrait.assetId),
        voiceAssetId: voice?.assetId || "",
        voiceStatus: voice ? "ready" : binding?.source === "library" ? "library_voice_requires_synthesis" : "not_configured",
        createdAt: new Date().toISOString(),
      },
      portraits,
      voice,
    };
  } catch (error) {
    await Promise.all(copiedPaths.map((path) => rm(path, { force: true }).catch(() => {})));
    await rm(bindingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function createDigitalModel(body) {
  const input = validateDigitalModelInput(body, { requireConsent: true });
  const files = validateDigitalModelFiles(body?.files, { min: 1, max: 8 });
  return mutateDigitalModelStore(async (store) => {
    assertUniqueDigitalModelName(store, input.name);
    const modelId = randomUUID();
    const createdAt = new Date().toISOString();
    const modelDir = join(digitalModelsUploadDir, modelId);
    await mkdir(modelDir, { recursive: true });
    try {
      const referenceImages = await saveDigitalModelFiles(modelId, files, modelDir, createdAt);
      const requestedCoverId = String(body?.coverImageId || "");
      const cover = referenceImages.find((image) => image.id === requestedCoverId) || referenceImages[0];
      referenceImages.forEach((image, index) => {
        image.sortOrder = index;
        image.isCover = image.id === cover.id;
      });
      const voiceBinding = await resolveDigitalModelVoiceBinding(body?.voiceBinding, {
        modelId,
        modelDir,
        current: null,
      });
      const model = normalizeDigitalModel({
        id: modelId,
        ...input,
        coverImageUrl: cover.imageUrl,
        referenceImages,
        voiceBinding,
        creationMode: "reference_images",
        provider: null,
        providerModelId: null,
        status: "ready",
        consentConfirmed: true,
        createdAt,
        updatedAt: createdAt,
      });
      store.models.push(model);
      return model;
    } catch (error) {
      await rm(modelDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  });
}

async function updateDigitalModel(modelId, body) {
  return mutateDigitalModelStore(async (store) => {
    const index = store.models.findIndex((item) => item.id === modelId);
    if (index < 0) throw digitalModelError(404, "digital_model_not_found", "没有找到这个数字角色，它可能已被删除。");
    const current = store.models[index];
    const input = validateDigitalModelInput(
      {
        name: body?.name ?? current.name,
        description: body?.description ?? current.description,
        appearance: body?.appearance ?? current.appearance,
        consentConfirmed: body?.consentConfirmed ?? current.consentConfirmed,
      },
      { requireConsent: true }
    );
    assertUniqueDigitalModelName(store, input.name, modelId);
    const status = body?.status === undefined ? current.status : String(body.status);
    if (!["draft", "ready", "disabled"].includes(status)) {
      throw digitalModelError(400, "invalid_digital_model_status", "角色状态无效，请刷新页面后重试。");
    }
    const voiceBinding = Object.prototype.hasOwnProperty.call(body || {}, "voiceBinding")
      ? await resolveDigitalModelVoiceBinding(body.voiceBinding, {
          modelId,
          modelDir: join(digitalModelsUploadDir, modelId),
          current: current.voiceBinding,
        })
      : current.voiceBinding;
    const next = normalizeDigitalModel({
      ...current,
      ...input,
      status,
      voiceBinding,
      updatedAt: new Date().toISOString(),
    });
    store.models[index] = next;
    return next;
  });
}

async function addDigitalModelImages(modelId, body) {
  const files = validateDigitalModelFiles(body?.files, { min: 1, max: 8 });
  return mutateDigitalModelStore(async (store) => {
    const index = store.models.findIndex((item) => item.id === modelId);
    if (index < 0) throw digitalModelError(404, "digital_model_not_found", "没有找到这个数字角色，它可能已被删除。");
    const current = store.models[index];
    if (current.referenceImages.length + files.length > 8) {
      throw digitalModelError(400, "digital_model_image_limit", "每个数字角色最多保存 8 张参考图，请先删除不需要的图片。");
    }
    const modelDir = join(digitalModelsUploadDir, modelId);
    await mkdir(modelDir, { recursive: true });
    const createdAt = new Date().toISOString();
    const saved = await saveDigitalModelFiles(
      modelId,
      files,
      modelDir,
      createdAt,
      new Set(current.referenceImages.map((image) => image.id))
    );
    const referenceImages = [...current.referenceImages, ...saved].map((image, sortOrder) => ({
      ...image,
      sortOrder,
      isCover: current.referenceImages.length ? image.isCover : sortOrder === 0,
    }));
    const next = normalizeDigitalModel({
      ...current,
      referenceImages,
      updatedAt: createdAt,
    });
    store.models[index] = next;
    return next;
  });
}

async function arrangeDigitalModelImages(modelId, body) {
  return mutateDigitalModelStore(async (store) => {
    const index = store.models.findIndex((item) => item.id === modelId);
    if (index < 0) throw digitalModelError(404, "digital_model_not_found", "没有找到这个数字角色，它可能已被删除。");
    const current = store.models[index];
    const knownIds = new Set(current.referenceImages.map((image) => image.id));
    const requestedOrder = Array.isArray(body?.order) ? body.order.map(String) : [];
    if (
      requestedOrder.length !== current.referenceImages.length ||
      new Set(requestedOrder).size !== knownIds.size ||
      requestedOrder.some((id) => !knownIds.has(id))
    ) {
      throw digitalModelError(400, "invalid_digital_model_image_order", "参考图顺序已变化，请刷新角色详情后重新调整。");
    }
    const coverImageId = String(body?.coverImageId || "");
    if (!knownIds.has(coverImageId)) {
      throw digitalModelError(400, "invalid_digital_model_cover", "请选择当前角色已有的图片作为主图。");
    }
    const byId = new Map(current.referenceImages.map((image) => [image.id, image]));
    const referenceImages = requestedOrder.map((id, sortOrder) => ({
      ...byId.get(id),
      sortOrder,
      isCover: id === coverImageId,
    }));
    const next = normalizeDigitalModel({
      ...current,
      referenceImages,
      updatedAt: new Date().toISOString(),
    });
    store.models[index] = next;
    return next;
  });
}

async function deleteDigitalModelImage(modelId, imageId) {
  return mutateDigitalModelStore(async (store) => {
    const index = store.models.findIndex((item) => item.id === modelId);
    if (index < 0) throw digitalModelError(404, "digital_model_not_found", "没有找到这个数字角色，它可能已被删除。");
    const current = store.models[index];
    if (current.referenceImages.length <= 1) {
      throw digitalModelError(400, "digital_model_last_image", "数字角色必须至少保留 1 张参考图，不能删除最后一张。");
    }
    const target = current.referenceImages.find((image) => image.id === imageId);
    if (!target) throw digitalModelError(404, "digital_model_image_not_found", "没有找到这张参考图，请刷新角色详情。");
    const referenceImages = current.referenceImages
      .filter((image) => image.id !== imageId)
      .map((image, sortOrder) => ({ ...image, sortOrder }));
    if (!referenceImages.some((image) => image.isCover)) referenceImages[0].isCover = true;
    const next = normalizeDigitalModel({
      ...current,
      referenceImages,
      updatedAt: new Date().toISOString(),
    });
    store.models[index] = next;
    await rm(digitalModelImageFilePath(target.imageUrl), { force: true }).catch(() => {});
    return next;
  });
}

async function deleteDigitalModel(modelId) {
  return mutateDigitalModelStore(async (store) => {
    const index = store.models.findIndex((item) => item.id === modelId);
    if (index < 0) throw digitalModelError(404, "digital_model_not_found", "没有找到这个数字角色，它可能已被删除。");
    store.models.splice(index, 1);
    await rm(join(digitalModelsUploadDir, modelId), { recursive: true, force: true });
    return true;
  });
}

function validateDigitalModelInput(body, options = {}) {
  const name = String(body?.name || "").trim();
  if (!name) throw digitalModelError(400, "digital_model_name_required", "请填写角色名称后再保存。");
  if ([...name].length > 20) {
    throw digitalModelError(400, "digital_model_name_too_long", "角色名称最多 20 个字符，请缩短后再保存。");
  }
  const description = String(body?.description || "").trim();
  if ([...description].length > 200) {
    throw digitalModelError(400, "digital_model_description_too_long", "角色备注最多 200 个字符，请精简后再保存。");
  }
  if (options.requireConsent && !body?.consentConfirmed) {
    throw digitalModelError(400, "digital_model_consent_required", "请先确认已获得人物肖像和图片的合法使用授权。");
  }
  return {
    name,
    description,
    appearance: normalizeDigitalModelAppearance(body?.appearance),
    consentConfirmed: Boolean(body?.consentConfirmed),
  };
}

function validateDigitalModelFiles(files, limits = {}) {
  const list = Array.isArray(files) ? files : [];
  const min = Number(limits.min || 0);
  const max = Number(limits.max || 8);
  if (list.length < min) {
    throw digitalModelError(400, "digital_model_image_required", "请至少上传 1 张角色参考图。");
  }
  if (list.length > max) {
    throw digitalModelError(400, "digital_model_image_limit", `本次最多可上传 ${max} 张参考图，请减少图片数量。`);
  }
  return list.map((file, index) => {
    let parsed;
    try {
      parsed = parseDataUrl(file?.dataUrl);
    } catch {
      throw digitalModelError(400, "digital_model_image_invalid", `第 ${index + 1} 张图片无法读取，请重新选择 JPG、PNG 或 WEBP 图片。`);
    }
    const mimeType = String(parsed.mimeType || "").toLowerCase();
    const extensions = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
    };
    if (!extensions[mimeType]) {
      throw digitalModelError(400, "digital_model_image_type", `第 ${index + 1} 张图片格式不支持，请使用 JPG、PNG 或 WEBP。`);
    }
    if (parsed.buffer.length > 10 * 1024 * 1024) {
      throw digitalModelError(400, "digital_model_image_size", `第 ${index + 1} 张图片超过 10MB，请压缩后重新上传。`);
    }
    if (!parsed.buffer.length || !digitalModelImageSignatureMatches(parsed.buffer, mimeType)) {
      throw digitalModelError(
        400,
        "digital_model_image_content_invalid",
        `第 ${index + 1} 张文件不是有效的 ${mimeType === "image/jpeg" ? "JPG" : mimeType === "image/png" ? "PNG" : "WEBP"} 图片，请重新导出后上传。`
      );
    }
    return {
      id: String(file?.id || randomUUID()),
      originalName: String(file?.name || `角色参考图${index + 1}`).slice(0, 180),
      buffer: parsed.buffer,
      extension: extensions[mimeType],
    };
  });
}

function digitalModelImageSignatureMatches(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (mimeType === "image/jpeg") return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === "image/png") {
    return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/webp") {
    return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

async function resolveDigitalModelVoiceBinding(value, context) {
  const source = String(value?.source || "none");
  if (source === "none") return null;
  if (source === "library") {
    const voiceId = String(value?.voiceId || "").trim();
    if (!voiceId) {
      throw digitalModelError(400, "digital_model_voice_required", "请从声音库选择一个声音，或改为不绑定声音。");
    }
    const voiceStore = await readVoiceStore();
    const voice = voiceStore.voices.find((item) => String(item?.id || "") === voiceId);
    if (!voice) {
      throw digitalModelError(404, "digital_model_voice_not_found", "声音库中没有找到所选声音，请刷新声音库后重新选择。");
    }
    const publicVoice = publicVoiceItem(voice);
    return normalizeDigitalModelVoiceBinding(
      {
        source,
        voiceId,
        name: publicVoice.name,
        sampleAudioUrl: publicVoice.sampleAudioUrl,
        previewAudioUrl: publicVoice.previewAudioUrl,
        status: publicVoice.status,
      },
      context.modelId
    );
  }
  if (source !== "upload") {
    throw digitalModelError(400, "invalid_digital_model_voice_source", "角色声音来源无效，请重新选择声音来源。");
  }

  const current = normalizeDigitalModelVoiceBinding(context.current, context.modelId);
  const requestedAssetId = String(value?.voiceAssetId || "").trim();
  if (!value?.file) {
    if (current?.source === "upload" && requestedAssetId && current.voiceAssetId === requestedAssetId) return current;
    throw digitalModelError(400, "digital_model_voice_file_required", "请选择要绑定的声音文件，或改为不绑定声音。");
  }

  const file = validateDigitalModelVoiceFile(value.file);
  let voiceAssetId = /^[a-zA-Z0-9_-]{8,80}$/.test(requestedAssetId) ? requestedAssetId : randomUUID();
  if (current?.source === "upload" && current.voiceAssetId === voiceAssetId) voiceAssetId = randomUUID();
  await mkdir(context.modelDir, { recursive: true });
  const fileName = `voice-${voiceAssetId}${file.extension}`;
  try {
    await writeFile(join(context.modelDir, fileName), file.buffer, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw digitalModelError(409, "digital_model_voice_conflict", "声音资产编号冲突，请重新选择声音文件后保存。");
    }
    throw error;
  }
  return normalizeDigitalModelVoiceBinding(
    {
      source,
      voiceAssetId,
      name: file.originalName,
      sampleAudioUrl: `/uploads/digital-models/${context.modelId}/${fileName}`,
      mimeType: file.mimeType,
      size: file.buffer.length,
      duration: file.duration,
      createdAt: new Date().toISOString(),
    },
    context.modelId
  );
}

function validateDigitalModelVoiceFile(file) {
  let parsed;
  try {
    parsed = parseDataUrl(file?.dataUrl);
  } catch {
    throw digitalModelError(400, "digital_model_voice_invalid", "声音文件无法读取，请重新上传 MP3、WAV 或 M4A 文件。");
  }
  const mimeType = String(parsed.mimeType || "").toLowerCase();
  const extension = extensionForVoiceMime(mimeType, file?.name);
  const allowedMimeTypes = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4", "audio/x-m4a"]);
  if (!allowedMimeTypes.has(mimeType) || ![".mp3", ".wav", ".m4a"].includes(extension)) {
    throw digitalModelError(400, "digital_model_voice_type", "声音格式不支持，请上传 MP3、WAV 或 M4A 文件。");
  }
  if (!parsed.buffer.length) {
    throw digitalModelError(400, "digital_model_voice_empty", "声音文件为空，请重新选择。");
  }
  if (parsed.buffer.length > 20 * 1024 * 1024) {
    throw digitalModelError(400, "digital_model_voice_size", "声音文件超过 20MB，请压缩后重新上传。");
  }
  if (!digitalModelVoiceSignatureMatches(parsed.buffer, extension)) {
    throw digitalModelError(400, "digital_model_voice_content_invalid", "声音文件内容与格式不匹配，请重新导出后上传。");
  }
  const duration = Number(file?.duration || 0);
  if (Number.isFinite(duration) && duration > 300) {
    throw digitalModelError(400, "digital_model_voice_duration", "声音文件超过 5 分钟，请裁剪后重新上传。");
  }
  return {
    originalName: String(file?.name || "角色声音").slice(0, 180),
    mimeType,
    extension,
    buffer: parsed.buffer,
    duration: Number.isFinite(duration) ? Math.max(0, duration) : 0,
  };
}

function digitalModelVoiceSignatureMatches(buffer, extension) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  if (extension === ".wav") {
    return buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE";
  }
  if (extension === ".m4a") {
    return buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp";
  }
  return buffer.subarray(0, 3).toString("ascii") === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
}

async function saveDigitalModelFiles(modelId, files, modelDir, createdAt, reservedIds = new Set()) {
  const images = [];
  const usedIds = new Set(reservedIds);
  const writtenPaths = [];
  for (const [index, file] of files.entries()) {
    let imageId = /^[a-zA-Z0-9_-]{8,80}$/.test(file.id) ? file.id : randomUUID();
    while (usedIds.has(imageId)) imageId = randomUUID();
    usedIds.add(imageId);
    const fileName = `${imageId}${file.extension}`;
    const filePath = join(modelDir, fileName);
    try {
      await writeFile(filePath, file.buffer, { flag: "wx" });
      writtenPaths.push(filePath);
      images.push({
        id: imageId,
        modelId,
        imageUrl: `/uploads/digital-models/${modelId}/${fileName}`,
        sortOrder: index,
        isCover: index === 0,
        createdAt,
        originalName: file.originalName,
      });
    } catch (error) {
      await Promise.all(writtenPaths.map((path) => rm(path, { force: true }).catch(() => {})));
      if (error?.code === "EEXIST") {
        throw digitalModelError(409, "digital_model_image_conflict", "参考图片资产编号冲突，请重新选择图片后再上传。");
      }
      throw error;
    }
  }
  return images;
}

function assertUniqueDigitalModelName(store, name, ignoreId = "") {
  const normalizedName = String(name).trim().toLocaleLowerCase("zh-CN");
  const duplicate = store.models.find(
    (model) => model.id !== ignoreId && model.name.trim().toLocaleLowerCase("zh-CN") === normalizedName
  );
  if (duplicate) {
    throw digitalModelError(409, "digital_model_name_duplicate", "已经存在同名数字角色，请换一个名称后再保存。");
  }
}

function digitalModelImageFilePath(imageUrl) {
  const prefix = "/uploads/digital-models/";
  const raw = String(imageUrl || "");
  if (!raw.startsWith(prefix)) return join(digitalModelsUploadDir, "__invalid__");
  const filePath = normalize(join(digitalModelsUploadDir, raw.slice(prefix.length)));
  return isInsidePath(digitalModelsUploadDir, filePath) ? filePath : join(digitalModelsUploadDir, "__invalid__");
}

function digitalModelError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function readAppState() {
  try {
    const data = JSON.parse(await readFile(appStatePath, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

async function writeAppState(state) {
  await mkdir(dataDir, { recursive: true });
  const previous = await readAppState();
  const next = mergeAppStateProjects(previous, {
    ...state,
    savedAt: state.savedAt || new Date().toISOString(),
  });
  await backupAppStateFile();
  await writeFile(appStatePath, JSON.stringify(next, null, 2));
}

function mergeAppStateProjects(previous, next) {
  const previousProjects = Array.isArray(previous?.projects) ? previous.projects : [];
  const nextProjects = Array.isArray(next?.projects) ? next.projects : [];
  const deletedProjectIds = [
    ...new Set([
      ...(Array.isArray(previous?.deletedProjectIds) ? previous.deletedProjectIds : []),
      ...(Array.isArray(next?.deletedProjectIds) ? next.deletedProjectIds : []),
    ]),
  ]
    .map((id) => String(id || "").trim())
    .filter(Boolean)
    .slice(-200);
  const deletedSet = new Set(deletedProjectIds);
  if (previousProjects.length && !nextProjects.length) {
    return {
      ...next,
      deletedProjectIds,
      projects: previousProjects.filter((project) => !deletedSet.has(project?.id)).slice(0, 10),
    };
  }
  if (!previousProjects.length) {
    return {
      ...next,
      deletedProjectIds,
      projects: nextProjects.filter((project) => !deletedSet.has(project?.id)).sort(compareProjectsByUpdatedAt).slice(0, 10),
    };
  }
  const merged = new Map();
  previousProjects.forEach((project) => {
    if (project?.id && !deletedSet.has(project.id)) merged.set(project.id, project);
  });
  nextProjects.forEach((project) => {
    if (!project?.id || deletedSet.has(project.id)) return;
    const existing = merged.get(project.id);
    const existingTime = Date.parse(existing?.updatedAt || existing?.createdAt || "") || 0;
    const nextTime = Date.parse(project.updatedAt || project.createdAt || "") || 0;
    if (!existing || nextTime >= existingTime) merged.set(project.id, project);
  });
  return {
    ...next,
    deletedProjectIds,
    projects: Array.from(merged.values()).sort(compareProjectsByUpdatedAt).slice(0, 10),
  };
}

function compareProjectsByUpdatedAt(a, b) {
  return (Date.parse(b?.updatedAt || b?.createdAt || "") || 0) - (Date.parse(a?.updatedAt || a?.createdAt || "") || 0);
}

async function backupAppStateFile() {
  if (!existsSync(appStatePath)) return;
  const backupPath = join(dataDir, "app-state.backup.json");
  try {
    await copyFile(appStatePath, backupPath);
  } catch {
    // Best effort only; the primary state file is still written below.
  }
}

async function upsertSubmission(record) {
  const submissions = await readSubmissions();
  const index = submissions.findIndex((item) => item.id === record.id);
  if (index >= 0) {
    submissions[index] = { ...submissions[index], ...record };
  } else {
    submissions.push(record);
  }
  await writeSubmissions(submissions);
}

async function updateSubmissionByIdentity(identity, patch) {
  if (!identity?.id) return;
  const submissions = await readSubmissions();
  const index = submissions.findIndex(
    (item) =>
      item.id === identity.id &&
      item.projectId === identity.projectId &&
      item.workflowId === identity.workflowId &&
      item.workflowType === identity.workflowType &&
      item.segmentId === identity.segmentId &&
      item.attemptId === identity.attemptId
  );
  if (index === -1) return;
  const next = { ...submissions[index], ...patch };
  next.dreaminaCost = getSubmissionDreaminaCost(next);
  submissions[index] = next;
  await writeSubmissions(submissions);
}

function requireApiKey() {
  if (!config.apiKey) {
    const error = new Error("图片与文本 API Key 未配置");
    error.status = 500;
    throw error;
  }
}

function loadSecureConfigSync() {
  try {
    const data = JSON.parse(readFileSync(secureConfigPath, "utf8"));
    const values = data?.values || {};
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, decryptSecureValue(value)])
    );
  } catch {
    return {};
  }
}

async function saveSecureConfig() {
  const values = Object.fromEntries(
    Object.entries(secureConfig)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, encryptSecureValue(String(value))])
  );
  await mkdir(dataDir, { recursive: true });
  await writeFile(secureConfigPath, JSON.stringify({ version: 1, values }, null, 2), "utf8");
}

function encryptSecureValue(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getAppEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: encrypted.toString("base64url"),
  };
}

function decryptSecureValue(value) {
  if (!value || typeof value !== "object") return "";
  const iv = Buffer.from(String(value.iv || ""), "base64url");
  const tag = Buffer.from(String(value.tag || ""), "base64url");
  const encrypted = Buffer.from(String(value.data || ""), "base64url");
  const decipher = createDecipheriv("aes-256-gcm", getAppEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function getAppEncryptionKey() {
  return createHash("sha256")
    .update(["skill", "studio", "dreamina", "secure", "config", "v1"].join("|"))
    .digest();
}

function loadDotEnv(filePath) {
  try {
    const text = readFileSync(filePath, "utf8");
    text.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const index = trimmed.indexOf("=");
      if (index === -1) return;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!process.env[key]) process.env[key] = value;
    });
  } catch {
    // .env is optional; production can provide environment variables.
  }
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "image";
}

function storageScopeSegment(value, fallback = "unassigned") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return cleaned || fallback;
}

function extensionForMime(mimeType) {
  const value = String(mimeType || "").toLowerCase();
  if (value === "image/jpeg" || value === "image/jpg") return ".jpg";
  if (value === "image/png") return ".png";
  if (value === "image/webp") return ".webp";
  if (value === "image/gif") return ".gif";
  if (value === "video/mp4") return ".mp4";
  if (value === "video/quicktime") return ".mov";
  if (value === "video/webm") return ".webm";
  if (value === "video/x-m4v") return ".m4v";
  if (value === "audio/mpeg" || value === "audio/mp3") return ".mp3";
  if (value === "audio/wav" || value === "audio/x-wav") return ".wav";
  if (value === "audio/mp4" || value === "audio/m4a" || value === "audio/x-m4a") return ".m4a";
  return "";
}

async function listUploadedImages() {
  return listMediaImages(uploadDir, "/uploads/");
}

async function listMediaImages(baseDir, publicPrefix) {
  let entries = [];
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const imageExts = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
  const items = [];
  for (const entry of entries) {
    const name = entry.name;
    if (entry.isDirectory()) {
      const nested = await listMediaImages(join(baseDir, name), `${publicPrefix}${name}/`);
      items.push(...nested);
      continue;
    }
    const ext = extname(name).toLowerCase();
    if (!imageExts.has(ext)) continue;
    const filePath = join(baseDir, name);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      items.push({
        name,
        url: `${publicPrefix}${name}`,
        size: info.size,
        updatedAt: info.mtime.toISOString(),
      });
    } catch {
      // Ignore files that disappear during listing.
    }
  }
  return items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 50);
}

function scrubProviderResponse(data) {
  if (!data || typeof data !== "object") return data;
  return {
    error: data.error || null,
    created: data.created || null,
  };
}
