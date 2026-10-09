"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { classifyUserAction } from "../electron/user-action-errors.mjs";

type Guidance = NonNullable<ReturnType<typeof classifyUserAction>>;
export type GuidanceTarget = NonNullable<Guidance["target"]>;

export function UserActionNotice({ onConfigure, suppressQianchuan = false }: {
  onConfigure: (target: GuidanceTarget) => void;
  suppressQianchuan?: boolean;
}) {
  const [guidance, setGuidance] = useState<Guidance | null>(null);
  useEffect(() => {
    const receive = (event: Event) => setGuidance((event as CustomEvent<Guidance>).detail);
    const dismiss = () => setGuidance(null);
    window.addEventListener("user-action-required", receive);
    window.addEventListener("user-action-dismiss", dismiss);
    return () => { window.removeEventListener("user-action-required", receive); window.removeEventListener("user-action-dismiss", dismiss); };
  }, []);
  if (!guidance || (suppressQianchuan && guidance.target === "qianchuan")) return null;
  return <aside className="user-action-notice" role="status" aria-label="操作引导">
    <div><strong>{guidance.title}</strong><p>{guidance.message}</p></div>
    {guidance.target && <button type="button" onClick={() => { onConfigure(guidance.target!); setGuidance(null); }}>{guidance.action}</button>}
    <button type="button" className="user-action-dismiss" aria-label="关闭操作引导" onClick={() => setGuidance(null)}>×</button>
  </aside>;
}

export function ErrorDetailDialog() {
  const [details, setDetails] = useState<{ message: string; operation?: string } | null>(null);
  useEffect(() => {
    const show = (value: { message: string; operation?: string }) => {
      const action = classifyUserAction(value);
      if (action) window.dispatchEvent(new CustomEvent("user-action-required", { detail: action }));
      else setDetails(value);
    };
    const receive = (event: Event) => show((event as CustomEvent).detail);
    window.addEventListener("local-error-detail", receive);
    const unsubscribe = window.desktopBridge?.diagnosticOnError?.(show);
    return () => { window.removeEventListener("local-error-detail", receive); unsubscribe?.(); };
  }, []);
  if (!details) return null;
  return createPortal(<div className="update-modal-backdrop"><section className="update-modal diagnostic-error-dialog" role="alertdialog" aria-modal="true" aria-labelledby="diagnostic-error-title"><h2 id="diagnostic-error-title">操作失败 · 错误详情</h2><pre>{details.message}</pre><p>可在设置 → 存储管理中导出日志交给开发者查看。</p><div className="update-modal-actions"><button onClick={() => void navigator.clipboard.writeText(details.message).catch(() => {})}>复制详情</button><button className="primary" onClick={() => setDetails(null)}>关闭</button></div></section></div>, document.body);
}
