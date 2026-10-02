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
    const candidates = [node, node?.closest('a,button,li,label'), node?.closest('.permission-wrapper')].filter(Boolean);
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
  const categoryLabel = argument.kind === 'topics' ? '话题分类' : '视频标签';
  const musicTagData = (label = categoryLabel) => {
    const roots = elements('.tag-cascader').filter(root => text(root.querySelector('.tag-label')) === label);
    const root = roots.length === 1 ? roots[0] : null;
    // Read only the options/value already supplied to this visible filter widget.
    // Do not change the provider component or its permission flags.
    const props = root?.__vue__?.$props;
    if (!root || !Array.isArray(props?.options) || !Array.isArray(props.value)) return null;
    const findPath = (nodes, id, parents = [], depth = 0) => {
      if (depth > 5) return null;
      for (const node of nodes) {
        const path = [...parents, node.Name];
        if (String(node.Id) === String(id)) return node.Name === '全部' ? [] : path;
        const nested = findPath(Array.isArray(node.Sub) ? node.Sub : [], id, path, depth + 1);
        if (nested) return nested;
      }
      return null;
    };
    const tree = (nodes, depth = 0) => {
      if (depth >= 5 && nodes.length) throw new Error('分类目录超过五级');
      return nodes.filter(node => node.Name !== '全部').map(node => ({ label: node.Name, children: tree(Array.isArray(node.Sub) ? node.Sub : [], depth + 1) }));
    };
    let fullOptions;
    try { fullOptions = tree(props.options); } catch { return null; }
    return { root, path: findPath(props.options, props.value.at(-1)), fullOptions,
      unsupportedDepth: props.options.some(node => (node.Sub || []).some(child => child.Sub?.length)),
      restricted: elements('.purview-mask-layer', root).some(mask => getComputedStyle(mask).pointerEvents !== 'none'),
      options: props.options.filter(node => node.Name !== '全部').map(node => ({ label: node.Name, children: (Array.isArray(node.Sub) ? node.Sub : []).filter(child => child.Name !== '全部').map(child => ({ label: child.Name })) })) };
  };
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
  if (command === 'accept-terms') {
    // Product owner explicitly requested automatic handling of this named notice.
    if (authState().actionRequired !== 'terms') return { accepted: false };
    const buttons = exact('同意并继续使用');
    if (buttons.length !== 1) return failure('无法唯一识别数据使用限制声明的确认按钮');
    buttons[0].click();
    return { accepted: true };
  }
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
  if (command === 'video-filter-options') {
    const category = musicTagData('带货品类'), tag = musicTagData('视频标签');
    if (!category || !tag) return failure('未能读取带货视频分类目录，请重新登录后重试');
    return { categoryPath: category.fullOptions, tagPath: tag.fullOptions };
  }
  if (command === 'video-filter') {
    if (!['带货品类', '视频标签'].includes(argument.label)) return failure('未知视频筛选项');
    const data = musicTagData(argument.label);
    if (!data) return failure(`未能识别${argument.label}控件`);
    const path = argument.path || [];
    if (!Array.isArray(path) || path.length > 5) return failure('视频分类路径无效');
    if (data.path && JSON.stringify(data.path) === JSON.stringify(path)) return { verified: true, path: data.path };
    if (argument.verify) return { verified: false, path: data.path };
    if (data.restricted) return failure(`当前飞瓜账号的${argument.label}筛选权限受限，本组未采集`);
    let options = data.fullOptions;
    for (const label of path) {
      const option = options.find(item => item.label === label);
      if (!option) return failure(`所选${argument.label}已不在飞瓜目录中`);
      options = option.children;
    }
    const depth = argument.phase === 'expand' ? argument.depth : Math.max(0, path.length - 1);
    if (!Number.isInteger(depth) || depth < 0 || depth >= Math.max(1, path.length)) return failure('视频分类层级无效');
    const matches = depth === 0
      ? elements('.tag-list > .tag-element', data.root).filter(node => compact(node) === (path[0] || '全部'))
      : elements('.el-popover', data.root).flatMap(popover => exact(path[depth], popover));
    const targets = [...new Set(matches)];
    if (targets.length !== 1) return failure(`无法唯一定位${argument.label}第${depth + 1}级选项`);
    const target = targets[0].closest('label') || targets[0];
    if (argument.phase === 'expand') {
      target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    } else target.click();
    return { changed: true };
  }
  if (command === 'music-tag-options') {
    const data = musicTagData();
    if (data?.unsupportedDepth) return failure('飞瓜分类出现三级或更深目录，请更新适配后再采集');
    return data ? { options: data.options, restricted: data.restricted } : failure(`未能读取飞瓜${categoryLabel}目录，请重新登录后重试`);
  }
  if (command === 'music-tag') {
    const data = musicTagData();
    if (!data) return failure(`未能识别飞瓜${categoryLabel}控件`);
    if (data.unsupportedDepth) return failure('飞瓜分类出现三级或更深目录，请更新适配后再采集');
    const path = argument.path || [];
    if (data.path && JSON.stringify(data.path) === JSON.stringify(path)) return { verified: true, path: data.path };
    if (argument.verify) return { verified: false, path: data.path };
    if (data.restricted) return failure(`当前飞瓜账号的${categoryLabel}筛选权限受限，本组未采集`);
    const parent = path.length ? data.options.find(option => option.label === path[0]) : null;
    if (path.length && (!parent || path.length > 1 && !parent.children.some(child => child.label === path[1]))) return failure(`所选${categoryLabel}已不在飞瓜目录中`);
    const first = elements('.tag-list > .tag-element', data.root).find(node => compact(node) === (path[0] || '全部'));
    if (!first) return failure(`未找到${categoryLabel}一级分类入口`);
    if (path.length < 2) { first.click(); return { changed: true }; }
    if (argument.phase === 'expand') {
      first.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      first.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return { changed: true };
    }
    const children = elements('.el-popover', data.root).flatMap(popover => exact(path[1], popover));
    if (children.length !== 1) return failure(`未能唯一识别${categoryLabel}二级分类选项`);
    (children[0].closest('label') || children[0]).click();
    return { changed: true };
  }
  if (command === 'navigate') {
    // Current SPA renders its menu entries as event-backed divs in a popover.
    const menuEntries = [...document.querySelectorAll('.dy-side-bar-poper .child-label')]
      .filter(node => argument.labels.includes(node.textContent.trim()));
    if (menuEntries.length === 1) { menuEntries[0].closest('.child-wrapper').click(); return { clicked: true }; }
    const links = elements('a').filter(node => argument.labels.includes(text(node)));
    const destinations = [...new Set(links.map(node => node.href).filter(url => /^https:\/\/dy\d*\.feigua\.cn\//.test(url)))];
    if (destinations.length === 1) return { url: destinations[0] };
    const menu = exact('视频/素材');
    if (menu.length === 1 && !argument.expanded) {
      const trigger = menu[0].closest('.el-popover__reference') || menu[0];
      trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return { expanded: true };
    }
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
    const labels = exact('视频关键词').concat(elements('input').filter(input => input.value === '视频关键词'));
    if (labels.length !== 1) return failure('未确认视频关键词搜索模式');
    let root = labels[0].parentElement;
    for (let depth = 0; root && depth < 5; depth++, root = root.parentElement) {
      const inputs = elements('input:not([type="hidden"])', root).filter(input => !input.readOnly && ['text', 'search'].includes(input.type));
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
    if (!clears.length && !text(document.body).includes('常用条件') && elements('input').some(input => /视频标题关键词/.test(input.placeholder) && !input.value.trim())) return { verified: true };
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
  const findTable = sortLabel => {
    const table = elements('table').find(table => elements('th', table).some(header => compact(header) === sortLabel));
    if (table) return { root: table, headers: elements('th', table), rows: elements('tbody tr', table).map(row => elements('td', row)) };
    const head = elements('.list-hd').find(row => elements('.col-item', row).some(cell => compact(cell) === sortLabel));
    if (!head) return null;
    const headers = elements('.col-item', head);
    let root = head.parentElement;
    while (root && root !== document.body && elements('.col-item', root).length <= headers.length) root = root.parentElement;
    if (!root) return null;
    const rowNodes = [...new Set(elements('.col-item', root).filter(cell => !head.contains(cell)).map(cell => cell.parentElement))];
    const rows = rowNodes.map(row => [...row.children].filter(cell => cell.classList.contains('col-item') && visible(cell)));
    return { root, headers, rows };
  };
  const sortDirection = header => {
    if (header.getAttribute('aria-sort') === 'descending') return 'desc';
    if (header.getAttribute('aria-sort') === 'ascending') return 'asc';
    if (header.querySelector('.define-sort-th.sorting .arrow.v-bottom.active')) return 'desc';
    if (header.querySelector('.define-sort-th.sorting .arrow.v-top.active')) return 'asc';
    if (header.querySelector('.sort-th .arrow.v-bottom.active')) return 'desc';
    if (header.querySelector('.sort-th .arrow.v-top.active')) return 'asc';
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
    const header = table.headers.find(node => compact(node) === argument.label);
    const direction = sortDirection(header);
    if (direction === 'desc') return { verified: true };
    if (argument.verify) return failure(`无法确认「${argument.label}」已按降序排列`);
    (elements('.define-sort-th,.sort-th,a,button', header)[0] || header).click();
    return { changed: true };
  }
  if (command === 'capture') {
    const videoCategory = argument.kind === 'videos' ? musicTagData('带货品类') : null;
    const videoTag = argument.kind === 'videos' ? musicTagData('视频标签') : null;
    if (argument.kind === 'videos' && (!Array.isArray(videoCategory?.path) || !Array.isArray(videoTag?.path))) return failure('无法回读带货品类或视频标签，本组未保存');
    const hasCategory = ['music', 'topics'].includes(argument.kind);
    const categoryData = hasCategory ? musicTagData() : null;
    if (hasCategory && !Array.isArray(categoryData?.path)) return failure(`无法回读实际${categoryLabel}，本组未保存`);
    if (categoryData?.unsupportedDepth) return failure('飞瓜分类出现三级或更深目录，请更新适配后再采集');
    const table = findTable(argument.sort);
    if (!table || sortDirection(table.headers.find(node => compact(node) === argument.sort)) !== 'desc') return failure('榜单排序状态发生变化');
    const headers = table.headers.map(compact);
    const column = (cells, names) => cells[headers.findIndex(header => names.some(name => header === name || header.startsWith(`${name}/`)))];
    const number = (node, label) => text(node).match(new RegExp(`${label}\\s*[:：]?\\s*([\\d,.]+(?:万|亿|[wW])?(?:%)?)`))?.[1] || null;
    const identity = cell => {
      const link = elements('a[href]', cell).find(node => /^https:\/\/dy\d*\.feigua\.cn\//.test(node.href) && text(node));
      return { title: link?.getAttribute('title') || text(link) || null, url: link?.href || null, id: link?.href || null };
    };
    const rows = [];
    for (const cells of table.rows) {
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
    const startDate = elements('input').find(input => input.placeholder === '开始日期')?.value;
    const endDate = elements('input').find(input => input.placeholder === '结束日期')?.value;
    return { url: location.href, rows, direction: 'desc', sort: argument.sort, period: argument.period, keyword: argument.keyword, filtersVerified: true,
      ...(hasCategory ? { musicTag: categoryData.path, musicTagOptions: categoryData.options, musicTagRestricted: categoryData.restricted } : {}),
      ...(argument.kind === 'videos' ? { categoryPath: videoCategory.path, tagPath: videoTag.path } : {}),
      dateRange: startDate && endDate ? `${startDate} - ${endDate}` : dateText.match(/\d{4}[-/]\d{2}[-/]\d{2}\s*[-~至]\s*\d{4}[-/]\d{2}[-/]\d{2}/)?.[0] || null,
      emptyVerified: /暂无数据|暂无相关|没有找到/.test(text(table.root)) };
  }
  if (command === 'ready') return { ready: document.readyState === 'complete' && !elements('[aria-busy="true"], .el-loading-mask, .loading-mask').length };
  return failure('未知采集指令');
}
