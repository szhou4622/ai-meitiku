# 服务端模块（app_name = ai-media-library）

本目录保存本项目独有的服务端代码与对共用文件的补丁。
**4b 已于 2026-09-17 08:46:19 UTC 部署，实际 phase=off；客户端调用已有内部测试包，未正式发版。**
后续时间卡冲突修复已形成新的本地候选，但**尚未部署**；范围和后续 v3 设计见
[`docs/ai-media-time-conflict-fix-and-v3-remaining.md`](../docs/ai-media-time-conflict-fix-and-v3-remaining.md)。
独立激活的本地候选见
[`docs/ai-media-canonical-activation-local.md`](../docs/ai-media-canonical-activation-local.md)；
**同样未部署。** 线上共用主文件在 4b 之后已有其他应用的改动，旧完整候选不能直接覆盖。
以最新线上快照为底的合并候选、完整 diff、依赖哈希和待审核部署步骤见
[`docs/ai-media-shared-license-merge-20260917.md`](../docs/ai-media-shared-license-merge-20260917.md)。

## 内容

| 路径 | 说明 |
| --- | --- |
| `ai_media_license_identity.py` | v3 机器身份观测模块，本项目独有，部署到 `/opt/original-video-dedup-tool/server/` |
| `ai_media_canonical_activation.py` | 新机独立绑定、老设备基线及安全恢复；**本地候选，未部署** |
| `ai_media_device_diagnostic.py` | 一次性核验码、哈希报告、管理员复核及单次批准消费；**本地候选，未部署** |
| `patches/license_server-identity-observe.diff` | 4b 历史补丁（当时的唯一改动点，1 个 hunk，+48/-0） |
| `patches/license_server.py.candidate` | 4b 基础上保留 `a4d1e45` 时间卡冲突修复并加入独立激活的完整**未部署**候选文件 |
| `patches/license_server.online-20260917T152932Z.py` | 最新线上共用主文件只读快照；**不可编辑** |
| `patches/license_server.py.merged-candidate` | 以最新线上文件为底，仅加入本应用改动的完整**未部署**候选 |
| `patches/license_server.online-20260917T152932Z-to-merged.diff` | 相对最新线上快照的完整差异 |
| `tests/test_ai_media_canonical_activation.py` | 临时数据库与合成卡的独立绑定/回退测试 |
| `tests/test_ai_media_device_diagnostic.py` | 核验码、脱敏持久化、审批和单次消费测试 |
| `tests/local_canonical_http_server.py` | 本机客户端＋服务端 HTTP 联调夹具；仅供测试 |
| `tests/test_identity_observe.py` | 单元测试（25 条） |
| `tests/isolation_acceptance.py` | 隔离性验收：真实启动 before/after 两个服务端逐字节比对 |
| `tests/endpoint_e2e.py` | 端点验收：验证归属判定失败时返回 404 而非 200 |

## 哈希

| 文件 | SHA-256 |
| --- | --- |
| `license_server.py` 4b 部署前基线/备份 | `c92065fa2ca8fe91de85b1260ceb388e654d6689d5acbdcaa8d6fba35f22cc37` |
| 4b 部署后线上 `license_server.py`（验收快照） | `a5af64f1737a735a29fd41ec70b1cba5233646a980c209429e10b731d998c5e2` |
| `a4d1e45` 历史未部署候选 `license_server.py.candidate` | `bb840bd1a61fc884b6eb01f126c17434c51590615a95b9a4c0646fb3c5586342` |
| `ai_media_license_identity.py` / 4b 部署后线上文件 | `553043f73a845af81387cb8878817a7b5680549641bd231eaef6ff7d11fd6519` |

以上为 **4b 历史**验收快照，不得当作未来的线上实时哈希。更新后的线上快照哈希
`0cb447e5…d4a9` 与本地合并候选 `9a4f9989…1792` 见上述新文档。备份路径：
`/opt/original-video-dedup-tool/server/backups/ai-media-v3-4b-20260917T084450Z/license_server.py`。
未来任何线上操作都须重新只读核对实际文件与进程环境。
当前新增候选的完整哈希在本地交付时另行计算，不得把上表的历史候选哈希用于部署。

## 运行测试

```bash
python3 -m unittest discover -s server/tests -v
```

隔离性验收需要 before/after 两份完整服务端目录（含 `license_core.py` 与
`ai_media_license_error_log.py`）：

```bash
python3 server/tests/isolation_acceptance.py <before_dir> <after_dir>
```

## 阶段开关

环境变量 `AIML_IDENTITY_PHASE`，取值 `off` / `observe` / `migrate` / `enforce`。
**读不到或值非法一律按 `off`**；这里只控制 4b 身份观测，
不控制本批时间卡冲突处理。不能把 `off` 理解为恢复所有后续业务改动。

新增独立激活的**另一个**开关是 `AIML_CANONICAL_CREATE_ENABLED=true`，缺省关闭。
关闭它只能停止新 canonical 的签发，不能停止已签发绑定的验证、恢复、解绑或续期。
设备核验报告即使已经由管理员批准，也仍受该开关约束；开关关闭时不会签发新的
canonical，且批准不会被消费。

仅对已部署 4b 观测而言，回到 `off` 可停止观测且不涉及授权绑定迁移；
将来若实际签发 canonical 身份，不能假定设回 `off` 就能恢复全部绑定行为。
4b 观测模块的历史彻底回滚 = 用部署前备份还原 `license_server.py` + 删除本模块；
本批冲突修复若获批部署，应单独备份，并回滚到**部署时实际的线上基线**；
不能把历史 4b 哈希当成当前基线，也不能删除其他应用随后加入的接口。

## 端点的两段式错误处理

分支以"是否已确认归属"为界分成两段：

| 阶段 | 失败时 | 原因 |
| --- | --- | --- |
| 归属判定（`read_json` + `app_name`） | **404** | 对一个本不属于该应用的路径返回 200，等于确认了该路径存在。归属不明同样按 404 |
| 已确认归属之后 | **200 空响应** | 确认是本应用后，任何内部异常都不应影响本应用自身的请求 |

`app_name` 用字面量比较，**不依赖新模块是否可导入**：即使模块缺失或损坏，
其他应用拿到的仍是干净的 404（已由 `endpoint_e2e.py` 覆盖）。

归属判定必须读请求体（`app_name` 只存在于正文中），`read_json` 自带
65536 字节上限，正文过大会抛异常并落入 404，因此读取量是有界的。

## 部署顺序

**先服务端、后客户端、最后切阶段**，三者不得合并：

1. 4b 服务端已部署。实际服务进程未设置 `AIML_IDENTITY_PHASE`，默认 `off`；
   部署后已连续观察至少 9 分钟，**并非 24 小时验证**。
2. 客户端独立 observe 调用已包含在 1.1.6 Windows 内部测试包；未正式发版，不修改服务端或切阶段。实机联调见 `../docs/identity-observe-internal-test-20260917.md`
3. 确认无误后才把 phase 切到 `observe`

理由：客户端接入与服务端部署是两个变量，同时上线出问题分不清来源。

## 历史部署流程（已执行，不要照此重复部署）

1. 当时先核对线上 `license_server.py` 为部署前基线 `c92065fa…`
2. 备份原文件到上文列出的备份路径并校验哈希
3. 暂存并校验 `ai_media_license_identity.py` 与候选 `license_server.py`
4. 编译通过后替换、复核哈希并重启服务
5. 核实实际进程 phase 为 `off`，再做合成请求对照与观察

### 回滚条件

以下任一成立立即回滚：

- 线上哈希与预期不符
- `py_compile` 失败
- 服务未起
- 观察期出现异常
- 其他 app 激活失败

**logrotate 等收尾步骤失败不回滚。**

### 部署后验证

- 目标 app 请求 `/api/license/identity/observe` 返回 200
- 其他 app 请求该端点返回 404
- 其他 app 的合成错误请求与部署前对照一致；未使用真实客户激活码验证成功激活

## 验收边界与未完成

- 4b 已部署并保持 `off`。合成目标请求得到 HTTP 200、`identity_phase=off`；
  其他 app 的新端点请求得到 404，既有接口的合成错误响应对照一致；
  第 2 批日志模块哈希未变且预期测试错误落盘，服务观察期无非预期异常。
- 未用真实客户激活码执行成功激活；未验证 `observe` 阶段真实数据入库。
- `/api/license/device/status` 是 GET 且无请求体，无法承载 v3 载荷；
  当前只有新端点 `POST /api/license/identity/observe` 这一条通道
- 客户端本地源码现已异步调用新端点，并有未发布的 Windows 内部测试包；尚未经 Windows 实机验收。只有成功联网验证且持有凭证的机器才会自动上报；
  激活失败的克隆机只能复制本地脱敏诊断供客服核对，不能绕过凭证校验。
