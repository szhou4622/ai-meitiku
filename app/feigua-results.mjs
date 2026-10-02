// The latest view shows already-collected data even while a refresh is pending
// or fails. An explicitly selected history batch is always shown verbatim.
export function displayedFeiguaGroups(runs, selectedRunId = '', cachedGroups = []) {
  if (selectedRunId) return runs.find(run => run.id === selectedRunId)?.groups || [];
  const latest = new Map();
  const results = new Map();
  const sources = [...runs, ...cachedGroups.map(group => ({ id: group.sourceRunId || 'saved-result', groups: [group] }))];
  for (const run of sources) {
    for (const group of run.groups || []) {
      const key = JSON.stringify([group.kind, group.keyword || null]);
      if (!latest.has(key)) latest.set(key, { group, runId: run.id });
      if (!results.has(key) && group.result && Array.isArray(group.result.rows)) {
        const attempt = latest.get(key).group;
        results.set(key, { ...group, showingPrevious: latest.get(key).runId !== run.id,
          refreshStatus: attempt.status, refreshMessage: attempt.message, requestedMusicTag: attempt.musicTag });
      }
    }
  }
  return [...latest].map(([key, value]) => results.get(key) || value.group);
}
