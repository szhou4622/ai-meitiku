export const SUBTITLE_DRAFT_KEY = 'subtitle-batch-draft-v1';
export const DEFAULT_SUBTITLE_REGION = { BX: 0, BY: .75, BW: 1, BH: .25 };
export const subtitlePathKey = value => {
  const key = String(value || '').replaceAll('\\', '/');
  return /^[a-z]:\//i.test(key) ? key.toLowerCase() : key;
};
export function validSubtitleRegion(region) {
  return !!region && ['BX', 'BY', 'BW', 'BH'].every(key => typeof region[key] === 'number' && Number.isFinite(region[key]) && region[key] >= 0 && region[key] <= 1)
    && region.BW > 0 && region.BH > 0 && region.BX + region.BW <= 1.000001 && region.BY + region.BH <= 1.000001;
}
export function applySubtitleRegion(entries, region, lockedIds = []) {
  if (!validSubtitleRegion(region)) throw new Error('字幕区域必须在画面内，宽度和高度必须大于 0');
  const locked = new Set(lockedIds);
  return entries.map(entry => locked.has(entry.id) ? entry : { ...entry, region: { ...region }, regionMode: 'shared' });
}
export function parseSubtitleDraft(raw) {
  if (!raw) return { entries: [], activeId: '', output: '', sync: false };
  const draft = JSON.parse(raw);
  if (draft.version !== 1 || !Array.isArray(draft.entries) || draft.entries.length > 200) throw new Error('去字幕草稿无法读取，原草稿已保留');
  const seen = new Set();
  const entries = draft.entries.filter(entry => {
    if (!entry || typeof entry.id !== 'string' || typeof entry.path !== 'string' || !/^(?:\/|[a-z]:[\\/])/i.test(entry.path)) return false;
    const key = subtitlePathKey(entry.path);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(entry => ({ ...entry, url: '', checked: entry.checked !== false,
    region: validSubtitleRegion(entry.region) ? { ...entry.region } : { ...DEFAULT_SUBTITLE_REGION }, regionMode: entry.regionMode || 'default' }));
  return { entries, activeId: entries.some(entry => entry.id === draft.activeId) ? draft.activeId : entries[0]?.id || '',
    output: typeof draft.output === 'string' ? draft.output : '', sync: draft.sync === true };
}
export function serializeSubtitleDraft(draft) {
  return JSON.stringify({ ...draft, version: 1, entries: draft.entries.map(({ url, ...entry }) => entry) });
}
