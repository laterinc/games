"""棋类游戏服务端环境变量配置。

服务端只负责 REST 与 WebSocket；前端构建产物由 Nginx / CDN / Vite 托管，
不在本进程内提供任何静态文件服务。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Mapping

DEFAULT_CORS_ORIGINS: tuple[str, ...] = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)


@dataclass(frozen=True, slots=True)
class Settings:
    """服务端运行配置。"""

    board_size: int = 15
    max_players: int = 2
    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS
    allowed_origins: tuple[str, ...] = ()
    room_ttl_seconds: float = 6 * 3600.0
    disconnect_grace_seconds: float = 60.0
    app_name: str = "棋类游戏"
    version: str = "1.0.0"
    #: 坦克大战 tick 频率；Workers 版通过 TANK_TICK_RATE=10 降低单连接事件压力。
    tank_tick_rate: int = 20

    def __post_init__(self) -> None:
        if self.board_size < 5:
            raise ValueError(f"BOARD_SIZE 至少为 5，当前为 {self.board_size}")
        if self.room_ttl_seconds < 0 or self.disconnect_grace_seconds < 0:
            raise ValueError("ROOM_TTL_SECONDS / DISCONNECT_GRACE_SECONDS 不能为负数")
        if not 5 <= self.tank_tick_rate <= 60:
            raise ValueError("TANK_TICK_RATE 需在 5–60 之间")

    @classmethod
    def from_env(cls) -> "Settings":
        """从环境变量构建设置；未设置的变量使用默认值。"""
        return cls.from_mapping(os.environ)

    @classmethod
    def from_mapping(cls, values: Mapping[str, Any]) -> "Settings":
        """从任意映射构建设置（Docker 环境变量或 Workers ``env`` 绑定）。

        Workers 的 ``env`` 是 JS 代理，值可能不是 ``str``；统一转成字符串再解析。
        """

        def raw(name: str) -> str:
            value = values.get(name) if hasattr(values, "get") else getattr(values, name, None)
            return "" if value is None else str(value).strip()

        def csv(name: str) -> tuple[str, ...]:
            return tuple(item.strip() for item in raw(name).split(",") if item.strip())

        def as_int(name: str, default: int) -> int:
            value = raw(name)
            if not value:
                return default
            try:
                return int(value)
            except ValueError as exc:  # pragma: no cover - 配置错误直接 fail fast
                raise ValueError(f"环境变量 {name} 必须是整数，当前为 {value!r}") from exc

        def as_float(name: str, default: float) -> float:
            value = raw(name)
            if not value:
                return default
            try:
                return float(value)
            except ValueError as exc:  # pragma: no cover
                raise ValueError(f"环境变量 {name} 必须是数字，当前为 {value!r}") from exc

        cors_origins = csv("CORS_ORIGINS") or DEFAULT_CORS_ORIGINS
        return cls(
            board_size=as_int("BOARD_SIZE", 15),
            cors_origins=cors_origins,
            allowed_origins=csv("ALLOWED_ORIGINS"),
            room_ttl_seconds=as_float("ROOM_TTL_SECONDS", 6 * 3600.0),
            disconnect_grace_seconds=as_float("DISCONNECT_GRACE_SECONDS", 60.0),
            tank_tick_rate=as_int("TANK_TICK_RATE", 20),
        )
