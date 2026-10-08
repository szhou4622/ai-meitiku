import { validateCaptureDates } from './feigua-contract.mjs';

const DAY = 86400000, BEIJING = 8 * 3600000, NINE = 9 * 3600000;
const isoDay = timestamp => new Date(timestamp).toISOString().slice(0, 10);

// A publication is a closed Monday-Sunday week, never a rolling seven-day range.
export function settledTopicPeriod(value, now = Date.now()) {
  try {
    const range = validateCaptureDates('topics', value, now).dateRange;
    const [start, end] = range.split(' - ').map(Date.parse);
    const today = Math.floor((now + BEIJING) / DAY) * DAY;
    return new Date(start).getUTCDay() === 1 && new Date(end).getUTCDay() === 0 && end < today ? range : null;
  } catch { return null; }
}

export function topicScheduleSlot(now = Date.now()) {
  const local = now + BEIJING, today = Math.floor(local / DAY) * DAY;
  const monday = today - (new Date(today).getUTCDay() + 6) % 7 * DAY;
  if (local < monday + NINE) return null;
  // Opening Tuesday before 09:00 can catch up Monday's missed check, while an
  // already attempted Monday check still waits until Tuesday 09:00.
  const slot = isoDay(local - today >= NINE ? today : today - DAY);
  return { slot, expectedPeriod: `${isoDay(monday - 7 * DAY)} - ${isoDay(monday - DAY)}`, checkedAt: new Date(now).toISOString() };
}

export function pendingTopicCheck(data, now = Date.now(), { ignorePreviousCheck = false } = {}) {
  const plan = topicScheduleSlot(now);
  if (!plan) return null;
  const category = JSON.stringify(data.musicTag || []);
  const completed = (data.latestResults || []).some(group => group.kind === 'topics' && group.status === 'completed'
    && Array.isArray(group.result?.rows) && group.result?.period === '周榜'
    && settledTopicPeriod(group.result.dateRange, now) === plan.expectedPeriod
    && JSON.stringify(group.result.filters?.categoryPath || group.musicTag || []) === category);
  if (completed) return null;
  const previous = data.lastTopicsCheck;
  if (!ignorePreviousCheck && previous?.expectedPeriod === plan.expectedPeriod && previous.slot >= plan.slot && JSON.stringify(previous.musicTag || []) === category) return null;
  return { ...plan, musicTag: [...(data.musicTag || [])] };
}
