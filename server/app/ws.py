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
    require_int,
    require_str,
    optional_str,
    validate_chat_text,
    validate_color,
    validate_player_name,
    validate_room_name,
    validate_visibility,
)
from .rooms import Player, RoomManager

logger = logging.getLogger(__name__)

router = APIRouter()

#: 身份 Cookie：保存 playerId.token，浏览器刷新/重开时用于恢复同一玩家
_SESSION_COOKIE = "gomoku_session"
_COOKIE_MAX_AGE = 30 * 24 * 3600


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

    def online_player_ids(self) -> list[str]:
        return list(self._connections.keys())

    @property
    def connection_count(self) -> int:
        return sum(len(connections) for connections in self._connections.values())


def _cookie_is_secure(websocket: WebSocket) -> bool:
    forwarded = websocket.headers.get("x-forwarded-proto", "")
    if forwarded.split(",")[0].strip().lower() == "https":
        return True
    return websocket.url.scheme == "wss"


def _session_cookie_header(websocket: WebSocket, value: str) -> bytes:
    parts = [
        f"{_SESSION_COOKIE}={value}",
        "Path=/",
        "HttpOnly",
        f"Max-Age={_COOKIE_MAX_AGE}",
    ]
    if _cookie_is_secure(websocket):
        # 跨站点（前端与后端不同域）且 HTTPS 时才能用 SameSite=None
        parts.extend(["Secure", "SameSite=None"])
    else:
        parts.append("SameSite=Lax")
    return "; ".join(parts).encode("latin-1")


def _welcome_message(player: Player, *, reconnected: bool) -> dict[str, Any]:
    return {
        "type": "welcome",
        "playerId": player.id,
        "token": player.token,
        "reconnected": reconnected,
        "serverTime": now_ms(),
        "protocolVersion": PROTOCOL_VERSION,
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
        if msg_type == "hello":
            await self._handle_hello(connection, payload)
        elif msg_type == "ping":
            await connection.send({"type": "pong", "t": now_ms()})
        elif msg_type == "list_rooms":
            await connection.send({"type": "rooms", "rooms": self._manager.rooms_snapshot()})
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
            row = require_int(payload, "row")
            col = require_int(payload, "col")
            await self._manager.move(connection.player_id, row=row, col=col)
        elif msg_type == "rematch":
            await self._manager.rematch(connection.player_id)
        elif msg_type == "leave_room":
            await self._manager.leave_room(connection.player_id)
        elif msg_type == "chat":
            text = validate_chat_text(require_str(payload, "text"))
            await self._manager.chat(connection.player_id, text=text)
        else:
            raise ProtocolError(ErrorCode.UNKNOWN_TYPE)

    async def _handle_hello(self, connection: ClientConnection, payload: dict[str, Any]) -> None:
        player_id = require_str(payload, "playerId")
        token = require_str(payload, "token")
        player = self._manager.authenticate(player_id, token)
        if player is None:
            raise ProtocolError(ErrorCode.AUTH_FAILED)

        previous_player_id = connection.player_id
        self._hub.rebind(connection, player.id)
        if previous_player_id != player.id:
            self._manager.discard_player(previous_player_id)

        await self._manager.mark_connected(player.id)
        await connection.send(_welcome_message(player, reconnected=True))
        room = self._manager.room_snapshot_for(player.id)
        if room is not None:
            await connection.send({"type": "room", "room": room})

    async def _handle_create_room(
        self, connection: ClientConnection, payload: dict[str, Any]
    ) -> None:
        name = validate_player_name(require_str(payload, "name"))
        room_name = validate_room_name(optional_str(payload, "roomName", "") or "")
        visibility = validate_visibility(optional_str(payload, "visibility", "public") or "public")
        color = validate_color(optional_str(payload, "color", "black") or "black")
        await self._manager.create_room(
            connection.player_id,
            name=name,
            room_name=room_name,
            visibility=visibility,
            color=color,
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
        await self._manager.quick_match(connection.player_id, name=name)


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

    # 优先用握手 Cookie 恢复身份：刷新页面/重开浏览器时即使 localStorage 丢了，
    # 也能认回同一个 player（房间座位、昵称、token 都不变）。失败则分配新匿名身份。
    restored = manager.authenticate_cookie(websocket.cookies.get(_SESSION_COOKIE))
    player = restored or manager.create_player()
    cookie_header = _session_cookie_header(websocket, manager.session_cookie_value(player))
    await websocket.accept(headers=[(b"set-cookie", cookie_header)])

    connection = ClientConnection(websocket, player.id)
    hub.rebind(connection, player.id)

    try:
        if restored is not None:
            await manager.mark_connected(player.id)
        await connection.send(_welcome_message(player, reconnected=restored is not None))
        if restored is not None:
            room = manager.room_snapshot_for(player.id)
            if room is not None:
                await connection.send({"type": "room", "room": room})
        dispatcher = MessageDispatcher(manager, hub)
        while True:
            try:
                raw = await asyncio.wait_for(
                    websocket.receive_text(), timeout=IDLE_TIMEOUT_SECONDS
                )
            except asyncio.TimeoutError:
                logger.info("连接 %s 超过 30s 无消息，主动断开", connection.player_id)
                try:
                    await websocket.close(code=1001)
                except Exception:  # noqa: BLE001
                    pass
                break
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
