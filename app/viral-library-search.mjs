export function matchesViralLibrarySearch(query, values) {
  const normalize = (value) => String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const needle = normalize(query);
  if (!needle) return true;
  return values.some((value) => {
    const haystack = normalize(value);
    if (haystack.includes(needle)) return true;
    let offset = 0;
    for (const character of needle) {
      offset = haystack.indexOf(character, offset);
      if (offset < 0) return false;
      offset += 1;
    }
    return true;
  });
}
