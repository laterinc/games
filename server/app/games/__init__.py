"""游戏注册表：新增小游戏只需实现 GameRules 并登记到 build_registry。"""

from __future__ import annotations

from .base import GameRules
from .chess import ChessRules
from .gomoku import GomokuRules


def build_registry(*, gomoku_board_size: int = 15) -> dict[str, GameRules]:
    return {
        "gomoku": GomokuRules(board_size=gomoku_board_size),
        "chess": ChessRules(),
    }


__all__ = ["GameRules", "build_registry", "GomokuRules", "ChessRules"]
