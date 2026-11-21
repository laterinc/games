"""SPA 静态资源托管：生产模式下由后端同端口提供 web/dist。"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse

logger = logging.getLogger(__name__)

_INDEX_CACHE_CONTROL = "no-cache, no-store, must-revalidate"
_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"
_DEFAULT_CACHE_CONTROL = "public, max-age=3600"
_NOT_FOUND_BODY = {"error": "NOT_FOUND", "message": "接口不存在"}


def _is_api_path(path: str) -> bool:
    return path == "api" or path.startswith("api/")


def _is_ws_path(path: str) -> bool:
    return path == "ws" or path.startswith("ws/")


def _register_disabled(app: FastAPI, reason: str) -> None:
    """静态托管关闭时，为非 API 路径返回明确 JSON，避免误导成接口 404。"""

    @app.get("/{full_path:path}", include_in_schema=False, response_model=None)
    async def static_disabled(full_path: str) -> JSONResponse:
        if _is_api_path(full_path):
            return JSONResponse(status_code=404, content=_NOT_FOUND_BODY)
        return JSONResponse(
            status_code=404,
            content={
                "error": "STATIC_DISABLED",
                "message": f"静态托管未启用（{reason}）：本服务只提供 /api 与 /ws，前端请由 Nginx/CDN 托管",
            },
        )


def register_static(app: FastAPI, web_dist: Path, *, enabled: bool = True) -> bool:
    """注册静态托管与 SPA 兜底；关闭或 dist 不存在时只禁用静态，不影响 API/WS。

    ``SERVE_STATIC=0`` 用于「Nginx 直接托管前端、后端只做 API/WS」的部署方式。
    返回是否启用了静态托管。
    """
    if not enabled:
        logger.info("静态托管已按 SERVE_STATIC=0 关闭，仅提供 /api 与 /ws")
        _register_disabled(app, "SERVE_STATIC=0")
        return False

    dist = Path(web_dist)
    index_file = dist / "index.html"
    if not dist.is_dir() or not index_file.is_file():
        logger.warning(
            "前端构建产物不存在（%s），静态托管已禁用；"
            "请构建 web/ 后重启，或设 SERVE_STATIC=0 交由 Nginx/CDN 托管前端",
            dist,
        )

        @app.get("/{full_path:path}", include_in_schema=False, response_model=None)
        async def spa_not_built(full_path: str) -> JSONResponse:
            if _is_api_path(full_path):
                return JSONResponse(status_code=404, content=_NOT_FOUND_BODY)
            return JSONResponse(
                status_code=404,
                content={
                    "error": "STATIC_NOT_BUILT",
                    "message": "前端构建产物缺失（web/dist），请先构建前端",
                },
            )

        return False

    dist_root = dist.resolve()

    @app.get("/{full_path:path}", include_in_schema=False, response_model=None)
    async def spa_fallback(full_path: str) -> FileResponse | JSONResponse:
        if _is_api_path(full_path) or _is_ws_path(full_path):
            return JSONResponse(status_code=404, content=_NOT_FOUND_BODY)

        if full_path:
            candidate = (dist / full_path).resolve()
            try:
                candidate.relative_to(dist_root)
            except ValueError:  # 路径穿越
                candidate = dist_root / "__forbidden__"
            if candidate.is_file():
                if full_path.startswith("assets/"):
                    cache_control = _ASSET_CACHE_CONTROL
                else:
                    cache_control = _DEFAULT_CACHE_CONTROL
                return FileResponse(candidate, headers={"Cache-Control": cache_control})

        # SPA 兜底：未知路径一律返回 index.html（/api、/ws 已在上面排除）
        return FileResponse(index_file, headers={"Cache-Control": _INDEX_CACHE_CONTROL})

    logger.info("静态托管已启用：%s", dist_root)
    return True
