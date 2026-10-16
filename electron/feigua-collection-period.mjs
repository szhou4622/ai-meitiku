// Shared Beijing calendar for category Top5 and monitored shops.
export const COLLECTION_WEEK_LABEL = '本周周一至昨天';
export function currentCollectionWeek(now = Date.now()) {
  const local = new Date(now + 8 * 3_600_000);
  const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const weekday = new Date(today).getUTCDay() || 7;
  if (weekday === 1) return null;
  return { start: new Date(today - (weekday - 1) * 86_400_000).toISOString().slice(0, 10), end: new Date(today - 86_400_000).toISOString().slice(0, 10) };
}
export function collectionUpdateDate(now = Date.now()) {
  const local = new Date(now + 8 * 3_600_000);
  return currentCollectionWeek(now) && local.getUTCHours() >= 7 ? local.toISOString().slice(0, 10) : null;
}
export function isCollectionWeek(period) {
  const valid = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  return !!period && valid(period.start) && valid(period.end) && new Date(period.start).getUTCDay() === 1 && period.end >= period.start && Date.parse(period.end) - Date.parse(period.start) <= 6 * 86_400_000;
}
