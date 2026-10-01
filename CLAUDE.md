# CLAUDE.md — AI媒体库 授权与机器码工作交接

本文件是给在本仓库工作的 AI 编码助手的常驻上下文。项目此前由另一个 AI 编码工具推进，
当前由 Claude Code 接手。**开始任何授权/机器码相关改动前，先读完本文件。**

---

## 一、硬性约束（不可违反）

这些约束优先于任何任务描述。若某个需求与它们冲突，先停下来向用户说明，不要自行变通。

1. **服务端改动严格限定 `app_name = 'ai-media-library'`。**
2. **这台授权服务器共用于 11 个 app、600+ 条绑定；任何改动不得影响其他 app。**
3. **共用文件 `license_server.py` 只允许一个改动点**（当前已用于第 2 批错误日志挂钩）。
   需要新增服务端行为时，优先放进独立文件，不要在共用文件里开第二处。
4. **不改全局常量、不改 `activations` 表结构、不改 `device_credential` 校验逻辑。**
5. **每批做完停下汇报，等用户确认再进行下一步。** 不要连做多批。
6. **涉及服务端部署时：先给 diff → 先备份 → 用户确认 → 才能部署。** 顺序不可颠倒。
7. 不得以硬件因子匹配替代或绕过现有 `device_credential` 校验。
8. 不上传、不记录任何原始硬件序列号；日志只保留脱敏字段。
9. 撞码问题的处置方式是客服后台手工解绑 + 用原激活码重新绑定；
   **不要求用户重新购买授权**，也**不得**通过改注册表 `MachineGuid` 或其他系统标识解决。

---

## 一之二、路径与副本纪律（不可违反）

### 唯一工作副本

```
/Users/a1-6/Documents/ChatGPT/媒体库/source/AI媒体库_完整项目源码_Mac打包_20260819
```

判定依据（三者必须同时成立，任一不符立即停下报告）：

- `pwd` 等于上述路径
- `package.json` 的 `name` = `ai-media-library`，`version` = `1.1.6`
- `git rev-parse --show-toplevel` 等于上述路径

**其他同名或相近目录一律视为历史副本：不读、不写、不作为判断依据。**
已知的近似目录（2026-09-17 核对）：

| 路径 | 实际内容 | 处置 |
| --- | --- | --- |
| `variants/AI媒体库_精简版_1.1.5_三端` | 真实副本，`ai-media-library` **1.1.5**（比工作副本旧一个版本） | **保留但禁止使用**：任何情况下不得作为代码参考或判断依据。看到的任何差异都应假定是版本落后所致，不得据此"修正"工作副本 |
| `source/_ARCHIVE_过时交接文档_勿用作参考_20260819` | 0.1.0 时期的 2 份交接文档，8KB，无 `package.json` | **历史存档，禁止参考**：所述架构（浏览器存储、无后端、无授权体系）与当前完全不同，目录内 `README.txt` 有逐项对照 |
| `AI媒体库_三端安装程序_0.1.1_20260822` | 无 `package.json` | 产物目录 |
| `AI媒体库_单机应急启动_不安装新版` | 无 `package.json` | 产物目录 |
| `交付_20260819`、`交付_单机启动内存修复_20260916` | 无 `package.json` | 交付目录 |

> 该存档目录原名是一段编码损坏的字节序列（GBK 亦无法解码），
> 显示上与真实工作副本几乎无法区分，极易误入。
> 2026-09-17 已改名为上表中的名称，文件内容未改动（改名前后 SHA-256 复验一致）。

### 父目录的 git 仓库：是 Codex 的检查点存储，不是空仓库

`/Users/a1-6/Documents/ChatGPT/媒体库/.git` **零提交，但绝不是空仓库**：

| 指标 | 实测（2026-09-17） |
| --- | --- |
| 提交数 | 0 |
| 暂存区 / stash / remote / reflog | 均空 |
| **`.git` 体积** | **4.0 GB** |
| **松散对象** | **19,090 个** |
| **refs** | **5 个 tree，全部在 `refs/codex/turn-diffs/checkpoints/` 下** |

那 5 个 ref 是**前一个 AI 编码工具 Codex 的 turn-diff 检查点**，
每个 tree 快照了整个 `媒体库/` 目录（`source`、`server-fixes`、`designs`、
`交付_20260819` 等）。对象时间跨度 2026-08-19 至 2026-09-17，
其中 09-16 有 4,238 个、09-17 有 13,404 个，即最近仍在写入。
同层还有 `.codex/` 与 `.codex-tmp/` 目录。

> **只跑 `git log` 会误判成空仓库。** 判断前必须看
> `git for-each-ref`、`du -sh .git` 和对象数，三者缺一不可。

因此：

- **不要删除这个 `.git`**——删掉等于丢弃 Codex 的全部检查点历史
- **已装 `pre-commit` 钩子作为物理保险**（`媒体库/.git/hooks/pre-commit`）：
  在该层执行 `git commit` 会被直接拒绝并打印指引。已实测生效。
  git 没有 `pre-add` / `pre-clean` / `pre-reset` 钩子，
  因此 `git add -A`、`git clean -fd`、`git reset --hard` **拦不住，只能靠纪律**
- 同层已放 `READ-ME-FIRST.txt`，说明该目录性质、4GB 检查点的来历与禁止操作
- **永远不要在 `媒体库/` 这一层执行 git 写操作**
  （`add` / `commit` / `checkout` / `clean` / `gc` / `reset`）。
  该层工作树覆盖 `server-fixes/`、`variants/`、各交付目录等数 GB 内容，
  一次 `git clean -fd` 即为灾难
- 本项目目录是独立仓库，提交不会落错；`媒体库/` 下其余子目录
  **均无自己的 `.git`**，全部落在该层工作树内

### 读取项目目录之外的文件

需要读取项目目录以外的任何文件（例如 `server-fixes/` 下的服务端候选文件）时：

1. **先输出完整绝对路径和 SHA-256 给用户确认**
2. 得到确认后才读
3. 不得因为"路径看起来对"就跳过这一步

### 不符即停

发现路径、版本、仓库根与预期不符时**立即停下报告**，不要自行推断、
不要"就近选一个看起来对的"、不要继续写入。

---

## 二、项目基本情况

- 包名 `ai-media-library`，版本见 `package.json`（当前 1.1.6），作者 梅小倩。
- 技术栈：Electron + Next(vinext) + React 19 + Tailwind 4 + drizzle；Node >= 22.13.0。
- 包管理器 pnpm 11.19.0。
- 测试：`npm test` 只跑 build + `tests/rendered-html.test.mjs`。
  **全量测试要用 `node --test tests/*.test.mjs`**（注意不能写成 `node --test tests/`，
  Node 会把它当模块解析并报错）。单跑某个文件用 `node --test tests/<file>`。
- Lint：`npm run lint` **目前会崩**（`RangeError: Invalid string length`）。
  原因是它只排除了 `dist` 和 `.next`，仍会走进 `.download-runtime/`、
  `bundled-downloaders/`、`release/` 里的 playwright / Python 产物，把 formatter 撑爆。
  改动前后请只对涉及的文件跑：`npx eslint <file>...`。
  已知既有问题：`app/page.tsx` 有 3 处 `react-hooks/set-state-in-effect` error，
  与近期改动无关，判断是否引入新问题时以这 3 条为基线。

### 授权相关代码位置

| 路径 | 作用 |
| --- | --- |
| `electron/license-service.mjs` | 授权主流程、激活、错误文案 |
| `electron/license-offline-grace.mjs` | 7 天离线宽限（第 1 批） |
| `electron/license-secure-store.mjs` | 设备凭证安全存储（Keychain / Credential Manager） |
| `electron/license-config.mjs` / `license-user-data.mjs` | 配置与本地用户数据 |
| `electron/machine-code.mjs` | **v2 机器码（线上现行路径，勿动）** |
| `electron/machine-identity/` | **4a 已接入后台采集与激活请求；独立 observe 调用已包含在 1.1.6 Windows 内部测试包，尚未正式发版。v2 仍是授权绑定依据** |
| `scripts/diagnose-windows-machine-identity.ps1` | Windows 身份诊断脚本 |
| `app/page.tsx` | 前端授权状态徽标、拦截页、toast 文案 |
| `electron/qianchuan-service.mjs` | 千川链路，复用设备凭证 |

### 必读文档

- `docs/known-issues.md` — 撞码事件、v3 暂缓上线原因与启用条件、畸形请求归属限制。
- `docs/license-copy-audit.md` — 18 条授权文案盘查表；本轮只改了第 2/3/5/7/9/10 条，
  其余 12 条**有明确的暂不修改理由**，不要在未确认的情况下顺手改掉。
- `mac-classifier-engine/SALVAGE/README.md` — 分类引擎字节码存档说明与安全边界。

---

## 三、已完成的工作（按批次）

1. **第 1 批：7 天离线宽限（客户端）** — 已提交，标签 `v0-baseline-offline-grace`（提交 `04e24b3`）。
2. **分类引擎字节码存档** — 提交 `bdcbd02`。原始 `.py` 源码已丢失，只剩 CPython 3.12 字节码；
   `SALVAGE/` 保存反汇编、接口地图、脱敏行为样本。**不声称恢复了源码**，升级 Python 次版本可能无法加载这些 `.pyc`。
3. **授权文案修正 6 条** — 提交 `5fbefc8`、`17047a6`。
4. **第 2 批：服务端错误日志** — **已部署上线**。
   - 新增 `/opt/original-video-dedup-tool/server/ai_media_license_error_log.py`
   - 第 2 批部署时 `license_server.py` SHA-256：
     `c92065fa2ca8fe91de85b1260ceb388e654d6689d5acbdcaa8d6fba35f22cc37`
     （这是 4b 部署前基线，不再是当前线上哈希）
   - 备份在 `/opt/original-video-dedup-tool/server/backups/`
   - 日志：目标应用写 `activation-errors.jsonl`；无法归属的解析失败写
     `/var/log/ai-media-license/unattributed-errors.jsonl`
   - 计划运行约 3 个月后，再根据实际撞码频次评估是否启用 v3。
5. **第 3 批：v3 采集模块** — 已提交（`9746147`、`d3efd58`）；采集器已由 4a 在后台接入，
   但 v3 不参与授权绑定。
   包含 macOS/Windows 采集器、归一化、哈希、诊断脚本、`tests/machine-identity-v3.test.mjs`。
   启用前必须保留策略开关、v2 降级路径和隔离性回归测试。
6. **声音克隆补丁** — 提交 `a4bc650`。属于下面的非授权改动线，不是授权批次。
   恢复失败复刻的记录留存（临时目录仍删除，但清空已失效的音频地址），
   并加入 `voices.json` 的一次性存量迁移（`schemaVersion` 标记，只跑一次）。
   配套 `tests/voice-store-migration.test.mjs`，实际加载后端模块验证迁移。
7. **第 4a 批：客户端基础接入** — 已完成（`4a7b8aa`）。后台采集、加密缓存与激活请求附带
   `machine_identity_v3` 已接入；active machine code、设备凭证与离线宽限仍沿用 v2。
8. **第 4b 批：服务端观测模块** — 已于 **2026-09-17 08:46:19 UTC** 重启部署并验收。
   实际进程的 `AIML_IDENTITY_PHASE` 未设置，模块按 **off** 运行，未切 observe/migrate/enforce。
   当时验收的线上 `license_server.py` SHA-256（**不是当前实时基线**）：
   `a5af64f1737a735a29fd41ec70b1cba5233646a980c209429e10b731d998c5e2`；
   `ai_media_license_identity.py` SHA-256：
   `553043f73a845af81387cb8878817a7b5680549641bd231eaef6ff7d11fd6519`。
   原文件备份：`/opt/original-video-dedup-tool/server/backups/ai-media-v3-4b-20260917T084450Z/license_server.py`
   （SHA-256 `c92065fa2ca8fe91de85b1260ceb388e654d6689d5acbdcaa8d6fba35f22cc37`）。
   合成请求验证了目标端点 off 响应、其他 app 的 404 与既有接口兼容，并观察服务至少 9 分钟；
   **未用真实客户激活码验证成功激活，也未证明 observe 数据已入库**。后续是否切阶段必须以服务器实测和另行批准为准。
9. **客户端 observe 调用（提交 `0f42a5b`）** — 独立异步 POST，需联网授权成功、凭证和采集齐备；
   每次启动最多实际发送一次，仅明确 `observe` 成功确认后按身份/授权记录去重 24 小时。
   `off`、失败、不确定响应不记确认，下一次启动可重试。确认摘要使用系统安全存储加密；
   激活失败的克隆机没有有效凭证，**不在自动上报覆盖范围**，可在激活页复制本地脱敏诊断。
   本批不启用 canonical 授权、不切服务端 phase、不正式发版。2026-09-17 已构建 Windows x64
   内部测试安装包；服务器仍为 off，测试机暂不可操作，实机授权与端点调用尚待验收。
   包哈希、24 小时观察边界、实机步骤及 observe 切换/回退条件见
   `docs/identity-observe-internal-test-20260917.md`。
10. **时间卡 v2 撞码冲突处理候选（`a4d1e45`）** — 本地修复仅把误入积分合并的分支改为
    目标 app 专用的结构化 409；凭证必须经过原 `_device_auth` 并关联命中的主授权。
    旧卡仍按原凭证校验，拒绝请求不消耗第二张卡。完整候选及后续 v3 独立绑定计划见
    `docs/ai-media-time-conflict-fix-and-v3-remaining.md`。**尚未部署、未实机验收；
    此提交本身未解决两台相同 v2 的设备各自独立激活。**
11. **同 v2 新设备独立激活本地候选** — 在 `a4d1e45` 上继续，仅本地实现与临时库/
    本机 HTTP 合成卡联调；旧 v2 绑定不迁移，老设备凭证认证后异步登记基线，
    新卡满足两项独立强因子冲突才由服务器签发 canonical。创建开关
    `AIML_CANONICAL_CREATE_ENABLED` 缺省关闭，与 `AIML_IDENTITY_PHASE` 分离。
    详情、部署顺序及不能简单回滚到 4b 的边界见
    `docs/ai-media-canonical-activation-local.md`。**未部署、未切线上开关、未打包，双机实测未完成。**
12. **共用授权文件的本地三方合并候选** — 2026-09-17 15:29:32 UTC 只读取得最新线上
    `license_server.py`，SHA-256 为 `0cb447e5c13d3fec90d8046780a10ebbdcc1e8b104fbf1f7756b7135aeb1d4a9`。
    该文件在 4b 后已有其他应用的精细积分接口，旧完整候选不可覆盖。以线上快照为底只
    移植本应用的 `a4d1e45` 与 `1c1be02` 改动，保留现有接口；合并候选、完整 diff、
    依赖哈希及待审核部署/回退方案见 `docs/ai-media-shared-license-merge-20260917.md`。
    **仅本地测试，未部署、未重启、未改线上数据库/开关或正式发布信息。**

### 与授权无关的改动线

这些不受授权批次约束，但共享同一套测试与构建流程：

| 提交 | 内容 |
| --- | --- |
| `17957c7` | 媒体库大库性能：`/__media/` 并发闸门（上限 12）、`DeferredAssetPreview` 懒加载、素材分页（每页 48） |
| `ddcb880` | 声音克隆降级为「仅试听」：删除 T2A 合成路径，`/api/voice-clone/generate` 返回 410，不再保留 MiniMax 音色 ID |
| `a4bc650` | 上述第 6 条 |

---

## 四、服务端访问

连接方式已在 4b 部署会话中核验；本仓库不保存服务器地址、私钥路径、口令或凭证。
需要再次操作线上环境时，必须重新核对目标、线上文件哈希与实际进程环境，
不能把本文件中的历史验收结果当作实时状态。

服务端路径：`/opt/original-video-dedup-tool/server/`
（`license_server.py` 为 11 个 app 共用，`ai_media_license_error_log.py` 为本项目独有。）

---

## 五、接手时的在途改动（已归档，2026-09-17 处理完毕）

接手时工作区有 5 个未提交文件，经用户确认为其本人的工作，已按两条独立产品线
拆分提交（拆分后逐字节校验与原始工作区一致）：

- `17957c7` **媒体库大库性能** — `electron/main.mjs` 并发闸门、
  `DeferredAssetPreview` 懒加载、素材分页
- `ddcb880` **声音克隆降级为仅试听** — `electron/voice-backend/server.mjs`
  删除 T2A 合成路径，前端改为下载试听
- `a4bc650` **后续修复** — 失败记录留存 + 存量数据迁移

第 2 批的文档补充（`docs/known-issues.md` 的「畸形激活请求的应用归属限制」）
已随 `dd01995` 提交。

**工作区现已干净。** 上面这些都是历史说明，不需要再处理。

### `scripts/license-diagnostic-app/` 空目录

创建于 2026-08-23，而本仓库的 git 初始化是 2026-09-16（提交 `04e24b3`）。
git 不跟踪空目录，所以它从未进过仓库，**查不到任何历史记录是正常的，不是丢失**。
全仓库无任何代码引用它。同理，`backups/`（2026-09-01）也早于 git 初始化且被
`.gitignore` 排除。

---

## 六、本地运行与预览

### 结论速查

| 想做什么 | 命令 | 终端数 |
| --- | --- | --- |
| 完整 Electron 桌面预览（沿用本机已有授权） | `npm run desktop` | **1 个** |
| 空白隔离数据目录测试（会要求单独激活） | `npm run desktop:isolated` | **1 个** |
| 只看网页界面（无 Electron 能力） | `npm run dev` | 1 个 |
| 全量测试 | `node --test tests/*.test.mjs` | 1 个 |

### 为什么 `npm run dev` 起不来 Electron 窗口

`npm run dev` 是 `vinext dev`，只启动 Vite 开发服务器（默认 3000 端口），
**它不会拉起 Electron，两者也没有任何连接**。

关键在于 Electron 主进程**不连 Vite 开发服务器**。`electron/main.mjs` 自己在
`127.0.0.1:43822` 起了一个 HTTP 服务，serve 的是 `dist/client` 目录，
也就是 `vinext build` 产出的静态文件（见 `electron/main.mjs` 的
`clientRoot = path.join(getAppRoot(), "dist", "client")` 与 `APP_URL`）。

所以正确命令是：

```bash
npm run desktop
```

它先构建 `dist/client`，再由 `scripts/launch-electron-preview.mjs` 启动 Electron，
明确使用本机正式版的授权及用户数据目录，避免反复要求输入激活码。
只有要测试全新安装状态时才运行 `npm run desktop:isolated`；该命令使用独立开发目录，
出现激活页是预期行为。不要为了预览复制、删除或重新输入正式授权凭证。
预览与正式版共用用户数据，测试删除、解绑、清空等操作前应确认影响范围。
**只需要一个终端，不需要同时开 `npm run dev`**；开了也不影响，Electron 不会用它。

### 改动后是否自动重载

**都不会自动重载，任何改动都要重新执行 `npm run desktop`。**

| 改了什么 | 行为 |
| --- | --- |
| `electron/main.mjs`（主进程） | 不重载。必须退出 Electron 重跑 |
| `electron/*.mjs`（其他主进程模块） | 同上 |
| `app/page.tsx`、`app/globals.css`（渲染层） | **也不重载**——渲染层读的是 `dist/client` 构建产物，不是源码 |

仓库里没有 `electron-reload` 一类的监听重载机制（`main.mjs` 中无任何
`fs.watch` / `chokidar`）。改渲染层想要热更新，只能用 `npm run dev` 在浏览器里看，
但那样拿不到 Electron 的 IPC、授权、本地文件与千川等能力。

### 开发期端口覆盖

未打包时可用环境变量改端口，避免与已安装的正式版抢占（打包后忽略，见
`runtimePreviewPort`）：

- `AI_MEDIA_LIBRARY_LOCAL_PORT` — 主界面，默认 `43822`
- `AI_MEDIA_LIBRARY_VOICE_PORT` — 声音后端，默认 `43824`

```bash
AI_MEDIA_LIBRARY_LOCAL_PORT=43922 AI_MEDIA_LIBRARY_VOICE_PORT=43924 npm run desktop
```

### 打包

`npm run desktop:pack`（macOS arm64 目录包）、`npm run desktop:dmg`（签名公证 DMG）、
`npm run desktop:win`（Windows NSIS）。这些会先跑
`scripts/verify-video-downloader-assets.mjs` 校验下载器资产。

---

## 七、工作方式

- **一次只做一批，做完停下汇报，等确认。**
- 服务端：diff → 备份 → 确认 → 部署，不得跳步。
- 客户端改动要配套单元测试，放在 `tests/` 并沿用现有 `node --test` 风格。
- 修改授权文案前先查 `docs/license-copy-audit.md`：该条是否已标注「暂不修改」及其理由。
- 文案原则：不把网络/本机问题说成「授权失效」；不暗示用户需要重新购买；
  明确「使用原激活码」；只描述本机设备状态，不推断用户购买的授权状态。
- 提交信息沿用现有前缀风格：`feat:` / `fix:` / `docs:` / `chore:`。
