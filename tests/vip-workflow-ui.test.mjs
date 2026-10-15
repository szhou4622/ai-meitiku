import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { featureRegistry } from "../electron/feature-registry.mjs";

test("locked workflows render their own inert outlines through the shared VIP card", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const preview = await readFile(new URL("../app/vip-workflow-preview.tsx", import.meta.url), "utf8");
  const start = page.indexOf("function VipFeatureLockedPage(");
  const end = page.indexOf("\nfunction LicensedApplication(", start);
  assert.ok(start > 0 && end > start);
  const source = `import { Sparkles, LockKeyhole, ShieldCheck, KeyRound, Images } from "lucide-react";\nconst featureMenuIcons = {};\n${preview}\nexport ${page.slice(start, end)}`;
  const modulePath = new URL(`../app/.vip-workflow-ui-${randomUUID()}.mjs`, import.meta.url);
  try {
    await writeFile(modulePath, ts.transpileModule(source, { compilerOptions: {jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext} }).outputText);
    const { VipFeatureLockedPage } = await import(modulePath.href);
    for (const [id, labels] of [
      ["subtitle-removal", ["框选字幕区域", "批量处理", "历史记录"]],
      ["prompt-library", ["1:1 还原", "可迁移模板", "提示词正文", "逐镜提示词"]],
    ]) {
      const html = renderToStaticMarkup(createElement(VipFeatureLockedPage, {feature:featureRegistry.get(id),onRedeem(){},onBack(){}}));
      for (const label of [...labels, "当前基础授权暂未包含此功能", "前往兑换VIP时间码"]) assert.ok(html.includes(label), label);
      assert.match(html, /vip-feature-locked-backdrop[^>]*aria-hidden="true"[^>]*inert/);
      const backdrop = html.split('aria-hidden="true" inert=""')[1]?.split('vip-feature-locked-veil')[0];
      assert.ok(backdrop);
      assert.doesNotMatch(backdrop, /<button|<input|<video|<iframe|contenteditable/i);
    }
    assert.match(page, /canAccessFeature\(featureRegistry, "prompt-library", licenseState\) && <div/);
    assert.match(page, /canAccessFeature\(featureRegistry, "subtitle-removal", licenseState\) && <div className="persistent-subtitle-host"/);
    const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
    assert.match(styles, /\.vip-feature-locked-backdrop\s*\{[^}]*filter:\s*blur\(2\.2px\)/);
  } finally { await rm(modulePath, {force:true}); }
});
