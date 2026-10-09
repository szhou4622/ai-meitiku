import test from "node:test";
import assert from "node:assert/strict";
import { formatPromptTimeline } from "../electron/prompt-format.mjs";

test("timeline paragraphs split real time ranges while preserving text, quotes and other sections", () => {
  const source = '【主体】1位女性\n【时间线】\n0.000秒至11.05秒，全程：0.000秒-0.083秒，举箱；0.083秒-0.500秒，字幕“同行们”；0.500秒-11.05秒，展示。\n\n【BGM】0–11.05s 未验证\n【限制】人物一致';
  const output = formatPromptTimeline(source);
  assert.match(output, /全程：\n0.000秒/);
  assert.match(output, /举箱；\n0.083秒/);
  assert.match(output, /同行们”；\n0.500秒/);
  assert.equal(output.replace(/\s/g, ""), source.replace(/\s/g, ""));
  assert.equal(formatPromptTimeline(output), output);
  assert.match(output, /【BGM】0–11.05s 未验证/);
});

test("clock ranges and shot-local timelines format without changing headings or adding cuts", () => {
  const source = '【分镜 2｜5–11秒】\n【时间线】00:00–00:02s 拿起；00:02–00:06s 展示\n【限制】同一长镜头';
  const output = formatPromptTimeline(source);
  assert.match(output, /拿起；\n00:02/);
  assert.equal(output.replace(/\s/g, ""), source.replace(/\s/g, ""));
  assert.equal(formatPromptTimeline('普通图片结果'), '普通图片结果');
});

test("existing numbered shot paragraphs keep the number attached to its timestamp", () => {
  const source = '【时间线】\n1. 0.000-2.500秒：展示\n2. 2.500-5.200秒：打开\n【BGM】未验证';
  assert.equal(formatPromptTimeline(source), source);
});
