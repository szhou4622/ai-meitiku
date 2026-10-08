import { VIDEO_DETAIL_ENDPOINTS } from './feigua-video-details.mjs';
import { feiguaVideoLink, feiguaProductLink } from './feigua-links.mjs';
export const FEIGUA_HOME = 'https://dy.feigua.cn/';
export const FEIGUA_SOURCES = Object.freeze({
  music: { label: '本周爆款 BGM Top5', navigation: ['热门音乐'], sort: '昨日使用人数', period: '昨日使用人数', fields: ['title', 'author', 'totalUsers', 'yesterdayUsers'] },
  topics: { label: '本周话题热点 Top5', navigation: ['热门话题榜', '热门话题', '话题榜'], sort: '参与人数增长率', period: '周榜', fields: ['title', 'author', 'followers', 'participantGrowth', 'playGrowth'] },
  hotspots: { label: '全网热点 Top5', navigation: ['抖音热点榜'], sort: '峰值热度', period: '日榜', fields: ['title', 'peakHeat'] },
  videos: { label: '关键词带货视频 Top5', navigation: ['带货视频库'], sort: '视频销售额', period: '近7天', fields: ['title', 'products', 'author', 'followers', 'sales', 'salesCount', 'likes', 'publishedAt'] },
});

export function isFeiguaDataUrl(value, sourceOrigin = null) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (sourceOrigin) {
      const source = new URL(sourceOrigin);
      if (['http:', 'https:'].includes(source.protocol) && !source.username && !source.password && url.origin === source.origin) return true;
    }
    return url.protocol === 'https:' && !url.port && /^dy\d*\.feigua\.cn$/.test(url.hostname);
  } catch { return false; }
}

export function normalizeKeywords(input) {
  if (!Array.isArray(input) || input.length > 50) throw new Error('最多配置 50 个关键词');
  const result = [];
  for (const item of input) {
    if (typeof item !== 'string') throw new Error('关键词必须是文字');
    const keyword = item.trim();
    if (!keyword) continue;
    if (keyword.length > 60 || /[\r\n\u0000-\u001f]/.test(keyword)) throw new Error('每个关键词限 60 字，不含换行或控制字符');
    if (!result.includes(keyword)) result.push(keyword);
  }
  return result;
}

export function normalizeMusicTag(input = []) {
  if (!Array.isArray(input) || input.length > 2) throw new Error('BGM 视频标签只支持一级、二级分类');
  return input.map(label => {
    if (typeof label !== 'string' || !label.trim() || label.trim() === '全部' || label.length > 60 || /[\u0000-\u001f]/.test(label)) throw new Error('BGM 视频标签无效');
    return label.trim();
  });
}

export function normalizeMusicTagOptions(options) {
  if (!Array.isArray(options) || !options.length || options.length > 100) throw new Error('飞瓜未返回有效的视频标签目录');
  const seen = new Set();
  return options.map(option => {
    const [label] = normalizeMusicTag([option?.label]);
    if (seen.has(label) || !Array.isArray(option.children) || option.children.length > 200) throw new Error('飞瓜视频标签目录结构异常');
    seen.add(label);
    const children = [...new Set(option.children.map(child => normalizeMusicTag([child?.label])[0]))].map(label => ({ label }));
    return { label, children };
  });
}

export function validateMusicTag(path, options) {
  const selection = normalizeMusicTag(path);
  if (!selection.length) return selection;
  const parent = options.find(option => option.label === selection[0]);
  if (!parent || selection.length === 2 && !parent.children.some(child => child.label === selection[1])) throw new Error('该榜单分类已失效，请重新登录以自动更新目录后选择');
  return selection;
}

export function normalizeVideoPath(input = []) {
  if (!Array.isArray(input) || input.length > 5) throw new Error('视频分类路径最多支持五级');
  return input.map(label => {
    if (typeof label !== 'string' || !label.trim() || label.trim() === '全部' || label.length > 60 || /[\u0000-\u001f]/.test(label)) throw new Error('视频分类路径无效');
    return label.trim();
  });
}

export function normalizeVideoOptions(input, depth = 0) {
  if (!Array.isArray(input) || input.length > 300 || depth >= 5 && input.length) throw new Error('视频分类目录结构异常');
  const seen = new Set();
  return input.map(option => {
    const [label] = normalizeVideoPath([option?.label]);
    if (seen.has(label)) throw new Error('视频分类目录包含重复名称');
    seen.add(label);
    return { label, children: normalizeVideoOptions(option.children || [], depth + 1) };
  });
}

export function normalizeVideoQueries(input) {
  if (!Array.isArray(input) || input.length > 50) throw new Error('最多配置 50 个关键词');
  const keywords = normalizeKeywords(input.map(query => query?.keyword));
  if (keywords.length !== input.length) throw new Error('关键词不能为空或重复');
  return input.map((query, index) => ({ keyword: keywords[index], categoryPath: normalizeVideoPath(query.categoryPath), tagPath: normalizeVideoPath(query.tagPath) }));
}

export function validateVideoQueries(input, catalogs) {
  const queries = normalizeVideoQueries(input);
  for (const query of queries) for (const key of ['categoryPath', 'tagPath']) {
    let options = catalogs[key] || [];
    for (const label of query[key]) {
      const option = options.find(item => item.label === label);
      if (!option) throw new Error(`「${query.keyword}」的${key === 'categoryPath' ? '带货品类' : '视频标签'}已失效或目录尚未加载，请登录后重新选择`);
      options = option.children || [];
    }
  }
  return queries;
}

function value(input, max = 1000) {
  return typeof input === 'string' ? input.trim().slice(0, max) || null : null;
}

function captureError(message) {
  return Object.assign(new Error(message), { publicMessage: message });
}

export function validateCaptureDates(kind, input, now = Date.now()) {
  const raw = value(input, 100);
  if (kind === 'music') return { dateRange: raw, dateWarning: null };
  const match = raw?.match(/^(\d{4}[-/]\d{1,2}[-/]\d{1,2})(?:\s*[-~～至]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}))?$/);
  if (!match) throw captureError('未取得可核验的实际统计日期，本组未保存');
  const parse = text => {
    const [year, month, day] = text.split(/[-/]/).map(Number);
    const timestamp = Date.UTC(year, month - 1, day);
    const date = new Date(timestamp);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw captureError('统计日期无效，本组未保存');
    return timestamp;
  };
  const start = parse(match[1]), end = parse(match[2] || match[1]);
  const day = 86_400_000;
  const expectedDays = kind === 'hotspots' ? 1 : 7;
  if ((end - start) / day + 1 !== expectedDays) throw captureError(`实际统计日期与${FEIGUA_SOURCES[kind].period}不一致，本组未保存`);
  const today = Math.floor((now + 8 * 60 * 60 * 1000) / day) * day;
  if (end > today) throw captureError('实际统计日期晚于北京时间当天，本组未保存');
  // The provider may only publish a settled week. Preserve its actual dates,
  // and label old data instead of relabelling it as the current week/day.
  const lastSunday = today - (new Date(today).getUTCDay() || 7) * day;
  const stale = end < (kind === 'topics' ? lastSunday : today - day);
  return {
    dateRange: kind === 'hotspots' ? new Date(start).toISOString().slice(0, 10) : `${new Date(start).toISOString().slice(0, 10)} - ${new Date(end).toISOString().slice(0, 10)}`,
    dateWarning: stale ? '来源统计日期较旧，请按所示日期使用数据' : null,
  };
}

export function isRankingMetric(kind, input) {
  const raw = value(input)?.replace(/\s+/g, '');
  if (!raw) return false;
  const number = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
  const amount = `${number}(?:万|亿|[wWkKmM])?`;
  if (kind === 'topics') return new RegExp(`^[<>≤≥]?[+-]?${amount}%$`).test(raw);
  if (kind === 'videos') return new RegExp(`^[¥￥]?[<>≤≥]?${amount}(?:[-~～—–至]${amount})?(?:元|以上|以下)?$`).test(raw);
  return new RegExp(`^[<>≤≥]?${amount}(?:人|次|以上|以下)?$`).test(raw);
}

// Whitelist provider data before it crosses IPC or reaches the local store.
export function validateCapture(kind, keyword, capture, options = {}) {
  const source = FEIGUA_SOURCES[kind];
  if (!source || !capture || !isFeiguaDataUrl(capture.url, options.sourceOrigin)) throw new Error('飞瓜来源校验失败');
  if (capture.sort !== source.sort || capture.direction !== 'desc' || capture.period !== source.period || capture.filtersVerified !== true) {
    throw new Error('未确认榜单筛选或降序排序，已停止本组采集');
  }
  if (kind === 'videos' && capture.keyword !== keyword) throw new Error('关键词筛选与当前采集组不一致');
  const videoFilters = kind === 'videos' ? { categoryPath: normalizeVideoPath(options.categoryPath), tagPath: normalizeVideoPath(options.tagPath) } : null;
  if (videoFilters) for (const key of ['categoryPath', 'tagPath']) {
    if (!Array.isArray(capture[key]) || JSON.stringify(normalizeVideoPath(capture[key])) !== JSON.stringify(videoFilters[key])) throw new Error('带货视频实际分类与关键词设置不一致，本组未保存');
  }
  const hasCategory = ['music', 'topics'].includes(kind);
  const musicTag = hasCategory ? normalizeMusicTag(options.musicTag) : [];
  if (hasCategory && (!Array.isArray(capture.musicTag) || JSON.stringify(normalizeMusicTag(capture.musicTag)) !== JSON.stringify(musicTag))) throw new Error('榜单实际分类与任务选择不一致，本组未保存');
  const dates = validateCaptureDates(kind, capture.dateRange, options.now);
  if (!Array.isArray(capture.rows) || (!capture.rows.length && capture.emptyVerified !== true)) throw new Error('未读到榜单，不能将未加载页面保存为空榜单');
  const seen = new Set();
  const rows = [];
  for (const row of capture.rows) {
    if (!row || !value(row.title)) throw new Error('榜单缺少标题，页面结构可能已变化');
    const metric = { music: 'yesterdayUsers', topics: 'participantGrowth', hotspots: 'peakHeat', videos: 'sales' }[kind];
    if (!isRankingMetric(kind, row[metric])) throw captureError('榜单排名指标缺失、无效或被权限提示替代，本组未保存');
    const url = isFeiguaDataUrl(row.url, options.sourceOrigin) ? row.url : null;
    const id = value(row.id, 200) || url;
    // Do not collapse unrelated videos solely because they share a title.
    if (!id) throw new Error('榜单缺少可核验的来源标识，已停止本组采集');
    if (seen.has(id)) continue;
    seen.add(id);
    const clean = { id, url, rank: rows.length + 1 };
    for (const field of source.fields) {
      clean[field] = field === 'products'
        ? (Array.isArray(row.products) ? row.products.slice(0, 30).map(product => ({ title: value(product?.title), commission: value(product?.commission, 60), url: feiguaProductLink(product?.url),
          ...(value(product?.id,160) ? {id:value(product.id,160)} : {}), ...(typeof product?.hasCommission==='boolean'?{hasCommission:product.hasCommission}:{}) })).filter(product => product.title) : [])
        : value(row[field]);
    }
    clean.missingFields = source.fields.filter(field => field === 'products' ? row.productsIncomplete === true || !clean.products.length || clean.products.some(product => !product.commission) : !clean[field]);
    if (kind === 'videos') {
      clean.videoUrl = feiguaVideoLink(row.videoUrl, clean.id);
      for (const field of ['comments','shares','collects']) clean[field] = value(row[field]);
      if (row.playsScope === 'detail-total' && clean.plays) clean.playsScope = 'detail-total';
      clean.fieldAvailability = Object.fromEntries(['plays','commission'].filter(field => ['source_unavailable','restricted','lookup_failed'].includes(row.fieldAvailability?.[field])).map(field => [field,row.fieldAvailability[field]]));
      if (row.detailProvenance?.transport === 'provider-api' && /^\d{8}$/.test(row.detailProvenance.dateCode)) clean.detailProvenance = {transport:'provider-api',dateCode:row.detailProvenance.dateCode,endpoints:Object.values(VIDEO_DETAIL_ENDPOINTS)};
    }
    rows.push(clean);
    if (rows.length === 5) break;
  }
  return {
    kind, keyword: kind === 'videos' ? keyword : null,
    sourceUrl: capture.url, collectedAt: new Date().toISOString(),
    sort: source.sort, direction: 'desc', period: source.period,
    ...dates,
    ...(capture.provenance?.transport === 'provider-api' ? { provenance: {
      transport: 'provider-api', endpoint: value(capture.provenance.endpoint, 200), method: 'GET', responseCode: 200, dateCode: value(capture.provenance.dateCode, 30),
    } } : {}),
    filters: kind === 'videos' ? { keyword, publishedAt: '不限', ...videoFilters } : hasCategory ? { category: musicTag.join(' > ') || '全部', categoryPath: musicTag } : { category: '全部' },
    rows,
  };
}
