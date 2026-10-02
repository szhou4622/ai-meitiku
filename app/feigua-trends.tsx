"use client";

import { useEffect, useRef, useState } from 'react';
import { Globe2, Music2, TrendingUp, Plus, X, RefreshCw, LogIn, Square, Search } from 'lucide-react';
import styles from './feigua-trends.module.css';
import { displayedFeiguaGroups } from './feigua-results.mjs';

type Kind = 'music' | 'topics' | 'hotspots' | 'videos';
type Row = { id: string; rank: number; title: string; author?: string; totalUsers?: string; yesterdayUsers?: string; followers?: string; participantGrowth?: string; playGrowth?: string; peakHeat?: string; plays?: string; likes?: string; sales?: string; publishedAt?: string; products?: { title: string; commission: string | null }[]; missingFields: string[] };
type Result = { collectedAt: string; dateRange: string | null; period: string; rows: Row[]; filters?: { category?: string; categoryPath?: string[] } };
type Group = { kind: Kind; keyword: string | null; status: string; message?: string; result?: Result; musicTag?: string[]; showingPrevious?: boolean; refreshStatus?: string; refreshMessage?: string; requestedMusicTag?: string[] };
type Run = { id: string; startedAt: string; finishedAt: string | null; status: string; message: string; keywords: string[]; groups: Group[] };
type MusicTagOption = { label: string; children: { label: string }[] };
type State = { keywords: string[]; musicTag: string[]; musicTagOptions: MusicTagOption[]; musicTagOptionsLoadedAt: string | null; musicTagRestricted: boolean; latestResults: Group[]; runs: Run[]; auth: { status: string; message: string }; busy: boolean; scheduleMessage?: string | null };
export type FeiguaBridge = {
  state: () => Promise<State>;
  saveKeywords: (keywords: string[]) => Promise<State>;
  saveMusicTag: (path: string[]) => Promise<State>;
  saveAndRefreshMusicTag: (path: string[]) => Promise<State>;
  refreshMusicTags: () => Promise<State>;
  login: () => Promise<State>;
  checkLogin: () => Promise<State>;
  start: () => Promise<State>;
  cancel: () => Promise<State>;
};
const emptyState: State = { keywords: [], musicTag: [], musicTagOptions: [], musicTagOptionsLoadedAt: null, musicTagRestricted: false, latestResults: [], runs: [], busy: false, auth: { status: 'unknown', message: '登录后自动采集' } };
const names: Record<string, string> = { pending: '等待采集', running: '采集中', completed: '采集完成', partial: '部分完成', failed: '采集失败', interrupted: '采集中断', skipped: '未采集', cancelled: '已取消' };
const labels: Record<Kind, string> = { music: '本周爆款 BGM', topics: '本周话题热点', hotspots: '全网热点', videos: '关键词带货视频' };
const rules: Record<Kind, string> = { music: '热门音乐 · 昨日使用人数降序', topics: '话题周榜 · 全部分类 · 参与人数增长率降序', hotspots: '抖音热点榜 · 日榜 · 峰值热度降序', videos: '近7天 · 视频销售额降序' };
const display = (value?: string | null) => value || '未取得';
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });

function ResultBody({ group, kind }: { group?: Group; kind: Kind }) {
  if (!group?.result) return <div className={styles.empty}><span>{group ? names[group.status] : '尚未采集'}</span><p>{group?.message || '采集完成后，飞瓜的前 5 条结果会显示在这里。'}</p></div>;
  if (!group.result.rows.length) return <div className={styles.empty}>飞瓜在当前筛选条件下暂无结果</div>;
  if (kind !== 'videos') return <ol className={styles.ranking}>
    {group.result.rows.map(row => <li key={row.id} className={styles.compactRow}>
      <span className={styles.rank}>{row.rank}</span>
      <div className={styles.rankText}>
        <div className={styles.rankTitle} title={`${row.title}${row.author ? ` · ${row.author}` : ''}`}><strong>{row.title}</strong>{kind === 'music' && <span> · {display(row.author)}</span>}</div>
        {kind === 'topics' && <p title={`发起人：${display(row.author)} · 粉丝 ${display(row.followers)}`}>发起人：{display(row.author)} · 粉丝 {display(row.followers)}</p>}
      </div>
      <div className={styles.rankNumbers}>
        {kind === 'music' && <><div>累计 <b>{display(row.totalUsers)}</b></div><div>昨日 <b>{display(row.yesterdayUsers)}</b></div></>}
        {kind === 'topics' && <><div>播放增长 <b>{display(row.playGrowth)}</b></div><div>参与增长 <b>{display(row.participantGrowth)}</b></div></>}
        {kind === 'hotspots' && <div>热度 <b>{display(row.peakHeat)}</b></div>}
      </div>
    </li>)}
  </ol>;
  return <ol className={styles.videoList}>
    {group.result.rows.map(row => <li key={row.id}>
      <span className={styles.rank}>{String(row.rank).padStart(2, '0')}</span>
      <div className={styles.rowContent}>
        <h4 title={row.title}>{row.title}</h4>
        {kind === 'videos' && <>
          <div className={styles.products}>{row.products?.length ? row.products.map((product, index) => <p key={index}>{product.title}<small>佣金率 {display(product.commission)}</small></p>) : <p>关联商品未取得</p>}</div>
          <p>{display(row.author)} · 粉丝 {display(row.followers)}</p>
          <dl><div><dt>播放</dt><dd>{display(row.plays)}</dd></div><div><dt>点赞</dt><dd>{display(row.likes)}</dd></div><div><dt>销售额</dt><dd>{display(row.sales)}</dd></div></dl>
          {row.publishedAt && <small>发布时间 {row.publishedAt}</small>}
        </>}
        {!!row.missingFields.length && <small className={styles.missing}>部分字段未取得</small>}
      </div>
    </li>)}
  </ol>;
}

function MusicCaption({group, selection, dirty, history}: {group?: Group; selection:string[]; dirty:boolean; history:boolean}) {
  const selected = (history ? group?.musicTag || group?.result?.filters?.categoryPath || [] : selection).join(' > ') || '全部';
  const actual = group?.result?.filters?.category || group?.musicTag?.join(' > ') || '全部';
  const status = group?.refreshStatus || group?.status;
  const refreshing = !history && ['pending', 'running'].includes(status || '');
  const failed = !history && ['failed','cancelled','interrupted'].includes(status || '');
  return <>
    <p>飞瓜数据 · 热门音乐 · 视频标签：<strong>{selected}</strong>{dirty && !history ? '（未保存）' : ''} · 昨日使用人数降序</p>
    {refreshing && <p className={styles.refreshing} role="status">正在刷新「{group?.requestedMusicTag?.join(' > ') || group?.musicTag?.join(' > ') || '全部'}」热门 BGM…</p>}
    {failed && <p className={styles.refreshError} role="status">「{group?.requestedMusicTag?.join(' > ') || group?.musicTag?.join(' > ') || '全部'}」刷新未完成：{group?.refreshMessage || group?.message || names[status || 'failed']}</p>}
    {group?.result && (actual !== selected || group.showingPrevious) && <p>当前显示：{actual} · 上次采集结果</p>}
    {!group?.result && !refreshing && !failed && !dirty && <p>该类目尚未采集，保存后将自动刷新</p>}
  </>;
}

export function FeiguaTrends() {
  const [state, setState] = useState<State>(emptyState);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [musicTag, setMusicTag] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [error, setError] = useState('');
  const [action, setAction] = useState('');
  const [selectedRun, setSelectedRun] = useState('');
  const initialized = useRef(false);
  const dirty = JSON.stringify(keywords) !== JSON.stringify(state.keywords);
  const musicDirty = JSON.stringify(musicTag) !== JSON.stringify(state.musicTag);
  const firstTag = state.musicTagOptions.find(option => option.label === musicTag[0]);
  const secondTags = firstTag?.children || [];
  const effectiveRunId = state.runs.some(item => item.id === selectedRun) ? selectedRun : '';
  const run = state.runs.find(item => item.id === effectiveRunId) || state.runs[0];
  const displayedGroups = displayedFeiguaGroups(state.runs, effectiveRunId, state.latestResults) as Group[];
  const displayedCount = displayedGroups.reduce((sum, group) => sum + (group.result?.rows.length || 0), 0);

  useEffect(() => {
    let alive = true, pending = false;
    const update = async () => {
      const api = window.desktopBridge?.feigua;
      if (!api) { if (alive) setLoaded(true); return; }
      if (pending) return;
      pending = true;
      try {
        const next = await api.state();
        if (!alive) return;
        setDesktop(true); setState({ ...emptyState, ...next }); setLoaded(true);
        if (!initialized.current) { setKeywords(next.keywords); setMusicTag(next.musicTag || []); initialized.current = true; }
      } catch { if (alive) { setError('热点数据读取失败，请重试；原有数据不会被覆盖。'); setLoaded(true); } }
      finally { pending = false; }
    };
    void update();
    const timer = setInterval(() => void update(), 1800);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  async function perform(name: string, operation: (api: FeiguaBridge) => Promise<State>) {
    const api = window.desktopBridge?.feigua;
    if (!api) { setError('请在 AI 媒体库桌面版使用飞瓜采集'); return; }
    setAction(name); setError('');
    try {
      const next = await operation(api); setState({ ...emptyState, ...next });
      if (name === 'save') setKeywords(next.keywords);
      if (name === 'music-save') { setMusicTag(next.musicTag); setSelectedRun(''); }
      if (name === 'start') setSelectedRun('');
    } catch (error) { setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作失败，请重试'); }
    finally { setAction(''); }
  }

  function addKeyword() {
    const keyword = input.trim();
    if (!keyword) return;
    if (keyword.length > 60 || /[\r\n\u0000-\u001f]/.test(keyword)) { setError('每个关键词限 60 字，不含换行'); return; }
    if (keywords.some((item, index) => item === keyword && index !== editing)) { setError('该关键词已存在'); return; }
    if (editing === null && keywords.length >= 50) { setError('最多保存 50 个关键词'); return; }
    setKeywords(editing === null ? [...keywords, keyword] : keywords.map((item, index) => index === editing ? keyword : item));
    setInput(''); setEditing(null); setError('');
  }

  const disabled = !desktop || !loaded || !!action;
  return <section className={styles.page}>
    <header className={styles.heading}>
      <div><h1>热点采集</h1><p>飞瓜抖音数据 · 发现热门音乐、话题与带货视频</p></div>
      <div className={styles.actions}>
        <button disabled={disabled || state.busy || dirty || musicDirty} onClick={() => void perform('login', api => api.login())}><LogIn size={16} />登录飞瓜</button>
        {state.busy ? <button disabled={disabled} onClick={() => void perform('cancel', api => api.cancel())}><Square size={14} />停止采集</button>
          : <button className={styles.primary} disabled={disabled || dirty || musicDirty || !!input.trim() || editing !== null || state.auth.status !== 'authenticated'} onClick={() => void perform('start', api => api.start())}><RefreshCw size={16} />{action === 'start' ? '准备中…' : '开始采集'}</button>}
      </div>
    </header>
    <div className={styles.connection} role="status"><span className={state.auth.status === 'authenticated' ? styles.online : styles.dot} />{!loaded ? '正在读取本地数据…' : !desktop ? '请在桌面版登录飞瓜并采集，网页版仅展示入口。' : displayedCount > 0 && !state.busy && state.auth.status !== 'authenticated' ? '已加载本地采集结果，登录后可更新' : state.auth.message}<span>登录后自动采集 · 数据保存在当前电脑</span></div>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {state.scheduleMessage && <div className={styles.error} role="alert">{state.scheduleMessage}</div>}
    <p>全网热点日榜每天北京时间 07:00 自动采集；请保持应用运行并登录飞瓜。错过时间后，当天重新打开或恢复运行时补采一次。</p>

    <details className={styles.settings}>
      <summary>采集设置 <span>BGM：{state.musicTag.join(' > ') || '全部标签'} · {state.keywords.length} 个关键词{dirty || musicDirty ? ' · 有未保存修改' : ''}</span></summary>
    <section className={`${styles.configuration} ${styles.musicConfiguration}`} aria-label="BGM 视频标签配置">
      <div><h2>本周爆款 BGM · 视频标签</h2><p>选择一级或二级分类，按昨日使用人数降序取前 5</p></div>
      <div className={styles.tagSelectors}>
        <label>一级分类<select aria-label="BGM 一级分类" value={musicTag[0] || ''} disabled={disabled || !state.musicTagOptions.length} onChange={event => setMusicTag(event.target.value ? [event.target.value] : [])}>
          <option value="">全部视频标签</option>
          {!!musicTag[0] && !firstTag && <option value={musicTag[0]} disabled>{musicTag[0]}（目录中已失效）</option>}
          {state.musicTagOptions.map(option => <option key={option.label} value={option.label}>{option.label}</option>)}
        </select></label>
        <label>二级分类<select aria-label="BGM 二级分类" value={musicTag[1] || ''} disabled={disabled || !secondTags.length} onChange={event => setMusicTag(event.target.value ? [musicTag[0], event.target.value] : [musicTag[0]])}>
          <option value="">{musicTag[0] ? `全部${musicTag[0]}` : '先选择一级分类'}</option>
          {!!musicTag[1] && !secondTags.some(option => option.label === musicTag[1]) && <option value={musicTag[1]} disabled>{musicTag[1]}（目录中已失效）</option>}
          {secondTags.map(option => <option key={option.label} value={option.label}>{option.label}</option>)}
        </select></label>
        <button className={styles.primary} disabled={disabled || state.busy} onClick={() => void perform('music-save', api => api.saveAndRefreshMusicTag(musicTag))}>{action === 'music-save' ? '正在保存并刷新…' : '保存并刷新 BGM'}</button>
        <button disabled={disabled || state.busy} onClick={() => void perform('music-refresh', api => api.refreshMusicTags())}><RefreshCw size={14} />{action === 'music-refresh' ? '读取分类中…' : '刷新飞瓜分类'}</button>
      </div>
      <small>{musicDirty ? `已选择：${musicTag.join(' > ') || '全部视频标签'}，点击“保存并刷新 BGM”立即更新榜单。` : `已保存：${state.musicTag.join(' > ') || '全部视频标签'} · 保存后自动刷新 BGM`}{!state.musicTagOptions.length ? ' · 首次登录后自动加载分类，也可点击刷新。' : ''}</small>
    </section>

    <section className={styles.configuration} aria-label="关键词配置">
      <div><h2>带货视频关键词</h2><p>每个关键词独立采集销售额前 5 · 时间周期近7天</p></div>
      <form onSubmit={event => { event.preventDefault(); addKeyword(); }}>
        <input aria-label="视频关键词" placeholder="输入关键词，按回车添加" maxLength={60} value={input} onChange={event => setInput(event.target.value)} disabled={disabled} />
        <button type="submit" disabled={disabled || !input.trim()}><Plus size={15} />{editing === null ? '添加' : '确认修改'}</button>
        <button type="button" className={styles.primary} disabled={disabled || !dirty || editing !== null || !!input.trim()} onClick={() => void perform('save', api => api.saveKeywords(keywords))}>{action === 'save' ? '保存中…' : '保存关键词'}</button>
      </form>
      <div className={styles.tags}>{keywords.map((keyword, index) => <span key={`${index}:${keyword}`}><button disabled={disabled} title={`修改「${keyword}」`} onClick={() => { setEditing(index); setInput(keyword); }}>{keyword}</button><button disabled={disabled} aria-label={`删除关键词${keyword}`} onClick={() => { setKeywords(keywords.filter((_, current) => current !== index)); setEditing(null); setInput(''); }}><X size={13} /></button></span>)}</div>
      <small>{editing !== null ? '正在修改关键词，确认后请保存。' : dirty ? '配置尚未保存。保存后用于下一次采集，当前任务保持原关键词。' : keywords.length ? `已保存 ${keywords.length} 个关键词，点击词条可以修改。` : '尚未配置关键词。仍可采集 BGM、话题和全网热点三个榜单。'}</small>
    </section>
    </details>

    <div className={styles.history}>
      <h2>采集结果</h2>
      {state.runs.length > 0 && <label>采集批次 <select aria-label="采集批次" value={effectiveRunId} onChange={event => setSelectedRun(event.target.value)}><option value="">最新已采集结果</option>{state.runs.map(item => <option key={item.id} value={item.id}>{date(item.startedAt)} · {names[item.status]}</option>)}</select></label>}
      <span role="status">{run ? effectiveRunId ? `${names[run.status]} · ${run.message}` : state.busy ? `${run.message} · 已有结果持续显示` : `已展示 ${displayedCount} 条采集结果` : '登录后自动采集'}</span>
    </div>
    <div className={styles.boards}>
      {(['music', 'topics', 'hotspots'] as Kind[]).map(kind => {
        const group = displayedGroups.find(item => item.kind === kind);
        const Icon = kind === 'music' ? Music2 : kind === 'topics' ? TrendingUp : Globe2;
        return <section key={kind} className={styles.board}><header><h3><Icon size={17} />{labels[kind]} <small>TOP 5</small></h3>{kind === 'music' ? <MusicCaption group={group} selection={musicTag} dirty={musicDirty} history={!!effectiveRunId} /> : <p>{rules[kind]}</p>}{kind !== 'music' && group?.showingPrevious && <p>本次更新尚未成功，显示上次已采集结果</p>}</header><ResultBody group={group} kind={kind} />{group?.result && <footer>{group.result.dateRange || group.result.period} · 采集于 {date(group.result.collectedAt)}</footer>}</section>;
      })}
    </div>
    <section className={styles.videoSection}><header><h2><Search size={18} />本周品类新发布 Top5 带货视频</h2><p>按关键词分组 · 近7天统计周期，不额外限制视频发布时间</p></header>
      {displayedGroups.filter(group => group.kind === 'videos').map(group => <section className={styles.videoGroup} key={group.keyword}><h3>{group.keyword}<small>{rules.videos} · {group.showingPrevious ? '上次已采集结果' : names[group.status]}</small></h3><ResultBody group={group} kind="videos" />{group.result && <footer>{group.result.dateRange || group.result.period} · 采集于 {date(group.result.collectedAt)}</footer>}</section>)}
      {!displayedGroups.some(group => group.kind === 'videos') && <div className={styles.empty}>{state.keywords.length ? '下一次采集将按已保存的关键词生成视频榜单。' : '添加并保存关键词后，这里将显示各组视频 Top5。'}</div>}
    </section>
  </section>;
}
