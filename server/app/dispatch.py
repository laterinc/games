"""WebSocket 协议消息解析与分发（不依赖 FastAPI，Workers 与 ASGI 共用）。

传输层只需提供带 ``player_id`` 与 ``async send(dict)`` 的连接对象，
即可复用同一套消息处理逻辑。
"""

from __future__ import annotations

import json
import logging
from typing import Any, Protocol

from .protocol import (
    ErrorCode,
    ProtocolError,
    error_code_message,
    now_ms,
    optional_str,
    require_bool,
    require_int,
    require_str,
    validate_board_size,
    validate_chat_text,
    validate_color,
    validate_mode,
    validate_player_name,
    validate_room_name,
    validate_visibility,
)
from .rooms import RoomManager

logger = logging.getLogger(__name__)


class DispatchConnection(Protocol):
    """分发器需要的连接能力。"""

    player_id: str

    async def send(self, message: dict[str, Any]) -> bool: ...


async def _send_error(
    connection: DispatchConnection, code: ErrorCode, message: str | None = None
) -> None:
    await connection.send(
        {"type": "error", "code": code.value, "message": message or error_code_message(code)}
    )


def _parse_message(raw: str) -> dict[str, Any]:
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ProtocolError(ErrorCode.INVALID_MESSAGE, "JSON 解析失败") from exc
    if not isinstance(payload, dict):
        raise ProtocolError(ErrorCode.INVALID_MESSAGE, "消息必须是 JSON 对象")
    msg_type = payload.get("type")
    if not isinstance(msg_type, str) or not msg_type:
        raise ProtocolError(ErrorCode.INVALID_MESSAGE, "缺少 type 字段")
    return payload


class MessageDispatcher:
    """把客户端消息分派到 RoomManager；所有业务异常都转成协议 error。"""

    def __init__(self, manager: RoomManager, hub: Any) -> None:
        self._manager = manager
        self._hub = hub

    async def handle(self, connection: DispatchConnection, raw: str) -> None:
        try:
            payload = _parse_message(raw)
            await self._dispatch(connection, payload)
        except ProtocolError as exc:
            await connection.send(exc.to_message())
        except Exception:  # noqa: BLE001 - 保证单条消息异常不炸掉连接
            logger.exception("处理消息时发生未预期错误")
            await _send_error(connection, ErrorCode.INVALID_MESSAGE, "服务器内部错误，请重试")

    async def _dispatch(self, connection: DispatchConnection, payload: dict[str, Any]) -> None:
        msg_type = payload["type"]
        if msg_type == "ping":
            await connection.send({"type": "pong", "t": now_ms()})
        elif msg_type == "list_rooms":
            game_type = optional_str(payload, "gameType", "") or None
            await connection.send(
                {"type": "rooms", "rooms": self._manager.rooms_snapshot(game_type)}
            )
        elif msg_type == "create_room":
            await self._handle_create_room(connection, payload)
        elif msg_type == "join_room":
            await self._handle_join_room(connection, payload)
        elif msg_type == "watch_room":
            await self._handle_watch_room(connection, payload)
        elif msg_type == "quick_match":
            await self._handle_quick_match(connection, payload)
        elif msg_type == "ready":
            await self._manager.ready(connection.player_id)
        elif msg_type == "move":
            await self._manager.move(connection.player_id, move=payload)
        elif msg_type == "rematch":
            await self._manager.rematch(connection.player_id)
        elif msg_type == "resign":
            await self._manager.resign(connection.player_id)
        elif msg_type == "undo_request":
            await self._manager.undo_request(connection.player_id)
        elif msg_type == "undo_response":
            await self._manager.undo_response(
                connection.player_id, accept=require_bool(payload, "accept")
            )
        elif msg_type == "leave_room":
            await self._manager.leave_room(connection.player_id)
        elif msg_type == "chat":
            text = validate_chat_text(require_str(payload, "text"))
            await self._manager.chat(connection.player_id, text=text)
        else:
            raise ProtocolError(ErrorCode.UNKNOWN_TYPE)

    async def _handle_create_room(
        self, connection: DispatchConnection, payload: dict[str, Any]
    ) -> None:
        name = validate_player_name(require_str(payload, "name"))
        room_name = validate_room_name(optional_str(payload, "roomName", "") or "")
        visibility = validate_visibility(optional_str(payload, "visibility", "public") or "public")
        color = validate_color(optional_str(payload, "color", "black") or "black")
        mode = validate_mode(optional_str(payload, "mode", "pvp") or "pvp")
        game_type = optional_str(payload, "gameType", "gomoku") or "gomoku"
        raw_board_size = payload.get("boardSize")
        board_size = validate_board_size(raw_board_size) if raw_board_size is not None else None
        raw_bot_difficulty = payload.get("botDifficulty")
        bot_difficulty: str | None = None
        if raw_bot_difficulty is not None:
            if raw_bot_difficulty not in ("easy", "normal", "hard"):
                raise ProtocolError(ErrorCode.INVALID_MESSAGE, "botDifficulty 只能是 easy/normal/hard")
            bot_difficulty = str(raw_bot_difficulty)
        raw_bot_count = payload.get("botCount")
        bot_count: int | None = None
        if raw_bot_count is not None:
            if isinstance(raw_bot_count, bool) or not isinstance(raw_bot_count, int):
                raise ProtocolError(ErrorCode.INVALID_MESSAGE, "botCount 必须是整数")
            if not 1 <= raw_bot_count <= 7:
                raise ProtocolError(ErrorCode.INVALID_MESSAGE, "botCount 只能是 1–7")
            bot_count = raw_bot_count
        raw_match_seconds = payload.get("matchSeconds")
        match_seconds: int | None = None
        if raw_match_seconds is not None:
            if isinstance(raw_match_seconds, bool) or not isinstance(raw_match_seconds, int):
                raise ProtocolError(ErrorCode.INVALID_MESSAGE, "matchSeconds 必须是整数秒")
            match_seconds = raw_match_seconds
        await self._manager.create_room(
            connection.player_id,
            name=name,
            room_name=room_name,
            visibility=visibility,
            color=color,
            mode=mode,
            game_type=game_type,
            board_size=board_size,
            bot_count=bot_count,
            bot_difficulty=bot_difficulty,
            match_seconds=match_seconds,
        )

    async def _handle_join_room(self, connection: DispatchConnection, payload: dict[str, Any]) -> None:
        room_id = require_str(payload, "roomId")
        name = validate_player_name(require_str(payload, "name"))
        await self._manager.join_room(connection.player_id, room_id=room_id, name=name)

    async def _handle_watch_room(
        self, connection: DispatchConnection, payload: dict[str, Any]
    ) -> None:
        room_id = require_str(payload, "roomId")
        name = validate_player_name(require_str(payload, "name"))
        await self._manager.watch_room(connection.player_id, room_id=room_id, name=name)

    async def _handle_quick_match(
        self, connection: DispatchConnection, payload: dict[str, Any]
    ) -> None:
        name = validate_player_name(require_str(payload, "name"))
        game_type = optional_str(payload, "gameType", "gomoku") or "gomoku"
        await self._manager.quick_match(connection.player_id, name=name, game_type=game_type)


