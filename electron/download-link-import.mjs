import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { OfficeParser } from "officeparser";
import { extractSupportedLinks } from "./download-service.mjs";

export const DOWNLOAD_LINK_IMPORT_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const DOWNLOAD_LINK_IMPORT_MAX_LINKS = 100;
export const DOWNLOAD_LINK_IMPORT_EXTENSIONS = new Set([".xlsx", ".xls", ".csv"]);

function decodeTextBuffer(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8");
}

export function collectSpreadsheetLinkText(ast) {
  const fragments = [];
  const visited = new WeakSet();
  let visitedNodes = 0;
  let collectedCharacters = 0;

  function visit(value, key = "") {
    if (visitedNodes >= 500_000 || collectedCharacters >= 12_000_000) return;
    if (typeof value === "string") {
      if (["text", "link", "url", "hyperlink", "target"].includes(key)) {
        fragments.push(value);
        collectedCharacters += value.length;
      }
      return;
    }
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    visitedNodes += 1;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
      return;
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      if (["rawContent", "data", "attachments"].includes(childKey)) continue;
      visit(childValue, childKey);
    }
  }

  visit(ast);
  return fragments.join("\n");
}

export function normalizeImportedDownloadLinks(source, limit = DOWNLOAD_LINK_IMPORT_MAX_LINKS) {
  const links = extractSupportedLinks(source);
  return {
    links: links.slice(0, limit),
    foundCount: links.length,
    importedCount: Math.min(links.length, limit),
    truncatedCount: Math.max(0, links.length - limit),
  };
}

async function extractXlsxText(filePath, parseOffice) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const ast = await parseOffice(filePath, {
      abortSignal: controller.signal,
      ignoreComments: false,
      ignoreHeadersAndFooters: false,
      extractAttachments: false,
    });
    const generated = await ast.to("text", { newlineDelimiter: "\n" });
    return `${String(generated?.value ?? "")}\n${collectSpreadsheetLinkText(ast)}`;
  } finally {
    clearTimeout(timeout);
  }
}

export async function importDownloadLinksFromSpreadsheet(filePath, options = {}) {
  const resolvedPath = path.resolve(String(filePath || ""));
  const extension = path.extname(resolvedPath).toLowerCase();
  if (!DOWNLOAD_LINK_IMPORT_EXTENSIONS.has(extension)) throw new Error("请选择 .xlsx、.xls 或 .csv 文件");
  const info = await stat(resolvedPath);
  if (!info.isFile()) throw new Error("所选路径不是可读取的文件");
  if (info.size > DOWNLOAD_LINK_IMPORT_MAX_FILE_BYTES) throw new Error("Excel 文件超过 32MB 限制");

  let source = "";
  if (extension === ".xlsx") {
    const parseOffice = options.parseOffice ?? OfficeParser.parseOffice.bind(OfficeParser);
    source = await extractXlsxText(resolvedPath, parseOffice);
  } else {
    const buffer = await readFile(resolvedPath);
    source = extension === ".xls"
      ? `${buffer.toString("latin1")}\n${buffer.toString("utf16le")}`
      : decodeTextBuffer(buffer);
  }

  const result = normalizeImportedDownloadLinks(source);
  if (!result.links.length) throw new Error("Excel 中未读取到抖音或小红书链接");
  return { cancelled: false, fileName: path.basename(resolvedPath), ...result };
}
