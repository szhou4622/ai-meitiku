"use client";

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Plus, RefreshCw, Square, X, Store } from 'lucide-react';
import styles from './feigua-shops.module.css';

type Shop = { id: string; name: string };
type Period = { start: string; end: string };
type Metrics = Record<string, string | null>;
type ShopEvent = { date: string; kind: string; product: string | null; creator: string | null; fans: string | null; changes: { type: number; title: string | null; before: string | null; after: string | null }[] };
type Snapshot = { shop: Shop; weekStart: string; through: string; collectedAt: string; metrics: Metrics; days: ({ date: string } & Metrics)[]; newGoods: { id: string; title: string; listedAt: string | null; sales: string | null; salesCount: string | null }[]; trend: { date: string; count: string }[]; events: ShopEvent[] };
type ShopState = { shops: Shop[]; snapshots: Snapshot[]; waitingShops?: { id: string; nextCheckAt: string; attempts: number }[]; busy: boolean; progress: string | null; currentWeek: Period | null; error: string | null; notice?: string | null; lastRun: { status: string; message: string; shops: { id: string; status: string; message?: string }[] } | null };
export type FeiguaShopsBridge = {
  state: () => Promise<ShopState>;
  search: (query: string) => Promise<Shop[]>;
  save: (shops: Shop[]) => Promise<ShopState>;
  remove: (id: string) => Promise<ShopState>;
  start: (options?: { ids: string[] }) => Promise<ShopState>;
  cancel: () => Promise<ShopState>;
};
const fields = { sales: '销售额', salesCount: '销量', goods: '带货商品', videos: '带货视频', lives: '带货直播', creators: '带货达人', newGoods: '上架商品', changedGoods: '信息变更商品', newCreators: '首次合作达人' };
const kinds: Record<string, string> = { 'new-product': '商品上架', 'product-change': '商品信息变更', 'new-creator': '首次合作达人' };
const value = (v: string | null | undefined) => v ?? '来源未提供';
const initial: ShopState = { shops: [], snapshots: [], busy: false, progress: null, currentWeek: null, error: null, lastRun: null };

export function FeiguaShopMonitoring({ settingsContainer }: { settingsContainer: HTMLElement | null }) {
  const [state, setState] = useState<ShopState>(initial);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Shop[]>([]);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState('');
  const [week, setWeek] = useState('');
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [eventTypes, setEventTypes] = useState(Object.keys(kinds));
  const [filter, setFilter] = useState('');
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  useEffect(() => {
    let alive = true, pending = false;
    const read = async () => {
      if (pending) return;
      const api = window.desktopBridge?.feiguaShops;
      if (!api) { if (alive) setError('请在媒体库桌面版使用竞对店铺采集'); return; }
      pending = true;
      try { const next = await api.state(); if (alive) { setState(next); setReady(true); } }
      catch { if (alive) setError('店铺数据读取失败，已有周数据保留，请重试'); }
      finally { pending = false; }
    };
    void read(); const timer = setInterval(() => void read(), 1800);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const active = state.shops.find(s => s.id === selected) || state.shops[0];
  const weeks = [...new Set([...(state.currentWeek ? [state.currentWeek.start] : []), ...state.snapshots.filter(s => s.shop.id === active?.id).map(s => s.weekStart)])].sort().reverse();
  const activeWeek = weeks.includes(week) ? week : weeks[0] || '';
  const snapshot = state.snapshots.find(s => s.shop.id === active?.id && s.weekStart === activeWeek);
  const failed = state.lastRun?.shops.find(s => s.id === active?.id && s.status === 'failed');
  const initializing = activeWeek === state.currentWeek?.start && state.waitingShops?.some(s => s.id === active?.id);
  const disabled = !ready || state.busy || !!action;
  const events = (snapshot?.events || []).filter(e => eventTypes.includes(e.kind) && (!filter.trim() || [e.product, e.creator, ...e.changes.map(c => c.title)].some(v => v?.includes(filter.trim()))));
  const pageCount = Math.max(1, Math.ceil(events.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const firstEvent = (currentPage - 1) * pageSize;
  async function perform(name: string, operation: (api: FeiguaShopsBridge) => Promise<ShopState>) {
    const api = window.desktopBridge?.feiguaShops; if (!api) return;
    setAction(name); setError('');
    try { const next = await operation(api); setState(next); return true; }
    catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作未完成，已有数据保留'); return false; }
    finally { setAction(''); }
  }
  async function search() {
    const api = window.desktopBridge?.feiguaShops; if (!api || disabled || !query.trim()) return;
    setAction('search'); setError(''); setMatches([]); setSearched(false);
    try { setMatches(await api.search(query)); setSearched(true); }
    catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '搜索未完成，请重试'); }
    finally { setAction(''); }
  }
  async function add(shop: Shop) {
    const ok = await perform('add', async api => {
      const saved = await api.save([...state.shops, shop]); setState(saved); setSelected(shop.id); setWeek(''); setPage(1);
      return api.start({ ids: [shop.id] });
    });
    if (ok) { setQuery(''); setMatches([]); setSearched(false); }
  }
  async function remove(shop: Shop) {
    if (await perform(`remove:${shop.id}`, api => api.remove(shop.id))) { setPage(1); setWeek(''); }
  }
  return <div className={styles.monitor}>
    {settingsContainer && createPortal(<div className={`${styles.monitor} ${styles.settingsContent}`}>
    <header className={styles.heading}><div><h2><Store size={18} />竞对店铺监控</h2><p>本周周一至昨天 · 最多 10 个店铺 · 每天北京时间 07:00 后自动更新一次</p></div>
      {state.busy ? <button disabled={action === 'cancel' || action.startsWith('remove:')} onClick={() => void perform('cancel', api => api.cancel())}><Square size={14} />停止店铺操作</button>
        : <button disabled={disabled || !state.shops.length || !state.currentWeek} onClick={() => void perform('start', api => api.start())}><RefreshCw size={14} />刷新全部店铺本周数据</button>}
    </header>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {state.error && <div className={styles.error} role="alert">{state.error}</div>}
    {state.busy && <div role="status" className={styles.progress}>{state.progress || '正在准备店铺采集…'}</div>}
    {!state.busy && state.lastRun && <p role="status">{state.lastRun.message}</p>}
    {state.notice && <p role="status">{state.notice}</p>}
    <section className={styles.search} aria-label="添加竞对店铺">
      <div className={styles.searchTop}><h3>监控店铺 <small>{state.shops.length}/10</small></h3><p>搜索后确认具体店铺，同名店铺按独立标识区分。</p></div>
      <form onSubmit={e => { e.preventDefault(); void search(); }}><input aria-label="店铺名称" value={query} onChange={e => { setQuery(e.target.value); setMatches([]); setSearched(false); }} maxLength={100} placeholder="输入要监控的店铺名称" disabled={disabled || state.shops.length >= 10} /><button disabled={disabled || !query.trim() || state.shops.length >= 10}><Search size={14} />{action === 'search' ? '搜索中…' : '搜索店铺'}</button></form>
      <p>添加并采集或手动刷新时，会自动同步关注到当前飞瓜账号，占用该账号的小店关注名额；已关注的店铺不会重复添加。“同步移除”会取消飞瓜关注并释放名额，保留本地历史周数据。飞瓜规定新关注的小店满 24 小时才可移除，受限或同步失败时保留本地监控并提示原因。</p>
      {searched && !matches.length && <p>没有找到店铺，请换一个更完整的名称。</p>}
      {!!matches.length && <ul className={styles.matches}>{matches.map(shop => <li key={shop.id}><span>{shop.name}<small>店铺标识 {shop.id}</small></span><button disabled={disabled || state.shops.length >= 10 || state.shops.some(s => s.id === shop.id)} onClick={() => void add(shop)}><Plus size={13} />{state.shops.some(s => s.id === shop.id) ? '已监控' : '添加并采集'}</button></li>)}</ul>}
      {!!state.shops.length && <ul className={styles.matches} aria-label="已监控店铺设置">{state.shops.map(shop => <li key={shop.id}><strong>{shop.name}</strong><div className={styles.shopActions}><button disabled={disabled || !state.currentWeek} onClick={() => void perform('refresh', api => api.start({ ids: [shop.id] }))}>刷新本周数据</button><button disabled={disabled} aria-label={`移除监控 ${shop.name}`} title="同步取消飞瓜关注并释放名额，保留本地历史周数据" onClick={() => void remove(shop)}><X size={13} />{action === `remove:${shop.id}` ? '正在同步移除…' : '同步移除'}</button></div></li>)}</ul>}
    </section>
    </div>, settingsContainer)}
    <header className={styles.heading}><div><h2><Store size={18} />竞对店铺监控结果</h2><p>本周周一至昨天 · 在上方“采集设置”中管理监控店铺</p></div></header>
    {state.busy && <div role="status" className={styles.progress}>{state.progress || '正在准备店铺采集…'}</div>}
    {error && <div className={styles.error} role="alert">{error}</div>}
    {state.error && <div className={styles.error} role="alert">{state.error}</div>}
    {!state.shops.length ? <div className={styles.empty}><h3>添加第一个竞对店铺</h3><p>保存后将采集本周汇总、逐日数据和小店动态，每周记录独立保留。</p></div> : <>
      <nav className={styles.shops} aria-label="选择监控店铺">{state.shops.map(shop => <div key={shop.id} className={active?.id === shop.id ? styles.selected : ''}><button aria-pressed={active?.id === shop.id} onClick={() => { setSelected(shop.id); setWeek(''); setPage(1); }}>{shop.name}</button></div>)}</nav>
      <div className={styles.period}><h3>{active?.name}</h3><label>查看周数据 <select aria-label="店铺周记录" value={activeWeek} onChange={e => { setWeek(e.target.value); setPage(1); }}>{weeks.map(date => <option key={date} value={date}>{date} 起{date === state.currentWeek?.start ? '（本周）' : ''}</option>)}</select></label></div>
      {!state.currentWeek && <p>本周尚无已结束日期，周二起更新本周数据；已保存的历史周仍可查看。</p>}
      {initializing && <div className={styles.progress} role="status">店铺已同步关注，飞瓜暂未提供完整可读取的周数据。软件会自动重试，无需重新添加。保持软件运行并登录飞瓜即可。</div>}
      {failed && <div className={styles.error} role="status">{failed.message}。{snapshot ? '下方保留上次成功保存的周数据。' : '本周尚无已保存数据。'}</div>}
      {initializing ? <div className={styles.empty}>等待飞瓜数据就绪{snapshot ? '；已有记录保留，初始化完成后重新核验并更新。' : '，暂不显示未准备好的周明细和动态。'}</div> : !snapshot ? <div className={styles.empty}>该店本周尚未采集成功，或该历史周没有记录。</div> : <>
        <p className={styles.source}>统计日期：{snapshot.weekStart} — {snapshot.through} · 更新于 {new Date(snapshot.collectedAt).toLocaleString('zh-CN', { hour12: false })} · 数值保留飞瓜原始区间</p>
        <div className={styles.metrics}>{Object.entries(fields).map(([key, label]) => <div key={key}><span>{label}</span><strong>{value(snapshot.metrics[key])}</strong></div>)}</div>
        <section className={styles.block}><h3>每日数据</h3><div className={styles.table}><table><thead><tr><th>日期</th>{Object.entries(fields).map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead><tbody>{snapshot.days.map(row => <tr key={row.date}><td>{row.date}</td>{Object.keys(fields).map(key => <td key={key}>{value(row[key])}</td>)}</tr>)}</tbody></table></div></section>
        <div className={styles.twoColumns}><section className={styles.block}><h3>商品上架节奏</h3><div className={styles.bars}>{snapshot.trend.map(row => <div key={row.date}><span>{row.date.slice(5)}</span><i style={{ height: `${Math.max(2, Number(row.count) / Math.max(1, ...snapshot.trend.map(r => Number(r.count))) * 90)}px` }} /><b>{row.count}</b></div>)}</div></section><section className={styles.block}><h3>上架商品 Top10</h3><div className={styles.table}><table><thead><tr><th>商品</th><th>上架日期</th><th>销售额</th><th>销量</th></tr></thead><tbody>{snapshot.newGoods.map(row => <tr key={row.id}><td>{row.title}</td><td>{value(row.listedAt)}</td><td>{value(row.sales)}</td><td>{value(row.salesCount)}</td></tr>)}</tbody></table>{!snapshot.newGoods.length && <p>本周没有新增上架商品。</p>}</div></section></div>
        <section className={styles.block}><div className={styles.eventHeader}><h3>小店动态</h3><input aria-label="筛选店铺动态" value={filter} onChange={e => { setFilter(e.target.value); setPage(1); }} placeholder="筛选商品名称、达人或动态内容" /></div><div className={styles.filters}>{Object.entries(kinds).map(([key, label]) => <label key={key}><input type="checkbox" checked={eventTypes.includes(key)} onChange={e => { setEventTypes(e.target.checked ? [...eventTypes, key] : eventTypes.filter(t => t !== key)); setPage(1); }} />{label}（{snapshot.events.filter(e => e.kind === key).length}）</label>)}</div>
          <p>已保存 {snapshot.events.length} 条动态，当前筛选 {events.length} 条</p>
          <ol className={styles.events} aria-label="本页小店动态">{events.slice(firstEvent, firstEvent + pageSize).map((event, i) => <li key={`${event.date}-${firstEvent + i}`}><time>{event.date}</time><article><div className={styles.eventTitle}><strong>{event.creator || event.product}</strong><span>{kinds[event.kind]}</span></div>{event.creator && <p>粉丝数：{value(event.fans)}</p>}{event.product && event.creator && <p>{event.product}</p>}{event.changes.map((change, j) => <div key={j} className={styles.change}><p>{change.type === 40 ? '首次带货直播' : change.type === 41 ? '首次带货视频' : change.type === 20 ? '主图变更' : change.type === 10 ? '商品上架' : '商品信息变更'}{change.title ? `：${change.title}` : ''}</p>{(change.before || change.after) && <p>{value(change.before)} → {value(change.after)}</p>}</div>)}</article></li>)}</ol>
          {!events.length && <p>当前条件没有动态。</p>}
          <nav className={styles.pagination} aria-label="小店动态分页"><label>每页 <select aria-label="小店动态每页条数" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}>{[10, 20, 50, 100].map(size => <option key={size} value={size}>{size} 条</option>)}</select></label><span role="status">{events.length ? `${firstEvent + 1}–${Math.min(firstEvent + pageSize, events.length)} / ${events.length} 条` : '0 条'}</span><button disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button><label>第 <select aria-label="小店动态页码" value={currentPage} disabled={!events.length} onChange={e => setPage(Number(e.target.value))}>{Array.from({ length: pageCount }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select> / {events.length ? pageCount : 0} 页</label><button disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button></nav>
        </section>
      </>}
    </>}
  </div>;
}
