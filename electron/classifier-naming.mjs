const namingAliases = new Map([
  ["产品名", "product_name"], ["产品名称", "product_name"], ["品名", "product_name"],
  ["二级分类", "subcategory"], ["二级类目", "subcategory"],
  ["具体画面", "detail"], ["画面内容", "detail"], ["画面", "detail"],
  ["景别", "form"], ["景别或形态", "form"], ["形态", "form"],
  ["素材拍摄日期", "shoot_date"], ["拍摄日期", "shoot_date"], ["日期", "shoot_date"],
  ["序号", "sequence"], ["编号", "sequence"],
]);

export function sanitizeClassifierFilenamePart(value) {
  return String(value ?? "")
    .replace(/[\\/:*?"<>|_\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .trim();
}

export function fitClassifierFilenameParts(parts, maxBytes = 220) {
  const next = parts.filter(Boolean).map((part) => [...part]);
  const byteLength = () => Buffer.byteLength(next.map((part) => part.join("")).join("_"), "utf8");
  while (byteLength() > maxBytes) {
    let longestIndex = -1;
    let longestBytes = 0;
    next.forEach((part, index) => {
      const size = Buffer.byteLength(part.join(""), "utf8");
      if (part.length > 2 && size > longestBytes) {
        longestIndex = index;
        longestBytes = size;
      }
    });
    if (longestIndex < 0) break;
    next[longestIndex].pop();
  }
  return next.map((part) => part.join("")).filter(Boolean);
}

export function buildClassifierFilenameParts(rule, values, productName = "", options = {}) {
  const tokens = String(rule || "产品名_二级分类_具体画面_景别或形态_素材拍摄日期_序号")
    .split("_").map((token) => token.trim()).filter(Boolean);
  const normalizedProductName = sanitizeClassifierFilenamePart(productName || values?.product_name || "未命名产品");
  const normalizedValues = {
    product_name: normalizedProductName,
    subcategory: sanitizeClassifierFilenamePart(values?.subcategory),
    detail: sanitizeClassifierFilenamePart(values?.detail),
    form: sanitizeClassifierFilenamePart(values?.form),
    shoot_date: sanitizeClassifierFilenamePart(values?.shoot_date),
    sequence: sanitizeClassifierFilenamePart(values?.sequence),
  };
  const generated = tokens.map((token) => {
    const field = namingAliases.get(token) ?? (token === normalizedProductName ? "product_name" : "");
    if (field === "sequence" && options.addSequence === false) return "";
    return sanitizeClassifierFilenamePart(field ? normalizedValues[field] : token);
  }).filter(Boolean);
  const originalName = options.preserveOriginalName
    ? sanitizeClassifierFilenamePart(options.originalName)
    : "";
  return fitClassifierFilenameParts(originalName ? [originalName, ...generated] : generated);
}
