import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const T2S_DICTIONARY_FILE = fileURLToPath(new URL(
  './text-conversion/t2s-map.json', import.meta.url,
));

let cachedDictionary;

function dictionary() {
  if (cachedDictionary) return cachedDictionary;
  const payload = JSON.parse(fs.readFileSync(T2S_DICTIONARY_FILE, 'utf8'));
  if (payload?.schemaVersion !== 1 || payload?.source?.project !== 'OpenCC'
    || !payload.phrases || !payload.characters) {
    throw new Error('内置繁简转换字典缺失或损坏。');
  }
  const phraseBuckets = new Map();
  for (const [source, target] of Object.entries(payload.phrases)) {
    if (!source || !target) continue;
    const bucket = phraseBuckets.get(source[0]) || [];
    bucket.push([source, target]);
    phraseBuckets.set(source[0], bucket);
  }
  for (const bucket of phraseBuckets.values()) bucket.sort((a, b) => b[0].length - a[0].length);
  cachedDictionary = { phraseBuckets, characters: new Map(Object.entries(payload.characters)), source: payload.source };
  return cachedDictionary;
}

/** Deterministic, offline Traditional Chinese -> Simplified Chinese conversion. */
export function traditionalToSimplified(value) {
  const input = String(value ?? '');
  if (!input) return input;
  const { phraseBuckets, characters } = dictionary();
  let output = '';
  for (let offset = 0; offset < input.length;) {
    let matched = false;
    for (const [source, target] of phraseBuckets.get(input[offset]) || []) {
      if (!input.startsWith(source, offset)) continue;
      output += target;
      offset += source.length;
      matched = true;
      break;
    }
    if (matched) continue;
    const codePoint = String.fromCodePoint(input.codePointAt(offset));
    output += characters.get(codePoint) || codePoint;
    offset += codePoint.length;
  }
  return output;
}

export function t2sDictionaryInfo() {
  return { ...dictionary().source };
}
