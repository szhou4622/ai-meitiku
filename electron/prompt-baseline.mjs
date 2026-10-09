/** @param {{source?: unknown, reverse?: {full: string, shots: string} | null, variants: {restore: {full: string, shots: string}}}} item */
export function promptBaseline(item) {
  if (item.reverse?.full?.trim()) return item.reverse;
  if (!item.source && item.variants.restore.full.trim()) return item.variants.restore;
  return null;
}
