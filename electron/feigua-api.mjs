import { FEIGUA_SOURCES, isFeiguaDataUrl, validateCaptureDates, isRankingMetric } from './feigua-contract.mjs';
import { feiguaVideoLink, feiguaProductLink } from './feigua-links.mjs';

// Observed from the logged-in site's own GET requests, not guessed API routes.
export const FEIGUA_ENDPOINTS = Object.freeze({
  music: '/api/v1/music/search/page',
  topics: '/api/v3/topicrank/getDyTopicRankData',
  hotspots: '/api/v3/hotrank/getDyHotRankData',
  videos: '/api/v1/aweme/search/listwith',
});
const allowedParameters = new Set(['pageIndex', 'pageSize', 'pageType', 'filter.sort', 'sortField', 'order', 'topicRankType', 'period', 'dateCode', 'rankType',
  'q.keyword', 'q.keywordType', 'q.mSearchType', 'q.tagMode', 'q.sort', 'q.searchType', 'q.dateFrom', 'q.dateTo']);
const categoryParameter = key => /^(?:filter\.|q\.)?(?:[\w]*tag[\w]*|[\w]*category[\w]*)$/i.test(key) && key !== 'q.tagMode';
const problem = message => Object.assign(new Error(message), { publicMessage: message, code: 'FEIGUA_API_INVALID' });

export function observeFeiguaRequest(details, sourceOrigin = null) {
  if (details.method !== 'GET' || !isFeiguaDataUrl(details.url, sourceOrigin)) return null;
  const url = new URL(details.url);
  const kind = Object.keys(FEIGUA_ENDPOINTS).find(kind => FEIGUA_ENDPOINTS[kind] === url.pathname);
  if (!kind) return null;
  const params = {};
  for (const [key, value] of url.searchParams) {
    if (key === '_') continue;
    if (Object.hasOwn(params, key) || !allowedParameters.has(key) && !categoryParameter(key)) return { kind, invalid: true };
    params[key] = value;
  }
  return { kind, endpoint: url.pathname, params };
}

export function validateFeiguaRequest(kind, request, context) {
  if (!request || request.invalid || request.kind !== kind || request.endpoint !== FEIGUA_ENDPOINTS[kind]) throw problem('未监听到本组可核验的飞瓜接口请求');
  const p = request.params;
  const scopedKeys = {
    music: ['filter.sort'], topics: ['sortField', 'order', 'topicRankType', 'period', 'dateCode'],
    hotspots: ['rankType', 'period', 'dateCode'],
    videos: ['q.keyword', 'q.keywordType', 'q.mSearchType', 'q.tagMode', 'q.sort', 'q.searchType', 'q.dateFrom', 'q.dateTo'],
  }[kind];
  const allowed = new Set(['pageIndex', 'pageSize', 'pageType', ...scopedKeys]);
  if (Object.keys(p).some(key => !allowed.has(key) && !(kind !== 'hotspots' && categoryParameter(key)))) throw problem('接口包含不属于当前榜单的筛选参数');
  const requireValues = values => {
    if (Object.entries(values).some(([key, value]) => p[key] !== String(value))) throw problem('接口请求与本组的关键词、周期或排序不一致');
  };
  requireValues({ pageIndex: 1, pageType: 1 });
  if (!/^\d+$/.test(p.pageSize) || Number(p.pageSize) < 5 || Number(p.pageSize) > 100) throw problem('接口分页范围无法核验');
  if (context.filtersVerified !== true || context.period !== FEIGUA_SOURCES[kind].period) throw problem('页面筛选尚未核验');
  if (kind === 'music') requireValues({ 'filter.sort': 1 });
  if (kind === 'topics') {
    requireValues({ sortField: 'UserCountIncRatioStr', order: 1, topicRankType: 0, period: 'week' });
    const dates = validateCaptureDates(kind, context.dateRange).dateRange.split(' - ').map(date => date.replaceAll('-', ''));
    if (p.dateCode && ![dates[0], dates.join('-')].includes(p.dateCode.replaceAll('/', '').replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1$2$3'))) throw problem('接口周榜日期与页面选择不一致');
  }
  if (kind === 'hotspots') requireValues({ rankType: 1, period: 'day', dateCode: validateCaptureDates(kind, context.dateRange).dateRange.replaceAll('-', '') });
  if (kind === 'videos') {
    const dates = validateCaptureDates(kind, context.dateRange).dateRange.split(' - ');
    requireValues({ 'q.keyword': context.keyword, 'q.keywordType': 0, 'q.mSearchType': 2, 'q.tagMode': 0, 'q.sort': 8, 'q.searchType': 2, 'q.dateFrom': dates[0], 'q.dateTo': dates[1] });
  }
  const categoryValues = Object.entries(p).filter(([key]) => categoryParameter(key));
  const checkCategory = (path, id, pattern) => {
    const values = categoryValues.filter(([key]) => pattern.test(key)).flatMap(([, value]) => value.split(/[,|]/)).filter(value => value && value !== '0' && value !== '-1');
    if (path?.length ? !values.includes(String(id)) : values.length > 0) throw problem('接口分类参数与页面实际分类不一致');
  };
  if (['music', 'topics'].includes(kind)) checkCategory(context.musicTag, context.musicTagId, /tag|category/i);
  if (kind === 'videos') { checkCategory(context.categoryPath, context.categoryId, /category/i); checkCategory(context.tagPath, context.tagId, /tag/i); }
  return request;
}

// Runs inside the provider page. Reuse its normal client for authentication and
// response decoding; never export credentials or change permission flags.
export async function readFeiguaApi({ endpoint, params }) {
  const endpoints = ['/api/v1/music/search/page', '/api/v3/topicrank/getDyTopicRankData', '/api/v3/hotrank/getDyHotRankData', '/api/v1/aweme/search/listwith'];
  if (!endpoints.includes(endpoint)) return { error: '飞瓜接口不在采集白名单内' };
  const api = document.querySelector('#app')?.__vue__?.$api;
  if (!api) return { error: '未找到飞瓜当前页面的接口客户端' };
  const models = Object.values(api).flatMap(group => Object.values(group || {})).filter(model => model?.url === endpoint && typeof model.GET === 'function');
  if (models.length !== 1) return { error: '无法唯一定位飞瓜榜单接口客户端' };
  let response;
  try { response = await models[0].GET({ params }); }
  catch (error) {
    const status = Number(error?.response?.status || error?.status);
    if (status === 401) return { error: '飞瓜登录已失效，请重新登录', errorCode: 'FEIGUA_AUTH_REQUIRED' };
    if (status === 403) return { error: '当前账号访问权限不足，请核对登录及权限', errorCode: 'FEIGUA_PERMISSION' };
    if (status === 429) return { error: '飞瓜请求频率受限，请稍后再采集', errorCode: 'FEIGUA_RATE_LIMIT' };
    if ([500, 502, 503, 504].includes(status) || ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT', 'ERR_INTERNET_DISCONNECTED', 'ERR_CONNECTION_RESET'].includes(error?.code) || /^(Failed to fetch|Network Error)$/i.test(error?.message || '')) return { error: '飞瓜网络或服务暂时不可用', errorCode: 'FEIGUA_NETWORK' };
    return { error: '飞瓜接口请求未完成，请核对页面后重试', errorCode: 'FEIGUA_API_INVALID' };
  }
  const scalar = value => ['string', 'number', 'boolean'].includes(typeof value) || value === null ? value : null;
  const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, scalar(object?.[key])]));
  const data = response?.Data;
  const list = Array.isArray(data?.List) ? data.List : Array.isArray(data?.AwemeList) ? data.AwemeList : null;
  return { code: response?.Code, success: response?.Status, exampleData: Boolean(response?.ExampleData || data?.ExampleData), data: {
    ...pick(data, ['Total', 'PageIndex', 'TimeRangeStr', 'UpdateTime', 'Remainder', 'AllowCount']),
    list: list && list.length <= 100 ? list.map(row => ({
      ...pick(row, ['MusicId', 'Title', 'Author', 'UserCount', 'TodayUserCount', 'DetailUrl', 'TopicId', 'RankNum', 'ViewCountIncRatioStr', 'UserCountIncRatioStr', 'HotId', 'Rank', 'HotValueStr', 'AwemeId', 'VideoUrl', 'Desc', 'BloggerNickName', 'Fans', 'PlayCount', 'LikeCount', 'CommentCount', 'ShareCount', 'CollectCount', 'SalesGmv', 'SaleCount', 'PubTimeStr', 'IsHasProduct']),
      topic: pick(row.BaseTopicDto, ['TopicName', 'TopicFullDetailUrl']),
      blogger: pick(row.BaseBloggerDto, ['BloggerName', 'MPlatform_Fans', 'Fans']),
      product: pick(row.ExtInfo, ['Gid', 'Title', 'Name', 'CosRatioShow', 'PromotionsCount', 'PromotionUrl']),
    })) : null,
  } };
}

const shown = value => value === null || value === undefined || value === '' || value === '--' || value === '-' ? null : String(value);
const link = (value, base) => { try { const url = new URL(value, base).href; return value && isFeiguaDataUrl(url, new URL(base).origin) ? url : null; } catch { return null; } };

export function captureFeiguaResponse(kind, request, context, response) {
  validateFeiguaRequest(kind, request, context);
  if (response?.code === 401) throw Object.assign(problem('飞瓜登录已失效，请重新登录'), { code: 'FEIGUA_AUTH_REQUIRED' });
  if (response?.code === 429) throw Object.assign(problem('飞瓜请求频率受限，请稍后再采集'), { code: 'FEIGUA_RATE_LIMIT' });
  if (response?.code === 403 && [0, '0'].includes(response.data?.Remainder)) throw Object.assign(problem('飞瓜接口查询额度已用完，本组未更新，保留上次结果'), { code: 'FEIGUA_QUOTA' });
  if (response?.exampleData || response?.ExampleData || response?.data?.ExampleData) throw problem('飞瓜接口返回示例数据，本组未保存，保留上次结果');
  if ([500, 502, 503, 504].includes(response?.code)) throw Object.assign(problem('飞瓜服务暂时不可用，本组将自动重试'), { code: 'FEIGUA_NETWORK' });
  if (response?.code !== 200 || response.success !== true || !Array.isArray(response.data?.list)) throw problem(`飞瓜接口未返回有效榜单数据（返回码 ${Number.isInteger(response?.code) ? response.code : '未知'}），本组未保存`);
  const data = response.data;
  if (data.list.length > Number(request.params.pageSize)) throw problem('接口返回条数超出本次分页范围');
  if (data.PageIndex !== null && data.PageIndex !== undefined && data.PageIndex !== 1) throw problem('接口响应不是第一页，本组未保存');
  if (data.list.length === 0 && data.Total !== 0) throw problem('接口空列表缺少总数为零的确认，本组未保存');
  let dateRange = context.dateRange;
  if (['topics', 'hotspots'].includes(kind) && data.TimeRangeStr) {
    const sourceDate = validateCaptureDates(kind, data.TimeRangeStr).dateRange;
    if (sourceDate !== validateCaptureDates(kind, dateRange).dateRange) throw problem('接口响应的统计日期与页面选择不一致');
    dateRange = sourceDate;
  }
  const rows = data.list.map((row, index) => {
    if (['topics', 'hotspots'].includes(kind) && Number(kind === 'topics' ? row.RankNum : row.Rank) !== index + 1) throw problem('接口来源排名缺失或不是从第一名开始');
    if (kind === 'music') return { id: shown(row.MusicId), url: link(row.DetailUrl, context.url), title: shown(row.Title), author: shown(row.Author), totalUsers: shown(row.UserCount), yesterdayUsers: shown(row.TodayUserCount) };
    if (kind === 'topics') return { id: shown(row.TopicId), url: link(row.topic?.TopicFullDetailUrl, context.url), title: shown(row.topic?.TopicName), author: shown(row.blogger?.BloggerName), followers: shown(row.blogger?.MPlatform_Fans ?? row.blogger?.Fans), participantGrowth: shown(row.UserCountIncRatioStr), playGrowth: shown(row.ViewCountIncRatioStr) };
    if (kind === 'hotspots') return { id: shown(row.HotId), url: null, title: shown(row.Title), peakHeat: shown(row.HotValueStr) };
    return { id: shown(row.AwemeId), url: link(row.DetailUrl, context.url), videoUrl: feiguaVideoLink(row.VideoUrl, row.AwemeId), title: shown(row.Desc), author: shown(row.BloggerNickName), followers: shown(row.Fans), plays: shown(row.PlayCount), likes: shown(row.LikeCount), comments: shown(row.CommentCount), shares: shown(row.ShareCount), collects: shown(row.CollectCount), sales: shown(row.SalesGmv), salesCount: shown(row.SaleCount), publishedAt: shown(row.PubTimeStr),
      products: row.IsHasProduct && shown(row.product?.Title || row.product?.Name) ? [{ id: shown(row.product.Gid), title: shown(row.product.Title || row.product.Name), commission: shown(row.product.CosRatioShow), url: feiguaProductLink(row.product.PromotionUrl) }] : [],
      productCount: Number(row.product?.PromotionsCount) || 0,
      productsIncomplete: Number(row.product?.PromotionsCount) > 1,
    };
  });
  const metric = { music: 'yesterdayUsers', topics: 'participantGrowth', hotspots: 'peakHeat', videos: 'sales' }[kind];
  if (rows.some(row => !isRankingMetric(kind, row[metric]))) throw problem('接口排名字段无效或包含权限提示，本组未保存');
  if (kind === 'hotspots') {
    let previous = Infinity;
    for (const row of rows) {
      const match = row.peakHeat.replaceAll(',', '').match(/^(\d+(?:\.\d+)?)(万|亿|[wW])?$/);
      const heat = match ? Number(match[1]) * (match[2] === '亿' ? 1e8 : match[2] ? 1e4 : 1) : NaN;
      if (!Number.isFinite(heat) || heat > previous) throw problem('接口热点峰值热度未按降序排列');
      previous = heat;
    }
  }
  return { ...context, dateRange, sort: FEIGUA_SOURCES[kind].sort, direction: 'desc', rows, emptyVerified: rows.length === 0 && data.Total === 0,
    provenance: { transport: 'provider-api', endpoint: request.endpoint, method: 'GET', responseCode: response.code, dateCode: request.params.dateCode || null },
  };
}
