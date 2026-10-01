"""小红书页面初始状态解析器。"""

from datetime import datetime
from typing import Any

from lxml.etree import HTML
from xhs_core.domain.errors import ParseError
from xhs_core.domain.links import work_id_from_url
from xhs_core.domain.models import Author, WorkDetail, WorkType

from xhs_adapters.config import AppSettings

from ._initial_state import load_latest_initial_state
from .media import MediaParser

INITIAL_STATE_PREFIX = "window.__INITIAL_STATE__"


class InitialStateParser:
    """把页面中的 ``window.__INITIAL_STATE__`` 转换为领域模型。

    Args:
        settings: 影响图片格式和视频流选择的应用配置。
    """

    def __init__(self, settings: AppSettings) -> None:
        self._media_parser = MediaParser(
            settings.image_format,
            settings.video_preference,
        )

    def parse(self, html: str, source_url: str) -> WorkDetail:
        """解析作品页面。

        Args:
            html: 小红书作品页面 HTML。
            source_url: 页面对应的规范作品链接。

        Returns:
            经过 Pydantic 验证的作品信息。

        Raises:
            ParseError: 页面不包含有效作品状态。
        """
        state = self._load_state(html)
        note = self._select_note(state, work_id_from_url(source_url))
        work_type = _classify(note)
        author_id = str(_deep_get(note, "user.userId"))
        nickname = str(
            _deep_get(note, "user.nickname") or _deep_get(note, "user.nickName")
        )
        avatar_url = str(
            _deep_get(note, "user.avatar") or _deep_get(note, "user.image")
        )
        work_id = str(note.get("noteId") or work_id_from_url(source_url))
        return WorkDetail(
            work_id=work_id,
            source_url=source_url,
            title=str(note.get("title") or ""),
            description=str(note.get("desc") or ""),
            work_type=work_type,
            tags=[
                str(item.get("name"))
                for item in _as_list(note.get("tagList"))
                if item.get("name")
            ],
            published_at=_timestamp(note.get("time")),
            updated_at=_timestamp(note.get("lastUpdateTime")),
            liked_count=str(_deep_get(note, "interactInfo.likedCount", "-1")),
            collected_count=str(_deep_get(note, "interactInfo.collectedCount", "-1")),
            comment_count=str(_deep_get(note, "interactInfo.commentCount", "-1")),
            share_count=str(_deep_get(note, "interactInfo.shareCount", "-1")),
            author=Author(
                author_id=author_id,
                nickname=nickname or author_id,
                profile_url=f"https://www.xiaohongshu.com/user/profile/{author_id}",
                avatar_url=avatar_url or None,
            ),
            media=self._media_parser.parse(note, work_type),
        )

    @staticmethod
    def _load_state(html: str) -> dict[str, Any]:
        if not html:
            raise ParseError("作品页面为空")
        tree = HTML(html)
        if tree is None:
            raise ParseError("作品页面不是有效 HTML")
        scripts = tree.xpath("//script/text()")
        script = next(
            (
                text
                for text in reversed(scripts)
                if text.lstrip().startswith(INITIAL_STATE_PREFIX)
            ),
            "",
        )
        if not script:
            raise ParseError("页面缺少作品初始状态")
        state = load_latest_initial_state(html)
        if state is None:
            raise ParseError("作品初始状态无法解析（诊断码：initial-state-invalid）")
        return state

    @staticmethod
    def _select_note(state: dict[str, Any], work_id: str) -> dict[str, Any]:
        note_map = _deep_get(state, "note.noteDetailMap", {})
        if isinstance(note_map, dict) and note_map:
            wrapper = note_map.get(work_id) or next(reversed(note_map.values()))
            wrapper = _unwrap(wrapper)
            note = wrapper.get("note") if isinstance(wrapper, dict) else None
            note = _unwrap(note)
            if isinstance(note, dict):
                return note
            if isinstance(wrapper, dict) and wrapper.get("noteId"):
                return wrapper
        phone_note = _deep_get(state, "noteData.data.noteData", {})
        phone_note = _unwrap(phone_note)
        if isinstance(phone_note, dict) and "note" in phone_note:
            phone_note = _unwrap(phone_note.get("note"))
        if isinstance(phone_note, dict) and phone_note:
            return phone_note
        raise ParseError("初始状态中没有作品数据（诊断码：note-state-missing）")


def _deep_get(data: Any, path: str, default: Any = "") -> Any:
    current = _unwrap(data)
    for part in path.split("."):
        current = _unwrap(current)
        try:
            current = current[part]
        except (KeyError, TypeError):
            return default
    current = _unwrap(current)
    return current if current is not None else default


def _unwrap(value: Any) -> Any:
    """有限展开页面状态中的响应式 ``value`` 包装。"""
    current = value
    for _ in range(4):
        if not isinstance(current, dict):
            break
        if "value" in current:
            current = current["value"]
            continue
        if "_value" in current:
            current = current["_value"]
            continue
        break
    return current


def _as_list(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _timestamp(value: Any) -> datetime | None:
    try:
        return datetime.fromtimestamp(float(value) / 1000)
    except (TypeError, ValueError, OSError):
        return None


def _classify(note: dict[str, Any]) -> WorkType:
    kind = note.get("type")
    images = _as_list(note.get("imageList"))
    if kind == "video":
        return WorkType.VIDEO if len(images) <= 1 else WorkType.GALLERY
    if kind == "normal" and images:
        return WorkType.IMAGE
    return WorkType.UNKNOWN
