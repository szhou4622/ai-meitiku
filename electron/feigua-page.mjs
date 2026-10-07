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
    const candidates = [node, node?.closest('a,button,li,label'), node?.closest('[role="tab"]'), node?.closest('.permission-wrapper')].filter(Boolean);
    return candidates.some(item => /(^|[\s_-])(active|selected|checked|current)([\s_-]|$)/i.test(item.className || '') || item.getAttribute('aria-selected') === 'true' || item.getAttribute('aria-pressed') === 'true');
  };
  const authState = () => {
    const body = text(document.body);
    const compactBody = body.replace(/\s+/g, '');
    // Personal center now lives in a collapsed dropdown. Require the mounted
    // provider client as well as the visible workspace sections in that case.
    const providerApi = document.querySelector('#app')?.__vue__?.$api;
    const hasProviderApi = Object.values(providerApi || {}).some(group => Object.values(group || {}).some(model => model?.url === '/api/v1/music/search/page' && typeof model.GET === 'function'));
    const personalLink = [...document.querySelectorAll('a')].some(node => node.textContent.trim() === '个人中心' && node.getAttribute('href') === '#/user-center');
    const hasShell = (compactBody.includes('个人中心') || hasProviderApi && personalLink) && compactBody.includes('收藏夹') && compactBody.includes('视频/素材');
    const loginText = /微信扫码登录|扫码登录\/注册|登录已过期|请重新登录/;
    const loginPrompt = node => loginText.test(text(node)) && (node.matches('.login-dialog, .login-modal')
      || elements('.el-dialog__title, .el-message-box__title, h1, h2, h3, [role="heading"]', node).some(heading => loginText.test(text(heading)) || /^登录(?:提示)?$/.test(text(heading)))
      || elements('.el-message-box__message', node).some(message => loginText.test(text(message)))
      || ['登录', '重新登录', '立即登录'].some(label => exact(label, node).some(control => control.closest('button, a, [role="button"]'))));
    const loginDialog = elements('input[type="password"], iframe').some(node => node.tagName === 'INPUT' || /login|qrcode/i.test(node.getAttribute('src') || ''))
      || elements('[role="dialog"], .el-dialog__wrapper, .el-message-box__wrapper, .login-dialog, .login-modal').some(loginPrompt)
      || !hasShell && loginText.test(body);
    const loginVisible = loginDialog || exact('注册 / 登录').length > 0 || exact('登录').length > 0;
    const actionRequired = body.includes('数据使用限制声明') && exact('同意并继续使用').length > 0 ? 'terms' : null;
    const workspaceAvailable = !hasShell && !loginVisible && !actionRequired && exact('进入工作台').length === 1;
    return { authenticated: hasShell && !loginDialog && !actionRequired, loginVisible, actionRequired, workspaceAvailable,
      loading: Boolean(document.querySelector('#app')) && !hasShell && !loginVisible && !actionRequired && !workspaceAvailable };
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
    if (!root || !Array.isArray(props?.options)) return null;
    // The video tag widget uses a scalar ID; ranking widgets use ID arrays.
    const values = Array.isArray(props.value) ? props.value : [props.value];
    if (!values.length || values.at(-1) == null) return null;
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
    return { root, popover: root.__vue__?.popover?.$refs?.popper, path: findPath(props.options, values.at(-1)), selectionId: String(values.at(-1)), fullOptions,
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
    const popovers = [...new Set([...elements('.el-popover', data.root), ...(visible(data.popover) ? [data.popover] : [])])];
    if (popovers.some(popover => elements('.purview-mask-layer', popover).some(mask => getComputedStyle(mask).pointerEvents !== 'none'))) return failure(`当前飞瓜账号的${argument.label}筛选权限受限，本组未采集`);
    const matches = depth === 0
      ? elements('.tag-list > .tag-element', data.root).filter(node => compact(node) === (path[0] || '全部'))
      : popovers.flatMap(popover => exact(path[depth], popover));
    const targets = [...new Set(matches)];
    if (targets.length !== 1) return failure(`无法唯一定位${argument.label}第${depth + 1}级选项`);
    const target = depth === 0 ? targets[0].querySelector('.tag-text') || targets[0] : targets[0].closest('label') || targets[0];
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
    const firstTarget = first.querySelector('.tag-text') || first;
    if (path.length < 2) { firstTarget.click(); return { changed: true }; }
    if (argument.phase === 'expand') {
      firstTarget.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      firstTarget.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return { changed: true };
    }
    // appendToBody detaches the panel from its filter. Read only this widget's
    // own mounted popper reference, never another filter's global popup.
    const popovers = [...new Set([...elements('.el-popover', data.root), ...(visible(data.popover) ? [data.popover] : [])])];
    const children = popovers.flatMap(popover => exact(path[1], popover));
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
  if (command === 'video-period') {
    // Scope to statistics time, never the optional video publication filter.
    const labels = exact('时间周期');
    if (labels.length !== 1) return failure('无法唯一识别视频统计时间周期');
    let root = null;
    for (let cursor = labels[0].parentElement, depth = 0; cursor && depth < 3; depth++, cursor = cursor.parentElement) {
      if (elements('input[placeholder="开始日期"]', cursor).length || exact('近7天', cursor).length) { root = cursor; break; }
    }
    if (!root || root === document.body || root === document.documentElement) return failure('未能识别视频统计日期控件');
    if (elements('.purview-mask-layer', root).some(mask => getComputedStyle(mask).pointerEvents !== 'none')) return failure('视频统计时间筛选权限受限');
    const starts = elements('input[placeholder="开始日期"]', root), ends = elements('input[placeholder="结束日期"]', root);
    if (starts.length !== 1 || ends.length !== 1) return failure('无法唯一回读视频统计起止日期');
    const parse = input => {
      const parts = input.value.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
      if (!parts) return null;
      const [, y, m, d] = parts.map(Number), date = new Date(Date.UTC(y, m - 1, d));
      return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date.toISOString().slice(0, 10) : null;
    };
    const start = parse(starts[0]), end = parse(ends[0]);
    const sevenDays = start && end && Date.parse(end) - Date.parse(start) === 6 * 86400000;
    const shortcuts = exact('近7天', root);
    if (shortcuts.length > 1) return failure('无法唯一定位统计时间的「近7天」');
    if (shortcuts.length) {
      if (selected(shortcuts[0])) return sevenDays ? { verified: true, label: '近7天', dateRange: `${start} - ${end}` } : failure('近7天选项与实际统计日期不一致');
      if (argument.verify) return { verified: false };
      shortcuts[0].click(); return { changed: true };
    }
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const first = new Date(Date.parse(today) - 6 * 86400000).toISOString().slice(0, 10);
    const verified = start === first && end === today;
    if (verified) return { verified: true, label: '近7天', dateRange: `${start} - ${end}` };
    if (argument.verify) return { verified: false };
    if (!argument.phase) return { calendar: true };
    const editors = elements('.el-date-editor--daterange', root);
    const editor = editors.length === 1 ? editors[0] : null;
    if (!editor || editor.classList.contains('is-disabled') || editor.__vue__?.$props?.disabled) return failure('视频统计日期控件不可用');
    if (argument.phase === 'open') { editor.click(); return { opened: true }; }
    if (!['start', 'end'].includes(argument.phase)) return failure('未知视频统计日期操作');
    // Read this widget's own detached panel, and interact through normal clicks.
    const panel = editor.__vue__?.picker?.$el;
    if (!visible(panel) || !panel.matches('.el-date-range-picker')) return failure('未能打开视频统计日期面板');
    const target = argument.phase === 'start' ? first : today;
    const calendars = elements('.el-date-range-picker__content', panel).map(calendar => {
      const match = text(calendar.querySelector('.el-date-range-picker__header')).match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
      return match ? { calendar, year: Number(match[1]), month: Number(match[2]), key: Number(match[1]) * 12 + Number(match[2]) - 1 } : null;
    });
    if (calendars.length !== 2 || calendars.some(item => !item || item.month < 1 || item.month > 12)) return failure('无法核对日期面板的年月');
    const [year, month, day] = target.split('-').map(Number), key = year * 12 + month - 1;
    const matching = calendars.filter(item => item.key === key);
    if (!matching.length) {
      const direction = key < Math.min(...calendars.map(item => item.key)) ? 'left' : key > Math.max(...calendars.map(item => item.key)) ? 'right' : null;
      const buttons = direction ? elements(`button.el-icon-arrow-${direction}`, panel).filter(button => !button.disabled && !button.classList.contains('is-disabled')) : [];
      if (buttons.length !== 1) return failure('无法切换到近7天所在月份');
      buttons[0].click(); return { moved: true };
    }
    const cells = matching.flatMap(item => elements('.el-date-table td', item.calendar)).filter(cell => !cell.classList.contains('prev-month') && !cell.classList.contains('next-month') && compact(cell) === String(day));
    if (cells.length !== 1 || cells[0].classList.contains('disabled') || !cells[0].classList.contains('available')) return failure('近7天所需日期不可选择');
    cells[0].click(); return { picked: true };
  }
  if (command === 'choice') {
    const matches = exact(argument.label);
    if (matches.length !== 1) return failure(`无法唯一定位「${argument.label}」`);
    if (!selected(matches[0])) { if (argument.verify) return { verified: false }; matches[0].click(); return { changed: true }; }
    return { verified: true, label: compact(matches[0]) };
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
        const summaries = exact(`视频关键词:${input.value}`).concat(exact(`视频关键词：${input.value}`));
        return { verified: input.value === argument.keyword && summaries.length === 1, keyword: input.value };
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
  if (command === 'capture-context') {
    // This branch reads only controls. Ranking rows come from the API client.
    if (!feiguaPage('ready').ready) return failure('榜单仍在加载，本组未保存');
    const optional = feiguaPage('optional-filters');
    if (!optional.verified) return optional;
    const hasCategory = ['music', 'topics'].includes(argument.kind);
    const category = hasCategory ? musicTagData() : null;
    const videoCategory = argument.kind === 'videos' ? musicTagData('带货品类') : null;
    const videoTag = argument.kind === 'videos' ? musicTagData('视频标签') : null;
    if (hasCategory && (!Array.isArray(category?.path) || category.unsupportedDepth)) return failure('无法核对榜单分类，本组未保存');
    if (argument.kind === 'videos' && (!Array.isArray(videoCategory?.path) || !Array.isArray(videoTag?.path))) return failure('无法核对视频分类，本组未保存');
    const videoPeriod = argument.kind === 'videos' ? feiguaPage('video-period', { verify: true }) : null;
    if (videoPeriod && !videoPeriod.verified) return failure(videoPeriod.error || '视频统计周期未生效，本组未保存');
    const choices = argument.kind === 'topics' ? ['话题总榜', argument.period] : argument.kind === 'hotspots' ? ['热点榜', argument.period] : [];
    let period = videoPeriod?.label || '昨日使用人数';
    for (const label of choices) {
      const current = feiguaPage('choice', { label, verify: true });
      if (!current.verified) return failure('榜单类型或周期未生效，本组未保存');
      period = current.label;
    }
    if (argument.kind === 'topics' && !feiguaPage('category', { label: '话题类型', verify: true }).verified) return failure('话题类型未生效，本组未保存');
    let keyword = null;
    if (argument.kind === 'videos') {
      const current = feiguaPage('keyword', { keyword: argument.keyword, verify: true });
      if (!current.verified) return failure('关键词未生效，本组未保存');
      keyword = current.keyword;
    }
    const inputs = elements('input');
    const starts = inputs.filter(input => input.placeholder === '开始日期');
    const ends = inputs.filter(input => input.placeholder === '结束日期');
    const date = '\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}';
    const ranges = [...new Set(inputs.map(input => input.value.trim()).filter(value => new RegExp(`^${date}\\s*[-~～至]\\s*${date}$`).test(value)))];
    const days = [...new Set(inputs.map(input => input.value.trim()).filter(value => new RegExp(`^${date}$`).test(value)))];
    const dateRange = argument.kind === 'videos' ? videoPeriod.dateRange : argument.kind === 'music' ? null : argument.kind === 'hotspots' ? days.length === 1 ? days[0] : null
      : starts.length === 1 && ends.length === 1 ? `${starts[0].value} - ${ends[0].value}` : ranges.length === 1 ? ranges[0] : null;
    if (argument.kind !== 'music' && !dateRange) return failure('未能唯一回读实际统计日期，本组未保存');
    return { url: location.href, period, keyword, dateRange, filtersVerified: true,
      ...(hasCategory ? { musicTag: category.path, musicTagId: category.selectionId, musicTagOptions: category.options, musicTagRestricted: category.restricted } : {}),
      ...(argument.kind === 'videos' ? { categoryPath: videoCategory.path, categoryId: videoCategory.selectionId, tagPath: videoTag.path, tagId: videoTag.selectionId } : {}),
    };
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
  const fixedHotspotRanking = table => {
    // The current daily hot ranking has a fixed order and no sort arrow.
    // Accept it only with visible source ranks starting at 1 and descending
    // numeric peak heat; a coloured header or a later page is not evidence.
    if (!['热点榜', '日榜'].every(label => {
      const matches = exact(label);
      return matches.length === 1 && selected(matches[0]);
    })) return false;
    const headers = table.headers.map(compact);
    const rankIndex = headers.indexOf('排名'), heatIndex = headers.indexOf('峰值热度');
    if (rankIndex < 0 || heatIndex < 0) return false;
    const rows = table.rows.slice(0, 10);
    if (!rows.length) return false;
    let previous = Infinity;
    return rows.every((cells, index) => {
      if (cells.length !== headers.length || !/^\d+$/.test(compact(cells[rankIndex])) || Number(compact(cells[rankIndex])) !== index + 1) return false;
      const metric = compact(cells[heatIndex]).match(/^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(万|亿|[wW])?$/);
      if (!metric) return false;
      const heat = Number(metric[1].replace(/,/g, '')) * (metric[2] === '亿' ? 1e8 : metric[2] ? 1e4 : 1);
      if (!Number.isFinite(heat) || heat > previous) return false;
      previous = heat;
      return true;
    });
  };
  const rankingDirection = (table, label) => {
    const explicit = sortDirection(table.headers.find(node => compact(node) === label));
    return explicit || (label === '峰值热度' && fixedHotspotRanking(table) ? 'desc' : null);
  };
  if (command === 'sort') {
    const table = findTable(argument.label);
    if (!table) return failure(`未识别含「${argument.label}」的榜单表格`);
    const header = table.headers.find(node => compact(node) === argument.label);
    const direction = rankingDirection(table, argument.label);
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
    if (!table || rankingDirection(table, argument.sort) !== 'desc') return failure('榜单排序状态发生变化');
    if (!feiguaPage('ready').ready) return failure('榜单仍在加载，本组未保存');
    const optional = feiguaPage('optional-filters');
    if (!optional.verified) return optional;
    const choices = argument.kind === 'topics' ? ['话题总榜', argument.period] : argument.kind === 'hotspots' ? ['热点榜', argument.period] : argument.kind === 'videos' ? [argument.period] : [];
    let period = '昨日使用人数';
    for (const label of choices) {
      const current = feiguaPage('choice', { label, verify: true });
      if (!current.verified) return failure('采集时榜单周期或榜单类型发生变化，本组未保存');
      period = current.label;
    }
    if (argument.kind === 'topics' && !feiguaPage('category', { label: '话题类型', verify: true }).verified) return failure('采集时话题类型发生变化，本组未保存');
    let keyword = null;
    if (argument.kind === 'videos') {
      const current = feiguaPage('keyword', { keyword: argument.keyword, verify: true });
      if (!current.verified) return failure('采集时关键词发生变化，本组未保存');
      keyword = current.keyword;
    }
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
      if (argument.kind === 'hotspots' && !item.id) {
        // Daily hotspots use an event-backed title. Read only the public row
        // identity already bound to this rendered row; never invent a URL/ID.
        const source = [main.parentElement, main.parentElement?.parentElement]
          .map(row => row?.__vue__?.$props?.source).find(Boolean);
        const title = typeof source?.Title === 'string' ? source.Title.trim() : '';
        const id = ['string', 'number'].includes(typeof source?.HotId) ? String(source.HotId).trim() : '';
        if (!id || !title || title !== text(main)) return failure('无法核对热点标题及稳定来源标识，本组未保存');
        Object.assign(item, { title, id: `hotspot:${id}`, url: null });
      }
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
    // Dates must come from the selected statistics controls, never publication
    // dates or unrelated examples in the table/body.
    const inputs = elements('input');
    const starts = inputs.filter(input => input.placeholder === '开始日期');
    const ends = inputs.filter(input => input.placeholder === '结束日期');
    const datePattern = '\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}';
    const ranges = [...new Set(inputs.map(input => input.value.trim()).filter(value => new RegExp(`^${datePattern}\\s*[-~～至]\\s*${datePattern}$`).test(value)))];
    const days = [...new Set(inputs.map(input => input.value.trim()).filter(value => new RegExp(`^${datePattern}$`).test(value)))];
    const dateRange = argument.kind === 'music' ? null : argument.kind === 'hotspots'
      ? days.length === 1 ? days[0] : null
      : starts.length === 1 && ends.length === 1 ? `${starts[0].value} - ${ends[0].value}` : ranges.length === 1 ? ranges[0] : null;
    if (argument.kind !== 'music' && !dateRange) return failure('未能唯一回读实际统计日期，本组未保存');
    return { url: location.href, rows, direction: 'desc', sort: argument.sort, period, keyword, filtersVerified: true,
      ...(hasCategory ? { musicTag: categoryData.path, musicTagOptions: categoryData.options, musicTagRestricted: categoryData.restricted } : {}),
      ...(argument.kind === 'videos' ? { categoryPath: videoCategory.path, tagPath: videoTag.path } : {}),
      dateRange,
      emptyVerified: /暂无数据|暂无相关|没有找到/.test(text(table.root)) };
  }
  if (command === 'ready') return { ready: document.readyState === 'complete' && !elements('[aria-busy="true"], .el-loading-mask, .loading-mask').length };
  return failure('未知采集指令');
}
