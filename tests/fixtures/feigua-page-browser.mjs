
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
  await mount(shell + `<div><span>视频标签</span><a class="active"><span>全部</span></a><a>时尚</a></div>
    <table><thead><tr><th>音乐</th><th>总使用人数</th><th aria-sort="descending">昨日使用人数</th></tr></thead>
    <tbody><tr><td><a href="https://dy.feigua.cn/synthetic/music/1">合成音乐</a><p>作者：合成作者</p></td><td>100w</td><td>3w</td></tr></tbody></table>`);
  assert('已登录识别', run('auth').authenticated === true);
  assert('嵌套全部筛选识别', run('category', {label:'视频标签',verify:true}).verified === true);
  assert('明确降序识别', run('sort', {label:'昨日使用人数',verify:true}).verified === true);
  const music = run('capture', {kind:'music',sort:'昨日使用人数',period:'昨日使用人数'});
  assert('音乐累计与昨日字段分别提取', music.rows[0].totalUsers === '100w' && music.rows[0].yesterdayUsers === '3w');
  frame.contentDocument.querySelector('[aria-sort]').setAttribute('aria-sort','ascending');
  assert('升序拒绝采集', Boolean(run('capture', {sort:'昨日使用人数'}).error));
  frame.contentDocument.querySelector('[aria-sort]').removeAttribute('aria-sort');
  assert('未知排序不能伪装降序', Boolean(run('sort', {label:'昨日使用人数',verify:true}).error));
  await mount(shell + `<div><span>视频关键词</span><input><button id="search">模糊搜索</button></div><p id="filters"></p>
    <input value="2026-09-25 - 2026-10-01">
    <table><thead><tr><th>带货视频/发布时间</th><th>关联商品</th><th>达人</th><th aria-sort="descending">视频销售额</th><th>点赞</th></tr></thead><tbody>
    <tr><td><a href="https://dy.feigua.cn/synthetic/video/1" title="合成完整标题">合成标题…</a><p>09/26 16:00</p></td><td><a href="https://dy.feigua.cn/synthetic/product/1">合成商品</a><span>佣金率 5.00%</span></td><td><a href="https://dy.feigua.cn/synthetic/author/1">合成达人</a><span>粉丝数：10w</span></td><td>10w~25w</td><td>5000</td></tr>
    </tbody></table>`);
  frame.contentDocument.querySelector('#search').onclick = () => { frame.contentDocument.querySelector('#filters').textContent = `视频关键词：${frame.contentDocument.querySelector('input').value}`; };
  run('keyword', {keyword:'合成词'});
  assert('关键词设置与筛选回读', run('keyword', {keyword:'合成词',verify:true}).verified === true);
  assert('其他关键词无法混入', run('keyword', {keyword:'其他词',verify:true}).verified === false);
  const videos = run('capture', {kind:'videos',sort:'视频销售额',period:'近7天',keyword:'合成词'});
  assert('完整标题、佣金率、粉丝和区间保真', videos.rows[0].title === '合成完整标题' && videos.rows[0].products[0].commission === '5.00%' && videos.rows[0].followers === '10w' && videos.rows[0].sales === '10w~25w');
  assert('缺少播放列不填零', !videos.rows[0].plays);
  assert('统计日期提取', videos.dateRange === '2026-09-25 - 2026-10-01');
} catch (error) { outputs.push(`ERROR ${error.message}`); }
document.querySelector('#result').textContent = outputs.join('\n');
