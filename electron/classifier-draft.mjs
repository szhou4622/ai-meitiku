const ruleLabels = {
  principles: "分类原则",
  classification_principles: "分类原则",
  boundaries: "边界说明",
  boundary_rules: "边界说明",
  boundary_explanations: "边界说明",
  corrections: "错分纠正样例",
  correction_examples: "错分纠正样例",
  examples: "示例",
};

function scalarText(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function indent(text) {
  return String(text || "").split("\n").map((line) => `  ${line}`).join("\n");
}

export function formatClassifierDraftText(value) {
  const scalar = scalarText(value);
  if (scalar) return scalar;
  if (Array.isArray(value)) {
    return value
      .map((item) => formatClassifierDraftText(item))
      .filter(Boolean)
      .map((item) => `- ${item.replace(/\n/g, "\n  ")}`)
      .join("\n");
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => {
        const text = formatClassifierDraftText(item);
        if (!text) return "";
        const label = ruleLabels[String(key).toLowerCase()] || String(key).trim();
        const structured = Array.isArray(item) || (item && typeof item === "object");
        return structured ? `${label}：\n${indent(text)}` : `${label}：${text}`;
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function normalizeTaxonomyItems(value) {
  if (typeof value === "string") {
    return value.split(/[\n,，、;；]+/).map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const scalar = scalarText(item);
      if (scalar) return [scalar];
      if (!item || typeof item !== "object") return [];
      const named = item.name ?? item.label ?? item.title ?? item.category ?? item.value;
      const namedText = scalarText(named);
      return namedText ? [namedText] : [];
    });
  }
  if (value && typeof value === "object") {
    const nested = value.items ?? value.children ?? value.categories ?? value.subcategories ?? value.sub_categories;
    if (nested !== undefined) return normalizeTaxonomyItems(nested);
    return Object.keys(value).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

export function normalizeClassifierTaxonomy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, items]) => [String(key).trim(), [...new Set(normalizeTaxonomyItems(items))]])
      .filter(([key, items]) => key && items.length),
  );
}

function contentToText(rawContent) {
  if (typeof rawContent === "string") return rawContent;
  if (Array.isArray(rawContent)) return rawContent.map(contentToText).join("");
  if (rawContent && typeof rawContent === "object") {
    if (typeof rawContent.text === "string") return rawContent.text;
    if (rawContent.content !== undefined) return contentToText(rawContent.content);
    return JSON.stringify(rawContent);
  }
  return String(rawContent || "");
}

function scalarOrFallback(value, fallback) {
  return scalarText(value) || fallback;
}

function namingRuleOrFallback(value) {
  const direct = scalarText(value);
  if (direct) return direct;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nested = value.pattern ?? value.template ?? value.format ?? value.naming_rule;
    const nestedText = scalarText(nested);
    if (nestedText) return nestedText;
  }
  return "产品名_二级分类_具体画面_景别_素材拍摄日期_序号";
}

const supportedNamingTokens = new Set([
  "产品名", "产品名称", "品名", "二级分类", "二级类目", "具体画面", "画面内容", "画面",
  "景别", "景别或形态", "形态", "素材拍摄日期", "拍摄日期", "日期", "序号", "编号",
]);

function comparableCategory(value) {
  return String(value || "")
    .replace(/^\s*\d+[._、\-\s]*/u, "")
    .replace(/[\s_，,。.;；:：、/\\\-]+/gu, "")
    .toLowerCase();
}

function forbiddenCategoryTerms(brief) {
  const line = String(brief || "").split(/\r?\n/u).find((item) => /^\s*不希望出现的类目或命名\s*[：:]/u.test(item));
  if (!line) return [];
  return line.replace(/^.*?[：:]/u, "").split(/[，,、;；|/\n]+/u).map((item) => item.trim()).filter(Boolean);
}

export function validateClassifierDraftQuality(draft, productBrief = "", aiIssues = []) {
  const issues = [];
  const taxonomy = normalizeClassifierTaxonomy(draft?.taxonomy);
  const seenFirst = new Map();
  const seenSecond = new Map();
  for (const [first, children] of Object.entries(taxonomy)) {
    const firstKey = comparableCategory(first);
    if (firstKey && seenFirst.has(firstKey)) {
      issues.push({ code: "duplicate_first_level", severity: "error", message: `一级分类“${first}”与“${seenFirst.get(firstKey)}”重复` });
    } else if (firstKey) seenFirst.set(firstKey, first);
    for (const child of children) {
      const childKey = comparableCategory(child);
      const previous = seenSecond.get(childKey);
      if (childKey && previous) {
        issues.push({ code: "duplicate_second_level", severity: "error", message: `二级分类“${child}”重复出现在“${previous}”和“${first}”中` });
      } else if (childKey) seenSecond.set(childKey, first);
    }
  }
  const secondNames = [...seenSecond.keys()];
  for (let leftIndex = 0; leftIndex < secondNames.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < secondNames.length; rightIndex += 1) {
      const left = secondNames[leftIndex];
      const right = secondNames[rightIndex];
      if (Math.min(left.length, right.length) >= 4 && (left.includes(right) || right.includes(left))) {
        issues.push({ code: "possible_overlap", severity: "warning", message: `二级分类“${left}”与“${right}”可能存在包含关系，请确认边界是否互斥` });
      }
    }
  }
  const allDraftText = `${Object.keys(taxonomy).join("\n")}\n${Object.values(taxonomy).flat().join("\n")}\n${draft?.naming_rule || ""}`;
  for (const forbidden of forbiddenCategoryTerms(productBrief)) {
    if (forbidden && allDraftText.includes(forbidden)) {
      issues.push({ code: "forbidden_category", severity: "error", message: `草案包含用户明确禁止的类目或命名“${forbidden}”` });
    }
  }
  const namingTokens = String(draft?.naming_rule || "").split("_").map((item) => item.trim()).filter(Boolean);
  for (const token of namingTokens) {
    const placeholder = token.match(/^\{([^{}]+)\}$/u)?.[1] || token.match(/^\[([^\[\]]+)\]$/u)?.[1];
    if (placeholder && !supportedNamingTokens.has(placeholder)) {
      issues.push({ code: "unsupported_naming_field", severity: "warning", message: `命名规则字段“${token}”不是软件支持的动态字段，将被当作固定文字` });
    }
  }
  for (const issue of Array.isArray(aiIssues) ? aiIssues : []) {
    const message = scalarText(issue?.message);
    if (message && issue?.fixed !== true) issues.push({
      code: scalarText(issue?.code) || "ai_quality_check",
      severity: issue?.severity === "error" ? "error" : "warning",
      message,
    });
  }
  const unique = [...new Map(issues.map((issue) => [`${issue.code}:${issue.message}`, issue])).values()];
  return { passed: unique.length === 0, issues: unique, checkedAt: new Date().toISOString() };
}

export function extractAuditedClassifierDraft(rawContent, originalDraft, productBrief = "") {
  const content = contentToText(rawContent);
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || content;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("质量检查没有返回可识别的 JSON");
  const audited = JSON.parse(fenced.slice(start, end + 1));
  const draft = audited?.draft ? extractClassifierDraft(JSON.stringify(audited.draft)) : originalDraft;
  const quality = validateClassifierDraftQuality(draft, productBrief, audited?.issues);
  return { ...draft, quality, repairedCount: Array.isArray(audited?.issues) ? audited.issues.filter((item) => item?.fixed === true).length : 0 };
}

export function extractClassifierDraft(rawContent) {
  const content = contentToText(rawContent);
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || content;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("文本模型没有返回可识别的分类方案 JSON");
  const draft = JSON.parse(fenced.slice(start, end + 1));
  const taxonomy = normalizeClassifierTaxonomy(draft?.taxonomy);
  if (!draft || typeof draft !== "object" || !Object.keys(taxonomy).length) {
    throw new Error("文本模型返回的分类结构不完整");
  }
  return {
    name: scalarOrFallback(draft.name, "AI 分类方案"),
    product_name: scalarOrFallback(draft.product_name, "未命名产品"),
    taxonomy,
    rules: formatClassifierDraftText(draft.rules),
    naming_rule: namingRuleOrFallback(draft.naming_rule),
  };
}
