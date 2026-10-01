# AI 媒体库授权服务三方合并候选（部署审核点）

状态：**仅本地快照、合并、测试和提交；未部署、未重启、未改线上数据库或开关。**
本轮没有更新 AI 媒体库正式版本、更新清单、下载地址或安装包。现有
`1c1be02` 内部测试包沿用，客户端代码未变；本机合成 HTTP 联调通过，双机实测未完成。

## 基线与文件

线上只读获取时间：**2026-09-17 15:29:32 UTC**；获取后于
**2026-09-17 15:30:14 UTC** 再次核验相同哈希。服务当时为 `active`，
实际进程的 `AIML_IDENTITY_PHASE`、`AIML_CANONICAL_CREATE_ENABLED` 均未设置，
故分别按 `off`、`false` 处理。这只是本次读取快照，**实际部署前必须重查**。

| 内容 | 本地路径或线上依赖 | SHA-256 | 后续部署操作 |
| --- | --- | --- | --- |
| 最新线上原始快照，不得编辑 | `server/patches/license_server.online-20260917T152932Z.py` | `0cb447e5c13d3fec90d8046780a10ebbdcc1e8b104fbf1f7756b7135aeb1d4a9` | 仅作基线与回退参照 |
| 完整合并候选 | `server/patches/license_server.py.merged-candidate` | `98e0c1ea4fcd048434333d18cde061daed82a7ec8a16d23bc33ed5e19557496f` | 已加入设备冲突核验端点；审核后才可部署为 `license_server.py` |
| 完整差异 | `server/patches/license_server.online-20260917T152932Z-to-merged.diff` | `66822c9c46087941a42b57372c4628b7c45f42ec38af4c949683799c7ab6e6b7` | 相对同一线上快照重新生成；审核材料，不部署 |
| AI 媒体库新增模块 | `server/ai_media_canonical_activation.py` | `fc69d54119c94b22a87f0ff991f5099cb7e8d71e1b2848f352b57799bcbdfd9f` | 审核后先于主文件放置 |
| 4b 现有身份模块 | `server/ai_media_license_identity.py`，线上同哈希 | `553043f73a845af81387cb8878817a7b5680549641bd231eaef6ff7d11fd6519` | 保留，不替换 |
| 第 2 批现有错误日志模块 | 线上 `ai_media_license_error_log.py` | `e59fd0f2b0e7df3edfd57b63d79c147ca3d2d2d822cf9b5563e0d556dfaaed85` | 保留，不替换 |
| 共用基础模块 | 线上项目根目录 `license_core.py` | `6f59663bcd5be6ff16843e4f72544ad61b7e73b1672454bdf120483f03758cdb` | 保留，不替换 |
| 线上已有精细积分依赖 | 线上服务目录 `por_precise_credits.py` | `00f3782c26d775254c8d36b1587ed66eadeca830450dc6d043f76b70efd32dfb` | 保留，不替换 |

历史共同基线是 4b `a5af64f1737a735a29fd41ec70b1cba5233646a980c209429e10b731d998c5e2`；
我方旧完整候选是 `a6f318d55723b7e0b9e3fd9d32656d58a2c4c8fee787c9384536800038b9b4de`。
两者仍保留在 Git 历史及 `server/patches/license_server.py.candidate`，**均不得直接覆盖当前线上文件**。

## 三方合并与影响边界

以最新线上快照为底，移植 `a4d1e45` 的时间卡冲突处理与 `1c1be02` 的
AI 媒体库独立绑定支持。机械三方合并无冲突标记，随后人工逐 hunk 核对：

- 与共同基线相比，另一方在线上增加了精细积分模块导入、配置、三个处理函数及
  GET `/api/license/credits/precise/balance` 和 POST `/api/license/credits/precise/consume`
  的分发，共五处；这些代码在合并候选中**原样保留**。
- 与我方旧候选相比，新候选的差异也恰好只有上述五处线上代码，没有修改其他应用的
  积分计算、认证或分发顺序；`por_precise_credits.py` 模块本身未编辑。
- 我方新增的共享入口分支均按 `app_name='ai-media-library'` 限定。
  `init_db()` 会导入新增模块并创建独立的 `aiml_` 表，因此模块必须先部署；
  它不修改 `activations` 表结构或原索引。未设置 `AIML_CANONICAL_CREATE_ENABLED=true`
  时不会签发新 canonical，但已签发身份的兼容读取/恢复能力必须持续保留。
- 这次仅为保护共用服务中的既有行为而作对照测试，不是开发或发布另一款软件。

## 本地验证证据

- 合并候选、canonical 模块、4b 身份模块 `py_compile` 通过；使用与线上同哈希的
  `license_core.py`、`por_precise_credits.py` 和日志模块，在隔离环境导入通过。
- `python3 -m unittest discover -s server/tests -q`：**56 项通过**。包括开关关闭
  时新卡不消耗且不签发 canonical、开关关闭后已签发绑定仍可验证/恢复、失败路径
  前后完整数据库快照一致。
- `node --test` 的 canonical 客户端与真实本机 HTTP 联调：**8 项通过**；
  observe 和离线宽限等针对性检查合计 **31 项通过**。这些不是双机实测。
- `server/tests/isolation_acceptance.py`：4 个阶段 × 3 个对照 app 的原接口
  响应及既有表行数一致，身份模块故障注入时仍一致。
- `server/tests/merged_shared_route_acceptance.py`：使用线上**未改动**的精细积分模块
  与两份独立临时 SQLite，对照最新线上快照/合并候选的实际 HTTP 路由。
  合成卡激活成功；缺内部令牌 403、错误设备凭证 401；余额查询 200；错误定价
  409 且账本不变；成功消费 200、幂等重试 200 且无重复扣款、冲突重试 409 且
  账本不变。两边状态、业务响应和事务后的账本结果一致。没有读取真实账户或操作线上数据。
- 完整差异文件与重新生成的 `diff -u` 字节一致；本轮没有修改客户端，故已生成的
  `1c1be02` 内部安装包仍代表同一协议，但必须等服务端部署审核后再做真机验收。

## 经再次批准后才可执行的部署顺序

1. 重新只读检查线上 `license_server.py` **完整 SHA-256**、依赖哈希、服务状态及
   实际进程环境。只允许在哈希仍为上述 `0cb447e5…d4a9` 时使用本候选；任何变化
   先停下重新三方合并，不能强行套用快照。
2. 确认身份观测阶段仍为 `off`，canonical 创建开关未设置或为 `false`；
   不更新 AI 媒体库发布信息、自动更新清单、下载地址或安装包。
3. 将共用服务文件做独立备份并校验哈希；对共用 SQLite 使用 SQLite 在线备份 API
   生成一致性副本（包含 WAL 中已提交内容），限制备份权限，**不得直接复制活跃主库**。
   备份只作恢复保障，不因本应用回退直接覆盖共用数据库。
4. 暂存且核验两份**待部署**文件：合并主文件和 `ai_media_canonical_activation.py`。
   在隔离目录用与线上同哈希的依赖进行 `py_compile` 和导入测试；任何失败都不替换、不重启。
5. 先放置新增模块，再替换完整主文件；复核两份线上哈希后才重启一次服务。
   确认服务 `active`，再次读取**实际服务进程**的两个开关，而非 SSH shell 环境。
6. 用不改变客户绑定的请求验收原接口、AI 媒体库 `identity_phase=off`、第 2 批日志，
   并与部署前对照其他应用响应；检查 `activations` 结构和索引未改变、无新 canonical
   签发。连续观察至少五分钟，区分预期合成错误与非预期异常。
7. 若启动、哈希或原接口异常，先只读核对是否已有 canonical 映射。**没有签发记录**
   才可恢复本次备份的主文件并重启验证；已有记录时必须保持兼容服务能力、停止新建并
   报告，不可退回不认识 canonical 的旧代码。保留映射、授权数据、日志及备份。

以上是待审核步骤，**本轮一项也未在生产执行**。创建开关、observe/migrate/enforce、
正式发版及真实客户卡测试均不在本轮授权范围。
