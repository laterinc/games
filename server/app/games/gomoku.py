"""五子棋规则插件（沿用 app/game.py 的棋盘算法与 app/ai.py 的启发式 AI）。"""

from __future__ import annotations

import random
from typing import Any

from .. import ai, game
from ..protocol import ErrorCode, ProtocolError, now_ms
from .base import GameRules


class GomokuRules(GameRules):
    key = "gomoku"
    name = "五子棋"
    colors = ("black", "white")
    create_colors = ("black", "white", "random")

    def __init__(self, *, board_size: int = 15) -> None:
        self.board_size = board_size

    def new_game(self, *, board_size: int | None = None) -> dict[str, Any]:
        size = board_size or self.board_size
        return {
            "boardSize": size,
            "board": game.empty_board(size),
            "currentTurn": self.colors[0],
            "lastMove": None,
            "moves": [],
            "winner": None,
            "winLine": None,
            "endedReason": None,
            "startedAt": None,
            "endedAt": None,
        }

    def apply_move(self, state: dict[str, Any], color: str, move: dict[str, Any]) -> None:
        move = self.require_move_object(move)
        row = move.get("row")
        col = move.get("col")
        if isinstance(row, bool) or isinstance(col, bool) or not isinstance(row, int) or not isinstance(col, int):
            raise ProtocolError(ErrorCode.INVALID_MOVE, "落子坐标必须是整数")
        if not isinstance(color, str) or color not in self.colors:
            raise ProtocolError(ErrorCode.INVALID_MOVE)
        if color != self.turn(state):
            raise ProtocolError(ErrorCode.NOT_YOUR_TURN)
        board = state["board"]
        if not game.is_empty(board, row, col):
            raise ProtocolError(ErrorCode.INVALID_MOVE)

        game.place(board, row, col, color)
        at = now_ms()
        state["moves"].append({"row": row, "col": col, "color": color, "at": at})
        state["lastMove"] = {"row": row, "col": col}
        state["updatedAt"] = at
        win_line = game.check_win(board, row, col)
        if win_line is not None:
            state["winner"] = color
            state["winLine"] = win_line
            state["endedReason"] = "five"
            state["endedAt"] = at
        elif game.is_board_full(board):
            state["winner"] = None
            state["endedReason"] = "draw"
            state["endedAt"] = at
        else:
            state["currentTurn"] = self.opposite(color)

    def ai_move(self, state: dict[str, Any], color: str) -> dict[str, Any] | None:
        target = ai.choose_move(state["board"], color)
        if target is None:
            return None
        return {"row": target[0], "col": target[1]}

    def undo(self, state: dict[str, Any]) -> bool:
        moves = state.get("moves") or []
        if not moves:
            return False
        removed = moves.pop()
        state["board"][removed["row"]][removed["col"]] = game.EMPTY
        state["currentTurn"] = removed["color"]
        state["lastMove"] = (
            {"row": moves[-1]["row"], "col": moves[-1]["col"]} if moves else None
        )
        state["winner"] = None
        state["winLine"] = None
        state["endedReason"] = None
        state["endedAt"] = None
        state["updatedAt"] = now_ms()
        return True

    def legal_moves(self, state: dict[str, Any]) -> list[dict[str, Any]]:
        # 五子棋没有"合法走法"限制，前端不需要提示
        return []


__all__ = ["GomokuRules"]
