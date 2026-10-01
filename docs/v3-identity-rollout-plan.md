# v3 多因子机器身份接入方案（第 4 批）

状态：4a 基础接入已完成；4b 已部署且实际 phase=off；独立 observe 客户端调用已在提交 `0f42a5b` 完成，有 Windows 内部测试包，未正式发版及实机验收
日期：2026-09-17

## 前提

- 第 3 批采集模块已完成（提交 `9746147`、`d3efd58`），4a 已把它接入客户端后台运行（`4a7b8aa`）
- 真机验证已完成：三台同镜像克隆机 v2 码相同、v3 码互不相同；
  BIOS UUID 与系统盘序列号在克隆机上均唯一有效
- 第 2 批服务端错误日志已上线；4b 服务端模块于 2026-09-17 08:46:19 UTC 部署，
  实际进程 `AIML_IDENTITY_PHASE` 未设置，因此仍为 `off`。部署文件、备份和验收边界见 `server/README.md`。
- 新端点客户端调用已在本地源码完成，有 Windows 内部测试包但未正式发版。`off` 响应不表示数据入库；只有服务器实测支持后，才可决定是否切 `observe`。内部包及实机验收边界见 `identity-observe-internal-test-20260917.md`。

## 硬性约束

1. 服务端改动严格限定 `app_name = 'ai-media-library'`
2. 共用文件 `license_server.py` 只允许一个改动点，且该改动点内任何异常
   必须被吞掉并降级到原路径
3. 不改全局常量、不改 `activations` 表结构、不改 `device_credential`
   校验逻辑、不改 `ops_admin_server.py`
4. **migrate 阶段不得放宽或绕过 `device_credential` 校验**——凭证缺失时，
   无论硬件因子匹配分多高，一律返回"需人工确认"，不写 v3 绑定、
   不改 v2 绑定、不签发或刷新凭证

---

## 零、接入前发现的三个结构性问题

方案形状由这三点决定。

### ① `bindingMismatch()` 是颗雷

`electron/license-service.mjs:270`：

```js
async bindingMismatch(body) {
  const remote = serverMachineCode(body);
  if (!remote) return false;
  return remote !== await this.machineCode();   // 任何不等 → 硬失败
}
```

服务端返回的 `machine_code` 只要与本地不一致即进入 `设备绑定信息异常`。
因此 **`canonical_machine_code` 绝不能复用 `machine_code` 字段**，
必须新开字段，且 `machine_code` 继续原样回显客户端送上来的值。

### ② 离线宽限授权与机器码绑死

`electron/license-offline-grace.mjs:106`：

```js
machineBinding: keyedDigest(key, "machine", machineCode)
```

一旦 active machine code 改为 v3，存量离线授权全部 `reason: "binding"` 失效，
等于"换硬盘 = 离线宽限没了"。这正是要避免的事故类型。

### ③ v3 码太脆，不能作身份主键

`hash.mjs:deriveV3MachineCode` 把强因子拼进单一 digest，任一强因子变动
整个 v3 码即变。因此匹配必须走**逐因子哈希比对**，v3 码只作候选标识与展示。

---

## 一、客户端

### 1. 后台异步采集

原则：**v2 路径保持关键路径唯一，一行不改。**

- 启动只 await 现有 `createStableMachineIdentity()`（v2）
- 新增 `electron/machine-identity/index.mjs`，转调已有的
  `startMacosFactorCollection` / `startWindowsFactorCollection`
  （二者已用 `setImmediate` 调度）
- 调用时机：`mainWindow.loadURL(APP_URL)` 之后，采集永不先于首屏
- 预算有界：macOS 总 8s / 单组 4s，Windows 同构
- **首次授权请求发出时若采集未完成，不带 v3 字段直接发，绝不等待**
- 结果落盘缓存，后台刷新条件：缓存超过 7 天或客户端版本变化

### 2. candidate_v3 的上报形态

```json
"machine_identity_v3": {
  "version": 3,
  "platform": "win32",
  "candidate_machine_code": "v3_…",
  "factors": {
    "machine_guid":       { "hash": "…32hex…" },
    "system_disk_serial": { "hash": null, "reason": "unavailable" }
  },
  "collection": { "duration_ms": 1840, "fallback_used": false, "timed_out": false },
  "low_confidence": false
}
```

**不上报 `factor_status[].weight`。** 采集器会把客户端权重表塞进
`factor_status`，序列化时整个剥掉——从线缆层面消除服务端采信客户端权重的
可能，直接满足约束 8。`reason` 只进日志，不参与计分。

采集未完成 / 零强因子 / 超时 → **整个字段省略**。

> `machine_identity_v3` 随激活请求发送；已激活设备通过独立的
> `POST /api/license/identity/observe` 后台上报，绝不改写 GET `/device/status`。
> observe 请求在网络边界再次白名单过滤，只送因子哈希、平台和候选码，
> 不发送 `reason`、采集来源、客户端权重或原始硬件值。

### 3. canonical_machine_code

| 阶段 | 用途 |
| --- | --- |
| observe | 不返回 |
| migrate | 未来阶段设想；本批客户端即使意外收到该值也一律忽略，不改变请求签名用的码 |
| enforce | 未来阶段设想；本批客户端即使意外收到该值也一律忽略 |

`bindingMismatch()` 只改一处，且是放宽：

```
remote === local_active || remote === stored_canonical  → 一致
其余 → 保持现有硬失败（fail-closed）
```

### 4. 两套缓存：并行，不合并

| 文件 | 绑定对象 | 本批改动 |
| --- | --- | --- |
| `license-offline-grant.v1.bin` | **v2 active code** | 不改，schema 仍为 1 |
| `license-machine-identity.v3-factors.bin` | 硬件因子 | 新增 |

身份缓存用**同一把** `readOrCreateOfflineHmacKey()` 密钥，但换域分隔符
`identity_v3`，两份签名无法互相重放。

**铁律：存在有效 v2 授权时，绝不用 v3 码重新派生离线授权的机器绑定。**
身份缓存 HMAC 校验失败 → 只丢弃 v3 块并重新采集，绝不波及授权。

### 5. 诊断面板（含调整一）

逐因子一行：因子名 · 是否采到 · 来源 · **哈希前 6 位** · 权重（标注"本地参考值"）。

**分数展示按阶段分级** —— enforce 之后精确分会成为攻击者的调参反馈，
可逐因子试探反推阈值与权重：

| 阶段 | 客户端可见 |
| --- | --- |
| observe / migrate | 详细分数（num/den、阈值、各因子命中情况） |
| **enforce** | **仅粗粒度状态**：`同机` / `需联网确认` / `判定为新设备`，**不返回任何数值** |

详细分数是否留存及可见范围须以实际服务端实现和阶段实测为准；
本批客户端不消费分数或 canonical 字段，不据此改动授权状态。

不显示任何原始硬件值。这是结构性保证：采集器返回值中没有原始值，
`acceptFactor` 之后原始字符串即出作用域。

### 6. 降级，且不得误判为换机

```
强因子数 ≥ 2         → 正常上报
强因子数 = 1         → 上报并标 low_confidence，服务端只许记日志，
                       不许建绑定、不许判"不同设备"
强因子数 = 0 / 超时  → 整个字段省略
```

**核心不对称原则：因子缺失只能降低信息量，永远不能降低信任度。**
判定表中不允许存在"因子少 → 新设备"的分支。只有**强因子同时存在且取值冲突**
才构成"不同设备"的正向证据——克隆机恰好是这个形态。

---

## 二、服务端

### 7. 表结构

全部 `aiml_` 前缀，全部带 `CHECK (app_name = 'ai-media-library')`，
把约束 1 变成数据库级保证。

```sql
aiml_machine_identity_device
  id, app_name, v2_machine_code, v3_machine_code,
  canonical_machine_code, activation_id,
  first_seen_at, last_seen_at, state
  -- state: observed | bound | needs_review | superseded
  UNIQUE(app_name, canonical_machine_code)
  INDEX(app_name, v2_machine_code) / (app_name, v3_machine_code) / (app_name, state)

aiml_machine_identity_factor
  device_id, factor_name, factor_hash, first_seen_at, last_seen_at
  PK(device_id, factor_name)
  INDEX(factor_name, factor_hash)

aiml_machine_identity_event
  id, app_name, at, event_type, v2_machine_code, v3_machine_code,
  match_score_num, match_score_den, decision, phase, detail_json
  INDEX(app_name, at)
```

`activation_id` 为**软引用，不建外键**。

### 8. 加权匹配

服务端**独立定义**权重表，不读客户端任何权重字段：

| win32 | 权重 | darwin | 权重 |
| --- | --- | --- | --- |
| machine_guid | 3 | io_platform_uuid | 3 |
| bios_uuid | 3 | io_platform_serial_number | 3 |
| system_disk_serial | 3 | hardware_model | 1 |
| baseboard_serial | 2 | physical_mac | 1 |
| cpu_processor_id | 1 | **合计** | **8** |
| physical_mac | 1 | | |
| **合计** | **13** | | |

### 9. 分母取法（防构造）

分母**不是**"客户端本次上报的因子权重和"，而是：

```
den = Σ weight(f)   f ∈ (该设备已存因子 ∪ 本次上报因子)
num = Σ weight(f)   f ∈ {两侧都存在 且 哈希相等}
```

藏掉曾见过的因子，它仍留在分母里贡献 0；凭空加因子也无法抬分。

两道**分数无法覆盖**的硬闸：

- **强因子闸**：至少 2 个强因子同时存在且匹配，才允许判"同一设备"
- **冲突闸**：任一强因子两侧都存在且不等 → 直接进"不同设备"候选

阈值：`≥0.75` 且过双闸 → bind；`0.45–0.75` → needs_review；`<0.45` → 不同设备。

### 10. 四阶段

| 阶段 | 行为 |
| --- | --- |
| `off` | 钩子立即返回，新表零读写，行为与今天逐字节一致 |
| `observe` | 计分、写三张表，**绝不改动任何响应**，不返回 canonical |
| `migrate` | 可返回 canonical；**仅在 device_credential 存在且有效时**才建 v3 绑定 |
| `enforce` | canonical 成为新激活的权威码；v2-only 客户端继续受理 |

切换：每请求读取服务进程环境变量 `AIML_IDENTITY_PHASE`，默认 `off`；
**读不到或值非法一律按 `off`**。

回滚：改回 `off` 即恢复原行为，新表为纯增量、无需数据迁移。
彻底回滚 = 从备份还原 `license_server.py` + phase `off`。

### 11. 约束 4 的硬短路

**凭证检查排在计分被使用之前**，该分支只有一个可达出口：

```python
def aiml_v3_decide(ctx):
    if ctx.phase is OFF:
        return NO_OP
    if ctx.phase is MIGRATE and not ctx.credential_verified:
        record_event(decision="needs_review", reason="credential_absent")
        return NEEDS_REVIEW          # ← 在 score 被读取之前返回
    ...
```

测试断言：

1. `test_migrate_without_credential_never_binds` —— 满分 1.0 + 全强因子匹配 +
   无凭证 → needs_review，且断言 v3 绑定表与 `activations` **行数前后不变**
2. `test_migrate_without_credential_issues_nothing` —— 响应体不含任何
   credential / session 字段
3. `test_migrate_without_credential_leaves_v2_intact` —— v2 绑定行前后逐字节相同
4. `test_no_score_can_bypass_credential_gate` —— **穷举**：score 0→1 ×
   因子组合全排列，凭证缺失时判定恒为 needs_review

第 4 条让"日后加一个按分数放行的分支"在测试层面不可能。

---

## 三、存量修复：三台克隆机

> **识别与授权都受凭证边界约束。** 本批只能自动观测已联网验证、持有效凭证的机器；
> 激活失败的两台克隆机不会自动形成服务端记录，也不会被自动恢复授权。

1. **observe**：本批只允许已成功联网验证且持有有效设备凭证的客户端自动上报。
   v2 撞码导致激活失败的 B/C **不在自动上报覆盖范围**，不能预期它们自动落表；
   只能手动复制本地脱敏因子诊断供客服对比，不得绕过凭证校验或自动授权。
2. **谁是原设备**：当前自动上报只涵盖持有有效 `device_credential` 且成功联网验证的机器。
   凭证是与现有激活绑定的证明；仅凭高硬件匹配分绝不能自动授权。
3. **B 和 C**：激活失败且无有效凭证，不会上报到 observe 端点，也不应假设服务端已有三行。
   用户可在激活页手动复制各因子哈希前缀；客服结合有效授权记录人工核对与解绑/重绑。
4. **未来迁移**：如经实际观测与单独批准启用 migrate/enforce，仍需独立设计和验收无凭证设备
   的人工确认流程；本批不会自动绑定、签发凭证或替换 v2 机器码。

---

## 四、共用文件改动点（第 13 点核实结论）

核实方式：读本地候选副本
`server-fixes/ai-media-license-error-log-20260916/candidate/license_server.py`，
SHA-256 实测 `c92065fa2ca8fe91de85b1260ceb388e654d6689d5acbdcaa8d6fba35f22cc37`，
与线上记录一致。文件 6314 行，`BaseHTTPRequestHandler` 裸实现，非 Flask。

### 结论：不存在两端点共同经过的调用点

| 端点 | 方法 | 位置 | 请求体 |
| --- | --- | --- | --- |
| `/api/license/activate` | **POST** | `do_POST` 第 6213 行 | `read_json(self)` |
| `/api/license/device/status` | **GET** | `do_GET` 第 6034 行 | **无请求体** |

两者分处 `do_GET` / `do_POST` 两条独立 if 链，无共同分发点。
更关键的是 `handle_device_status(headers)` **只接受 headers**，
客户端在该端点上根本无处放 `machine_identity_v3`。

`json_response()`（52 处调用）确实是唯一的全局公共缝，但它
**拿不到 app_name 和请求体**，且位于全部 11 个 app 的响应路径上——
技术上算"1 处"，实质违背约束 1、2 的意图。

### 方案决策（历史记录）

| 方案 | 改动点 | 说明 |
| --- | --- | --- |
| **A. 仅 `/activate`** | 1 | 插在第 6213 分支内。该分支已有第 2 批的同构先例（`except` 内按 app_name 守卫的错误日志）。代价：已激活设备不再走 activate，v3 数据只能从"激活时"采集，observe 期数据增长慢 |
| **B. 两端点各 1 处** | 2 | **违反约束 3**，需明确豁免 |
| **C. 挂 `json_response`** | 1 | 不推荐：无 app_name 与请求体，且横跨全部 11 个 app |
| **D. 新增独立端点** `POST /api/license/identity/observe` | 1 | 在 `do_POST` if 链加一个分支。与 activate / device-status 完全解耦，分支内第一件事即校验 app_name，对其他 app 结构性不可达；客户端后台单独调用，失败零影响。代价：多一次网络请求 |

已选 **D**，4b 服务端端点已部署、实际 phase=off；本批补齐客户端独立异步调用。

### 4a 可安全先行的依据

已核实当前线上服务端对请求体未知字段**不作拒绝**：
`handle_activation_payload` 全部通过 `data.get(...)` 读已知键，
全文无 `allowed_keys` / 未知键校验；`_uses_device_rebind_protocol`
只读 `license_protocol_version`。`read_json` 上限 65536 字节，
本字段约 500 字节。

因此**在 `/activate` 请求体附加 `machine_identity_v3` 对当前线上服务端完全无影响**，
会被静默忽略。这满足 4a"服务端尚未部署 v3 支持时客户端仍须正常工作"的要求。

`/device/status` 的通道待方案选定后再接。

---

## 五、分批与验证

| 批次 | 内容 | 验证 |
| --- | --- | --- |
| **4a** 客户端基础接入（已完成） | 后台采集、缓存、激活载荷与诊断；v2 仍是绑定依据 | 见 4a 提交 `4a7b8aa` |
| **4b** 服务端模块（已部署，off） | 独立模块 + 单一分发点；实际 phase=off | 合成端点、既有接口及其他 app 对照；真实 observe 入库尚未验收 |
| **本批** 客户端 observe 调用（Windows 内部包，未正式发版） | 成功联网验证与采集完成后异步上报；失败不影响授权 | 本地模拟服务已覆盖先后顺序、去重、安全和回退；Windows 实机待测，不切线上阶段 |
| **4c** migrate | observe 数据无误后 | 约束 4 四条断言；needs_review 路径；三台机人工绑定演练 |
| **4d** enforce | migrate 稳定后 | 全量回归 + 回滚演练 |

每批做完停下汇报等确认。**本批只做观测调用，不启用 canonical 授权或迁移。**

### 本批去重与失败重试

本地采集缓存、进程内的“最近实际尝试”和服务端有效确认是三种不同状态。
每次启动最多实际 POST 一次。仅 HTTP 200 且返回 `ok=true`、
`identity_phase=observe` 和有效观测判定时，保存加密的确认摘要与确认时间；
同一身份、同一授权记录的确认在 **24 小时**内跳过，到期重试。
`off`、404、超时、网络错误、畸形或不确定响应不写确认；下次启动仍可尝试。
离线宽限不是成功联网验证，不触发上报。激活失败的克隆机也不会自动上报。

### 隔离性验收（第 14 点）

对照 app：`OriginalVideoDedupTool`、`qianchuan-lapian-tool`、`DadaoMaterialClassifier`。

- 部署前后 `license_server.py` SHA-256 记录（动手前先核对仍为 `c92065fa…`）
- 每个对照 app 跑 activate + device/status 各一组合法/非法请求，
  断言 HTTP 状态、响应体**逐字节相同**、DB 行数相同
- 断言新表中 `app_name != 'ai-media-library'` 的行数恒为 0
- 钩子内埋 app_name 计数，断言对照 app 的请求**从未进入**钩子
- `ops_admin_server.py` SHA-256 不变
- **故障注入**：强制钩子内抛异常并打对照 app 请求，确认响应不变
  （对约束 2 的直接验证）
- 矩阵：4 个阶段 × 3 个对照 app 全跑
