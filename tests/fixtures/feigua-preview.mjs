// Synthetic UI fixture, explicitly installed only by a developer in a preview tab.
// Never imported by the production entrypoint. Reload the tab to remove it.
export function installFeiguaPreview({ musicRefreshFails = false } = {}) {
  let state = { keywords: [], musicTag: [], musicTagOptions: [{ label: '合成一级甲', children: [{label:'合成二级甲'}, {label:'合成二级乙'}] }, { label:'合成一级乙', children:[{label:'合成二级丙'}] }], musicTagOptionsLoadedAt: '2026-10-02T00:00:00Z', musicTagRestricted: false, runs: [], busy: false, auth: { status: 'authenticated', message: '合成测试：已登录' } };
  state.videoQueries = [];
  state.videoFilterOptions = { categoryPath: [{label:'合成食品',children:[{label:'合成调味品',children:[{label:'合成酱料',children:[]}]}]}, {label:'合成家居',children:[]}], tagPath: [{label:'合成美食',children:[{label:'合成教程',children:[]}]}, {label:'合成生活',children:[]}] };
  const snapshot = () => structuredClone(state);
  const group = (kind, keyword = null) => ({ kind, keyword, ...(['music','topics'].includes(kind)?{musicTag:[...state.musicTag]}:{}), status: 'completed', result: {
    ...(['music','topics'].includes(kind)?{filters:{category:state.musicTag.join(' > ')||'全部',categoryPath:[...state.musicTag]}}:{}),
    ...(kind === 'videos' ? {filters: structuredClone(state.videoQueries.find(query => query.keyword === keyword) || { categoryPath: [], tagPath: [] })} : {}),
    collectedAt: '2026-10-01T11:00:00Z', dateRange: '2026-09-25 - 2026-10-01', period: '近7天',
    rows: Array.from({ length: 5 }, (_, index) => ({ id: `${kind}-${index}`, rank: index + 1, title: `合成测试${kind === 'videos' ? '视频' : '条目'} ${index + 1}`, author: '合成测试达人', totalUsers: '100w', yesterdayUsers: '3.2w', followers: '10w', participantGrowth: '24.5%', playGrowth: '32.1%', peakHeat: '1000w', plays: index ? '20w' : null, likes: '5000', sales: '10w~25w', products: [{ title: '合成测试商品', commission: '5.00%' }], missingFields: index ? [] : ['plays'] })),
  } });
  window.desktopBridge = { ...window.desktopBridge, feigua: {
    state: async () => snapshot(),
    saveKeywords: async keywords => { state.keywords = [...keywords]; return snapshot(); },
    saveAndRefreshVideoQueries: async queries => {
      state.videoQueries = structuredClone(queries); state.keywords = queries.map(query => query.keyword);
      if (queries.length) state.runs.unshift({ id:String(Date.now()), startedAt:new Date().toISOString(), status:musicRefreshFails?'failed':'completed', message:'关键词榜单刷新（合成测试）', keywords:[...state.keywords], groups:queries.map(query => musicRefreshFails ? {kind:'videos',...query,status:'failed',message:'合成测试：刷新失败'} : group('videos', query.keyword)) });
      return snapshot();
    },
    saveMusicTag: async path => { state.musicTag = [...path]; return snapshot(); },
    saveAndRefreshMusicTag: async path => {
      state.musicTag = [...path];
      const groups = ['music','topics'].map(kind => musicRefreshFails ? { kind, keyword:null, musicTag:[...path], status:'failed', message:'合成测试：刷新失败' } : group(kind));
      state.runs.unshift({ id:String(Date.now()), startedAt:new Date().toISOString(), status:groups[0].status, message:'BGM 与话题刷新（合成测试）', keywords:[], musicTag:[...path], groups });
      return snapshot();
    },
    refreshMusicTags: async () => snapshot(),
    login: async () => { state.auth = { status: 'authenticated', message: '合成测试：已登录' }; return snapshot(); },
    checkLogin: async () => { state.auth = { status: 'authenticated', message: '合成测试：已登录' }; return snapshot(); },
    start: async () => { state.runs.unshift({ id: String(Date.now()), startedAt: new Date().toISOString(), status: 'completed', message: `完成 ${state.keywords.length + 3} 组（合成测试）`, keywords: [...state.keywords], groups: [group('music'), group('topics'), group('hotspots'), ...state.keywords.map(keyword => group('videos', keyword))] }); return snapshot(); },
    cancel: async () => snapshot(),
  } };
}
