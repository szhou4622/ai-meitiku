# AM 媒体库（AI Media Library）

项目仓库：https://github.com/szhou4622/ai-meitiku

本仓库用于集中管理媒体库代码、记录可追溯版本，并开展独立分支开发。

## 当前状态

仓库管理基线已建立。完整客户端源码将单独通过导入分支和 PR 纳入。
当前不宣称具备完整构建或运行能力。

协作配置与检查范围见 [团队协作流程](docs/team-workflow.md)。当前 CI 仅检查仓库规范，应用测试与构建将在源码导入后补齐。

## 分支流程

1. `main`：已确认的稳定基线。
2. `codex/server-import`：首批服务器源码导入与完整性核对。
3. 后续功能使用 `codex/<任务名>`，通过 Pull Request 合并。

```bash
git switch main
git pull --ff-only
git switch -c codex/your-task
```

提交前检查差异及敏感信息，完成适用验证，再提交并推送当前分支。
基线标签用于回溯版本；不要强制移动已发布标签。

## 范围

只在本仓库调试。服务器只作为本次代码导入来源；不对线上服务进行部署、重启或数据修改。
真实环境配置、用户数据、媒体资源和安装包不进入 Git。
