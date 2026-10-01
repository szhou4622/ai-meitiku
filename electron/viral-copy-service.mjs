import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const VIRAL_COPY_CATEGORIES = ["未分类", "开头钩子", "痛点共鸣", "产品卖点", "效果描述", "信任背书", "价格利益", "促单引导"];

function safeText(value, limit = 2000) {
  return String(value ?? "").trim().slice(0, limit);
}

function validTime(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 24 * 60 * 60 ? Math.round(number * 100) / 100 : null;
}

export function viralCopyKey(binding) {
  const accountId = safeText(binding?.advertiserId, 100);
  const materialId = safeText(binding?.materialId, 100);
  if (!accountId || !materialId) throw new Error("素材尚未绑定千川账户与素材 ID");
  return `${accountId}:${materialId}`;
}

export function viralCopyReferenceKey(reference) {
  const accountId = safeText(reference?.advertiserId, 100);
  const materialId = safeText(reference?.materialId, 100);
  if (accountId && materialId) return `${accountId}:${materialId}`;
  const assetId = Number(reference?.assetId);
  if (Number.isSafeInteger(assetId)) return `asset:${assetId}`;
  const referenceId = safeText(reference?.referenceId, 120);
  if (referenceId) return `standalone:${referenceId}`;
  throw new Error("文案缺少可用的素材或独立记录标识");
}

export function normalizeCopySegment(input, index = 0) {
  const text = safeText(input?.text);
  if (!text) return null;
  const start = validTime(input?.start);
  const end = validTime(input?.end);
  if (start !== null && end !== null && end <= start) throw new Error("文案结束时间必须晚于开始时间");
  const rawClassifications = Array.isArray(input?.classifications) ? input.classifications : [];
  if (rawClassifications.length > 24) throw new Error("每段文案最多保留 24 个分类字段");
  const classifications = [...new Map(rawClassifications.flatMap((item) => {
    const field = safeText(item?.field, 100);
    const value = safeText(item?.value, 200);
    return field && value ? [[`${field}\u0000${value}`, { field, value }]] : [];
  })).values()];
  const rawDataFields = Array.isArray(input?.data_fields) ? input.data_fields : [];
  if (rawDataFields.length > 128) throw new Error("每段文案最多保留 128 个数据字段");
  const dataFields = rawDataFields.flatMap((item) => {
    const name = safeText(item?.name, 100);
    const value = safeText(item?.value, 2000);
    return name && value ? [{ name, value }] : [];
  });
  const category = classifications[0]?.value || safeText(input?.category, 200) || "未分类";
  return {
    id: safeText(input?.id, 80) || `S${index + 1}`,
    text,
    start,
    end,
    category,
    classifications,
    data_fields: dataFields,
    confirmed: input?.confirmed === true,
    visual_asset_id: Number.isSafeInteger(Number(input?.visual_asset_id)) && Number(input.visual_asset_id) > 0
      ? Number(input.visual_asset_id)
      : null,
  };
}

function parseClock(value) {
  const parts = String(value || "").replace(",", ".").split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

export function parseManualTranscript(value) {
  const input = String(value || "").replace(/\r/g, "").trim();
  if (input.length > 200000) throw new Error("文案文本过长，请分批导入");
  const blocks = input.split(/\n\s*\n/).filter(Boolean);
  const timed = blocks.map((block, index) => {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) return null;
    const [from, to] = lines[timeIndex].split("-->").map((part) => parseClock(part.trim().split(/\s+/)[0]));
    if (from === null || to === null || to <= from) return null;
    return normalizeCopySegment({ id: `S${index + 1}`, start: from, end: to, text: lines.slice(timeIndex + 1).join(" ") }, index);
  }).filter(Boolean);
  if (timed.length) {
    if (timed.length > 1000) throw new Error("文案片段过多，请分批导入");
    return timed;
  }
  if (input.includes("-->")) throw new Error("字幕时间码无效，请检查 SRT/VTT 格式");
  const lines = input.split("\n").map((line, index) => normalizeCopySegment({ text: line }, index)).filter(Boolean);
  if (lines.length > 1000) throw new Error("文案片段过多，请分批导入");
  return lines;
}

export function parseWhisperTranscript(payload) {
  const source = Array.isArray(payload?.segments) ? payload.segments : Array.isArray(payload?.transcription) ? payload.transcription : [];
  return source.map((segment, index) => normalizeCopySegment({
    id: `S${index + 1}`,
    text: segment.text,
    start: Number.isFinite(Number(segment.start)) ? Number(segment.start) : Number.isFinite(Number(segment.offsets?.from)) ? Number(segment.offsets.from) / 1000 : parseClock(segment.timestamps?.from),
    end: Number.isFinite(Number(segment.end)) ? Number(segment.end) : Number.isFinite(Number(segment.offsets?.to)) ? Number(segment.offsets.to) / 1000 : parseClock(segment.timestamps?.to),
  }, index)).filter(Boolean);
}

async function runCommand(command, args, timeoutMs) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let output = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-4096); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(code === null ? "处理超时或已中断" : `处理程序返回 ${code}`));
    });
  });
}

async function firstAvailable(candidates, mode) {
  for (const candidate of candidates.filter(Boolean)) {
    try { await access(candidate, mode); return candidate; } catch { /* Try the next bundled path. */ }
  }
  return "";
}

export function createViralCopyService({ userDataPath, resourcesPath = "", appRoot = "", platform = process.platform, arch = process.arch }) {
  const dataPath = path.join(userDataPath, "viral-copy-library.json");
  const backupPath = path.join(userDataPath, "viral-copy-library.backup.json");
  let busy = false;
  let writeQueue = Promise.resolve();

  async function load() {
    let existing = false;
    for (const candidate of [dataPath, backupPath]) {
      try {
        const data = JSON.parse(await readFile(candidate, "utf8"));
        if (data?.version === 1 && Array.isArray(data.records)) return data.records;
      } catch { /* The backup remains available if the primary index is damaged. */ }
      try { await stat(candidate); existing = true; } catch { /* No index on first use. */ }
    }
    if (existing) throw new Error("文案索引无法读取；原文件和备份均已保留，请先修复索引再保存");
    return [];
  }

  async function writeRecords(records) {
    await mkdir(userDataPath, { recursive: true });
    try {
      const previous = JSON.parse(await readFile(dataPath, "utf8"));
      if (previous?.version === 1 && Array.isArray(previous.records)) await copyFile(dataPath, backupPath);
    } catch { /* Never replace a valid backup with a damaged primary index. */ }
    const temporaryPath = `${dataPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify({ version: 1, records }, null, 2), "utf8");
    await rename(temporaryPath, dataPath);
  }

  function nextUpdatedAt(record) {
    const previous = Date.parse(String(record?.updated_at || ""));
    return new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
  }

  async function saveNow(reference, segments) {
    const key = viralCopyReferenceKey(reference);
    if (!Array.isArray(segments) || segments.length > 1000) throw new Error("文案数量无效");
    const normalized = segments.map(normalizeCopySegment).filter(Boolean);
    if (!normalized.length) throw new Error("请先输入或提取文案");
    const records = await load();
    const old = records.find((record) => record.key === key);
    const record = {
      key,
      advertiser_id: safeText(reference.advertiserId, 100),
      material_id: safeText(reference.materialId, 100),
      asset_id: Number.isSafeInteger(Number(reference.assetId)) ? Number(reference.assetId) : null,
      association_id: safeText(reference.associationId, 120),
      title: safeText(reference.title, 300) || "独立文案",
      major_category: reference.majorCategory === undefined ? safeText(old?.major_category, 100) : safeText(reference.majorCategory, 100),
      segments: normalized,
      source: safeText(reference.source, 30) || (Number.isSafeInteger(Number(reference.assetId)) ? "local" : "manual"),
      updated_at: nextUpdatedAt(old),
      created_at: old?.created_at || new Date().toISOString(),
    };
    const next = [...records.filter((item) => item.key !== key), record];
    await writeRecords(next);
    return record;
  }

  function assertCurrentSegment(records, target) {
    const key = safeText(target?.key, 300);
    const record = records.find((item) => item.key === key);
    const index = Number(target?.index);
    if (!record || !Number.isSafeInteger(index) || index < 0 || index >= record.segments.length) {
      throw new Error("文案已变化，请刷新后重试");
    }
    if (String(record.updated_at || "") !== String(target?.updatedAt || "")
      || String(record.segments[index]?.id || "") !== String(target?.segmentId || "")) {
      throw new Error("文案已变化，请刷新后重试");
    }
    return { record, index };
  }

  async function deleteSegmentsNow(targets) {
    if (!Array.isArray(targets) || !targets.length || targets.length > 200) throw new Error("请选择 1–200 条文案删除");
    const records = await load();
    const indicesByKey = new Map();
    for (const target of targets) {
      const { record, index } = assertCurrentSegment(records, target);
      if (!indicesByKey.has(record.key)) indicesByKey.set(record.key, new Set());
      indicesByKey.get(record.key).add(index);
    }
    const next = records.flatMap((record) => {
      const indices = indicesByKey.get(record.key);
      if (!indices) return [record];
      const segments = record.segments.filter((_, index) => !indices.has(index));
      return segments.length ? [{ ...record, segments, updated_at: nextUpdatedAt(record) }] : [];
    });
    await writeRecords(next);
    return { deletedCount: [...indicesByKey.values()].reduce((sum, indices) => sum + indices.size, 0), records: next };
  }

  function deleteSegments(targets) {
    const operation = writeQueue.then(() => deleteSegmentsNow(targets));
    writeQueue = operation.catch(() => {});
    return operation;
  }

  async function setConfirmedSegmentsNow(targets, confirmed) {
    if (!Array.isArray(targets) || !targets.length || targets.length > 200) throw new Error("请选择 1–200 条文案操作");
    if (typeof confirmed !== "boolean") throw new Error("文案确认状态无效");
    const records = await load();
    const indicesByKey = new Map();
    for (const target of targets) {
      const { record, index } = assertCurrentSegment(records, target);
      if (!indicesByKey.has(record.key)) indicesByKey.set(record.key, new Set());
      indicesByKey.get(record.key).add(index);
    }
    const next = records.map((record) => {
      const indices = indicesByKey.get(record.key);
      if (!indices) return record;
      return {
        ...record,
        segments: record.segments.map((segment, index) => indices.has(index) ? { ...segment, confirmed } : segment),
        updated_at: nextUpdatedAt(record),
      };
    });
    await writeRecords(next);
    return { updatedCount: [...indicesByKey.values()].reduce((sum, indices) => sum + indices.size, 0), records: next };
  }

  function setConfirmedSegments(targets, confirmed) {
    const operation = writeQueue.then(() => setConfirmedSegmentsNow(targets, confirmed));
    writeQueue = operation.catch(() => {});
    return operation;
  }

  async function updateSegmentTextNow(target, text) {
    const normalizedText = safeText(text);
    if (!normalizedText) throw new Error("文案内容不能为空；如需移除请使用删除按钮");
    const records = await load();
    const { record, index } = assertCurrentSegment(records, target);
    const updated = {
      ...record,
      segments: record.segments.map((segment, position) => position === index ? { ...segment, text: normalizedText } : segment),
      updated_at: nextUpdatedAt(record),
    };
    const next = records.map((item) => item.key === record.key ? updated : item);
    await writeRecords(next);
    return updated;
  }

  function updateSegmentText(target, text) {
    const operation = writeQueue.then(() => updateSegmentTextNow(target, text));
    writeQueue = operation.catch(() => {});
    return operation;
  }

  async function linkVisualNow(target, assetId) {
    if (assetId !== null && (!Number.isSafeInteger(assetId) || assetId <= 0)) throw new Error("画面素材 ID 无效");
    const records = await load();
    const { record, index } = assertCurrentSegment(records, target);
    const updated = {
      ...record,
      segments: record.segments.map((segment, position) => position === index ? { ...segment, visual_asset_id: assetId } : segment),
      updated_at: nextUpdatedAt(record),
    };
    const next = records.map((item) => item.key === record.key ? updated : item);
    await writeRecords(next);
    return updated;
  }

  function linkVisual(target, assetId) {
    const operation = writeQueue.then(() => linkVisualNow(target, assetId));
    writeQueue = operation.catch(() => {});
    return operation;
  }

  function saveReference(reference, segments) {
    const operation = writeQueue.then(() => saveNow(reference, segments));
    writeQueue = operation.catch(() => {});
    return operation;
  }

  function save(binding, segments) {
    viralCopyKey(binding);
    return saveReference(binding, segments);
  }

  async function resolveTranscriber() {
    const executable = platform === "win32" ? ".exe" : "";
    const archDir = `${platform}-${arch}`;
    const ffmpeg = await firstAvailable([
      path.join(resourcesPath, "bin", archDir, `ffmpeg${executable}`),
      path.join(appRoot, "bundled-tools", archDir, `ffmpeg${executable}`),
      "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg",
    ], constants.X_OK);
    const whisper = await firstAvailable([
      process.env.WHISPER_BIN,
      path.join(resourcesPath, "bin", archDir, `whisper-cli${executable}`),
      path.join(appRoot, "bundled-tools", archDir, `whisper-cli${executable}`),
      "/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli",
    ], constants.X_OK);
    const model = await firstAvailable([
      process.env.WHISPER_MODEL,
      path.join(resourcesPath, "models", "whisper", "ggml-small.bin"),
      path.join(appRoot, "models", "whisper", "ggml-small.bin"),
    ], constants.R_OK);
    return { ffmpeg, whisper, model };
  }

  async function capabilities() {
    const { ffmpeg, whisper, model } = await resolveTranscriber();
    return {
      transcribeAvailable: Boolean(ffmpeg && whisper && model),
      message: ffmpeg && whisper && model ? "本地转写组件已就绪" : "未检测到完整的本地转写组件或模型；可使用字幕导入与人工补录。",
    };
  }

  async function transcribe(localPath) {
    if (busy) throw new Error("已有文案转写任务正在进行");
    let source;
    try { source = await stat(localPath); }
    catch { throw new Error("原视频暂不可访问，请检查本地文件或共享网盘连接"); }
    if (!source.isFile()) throw new Error("原视频不可用");
    const { ffmpeg, whisper, model } = await resolveTranscriber();
    if (!ffmpeg || !whisper || !model) throw new Error("本机缺少本地转写组件或模型；可先补录文案，自动转写需配置 Whisper。");
    busy = true;
    const workDir = await mkdtemp(path.join(os.tmpdir(), "ai-media-viral-copy-"));
    try {
      const audio = path.join(workDir, "audio.wav");
      const output = path.join(workDir, "transcript");
      try {
        await runCommand(ffmpeg, ["-nostdin", "-y", "-i", localPath, "-vn", "-ac", "1", "-ar", "16000", audio], 10 * 60 * 1000);
      } catch { throw new Error("原视频音轨读取失败或处理超时，请确认文件仍可访问"); }
      try {
        await runCommand(whisper, ["-m", model, "-f", audio, "-l", "zh", "-oj", "-of", output], 20 * 60 * 1000);
      } catch { throw new Error("本地转写失败或超时，原视频和已有文案均未修改"); }
      const segments = parseWhisperTranscript(JSON.parse(await readFile(`${output}.json`, "utf8")));
      if (!segments.length) throw new Error("转写完成，但没有识别到可用口播；请手动补录或检查原视频音轨。");
      return { segments, source: "local-asr" };
    } finally {
      busy = false;
      await rm(workDir, { recursive: true, force: true });
    }
  }

  return { load, save, saveReference, deleteSegments, setConfirmedSegments, updateSegmentText, linkVisual, capabilities, transcribe };
}
