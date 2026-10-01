# AI媒体库鉴权服务对接契约（客户端代码基线，2026-09-22）

本文件供共用鉴权服务及管理后台开发使用，**描述当前本地客户端实际发送和解析的内容**，不是已上线服务端协议的证明。服务端实际代码、数据库结构、管理后台写入链和部署版本尚未核验；不得拿 `server/patches/` 的历史快照确定字段存储位置或覆盖线上代码。本轮没有修改生产授权。应用标识固定为 `ai-media-library`，基础 URL 为 `https://license.dadaozixun.com/api/license`，旧 `license_protocol_version` 当前为数字 `2`；这些值见 `electron/license-config.mjs:1-7`。下文的双期限字段属于已接入客户端、**尚待真实服务端实现和联调**的适配契约。

## 1. 实际请求与解析

所有下列请求都经过 `LicenseService.request()`：`Accept: application/json`，有 JSON 请求体时发送 `Content-Type: application/json`，超时 12 秒，禁止重定向。**所有请求**还带 `X-AI-Media-Client-Version: <app.getVersion()>` 和 `X-AI-Media-License-Protocol: 2`，因此无请求体的状态 GET 也上报版本；带设备证明的请求另有 `Authorization: Bearer <device_session>` 和 `X-Device-Credential: <device_credential>`。后两者是凭证，示例不会给出真实值。版本字符串只是客户端自报，服务端不能只靠它证明旧包已被更新。代码：`electron/license-service.mjs:431-467`、`electron/main.mjs:510-535`。

| 操作 | 方法与相对路径 | 请求体（必填；可选） | 设备证明及响应消费 |
| --- | --- | --- | --- |
| 激活 | `POST /activate` | `app_name`、`activation_code`、`machine_code`、`client_version`、`license_protocol_version`；已有完整设备凭证时附带 `device_credential`，本地可用时附带 `activation_recovery_secret`，采集成功时可附带 `machine_identity_v3` | 已有完整证明时也带 Bearer 与 `X-Device-Credential`；成功响应须有完整 `device_session`、`device_credential`，客户端保存后立即查状态。见 `electron/license-service.mjs:527-646`。 |
| 设备状态 | `GET /device/status` | **无请求体、无查询参数**；版本与协议只在上述公共请求头 | 必带 Bearer 与 `X-Device-Credential`；这是联网权益确认的主要读取链，成功响应覆盖本地 B/V、标志及状态，忽略响应中意外出现的设备凭证轮换。见 `electron/license-service.mjs:775-890`。 |
| 会话刷新 | `POST /device/refresh` | `app_name`、`code_id`、`machine_code`、`client_version`、`license_protocol_version` | 带 `X-Device-Credential`，**不带 Bearer**；应返回新的 `device_session`，客户端保留原长期 `device_credential`，随后重新查状态。当前解析器也可能从旧记录回退得到非空 `device_session`，服务端不应依赖这一宽松行为。会话响应若不含权益版本字段，客户端暂时保留旧 B/V 但不能仅凭此视为新的联网权益确认。见 `electron/license-service.mjs:469-507`。 |
| 有效期内兑换／兼容续期 | `POST /time/renew` | 公共字段 `app_name`、`activation_code`、`request_id`、`confirm_renewal: true`、`client_version`、`license_protocol_version`。**新双期限分支另带** `redemption_protocol_version: 1`；旧过期续期分支不带该字段。 | 必带 Bearer 与 `X-Device-Credential`。新分支要求 HTTP 成功且 `action` **精确等于** `"time_renewed"`，随后用原设备凭证再次 `GET /device/status`；旧分支也要求 `time_renewed`，但会先按响应更新旧本地记录再查状态。见 `electron/license-service.mjs:649-773`。 |

这些路径都是实际客户端调用；不要把 `POST /time/renew` 误写成新的兑换路径。`license-activate`、`license-refresh`、`license-renew-time`、`license-redeem-time` 是本机 IPC 名称，不是云端 URL。新分支仅在已有有效在线基础授权且 `phase === "active"`、本地完整设备证明中的 `redemptionProtocolVersion >= 1` 时执行；界面按钮也检查最新状态的 `redemptionProtocolVersion >= 1`。离线不允许兑换。过期授权走 `renewTimeLicense()`：若缓存中的该标志仍为 0，仍走旧续期报文；若为 1，转入新双期限报文。见 `app/page.tsx:2012-2025,2179-2183`、`electron/license-service.mjs:649-773`。

### 响应字段及表示

解析器按顶层优先、再按 `data`、`result`、`license`、`device`、`credentials`、`credential` 容器至多三层查找；服务端建议始终用同一顶层结构，避免同名字段遮蔽。旧字段在 `electron/license-service.mjs:59-89,143-186`，新权益读取在 `electron/feature-registry.mjs:88-101`。

| 响应字段 | 类型／来源 | 当前客户端含义与要求 |
| --- | --- | --- |
| `code_id` | 旧字段，非空字符串 | 主授权身份；激活时保存，续期重试标识也包含它。状态或会话响应缺失时从原安全凭证继承。 |
| `device_session`、`device_credential` | 旧字段，非空字符串 | 激活须提供两者；会话刷新应返回 session，长期 credential 本机保留；状态 GET 不应试图轮换它们。 |
| `binding_status` | 旧字段，字符串 | `active` 是正常授权前提；`unbound`、`disabled`、`revoked`、`expired` 触发阻断。 |
| `license_type`、`duration_days`、`activated_at`、`expires_at` | 旧字段；字符串、天数数字、时间字符串、时间字符串或 `null` | 普通时间授权仍需非空类型、正数天数、激活和到期时间；积分／无限等旧类型不能混入。对于**有限期新协议**，服务端应同时返回旧 `expires_at` 与权威 `base_expires_at`，并让旧字段与当前 B 一致，以兼容旧校验和到期恢复链。永久免费基础授权仅在新协议明确 `base_permanent: true` 时支持，此时旧 `expires_at` 可为 `null`。`duration_days` 是码时长记录，不是 VIP 权益的独立时长字段。 |
| `remaining_days`、`transfer_count` | 旧字段，数字 | 展示／历史信息；不作为 VIP 判定条件。 |
| `machine_code`／`bound_machine_code`／`canonical_machine_code` | 旧设备身份字段，字符串 | 用于当前机器与服务端绑定一致性检查；不能用权益等级替代绑定验证。 |
| `license_status` 或 `status`、`is_disabled` 或 `disabled`、`is_expired` 或 `expired` | 旧状态字段，字符串、**布尔** | 禁用／撤销／整份授权过期将阻断所有功能。布尔只把 JSON `true` 当真；授权恢复时明确返回 `false`，避免沿用旧缓存里的 `true`。**VIP 单独到期不能把整份授权标为 `expired`，若 B 仍有效应保持基础授权 `active`。** |
| `action`、`message`、`error_code`（或 `code`） | 旧动作／错误字段，字符串 | 激活只接受空值、`activated`、`rebound`、`already_bound`、`legacy_primary_adopted`；兑换成功需 `time_renewed`。错误码和消息用于明确撤权、升级及展示。 |
| `entitlement_schema_version` | **新增**，数字 `>= 1` | 每次成功联网授权状态应明确返回；缺失／`null`／不可转数字按 0，回到旧授权解释且**不继承上次 VIP**。 |
| `base_expires_at` | **新增**，RFC 3339/ISO 8601 带时区字符串或永久时 `null` | B；新协议时它是基础有限期的权威到期时间，缺失／`null`／非法值不能靠旧 `expires_at` 回退授予基础权益（`base_permanent: true` 除外）。 |
| `vip_expires_at` | **新增**，带时区时间字符串或 `null` | V；缺失、显式 `null` 或非法时间均无有效 VIP；过去时间表示曾有 VIP、现已到期。显式 `null` 会覆盖旧缓存的 V。 |
| `base_permanent` | **新增**，严格布尔 `true`／`false` | 仅同时有 `entitlement_schema_version >= 1` 且值严格为 `true` 才把 B 视为永久；字符串 `"true"`、缺失、`null` 均不算。永久基础授权不会使 V 永久。 |
| `redemption_protocol_version` | **新增**，数字 `>= 1` | 服务端明确承诺可按双期限原子兑换的能力标志；缺失／`null`／非法值变为 0。有效期内按钮与执行层分别检查状态和安全凭证。**每次成功状态响应都应提供**，否则新状态解析会重置为 0。它不同于旧 `license_protocol_version: 2`。 |

时间建议一律传 `YYYY-MM-DDTHH:mm:ss.sssZ`（或等效明确偏移），以服务端 UTC 时钟为准；客户端用 `Date.parse()` 转为毫秒比较，`到期 <= 当前时刻` 即失效，`duration_days` 单位为天，离线 7 天按每 24 小时计算。当前解析器虽可能接受其他可解析格式，**没有显式时区的日期不应作为协议输出**。`base_expires_at` 非法不能解释为永久；`vip_expires_at` 非法不能授权 VIP。旧缓存无新权益版本只能按仍有效的旧基础 `expires_at` 使用免费功能。源码：`electron/feature-registry.mjs:88-101,118-123`、`electron/license-offline-grace.mjs:3-10,103-112`。

### 明确拒绝与网络失败

- 状态 GET 的 HTTP `426`，或响应 `error_code`／`code` 为 `client_upgrade_required`、`protocol_upgrade_required`：客户端进入 `update_required`，清除离线快照、保留设备证明及更新入口。激活和旧续期也识别；新兑换分支将升级信息作为错误提示。会话刷新后的状态链亦检查升级响应。**尚未核验服务端是否真的返回这些码，也未验证旧包升级门槛。**见 `electron/license-service.mjs:110-116,573-576,703-705,767-799,817-820`。
- 状态响应中的 `binding_status: unbound/disabled/revoked/expired`、`license_status: disabled/revoked/banned/expired`、布尔 `is_disabled: true`／`is_expired: true` 会明确阻断；401 配 `device_credential_revoked`、`device_credential_mismatch`、`device_binding_unbound` 会清除设备证明。其他 401 尝试一次会话刷新，409 阻断；明确拒绝先于 5xx 临时失败处理，不能被旧离线快照覆盖。见 `electron/license-service.mjs:13-17,172-205,801-860`。
- 真正的网络异常、超时，或没有明确拒绝语义的 408／425／429／5xx 状态 GET 才尝试原离线快照；没有合格快照则 `network_error`。联网失败**不会**更新最后成功确认时间。激活和兑换的网络异常不应解释成已成功消费码。见 `electron/license-service.mjs:431-459,296-359,789-860`。
- 现有边界：启动时只有长期 credential、缺少短期 session 时先刷新会话；该 `initialize()` 分支对会话刷新返回的升级响应尚未形成独立 `update_required` 状态，可能落到待激活。正式升级门槛联调必须包含这一场景，不应把所有旧版本路径宣称已验收。见 `electron/license-service.mjs:510-524`。

## 2. 脱敏合成响应示例

以下日期只是合成数据。第一份按**激活**响应展示，因此包含非真实的占位凭证；其余按**已保存设备凭证后的状态 GET**展示，状态响应无需再次传设备秘密。示例使用顶层字段；服务端仍须自行校验应用、设备、码状态与事务。为简洁起见，新协议状态响应共用旧基础字段 `code_id`、`binding_status`、`license_type`、`duration_days`、`activated_at`、`expires_at`，不能因表格中某个示例省略了动作字段就推断服务端数据库结构。

**历史有效基础码，旧协议激活：**

```json
{"ok":true,"action":"activated","code_id":"SYNTHETIC-BASE-001","device_session":"SYNTHETIC-SESSION-ONLY","device_credential":"SYNTHETIC-DEVICE-PROOF-ONLY","binding_status":"active","license_type":"yearly","duration_days":365,"activated_at":"2026-09-22T00:00:00Z","expires_at":"2027-09-22T00:00:00Z","remaining_days":365,"transfer_count":0,"is_expired":false,"is_disabled":false}
```

不带新权益版本：旧 `expires_at` 作为 B、免费有效、VIP 无效。激活后仍需下一次状态 GET 确认。

**有效 VIP，状态 GET：**

```json
{"ok":true,"code_id":"SYNTHETIC-BASE-001","binding_status":"active","license_type":"yearly","duration_days":365,"activated_at":"2026-09-22T00:00:00Z","expires_at":"2027-12-01T00:00:00Z","entitlement_schema_version":1,"base_expires_at":"2027-12-01T00:00:00Z","vip_expires_at":"2027-10-01T00:00:00Z","base_permanent":false,"redemption_protocol_version":1,"is_expired":false,"is_disabled":false}
```

**VIP 已到期但 B 仍有效，状态 GET：**

```json
{"ok":true,"code_id":"SYNTHETIC-BASE-001","binding_status":"active","license_status":"active","license_type":"yearly","duration_days":365,"activated_at":"2026-09-22T00:00:00Z","expires_at":"2027-12-01T00:00:00Z","entitlement_schema_version":1,"base_expires_at":"2027-12-01T00:00:00Z","vip_expires_at":"2026-09-01T00:00:00Z","base_permanent":false,"redemption_protocol_version":1,"is_expired":false,"is_disabled":false}
```

若从未有 VIP，改用 `"vip_expires_at": null`；不能把整个 `license_status` 改为 `expired`。

**永久 B＋有限期 VIP，状态 GET：**

```json
{"ok":true,"code_id":"SYNTHETIC-PERM-001","binding_status":"active","license_type":"permanent","duration_days":0,"activated_at":"2026-09-22T00:00:00Z","expires_at":null,"entitlement_schema_version":1,"base_expires_at":null,"base_permanent":true,"vip_expires_at":"2027-01-01T00:00:00Z","redemption_protocol_version":1,"is_expired":false,"is_disabled":false}
```

**整份授权被禁用，状态 GET（明确拒绝，即使 HTTP 200 也阻断）：**

```json
{"ok":false,"code_id":"SYNTHETIC-BASE-001","binding_status":"active","license_status":"disabled","is_disabled":true,"message":"此合成授权已禁用"}
```

**必须升级，HTTP 426：**

```json
{"ok":false,"error_code":"client_upgrade_required","message":"请安装支持权限分级的新版本后重试"}
```

**兑换成功及相同 `request_id` 的重试重放，均为 HTTP 200：**

```json
{"ok":true,"action":"time_renewed","message":"兑换已确认"}
```

第二次返回相同动作只表示**同一次交易的确认结果**，服务端不得再次增加 B 或 V；客户端收到任一次成功后都重新查状态。新分支并不依赖兑换响应携带 B/V。示例不能证明真实后台已经实现重复消费保护。

## 3. 兑换事务与状态同步

新分支把输入码 `trim()` 后，计算 `SHA-256(UTF8("aiml-time-redeem-v1") + 0x00 + UTF8(codeId) + 0x00 + UTF8(trimmedCode))`，输出十六进制 `request_id`；`0x00` 是 **NUL 字节**，不是反斜线和数字 0。相同主授权和相同码的重试得到同一 ID；**客户端不另行保存随机 ID**，码输入成功后清空，原主激活码和设备证明不因兑换替换。旧过期续期分支使用不同前缀 `aiml-time-renew-v1`。ID 不是凭证，服务端仍须独立验证设备证明和兑换码。精确拼接见 `electron/license-service.mjs:680-695,737-765`。

新分支只检查 HTTP 成功及 `action === "time_renewed"`，**不按响应里的到期字段本地增加时间，也不直接写权益缓存**；立即使用原凭证查 `/device/status`，该状态结果覆盖 B/V 并生成新的本地离线快照。若服务端已提交交易但响应丢失，客户端可能显示网络错误；用户以**同一码**重试时，服务端必须在同一授权身份和同一请求 ID 下返回已完成交易的相同成功动作及权威状态，不能再次延长、不能误报“码已使用”而不让客户端恢复确认。码的已用标记、权益更新、兑换记录及请求去重必须在服务端一致且原子完成；具体表和事务边界待线上基线核验。见 `electron/license-service.mjs:737-773,863-880`。

已确认业务计算仅供服务端实施：基础码 `B = max(旧B, 服务端当前时刻) + 码时长`，V 不变；VIP 码 `V = max(旧V, 服务端当前时刻) + 码时长`，`B = max(旧B, 新V)`，永久 B 仍永久。VIP 到期但原 B 有效时仍可使用基础功能，不是新赠送授权。原码保留其历史、绑定和设备限制；不要把时间类型与权益等级混为一字段。**客户端未实现这些服务端计算，四种组合与永久 B 的真实事务尚未联调。**

## 4. 本地离线协议与保护边界

成功联网确认后，**客户端** `recordOnlineValidation()` 从状态结果创建离线快照；`LicenseSecureStore` 用 Electron `safeStorage` 加密存储本地 credential、HMAC 密钥及快照。快照由客户端用本机密钥做 HMAC-SHA-256 完整性校验，同时绑定 `appName`、`codeId`、设备凭证摘要与机器码摘要；**不是服务器签发的授权签名**，不能作为服务端交易证明。快照的 `license` 部分保留 `bindingStatus`、`licenseType`、`durationDays`、`activatedAt`、旧 `expiresAt`、B、V、`basePermanent`、`entitlementSchemaVersion`、`remainingDays`、`transferCount`；不放原始 session、长期 credential 或机器码。还记录最后联网确认、最后见到的本地时间、宽限截止和展示天数。见 `electron/license-service.mjs:272-359`、`electron/license-offline-grace.mjs:12-25,94-180`、`electron/license-secure-store.mjs:18-113,199-226`。

离线基础授权受 `min(最后成功联网确认+7×24小时, B)` 限制（永久 B 不截短 7 天）；VIP 还须 V 有效，因此实际 VIP 截止为**宽限、B、V 中最早者**。网络失败只会在签名验证后推进 `lastSeenAt` 以防回拨，不改 `lastValidatedAt`，不能刷新宽限。旧快照无新版本/V 时绝不推断 VIP。明确禁用、撤销、解绑、失效或要求升级时清除旧快照／设备证明，随后不能用它覆盖联网拒绝。可被本机管理员篡改运行环境的客户端没有绝对防破解保证。见 `electron/feature-registry.mjs:93-101`、`electron/license-offline-grace.mjs:145-180`、`electron/license-service.mjs:796-860`。

## 5. 入口覆盖证据与未覆盖边界

`electron/main.mjs:2285-2287` 中 `registerProtectedHandle()` 将**实际声明的 82 个**业务 IPC 入口按同一注册表归属、执行前 `assertFeature()`；入口名按当前代码抽取核对如下（不是对整个应用所有 IPC 的概括）：

| 组／数量 | 实际受控 `ipcMain.handle` 名称 |
| --- | --- |
| `media`／13 | `choose-directory`, `media-choose-files`, `media-choose-folder`, `media-relink-folder`, `media-import-paths`, `media-import-classifier-output`, `media-import-classifier-segments`, `media-scan-folder`, `media-load-library`, `media-save-library`, `media-reveal-file`, `media-trash-folder`, `open-local-path` |
| `qianchuan-videos`／19 | `qianchuan-bootstrap`, `qianchuan-config-status`, `qianchuan-config-save`, `qianchuan-config-confirm-callback`, `qianchuan-config-test`, `qianchuan-open-developer-portal`, `qianchuan-oauth-start`, `qianchuan-oauth-reopen`, `qianchuan-oauth-poll`, `qianchuan-oauth-revoke`, `qianchuan-videos`, `qianchuan-resolve`, `qianchuan-preview`, `qianchuan-report`, `qianchuan-top`, `qianchuan-library-cache`, `qianchuan-library-sync`, `qianchuan-library-cancel`, `qianchuan-import` |
| `viral-visuals`／3 | `viral-library-import-csv`, `viral-library-authorize-write`, `viral-library-data-csv` |
| `viral-copy`／10 | `viral-copy-list`, `viral-copy-capabilities`, `viral-copy-parse`, `viral-copy-save`, `viral-copy-transcribe`, `viral-copy-save-reference`, `viral-copy-delete-segments`, `viral-copy-set-confirmed`, `viral-copy-link-visual`, `viral-copy-transcribe-media` |
| `downloads`／12 | `video-download-bootstrap`, `video-download-import-spreadsheet`, `video-download-enqueue`, `video-download-retry`, `video-download-cancel`, `video-download-pause`, `video-download-clear-completed`, `video-download-set-output`, `video-download-mark-imported`, `video-download-auth-bootstrap`, `video-download-auth-open`, `video-download-auth-refresh` |
| `schemes`／10 | `classifier-bootstrap`, `classifier-set-active`, `classifier-create-template`, `classifier-edit-template`, `classifier-generate-template-draft`, `classifier-import-product-info-files`, `classifier-import-product-info-paths`, `classifier-recognize-scanned-product-info`, `classifier-import-template`, `classifier-export-template` |
| `classifier`／7 | `classifier-preview-media`, `classifier-prepare-input`, `classifier-validate-output-directory`, `classifier-mark-output-synced`, `classifier-save-config`, `classifier-run`, `classifier-cancel` |
| `settings`／8 | `api-settings-get`, `api-settings-save`, `api-settings-test`, `open-product-guide`, `open-classifier-rules`, `storage-management-get`, `storage-management-save`, `storage-management-clear` |

明确例外，不应被误计作“82 个”：主窗口另有 **22 个直接注册的 IPC handle**。其中 14 个 `license-*`：`license-bootstrap`, `license-machine-code`, `license-machine-identity`, `license-identity-diagnostics`, `license-copy-identity-diagnostics`, `license-copy-machine-code`, `license-reveal-activation-code`, `license-copy-activation-code`, `license-save-activation-code`, `license-activate`, `license-renew-time`, `license-redeem-time`, `license-refresh`, `license-unbind`，用于激活、设备核验、续期与支持操作；查看／补录激活码在 `LicenseService` 内另有基础授权检查。另 8 个 `update-*`：`update-bootstrap`, `update-check`, `update-download`, `update-cancel-download`, `update-remind-later`, `update-install-now`, `update-install-on-quit`, `update-exit`，必须在过期／升级门槛下可用。它们不继承免费/VIP业务组，须按各自安全语义审查。还有一个 `ipcMain.on("media-start-drag")` 事件，不走上述 handle 包装，但在拖动前手动 `assertFeature("media")`；见 `electron/main.mjs:2518-2544`。独立的设备核验程序 `electron/device-diagnostic-main.mjs:75-94` 另有 `device-diagnostic:platform`、`device-diagnostic:submit` 两个 IPC，它不是主窗口业务模块，不能计入 82。

本地 HTTP：主窗口 `127.0.0.1:43822` 的 `/api/voices`、`/api/voices/*`、`/api/voice-clone/*`、`/outputs/voices/*`、`/uploads/voices/*` 按免费 `voice` 检查；`/__media/*` 按免费 `media`；`/__qianchuan_preview/*` 按免费 `qianchuan-videos`，失败返回 403。`GET /api/contact` 是公开的联系信息入口，静态页面和 JS 文件也不做授权拦截。见 `electron/main.mjs:3291-3369`、`electron/feature-registry.mjs:13-26`。

声音后端仍单独监听 `127.0.0.1:43824`（开发环境端口可配置），但当前源码已关闭原来的直连授权边界：Electron 启动声音服务时通过 `configureVoiceAuthorization` 注入实时的 `licenseService.assertFeature("voice")` 判断；声音后端在处理任何 API、输出、上传、静态或未知路径之前都会先执行该判断，未注入检查器时以 503 失败关闭，无有效基础授权时返回 403。专项测试覆盖有效免费授权、VIP 到期但基础授权有效、离线宽限、联网撤权、期限到达、供应商调用前拒绝及服务重启。见 `electron/main.mjs:405-417`、`electron/voice-backend/server.mjs:66-96,169-187`、`tests/voice-backend-authorization.test.mjs`。这证明当前源码的第二端口边界已修复；旧安装包不会自动获得该修复，正式发行前仍需核验目标安装包确实包含这些文件，并做一次不触发供应商计费的桌面端请求验证。

## 6. 本次测试证据、遗留与后续验收

本地执行 `node --test tests/*.test.mjs`：**355 项，355 通过，0 失败**；`npm run build`（vinext 静态构建）：**退出码 0，2 个路由预渲染**。这些都是本地模拟／单元／源码约束测试，不等于真实服务端数据库、真实激活码、管理后台或桌面发行包联调。测试中的第三个临时 VIP 功能只在 `tests/feature-registry.test.mjs` 内注册，验证组继承、子 IPC 执行前拒绝、降级和未注册拒绝；未进入正式功能清单。

`./node_modules/.bin/tsc --noEmit` 当前退出码 2，四处错误：`app/page.tsx:946` 的 `flatMap` 返回 `field`／`literal` 两种对象类型推断（TS2345）；`db/index.ts:1` 缺 `cloudflare:workers` 类型（TS2307）；`worker/index.ts:6` 缺 `Fetcher`（TS2304）；`worker/index.ts:7` 缺 `D1Database`（TS2552）。`git show HEAD:app/page.tsx:864-876` 可见相同分类命名表达式在本次权限改造前已存在；`db/index.ts`、`worker/index.ts` 本轮及当前工作区均未修改。这里只能证明错误所在代码／类型依赖并非本轮新增，**不能声称 tsc 已通过**。本轮只生成本交接文档，未修这些无关错误。

未完成的真实桌面验收：用合成授权／隔离测试服务验证四种免费/VIP码组合、永久 B、重复兑换／响应丢失／网络重试、禁用和降级同步、旧缓存与离线 7 天、旧安装包升级路径；核对两个 VIP 库的隐藏、直达执行与到期缓存清理；核对共享媒体原始文件和文案不删不迁。六个免费模块及 API 配置入口应**先跑不产生第三方费用的基础流程**；任何可能触发供应商计费的操作另行确认后再测。声音后端第二端口已通过本地 HTTP 专项测试，但目标安装包的真实桌面验证、会话刷新 426 的启动边界以及本地索引专属元数据写入仍未完成，不能写成发行包已验收。

服务端接手前须以已授权的只读方式确认**当前部署主文件版本、真实数据库结构、后台生成／编辑／续期写入链与共用应用隔离**，再决定 B/V 与码等级的存储、历史码免费兼容及事务迁移。先备份和验证回滚点，再做隔离环境联调；准备新客户端及更新路径后，最后才考虑正式启用旧版在线升级门槛。不得用本文件的合成字段示例代替线上基线，也不得将 VIP 权益移植到其他应用或改变其积分语义。
