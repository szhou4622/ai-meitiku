# 媒体库个人 API 使用开关

> 历史阶段记录：本文中的“未接通、未上线、尚未打包”等状态只代表当时的验收范围。2026-10-15 当前状态见 [当前开发与交付状态](CURRENT_STATUS.md)，请勿据本文推断现在仍未完成。

本批仅修改媒体库客户端，未修改服务器或其他软件。各提供商独立保存：`volcengine`、`relay`、`minimax`、`aliyun`。

- 开启：仅使用个人 API；缺少配置或调用失败时停止，不切换成积分调用。
- 关闭：选择平台积分模式；保留个人密钥，禁止个人密钥调用。
- 开关立即保存到系统安全存储加密的 `api-usage.v1.bin`，不要求先填写密钥，也不依赖底部“保存 API 设置”。缺少该文件的旧安装默认全部开启，保留既有行为；读取失败停止任务。
- 每个任务固定使用方式。分类批次持有同一份内存配置，重跑使用服务器所属客户端主进程记录的 `apiTaskId` 和原方式；提示词排队与供应商重试沿用提交时的配置；去字幕在持久任务中保存 `apiSelection`；声音重复请求返回原结果，任务记录保存原 `apiSelection`。

## 给平台接口接入的约定

`electron/api-usage.mjs` 的 `ApiUsageStore.selection(provider)` 返回 `{ provider, apiMode, usesSoftwarePoints }`。`customer_api` 不得调用中央积分预扣或结算；`platform_api` 不得读取或发送用户个人密钥。客户端不得自行决定供应商真实成本，也不得将错误、超时或缺少 Key 作为切换付费方式的理由。

当前源码的供应商执行仍为个人 API 路径，因此 `requireCustomerApi()` 在积分模式明确抛出 `PLATFORM_API_UNAVAILABLE`，不产生个人 API 调用或软件积分扣款。后续接入者必须在任务开始处按上述方式增加独立的平台执行分支，使用中央权威结算；不能简单删除此拦截或恢复“有 Key 就用个人 API，否则自动扣积分”的判断。

分类读取的 `profiles.volcengine.useOwnApi` / `profiles.relay.useOwnApi` 已注入开关。阿里云服务的 `getApiSelection`、声音后端的 `configureVoiceApiUsage` 已接入主进程选择器。模式应由主进程记录并沿用；不得信任 renderer 提供的 `apiMode` 作为收费授权。

## 验证

相关九组测试合计 111 项通过；类型检查与生产构建通过。新增文件及主进程、配置模块的定向 lint 通过，设置页原有 lint 问题仍存在。

Electron 独立测试预览实际确认 MiniMax 无 Key 可以关闭、个人字段和连接测试停用；阿里云与火山保持独立；离开页面再返回保留已选模式。测试开关均恢复默认开启。未调用真实供应商、未消费真实积分、未更新安装版。
