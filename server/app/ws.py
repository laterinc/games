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
from .dispatch import MessageDispatcher
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
