"use client";

import { useEffect, useRef, useState } from 'react';
import { Globe2, Music2, TrendingUp, Plus, X, RefreshCw, LogIn, Square, Search } from 'lucide-react';
import styles from './feigua-trends.module.css';
import { displayedFeiguaGroups } from './feigua-results.mjs';
import { recoverVideoHistory, videoHistoryPeriods, videoGroupsForPeriod } from '../electron/feigua-video-history.mjs';
import { feiguaVideoLink, feiguaProductLink } from '../electron/feigua-links.mjs';

type Kind = 'music' | 'topics' | 'hotspots' | 'videos';
type Row = { id: string; rank: number; title: string; videoUrl?: string | null; author?: string; totalUsers?: string; yesterdayUsers?: string; followers?: string; participantGrowth?: string; playGrowth?: string; peakHeat?: string; plays?: string; playsScope?: string; likes?: string; comments?: string; shares?: string; collects?: string; sales?: string; salesCount?: string; publishedAt?: string; products?: { title: string; commission: string | null; url?: string | null; hasCommission?: boolean }[]; fieldAvailability?: {plays?:string;commission?:string}; missingFields: string[] };
type Result = { collectedAt: string; dateRange: string | null; dateWarning?: string | null; period: string; rows: Row[]; filters?: { category?: string; categoryPath?: string[]; tagPath?: string[] } };
type Group = { kind: Kind; keyword: string | null; status: string; message?: string; result?: Result; musicTag?: string[]; categoryPath?: string[]; tagPath?: string[]; showingPrevious?: boolean; refreshStatus?: string; refreshMessage?: string; requestedMusicTag?: string[] };
type Run = { id: string; startedAt: string; finishedAt: string | null; status: string; message: string; keywords: string[]; groups: Group[] };
type MusicTagOption = { label: string; children: { label: string }[] };
type VideoQuery = { keyword: string; categoryPath: string[]; tagPath: string[] };
type CategoryOption = { label: string; children: CategoryOption[] };
type State = { loginEntryUrl?: string; keywords: string[]; videoQueries?: VideoQuery[]; videoHistory?: Group[]; videoFilterOptions: { categoryPath: CategoryOption[]; tagPath: CategoryOption[] }; musicTag: string[]; musicTagOptions: MusicTagOption[]; musicTagOptionsLoadedAt: string | null; musicTagRestricted: boolean; latestResults: Group[]; runs: Run[]; auth: { status: string; message: string }; busy: boolean; credentialMessage?: string | null; storageMessage?: string | null; scheduleMessage?: string | null; catalogMessage?: string | null };
export type FeiguaBridge = {
  state: () => Promise<State>;
  saveLoginEntryUrl: (url: string) => Promise<State>;
  saveKeywords: (keywords: string[]) => Promise<State>;
  saveAndRefreshVideoQueries: (queries: VideoQuery[], options?: { changedOnly: boolean }) => Promise<State>;
  saveMusicTag: (path: string[]) => Promise<State>;
  saveAndRefreshMusicTag: (path: string[]) => Promise<State>;
  refreshMusicTags: () => Promise<State>;
  login: (options?: { collectAfterLogin: boolean }) => Promise<State>;
  checkLogin: () => Promise<State>;
  start: () => Promise<State>;
  cancel: () => Promise<State>;
};
const emptyState: State = { keywords: [], videoFilterOptions: { categoryPath: [], tagPath: [] }, musicTag: [], musicTagOptions: [], musicTagOptionsLoadedAt: null, musicTagRestricted: false, latestResults: [], runs: [], busy: false, auth: { status: 'unknown', message: '登录后自动采集' } };
const savedVideoQueries = (state: State): VideoQuery[] => state.videoQueries || state.keywords.map(keyword => ({ keyword, categoryPath: [], tagPath: [] }));
const pathLabel = (path?: string[]) => path?.join(' > ') || '全部';
const names: Record<string, string> = { pending: '等待采集', running: '采集中', retrying: '自动重试中', waiting: '等待新周榜', completed: '采集完成', partial: '部分完成', failed: '采集失败', interrupted: '采集中断', skipped: '未采集', cancelled: '已取消' };
const labels: Record<Kind, string> = { music: '本周爆款 BGM', topics: '本周话题热点', hotspots: '全网热点', videos: '关键词带货视频' };
const rules: Record<Kind, string> = { music: '热门音乐 · 昨日使用人数降序', topics: '话题周榜 · 参与人数增长率降序', hotspots: '抖音热点榜 · 日榜 · 峰值热度降序', videos: '近7天 · 视频销售额降序' };
const display = (value?: string | null) => value || '未取得';
const unavailable = (state?: string) => state === 'source_unavailable' ? '来源未提供' : state === 'restricted' ? '来源访问受限' : state === 'lookup_failed' ? '详情暂未核验' : '未取得';
const missingLabels: Record<string,string> = {products:'商品 / 佣金率',author:'达人名称',followers:'粉丝数',likes:'点赞数',sales:'视频销售额',salesCount:'视频销量',publishedAt:'发布时间',title:'视频标题'};
const videoMissingFields = (row: Row) => row.missingFields.filter(field => !['plays','comments','shares','collects'].includes(field));
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });

function ResultFooter({ result }: { result: Result }) {
  return <footer>{result.dateRange || result.period} · 采集于 {date(result.collectedAt)}{result.dateWarning && <p className={styles.missing} role="status">{result.dateWarning}</p>}</footer>;
}

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
        <h4 title={row.title}>{feiguaVideoLink(row.videoUrl, row.id) ? <a className={styles.contentLink} href={feiguaVideoLink(row.videoUrl, row.id)!} target="_blank" rel="noopener noreferrer" title="在浏览器中打开抖音视频">{row.title}</a> : row.title}</h4>
        {kind === 'videos' && <>
          <div className={styles.products}>{row.products?.length ? row.products.map((product, index) => <p key={index}>{feiguaProductLink(product.url) ? <a className={styles.contentLink} href={feiguaProductLink(product.url)!} target="_blank" rel="noopener noreferrer" title="在浏览器中打开对应商品">{product.title}</a> : product.title}<small title={product.hasCommission === false ? '飞瓜详情显示值，来源未标记有推广佣金' : undefined}>佣金率 {product.commission || unavailable(row.fieldAvailability?.commission)}</small></p>) : <p>关联商品未取得</p>}</div>
          <p>{display(row.author)} · 粉丝 {display(row.followers)}</p>
          <dl><div><dt>视频销售额</dt><dd>{display(row.sales)}</dd></div><div><dt>视频销量</dt><dd>{display(row.salesCount)}</dd></div><div><dt>点赞</dt><dd>{display(row.likes)}</dd></div></dl>
          {row.publishedAt && <small>发布时间 {row.publishedAt}</small>}
        </>}
        {!!(kind === 'videos' ? videoMissingFields(row).length : row.missingFields.length) && <small className={styles.missing}>{kind === 'videos' ? `未取得：${videoMissingFields(row).map(field=>missingLabels[field]||field).join('、')}` : '部分字段未取得'}</small>}
      </div>
    </li>)}
  </ol>;
}

function MusicCaption({group, kind, selection, dirty}: {group?: Group; kind:'music'|'topics'; selection:string[]; dirty:boolean}) {
  const selected = selection.join(' > ') || '全部';
  const actual = group?.result?.filters?.category || group?.musicTag?.join(' > ') || '全部';
  const status = group?.refreshStatus || group?.status;
  const queued = status === 'pending';
  const refreshing = status === 'running';
  const retrying = status === 'retrying';
  const failed = ['failed','cancelled','interrupted'].includes(status || '');
  return <>
    <p>飞瓜数据 · {kind === 'music' ? '热门音乐 · 视频标签' : '话题周榜 · 话题分类'}：<strong>{selected}</strong>{dirty ? '（未保存）' : ''} · {kind === 'music' ? '昨日使用人数降序' : '参与人数增长率降序'}</p>
    {retrying && <p className={styles.refreshing} role="status">{group?.refreshMessage || group?.message || '网络暂时不可用，正在自动重试'}</p>}
    {status === 'waiting' && <p role="status">{group?.refreshMessage || group?.message || '新一期话题周榜尚未发布，保留已有结果，下次 09:00 再检查'}</p>}
    {(refreshing || queued) && <p className={styles.refreshing} role="status">{queued ? '等待采集' : '正在刷新'}「{group?.requestedMusicTag?.join(' > ') || group?.musicTag?.join(' > ') || '全部'}」{kind === 'music' ? '热门 BGM' : '话题榜单'}…</p>}
    {failed && <p className={styles.refreshError} role="status">「{group?.requestedMusicTag?.join(' > ') || group?.musicTag?.join(' > ') || '全部'}」刷新未完成：{group?.refreshMessage || group?.message || names[status || 'failed']}</p>}
    {group?.result && (actual !== selected || group.showingPrevious) && <p>当前显示：{actual} · 上次采集结果</p>}
    {!group?.result && !refreshing && !queued && !retrying && !failed && status !== 'waiting' && !dirty && <p>该类目尚未采集，保存后将自动刷新</p>}
  </>;
}

function CategorySelect({ label, options, path, disabled, onChange }: { label: string; options: CategoryOption[]; path: string[]; disabled: boolean; onChange: (path: string[]) => void }) {
  const levels: CategoryOption[][] = [options];
  for (let depth = 0; depth < path.length && depth < 4; depth++) {
    const children = levels[depth]?.find(option => option.label === path[depth])?.children || [];
    if (!children.length && !path[depth + 1]) break;
    levels.push(children);
  }
  return <div className={styles.tagSelectors}>{levels.map((items, depth) => <label key={depth}>{depth === 0 ? label : `${depth + 1}级`}
    <select aria-label={`${label}第${depth + 1}级`} value={path[depth] || ''} disabled={disabled || !items.length} onChange={event => onChange(event.target.value ? [...path.slice(0, depth), event.target.value] : path.slice(0, depth))}>
      <option value="">全部{depth ? path[depth - 1] : ''}</option>
      {!!path[depth] && !items.some(item => item.label === path[depth]) && <option value={path[depth]} disabled>{path[depth]}（目录中已失效）</option>}
      {items.map(item => <option key={item.label} value={item.label}>{item.label}</option>)}
    </select>
  </label>)}</div>;
}

export function FeiguaTrends() {
  const [state, setState] = useState<State>(emptyState);
  const [loginEntryUrl, setLoginEntryUrl] = useState('');
  const [videoQueries, setVideoQueries] = useState<VideoQuery[]>([]);
  const [videoPeriod, setVideoPeriod] = useState('');
  const keywords = videoQueries.map(query => query.keyword);
  const [musicTag, setMusicTag] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [inputCategoryPath, setInputCategoryPath] = useState<string[]>([]);
  const [inputTagPath, setInputTagPath] = useState<string[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [error, setError] = useState('');
  const [action, setAction] = useState('');
  const initialized = useRef(false);
  const settingsPanel = useRef<HTMLDetailsElement>(null);
  const dirty = JSON.stringify(videoQueries) !== JSON.stringify(savedVideoQueries(state));
  const musicDirty = JSON.stringify(musicTag) !== JSON.stringify(state.musicTag);
  const loginEntryDirty = loginEntryUrl.trim() !== (state.loginEntryUrl || '');
  const editorDirty = !!input.trim() || editing !== null || !!inputCategoryPath.length || !!inputTagPath.length;
  const firstTag = state.musicTagOptions.find(option => option.label === musicTag[0]);
  const secondTags = firstTag?.children || [];
  const run = state.runs[0];
  const displayedGroups = (displayedFeiguaGroups(state.runs, '', state.latestResults) as Group[]).filter(group => group.kind !== 'videos' || state.keywords.includes(group.keyword || ''));
  const videoHistory = recoverVideoHistory(state.runs, state.latestResults, state.videoHistory || []) as Group[];
  const videoPeriods = videoHistoryPeriods(videoHistory, state.keywords) as string[];
  const videoGroups = videoGroupsForPeriod(videoHistory, videoPeriod, displayedGroups, state.keywords) as Group[];
  const displayedCount = [...displayedGroups.filter(group => group.kind !== 'videos'), ...videoGroups].reduce((sum, group) => sum + (group.result?.rows.length || 0), 0);

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
        if (!initialized.current) { setLoginEntryUrl(next.loginEntryUrl || ''); setVideoQueries(savedVideoQueries(next)); setMusicTag(next.musicTag || []); initialized.current = true; }
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
      if (name === 'entry-save') setLoginEntryUrl(next.loginEntryUrl || '');
      if (name === 'video-save' || name === 'video-change') {
        setVideoPeriod('');
        setVideoQueries(savedVideoQueries(next));
        if (name === 'video-save' && settingsPanel.current) settingsPanel.current.open = false;
      }
      if (name === 'music-save') {
        setMusicTag(next.musicTag);
        if (settingsPanel.current) settingsPanel.current.open = false;
      }
      return true;
    } catch (error) { setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作失败，请重试'); }
    finally { setAction(''); }
  }

  async function addKeyword() {
    const keyword = input.trim();
    if (!keyword) return;
    if (keyword.length > 60 || /[\r\n\u0000-\u001f]/.test(keyword)) { setError('每个关键词限 60 字，不含换行'); return; }
    if (keywords.some((item, index) => item === keyword && index !== editing)) { setError('该关键词已存在'); return; }
    if (editing === null && keywords.length >= 50) { setError('最多保存 50 个关键词'); return; }
    const query = { keyword, categoryPath: [...inputCategoryPath], tagPath: [...inputTagPath] };
    const next = editing === null ? [...videoQueries, query] : videoQueries.map((item, index) => index === editing ? query : item);
    if (await perform('video-change', api => api.saveAndRefreshVideoQueries(next, { changedOnly: true }))) clearEditor();
  }

  function clearEditor() {
    setInput(''); setInputCategoryPath([]); setInputTagPath([]); setEditing(null);
  }

  function editQuery(query: VideoQuery, index: number) {
    setInput(query.keyword); setInputCategoryPath([...query.categoryPath]); setInputTagPath([...query.tagPath]); setEditing(index);
  }

  const disabled = !desktop || !loaded || !!action;
  return <section className={styles.page}>
    <header className={styles.heading}>
      <div><h1>热点采集</h1><p>飞瓜抖音数据 · 发现热门音乐、话题与带货视频</p></div>
      <div className={styles.actions}>
        <button disabled={disabled || state.busy || loginEntryDirty || !state.loginEntryUrl} onClick={() => void perform('login', api => api.login({ collectAfterLogin: !dirty && !musicDirty && !editorDirty }))}><LogIn size={16} />打开登录入口</button>
        {state.busy ? <button disabled={disabled} onClick={() => void perform('cancel', api => api.cancel())}><Square size={14} />停止采集</button>
          : <button className={styles.primary} disabled={disabled || loginEntryDirty || dirty || musicDirty || editorDirty || state.auth.status !== 'authenticated'} onClick={() => void perform('start', api => api.start())}><RefreshCw size={16} />{action === 'start' ? '准备中…' : '开始采集'}</button>}
      </div>
    </header>
    <form className={styles.loginEntry} onSubmit={event => { event.preventDefault(); void perform('entry-save', api => api.saveLoginEntryUrl(loginEntryUrl)); }}>
      <label htmlFor="feigua-login-entry">登录入口网址</label>
      <input id="feigua-login-entry" type="url" value={loginEntryUrl} onChange={event => setLoginEntryUrl(event.target.value)} placeholder="输入你的登录入口（http:// 或 https://）" maxLength={2048} disabled={disabled || state.busy} autoComplete="off" spellCheck={false} />
      <button type="submit" disabled={disabled || state.busy || !loginEntryDirty}>{action === 'entry-save' ? '保存中…' : '保存网址'}</button>
      <small>{loginEntryDirty ? '网址有修改，请先保存再登录。' : state.loginEntryUrl ? '网址已保存，可随时修改。先在入口登录，再进入飞瓜工作台。' : '先填写并保存入口网址，然后打开入口登录。'}</small>
    </form>
    <div className={styles.connection} role="status"><span className={state.auth.status === 'authenticated' ? styles.online : styles.dot} />{!loaded ? '正在读取本地数据…' : !desktop ? '请在桌面版登录飞瓜并采集，网页版仅展示入口。' : ['expired', 'error', 'checking'].includes(state.auth.status) ? state.auth.message : displayedCount > 0 && !state.busy && state.auth.status !== 'authenticated' ? '已加载本地采集结果，登录后可更新' : state.auth.message}<span>登录后自动采集 · 数据保存在当前电脑</span></div>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {state.storageMessage && <div className={styles.error} role="alert">{state.storageMessage}</div>}
    {state.scheduleMessage && <div className={styles.error} role="alert">{state.scheduleMessage}</div>}
    {state.catalogMessage && <div className={styles.error} role="status">{state.catalogMessage}</div>}
    {state.credentialMessage && <div className={styles.error} role="status">{state.credentialMessage}</div>}
    <p>北京时间：带货视频每周一 06:30 采集；全网热点每天 07:00 采集；话题周榜每周一 09:00 检查最新已发布周，未发布或失败时每天 09:00 再检查，成功后本周不再自动重复采集。保持应用运行并登录飞瓜，错过时间后打开或恢复运行会补采。</p>

    <details ref={settingsPanel} className={styles.settings}>
      <summary>采集设置 <span>BGM / 话题：{state.musicTag.join(' > ') || '全部标签'} · {state.keywords.length} 个关键词{dirty || musicDirty || editorDirty ? ' · 有未保存修改' : ''}</span></summary>
    <section className={`${styles.configuration} ${styles.musicConfiguration}`} aria-label="BGM 与话题分类配置">
      <div><h2>BGM 与话题 · 榜单分类</h2><p>共用已核对一致的一级、二级分类，保存后同步刷新两个榜单</p></div>
      <div className={styles.tagSelectors}>
        <label>一级分类<select aria-label="榜单一级分类" value={musicTag[0] || ''} disabled={disabled || !state.musicTagOptions.length} onChange={event => setMusicTag(event.target.value ? [event.target.value] : [])}>
          <option value="">全部视频标签</option>
          {!!musicTag[0] && !firstTag && <option value={musicTag[0]} disabled>{musicTag[0]}（目录中已失效）</option>}
          {state.musicTagOptions.map(option => <option key={option.label} value={option.label}>{option.label}</option>)}
        </select></label>
        <label>二级分类<select aria-label="榜单二级分类" value={musicTag[1] || ''} disabled={disabled || !secondTags.length} onChange={event => setMusicTag(event.target.value ? [musicTag[0], event.target.value] : [musicTag[0]])}>
          <option value="">{musicTag[0] ? `全部${musicTag[0]}` : '先选择一级分类'}</option>
          {!!musicTag[1] && !secondTags.some(option => option.label === musicTag[1]) && <option value={musicTag[1]} disabled>{musicTag[1]}（目录中已失效）</option>}
          {secondTags.map(option => <option key={option.label} value={option.label}>{option.label}</option>)}
        </select></label>
        <button className={styles.primary} disabled={disabled || state.busy} onClick={() => void perform('music-save', api => api.saveAndRefreshMusicTag(musicTag))}>{action === 'music-save' ? '正在保存并刷新…' : '保存并刷新 BGM / 话题'}</button>
      </div>
      <small>{musicDirty ? `已选择：${musicTag.join(' > ') || '全部视频标签'}，点击“保存并刷新 BGM / 话题”立即更新榜单。` : `已保存：${state.musicTag.join(' > ') || '全部视频标签'} · 保存后自动刷新 BGM / 话题`}{!state.musicTagOptions.length ? ' · 登录后自动加载分类。' : ''}</small>
    </section>

    <section className={styles.configuration} aria-label="关键词配置">
      <div><h2>本周品类新发布 · 关键词与分类</h2><p>每个关键词一组 · 每周一 06:30 更新近7天销售额前 5 · 新增或修改分类后立即采集该组</p></div>
      <form className={styles.queryEditor} onSubmit={event => { event.preventDefault(); void addKeyword(); }}>
        <label className={styles.queryField}>关键词<input aria-label="视频关键词" placeholder="输入关键词" maxLength={60} value={input} onChange={event => setInput(event.target.value)} disabled={disabled} /></label>
        <CategorySelect label="带货品类" options={state.videoFilterOptions.categoryPath} path={inputCategoryPath} disabled={disabled} onChange={setInputCategoryPath} />
        <CategorySelect label="视频标签" options={state.videoFilterOptions.tagPath} path={inputTagPath} disabled={disabled} onChange={setInputTagPath} />
        <div className={styles.queryActions}>
          <button type="submit" disabled={disabled || state.busy || !input.trim()}><Plus size={15} />{editing === null ? '添加并采集' : '确认并采集'}</button>
          {editing !== null && <button type="button" disabled={disabled} onClick={clearEditor}>取消修改</button>}
          <button type="button" className={styles.primary} disabled={disabled || state.busy || editorDirty || !videoQueries.length} onClick={() => void perform('video-save', api => api.saveAndRefreshVideoQueries(videoQueries))}>{action === 'video-save' ? '正在刷新…' : '刷新关键词榜单'}</button>
        </div>
      </form>
      {videoQueries.map((query, index) => <section className={styles.querySettings} key={index} aria-label={`关键词${query.keyword}设置`}>
        <strong>{query.keyword}</strong>
        <span>带货品类：{pathLabel(query.categoryPath)}</span><span>视频标签：{pathLabel(query.tagPath)}</span>
        <button disabled={disabled || editorDirty} aria-label={`修改关键词${query.keyword}`} onClick={() => editQuery(query, index)}>修改</button>
        <button disabled={disabled || state.busy || editorDirty} aria-label={`删除关键词${query.keyword}`} onClick={() => void perform('video-change', api => api.saveAndRefreshVideoQueries(videoQueries.filter((_, current) => current !== index), { changedOnly: true }))}><X size={13} />删除</button>
      </section>)}
      <small>{editing !== null ? '确认后自动保存，并立即采集有变化的这一组。' : editorDirty ? '选择带货品类和视频标签后点击“添加并采集”，自动保存并立即采集这一组。' : keywords.length ? `已保存 ${keywords.length} 组，每周一 06:30 自动采集；也可手动刷新。` : '输入关键词，选择带货品类和视频标签，再点击“添加并采集”。'}</small>
    </section>
    </details>

    <div className={styles.history}>
      <h2>采集结果</h2>
      <span role="status">{run ? state.busy ? `${run.message} · 已有结果持续显示` : `已展示 ${displayedCount} 条采集结果` : '登录后自动采集'}</span>
    </div>
    <div className={styles.boards}>
      {(['music', 'topics', 'hotspots'] as Kind[]).map(kind => {
        const group = displayedGroups.find(item => item.kind === kind);
        const Icon = kind === 'music' ? Music2 : kind === 'topics' ? TrendingUp : Globe2;
        return <section key={kind} className={styles.board}><header><h3><Icon size={17} />{labels[kind]} <small>TOP 5</small></h3>{(kind === 'music' || kind === 'topics') ? <MusicCaption kind={kind} group={group} selection={musicTag} dirty={musicDirty} /> : <p>{rules[kind]}</p>}{kind === 'hotspots' && group?.result && group.result.period !== '日榜' && <p>当前显示：{group.result.period} · 之前采集结果</p>}{kind === 'hotspots' && (group?.refreshStatus || group?.status) === 'retrying' && <p role="status">{group?.refreshMessage || group?.message || '正在自动重试'}</p>}{kind === 'hotspots' && group?.showingPrevious && <p>本次更新尚未成功，显示上次已采集结果</p>}</header><ResultBody group={group} kind={kind} />{group?.result && <ResultFooter result={group.result} />}</section>;
      })}
    </div>
    <section className={styles.videoSection}><header><h2><Search size={18} />本周品类新发布 Top5 带货视频</h2><p>按关键词分组 · 近7天统计周期，不额外限制视频发布时间</p>
      <div className={styles.videoPeriods} role="group" aria-label="带货榜单周日期">
        <span>周榜日期</span><button type="button" aria-pressed={!videoPeriod} onClick={() => setVideoPeriod('')}>最新</button>
        {videoPeriods.map(period => <button type="button" key={period} aria-pressed={videoPeriod === period} onClick={() => setVideoPeriod(period)}>{period}</button>)}
      </div>
      <p>{videoPeriod ? `查看 ${videoPeriod} 这一周保存的榜单` : '显示最新结果'} · 按周保存；实际近7天统计周期见各组底部</p>
    </header>
      {videoGroups.map(group => {
        const configured = savedVideoQueries(state).find(query => query.keyword === group.keyword);
        const actual = group.result ? group.result.filters : group;
        const changed = !videoPeriod && configured && (JSON.stringify(configured.categoryPath) !== JSON.stringify(actual?.categoryPath || []) || JSON.stringify(configured.tagPath) !== JSON.stringify(actual?.tagPath || []));
        const status = group.refreshStatus || group.status;
        return <section className={styles.videoGroup} key={group.keyword}><h3>{group.keyword}<small>{rules.videos} · {group.showingPrevious ? '上次已采集结果' : group.result?.rows.some(row=>videoMissingFields(row).length) ? '榜单已采集 · 部分信息不可用' : names[group.status]}</small></h3>
          <p>{group.result ? '当前结果' : '本组设置'} · 带货品类：{pathLabel(actual?.categoryPath)} · 视频标签：{pathLabel(actual?.tagPath)}</p>
          {changed && <p>已保存设置 · 带货品类：{pathLabel(configured.categoryPath)} · 视频标签：{pathLabel(configured.tagPath)}（当前结果尚未更新）</p>}
          {['pending', 'running', 'retrying', 'failed', 'cancelled', 'interrupted'].includes(status) && <p role="status">{names[status]}{group.refreshMessage || group.message ? `：${group.refreshMessage || group.message}` : ''}</p>}
          <ResultBody group={group} kind="videos" />{group.result && <ResultFooter result={group.result} />}</section>;
      })}
      {!!videoPeriod && state.keywords.some(keyword => !videoGroups.some(group => group.keyword === keyword)) && <p className={styles.videoPeriodNotice}>这一周未保存以下关键词的榜单：{state.keywords.filter(keyword => !videoGroups.some(group => group.keyword === keyword)).join('、')}</p>}
      {!videoGroups.length && <div className={styles.empty}>{videoPeriod ? '这一周没有已保存的带货榜单，请选择其他周或最新结果。' : state.keywords.length ? '下一次采集将按已保存的关键词生成视频榜单。' : '添加并保存关键词后，这里将显示各组视频 Top5。'}</div>}
    </section>
  </section>;
}
