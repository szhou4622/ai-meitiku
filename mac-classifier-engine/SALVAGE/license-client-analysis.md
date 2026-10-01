# `license_client.pyc` 详细行为分析

## 结论

`xiaoguan_classifier.license_client` 是历史分类工作台的独立授权客户端，不是当前 Electron 的 `ai-media-library` 授权实现。

- 它使用独立 `app_name = DadaoMaterialClassifier`、独立机器码格式和独立本地状态文件。
- 它不使用 Electron 的 `v2_<64 hex>` 机器码，也没有 `device_session` / `device_credential` / `license_protocol_version=2`。
- `app.pyc` 的传统 GUI 入口会动态导入并调用 `ensure_activated()`；Electron 调用的 `engine_entry.py` 分类入口没有导入或调用该授权模块。因此，本次真实 `classify` 流程没有触发它。
- 本地状态加密仅实现 Windows DPAPI；macOS 调用 `_protect` / `_unprotect` 会直接报“当前系统不支持 Windows DPAPI 安全存储”。

## 与服务器的请求

### 激活

- 方法：`POST`
- 地址：`https://license.dadaozixun.com/api/license/activate`
- 超时：12 秒
- 请求头：`Content-Type: application/json; charset=utf-8`、`Accept: application/json`
- 请求字段：
  - `app_name`
  - `activation_code`
  - `code`（与 `activation_code` 重复）
  - `machine_code`
  - `software_version`
  - `client_version`
  - `platform`

它没有调用设备状态接口或解绑接口，也没有发送 `Authorization: Bearer ...`、`X-Device-Credential` 或协议版本字段。

响应会在 `license`、`data`、`result` 三种包装中取第一层字典，并兼容以下别名：

- 机器码：`bound_machine_code` / `machine_code` / `device_code`
- 起始时间：`issued_at` / `activated_at` / `start_at`
- 到期时间：`expires_at` / `expire_at` / `expired_at` / `end_at`
- 授权类型：`license_type` / `type` / `code_type` / `plan_type`
- 余额：`credits` / `points`
- 标识：`code_id` / `license_id` / `id`
- 状态：`status` / `state`
- 无限期：`unlimited` / `is_unlimited`

本地标准化状态还写入 `activated`、`software_version`、`last_online_check_utc`、`last_seen_utc` 和 `last_server_message`。用户输入的激活码以 `activation_credential` 名称放在 Windows DPAPI 加密状态中；它不是当前协议的设备凭证。

### 更新检查

- 方法：`GET`
- 地址：`https://update.dadaozixun.com/api/update/latest?app_name=DadaoMaterialClassifier`
- 超时：6 秒
- 读取字段：`version` / `latest_version`、`download_url` / `url` / `installer_url`、`release_notes` / `notes` / `changelog`、`mandatory` / `force_update` / `required`
- 只有 `https://` 下载地址会进入返回结果。

## 独立机器码逻辑

答案是：**会独立生成标识，而且与 Electron 机器码不兼容。**

算法为：

1. 组成原文：`DadaoMaterialClassifier | sys.platform | machine_source`（实际使用 `|` 连接，不含空格）。
2. 对 UTF-8 原文做 SHA-256，转大写十六进制。
3. 只取前 20 位，按 4 位分组，输出 `XXXX-XXXX-XXXX-XXXX-XXXX`。

`machine_source`：

- Windows：优先通过 `reg.exe query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid` 读取 `MachineGuid`，命令超时 5 秒。
- 读取失败或非 Windows：使用 `platform.node()`、`uuid.getnode()` 和 `platform.machine()` 的组合。这意味着 macOS 路径包含主机名、MAC 派生值和架构。

对比当前 Electron：当前应用以 `ai-media-library` 和 Windows `MachineGuid` / macOS `IOPlatformUUID` 生成 `v2_<64 hex>`。两者的 app 名、输入因子、盐/拼接格式、长度和显示格式都不同，不能互相替代。

## 本地保存与离线行为

- Windows 状态目录：`%LOCALAPPDATA%/DadaoMaterialClassifier/license.dat`
- 非 Windows 状态目录：`~/.local/share/DadaoMaterialClassifier/license.dat`
- 保存方式：JSON → Windows DPAPI（以 app 名作额外熵）→ Base64；临时文件写入后用 `os.replace` 原子替换。
- `OFFLINE_GRACE_SECONDS = 259200`（3 天）和 `_can_use_offline()` 虽然存在，但反汇编中没有任何调用点，不能把它视为当前有效的 3 天离线策略。
- `ensure_activated()` 只读取本地状态、校验机器码/到期时间/时间回拨/`activation_credential`，然后更新 `last_seen_utc`；没有启动时设备状态联网复验。
- 时间回拨容忍为 300 秒。

## 风险与保留建议

1. 该模块属于历史独立 GUI 的授权逻辑；当前 Electron 集成入口不依赖它，不应把它误接回 Electron 授权链路。
2. macOS 缺少 Keychain 实现，若恢复传统 GUI 入口，授权状态保存会失败。
3. 本地状态中的 `activation_credential` 实际是完整激活码。Windows 上虽经 DPAPI 保护，仍不符合当前客户端“不保留完整激活码用于设备状态验证”的新协议设计。
4. `_can_use_offline()` 是无调用点的遗留函数；任何离线期限判断应以当前 Electron 第 1 批实现为准。
5. 请求契约的无网络捕获样本见 `behavior-samples/modules/license_client.json`，完整指令级证据见 `disasm/license_client.txt`。
