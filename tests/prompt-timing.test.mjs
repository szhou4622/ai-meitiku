import test from "node:test";
import assert from "node:assert/strict";
import { assertPromptDuration } from "../electron/prompt-timing.mjs";
test("timelines use actual source duration, accepting rounded endpoints and rejecting invented extensions", () => {
  for (const text of [
    "节拍1（0-2s），节拍2（2-11.1s）",
    "镜头 00:00–00:11",
    "总时长：11.05秒",
    "前景主体占 1/3",
  ])
    assert.doesNotThrow(() => assertPromptDuration(text, 11.05));
  for (const text of [
    "节拍14（37-40s）",
    "0秒至40秒",
    "镜头（00:10-00:40）",
    "总时长：40秒",
    "镜头（8–2s）",
  ])
    assert.throws(() => assertPromptDuration(text, 11.05));
});
