"""坦克大战的 GameRules 适配层。

真实模拟在 ``app.games.tank.TankWorld`` 里跑（实时 tick 循环由
``app.realtime.engine.TankSession`` 驱动）；房间层只把它当作「一种游戏」来看待：
需要注册名、名字、座位颜色与一个等待阶段的 ``game`` 快照。

因此这里不做任何走子逻辑，回合制接口全部拒绝，避免房间层误用。
"""

from __future__ import annotations

from typing import Any

from ..protocol import ErrorCode, ProtocolError
from .base import GameRules
from .tank import MATCH_SECONDS, MAX_PLAYERS, TARGET_KILLS, TICK_RATE


class TankRules(GameRules):
    key = "tank"
    name = "坦克大战"
    colors = ("red", "blue")
    create_colors = ("red",)
    max_players = MAX_PLAYERS
    ai_delay_seconds = 0.0

    def new_game(self, *, board_size: int | None = None) -> dict[str, Any]:
        return {
            "phase": "waiting",
            "tickRate": TICK_RATE,
            "map": None,
            "targetKills": TARGET_KILLS,
            "matchSeconds": int(MATCH_SECONDS),
            "endsAt": None,
            "winnerId": None,
            "endedReason": None,
            "scores": {},
        }

    def apply_move(self, state: dict[str, Any], color: str, move: dict[str, Any]) -> None:
        raise ProtocolError(ErrorCode.INVALID_MOVE, "坦克大战使用实时二进制输入，不接受走子")

    def ai_move(self, state: dict[str, Any], color: str) -> dict[str, Any] | None:
        return None

    def undo(self, state: dict[str, Any]) -> bool:
        return False

    def legal_moves(self, state: dict[str, Any]) -> list[dict[str, Any]]:
        return []
