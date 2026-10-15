// Main-process only. Device proof stays in the established license secure store;
// supplier credentials and settlement tokens are never present in the client.
import { uploadSubtitleDirect } from './oss-subtitle-upload.mjs';
const APP = "ai-media-library";
const ACTIONS = new Set(["quote", "run", "status", "capabilities", "subtitle-upload", ...['init','part','status','complete'].map(stage => 'subtitle-upload-'+stage)]);
const error = (code, message) => Object.assign(new Error(message), { code });

export function createPlatformTransport(licenseService) {
  const licenseUrl = new URL(licenseService.config.baseUrl);
  const root = licenseUrl.protocol === "http:" && licenseUrl.hostname === "127.0.0.1"
    ? `${licenseUrl.origin}/api/ai-media-library/v1/tasks`
    : "https://api.dadaozixun.com/api/ai-media-library/v1/tasks";
  const transport = async (action, input) => {
    if (licenseService.config.appName !== APP || !ACTIONS.has(action))
      throw error("APP_SCOPE_MISMATCH", "平台任务接口范围无效");
    if (!input || typeof input !== "object" || Array.isArray(input)
        || input.app_name !== undefined || input.budget_cny !== undefined || input.cost_cny !== undefined || input.max_points !== undefined)
      throw error("INVALID_PLATFORM_REQUEST", "任务费用由服务器报价，请勿提交自定义扣费金额");
    let credential = await licenseService.secureStore.readCredential();
    if (!credential?.codeId || !credential?.deviceCredential)
      throw error("PLATFORM_CREDENTIAL_REQUIRED", "请先完成设备授权验证");
    const account = credential.codeId;
    const rotate = async () => {
      if (!licenseService.pointsSessionRefreshPromise) {
        licenseService.pointsSessionRefreshPromise = licenseService.refreshDeviceSession(credential)
          .finally(() => { licenseService.pointsSessionRefreshPromise = null; });
      }
      const refreshed = await licenseService.pointsSessionRefreshPromise;
      if (!refreshed?.ok || !refreshed.credential?.deviceSession || !refreshed.credential?.deviceCredential)
        throw error("DEVICE_AUTH_FAILED", "设备会话恢复未完成，请重新验证授权");
      credential = refreshed.credential;
      if (credential.codeId !== account) throw error("DEVICE_CHANGED", "设备授权已变更，请重新发起任务");
    };
    if (!credential.deviceSession) await rotate();
    if (action === 'subtitle-upload') {
      if (Object.keys(input).some(k => !['filePath','requestId','onProgress'].includes(k))) throw error('INVALID_SUBTITLE_UPLOAD', '上传参数无效');
      return uploadSubtitleDirect({ ...input, fetchImpl: licenseService.fetchImpl, request: async (stage, body) => {
        if ((await licenseService.secureStore.readCredential())?.codeId !== account) throw error('DEVICE_CHANGED', '设备授权已变更');
        return transport('subtitle-upload-'+stage, body);
      } });
    }
    const upload = action.startsWith('subtitle-upload-');
    const send = async () => {
      try {
        const url = upload ? root.replace(/\/tasks$/, '/uploads/subtitle/') + action.slice('subtitle-upload-'.length)
          : action === "capabilities" ? root.replace(/\/tasks$/, "/capabilities") : `${root}/${action}`;
        const response = await licenseService.fetchImpl(url, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(upload ? 120000 : action === "quote" ? 120000 : 12000),
          headers: { accept: "application/json", "content-type": "application/json",
            ...licenseService.credentialHeaders(credential) },
          body: JSON.stringify({ ...input, app_name: APP }),
        });
        const body = await response.json().catch(() => ({}));
        return { response, body };
      } catch {
        throw Object.assign(new Error(upload || action === "quote" || action === "capabilities"
          ? "平台服务连接失败，本次未提交生成任务，也未扣积分。"
          : "平台任务连接未完成，请查看原任务状态。"), { kind: "network" });
      }
    };
    let result = await send();
    // A confirmed 401 means the gateway rejected authentication before executing.
    // Recover the existing session, then retry the identical logical task once.
    if (result.response.status === 401) { await rotate(); result = await send(); }
    if (!result.response.ok || result.body?.ok !== true || result.body.app_name !== APP) {
      if (result.response.status === 404 && (action === "quote" || action === "capabilities"))
        throw error("PLATFORM_API_UNAVAILABLE", "此功能的积分生成服务尚未开放，本次未提交任务，也未扣积分。");
      const code = String(result.body?.error_code || "PLATFORM_REQUEST_FAILED");
      const messages = {
        INSUFFICIENT_POINTS: "可用积分不足，请充值后重试。",
        QUOTE_EXPIRED: "积分报价已过期，请重新发起任务。",
        QUOTE_CONFIGURATION_CHANGED: "积分报价已更新，请重新确认后运行。",
        PLATFORM_API_UNAVAILABLE: "此功能的平台积分接口尚未开放。",
        CONSUMPTION_DISABLED: "平台积分消费暂不可用。",
        SUBTITLE_FILE_TOO_LARGE: "上传文件不能超过 1 GB。",
        SUBTITLE_UPLOAD_BUSY: "视频上传服务繁忙，请稍后重试；本次没有扣积分。",
        SUBTITLE_STORAGE_BUSY: "视频临时存储繁忙，请稍后重试；本次没有扣积分。",
        SUBTITLE_UPLOAD_EXPIRED: "视频临时上传已过期，请重新提交；不会重复生成已有任务。",
        SUBTITLE_UPLOAD_CHANGED: "原视频已变化，请重新添加；本次没有扣积分。",
        SUBTITLE_UPLOAD_UNVERIFIED: "上传文件校验失败，本次没有提交生成或扣积分。",
      };
      throw error(/^[A-Z0-9_]{1,80}$/.test(code) ? code : "PLATFORM_REQUEST_FAILED", messages[code] || "平台任务未完成，请查看任务状态。");
    }
    return result.body;
  };
  return transport;
}

export async function platformFeatureStatus(licenseService, feature, provider) {
  try {
    const body = await createPlatformTransport(licenseService)("capabilities", {});
    const ready = body.generation_enabled === true && body.consumption_enabled === true
      && body.providers?.[provider]?.configured === true
      && Array.isArray(body.enabled_features) && body.enabled_features.includes(feature);
    return { ready, reason: ready ? null : "此功能的积分生成服务尚未开放。" };
  } catch {
    return { ready: false, reason: "暂时无法确认积分服务状态，请稍后重试。" };
  }
}
