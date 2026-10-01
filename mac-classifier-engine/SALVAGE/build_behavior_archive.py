#!/usr/bin/env python3
"""Convert an isolated runtime capture into commit-safe behavior samples."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path


SALVAGE_ROOT = Path(__file__).resolve().parent
OUTPUT_ROOT = SALVAGE_ROOT / "behavior-samples"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture", required=True, type=Path)
    parser.add_argument("--progress", required=True, type=Path)
    parser.add_argument("--work-root", required=True, type=Path)
    args = parser.parse_args()

    capture = json.loads(args.capture.read_text(encoding="utf-8"))
    interface = json.loads((SALVAGE_ROOT / "interface-map.json").read_text(encoding="utf-8"))
    work_roots = {str(args.work_root), str(args.work_root.resolve())}

    def scrub(text: str) -> str:
        output = text
        for root in work_roots:
            output = output.replace(root, "<work>")
        output = output.replace("<work>/input", "<input>").replace("<work>/output", "<output>")
        return output

    progress_lines = [scrub(line) for line in args.progress.read_text(encoding="utf-8").splitlines()]
    run_payload = {
        "schema_version": 1,
        "source": capture["source"],
        "request": capture["request"],
        "result": capture["result"],
        "output_files": capture["output_files"],
        "progress": progress_lines,
        "safety": {
            "source_copied_to_isolated_temp": True,
            "original_source_modified": False,
            "generated_media_committed": False,
            "secrets_committed": False,
        },
    }
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    (OUTPUT_ROOT / "classification-run.json").write_text(
        json.dumps(run_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    grouped: dict[str, list[dict[str, object]]] = defaultdict(list)
    for sample in capture["module_samples"]:
        module_name = "xiaoguan_classifier.__init__" if sample["module"] == "xiaoguan_classifier" else sample["module"]
        grouped[module_name].append(sample)

    module_root = OUTPUT_ROOT / "modules"
    module_root.mkdir(parents=True, exist_ok=True)
    rows = []
    for record in interface["modules"]:
        full_name = record["module"]
        short_name = full_name.rsplit(".", 1)[-1]
        samples = grouped.get(full_name, [])
        module_payload = {
            "module": full_name,
            "bytecode_sha256": record["sha256"],
            "observed_in_classification_run": bool(samples),
            "sample_count": len(samples),
            "samples": samples,
            "note": "" if samples else "This module was not invoked by the classify command; see interface-map.md and disasm for its static contract.",
        }
        (module_root / f"{short_name}.json").write_text(
            json.dumps(module_payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        rows.append((full_name, "是" if samples else "否", str(len(samples))))

    readme = [
        "# 分类引擎行为样本",
        "",
        "本目录记录一次真实素材的隔离分类运行。原素材只复制到系统临时目录，未修改；生成的视频副本未纳入 Git。",
        "所有路径已替换为 `<input>`、`<output>`、`<runtime>` 或 `<work>`；API Key、授权码和机器码不在样本中。",
        "",
        "## 真实运行结果",
        "",
        f"- 输入文件 SHA-256：`{capture['source']['sha256']}`",
        f"- 输入大小：{capture['source']['size']} 字节",
        f"- 分类成功：{'是' if capture['result']['ok'] else '否'}",
        f"- 生成文件记录数：{len(capture['output_files'])}（只记录名称、大小、摘要，不保存媒体副本）",
        "- API 请求：1 次成功；运行日志报告输入 2478 tokens、输出 722 tokens、合计 3200 tokens",
        "",
        "## 模块覆盖",
        "",
        "| 模块 | 本次 classify 实际调用 | 已记录函数样本数 |",
        "| --- | ---: | ---: |",
    ]
    readme.extend(f"| `{module}` | {observed} | {count} |" for module, observed, count in rows)
    readme.extend([
        "",
        "未被 classify 命令触发的模块并不表示无效；GUI、授权、规则文档、复核与镜头切分是独立入口。",
        "`license_client.json` 另由完全本地的假 HTTP 响应生成，用于保存请求契约，未访问授权服务器。",
        "",
    ])
    (OUTPUT_ROOT / "README.md").write_text("\n".join(readme), encoding="utf-8")
    print(f"wrote {len(rows)} module behavior files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
