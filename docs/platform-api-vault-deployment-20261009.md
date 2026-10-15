# 媒体库平台密钥与统一 API 域名接入

状态：2026-10-09 已经用户确认部署。三组供应商凭证已在服务器私密目录加密保存；媒体库独立入口已接到 api.dadaozixun.com。用户随后授权开启服务器消费开关，当前为 true；供应商生成任务和实际费用采集尚未接通，生成仍为 false。

## 已部署范围

- 英文应用标识：`ai-media-library`。
- 密文：`/var/lib/ai-media-library/platform-api.enc.json`，root:root 0600，目录 0700。
- 主密钥：`/etc/ai-media-library/platform-api.masterkey`，root:root 0600，目录 0700。
- 独立入口：`/opt/ai-media-library-platform/ai_media_platform.py`。
- 独立服务：`ai-media-library-platform.service`，仅监听 `127.0.0.1:8843`，文件系统只读沙箱。
- 独立路由：`/etc/nginx/snippets/ai-media-library-platform.conf`。
- API 域名配置仅新增该路由文件的一行 include；其他产品路径和服务保留。

密文使用 AES-256-GCM、随机 256 位主密钥、96 位 nonce、128 位认证标签，附加认证数据为 `ai-media-library:platform-api:v1`。包括阿里云、火山方舟、MiniMax 三组凭证。主密钥与密文分目录保存，不进入客户端、源码或安装包；供应商凭证只在服务器进程内解密。文件读取拒绝符号链接、硬链接、不安全权限和不匹配的应用标识。

## 域名接口

基础地址：`https://api.dadaozixun.com/api/ai-media-library/v1/`

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | health | 返回入口健康；生成未开放，消费状态实时读取中央结算服务 |
| POST | capabilities | 原设备凭证认证，仅返回供应商已配置/尚未验证的布尔状态 |
| POST | wallet/balance | 转发既有媒体库中央余额接口 |
| POST | wallet/transactions | 转发既有媒体库中央流水接口 |
| POST | wallet/redeem | 转发既有媒体库积分码兑换接口 |

POST 必须提交 `app_name=ai-media-library`，设备凭证也必须属于该应用。已有中央账本接口继续执行账户、字段、兑换码和幂等检查；新路由不增加第二个账本或第二次扣款。原 license.dadaozixun.com 积分路径仍有效，客户端本批无需改域名。

未知路径、内部结算和密钥文件路径一律 404，不落入其他软件代理。公网不能发码、冻结、提交扣款或释放积分。新入口关闭访问日志、丢弃传入内部结算凭证；应用不记录请求正文、设备凭证或密钥，也不返回供应商原始异常。

## 验证证据

- 服务器运行 14 项合成测试全部通过：加密往返、篡改拒绝、权限/链接拒绝、跨应用凭证拒绝、请求字段限制和无密钥响应。
- 14 项公网检查通过：健康、无凭证拒绝、错误应用拒绝、不允许的费用字段拒绝、内部/密钥路径拒绝及原积分入口保持有效。
- Electron 系统安全存储读取独立预览目录中的现有凭证，实际通过新入口查询配置状态、余额和流水；余额与原中央入口一致（当时为 0），无真实兑换。
- 三组密钥仅验证了加密结构与字段存在，没有验证供应商权限、余额、模型能力或实际单价；供应商请求数为 0。
- 核对原授权、产品经营报告、千川业务代理、既有媒体库积分服务 PID 均未改变；其他软件密钥配置、共享授权代码、其他域名配置哈希保持一致；无数据库结构迁移。
- 部署前备份：`/opt/ai-media-library-platform-backups/20261009T060939Z`。
- 本地回执：`server-integration/platform-20261009/deployment-receipt.json`、`live-verification.json`。

## 回退与剩余工作

回退只移除本应用 include 并停用 ai-media-library-platform.service；经 nginx -t 通过后 reload。保留私密配置以供恢复，勿恢复整份共享数据库或覆盖其他软件配置。部署失败脚本仅移除自己新增的 include，保留可能并发发生的其他软件路由变更。

尚需供应商任务代理、服务端预算控制与幂等、真实计费证据/价目版本、中央任务结算，以及客户端五个收费功能接入和发布验收，才可向无个人 API 的用户开放积分生成。MiniMax 试听/复刻分别计费的问题需在供应商调用链中核验，不能因下载试听就额外收取固定复刻费。

本批没有修改用户自己的 API 调用方式，没有发版或打包客户端。

## 后续授权开启消费开关（2026-10-09）

用户明确要求服务器消费开关先开启。已将媒体库积分服务的 AIML_POINTS_CONSUMPTION_ENABLED 从 0 改为 1；网关实时读取中央结算服务的健康状态，读取失败或应用不匹配时返回关闭。重启的仅为 ai-media-library-points.service 与 ai-media-library-platform.service。

18 项合成测试通过；公网两个健康接口均确认 consumption_enabled=true，generation_enabled=false；两个内部消费路径仍返回 404。实际设备凭证通过 capabilities 查询，余额和流水仍与原中央入口一致，未提交真实兑换或付费任务。用户自接 API 不扣软件积分的校验保留。

开关控制新任务能否进入内部预算冻结；扣款仍须内部凭证、媒体库设备认证、平台 API 来源、允许功能、实际费用数据和幂等校验。当前没有供应商任务代理自动调用这些内部端点，开启开关不会自动生成任务或扣款。

备份：/opt/ai-media-library-platform-backups/consumption-20261009T072500Z。回退时恢复该目录中的媒体库专用 unit 和网关模块，再重启这两个服务，不回退共享数据库。回执：consumption-switch-receipt.json、consumption-switch-live-verification.json。
