# AI 媒体库身份观测：内部测试版与 phase=off 实机联调

状态快照：2026-09-17 10:24 UTC。本文件是交接记录，不是 observe 切换授权。服务器保持 `off`；未正式发版。

## 基线与内部安装包

- 唯一源码仓库：`source/AI媒体库_完整项目源码_Mac打包_20260819`；提交 `0f42a5b`，包名 `ai-media-library`，版本 `1.1.6`。
- Windows x64 内部 NSIS 包：`/Users/a1-6/Documents/ChatGPT/媒体库/internal-test-builds/1.1.6-0f42a5b-win-x64-20260917/AI媒体库-1.1.6-win-x64-安装程序.exe`，SHA-256 `8bf944d7ac0914fb4300ed127405dcd42f731bda5ca5a35de555f1bdcdef0b3f`，约 321 MiB。独立于正式 `release/`；未上传正式下载地址、未改自动更新配置。
- 安装包内的 `app.asar` 已核实包含 `electron/machine-identity/observe.mjs`，包内版本为 `1.1.6`。PE Security Directory 为零，**此内部测试包未签名**；仅限公司可信测试机使用，不能当作正式发布包。相同 appId 的安装可能替换该机现有安装，测试前保留正式安装包；不要删除用户数据或授权凭证。
- Windows 下载运行时检查通过，`vinext build` 与 NSIS 打包通过；授权/机器身份相关 Node 单测 117/117 通过。
- 本机 macOS arm64：以独立开发数据目录、隐藏窗口启动 Electron，预览端口返回 HTTP 200，退出后端口关闭。这只是本机启动烟测，**不是 macOS 安装包、Keychain 或有效授权实测**。

## 线上只读快照与 24 小时观察边界

- `license_server.py`：`a5af64f1737a735a29fd41ec70b1cba5233646a980c209429e10b731d998c5e2`。
- `ai_media_license_identity.py`：`553043f73a845af81387cb8878817a7b5680549641bd231eaef6ff7d11fd6519`。
- `ovdt-license.service` 自 2026-09-17 08:46:19 UTC 起为 `active/running`，检查时 `NRestarts=0`；实际进程未设置 `AIML_IDENTITY_PHASE`，因此默认 `off`。部署至 10:24 UTC 约 1 小时 38 分钟；warning 及以上的服务日志为 0 条。
- 第 2 批日志目录 0700、两个 JSONL 文件 0600；目标错误文件 4 行，未归属错误文件 1 行。本次未读取或输出任何凭证、激活码、硬件原值或完整机器码。
- 此前部署验收只连续观察了至少 9 分钟；**24 小时观察尚未完成**。最早到 2026-09-18 08:46:19 UTC 才具备满 24 小时的时间条件，届时还须重新检查运行状态、重启次数和异常日志，不能只看时间经过。

## phase=off 实机验收手册（当前全部待测）

公司 Windows 测试机暂不可操作。以下步骤必须在各自持有合法测试授权的设备上执行；不得复制或借用其他设备的 `device_session` / `device_credential`，也不使用真实客户激活码做改变绑定的测试。

### 已正常授权的 Windows 测试机

1. 安装前，在软件内记录当前版本、授权状态及完整 v2 机器码，**只在本机比较，不回传完整值**。确认该机的现有授权由其自身合法取得。用 PowerShell `Get-FileHash -Algorithm SHA256 <安装包路径>` 核对上面的包哈希，再安装内部包；若安全警告出现，先确认来源与哈希，不把警告当作签名验收通过。
2. 启动测试版，确认仍为已授权、主功能可用、v2 机器码逐字相同，不出现重新激活或绑定变更。硬件采集完成后，查看“授权诊断”仅显示因子是否成功与哈希前缀，不出现原始标识。
3. 记录启动时间。只读查看服务器该时间窗内该测试机对 `POST /api/license/identity/observe` 的访问记录；同时验证目标端点在实际服务进程 `off` 下响应 `identity_phase=off`。若没有可关联的访问及响应证据，**该项记为未验证**，不能用本地模拟测试代替。
4. 只检查本机 `%APPDATA%\ai-media-library\license\license-machine-identity.observe-confirmed.v1.bin` 的存在状态/修改时间，不读取内容。`off` 响应不应产生新的“已确认入库”记录；若测试前文件已存在，须比较前后状态并查明来源，不能盲删授权目录。
5. 只读比较测试前后 `aiml_machine_identity_*` 表是否存在及其目标 app 行数；`off` 请求应为零新增。退出并重启一次，确认仍成功联网验证，且再次有 observe POST 尝试；授权、v2 码及已有业务数据不变。

任一步出现授权被清除、机器码改变、原功能不可用、请求意外写入 v3 表或其他异常，应停止该机测试，保留脱敏时间点/状态与日志，不操作客户绑定。测试包不能作为已验收发版。

### 激活失败的克隆机

在不输入新的客户激活码、不解绑、不复制凭证的前提下，于激活页点击“复制脱敏诊断”，粘贴到本机文本编辑器检查仅有因子采集状态及 hash 前缀。两台机器只比较脱敏因子差异；六位前缀只用于初筛，不等同于完整身份校验。无有效设备凭证时不应自动调用 observe、不应自动恢复授权，也不得以硬件相似度绕过原有凭证校验。此类机器**不会自然形成线上三台观测记录**。

## 小范围 observe 验收准备（本轮不执行）

前置门槛：完成上面的 phase=off 实机验收及满 24 小时的服务观察；明确指定至少两台各自持有合法测试授权的设备。授权不足时跨设备入库验收存在缺口，不复制凭证。切换前再次核对线上哈希、服务健康、实际 phase、数据库及第 2 批日志，并做经核验的 DB/服务文件备份。

`AIML_IDENTITY_PHASE` 是**应用级**开关，不是服务端设备白名单。仅发放少量内部包不能保证只有这些设备受 observe 影响；任何已运行支持观测功能的 `ai-media-library` 客户端都可能写入。若不能接受此影响范围，就保持 `off`，另行设计经过批准的服务端设备级灰度。

经单独批准后的预定切换：在服务的专用 systemd drop-in 中设置 `Environment="AIML_IDENTITY_PHASE=observe"`，执行 `daemon-reload` 与一次服务重启；检查**新进程** `/proc/<PID>/environ` 为 `observe`、服务 active、线上哈希不变。先以一台合法授权测试机观察响应 `identity_phase=observe` 与目标 app 新表记录，再让第二台独立合法授权设备上报，核对记录分离、原 `activations` 绑定不变。相同设备在有效确认后 24 小时内重启应由客户端跳过重复 POST；身份变化后应重新上报，但真机变化须用受控、合法的硬件条件验证，不改注册表/系统标识，不能用模拟结果冒充实机。整个窗口监视服务健康、其他 app 既有接口与第 2 批日志。

回退阶段只把专用 drop-in 改为 `Environment="AIML_IDENTITY_PHASE=off"`，`daemon-reload` 并重启，验证新进程为 off；**不会删除已写入的观测表或事件**。如需代码回滚，4b 共用文件的已验证基线备份为 `/opt/original-video-dedup-tool/server/backups/ai-media-v3-4b-20260917T084450Z/license_server.py`，SHA-256 `c92065fa2ca8fe91de85b1260ceb388e654d6689d5acbdcaa8d6fba35f22cc37`；它保留第 2 批日志功能。代码回滚仍须单独核对当时线上基线、备份、语法和服务状态，不删除授权数据、观测记录或日志；本轮不执行。

未授权克隆机只走人工诊断与客服处置；本阶段不启用 `migrate` / `enforce`，也不改 active v2 机器码、设备凭证或原授权绑定。
