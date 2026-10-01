// Synthetic UI fixture, explicitly installed only by a developer in a preview tab.
// Never imported by the production entrypoint. Reload the tab to remove it.
export function installFeiguaPreview() {
  let state = { keywords: [], runs: [], busy: false, auth: { status: 'signed_out', message: '合成测试：尚未登录' } };
  const snapshot = () => structuredClone(state);
  const group = (kind, keyword = null) => ({ kind, keyword, status: 'completed', result: {
    collectedAt: '2026-10-01T11:00:00Z', dateRange: '2026-09-25 - 2026-10-01', period: '近7天',
    rows: Array.from({ length: 5 }, (_, index) => ({ id: `${kind}-${index}`, rank: index + 1, title: `合成测试${kind === 'videos' ? '视频' : '条目'} ${index + 1}`, author: '合成测试达人', totalUsers: '100w', yesterdayUsers: '3.2w', followers: '10w', participantGrowth: '24.5%', playGrowth: '32.1%', peakHeat: '1000w', plays: index ? '20w' : null, likes: '5000', sales: '10w~25w', products: [{ title: '合成测试商品', commission: '5.00%' }], missingFields: index ? [] : ['plays'] })),
  } });
  window.desktopBridge = { ...window.desktopBridge, feigua: {
    state: async () => snapshot(),
    saveKeywords: async keywords => { state.keywords = [...keywords]; return snapshot(); },
    login: async () => { state.auth = { status: 'unknown', message: '合成测试：点击检查登录继续' }; return snapshot(); },
    checkLogin: async () => { state.auth = { status: 'authenticated', message: '合成测试：已登录' }; return snapshot(); },
    start: async () => { state.runs.unshift({ id: String(Date.now()), startedAt: new Date().toISOString(), status: 'completed', message: `完成 ${state.keywords.length + 3} 组（合成测试）`, keywords: [...state.keywords], groups: [group('music'), group('topics'), group('hotspots'), ...state.keywords.map(keyword => group('videos', keyword))] }); return snapshot(); },
    cancel: async () => snapshot(),
  } };
}
