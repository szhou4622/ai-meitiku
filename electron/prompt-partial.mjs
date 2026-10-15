import { assertVideoPromptSections, validateShotPrompts } from './prompt-shots.mjs';
import { assertPromptDuration, localizeShotPrompt } from './prompt-timing.mjs';
import { formatPromptTimeline } from './prompt-format.mjs';

export function partialQuality(issues) {
  return { status: issues.length ? 'partial' : 'complete', issues };
}

export function recoverReverseVideoOutput(rawOutput, duration) {
  let parsed;
  try { parsed = JSON.parse(rawOutput.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')); }
  catch {
    return { full: rawOutput, shots: '', rawOutput, shotData: [], quality: partialQuality([{ part: 'structure', message: '生成内容的结构未完整返回，原始内容已保留，可手动复制或补生成。' }]) };
  }
  const issues = [];
  const full = typeof parsed?.full === 'string' ? parsed.full.trim() : '';
  try { assertVideoPromptSections(full); assertPromptDuration(full, duration); }
  catch (error) { issues.push({ part: 'full', message: error.message.replace(/，原结果已保留，请重新生成$/, '') }); }
  const shotData = Array.isArray(parsed?.shots) ? parsed.shots : [];
  if (!shotData.length) issues.push({ part: 'shots', message: '逐镜提示词尚未完整返回。' });
  let previous = 0;
  const formatted = shotData.map((shot, index) => {
    const prompt = typeof shot?.prompt === 'string' ? shot.prompt : '';
    try {
      if (!Number.isFinite(shot?.start) || !Number.isFinite(shot?.end) || shot.start < 0 || shot.end <= shot.start || Math.abs(shot.start - previous) > 0.15 || (Number.isFinite(duration) && shot.end > duration + 0.15)) throw new Error('起止时间或与相邻镜头的衔接需要核对');
      const localized = localizeShotPrompt(prompt, shot.start, shot.end);
      const [valid] = validateShotPrompts([{ start: 0, end: shot.end - shot.start, prompt: localized }], shot.end - shot.start);
      return `【分镜 ${index + 1}｜${shot.start}–${shot.end}秒】\n${formatPromptTimeline(valid.prompt)}`;
    } catch (error) {
      issues.push({ part: 'shot', index, message: `分镜 ${index + 1}：${error.message.replace(/，原结果已保留，请重新生成$|，请重新生成$/g, '')}` });
      return `【分镜 ${index + 1}｜${Number.isFinite(shot?.start) && Number.isFinite(shot?.end) ? `${shot.start}–${shot.end}秒` : '时间待核对'}】\n${prompt || '（本镜提示词尚未返回，可补生成）'}`;
    } finally { if (Number.isFinite(shot?.end)) previous = shot.end; }
  }).join('\n\n');
  if (Number.isFinite(duration) && Math.abs(previous - duration) > 0.15) issues.push({ part: 'shots', message: '逐镜时间尚未覆盖原片实际长度。' });
  return { full: full ? formatPromptTimeline(full) : '', shots: formatted, rawOutput, shotData, quality: partialQuality(issues) };
}

export function retainPartial(output, message, part = 'stage') {
  return { ...output, quality: partialQuality([...(output.quality?.issues || []), { part, message }]) };
}

export function mergeRepairedReverse(previous, patch, duration) {
  const issues = previous.quality?.issues || [];
  const targets = new Set(issues.filter(issue => issue.part === 'shot').map(issue => issue.index));
  const allShots = issues.some(issue => ['shots', 'structure'].includes(issue.part));
  const shotData = [...(previous.shotData || [])];
  for (const shot of Array.isArray(patch.shots) ? patch.shots : []) {
    const index = shot.index;
    if (!Number.isInteger(index) || index < 0 || (!allShots && !targets.has(index))) continue;
    // A partial repair cannot rewrite an already accepted, unrelated shot.
    if (allShots && shotData[index] && !targets.has(index)) continue;
    shotData[index] = { start: shot.start, end: shot.end, prompt: shot.prompt };
  }
  const full = issues.some(issue => ['full', 'structure'].includes(issue.part)) && typeof patch.full === 'string' ? patch.full : previous.full;
  return recoverReverseVideoOutput(JSON.stringify({ full, shots: shotData }), duration);
}
