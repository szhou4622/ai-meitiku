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

test("absolute source timestamps in a complete shot become local without changing source boundaries", () => {
  const second = prompt("人物转身，光影与动作保持原文")
    .replace("0–2s 拿起产品", "2.633秒 - 3.633秒 拿起产品\n3.633秒 - 5.167秒 放下产品")
    .replace("【BGM】无音乐", "【BGM】2.633–5.167s 无音乐") + "\n本镜总时长2.534秒";
  const input = [
    { start: 0, end: 2.633, prompt: prompt("第一镜").replace("0–2s", "0–2.633s") },
    { start: 2.633, end: 5.167, prompt: second },
    { start: 5.167, end: 10.05, prompt: prompt("第三镜").replace("0–2s", "0–4.883s") },
  ];
  const valid = validateShotPrompts(input, 10.05);
  assert.deepEqual(valid.map(({ start, end }) => ({ start, end })), input.map(({ start, end }) => ({ start, end })));
  assert.match(valid[1].prompt, /0–1秒 拿起产品\n1–2.534秒 放下产品/);
  assert.match(valid[1].prompt, /【BGM】0–2.534秒 无音乐/);
  assert.match(valid[1].prompt, /人物转身，光影与动作保持原文/);
  assert.match(valid[1].prompt, /本镜总时长2.534秒/);
  assert.equal(valid[0].prompt, input[0].prompt);
  assert.equal(valid[2].prompt, input[2].prompt);
  assert.match(formatShotPrompts(valid), /【分镜 2｜2.633–5.167秒】/);
  assert.equal(input[1].prompt, second);
});

test("clock timestamps can be localized but mixed coordinates, incomplete evidence and extensions still fail", () => {
  const first = { start: 0, end: 2.633, prompt: prompt("第一镜").replace("0–2s", "0–2.633s") };
  const absolute = prompt("第二镜").replace("0–2s", "00:02.633–00:05.167s");
  assert.match(validateShotPrompts([first, {start: 2.633, end: 5.167, prompt: absolute}], 5.167)[1].prompt, /0–2.534秒/);
  for (const invalid of [
    absolute.replace("【BGM】无音乐", "【BGM】0–1s 无音乐"),
    absolute.replace("00:05.167", "00:05.500"),
    absolute.replace("00:02.633", "00:03.000"),
    absolute.replace("00:02.633–00:05.167s", "2.633–3.0s 动作\n4–5.167s"),
  ]) {
    assert.throws(() => validateShotPrompts([first, {start: 2.633, end: 5.167, prompt: invalid}], 5.167), /分镜 2实际时长 2.534/);
  }
});
