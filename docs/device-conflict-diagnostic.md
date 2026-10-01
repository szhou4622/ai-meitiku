# AI媒体库设备冲突核验工具

此功能只服务 `app_name=ai-media-library`。它不修改现有激活记录，不接受激活码，不读取用户文件，也不会在未经管理员确认时生成新的 canonical 机器码。

## 工作流程

1. 管理员生成 8 位一次性核验码。核验码 15 分钟有效且只能使用一次。
2. 用户关闭 AI媒体库，运行对应系统的“AI媒体库设备核验工具”，输入核验码。
3. 工具复用客户端既有算法，在本机完成设备因子单向哈希，只上传核验码、平台、v2 机器码、哈希因子和受安全存储保护的安装证明。
4. 后台显示 `same_installation`、`likely_new_installation` 或 `needs_review`，管理员记录操作人和原因后确认。
5. 只有 `approve_new_installation` 会生成 24 小时、仅可消费一次的批准。用户随后仍须使用一张未使用的有效时间卡激活；批准本身不授予授权。
6. canonical 创建与批准消费在同一数据库事务完成。激活失败时两者一并回滚。

## 管理命令

管理员令牌只通过环境变量传入，不应写入命令历史、源代码或日志。

```bash
export LICENSE_ADMIN_API_TOKEN="由服务器安全环境提供"
node scripts/license-diagnostic-app/admin.mjs create --operator "客服姓名"
node scripts/license-diagnostic-app/admin.mjs list --state pending
node scripts/license-diagnostic-app/admin.mjs approve diag_xxx --operator "管理员姓名" --reason "订单及远程画面已核对"
```

其他结论：

```bash
node scripts/license-diagnostic-app/admin.mjs same diag_xxx --operator "管理员姓名" --reason "确认是原安装"
node scripts/license-diagnostic-app/admin.mjs reject diag_xxx --operator "管理员姓名" --reason "客户或设备信息不一致"
```

## 发布边界

- 服务端候选入口在 `server/patches/license_server.py.merged-candidate`，未部署时客户端会提示核验服务不可用。
- macOS 安装包必须完成 Developer ID 签名、Apple 公证、stapler 和 Gatekeeper 校验。
- Windows 安装包必须使用组织的 Authenticode 证书签名。未签名测试包不能作为正式客户版本发布。
- 诊断批准不能代替有效激活码，也不能让同一激活码绑定两台电脑。
