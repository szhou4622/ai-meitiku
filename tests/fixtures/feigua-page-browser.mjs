
import { feiguaPage } from '/electron/feigua-page.mjs';
const frame = document.querySelector('iframe');
const outputs = [];
async function mount(html) {
  await new Promise(resolve => { frame.onload = resolve; frame.srcdoc = html; });
}
const run = (command, args = {}) => frame.contentWindow.eval(`(${feiguaPage.toString()})(${JSON.stringify(command)},${JSON.stringify(args)})`);
const assert = (name, passed) => { outputs.push(`${passed ? 'PASS' : 'FAIL'} ${name}`); if (!passed) throw new Error(name); };
const shell = '<aside>个人中心 收藏夹 视频/素材</aside>';
try {
  await mount('<h1>微信扫码登录/注册飞瓜数据</h1>');
  assert('登录页面不能视为已登录', run('auth').authenticated === false);
  assert('登录页不能采集为空榜单', run('capture', {kind:'videos'}).authRequired === true);
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
  await mount(shell + `<div><input readonly value="视频关键词"><input placeholder="请输入视频标题关键词或链接搜索"><button id="search">模糊搜索</button></div><p id="filters"></p>
    <div class="permission-wrapper active"><button><span>近7天</span></button></div>
    <input placeholder="开始日期" value="2026-09-25"><input placeholder="结束日期" value="2026-10-01">
    <table><thead><tr><th>带货视频/发布时间</th><th>关联商品</th><th>达人</th><th aria-sort="descending">视频销售额</th><th>点赞</th></tr></thead><tbody>
    <tr><td><a href="https://dy.feigua.cn/synthetic/video/1" title="合成完整标题">合成标题…</a><p>09/26 16:00</p></td><td><a href="https://dy.feigua.cn/synthetic/product/1">合成商品</a><span>佣金率 5.00%</span></td><td><a href="https://dy.feigua.cn/synthetic/author/1">合成达人</a><span>粉丝数：10w</span></td><td>10w~25w</td><td>5000</td></tr>
    </tbody></table>`);
  assert('新版时间周期选中状态核验', run('choice', {label:'近7天',verify:true}).verified === true);
  frame.contentDocument.querySelector('#search').onclick = () => { frame.contentDocument.querySelector('#filters').textContent = `视频关键词：${frame.contentDocument.querySelector('input:not([readonly])').value}`; };
  run('keyword', {keyword:'合成词'});
  assert('关键词设置与筛选回读', run('keyword', {keyword:'合成词',verify:true}).verified === true);
  assert('其他关键词无法混入', run('keyword', {keyword:'其他词',verify:true}).verified === false);
  const videos = run('capture', {kind:'videos',sort:'视频销售额',period:'近7天',keyword:'合成词'});
  assert('完整标题、佣金率、粉丝和区间保真', videos.rows[0].title === '合成完整标题' && videos.rows[0].products[0].commission === '5.00%' && videos.rows[0].followers === '10w' && videos.rows[0].sales === '10w~25w');
  assert('缺少播放列不填零', !videos.rows[0].plays);
  assert('统计日期提取', videos.dateRange === '2026-09-25 - 2026-10-01');
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
  table.innerHTML = `<input value="2026-09-21 - 2026-09-27"><table><thead><tr><th>话题</th><th aria-sort="descending">参与人数增长率</th></tr></thead><tbody><tr><td><a href="https://dy.feigua.cn/synthetic/topic/1">合成话题</a></td><td>20%</td></tr></tbody></table>`;
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
} catch (error) { outputs.push(`ERROR ${error.message}`); }
document.querySelector('#result').textContent = outputs.join('\n');
