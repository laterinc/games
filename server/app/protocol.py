"""协议常量、错误码与入参校验（对齐 gomoku/PROTOCOL.md v1）。"""

from __future__ import annotations

import time
from enum import Enum
from typing import Any

PROTOCOL_VERSION = 1
MAX_PLAYERS = 2
BOARD_SIZE_DEFAULT = 15

NAME_MAX_LENGTH = 16
ROOM_NAME_MAX_LENGTH = 24
CHAT_TEXT_MAX_LENGTH = 200
CHAT_HISTORY_LIMIT = 50

#: 心跳/超时（协议固定值，不随环境变量变化）
IDLE_TIMEOUT_SECONDS = 30.0
RATE_LIMIT_WINDOW_SECONDS = 5.0
RATE_LIMIT_MAX_MESSAGES = 40

#: 颜色/可见性枚举
COLORS: tuple[str, ...] = ("black", "white")
CREATE_COLORS: tuple[str, ...] = ("black", "white", "random")
VISIBILITIES: tuple[str, ...] = ("public", "private")
ROOM_STATUSES: tuple[str, ...] = ("waiting", "playing", "finished")


def now_ms() -> int:
    """当前 Unix 毫秒时间戳。"""
    return int(time.time() * 1000)


class ErrorCode(str, Enum):
    """协议错误码全集（字符串值即客户端可见的 code）。"""

    INVALID_MESSAGE = "INVALID_MESSAGE"
    UNKNOWN_TYPE = "UNKNOWN_TYPE"
    INVALID_NAME = "INVALID_NAME"
    INVALID_ROOM_NAME = "INVALID_ROOM_NAME"
    ALREADY_IN_ROOM = "ALREADY_IN_ROOM"
    NOT_IN_ROOM = "NOT_IN_ROOM"
    ROOM_NOT_FOUND = "ROOM_NOT_FOUND"
    ROOM_FULL = "ROOM_FULL"
    ROOM_STARTED = "ROOM_STARTED"
    NOT_YOUR_TURN = "NOT_YOUR_TURN"
    INVALID_MOVE = "INVALID_MOVE"
    GAME_NOT_ACTIVE = "GAME_NOT_ACTIVE"
    RATE_LIMITED = "RATE_LIMITED"
    AUTH_FAILED = "AUTH_FAILED"


DEFAULT_ERROR_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.INVALID_MESSAGE: "消息格式不正确",
    ErrorCode.UNKNOWN_TYPE: "未知消息类型",
    ErrorCode.INVALID_NAME: f"昵称需为 1–{NAME_MAX_LENGTH} 个字符",
    ErrorCode.INVALID_ROOM_NAME: f"房间名需为 0–{ROOM_NAME_MAX_LENGTH} 个字符",
    ErrorCode.ALREADY_IN_ROOM: "你已在房间中",
    ErrorCode.NOT_IN_ROOM: "你不在房间中",
    ErrorCode.ROOM_NOT_FOUND: "房间不存在",
    ErrorCode.ROOM_FULL: "房间已满",
    ErrorCode.ROOM_STARTED: "对局已开始，无法加入",
    ErrorCode.NOT_YOUR_TURN: "还没轮到你落子",
    ErrorCode.INVALID_MOVE: "落子位置不合法",
    ErrorCode.GAME_NOT_ACTIVE: "当前不在对局中",
    ErrorCode.RATE_LIMITED: "消息发送过于频繁",
    ErrorCode.AUTH_FAILED: "重连凭证无效",
}


class ProtocolError(Exception):
    """可直接映射为协议 error 消息的业务异常。"""

    def __init__(self, code: ErrorCode, message: str | None = None) -> None:
        self.code = code
        self.message = message or DEFAULT_ERROR_MESSAGES[code]
        super().__init__(self.message)

    def to_message(self) -> dict[str, str]:
        return {"type": "error", "code": self.code.value, "message": self.message}


def error_code_message(code: ErrorCode) -> str:
    return DEFAULT_ERROR_MESSAGES[code]


# ---------------------------------------------------------------------------
# 字段校验
# ---------------------------------------------------------------------------


def require_str(payload: dict[str, Any], key: str) -> str:
    """取必填字符串字段；缺失或类型错误回 INVALID_MESSAGE。"""
    value = payload.get(key)
    if not isinstance(value, str):
        raise ProtocolError(ErrorCode.INVALID_MESSAGE, f"字段 {key} 缺失或不是字符串")
    return value


def optional_str(payload: dict[str, Any], key: str, default: str | None = None) -> str | None:
    """取可选字符串字段；缺省返回 default，类型错误回 INVALID_MESSAGE。"""
    if key not in payload or payload[key] is None:
        return default
    value = payload[key]
    if not isinstance(value, str):
        raise ProtocolError(ErrorCode.INVALID_MESSAGE, f"字段 {key} 不是字符串")
    return value


def require_int(payload: dict[str, Any], key: str) -> int:
    """取必填整数字段（bool 不算整数）。"""
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProtocolError(ErrorCode.INVALID_MESSAGE, f"字段 {key} 缺失或不是整数")
    return value


def validate_player_name(raw: str) -> str:
    """昵称：去首尾空白后 1–16 个字符。"""
    name = raw.strip()
    if not name or len(name) > NAME_MAX_LENGTH:
        raise ProtocolError(ErrorCode.INVALID_NAME)
    return name


def validate_room_name(raw: str) -> str:
    """房间名：去首尾空白后 0–24 个字符；空串表示由服务端自动命名。"""
    room_name = raw.strip()
    if len(room_name) > ROOM_NAME_MAX_LENGTH:
        raise ProtocolError(ErrorCode.INVALID_ROOM_NAME)
    return room_name


def validate_chat_text(raw: str) -> str:
    """聊天内容：去首尾空白后 1–200 个字符。"""
    text = raw.strip()
    if not text or len(text) > CHAT_TEXT_MAX_LENGTH:
        raise ProtocolError(
            ErrorCode.INVALID_MESSAGE,
            f"聊天内容需为 1–{CHAT_TEXT_MAX_LENGTH} 个字符",
        )
    return text


def validate_visibility(raw: str) -> str:
    if raw not in VISIBILITIES:
        raise ProtocolError(ErrorCode.INVALID_MESSAGE, "visibility 只能是 public 或 private")
    return raw


def validate_color(raw: str) -> str:
    if raw not in CREATE_COLORS:
        raise ProtocolError(ErrorCode.INVALID_MESSAGE, "color 只能是 black、white 或 random")
    return raw
