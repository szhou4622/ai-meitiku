# AI媒体库功能注册与权益接入（本地开发版）

`electron/feature-registry.mjs` 是客户端功能归属的唯一清单。`free` 表示有效基础授权；`vip` 表示基础授权与 VIP 权益同时有效。`enabled` 只控制功能是否发布，不代表用户权益。注册缺失、归属缺失、入口冲突一律拒绝。

新增 VIP 功能的最小注册示例（仅用于说明，测试里的临时功能不属于正式清单）：

```js
registerVipFeature({
  id: "example-vip",
  label: "示例 VIP 功能",
  enabled: true,
  ipcPrefixes: ["example-vip-"],
  httpPrefixes: ["/api/example-vip/"],
})
```

业务开发仍需实现页面组件、菜单图标（可选）、preload 桥接、受控主进程处理器及测试。主进程用 `registerProtectedHandle("example-vip-create", handler)` 注册 IPC；子操作沿用同一前缀，自动继承本功能的 VIP 归属。任何本地 HTTP 子路由需要进入 `featureRegistry.forHttp()` 的执行保护。页面只在 `canAccessFeature()` 允许时挂载；实际写入必须由受控执行入口再次校验，不能信任渲染进程传入的功能 ID。新增功能无需修改旧激活码、用户记录或通用权益算法。

共享的媒体文件、预览、分类与普通导入属于免费底层能力，不能因为被 VIP 库引用就整体封锁。爆款画面库的专属索引元数据（库成员关系、CSV 数据）在 `saveMediaLibrary()` 中做差异检查，原始媒体记录仍可由免费媒体库读取。爆款文案的专属操作通过 `viral-copy-*` 入口保护。

双期限客户端协议目前是**待服务端基线核验的适配约定**：成功联网状态须明确返回 `entitlement_schema_version >= 1`、`base_expires_at` 和 `vip_expires_at`（无 VIP 时为 `null`）；只有服务端明确返回 `redemption_protocol_version >= 1`，有效期内兑换入口才开放。客户端只读取并执行 B/V，不自行计算、持久化或授予续期。服务端必须自行核验应用、设备、码类型、期限、事务与幂等；这些能力尚未联调，不能用于生产。
