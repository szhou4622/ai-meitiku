import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { collectionUpdateDate } from './feigua-collection-period.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FeiguaShopCollector } from './feigua-shop-collector.mjs';
import { normalizeShops, currentShopWeek, retainShopWeeks, shopError } from './feigua-shop-contract.mjs';

const initial = () => ({ version: 1, shops: [], snapshots: [], waitingShops: [], lastRun: null, lastScheduledDate: null });
const failMessage = error => error.publicMessage || '店铺采集未完成，已保留上次成功结果';

export class FeiguaShopService {
  constructor({ userDataPath, gateway, collector, storage, now = () => Date.now() }) {
    this.gateway = gateway; this.collector = collector || new FeiguaShopCollector(gateway.browser); this.now = now;
    this.data = initial(); this.controller = null; this.job = null; this.queue = Promise.resolve(); this.disposed = false; this.progress = null;
    const filename = path.join(userDataPath, 'feigua-shops', 'state.json');
    this.storage = storage || {
      read: async () => { try { return JSON.parse(await readFile(filename, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return initial(); throw shopError('竞对店铺数据读取失败，原文件已保留'); } },
      write: async data => { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(`${filename}.tmp`, JSON.stringify(data), { mode: 0o600 }); await rename(`${filename}.tmp`, filename); },
    };
    this.ready = this.load(); this.ready.catch(() => {});
  }
  async load() {
    const data = await this.storage.read();
    if (data.version !== 1 || !Array.isArray(data.snapshots)) throw shopError('竞对店铺历史格式无法识别，原文件已保留');
    if (data.snapshots.some(row => !row?.shop || typeof row.weekStart !== 'string' || typeof row.through !== 'string' || !row.metrics || !Array.isArray(row.days) || !Array.isArray(row.events) || !Array.isArray(row.newGoods) || !Array.isArray(row.trend))) throw shopError('竞对店铺周数据损坏，原文件已保留');
    const shops = normalizeShops(data.shops), waiting = data.waitingShops ?? [];
    if (!Array.isArray(waiting) || waiting.some(row => !row || typeof row.id !== 'string' || !Number.isSafeInteger(row.attempts) || row.attempts < 1 || !Number.isFinite(Date.parse(row.nextCheckAt)))) throw shopError('店铺等待状态损坏，原文件已保留');
    this.data = { version: 1, shops, snapshots: data.snapshots, waitingShops: waiting.filter(row => shops.some(shop => shop.id === row.id)), lastRun: data.lastRun || null, lastScheduledDate: data.lastScheduledDate || null };
    if (this.data.lastRun?.status === 'running') await this.commit({ ...this.data, lastRun: { ...this.data.lastRun, status: 'interrupted', message: '上次店铺采集被中断，请重新刷新；已保存周数据保留' } });
  }
  async commit(data) {
    const next = structuredClone(data);
    const task = this.queue.then(async () => { await this.storage.write(next); this.data = next; });
    this.queue = task.catch(() => {}); return task;
  }
  async state() {
    await this.ready;
    return structuredClone({ ...this.data, busy: !!this.controller, progress: this.progress, currentWeek: currentShopWeek(this.now()), error: this.error || null, notice: this.notice || null });
  }
  async save(shops) {
    await this.ready;
    if (this.controller || this.configPending || this.disposed) throw shopError('店铺采集中或设置正在保存，请稍后再试');
    const next = normalizeShops(shops);
    if (this.data.shops.some(shop => !next.some(item => item.id === shop.id))) throw shopError('移除店铺需要同步取消飞瓜关注，请使用“同步移除”');
    this.configPending = true;
    try { await this.commit({ ...this.data, shops: next, waitingShops: this.data.waitingShops.filter(row => next.some(shop => shop.id === row.id)) }); } finally { this.configPending = false; }
    return this.state();
  }
  async remove(id) {
    await this.ready; await this.queue;
    if (this.controller || this.configPending || this.gateway.controller || this.gateway.operation || this.disposed) throw shopError('正在执行飞瓜操作，请稍后再同步移除');
    const shop = this.data.shops.find(shop => shop.id === id);
    if (!shop) throw shopError('该店铺不在当前监控列表中');
    const controller = new AbortController(); this.controller = controller; this.configPending = true; this.error = null; this.notice = null;
    try {
      await this.gateway.exclusive(async () => {
        this.gateway.controller = controller;
        try {
          if (controller.signal.aborted || this.disposed) throw shopError('已停止同步移除，本地监控保留', 'FEIGUA_CANCELLED');
          const auth = await this.gateway.browser.checkLogin(); this.gateway.auth = auth;
          if (auth.status !== 'authenticated') throw shopError(auth.message || '请先登录飞瓜');
          const result = await this.collector.unfollow(shop, controller.signal, text => { this.progress = `${shop.name} · ${text}`; }, this.now());
          if (controller.signal.aborted || this.disposed) throw shopError('已停止同步移除，请重试确认飞瓜状态；本地监控和历史数据保留', 'FEIGUA_CANCELLED');
          try { await this.commit({ ...this.data, shops: this.data.shops.filter(item => item.id !== id), waitingShops: this.data.waitingShops.filter(item => item.id !== id) }); }
          catch { throw shopError('飞瓜同步移除已确认，但本地保存失败，请再次同步移除完成保存；历史数据保留', 'FEIGUA_SHOP_REMOVE_SAVE'); }
          this.notice = `已同步移除「${shop.name}」，飞瓜当前剩余 ${result.remaining} 个关注名额；本地历史周数据保留。`;
        } finally { if (this.gateway.controller === controller) this.gateway.controller = null; }
      });
    } finally { if (this.controller === controller) this.controller = null; this.configPending = false; this.progress = null; }
    return this.state();
  }
  async search(query) {
    await this.ready;
    if (this.controller || this.configPending || this.disposed) throw shopError('请等待当前店铺操作完成');
    return this.gateway.exclusive(async () => {
      const auth = await this.gateway.browser.checkLogin(); this.gateway.auth = auth;
      if (auth.status !== 'authenticated') throw shopError(auth.message || '请先登录飞瓜');
      return this.collector.search(query);
    });
  }
  async start({ ids, allowFollow = true } = {}) {
    await this.ready;
    await this.queue;
    if (this.controller || this.configPending || this.gateway.controller || this.gateway.operation || this.disposed) throw shopError('正在执行采集操作，请稍后再试');
    const period = currentShopWeek(this.now());
    if (!period) throw shopError('本周尚无已结束日期，周二起可采集本周数据');
    const shops = structuredClone(this.data.shops.filter(shop => !ids || ids.includes(shop.id)));
    if (!shops.length) throw shopError('请先添加要监控的店铺');
    const controller = new AbortController(); this.controller = controller; this.error = null; this.notice = null;
    const run = { id: randomUUID(), week: period, startedAt: new Date(this.now()).toISOString(), finishedAt: null, status: 'running', message: '正在检查飞瓜登录状态', shops: shops.map(shop => ({ id: shop.id, name: shop.name, status: 'pending' })) };
    try { await this.commit({ ...this.data, lastRun: run }); } catch (e) { this.controller = null; throw e; }
    this.job = this.gateway.exclusive(async () => {
      this.gateway.controller = controller;
      try {
        if (controller.signal.aborted || this.disposed) return;
        const auth = await this.gateway.browser.checkLogin(); this.gateway.auth = auth;
        if (auth.status !== 'authenticated') throw shopError(auth.message || '请先登录飞瓜');
        for (const shop of shops) {
          if (controller.signal.aborted) break;
          const group = run.shops.find(g => g.id === shop.id); group.status = 'running';
          this.progress = `正在采集 ${shop.name}`;
          try {
            const snapshot = await this.collector.collect(shop, period, controller.signal, text => { this.progress = `${shop.name} · ${text}`; }, { allowFollow: allowFollow === true });
            if (controller.signal.aborted) break;
            group.status = 'completed';
            await this.commit({ ...this.data, snapshots: retainShopWeeks(this.data.snapshots, snapshot), waitingShops: this.data.waitingShops.filter(row => row.id !== shop.id), lastRun: run });
          } catch (e) {
            if (controller.signal.aborted || e.code === 'FEIGUA_CANCELLED') break;
            const pending = this.data.waitingShops.find(row => row.id === shop.id);
            const waiting = this.data.waitingShops.filter(row => row.id !== shop.id);
            group.status = e.code === 'FEIGUA_SHOP_INITIALIZING' ? 'waiting' : 'failed'; group.message = failMessage(e);
            if (group.status === 'waiting') {
              const attempts = (pending?.attempts || 0) + 1;
              waiting.push({ id: shop.id, attempts, nextCheckAt: new Date(this.now() + [60, 180, 300][Math.min(attempts - 1, 2)] * 1000).toISOString() });
            }
            await this.commit({ ...this.data, waitingShops: waiting, lastRun: run });
            if (['FEIGUA_AUTH_REQUIRED', 'FEIGUA_QUOTA', 'FEIGUA_RATE_LIMIT', 'FEIGUA_VERIFICATION_REQUIRED'].includes(e.code)) throw e;
          }
        }
      } finally { if (this.gateway.controller === controller) this.gateway.controller = null; }
    }).catch(async e => { this.error = failMessage(e); await this.commit({ ...this.data, waitingShops: this.data.waitingShops.filter(row => !shops.some(shop => shop.id === row.id)) }); }).then(async () => {
      const cancelled = controller.signal.aborted;
      for (const group of run.shops) if (['running', 'pending'].includes(group.status)) { group.status = cancelled ? 'cancelled' : 'failed'; group.message = cancelled ? '已停止采集' : this.error || '本组未完成'; }
      const done = run.shops.filter(g => g.status === 'completed').length;
      const waiting = run.shops.filter(g => g.status === 'waiting').length;
      run.status = cancelled ? 'cancelled' : done === shops.length ? 'completed' : waiting === shops.length ? 'waiting' : done || waiting ? 'partial' : 'failed';
      run.finishedAt = new Date(this.now()).toISOString(); run.message = cancelled ? '店铺采集已停止，保留已完成结果' : `完成 ${done}/${shops.length} 个店铺${waiting ? `，${waiting} 个等待飞瓜返回完整周数据，将自动重试` : ''}`;
      await this.commit({ ...this.data, ...(cancelled ? { waitingShops: this.data.waitingShops.filter(row => !shops.some(shop => shop.id === row.id)) } : {}), lastRun: run });
    }).catch(() => { this.error = '店铺结果保存失败，已保留此前成功数据，请检查本机存储'; }).finally(() => { if (this.controller === controller) this.controller = null; this.progress = null; });
    return this.state();
  }
  async cancel() { this.controller?.abort(); if (this.controller && this.gateway.controller === this.controller) this.gateway.browser.stop?.(); return this.state(); }
  async checkSchedule(now = this.now(), canRun = () => false) {
    await this.ready;
    const date = collectionUpdateDate(now);
    const week = currentShopWeek(now);
    if (this.disposed || !canRun() || !week || !this.data.shops.length || this.controller || this.configPending || this.gateway.controller || this.gateway.operation) return;
    const due = this.data.waitingShops.filter(row => Date.parse(row.nextCheckAt) <= now);
    if (due.length) {
      await this.commit({ ...this.data, waitingShops: this.data.waitingShops.map(row => due.some(item => item.id === row.id) ? { ...row, nextCheckAt: new Date(now + 300_000).toISOString() } : row) });
      if (!this.disposed) await this.start({ ids: due.map(row => row.id), allowFollow: false });
      return;
    }
    if (!date || this.data.lastScheduledDate === date) return;
    const pending = this.data.shops.filter(shop => !this.data.snapshots.some(row => row.shop.id === shop.id && row.weekStart === week.start && row.through === week.end));
    await this.commit({ ...this.data, lastScheduledDate: date });
    if (!this.disposed && pending.length) await this.start({ ids: pending.map(shop => shop.id), allowFollow: false });
  }
  startDailySchedule(canRun) {
    if (this.timer) return;
    const tick = () => { if (!this.schedulePending) { this.schedulePending = true; void this.checkSchedule(this.now(), canRun).catch(() => { this.error = '竞对店铺自动更新未完成，可手动刷新'; }).finally(() => { this.schedulePending = false; }); } };
    this.timer = setInterval(tick, 30_000); this.timer.unref?.(); tick();
  }
  dispose() { this.disposed = true; clearInterval(this.timer); this.controller?.abort(); }
}
