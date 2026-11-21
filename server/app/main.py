"""FastAPI 应用装配：生命周期、REST、WebSocket 与静态托管。"""

from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import Settings
from .protocol import MAX_PLAYERS, PROTOCOL_VERSION, now_ms
from .rooms import RoomManager
from .static import register_static
from .ws import ConnectionHub, router as ws_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger(__name__)

#: waiting 房间空闲回收检查周期
_REAPER_INTERVAL_SECONDS = 60.0


async def _room_reaper(manager: RoomManager) -> None:
    while True:
        try:
            await asyncio.sleep(_REAPER_INTERVAL_SECONDS)
            await manager.reap_idle_rooms()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - 后台任务不能因单次异常退出
            logger.exception("空闲房间回收任务异常")


def create_app(settings: Settings | None = None) -> FastAPI:
    """创建 FastAPI 应用；测试可注入自定义 Settings。"""
    settings = settings or Settings.from_env()
    hub = ConnectionHub()
    manager = RoomManager(
        hub,
        board_size=settings.board_size,
        room_ttl_seconds=settings.room_ttl_seconds,
        disconnect_grace_seconds=settings.disconnect_grace_seconds,
    )
    started_at = time.time()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        reaper = asyncio.create_task(_room_reaper(manager))
        logger.info(
            "五子棋服务启动：boardSize=%d roomTtl=%ss grace=%ss webDist=%s",
            settings.board_size,
            settings.room_ttl_seconds,
            settings.disconnect_grace_seconds,
            settings.web_dist,
        )
        try:
            yield
        finally:
            reaper.cancel()
            try:
                await reaper
            except asyncio.CancelledError:
                pass
            manager.cancel_background_tasks()
            logger.info("五子棋服务已停止")

    app = FastAPI(
        title=settings.app_name,
        version=settings.version,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.hub = hub
    app.state.manager = manager
    app.state.started_at = started_at

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(ws_router)

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "version": settings.version,
            "uptimeSeconds": round(time.time() - started_at, 3),
            "rooms": manager.room_count,
            "connections": hub.connection_count,
            "serverTime": now_ms(),
        }

    @app.get("/api/rooms")
    async def rooms() -> dict[str, Any]:
        return {"rooms": manager.rooms_snapshot()}

    @app.get("/api/config")
    async def config() -> dict[str, Any]:
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "boardSize": settings.board_size,
            "maxPlayers": MAX_PLAYERS,
            "appName": settings.app_name,
        }

    @app.api_route(
        "/api/{unknown_path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
        include_in_schema=False,
        response_model=None,
    )
    async def unknown_api(unknown_path: str) -> JSONResponse:
        """未注册的 /api/* 一律返回 404 JSON（不落到 SPA 兜底）。"""
        return JSONResponse(
            status_code=404,
            content={"error": "NOT_FOUND", "message": f"接口不存在：/api/{unknown_path}"},
        )

    register_static(app, settings.web_dist)
    return app


app = create_app()


if __name__ == "__main__":  # pragma: no cover - 便捷本地启动
    import uvicorn

    _settings = Settings.from_env()
    uvicorn.run(
        "app.main:app",
        host=_settings.host,
        port=_settings.port,
        reload=False,
    )
