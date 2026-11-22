"""WebSocket /ws：连接生命周期、消息分发、限流、心跳与重连。"""

from __future__ import annotations

import asyncio
import collections
import json
import logging
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .config import Settings
from .protocol import (
    IDLE_TIMEOUT_SECONDS,
    PROTOCOL_VERSION,
    RATE_LIMIT_MAX_MESSAGES,
    RATE_LIMIT_WINDOW_SECONDS,
    ErrorCode,
    ProtocolError,
    error_code_message,
    now_ms,
    require_bool,
    require_int,
    require_str,
    optional_str,
    validate_board_size,
    validate_chat_text,
    validate_color,
    validate_mode,
    validate_player_name,
    validate_room_name,
    validate_visibility,
)
from .games.tank import TICK_RATE as TANK_TICK_RATE
from .rooms import Player, RoomManager

logger = logging.getLogger(__name__)

router = APIRouter()

class ClientConnection:
    """单条 WS 连接：一把发送锁保证串行写，并维护 5s/40 条限流窗口。"""

    __slots__ = ("ws", "player_id", "_send_lock", "_rate_window")

    def __init__(self, websocket: WebSocket, player_id: str) -> None:
        self.ws = websocket
        self.player_id = player_id
        self._send_lock = asyncio.Lock()
        self._rate_window: collections.deque[float] = collections.deque()

    async def send(self, message: dict[str, Any]) -> bool:
        """逐条发送；单条失败只记日志，不影响其他消息与连接。"""
        payload = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        async with self._send_lock:
            try:
                await self.ws.send_text(payload)
                return True
            except Exception:  # noqa: BLE001 - 连接已断，忽略
                logger.debug("发送消息失败（连接可能已断开）", exc_info=True)
                return False

    async def send_bytes(self, data: bytes) -> bool:
        """发送二进制帧（实时对局快照）；与文本共用发送锁，保证帧不乱序。"""
        async with self._send_lock:
            try:
                await self.ws.send_bytes(data)
                return True
            except Exception:  # noqa: BLE001 - 连接已断，忽略
                logger.debug("发送二进制帧失败（连接可能已断开）", exc_info=True)
                return False

    def allow_message(self) -> bool:
        """滑动窗口限流：5 秒内最多 40 条（含当前条）。"""
        now = time.monotonic()
        window = self._rate_window
        while window and now - window[0] > RATE_LIMIT_WINDOW_SECONDS:
            window.popleft()
        window.append(now)
        return len(window) <= RATE_LIMIT_MAX_MESSAGES


class ConnectionHub:
    """playerId → 活动连接集合。

    同一 playerId 允许同时存在多个连接（多标签页/多窗口）：消息广播到该玩家的所有
    连接，最后一个连接断开时才把玩家标记为离线。这样多开标签页不会再互相顶号，
    也就不会出现「新连接踢掉旧连接 → 旧连接自动重连 → 再踢新连接」的死循环。
    """

    def __init__(self) -> None:
        self._connections: dict[str, set[ClientConnection]] = {}

    def register(self, connection: ClientConnection) -> None:
        self._connections.setdefault(connection.player_id, set()).add(connection)

    def unregister(self, connection: ClientConnection) -> bool:
        """移除连接；返回该玩家是否已经没有其它活动连接。"""
        connections = self._connections.get(connection.player_id)
        if not connections or connection not in connections:
            return False
        connections.discard(connection)
        if connections:
            return False
        self._connections.pop(connection.player_id, None)
        return True

    def rebind(self, connection: ClientConnection, player_id: str) -> None:
        """把连接绑定到（恢复的）玩家身份，不关闭该玩家已有的其它连接。"""
        previous = connection.player_id
        if previous != player_id:
            old_connections = self._connections.get(previous)
            if old_connections is not None:
                old_connections.discard(connection)
                if not old_connections:
                    self._connections.pop(previous, None)
            connection.player_id = player_id
        self._connections.setdefault(player_id, set()).add(connection)

    async def send_to_player(self, player_id: str, message: dict[str, Any]) -> None:
        for connection in list(self._connections.get(player_id, ())):
            await connection.send(message)

    async def send_bytes_to_player(self, player_id: str, data: bytes) -> None:
        for connection in list(self._connections.get(player_id, ())):
            await connection.send_bytes(data)

    def online_player_ids(self) -> list[str]:
        return list(self._connections.keys())

    @property
    def connection_count(self) -> int:
        return sum(len(connections) for connections in self._connections.values())


def _welcome_message(player: Player, *, reconnected: bool) -> dict[str, Any]:
    return {
        "type": "welcome",
        "playerId": player.id,
        "reconnected": reconnected,
        "serverTime": now_ms(),
        "protocolVersion": PROTOCOL_VERSION,
        # 实时游戏能力协商：二进制输入/快照 + tick 频率（老客户端忽略即可）。
        "binary": True,
        "tickRate": TANK_TICK_RATE,
    }


async def _send_error(connection: ClientConnection, code: ErrorCode, message: str | None = None) -> None:
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

    def __init__(self, manager: RoomManager, hub: ConnectionHub) -> None:
        self._manager = manager
        self._hub = hub

    async def handle(self, connection: ClientConnection, raw: str) -> None:
        try:
            payload = _parse_message(raw)
            await self._dispatch(connection, payload)
        except ProtocolError as exc:
            await connection.send(exc.to_message())
        except Exception:  # noqa: BLE001 - 保证单条消息异常不炸掉连接
            logger.exception("处理消息时发生未预期错误")
            await _send_error(connection, ErrorCode.INVALID_MESSAGE, "服务器内部错误，请重试")

    async def _dispatch(self, connection: ClientConnection, payload: dict[str, Any]) -> None:
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
        self, connection: ClientConnection, payload: dict[str, Any]
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

    async def _handle_join_room(self, connection: ClientConnection, payload: dict[str, Any]) -> None:
        room_id = require_str(payload, "roomId")
        name = validate_player_name(require_str(payload, "name"))
        await self._manager.join_room(connection.player_id, room_id=room_id, name=name)

    async def _handle_watch_room(
        self, connection: ClientConnection, payload: dict[str, Any]
    ) -> None:
        room_id = require_str(payload, "roomId")
        name = validate_player_name(require_str(payload, "name"))
        await self._manager.watch_room(connection.player_id, room_id=room_id, name=name)

    async def _handle_quick_match(
        self, connection: ClientConnection, payload: dict[str, Any]
    ) -> None:
        name = validate_player_name(require_str(payload, "name"))
        game_type = optional_str(payload, "gameType", "gomoku") or "gomoku"
        await self._manager.quick_match(connection.player_id, name=name, game_type=game_type)


async def _origin_allowed(websocket: WebSocket, settings: Settings) -> bool:
    """设置 ALLOWED_ORIGINS 时校验握手 Origin，否则放行。"""
    if not settings.allowed_origins:
        return True
    origin = websocket.headers.get("origin")
    return origin is not None and origin in settings.allowed_origins


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    settings: Settings = websocket.app.state.settings
    hub: ConnectionHub = websocket.app.state.hub
    manager: RoomManager = websocket.app.state.manager

    if not await _origin_allowed(websocket, settings):
        await websocket.close(code=1008)
        return

    # 身份由前端 localStorage 里的 UUID 决定：连接时通过 ?uid=<uuid> 带回。
    # 首次访问（没有 uid）时服务端生成 UUID v4，并通过 welcome 下发给前端保存。
    # 浏览器刷新 / 重开 / 多标签页只要带着同一个 UUID，就能认回同一玩家与房间座位。
    player, restored = manager.player_for_uid(websocket.query_params.get("uid"))
    await websocket.accept()

    connection = ClientConnection(websocket, player.id)
    hub.rebind(connection, player.id)

    try:
        await manager.mark_connected(player.id)
        await connection.send(_welcome_message(player, reconnected=restored))
        await connection.send(
            {"type": "records", "records": manager.player_records(player.id)}
        )
        room = manager.room_snapshot_for(player.id)
        if room is not None:
            await connection.send({"type": "room", "room": room})
        dispatcher = MessageDispatcher(manager, hub)
        while True:
            try:
                message = await asyncio.wait_for(
                    websocket.receive(), timeout=IDLE_TIMEOUT_SECONDS
                )
            except asyncio.TimeoutError:
                logger.info("连接 %s 超过 30s 无消息，主动断开", connection.player_id)
                try:
                    await websocket.close(code=1001)
                except Exception:  # noqa: BLE001
                    pass
                break
            if message.get("type") == "websocket.disconnect":
                break
            data = message.get("bytes")
            if data is not None:
                # 二进制帧只用于实时对局输入；非实时房间直接拒绝，避免无意义流量。
                if not manager.submit_binary(connection.player_id, data):
                    await _send_error(
                        connection, ErrorCode.INVALID_MESSAGE, "当前没有进行中的实时对局"
                    )
                continue
            raw = message.get("text")
            if raw is None:
                continue
            if not connection.allow_message():
                await _send_error(connection, ErrorCode.RATE_LIMITED)
                continue
            await dispatcher.handle(connection, raw)
    except WebSocketDisconnect:
        pass
    except RuntimeError as exc:
        # Starlette 在连接已被关闭时 receive_text 会抛 RuntimeError（例如客户端断开瞬间）
        logger.debug("WebSocket 已关闭：%s", exc)
    except Exception:  # noqa: BLE001 - 单个连接异常不影响服务
        logger.exception("WebSocket 连接异常")
    finally:
        if hub.unregister(connection):
            if manager.is_spectator(connection.player_id):
                # 观战不占座，断开即退出，不进入 60s 宽限
                await manager.remove_spectator(connection.player_id, notify=False)
            else:
                await manager.mark_disconnected(connection.player_id)
