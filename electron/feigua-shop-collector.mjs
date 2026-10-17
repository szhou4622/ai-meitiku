import { setTimeout as delay } from 'node:timers/promises';
import { SHOP_ENDPOINTS, readShopApi } from './feigua-shop-api.mjs';
import { normalizeShops, shopError, shopQuery, validateShopSnapshot, validateShopWeek } from './feigua-shop-contract.mjs';

const check = signal => { if (signal?.aborted) throw shopError('已停止店铺采集', 'FEIGUA_CANCELLED'); };
const canonical = value => JSON.stringify(Object.entries(value).map(([k, v]) => [k, String(v)]).sort(([a], [b]) => a.localeCompare(b)));

export class FeiguaShopCollector {
  constructor(browser) { this.browser = browser; this.focusIds = new Map(); }

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
    if (result?.removalLocked) throw shopError('飞瓜规定新关注的小店需满 24 小时才能移除；本地监控和历史数据保留', 'FEIGUA_SHOP_REMOVE_LOCKED');
    if (result?.code === 403) throw shopError('飞瓜拒绝访问该店数据，请检查当前账号的访问权限', 'FEIGUA_PERMISSION');
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

  async isFollowed(shop, period, signal) {
    this.focusIds.delete(shop.id);
    const seen = new Set(); let expected = null;
    for (let page = 1; page <= 500; page++) {
      const data = await this.request('focusList', { beginDateCode: period.start.replaceAll('-', ''), endDateCode: period.end.replaceAll('-', ''), groupId: 0, shopStatSort: 1, sortDirection: 1, pageIndex: page, pageSize: 10 }, signal);
      if (!Number.isSafeInteger(data.total) || data.total < 0 || data.total > 5000 || !Array.isArray(data.rows) || data.rows.length > 10 || expected !== null && expected !== data.total) throw shopError('飞瓜关注列表无法完整核验，未新增关注');
      expected = data.total;
      const rows = normalizeShops(data.rows);
      for (const row of rows) { if (seen.has(row.id)) throw shopError('飞瓜关注列表分页重复，未新增关注'); seen.add(row.id); }
      if (seen.size > expected) throw shopError('飞瓜关注列表数量不一致，未新增关注');
      if (rows.some(row => row.id === shop.id)) {
        const focusId = data.rows.find(row => row.id === shop.id).focusId;
        if (!Number.isSafeInteger(focusId) || focusId <= 0) throw shopError('飞瓜关注记录缺少有效标识，请稍后刷新重试');
        this.focusIds.set(shop.id, focusId); return true;
      }
      if (seen.size === expected) return false;
      if (rows.length !== 10) throw shopError('飞瓜关注列表分页缺失，未新增关注');
    }
    throw shopError('飞瓜关注列表超出可核验范围，未新增关注');
  }

  async checkReady(shop, signal) {
    const focusId = this.focusIds.get(shop.id);
    if (!Number.isSafeInteger(focusId) || focusId <= 0) throw shopError('未确认该店铺的飞瓜关注记录');
    const info = await this.request('focusInfo', { focusId }, signal);
    if (info.shopId !== shop.id || typeof info.ready !== 'boolean') throw shopError('飞瓜店铺身份或数据准备状态无法核验');
    // This flag describes source preparation, not whether every weekly API is
    // unavailable. Accept complete verified data even while the flag is false.
    return info.ready;
  }

  async ensureFollowed(shop, period, signal, progress, allowFollow) {
    progress('核对飞瓜关注状态');
    if (await this.isFollowed(shop, period, signal)) return;
    if (!allowFollow) throw shopError('该店尚未同步到飞瓜关注，请点击“刷新本周数据”自动同步并采集', 'FEIGUA_SHOP_NOT_FOLLOWED');
    const capacity = await this.request('focusCount', {}, signal);
    if (!Number.isSafeInteger(capacity.remaining) || capacity.remaining < 0) throw shopError('无法核验飞瓜剩余关注名额，未新增关注');
    if (capacity.remaining === 0) throw shopError('当前飞瓜账号的关注小店名额已满，请先在飞瓜管理关注名额', 'FEIGUA_SHOP_FOCUS_LIMIT');
    check(signal);
    progress('同步关注到飞瓜');
    // A failed/timed-out write is never blindly retried. The next manual run
    // reads membership again before deciding whether a new write is needed.
    await this.request('follow', { groupId: 0, shopId: shop.id }, signal);
    check(signal);
    if (!await this.isFollowed(shop, period, signal)) throw shopError('飞瓜关注尚未确认，请稍后刷新重试；已有店铺和周数据保留');
  }

  async unfollow(shop, signal, progress = () => {}, now = Date.now()) {
    normalizeShops([shop]); check(signal);
    const end = Math.floor((now + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 86_400_000;
    const period = { start: new Date(end - 29 * 86_400_000).toISOString().slice(0, 10), end: new Date(end).toISOString().slice(0, 10) };
    progress('核对飞瓜关注记录');
    const followed = await this.isFollowed(shop, period, signal);
    let before = null;
    const capacity = async () => {
      const data = await this.request('focusCount', {}, signal);
      if (!Number.isSafeInteger(data.remaining) || data.remaining < 0) throw shopError('未能确认飞瓜关注名额，本地监控保留，请重试移除');
      return data.remaining;
    };
    if (followed) {
      const focusId = this.focusIds.get(shop.id);
      const info = await this.request('focusInfo', { focusId }, signal);
      if (info.shopId !== shop.id || typeof info.removable !== 'boolean') throw shopError('未能核验该店的移除权限，本地监控保留');
      if (!info.removable) {
        const match = info.followedAt?.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
        const timestamp = match && Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`);
        const validTime = Number.isFinite(timestamp) && new Date(timestamp + 8 * 3_600_000).toISOString().slice(0, 19) === info.followedAt.replaceAll('/', '-').replace(' ', 'T');
        const available = validTime ? new Date(timestamp + 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ') : null;
        throw shopError(`飞瓜规定新关注的小店需满 24 小时才能移除${available ? `，预计 ${available}（北京时间）后可重试` : ''}；本地监控和历史数据保留`, 'FEIGUA_SHOP_REMOVE_LOCKED');
      }
      before = await capacity(); check(signal);
      progress('正在同步取消飞瓜关注');
      await this.request('unfollow', { focusId }, signal); check(signal);
      if (await this.isFollowed(shop, period, signal)) throw shopError('飞瓜尚未确认取消关注，本地监控保留，请重试移除');
    }
    progress('确认飞瓜剩余名额');
    const remaining = await capacity();
    if (before !== null && remaining < before + 1) throw shopError('飞瓜已取消关注，但名额尚未确认释放；本地监控保留，请稍后重试移除');
    check(signal); return { remaining };
  }

  async collect(shop, period, signal, progress = () => {}, { allowFollow = true } = {}) {
    normalizeShops([shop]); validateShopWeek(period);
    const confirmIdentity = async () => {
      const matches = await this.search(shop.name, signal);
      const actual = matches.find(item => item.id === shop.id);
      if (!actual) throw shopError('已监控店铺的身份未能重新确认，请重新搜索该店铺');
      return actual;
    };
    // A manual follow needs a fresh search confirmation before any write.
    // Background reads confirm identity through membership and base data,
    // without repeating public-search queries for an already followed shop.
    const actual = allowFollow ? await confirmIdentity() : shop;
    await this.ensureFollowed(actual, period, signal, progress, allowFollow);
    const sourcePreparing = !await this.checkReady(actual, signal);
    try { return await this.collectWeek(actual, period, signal, progress); }
    catch (error) {
      if (sourcePreparing && error.code === 'FEIGUA_PERMISSION') throw shopError('已同步关注，飞瓜尚未提供可完整读取的该店周数据，将自动检查并继续采集', 'FEIGUA_SHOP_INITIALIZING');
      throw error;
    }
  }

  async collectWeek(actual, period, signal, progress) {
    const shop = actual;
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

export const shopReadPaths = Object.entries(SHOP_ENDPOINTS).filter(([kind]) => !['follow', 'unfollow'].includes(kind)).map(([, path]) => path);
