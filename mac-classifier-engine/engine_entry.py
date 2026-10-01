from __future__ import annotations

import base64  # noqa: F401
import collections  # noqa: F401
import concurrent.futures  # noqa: F401
import csv  # noqa: F401
import ctypes  # noqa: F401
import dataclasses  # noqa: F401
import datetime  # noqa: F401
import hashlib  # noqa: F401
import html  # noqa: F401
import json
import math  # noqa: F401
import os  # noqa: F401
import platform  # noqa: F401
import queue  # noqa: F401
import re  # noqa: F401
import shutil  # noqa: F401
import subprocess  # noqa: F401
import sys
import tempfile  # noqa: F401
import threading  # noqa: F401
import time  # noqa: F401
import tkinter  # noqa: F401
import urllib.error  # noqa: F401
import urllib.request  # noqa: F401
import uuid  # noqa: F401
import webbrowser  # noqa: F401
from pathlib import Path

# These imports make the native packager collect dependencies used by the
# recovered classifier bytecode, which is loaded from the bundled src folder.
import imageio  # noqa: F401
import imageio_ffmpeg  # noqa: F401
import numpy  # noqa: F401
import requests  # noqa: F401
from PIL import Image, ImageDraw, ImageFont  # noqa: F401


def bundle_root() -> Path:
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)).resolve()


def prepare_import_path() -> None:
    source_root = bundle_root() / "src"
    if source_root.exists():
        sys.path.insert(0, str(source_root))


def emit_to(progress_path: Path | None, message: object) -> None:
    if progress_path is None:
        return
    progress_path.parent.mkdir(parents=True, exist_ok=True)
    with progress_path.open("a", encoding="utf-8") as stream:
        stream.write(str(message).replace("\r", " ").replace("\n", " ") + "\n")


def json_default(value: object) -> object:
    if hasattr(value, "__dict__"):
        return value.__dict__
    return str(value)


def configure_split_precision(shot_splitter: object, request: dict[str, object], emit) -> str:
    precision = str(request.get("split_precision", "fine")).strip().lower()
    if precision == "rough":
        # A higher scene threshold ignores small visual changes. The longer
        # minimum segment prevents a burst of tiny clips around camera motion.
        shot_splitter.STABLE_SCENE_THRESHOLD = 0.38
        shot_splitter.STABLE_MIN_SEGMENT_SECONDS = 2.4
        emit("切割精度：粗略切割；场景变化阈值 0.38，最短镜头 2.4 秒。")
        return "rough"
    shot_splitter.STABLE_SCENE_THRESHOLD = 0.24
    shot_splitter.STABLE_MIN_SEGMENT_SECONDS = 0.8
    emit("切割精度：精细切割；场景变化阈值 0.24，最短镜头 0.8 秒。")
    return "fine"


def run(request: dict[str, object], progress_path: Path | None) -> object:
    command = str(request.get("command", "classify"))
    folder_text = str(request.get("folder", "")).strip()
    output_text = str(request.get("output_root", "")).strip()
    folder = Path(folder_text) if folder_text else None
    output_root = Path(output_text) if output_text else None

    from xiaoguan_classifier import config as config_module
    from xiaoguan_classifier import templates as templates_module

    template = templates_module.get_active_template()
    emit = lambda message: emit_to(progress_path, message)

    if command in ("classify", "review"):
        if folder is None:
            raise ValueError("请选择素材文件夹")
        from xiaoguan_classifier import organizer

        return organizer.organize_folder(
            folder,
            config_module.load_settings(),
            emit,
            output_root,
            None,
            template,
            command == "review",
        )
    if command == "split":
        if folder is None:
            raise ValueError("请选择素材文件夹")
        from xiaoguan_classifier import shot_splitter

        configure_split_precision(shot_splitter, request, emit)
        return shot_splitter.split_folder_stable(folder, emit, output_root, None, 2)
    if command in ("correction-create", "correction-apply", "self-check"):
        library_root = output_root or folder
        if library_root is None:
            raise ValueError("请选择素材文件夹或输出目录")
        from xiaoguan_classifier import review_tools

        if command == "correction-create":
            return review_tools.build_correction_sheet(library_root, template)
        if command == "correction-apply":
            return review_tools.apply_correction_sheet(library_root, template)
        return review_tools.run_classification_self_check(library_root, template)
    raise ValueError("不支持的内部命令：" + command)


def main() -> int:
    prepare_import_path()
    args = sys.argv[1:]
    if "--self-test" in args:
        from xiaoguan_classifier import taxonomy, templates

        template = templates.get_active_template()
        if not template or not taxonomy.TAXONOMY:
            raise RuntimeError("分类引擎模板或分类逻辑未加载")
        print("classifier engine self-test ok")
        return 0
    if "--request" not in args or "--result" not in args:
        print("missing --request or --result", file=sys.stderr)
        return 2

    request_path = Path(args[args.index("--request") + 1]).resolve()
    result_path = Path(args[args.index("--result") + 1]).resolve()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    progress_text = str(request.get("progress_path", "")).strip()
    progress_path = Path(progress_text).resolve() if progress_text else None

    payload: dict[str, object]
    try:
        payload = {"ok": True, "result": run(request, progress_path)}
    except Exception as error:
        emit_to(progress_path, "错误：" + str(error))
        payload = {"ok": False, "error": str(error)}

    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(
        json.dumps(payload, ensure_ascii=False, default=json_default),
        encoding="utf-8",
    )
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
