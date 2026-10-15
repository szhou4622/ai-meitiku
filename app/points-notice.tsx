"use client";
import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';

export type PointsNoticeValue = { id: string; pointsUsed: string };

export function PointsNotice() {
  const [queue, setQueue] = useState<PointsNoticeValue[]>([]);
  const current = queue[0];
  useEffect(() => window.desktopBridge?.onPointsNotice?.(value => {
    if (!value?.id || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value.pointsUsed)) return;
    setQueue(previous => previous.some(item => item.id === value.id) ? previous : [...previous, value]);
  }), []);
  useEffect(() => {
    if (!current) return;
    const expiresAt = Date.now() + 3000;
    const dismiss = () => setQueue(previous => previous.filter(item => item.id !== current.id));
    const checkExpired = () => { if (Date.now() >= expiresAt) dismiss(); };
    const timer = window.setTimeout(dismiss, 3000);
    window.addEventListener('focus', checkExpired);
    document.addEventListener('visibilitychange', checkExpired);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', checkExpired);
      document.removeEventListener('visibilitychange', checkExpired);
    };
  }, [current]);
  if (!current) return null;
  return <div key={current.id} className="points-notice" role="status" aria-live="polite" aria-atomic="true">
    <Check size={18} aria-hidden="true" />
    <span>本次扣除 {current.pointsUsed} 积分</span>
    <button type="button" aria-label="关闭积分提示" onClick={() => setQueue(previous => previous.filter(item => item.id !== current.id))}>
      <X size={16} aria-hidden="true" />
    </button>
  </div>;
}
