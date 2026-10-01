# AI 媒体库时间卡冲突修复与 v3 后续设计（未部署）

> 历史阶段记录：此文固定描述 `a4d1e45` 时“独立激活尚未实现”的状态。
> 后续本地候选实现、开关与回退边界见
> [ai-media-canonical-activation-local.md](ai-media-canonical-activation-local.md)；
> 该候选仍未部署，不能把本文件的旧待办当作当前代码事实。

本文件只描述 `app_name='ai-media-library'`。本批候选代码不改线上服务、不切换
`AIML_IDENTITY_PHASE`、不使 v3 成为授权绑定依据。线上 4b 已部署但 phase 仍为 off。

## 本批实际修复

- `server/patches/license_server.py.candidate`：在已存在的 `app_name + v2 machine_code`
  主授权命中且新旧 code_id 不同时，先识别目标应用的时间卡；不再把该情形作为积分合并。
  现有 `_device_auth` 验证设备会话、设备凭证、绑定状态、角色、机器码、凭证版本，
  然后再与命中的主授权逐项核对 `app_name`、`code_id`、绑定机器码、状态、角色、凭证版本和凭证散列。
  请求体若另带 `device_credential`，也必须与主授权凭证散列一致。
  不通过时返回 HTTP 409 `error_code=machine_identity_conflict`、
  `action=manual_identity_review`；通过时返回 HTTP 409
  `error_code=existing_time_license`、`action=renewal_requires_confirmation`。
  两者均在写入前拒绝，绝不消耗第二张卡；其他 app 保持旧逻辑、旧 HTTP 400 与旧正文。
- `electron/license-service.mjs`：仅当本地安全存储已有完整设备会话与凭证时，
  在激活请求附上既有认证头及对应设备凭证。无凭证的新机不发送。
  v2 active machine_code、已有状态校验、解绑、离线宽限及授权保存逻辑不变。
  客户端目前**没有**独立的时间卡续期界面，不显示虚假的可用续期入口。
- `server/tests/test_ai_media_time_conflict.py` 和 `tests/license-service.test.mjs`：
  覆盖克隆机、同机第二卡、已绑定卡换机、缺凭证、旧卡有效凭证、错误/跨应用/
  跨主授权凭证、请求脱敏与其他 app 隔离。拒绝路径比较临时数据库所有表的每一行全部字段，
  不是仅比较记录数量。

这批只修复误导性的“积分合并/续期”判断。**两台相同 v2 的设备各自独立激活仍未实现。**
已有凭证若连同操作系统镜像被完整复制，当前机制仍可能把克隆机视作原设备；
不能把本批修复或 v3 哈希收集称为防克隆认证。

## 真正解决 v2 撞码：下一批的接口与存储方案，不在本批实施

1. **首次激活前的身份预检。** 客户端在 `/activate` 提交前等待本次后台 v3
   采集完成（总超时上限仍为 8 秒），把已有的 v2 active code、v3 候选与因子哈希带入
   同一次激活请求；缺少足够可信因子时走人工核对，不自行替换 v2。
   服务端在旧 `target_primary` 的 v2 查询和任何写入之前，先验证未使用时间卡归属与状态，
   并对 `ai-media-library` 调用独立身份决策模块。当前 `/identity/observe` 只接受成功授权
   后的观测，不能充当新机首次激活预检。此流程需要新的 target-only 激活分发，
   不能仅把 phase 改成 `enforce`。
2. **旧卡与新卡分开判定。** 输入已绑定的原卡而缺少原设备凭证时，
   不论 v3 相似度多高都不得迁移或接管，返回人工确认。输入一张合法、未使用的新时间卡时，
   即使 v2 与旧机相同，也可以在新设备完成身份预检和新设备密钥挑战后建立**独立**绑定，
   不动旧机的 code_id、凭证、激活时间和到期时间。强因子不足、冲突不明确或设备证明失败时
   不自动绑定；不能仅凭客户端自报的候选码判断为另一台机器。
3. **唯一约束与独立命名空间。** 现有 `idx_activations_one_primary` 唯一索引覆盖
   `(app_name, bound_machine_code)` 的 active primary。两个相同 v2 无法同时以 v2 写入此列。
   保留旧用户的 v2 行不变；为经过验证的新绑定分配服务端生成的不透明 canonical 码，
   写入新卡的 `bound_machine_code`，并在独立 `aiml_*` 表中按
   `(app_name, code_id, canonical, v2, 因子哈希, 设备公钥, 状态)` 建立关联。
   旧用户迁移必须持有旧会话+凭证，迁移原 code_id 时原子地更新绑定与会话版本，
   不重置期限。所有新查询强制限定 `app_name='ai-media-library'`；其他 app 的行和流程不变。
4. **canonical 不能直接信任客户端。** 当前 `ai_media_license_identity.py` 的
   `_internal_canonical()` 在有 candidate 时直接采用 candidate；这只适合观测，**不能**
   直接用于授权写入。下一批须由服务端生成、签发和持久化 canonical；先校验因子形状与
   服务器权重规则，再通过一次性挑战验证新设备密钥的持有权，限制重放和并发双绑。
   因子哈希仍是客户端自报，纯软件方案不具备硬件远程证明；对于高风险或缺少旧机基线的
   案例须保留人工复核，不能宣称绝对防伪。
5. **全授权路径一致。** 对目标 app，激活、GET device/status、凭证刷新、解绑、
   时间卡续期及本地离线宽限必须统一使用服务端已签发且安全保存的有效绑定码；
   旧 v2 用户继续走 v2。客户端的绑定比较目前只接受 v2 和少量已记录 canonical，
   离线授权缓存绑定 v2；这些都需要专门迁移测试。原设备凭证是旧绑定迁移的前置条件，
   v3 因子匹配只能作为附加条件，不能替代。
6. **回滚不是单纯 phase=off。** 开始产生 canonical 绑定后，切回 off 只能阻止新增
   v3 写入；已签发的 canonical 设备仍必须能状态验证、解绑、续期和使用离线宽限。
   保留一个只读兼容层和独立映射；停写、回滚代码、数据恢复分别制定步骤。
   由于两个独立绑定不能同时写回同一个 v2 唯一键，不能靠恢复旧文件或把 phase 设 off
   来“还原”全部绑定。发布门禁必须包含 off 后双设备继续可用的测试。

### 下一批至少要改的文件/接口

- 客户端：`electron/license-service.mjs`、`electron/machine-code.mjs`、
  `electron/machine-identity/service.mjs`、`electron/license-offline-grace.mjs`、
  对应安全存储及 UI/IPC。首次激活需取得采集结果；服务端确认前不能把 candidate 当 active。
- 服务端：独立的 `server/ai_media_license_identity.py` 扩展预检、挑战、canonical
  发放与映射；共用 `license_server.py` 仅增加目标 app 分发及为已签发 canonical
  保留的兼容读取路径；不改其他 app 的设备凭证校验语义。
- 接口：目标 app 的 `/api/license/activate` 增加可选 `machine_identity_v3` 与
  新设备证明；必要时新增目标 app 专用挑战端点。成功响应明确返回服务器签发的
  `binding_machine_code`、旧 `v2_machine_code` 和绑定版本；错误响应保留明确的
  `manual_identity_review` / `existing_time_license`，不泄露原始硬件值。
- 测试：五台同镜像机的 v2 相同/v3 因子不同、旧卡无凭证拒绝、新卡独立绑定、
  同机重启、误报/缺因子/伪造 candidate/重放/并发、三端升级及卸载重装、旧版客户端兼容、
  离线宽限与原到期时间不变、解绑/续期、切回 off 后已签发 canonical 继续可用、
  其他 app 请求和数据库内容逐项一致。

## 本批部署候选边界

完整服务端候选文件就是 `server/patches/license_server.py.candidate`；
线上仍是 4b 旧文件，部署前必须重新核对哈希、备份、在暂存目录编译并以合成授权测试。
客户端改动尚无新安装包；仅替换服务端会让旧客户端得到更明确的 409，
但旧客户端不携带原设备认证头，无法进入“已有时间授权”分支。
本批提交、测试通过都不构成线上部署或实机验收。

候选哈希（本批提交时核对）：

| 用途 | SHA-256 |
| --- | --- |
| 4b 线上基线 `license_server.py` | `a5af64f1737a735a29fd41ec70b1cba5233646a980c209429e10b731d998c5e2` |
| 本批完整候选 `license_server.py.candidate` | `bb840bd1a61fc884b6eb01f126c17434c51590615a95b9a4c0646fb3c5586342` |
| 本批客户端 `electron/license-service.mjs` | `53bf0550738d7b49b63bab234fc3af540bea337d80657225f28abe6f2266ea2d` |

获批部署时应先重新核对线上基线及实际进程环境；不一致立即停止。
备份线上原文件并校验备份哈希，再暂存完整候选、校验 SHA-256、
`py_compile`、替换、重启并检查服务与实际 phase，最后用合成码验证
409 两类分支、旧卡/凭证、非目标 app 对照和日志。任何现有授权路径异常时，
用备份恢复 4b 文件并再次验证；不删除数据库、错误日志或备份。
