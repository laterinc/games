"""Cloudflare Python Worker 入口：把 HTTP / WebSocket 请求转给全局 GameHub DO。"""

from __future__ import annotations

import json
import logging

from workers import Response, WorkerEntrypoint

from hub import GameHub

logger = logging.getLogger(__name__)

__all__ = ["Default", "GameHub"]


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        try:
            stub = self.env.GAME_HUB.get(self.env.GAME_HUB.idFromName("global"))
            return await stub.fetch(request)
        except Exception:  # noqa: BLE001 - 返回可诊断的 500，而非裸异常
            logger.exception("GameHub 请求失败")
            body = json.dumps(
                {"error": "INTERNAL_ERROR", "message": "游戏服务暂不可用，请稍后重试"},
                ensure_ascii=False,
            )
            return Response(
                body,
                status=500,
                headers={"Content-Type": "application/json; charset=utf-8"},
            )
