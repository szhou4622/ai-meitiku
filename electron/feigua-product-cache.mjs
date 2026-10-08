import { feiguaProductLink } from './feigua-links.mjs';

const list = value => Array.isArray(value) ? value : [];
const groupsIn = data => [
  ...list(data.runs).flatMap(run => list(run?.groups)),
  ...list(data.latestResults), ...list(data.videoHistory),
].filter(group => group && typeof group === 'object');
const productsIn = row => list(row?.products).slice(0, 30).filter(product => product && typeof product === 'object');
const productId = value => typeof value === 'string' && value.trim() === value && value.length <= 160 && value !== '0' ? value : '';
const videoId = value => typeof value === 'string' && /^\d{6,25}$/.test(value) ? value : '';
const commissionRate = value => typeof value === 'string' && /^\d+(?:\.\d+)?%$/.test(value) && Number(value.slice(0,-1)) <= 100 ? value : null;
const verifiedAt = (value, fallback) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= fallback ? Date.parse(value) : fallback;
function scope(result) {
  if (result?.provenance?.transport !== 'provider-api' || result.provenance.responseCode !== 200
    || result.provenance.endpoint !== '/api/v1/aweme/search/listwith' || !Array.isArray(result.rows)) return null;
  const at = Date.parse(result.collectedAt);
  try {
    const url = new URL(result.sourceUrl);
    if (!Number.isFinite(at) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return { origin: url.origin, at };
  } catch { return null; }
}
const keyFor = (origin, row, product) => videoId(row.id) && productId(product.id)
  ? JSON.stringify([origin, row.id, product.id]) : null;

function productIndex(data) {
  const index = new Map();
  for (const group of groupsIn(data)) {
    if (group.kind !== 'videos' || group.status !== 'completed') continue;
    const source = scope(group.result);
    if (!source) continue;
    for (const row of group.result.rows.slice(0, 5)) for (const product of productsIn(row)) {
      const key = keyFor(source.origin, row, product), url = feiguaProductLink(product.url), commission = commissionRate(product.commission);
      if (!key || !url && !commission) continue;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ url, at: source.at, urlVerifiedAt: verifiedAt(product.urlVerifiedAt, source.at), destination: url ? new URL(url).searchParams.get('id') : null,
        commission, commissionVerifiedAt: verifiedAt(product.commissionVerifiedAt, source.at), hasCommission: product.hasCommission });
    }
  }
  return index;
}

function fillMissing(result, index) {
  const target = scope(result);
  if (!target) return 0;
  let restored = 0;
  for (const row of result.rows.slice(0, 5)) for (const product of productsIn(row)) {
    const key = keyFor(target.origin, row, product);
    const candidates = (index.get(key) || []).filter(link => link.at <= target.at);
    // A new destination or explicit rate (including 0.00%) always wins.
    const links = candidates.filter(link => link.url);
    if ((product.url == null || product.url === '') && links.length && new Set(links.map(link => link.destination)).size === 1) {
      const known = links.reduce((best, link) => link.at > best.at ? link : best);
      product.url = known.url;
      product.urlVerifiedAt = new Date(known.urlVerifiedAt).toISOString();
      restored++;
    }
    const rates = candidates.filter(item => item.commission);
    if ([null, undefined, '', '--', '-'].includes(product.commission) && rates.length) {
      const latest = Math.max(...rates.map(item => item.commissionVerifiedAt));
      const known = rates.filter(item => item.commissionVerifiedAt === latest);
      if (new Set(known.map(item => Number(item.commission.slice(0,-1)))).size === 1) {
        product.commission = known[0].commission;
        product.commissionVerifiedAt = new Date(latest).toISOString();
        if (product.hasCommission == null && typeof known[0].hasCommission === 'boolean') product.hasCommission = known[0].hasCommission;
        restored++;
      }
    }
  }
  return restored;
}

// Reuse verified fields only for the same source, video and product identity.
// Cached commission rates carry their original date and are labelled in the UI.
// Current titles, rankings, sales metrics and collection dates are unchanged.
export function retainProductFields(result, previousState) {
  const retained = structuredClone(result);
  fillMissing(retained, productIndex(previousState));
  return retained;
}

// Repair earlier partial captures before the service exposes its loaded state.
// The caller must persist this copy successfully before publishing it.
export function restoreProductFieldsInState(stored) {
  const data = structuredClone(stored), index = productIndex(stored);
  let restored = 0;
  for (const group of groupsIn(data)) {
    if (group.kind === 'videos' && group.status === 'completed') restored += fillMissing(group.result, index);
  }
  return { data, changed: restored > 0 };
}
