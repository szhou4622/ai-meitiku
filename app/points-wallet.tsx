"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatPointUnits } from "../electron/points-client.mjs";

export type PointsSnapshot = {
  appName: string; balanceUnits: number; reservedUnits: number; availableUnits: number; unitScale: number;
  idempotent?: boolean; items?: PointsTransaction[]; nextBeforeSequence?: number | null;
};
export type PointsTransaction = {
  sequence: number; kind: string; deltaUnits: number; balanceUnits: number; taskId: string | null; createdAt: string;
};
export type PointsBridge = {
  pointsBalance: () => Promise<PointsSnapshot>;
  pointsTransactions: (options?: { beforeSequence?: number; limit?: number }) => Promise<PointsSnapshot>;
  pointsRedeem: (code: string) => Promise<PointsSnapshot>;
};

const kinds: Record<string, string> = { recharge: "积分充值", reserve: "任务积分预留", commit: "任务结算", release: "预留释放" };
function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message.split("\n")[0] : fallback;
}

export function PointsWalletCard({ canUse, preview, notify }: {
  canUse: boolean; preview: boolean; notify: (message: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<PointsSnapshot | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(canUse ? "refresh" : "");
  const [error, setError] = useState("");
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [rows, setRows] = useState<PointsTransaction[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const [ledgerError, setLedgerError] = useState("");
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const generation = useRef(0);
  const operationBusy = useRef(false);
  const ledgerPending = useRef(false);

  const refresh = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!canUse || !bridge?.pointsBalance || operationBusy.current) return;
    const version = generation.current;
    operationBusy.current = true; setBusy("refresh"); setError("");
    try {
      const next = await bridge.pointsBalance();
      if (version === generation.current) setSnapshot(next);
    } catch (cause) {
      if (version === generation.current) setError(message(cause, "积分查询失败，请重试。"));
    } finally {
      if (version === generation.current) { operationBusy.current = false; setBusy(""); }
    }
  }, [canUse]);

  useEffect(() => {
    const version = ++generation.current;
    const bridge = window.desktopBridge;
    if (!canUse || !bridge?.pointsBalance) return;
    operationBusy.current = true;
    void bridge.pointsBalance().then(next => {
      if (version === generation.current) setSnapshot(next);
    }).catch(cause => {
      if (version === generation.current) setError(message(cause, "积分查询失败，请重试。"));
    }).finally(() => {
      if (version === generation.current) { operationBusy.current = false; setBusy(""); }
    });
    return () => { generation.current += 1; };
  }, [canUse]);

  const loadLedger = async (append = false) => {
    const bridge = window.desktopBridge;
    if (!canUse || !bridge?.pointsTransactions || ledgerPending.current) return;
    const version = generation.current;
    ledgerPending.current = true; setLedgerBusy(true); setLedgerError("");
    try {
      const next = await bridge.pointsTransactions({ limit: 30, ...(append && cursor ? { beforeSequence: cursor } : {}) });
      if (version !== generation.current) return;
      setSnapshot(next);
      setRows(previous => append ? [...previous, ...(next.items || [])] : next.items || []);
      setCursor(next.nextBeforeSequence ?? null);
      setMore((next.items?.length || 0) === 30 && Boolean(next.nextBeforeSequence));
    } catch (cause) {
      if (version === generation.current) setLedgerError(message(cause, "积分明细加载失败，请重试。"));
    } finally {
      if (version === generation.current) { ledgerPending.current = false; setLedgerBusy(false); }
    }
  };

  const redeem = async () => {
    if (preview) { notify("源码预览不提交真实积分码，请使用正式客户端兑换。"); return; }
    if (!canUse || !window.desktopBridge?.pointsRedeem || !code.trim() || operationBusy.current) return;
    if (!window.confirm("确认将这张积分码兑换到当前媒体库账户吗？")) return;
    const version = generation.current;
    operationBusy.current = true; setBusy("redeem"); setError("");
    try {
      const next = await window.desktopBridge.pointsRedeem(code);
      if (version !== generation.current) return;
      setSnapshot(next); setCode("");
      notify(next.idempotent ? "这张积分码已入账，本次未重复充值。" : "积分兑换成功，余额已更新。");
      if (ledgerOpen) void loadLedger();
    } catch (cause) {
      if (version === generation.current) {
        const detail = message(cause, "积分兑换结果未确认，请保留原积分码重试。");
        setError(detail); notify(detail);
      }
    } finally {
      if (version === generation.current) { operationBusy.current = false; setBusy(""); }
    }
  };

  return <><div className="license-redemption-card license-points-redemption-card">
    <span>积分兑换</span>
    <div className="license-redemption-controls">
      <input type="password" value={code} onChange={event => setCode(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void redeem(); }} placeholder="输入积分兑换码" aria-label="积分兑换码" autoComplete="off" spellCheck={false} disabled={!canUse || preview || Boolean(busy)} />
      <button type="button" onClick={() => void redeem()} disabled={!canUse || preview || !code.trim() || Boolean(busy)}>{busy === "redeem" ? "兑换中" : "兑换"}</button>
    </div>
  </div>
  <div className="license-points-wallet-card" aria-label="积分账户">
    <div className="license-points-summary" aria-live="polite">
      <div className="license-points-balance">
        <strong>{snapshot ? formatPointUnits(snapshot.balanceUnits) : "—"}<em>积分</em></strong>
        {snapshot && <span className="license-points-breakdown">可用 {formatPointUnits(snapshot.availableUnits)} · 冻结 {formatPointUnits(snapshot.reservedUnits)}</span>}
      </div>
      <div className="license-points-tools">
        <button type="button" disabled={!canUse || Boolean(busy)} onClick={() => void refresh()}>{busy === "refresh" ? "查询中" : "刷新"}</button>
        <button type="button" disabled={!canUse} onClick={() => { setLedgerOpen(true); void loadLedger(); }}>账单</button>
      </div>
    </div>
    {!canUse && <small>请先完成设备授权验证。</small>}
    {error && <small role="alert">{error}{snapshot ? "（显示上次查询结果）" : ""}</small>}
    {ledgerOpen && createPortal(<div className="modal-backdrop" onMouseDown={() => setLedgerOpen(false)}>
      <section className="license-points-ledger-dialog" role="dialog" aria-modal="true" aria-labelledby="points-ledger-title" onMouseDown={event => event.stopPropagation()}>
        <header><div><h2 id="points-ledger-title">积分账单</h2><p>基础版与 VIP 共用当前账户积分。</p></div><button type="button" aria-label="关闭积分账单" onClick={() => setLedgerOpen(false)}>关闭</button></header>
        <div className="license-points-ledger-total">余额 {snapshot ? formatPointUnits(snapshot.balanceUnits) : "—"} 积分<button type="button" disabled={ledgerBusy} onClick={() => void loadLedger()}>刷新账单</button></div>
        {ledgerError && <p role="alert" className="license-points-ledger-error">{ledgerError}</p>}
        <div className="license-points-ledger-scroll"><table><thead><tr><th>时间</th><th>类型</th><th>变动积分</th><th>结余积分</th></tr></thead><tbody>
          {rows.map(row => <tr key={row.sequence}><td>{new Date(row.createdAt).toLocaleString("zh-CN", { hour12: false })}</td><td>{kinds[row.kind] || "账户变动"}</td><td>{row.deltaUnits === 0 ? "—" : formatPointUnits(row.deltaUnits, true)}</td><td>{formatPointUnits(row.balanceUnits)}</td></tr>)}
        </tbody></table>
        {!rows.length && !ledgerBusy && !ledgerError && <p className="license-points-ledger-empty">暂无积分记录</p>}
        {ledgerBusy && <p className="license-points-ledger-empty">正在查询…</p>}
        </div>
        <footer><small>任务积分预留与释放不会直接扣减余额。</small>{more && <button type="button" disabled={ledgerBusy} onClick={() => void loadLedger(true)}>加载更多</button>}</footer>
      </section>
    </div>, document.body)}
  </div></>;
}
