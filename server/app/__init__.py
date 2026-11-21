"""五子棋联机服务端（FastAPI + WebSocket）。"""

from .main import app, create_app

__all__ = ["app", "create_app"]
