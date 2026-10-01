#!/usr/bin/env python3
"""Create a deterministic, secret-safe archive of the CPython 3.12 bytecode API."""

from __future__ import annotations

import dis
import hashlib
import importlib
import inspect
import json
import marshal
import os
import platform
import re
import sys
import types
from pathlib import Path


SALVAGE_ROOT = Path(__file__).resolve().parent
ENGINE_ROOT = SALVAGE_ROOT.parent
PACKAGE_ROOT = ENGINE_ROOT / "src" / "xiaoguan_classifier"
DISASM_ROOT = SALVAGE_ROOT / "disasm"
SENSITIVE_NAME_PARTS = ("secret", "password", "credential", "token", "api_key", "activation_code")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def load_code(path: Path) -> types.CodeType:
    payload = path.read_bytes()
    code = marshal.loads(payload[16:])
    if not isinstance(code, types.CodeType):
        raise TypeError(f"{path.name} does not contain a code object")
    return code


def nested_code(code: types.CodeType):
    yield code
    for value in code.co_consts:
        if isinstance(value, types.CodeType):
            yield from nested_code(value)


def imports_for(code: types.CodeType) -> list[str]:
    names: set[str] = set()
    for nested in nested_code(code):
        for instruction in dis.get_instructions(nested):
            if instruction.opname == "IMPORT_NAME" and instruction.argval:
                names.add(str(instruction.argval))
    return sorted(names)


def safe_repr(name: str, value: object) -> str:
    lowered = name.lower()
    if any(part in lowered for part in SENSITIVE_NAME_PARTS):
        return f"<redacted:{type(value).__name__}>"
    def scrub_path(text: str) -> str:
        return text.replace(str(ENGINE_ROOT), "<engine-root>").replace(str(Path.home()), "<home>")
    if isinstance(value, (str, int, float, bool, type(None))):
        text = scrub_path(repr(value))
        return text if len(text) <= 300 else text[:280] + "…"
    if isinstance(value, Path):
        return repr(scrub_path(str(value)))
    if isinstance(value, (tuple, list, set, frozenset, dict)):
        text = repr(value)
        if len(text) <= 500:
            return text
        return f"<{type(value).__name__} items={len(value)} sha256={sha256_bytes(text.encode('utf-8'))[:16]}>"
    return f"<{type(value).__module__}.{type(value).__qualname__}>"


def signature_of(value: object) -> str:
    try:
        return str(inspect.signature(value))
    except (TypeError, ValueError):
        return "<signature unavailable>"


def module_interface(module: types.ModuleType) -> dict[str, object]:
    functions = []
    classes = []
    constants = []
    for name, value in sorted(vars(module).items()):
        if name.startswith("__"):
            continue
        if inspect.isfunction(value) and value.__module__ == module.__name__:
            functions.append({"name": name, "signature": signature_of(value)})
        elif inspect.isclass(value) and value.__module__ == module.__name__:
            methods = []
            for method_name, method in sorted(vars(value).items()):
                target = method
                kind = "method"
                if isinstance(method, staticmethod):
                    target = method.__func__
                    kind = "staticmethod"
                elif isinstance(method, classmethod):
                    target = method.__func__
                    kind = "classmethod"
                if inspect.isfunction(target):
                    methods.append({"name": method_name, "kind": kind, "signature": signature_of(target)})
            classes.append({"name": name, "signature": signature_of(value), "methods": methods})
        elif name.isupper() and not inspect.ismodule(value) and not inspect.isroutine(value):
            constants.append({"name": name, "value": safe_repr(name, value)})
    return {"functions": functions, "classes": classes, "constants": constants}


def render_interface_map(records: list[dict[str, object]]) -> str:
    lines = [
        "# CPython 3.12 分类引擎接口地图",
        "",
        "> 本文件由 `generate_archive.py` 从 15 个 `.pyc` 静态反汇编并在隔离进程中只做模块导入/反射生成。",
        "> 带敏感名称的全局量只记录类型，不记录值；大型常量只记录数量和摘要。",
        "",
    ]
    for record in records:
        lines.extend([
            f"## `{record['module']}`",
            "",
            f"- 字节码：`{record['file']}`",
            f"- SHA-256：`{record['sha256']}`",
            f"- 编译源路径：`{record['source_filename']}`",
            f"- import 依赖：{', '.join(f'`{item}`' for item in record['imports']) or '无'}",
            "",
            "### 函数",
            "",
        ])
        functions = record["interface"]["functions"]
        lines.extend([f"- `{item['name']}{item['signature']}`" for item in functions] or ["- 无"])
        lines.extend(["", "### 类与方法", ""])
        classes = record["interface"]["classes"]
        if not classes:
            lines.append("- 无")
        for item in classes:
            lines.append(f"- `{item['name']}{item['signature']}`")
            for method in item["methods"]:
                lines.append(f"  - {method['kind']} `{method['name']}{method['signature']}`")
        lines.extend(["", "### 全局常量", ""])
        constants = record["interface"]["constants"]
        lines.extend([f"- `{item['name']}` = `{item['value']}`" for item in constants] or ["- 无"])
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError("must run with CPython 3.12")
    DISASM_ROOT.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(ENGINE_ROOT / "src"))
    os.environ.pop("ARK_API_KEY", None)

    records: list[dict[str, object]] = []
    for path in sorted(PACKAGE_ROOT.glob("*.pyc")):
        code = load_code(path)
        module_name = f"xiaoguan_classifier.{path.stem}"
        disassembly_path = DISASM_ROOT / f"{path.stem}.txt"
        with disassembly_path.open("w", encoding="utf-8") as stream:
            stream.write(f"module: {module_name}\n")
            stream.write(f"bytecode: {path.relative_to(ENGINE_ROOT)}\n")
            stream.write(f"sha256: {sha256_bytes(path.read_bytes())}\n")
            stream.write(f"python: {platform.python_version()}\n")
            stream.write(f"source_filename: {code.co_filename}\n\n")
            dis.dis(code, file=stream)
        disassembly_path.write_text(
            re.sub(r" at 0x[0-9a-fA-F]+", " at <address>", disassembly_path.read_text(encoding="utf-8")),
            encoding="utf-8",
        )
        module = importlib.import_module(module_name)
        records.append({
            "module": module_name,
            "file": str(path.relative_to(ENGINE_ROOT)),
            "sha256": sha256_bytes(path.read_bytes()),
            "source_filename": code.co_filename,
            "imports": imports_for(code),
            "interface": module_interface(module),
        })

    (SALVAGE_ROOT / "interface-map.md").write_text(render_interface_map(records), encoding="utf-8")
    manifest = {
        "schema_version": 1,
        "python_runtime": platform.python_version(),
        "implementation": platform.python_implementation(),
        "module_count": len(records),
        "modules": records,
    }
    (SALVAGE_ROOT / "interface-map.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"archived {len(records)} modules")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
