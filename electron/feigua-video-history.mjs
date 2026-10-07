// Source periods remain seven days; weekly archives use Monday labels in Beijing.
export function videoCollectionWeek(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const beijing = new Date(timestamp + 8 * 3600000);
  const monday = new Date(Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate() - (beijing.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

// Never relabel a rolling source period as a calendar week.
export function videoRankingPeriod(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4}-\d{2}-\d{2}) - (\d{4}-\d{2}-\d{2})$/);
  if (!match) return null;
  const start = Date.parse(match[1]), end = Date.parse(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || new Date(start).toISOString().slice(0, 10) !== match[1] || new Date(end).toISOString().slice(0, 10) !== match[2] || end - start !== 6 * 86400000) return null;
  return value;
}

// Preserve weekly results independently of the twelve recent task attempts.
// A failed refresh cannot overwrite a saved result, including an empty ranking.
export function recoverVideoHistory(runs = [], cached = [], history = []) {
  const found = new Map();
  const candidates = [...runs.flatMap(run => run.groups || []), ...cached, ...history]
    .filter(group => group.kind === 'videos' && group.status === 'completed' && group.result && Array.isArray(group.result.rows) && Number.isFinite(Date.parse(group.result.collectedAt)) && videoRankingPeriod(group.result.dateRange))
    .sort((a, b) => Date.parse(b.result.collectedAt) - Date.parse(a.result.collectedAt));
  const periods = new Set();
  for (const group of candidates) {
    const period = videoCollectionWeek(group.result.collectedAt);
    if (!periods.has(period) && periods.size >= 52) continue;
    periods.add(period);
    const key = JSON.stringify([period, group.keyword]);
    if (!found.has(key)) found.set(key, group);
  }
  return [...found.values()];
}

export function videoHistoryPeriods(history, keywords) {
  return [...new Set(history.filter(group => keywords.includes(group.keyword)).map(group => videoCollectionWeek(group.result.collectedAt)))].filter(Boolean).sort().reverse();
}

export function videoGroupsForPeriod(history, selectedPeriod, latestGroups, keywords) {
  if (!selectedPeriod) return latestGroups.filter(group => group.kind === 'videos' && keywords.includes(group.keyword));
  return keywords.map(keyword => history.find(group => group.keyword === keyword && videoCollectionWeek(group.result.collectedAt) === selectedPeriod))
    .filter(Boolean).map(group => ({ ...group, showingPrevious: false, refreshStatus: undefined, refreshMessage: undefined }));
}
