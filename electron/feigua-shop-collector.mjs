import { setTimeout as delay } from 'node:timers/promises';
import { SHOP_ENDPOINTS, readShopApi } from './feigua-shop-api.mjs';
import { normalizeShops, shopError, shopQuery, validateShopSnapshot } from './feigua-shop-contract.mjs';

const check = signal => { if (signal?.aborted) throw shopError('已停止店铺采集', 'FEIGUA_CANCELLED'); };
const canonical = value => JSON.stringify(Object.entries(value).map(([k, v]) => [k, String(v)]).sort(([a], [b]) => a.localeCompare(b)));

export class FeiguaShopCollector {
  constructor(browser) { this.browser = browser; }

  async request(kind, params, signal) {
    check(signal);
    const browser = this.browser, window = browser.window;
    if (!window || window.isDestroyed() || !browser.isProviderUrl(window.webContents.getURL())) throw shopError('请先登录飞瓜', 'FEIGUA_AUTH_REQUIRED');
    const origin = new URL(window.webContents.getURL()).origin;
    const since = browser.requestSequence;
    const value = window.webContents.executeJavaScript(`(${readShopApi.toString()})(${JSON.stringify({ kind, params })})`);
    const result = await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(shopError('已停止店铺采集', 'FEIGUA_CANCELLED')); };
      const timer = setTimeout(() => { cleanup(); reject(shopError('飞瓜店铺请求超时', 'FEIGUA_NETWORK')); }, 25_000);
      signal?.addEventListener('abort', abort, { once: true });
      Promise.resolve(value).then(r => { cleanup(); resolve(r); }, () => { cleanup(); reject(shopError('飞瓜店铺请求失败', 'FEIGUA_NETWORK')); });
      if (signal?.aborted) abort();
    });
    check(signal);
    if (window !== browser.window || new URL(window.webContents.getURL()).origin !== origin) throw shopError('店铺读取期间来源窗口发生变化');
    const observed = (browser.shopRequests || []).filter(r => r.sequence > since && r.kind === kind).at(-1);
    if (!observed || canonical(observed.params) !== canonical(params)) throw shopError('未核验到本次店铺、日期及分页一致的真实请求');
    if (result?.code === 430) browser.requireVerification();
    if (result?.code === 401) throw shopError('飞瓜登录已失效，请重新登录', 'FEIGUA_AUTH_REQUIRED');
    if (result?.quota) throw shopError('飞瓜查询额度已用完，已保留原周数据', 'FEIGUA_QUOTA');
    if (result?.code === 403) throw shopError('飞瓜拒绝访问该店周数据，请先在飞瓜关注该小店并确认账号权限', 'FEIGUA_PERMISSION');
    if (result?.code === 429) throw shopError('飞瓜请求频率受限，请稍后重试', 'FEIGUA_RATE_LIMIT');
    if (result?.code !== 200 || !result.success || result.example || result.data == null) throw shopError('飞瓜未返回可核验的真实店铺数据，已保留原结果');
    return result.data;
  }

  async search(query, signal) {
    const keyword = shopQuery(query);
    const data = await this.request('search', { period: 30, sort: 0, keyword, page: 1, pageSize: 10, pageType: 1 }, signal);
    if (!Array.isArray(data.rows) || !data.rows.length && data.total !== 0) throw shopError('店铺搜索结果不完整，请重试');
    return normalizeShops(data.rows);
  }

  async collect(shop, period, signal, progress = () => {}) {
    const matches = await this.search(shop.name, signal);
    const actual = matches.find(item => item.id === shop.id);
    if (!actual) throw shopError('已监控店铺的身份未能重新确认，请重新搜索该店铺');
    const params = { shopId: shop.id, fromDateCode: period.start.replaceAll('-', ''), toDateCode: period.end.replaceAll('-', ''), periodType: '10002' };
    const parts = { events: [], newGoods: [], trend: [], eventTotal: 0 };
    progress('读取周汇总');
    parts.overview = await this.request('overview', params, signal);
    const days = await this.request('days', { ...params, order: 1, sortField: 'ListTime', pageIndex: 1, pageSize: 10 }, signal);
    if (!Array.isArray(days.rows)) throw shopError('逐日数据未返回完整列表');
    parts.days = days.rows.filter(row => Number(row.DateCode) > 0);
    if (days.total !== parts.days.length) throw shopError('逐日数据分页不完整');
    progress('读取商品上架及店铺动态');
    const stat = await this.request('stat', params, signal);
    for (const field of ['NewGoodsCountStr', 'UpdateGoodsCountStr', 'NewBloggerCountStr']) {
      if (String(stat[field]) !== String(parts.overview[field])) throw shopError('周汇总与动态汇总尚未一致，请稍后刷新');
    }
    parts.newGoods = await this.request('tops', { ...params, TrendPeriod: '10001' }, signal);
    if (!Array.isArray(parts.newGoods) || parts.newGoods.some(row => row.shopId !== shop.id)) throw shopError('上架商品不属于当前店铺');
    parts.trend = await this.request('trend', { ...params, TrendPeriod: '10001' }, signal);
    if (!Array.isArray(parts.trend)) throw shopError('上架趋势未返回有效数据');
    const options = await this.request('options', params, signal);
    const filters = { dynamicTypes: '1,4,2', ...(options.subtypes?.length ? { dynamicSubTypes: [...new Set(options.subtypes)].join(',') } : {}) };
    const seen = new Set();
    for (let page = 1; page <= 500; page++) {
      check(signal);
      const data = await this.request('events', { ...params, ...filters, pageSize: 10, page }, signal);
      if (!Array.isArray(data.rows) || !Number.isSafeInteger(data.total) || data.total < 0 || data.total > 5000 || data.rows.length > 10) throw shopError('店铺动态数量无法完整核验，已保留原结果');
      if (page > 1 && data.total !== parts.eventTotal) throw shopError('动态总数在分页期间变化，请重新采集');
      parts.eventTotal = data.total;
      for (const row of data.rows) {
        if (!Array.isArray(row.changes) || !row.changes.length) throw shopError('店铺动态缺少来源明细');
        const types = row.changes.map(item => Number(item.type));
        const kind = types.every(type => type >= 40 && type < 50) ? 'new-creator' : types.every(type => type >= 20 && type < 30) ? 'product-change' : types.every(type => type >= 10 && type < 20) ? 'new-product' : null;
        if (!kind || (kind === 'new-creator' ? !row.creatorId || !row.creator : !row.productId || !row.product)) throw shopError('店铺动态来源身份或类型不完整');
        const fingerprint = JSON.stringify(row);
        if (seen.has(fingerprint)) throw shopError('动态分页重复返回同一记录，已保留原结果');
        seen.add(fingerprint);
        parts.events.push({ ...row, kind });
      }
      progress(`读取动态 ${parts.events.length}/${parts.eventTotal}`);
      if (parts.events.length === parts.eventTotal) break;
      if (data.rows.length !== 10 || parts.events.length > parts.eventTotal || page === 500) throw shopError('店铺动态分页未完成，已保留原结果');
      await delay(100, undefined, { signal });
    }
    check(signal);
    return validateShopSnapshot(actual, period, parts);
  }
}

export const shopReadPaths = Object.values(SHOP_ENDPOINTS);
