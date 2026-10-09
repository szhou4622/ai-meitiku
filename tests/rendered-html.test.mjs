import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractClassifierDraft, validateClassifierDraftQuality } from "../electron/classifier-draft.mjs";
import { buildClassifierFilenameParts } from "../electron/classifier-naming.mjs";
import { buildClassifierPreviewMetadata } from "../electron/classifier-preview.mjs";
import { consumeGeneratedClassifierSources } from "../electron/classifier-source-cleanup.mjs";
import { validateClassifierOutputRoot } from "../electron/classifier-output-root.mjs";
import { buildFolderRelinkPlan } from "../electron/media-folder-relink.mjs";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("normalizes structured classifier draft fields returned by different models", () => {
  const draft = extractClassifierDraft([{ text: JSON.stringify({
    name: "测试方案",
    product_name: "测试产品",
    taxonomy: {
      "01_素材来源": ["自有拍摄", { name: "达人原片" }],
      "02_使用场景": { subcategories: ["居家", "办公"] },
    },
    rules: {
      classification_principles: ["按主体画面分类", "不得凭空推断功效"],
      boundary_rules: { "多主体": "按主要占比最高的主体分类" },
      correction_examples: ["背景有多瓶但主体一瓶，仍按主体一瓶分类"],
    },
    naming_rule: { pattern: "产品名_二级分类_序号" },
  }) }]);

  assert.deepEqual(draft.taxonomy, {
    "01_素材来源": ["自有拍摄", "达人原片"],
    "02_使用场景": ["居家", "办公"],
  });
  assert.match(draft.rules, /分类原则/);
  assert.match(draft.rules, /边界说明/);
  assert.match(draft.rules, /错分纠正样例/);
  assert.doesNotMatch(draft.rules, /\[object Object\]/);
  assert.equal(draft.naming_rule, "产品名_二级分类_序号");
});

test("validates duplicate, forbidden, overlapping, and unsupported classifier draft fields", () => {
  const quality = validateClassifierDraftQuality({
    taxonomy: {
      "01_使用场景": ["办公室日常使用", "办公室日常"],
      "02_场景": ["办公室日常使用", "禁止功效"],
    },
    naming_rule: "产品名_{不存在字段}_序号",
  }, "不希望出现的类目或命名：禁止功效");
  assert.equal(quality.passed, false);
  assert.ok(quality.issues.some((issue) => issue.code === "duplicate_second_level"));
  assert.ok(quality.issues.some((issue) => issue.code === "possible_overlap"));
  assert.ok(quality.issues.some((issue) => issue.code === "forbidden_category"));
  assert.ok(quality.issues.some((issue) => issue.code === "unsupported_naming_field"));
});

test("builds classifier filenames from ordered fields and fixed text safely", () => {
  const values = {
    product_name: "桌面磁吸折叠手机支架",
    subcategory: "办公/使用",
    detail: "支架展开",
    form: "近景",
    shoot_date: "260823",
    sequence: "01",
  };
  assert.deepEqual(
    buildClassifierFilenameParts("固定片头_序号_产品名_二级分类", values),
    ["固定片头", "01", "桌面磁吸折叠手机支架", "办公-使用"],
  );
  assert.deepEqual(
    buildClassifierFilenameParts("产品名_二级分类_序号", values, values.product_name, {
      preserveOriginalName: true,
      addSequence: false,
      originalName: "原始素材 01.mp4",
    }),
    ["原始素材 01.mp4", "桌面磁吸折叠手机支架", "办公-使用"],
  );
  const longParts = buildClassifierFilenameParts(`产品名_${"超长固定文字".repeat(80)}_序号`, values);
  assert.ok(Buffer.byteLength(longParts.join("_"), "utf8") <= 220);
  assert.doesNotMatch(longParts.join("_"), /[\\/:*?"<>|]/);
});

test("rejects broad classifier output roots while allowing an explicit project folder", () => {
  const macProtected = ["/Users/demo", "/Users/demo/Downloads"];
  assert.equal(validateClassifierOutputRoot("/Users/demo/Downloads", {
    platform: "darwin",
    protectedRoots: macProtected,
  }).ok, false);
  assert.deepEqual(validateClassifierOutputRoot("/Users/demo/Downloads/磁吸手机", {
    platform: "darwin",
    protectedRoots: macProtected,
  }), {
    ok: true,
    path: "/Users/demo/Downloads/磁吸手机",
  });

  assert.equal(validateClassifierOutputRoot("c:\\users\\demo\\downloads", {
    platform: "win32",
    protectedRoots: ["C:\\Users\\Demo\\Downloads"],
  }).ok, false);
  assert.equal(validateClassifierOutputRoot("C:\\Users\\Demo\\Downloads\\项目A", {
    platform: "win32",
    protectedRoots: ["C:\\Users\\Demo\\Downloads"],
  }).ok, true);
});

test("relinks a lost folder tree by path without merging a same-name folder", () => {
  const folders = [
    { path: "/old/项目", name: "项目", available: false },
    { path: "/old/项目/01_场景", name: "01_场景", parentPath: "/old/项目", available: false },
    { path: "/other/项目", name: "项目", available: true },
  ];
  const assets = [
    {
      id: 1,
      name: "旧名称",
      localPath: "/old/项目/01_场景/a.mp4",
      sourceRoot: "/old/项目/01_场景",
      sourceKind: "folder",
      tags: ["精选"],
      favorite: true,
      collection: "保留项目",
      broken: true,
      available: false,
    },
  ];
  const plan = buildFolderRelinkPlan({
    oldRoot: "/old/项目",
    newRoot: "/new/项目",
    folders,
    assets,
    availableDirectories: ["/new/项目", "/new/项目/01_场景"],
    mediaRecords: [{
      path: "/new/项目/01_场景/a.mp4",
      name: "a.mp4",
      type: "video",
      sizeBytes: 123,
      modifiedAt: 456,
      url: "media://a",
    }],
    platform: "darwin",
  });

  assert.ok(plan.folders.some((folder) => folder.path === "/other/项目" && folder.available));
  assert.ok(plan.folders.some((folder) => folder.path === "/new/项目/01_场景" && folder.parentPath === "/new/项目"));
  assert.equal(plan.assets[0].localPath, "/new/项目/01_场景/a.mp4");
  assert.equal(plan.assets[0].sourceRoot, "/new/项目/01_场景");
  assert.deepEqual(plan.assets[0].tags, ["精选"]);
  assert.equal(plan.assets[0].favorite, true);
  assert.equal(plan.assets[0].collection, "保留项目");
  assert.equal(plan.assets[0].broken, false);
  assert.deepEqual(plan.stats, { folders: 2, newFolders: 0, reconnectedAssets: 1, missingAssets: 0, newAssets: 0 });
});

test("rebuilds discovered child-folder hierarchy while relinking", () => {
  const plan = buildFolderRelinkPlan({
    oldRoot: "/old/项目",
    newRoot: "/new/项目",
    folders: [{ path: "/old/项目", name: "项目", available: false }],
    assets: [],
    availableDirectories: ["/new/项目", "/new/项目/01_场景", "/new/项目/01_场景/办公室"],
    mediaRecords: [{
      path: "/new/项目/01_场景/办公室/new.mp4",
      name: "new.mp4",
      type: "video",
      sizeBytes: 10,
      modifiedAt: 20,
      url: "media://new",
    }],
    platform: "darwin",
  });

  assert.ok(plan.folders.some((folder) => folder.path === "/new/项目/01_场景" && folder.parentPath === "/new/项目"));
  assert.ok(plan.folders.some((folder) => folder.path === "/new/项目/01_场景/办公室" && folder.parentPath === "/new/项目/01_场景"));
  assert.equal(plan.newRecords[0].sourceRoot, "/new/项目/01_场景/办公室");
  assert.equal(plan.stats.newFolders, 2);
});

test("folder relink refuses to overwrite an indexed target path", () => {
  assert.throws(() => buildFolderRelinkPlan({
    oldRoot: "/old/项目",
    newRoot: "/new/项目",
    folders: [
      { path: "/old/项目", name: "项目", available: false },
      { path: "/new/项目", name: "项目", available: true },
    ],
    availableDirectories: ["/new/项目"],
    platform: "darwin",
  }), /新位置已被媒体库中的文件夹/);
});

test("serves the media library shell without a worker error", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>AI媒体库<\/title>/i);
  assert.match(html, /正在验证设备授权/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("license settings use the effective accumulated authorization period after renewal", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /licenseDisplayDetails\(state\.license\)/);
  assert.match(page, /licenseDisplay\.durationTitle/);
  assert.match(page, /licenseDisplay\.durationLabel/);
  assert.doesNotMatch(page, /state\.license\.durationDays\}\s*天/);
});

test("source preview shows the current dual-deadline UI without submitting customer codes", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /源码预览不会提交真实时间码/);
  assert.match(page, /双期限兑换界面已启用；源码预览不提交真实时间码/);
  assert.match(page, /previewAllFeatures:\s*true/);
  assert.match(page, /redemptionProtocolVersion:\s*1/);
});

test("persists unfinished classifier drafts and exposes selected generation safeguards", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../electron/preload.cjs", import.meta.url), "utf8");
  assert.match(page, /classifier-template-editor-draft-v1/);
  assert.match(page, /资料检查：还缺少/);
  assert.match(page, /生成后质量检查/);
  assert.match(page, /schemeImportedProductSourceIds/);
  assert.match(main, /正在整理产品资料/);
  assert.match(main, /正在设计分类结构/);
  assert.match(main, /正在检查分类冲突/);
  assert.match(main, /正在生成命名规则/);
  assert.match(main, /不可信的产品参考资料/);
  assert.match(preload, /classifier-draft-progress/);
});

test("keeps navigation focused and wires core media actions", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../electron/preload.cjs", import.meta.url), "utf8");
  const classifierEngine = await readFile(new URL("../mac-classifier-engine/engine_entry.py", import.meta.url), "utf8");
  const portableClassifierEngine = await readFile(new URL("../bundled-classifier/bin/darwin-x64/engine/engine_entry.py", import.meta.url), "utf8");

  assert.match(page, />媒体库</);
  assert.match(page, />分类方案</);
  assert.match(page, />素材分类工作台</);
  assert.match(page, /function ContactAuthorButton/);
  assert.match(page, />联系作者<\/button>/);
  assert.match(page, /onMouseEnter=\{reveal\}/);
  assert.match(page, /onFocusCapture=\{reveal\}/);
  assert.match(page, /aria-haspopup="dialog"/);
  assert.match(page, /fetch\("\/api\/contact"/);
  assert.match(page, /await preloadContactImage\(config\.qr_image_url\)/);
  assert.match(page, /联系方式暂未开放/);
  assert.match(page, /联系方式图片暂未配置/);
  assert.doesNotMatch(page, /联系作者[：:]\s*微信|微信号/);
  assert.match(styles, /\.contact-author-popover\s*\{[^}]*width:\s*360px;[^}]*min-height:\s*520px;/);
  assert.match(styles, /\.contact-author-image\s*\{[^}]*width:\s*100%;[^}]*height:\s*430px;/);
  assert.match(styles, /\.contact-author-image img\s*\{[^}]*max-width:\s*100%;[^}]*max-height:\s*100%;[^}]*object-fit:\s*contain;[^}]*object-position:\s*center;/);
  assert.match(page, /function ClassifierWorkbench/);
  assert.match(page, /className="license-detail-grid"[\s\S]*className="license-redemption-card"[\s\S]*<MachineCodeField compact \/>/);
  assert.match(page, /className="license-redemption-controls"/);
  assert.match(page, /placeholder="输入基础或 VIP 时间码"/);
  assert.doesNotMatch(page, /输入免费或 VIP 时间码/);
  assert.match(page, /兑换成功：\$\{codeLabel\}，增加 \$\{next\.redemption\.durationDays\} 天/);
  assert.match(styles, /\.license-redemption-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/);
  assert.match(page, /featureRegistry\.list\(\)\.filter\(\(feature\) => canDiscoverFeature/);
  assert.match(page, /className="persistent-classifier-host"/);
  assert.match(page, /hidden=\{activeModule !== "schemes" && activeModule !== "classifier"\}/);
  assert.match(page, /view=\{activeModule === "schemes" \? "schemes" : "workbench"\}/);
  assert.match(styles, /\.persistent-classifier-host\s*\{[^}]*display:\s*flex;/);
  assert.match(styles, /\.persistent-classifier-host\[hidden\]\s*\{[^}]*display:\s*none;/);
  assert.match(page, /className="persistent-voice-host"/);
  assert.match(page, /hidden=\{activeModule !== "voice"\}/);
  assert.match(page, /<VoiceCloneWorkbench notify=\{notify\} appName=\{licenseState\.appName\} \/>/);
  assert.match(styles, /\.persistent-voice-host\s*\{[^}]*display:\s*flex;/);
  assert.match(styles, /\.persistent-voice-host\[hidden\]\s*\{[^}]*display:\s*none;/);
  assert.match(page, /classifier-scheme-page-card/);
  assert.match(page, /classifier-scheme-list/);
  assert.match(page, /classifier-scheme-summary/);
  assert.match(page, /aria-expanded/);
  assert.match(page, /expandedSchemeId/);
  assert.match(page, /templates\.map/);
  assert.match(page, /setActiveScheme/);
  assert.match(page, /"设为当前"/);
  assert.match(page, /classifier-workbench-scheme-picker/);
  assert.match(page, /id="classifier-workbench-scheme"/);
  assert.match(page, /选择分类方案/);
  assert.match(page, /方案来自左侧“分类方案”栏目/);
  assert.match(page, /方案管理/);
  assert.match(page, /openCreateTemplate/);
  assert.match(page, /openEditTemplate/);
  assert.match(page, /saveTemplateDialog/);
  assert.match(page, /classifierProductBriefTemplate/);
  assert.match(page, /核心痛点/);
  assert.match(page, /核心卖点/);
  assert.match(page, /错分纠正样例/);
  assert.match(page, /AI 生成草案/);
  assert.match(page, /classifierGenerateTemplateDraft/);
  assert.match(page, /classifierImportProductInfoFiles/);
  assert.match(page, /classifierImportProductInfoPaths/);
  assert.match(page, /classifierRecognizeScannedProductInfo/);
  assert.match(page, /AI 识别扫描件/);
  assert.match(page, /不会自动执行“AI 生成草案”/);
  assert.match(page, /data-tooltip=/);
  assert.match(page, /上传产品资料/);
  assert.match(page, /点击上传或将文件拖到这里/);
  assert.match(page, /onDrop=\{dropProductInfoFiles\}/);
  assert.match(page, /支持 PPT\/PPTX、图片、HTML、PDF、Word、Excel、TXT\/Markdown\/CSV 等常见格式/);
  assert.match(page, /正在读取产品资料/);
  assert.match(page, /已读取 \{schemeImportedProductFiles\.length\} 个文件/);
  assert.match(preload, /classifierImportProductInfoFiles: \(\) => ipcRenderer\.invoke\("classifier-import-product-info-files"\)/);
  assert.match(preload, /classifierImportProductInfoPaths/);
  assert.match(preload, /classifierRecognizeScannedProductInfo/);
  assert.match(main, /registerProtectedHandle\("classifier-import-product-info-files"/);
  assert.match(main, /registerProtectedHandle\("classifier-recognize-scanned-product-info"/);
  assert.match(main, /extractProductInfoFiles\(selection\.filePaths/);
  assert.match(page, /classifier-inline-template-editor/);
  assert.match(page, /classifier-template-editor-scroll/);
  assert.match(styles, /\.classifier-card\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;/);
  assert.match(styles, /\.classifier-inline-template-editor \.classifier-template-editor-scroll\s*\{[^}]*height:\s*auto;[^}]*align-items:\s*stretch;/);
  assert.match(styles, /\.classifier-inline-template-editor \.classifier-ai-draft-panel\s*\{[^}]*align-self:\s*stretch;/);
  assert.match(page, /closeSchemeEditor/);
  assert.doesNotMatch(page, /modal-backdrop classifier-template-editor-backdrop/);
  assert.match(page, /parseClassifierTaxonomy/);
  assert.match(page, /分类规则 \/ 边界说明/);
  assert.match(page, /命名规则/);
  assert.match(page, /importTemplate/);
  assert.match(page, /exportTemplate/);
  assert.match(page, /保存并使用/);
  assert.match(page, /setActiveModule\("classifier"\)/);
  assert.match(page, /active-application-module-v1/);
  assert.match(page, /applicationModules\.includes\(savedModule\) && canDiscoverFeature\(featureRegistry, savedModule, licenseState\)/);
  assert.match(page, /localStorage\.setItem\(activeApplicationModuleStorageKey, activeModule\)/);
  assert.match(page, /"classifier-light"/);
  assert.match(page, /className="classifier-heading-icon workspace-heading-icon"/);
  assert.match(page, /function VoiceCloneWorkbench/);
  assert.match(page, /hidden=\{activeModule !== "voice"\}/);
  assert.match(page, /activeModule === "voice" \? "voice-light"/);
  assert.match(page, /\/api\/voice-clone\/create/);
  assert.doesNotMatch(page, /\/api\/voice-clone\/generate/);
  assert.match(page, /我确认拥有该声音样本的使用授权/);
  assert.match(page, /function VoiceAudioPlayer/);
  assert.match(page, />上传新声音</);
  assert.match(page, /className="voice-tabs two"/);
  assert.match(page, /tab === "library" \? "active"/);
  assert.match(page, />试听记录</);
  assert.match(page, /voice-workbench-tab-v1/);
  assert.match(page, /voice-library-selected-id-v1/);
  assert.match(page, /const preferred = items\.find/);
  assert.match(page, /\|\| items\[0\]/);
  assert.doesNotMatch(page, />选择声音库</);
  assert.doesNotMatch(page, /tab === "select"|handleUseVoice|chooseVoice|使用该声音|使用此声音/);
  assert.doesNotMatch(styles, /voice-selected-choice|voice-choice-list|voice-card-actions button\.use/);
  assert.match(page, /生成并下载试听/);
  assert.match(page, /下载试听音频/);
  assert.match(page, /voice\.legacyNotice && <p className="voice-card-notice">/);
  assert.match(page, /voice\.errorMessage && <p className="voice-card-error">/);
  assert.match(page, /不正式启用音色/);
  assert.match(page, /downloadLink\.click\(\)/);
  assert.match(page, /classifierRun/);
  assert.match(page, /const splitAndRename/);
  assert.match(page, /const \[runningAction, setRunningAction\]/);
  assert.match(page, /className="classifier-process-methods"/);
  assert.match(page, /role="radiogroup" aria-label="选择处理方式"/);
  assert.match(page, /<strong>仅打标<\/strong>/);
  assert.match(page, /<strong>仅分割<\/strong>/);
  assert.match(page, /<strong>分割\+打标<\/strong>/);
  assert.match(page, /aria-label="选择切割精度"/);
  assert.match(page, /<strong>粗略切割<\/strong>/);
  assert.match(page, /<strong>精细切割<\/strong>/);
  assert.match(page, /processMethod !== "classify"/);
  assert.match(page, /split_precision: runSplitPrecision/);
  assert.match(page, /split_precision: splitPrecision/);
  assert.match(page, /classifier-split-precision-v1/);
  assert.match(page, /setSplitPrecision\(payload\.split_precision\)/);
  assert.match(styles, /\.classifier-split-precision-options \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(main, /split_precision: payload\.command === "split" && payload\.split_precision === "rough" \? "rough" : "fine"/);
  for (const engine of [classifierEngine, portableClassifierEngine]) {
    assert.match(engine, /def configure_split_precision/);
    assert.match(engine, /STABLE_SCENE_THRESHOLD = 0\.38/);
    assert.match(engine, /STABLE_MIN_SEGMENT_SECONDS = 2\.4/);
    assert.match(engine, /STABLE_SCENE_THRESHOLD = 0\.24/);
    assert.match(engine, /STABLE_MIN_SEGMENT_SECONDS = 0\.8/);
    assert.match(engine, /configure_split_precision\(shot_splitter, request, emit\)/);
  }
  assert.match(page, /className="classifier-run-naming-options"/);
  assert.match(styles, /\.classifier-run-naming-options \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(page, />保留原名</);
  assert.match(page, />添加序号</);
  assert.match(page, />记住</);
  assert.match(page, /classifier-run-naming-options-v1/);
  assert.doesNotMatch(page, /输出结构/);
  assert.match(page, /data-tooltip="同时处理的素材任务数量/);
  assert.match(page, /data-tooltip="仅用于视频：每个视频均匀提取并交给模型分析的画面数量/);
  assert.match(styles, /\.classifier-option-help:hover::after, \.classifier-option-help:focus-visible::after/);
  assert.match(page, /开始\$\{selectedProcessLabel\}/);
  assert.match(page, /const \[retryTaskCount, setRetryTaskCount\] = useState\(0\)/);
  assert.match(page, /const \[retryPayload, setRetryPayload\] = useState<ClassifierRunPayload \| null>\(null\)/);
  assert.match(page, /retryTaskCount > 0/);
  assert.match(page, /继续重跑失败任务（\{retryTaskCount\}）/);
  assert.match(page, /const rerunFailedTasks/);
  assert.match(page, /folder: prepared\.folder/);
  assert.match(page, /await (?:window\.desktopBridge!|bridge)\.classifierBootstrap\(\);[\s\S]*applyState\(next\)/);
  assert.match(main, /async function loadClassifierRetryState\(\)/);
  assert.match(main, /readClassifierRetryState\(classifierActiveJobPath\(\), readJson, readFile\)/);
  assert.doesNotMatch(page, /重跑失败 \/ 待筛任务/);
  assert.match(page, /停止当前任务/);
  assert.match(page, /ClassifierLogEntry/);
  assert.match(page, /const \[logs, setLogs\] = useState<ClassifierLogEntry\[]>\(\[]\)/);
  assert.doesNotMatch(page, /等待任务：开始后将逐行显示/);
  assert.doesNotMatch(page, /role="columnheader"/);
  assert.doesNotMatch(page, />切割状态<\/span>/);
  assert.doesNotMatch(page, />打标状态<\/span>/);
  assert.match(page, />终端输出<\/span>/);
  assert.match(page, /\[\{entry\.time\}\]/);
  assert.match(page, /classifierLogTone\(entry\)/);
  assert.match(page, /body\.scrollTop = body\.scrollHeight/);
  assert.match(page, /classifierLogTime/);
  assert.match(page, /classifier-terminal/);
  assert.match(page, /formatClassifierProgressLogs/);
  assert.match(page, /打标模式：/);
  assert.match(page, /找到 \$\{total\} 个素材文件，本次准备打标/);
  assert.match(page, /开始处理：\$\{fileName\}/);
  assert.match(page, /开始场景检测：\$\{fileName\}/);
  assert.match(page, /检测到 \$\{Math\.max\(0, shotCount - 1\)\} 个场景变化点/);
  assert.match(page, /已分割为 \$\{shotCount\} 个分镜/);
  assert.match(page, /分析分镜 \$\{shotProgress\[1\]\}\/\$\{shotProgress\[2\]\}/);
  assert.match(page, /打标结果：\$\{result\}/);
  assert.match(page, /打标进度：\$\{current\}\/\$\{total\}/);
  assert.match(page, /classifierOnProgress/);
  assert.match(preload, /ipcRenderer\.on\("classifier-progress"/);
  assert.match(main, /setInterval\(\(\) => \{ void streamProgress\(\); \}, 250\)/);
  assert.match(main, /webContents\.send\("classifier-progress"/);
  assert.match(page, /切割中/);
  assert.match(page, /打标中/);
  assert.match(page, /切割完成/);
  assert.match(page, /打标完成/);
  assert.match(styles, /\.classifier-terminal-line\s*\{[^}]*font:\s*10px\/1\.55 var\(--font-geist-mono\), monospace;/);
  assert.match(styles, /\.classifier-terminal-line\.success\s*\{[^}]*background:\s*#e1f0e9;/);
  assert.match(styles, /\.classifier-terminal-line\.error\s*\{[^}]*background:\s*#f9e6e2;/);
  assert.match(page, /classifier-recovery-banner/);
  assert.match(page, /const resumeLastTask/);
  assert.match(page, /继续上次任务/);
  assert.match(page, /只处理尚未完成的素材/);
  assert.match(page, /const splitResults = Array\.isArray\(splitResponse\.result\)/);
  assert.match(page, /classifierPrepareInput\(segmentDirs\)/);
  assert.match(page, /command: "classify", folder: prepared\.folder/);
  assert.match(page, /拆镜头完成：共生成/);
  assert.match(page, /classifierPrepareInput/);
  assert.match(page, /prepareInputPaths/);
  assert.match(page, /dropClassifierInput/);
  assert.match(page, /className="classifier-field"[\s\S]*选择输出目录[\s\S]*打开输出/);
  assert.match(page, /classifier-output-directory-v1/);
  assert.match(page, /localStorage\.getItem\(classifierOutputDirectoryStorageKey\)/);
  assert.match(page, /localStorage\.setItem\(classifierOutputDirectoryStorageKey, validPath\)/);
  assert.match(page, /classifierValidateOutputDirectory/);
  assert.match(page, /输出目录已保存为默认目录/);
  assert.doesNotMatch(page, /配置与文档|当前方案规则|生成修正表|应用修正表|分类自检/);
  assert.match(page, /className="api-settings-action-buttons"[\s\S]*openProductGuide\(\)[\s\S]*产品使用教程/);
  assert.equal((page.match(/openProductGuide\(\)/g) ?? []).length, 1);
  assert.match(page, />上传文件</);
  assert.match(page, />上传文件夹</);
  assert.match(page, /可多选文件，也可拖入整个文件夹/);
  assert.match(page, /sendAssetsToClassifier/);
  assert.match(page, /asset\?\.type === "image" \|\| asset\?\.type === "video"/);
  assert.match(page, /支持图片和视频/);
  assert.match(page, /图片会直接识别，不受此项影响/);
  assert.match(page, /mediaCounts: prepared\.mediaCounts/);
  assert.doesNotMatch(page, /kind: "videos"/);
  assert.match(page, /sendFolderToClassifier/);
  assert.match(page, /openFolderMenu/);
  assert.match(page, /className={`folder-more/);
  assert.match(page, /folder-action-classifier/);
  assert.match(page, /folder-action-reveal/);
  assert.match(page, /folder-action-relink/);
  assert.match(page, /重新关联文件夹/);
  assert.match(page, /只更新媒体库索引和目录层级，不会移动、复制或删除本地文件/);
  assert.match(page, /collection === "失联素材" \|\| isProjectCollection/);
  assert.match(page, /folder\.available !== false/);
  assert.match(page, /folder-action-project/);
  assert.match(page, /folder-action-delete/);
  assert.match(page, /删除文件夹及本地文件夹/);
  assert.match(page, /仅删除文件夹，保留本地文件夹/);
  assert.match(page, /仅删除文件夹内的素材/);
  assert.match(page, /图片、视频和音频记录/);
  assert.match(page, /查看原文件夹位置/);
  assert.match(page, /moveFolderToCollection/);
  assert.doesNotMatch(page, /folder-send-workbench/);
  assert.match(page, /syncClassifierOutput/);
  assert.match(page, /extractClassifierOutputFiles/);
  assert.match(page, /mediaImportPaths\(exactOutputFiles\)/);
  assert.match(page, /mediaImportClassifierOutput\(outputPath, exactOutputFiles\)/);
  assert.match(page, /installFolderSources\(grouped\.folders\)/);
  assert.match(page, /A zero-result response is authoritative:[\s\S]*return grouped\.records\.length;[\s\S]*const imported = await bridge\.mediaImportPaths\(exactOutputFiles\)/);
  assert.match(page, /本次没有可入库的正式素材；分析用帧快照已自动排除/);
  assert.match(page, /folder\.indexMode !== "exact"/);
  assert.match(page, /folder\.parentPath \?\? null/);
  assert.match(page, /folderTreePaths\(folders, folder\.path\)/);
  assert.match(preload, /mediaImportClassifierOutput/);
  assert.match(preload, /mediaImportClassifierSegments/);
  assert.match(preload, /mediaRelinkFolder/);
  assert.match(preload, /classifierValidateOutputDirectory/);
  assert.match(main, /media-import-classifier-output/);
  assert.match(main, /media-import-classifier-segments/);
  assert.match(main, /media-relink-folder/);
  assert.match(main, /classifier-validate-output-directory/);
  assert.match(main, /classifierSegmentsDirectoryInfo\(segmentDirectory\)/);
  assert.match(main, /classifierSegmentsDirectoryInfo\(resolvedDirectory\)/);
  assert.match(main, /parentPath: resolvedRoot, indexMode: "exact"/);
  assert.match(main, /folder\.indexMode === "exact"/);
  assert.match(main, /detectClassifierCategoryFolder/);
  assert.match(main, /asset\.sourceKind === "file" \|\| asset\.sourceKind === "folder"/);
  assert.match(main, /candidateFolders\.set\(mediaPathKey\(folder\.path\)/);
  assert.match(page, /return \[\.\.\.imported, \.\.\.existing\.filter/);
  assert.match(page, /未读取到本次生成文件清单，已取消自动入库，不会连接或扫描总输出目录/);
  assert.match(page, /onCompleted\(syncRoot, \[\], true\)/);
  assert.match(page, /mediaImportClassifierSegments\(outputPath\)/);
  assert.match(page, /allowGeneratedFolderScan/);
  assert.doesNotMatch(page, /mediaScanFolder\(outputPath\)/);
  assert.match(main, /resolvedResult = \{ \.\.\.result, jobId, logs, outputFiles, outputMappings, consumedSourceFiles, diagnostic \}/);
  assert.match(main, /stageClassifierPhysicalSource\(sourcePath, inputRoot/);
  assert.match(main, /isClassifierHandoffInput\(payload\.folder/);
  assert.doesNotMatch(main, /await symlink\(/);
  assert.match(main, /applyClassifierNamingRule\(root, result, logs, payload\.naming\)/);
  assert.match(main, /uniqueClassifierOutputPath/);
  assert.match(main, /buildClassifierFilenameParts/);
  assert.match(main, /命名规则应用失败，已保留引擎原始输出/);
  assert.match(page, /classifierNamingFields/);
  assert.match(page, /parseClassifierNamingRule/);
  assert.match(page, /serializeClassifierNamingRule/);
  assert.match(page, /previewClassifierNamingRule/);
  assert.match(page, /aria-label="命名规则编辑器"/);
  assert.match(page, /固定文字/);
  assert.match(page, /firstClassifierSubcategoryFromText/);
  assert.match(page, /具体画面由素材识别生成/);
  assert.doesNotMatch(page, /磁吸支架展开/);
  assert.match(page, /文件名预览/);
  assert.match(page, /GripVertical/);
  assert.match(page, /draggable/);
  assert.match(page, /startLogSession/);
  assert.match(page, /打标模式：已加载/);
  assert.match(page, /找到 \$\{detectedCount\} 个素材文件，准备处理/);
  assert.match(page, /开始素材识别与打标/);
  assert.match(page, /切割模式：已加载\$\{runSplitPrecision === "rough" \? "粗略" : "精细"\}切割规则/);
  assert.match(page, /开始场景检测/);
  assert.match(page, /组合模式：先按\$\{splitPrecision === "rough" \? "粗略" : "精细"\}切割视频镜头/);
  assert.match(page, /进行素材打标和命名/);
  assert.match(page, /const resultItems = Array\.isArray\(response\.result\)/);
  assert.match(page, /resultItems\.map\(\(item\) => item\?\.output_dir\)/);
  assert.match(page, /未自动扫描总输出目录/);
  assert.doesNotMatch(page, /result\.classification_root \|\| runOutputRoot \|\| runFolder/);
  assert.doesNotMatch(page, /renameResult\.classification_root \|\| outputRoot/);
  assert.match(page, /发送到素材工作台/);
  assert.match(page, /处理完成后会自动同步回媒体库/);
  assert.match(page, /onCompleted\(syncRoot, \[\], true\)/);
  assert.match(page, /const allFailed/);
  assert.match(page, /均未生成结果/);
  assert.match(page, /来自媒体库/);
  assert.doesNotMatch(page, /智能打标|SmartTagging|批量生成|创意画布|视频压缩|图片切分/);
  assert.match(page, /activeModule === "prompt-library"/);
  assert.match(page, /const onImport/);
  assert.match(page, /const openAssetPreview/);
  assert.match(page, /const revealAssetInFolder/);
  assert.match(page, /data-testid="asset-action-reveal"/);
  assert.match(page, /在访达\/文件夹中打开/);
  assert.match(preload, /mediaRevealFile: \(targetPath\) => ipcRenderer\.invoke\("media-reveal-file", targetPath\)/);
  assert.match(main, /registerProtectedHandle\("media-reveal-file"/);
  assert.match(main, /shell\.showItemInFolder\(resolvedPath\)/);
  assert.match(preload, /mediaTrashFolder: \(folderPath\) => ipcRenderer\.invoke\("media-trash-folder", folderPath\)/);
  assert.match(main, /registerProtectedHandle\("media-trash-folder"/);
  assert.match(main, /shell\.trashItem\(resolvedPath\)/);
  assert.match(main, /只能删除媒体库中已登记的文件夹/);
  assert.match(page, /className="preview-dialog"/);
  assert.match(page, /src=\{previewAsset\.src\} controls autoPlay playsInline/);
  assert.doesNotMatch(page, /window\.open\(asset\.src/);
  assert.match(page, /<Upload size=\{14\} \/>上传文件/);
  assert.match(page, /<FolderOpen size=\{14\} \/>上传文件夹/);
  assert.match(page, /fileInput\.current\?\.click\(\)/);
  assert.match(page, /const uploadLocalFolder/);
  assert.match(page, /const uploadLocalFiles/);
  assert.match(page, /const refreshLocalLibrary/);
  assert.match(page, /const handleMediaDrop/);
  assert.match(page, /const startNativeMediaDrag/);
  assert.match(page, /selectedAssetIds/);
  assert.match(page, /selectAssetFromPointer/);
  assert.match(page, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(page, /event\.shiftKey/);
  assert.match(page, /event\.key\.toLowerCase\(\) === "a"/);
  assert.match(page, /event\.key === "Escape"/);
  assert.match(page, /toggleSelectAllVisible/);
  assert.match(page, /批量添加标签/);
  assert.match(page, /批量加入项目/);
  assert.match(page, /移入回收站/);
  assert.match(page, /setClassifierPreparing\(true\)/);
  assert.match(page, /setClassifierHandoff\(null\)/);
  assert.match(page, /setActiveModule\("classifier"\)/);
  assert.match(page, /appliedHandoffId\.current === handoff\.id/);
  assert.match(page, /setFolder\(handoff\.folder\)/);
  assert.match(page, /setInputLabel\(handoff\.label\)/);
  assert.match(page, /const \[inputPaths, setInputPaths\]/);
  assert.match(page, /const combinedPaths = \[\.\.\.new Set\(\[\.\.\.inputPaths, \.\.\.usablePaths\]\)\]/);
  assert.match(page, /classifierPrepareInput\(combinedPaths\)/);
  assert.match(page, /setInputPaths\(combinedPaths\)/);
  assert.match(page, /const clearClassifierInput/);
  assert.match(page, /清空素材<\/button>/);
  assert.match(page, /继续上传或拖入会追加素材，不会替换当前列表/);
  assert.match(page, /paths: usablePaths/);
  assert.match(page, /paths: \[folderSource\.path\]/);
  assert.match(page, /正在准备素材并打开分类工作台/);
  assert.match(page, /classifierPreparing \? "正在发送…"/);
  assert.doesNotMatch(page, /setTask\(/);
  const sendToClassifierFlow = page.slice(page.indexOf("const sendAssetsToClassifier"), page.indexOf("const sendFolderToClassifier"));
  assert.ok(sendToClassifierFlow.indexOf('setActiveModule("classifier")') < sendToClassifierFlow.indexOf("await window.desktopBridge.classifierPrepareInput"));
  assert.match(page, /Shift 连选/);
  assert.match(page, /拖动空白处框选/);
  assert.match(page, /toggleMarqueeSelection\(active\.baseIds, hitIds\)/);
  assert.match(page, /框内已选取消、未选勾选/);
  assert.match(page, /const selectAssetCardFromPointer/);
  assert.match(page, /const beginAssetMarquee/);
  assert.match(page, /className=\{`asset-section[^\n]+onMouseDown=\{beginAssetMarquee\}/);
  assert.match(page, /className=\{`asset-grid \$\{view\}`\} ref=\{assetGridRef\}/);
  assert.match(page, /data-asset-id=\{asset\.id\}/);
  assert.match(page, /onDoubleClick=\{\(\) => openAssetPreview\(asset\)\}/);
  assert.match(page, /单击选择，双击预览/);
  assert.match(page, /className="asset-marquee-rect"/);
  assert.match(styles, /\.asset-marquee-rect/);
  assert.match(styles, /\.media-marquee-active/);
  assert.match(page, /mediaStartDrag\(usablePaths\)/);
  assert.match(page, /draggable=\{folderDragPaths\.length > 0\}/);
  assert.match(page, /draggable=\{Boolean\(asset\.localPath/);
  assert.match(page, /const openFolderSource/);
  assert.match(page, /const isProjectCollection = collections\.includes\(collection\)/);
  assert.match(page, /folderNavigationEnabled = \(collection === "全部素材" \|\| collection === "失联素材" \|\| isProjectCollection\)/);
  assert.match(page, /asset\.collection === collection && asset\.sourceRoot/);
  assert.match(page, /if \(!collections\.includes\(collection\)\) setCollection\("全部素材"\)/);
  assert.match(page, /isProjectCollection \? `\$\{collectionLabelFor\(collection\)\} · 文件夹视图`/);
  assert.match(page, /onDoubleClick=\{\(event\) => \{ event\.preventDefault\(\); beginCollectionRename\(item\); \}\}/);
  assert.match(page, /collectionRenameTarget === item \? <div className="tree-item nested project-tree-editor">/);
  assert.match(page, /className="project-tree-edit-input"[\s\S]*onBlur=\{saveCollectionRename\}/);
  assert.match(page, /event\.key === "Enter"[\s\S]*event\.currentTarget\.blur\(\)/);
  assert.match(page, /event\.key === "Escape"[\s\S]*setCollectionRenameTarget\(null\)/);
  assert.match(page, /aria-label=\{`删除项目：\$\{collectionLabelFor\(item\)\}`\}/);
  assert.doesNotMatch(page, /id="collection-rename-title"/);
  assert.match(page, /素材仍保留在“全部素材”/);
  assert.match(page, /collectionAliases/);
  assert.match(page, /hiddenCollections/);
  assert.match(styles, /\.project-tree-row:hover \.project-tree-delete/);
  assert.match(styles, /\.project-tree-edit-input\s*\{[^}]*flex:\s*1;[^}]*border:\s*1px solid #55bdb4;/);
  assert.match(page, /className=\{`asset-card folder-card/);
  assert.match(page, /双击打开/);
  assert.match(page, /className="media-drop-overlay"/);
  assert.match(page, /松开即可导入/);
  assert.match(page, /aria-label="刷新本地媒体库"/);
  assert.match(page, /刷新完成：/);
  assert.match(page, /installDesktopAssets/);
  assert.match(page, /defaultProjectCollections = \["视频下载", "素材分类", QIANCHUAN_PROJECT_COLLECTION, VIRAL_FRAME_COLLECTION, SUBTITLE_RESULT_COLLECTION\]/);
  assert.match(page, /installDesktopAssets\(grouped\.records, "folder", "素材分类"\)/);
  assert.match(page, /installDesktopAssets\(records, sourceKind, "视频下载"\)/);
  assert.match(page, /normalizeProjectCollections\(data\.collections\)/);
  assert.doesNotMatch(page, /const \[collections, setCollections\] = useState\(\["示例项目"/);
  assert.match(page, /mediaLoadLibrary/);
  assert.match(page, /mediaSaveLibrary/);
  assert.match(page, /asset\.sourceKind !== "demo"/);
  assert.match(page, /folderInput\.current\?\.click\(\)/);
  assert.match(page, /webkitdirectory/);
  assert.match(page, /file\.webkitRelativePath \|\| file\.name/);
  assert.match(page, /const backupDatabase/);
  assert.match(page, /const restoreDatabase/);
  assert.match(page, /数据管理/);
  assert.match(page, /const softDelete/);
  assert.match(page, /const restoreAsset/);
  assert.match(page, /const repairAsset/);
  assert.match(page, /setSortBy/);
  assert.match(page, /media-library-preferences-v1/);
  assert.match(page, /scanConnectedDirectory/);
  assert.doesNotMatch(page, /AI 智搜|智能检索引擎|入库自动向量化|模型升级后强制全库重建/);
  assert.doesNotMatch(page, /buildVisualIndex|embedText|embedVisual/);
  assert.match(page, /classifyViralVisualLocally, localClipModel/);
  assert.match(page, /createPortal/);
  assert.match(page, /openAssetMenu/);
  assert.match(page, /asset-action-favorite/);
  assert.match(page, /asset-action-tag/);
  assert.match(page, /asset-action-move/);
  assert.match(page, /className="asset-submenu"/);
  assert.match(page, /全部标签/);
  assert.match(page, /全部项目/);
  assert.match(page, /asset\.tags\.includes\(tagName\)\)\.length/);
  assert.match(page, /asset\.collection === item\)\.length/);
  assert.match(page, /collections\.includes\(asset\.collection\)/);
  assert.doesNotMatch(page, /添加“精选”标签/);
  assert.doesNotMatch(page, /移至灵感收藏/);
  assert.match(page, /asset-action-delete/);
  assert.match(page, /asset-action-restore/);
  assert.doesNotMatch(page, /document\.addEventListener\("pointerdown"/);
});

test("separates the Qianchuan video library from the curated viral frame library", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../electron/preload.cjs", import.meta.url), "utf8");
  const service = await readFile(new URL("../electron/qianchuan-service.mjs", import.meta.url), "utf8");

  assert.match(page, />千川视频库</);
  assert.match(page, />爆款画面库</);
  assert.match(page, />爆款文案库</);
  assert.match(page, /feature\.group === "vip" \? "viral-nav" : ""/);
  assert.match(page, /feature\.group === "vip" && <small>\{!accessible && <LockKeyhole size=\{9\} \/>\}VIP<\/small>/);
  assert.match(page, /const activeModule = canDiscoverFeature\(featureRegistry, requestedModule, licenseState\)/);
  assert.match(page, /featureRegistry\.list\(\)\.filter\(\(feature\) => canDiscoverFeature/);
  assert.match(page, /const lockedVipFeature = requestedFeature\?\.group === "vip"/);
  assert.match(page, /lockedVipFeature \? \([\s\S]*<VipFeatureLockedPage/);
  assert.match(page, /当前基础授权暂未包含此功能/);
  assert.match(page, /前往兑换VIP时间码/);
  assert.match(page, /这里只展示功能介绍和示意轮廓，不会加载专属内容或执行VIP操作/);
  assert.match(page, /vip-feature-locked-backdrop/);
  assert.match(page, /feature\.id === "viral-copy" \? "copy" : "visual"/);
  assert.match(page, /vip-lock-visual-preview/);
  assert.match(page, /vip-lock-copy-preview/);
  assert.match(styles, /\.vip-feature-locked-backdrop \{[^}]*filter: blur\(2\.2px\)/);
  assert.match(styles, /\.vip-feature-locked-veil/);
  assert.match(page, /!accessible && <LockKeyhole size=\{9\} \/>/);
  assert.match(page, /onContextMenu=\{\(event\) => openAssetContextMenu/);
  assert.match(page, />绑定千川数据</);
  assert.match(page, />查看千川数据</);
  assert.match(page, /qianchuanImport/);
  assert.match(page, /素材范围/);
  assert.match(page, /最近 100 条/);
  assert.match(page, /素材创建日期/);
  assert.match(page, /数据统计周期/);
  assert.match(page, /上次同步/);
  assert.match(page, /className="viral-card-grid"/);
  assert.match(page, /className="viral-frame-delete danger icon-only"/);
  assert.match(styles, /\.viral-frame-info \.viral-frame-delete \{ position: absolute; top: 8px; right: 9px;/);
  assert.match(page, /const localVideoUrl = linkedAsset\?\.type === "video" \? linkedAsset\.src : ""/);
  assert.match(page, /<video src=\{localVideoUrl\} poster=\{poster \|\| undefined\} muted playsInline preload="metadata"/);
  assert.match(page, /千川素材筛选/);
  assert.match(page, /综合表现/);
  assert.match(page, /className="viral-detail-drawer"/);
  assert.match(page, /播放预览/);
  assert.match(page, />在媒体库中查看</);
  assert.match(page, /qianchuanPreview/);
  assert.match(page, /qianchuanLibraryCache/);
  assert.match(page, /qianchuanLibrarySync/);
  assert.match(page, /QIANCHUAN_PROJECT_COLLECTION = "千川素材"/);
  assert.match(page, /LEGACY_QIANCHUAN_PROJECT_COLLECTION = "千川导入"/);
  assert.match(page, /function QianchuanVideoLibrary/);
  assert.match(page, /function ViralVisualLibrary/);
  assert.match(page, /onPreview=\{openAssetPreview\}/);
  assert.match(page, /aria-label=\{`播放预览：\$\{asset\.name\}`\}/);
  assert.match(page, /event\.stopPropagation\(\); onPreview\(asset\);/);
  assert.match(page, /data-tooltip=\{iconHelp \|\| undefined\}/);
  assert.match(page, /title=\{iconHelp \|\| undefined\}/);
  assert.match(page, /爆款画面库：管理图片、视频及关联数据/);
  assert.match(page, /爆款文案库：管理文案、分类及画面关联/);
  assert.doesNotMatch(page, /className="viral-frame-select"[^\n]*<span>选择<\/span>/);
  assert.doesNotMatch(page, /<Play size=\{12\} \/>播放/);
  assert.match(page, /aria-label=\{`在媒体库中查看：\$\{asset\.name\}`\}/);
  assert.match(page, /aria-label=\{`删除画面：\$\{asset\.name\}`\}/);
  assert.match(styles, /\.viral-frame-actions \.icon-only\s*\{[^}]*width:\s*28px;[^}]*justify-content:\s*center;/);
  assert.match(page, /aria-label="画面筛选和排序"/);
  assert.match(page, /大分类[\s\S]*全部大分类[\s\S]*画面类型[\s\S]*全部画面类型/);
  assert.match(page, /aria-label="文案大分类"[\s\S]*全部大分类/);
  assert.match(page, /aria-label="文案细分类"[\s\S]*全部细分类/);
  assert.match(page, /function viralCopyCategoryContext/);
  assert.match(page, /hasLegacyCategoryMixup \? visualMajorCategory/);
  assert.match(page, /field\.key === "majorCategory"[\s\S]*category: current\.category\.filter\(\(item\) => item !== column\)/);
  assert.match(page, /已用作大分类的列不能重复勾选/);
  assert.match(page, /大分类[\s\S]*画面类型[\s\S]*数据状态[\s\S]*已关联数据[\s\S]*CSV 数据[\s\S]*千川数据[\s\S]*无关联数据/);
  assert.match(page, /visualTypeOptions\.map\(\(visualType\) => <option value=\{visualType\}/);
  assert.match(page, /!viralVisualTypesForAsset\(asset\)\.includes\(visualTypeFilter\)/);
  assert.doesNotMatch(page, /<option value="video">视频<\/option><option value="image">图片<\/option>/);
  assert.match(page, /排序[\s\S]*最近修改[\s\S]*最早修改[\s\S]*名称 A–Z[\s\S]*名称 Z–A/);
  assert.match(page, /dataFilter === "none" && \(hasCsvData \|\| hasQianchuanData\)/);
  assert.match(page, /sortMode === "name-asc"/);
  assert.match(styles, /\.viral-frame-filterbar/);
  assert.match(styles, /\.viral-category-section \.viral-frame-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill, minmax\(220px, 1fr\)\);[^}]*grid-auto-flow:\s*row;[^}]*overflow:\s*visible;/);
  assert.match(styles, /\.viral-category-section \.viral-frame-card\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/);
  assert.doesNotMatch(styles, /\.viral-category-section \.viral-frame-grid[^\{]*\{[^}]*overflow-x:\s*auto/);
  assert.match(styles, /\.viral-category-section \.copy-card-list\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill, minmax\(300px, 1fr\)\);[^}]*grid-auto-flow:\s*row;[^}]*overflow:\s*visible;/);
  assert.doesNotMatch(styles, /\.viral-category-section \.copy-card-list[^\{]*\{[^}]*overflow-x:\s*auto/);
  assert.match(page, /function ViralCategorySelect/);
  assert.match(page, /aria-label=\{`全选大分类：\$\{name\}`\}/);
  assert.match(page, /onToggle=\{\(\) => toggleFrameGroup\(groupIds\)\}/);
  assert.match(page, /onToggle=\{\(\) => toggleCopyGroup\(groupTargets\)\}/);
  assert.match(styles, /\.viral-category-select input\s*\{[^}]*accent-color:\s*#2d9f96;/);
  assert.match(page, /className="copy-card-quick-actions"/);
  assert.match(page, /aria-label="复制文案"/);
  assert.match(page, /className="copy-card-editable-text"/);
  assert.match(page, /title=\{segment \? "双击编辑文案" : "双击补录文案"\}/);
  assert.match(page, /onDoubleClick=\{\(event\) => \{ event\.stopPropagation\(\); beginInlineEdit\(\); \}\}/);
  assert.match(page, /className="copy-card-editable-text editing" contentEditable=\{!inlineSaving\}/);
  assert.match(page, /onInput=\{\(event\) => \{ inlineDraftRef\.current = event\.currentTarget\.innerText \|\| ""; \}\}/);
  assert.match(page, /nextFocus\?\.closest\("\[data-inline-cancel\]"\)/);
  assert.match(page, /点击其他位置自动保存/);
  assert.match(page, /data-inline-cancel/);
  assert.doesNotMatch(page, /inlineSaving \? "保存中…" : "保存"/);
  assert.match(page, /viralCopyUpdateText\(target, text\)/);
  assert.match(styles, /\.copy-card \.copy-card-editable-text:hover\s*\{/);
  assert.match(styles, /\.copy-card \.copy-card-editable-text\.editing\s*\{/);
  assert.doesNotMatch(styles, /\.copy-card-inline-editor textarea\s*\{/);
  assert.match(preload, /viralCopyUpdateText:\s*\(target, text\) => ipcRenderer\.invoke\("viral-copy-update-text", target, text\)/);
  assert.match(main, /registerProtectedHandle\("viral-copy-update-text"/);
  assert.match(page, /aria-label=\{visualAsset \? "更换画面" : "关联画面"\}/);
  assert.match(page, /aria-label=\{segment \? "编辑文案" : "提取或补录文案"\}/);
  assert.match(page, /aria-label="删除文案"/);
  assert.match(page, /aria-label=\{`已链接画面：\$\{visualAsset\.name\}，点击预览`\}/);
  assert.match(page, /onClick=\{\(\) => onPreview\(visualAsset\)\}/);
  assert.match(page, /<span>已链接<\/span><span className="copy-card-hover-preview"/);
  assert.doesNotMatch(page, /\{`关联画面：\$\{visualAsset\.name\}`\}/);
  assert.match(page, /<ViralCopyLibrary[^>]*onPreview=\{openAssetPreview\}/);
  assert.doesNotMatch(page, /<ViralCopyLibrary[^>]*onLocate=/);
  assert.match(styles, /\.copy-card button\.copy-card-visual\s*\{[^}]*cursor:\s*pointer;/);
  assert.match(styles, /\.copy-card button\.copy-card-visual\s*\{[^}]*font-size:\s*9px;/);
  assert.match(styles, /\.copy-card-hover-preview img, \.copy-card-hover-preview video\s*\{[^}]*width:\s*auto;[^}]*height:\s*auto;[^}]*max-width:\s*min\(720px, 82vw\);[^}]*max-height:\s*min\(620px, 70vh\);/);
  assert.match(styles, /\.copy-card-visual > \.copy-card-hover-preview\s*\{[^}]*position:\s*fixed;[^}]*top:\s*50%;[^}]*left:\s*50%;/);
  assert.match(page, /\(classifications \|\| copyClassifications\(segment\)\)\.map\(\(item\) => <span className="copy-category"[^>]*>\{item\.value\}<\/span>\)/);
  assert.doesNotMatch(page, /\$\{item\.field\}：\$\{item\.value\}/);
  assert.match(page, /function copyCardUploadedData/);
  assert.match(page, /className="copy-card-meta-row"/);
  assert.match(page, /className="copy-card-data-summary" aria-label="上传数据摘要"/);
  assert.match(page, /asset\?\.csvData\?\.fields/);
  assert.match(styles, /\.copy-card-data-summary\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
  assert.doesNotMatch(page, />播放片段</);
  assert.doesNotMatch(page, /上传时间：\{record\.created_at/);
  assert.match(page, /画面库与文案库独立计数/);
  assert.match(page, /独立上传的文案不需要关联画面/);
  assert.match(page, /className="viral-frame-guidance"[\s\S]*className="viral-guidance-actions"/);
  assert.match(page, /className="copy-guidance"[\s\S]*className="viral-guidance-actions"/);
  assert.match(page, /CSV 字段对应/);
  assert.match(page, /打开画面后显示的字段/);
  assert.match(page, /恢复推荐 4 项/);
  assert.match(page, /文案卡片显示的数据字段/);
  assert.match(page, /外显数据默认推荐 4 项并可手动增减/);
  assert.match(page, /function visualCardUploadedData/);
  assert.match(page, /className="viral-frame-data-summary" aria-label="画面数据摘要"/);
  assert.match(styles, /\.viral-frame-data-summary\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(page, /function csvDataFieldPresentation/);
  assert.match(page, /function csvDataDialogLayout/);
  assert.match(page, /const csvDataLayout = csvDataDialogLayout\(csvDataFields\)/);
  assert.match(page, /className=\{`viral-csv-data-field \$\{presentation\.wide \? "wide" : ""\} \$\{presentation\.long \? "long" : ""\}`\}/);
  assert.match(page, /\{csvDataFields\.length\} 个字段/);
  assert.match(styles, /\.viral-csv-data-dialog\.wide\s*\{[^}]*width:\s*min\(1040px,/);
  assert.match(styles, /\.viral-csv-data-field\.wide\s*\{[^}]*grid-column:\s*1 \/ -1;/);
  assert.match(styles, /\.viral-csv-data-field\.long dd\s*\{[^}]*overflow:\s*auto;/);
  assert.match(page, /删除文案数据字段：/);
  assert.match(page, /data_fields: row\.dataFields/);
  assert.match(page, /删除展示字段：/);
  assert.match(page, /同步文案到爆款文案库/);
  assert.match(page, /DEFAULT_VIRAL_VISUAL_TYPES = \["痛点展示", "使用演示", "效果对比", "产品特写", "场景应用", "价格促单钩子", "证言共鸣", "人工标注"\]/);
  assert.match(page, />画面类型列<select/);
  assert.match(page, /没有此列，自动识别默认分类/);
  assert.match(page, /本地识别（默认）/);
  assert.match(page, /API 识别（更准）/);
  assert.match(page, /classifyViralVisualLocally/);
  assert.match(page, /viralLibraryClassifyVisuals/);
  assert.match(page, /visualTypeColumn: viralDataCsvVisualTypeColumn/);
  assert.match(page, /tags: \[\.\.\.new Set\(\[\.\.\.asset\.tags, \.\.\.visualTypes\]\)\]/);
  assert.match(page, /visualTypes,/);
  assert.match(styles, /\.viral-visual-recognition-options label\.selected/);
  assert.match(page, /使用 CSV 已有文案字段/);
  assert.match(page, /本机生成文案/);
  assert.match(page, /displayColumns: viralUploadSyncData \? viralDataCsvDisplayColumns : \[\]/);
  assert.match(page, /copyColumn: viralUploadSyncCopy && viralUploadCopySource === "csv" \? viralUploadCopyColumn : -1/);
  assert.match(page, /“画面路径”和“文案”至少选一项/);
  assert.match(page, /viralCsvMappingFields/);
  assert.match(page, /也可按实际表头自选对应字段/);
  assert.match(page, /Error invoking remote method/);
  assert.match(page, /records\.flatMap\(\(record\) => linkedKeys\.has\(record\.key\) \? \[\] : record\.segments/);
  assert.doesNotMatch(page, /const dataOnly = Object\.entries\(performance\)/);
  assert.match(page, /recordByKey\.has\(key\)/);
  assert.match(page, /VIRAL_FRAME_COLLECTION = "爆款画面"/);
  assert.match(page, /const selectCollection = \(nextCollection: string\) => \{[\s\S]*?setCollection\(nextCollection\);[\s\S]*?setQuery\(""\);[\s\S]*?setActiveFolderPath\(null\);/);
  assert.match(page, /asset\.type === "image"/);
  assert.match(page, /function QianchuanIntegrationPanel/);
  assert.match(page, />千川接入</);
  assert.match(page, /配置应用[\s\S]*设置回调[\s\S]*测试配置/);
  assert.match(page, /showAuthorizationAssist/);
  assert.match(page, /首次连接千川账户/);
  assert.match(page, /补充敏感物料权限/);
  assert.match(page, /authorizationHealthError/);
  assert.match(page, /重新授权千川账户/);
  assert.match(page, /APP ID、APP Secret 和回调地址都不需修改/);
  assert.match(styles, /\.qianchuan-oauth-state\.expired/);
  assert.match(page, /系统默认浏览器[\s\S]*软件内置浏览器/);
  assert.match(page, /https:\/\/api\.dadaozixun\.com\/qianchuan\/callback/);
  assert.match(page, /qianchuanConfigSave\(\{ app_id: appId\.trim\(\), app_secret: appSecret\.trim\(\) \}\)/);
  assert.doesNotMatch(page, /localStorage[\s\S]{0,120}(?:appSecret|APP Secret)/);
  assert.match(page, /installDesktopAssets\(\[result\.record\], "file", QIANCHUAN_PROJECT_COLLECTION\)/);
  assert.match(page, /collection: normalizeAssetCollection\(asset\.collection\)/);
  assert.match(page, /qianchuan:\s*previous\?\.qianchuan/);
  assert.match(styles, /\.viral-library-page/);
  assert.match(styles, /\.viral-card-grid/);
  assert.match(styles, /\.viral-detail-drawer/);
  assert.match(styles, /\.qianchuan-dialog/);
  assert.match(main, /registerProtectedHandle\("qianchuan-import"/);
  assert.match(main, /registerProtectedHandle\("qianchuan-config-save"/);
  assert.match(main, /registerProtectedHandle\("qianchuan-oauth-start"/);
  assert.match(main, /registerProtectedHandle\("qianchuan-oauth-reopen"/);
  assert.match(main, /registerProtectedHandle\("qianchuan-library-cache"/);
  assert.match(main, /registerProtectedHandle\("qianchuan-library-sync"/);
  assert.match(main, /registerProtectedHandle\("qianchuan-library-cancel"/);
  assert.match(main, /registerProtectedHandle\("qianchuan-preview"/);
  assert.match(main, /serveQianchuanPreview/);
  assert.match(main, /qianchuanInternals\.assertSafeDownloadUrl\(upstream\.url \|\| entry\.url\)/);
  assert.match(main, /assertSafeAuthorizationUrl\(result\.auth_url\)/);
  assert.match(main, /session\.fromPartition\("persist:qianchuan-oauth"/);
  assert.match(main, /nodeIntegration: false,[\s\S]{0,180}contextIsolation: true,[\s\S]{0,180}sandbox: true/);
  assert.match(main, /normalizeQianchuanBrowserMode\(browserMode\)/);
  assert.match(main, /if \(mode === "system"\) await shell\.openExternal\(safeUrl\.href\)/);
  assert.match(main, /else await openQianchuanOauthWindow\(safeUrl\.href\)/);
  assert.match(main, /else await openQianchuanDeveloperPortalWindow\(\)/);
  assert.match(preload, /qianchuanBootstrap/);
  assert.match(preload, /qianchuanConfigStatus/);
  assert.match(preload, /qianchuanOAuthPoll/);
  assert.match(preload, /qianchuanOAuthReopen/);
  assert.match(page, /打开开发者后台/);
  assert.match(page, /重新打开授权页面/);
  assert.match(page, /qianchuanOAuthReopen\(flowId, browserMode\)/);
  assert.match(page, /与基础数据在同一次同步任务中采集并缓存/);
  assert.match(page, /扩展数据同步中/);
  assert.match(page, /扩展分析 \$\{cachedInsightCount\}\/\$\{items\.length\}/);
  assert.match(page, /qianchuan-insight-skeleton/);
  assert.match(page, /扩展分析数据同步失败/);
  assert.match(service, /QIANCHUAN_INSIGHT_SYNC_CONCURRENCY = 3/);
  assert.match(service, /stage: "insights"/);
  assert.match(service, /insights_by_material/);
  assert.match(styles, /\.qianchuan-insight-skeleton/);
  assert.match(preload, /qianchuanLibraryOnProgress/);
  assert.match(preload, /qianchuanPreview/);
  assert.match(service, /api\/v1\/qianchuan\/session\/exchange/);
  assert.match(service, /viral-library-cache\.v1\.json/);
  assert.match(service, /QIANCHUAN_LIBRARY_DATE_SCAN_PAGES/);
  assert.match(service, /hostname\.toLowerCase\(\) !== QIANCHUAN_AUTH_HOST/);
  assert.doesNotMatch(page, /device_session|device_credential|deviceSession|deviceCredential/);
});

test("keeps the voice library in an atomic recoverable user-data store", async () => {
  const backend = await readFile(new URL("../electron/voice-backend/server.mjs", import.meta.url), "utf8");

  assert.match(backend, /const voicesPath = join\(dataDir, "voices\.json"\)/);
  assert.match(backend, /const voicesBackupPath = join\(dataDir, "voices\.backup\.json"\)/);
  assert.match(backend, /await copyFile\(voicesPath, voicesBackupPath\)/);
  assert.match(backend, /await rename\(tempPath, voicesPath\)/);
  assert.match(backend, /await restoreVoiceStorePrimary\(backup\)/);
  assert.match(backend, /voiceStoreMutationQueue = operation\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(backend, /async function readVoiceStore\(\) \{[\s\S]{0,500}catch \{\s*return \{ voices: \[\] \};/);
});

test("lets the voice clone workspace expand and scale gently on large displays", async () => {
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(styles, /\.voice-content \{ width: 100%; max-width: none;/);
  assert.doesNotMatch(styles, /\.voice-content \{[^}]*max-width: 1380px/);
  assert.match(styles, /--voice-body-size: clamp\(/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) clamp\(340px, 28vw, 520px\)/);
  assert.match(styles, /\.voice-workbench \.voice-workbench-head h1 \{\s*font-size: clamp\(/);
  assert.match(styles, /@media \(min-width: 1800px\) \{\s*\.voice-grid \{ grid-template-columns: repeat\(4/);
});

test("keeps local folder storage while removing the AI smart-search surface", async () => {
  const localMedia = await readFile(new URL("../app/local-media.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(localMedia, /showDirectoryPicker/);
  assert.match(localMedia, /scanLibraryDirectory/);
  assert.match(page, /placeholder="搜索素材名称、描述、标签\.\.\."/);
  assert.match(page, /aria-label="数据管理"/);
  assert.doesNotMatch(page, /AI 智搜|CLIP ViT|补建缺失向量|语义匹配精度/);
});

test("keeps backup and restore available in the compact data-management panel", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /data-management-panel/);
  assert.match(page, />备份数据库</);
  assert.match(page, />还原数据库</);
  assert.match(page, /备份不包含原始素材文件/);
});

test("packages a self-contained desktop app with a stable loopback origin", async () => {
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const voiceBackend = await readFile(new URL("../electron/voice-backend/server.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../electron/preload.cjs", import.meta.url), "utf8");
  const nextConfig = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.dependencies.officeparser, "7.5.1");
  assert.ok(packageJson.build.files.includes("electron/**/*"));

  assert.match(main, /const LOCAL_HOST = "127\.0\.0\.1"/);
  assert.match(main, /const LOCAL_PORT = runtimePreviewPort\("AI_MEDIA_LIBRARY_LOCAL_PORT", 43822\)/);
  assert.match(main, /const VOICE_PORT = runtimePreviewPort\("AI_MEDIA_LIBRARY_VOICE_PORT", 43824\)/);
  assert.match(main, /startVoiceServer/);
  assert.match(main, /proxyVoiceRequest/);
  assert.match(main, /voice-backend/);
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /createServer/);
  assert.match(main, /createContactService/);
  assert.match(main, /requestUrl\.pathname === "\/api\/contact"/);
  assert.match(main, /contactService\.getContactConfig\(\)/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /registerProtectedHandle\("classifier-run"/);
  assert.match(main, /classifier-handoffs/);
  assert.match(main, /classifier-jobs/);
  assert.match(main, /active-job\.json/);
  assert.match(main, /async function saveClassifierJobState/);
  assert.match(main, /async function loadClassifierRecovery/);
  assert.match(main, /status: "running"/);
  assert.match(main, /resultReadFailed \|\| launchError/);
  assert.match(main, /: "failed"/);
  assert.match(main, /registerProtectedHandle\("media-choose-files"/);
  assert.match(main, /registerProtectedHandle\("media-choose-folder"/);
  assert.match(main, /registerProtectedHandle\("media-load-library"/);
  assert.match(main, /registerProtectedHandle\("media-save-library"/);
  assert.match(main, /registerProtectedHandle\("media-import-paths"/);
  assert.match(main, /ipcMain\.on\("media-start-drag"/);
  assert.match(main, /registerProtectedHandle\("classifier-prepare-input"/);
  assert.match(main, /if \(info\.isDirectory\(\)\)/);
  assert.match(main, /kind: "folder"/);
  assert.match(main, /const classifierMediaExtensions = new Set/);
  assert.match(main, /mediaCounts: classifierMediaCounts\(records\)/);
  assert.match(main, /没有可发送到素材工作台的图片或视频/);
  assert.match(main, /buildClassifierRuntimeEnvironment\(process\.env, profiles, provider\)/);
  assert.match(main, /env: environment/);
  assert.match(main, /classification_mode: payload\.mode/);
  assert.match(main, /classifier-generate-template-draft/);
  assert.match(main, /\/chat\/completions/);
  assert.match(main, /payload\.taxonomy/);
  assert.match(main, /payload\.namingRule/);
  assert.match(main, /importedName: template\.name/);
  assert.match(main, /cancelled: true/);
  assert.match(main, /event\.sender\.startDrag/);
  assert.match(main, /resize\(\{ width: 48, height: 48/);
  assert.match(main, /files,/);
  assert.match(main, /registerProtectedHandle\("media-scan-folder"/);
  assert.match(main, /version: 2, assets: safeAssets, folders: safeFolders/);
  assert.match(main, /asset\.sourceKind !== "folder" \|\| asset\.sourceRoot/);
  assert.match(main, /media-library\.json/);
  assert.match(main, /media-library\.backup\.json/);
  assert.match(main, /await copyFile\(mediaLibraryIndexPath\(\), mediaLibraryBackupPath\(\)\)/);
  assert.match(main, /await rename\(temporaryPath, mediaLibraryIndexPath\(\)\)/);
  assert.match(main, /\/__media\//);
  assert.match(main, /"Accept-Ranges": "bytes"/);
  // v3 身份采集必须排在首屏之后，且不得被 await
  assert.match(main, /await createMainWindow\(\);\n\s*\/\/[^\n]*\n\s*const factorCollection = machineIdentityService\?\.start\(\);/);
  assert.match(main, /factorCollection\.then\(\(\) => \{[\s\S]{0,900}identityObserveCoordinator\?\.maybeSend\(\)/);
  assert.doesNotMatch(main, /await machineIdentityService/);
  assert.match(main, /machineIdentity: machineIdentityService/);
  assert.match(main, /const MAX_ACTIVE_MEDIA_STREAMS = 12/);
  assert.match(main, /async function pipeRegisteredMedia/);
  assert.match(main, /request\.once\("aborted", abort\)/);
  assert.match(main, /response\.once\("close", abort\)/);
  assert.match(main, /if \(!source\.destroyed\) source\.destroy\(\)/);
  assert.match(main, /function classifierEnginePath/);
  assert.match(main, /`\$\{process\.platform\}-\$\{process\.arch\}`/);
  assert.doesNotMatch(main, /startProdServer|vinext\/server/);
  assert.match(preload, /electron-app/);
  assert.match(preload, /openClassifier/);
  assert.match(preload, /mediaChooseFiles/);
  assert.match(preload, /mediaChooseFolder/);
  assert.match(preload, /mediaLoadLibrary/);
  assert.match(preload, /mediaSaveLibrary/);
  assert.match(preload, /webUtils\.getPathForFile/);
  assert.match(preload, /mediaImportPaths/);
  assert.match(preload, /mediaStartDrag/);
  assert.match(preload, /mediaScanFolder/);
  assert.match(preload, /classifierPrepareInput/);
  assert.match(preload, /classifierGenerateTemplateDraft/);
  assert.match(nextConfig, /output: "export"/);
  assert.equal(packageJson.main, "electron/main.mjs");
  assert.equal(packageJson.build.asar, true);
  assert.ok(packageJson.build.files.includes("dist/client/**/*"));
  assert.ok(packageJson.build.mac.extraResources.some((resource) => resource.to === "classifier"));
  assert.ok(packageJson.build.mac.extraResources.some((resource) => resource.to === "classifier/bin/darwin-${arch}"));
  assert.ok(packageJson.build.mac.extraResources.some((resource) => resource.to === "bin/darwin-${arch}"));
  assert.ok(packageJson.build.win.extraResources.some((resource) => resource.to === "classifier"));
  assert.match(voiceBackend, /runVoiceAttempt/);
  assert.doesNotMatch(voiceBackend, /\/api\/credits\/server-redeem/);
  assert.doesNotMatch(voiceBackend, /insufficient_credits/);
  assert.doesNotMatch(voiceBackend, /readLedger|mutateLedger|算力积分不足/);
  assert.match(voiceBackend, /"voice_clone"/);
  assert.doesNotMatch(voiceBackend, /operation:\s*"voice_synthesis"/);
  assert.doesNotMatch(voiceBackend, /buildMinimaxUrl\("\/t2a_v2"\)/);
  assert.match(voiceBackend, /data\?\.demo_audio/);
  assert.match(voiceBackend, /voice_synthesis_disabled/);
  assert.match(voiceBackend, /status: "试听已生成"/);
  assert.match(voiceBackend, /const VOICE_STORE_SCHEMA_VERSION = 2/);
  assert.match(voiceBackend, /async function migrateVoiceStoreToPreviewOnly/);
  assert.match(voiceBackend, /历史记录（合成已停用）/);
  assert.match(voiceBackend, /await Promise\.allSettled\(\[upsertVoiceItem\(failedVoice\)\]\)/);
  // 迁移保留 providerVoiceId，但 publicVoiceItem 不把它送到前端
  assert.doesNotMatch(voiceBackend, /providerVoiceId: voice\.providerVoiceId/);
  assert.match(voiceBackend, /export \{ server \}/);
});

test("packages native classifier engines for Windows and macOS", async () => {
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const notarizedBuild = await readFile(new URL("../scripts/build-macos-notarized.sh", import.meta.url), "utf8");
  const assetVerifier = await readFile(new URL("../scripts/verify-video-downloader-assets.mjs", import.meta.url), "utf8");
  const windowsPortableEngine = await readFile(new URL("../bundled-classifier/bin/win32-x64/engine/engine_entry.py", import.meta.url), "utf8");

  assert.match(main, /process\.platform === "win32" \? "素材分类引擎\.exe" : "素材分类引擎"/);
  assert.match(main, /path\.join\(root, "bin", platformArch, binaryName\)/);
  assert.match(main, /function windowsPortableClassifierLaunch/);
  assert.match(main, /"downloaders", "xhs-runtime", "python\.exe"/);
  assert.match(main, /"classifier", "bin", "win32-x64", "engine", "engine_entry\.py"|packageRoot, "bin", "win32-x64", "engine", "engine_entry\.py"/);
  assert.match(main, /\.\.\.enginePrefixArguments, "--request"/);
  assert.deepEqual(packageJson.build.win.target, ["nsis"]);
  assert.ok(packageJson.build.win.extraResources.some((resource) => resource.from === "bundled-classifier/bin/win32-x64" && resource.to === "classifier/bin/win32-x64"));
  assert.deepEqual(packageJson.build.mac.target, ["dir", "dmg"]);
  assert.match(packageJson.build.mac.x64ArchFiles, /classifier\/bin/);
  assert.match(packageJson.build.mac.x64ArchFiles, /bin\/\*\*\//);
  assert.match(packageJson.build.artifactName, /\$\{os\}.*\$\{arch\}.*安装程序/);
  assert.match(assetVerifier, /Windows 分类引擎入口/);
  assert.match(assetVerifier, /Windows 精细切割模块/);
  assert.match(assetVerifier, /Windows 图像依赖 Pillow/);
  assert.match(windowsPortableEngine, /def configure_split_precision/);
  assert.doesNotMatch(windowsPortableEngine, /import tkinter/);
  assert.match(main, /const APP_DISPLAY_NAME = "AI媒体库"/);
  assert.match(main, /const STABLE_USER_DATA_DIRECTORY_NAME = LICENSE_CONFIG\.appName/);
  assert.match(main, /licenseUserDataDirectoryName/);
  assert.match(main, /const RUNTIME_USER_DATA_PATH = licenseUserDataPath\(/);
  assert.match(main, /app\.setPath\("userData", RUNTIME_USER_DATA_PATH\)/);
  assert.match(main, /app\.setName\(RUNTIME_USER_DATA_DIRECTORY_NAME\)/);
  assert.ok(
    main.indexOf('app.setPath("userData"') < main.indexOf("app.setName(RUNTIME_USER_DATA_DIRECTORY_NAME)"),
    "the stable userData path must be selected before the runtime identity is fixed",
  );
  assert.doesNotMatch(main, /app\.setName\(APP_DISPLAY_NAME\)/);
  assert.match(main, /label: APP_DISPLAY_NAME/);
  assert.match(main, /title: APP_DISPLAY_NAME/);
  assert.match(main, /webContents\.on\("page-title-updated"/);
  assert.match(main, /event\.preventDefault\(\)/);
  assert.match(main, /app\.disableSuddenTermination\(\)/);
  assert.match(main, /mainWindow\.on\("close", \(event\) => \{[\s\S]{0,180}event\.preventDefault\(\);[\s\S]{0,120}mainWindow\?\.hide\(\)/);
  assert.match(main, /applicationQuitRequested = true;[\s\S]{0,180}app\.enableSuddenTermination\(\)/);
  assert.match(packageJson.scripts["desktop:dmg:all"], /build-macos-notarized\.sh all/);
  assert.match(packageJson.scripts["desktop:dmg:arm64"], /build-macos-notarized\.sh arm64/);
  assert.match(packageJson.scripts["desktop:dmg:x64"], /build-macos-notarized\.sh x64/);
  assert.match(packageJson.scripts["desktop:dmg:universal"], /build-macos-notarized\.sh universal/);
  assert.match(notarizedBuild, /notarytool submit/);
  assert.match(notarizedBuild, /stapler staple/);
  assert.match(notarizedBuild, /spctl --assess/);
  assert.match(notarizedBuild, /release\/notarized/);
  assert.match(notarizedBuild, /APPLE_CERT_ZIP/);
  assert.match(notarizedBuild, /APPLE_NOTARY_PROFILE/);
});

test("enforces protocol-v2 online licensing in the Electron main process", async () => {
  const config = await readFile(new URL("../electron/license-config.mjs", import.meta.url), "utf8");
  const service = await readFile(new URL("../electron/license-service.mjs", import.meta.url), "utf8");
  const secureStore = await readFile(new URL("../electron/license-secure-store.mjs", import.meta.url), "utf8");
  const offlineGrace = await readFile(new URL("../electron/license-offline-grace.mjs", import.meta.url), "utf8");
  const machineCode = await readFile(new URL("../electron/machine-code.mjs", import.meta.url), "utf8");
  const systemId = await readFile(new URL("../electron/machine-identity/system-id.mjs", import.meta.url), "utf8");
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../electron/preload.cjs", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(config, /appName: "ai-media-library"/);
  assert.match(config, /softwareName: "AI媒体库"/);
  assert.match(config, /baseUrl: "https:\/\/license\.dadaozixun\.com\/api\/license"/);
  assert.match(config, /protocolVersion: 2/);
  assert.match(config, /offlineGraceDays: 7/);
  assert.match(service, /this\.request\("\/activate"/);
  assert.match(service, /this\.request\("\/device\/status"/);
  assert.match(service, /this\.request\("\/device\/refresh"/);
  assert.match(service, /this\.request\("\/device\/unbind"/);
  assert.match(service, /this\.request\("\/time\/renew"/);
  assert.match(service, /async renewTimeLicense\(activationCode\)/);
  assert.match(service, /aiml-time-renew-v1/);
  assert.match(service, /Authorization: `Bearer \$\{credential\.deviceSession\}`/);
  assert.match(service, /"X-Device-Credential": credential\.deviceCredential/);
  assert.match(service, /license_protocol_version: this\.config\.protocolVersion/);
  assert.match(service, /activation_code: code/);
  assert.match(service, /当前无法完成联网授权验证，请检查网络、VPN或防火墙；联网后将自动恢复授权验证/);
  assert.match(service, /您的授权未失效，联网后将自动恢复使用/);
  assert.match(service, /当前设备凭证已失效，请使用原激活码重新验证/);
  assert.match(service, /未能完成激活，请核对激活码输入后重试/);
  assert.match(service, /当前设备已解绑，请使用原激活码重新绑定/);
  assert.match(service, /本机尚未补录激活码，可在授权管理中补录/);
  assert.doesNotMatch(service, /设备授权已失效，请重新激活|激活失败，请检查激活码|设备已解绑，请重新激活|当前授权未保存激活码，请重新激活/);
  assert.match(service, /credential_missing/);
  assert.match(service, /RESPONSE_CONTAINER_KEYS/);
  assert.doesNotMatch(service, /credits\/(reserve|confirm|release|consume|merge)/);
  assert.match(secureStore, /safeStorage\.encryptStringAsync/);
  assert.match(secureStore, /safeStorage\.decryptStringAsync/);
  assert.match(secureStore, /safeStorage\.isEncryptionAvailable/);
  assert.match(secureStore, /safeStorage\.encryptString\(plainText\)/);
  assert.match(secureStore, /safeStorage\.decryptString\(encrypted\)/);
  assert.match(secureStore, /license-credential\.v2\.bin/);
  assert.match(secureStore, /license-offline-hmac-key\.v1\.bin/);
  assert.match(secureStore, /license-offline-grant\.v1\.bin/);
  assert.match(secureStore, /async clearOfflineGrant\(\)/);
  assert.match(secureStore, /async clearDeviceCredential\(\)/);
  assert.match(secureStore, /async clearSavedActivationCode\(\)/);
  assert.match(secureStore, /async clearMachineIdentity\(\)/);
  assert.doesNotMatch(service, /deleteCredential\(/);
  assert.doesNotMatch(secureStore, /localStorage/);
  assert.match(offlineGrace, /createHmac\("sha256"/);
  assert.match(offlineGrace, /timingSafeEqual/);
  assert.doesNotMatch(offlineGrace, /deviceSession:\s*credential/);
  assert.doesNotMatch(offlineGrace, /deviceCredential:\s*credential/);
  assert.match(systemId, /IOPlatformUUID/);
  assert.match(systemId, /MachineGuid/);
  assert.match(machineCode, /createHash\("sha256"\)/);
  assert.match(machineCode, /secureStore\.readMachineCode\(\)/);
  assert.match(machineCode, /secureStore\.writeMachineIdentity\(identity\)/);
  assert.match(machineCode, /secureStore\.writeMachineCode\(identity\.active_machine_code\)/);
  assert.match(secureStore, /license-machine-code\.v2\.bin/);
  assert.match(secureStore, /license-machine-identity\.v3\.bin/);
  assert.match(main, /function registerProtectedHandle/);
  assert.match(main, /protectedIpcHandler\(featureRegistry, channel/);
  assert.match(main, /devTools: !app\.isPackaged/);
  assert.match(main, /isVoiceRoute \|\| isMediaRoute/);
  assert.match(preload, /licenseBootstrap/);
  assert.match(preload, /licenseDiagnosticLog/);
  assert.match(preload, /licenseCopyDiagnosticLog/);
  assert.match(preload, /licenseClearDiagnosticLog/);
  assert.match(preload, /license-diagnostic-log-changed/);
  assert.match(preload, /licenseMachineCode/);
  assert.match(preload, /licenseMachineIdentity/);
  assert.match(preload, /licenseCopyMachineCode/);
  assert.match(preload, /licenseRevealActivationCode/);
  assert.match(preload, /licenseCopyActivationCode/);
  assert.match(preload, /licenseSaveActivationCode/);
  assert.match(preload, /licenseActivate/);
  assert.match(preload, /licenseRenewTime/);
  assert.match(preload, /licenseUnbind/);
  assert.match(preload, /licenseRefresh: \(options\)/);
  assert.match(main, /resetOfflineCache/);
  assert.match(page, /function LicenseGate/);
  assert.match(page, /function LicenseDiagnosticLogPanel/);
  assert.match(page, />运行诊断日志</);
  assert.match(page, /当前会话最多保留/);
  assert.match(page, /复制内容已强制脱敏/);
  assert.match(styles, /\.license-diagnostic-list\s*\{[^}]*max-height:\s*255px;[^}]*overflow:\s*auto;/);
  assert.match(main, /function registerDiagnosticHandle\(channel, handler\) \{ ipcMain\.handle\(channel, diagnosticHandler\(applicationLog, channel, handler\)\); \}/);
  assert.match(main, /registerDiagnosticHandle\("license-diagnostic-log"/);
  assert.match(main, /registerDiagnosticHandle\("license-copy-diagnostic-log"/);
  assert.match(main, /registerDiagnosticHandle\("license-clear-diagnostic-log"/);
  assert.match(page, /使用新码恢复授权/);
  assert.match(page, /机器码和长期设备凭证保持不变/);
  assert.match(page, /function LicenseManagement/);
  assert.match(page, /MachineIdentityDiagnostic/);
  assert.match(page, /process\.env\.NODE_ENV === "development" && !bridge/);
  assert.match(page, /isLocalBrowserPreview/);
  assert.match(page, /phase: "active",\s*authorized: true/);
  assert.match(page, /state\.canUnbind/);
  assert.match(page, /凭证缺失/);
  assert.match(page, /当前设备未绑定/);
  assert.match(page, /授权状态待确认/);
  assert.match(page, /本机尚未补录激活码，可在授权管理中补录/);
  assert.doesNotMatch(page, /return "未激活"|return "授权失效"|当前授权激活时尚未保存激活码，请重新激活后查看/);
  assert.match(page, /换绑设备/);
  assert.match(page, /确认解绑并换绑/);
  assert.match(page, /••••••••••••••••/);
  assert.match(page, /"补录"/);
  assert.match(page, /立即激活/);
  assert.match(page, />授权管理</);
  assert.match(page, /aria-controls="license-management-details"/);
  assert.match(page, /license-management-chevron/);
  assert.match(page, /phase === "offline_active"/);
  assert.match(service, /功能正常可用，联网后将自动完成授权验证/);
  assert.match(service, /请在 \$\{result\.remainingDays\} 天内连接一次网络，否则将无法继续使用/);
  assert.match(await readFile(new URL("../app/globals.css", import.meta.url), "utf8"), /\.license-blocked-state h2 \{[^}]*white-space: pre-line;/);
  assert.match(page, /versionClicks\.current/);
  assert.match(page, /count >= 5/);
  assert.match(page, /resetOfflineCache: true/);
  assert.match(page, /不会删除激活码或设备凭证/);
  assert.equal(packageJson.build.electronFuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(packageJson.build.electronFuses.onlyLoadAppFromAsar, true);
  assert.equal(packageJson.build.electronFuses.runAsNode, false);
});

test("provides user-owned API settings for classification and MiniMax", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../electron/preload.cjs", import.meta.url), "utf8");
  const voiceBackend = await readFile(new URL("../electron/voice-backend/server.mjs", import.meta.url), "utf8");

  assert.match(page, /function ApiSettingsPage/);
  assert.match(page, /featureRegistry\.list\(\)\.filter\(\(feature\) => canDiscoverFeature/);
  assert.match(page, />设置</);
  assert.match(page, />火山引擎</);
  assert.match(page, />任意中转</);
  assert.match(page, />火山引擎 Endpoint ID</);
  assert.match(page, /placeholder="ep-xxxxxxxx"/);
  assert.match(page, /settings\.classification\.volcengine\.endpointId\.trim\(\)\.startsWith\("ep-"\)/);
  assert.match(page, /settings\.classification\.relay\.baseUrl\.trim\(\)/);
  assert.doesNotMatch(page, /}, \[notify\]\);/);
  assert.match(page, /火山引擎 API Key/);
  assert.match(page, /中转 API Key/);
  assert.match(page, /不与中转 API Key 共用/);
  assert.match(page, /不与火山引擎 API Key 共用/);
  assert.match(page, /const \[volcengineKey, setVolcengineKey\]/);
  assert.match(page, /const \[relayKey, setRelayKey\]/);
  assert.doesNotMatch(page, /const \[classificationKey, setClassificationKey\]/);
  assert.match(page, /MiniMax 声音克隆/);
  assert.match(page, /测试分类模型连接/);
  assert.match(page, /测试 MiniMax 连接/);
  assert.match(page, /apiSettingsTest/);
  assert.match(page, /请补全必填项；保存时会校验格式/);
  assert.match(page, /软件直接请求所选模型服务，不经过统一中转后台/);
  assert.match(main, /const VOLCENGINE_API_BASE_URL = "https:\/\/ark\.cn-beijing\.volces\.com\/api\/v3"/);
  assert.match(main, /registerProtectedHandle\("api-settings-get"/);
  assert.match(main, /registerProtectedHandle\("api-settings-save"/);
  assert.match(main, /registerProtectedHandle\("api-settings-test"/);
  assert.match(main, /function normalizeApiKey/);
  assert.match(main, /function normalizeVolcengineEndpoint/);
  assert.match(main, /const API_SETTINGS_STORE_FILE = "api-settings\.v1\.bin"/);
  assert.match(main, /async function loadClassificationProfiles/);
  assert.match(main, /stored\?\.volcengine\?\.endpointId/);
  assert.match(main, /stored\?\.relay\?\.baseUrl/);
  assert.match(main, /profiles\.volcengine\.apiKey/);
  assert.match(main, /profiles\.relay\.apiKey/);
  assert.match(main, /writeEncrypted\(API_SETTINGS_STORE_FILE, JSON\.stringify\(profiles\)\)/);
  assert.match(main, /ensureClassifierUserConfig/);
  assert.match(main, /buildClassifierRuntimeEnvironment\(process\.env, profiles, provider\)/);
  assert.doesNotMatch(main, /writeFile\(path\.join\([^\n]*\.env[^\n]*ARK_API_KEY/);
  assert.match(main, /Endpoint ID 格式不正确/);
  assert.match(main, /chat\/completions/);
  assert.match(main, /connection_type: provider/);
  assert.doesNotMatch(main, /请填写分类方案使用的文本模型或 Endpoint ID/);
  assert.doesNotMatch(main, /请填写素材分类使用的视觉模型或 Endpoint ID/);
  assert.match(preload, /apiSettingsGet/);
  assert.match(preload, /apiSettingsSave/);
  assert.match(preload, /apiSettingsTest/);
  assert.match(voiceBackend, /req\.method === "POST" && url\.pathname === "\/api\/config"/);
  assert.match(voiceBackend, /url\.pathname === "\/api\/config\/test-minimax"/);
  assert.match(voiceBackend, /get_voice/);
  assert.match(voiceBackend, /const secureConfigPath = process\.env\.SECURE_CONFIG_PATH \|\| join\(dataDir, "secure-config\.json"\)/);
});

test("provides a restricted recoverable desktop update workflow", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../electron/preload.cjs", import.meta.url), "utf8");
  const updater = await readFile(new URL("../electron/update-service.mjs", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.version, "1.1.19");
  assert.equal(packageJson.dependencies.semver, "^7.7.4");
  assert.match(updater, /UPDATE_APP_NAME = "ai-media-library"/);
  assert.match(updater, /UPDATE_BASE_URL = "https:\/\/update\.dadaozixun\.com"/);
  assert.match(updater, /function normalizeUpdateResponse/);
  assert.match(updater, /UPDATE_CHECK_INTERVAL_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(updater, /sha256File/);
  assert.match(updater, /更新包校验失败，请重新下载/);
  assert.match(updater, /path\.join\(userDataPath, "updates"\)/);
  assert.doesNotMatch(updater, /activation_code|device_session|device_credential|APPLE_|API_KEY/);
  assert.match(main, /initializeUpdateService/);
  assert.match(main, /scheduleAutomaticUpdateChecks/);
  assert.match(main, /function registerDiagnosticHandle\(channel, handler\) \{ ipcMain\.handle\(channel, diagnosticHandler\(applicationLog, channel, handler\)\); \}/);
  assert.match(main, /registerDiagnosticHandle\("update-check"/);
  assert.match(main, /registerDiagnosticHandle\("update-download"/);
  assert.match(main, /registerDiagnosticHandle\("update-install-now"/);
  assert.match(preload, /updateBootstrap/);
  assert.match(preload, /updateOnStateChanged/);
  assert.match(page, /关于与软件更新/);
  assert.match(page, /检查更新/);
  assert.match(page, /aria-controls="software-update-details"/);
  assert.match(page, /!collapsed && <div className="software-update-body" id="software-update-details">/);
  assert.match(page, /立即重启并安装/);
  assert.match(page, /退出时安装/);
  assert.match(page, /稍后提醒/);
  assert.match(page, /更新说明/);
  assert.match(styles, /update-download-progress/);
  assert.match(styles, /update-modal-backdrop/);
  assert.match(styles, /\.classification-api-card,[\s\S]*\.minimax-api-card\s*\{\s*display:\s*flex;\s*flex-direction:\s*column;/);
  assert.match(styles, /\.classification-api-card \.api-test-row,[\s\S]*\.minimax-api-card \.api-test-row\s*\{\s*margin-top:\s*auto;/);
});

test("proxies contact configuration through the local web preview server", async () => {
  const viteConfig = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");

  assert.match(viteConfig, /function contactPreviewApi/);
  assert.match(viteConfig, /requestUrl\.pathname !== "\/api\/contact"/);
  assert.match(viteConfig, /createContactService/);
  assert.match(viteConfig, /appName: LICENSE_CONFIG\.appName/);
  assert.match(viteConfig, /apply: "serve"/);
  assert.match(viteConfig, /contactPreviewApi\(\)/);
});

test("provides batch Douyin and Xiaohongshu downloads through the desktop bridge", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../electron/preload.cjs", import.meta.url), "utf8");
  const service = await readFile(new URL("../electron/download-service.mjs", import.meta.url), "utf8");
  const authService = await readFile(new URL("../electron/download-auth-service.mjs", import.meta.url), "utf8");
  const browserFallback = await readFile(new URL("../electron/douyin-browser-downloader.mjs", import.meta.url), "utf8");
  const assetVerifier = await readFile(new URL("../scripts/verify-video-downloader-assets.mjs", import.meta.url), "utf8");
  const notices = await readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(page, /featureRegistry\.list\(\)\.filter\(\(feature\) => canDiscoverFeature/);
  assert.match(page, />视频下载</);
  assert.match(page, /function VideoDownloadWorkbench/);
  assert.match(page, /const \[videoDownloadDraft, setVideoDownloadDraft\] = useState\(""\)/);
  assert.match(page, /input=\{videoDownloadDraft\}/);
  assert.match(page, /setInput=\{setVideoDownloadDraft\}/);
  assert.match(page, /支持批量粘贴/);
  assert.match(page, /解析并加入队列/);
  assert.match(page, /自动入库/);
  assert.match(page, /videoDownloadImportSpreadsheet/);
  assert.match(page, /上传 Excel 读取链接/);
  assert.match(page, /exportTable: false, quality/);
  assert.doesNotMatch(page, /const \[exportTable, setExportTable\]/);
  assert.match(main, /video-download-import-spreadsheet/);
  assert.match(preload, /videoDownloadImportSpreadsheet/);
  assert.match(service, /DOWNLOAD_TABLE_FILENAME = "视频下载记录\.csv"/);
  assert.match(service, /downloadTableCsv/);
  const queueActionsStart = page.indexOf('className="video-download-queue-actions"');
  const queueActionsEnd = page.indexOf("</div></div>", queueActionsStart);
  assert.ok(queueActionsStart >= 0 && page.slice(queueActionsStart, queueActionsEnd).includes("清除已完成"));
  const queueFooterStart = page.indexOf('className="video-download-queue-footer"');
  const queueFooterEnd = page.indexOf("</footer>", queueFooterStart);
  assert.ok(queueFooterStart >= 0 && !page.slice(queueFooterStart, queueFooterEnd).includes("清除已完成"));
  assert.match(page, /平台登录/);
  assert.match(page, /登录信息仅保存在本机/);
  assert.match(page, /videoDownloadAuthOpen/);
  assert.match(page, /已检测登录态/);
  assert.match(styles, /\.video-download-auth-panel/);
  assert.match(styles, /\.video-download-page/);
  assert.match(main, /initializeVideoDownloadService/);
  assert.match(main, /initializeVideoDownloadAuthService/);
  assert.match(main, /registerProtectedHandle\("video-download-enqueue"/);
  assert.match(main, /registerProtectedHandle\("video-download-auth-open"/);
  assert.match(preload, /videoDownloadEnqueue/);
  assert.match(preload, /videoDownloadAuthBootstrap/);
  assert.match(preload, /videoDownloadAuthOnStateChanged/);
  assert.match(preload, /videoDownloadOnStateChanged/);
  assert.match(service, /extractSupportedLinks/);
  assert.match(service, /task\.platform === "douyin" && existsSync\(bundledYtDlp\)/);
  assert.match(service, /task\.platform === "xiaohongshu" && existsSync\(bundledExecutable\)/);
  assert.match(service, /bundledXhsRuntime/);
  assert.match(service, /xhs_launcher\.py/);
  assert.match(service, /--ffmpeg-location/);
  assert.match(service, /XHS_COOKIE/);
  assert.match(service, /XHS_USER_AGENT/);
  assert.match(service, /PYTHONUTF8/);
  assert.match(service, /PYTHONIOENCODING/);
  assert.match(service, /--cookies/);
  assert.match(main, /downloadDouyinWithBrowser/);
  assert.match(authService, /DouyinBrowserDownloader/);
  assert.match(browserFallback, /backgroundThrottling: false/);
  assert.match(browserFallback, /will-download/);
  assert.match(service, /单次最多添加 100 条链接/);
  assert.match(notices, /jiji262\/douyin-downloader/);
  assert.match(notices, /Andy-SoulShell\/xhs-downloader/);
  assert.ok(packageJson.build.files.includes("third_party/video-downloaders/**/*"));
  assert.ok(packageJson.build.mac.extraResources.some((entry) => entry.from === "bundled-downloaders/darwin-${arch}"));
  assert.ok(packageJson.build.win.extraResources.some((entry) => entry.from === "bundled-downloaders/win32-x64"));
  assert.ok(packageJson.build.win.extraResources.some((entry) => entry.from === "bundled-tools/win32-x64"));
  assert.match(packageJson.scripts["desktop:win"], /verify-video-downloader-assets\.mjs win32-x64/);
  assert.match(packageJson.scripts["desktop:pack"], /verify-video-downloader-assets\.mjs darwin-arm64/);
  assert.match(assetVerifier, /xhs-downloader/);
  assert.match(assetVerifier, /xhs-runtime/);
  assert.match(assetVerifier, /ffmpeg/);
});

test("reserves a macOS traffic-light drag region above the sidebar navigation", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../electron/preload.cjs", import.meta.url), "utf8");
  assert.match(page, /sidebar-window-drag-region/);
  assert.match(preload, /`platform-\$\{process\.platform\}`/);
  assert.match(css, /\.electron-app\.platform-darwin \.sidebar-window-drag-region/);
  assert.match(css, /\.electron-app:not\(\.platform-darwin\) \.sidebar-window-drag-region\s*\{\s*display:\s*none;/);
  assert.match(css, /flex:\s*0 0 40px/);
  assert.match(css, /-webkit-app-region:\s*drag/);
  assert.match(main, /process\.platform === "darwin"[\s\S]*titleBarStyle: "hiddenInset"[\s\S]*titleBarStyle: "default"/);
});

test("uses one typography scale for every primary workspace header", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /--workspace-header-height:\s*78px/);
  assert.match(css, /\.library-heading,[\s\S]*\.api-settings-heading\s*\{[\s\S]*height:\s*var\(--workspace-header-height\);[\s\S]*min-height:\s*var\(--workspace-header-height\);[\s\S]*padding:\s*14px 22px;[\s\S]*border-bottom:\s*1px solid #e1e6ea;/);
  assert.equal((page.match(/workspace-heading-icon/g) ?? []).length, 6);
  assert.doesNotMatch(css, /\.video-download-icon\s*\{[^}]*width:\s*48px/);
  assert.match(css, /\.video-download-icon\s*\{[^}]*width:\s*38px;[^}]*height:\s*38px;[^}]*flex:\s*0 0 38px;/);
  assert.match(css, /\.workspace-heading-icon\s*\{[\s\S]*width:\s*38px !important;[\s\S]*height:\s*38px !important;[\s\S]*flex:\s*0 0 38px !important;[\s\S]*border-radius:\s*10px !important;/);
  assert.match(css, /\.workspace-heading-icon > svg\s*\{[\s\S]*width:\s*22px !important;[\s\S]*height:\s*22px !important;/);
  assert.match(css, /\.electron-app \.library-heading,[\s\S]*\.electron-app \.api-settings-heading\s*\{[\s\S]*-webkit-app-region:\s*drag;/);
  assert.match(css, /\.electron-app \.viral-library-heading,[\s\S]*-webkit-app-region:\s*drag;/);
  assert.match(css, /\.electron-app \.viral-library-heading button,[\s\S]*-webkit-app-region:\s*no-drag;/);
  assert.match(css, /\.electron-app \.contact-author\s*\{[\s\S]*-webkit-app-region:\s*no-drag;/);
  assert.match(css, /\.video-download-heading-main\s*\{\s*gap:\s*13px;/);
  assert.match(css, /\.heading-row h1,[\s\S]*\.api-settings-heading h1\s*\{[\s\S]*font-size:\s*18px;[\s\S]*font-weight:\s*700;[\s\S]*letter-spacing:\s*0;/);
  assert.match(css, /\.library-heading p,[\s\S]*\.api-settings-heading p\s*\{[\s\S]*font-size:\s*11px;[\s\S]*font-weight:\s*400;/);
});

test("aligns media actions with the lower filter row", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(page, /className="search-row"[\s\S]*className="search-box"[\s\S]*className=\{`local-source \$\{localStatus\}`\}[\s\S]*className="toolbar-actions"/);
  assert.doesNotMatch(css, /\.local-source\s*\{[^}]*transform:/);
  assert.match(css, /\.toolbar-wrap\s*\{[^}]*position:\s*relative/);
  assert.match(css, /\.toolbar-actions\s*\{[^}]*position:\s*absolute;[^}]*right:\s*20px;[^}]*bottom:\s*13px/);
});

test("previews video cards silently on hover and resets them on mouse leave", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(page, /const startVideoHoverPreview/);
  assert.match(page, /video\.muted = true/);
  assert.match(page, /video\.loop = true/);
  assert.match(page, /video\.play\(\)/);
  assert.match(page, /const stopVideoHoverPreview/);
  assert.match(page, /video\.pause\(\)/);
  assert.match(page, /video\.currentTime = 0/);
  assert.match(page, /onMouseEnter=\{\(event\) =>/);
  assert.match(page, /onMouseLeave=\{\(event\) =>/);
  assert.match(page, /function DeferredAssetPreview/);
  assert.match(page, /data-media-src=\{asset\.src\}/);
  assert.match(page, /preload=\{shouldLoad \? "metadata" : "none"\}/);
  assert.match(page, /const MEDIA_ASSET_PAGE_SIZE = 48/);
  assert.match(page, /pagedAssets\.map/);
  assert.match(css, /\.asset-card\.hover-previewing \.play-chip/);
  assert.match(css, /\.asset-pagination/);
  assert.match(css, /\.voice-card-notice/);
  assert.match(css, /\.voice-card-error/);
});

test("builds classifier result preview metadata without mounting the output directory", () => {
  const segment = buildClassifierPreviewMetadata("C:\\结果\\segments\\商品片_镜头_02_00004000-00006800.mp4");
  assert.equal(segment.segmentIndex, 2);
  assert.equal(segment.startMs, 4000);
  assert.equal(segment.endMs, 6800);
  assert.equal(segment.timeRange, "00:04.0 – 00:06.8");
  assert.deepEqual(segment.tags, []);

  const tagged = buildClassifierPreviewMetadata("/Users/test/结果/01_使用场景/办公场景/商品_桌面使用_01.mp4");
  assert.deepEqual(tagged.tags, ["01_使用场景", "办公场景"]);

  const taggedSegment = buildClassifierPreviewMetadata("/Users/test/结果/01_产品本体展示/外包装细节/原视频_镜头04_000011267-000014400_产品_外包装细节_近景.mp4");
  assert.equal(taggedSegment.timeRange, "00:11.3 – 00:14.4");
  assert.deepEqual(taggedSegment.tags, ["01_产品本体展示", "外包装细节"]);

  const generatedSegment = buildClassifierPreviewMetadata("/Users/test/结果/outputs/任务_镜头拆解_260901/segments/原视频_镜头04_000011267-000014400.mp4");
  assert.deepEqual(generatedSegment.tags, []);
});

test("shows live classifier result previews with hover playback and a right detail drawer", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../electron/preload.cjs", import.meta.url), "utf8");

  assert.match(page, /处理结果预览/);
  assert.match(page, /视频悬停即可静音预览/);
  assert.match(page, /classifier-preview-drawer/);
  assert.match(page, /hydrateClassifierPreview\(segmentDirs, true\)/);
  assert.match(page, /hydrateClassifierPreview\(renameOutputFiles, true\)/);
  assert.match(page, /event\.currentTarget\.play\(\)/);
  assert.match(page, /event\.currentTarget\.pause\(\)/);
  assert.match(css, /\.classifier-preview-row/);
  assert.match(css, /\.classifier-preview-drawer\s*\{/);
  assert.match(main, /classifier-preview-media/);
  assert.match(preload, /classifierPreviewMedia/);
  assert.doesNotMatch(main, /classifier-preview-media[\s\S]{0,1200}mediaSaveLibrary/);
});

test("reveals split previews one shot at a time and replaces source rows after tagging", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const shotProgress = message\.match\(\/\^镜头/);
  assert.match(page, /message: `分镜已生成（\$\{index\}\/\$\{total\}）`/);
  assert.match(page, /replaceClassifierPreviewOutput\(sourceName, copied\[1\]\)/);
  assert.match(page, /classifierPreviewMatchesSource\(item, fileName\)/);
  assert.doesNotMatch(page, /for \(let index = 1; index <= count; index \+= 1\)/);
});

test("cleans only approved generated split sources after a final tagged output exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classifier-cleanup-"));
  try {
    const segmentRoot = path.join(root, "outputs", "task", "segments");
    const handoffRoot = path.join(root, "handoff");
    const finalRoot = path.join(root, "classified");
    await Promise.all([mkdir(segmentRoot, { recursive: true }), mkdir(handoffRoot, { recursive: true }), mkdir(finalRoot, { recursive: true })]);
    const generatedSource = path.join(segmentRoot, "shot-01.mp4");
    const protectedSource = path.join(root, "user-original.mp4");
    const handoffInput = path.join(handoffRoot, "shot-01.mp4");
    const protectedInput = path.join(handoffRoot, "user-original.mp4");
    const finalOutput = path.join(finalRoot, "tagged-01.mp4");
    await Promise.all([
      writeFile(generatedSource, "generated"),
      writeFile(protectedSource, "original"),
      writeFile(handoffInput, "handoff"),
      writeFile(protectedInput, "handoff"),
      writeFile(finalOutput, "final"),
    ]);
    const result = await consumeGeneratedClassifierSources([
      { sourcePath: handoffInput, outputPath: finalOutput },
      { sourcePath: protectedInput, outputPath: finalOutput },
    ], [
      { inputPath: handoffInput, sourcePath: generatedSource },
      { inputPath: protectedInput, sourcePath: protectedSource },
    ], [segmentRoot]);
    assert.deepEqual(result.consumed, [generatedSource]);
    await assert.rejects(stat(generatedSource));
    assert.equal((await stat(protectedSource)).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
