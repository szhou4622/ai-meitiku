import { buildIdentityPayload } from "./machine-identity/index.mjs";
import { LICENSE_CONFIG } from "./license-config.mjs";
import { secureStorageErrorMessage } from "./license-secure-store.mjs";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function deviceDiagnosticErrorMessage(error) {
  const storageMessage = secureStorageErrorMessage(error);
  if (storageMessage) return storageMessage;
  const message = String(error?.message || "").trim();
  if (
    error?.code === "SECURE_STORAGE_DECRYPT_FAILED"
    || /decrypt(?:ing)?|ciphertext|safestorage/i.test(message)
  ) {
    return "本机加密授权凭证无法读取，原数据已保留。请确认正在使用安装软件时的同一 Windows 账户；如仍失败，请联系管理员核对。";
  }
  return message || "设备核验失败，请稍后重试。";
}

export function normalizeDeviceDiagnosticCode(value) {
  const compact = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "");
  if (compact.length !== 8 || [...compact].some((char) => !CODE_ALPHABET.includes(char))) {
    throw new Error("请输入管理员提供的 8 位一次性核验码");
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function prepareDeviceDiagnosticRequest({ appName, verificationCode, machineCode, identityResult }) {
  const code = normalizeDeviceDiagnosticCode(verificationCode);
  const normalizedMachineCode = String(machineCode || "").trim().toLowerCase();
  const identity = buildIdentityPayload(identityResult);
  if (!/^v2_[a-f0-9]{64}$/.test(normalizedMachineCode)) throw new Error("本机机器码不可用");
  if (!identity || identity.low_confidence) throw new Error("本机身份因子不足，请联系管理员人工核对");
  return Object.freeze({
    app_name: String(appName || ""),
    verification_code: code,
    machine_code: normalizedMachineCode,
    machine_identity_v3: identity,
  });
}

export function buildDeviceDiagnosticRequest({ appName, verificationCode, machineCode, recoverySecret, identityResult }) {
  const prepared = prepareDeviceDiagnosticRequest({ appName, verificationCode, machineCode, identityResult });
  const normalizedRecoverySecret = String(recoverySecret || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedRecoverySecret)) throw new Error("本机安装核验密钥不可用");
  return Object.freeze({
    ...prepared,
    activation_recovery_secret: normalizedRecoverySecret,
  });
}

export async function submitDeviceDiagnostic({ baseUrl, request, fetchImpl = globalThis.fetch }) {
  const expectedBase = new URL(LICENSE_CONFIG.baseUrl);
  let suppliedBase;
  try { suppliedBase = new URL(String(baseUrl || "")); } catch { suppliedBase = null; }
  if (
    !suppliedBase
    || suppliedBase.protocol !== "https:"
    || suppliedBase.username
    || suppliedBase.password
    || suppliedBase.href.replace(/\/+$/, "") !== expectedBase.href.replace(/\/+$/, "")
  ) throw new Error("设备核验服务地址不正确");
  let response;
  try {
    response = await fetchImpl(`${suppliedBase.href.replace(/\/$/, "")}/device-diagnostic/submit`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("设备核验服务暂时无法连接，请稍后重试");
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok || body?.ok !== true) {
    throw new Error(String(body?.message || body?.error || "设备核验服务暂时无法连接，请稍后重试"));
  }
  return {
    ok: true,
    reportId: String(body.report_id || ""),
    status: String(body.status || "pending_review"),
    message: String(body.message || "设备核验信息已提交，请等待管理员确认。"),
  };
}
