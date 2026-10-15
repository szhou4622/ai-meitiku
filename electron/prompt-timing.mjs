const rangePattern = () => /(-?\d+(?::\d{1,2}){0,2}(?:\.\d+)?)\s*(?:秒|s)?\s*[-–—~～至]\s*(-?\d+(?::\d{1,2}){0,2}(?:\.\d+)?)\s*(?:秒|s|[)）])/gi;
const clock = (value) => value.includes(":")
  ? value.split(":").reduce((n, part) => n * 60 + Number(part), 0)
  : Number(value);
const rangesIn = (text) => [...text.matchAll(rangePattern())].map(match => ({
  match, start: clock(match[1]), end: clock(match[2]),
}));

// A model may copy original-video timestamps into an independently usable shot.
// Convert only a complete, unambiguous absolute timeline. Never clip, scale or
// repair mixed coordinates / invented intervals to make validation pass.
export function localizeShotPrompt(text, start, end) {
  const duration = end - start;
  const ranges = rangesIn(text);
  if (start <= 0 || !ranges.length || ranges.every(range => range.start >= 0 && range.end >= range.start && range.end <= duration + 0.1)) return text;
  const timeline = text.match(/【时间线】([\s\S]*?)(?=【[^】]+】|$)/)?.[1] || "";
  const timelineRanges = rangesIn(timeline);
  if (!timelineRanges.length || Math.abs(timelineRanges[0].start - start) > 0.1 || Math.abs(timelineRanges.at(-1).end - end) > 0.1) return text;
  if (ranges.some(range => range.start < start || range.end < range.start || range.end > end + 0.1)) return text;
  if (timelineRanges.some((range, index) => index > 0 && Math.abs(range.start - timelineRanges[index - 1].end) > 0.15)) return text;
  const seconds = value => String(Number(value.toFixed(6)));
  return text.replace(rangePattern(), (match, from, to) => {
    const suffix = /[)）]$/.test(match) ? match.at(-1) : "";
    return `${seconds(clock(from) - start)}–${seconds(clock(to) - start)}秒${suffix}`;
  });
}

export function assertPromptDuration(text, duration, label = "原视频") {
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("原视频时长缺失，请重新读取原素材");
  const ranges = text.matchAll(rangePattern());
  for (const match of ranges) {
    const start = clock(match[1]),
      end = clock(match[2]);
    if (start < 0 || end < start || end > duration + 0.1)
      throw new Error(
        `模型生成的时间段 ${match[0]} 超过${label}实际时长 ${Number(duration.toFixed(6))} 秒或顺序错误，结果未采用，请重新生成`,
      );
  }
  for (const match of text.matchAll(
    /(?:总时长|全片时长|视频时长)[：:\s]*(\d+(?:\.\d+)?)\s*秒/g,
  )) {
    if (Math.abs(Number(match[1]) - duration) > 0.1)
      throw new Error(
        `模型生成的总时长与${label}实际时长 ${Number(duration.toFixed(6))} 秒不一致，结果未采用，请重新生成`,
      );
  }
}
