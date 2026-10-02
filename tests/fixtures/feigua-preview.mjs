// Synthetic UI fixture, explicitly installed only by a developer in a preview tab.
// Never imported by the production entrypoint. Reload the tab to remove it.
export function installFeiguaPreview() {
  let state = { keywords: [], musicTag: [], musicTagOptions: [{ label: '合成一级甲', children: [{label:'合成二级甲'}, {label:'合成二级乙'}] }, { label:'合成一级乙', children:[{label:'合成二级丙'}] }], musicTagOptionsLoadedAt: '2026-10-02T00:00:00Z', musicTagRestricted: false, runs: [], busy: false, auth: { status: 'authenticated', message: '合成测试：已登录' } };
  const snapshot = () => structuredClone(state);
  const group = (kind, keyword = null) => ({ kind, keyword, ...(kind==='music'?{musicTag:[...state.musicTag]}:{}), status: 'completed', result: {
    ...(kind==='music'?{filters:{category:state.musicTag.join(' > ')||'全部',categoryPath:[...state.musicTag]}}:{}),
    collectedAt: '2026-10-01T11:00:00Z', dateRange: '2026-09-25 - 2026-10-01', period: '近7天',
    rows: Array.from({ length: 5 }, (_, index) => ({ id: `${kind}-${index}`, rank: index + 1, title: `合成测试${kind === 'videos' ? '视频' : '条目'} ${index + 1}`, author: '合成测试达人', totalUsers: '100w', yesterdayUsers: '3.2w', followers: '10w', participantGrowth: '24.5%', playGrowth: '32.1%', peakHeat: '1000w', plays: index ? '20w' : null, likes: '5000', sales: '10w~25w', products: [{ title: '合成测试商品', commission: '5.00%' }], missingFields: index ? [] : ['plays'] })),
  } });
  window.desktopBridge = { ...window.desktopBridge, feigua: {
    state: async () => snapshot(),
    saveKeywords: async keywords => { state.keywords = [...keywords]; return snapshot(); },
    saveMusicTag: async path => { state.musicTag = [...path]; return snapshot(); },
    refreshMusicTags: async () => snapshot(),
    login: async () => { state.auth = { status: 'authenticated', message: '合成测试：已登录' }; return snapshot(); },
    checkLogin: async () => { state.auth = { status: 'authenticated', message: '合成测试：已登录' }; return snapshot(); },
    start: async () => { state.runs.unshift({ id: String(Date.now()), startedAt: new Date().toISOString(), status: 'completed', message: `完成 ${state.keywords.length + 3} 组（合成测试）`, keywords: [...state.keywords], groups: [group('music'), group('topics'), group('hotspots'), ...state.keywords.map(keyword => group('videos', keyword))] }); return snapshot(); },
    cancel: async () => snapshot(),
  } };
}
