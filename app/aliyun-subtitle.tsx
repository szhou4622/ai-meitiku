"use client";
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ExternalLink, Film, FolderOpen, Settings, Upload, MousePointer2 } from 'lucide-react';

import { subtitlePoint, subtitleRectangle } from "./subtitle-region.mjs";
import { createSubtitleAutoSync, subtitleSourceVideos } from "./subtitle-library-sync.mjs";

type BrowserMode = 'system' | 'embedded';
type Region = { BX: number; BY: number; BW: number; BH: number };
type Source = { path: string; name: string; url: string; width: number; height: number; duration: number; sizeBytes: number };
type Job = { id: string; name: string; sourcePath: string; outputPath: string; status: string; message: string; jobId: string; createdAt: string; importedAt: string | null; sha256?: string; syncToMediaLibrary?: boolean; importError?: string };
type State = { configured: boolean; browserMode: BrowserMode; defaultOutputDirectory?: string; jobs: Job[] };
export type AliyunSubtitleBridge = {
  state: () => Promise<State>;
  save: (payload: { browserMode: BrowserMode; accessKeyId: string; accessKeySecret: string }) => Promise<State>;
  verify: () => Promise<{ message: string }>;
  open: (page: string, mode: BrowserMode) => Promise<void>;
  choose: () => Promise<Source | null>;
  inspect: (path: string) => Promise<Source>;
  submit: (payload: { path: string; outputDirectory: string; region: Region; consent: boolean; syncToMediaLibrary?: boolean }) => Promise<State>;
  retry: (id: string) => Promise<State>;
  recover: (id: string, jobId: string) => Promise<State>;
  imported: (id: string) => Promise<State>;
  importFailed: (id: string) => Promise<State>;
  preview: (id: string) => Promise<{ url: string; path: string } | null>;
};
const emptyState: State = { configured: false, browserMode: 'system', jobs: [] };
const defaultRegion: Region = { BX: 0, BY: 0.75, BW: 1, BH: 0.25 };
const statusNames: Record<string, string> = { submitting: '上传 / 提交中', queued: '排队中', processing: '处理中', downloading: '下载中', completed: '已完成', failed: '处理失败', unknown: '待核实', 'query-error': '查询暂停', 'download-error': '下载暂停' };
function bridge() {
  const api = window.desktopBridge?.aliyunSubtitle;
  if (!api) throw new Error('请在桌面版使用阿里云去字幕');
  return api;
}
function errorText(error: unknown) { return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作未完成，请重试'; }
function useAliyunState(notify: (message: string) => void, poll = false) {
  const [state, setState] = useState(emptyState);
  const [loaded, setLoaded] = useState(false);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  useEffect(() => {
    let alive = true, pending = false, errorReported = false;
    const update = async () => {
      if (pending || !window.desktopBridge?.aliyunSubtitle) { if (alive) setLoaded(true); return; }
      pending = true;
      try { const next = await bridge().state(); errorReported = false; if (alive) setState(next); }
      catch (error) { if (alive && !errorReported) { errorReported = true; notifyRef.current(errorText(error)); } }
      finally { pending = false; if (alive) setLoaded(true); }
    };
    void update();
    const timer = poll ? window.setInterval(() => void update(), 2500) : undefined;
    return () => { alive = false; if (timer) window.clearInterval(timer); };
  }, [poll]);
  return { state, setState, loaded };
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
  const run = async (action: () => Promise<void>) => { setBusy(true); setMessage(''); try { await action(); } catch (error) { setMessage(errorText(error)); } finally { setBusy(false); } };
  const open = (page: string) => void run(() => bridge().open(page, browserMode));
  const guide = <div className="as-connect-steps">
    <section><span className="as-step-number">1</span><div><h3>开通去字幕服务</h3><p>登录你的阿里云账户，开通「视频生产」服务。已经开通过可跳过。</p><button type="button" disabled={busy} onClick={() => open('activate')}>去阿里云开通 <ExternalLink size={13} /></button></div></section>
    <section><span className="as-step-number">2</span><div><h3>获取两项连接密钥</h3><p>打开密钥管理页，点击「创建 AccessKey」并完成验证，再把 ID 和 Secret 复制到下方。</p><button type="button" disabled={busy} onClick={() => open('keys')}>去获取密钥 <ExternalLink size={13} /></button></div></section>
  </div>;
  return <div className="api-settings-content as-root as-settings as-guided-settings"><section className="api-settings-card">
    <div className="api-settings-card-title as-settings-heading"><div><h2>{state.configured ? '阿里云账户设置' : '首次使用：连接你的阿里云账户'}</h2><p>只需设置一次，以后选视频就能处理。去字幕费用由你的阿里云账户支付。</p></div><div className="as-heading-controls"><span className={`api-config-status ${state.configured ? '' : 'empty'}`}>{state.configured ? '已保存密钥' : '尚未连接'}</span><div className="as-guide-toolbar"><span>下方链接打开到</span><BrowserChoice value={browserMode} onChange={setMode} /></div></div></div>
    {state.configured ? <details className="as-setup-help"><summary><ChevronDown size={14} />重新查看开通与密钥获取步骤</summary>{guide}</details> : guide}
    <section className="as-connect-form"><div className="as-connect-form-title">{!state.configured && <span className="as-step-number">3</span>}<div><h3>{state.configured ? '管理连接密钥' : '粘贴密钥，保存并检查'}</h3><p>{state.configured ? '更换账户时同时填写两项；留空则保留现有密钥。' : '这两项相当于软件连接阿里云的凭证，请从阿里云复制，不是登录密码。'}</p></div></div>
    <div className="as-key-grid"><label>密钥 ID <span>AccessKey ID</span><input type="password" autoComplete="off" spellCheck={false} value={id} onChange={e => setId(e.target.value)} placeholder={state.configured ? '已保存，留空保留' : '粘贴从阿里云复制的 ID'} /></label><label>密钥 Secret <span>AccessKey Secret</span><input type="password" autoComplete="new-password" spellCheck={false} value={secret} onChange={e => setSecret(e.target.value)} placeholder={state.configured ? '已保存，留空保留' : '粘贴从阿里云复制的 Secret'} /></label></div>
    <p className="as-hint">密钥加密保存在本机，不会显示给其他用户。保存和身份检查不会提交视频。</p>
    {message && <p className="as-notice" role="status">{message}</p>}
    <div className="as-footer"><div className="as-actions"><button className="as-primary" type="button" disabled={!loaded || busy || (!state.configured && (!id.trim() || !secret.trim()))} onClick={() => void run(async () => { setState(await bridge().save({ browserMode, accessKeyId: id, accessKeySecret: secret })); setId(''); setSecret(''); setMessage('密钥已保存，正在检查…'); const result = await bridge().verify(); setMessage(result.message); })}>{busy ? '正在处理…' : '保存并检查密钥'}</button>{state.configured && <button type="button" onClick={onStart}>下一步：选择视频 →</button>}</div></div>
    </section>
    <details className="as-setup-help"><summary><ChevronDown size={14} />连接失败怎么办？</summary><p>确认已开通「视频生产」，并为创建密钥的 RAM 用户授予 AliyunVIAPIFullAccess 权限。身份检查成功仍需通过视频处理确认服务权限和余额。遇到登录跳转限制可切换系统浏览器。</p></details>
    <div className="as-support-links"><button type="button" onClick={() => open('guide')}>查看官方接入说明 <ExternalLink size={13} /></button><button type="button" onClick={() => open('pricing')}>查看收费标准 <ExternalLink size={13} /></button></div>
  </section></div>;
}
export function AliyunSubtitleWorkbench({ notify, onConfigure, onImport, assets, contactAuthor }: { notify: (message: string) => void; onConfigure: () => void; onImport: (path: string) => Promise<void>; assets: { name: string; localPath?: string; type: string }[]; contactAuthor: ReactNode }) {
  const { state, setState, loaded } = useAliyunState(notify, true);
  const [source, setSource] = useState<Source | null>(null), [region, setRegion] = useState(defaultRegion);
  const [output, setOutput] = useState(''), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false);
  const [syncToMediaLibrary, setSyncToMediaLibrary] = useState(false);
  const [result, setResult] = useState<{ name: string; url: string } | null>(null);
  const [recover, setRecover] = useState<Record<string, string>>({});
  const [drawing, setDrawing] = useState(false);
  const drawOrigin = useRef<{ x: number; y: number; previous: Region } | null>(null);
  const sourceVideo = useRef<HTMLVideoElement>(null);
  const outputDirectory = output || state.defaultOutputDirectory || '';
  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return subtitlePoint(event.clientX, event.clientY, bounds);
  };
  const updateSelection = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drawOrigin.current) return null;
    const end = point(event), start = drawOrigin.current;
    const next = subtitleRectangle(start, end);
    if (next) setRegion(next); return next;
  };
  const run = async (action: () => Promise<void>) => { setBusy(true); try { await action(); } catch (error) { notify(errorText(error)); } finally { setBusy(false); } };
  const selectSource = (next: Source | null) => { if (next) { setSource(next); setRegion(defaultRegion); setConsent(false); setDrawing(false); } };
  const active = state.jobs.some(job => ['submitting', 'queued', 'processing', 'downloading'].includes(job.status));
  const videos = subtitleSourceVideos(assets, state.jobs) as typeof assets;
  return <section className="as-workbench"><header className="classifier-title-row"><div className="classifier-heading-icon workspace-heading-icon"><Film /></div><div className="classifier-title-copy"><div className="feature-title-line"><h1>阿里云去字幕</h1>{contactAuthor}</div><p>选择视频，框住字幕，生成没有字幕的新视频。</p></div><button className="as-service-settings" type="button" onClick={onConfigure}><Settings size={14} />服务设置</button></header>
    <div className="as-root">
    {!state.configured && <div className="as-notice">第一次使用？先连接你的阿里云账户，只需设置一次。<button type="button" onClick={onConfigure}>按步骤完成连接 →</button></div>}
    <div className="as-editor"><section className="as-card"><h2>1. 选择要去字幕的视频</h2><p className="as-hint">MP4 · 不超过 1 GB · 最高 1080P · 支持常规中英文字幕</p>
      <div className="as-actions"><button type="button" disabled={busy} onClick={() => void run(async () => selectSource(await bridge().choose()))}><Upload size={16} />选择本地视频</button><select aria-label="从媒体库选择视频" disabled={!loaded || busy || !videos.length} value="" onChange={e => { const value = e.target.value; if (value) void run(async () => selectSource(await bridge().inspect(value))); }}><option value="">{videos.length ? '从媒体库选择原视频' : '媒体库暂无可处理的原视频'}</option>{videos.map((asset, i) => <option key={`${asset.localPath}-${i}`} value={asset.localPath}>{asset.name}</option>)}</select></div>
      {source ? <><div className="as-video-stage"><div className="as-video-frame" style={{ '--as-video-ratio': source.width / source.height, aspectRatio: `${source.width}/${source.height}`, maxWidth: `${400 * source.width / source.height}px` } as React.CSSProperties}><video ref={sourceVideo} src={source.url} controls={!drawing} preload="metadata" /><div className="as-region" style={{ left: `${region.BX * 100}%`, top: `${region.BY * 100}%`, width: `${region.BW * 100}%`, height: `${region.BH * 100}%` }}><span>仅处理框内字幕</span></div>{drawing && <div className="as-draw-surface" aria-label="拖动鼠标框选字幕区域"
        onPointerDown={event => { if (event.button !== 0) return; const start = point(event); if (!start) return; sourceVideo.current?.pause(); event.currentTarget.setPointerCapture(event.pointerId); drawOrigin.current = { ...start, previous: region }; }}
        onPointerMove={event => { updateSelection(event); }}
        onPointerUp={event => { const origin = drawOrigin.current; const next = updateSelection(event); if (!origin) return; if (!next || next.BW < .01 || next.BH < .01) { setRegion(origin.previous); notify('请按住鼠标拖出一个矩形，包住字幕'); } else setDrawing(false); drawOrigin.current = null; }}
        onPointerCancel={() => { if (drawOrigin.current) setRegion(drawOrigin.current.previous); drawOrigin.current = null; }} />}</div></div><p className="as-hint">{source.name} · {source.width} × {source.height} · {source.duration.toFixed(1)} 秒</p></> : <div className="as-empty"><Film size={38} /><strong>选择需要去字幕的视频</strong><span>原文件保留，成片另存为新文件</span></div>}
      <div className="as-region-guide"><h2>2. 确认字幕位置</h2><p>{drawing ? '按住鼠标，在画面上拖出矩形，包住整行字幕。' : '已默认选中画面底部。字幕不在框内时，点击「重新框选字幕」。'}</p><div className="as-actions"><button type="button" disabled={!source} onClick={() => { sourceVideo.current?.pause(); setDrawing(current => !current); }}><MousePointer2 size={15} />{drawing ? '退出框选' : '重新框选字幕'}</button><button className="as-link" type="button" onClick={() => { setRegion(defaultRegion); setDrawing(false); }}>使用底部默认区域</button></div></div>
      <details className="as-setup-help"><summary><ChevronDown size={14} />高级：精确调整区域</summary><div className="as-region-fields">{([['BX', '左侧'], ['BY', '顶部'], ['BW', '宽度'], ['BH', '高度']] as const).map(([key, label]) => <label key={key}>{label}（%）<input type="number" min={0} max={100} step={1} value={Math.round(region[key] * 100)} onChange={e => setRegion(current => ({ ...current, [key]: Number(e.target.value) / 100 }))} /></label>)}</div></details>
      <p className="as-hint">尽量只框住字幕。花体、过细或一闪而过的文字可能无法清除，复杂背景可能出现修补痕迹。</p>
    </section><div className="as-sidebar"><section className="as-card as-output"><h2>3. 开始处理</h2><p className="as-hint">处理完成后自动保存新视频，原文件不变。</p>
      <div className="as-cost"><span>本次预计费用</span><strong>{source ? `¥${(Math.max(1, Math.ceil(source.duration)) / 60 * 0.4).toFixed(3)}` : '选视频后显示'}</strong><p>阿里云按量价 ¥0.40 / 分钟，以实际输出时长和账户账单为准。</p><button className="as-link" type="button" onClick={() => void run(() => bridge().open('pricing', state.browserMode))}>查看收费说明 <ExternalLink size={13} /></button></div>
      <div className="as-save-location"><strong>保存到</strong><p title={outputDirectory}>{outputDirectory || '正在读取默认保存位置…'}</p><button className="as-link" type="button" onClick={() => void run(async () => { const directory = await window.desktopBridge?.chooseDirectory(); if (directory) setOutput(directory); })}><FolderOpen size={14} />更换文件夹</button></div>
      <label className="as-consent as-sync-choice"><input type="checkbox" checked={syncToMediaLibrary} disabled={busy || active} onChange={e => setSyncToMediaLibrary(e.target.checked)} />完成后自动同步到媒体库</label>
      <label className="as-consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />我确认上传此视频至阿里云，并由我的阿里云账户承担处理费用。</label>
      <button type="button" className="as-primary as-submit" disabled={busy || active || !state.configured || !source || !outputDirectory || !consent || drawing} onClick={() => void run(async () => { if (source) { setState(await bridge().submit({ path: source.path, outputDirectory, region, consent, syncToMediaLibrary })); setConsent(false); notify('已开始上传，任务进度会自动更新'); } })}>{active ? '处理中，请稍候…' : !state.configured ? '请先连接阿里云账户' : !source ? '请先选择视频' : '开始去字幕'}</button>
      <p className="as-hint">提交后可在下方查看进度。请保持软件运行，成片会自动下载；关闭软件不会取消阿里云任务。</p>
    </section>
    <section className="as-card as-history"><h2>处理进度与成片 <span>{state.jobs.length}</span></h2>{!state.jobs.length && <p className="as-hint">暂无处理记录。完成后可预览成片，并加入媒体库。</p>}{state.jobs.map(job => <article key={job.id} className="as-job"><div className="as-job-title"><strong>{job.name}</strong><span className={`as-status as-status-${job.status}`}>{statusNames[job.status] || job.status}</span></div><p>{job.importError || (job.importedAt ? '成片已保存并同步到媒体库' : job.status === 'completed' && job.syncToMediaLibrary ? '成片已保存，正在同步到媒体库…' : job.message)}</p><small>{new Date(job.createdAt).toLocaleString()} {job.jobId && ` · 任务编号：${job.jobId}`}</small><div className="as-actions">
      {['query-error', 'download-error'].includes(job.status) && <button type="button" disabled={busy} onClick={() => void run(async () => setState(await bridge().retry(job.id)))}>继续查询 / 下载</button>}
      {job.status === 'unknown' && <><input aria-label="找回任务 RequestId" placeholder="从阿里云找回 RequestId 后填写" value={recover[job.id] || ''} onChange={e => setRecover(current => ({ ...current, [job.id]: e.target.value }))} /><button type="button" disabled={busy || !recover[job.id]} onClick={() => void run(async () => setState(await bridge().recover(job.id, recover[job.id].trim())))}>找回并查询</button></>}
      {job.status === 'completed' && <><button type="button" disabled={busy} onClick={() => void run(async () => { const media = await bridge().preview(job.id); if (!media) throw new Error('成片文件不可用'); setResult({ name: job.name, url: media.url }); })}>预览成片</button><button type="button" disabled={busy || !!job.importedAt || (!!job.syncToMediaLibrary && !job.importError)} onClick={() => void run(async () => { await onImport(job.outputPath); setState(await bridge().imported(job.id)); notify('成片已加入媒体库'); })}>{job.importedAt ? '已同步媒体库' : job.importError ? '重试同步' : job.syncToMediaLibrary ? '正在同步…' : '加入媒体库'}</button><button type="button" onClick={() => void run(async () => { await window.desktopBridge?.mediaRevealFile(job.outputPath); })}>打开所在文件夹</button></>}
    </div></article>)}</section></div></div>
    {result && <div className="as-modal" role="dialog" aria-modal="true" aria-label="去字幕成片预览"><div><header><strong>{result.name} · 去字幕成片</strong><button type="button" onClick={() => setResult(null)}>关闭</button></header><video src={result.url} controls autoPlay /></div></div>}
    </div>
  </section>;
}
