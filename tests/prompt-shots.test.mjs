import test from "node:test";
import assert from "node:assert/strict";
import {
  validateShotPrompts,
  assertVideoPromptSections,
  formatShotPrompts,
  splitShotPrompts,
} from "../electron/prompt-shots.mjs";
const prompt = (subject) =>
  `【主体】${subject}\n【风格】写实\n【光影】顶部柔光，阴影柔和\n【时间线】\n0–2s 拿起产品\n【BGM】无音乐\n【限制】服装一致`;
test("each shot retains an independently usable API prompt and roundtrips through stored text", () => {
  const input = [
    { start: 0, end: 2, prompt: prompt("人物一") },
    { start: 2, end: 4, prompt: prompt("人物二") },
  ];
  const valid = validateShotPrompts(input, 4),
    stored = formatShotPrompts(valid);
  assert.deepEqual(splitShotPrompts(stored), input);
  assert.equal(splitShotPrompts(stored)[1].prompt, prompt("人物二"));
  assert.ok(!splitShotPrompts(stored)[1].prompt.includes("人物一"));
  assert.deepEqual(splitShotPrompts("全片约束与整体时间线"), []);
});
test("missing structure, gaps, overlaps, wrong durations and dependent prompts are rejected", () => {
  assert.throws(() => validateShotPrompts("整片形式的逐镜文本", 4), /数组/);
  assert.throws(
    () => validateShotPrompts([{ start: 0, end: 2, prompt: "片段动作" }], 2),
    /缺少/,
  );
  assert.throws(
    () =>
      validateShotPrompts(
        [
          { start: 0, end: 2, prompt: prompt("甲") },
          { start: 3, end: 4, prompt: prompt("乙") },
        ],
        4,
      ),
    /时间/,
  );
  assert.throws(
    () =>
      validateShotPrompts([{ start: 0, end: 2, prompt: prompt("同上") }], 2),
    /独立/,
  );
  assert.throws(
    () => validateShotPrompts([{ start: 0, end: 2, prompt: prompt("甲") }], 4),
    /长度/,
  );
});
test("whole and individual prompts reject missing or empty lighting sections", () => {
  for (const missing of [
    prompt("甲").replace(/【光影】[^\n]*\n/, ""),
    prompt("甲").replace(/【光影】[^\n]*/, "【光影】  "),
  ]) {
    assert.throws(() => assertVideoPromptSections(missing), /光影/);
    assert.throws(() => validateShotPrompts([{ start: 0, end: 2, prompt: missing }], 2), /分镜 1.*光影/);
  }
});
