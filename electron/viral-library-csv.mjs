import path from "node:path";
import { defaultViralDisplayColumns } from "../app/viral-display-columns.mjs";

const HEADER_ALIASES = {
  associationId: ["关联id", "关联编号", "配对id", "素材id", "associationid", "association_id", "key", "id"],
  media: ["画面", "视频", "图片", "文件", "文件名", "画面路径", "视频路径", "素材路径", "media", "visual", "file", "path"],
  copy: ["文案", "脚本", "口播", "字幕", "copy", "script", "text"],
  category: ["分类", "文案类型", "category", "type"],
  majorCategory: ["大分类", "素材大类", "majorcategory", "major_category"],
  title: ["标题", "名称", "title", "name"],
};
const VISUAL_TYPE_ALIASES = ["画面类型", "画面分类", "素材类型", "素材分类", "visualtype", "visual_type", "frametype", "frame_type"];

function normalizedHeader(value) {
  return String(value ?? "").replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s-]+/g, "");
}

function csvDataRows(source) {
  const rows = parseCsvRows(source).filter((row) => row.some((cell) => String(cell).trim()));
  if (rows.length < 2) throw new Error("CSV 至少需要表头和 1 行数据");
  if (rows.length > 5001) throw new Error("CSV 最多支持 5000 行数据");
  return rows;
}

function automaticColumns(headers) {
  const normalized = headers.map(normalizedHeader);
  const columnFor = (name) => normalized.findIndex((item) => HEADER_ALIASES[name].includes(item));
  const columns = {
    ...Object.fromEntries(Object.keys(HEADER_ALIASES).filter((name) => name !== "category").map((name) => [name, columnFor(name)])),
    category: normalized.flatMap((name, index) => !HEADER_ALIASES.majorCategory.includes(name) && (HEADER_ALIASES.category.includes(name) || /分类|类目|标签/.test(name)) ? [index] : []),
  };
  const controlColumns = [columns.associationId, columns.media, columns.copy, columns.majorCategory, columns.title, ...columns.category];
  return { ...columns, data: defaultViralDisplayColumns(headers, controlColumns) };
}

function selectedColumns(value, headers) {
  const columnCount = headers.length;
  const result = {};
  for (const name of Object.keys(HEADER_ALIASES).filter((item) => item !== "category")) {
    const index = Number(value?.[name]);
    result[name] = Number.isSafeInteger(index) && index >= 0 && index < columnCount ? index : -1;
  }
  const categories = Array.isArray(value?.category) ? value.category : [value?.category];
  result.category = [...new Set(categories.filter((index) => Number.isSafeInteger(index) && index >= 0 && index < columnCount))];
  if (result.category.length > 24) throw new Error("最多选择 24 个分类字段");
  if (result.majorCategory >= 0 && result.category.includes(result.majorCategory)) {
    throw new Error("同一列不能同时作为大分类和细分类字段");
  }
  const dataFields = Array.isArray(value?.data)
    ? value.data
    : defaultViralDisplayColumns(headers, [result.associationId, result.media, result.copy, result.majorCategory, result.title, ...result.category]);
  result.data = [...new Set(dataFields.filter((index) => Number.isSafeInteger(index) && index >= 0 && index < columnCount))];
  if (result.data.length > 128) throw new Error("最多保留 128 个数据字段");
  return result;
}

export function inspectViralLibraryCsv(source) {
  const rows = csvDataRows(source);
  const headers = rows[0].map((value, index) => String(value ?? "").replace(/^\uFEFF/, "").trim() || `第 ${index + 1} 列`);
  if (headers.length > 128) throw new Error("CSV 最多支持 128 列数据");
  return {
    headers,
    columns: automaticColumns(headers),
    previewRows: rows.slice(1, 4).map((row) => headers.map((_, index) => String(row[index] ?? "").trim())),
    rowCount: rows.length - 1,
  };
}

export function decodeCsvBuffer(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { return new TextDecoder("gb18030").decode(buffer); }
}

export function parseCsvRows(source) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  const input = String(source ?? "").replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') { value += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else value += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") { row.push(value); value = ""; }
    else if (character === "\n") { row.push(value); rows.push(row); row = []; value = ""; }
    else if (character !== "\r") value += character;
  }
  row.push(value);
  if (row.some((cell) => cell.trim()) || rows.length === 0) rows.push(row);
  if (quoted) throw new Error("CSV 存在未闭合的引号");
  return rows;
}

export function inspectViralDataCsv(source) {
  const rows = csvDataRows(source);
  const headers = rows[0].map((value, index) => String(value ?? "").replace(/^\uFEFF/, "").trim() || `第 ${index + 1} 列`);
  if (headers.length > 128) throw new Error("CSV 最多支持 128 列数据");
  const matchColumn = headers.findIndex((header) => HEADER_ALIASES.media.includes(normalizedHeader(header)) || /(?:素材|画面|视频|图片).*(?:文件|名称|路径)/.test(normalizedHeader(header)));
  const copyColumn = headers.findIndex((header) => {
    const normalized = normalizedHeader(header);
    return HEADER_ALIASES.copy.includes(normalized) || /文案|脚本|口播|字幕/.test(normalized);
  });
  const visualTypeColumn = headers.findIndex((header) => VISUAL_TYPE_ALIASES.includes(normalizedHeader(header)));
  return {
    headers,
    rowCount: rows.length - 1,
    matchColumn,
    copyColumn,
    visualTypeColumn,
    displayColumns: defaultViralDisplayColumns(headers, [matchColumn, copyColumn, visualTypeColumn]),
    previewRows: rows.slice(1, 4).map((row) => headers.map((_, index) => String(row[index] ?? "").trim())),
  };
}

export function parseViralDataCsv(source, matchColumn, options = {}) {
  const inspection = inspectViralDataCsv(source);
  if (!Number.isSafeInteger(matchColumn) || matchColumn < 0 || matchColumn >= inspection.headers.length) {
    throw new Error("请选择 CSV 中用于匹配画面文件的列");
  }
  const requestedDisplayColumns = Array.isArray(options.displayColumns)
    ? options.displayColumns
    : defaultViralDisplayColumns(inspection.headers, [matchColumn, inspection.copyColumn, inspection.visualTypeColumn]);
  const displayColumns = [...new Set(requestedDisplayColumns)]
    .filter((index) => Number.isSafeInteger(index) && index >= 0 && index < inspection.headers.length && index !== matchColumn);
  const copyColumn = Number.isSafeInteger(options.copyColumn) && options.copyColumn >= 0 && options.copyColumn < inspection.headers.length
    ? options.copyColumn
    : -1;
  const visualTypeColumn = Number.isSafeInteger(options.visualTypeColumn) && options.visualTypeColumn >= 0 && options.visualTypeColumn < inspection.headers.length
    ? options.visualTypeColumn
    : -1;
  return {
    headers: inspection.headers,
    rows: csvDataRows(source).slice(1).map((row, index) => ({
      rowNumber: index + 2,
      matchValue: String(row[matchColumn] ?? "").trim(),
      fields: displayColumns.flatMap((column) => {
        const value = String(row[column] ?? "").trim();
        return value ? [{ name: inspection.headers[column], value }] : [];
      }),
      copyText: copyColumn >= 0 ? String(row[copyColumn] ?? "").trim() : "",
      visualTypes: visualTypeColumn >= 0
        ? [...new Set(String(row[visualTypeColumn] ?? "").split(/[,\uff0c/\u3001;\uff1b|]+/).map((value) => value.trim()).filter(Boolean))].slice(0, 8)
        : [],
    })).filter((row) => row.matchValue),
  };
}

export function parseViralLibraryCsv(source, csvPath, mapping) {
  const rows = csvDataRows(source);
  const columns = mapping ? selectedColumns(mapping, rows[0]) : automaticColumns(rows[0]);
  if (columns.category.length > 24) throw new Error("最多选择 24 个分类字段");
  const headers = rows[0].map((value, index) => String(value ?? "").replace(/^\uFEFF/, "").trim() || `第 ${index + 1} 列`);
  if (columns.media < 0 && columns.copy < 0) throw new Error("请至少选择一个“画面路径”或“文案”字段");
  const baseDirectory = path.dirname(path.resolve(csvPath));
  const valueAt = (row, index) => index >= 0 ? String(row[index] ?? "").trim() : "";
  const result = rows.slice(1).map((row, index) => {
    const mediaValue = valueAt(row, columns.media);
    const mediaPath = mediaValue ? (path.isAbsolute(mediaValue) ? path.normalize(mediaValue) : path.resolve(baseDirectory, mediaValue)) : "";
    const copy = valueAt(row, columns.copy);
    if (!mediaPath && !copy) return null;
    const classifications = columns.category.flatMap((column) => {
      const value = valueAt(row, column);
      return value ? [{ field: headers[column], value }] : [];
    });
    const dataFields = columns.data.flatMap((column) => {
      const value = valueAt(row, column);
      return value ? [{ name: headers[column], value }] : [];
    });
    return {
      rowNumber: index + 2,
      associationId: valueAt(row, columns.associationId) || `row-${index + 2}`,
      mediaPath,
      copy,
      category: classifications[0]?.value || "未分类",
      majorCategory: valueAt(row, columns.majorCategory).slice(0, 100),
      classifications,
      dataFields,
      title: valueAt(row, columns.title) || (mediaPath ? path.basename(mediaPath, path.extname(mediaPath)) : `文案 ${index + 1}`),
    };
  }).filter(Boolean);
  if (!result.length) throw new Error("CSV 中没有可导入的画面或文案");
  return result;
}
