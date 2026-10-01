# 分类引擎抢救性存档

该目录面向仅剩 CPython 3.12 `.pyc` 的历史分类引擎，保存可维护性最低限度所需的行为证据，不声称恢复了原始 `.py` 源码。

## 内容

- `disasm/`：15 个模块的完整 `dis.dis()` 输出，每个模块一个文件。
- `interface-map.md`：函数、类、参数、默认值、全局常量与 import 依赖关系。
- `interface-map.json`：同一接口地图的机器可读版。
- `license-client-analysis.md`：历史授权客户端的请求、字段、本地保存和独立机器码分析。
- `behavior-samples/`：一次真实素材分类的脱敏输入/输出、产物摘要及逐模块调用样本。
- `generate_archive.py`：重新生成反汇编与接口地图。
- `capture_behavior.py` / `build_behavior_archive.py`：在隔离目录采集并脱敏真实行为。
- `capture_license_contract.py`：用假 HTTP 响应提取授权请求契约，不联网。

## 生成环境

字节码魔数和运行验证对应 CPython 3.12；本次使用项目现存的 Python 3.12.14 运行时。升级 Python 主版本/次版本可能无法加载这些 `.pyc`。

## 安全边界

- 未提交原始素材或分类后的视频副本。
- 未提交 API Key、激活码、机器码、设备会话或设备凭证。
- 行为样本中的本地绝对路径已替换为占位符。
- 对外部模型的真实调用只有分类样本中的 1 次；授权契约捕获完全在本地假响应中完成。
