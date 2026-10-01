const SENSITIVE_KEY_PATTERN = /(?:activation.?code|device.?session|device.?credential|authorization|password|secret|token|api.?key|cookie|machine.?code|code.?id)/i;
const MACHINE_CODE_PATTERN = /\bv[23]_[a-f0-9]{64}\b/gi;
const LONG_HEX_PATTERN = /\b[a-f0-9]{64}\b/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const ACTIVATION_CODE_PATTERN = /\b[A-Z]{2,8}(?:-[A-Z0-9]{4}){2,6}\b/g;
const MAX_TEXT_LENGTH = 360;

function boundedText(value, maxLength = MAX_TEXT_LENGTH) {
  const text = String(value ?? "")
    .replace(BEARER_PATTERN, "Bearer [已脱敏]")
    .replace(MACHINE_CODE_PATTERN, "[已脱敏机器码]")
    .replace(LONG_HEX_PATTERN, "[已脱敏摘要]")
    .replace(ACTIVATION_CODE_PATTERN, "[已脱敏激活码]");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function sanitizedValue(key, value) {
  if (SENSITIVE_KEY_PATTERN.test(String(key || ""))) return "[已脱敏]";
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => boundedText(item, 120));
  if (typeof value === "object") return "[已省略对象]";
  return boundedText(value, 180);
}

export function sanitizeDiagnosticDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  const safe = {};
  for (const [key, value] of Object.entries(details).slice(0, 24)) {
    safe[boundedText(key, 60)] = sanitizedValue(key, value);
  }
  return safe;
}

export class LicenseDiagnosticLog {
  constructor({ maxEntries = 240, now = () => new Date(), onChange = () => {} } = {}) {
    this.maxEntries = Math.max(20, Math.min(500, Number(maxEntries) || 240));
    this.now = now;
    this.onChange = onChange;
    this.entries = [];
    this.sequence = 0;
  }

  add(level, stage, message, details = {}) {
    const safeLevel = ["info", "success", "warning", "error"].includes(level) ? level : "info";
    const entry = Object.freeze({
      id: ++this.sequence,
      timestamp: this.now().toISOString(),
      level: safeLevel,
      stage: boundedText(stage || "runtime", 80),
      message: boundedText(message || "运行状态更新"),
      details: Object.freeze(sanitizeDiagnosticDetails(details)),
    });
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    this.emit();
    return entry;
  }

  snapshot() {
    return {
      entries: this.entries.map((entry) => ({ ...entry, details: { ...entry.details } })),
      generatedAt: this.now().toISOString(),
      maxEntries: this.maxEntries,
    };
  }

  clear() {
    this.entries = [];
    this.add("info", "diagnostic", "当前会话诊断日志已清空");
    return this.snapshot();
  }

  toText() {
    const lines = ["【AI媒体库 · 授权运行诊断（已脱敏）】"];
    for (const entry of this.entries) {
      const details = Object.entries(entry.details)
        .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value ?? "-")}`)
        .join(" ");
      lines.push(`[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.stage}] ${entry.message}${details ? ` | ${details}` : ""}`);
    }
    lines.push("注：不包含完整激活码、机器码、设备会话、设备凭证或 API Key。");
    return lines.join("\n");
  }

  emit() {
    try {
      this.onChange(this.snapshot());
    } catch {
      // Diagnostics must never affect authorization or application startup.
    }
  }
}
