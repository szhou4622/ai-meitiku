const BEIJING = 8 * 3600000;

export function musicCollectionDate(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp + BEIJING).toISOString().slice(0, 10) : null;
}

export function dueMusicDate(now = Date.now()) {
  const local = new Date(now + BEIJING);
  return local.getUTCHours() >= 8 ? local.toISOString().slice(0, 10) : null;
}

// Completion comes from durably saved results, never from an attempted check.
export function pendingMusicCheck(data, now = Date.now(), { ignorePreviousCheck = false } = {}) {
  const date = dueMusicDate(now);
  if (!date) return null;
  const category = JSON.stringify(data.musicTag || []);
  const completed = (data.latestResults || []).some(group => group.kind === 'music' && group.status === 'completed'
    && group.result?.period === '昨日使用人数' && Array.isArray(group.result.rows)
    && musicCollectionDate(group.result.collectedAt) === date
    && JSON.stringify(group.result.filters?.categoryPath || group.musicTag || []) === category);
  if (completed) return null;
  const previous = data.lastMusicCheck;
  if (!ignorePreviousCheck && previous?.date >= date && JSON.stringify(previous.musicTag || []) === category) return null;
  return { date, checkedAt: new Date(now).toISOString(), musicTag: [...(data.musicTag || [])] };
}
