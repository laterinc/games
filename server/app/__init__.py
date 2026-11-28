"""棋类游戏服务端核心包。

导入 ``app.protocol`` / ``app.rooms`` 等纯逻辑模块时不应加载 FastAPI；
只有显式访问 ``app.app`` / ``app.create_app`` 时才装配 ASGI 应用。
"""

from __future__ import annotations

from typing import Any

__all__ = ["app", "create_app"]


def __getattr__(name: str) -> Any:
    if name in __all__:
        from .main import app, create_app

        return {"app": app, "create_app": create_app}[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
