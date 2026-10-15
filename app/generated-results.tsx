"use client";
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, FileText, RefreshCw } from 'lucide-react';
import styles from './generated-results.module.css';

export type GeneratedRecord = { id: string; feature: string; stage: string; savedAt: string; text: string; characters?: number; billing?: { pointsUsed: string | null; billingPending: boolean } | null };
const labels: Record<string, string> = { schemes: '分类草案', classifier: '素材分类', 'prompt-library': '提示词库', voice: '声音生成', 'subtitle-removal': '去字幕' };

export function GeneratedResultsPanel({ notify }: { notify: (text: string) => void }) {
  const [records, setRecords] = useState<Omit<GeneratedRecord, 'text'>[]>([]);
  const [selected, setSelected] = useState<GeneratedRecord | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState('refresh');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    void (window.desktopBridge?.generatedResultsList?.() || Promise.resolve([])).then(next => {
      if (active) setRecords(next);
    }).catch(() => {
      if (active) setError('已保存内容暂时无法读取，请刷新重试。');
    }).finally(() => { if (active) setBusy(''); });
    return () => { active = false; generation.current += 1; };
  }, []);

  const refresh = async () => {
    setBusy('refresh'); setError('');
    const version = ++generation.current;
    try {
      const next = await window.desktopBridge?.generatedResultsList?.() || [];
      if (version !== generation.current) return;
      setRecords(next);
      if (!next.some(record => record.id === selectedId)) { setSelected(null); setSelectedId(''); }
    } catch { if (version === generation.current) setError('已保存内容暂时无法读取，请刷新重试。'); }
    finally { if (version === generation.current) setBusy(''); }
  };
  const select = async (id: string) => {
    const version = ++generation.current;
    setSelectedId(id); setSelected(null); setCopied(false); setError('');
    if (!id) { setBusy(''); return; }
    setBusy('read');
    try {
      const next = await window.desktopBridge!.generatedResultRead(id);
      if (version === generation.current) setSelected(next);
    } catch { if (version === generation.current) setError('该条内容暂时无法读取，请重新选择或刷新重试。'); }
    finally { if (version === generation.current) setBusy(''); }
  };
  const copy = async () => {
    if (!selected) return;
    try { await navigator.clipboard.writeText(selected.text); setCopied(true); notify('已复制生成内容'); }
    catch { setError('暂时无法复制，请手动选中文本复制。'); }
  };

  return <section className={styles.card} aria-label="已生成内容" aria-busy={Boolean(busy)}>
    <div className={styles.heading}>
      <span className={styles.icon}><FileText size={19} /></span>
      <div className={styles.title}><h3>已生成内容 <span>{records.length} 条</span></h3>
        <p>找回已保存的生成文本；是否完整、是否通过检查，请以原任务为准。</p></div>
      <button type="button" className={styles.button} disabled={Boolean(busy)} onClick={() => void refresh()}>
        <RefreshCw size={14} className={busy === 'refresh' ? styles.spinning : undefined} />{busy === 'refresh' ? '读取中…' : '刷新记录'}
      </button>
    </div>
    <div className={styles.picker}>
      <label htmlFor="saved-generated-result">选择记录</label>
      <select id="saved-generated-result" value={selectedId} disabled={busy === 'refresh' || !records.length} onChange={event => void select(event.target.value)}>
        <option value="">{busy === 'refresh' ? '正在读取记录…' : records.length ? '选择一条记录，查看或复制内容' : '暂无已保存的生成内容'}</option>
        {records.map(record => <option key={record.id} value={record.id}>{labels[record.feature] || '生成结果'} · {new Date(record.savedAt).toLocaleString('zh-CN', { hour12: false })} · {record.characters ?? 0} 字</option>)}
      </select>
    </div>
    {error && <p className={styles.error} role="status">{error}</p>}
    {busy === 'read' && <p className={styles.loading} role="status">正在读取内容…</p>}
    {selected && <div className={styles.preview}>
      <div className={styles.previewHeading}><strong>{labels[selected.feature] || '生成结果'} · {selected.text.length} 字</strong>
        <button type="button" className={styles.button} onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : '复制内容'}</button></div>
      <textarea aria-label="已保存的生成内容" value={selected.text} readOnly rows={Math.min(8, Math.max(3, selected.text.split('\n').length))} />
      {(selected.stage || selected.billing) && <p className={styles.meta}>{selected.stage}{selected.billing ? selected.billing.billingPending || selected.billing.pointsUsed == null ? ' · 积分结算待核对，请查看原任务账单' : ` · 该步骤已确认使用 ${selected.billing.pointsUsed} 积分` : ''}</p>}
    </div>}
  </section>;
}
