"""下载 CLI 页面解析器的兼容性回归测试。"""

from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PARSING_ROOT = ROOT / "packages" / "xhs-adapters" / "src" / "xhs_adapters" / "parsing"


class ParseError(Exception):
    """测试替身使用的页面解析异常。"""


def _module(name: str, **attributes: object) -> types.ModuleType:
    module = types.ModuleType(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    sys.modules[name] = module
    return module


def _load_page_module():
    """隔离加载页面解析器，避免测试依赖完整应用运行时。"""
    package = _module("xhs_adapters")
    package.__path__ = []
    parsing = _module("xhs_adapters.parsing")
    parsing.__path__ = [str(PARSING_ROOT)]
    _module("xhs_adapters.config", AppSettings=object)
    _module("xhs_adapters.parsing.media", MediaParser=object)

    core = _module("xhs_core")
    core.__path__ = []
    domain = _module("xhs_core.domain")
    domain.__path__ = []
    _module("xhs_core.domain.errors", ParseError=ParseError)
    _module(
        "xhs_core.domain.links",
        work_id_from_url=lambda url: url.rstrip("/").split("/")[-1],
    )
    _module(
        "xhs_core.domain.models",
        Author=object,
        WorkDetail=object,
        WorkType=types.SimpleNamespace(
            VIDEO="video", GALLERY="gallery", IMAGE="image", UNKNOWN="unknown"
        ),
    )

    for name in ("_initial_state", "page"):
        qualified = f"xhs_adapters.parsing.{name}"
        spec = importlib.util.spec_from_file_location(
            qualified,
            PARSING_ROOT / f"{name}.py",
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[qualified] = module
        spec.loader.exec_module(module)
    return sys.modules["xhs_adapters.parsing.page"]


PAGE = _load_page_module()


class InitialStateParserCompatibilityTest(unittest.TestCase):
    """验证新版初始状态和响应式包装的兼容边界。"""

    def test_undefined_value_is_normalized_before_json_decode(self) -> None:
        """JSON 解码前只替换字符串外的 undefined。"""
        html = (
            '<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":'
            '{"abc":{"note":{"noteId":"abc","extra":undefined}}}}};</script>'
        )
        state = PAGE.InitialStateParser._load_state(html)
        note = PAGE.InitialStateParser._select_note(state, "abc")
        self.assertEqual(note["noteId"], "abc")
        self.assertIsNone(note["extra"])

    def test_empty_javascript_collections_are_normalized_outside_strings(self) -> None:
        """空 Map 和 Set 转为 JSON，字符串中的同名文本保持不变。"""
        html = (
            '<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":'
            '{"abc":{"note":{"noteId":"abc"}}}},"runtime":'
            '{"cache":new Map([]),"tags":new Set([]),'
            '"literal":"new Map([])"}};</script>'
        )
        state = PAGE.InitialStateParser._load_state(html)
        note = PAGE.InitialStateParser._select_note(state, "abc")
        self.assertEqual(note["noteId"], "abc")
        self.assertEqual(state["runtime"]["cache"], {})
        self.assertEqual(state["runtime"]["tags"], [])
        self.assertEqual(state["runtime"]["literal"], "new Map([])")

    def test_reactive_value_wrappers_are_unwrapped(self) -> None:
        """响应式 value 包装中的作品数据可以被读取。"""
        state = {
            "note": {
                "value": {
                    "noteDetailMap": {
                        "_value": {
                            "abc": {"value": {"note": {"_value": {"noteId": "abc"}}}}
                        }
                    }
                }
            }
        }
        note = PAGE.InitialStateParser._select_note(state, "abc")
        self.assertEqual(note["noteId"], "abc")

    def test_phone_note_wrapper_is_unwrapped(self) -> None:
        """移动端 noteData 包装中的作品数据可以被读取。"""
        state = {
            "noteData": {
                "data": {"noteData": {"value": {"note": {"value": {"noteId": "abc"}}}}}
            }
        }
        note = PAGE.InitialStateParser._select_note(state, "abc")
        self.assertEqual(note["noteId"], "abc")

    def test_invalid_state_and_missing_note_have_stable_diagnostic_codes(self) -> None:
        """损坏状态和缺少作品保持稳定且可诊断的错误码。"""
        invalid = "<script>window.__INITIAL_STATE__={broken:undefined};</script>"
        with self.assertRaisesRegex(ParseError, "initial-state-invalid"):
            PAGE.InitialStateParser._load_state(invalid)
        with self.assertRaisesRegex(ParseError, "note-state-missing"):
            PAGE.InitialStateParser._select_note({"user": {}}, "abc")


if __name__ == "__main__":
    unittest.main()
