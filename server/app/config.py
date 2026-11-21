"""五子棋服务端环境变量配置。

服务端只负责 REST 与 WebSocket；前端构建产物由 Nginx / CDN / Vite 托管，
不在本进程内提供任何静态文件服务。
"""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_CORS_ORIGINS: tuple[str, ...] = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError as exc:  # pragma: no cover - 配置错误直接 fail fast
        raise ValueError(f"环境变量 {name} 必须是整数，当前为 {raw!r}") from exc


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw.strip())
    except ValueError as exc:  # pragma: no cover
        raise ValueError(f"环境变量 {name} 必须是数字，当前为 {raw!r}") from exc


def _env_csv(name: str) -> tuple[str, ...]:
    raw = os.getenv(name, "")
    return tuple(item.strip() for item in raw.split(",") if item.strip())


@dataclass(frozen=True, slots=True)
class Settings:
    """服务端运行配置。"""

    host: str = "0.0.0.0"
    port: int = 8765
    board_size: int = 15
    max_players: int = 2
    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS
    allowed_origins: tuple[str, ...] = ()
    room_ttl_seconds: float = 6 * 3600.0
    disconnect_grace_seconds: float = 60.0
    app_name: str = "五子棋"
    version: str = "1.0.0"

    def __post_init__(self) -> None:
        if self.board_size < 5:
            raise ValueError(f"BOARD_SIZE 至少为 5，当前为 {self.board_size}")
        if self.room_ttl_seconds < 0 or self.disconnect_grace_seconds < 0:
            raise ValueError("ROOM_TTL_SECONDS / DISCONNECT_GRACE_SECONDS 不能为负数")

    @classmethod
    def from_env(cls) -> "Settings":
        """从环境变量构建设置；未设置的变量使用默认值。"""
        raw_port = os.getenv("PORT") or os.getenv("APP_PORT")
        port = int(raw_port.strip()) if raw_port and raw_port.strip() else 8765

        cors_origins = _env_csv("CORS_ORIGINS")
        if not cors_origins:
            cors_origins = DEFAULT_CORS_ORIGINS

        return cls(
            host=(os.getenv("HOST") or "0.0.0.0").strip() or "0.0.0.0",
            port=port,
            board_size=_env_int("BOARD_SIZE", 15),
            cors_origins=cors_origins,
            allowed_origins=_env_csv("ALLOWED_ORIGINS"),
            room_ttl_seconds=_env_float("ROOM_TTL_SECONDS", 6 * 3600.0),
            disconnect_grace_seconds=_env_float("DISCONNECT_GRACE_SECONDS", 60.0),
        )
