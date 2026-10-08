import { installFeiguaPreview } from './feigua-preview.mjs';

// Explicitly imported by the isolated test HTML only; no production import.
export async function installControlPreview(mode) {
  installFeiguaPreview({ weeklyHistory: true });
  const api = window.desktopBridge.feigua;
  const state = { ...await api.state(), loginEntryUrl: 'https://dy.feigua.cn/', busy: false };
  const snapshot = () => structuredClone(state);
  let release;
  const control = { mode, startCalls: 0, saveCalls: 0, cancelCalls: 0, collected: 0, verified: false,
    release: () => release?.(),
    completeVerification: () => { control.verified = true; state.auth = {status:'authenticated',message:'合成：验证完成，可以重新采集'}; },
  };
  window.__feiguaControl = control;
  api.state = async () => snapshot();
  const hold = () => { state.busy = true; return new Promise(resolve => { release = () => { state.busy = false; resolve(snapshot()); }; }); };
  api.start = async () => {
    control.startCalls++;
    if (mode === 'verification') {
      if (!control.verified) throw new Error('合成：仍需图形验证');
      control.collected++;return snapshot();
    }
    return hold();
  };
  api.saveAndRefreshVideoQueries = async queries => { control.saveCalls++;state.videoQueries = structuredClone(queries);state.keywords = queries.map(query=>query.keyword);return hold(); };
  api.cancel = async () => { control.cancelCalls++;return snapshot(); };
  if (mode === 'verification') state.auth = {status:'verification_required',message:'合成：请在飞瓜窗口完成图形验证后重新采集'};
}
