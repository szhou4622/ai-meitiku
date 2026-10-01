import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeViralVisualType,
  parseViralVisualClassification,
  viralVisualClassificationPrompt,
  VIRAL_VISUAL_TYPES,
} from "../electron/viral-visual-classifier.mjs";

test("default viral visual taxonomy stays fixed and includes manual fallback", () => {
  assert.deepEqual(VIRAL_VISUAL_TYPES, ["痛点展示", "使用演示", "效果对比", "产品特写", "场景应用", "价格促单钩子", "证言共鸣", "人工标注"]);
});

test("normalizes common API category aliases", () => {
  assert.equal(normalizeViralVisualType("06_价格促单"), "价格促单钩子");
  assert.equal(normalizeViralVisualType("口碑证言"), "证言共鸣");
  assert.equal(normalizeViralVisualType("不存在的分类"), "人工标注");
});

test("keeps confident API result and sends low confidence to manual review", () => {
  assert.deepEqual(
    parseViralVisualClassification('{"visual_type":"使用演示","confidence":0.91,"reason":"人物正在操作产品"}'),
    { visualType: "使用演示", confidence: 0.91, reason: "人物正在操作产品" },
  );
  assert.equal(parseViralVisualClassification('{"visual_type":"效果对比","confidence":0.31}').visualType, "人工标注");
  assert.equal(parseViralVisualClassification("not-json").visualType, "人工标注");
});

test("prompt limits the model to the built-in taxonomy", () => {
  const prompt = viralVisualClassificationPrompt("sample.mp4", 3);
  for (const visualType of VIRAL_VISUAL_TYPES) assert.match(prompt, new RegExp(visualType));
  assert.match(prompt, /3张来自同一视频的代表帧/);
  assert.match(prompt, /只能从以下分类中选一个/);
});
