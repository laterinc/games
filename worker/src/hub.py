"""Cloudflare Workers 适配层：GameHub Durable Object + WebSocket 传输。

当前选择「单个全局 Durable Object」承载整个大厅：
- 前端协议是「一条 WebSocket 连接上复用所有房间」，改成每房间一个 DO 需要
  客户端先加入房间再换连接，改动面大；单 DO 可零协议变更迁到 Workers。
- 朋友局规模下，单 DO 足够；所有状态在 DO 内存 + asyncio 任务中，D1 只做
  玩家昵称与战绩的持久化。
- WebSocket 使用 ``server.accept()``（非休眠模式），连接期间 DO 常驻，
  从而保证坦克大战 20Hz tick、AI 延迟落子、断线宽限等定时任务继续运行。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any
from urllib.parse import parse_qs, urlparse

from js import WebSocketPair
from pyodide.ffi import create_proxy
from workers import DurableObject, Response

from app.config import Settings
from app.dispatch import MessageDispatcher
from app.games.tank import TICK_RATE as TANK_TICK_RATE
from app.rooms import RoomManager
from app.protocol import (
    IDLE_TIMEOUT_SECONDS,
    MAX_PLAYERS,
    PROTOCOL_VERSION,
    ErrorCode,
    error_code_message,
    now_ms,
)
from store import D1Store
from ws import WorkerConnection

logger = logging.getLogger(__name__)

_REAPER_INTERVAL_SECONDS = 60.0
_IDLE_CHECK_INTERVAL_SECONDS = 5.0
_CORS_ALLOW_HEADERS = "Content-Type, Accept"
_CORS_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS"


def _env_value(env: Any, name: str) -> Any:
    try:
        return getattr(env, name, None)
    except Exception:  # noqa: BLE001 - Workers env 的未定义属性可能抛错
        return None


def normalize_path(path: str) -> str:
    """去掉反向代理前缀 ``/games``，让 Worker 同时支持根路径与子路径路由。"""

    if path == "/games":
        return "/"
    if path.startswith("/games/"):
        return path[len("/games") :]
    return path or "/"


def _json_response(
    payload: Any, *, status: int = 200, headers: dict[str, str] | None = None
) -> Response:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    merged = {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    }
    if headers:
        merged.update(headers)
    return Response(body, status=status, headers=merged)


def _cors_headers(origin: str | None, allowed: tuple[str, ...]) -> dict[str, str]:
    if not origin:
        return {}
    if not allowed:
        return {}
    if "*" in allowed or origin in allowed:
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            "Vary": "Origin",
        }
    return {}


def _welcome_message(
    player: Any, *, reconnected: bool, tick_rate: int = TANK_TICK_RATE
) -> dict[str, Any]:
    return {
        "type": "welcome",
        "playerId": player.id,
        "reconnected": reconnected,
        "serverTime": now_ms(),
        "protocolVersion": PROTOCOL_VERSION,
        "binary": True,
        "tickRate": tick_rate,
    }


async def _send_error(connection: "WorkerConnection", code: ErrorCode, message: str | None = None) -> None:
    await connection.send(
        {"type": "error", "code": code.value, "message": message or error_code_message(code)}
    )


class GameHub(DurableObject):
    """单实例大厅：持有 RoomManager、所有 WebSocket 连接与定时任务。"""

    def __init__(self, ctx: Any, env: Any) -> None:
        super().__init__(ctx, env)
        self.ctx = ctx
        self.env = env
        env_values = {
            name: _env_value(env, name)
            for name in (
                "BOARD_SIZE",
                "CORS_ORIGINS",
                "ALLOWED_ORIGINS",
                "ROOM_TTL_SECONDS",
                "DISCONNECT_GRACE_SECONDS",
                "TANK_TICK_RATE",
            )
        }
        self.settings = Settings.from_mapping(env_values)
        self.store = D1Store(env)
        self.hub = WorkerHub()
        self.manager = RoomManager(
            self.hub,
            board_size=self.settings.board_size,
            room_ttl_seconds=self.settings.room_ttl_seconds,
            disconnect_grace_seconds=self.settings.disconnect_grace_seconds,
            store=self.store if self.store.available else None,
            tank_tick_rate=self.settings.tank_tick_rate,
        )
        self.dispatcher = MessageDispatcher(self.manager, self.hub)
        self._started_at = time.time()
        self._started = False
        self._message_lock = asyncio.Lock()
        self._reaper_task: asyncio.Task[None] | None = None
        self._idle_tasks: set[asyncio.Task[None]] = set()
        self._binary_received = 0
        self._binary_inputs = 0
        self._last_message_kind = ""
        self._last_msg_ms = 0.0

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    async def ensure_started(self) -> None:
        if self._started:
            return
        self._started = True
        try:
            await self.store.ensure_schema()
        except Exception:  # noqa: BLE001 - D1 不可用时继续以内存模式运行
            logger.exception("初始化 D1 表结构失败，本次降级为纯内存")

    def _ensure_reaper(self) -> None:
        """有连接时才启动房间回收循环；连接清空后任务自行退出，避免 DO 常驻计费。"""
        if self._reaper_task is not None and not self._reaper_task.done():
            return
        if self.hub.connection_count == 0:
            return
        self._reaper_task = asyncio.create_task(self._reaper_loop(), name="games-reaper")

    async def _reaper_loop(self) -> None:
        try:
            while self.hub.connection_count > 0:
                await asyncio.sleep(_REAPER_INTERVAL_SECONDS)
                await self.manager.reap_idle_rooms()
        except asyncio.CancelledError:
            return
        except Exception:  # noqa: BLE001
            logger.exception("空闲房间回收任务异常")

    # ------------------------------------------------------------------
    # HTTP / WebSocket 入口
    # ------------------------------------------------------------------

    async def fetch(self, request: Any) -> Response:
        await self.ensure_started()
        path = normalize_path(urlparse(request.url).path)
        upgrade = request.headers.get("Upgrade") or ""
        if path == "/ws" or upgrade.lower() == "websocket":
            if upgrade.lower() != "websocket":
                return _json_response(
                    {"error": "UPGRADE_REQUIRED", "message": "请使用 WebSocket 连接 /ws"},
                    status=426,
                )
            return await self._handle_websocket(request)
        return await self._handle_http(request, path)

    async def _handle_http(self, request: Any, path: str) -> Response:
        origin = request.headers.get("Origin")
        cors = _cors_headers(origin, self.settings.cors_origins)

        if request.method == "OPTIONS":
            headers = dict(cors)
            if origin and (
                not self.settings.cors_origins
                or "*" in self.settings.cors_origins
                or origin in self.settings.cors_origins
            ):
                headers.update(
                    {
                        "Access-Control-Allow-Methods": _CORS_ALLOW_METHODS,
                        "Access-Control-Allow-Headers": _CORS_ALLOW_HEADERS,
                        "Access-Control-Max-Age": "86400",
                    }
                )
            return Response(None, status=204, headers=headers)

        if path == "/api/health":
            try:
                realtime = self.manager.realtime_debug()
            except Exception:  # noqa: BLE001 - 诊断信息不能导致健康检查失败
                logger.exception("读取实时对局诊断信息失败")
                realtime = []
            payload = {
                "status": "ok",
                "runtime": "cloudflare-python-workers",
                "build": "tank-10hz-input-driven",
                "version": self.settings.version,
                "uptimeSeconds": round(time.time() - self._started_at, 3),
                "rooms": self.manager.room_count,
                "connections": self.hub.connection_count,
                "serverTime": now_ms(),
                "d1": self.store.available,
                "binaryFrames": self._binary_received,
                "binaryInputs": self._binary_inputs,
                "lastMessageKind": self._last_message_kind,
                "tankTickRate": self.settings.tank_tick_rate,
                "lastMsgMs": round(self._last_msg_ms, 2),
                "realtime": realtime,
            }
            return _json_response(payload, headers=cors)

        if path == "/api/rooms":
            game = None
            query = parse_qs(urlparse(request.url).query)
            values = query.get("game") or query.get("gameType")
            if values:
                game = values[0]
            return _json_response({"rooms": self.manager.rooms_snapshot(game)}, headers=cors)

        if path == "/api/config":
            payload = {
                "protocolVersion": PROTOCOL_VERSION,
                "boardSize": self.settings.board_size,
                "maxPlayers": MAX_PLAYERS,
                "appName": self.settings.app_name,
                "games": [
                    {
                        "key": key,
                        "name": self.manager.rules(key).name,
                        "colors": list(self.manager.rules(key).colors),
                        "createColors": list(self.manager.rules(key).create_colors),
                    }
                    for key in self.manager.game_types()
                ],
            }
            return _json_response(payload, headers=cors)

        if path == "/" or path == "":
            return _json_response(
                {
                    "service": "games-api",
                    "runtime": "cloudflare-python-workers",
                    "endpoints": ["/api/health", "/api/rooms", "/api/config", "/ws"],
                },
                headers=cors,
            )

        if path.startswith("/api/"):
            return _json_response(
                {"error": "NOT_FOUND", "message": f"接口不存在：{path}"},
                status=404,
                headers=cors,
            )

        return _json_response(
            {"error": "NOT_FOUND", "message": f"路径不存在：{path}"},
            status=404,
            headers=cors,
        )

    async def _handle_websocket(self, request: Any) -> Response:
        origin = request.headers.get("Origin")
        if self.settings.allowed_origins and origin not in self.settings.allowed_origins:
            return _json_response(
                {"error": "ORIGIN_NOT_ALLOWED", "message": "WebSocket Origin 不在白名单内"},
                status=403,
            )

        query = parse_qs(urlparse(request.url).query)
        uid = (query.get("uid") or [None])[0]
        player, restored = self.manager.player_for_uid(uid)

        client, server = WebSocketPair.new().object_values()
        # 必须在 accept 前设置：否则二进制消息默认按 Blob 投递，每条都要走一次
        # 异步 arrayBuffer() 转换，Python Worker 上会明显拖慢输入处理。
        try:
            server.binaryType = "arraybuffer"
        except Exception:  # noqa: BLE001 - 运行时可能不支持该属性
            pass
        server.accept()
        connection = WorkerConnection(server, player.id)
        self.hub.rebind(connection, player.id)

        async def on_message(event: Any) -> None:
            await self._on_message(connection, event)

        async def on_close(event: Any) -> None:
            await self._on_close(connection)

        message_proxy = create_proxy(on_message)
        close_proxy = create_proxy(on_close)
        connection.proxies = (message_proxy, close_proxy)
        try:
            server.addEventListener("message", message_proxy)
            server.addEventListener("close", close_proxy)
        except Exception:  # noqa: BLE001 - 极少数运行时没有 addEventListener
            logger.exception("注册 WebSocket 事件失败")

        await self.manager.mark_connected(player.id)
        known = await self.manager.hydrate_player(player.id)
        await connection.send(
            _welcome_message(
                player,
                reconnected=restored or known,
                tick_rate=self.settings.tank_tick_rate,
            )
        )
        await connection.send(
            {"type": "records", "records": self.manager.player_records(player.id)}
        )
        snapshot = self.manager.room_snapshot_for(player.id)
        if snapshot is not None:
            await connection.send({"type": "room", "room": snapshot})

        self._ensure_reaper()
        task = asyncio.create_task(self._idle_watch(connection), name=f"idle-{player.id}")
        self._idle_tasks.add(task)
        task.add_done_callback(self._idle_tasks.discard)
        connection.idle_task = task
        return Response(None, status=101, web_socket=client)

    # ------------------------------------------------------------------
    # WebSocket 事件
    # ------------------------------------------------------------------

    async def _on_message(self, connection: WorkerConnection, event: Any) -> None:
        started = time.time()
        connection.touch()
        data = event.data
        self._last_message_kind = "text" if isinstance(data, str) else str(data)
        if isinstance(data, str):
            if not connection.allow_message():
                await _send_error(connection, ErrorCode.RATE_LIMITED)
                return
            async with self._message_lock:
                await self.dispatcher.handle(connection, data)
            self._last_msg_ms = (time.time() - started) * 1000.0
            return

        # Workers 的 WebSocket 二进制消息默认是 Blob（浏览器同款默认值），
        # 需要先异步读成 ArrayBuffer 再转 bytes；不能直接对 Blob 做 bytes()。
        if hasattr(data, "arrayBuffer"):
            try:
                payload = _to_bytes(await data.arrayBuffer())
            except Exception:  # noqa: BLE001
                logger.exception("读取二进制 WebSocket 消息失败")
                payload = None
        else:
            payload = _to_bytes(data)
        if payload is None:
            logger.debug("忽略无法识别的 WebSocket 消息：%r", type(data))
            return
        self._binary_received += 1
        async with self._message_lock:
            if self.manager.submit_binary(connection.player_id, payload):
                self._binary_inputs += 1
                await self.manager.pump_realtime(connection.player_id)
            else:
                await _send_error(
                    connection,
                    ErrorCode.INVALID_MESSAGE,
                    "当前没有进行中的实时对局",
                )
        self._last_msg_ms = (time.time() - started) * 1000.0

    async def _on_close(self, connection: WorkerConnection) -> None:
        connection.closed = True
        task = connection.idle_task
        if task is not None and not task.done():
            task.cancel()
        for proxy in connection.proxies:
            try:
                proxy.destroy()
            except Exception:  # noqa: BLE001
                pass
        connection.proxies = ()
        if not self.hub.unregister(connection):
            return
        try:
            if self.manager.is_spectator(connection.player_id):
                await self.manager.remove_spectator(connection.player_id, notify=False)
            else:
                await self.manager.mark_disconnected(connection.player_id)
        except Exception:  # noqa: BLE001 - 断开处理失败不应留下异常
            logger.exception("处理 WebSocket 断开失败")

    async def _idle_watch(self, connection: WorkerConnection) -> None:
        try:
            while not connection.closed:
                await asyncio.sleep(_IDLE_CHECK_INTERVAL_SECONDS)
                if connection.closed:
                    return
                if time.monotonic() - connection.last_seen > IDLE_TIMEOUT_SECONDS:
                    logger.info("连接 %s 超过 %ss 无消息，主动断开", connection.player_id, IDLE_TIMEOUT_SECONDS)
                    await connection.close(1001, "idle timeout")
                    return
        except asyncio.CancelledError:
            return


def _to_bytes(value: Any) -> bytes | None:
    """把 JS 的 ArrayBuffer / Uint8Array 转成 Python bytes。"""

    try:
        converted = value.to_py() if hasattr(value, "to_py") else value
    except Exception:  # noqa: BLE001
        converted = value
    if isinstance(converted, (bytes, bytearray)):
        return bytes(converted)
    if isinstance(converted, memoryview):
        return converted.tobytes()
    if isinstance(converted, (list, tuple)):
        try:
            return bytes(converted)
        except (TypeError, ValueError):
            return None
    try:
        return bytes(converted)
    except (TypeError, ValueError):
        return None


class WorkerHub:
    """playerId → 活动连接集合；支持同一玩家多标签页。"""

    def __init__(self) -> None:
        self._connections: dict[str, set[WorkerConnection]] = {}

    def register(self, connection: WorkerConnection) -> None:
        self._connections.setdefault(connection.player_id, set()).add(connection)

    def unregister(self, connection: WorkerConnection) -> bool:
        connections = self._connections.get(connection.player_id)
        if not connections or connection not in connections:
            return False
        connections.discard(connection)
        if connections:
            return False
        self._connections.pop(connection.player_id, None)
        return True

    def rebind(self, connection: WorkerConnection, player_id: str) -> None:
        previous = connection.player_id
        if previous != player_id:
            old = self._connections.get(previous)
            if old is not None:
                old.discard(connection)
                if not old:
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


__all__ = ["GameHub", "WorkerHub", "normalize_path"]
