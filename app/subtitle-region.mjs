// Convert pointer coordinates into the normalized rectangle required by VIAPI.
export function subtitlePoint(clientX, clientY, bounds) {
  if (!(bounds.width > 0 && bounds.height > 0)) return null;
  return {
    x: Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (clientY - bounds.top) / bounds.height)),
  };
}
export function subtitleRectangle(start, end) {
  if (!start || !end) return null;
  return {
    BX: Math.min(start.x, end.x), BY: Math.min(start.y, end.y),
    BW: Math.abs(end.x - start.x), BH: Math.abs(end.y - start.y),
  };
}
