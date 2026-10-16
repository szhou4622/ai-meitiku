import { currentCollectionWeek } from './feigua-collection-period.mjs';
export const SHOP_LIMIT = 10;
export const SHOP_METRICS = Object.freeze({
  sales: 'SalesGmvStr', salesCount: 'SalesCountStr', goods: 'GoodsCountStr',
  videos: 'AwemeCountStr', lives: 'LiveCountStr', creators: 'BloggerCountStr',
  newGoods: 'NewGoodsCountStr', changedGoods: 'UpdateGoodsCountStr', newCreators: 'NewBloggerCountStr',
});
export const shopError = (message, code = 'FEIGUA_SHOP_INVALID') => Object.assign(new Error(message), { publicMessage: message, code });
export const shopText = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) || null : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);

export function shopQuery(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw shopError('请输入 1–100 字的店铺名称');
  return value.trim();
}

export function normalizeShops(input) {
  if (!Array.isArray(input) || input.length > SHOP_LIMIT) throw shopError('最多监控 10 个店铺');
  const seen = new Set();
  return input.map(shop => {
    if (!identifier(shop?.id) || seen.has(shop.id)) throw shopError('店铺标识无效或重复，请重新搜索确认');
    seen.add(shop.id);
    return { id: shop.id, name: shopQuery(shop.name) };
  });
}

export function shopDate(value) {
  const match = String(value || '').match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/);
  if (!match) throw shopError('店铺统计日期无效');
  const [, y, m, d] = match;
  const day = Date.UTC(Number(y), Number(m) - 1, Number(d));
  const iso = new Date(day).toISOString().slice(0, 10);
  if (iso !== `${y}-${m}-${d}`) throw shopError('店铺统计日期无效');
  return iso;
}

// Beijing natural week; Monday has no settled day yet. No partial future day.
export const currentShopWeek = currentCollectionWeek;

export function validateShopWeek(period, now = Date.now()) {
  const start = shopDate(period?.start), end = shopDate(period?.end);
  const a = Date.parse(start), b = Date.parse(end);
  const yesterday = Math.floor((now + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 86_400_000;
  if (new Date(a).getUTCDay() !== 1 || b < a || b - a > 6 * 86_400_000 || b > yesterday) throw shopError('周数据必须是周一开始，且不包含未结束的日期');
  return { start, end };
}

export function parseShopMetrics(data) {
  return Object.fromEntries(Object.entries(SHOP_METRICS).map(([key, field]) => {
    const text = shopText(data?.[field], 60);
    if (text && !['--', '-'].includes(text) && !/^[<>≤≥]?(?:\d[\d,.]*)(?:[wW万亿]|%)?\+?(?:[-~～]\d[\d,.]*(?:[wW万亿]|%)?\+?)?$/.test(text)) throw shopError('店铺指标包含权限提示或无效数值，已保留原结果');
    return [key, !text || ['--', '-'].includes(text) ? null : text];
  }));
}

export function validateShopSnapshot(shop, period, parts, now = Date.now()) {
  const [cleanShop] = normalizeShops([shop]);
  const week = validateShopWeek(period, now);
  const metrics = parseShopMetrics(parts.overview);
  if (!metrics.sales || !metrics.salesCount) throw shopError('飞瓜未提供可核验的周销售数据，已保留原结果');
  const days = parts.days.map(row => ({ date: shopDate(row.DateCode), ...parseShopMetrics(row) }));
  const expected = (Date.parse(week.end) - Date.parse(week.start)) / 86_400_000 + 1;
  if (days.length !== expected || new Set(days.map(row => row.date)).size !== expected || days.some(row => row.date < week.start || row.date > week.end)) throw shopError('逐日数据日期缺失、重复或不属于本周，已保留原结果');
  const events = parts.events.map(row => {
    const date = shopDate(row.date);
    if (date < week.start || date > week.end || !['new-product', 'product-change', 'new-creator'].includes(row.kind)) throw shopError('店铺动态日期或类型无法核验');
    return { date, kind: row.kind, productId: shopText(row.productId, 160), product: shopText(row.product), creatorId: shopText(row.creatorId, 160), creator: shopText(row.creator), fans: shopText(row.fans, 60),
      changes: row.changes.map(change => ({ type: Number(change.type), title: shopText(change.title, 1200), before: shopText(change.before, 1200), after: shopText(change.after, 1200) })) };
  });
  if (events.length !== parts.eventTotal) throw shopError('店铺动态分页不完整，已保留原结果');
  const newGoods = parts.newGoods.map(row => ({ id: shopText(row.id, 160), title: shopText(row.title), listedAt: shopText(row.listedAt, 40), sales: shopText(row.sales, 60), salesCount: shopText(row.salesCount, 60) }));
  if (newGoods.length > 10 || newGoods.some(row => !identifier(row.id) || !row.title)) throw shopError('上架商品 Top10 无法核验');
  const trend = parts.trend.map(row => ({ date: shopDate(row.date), count: shopText(row.count, 60) }));
  if (trend.some(row => row.date < week.start || row.date > week.end || !/^\d+$/.test(row.count || ''))) throw shopError('上架趋势数据无法核验');
  return { shop: cleanShop, weekStart: week.start, through: week.end, collectedAt: new Date(now).toISOString(), metrics,
    days: days.sort((a, b) => b.date.localeCompare(a.date)), newGoods, trend, events,
    provenance: { transport: 'provider-api', responseCode: 200, periodType: '10002' } };
}

export function retainShopWeeks(previous, next) {
  const rows = [next, ...previous.filter(row => row.shop.id !== next.shop.id || row.weekStart !== next.weekStart)];
  const counts = new Map();
  return rows.sort((a, b) => b.weekStart.localeCompare(a.weekStart)).filter(row => {
    const count = (counts.get(row.shop.id) || 0) + 1; counts.set(row.shop.id, count); return count <= 52;
  });
}
