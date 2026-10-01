import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { OfficeParser } from "officeparser";

export const PRODUCT_INFO_MAX_FILES = 12;
export const PRODUCT_INFO_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const PRODUCT_INFO_MAX_TOTAL_BYTES = 96 * 1024 * 1024;
export const PRODUCT_INFO_MAX_TEXT_PER_FILE = 200_000;
export const PRODUCT_INFO_MAX_TEXT = 600_000;
export const PRODUCT_INFO_MAX_SCANNED_TEXT = 600_000;

export const PRODUCT_INFO_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
export const PRODUCT_INFO_OFFICE_EXTENSIONS = new Set([
  ".pptx", ".ppsx", ".docx", ".xlsx", ".pdf", ".rtf",
  ".odt", ".odp", ".ods", ".epub",
]);
export const PRODUCT_INFO_TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".html", ".htm",
  ".json", ".xml", ".yaml", ".yml", ".log",
]);
export const PRODUCT_INFO_LEGACY_OFFICE_EXTENSIONS = new Set([".ppt", ".pps", ".doc", ".xls"]);
export const PRODUCT_INFO_SUPPORTED_EXTENSIONS = new Set([
  ...PRODUCT_INFO_IMAGE_EXTENSIONS,
  ...PRODUCT_INFO_OFFICE_EXTENSIONS,
  ...PRODUCT_INFO_TEXT_EXTENSIONS,
  ...PRODUCT_INFO_LEGACY_OFFICE_EXTENSIONS,
]);

const imageMimeTypes = new Map([
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"],
  [".webp", "image/webp"], [".gif", "image/gif"],
]);

function decodeHtmlEntities(source) {
  const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return source.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match;
    const hexadecimal = entity[1]?.toLowerCase() === "x";
    const value = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return Number.isFinite(value) ? String.fromCodePoint(value) : match;
  });
}

export function htmlToProductInfoText(source) {
  return decodeHtmlEntities(String(source || "")
    .replace(/<(script|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(p|div|section|article|header|footer|h[1-6]|li|tr|table|br)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "));
}

export function normalizeProductInfoText(source, limit = PRODUCT_INFO_MAX_TEXT_PER_FILE) {
  const normalized = String(source || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t\f\v ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}\n（该文件内容较长，已截取前 ${limit} 字）`;
}

function decodeTextBuffer(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8");
}

export function extractLegacyOfficeText(buffer) {
  const candidates = [];
  const ascii = buffer.toString("latin1").match(/[\x20-\x7e]{4,}/g) ?? [];
  const utf16 = buffer.toString("utf16le").match(/[\p{L}\p{N}\p{Script=Han}，。！？；：“”‘’（）《》、·%+\-_/\s]{4,}/gu) ?? [];
  for (const value of [...utf16, ...ascii]) {
    const normalized = normalizeProductInfoText(value, 1_000);
    if (normalized.length >= 4 && !/^[\W_]+$/u.test(normalized)) candidates.push(normalized);
  }
  return [...new Set(candidates)].join("\n");
}

async function extractOfficeText(filePath, parseOffice = OfficeParser.parseOffice) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const ast = await parseOffice(filePath, {
      abortSignal: controller.signal,
      ignoreComments: true,
      ignoreHeadersAndFooters: false,
      ignoreNotes: false,
      extractAttachments: false,
    });
    const generated = await ast.to("text", { newlineDelimiter: "\n" });
    return String(generated?.value ?? "");
  } finally {
    clearTimeout(timeout);
  }
}

async function extractPdfTextAndScanPages(filePath, parseOffice = OfficeParser.parseOffice) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const ast = await parseOffice(filePath, {
      abortSignal: controller.signal,
      ignoreComments: true,
      ignoreHeadersAndFooters: false,
      ignoreNotes: false,
      extractAttachments: true,
      ocr: false,
    });
    const generated = await ast.to("text", { newlineDelimiter: "\n" });
    const imagePages = new Set((Array.isArray(ast?.attachments) ? ast.attachments : [])
      .map(scannedPdfAttachmentPage).filter(Boolean).map((position) => position.page));
    const pageNodes = (Array.isArray(ast?.content) ? ast.content : []).filter((node) => node?.type === "page");
    const scanPages = pageNodes
      .map((node, index) => ({ page: Number(node?.metadata?.pageNumber) || index + 1, text: String(node?.text || "") }))
      .filter(({ page, text }) => imagePages.has(page) && ((text.match(/[\p{L}\p{N}]/gu) || []).length < 4))
      .map(({ page }) => page);
    if (!pageNodes.length && imagePages.size) scanPages.push(...imagePages);
    return { text: String(generated?.value ?? ""), scanPages: [...new Set(scanPages)].sort((a, b) => a - b), totalPages: pageNodes.length || Math.max(0, ...imagePages) };
  } finally {
    clearTimeout(timeout);
  }
}

function productInfoTextMissingError(metadata = {}) {
  const error = new Error("文件中未提取到可用文字");
  error.code = "PRODUCT_INFO_TEXT_MISSING";
  Object.assign(error, metadata);
  return error;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

export function pdfBmpToPng(bmp) {
  const source = Buffer.isBuffer(bmp) ? bmp : Buffer.from(bmp || []);
  if (source.length < 54 || source.toString("ascii", 0, 2) !== "BM") throw new Error("扫描页图片格式无效");
  const pixelOffset = source.readUInt32LE(10);
  const width = source.readInt32LE(18);
  const signedHeight = source.readInt32LE(22);
  const height = Math.abs(signedHeight);
  const bitDepth = source.readUInt16LE(28);
  const compression = source.readUInt32LE(30);
  if (width <= 0 || height <= 0 || width * height > 50_000_000 || bitDepth !== 24 || compression !== 0) {
    throw new Error("扫描页图片参数不受支持");
  }
  const bmpStride = Math.floor((width * 3 + 3) / 4) * 4;
  if (pixelOffset + bmpStride * height > source.length) throw new Error("扫描页图片数据不完整");
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = signedHeight < 0 ? y : height - y - 1;
    const sourceRow = pixelOffset + sourceY * bmpStride;
    const targetRow = y * (width * 3 + 1);
    raw[targetRow] = 0;
    for (let x = 0; x < width; x += 1) {
      const sourcePixel = sourceRow + x * 3;
      const targetPixel = targetRow + 1 + x * 3;
      raw[targetPixel] = source[sourcePixel + 2];
      raw[targetPixel + 1] = source[sourcePixel + 1];
      raw[targetPixel + 2] = source[sourcePixel];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function extractProductInfoFile(filePath, { analyzeImage, parseOffice } = {}) {
  const resolvedPath = path.resolve(String(filePath || ""));
  const extension = path.extname(resolvedPath).toLowerCase();
  if (!PRODUCT_INFO_SUPPORTED_EXTENSIONS.has(extension)) throw new Error(`不支持 ${extension || "无扩展名"} 格式`);
  const info = await stat(resolvedPath);
  if (!info.isFile()) throw new Error("不是可读取的文件");
  if (info.size > PRODUCT_INFO_MAX_FILE_BYTES) throw new Error("文件超过 32MB 限制");
  const sourceId = createHash("sha256").update(await readFile(resolvedPath)).digest("hex");

  let text = "";
  let scanPages = [];
  let totalPages = 0;
  if (PRODUCT_INFO_IMAGE_EXTENSIONS.has(extension)) {
    if (typeof analyzeImage !== "function") throw new Error("当前没有可用的图片识别能力");
    text = await analyzeImage(resolvedPath, imageMimeTypes.get(extension));
  } else if (PRODUCT_INFO_TEXT_EXTENSIONS.has(extension)) {
    const buffer = await readFile(resolvedPath);
    const decoded = decodeTextBuffer(buffer);
    text = extension === ".html" || extension === ".htm" ? htmlToProductInfoText(decoded) : decoded;
  } else if (PRODUCT_INFO_LEGACY_OFFICE_EXTENSIONS.has(extension)) {
    text = extractLegacyOfficeText(await readFile(resolvedPath));
  } else if (extension === ".pdf") {
    const pdf = await extractPdfTextAndScanPages(resolvedPath, parseOffice);
    text = pdf.text;
    scanPages = pdf.scanPages;
    totalPages = pdf.totalPages;
  } else {
    text = await extractOfficeText(resolvedPath, parseOffice);
  }

  const normalized = normalizeProductInfoText(text);
  if (!normalized) {
    if (PRODUCT_INFO_IMAGE_EXTENSIONS.has(extension)) throw new Error("图片中未识别到产品信息");
    throw productInfoTextMissingError({ sourceId, scanPages, totalPages });
  }
  return { name: path.basename(resolvedPath), path: resolvedPath, extension, size: info.size, sourceId, text: normalized, scanPages, totalPages };
}

export async function extractProductInfoFiles(filePaths, options = {}) {
  const uniquePaths = [...new Set((Array.isArray(filePaths) ? filePaths : []).filter((item) => typeof item === "string" && item))];
  if (!uniquePaths.length) return { text: "", files: [], warnings: [] };
  if (uniquePaths.length > PRODUCT_INFO_MAX_FILES) throw new Error(`一次最多选择 ${PRODUCT_INFO_MAX_FILES} 个产品资料文件`);

  let totalBytes = 0;
  for (const filePath of uniquePaths) totalBytes += (await stat(filePath)).size;
  if (totalBytes > PRODUCT_INFO_MAX_TOTAL_BYTES) throw new Error("所选文件合计超过 96MB 限制");

  const files = [];
  const warnings = [];
  const scanCandidates = [];
  for (const filePath of uniquePaths) {
    try {
      const extracted = await extractProductInfoFile(filePath, options);
      files.push(extracted);
      if (extracted.extension === ".pdf" && extracted.scanPages.length) {
        scanCandidates.push({
          name: extracted.name,
          path: extracted.path,
          extension: extracted.extension,
          size: extracted.size,
          sourceId: extracted.sourceId,
          pages: extracted.scanPages,
          totalPages: extracted.totalPages,
          reason: `还有 ${extracted.scanPages.length} 页未提取到正常文字，可使用 AI 识别`,
        });
      }
    } catch (error) {
      const resolvedPath = path.resolve(filePath);
      if (path.extname(resolvedPath).toLowerCase() === ".pdf" && error?.code === "PRODUCT_INFO_TEXT_MISSING") {
        const info = await stat(resolvedPath);
        scanCandidates.push({
          name: path.basename(resolvedPath),
          path: resolvedPath,
          extension: ".pdf",
          size: info.size,
          sourceId: error?.sourceId || createHash("sha256").update(await readFile(resolvedPath)).digest("hex"),
          pages: Array.isArray(error?.scanPages) ? error.scanPages : [],
          totalPages: Number(error?.totalPages) || 0,
          reason: "未提取到正常文字，可使用 AI 识别扫描件",
        });
      } else {
        warnings.push(`${path.basename(filePath)}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (!files.length && !scanCandidates.length) throw new Error(warnings[0] || "没有从所选文件中提取到产品信息");

  const sections = files.map((file) => `【产品资料：${file.name}】\n${file.text}`);
  const combined = normalizeProductInfoText(sections.join("\n\n"), PRODUCT_INFO_MAX_TEXT);
  return {
    text: combined,
    files: files.map(({ name, extension, size, sourceId }) => ({ name, extension, size, sourceId })),
    documents: files.map(({ name, text, sourceId }) => ({ name, text, sourceId })),
    warnings,
    scanCandidates,
  };
}

function scannedPdfAttachmentPage(attachment) {
  const match = String(attachment?.name || "").match(/^pdf_image_p(\d+)_(\d+)\.bmp$/i);
  return match ? { page: Number(match[1]), order: Number(match[2]) } : null;
}

export async function extractScannedProductInfoFiles(filePaths, { analyzeImage, parseOffice = OfficeParser.parseOffice } = {}) {
  if (typeof analyzeImage !== "function") throw new Error("当前没有可用的扫描件 AI 识别能力");
  const normalizedInputs = (Array.isArray(filePaths) ? filePaths : []).map((item) => typeof item === "string" ? { path: item, pages: [] } : item).filter((item) => item && typeof item.path === "string" && item.path);
  const uniqueInputs = [...new Map(normalizedInputs.map((item) => [path.resolve(item.path), { ...item, path: path.resolve(item.path) }])).values()];
  if (!uniqueInputs.length) return { text: "", files: [], warnings: [] };
  const files = [];
  const warnings = [];
  for (const input of uniqueInputs) {
    const resolvedPath = input.path;
    try {
      if (path.extname(resolvedPath).toLowerCase() !== ".pdf") throw new Error("AI 识别扫描件目前仅支持 PDF");
      const info = await stat(resolvedPath);
      if (!info.isFile()) throw new Error("不是可读取的文件");
      if (info.size > PRODUCT_INFO_MAX_FILE_BYTES) throw new Error("文件超过 32MB 限制");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);
      let ast;
      try {
        ast = await parseOffice(resolvedPath, {
          abortSignal: controller.signal,
          ignoreComments: true,
          ignoreHeadersAndFooters: false,
          ignoreNotes: false,
          extractAttachments: true,
          ocr: false,
        });
      } finally {
        clearTimeout(timeout);
      }
      const pageImages = (Array.isArray(ast?.attachments) ? ast.attachments : [])
        .map((attachment) => ({ attachment, position: scannedPdfAttachmentPage(attachment) }))
        .filter((item) => item.position && item.attachment?.mimeType === "image/bmp" && typeof item.attachment?.data === "string")
        .filter((item) => !Array.isArray(input.pages) || !input.pages.length || input.pages.includes(item.position.page))
        .sort((left, right) => left.position.page - right.position.page || left.position.order - right.position.order);
      if (!pageImages.length) throw new Error("没有从 PDF 中找到可识别的扫描页图片");
      const recognized = [];
      const pageWarnings = [];
      for (const { attachment, position } of pageImages) {
        try {
          const png = pdfBmpToPng(Buffer.from(attachment.data, "base64"));
          const pageText = normalizeProductInfoText(await analyzeImage(png, "image/png", {
            source: "scanned-pdf",
            fileName: path.basename(resolvedPath),
            page: position.page,
            imageOrder: position.order,
          }), PRODUCT_INFO_MAX_TEXT_PER_FILE);
          if (pageText) recognized.push(`【第 ${position.page} 页】\n${pageText}`);
        } catch (error) {
          pageWarnings.push(`第 ${position.page} 页图片 ${position.order}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const text = normalizeProductInfoText(recognized.join("\n\n"), PRODUCT_INFO_MAX_SCANNED_TEXT);
      if (!text) throw new Error(pageWarnings[0] || "AI 未识别到可用产品信息");
      const sourceId = input.sourceId || createHash("sha256").update(await readFile(resolvedPath)).digest("hex");
      const recognizedPages = [...new Set(pageImages.map((item) => item.position.page))];
      files.push({ name: path.basename(resolvedPath), path: resolvedPath, extension: ".pdf", size: info.size, text, sourceId, recognizedPages, recognitionId: `${sourceId}:scan:${recognizedPages.join(",")}` });
      warnings.push(...pageWarnings.map((message) => `${path.basename(resolvedPath)}：${message}`));
    } catch (error) {
      warnings.push(`${path.basename(resolvedPath)}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!files.length) throw new Error(warnings[0] || "没有从扫描件中识别到产品信息");
  return {
    text: normalizeProductInfoText(files.map((file) => `【AI 识别扫描件：${file.name}】\n${file.text}`).join("\n\n"), PRODUCT_INFO_MAX_SCANNED_TEXT),
    files: files.map(({ name, path: filePath, extension, size, sourceId, recognizedPages, recognitionId }) => ({ name, path: filePath, extension, size, sourceId, recognizedPages, recognitionId })),
    documents: files.map(({ name, text, recognitionId }) => ({ name, text, sourceId: recognitionId })),
    warnings,
  };
}
