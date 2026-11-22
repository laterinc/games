"""游戏注册表：新增小游戏只需实现 GameRules 并登记到 build_registry。"""

from __future__ import annotations

from .base import GameRules
from .chess import ChessRules
from .gomoku import GomokuRules
from .tank_rules import TankRules

#: 走实时 tick 循环、使用二进制输入/快照的游戏（房间层据此走不同分支）。
REALTIME_GAME_TYPES = frozenset({"tank"})


def build_registry(*, gomoku_board_size: int = 15) -> dict[str, GameRules]:
    return {
        "gomoku": GomokuRules(board_size=gomoku_board_size),
        "chess": ChessRules(),
        "tank": TankRules(),
    }


__all__ = [
    "GameRules",
    "REALTIME_GAME_TYPES",
    "build_registry",
    "GomokuRules",
    "ChessRules",
    "TankRules",
]
