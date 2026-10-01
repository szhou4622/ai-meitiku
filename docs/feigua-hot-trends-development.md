# 飞瓜热点采集开发与验收记录

日期：2026-10-01。分支：`codex/feigua-hot-trends`。

## 实现范围

- 在现有侧栏新增“热点采集”，保留原媒体库布局和功能入口。
- 新增四类结果展示、关键词新增/修改/删除/保存、登录及状态检查、开始/取消采集、最近 12 次历史批次。
- 使用独立 Electron 沙箱窗口承载飞瓜登录，识别后台页面后自动关闭登录窗口并更新媒体库登录状态，复用同一个持久会话分区。用户无需提供端口；密码和 Cookie 不进入应用 IPC 或榜单存储。
- 将关键词、任务意图、分组结果保存在 Electron `userData/feigua-trends/state.json`，通过临时文件及 rename 写入。开始时固定关键词快照；中断不自动重跑；失败不覆盖之前批次。
- 主进程按基础授权检查 `feigua-*` IPC，并验证请求来自应用主窗口主框架；飞瓜页面没有 preload、Node 权限或应用桥接。
- 适配器从飞瓜登录后的菜单识别来源链接，按页面文字和表头设置筛选、核验降序、提取前 5 条。无法识别来源、筛选、排序或稳定标识时明确失败，不把错误页面保存为空榜单。
- 销售额区间、佣金率和万/亿单位保留原文；未读到的字段显示“未取得”。跨关键词允许重复命中，同组按来源标识去重。

## 代码入口

- `app/feigua-trends.tsx`、`app/feigua-trends.module.css`：界面。
- `electron/feigua-service.mjs`：本地状态与任务生命周期。
- `electron/feigua-browser.mjs`：独立会话、导航限制、采集流程。
- `electron/feigua-page.mjs`：页面筛选与表格提取。
- `electron/feigua-contract.mjs`：来源规则、关键词校验、结果字段白名单。
- `electron/main.mjs`、`electron/preload.cjs`、`electron/feature-registry.mjs`：桌面接入与授权。

## 已执行验证

1. `npm run test:feigua`：26 项通过，覆盖采集规则、关键词快照、重复任务拒绝、会话失效、取消、重启恢复、保存失败、导航边界、功能授权，以及登录成功自动关闭窗口并同步状态。
2. `npx tsc --noEmit --pretty false`：通过。
3. 新增功能与测试文件的定向 ESLint：通过。
4. `npm run dev -- --host 127.0.0.1 --port 5177`：浏览器实际打开原应用并进入“热点采集”；以明确标记的合成数据验证关键词新增、修改、删除、保存、采集按钮状态、四类字段显示和历史结果保留。测试桥接已通过刷新页面移除。
5. `tests/fixtures/feigua-page.html`：13 项浏览器合成 DOM 检查通过，包含登录页拒绝、筛选回读、升序/未知排序拒绝、关键词隔离、完整标题、佣金、销售区间、日期与缺失播放字段。此测试不连接飞瓜。
6. `node --test tests/rendered-html.test.mjs`：30 项通过，2 项因仓库缺少 `bundled-classifier` 的 Windows/macOS `engine_entry.py` 失败；不补造缺失组件、不跳过这些测试。
7. 构建：Windows Node 24.18.0/24.19.0 出现完成页面生成后以 `UV_HANDLE_CLOSING` 断言退出的问题；使用 `npx --yes --package=node@22.23.3 node node_modules/vinext/dist/cli.js build` 构建成功、退出码 0。未修改全局 Node 或项目依赖；本地复核可使用此项目支持的 Node 22 版本。

GitHub Actions 新增 `feigua-tests` 作业。原必需检查 `repository-checks` 仍只验证仓库规范，不代表应用功能、真实飞瓜采集或安装包通过。

## 尚未通过的验收与合并门槛

- 飞瓜真实登录、会话复用及失效后重新登录。
- 四个实际榜单的菜单、筛选选中标记及降序标记适配；当前规则只通过合成页面测试。
- 逐项核对真实榜单前 5 条、话题实际周日期及多关键词分组。
- 带货视频列表未显示播放数时的详情补充，以及多商品时佣金率的准确关联；当前会标记缺失，未实现未核验的详情接口。
- 现有完整回归的分类引擎缺失问题需补齐组件后验收；Node 24 的 Windows 构建退出异常尚未解决，当前已有 Node 22.23.3 构建通过记录。

上述事项完成前保持 Draft PR，不合并 main，不发布或部署。登录、接口健康和单元测试不视为四类真实采集成功。

## 本地复核与恢复

先按原项目方式安装依赖，再运行 `npm run test:feigua`、类型检查和构建。浏览器合成 DOM 测试通过开发服务器打开 `/tests/fixtures/feigua-page.html`；页面显示每个断言结果。交互测试桥接位于 `tests/fixtures/feigua-preview.mjs`，仅供开发者显式加载，生产入口不导入，刷新即可移除。

桌面预览使用 `AI_MEDIA_LIBRARY_PREVIEW_ALL_FEATURES=true` 和 `AI_MEDIA_LIBRARY_TEST_USER_DATA_PATH` 指向专用测试目录，避免使用正式用户数据。需要界面显示时不要使用隐藏启动模式。

回退应用代码不删除飞瓜会话或历史数据。飞瓜新文件独立于原媒体库与授权数据，不涉及现有数据库迁移或生产服务变更。测试日志、用户登录态及真实采集数据留在忽略目录，不提交到公开仓库。
