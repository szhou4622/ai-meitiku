const PRIORITY_GROUPS = [
  [/消耗/, /花费/, /投放金额/, /(?:^|[^a-z])spend(?:[^a-z]|$)/, /(?:^|[^a-z])cost(?:[^a-z]|$)/],
  [/(?:支付|成交|转化|整体)?roi/, /投入产出比/, /returnoninvestment/],
  [/成交金额/, /支付金额/, /交易金额/, /成交额/, /(?:^|[^a-z])gmv(?:[^a-z]|$)/, /revenue/],
  [/(?:3秒|3s|前3秒).*(?:完播|播放|观看|留存)/, /(?:完播|播放|观看|留存).*(?:3秒|3s|前3秒)/],
];

const METRIC_HINT = /消耗|花费|roi|金额|成交|支付|播放|完播|展现|点击|转化|订单|销量|粉丝|评论|点赞|收藏|观看|留存|时长|spend|cost|gmv|revenue|rate|count|amount|click|view|play|order|sale/;
const CONTROL_HEADERS = new Set([
  "关联id", "关联编号", "配对id", "素材id", "id", "key", "associationid",
  "画面", "视频", "图片", "文件", "文件名", "画面路径", "视频路径", "素材路径", "media", "visual", "file", "path",
  "文案", "脚本", "口播", "字幕", "copy", "script", "text",
  "大分类", "素材大类", "分类", "文案类型", "画面类型", "画面分类", "素材类型", "素材分类", "category", "type", "majorcategory", "visualtype", "frametype",
  "标题", "名称", "title", "name",
]);

function normalizeHeader(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_\-:/：（）()]+/g, "");
}

function isControlHeader(header) {
  const normalized = normalizeHeader(header);
  if (CONTROL_HEADERS.has(normalized)) return true;
  return !METRIC_HINT.test(normalized) && /(?:素材|画面|视频|图片).*(?:文件|文件名|名称|路径)/.test(normalized);
}

export function defaultViralDisplayColumns(headers, excludedColumns = [], limit = 4) {
  const excluded = new Set((excludedColumns || []).filter((index) => Number.isSafeInteger(index) && index >= 0));
  const normalized = headers.map(normalizeHeader);
  const selected = [];
  const add = (index) => {
    if (index < 0 || excluded.has(index) || selected.includes(index) || selected.length >= limit) return;
    selected.push(index);
  };

  for (const patterns of PRIORITY_GROUPS) {
    add(normalized.findIndex((header, index) => !excluded.has(index) && patterns.some((pattern) => pattern.test(header))));
  }
  normalized.forEach((header, index) => {
    if (METRIC_HINT.test(header) && !isControlHeader(headers[index])) add(index);
  });
  normalized.forEach((_, index) => {
    if (!isControlHeader(headers[index])) add(index);
  });
  normalized.forEach((_, index) => add(index));
  return selected;
}
