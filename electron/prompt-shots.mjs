import { assertPromptDuration } from "./prompt-timing.mjs";
import { formatPromptTimeline } from "./prompt-format.mjs";
/** @typedef {{start:number,end:number,prompt:string}} ShotPrompt */
const heading = /^【分镜 (\d+)｜([\d.]+)–([\d.]+)秒】\s*$/gm;
/** @param {string} text @param {string} label */
export function assertVideoPromptSections(text, label = "整片提示词") {
  for (const part of ["主体", "风格", "光影", "时间线", "BGM", "限制"]) {
    const body = text.match(new RegExp(`【${part}】([\\s\\S]*?)(?=【[^】]+】|$)`))?.[1];
    if (!body?.trim())
      throw new Error(`${label}缺少有内容的【${part}】，原结果已保留，请重新生成`);
  }
}
/** @param {string} text @returns {ShotPrompt[]} */
export function splitShotPrompts(text) {
  const matches = [...text.matchAll(heading)];
  if (!matches.length || text.slice(0, matches[0].index).trim()) return [];
  return matches.map((match, index) => ({
    start: Number(match[2]),
    end: Number(match[3]),
    prompt: text
      .slice(
        match.index + match[0].length,
        matches[index + 1]?.index ?? text.length,
      )
      .trim(),
  }));
}
/** @param {ShotPrompt[]} shots */
export function formatShotPrompts(shots) {
  return shots
    .map(
      (shot, index) =>
        `【分镜 ${index + 1}｜${shot.start}–${shot.end}秒】\n${formatPromptTimeline(shot.prompt)}`,
    )
    .join("\n\n");
}
/** @param {unknown} value @param {number | undefined} duration @returns {ShotPrompt[]} */
export function validateShotPrompts(value, duration) {
  if (!Array.isArray(value) || !value.length || value.length > 200)
    throw new Error("模型未返回逐镜独立提示词数组，请重新生成");
  let previous = 0;
  const shots = value.map((shot, index) => {
    if (
      !shot ||
      !Number.isFinite(shot.start) ||
      !Number.isFinite(shot.end) ||
      shot.start < 0 ||
      shot.end <= shot.start ||
      Math.abs(shot.start - previous) > 0.15 ||
      typeof shot.prompt !== "string" ||
      !shot.prompt.trim() ||
      shot.prompt.length > 100000
    )
      throw new Error(`分镜 ${index + 1} 的时间或独立提示词不完整，请重新生成`);
    assertVideoPromptSections(shot.prompt, `分镜 ${index + 1}`);
    if (/同上|参见上一镜|沿用上一镜提示词/.test(shot.prompt))
      throw new Error(`分镜 ${index + 1} 依赖其他分镜，无法独立复制使用`);
    assertPromptDuration(shot.prompt, shot.end - shot.start);
    previous = shot.end;
    return { start: shot.start, end: shot.end, prompt: shot.prompt.trim() };
  });
  if (duration !== undefined && Math.abs(previous - duration) > 0.15)
    throw new Error("逐镜时间未覆盖原片实际长度，请重新生成");
  return shots;
}
