import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("first entry displays media reverse workflow and keeps output tabs beside mode tabs", async () => {
  const source = await readFile(
    new URL("../app/prompt-library.tsx", import.meta.url),
    "utf8",
  );
  const modulePath = new URL(`.prompt-ui-${randomUUID()}.mjs`, import.meta.url);
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  try {
    await writeFile(modulePath, compiled);
    const { PromptLibrary } = await import(modulePath.href);
    const html = renderToStaticMarkup(
      createElement(PromptLibrary, {
        assets: [],
        notify() {},
        onConfigure() {},
        contactAuthor: null,
        registerBeforeLeave() {},
      }),
    );
    for (const label of [
      "1:1 还原",
      "可迁移模板",
      "整片提示词",
      "逐镜提示词",
      "原素材反推提示词",
      "上传图片或视频",
      "从媒体库选择",
      "反推原素材提示词",
      "转为可迁移模板",
      "保存修改",
      "下载 .txt",
      "复制全文",
    ])
      assert.ok(html.includes(label), `Empty library must show ${label}`);
    assert.match(html, /aria-label="提示词正文"/);
    assert.ok(!html.includes("复刻换元素"));
    assert.match(
      html,
      /prompt-toolbar[\s\S]*1:1 还原[\s\S]*可迁移模板[\s\S]*整片提示词[\s\S]*逐镜提示词[\s\S]*prompt-source-card/,
    );
    assert.match(html, /prompt-brand-icon workspace-heading-icon/);
    assert.ok(!html.includes("选择一条提示词开始编辑"));
    assert.ok(!html.includes("一键自动成片"));
    assert.ok(!html.includes("文生视频"));
    const imageHtml = renderToStaticMarkup(
      createElement(PromptLibrary, {
        assets: [],
        notify() {},
        onConfigure() {},
        contactAuthor: null,
        registerBeforeLeave() {},
        initialRecord: {
          id: "image",
          title: "图片",
          tags: "",
          variants: {
            restore: { full: "图像结果", shots: "" },
            template: { full: "", shots: "" },
          },
          dialogue: "",
          favorite: false,
          revision: 1,
          createdAt: "",
          updatedAt: "",
          lastUsedAt: null,
          materials: [],
          source: { id: "source-image", kind: "image", name: "image.png" },
        },
      }),
    );
    assert.ok(imageHtml.includes("整片提示词"));
    assert.ok(!imageHtml.includes("逐镜提示词"));
    assert.ok(imageHtml.includes("反推图片提示词"));
    const videoHtml = renderToStaticMarkup(createElement(PromptLibrary, {
      assets: [], notify() {}, onConfigure() {}, contactAuthor: null, registerBeforeLeave() {},
      initialRecord: { id: 'video', title: '视频', tags: '', dialogue: '', favorite: false, variants: { restore: { full: '', shots: '' }, template: { full: '', shots: '' } }, revision: 1, createdAt: '', updatedAt: '', lastUsedAt: null, materials: [], source: { id: 'source-video', kind: 'video', name: 'interview.mp4' } },
    }));
    assert.ok(videoHtml.includes('反推原视频提示词'));
    assert.match(videoHtml, /<details[^>]*prompt-transcript-supplement[\s\S]*补充原片台词/);
    assert.ok(videoHtml.includes('原片实际台词'));
    assert.ok(!videoHtml.includes('开始原素材反推'));
    assert.ok(!videoHtml.includes('aria-modal="true"'));

  } finally {
    await rm(modulePath, { force: true });
  }
});
