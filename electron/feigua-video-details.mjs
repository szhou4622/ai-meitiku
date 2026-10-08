import { feiguaVideoLink, feiguaProductLink } from './feigua-links.mjs';

export const VIDEO_DETAIL_ENDPOINTS = Object.freeze({
  main: '/api/v3/aweme/detail/detail/mainPart',
  products: '/api/v3/aweme/detail/detail/promotions',
});

export function videoPublishedDate(value) {
  const match = String(value || '').match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s|$)/);
  return match ? match[1] + match[2].padStart(2, '0') + match[3].padStart(2, '0') : null;
}

export function observeVideoDetailRequest(details, origin) {
  try {
    const url = new URL(details.url);
    if (details.method !== 'GET' || url.origin !== origin || !Object.values(VIDEO_DETAIL_ENDPOINTS).includes(url.pathname)) return null;
    if (url.searchParams.getAll('awemeId').length !== 1 || url.searchParams.getAll('dateCode').length !== 1) return null;
    return { endpoint: url.pathname, videoId: url.searchParams.get('awemeId'), dateCode: url.searchParams.get('dateCode') };
  } catch { return null; }
}

// Executes in the provider page. Signed parameters stay here and never cross
// IPC, enter the local result store, or appear in diagnostics.
export async function readVideoDetailsApi({ videoId, dateCode }) {
  const endpoints = ['/api/v3/aweme/detail/detail/mainPart', '/api/v3/aweme/detail/detail/promotions'];
  const api = document.querySelector('#app')?.__vue__?.$api;
  const visible = node => Boolean(node.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
  if (!api || [...document.querySelectorAll('.purview-mask-layer')].some(visible)) return { state: 'restricted' };
  const responses = [];
  for (const endpoint of endpoints) {
    const records = performance.getEntriesByType('resource').map(record => {
      try { return new URL(record.name); } catch { return null; }
    }).filter(url => url?.origin === location.origin && url.pathname === endpoint && url.searchParams.get('awemeId') === videoId && url.searchParams.get('dateCode') === dateCode);
    const observed = records.at(-1);
    const models = Object.values(api).flatMap(group => Object.values(group || {})).filter(model => model?.url === endpoint && typeof model.GET === 'function');
    if (!observed || models.length !== 1) return { state: 'lookup_failed' };
    const allowed = endpoint === endpoints[0] ? ['awemeId', 'dateCode', 'sign', 'ts', '_'] : ['awemeId', 'dateCode', '_'];
    if ([...observed.searchParams.keys()].some(key => !allowed.includes(key)) || allowed.some(key => observed.searchParams.getAll(key).length > 1)) return { state: 'lookup_failed' };
    const params = Object.fromEntries([...observed.searchParams].filter(([key]) => key !== '_'));
    let response;
    try { response = await models[0].GET({ params }); }
    catch (error) {
      const status = Number(error?.response?.status || error?.status);
      return { state: status === 401 ? 'auth_required' : status === 403 ? 'restricted' : status === 429 ? 'rate_limited' : 'lookup_failed' };
    }
    if (response?.Code === 401) return { state: 'auth_required' };
    if (response?.Code === 430) return { state: 'verification_required' };
    if (response?.Code === 403 && [0, '0'].includes(response?.Data?.Remainder)) return { state: 'quota_exhausted' };
    if (response?.Code === 429) return { state: 'rate_limited' };
    if (response?.Code !== 200 || response.Status !== true || response.ExampleData || response.Data?.ExampleData) return { state: 'restricted' };
    responses.push(response.Data);
  }
  const [main, products] = responses;
  if (String(main?.AwemeId) !== videoId || String(main?.DateCode) !== dateCode || !Array.isArray(products) || products.length > 30) return { state: 'lookup_failed' };
  const scalar = value => ['string', 'number', 'boolean'].includes(typeof value) || value === null ? value : null;
  return { state: 'verified', videoId, dateCode, videoUrl: scalar(main.VideoUrl), playsText: scalar(main.PlayCountStr), playsCount: scalar(main.PlayCount),
    products: products.map(row => ({ id: row.Goods?.Gid == null ? null : String(row.Goods.Gid), title: scalar(row.Goods?.Title), commission: scalar(row.Goods?.CosRatio), hasCommission: scalar(row.Goods?.HasCos), url: scalar(row.Goods?.PromotionLink) })) };
}

const count = value => {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? String(value) : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return /^(?:\d+(?:\.\d+)?)(?:[,\d]*)(?:万|亿|[wW])?$/.test(text) ? text : null;
};
const commission = value => typeof value === 'string' && /^\d+(?:\.\d+)?%$/.test(value.trim()) && Number(value.trim().slice(0, -1)) <= 100 ? value.trim() : null;

export function enrichVideoRow(row, detail) {
  const clean = structuredClone(row);
  clean.fieldAvailability = { ...clean.fieldAvailability };
  if (detail?.state !== 'verified' || detail.videoId !== String(row.id) || detail.dateCode !== videoPublishedDate(row.publishedAt)) {
    const state = ['restricted', 'auth_required', 'quota_exhausted', 'rate_limited'].includes(detail?.state) ? 'restricted' : 'lookup_failed';
    if (!clean.plays) clean.fieldAvailability.plays = state;
    if (clean.products?.some(product => !product.commission)) clean.fieldAvailability.commission = state;
    return clean;
  }
  clean.videoUrl = feiguaVideoLink(clean.videoUrl, row.id) || feiguaVideoLink(detail.videoUrl, row.id);
  if (!clean.plays) {
    // A raw zero with no formatted display value is the provider's placeholder.
    const plays = count(detail.playsText) || (Number(detail.playsCount) > 0 ? count(detail.playsCount) : null);
    if (plays !== null) { clean.plays = plays; clean.playsScope = 'detail-total'; delete clean.fieldAvailability.plays; }
    else clean.fieldAvailability.plays = 'source_unavailable';
  }
  const products = (detail.products || []).filter(product => typeof product.id === 'string' && product.id && typeof product.title === 'string' && product.title);
  const knownIds = (row.products || []).map(product => product.id).filter(id => id && id !== '0');
  const enough = products.length >= Math.max(1, Number(row.productCount) || 1);
  if (enough && (!knownIds.length || knownIds.every(id => products.some(product => product.id === id)))) {
    clean.products = products.map(product => {
      const previous = (row.products || []).find(item => item.id === product.id);
      // Display a source-provided 0.00% verbatim, including when HasCos is false.
      // Preserve that flag so the UI doesn't imply an available promotion.
      const ratio = commission(product.commission);
      return { id: product.id, title: product.title, commission: previous?.commission || ratio, url: feiguaProductLink(product.url) || feiguaProductLink(previous?.url),
        hasCommission: previous?.commission ? previous.hasCommission : product.hasCommission,
        commissionAvailability: previous?.commission || ratio ? product.hasCommission === false ? 'source_display_only' : 'available' : 'source_unavailable' };
    });
    clean.productsIncomplete = false;
    if (clean.products.some(product => !product.commission)) clean.fieldAvailability.commission = 'source_unavailable';
    else delete clean.fieldAvailability.commission;
  } else if (clean.products?.some(product => !product.commission) || clean.productsIncomplete) clean.fieldAvailability.commission = 'lookup_failed';
  clean.detailProvenance = { transport: 'provider-api', dateCode: detail.dateCode, endpoints: Object.values(VIDEO_DETAIL_ENDPOINTS) };
  return clean;
}
