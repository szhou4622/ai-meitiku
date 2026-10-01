export function toggleMarqueeSelection(selectedIds, hitIds) {
  const selected = new Set(selectedIds);
  const hits = new Set(hitIds);
  const next = selectedIds.filter((id) => !hits.has(id));

  for (const id of hitIds) {
    if (!selected.has(id)) next.push(id);
  }

  return next;
}
