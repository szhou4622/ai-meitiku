"use client";
import { useEffect, useRef, useState, type ReactNode } from 'react';
export type ApiProvider = 'volcengine' | 'relay' | 'minimax' | 'aliyun';
export type ApiUsageState = Record<ApiProvider, boolean>;
export function ApiUsageSwitch({ provider, children, notify }: { provider: ApiProvider; children?: ReactNode; notify: (message: string) => void }) {
  const [own, setOwn] = useState(true), [loaded, setLoaded] = useState(false), [saving, setSaving] = useState(false);
  const notifyRef = useRef(notify);
  useEffect(() => { notifyRef.current = notify; }, [notify]);
  useEffect(() => {
    let alive = true;
    window.desktopBridge?.apiUsageGet?.().then(values => { if (alive) { setOwn(values[provider]); setLoaded(true); } })
      .catch(() => { if (alive) notifyRef.current('API 使用方式读取失败，请重新打开设置'); });
    return () => { alive = false; };
  }, [provider]);
  const toggle = async () => {
    if (!loaded || saving || !window.desktopBridge?.apiUsageSet) return;
    setSaving(true);
    try { const values = await window.desktopBridge.apiUsageSet(provider, !own); setOwn(values[provider]); }
    catch { notify('API 使用方式保存失败，仍按原来的方式使用'); }
    finally { setSaving(false); }
  };
  return <>
    <div className="api-usage-row">
      <div><strong>使用自己的 API</strong><p>{own ? '个人 API 付费；配置缺失或调用失败时停止，不转扣软件积分。' : '已选择积分模式；功能开放状态以任务入口为准，已保存的个人密钥保留。'}</p></div>
      <div className="api-usage-choice"><span>{own ? '个人 API' : '积分模式'}</span><button type="button" role="switch" aria-label="使用自己的 API" aria-checked={own} disabled={!loaded || saving} onClick={() => void toggle()} className={`api-usage-toggle ${own ? 'on' : ''}`}><i /></button></div>
    </div>
    {children && loaded && own && <fieldset className="api-usage-fields" disabled={saving}>{children}</fieldset>}
  </>;
}
