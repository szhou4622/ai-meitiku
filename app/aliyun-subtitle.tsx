"use client";
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Film, FolderOpen, Settings, Upload, MousePointer2, X, RefreshCw, Pause, Play, Copy } from 'lucide-react';

import { subtitleDisplayText, subtitleDisplayDirectory } from '../electron/subtitle-display.mjs';
import { subtitleDroppedPaths } from './subtitle-drop.mjs';
import { subtitleLibraryFolders, subtitleInFolder } from './subtitle-folders.mjs';
import { subtitlePoint, subtitleRectangle } from "./subtitle-region.mjs";
import { createSubtitleAutoSync, subtitleSourceVideos } from "./subtitle-library-sync.mjs";
import { SUBTITLE_DRAFT_KEY, DEFAULT_SUBTITLE_REGION, subtitlePathKey, validSubtitleRegion, applySubtitleRegion, parseSubtitleDraft, serializeSubtitleDraft } from './subtitle-batch.mjs';

type BrowserMode = 'system' | 'embedded';
type Region = { BX: number; BY: number; BW: number; BH: number };
type Source = { path: string; name: string; url: string; width: number; height: number; duration: number; sizeBytes: number };
type Job = { id: string; batchId?: string; itemId?: string; name: string; sourcePath: string; outputPath: string; status: string; message: string; jobId: string; createdAt: string; importedAt: string | null; sha256?: string; syncToMediaLibrary?: boolean; importError?: string };
type Batch = { id: string; total: number; completed: number; waiting: number; paused: number; active: number; failed: number; attention: number; cancelled: number; message: string };
type State = { version?: number; configured: boolean; browserMode: BrowserMode; defaultOutputDirectory?: string; jobs: Job[]; batch?: Batch | null };
type Entry = Source & { id: string; checked: boolean; region: Region; regionMode: string; error?: string };
export type AliyunSubtitleBridge = {
  state: () => Promise<State>;
  save: (payload: { browserMode: BrowserMode; accessKeyId: string; accessKeySecret: string }) => Promise<State>;
  verify: () => Promise<{ message: string }>;
  open: (page: string, mode: BrowserMode) => Promise<void>;
  choose: () => Promise<Source | null>;
  chooseMany: () => Promise<string[]>;
  chooseFolder: () => Promise<{ directory: string; paths: string[]; unsupported: number; unreadable: number; limited: boolean } | null>;
  onChange: (callback: (state: State) => void) => () => void;
  inspect: (path: string) => Promise<Source>;
  submit: (payload: { path: string; outputDirectory: string; region: Region; consent: boolean; syncToMediaLibrary?: boolean }) => Promise<State>;
  startBatch: (payload: { entries: { id: string; path: string; region: Region }[]; outputDirectory: string; consent: boolean; syncToMediaLibrary: boolean }) => Promise<State>;
  pauseBatch: (id: string) => Promise<State>;
  resumeBatch: (id: string) => Promise<State>;
  cancelPending: (id: string) => Promise<State>;
  openOutput: (directory: string) => Promise<{ ok: boolean }>;
  retry: (id: string) => Promise<State>;
  recover: (id: string, jobId: string) => Promise<State>;
  imported: (id: string) => Promise<State>;
  importFailed: (id: string) => Promise<State>;
  preview: (id: string) => Promise<{ url: string; path: string } | null>;
};
const emptyState: State = { configured: false, browserMode: 'system', jobs: [] };
const defaultRegion: Region = DEFAULT_SUBTITLE_REGION;
const activeStatuses = ['preparing', 'submitting', 'queued', 'processing', 'downloading'];
const statusNames: Record<string, string> = { waiting: '待提交', paused: '后续提交暂停', preparing: '检查中', cancelled: '已取消', 'preflight-error': '文件检查失败', submitting: '上传 / 提交中', queued: '云端排队中', processing: '处理中', downloading: '下载中', completed: '已完成', failed: '处理失败', unknown: '待核实', 'query-error': '查询暂停', 'download-error': '下载暂停' };
function bridge() {
  const api = window.desktopBridge?.aliyunSubtitle;
  if (!api) throw new Error('请在桌面版使用一键去字幕');
  return api;
}
function errorText(error: unknown) { return subtitleDisplayText(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : `操作未完成：${typeof error === 'string' ? error : JSON.stringify(error) || '未提供错误原因'}`); }
function useAliyunState(notify: (message: string) => void, poll = false, enabled = true) {
  const [state, updateState] = useState(emptyState);
  const setState = (next: State) => updateState(current => (next.version || 0) < (current.version || 0) ? current : next);
  const [loaded, setLoaded] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(''), [connectionError, setConnectionError] = useState('');
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  useEffect(() => {
    if (!enabled) return;
    let alive = true, pending = false, errorReported = false;
    const update = async () => {
      if (pending || !window.desktopBridge?.aliyunSubtitle) { if (alive) setLoaded(true); return; }
      pending = true;
      try { const next = await bridge().state(); errorReported = false; if (alive) { setState(next); setConnectionError(''); setLastUpdate(new Date().toLocaleTimeString()); } }
      catch (error) { if (alive) { setConnectionError('暂时无法读取进度，后台任务不会因此取消，正在重新读取…'); if (!errorReported) { errorReported = true; notifyRef.current(errorText(error)); } } }
      finally { pending = false; if (alive) setLoaded(true); }
    };
    void update();
    const unsubscribe = window.desktopBridge?.aliyunSubtitle?.onChange?.(next => { if (alive) { setState(next); setLastUpdate(new Date().toLocaleTimeString()); } });
    const timer = poll ? window.setInterval(() => void update(), 2500) : undefined;
    return () => { alive = false; unsubscribe?.(); if (timer) window.clearInterval(timer); };
  }, [poll, enabled]);
  return { state, setState, loaded, lastUpdate, connectionError };
}
export function AliyunSubtitleAutoSync({ ready, onImport, notify }: { ready: () => boolean; onImport: (path: string) => Promise<void>; notify: (message: string) => void }) {
  const latest = useRef({ ready, onImport, notify });
  latest.current = { ready, onImport, notify };
  useEffect(() => {
    const sync = createSubtitleAutoSync({ ready: () => Boolean(window.desktopBridge?.aliyunSubtitle) && latest.current.ready(), api: bridge,
      importFile: (path: string) => latest.current.onImport(path), notify: (message: string) => latest.current.notify(message) });
    const tick = () => void sync.tick().catch(() => {});
    tick(); const timer = window.setInterval(tick, 2500);
    return () => { sync.stop(); window.clearInterval(timer); };
  }, []);
  return null;
}
function BrowserChoice({ value, onChange }: { value: BrowserMode; onChange: (mode: BrowserMode) => void }) {
  return <fieldset className="as-browser"><legend>官方页面打开方式</legend>
    <label><input type="radio" name="aliyun-browser" checked={value === 'system'} onChange={() => onChange('system')} />系统浏览器</label>
    <label><input type="radio" name="aliyun-browser" checked={value === 'embedded'} onChange={() => onChange('embedded')} />内置浏览器</label>
  </fieldset>;
}
export function AliyunSubtitleSettings({ notify, onStart }: { notify: (message: string) => void; onStart: () => void }) {
  const { state, setState, loaded } = useAliyunState(notify);
  const [id, setId] = useState(''), [secret, setSecret] = useState('');
  const [mode, setMode] = useState<BrowserMode | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const browserMode = mode || state.browserMode;
  const showSetupGuide = false;
  const run = async (action: () => Promise<void>) => { setBusy(true); setMessage(''); try { await action(); } catch (error) { setMessage(errorText(error)); } finally { setBusy(false); } };
  const open = (page: string) => void run(() => bridge().open(page, browserMode));
  const guide = <div className="as-connect-steps">
    <section><span className="as-step-number">1</span><div><h3>开通去字幕服务</h3><p>登录你的云服务账户，开通「视频生产」服务。已经开通过可跳过。</p><button type="button" disabled={busy} onClick={() => open('activate')}>去开通服务 <ExternalLink size={13} /></button></div></section>
    <section><span className="as-step-number">2</span><div><h3>获取两项连接密钥</h3><p>打开密钥管理页，点击「创建 AccessKey」并完成验证，再把 ID 和 Secret 复制到下方。</p><button type="button" disabled={busy} onClick={() => open('keys')}>去获取密钥 <ExternalLink size={13} /></button></div></section>
  </div>;
  return <div className="api-settings-content as-root as-settings as-guided-settings"><section className="api-settings-card">
    <div className="api-settings-card-title as-settings-heading"><div><h2>{state.configured ? '去字幕服务设置' : '首次使用：连接去字幕服务'}</h2><p>只需设置一次，以后选视频就能处理。去字幕费用由你的云服务账户支付。</p></div><div className="as-heading-controls"><span className={`api-config-status ${state.configured ? '' : 'empty'}`}>{state.configured ? '已保存密钥' : '尚未连接'}</span><div className="as-guide-toolbar"><span>下方链接打开到</span><BrowserChoice value={browserMode} onChange={setMode} /></div></div></div>
    {showSetupGuide && (state.configured ? <details className="as-setup-help"><summary><ChevronDown size={14} />重新查看开通与密钥获取步骤</summary>{guide}</details> : guide)}
    <section className="as-connect-form"><div className="as-connect-form-title">{!state.configured && <span className="as-step-number">3</span>}<div><h3>{state.configured ? '管理连接密钥' : '粘贴密钥，保存并检查'}</h3><p>{state.configured ? '更换账户时同时填写两项；留空则保留现有密钥。' : '这两项是软件连接去字幕服务的凭证，请从密钥管理页复制，不是登录密码。'}</p></div></div>
    <div className="as-key-grid"><label>密钥 ID <span>AccessKey ID</span><input type="password" autoComplete="off" spellCheck={false} value={id} onChange={e => setId(e.target.value)} placeholder={state.configured ? '已保存，留空保留' : '粘贴从密钥管理页复制的 ID'} /></label><label>密钥 Secret <span>AccessKey Secret</span><input type="password" autoComplete="new-password" spellCheck={false} value={secret} onChange={e => setSecret(e.target.value)} placeholder={state.configured ? '已保存，留空保留' : '粘贴从密钥管理页复制的 Secret'} /></label></div>
    <p className="as-hint">密钥加密保存在本机，不会显示给其他用户。保存和身份检查不会提交视频。</p>
    {message && <p className="as-notice" role="status">{message}</p>}
    <div className="as-footer"><div className="as-actions"><button className="as-primary" type="button" disabled={!loaded || busy || (!state.configured && (!id.trim() || !secret.trim()))} onClick={() => void run(async () => { setState(await bridge().save({ browserMode, accessKeyId: id, accessKeySecret: secret })); setId(''); setSecret(''); setMessage('密钥已保存，正在检查…'); const result = await bridge().verify(); setMessage(subtitleDisplayText(result.message)); })}>{busy ? '正在处理…' : '保存并检查密钥'}</button>{state.configured && <button type="button" onClick={onStart}>下一步：选择视频 →</button>}</div></div>
    </section>
    <details className="as-setup-help"><summary><ChevronDown size={14} />连接失败怎么办？</summary><p>确认已开通「视频生产」，并为创建密钥的子用户授予视频处理权限。身份检查成功仍需通过视频处理确认服务权限和余额。遇到登录跳转限制可切换系统浏览器。</p></details>
  </section></div>;
}
export function AliyunSubtitleBackgroundStatus({ visible, ready, notify, onOpen }: { visible: boolean; ready: boolean; notify: (message: string) => void; onOpen: () => void }) {
  const { state, lastUpdate, connectionError } = useAliyunState(notify, ready, ready);
  const previous = useRef<Batch | null>(null);
  useEffect(() => {
    const batch = state.batch;
    const old = previous.current;
    if (batch && old?.id === batch.id && (old.active || old.waiting) && !batch.active && !batch.waiting && !batch.paused && !batch.attention) {
      notify(`去字幕批次已结束：${batch.completed} 个完成，${batch.failed} 个失败，${batch.cancelled} 个取消`);
    }
    previous.current = batch || null;
  }, [state.batch, notify]);
  const activeJob = state.jobs.find(job => activeStatuses.includes(job.status));
  const batch = state.batch;
  const attentionJob = state.jobs.find(job => ['unknown', 'query-error', 'download-error'].includes(job.status));
  const attention = batch && (batch.paused || batch.attention);
  if (!ready || !visible || (!activeJob && !batch?.waiting && !attention && !attentionJob)) return null;
  return <div className="as-background-status" role="status"><Film size={15} /><div><strong>{activeJob ? `去字幕正在后台处理：${activeJob.name} · ${statusNames[activeJob.status]}` : attentionJob ? `${attentionJob.name} · ${statusNames[attentionJob.status]}` : '去字幕批次需要处理'}</strong><span>{connectionError || (!activeJob && attentionJob ? subtitleDisplayText(attentionJob.message) : batch ? `已完成 ${batch.completed} / ${batch.total} · ${batch.paused ? subtitleDisplayText(batch.message) : `进度更新 ${lastUpdate || '正在读取'}`}` : `进度更新 ${lastUpdate}`)}</span></div><button type="button" onClick={onOpen}>查看进度</button></div>;
}

export function AliyunSubtitleWorkbench({ notify, onConfigure, onImport, assets, folders = [], contactAuthor, active = true }: { notify: (message: string) => void; onConfigure: () => void; onImport: (path: string) => Promise<void>; assets: { name: string; localPath?: string; sourceRoot?: string; type: string }[]; folders?: { path: string; name?: string; available?: boolean }[]; contactAuthor: ReactNode; active?: boolean }) {
  const { state, setState, loaded, lastUpdate, connectionError } = useAliyunState(notify, true);
  const [entries, setEntries] = useState<Entry[]>([]), [activeId, setActiveId] = useState('');
  const [output, setOutput] = useState(''), [sync, setSync] = useState(false);
  const [busy, setBusy] = useState(''), [feedback, setFeedback] = useState(''), [draftReady, setDraftReady] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false), [libraryPaths, setLibraryPaths] = useState<string[]>([]), [libraryQuery, setLibraryQuery] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const [libraryFolder, setLibraryFolder] = useState(''), [pickerMessage, setPickerMessage] = useState('');
  const [result, setResult] = useState<{ name: string; url: string } | null>(null), [history, setHistory] = useState(false);
  const [recover, setRecover] = useState<Record<string, string>>({}), [drawing, setDrawing] = useState(false), [regionDraft, setRegionDraft] = useState<Region>({ ...defaultRegion });
  const draftWritable = useRef(true), saveErrorReported = useRef(false), importLock = useRef(false), entriesRef = useRef(entries);
  const video = useRef<HTMLVideoElement>(null), drawOrigin = useRef<{ x: number; y: number } | null>(null);
  entriesRef.current = entries;
  const source = entries.find(entry => entry.id === activeId) || entries[0] || null;
  const jobFor = (entry: Entry) => state.jobs.find(job => job.itemId === entry.id);
  const currentJob = source ? jobFor(source) : null;
  const locked = !!currentJob;
  const eligible = entries.filter(entry => entry.checked && !entry.error && !jobFor(entry));
  const editableEntries = entries.filter(entry => !jobFor(entry));
  const batch = state.batch;
  const preparing = state.jobs.some(job => job.batchId === batch?.id && job.status === 'preparing');
  const queueOpen = state.jobs.some(job => [...activeStatuses, 'waiting', 'paused'].includes(job.status));
  const directory = output || state.defaultOutputDirectory || '';
  const mixed = new Set(entries.map(entry => entry.width > entry.height ? 'landscape' : 'portrait')).size > 1;
  const videos = subtitleSourceVideos(assets, state.jobs) as typeof assets;
  const libraryFolders = subtitleLibraryFolders(videos, folders) as { path: string; name: string; paths: string[] }[];
  const displayVideos = videos.filter(asset => (!libraryFolder || subtitleInFolder(asset.localPath, libraryFolder)) && `${asset.name} ${asset.localPath || ''}`.toLowerCase().includes(libraryQuery.toLowerCase()));
  const jobs = history || !batch ? state.jobs : state.jobs.filter(job => job.batchId === batch.id);
  const validRegion = validSubtitleRegion(regionDraft);
  const announce = (message: string) => { setFeedback(message); notify(message); };
  const run = async (label: string, action: () => Promise<void>) => {
    if (importLock.current) return;
    importLock.current = true; setBusy(label); setFeedback(label);
    try { await action(); } catch (error) { announce(errorText(error)); }
    finally { importLock.current = false; setBusy(''); }
  };
  useEffect(() => {
    let alive = true;
    const restore = async () => {
      try {
        const draft = parseSubtitleDraft(localStorage.getItem(SUBTITLE_DRAFT_KEY));
        setEntries(draft.entries); setActiveId(draft.activeId); setOutput(draft.output); setSync(draft.sync);
        for (const entry of draft.entries) {
          try {
            const fresh = await bridge().inspect(entry.path);
            if (alive) setEntries(current => current.map(item => item.id === entry.id ? { ...item, ...fresh, error: '' } : item));
          } catch {
            if (alive) setEntries(current => current.map(item => item.id === entry.id ? { ...item, error: '原视频暂不可访问，请重新检测或移除' } : item));
          }
        }
      } catch (error) { draftWritable.current = false; if (alive) setFeedback(errorText(error)); }
      finally { if (alive) setDraftReady(true); }
    };
    void restore();
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!draftReady || !draftWritable.current) return;
    try { localStorage.setItem(SUBTITLE_DRAFT_KEY, serializeSubtitleDraft({ entries, activeId, output, sync })); saveErrorReported.current = false; }
    catch { if (!saveErrorReported.current) { saveErrorReported.current = true; announce('草稿保存失败。已提交任务仍由后台保存，请检查本机存储。'); } }
  }, [entries, activeId, output, sync, draftReady]);
  useEffect(() => {
    video.current?.pause(); drawOrigin.current = null; setDrawing(false);
    setRegionDraft(source ? { ...source.region } : { ...defaultRegion });
  }, [source?.id]);
  useEffect(() => { if (!active) { dragDepth.current = 0; setDragActive(false); video.current?.pause(); setDrawing(false); drawOrigin.current = null; setResult(null); setLibraryOpen(false); } }, [active]);
  const updateEntry = (id: string, patch: Partial<Entry>) => setEntries(current => current.map(entry => entry.id === id ? { ...entry, ...patch } : entry));
  const commitRegion = (region: Region, mode = 'custom') => {
    if (!source || locked || !validSubtitleRegion(region)) return;
    updateEntry(source.id, { region: { ...region }, regionMode: mode }); setRegionDraft({ ...region });
  };
  const addPaths = async (paths: string[]) => {
    const existing = new Set(entriesRef.current.map(entry => subtitlePathKey(entry.path)));
    const outputs = new Set(state.jobs.map(job => subtitlePathKey(job.outputPath)));
    let added = 0, duplicate = 0; const failures: string[] = [];
    for (const path of paths) {
      if (!path) continue;
      if (existing.has(subtitlePathKey(path))) { duplicate++; continue; }
      if (outputs.has(subtitlePathKey(path))) { failures.push('已处理的成片不能作为本批次原视频'); continue; }
      if (entriesRef.current.length >= 200) { failures.push('每批最多添加 200 个视频'); break; }
      setBusy(`正在检查视频 ${added + failures.length + 1} / ${paths.length}…`);
      try {
        const fresh = await bridge().inspect(path);
        const entry: Entry = { ...fresh, id: crypto.randomUUID(), checked: true, region: { ...defaultRegion }, regionMode: 'default', error: '' };
        existing.add(subtitlePathKey(path));
        entriesRef.current = [...entriesRef.current, entry];
        setEntries(current => [...current, entry]); setActiveId(current => current || entry.id); added++;
      } catch (error) { failures.push(errorText(error)); }
    }
    announce(`已添加 ${added} 个视频${duplicate ? `，跳过 ${duplicate} 个重复文件` : ''}${failures.length ? `；${failures.length} 个未添加：${failures[0]}` : ''}`);
  };
  const dropVideos = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragActive(false);
    if (importLock.current || !draftReady) { announce('正在检查视频，请稍后再拖入'); return; }
    const files = Array.from(event.dataTransfer.files);
    void run('正在识别拖入的视频…', async () => {
      const selection = subtitleDroppedPaths(files, window.desktopBridge?.mediaPathForFile);
      const notes = [selection.unsupported ? `跳过 ${selection.unsupported} 个非 MP4 文件，文件夹请使用选择本地文件夹` : '', selection.unreadable ? `${selection.unreadable} 个文件无法读取本地路径，请从电脑文件夹拖入` : ''].filter(Boolean).join('；');
      if (!selection.paths.length) { announce(notes || '请拖入电脑中的 MP4 视频'); return; }
      await addPaths(selection.paths);
      if (notes) setFeedback(current => `${current}；${notes}`);
    });
  };
  const chooseFolder = () => void run('正在选择并读取视频文件夹…', async () => {
    let selection;
    try { selection = await bridge().chooseFolder(); }
    catch (error) { setPickerMessage(errorText(error)); throw error; }
    if (!selection) { setPickerMessage('已取消文件夹选择'); setFeedback('已取消文件夹选择'); return; }
    const notes = [selection.unsupported ? `跳过 ${selection.unsupported} 个非 MP4 视频` : '', selection.unreadable ? `${selection.unreadable} 个目录暂不可读取` : '', selection.limited ? '文件夹视频超过 200 个，本次最多读取 200 个，请分批添加' : ''].filter(Boolean).join('；');
    if (!selection.paths.length) { const message = `此文件夹中没有可添加的 MP4 视频${notes ? `；${notes}` : ''}`; setPickerMessage(message); announce(message); return; }
    setLibraryOpen(false);
    await addPaths(selection.paths);
    if (notes) setFeedback(current => `${current}；${notes}`);
  });
  const switchVideo = (delta: number) => { if (!source) return; const index = entries.findIndex(entry => entry.id === source.id); const next = entries[index + delta]; if (next) setActiveId(next.id); };
  const chooseOutput = () => void run('正在选择保存目录…', async () => { const next = await window.desktopBridge?.chooseDirectory(); if (next) { setOutput(next); announce('成片保存目录已更新；已提交任务仍使用原目录'); } else setFeedback('已取消目录选择'); });
  const start = () => void run('正在保存批次并启动后台队列…', async () => {
    if (source && !locked) commitRegion(regionDraft);
    const next = await bridge().startBatch({ entries: eligible.map(entry => ({ id: entry.id, path: entry.path, region: entry.id === source?.id ? { ...regionDraft } : { ...entry.region } })), outputDirectory: directory, consent: true, syncToMediaLibrary: sync });
    setState(next); setHistory(false); announce(`已启动 ${eligible.length} 个视频的后台队列，可以切换视频或其他栏目`);
  });
  const point = (event: React.PointerEvent<HTMLDivElement>) => subtitlePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
  const changeBox = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drawOrigin.current) return null;
    const region = subtitleRectangle(drawOrigin.current, point(event));
    if (region) setRegionDraft(region); return region;
  };
  return <section className="as-workbench as-batch-workbench" onKeyDown={event => { if (event.key === 'Escape') { setLibraryOpen(false); setResult(null); setDrawing(false); drawOrigin.current = null; if (source) setRegionDraft({ ...source.region }); } }}>
    <header className="classifier-title-row"><div className="classifier-heading-icon workspace-heading-icon"><Film /></div><div className="classifier-title-copy"><div className="feature-title-line"><h1>一键去字幕</h1>{contactAuthor}</div><p>批量选择视频，框选字幕区域，自动保存成片。</p></div><span className="as-account-state">{loaded ? state.configured ? '服务已连接' : '尚未连接服务' : '正在读取连接…'}</span><button className="as-service-settings" type="button" onClick={onConfigure}><Settings size={14} />服务设置</button></header>
    <div className="as-root">
      {!state.configured && loaded && <div className="as-notice">先连接去字幕服务，只需设置一次。<button type="button" onClick={onConfigure}>去连接</button></div>}
      <div className="as-batch-steps"><span>1 添加视频</span><span>2 设置字幕区域</span><span>3 批量处理</span></div>
      <div className="as-batch-feedback" role="status" aria-live="polite">{busy || connectionError || feedback || (draftReady ? '队列与区域会保留；切换栏目不会停止后台任务。' : '正在恢复上次的视频列表与字幕区域…')}</div>
      <div className="as-batch-layout">
        <section className={`as-card as-queue-card ${dragActive ? 'as-drop-active' : ''}`} aria-label="视频列表，可拖入 MP4 视频" onDragEnter={event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); event.stopPropagation(); dragDepth.current++; setDragActive(true); }} onDragOver={event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = busy || !draftReady ? 'none' : 'copy'; }} onDragLeave={event => { event.stopPropagation(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragActive(false); }} onDrop={dropVideos}>
          <div className="as-drop-hint"><Upload size={14} /><span>{dragActive ? busy || !draftReady ? '正在读取，请稍后再拖入' : '松开鼠标，添加这些视频' : '拖入视频到此处 · 支持多个 MP4'}</span></div>
          {dragActive && <div className="as-drop-overlay" aria-hidden="true"><Upload size={30} /><strong>{busy || !draftReady ? '正在检查视频，请稍后再拖入' : '松开鼠标添加视频'}</strong><span>自动检查格式、读取视频信息并去重</span></div>}
          <h2>1. 视频列表 <small>{entries.length}</small></h2>
          <div className="as-add-actions"><button type="button" disabled={!!busy || !draftReady} onClick={() => void run('正在选择本地视频…', async () => { const paths = await bridge().chooseMany(); if (paths.length) await addPaths(paths); else setFeedback('已取消视频选择'); })}><Upload size={14} />添加本地视频</button><button type="button" disabled={!!busy || !draftReady} onClick={() => { setLibraryPaths([]); setLibraryQuery(''); setLibraryFolder(''); setPickerMessage(''); setLibraryOpen(true); }}><FolderOpen size={14} />从媒体库添加</button></div>
          <div className="as-queue-toolbar"><span>已勾选 {entries.filter(entry => entry.checked).length} 个</span><label><input type="checkbox" aria-label="全选视频" checked={!!entries.length && entries.every(entry => entry.checked)} disabled={!!busy || !entries.length} onChange={event => { setEntries(current => current.map(entry => ({ ...entry, checked: event.target.checked }))); }} />全选</label></div>
          <div className="as-queue-scroll">{!entries.length && <div className="as-queue-empty"><Film size={28} /><strong>添加要去字幕的视频</strong><span>支持多选或拖入 MP4</span></div>}{entries.map(entry => {
            const job = jobFor(entry);
            return <article key={entry.id} className={`as-queue-item ${source?.id === entry.id ? 'selected' : ''}`}>
              <input type="checkbox" aria-label={`选择 ${entry.name}`} checked={entry.checked} disabled={!!busy} onChange={event => { updateEntry(entry.id, { checked: event.target.checked }); }} />
              <button type="button" className="as-queue-select" aria-label={`查看 ${entry.name}`} onClick={() => setActiveId(entry.id)}><Film size={24} /><span><strong title={entry.name}>{entry.name}</strong><small>{entry.width} × {entry.height} · {entry.duration?.toFixed(1)} 秒</small><em className={entry.error ? 'error' : ''}>{entry.error ? '文件不可访问' : job ? statusNames[job.status] : entry.regionMode === 'shared' ? '统一区域' : entry.regionMode === 'custom' ? '单独区域' : '底部区域'}</em></span></button>
              <button type="button" className="as-queue-remove" aria-label={`移除 ${entry.name}`} disabled={!!busy} onClick={() => { setEntries(current => current.filter(item => item.id !== entry.id)); if (entry.id === activeId) setActiveId(''); announce(job && activeStatuses.includes(job.status) ? '已从列表移除，后台任务仍会继续，可在进度中查看' : '视频已从列表移除，原文件保留'); }}><X size={13} /></button>
            </article>;
          })}</div>
          <div className="as-queue-footer"><span>可开始处理：{eligible.length} 个</span><button type="button" className="as-link" disabled={!!busy || !editableEntries.length} onClick={() => { setEntries(current => current.filter(entry => !!jobFor(entry))); announce('未提交的视频已从列表移除'); }}>清空未提交</button></div>
        </section>
        <section className="as-card as-batch-preview"><h2>2. 框选字幕区域</h2><p className="as-hint">框选一次，可应用到全部待处理视频。</p>
          {source ? <>
            <div className="as-current-source"><strong title={source.name}>{source.name}</strong><small>{entries.findIndex(entry => entry.id === source.id) + 1} / {entries.length}</small></div>
            {source.error ? <div className="as-empty"><Film size={30} /><strong>原视频暂不可访问</strong><span>{source.error}</span><button type="button" disabled={!!busy} onClick={() => void run('正在重新检测视频…', async () => { const fresh = await bridge().inspect(source.path); updateEntry(source.id, { ...fresh, error: '' }); announce('视频检查通过，可以预览'); })}><RefreshCw size={14} />重新检测</button></div> : !source.url ? <div className="as-empty"><Film size={30} /><strong>正在载入视频预览…</strong></div> : <div className="as-video-stage"><div className="as-video-frame" style={{ '--as-video-ratio': source.width / source.height, aspectRatio: `${source.width}/${source.height}` } as React.CSSProperties}>
              <video key={`${source.id}-${source.url}`} ref={video} src={source.url} controls={!drawing} preload="metadata" onError={() => { updateEntry(source.id, { error: '视频预览读取失败，请重新检测原文件' }); setFeedback('预览无法读取；后台已经提交的任务继续处理'); }} />
              <div className="as-region" style={{ left: `${regionDraft.BX * 100}%`, top: `${regionDraft.BY * 100}%`, width: `${regionDraft.BW * 100}%`, height: `${regionDraft.BH * 100}%` }}><span>字幕区域</span></div>
              {drawing && !locked && <div className="as-draw-surface" aria-label="拖动鼠标框选字幕区域" onPointerDown={event => { if (event.button !== 0) return; drawOrigin.current = point(event); video.current?.pause(); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={changeBox} onPointerUp={event => { if (!drawOrigin.current) return; const next = changeBox(event); drawOrigin.current = null; if (!next || next.BW < .01 || next.BH < .01) { setRegionDraft({ ...source.region }); announce('请按住鼠标拖出矩形，包住字幕'); } else { commitRegion(next); setDrawing(false); announce('当前视频字幕区域已更新'); } }} onPointerCancel={() => { drawOrigin.current = null; setRegionDraft({ ...source.region }); }} />}
            </div></div>}
            <div className="as-video-pager"><button type="button" aria-label="上一个视频" disabled={entries.findIndex(entry => entry.id === source.id) <= 0} onClick={() => switchVideo(-1)}><ChevronLeft size={15} /></button><span>切换视频检查区域</span><button type="button" aria-label="下一个视频" disabled={entries.findIndex(entry => entry.id === source.id) >= entries.length - 1} onClick={() => switchVideo(1)}><ChevronRight size={15} /></button></div>
          </> : <div className="as-empty"><Film size={34} /><strong>添加视频后，在画面上框选字幕</strong><span>原文件保留，成片另存为新文件</span></div>}
          <div className="as-region-tools"><button type="button" disabled={!source?.url || locked || !!busy || !!source?.error} onClick={() => { video.current?.pause(); setDrawing(current => !current); setFeedback(drawing ? '已退出框选' : '按住鼠标拖出矩形，包住完整字幕'); }}><MousePointer2 size={14} />{drawing ? '退出框选' : '重新框选'}</button><button type="button" disabled={!source || locked || !!busy} onClick={() => { commitRegion(defaultRegion, 'default'); setDrawing(false); announce('当前视频已使用底部 25% 区域'); }}>使用底部区域</button></div>
          <details className="as-setup-help"><summary><ChevronDown size={14} />精确调整区域</summary><div className="as-region-fields">{([['BX', '左侧'], ['BY', '顶部'], ['BW', '宽度'], ['BH', '高度']] as const).map(([key, label]) => <label key={key}>{label}（%）<input type="number" aria-label={`${label}百分比`} min={0} max={100} step={.1} disabled={!source || locked || !!busy} value={Number((regionDraft[key] * 100).toFixed(2))} onChange={event => setRegionDraft(current => ({ ...current, [key]: Number(event.target.value) / 100 }))} onBlur={() => commitRegion(regionDraft)} /></label>)}</div></details>
          {!validRegion && <p className="as-region-error" role="alert">区域超出画面或宽高为零，请调整后再应用。</p>}
          <button type="button" className="as-primary as-apply-region" disabled={!source || locked || !editableEntries.length || !validRegion || drawing || !!busy} onClick={() => { setEntries(current => applySubtitleRegion(current, regionDraft, state.jobs.map(job => job.itemId).filter(Boolean))); announce(`当前区域已应用到 ${editableEntries.length} 个待处理视频`); }}><Copy size={14} />应用到全部 {editableEntries.length} 个待处理视频</button>
          <p className={`as-hint ${mixed ? 'as-mixed-warning' : ''}`}>{locked ? '当前视频已提交，使用提交时的区域；不会因切换或修改其他视频而变化。' : mixed ? '本列表包含横竖屏视频。区域按比例应用，请逐条检查字幕是否在框内。' : '按画面比例应用；字幕位置不同的视频可单独调整。'}</p>
          {currentJob && ['completed', 'failed', 'preflight-error', 'cancelled'].includes(currentJob.status) && <button type="button" className="as-link" disabled={!!busy} onClick={() => { const id = crypto.randomUUID(); updateEntry(source!.id, { id }); setActiveId(id); announce('已重新加入待处理；再次开始会创建新的去字幕任务'); }}>将当前视频重新加入待处理</button>}
        </section>
        <div className="as-batch-side"><section className="as-card as-output"><h2>3. 批量处理</h2><p className="as-hint">本次可提交 {eligible.length} 个视频</p><div className="as-save-location"><strong>成片保存到</strong><p title={subtitleDisplayDirectory(directory)}>{subtitleDisplayDirectory(directory) || '正在读取保存位置…'}</p><button type="button" className="as-link" disabled={!!busy} onClick={chooseOutput}><FolderOpen size={14} />更换文件夹</button></div>
          <label className="as-consent as-sync-choice"><input type="checkbox" checked={sync} onChange={event => setSync(event.target.checked)} />完成后自动同步到媒体库</label>
          <button type="button" className="as-primary as-submit" disabled={!!busy || !draftReady || !loaded || !state.configured || !eligible.length || !directory || queueOpen || drawing || (source && !locked && !validRegion) === true} onClick={start}>{busy || (queueOpen ? batch?.paused && !batch.active ? '后续提交已暂停，请继续批次' : '当前批次正在后台运行' : !state.configured ? '请先连接去字幕服务' : !eligible.length ? '请先添加待处理视频' : `开始批量去字幕（${eligible.length} 个）`)}</button>
          {batch && (batch.waiting > 0 || batch.paused > 0 || preparing) && <div className="as-batch-controls">{batch.waiting > 0 || preparing ? <button type="button" disabled={!!busy} onClick={() => void run('正在暂停后续提交…', async () => { setState(await bridge().pauseBatch(batch.id)); announce('后续提交已暂停，已提交任务继续处理'); })}><Pause size={13} />暂停后续提交</button> : <button type="button" disabled={!!busy} onClick={() => void run('正在继续批次…', async () => { setState(await bridge().resumeBatch(batch.id)); announce('批次已继续，后台按队列处理'); })}><Play size={13} />继续批次</button>}<button type="button" disabled={!!busy} onClick={() => void run('正在取消待提交视频…', async () => { setState(await bridge().cancelPending(batch.id)); announce('待提交视频已取消，已提交任务继续查询和下载'); })}>取消待提交</button></div>}
          <p className="as-hint">按队列逐个处理。可以切换其他栏目；请保持软件运行以自动下载。</p></section>
          <section className="as-card as-history"><div className="as-history-heading"><h2>进度与成片</h2><button type="button" className="as-link" onClick={() => setHistory(current => !current)}>{history ? '返回本批次' : '历史记录'}</button></div>
            {batch && !history && <div className="as-batch-progress"><strong>{batch.completed} / {batch.total} 已完成</strong><progress aria-label="本批次进度" max={batch.total} value={batch.completed + batch.failed + batch.cancelled} /><div><span>待提交 {batch.waiting + batch.paused}</span><span>处理中 {batch.active}</span><span>失败 {batch.failed + batch.attention}</span>{batch.cancelled > 0 && <span>已取消 {batch.cancelled}</span>}</div>{batch.paused > 0 && <p className="as-mixed-warning">{subtitleDisplayText(batch.message)}</p>}</div>}
            <small className="as-progress-heartbeat">{connectionError || `后台进度更新：${lastUpdate || '正在读取…'}`}</small>
            <div className="as-job-scroll">{!jobs.length && <p className="as-hint">暂无处理记录。完成后可在这里预览成片。</p>}{jobs.map(job => <article key={job.id} className="as-job"><div className="as-job-title"><strong title={job.name}>{job.name}</strong><span className={`as-status as-status-${job.status}`}>{statusNames[job.status] || job.status}</span></div><p>{job.importError || (job.importedAt ? '成片已保存并同步到媒体库' : job.status === 'completed' && job.syncToMediaLibrary ? '成片已保存，正在同步到媒体库…' : job.message)}</p><details className="as-task-detail"><summary>任务详情</summary><small>{new Date(job.createdAt).toLocaleString()}<br />{job.jobId ? `任务编号：${job.jobId}` : '尚无云端任务编号'}</small></details><div className="as-actions">
              {['query-error', 'download-error'].includes(job.status) && <button type="button" disabled={!!busy} onClick={() => void run('正在恢复原任务…', async () => { setState(await bridge().retry(job.id)); announce('正在继续查询或下载原任务，不会重新提交'); })}>继续查询 / 下载</button>}
              {job.status === 'unknown' && <><input aria-label={`找回 ${job.name} 的 RequestId`} placeholder="任务 RequestId" value={recover[job.id] || ''} onChange={event => setRecover(current => ({ ...current, [job.id]: event.target.value }))} /><button type="button" disabled={!!busy || !recover[job.id]?.trim()} onClick={() => void run('正在找回原任务…', async () => { setState(await bridge().recover(job.id, recover[job.id].trim())); announce('原任务已找回，正在查询'); })}>找回并查询</button></>}
              {job.status === 'completed' && <><button type="button" disabled={!!busy} onClick={() => void run('正在载入成片预览…', async () => { const media = await bridge().preview(job.id); if (!media) throw new Error('成片文件不可用'); setResult({ name: job.name, url: media.url }); setFeedback('成片预览已打开'); })}>预览成片</button><button type="button" disabled={!!busy || !!job.importedAt || (!!job.syncToMediaLibrary && !job.importError)} onClick={() => void run('正在同步媒体库…', async () => { await onImport(job.outputPath); setState(await bridge().imported(job.id)); announce('成片已加入媒体库'); })}>{job.importedAt ? '已同步媒体库' : job.importError ? '重试同步' : job.syncToMediaLibrary ? '正在同步…' : '加入媒体库'}</button><button type="button" disabled={!!busy} onClick={() => void run('正在打开成片文件夹…', async () => { await window.desktopBridge?.mediaRevealFile(job.outputPath); setFeedback('已打开成片所在位置'); })}>打开所在文件夹</button></>}
            </div></article>)}</div>
            <button type="button" className="as-open-output" disabled={!!busy || !directory || (!state.jobs.some(job => subtitlePathKey(job.outputPath).startsWith(subtitlePathKey(directory).replace(/\/$/, '') + '/')) && directory !== state.defaultOutputDirectory)} onClick={() => void run('正在打开成片目录…', async () => { await bridge().openOutput(directory); setFeedback('成片目录已打开'); })}><FolderOpen size={14} />打开成片文件夹</button>
          </section></div>
      </div>
      {libraryOpen && <div className="as-modal" role="dialog" aria-modal="true" aria-label="从媒体库批量添加视频或文件夹"><div className="as-library-picker">
        <header><strong>添加视频或文件夹</strong><button type="button" onClick={() => setLibraryOpen(false)} aria-label="关闭媒体库选择"><X size={16} /></button></header>
        <div className="as-picker-folder-tools"><button type="button" disabled={!!busy} onClick={chooseFolder}><FolderOpen size={15} />选择本地文件夹</button><label>媒体库文件夹<select aria-label="选择媒体库文件夹" value={libraryFolder} disabled={!!busy} onChange={event => { const folder = event.target.value; setLibraryFolder(folder); setLibraryQuery(''); const paths = libraryFolders.find(item => item.path === folder)?.paths || []; setLibraryPaths(paths); setPickerMessage(folder ? `已选中此文件夹及子文件夹中的 ${paths.length} 个视频，可取消不需要的视频` : '已返回全部视频，可逐条勾选'); }}><option value="">全部文件夹</option>{libraryFolders.map(folder => <option key={folder.path} value={folder.path}>{folder.name} · {folder.paths.length} 个视频 · {folder.path}</option>)}</select></label></div>
        <p className="as-picker-help" role="status">{busy || pickerMessage || '选择文件夹即可读取其中及子文件夹的 MP4 视频；仅添加到列表，点击开始后才处理。'}</p>
        <input aria-label="搜索媒体库视频或文件夹" placeholder="搜索视频或文件夹名称" value={libraryQuery} onChange={event => setLibraryQuery(event.target.value)} />
        <div className="as-picker-toolbar"><span>已选 {libraryPaths.length} 个</span><button type="button" disabled={!!busy} onClick={() => setLibraryPaths(displayVideos.map(asset => asset.localPath!).filter(Boolean))}>全选当前列表</button><button type="button" disabled={!!busy} onClick={() => setLibraryPaths([])}>取消选择</button></div>
        <div className="as-picker-list">{!displayVideos.length && <p>当前范围暂无可添加的原视频</p>}{displayVideos.map((asset, index) => <label key={`${asset.localPath}-${index}`} title={asset.localPath}><input type="checkbox" disabled={!!busy} checked={libraryPaths.includes(asset.localPath!)} onChange={event => setLibraryPaths(current => event.target.checked ? [...new Set([...current, asset.localPath!])] : current.filter(path => path !== asset.localPath))} /><span>{asset.name}</span></label>)}</div>
        <footer><button type="button" onClick={() => setLibraryOpen(false)}>取消</button><button type="button" className="as-primary" disabled={!libraryPaths.length || !!busy} onClick={() => { const paths = [...libraryPaths]; setLibraryOpen(false); void run('正在检查媒体库视频…', () => addPaths(paths)); }}>添加所选 {libraryPaths.length} 个视频</button></footer>
      </div></div>}
      {result && <div className="as-modal" role="dialog" aria-modal="true" aria-label="去字幕成片预览"><div><header><strong>{result.name} · 去字幕成片</strong><button type="button" onClick={() => setResult(null)}>关闭</button></header><video src={result.url} controls autoPlay /></div></div>}
    </div>
  </section>;
}
