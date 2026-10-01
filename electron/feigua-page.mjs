// Runs in the isolated Feigua page, without Node or the application's preload.
// Select by visible labels and table headers. Unknown markup fails closed.
export function feiguaPage(command, argument = {}) {
  const visible = node => Boolean(node?.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
  const text = node => (node?.innerText || '').trim();
  const compact = node => text(node).replace(/\s+/g, '');
  const elements = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
  const exact = (label, root = document) => elements('a,button,label,span,li,div', root)
    .filter(node => compact(node) === label.replace(/\s+/g, '') && ![...node.children].some(child => visible(child) && compact(child) === label.replace(/\s+/g, '')));
  const selected = node => {
    const candidates = [node, node?.closest('a,button,li,label')].filter(Boolean);
    return candidates.some(item => /(^|[\s_-])(active|selected|checked|current)([\s_-]|$)/i.test(item.className || '') || item.getAttribute('aria-selected') === 'true' || item.getAttribute('aria-pressed') === 'true');
  };
  const authState = () => {
    const body = text(document.body);
    const compactBody = body.replace(/\s+/g, '');
    const hasShell = compactBody.includes('个人中心') && compactBody.includes('收藏夹') && compactBody.includes('视频/素材');
    const loginDialog = elements('input[type="password"], iframe').some(node => node.tagName === 'INPUT' || /login|qrcode/i.test(node.getAttribute('src') || ''))
      || /微信扫码登录|扫码登录\/注册|登录已过期|请重新登录/.test(body);
    const loginVisible = loginDialog || exact('注册 / 登录').length > 0 || exact('登录').length > 0;
    const actionRequired = body.includes('数据使用限制声明') && exact('同意并继续使用').length > 0 ? 'terms' : null;
    return { authenticated: hasShell && !loginDialog && !actionRequired, loginVisible, actionRequired,
      workspaceAvailable: !hasShell && !loginVisible && !actionRequired && exact('进入工作台').length === 1 };
  };
  const authenticated = () => authState().authenticated;
  const failure = message => ({ error: message });
  const scope = label => {
    const labels = exact(label);
    if (labels.length !== 1) return null;
    let root = labels[0].parentElement;
    for (let depth = 0; root && depth < 3; depth++, root = root.parentElement) {
      if (exact('全部', root).length === 1) return root;
    }
    return null;
  };
  if (command === 'auth') return authState();
  if (authState().actionRequired) return { actionRequired: 'terms' };
  if (command === 'enter-workspace') {
    if (!authState().workspaceAvailable) return failure('尚未发现登录后的工作台入口');
    const entry = exact('进入工作台')[0];
    const anchor = entry.closest('a[href]');
    if (anchor && /^https:\/\/dy\d*\.feigua\.cn\//.test(anchor.href)) return { url: anchor.href };
    entry.click();
    return { clicked: true };
  }
  if (command === 'login') {
    const link = exact('注册 / 登录')[0] || exact('登录')[0];
    if (link) link.click();
    return { opened: Boolean(link) };
  }
  if (!authenticated()) return { authRequired: true };
  if (command === 'navigate') {
    const links = elements('a').filter(node => argument.labels.includes(text(node)));
    const destinations = [...new Set(links.map(node => node.href).filter(url => /^https:\/\/dy\d*\.feigua\.cn\//.test(url)))];
    if (destinations.length === 1) return { url: destinations[0] };
    const menu = exact('视频/素材');
    if (menu.length === 1 && !argument.expanded) { menu[0].click(); return { expanded: true }; }
    return failure('未识别到飞瓜来源入口，需要核对当前页面版本');
  }
  if (command === 'category') {
    const root = scope(argument.label);
    if (!root) return failure(`未识别${argument.label}筛选区`);
    const all = exact('全部', root)[0];
    if (!selected(all)) { if (argument.verify) return { verified: false }; all.click(); return { changed: true }; }
    return { verified: true };
  }
  if (command === 'choice') {
    const matches = exact(argument.label);
    if (matches.length !== 1) return failure(`无法唯一定位「${argument.label}」`);
    if (!selected(matches[0])) { if (argument.verify) return { verified: false }; matches[0].click(); return { changed: true }; }
    return { verified: true };
  }
  if (command === 'keyword') {
    // Require the video-keyword search mode, not a global author/product search.
    const labels = exact('视频关键词');
    if (labels.length !== 1) return failure('未确认视频关键词搜索模式');
    let root = labels[0].parentElement;
    for (let depth = 0; root && depth < 5; depth++, root = root.parentElement) {
      const inputs = elements('input:not([type="hidden"])', root);
      const searches = exact('模糊搜索', root);
      if (inputs.length !== 1 || searches.length !== 1) continue;
      const input = inputs[0];
      if (argument.verify) {
        const body = text(document.body).replace(/\s+/g, '');
        return { verified: input.value === argument.keyword && body.includes(`视频关键词:${argument.keyword}`) || input.value === argument.keyword && body.includes(`视频关键词：${argument.keyword}`) };
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, argument.keyword);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      searches[0].click();
      return { changed: true };
    }
    return failure('未识别关键词搜索框');
  }
  if (command === 'clear') {
    const clears = exact('清空筛选');
    if (clears.length !== 1) return failure('未找到清空筛选入口，无法排除遗留筛选条件');
    clears[0].click(); return { changed: true };
  }
  if (command === 'optional-filters') {
    const checked = elements('input[type="checkbox"]').filter(node => node.checked);
    if (checked.length) return failure('页面仍有勾选的附加筛选条件，请清除后重新采集');
    const keywords = elements('input[type="text"],input:not([type])').filter(node => /音乐|热点/.test(node.placeholder || '') && node.value.trim());
    if (keywords.length) return failure('页面仍有音乐或热点搜索词，请清除后重新采集');
    return { verified: true };
  }
  const findTable = sortLabel => elements('table').find(table => elements('th', table).some(header => compact(header) === sortLabel));
  const sortDirection = header => {
    if (header.getAttribute('aria-sort') === 'descending') return 'desc';
    if (header.getAttribute('aria-sort') === 'ascending') return 'asc';
    const nodes = [header, ...elements('a,span,i', header)];
    if (nodes.some(node => /(^|\s)(sorting_desc|descending|sort-desc)(\s|$)/.test(node.className || ''))) return 'desc';
    if (nodes.some(node => /(^|\s)(sorting_asc|ascending|sort-asc)(\s|$)/.test(node.className || ''))) return 'asc';
    // Only explicit current direction attributes count; a green header alone is insufficient.
    if (nodes.some(node => selected(node) && ['desc', 'descending'].includes(node.getAttribute('data-order') || node.getAttribute('data-direction')))) return 'desc';
    return null;
  };
  if (command === 'sort') {
    const table = findTable(argument.label);
    if (!table) return failure(`未识别含「${argument.label}」的榜单表格`);
    const header = elements('th', table).find(node => compact(node) === argument.label);
    const direction = sortDirection(header);
    if (direction === 'desc') return { verified: true };
    if (argument.verify) return failure(`无法确认「${argument.label}」已按降序排列`);
    (elements('a,button', header)[0] || header).click();
    return { changed: true };
  }
  if (command === 'capture') {
    const table = findTable(argument.sort);
    if (!table || sortDirection(elements('th', table).find(node => compact(node) === argument.sort)) !== 'desc') return failure('榜单排序状态发生变化');
    const headers = elements('th', table).map(compact);
    const column = (cells, names) => cells[headers.findIndex(header => names.some(name => header === name || header.startsWith(`${name}/`)))];
    const number = (node, label) => text(node).match(new RegExp(`${label}\\s*[:：]?\\s*([\\d,.]+(?:万|亿|[wW])?(?:%)?)`))?.[1] || null;
    const identity = cell => {
      const link = elements('a[href]', cell).find(node => /^https:\/\/dy\d*\.feigua\.cn\//.test(node.href) && text(node));
      return { title: link?.getAttribute('title') || text(link) || null, url: link?.href || null, id: link?.href || null };
    };
    const rows = [];
    for (const row of elements('tbody tr', table)) {
      const cells = elements('td', row);
      if (cells.length !== headers.length) continue;
      const main = column(cells, argument.kind === 'music' ? ['音乐'] : argument.kind === 'topics' ? ['话题'] : argument.kind === 'hotspots' ? ['热点'] : ['带货视频', '带货视频/发布时间']);
      if (!main) return failure('榜单标题列无法识别');
      const item = identity(main);
      if (argument.kind === 'music') Object.assign(item, { author: text(main).match(/作者[:：]\s*([^\n]+)/)?.[1] || null, totalUsers: text(column(cells, ['总使用人数'])), yesterdayUsers: text(column(cells, ['昨日使用人数'])) });
      if (argument.kind === 'topics') {
        const author = column(cells, ['发起人']);
        Object.assign(item, { author: author ? identity(author).title : null, followers: number(author, '粉丝数'), participantGrowth: text(column(cells, ['参与人数增长率'])), playGrowth: text(column(cells, ['播放增长率'])) });
      }
      if (argument.kind === 'hotspots') item.peakHeat = text(column(cells, ['峰值热度']));
      if (argument.kind === 'videos') {
        const author = column(cells, ['达人']);
        const products = column(cells, ['关联商品']);
        const links = products ? elements('a[href]', products).filter(node => text(node) && !/^(价格|佣金率)$/.test(text(node))) : [];
        Object.assign(item, { author: author ? identity(author).title : null, followers: number(author, '粉丝数'), plays: text(column(cells, ['播放数', '播放量', '播放'])), likes: text(column(cells, ['点赞', '点赞数'])), sales: text(column(cells, ['视频销售额'])), publishedAt: text(main).match(/\d{2,4}[/-]\d{2}(?:[/-]\d{2})?\s+\d{2}:\d{2}/)?.[0] || null,
          products: links.map(link => ({ title: link.getAttribute('title') || text(link), commission: links.length === 1 ? number(products, '佣金率') : null })) });
      }
      rows.push(item);
      if (rows.length === 10) break;
    }
    const dateText = elements('input').map(input => input.value).concat(text(document.body)).join('\n');
    return { url: location.href, rows, direction: 'desc', sort: argument.sort, period: argument.period, keyword: argument.keyword, filtersVerified: true,
      dateRange: dateText.match(/\d{4}[-/]\d{2}[-/]\d{2}\s*[-~至]\s*\d{4}[-/]\d{2}[-/]\d{2}/)?.[0] || null,
      emptyVerified: /暂无数据|暂无相关|没有找到/.test(text(table)) };
  }
  if (command === 'ready') return { ready: document.readyState === 'complete' && !elements('[aria-busy="true"], .el-loading-mask, .loading-mask').length };
  return failure('未知采集指令');
}
