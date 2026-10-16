import { isFeiguaDataUrl } from './feigua-contract.mjs';
export const SHOP_ENDPOINTS = Object.freeze({
  search: '/api/v1/shopsearch/list', overview: '/api/v3/focusshopdetails/GetDailyOverview',
  days: '/api/v3/focusshopdetails/GetFocusShopDayList', stat: '/api/v3/focusshopdetails/GetFocusShopDynamicStat',
  trend: '/api/v3/focusshopdetails/GetFocusShopNewGoodsTrends', tops: '/api/v3/focusshopdetails/GetFocusShopNewGoodsTops',
  options: '/api/v3/focusshopdetails/GetFocusShopDynamicSearchItems', events: '/api/v3/focusshopdetails/GetFocusShopDynamicList',
});

export function observeShopRequest(details, origin) {
  try {
    if (!origin || !isFeiguaDataUrl(details.url, origin) || new URL(details.url).origin !== origin) return null;
    const url = new URL(details.url), kind = Object.keys(SHOP_ENDPOINTS).find(k => SHOP_ENDPOINTS[k] === url.pathname);
    if (!kind || details.method !== (kind === 'search' ? 'POST' : 'GET')) return null;
    let params;
    if (kind === 'search') {
      const buffers = (details.uploadData || []).map(item => item.bytes);
      if (!buffers.length || buffers.some(item => !item)) return null;
      const raw = Buffer.concat(buffers).toString('utf8');
      if (raw.length > 2000) return null;
      params = JSON.parse(raw);
    } else {
      params = {};
      for (const [key, value] of url.searchParams) { if (key === '_') continue; if (Object.hasOwn(params, key)) return null; params[key] = value; }
    }
    const allowed = kind === 'search' ? ['period', 'sort', 'keyword', 'page', 'pageSize', 'pageType'] : ['shopId', 'fromDateCode', 'toDateCode', 'periodType', 'TrendPeriod', 'order', 'sortField', 'pageIndex', 'pageSize', 'page', 'dynamicTypes', 'dynamicSubTypes'];
    if (!params || Object.keys(params).some(k => !allowed.includes(k)) || Object.values(params).some(v => !['string', 'number'].includes(typeof v))) return null;
    return { kind, params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) };
  } catch { return null; }
}

// Executes only in the logged-in provider page; no credentials or signed links
// leave this function. POST search is the observed read-only shop search route.
export async function readShopApi({ kind, params }) {
  const paths = { search: '/api/v1/shopsearch/list', overview: '/api/v3/focusshopdetails/GetDailyOverview', days: '/api/v3/focusshopdetails/GetFocusShopDayList', stat: '/api/v3/focusshopdetails/GetFocusShopDynamicStat', trend: '/api/v3/focusshopdetails/GetFocusShopNewGoodsTrends', tops: '/api/v3/focusshopdetails/GetFocusShopNewGoodsTops', options: '/api/v3/focusshopdetails/GetFocusShopDynamicSearchItems', events: '/api/v3/focusshopdetails/GetFocusShopDynamicList' };
  const endpoint = paths[kind];
  if (!endpoint) return { code: 0, error: '店铺接口不在读取白名单内' };
  const api = document.querySelector('#app')?.__vue__?.$api;
  const models = Object.values(api || {}).flatMap(g => Object.values(g || {})).filter(m => m?.url === endpoint && typeof m[kind === 'search' ? 'POST' : 'GET'] === 'function');
  if (models.length !== 1) return { code: 0, error: '飞瓜店铺接口客户端未就绪' };
  let response;
  try { response = kind === 'search' ? await models[0].POST({ data: params, params: { pageType: 1 } }) : await models[0].GET({ params }); }
  catch (error) { return { code: Number(error?.response?.status) || 0, error: '飞瓜店铺请求未完成' }; }
  const scalar = value => typeof value === 'string' ? value.slice(0, 2000) : typeof value === 'number' || typeof value === 'boolean' || value === null ? value : null;
  const pick = (value, fields) => Object.fromEntries(fields.map(k => [k, scalar(value?.[k])]));
  const metrics = ['SalesGmvStr', 'SalesCountStr', 'GoodsCountStr', 'AwemeCountStr', 'LiveCountStr', 'BloggerCountStr', 'NewGoodsCountStr', 'UpdateGoodsCountStr', 'NewBloggerCountStr'];
  const data = response?.Data;
  let clean = null;
  if (kind === 'search') clean = { total: scalar(data?.Total), rows: Array.isArray(data?.ShopDatas) ? data.ShopDatas.slice(0, 10).map(row => ({ id: scalar(row.ShopId), name: scalar(row.ShopName) })) : null };
  if (kind === 'overview' || kind === 'stat') clean = pick(data, metrics);
  if (kind === 'days') clean = { total: scalar(data?.TotalCount), rows: Array.isArray(data?.Items) ? data.Items.slice(0, 32).map(row => ({ DateCode: scalar(row.DateCode), ...pick(row, metrics) })) : null };
  if (kind === 'trend') clean = Array.isArray(data) ? data.slice(0, 7).map(row => ({ date: scalar(row.DateCode), count: scalar(row.NewGoodsCountStr) })) : null;
  if (kind === 'tops') clean = Array.isArray(data) ? data.slice(0, 11).map(row => ({ id: scalar(row.Goods?.Gid), title: scalar(row.Goods?.Title), shopId: scalar(row.Goods?.ShopId), listedAt: scalar(row.Goods?.FirstTimeStr2), sales: scalar(row.SalesGmvStr), salesCount: scalar(row.SalesCountStr) })) : null;
  if (kind === 'options') clean = { subtypes: Array.isArray(data?.UpdateGoods) ? data.UpdateGoods.flatMap(row => (row.SonItems || []).map(item => String(item.Value))).filter(v => /^2\d$/.test(v)) : [] };
  if (kind === 'events') clean = { total: scalar(data?.TotalCount), rows: Array.isArray(data?.Items) ? data.Items.slice(0, 101).map(row => ({ date: scalar(row.DateCode), productId: scalar(row.Goods?.Gid), product: scalar(row.Goods?.Title), creatorId: scalar(row.Blogger?.BloggerUid), creator: scalar(row.Blogger?.BloggerName), fans: scalar(row.Blogger?.MPlatform_Fans ?? row.Blogger?.Fans),
    changes: Array.isArray(row.Items) ? row.Items.slice(0, 30).map(item => ({ type: scalar(item.Type), title: scalar(item.Title), before: typeof item.OldValue === 'string' && !/^https?:/i.test(item.OldValue) ? scalar(item.OldValue) : null, after: typeof item.NewValue === 'string' && !/^https?:/i.test(item.NewValue) ? scalar(item.NewValue) : null })) : null })) : null };
  return { code: scalar(response?.Code), success: response?.Status === true, example: Boolean(response?.ExampleData || data?.ExampleData || data?.IsDemo), quota: response?.Code === 403 && [0, '0'].includes(data?.Remainder), data: clean };
}
