import { classifyUserAction, serializeUserAction } from "./user-action-errors.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";

const SECRET_KEY = /cookie|authorization|secret|token|password|api.?key|access.?key|activation.?code|base64|device.?credential|device.?session|machine.?code|machine.?id|hardware.?id|serial.?number|bios.?uuid|mac.?address|code.?id/i;
const USAGE_COUNT_KEY = /^(?:input|output|total|cached|prompt|completion|cache_creation_input|cached_input)_?tokens$/i;

// Keep causes and stacks, while removing credentials from keys, text and URLs.
export function redact(value, seen = new WeakSet()) {
  if (typeof value === "string") return value
    .replace(/\b[A-Z]{2,8}(?:-[A-Z0-9]{4}){2,6}\b/g, "[REDACTED_ACTIVATION]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]")
    .replace(/\bv[23]_[a-f0-9]{64}\b/gi, "[REDACTED_MACHINE]")
    .replace(/(["\'](?:device[_-]?credential|device[_-]?session|machine[_-]?(?:code|id))["\']\s*:\s*)["\'][^"\']*["\']/gi, '$1"[REDACTED]"')
    .replace(/((?:device[_-]?credential|device[_-]?session|machine[_-]?(?:code|id))\s*[=:]\s*)[^\s,;"']+/gi, "$1[REDACTED]")
    .replace(/((?:cookie|authorization)\s*[=:]\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/(["\'](?:api[_-]?key|secret|token|password|access[_-]?key(?:id|secret)?|activation[_-]?code)["\']\s*:\s*)["\'][^"\']*["\']/gi, '$1"[REDACTED]"')
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:cookie|authorization|api[_-]?key|access[_-]?key(?:id|secret)?|secret|token|password|activation[_-]?code|xsec_token)\s*[=:]\s*)[^\s,;"']+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, raw => { try { const u = new URL(raw); u.username = ""; u.password = ""; u.search = u.search ? "?[REDACTED]" : ""; u.hash = ""; return u.toString(); } catch { return "[URL]"; } });
  if (!value || typeof value !== "object") return typeof value === "bigint" ? String(value) : value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Error) return redact({ name: value.name, message: value.message, stack: value.stack, code: value.code, status: value.status, cause: value.cause, ...value }, seen);
  if (Array.isArray(value)) return value.map(item => redact(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    typeof item === "boolean" || (USAGE_COUNT_KEY.test(key) && typeof item === "number" && Number.isFinite(item)) ? item
      : SECRET_KEY.test(key) ? "[REDACTED]" : redact(item, seen)]));
}

// Inspect existence and timestamps only. Export never decrypts or reads secret
// files, and one inaccessible file must not prevent the rest of the report.
export function authorizationFileStatus(userDataPath) {
  const names = ["license-credential.v2.bin", "license-offline-grant.v1.bin",
    "license-offline-hmac-key.v1.bin", "license-canonical-recovery.v1.bin",
    "license-machine-identity.v3.bin", "license-machine-identity.v3-factors.bin",
    "license-machine-code.v2.bin", "license-identity-repair.v1.bin"];
  return names.map(name => {
    try {
      const info = fs.statSync(path.join(userDataPath, "license", name));
      return { name, exists: true, isFile: info.isFile(), bytes: info.size,
        modifiedAt: info.mtime.toISOString(), permissions: (info.mode & 0o777).toString(8) };
    } catch (error) {
      return { name, exists: error.code === "ENOENT" ? false : null, errorCode: error.code || "UNKNOWN" };
    }
  });
}

export class ApplicationLog {
  constructor({ userDataPath, metadata = {}, now = () => new Date() }) {
    this.root = path.join(userDataPath, "diagnostic-logs");
    this.configPath = path.join(this.root, "settings.json");
    this.metadata = metadata;
    this.now = now;
    this.sessionId = randomUUID();
    fs.mkdirSync(this.root, { recursive: true });
    try { this.settings = this.normalize(JSON.parse(fs.readFileSync(this.configPath, "utf8"))); } catch { this.settings = this.normalize({}); }
    this.prune();
  }
  normalize(value) {
    return { retentionDays: [7, 14, 30, 90].includes(Number(value.retentionDays)) ? Number(value.retentionDays) : 14, maxMegabytes: [50, 100, 200, 500].includes(Number(value.maxMegabytes)) ? Number(value.maxMegabytes) : 100 };
  }
  files() { return fs.readdirSync(this.root).filter(n => n.endsWith(".jsonl")).map(name => ({ name, ...fs.statSync(path.join(this.root, name)) })).sort((a, b) => a.mtimeMs - b.mtimeMs); }
  prune() {
    const cutoff = this.now().getTime() - this.settings.retentionDays * 86400000;
    let files = this.files();
    for (const f of files) if (f.mtimeMs < cutoff) fs.unlinkSync(path.join(this.root, f.name));
    files = this.files();
    let size = files.reduce((sum, f) => sum + f.size, 0);
    for (const f of files) { if (size <= this.settings.maxMegabytes * 1048576) break; fs.unlinkSync(path.join(this.root, f.name)); size -= f.size; }
  }
  write(level, event, details = {}) {
    try {
      const date = this.now();
      const stem = date.toISOString().slice(0, 10);
      let index = 0, file;
      do { file = path.join(this.root, `${stem}-${index++}.jsonl`); } while (fs.existsSync(file) && fs.statSync(file).size >= 2 * 1048576);
      fs.appendFileSync(file, JSON.stringify(redact({ timestamp: date.toISOString(), sessionId: this.sessionId, level, event, ...details })) + "\n", { mode: 0o600 });
      this.prune();
    } catch (error) { this.lastWriteError = String(error.message); }
  }
  snapshot() { const files = this.files(); return { path: this.root, bytes: files.reduce((sum, f) => sum + f.size, 0), fileCount: files.length, settings: this.settings, lastWriteError: this.lastWriteError || "" }; }
  save(patch) { this.settings = this.normalize({ ...this.settings, ...patch }); fs.writeFileSync(this.configPath, JSON.stringify(this.settings), { mode: 0o600 }); this.prune(); return this.snapshot(); }
  async export(destination, supplemental = {}) {
    this.write("info", "diagnostics.export");
    // Open snapshot descriptors before yielding. Retention may unlink files while
    // export runs; their open descriptors preserve the complete snapshot.
    const sources = [];
    try {
      for (const f of this.files()) sources.push({ name: f.name, size: f.size, fd: fs.openSync(path.join(this.root, f.name), "r") });
      const header = redact({ formatVersion: 2, exportedAt: this.now().toISOString(), metadata: this.metadata,
        retention: this.settings, logStatus: this.snapshot(), supplemental,
        inventory: sources.map(({ name, size }) => ({ name, bytes: size })),
        coverage: { fileCount: sources.length, sourceBytes: sources.reduce((total, item) => total + item.size, 0),
          scope: "All retained logs plus current diagnostic snapshots; deleted historical logs cannot be recovered." } });
      async function* chunks() {
        yield JSON.stringify(header).slice(0, -1) + ',"records":[';
        for (let i = 0; i < sources.length; i++) {
          const source = sources[i];
          yield (i ? "," : "") + '{"name":' + JSON.stringify(source.name) + ',"content":"';
          if (source.size > 0) {
            const input = fs.createReadStream("", { fd: source.fd, autoClose: false, start: 0, end: source.size - 1, encoding: "utf8" });
            // Reapply current redaction to historical logs from older builds.
            // Process complete lines so secrets cannot escape at chunk edges.
            const lines = createInterface({ input, crlfDelay: Infinity });
            for await (const line of lines) {
              let clean;
              try { clean = JSON.stringify(redact(JSON.parse(line))); }
              catch { clean = JSON.stringify({ event: "diagnostics.unparsed_record", message: redact(line) }); }
              yield JSON.stringify(clean + "\n").slice(1, -1);
            }
          }
          yield '"}';
        }
        yield "]}";
      }
      await pipeline(Readable.from(chunks()), createGzip(), fs.createWriteStream(destination, { mode: 0o600 }));
    } finally {
      for (const source of sources) fs.closeSync(source.fd);
    }
  }
}

export function diagnosticHandler(log, channel, handler) {
  return async (event, ...args) => {
    const operationId = randomUUID();
    const started = Date.now();
    const credentialChannel = /license|auth|login|cookie|api-settings-save/.test(channel);
    log.write("info", "operation.start", { channel, operationId, args: credentialChannel ? "[Credential parameters redacted]" : args });
    try {
      const result = await handler(event, ...args);
      const failed = result?.ok === false || result?.success === false || result?.error;
      const action = failed ? classifyUserAction(result, channel) : null;
      log.write(failed ? action ? "warn" : "error" : "info", "operation.finish", { channel, operationId, durationMs: Date.now() - started, result: /reveal|copy-activation|copy-machine/.test(channel) ? "[Credential result redacted]" : result });
      if (result?.ok === false || result?.success === false || result?.error) {
        const reason = result.error || result.message || result.reason || "服务返回失败，但未提供错误原因";
        const message = action ? redact(serializeUserAction(action)) : `${typeof reason === "string" ? redact(reason) : JSON.stringify(redact(reason))}\n操作：${channel}\n错误码：${result.code || result.status || "未提供"}\n诊断编号：${operationId}`;
        if (event?.sender && !event.sender.isDestroyed()) event.sender.send("application-operation-error", { message, operation: channel });
      }
      return result;
    } catch (error) {
      const action = classifyUserAction(error, channel);
      if (action) {
        log.write("warn", "operation.action-required", { channel, operationId, durationMs: Date.now() - started, code: action.code, message: action.message });
        const message = redact(serializeUserAction(action));
        if (event?.sender && !event.sender.isDestroyed()) event.sender.send("application-operation-error", { message, operation: channel });
        throw userFacingActionError(message, action.code);
      }
      log.write("error", "operation.error", { channel, operationId, durationMs: Date.now() - started, error });
      const reason = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(redact(error));
      throw new Error(`${redact(reason || "未提供错误原因")}\n操作：${channel}\n错误码：${error?.code || error?.name || "UNKNOWN"}\n诊断编号：${operationId}`, { cause: error });
    }
  };
}

function userFacingActionError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
