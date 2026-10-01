function normalizedPath(value) {
  return String(value ?? "").trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

function fileName(value) {
  return normalizedPath(value).split("/").pop() || "";
}

export function matchViralVisualCsv(paths, rows) {
  const selections = [...new Set(paths.map((path) => String(path ?? "")).filter(Boolean))];
  const matches = [];
  const unmatched = [];
  const ambiguous = [];
  for (const selectedPath of selections) {
    const exact = rows.filter((row) => normalizedPath(row.matchValue) === normalizedPath(selectedPath));
    const candidates = exact.length ? exact : rows.filter((row) => fileName(row.matchValue) === fileName(selectedPath));
    const sameNameSelections = selections.filter((path) => fileName(path) === fileName(selectedPath));
    if (!exact.length && sameNameSelections.length > 1) {
      ambiguous.push(selectedPath);
    } else if (candidates.length === 1) {
      matches.push({ path: selectedPath, row: candidates[0] });
    } else if (candidates.length > 1) {
      ambiguous.push(selectedPath);
    } else {
      unmatched.push(selectedPath);
    }
  }
  return { matches, unmatched, ambiguous };
}
