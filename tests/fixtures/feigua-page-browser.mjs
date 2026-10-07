
import { feiguaPage } from '/electron/feigua-page.mjs';
import { loginFormMemory } from '/electron/feigua-login-credentials.mjs';
const frame = document.querySelector('iframe');
const outputs = [];
async function mount(html) {
  await new Promise(resolve => { frame.onload = resolve; frame.srcdoc = html; });
}
const run = (command, args = {}) => frame.contentWindow.eval(`(${feiguaPage.toString()})(${JSON.stringify(command)},${JSON.stringify(args)})`);
const assert = (name, passed) => { outputs.push(`${passed ? 'PASS' : 'FAIL'} ${name}`); if (!passed) throw new Error(name); };
const shell = '<aside>个人中心 收藏夹 视频/素材</aside>';
try {
  {
    const loginHtml='<form><input id="username" name="username"><input id="password" name="password" type="password"><input id="save_pass" type="checkbox" checked><button type="button">登录</button></form>';
    await mount(loginHtml);
    const doc=frame.contentDocument, origin=frame.contentWindow.location.origin;
    const saved={username:'synthetic-user',password:'synthetic-password'};
    const memory=args=>frame.contentWindow.eval(`(${loginFormMemory.toString()})(${JSON.stringify({origin,...args})})`);
    let clicked=0;doc.querySelector('button').onclick=()=>{clicked++;};
    assert('登录信息回填到正确表单',memory({command:'install',credentials:saved}).filled===true&&doc.querySelector('#username').value===saved.username&&doc.querySelector('#password').value===saved.password);
    assert('自动回填不点击登录',clicked===0);
    assert('输入只交给主进程私有采集通道',memory({command:'take'}).credentials.password===saved.password);
    doc.querySelector('#password').value='synthetic-new-password';
    doc.querySelector('#password').dispatchEvent(new frame.contentWindow.Event('input',{bubbles:true}));
    assert('新输入覆盖旧密码',memory({command:'take'}).credentials.password==='synthetic-new-password');
    doc.querySelector('#password').value='';
    assert('临时清空字段不删除已记忆信息',memory({command:'take'}).credentials===null);
    doc.querySelector('#save_pass').checked=false;
    assert('取消记住密码请求撤销保存',memory({command:'take'}).credentials.remember===false);
    await mount(loginHtml);
    const freshOrigin=frame.contentWindow.location.origin;
    const fresh=args=>frame.contentWindow.eval(`(${loginFormMemory.toString()})(${JSON.stringify({origin:freshOrigin,...args})})`);
    assert('其他来源不能回填',fresh({command:'install',origin:'https://other.example',credentials:saved}).installed===false&&frame.contentDocument.querySelector('#password').value==='');
    frame.contentDocument.querySelector('#username').value='different-synthetic-user';
    assert('更换账号不填入旧账号密码',fresh({command:'install',credentials:saved}).filled===false&&frame.contentDocument.querySelector('#password').value==='');
    await mount(loginHtml);
    frame.contentDocument.querySelector('#password').value='synthetic-current-input';
    fresh({command:'install',credentials:saved});
    assert('已有用户输入不会被旧密码覆盖',frame.contentDocument.querySelector('#password').value==='synthetic-current-input');
  }
  {
    await mount(shell + `<div class="tag-cascader"><span class="tag-label">视频标签</span><ul class="tag-list"><li class="tag-element"><span class="tag-text">时尚</span></li></ul></div>
      <div class="el-popover" id="own-panel" style="display:none"><label><span>护肤</span></label></div>
      <div class="el-popover"><label><span>护肤</span></label></div>`);
    const root=frame.contentDocument.querySelector('.tag-cascader');
    const own=frame.contentDocument.querySelector('#own-panel');
    const props={value:['0'],options:[{Id:'0',Name:'全部',Sub:[]},{Id:'fashion',Name:'时尚',Sub:[{Id:'skin',Name:'护肤',Sub:[]}]}]};
    root.__vue__={$props:props,popover:{$refs:{popper:own}}};
    root.querySelector('.tag-text').onmouseenter=()=>{own.style.display='block';};
    own.querySelector('label').onclick=()=>{props.value=['fashion','skin'];};
    assert('二级分类展开使用实际文字事件节点',run('music-tag',{path:['时尚','护肤'],phase:'expand'}).changed===true&&own.style.display==='block');
    assert('二级浮层可挂在控件外且不误选别的控件',!root.contains(own)&&run('music-tag',{path:['时尚','护肤'],phase:'select'}).changed===true);
    assert('选择后回读完整二级路径',run('music-tag',{path:['时尚','护肤'],verify:true}).verified===true);
  }
  await mount('<h1>微信扫码登录/注册飞瓜数据</h1>');
  assert('登录页面不能视为已登录', run('auth').authenticated === false);
  assert('登录页不能采集为空榜单', run('capture', {kind:'videos'}).authRequired === true);
  {
    await mount(shell + '<article><h2>账号提示请重新登录怎么办？教你排查</h2><p>微信扫码登录功能说明</p></article>');
    assert('正常榜单标题的登录文案不冒充掉线',run('auth').authenticated===true&&run('ready').ready===true);
    const dialog=frame.contentDocument.createElement('div');dialog.setAttribute('role','dialog');
    dialog.innerHTML='<h2>视频详情</h2><p>标题：账号提示请重新登录怎么办？</p>';frame.contentDocument.body.append(dialog);
    assert('视频详情弹窗中的普通标题也不冒充登录弹窗',run('auth').authenticated===true);
    dialog.innerHTML='<h2>登录提示</h2><p>登录已过期，请重新登录</p><button>重新登录</button>';
    assert('真实过期登录弹窗仍阻止采集',run('auth').authenticated===false&&run('ready').authRequired===true);
    dialog.style.display='none';assert('隐藏登录弹窗不使正常工作台掉线',run('auth').authenticated===true);
    dialog.style.display='block';dialog.innerHTML='<div class="el-message-box__message">登录已过期，请重新登录</div><button>确定</button>';
    assert('结构化的过期消息框仍被识别',run('auth').authenticated===false);
    dialog.remove();const iframe=frame.contentDocument.createElement('iframe');iframe.src='about:blank#login';frame.contentDocument.body.append(iframe);
    assert('工作台覆盖扫码登录框仍需重新登录',run('auth').authenticated===false);
  }
  {
    await mount(shell + '<div class="tag-cascader"><span class="tag-label">视频标签</span><ul class="tag-list"><li class="tag-element"><span class="tag-text">合成一级</span></li></ul></div><div id="video-own-panel" class="el-popover" style="display:none"><label><span>合成二级</span></label></div><div class="el-popover"><label><span>合成二级</span></label></div>');
    const doc=frame.contentDocument,root=doc.querySelector('.tag-cascader'),panel=doc.querySelector('#video-own-panel');
    const props={value:'0',options:[{Id:'0',Name:'全部',Sub:[]},{Id:'p',Name:'合成一级',Sub:[{Id:'c',Name:'合成二级',Sub:[]}]}]};
    root.__vue__={$props:props,popover:{$refs:{popper:panel}}};
    root.querySelector('.tag-text').onmouseenter=()=>{panel.style.display='block';};
    let clicked=0;panel.querySelector('label').onclick=()=>{clicked++;props.value='c';};
    assert('视频分类从真实文字节点展开浮层',run('video-filter',{label:'视频标签',path:['合成一级','合成二级'],phase:'expand',depth:0}).changed===true&&panel.style.display==='block');
    assert('视频二级分类使用自己的外置浮层且忽略同名干扰',run('video-filter',{label:'视频标签',path:['合成一级','合成二级'],phase:'select'}).changed===true&&clicked===1);
    assert('视频外置浮层选择后回读完整路径',run('video-filter',{label:'视频标签',path:['合成一级','合成二级'],verify:true}).verified===true);
    props.value='0';const mask=doc.createElement('div');mask.className='purview-mask-layer';panel.append(mask);
    assert('视频外置浮层权限遮罩不可穿透',/权限受限/.test(run('video-filter',{label:'视频标签',path:['合成一级','合成二级'],phase:'select'}).error)&&clicked===1);mask.remove();
    panel.style.display='none';assert('隐藏的外置浮层不能靠同名干扰选中',Boolean(run('video-filter',{label:'视频标签',path:['合成一级','合成二级'],phase:'select'}).error)&&clicked===1);
  }
  await mount('<header><a href="https://dy.feigua.cn/synthetic/workspace">进入工作台</a><img alt="用户头像"></header>');
  assert('官网登录后首页识别工作台入口', run('auth').workspaceAvailable === true);
  assert('官网首页本身不冒充后台验证成功', run('auth').authenticated === false);
  assert('使用页面真实工作台链接', run('enter-workspace').url === 'https://dy.feigua.cn/synthetic/workspace');
  await mount('<header><a>进入工作台</a><a>注册 / 登录</a></header>');
  assert('仍有登录入口时不误判已完成登录', run('auth').workspaceAvailable === false);
  await mount(shell + '<div role="dialog"><h2>数据使用限制声明</h2><button>同意并继续使用</button><button>拒绝并退出</button></div>');
  assert('声明弹窗阻止后台登录就绪判定', run('auth').authenticated === false && run('auth').actionRequired === 'terms');
  assert('声明未处理时拒绝采集', run('capture', {kind:'music'}).actionRequired === 'terms');
  let accepted = 0;
  frame.contentDocument.querySelector('button').onclick = () => { accepted++; frame.contentDocument.querySelector('[role="dialog"]').remove(); };
  assert('自动确认已授权的指定声明', run('accept-terms').accepted === true && accepted === 1);
  assert('声明消失后不重复确认', run('accept-terms').accepted === false && accepted === 1);
  await mount(shell + `<div class="tag-cascader"><span class="tag-label">视频标签</span><a class="active"><span>全部</span></a><a>时尚</a></div>
    <table><thead><tr><th>音乐</th><th>总使用人数</th><th aria-sort="descending">昨日使用人数</th></tr></thead>
    <tbody><tr><td><a href="https://dy.feigua.cn/synthetic/music/1">合成音乐</a><p>作者：合成作者</p></td><td>100w</td><td>3w</td></tr></tbody></table>`);
  frame.contentDocument.querySelector('.tag-cascader').__vue__ = { $props: { value:['0'], options:[{Id:'0',Name:'全部',Sub:[]}] } };
  assert('已登录识别', run('auth').authenticated === true);
  assert('嵌套全部筛选识别', run('category', {label:'视频标签',verify:true}).verified === true);
  assert('明确降序识别', run('sort', {label:'昨日使用人数',verify:true}).verified === true);
  const music = run('capture', {kind:'music',sort:'昨日使用人数',period:'昨日使用人数'});
  assert('音乐累计与昨日字段分别提取', music.rows[0].totalUsers === '100w' && music.rows[0].yesterdayUsers === '3w');
  frame.contentDocument.querySelector('[aria-sort]').setAttribute('aria-sort','ascending');
  assert('升序拒绝采集', Boolean(run('capture', {sort:'昨日使用人数'}).error));
  frame.contentDocument.querySelector('[aria-sort]').removeAttribute('aria-sort');
  assert('未知排序不能伪装降序', Boolean(run('sort', {label:'昨日使用人数',verify:true}).error));
  await mount(shell + `<div class="dy-side-bar-poper" style="display:none"><div class="child-wrapper"><div class="child-label">热门音乐</div></div></div>
    <div class="tag-cascader"><span class="tag-label">视频标签</span></div>
    <section><div><div class="list-hd"><div class="col-item">音乐</div><div class="col-item">总使用人数</div><div class="col-item"><div class="define-sort-th sorting">昨日使用人数<i class="arrow v-bottom active"></i></div></div></div></div>
    <div><div class="col-item"><a href="https://dy.feigua.cn/synthetic/music/1">合成音乐</a><p>作者：合成作者</p></div><div class="col-item">20w</div><div class="col-item">5w</div></div></section>`);
  frame.contentDocument.querySelector('.tag-cascader').__vue__ = { $props: { value:['0'], options:[{Id:'0',Name:'全部',Sub:[]}] } };
  let menuClicked = false;
  frame.contentDocument.querySelector('.child-wrapper').onclick = () => { menuClicked = true; };
  assert('识别新版事件菜单入口', run('navigate', {labels:['热门音乐']}).clicked === true && menuClicked);
  assert('新版自定义列表降序核验', run('sort', {label:'昨日使用人数',verify:true}).verified === true);
  const customMusic = run('capture', {kind:'music',sort:'昨日使用人数',period:'昨日使用人数'});
  assert('新版列表表头与数据行分离仍正确提取', customMusic.rows.length === 1 && customMusic.rows[0].yesterdayUsers === '5w');
  await mount(shell + `<div><input readonly value="视频关键词"><input placeholder="请输入视频标题关键词或链接搜索"><button id="search">模糊搜索</button></div><span id="filters"></span>
    <div id="video-period"><span>时间周期</span><div class="permission-wrapper active"><button><span>近7天</span></button></div>
    <input placeholder="开始日期" value="2026-09-25"><input placeholder="结束日期" value="2026-10-01"></div>
    <table><thead><tr><th>带货视频/发布时间</th><th>关联商品</th><th>达人</th><th aria-sort="descending">视频销售额</th><th>点赞</th></tr></thead><tbody>
    <tr><td><a href="https://dy.feigua.cn/synthetic/video/1" title="合成完整标题">合成标题…</a><p>09/26 16:00</p></td><td><a href="https://dy.feigua.cn/synthetic/product/1">合成商品</a><span>佣金率 5.00%</span></td><td><a href="https://dy.feigua.cn/synthetic/author/1">合成达人</a><span>粉丝数：10w</span></td><td>10w~25w</td><td>5000</td></tr>
    </tbody></table>`);
  assert('新版时间周期选中状态核验', run('choice', {label:'近7天',verify:true}).verified === true);
  assert('视频快捷周期同时核验七天日期',run('video-period',{verify:true}).dateRange==='2026-09-25 - 2026-10-01');
  frame.contentDocument.querySelector('#search').onclick = () => { frame.contentDocument.querySelector('#filters').textContent = `视频关键词：${frame.contentDocument.querySelector('input:not([readonly])').value}`; };
  run('keyword', {keyword:'合成词'});
  assert('关键词设置与筛选回读', run('keyword', {keyword:'合成词',verify:true}).verified === true);
  assert('其他关键词无法混入', run('keyword', {keyword:'其他词',verify:true}).verified === false);
  frame.contentDocument.querySelector('#filters').textContent = '视频关键词：合成词后缀';
  assert('关键词前缀相同不能冒充完整匹配', run('keyword', {keyword:'合成词',verify:true}).verified === false);
  frame.contentDocument.querySelector('#filters').textContent = '视频关键词：合成词';
  for (const label of ['带货品类', '视频标签']) {
    const root = frame.contentDocument.createElement('div');
    root.className = 'tag-cascader';
    root.innerHTML = `<span class="tag-label">${label}</span><div class="permission-wrapper"><ul class="tag-list"><li class="tag-element">全部</li><li class="tag-element">${label}一级</li></ul></div><div class="el-popover" style="display:none"><span>${label}二级</span><span style="display:none">${label}三级</span></div>`;
    const props = { value:['0'], options:[{Id:'0',Name:'全部',Sub:[]},{Id:'1',Name:`${label}一级`,Sub:[{Id:'11',Name:`${label}二级`,Sub:[{Id:'111',Name:`${label}三级`,Sub:[]}]}]}] };
    root.__vue__ = {$props:props};
    const choices = root.querySelectorAll('.tag-element');
    choices[0].onclick = () => { props.value=['0']; };
    choices[1].onclick = () => { props.value=['1']; };
    choices[1].onmouseenter = () => { root.querySelector('.el-popover').style.display='block'; };
    const children = root.querySelectorAll('.el-popover span');
    children[0].onclick = () => { props.value=['1','11']; };
    children[0].onmouseenter = () => { children[1].style.display='inline'; };
    children[1].onclick = () => { props.value=['1','11','111']; };
    frame.contentDocument.body.append(root);
  }
  const videoCatalog = run('video-filter-options');
  assert('带货品类和视频标签目录独立读取，保留三级', videoCatalog.categoryPath[0].children[0].children[0].label === '带货品类三级' && videoCatalog.tagPath[0].label === '视频标签一级');
  const scalarWidget = [...frame.contentDocument.querySelectorAll('.tag-cascader')].find(root=>root.querySelector('.tag-label').textContent==='视频标签');
  scalarWidget.__vue__.$props.value='0';
  assert('真实视频标签使用字符串 ID 时目录仍可读取',run('video-filter-options').tagPath[0].label==='视频标签一级');
  assert('字符串全部 ID 可核验',run('video-filter',{label:'视频标签',path:[],verify:true}).verified===true);
  scalarWidget.__vue__.$props.value='11';
  assert('字符串子级 ID 可回读完整路径',run('video-filter',{label:'视频标签',path:['视频标签一级','视频标签二级'],verify:true}).verified===true);
  scalarWidget.__vue__.$props.value='unknown';
  assert('未知字符串 ID 不能视为全部',run('video-filter',{label:'视频标签',path:[],verify:true}).verified===false);
  scalarWidget.__vue__.$props.value='0';
  const categoryPath=['带货品类一级','带货品类二级','带货品类三级'], tagPath=['视频标签一级','视频标签二级'];
  for (const [label,path] of [['带货品类',categoryPath],['视频标签',tagPath]]) {
    for (let depth=0; depth<path.length-1; depth++) run('video-filter',{label,path,phase:'expand',depth});
    run('video-filter',{label,path,phase:'select'});
    assert(`${label}独立选中并回读完整层级`,run('video-filter',{label,path,verify:true}).verified===true);
  }
  const videos = run('capture', {kind:'videos',sort:'视频销售额',period:'近7天',keyword:'合成词'});
  assert('视频结果回读两套实际筛选，不用请求参数冒充',videos.categoryPath.join('/')===categoryPath.join('/') && videos.tagPath.join('/')===tagPath.join('/'));
  assert('完整标题、佣金率、粉丝和区间保真', videos.rows[0].title === '合成完整标题' && videos.rows[0].products[0].commission === '5.00%' && videos.rows[0].followers === '10w' && videos.rows[0].sales === '10w~25w');
  assert('缺少播放列不填零', !videos.rows[0].plays);
  assert('统计日期提取', videos.dateRange === '2026-09-25 - 2026-10-01');
  const videoArgs = {kind:'videos',sort:'视频销售额',period:'近7天',keyword:'合成词'};
  frame.contentDocument.querySelector('.permission-wrapper.active').classList.remove('active');
  assert('最终采集重新核验周期而非复述请求参数', /周期/.test(run('capture',videoArgs).error));
  frame.contentDocument.querySelector('.permission-wrapper').classList.add('active');
  frame.contentDocument.querySelector('#filters').textContent = '视频关键词：其他词';
  assert('最终采集重新核验关键词', /关键词/.test(run('capture',videoArgs).error));
  frame.contentDocument.querySelector('#filters').textContent = '视频关键词：合成词';
  const loading = frame.contentDocument.createElement('div'); loading.className = 'el-loading-mask'; loading.textContent = '加载中'; frame.contentDocument.body.append(loading);
  assert('仍在加载时不能保存旧列表', /加载/.test(run('capture',videoArgs).error)); loading.remove();
  run('video-filter',{label:'带货品类',path:[],phase:'select'});
  assert('切换关键词前允许回到全部，另一套筛选保持独立',run('video-filter',{label:'带货品类',path:[],verify:true}).verified===true && run('video-filter',{label:'视频标签',path:tagPath,verify:true}).verified===true);
  const videoRoot=frame.contentDocument.querySelector('.tag-cascader');
  const videoMask=frame.contentDocument.createElement('div');videoMask.className='purview-mask-layer';videoMask.textContent='权限遮罩';videoRoot.append(videoMask);
  assert('视频分类权限遮罩不可穿透',/权限受限/.test(run('video-filter',{label:'带货品类',path:categoryPath,phase:'select'}).error) && videoRoot.__vue__.$props.value[0]==='0');
  videoRoot.__vue__.$props.value=['unknown'];
  assert('视频实际分类不明时禁止保存',/无法回读/.test(run('capture',{kind:'videos',sort:'视频销售额'}).error));
  await mount(shell + `<div class="tag-cascader"><span class="tag-label">视频标签</span><div class="permission-wrapper"><ul class="tag-list"><li class="tag-element" id="all-tag">全部</li><li class="tag-element" id="parent-tag">合成一级</li></ul></div><div class="el-popover" style="display:none"><span id="child-tag">合成二级</span></div></div>`);
  const tagRoot = frame.contentDocument.querySelector('.tag-cascader');
  const widgetProps = { value:['0'],options:[{Id:'0',Name:'全部',Sub:[]},{Id:'1',Name:'合成一级',Sub:[{Id:'11',Name:'合成二级',Sub:[]}]}] };
  tagRoot.__vue__ = { $props:widgetProps };
  frame.contentDocument.querySelector('#all-tag').onclick = () => { widgetProps.value=['0']; };
  frame.contentDocument.querySelector('#parent-tag').onclick = () => { widgetProps.value=['1']; };
  frame.contentDocument.querySelector('#parent-tag').onmouseenter = () => { tagRoot.querySelector('.el-popover').style.display='block'; };
  frame.contentDocument.querySelector('#child-tag').onclick = () => { widgetProps.value=['1','11']; };
  const catalog=run('music-tag-options');
  assert('BGM 分类目录包含真实父子层级', catalog.options[0].children[0].label==='合成二级');
  run('music-tag',{path:['合成一级'],phase:'select'});
  assert('只选择一级可以回读',run('music-tag',{path:['合成一级'],verify:true}).verified===true);
  run('music-tag',{path:['合成一级','合成二级'],phase:'expand'});
  run('music-tag',{path:['合成一级','合成二级'],phase:'select'});
  assert('选择二级并核验完整路径',run('music-tag',{path:['合成一级','合成二级'],verify:true}).verified===true);
  assert('错误二级不得视为筛选生效',run('music-tag',{path:['合成一级','不存在'],verify:true}).verified===false);
  run('music-tag',{path:[],phase:'select'});
  assert('支持回到全部标签',run('music-tag',{path:[],verify:true}).verified===true);
  const mask=frame.contentDocument.createElement('div');mask.className='purview-mask-layer';mask.textContent='权限遮罩';tagRoot.querySelector('.permission-wrapper').append(mask);
  assert('权限层存在时不得点击穿透',/权限受限/.test(run('music-tag',{path:['合成一级'],phase:'select'}).error)&&widgetProps.value[0]==='0');
  mask.remove();
  tagRoot.querySelector('.tag-label').textContent = '话题分类';
  const table = frame.contentDocument.createElement('div');
  table.innerHTML = `<button class="active">话题总榜</button><button class="active">周榜</button><div><span>话题类型</span><button class="active">全部</button></div><input value="2026-09-21 - 2026-09-27"><table><thead><tr><th>话题</th><th aria-sort="descending">参与人数增长率</th></tr></thead><tbody><tr><td><a href="https://dy.feigua.cn/synthetic/topic/1">合成话题</a></td><td>20%</td></tr></tbody></table>`;
  frame.contentDocument.body.append(table);
  const topicArgs = {kind:'topics',sort:'参与人数增长率',period:'周榜'};
  assert('话题从自身控件读取二级目录',run('music-tag-options',{kind:'topics'}).options[0].children[0].label==='合成二级');
  run('music-tag',{kind:'topics',path:['合成一级'],phase:'select'});
  assert('话题一级分类回读',run('music-tag',{kind:'topics',path:['合成一级'],verify:true}).verified===true);
  run('music-tag',{kind:'topics',path:['合成一级','合成二级'],phase:'expand'});
  run('music-tag',{kind:'topics',path:['合成一级','合成二级'],phase:'select'});
  assert('话题二级分类回读完整路径',run('music-tag',{kind:'topics',path:['合成一级','合成二级'],verify:true}).verified===true);
  const topicResult = run('capture',topicArgs);
  assert('话题结果保留二级分类和原排名日期',topicResult.musicTag.join(' > ')==='合成一级 > 合成二级' && topicResult.rows[0].participantGrowth==='20%' && topicResult.dateRange==='2026-09-21 - 2026-09-27');
  assert('话题不会误读 BGM 控件',Boolean(run('music-tag',{path:['合成一级'],verify:true}).error));
  assert('不存在的二级不能视为筛选生效',run('music-tag',{kind:'topics',path:['合成一级','不存在'],verify:true}).verified===false);
  run('music-tag',{kind:'topics',path:[],phase:'select'});
  assert('话题可回到全部',run('capture',topicArgs).musicTag.length===0);
  tagRoot.querySelector('.permission-wrapper').append(mask);
  assert('话题不能穿透权限遮罩',/权限受限/.test(run('music-tag',{kind:'topics',path:['合成一级'],phase:'select'}).error)&&widgetProps.value[0]==='0');
  mask.remove();
  widgetProps.value=['unknown'];
  assert('话题分类回读失败不能当全部保存',/无法回读/.test(run('capture',topicArgs).error));
  widgetProps.value=['0'];
  widgetProps.options[1].Sub[0].Sub=[{Id:'111',Name:'新增三级',Sub:[]}];
  assert('未来出现三级目录时不得静默截断',/三级/.test(run('music-tag-options',{kind:'topics'}).error)&&/三级/.test(run('capture',topicArgs).error));
  await mount(shell + `<div role="tab" aria-selected="true" class="el-tabs__item is-active"><div><span>热点榜</span></div></div><button class="active"><span>日榜</span></button><input value="2026-10-01"><table><thead><tr><th>热点</th><th aria-sort="descending">峰值热度</th></tr></thead><tbody><tr><td><a href="https://dy.feigua.cn/synthetic/hotspot/1">合成热点</a></td><td>1249.1w</td></tr></tbody></table>`);
  const hotspotArgs = {kind:'hotspots',sort:'峰值热度',period:'日榜'};
  assert('真实嵌套 tab 的选中状态从 role=tab 回读',run('choice',{label:'热点榜',verify:true}).verified===true);
  assert('日榜保存具体单日统计日期',run('capture',hotspotArgs).dateRange==='2026-10-01');
  frame.contentDocument.querySelector('[role="tab"]').setAttribute('aria-selected','false');
  frame.contentDocument.querySelector('[role="tab"]').classList.remove('is-active');
  assert('最终采集不接受已变化的热点榜类型',/周期或榜单类型/.test(run('capture',hotspotArgs).error));
  frame.contentDocument.querySelector('[role="tab"]').setAttribute('aria-selected','true');
  frame.contentDocument.querySelector('button').classList.remove('active');
  assert('实时或未选中周期不能被标为日榜',/周期/.test(run('capture',hotspotArgs).error));
  frame.contentDocument.querySelector('button').classList.add('active');
  frame.contentDocument.querySelector('input').remove();
  const unrelatedDate = frame.contentDocument.createElement('p'); unrelatedDate.textContent='其他内容发布于 2026-10-01'; frame.contentDocument.body.append(unrelatedDate);
  assert('不能拿表格正文日期冒充所选统计日期',/统计日期/.test(run('capture',hotspotArgs).error));
  await mount(shell + `<div role="tab" aria-selected="true"><div><span>热点榜</span></div></div><button class="active">日榜</button><input value="2026-10-01"><table><thead><tr><th>排名</th><th>热点</th><th>峰值热度</th></tr></thead><tbody><tr><td>01</td><td><a href="https://dy.feigua.cn/synthetic/hotspot/1">合成热点1</a></td><td>0.2亿</td></tr><tr><td>02</td><td><a href="https://dy.feigua.cn/synthetic/hotspot/2">合成热点2</a></td><td>1000w</td></tr></tbody></table>`);
  assert('固定日榜无排序箭头时核验来源排名和峰值热度降序',run('sort',{label:'峰值热度',verify:true}).verified===true);
  assert('固定日榜可以按真实日期及顺序采集',run('capture',hotspotArgs).rows.length===2);
  const fixedRows = frame.contentDocument.querySelectorAll('tbody tr');
  fixedRows[1].children[2].textContent='0.3亿';
  assert('实际热度升序的固定榜单被拒绝',Boolean(run('sort',{label:'峰值热度',verify:true}).error));
  fixedRows[1].children[2].textContent='1000w';
  fixedRows[0].children[0].textContent='06';
  assert('不是从第一名开始的页面不能冒充 Top5',Boolean(run('capture',hotspotArgs).error));
  fixedRows[0].children[0].textContent='01';
  fixedRows[1].children[0].textContent='03';
  assert('来源排名缺行不能静默跳过',Boolean(run('capture',hotspotArgs).error));
  fixedRows[1].children[0].textContent='02';
  fixedRows[1].children[2].textContent='开通会员查看';
  assert('固定排名指标为权限提示时拒绝采集',Boolean(run('capture',hotspotArgs).error));
  fixedRows[1].children[2].textContent='1000w';
  frame.contentDocument.querySelector('th:last-child').setAttribute('aria-sort','ascending');
  assert('显式升序不能被固定排名规则覆盖',Boolean(run('capture',hotspotArgs).error));
  frame.contentDocument.querySelector('th:last-child').removeAttribute('aria-sort');
  fixedRows[0].children[1].innerHTML='<div class="cursor-pointer-color">合成热点1</div>';
  fixedRows[0].__vue__={$props:{source:{HotId:'synthetic-hotspot-id',Title:'合成热点1',privateIgnored:'must-not-leak'}}};
  const eventTitle=run('capture',hotspotArgs);
  assert('非链接热点标题使用实际行 HotId 而非标题或行号造 ID',eventTitle.rows[0].id==='hotspot:synthetic-hotspot-id' && eventTitle.rows[0].title==='合成热点1' && eventTitle.rows[0].url===null);
  assert('行组件仅返回白名单身份字段',!JSON.stringify(eventTitle).includes('must-not-leak'));
  fixedRows[0].__vue__.$props.source.Title='不匹配标题';
  assert('行绑定数据与可见标题不一致时拒绝保存',/稳定来源标识/.test(run('capture',hotspotArgs).error));
  fixedRows[0].__vue__.$props.source.Title='合成热点1';
  delete fixedRows[0].__vue__.$props.source.HotId;
  assert('非链接热点缺少真实标识时拒绝保存',/稳定来源标识/.test(run('capture',hotspotArgs).error));
  await mount(shell + `<div role="tab" aria-selected="true"><div><span>热点榜</span></div></div><button class="active">日榜</button><input value="2026-10-01"><section><div class="list-hd"><div class="col-item">排名</div><div class="col-item">热点</div><div class="col-item">峰值热度</div></div><div class="item-border-bottom"><div class="row-cells"><div class="col-item">01</div><div class="col-item">合成热点</div><div class="col-item">1000w</div></div></div></section>`);
  frame.contentDocument.querySelector('.item-border-bottom').__vue__={$props:{source:{HotId:'nested-row-id',Title:'合成热点'}}};
  assert('真实自定义列表从外层行组件回读身份',run('capture',hotspotArgs).rows[0].id==='hotspot:nested-row-id');
  const context=run('capture-context',hotspotArgs);
  assert('接口采集上下文只回读控件，不携带表格数据',context.dateRange==='2026-10-01'&&!Object.hasOwn(context,'rows'));
  frame.contentDocument.querySelector('section').remove();
  assert('表格不存在也能完成接口请求的筛选上下文核验',run('capture-context',hotspotArgs).filtersVerified===true);
  {
    const dates='<div id="statistics"><span>时间周期</span><div class="el-date-editor--daterange"><input placeholder="开始日期" value="2026-10-01"><input placeholder="结束日期" value="2026-10-07"></div></div>';
    const categories=['带货品类','视频标签'].map(label=>`<div class="tag-cascader"><span class="tag-label">${label}</span></div>`).join('');
    await mount(shell + dates + categories + '<div><input readonly value="视频关键词"><input value="合成词"><button>模糊搜索</button></div><span>视频关键词：合成词</span><section id="publication"><span>发布时间段</span><button class="active">近7天</button><input placeholder="开始日期" value="2026-09-01"><input placeholder="结束日期" value="2026-10-07"></section>');
    frame.contentWindow.Date.now=()=>Date.parse('2026-10-07T14:00:00Z');
    for(const root of frame.contentDocument.querySelectorAll('.tag-cascader'))root.__vue__={$props:{value:['0'],options:[{Id:'0',Name:'全部',Sub:[]}]}};
    const doc=frame.contentDocument,root=doc.querySelector('#statistics'),start=root.querySelector('input'),end=root.querySelectorAll('input')[1];
    let clicks=0;root.onclick=()=>{clicks++;};
    assert('没有快捷按钮时直接核验真实近7天日期',run('video-period').verified===true&&clicks===0);
    assert('无快捷按钮的 API 上下文忽略发布时间筛选日期',run('capture-context',{kind:'videos',keyword:'合成词',period:'近7天'}).dateRange==='2026-10-01 - 2026-10-07');
    start.value='2026-09-24';end.value='2026-09-30';
    assert('任意历史七天不冒充当前近7天',run('video-period',{verify:true}).verified===false);
    assert('其他筛选区的同名快捷按钮不能代替统计周期',run('video-period').calendar===true);
    assert('请求期间周期变化不能继续保存',Boolean(run('capture-context',{kind:'videos',keyword:'合成词',period:'近7天'}).error));
    start.value='2026-02-30';end.value='2026-03-08';
    assert('无效日历日期不能通过',run('video-period',{verify:true}).verified===false);
    start.value='2026-10-01';end.value='2026-10-07';
    const duplicate=start.cloneNode();root.append(duplicate);
    assert('同一统计控件日期重复时拒绝猜测',Boolean(run('video-period',{verify:true}).error));duplicate.remove();
    const mask=doc.createElement('div');mask.className='purview-mask-layer';root.append(mask);
    assert('时间周期权限遮罩不可穿透',/权限/.test(run('video-period').error)&&clicks===0);mask.remove();
    root.querySelector('span').textContent='未知时间';
    assert('缺少时间周期标识不能使用发布时间',Boolean(run('video-period').error));
  }
  {
    await mount(shell + '<div><span>时间周期</span><div class="el-date-editor--daterange"><input placeholder="开始日期" value="2026-11-01"><input placeholder="结束日期" value="2026-11-07"></div></div><div id="own" class="el-date-range-picker" style="display:none"><div class="el-date-range-picker__content"><div class="el-date-range-picker__header"><button class="el-icon-arrow-left"></button><div>2026 年 10 月</div></div><table class="el-date-table"><tbody><tr><td class="available"><span>28</span></td></tr></tbody></table></div><div class="el-date-range-picker__content"><div class="el-date-range-picker__header"><button class="el-icon-arrow-right"></button><div>2026 年 11 月</div></div><table class="el-date-table"><tbody><tr><td class="available"><span>3</span></td></tr></tbody></table></div></div><div class="el-date-range-picker"><button>28</button></div>');
    frame.contentWindow.Date.now=()=>Date.parse('2027-01-02T16:00:00Z');
    const doc=frame.contentDocument,editor=doc.querySelector('.el-date-editor--daterange'),panel=doc.querySelector('#own');
    const props=Object.freeze({disabled:false});editor.__vue__={$props:props,picker:{$el:panel}};
    editor.onclick=()=>{panel.style.display='block';};
    let picked=0;const cells=panel.querySelectorAll('td');
    for(const cell of cells)cell.onclick=()=>{if(++picked===2){editor.querySelectorAll('input')[0].value='2026-12-28';editor.querySelectorAll('input')[1].value='2027-01-03';panel.style.display='none';}};
    let moves=0;
    panel.querySelector('.el-icon-arrow-right').onclick=()=>{const headers=panel.querySelectorAll('.el-date-range-picker__header > div');moves++;headers[0].textContent=moves===1?'2026 年 11 月':'2026 年 12 月';headers[1].textContent=moves===1?'2026 年 12 月':'2027 年 1 月';cells[1].querySelector('span').textContent=moves===1?'28':'3';};
    assert('错误周期请求正常日历选择',run('video-period').calendar===true);
    assert('通过控件点击打开所属面板',run('video-period',{phase:'open'}).opened===true);
    assert('跨月仅点击普通月份导航',run('video-period',{phase:'start'}).moved===true);
    cells[1].classList.add('disabled');
    assert('禁用日期不能被点击',Boolean(run('video-period',{phase:'start'}).error)&&picked===0);cells[1].classList.remove('disabled');
    assert('跨年起始日按完整年月识别',run('video-period',{phase:'start'}).picked===true&&picked===1);
    assert('终止日在下一月时继续普通导航',run('video-period',{phase:'end'}).moved===true&&moves===2);
    assert('终止日通过正常点击提交',run('video-period',{phase:'end'}).picked===true&&picked===2);
    assert('选择后核验日期值且不修改 Vue 状态',run('video-period',{verify:true}).dateRange==='2026-12-28 - 2027-01-03'&&editor.__vue__.$props===props);
  }
} catch (error) { outputs.push(`ERROR ${error.message}`); }
document.querySelector('#result').textContent = outputs.join('\n');
