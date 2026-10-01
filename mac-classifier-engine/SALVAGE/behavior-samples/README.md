# 分类引擎行为样本

本目录记录一次真实素材的隔离分类运行。原素材只复制到系统临时目录，未修改；生成的视频副本未纳入 Git。
所有路径已替换为 `<input>`、`<output>`、`<runtime>` 或 `<work>`；API Key、授权码和机器码不在样本中。

## 真实运行结果

- 输入文件 SHA-256：`670bc3b8b950fda0404aa38c04bdd0d8ed52d8fd986fdad390e6e2725a6917c9`
- 输入大小：514445 字节
- 分类成功：是
- 生成文件记录数：9（只记录名称、大小、摘要，不保存媒体副本）
- API 请求：1 次成功；运行日志报告输入 2478 tokens、输出 722 tokens、合计 3200 tokens

## 模块覆盖

| 模块 | 本次 classify 实际调用 | 已记录函数样本数 |
| --- | ---: | ---: |
| `xiaoguan_classifier.__init__` | 是 | 1 |
| `xiaoguan_classifier.app` | 否 | 0 |
| `xiaoguan_classifier.config` | 是 | 9 |
| `xiaoguan_classifier.help_docs` | 否 | 0 |
| `xiaoguan_classifier.license_client` | 否 | 0 |
| `xiaoguan_classifier.media` | 是 | 7 |
| `xiaoguan_classifier.model_client` | 是 | 2 |
| `xiaoguan_classifier.organizer` | 是 | 19 |
| `xiaoguan_classifier.prompt` | 是 | 3 |
| `xiaoguan_classifier.review_tools` | 否 | 0 |
| `xiaoguan_classifier.rule_docs` | 否 | 0 |
| `xiaoguan_classifier.shot_splitter` | 否 | 0 |
| `xiaoguan_classifier.source` | 是 | 3 |
| `xiaoguan_classifier.taxonomy` | 是 | 6 |
| `xiaoguan_classifier.templates` | 是 | 12 |

未被 classify 命令触发的模块并不表示无效；GUI、授权、规则文档、复核与镜头切分是独立入口。
`license_client.json` 另由完全本地的假 HTTP 响应生成，用于保存请求契约，未访问授权服务器。
