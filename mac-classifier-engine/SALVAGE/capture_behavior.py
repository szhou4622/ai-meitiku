#!/usr/bin/env python3
"""Run one classifier request and capture redacted module-level call samples."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import sys
from pathlib import Path


SENSITIVE_PARTS = ("secret", "password", "credential", "token", "api_key", "activation_code", "authorization")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-entry", required=True, type=Path)
    parser.add_argument("--runtime-root", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--work-dir", required=True, type=Path)
    args = parser.parse_args()

    work_dir = args.work_dir.resolve()
    input_dir = work_dir / "input"
    output_dir = work_dir / "output"
    input_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    source_copy = input_dir / args.source.name
    shutil.copy2(args.source, source_copy)

    roots = {
        str(input_dir): "<input>",
        str(output_dir): "<output>",
        str(args.runtime_root.resolve()): "<runtime>",
        str(args.engine_entry.resolve().parent): "<engine>",
        str(work_dir): "<work>",
    }
    secret_values = {
        value
        for key, value in os.environ.items()
        if value and any(part in key.lower() for part in ("key", "token", "secret", "password", "credential"))
    }

    def scrub_text(value: str) -> str:
        text = value
        for root, replacement in roots.items():
            text = text.replace(root, replacement)
        for secret in secret_values:
            if len(secret) >= 6:
                text = text.replace(secret, "<redacted-secret>")
        if len(text) > 240:
            return f"<str length={len(text)} sha256={digest(text.encode('utf-8'))[:16]}>"
        return text

    def summarize(value: object, name: str = "", depth: int = 0) -> object:
        if any(part in name.lower() for part in SENSITIVE_PARTS):
            return f"<redacted:{type(value).__name__}>"
        if depth >= 3:
            return f"<{type(value).__name__}>"
        if value is None or isinstance(value, (bool, int, float)):
            return value
        if isinstance(value, str):
            return scrub_text(value)
        if isinstance(value, Path):
            return scrub_text(str(value))
        if isinstance(value, bytes):
            return {"type": "bytes", "length": len(value), "sha256": digest(value)[:16]}
        if isinstance(value, dict):
            output = {}
            for key, item in list(value.items())[:30]:
                key_text = scrub_text(str(key))
                output[key_text] = summarize(item, key_text, depth + 1)
            if len(value) > 30:
                output["<truncated>"] = len(value) - 30
            return output
        if isinstance(value, (list, tuple, set, frozenset)):
            items = list(value)
            return {
                "type": type(value).__name__,
                "length": len(items),
                "items": [summarize(item, depth=depth + 1) for item in items[:12]],
            }
        if hasattr(value, "__dict__"):
            return {"type": type(value).__name__, "fields": summarize(vars(value), depth=depth + 1)}
        return f"<{type(value).__module__}.{type(value).__qualname__}>"

    samples: dict[str, dict[str, object]] = {}

    def trace(frame, event, arg):
        module = str(frame.f_globals.get("__name__", ""))
        if not module.startswith("xiaoguan_classifier"):
            return trace
        function = frame.f_code.co_qualname
        key = f"{module}:{function}"
        record = samples.setdefault(key, {"module": module, "function": function, "calls": 0})
        if event == "call":
            record["calls"] = int(record["calls"]) + 1
            if "input" not in record:
                arguments = {}
                arg_count = frame.f_code.co_argcount + frame.f_code.co_kwonlyargcount
                for name in frame.f_code.co_varnames[:arg_count]:
                    if name in frame.f_locals:
                        arguments[name] = summarize(frame.f_locals[name], name)
                record["input"] = arguments
        elif event == "return" and "output" not in record:
            record["output"] = summarize(arg, "return")
        elif event == "exception" and "exception" not in record:
            exc_type, exc_value, _ = arg
            record["exception"] = {
                "type": getattr(exc_type, "__name__", str(exc_type)),
                "message": scrub_text(str(exc_value)),
            }
        return trace

    request = {
        "command": "classify",
        "folder": str(input_dir),
        "output_root": str(output_dir),
        "progress_path": str(work_dir / "progress.log"),
        "runtime_root": str(args.runtime_root.resolve()),
    }
    (work_dir / "request.json").write_text(json.dumps(request, ensure_ascii=False, indent=2), encoding="utf-8")

    spec = importlib.util.spec_from_file_location("salvage_engine_entry", args.engine_entry.resolve())
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load engine entry")
    engine = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(engine)
    engine.prepare_import_path()

    sys.settrace(trace)
    try:
        result = engine.run(request, work_dir / "progress.log")
        payload = {"ok": True, "result": summarize(result, "result")}
    except Exception as error:
        payload = {"ok": False, "error": {"type": type(error).__name__, "message": scrub_text(str(error))}}
    finally:
        sys.settrace(None)

    source_info = {
        "name": args.source.name,
        "size": args.source.stat().st_size,
        "sha256": digest(args.source.read_bytes()),
    }
    output_files = []
    for path in sorted(output_dir.rglob("*")):
        if path.is_file():
            output_files.append({
                "path": str(path.relative_to(output_dir)),
                "size": path.stat().st_size,
                "sha256": digest(path.read_bytes()),
            })

    (work_dir / "capture.json").write_text(
        json.dumps({
            "source": source_info,
            "request": summarize(request, "request"),
            "result": payload,
            "module_samples": list(samples.values()),
            "output_files": output_files,
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"ok": payload["ok"], "sample_count": len(samples), "output_file_count": len(output_files)}, ensure_ascii=False))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
