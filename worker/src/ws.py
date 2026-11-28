"""Workers WebSocket 连接包装：JSON/二进制发送、限流、空闲计时。"""

from __future__ import annotations

import asyncio
import collections
import json
import logging
import time
from typing import Any

from app.protocol import RATE_LIMIT_MAX_MESSAGES, RATE_LIMIT_WINDOW_SECONDS

logger = logging.getLogger(__name__)


class WorkerConnection:
    """单条 Workers WebSocket 连接。"""

    __slots__ = (
        "ws",
        "player_id",
        "_send_lock",
        "_rate_window",
        "last_seen",
        "closed",
        "proxies",
        "idle_task",
    )

    def __init__(self, ws: Any, player_id: str) -> None:
        self.ws = ws
        self.player_id = player_id
        self._send_lock = asyncio.Lock()
        self._rate_window: collections.deque[float] = collections.deque()
        self.last_seen = time.monotonic()
        self.closed = False
        self.proxies: tuple[Any, ...] = ()
        self.idle_task: asyncio.Task[None] | None = None

    def touch(self) -> None:
        self.last_seen = time.monotonic()

    async def send(self, message: dict[str, Any]) -> bool:
        payload = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        async with self._send_lock:
            if self.closed:
                return False
            try:
                self.ws.send(payload)
                return True
            except Exception:  # noqa: BLE001 - 连接已断，忽略
                logger.debug("发送 JSON 失败（连接可能已断开）", exc_info=True)
                return False

    async def send_bytes(self, data: bytes) -> bool:
        async with self._send_lock:
            if self.closed:
                return False
            try:
                # 必须显式转成 JS Uint8Array；直接把 Python bytes 传给 ws.send()
                # 会被运行时序列化成 "b'...'" 字符串，客户端收到的是文本帧。
                from pyodide.ffi import to_js

                self.ws.send(to_js(data))
                return True
            except Exception:  # noqa: BLE001
                logger.debug("发送二进制帧失败（连接可能已断开）", exc_info=True)
                return False

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = True
        try:
            self.ws.close(code, reason)
        except Exception:  # noqa: BLE001
            pass

    def allow_message(self) -> bool:
        now = time.monotonic()
        window = self._rate_window
        while window and now - window[0] > RATE_LIMIT_WINDOW_SECONDS:
            window.popleft()
        window.append(now)
        return len(window) <= RATE_LIMIT_MAX_MESSAGES
