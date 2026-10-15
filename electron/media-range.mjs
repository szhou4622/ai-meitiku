// Return null for unsupported/malformed Range headers (serve the full file).
// An unsatisfiable valid byte range must return 416, never a clamped last byte.
export function mediaByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return { unsatisfiable: true };
  if (size <= 0) return { unsatisfiable: true };
  if (first === null) {
    if (last === 0) return { unsatisfiable: true };
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  if (first >= size || (last !== null && last < first)) return { unsatisfiable: true };
  return { start: first, end: last === null ? size - 1 : Math.min(last, size - 1) };
}
