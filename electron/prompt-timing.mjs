export function assertPromptDuration(text, duration) {
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("原视频时长缺失，请重新读取原素材");
  const clock = (value) =>
    value.includes(":")
      ? value.split(":").reduce((n, part) => n * 60 + Number(part), 0)
      : Number(value);
  const ranges = text.matchAll(
    /(\d+(?::\d{1,2}){0,2}(?:\.\d+)?)\s*(?:秒|s)?\s*[-–—~～至]\s*(\d+(?::\d{1,2}){0,2}(?:\.\d+)?)\s*(?:秒|s|[)）])/gi,
  );
  for (const match of ranges) {
    const start = clock(match[1]),
      end = clock(match[2]);
    if (end < start || end > duration + 0.1)
      throw new Error(
        `模型生成的时间段 ${match[0]} 超过原视频实际时长 ${duration} 秒或顺序错误，结果未采用，请重新生成`,
      );
  }
  for (const match of text.matchAll(
    /(?:总时长|全片时长|视频时长)[：:\s]*(\d+(?:\.\d+)?)\s*秒/g,
  )) {
    if (Math.abs(Number(match[1]) - duration) > 0.1)
      throw new Error(
        `模型生成的总时长与原视频实际时长 ${duration} 秒不一致，结果未采用，请重新生成`,
      );
  }
}
