"""中国象棋规则插件：完整走子规则、将军/将死/困毙判定与 alpha-beta AI。

棋盘 10 行 × 9 列，row 0 在上（黑方底线），row 9 在下（红方底线）。
红方大写 ``K A B N R C P``，黑方小写 ``k a b n r c p``。
"""

from __future__ import annotations

import time
from typing import Any

from ..protocol import ErrorCode, ProtocolError, now_ms
from .base import GameRules, require_point

ROWS = 10
COLS = 9

RED = "red"
BLACK = "black"

_COL_LETTERS = "ABCDEFGHI"

#: 初始布局（row 0 在上）
_START_LAYOUT = (
    "rnbakabnr",
    ".........",
    ".c.....c.",
    "p.p.p.p.p",
    ".........",
    ".........",
    "P.P.P.P.P",
    ".C.....C.",
    ".........",
    "RNBAKABNR",
)

_PALACE_ROWS = {RED: (7, 9), BLACK: (0, 2)}
_PALACE_COLS = (3, 5)

_ORTHO = ((1, 0), (-1, 0), (0, 1), (0, -1))
_DIAG = ((1, 1), (1, -1), (-1, 1), (-1, -1))
_KNIGHT = ((-2, -1), (-2, 1), (-1, -2), (-1, 2), (1, -2), (1, 2), (2, -1), (2, 1))

_PIECE_VALUES = {"K": 100000, "R": 900, "N": 400, "C": 450, "A": 200, "B": 200, "P": 100}
_CROSSED_PAWN_VALUE = 200

#: AI 参数：深度 3 + 时间/节点双上限，保证返回合法走法且不拖慢响应
_AI_DEPTH = 3
_AI_TIME_LIMIT = 1.0
_AI_NODE_LIMIT = 40000
_AI_MATE = 1_000_000
_AI_INF = 2 * _AI_MATE

#: 可选：240 个半回合（120 回合）自然限着和棋
_NATURAL_LIMIT_HALF_MOVES = 240


class _SearchTimeout(Exception):
    """AI 搜索超时/超节点预算时中断当前迭代。"""


def _piece_color(piece: str) -> str:
    return RED if piece.isupper() else BLACK


def _opposite(color: str) -> str:
    return BLACK if color == RED else RED


def _in_board(board: list[list[str | None]], row: int, col: int) -> bool:
    return 0 <= row < len(board) and 0 <= col < len(board[row])


def _in_palace(row: int, col: int, color: str) -> bool:
    top, bottom = _PALACE_ROWS[color]
    return top <= row <= bottom and _PALACE_COLS[0] <= col <= _PALACE_COLS[1]


def _notation(from_row: int, from_col: int, to_row: int, to_col: int) -> str:
    """坐标串：列 A-I，行按红方视角 1-10（红底线 row9 = 第 1 行）。"""
    return (
        f"{_COL_LETTERS[from_col]}{ROWS - from_row}"
        f"{_COL_LETTERS[to_col]}{ROWS - to_row}"
    )


def _initial_board() -> list[list[str | None]]:
    return [[None if ch == "." else ch for ch in line] for line in _START_LAYOUT]


class ChessRules(GameRules):
    key = "chess"
    name = "中国象棋"
    colors = (RED, BLACK)
    create_colors = (RED, BLACK, "random")
    ai_delay_seconds = 0.5

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    def new_game(self, *, board_size: int | None = None) -> dict[str, Any]:
        del board_size  # 中国象棋固定 9×10，不支持自定义。
        state: dict[str, Any] = {
            "rows": ROWS,
            "cols": COLS,
            "board": _initial_board(),
            "currentTurn": RED,
            "lastMove": None,
            "moves": [],
            "winner": None,
            "winLine": None,
            "endedReason": None,
            "startedAt": None,
            "endedAt": None,
            "check": False,
            "legalMoves": [],
            "captured": {"red": [], "black": []},
        }
        self._refresh(state)
        return state

    def apply_move(self, state: dict[str, Any], color: str, move: dict[str, Any]) -> None:
        move = self.require_move_object(move)
        if not isinstance(color, str) or color not in self.colors:
            raise ProtocolError(ErrorCode.INVALID_MOVE, "颜色不合法")
        board = state.get("board")
        if not isinstance(board, list) or not board:
            raise ProtocolError(ErrorCode.INVALID_MOVE, "棋盘状态不正确")
        if state.get("endedReason") is not None:
            raise ProtocolError(ErrorCode.INVALID_MOVE, "对局已结束")
        if color != self.turn(state):
            raise ProtocolError(ErrorCode.NOT_YOUR_TURN)

        from_row, from_col = require_point(move, "from")
        to_row, to_col = require_point(move, "to")
        rows, cols = len(board), len(board[0])
        if not (
            0 <= from_row < rows
            and 0 <= to_row < rows
            and 0 <= from_col < cols
            and 0 <= to_col < cols
        ):
            raise ProtocolError(ErrorCode.INVALID_MOVE, "坐标超出棋盘")
        piece = board[from_row][from_col]
        if piece is None:
            raise ProtocolError(ErrorCode.INVALID_MOVE, "起点没有棋子")
        if _piece_color(piece) != color:
            raise ProtocolError(ErrorCode.INVALID_MOVE, "不能移动对方的棋子")

        legal = self._legal_moves(board, color)
        legal_set = {
            (
                (item["from"]["row"], item["from"]["col"]),
                (item["to"]["row"], item["to"]["col"]),
            )
            for item in legal
        }
        if ((from_row, from_col), (to_row, to_col)) not in legal_set:
            raise ProtocolError(ErrorCode.INVALID_MOVE, "该走法不合法")

        captured_piece = board[to_row][to_col]
        board[to_row][to_col] = piece
        board[from_row][from_col] = None

        captured = self._ensure_captured(state)
        if captured_piece is not None:
            captured.setdefault(color, []).append(captured_piece)

        at = now_ms()
        state.setdefault("moves", []).append(
            {
                "from": {"row": from_row, "col": from_col},
                "to": {"row": to_row, "col": to_col},
                "piece": piece,
                "captured": captured_piece,
                "color": color,
                "notation": _notation(from_row, from_col, to_row, to_col),
                "at": at,
            }
        )
        state["lastMove"] = {
            "from": {"row": from_row, "col": from_col},
            "to": {"row": to_row, "col": to_col},
        }
        if state.get("startedAt") is None:
            state["startedAt"] = at
        state["currentTurn"] = self.opposite(color)
        state["winner"] = None
        state["winLine"] = None
        state["endedReason"] = None
        state["endedAt"] = None
        self._refresh(state)

        if not state["legalMoves"]:
            # 中国象棋：将死与困毙（无子可动）都判走子方胜
            state["winner"] = color
            state["endedReason"] = "checkmate" if state["check"] else "stalemate"
            state["endedAt"] = at
        elif len(state["moves"]) >= _NATURAL_LIMIT_HALF_MOVES:
            state["winner"] = None
            state["endedReason"] = "draw"
            state["endedAt"] = at

    def undo(self, state: dict[str, Any]) -> bool:
        moves = state.get("moves")
        if not isinstance(moves, list) or not moves:
            return False
        board = state.get("board")
        if not isinstance(board, list) or not board:
            return False
        last = moves.pop()
        try:
            from_row = last["from"]["row"]
            from_col = last["from"]["col"]
            to_row = last["to"]["row"]
            to_col = last["to"]["col"]
            piece = last["piece"]
        except (KeyError, TypeError):
            return False

        board[from_row][from_col] = piece
        board[to_row][to_col] = last.get("captured")

        captured = self._ensure_captured(state)
        captured_piece = last.get("captured")
        if captured_piece is not None:
            taken = captured.get(last.get("color"))
            if isinstance(taken, list) and taken:
                if taken[-1] == captured_piece:
                    taken.pop()
                elif captured_piece in taken:
                    taken.remove(captured_piece)

        state["currentTurn"] = last.get("color", self.colors[0])
        state["lastMove"] = (
            {"from": dict(moves[-1]["from"]), "to": dict(moves[-1]["to"])} if moves else None
        )
        state["winner"] = None
        state["winLine"] = None
        state["endedReason"] = None
        state["endedAt"] = None
        state["startedAt"] = state.get("startedAt") if moves else None
        self._refresh(state)
        return True

    def legal_moves(self, state: dict[str, Any]) -> list[dict[str, Any]]:
        board = state.get("board")
        if not isinstance(board, list) or not board:
            return []
        if state.get("endedReason") is not None:
            return []
        color = self.turn(state)
        if color not in self.colors:
            color = self.colors[0]
        return self._legal_moves(board, color)

    # ------------------------------------------------------------------
    # 状态刷新
    # ------------------------------------------------------------------

    @staticmethod
    def _ensure_captured(state: dict[str, Any]) -> dict[str, list[str]]:
        captured = state.get("captured")
        if not isinstance(captured, dict):
            captured = {}
        red = captured.get("red")
        black = captured.get("black")
        result = {
            "red": list(red) if isinstance(red, list) else [],
            "black": list(black) if isinstance(black, list) else [],
        }
        state["captured"] = result
        return result

    def _refresh(self, state: dict[str, Any]) -> None:
        board = state.get("board")
        if not isinstance(board, list) or not board:
            state["legalMoves"] = []
            state["check"] = False
            return
        state["rows"] = len(board)
        state["cols"] = len(board[0])
        state.setdefault("moves", [])
        self._ensure_captured(state)
        turn = self.turn(state)
        if turn not in self.colors:
            turn = self.colors[0]
            state["currentTurn"] = turn
        state["check"] = self._in_check(board, turn)
        if state.get("endedReason") is not None:
            state["legalMoves"] = []
        else:
            state["legalMoves"] = self._legal_moves(board, turn)

    # ------------------------------------------------------------------
    # 走法生成
    # ------------------------------------------------------------------

    def _legal_moves(
        self, board: list[list[str | None]], color: str
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        king = self._find_king(board, color)
        enemy_color = _opposite(color)
        for row in range(len(board)):
            line = board[row]
            for col in range(len(line)):
                piece = line[col]
                if piece is None or _piece_color(piece) != color:
                    continue
                for to_row, to_col in self._pseudo_moves(board, row, col):
                    captured = board[to_row][to_col]
                    board[to_row][to_col] = piece
                    board[row][col] = None
                    if piece.upper() == "K":
                        safe_king = (to_row, to_col)
                    else:
                        safe_king = king
                    safe = safe_king is None or not self._is_attacked(
                        board, safe_king[0], safe_king[1], enemy_color
                    )
                    board[row][col] = piece
                    board[to_row][to_col] = captured
                    if safe:
                        result.append(
                            {
                                "from": {"row": row, "col": col},
                                "to": {"row": to_row, "col": to_col},
                            }
                        )
        return result

    def _pseudo_moves(
        self, board: list[list[str | None]], row: int, col: int
    ) -> list[tuple[int, int]]:
        piece = board[row][col]
        if piece is None:
            return []
        color = _piece_color(piece)
        kind = piece.upper()
        moves: list[tuple[int, int]] = []

        if kind == "K":
            for dr, dc in _ORTHO:
                to_row, to_col = row + dr, col + dc
                if _in_palace(to_row, to_col, color) and self._can_land(
                    board, to_row, to_col, color
                ):
                    moves.append((to_row, to_col))
        elif kind == "A":
            for dr, dc in _DIAG:
                to_row, to_col = row + dr, col + dc
                if _in_palace(to_row, to_col, color) and self._can_land(
                    board, to_row, to_col, color
                ):
                    moves.append((to_row, to_col))
        elif kind == "B":
            for dr, dc in _DIAG:
                to_row, to_col = row + 2 * dr, col + 2 * dc
                if not _in_board(board, to_row, to_col):
                    continue
                # 相/象不过河：红方 row>=5，黑方 row<=4
                if (color == RED and to_row < 5) or (color == BLACK and to_row > 4):
                    continue
                if board[row + dr][col + dc] is not None:  # 塞象眼
                    continue
                if self._can_land(board, to_row, to_col, color):
                    moves.append((to_row, to_col))
        elif kind == "N":
            for dr, dc in _KNIGHT:
                to_row, to_col = row + dr, col + dc
                if not _in_board(board, to_row, to_col):
                    continue
                if abs(dr) == 2:
                    leg_row, leg_col = row + dr // 2, col
                else:
                    leg_row, leg_col = row, col + dc // 2
                if board[leg_row][leg_col] is not None:  # 蹩马腿
                    continue
                if self._can_land(board, to_row, to_col, color):
                    moves.append((to_row, to_col))
        elif kind == "R":
            for dr, dc in _ORTHO:
                to_row, to_col = row + dr, col + dc
                while _in_board(board, to_row, to_col):
                    target = board[to_row][to_col]
                    if target is None:
                        moves.append((to_row, to_col))
                    else:
                        if _piece_color(target) != color:
                            moves.append((to_row, to_col))
                        break
                    to_row += dr
                    to_col += dc
        elif kind == "C":
            for dr, dc in _ORTHO:
                to_row, to_col = row + dr, col + dc
                screen = False
                while _in_board(board, to_row, to_col):
                    target = board[to_row][to_col]
                    if not screen:
                        if target is None:
                            moves.append((to_row, to_col))
                        else:
                            screen = True
                    elif target is not None:
                        if _piece_color(target) != color:
                            moves.append((to_row, to_col))
                        break
                    to_row += dr
                    to_col += dc
        elif kind == "P":
            forward = -1 if color == RED else 1
            to_row, to_col = row + forward, col
            if _in_board(board, to_row, to_col) and self._can_land(
                board, to_row, to_col, color
            ):
                moves.append((to_row, to_col))
            crossed = row <= 4 if color == RED else row >= 5
            if crossed:
                for dc in (-1, 1):
                    to_row, to_col = row, col + dc
                    if _in_board(board, to_row, to_col) and self._can_land(
                        board, to_row, to_col, color
                    ):
                        moves.append((to_row, to_col))
        return moves

    @staticmethod
    def _can_land(
        board: list[list[str | None]], row: int, col: int, color: str
    ) -> bool:
        if not _in_board(board, row, col):
            return False
        target = board[row][col]
        return target is None or _piece_color(target) != color

    # ------------------------------------------------------------------
    # 将军判定
    # ------------------------------------------------------------------

    @staticmethod
    def _find_king(
        board: list[list[str | None]], color: str
    ) -> tuple[int, int] | None:
        target = "K" if color == RED else "k"
        for row, line in enumerate(board):
            for col, piece in enumerate(line):
                if piece == target:
                    return row, col
        return None

    def _in_check(self, board: list[list[str | None]], color: str) -> bool:
        king = self._find_king(board, color)
        if king is None:
            return False
        return self._is_attacked(board, king[0], king[1], _opposite(color))

    def _is_attacked(
        self,
        board: list[list[str | None]],
        row: int,
        col: int,
        by_color: str,
    ) -> bool:
        """row/col 格是否被 ``by_color`` 方攻击（含将帅照面）。"""
        enemy_rook = "R" if by_color == RED else "r"
        enemy_cannon = "C" if by_color == RED else "c"
        enemy_king = "K" if by_color == RED else "k"
        enemy_knight = "N" if by_color == RED else "n"
        enemy_pawn = "P" if by_color == RED else "p"
        rows, cols = len(board), len(board[0])

        # 车 / 将（含同列将帅照面）
        for dr, dc in _ORTHO:
            r, c, dist = row + dr, col + dc, 1
            while 0 <= r < rows and 0 <= c < cols:
                target = board[r][c]
                if target is not None:
                    if target == enemy_rook:
                        return True
                    if target == enemy_king and (dc == 0 or dist == 1):
                        return True
                    break
                r += dr
                c += dc
                dist += 1

        # 炮：与目标之间恰好一个炮架
        for dr, dc in _ORTHO:
            r, c = row + dr, col + dc
            screen = False
            while 0 <= r < rows and 0 <= c < cols:
                target = board[r][c]
                if target is not None:
                    if not screen:
                        screen = True
                    else:
                        if target == enemy_cannon:
                            return True
                        break
                r += dr
                c += dc

        # 马：反向找马并检查蹩马腿
        for dr, dc in _KNIGHT:
            knight_row, knight_col = row + dr, col + dc
            if not (0 <= knight_row < rows and 0 <= knight_col < cols):
                continue
            if board[knight_row][knight_col] != enemy_knight:
                continue
            if abs(dr) == 2:
                leg_row, leg_col = row + dr // 2, col + dc
            else:
                leg_row, leg_col = row + dr, col + dc // 2
            if board[leg_row][leg_col] is None:
                return True

        # 兵/卒：正面一步（红兵向上，黑卒向下）；过河后可横吃
        if by_color == RED:
            if 0 <= row + 1 < rows and board[row + 1][col] == enemy_pawn:
                return True
            if row <= 4:
                for dc in (-1, 1):
                    c = col + dc
                    if 0 <= c < cols and board[row][c] == enemy_pawn:
                        return True
        else:
            if 0 <= row - 1 < rows and board[row - 1][col] == enemy_pawn:
                return True
            if row >= 5:
                for dc in (-1, 1):
                    c = col + dc
                    if 0 <= c < cols and board[row][c] == enemy_pawn:
                        return True
        return False

    # ------------------------------------------------------------------
    # AI：alpha-beta + 子力评估，深度 3，时间/节点双上限
    # ------------------------------------------------------------------

    def ai_move(self, state: dict[str, Any], color: str) -> dict[str, Any] | None:
        board = state.get("board")
        if not isinstance(board, list) or not board:
            return None
        if not isinstance(color, str) or color not in self.colors:
            return None
        if state.get("endedReason") is not None:
            return None
        work = [list(line) for line in board]
        root_moves = self._legal_moves(work, color)
        if not root_moves:
            return None
        if len(root_moves) == 1:
            chosen = root_moves[0]
            return {"from": dict(chosen["from"]), "to": dict(chosen["to"])}

        deadline = time.monotonic() + _AI_TIME_LIMIT
        nodes = 0

        def evaluate(side: str) -> int:
            score = 0
            for row in range(ROWS):
                line = work[row]
                for col in range(COLS):
                    piece = line[col]
                    if piece is None:
                        continue
                    value = _PIECE_VALUES[piece.upper()]
                    if value == _PIECE_VALUES["P"]:
                        if piece == "P" and row <= 4:
                            value = _CROSSED_PAWN_VALUE
                        elif piece == "p" and row >= 5:
                            value = _CROSSED_PAWN_VALUE
                    if piece.isupper():
                        score += value
                    else:
                        score -= value
            return score if side == RED else -score

        def order(moves: list[dict[str, Any]]) -> list[dict[str, Any]]:
            def key(item: dict[str, Any]) -> int:
                to_row = item["to"]["row"]
                to_col = item["to"]["col"]
                target = work[to_row][to_col]
                if target is None:
                    return 0
                from_row = item["from"]["row"]
                from_col = item["from"]["col"]
                attacker = work[from_row][from_col]
                return (
                    _PIECE_VALUES[target.upper()] * 10
                    - _PIECE_VALUES[attacker.upper()]
                )

            return sorted(moves, key=key, reverse=True)

        def search(
            side: str, depth: int, alpha: int, beta: int, ply: int
        ) -> int:
            nonlocal nodes
            nodes += 1
            if nodes > _AI_NODE_LIMIT or time.monotonic() > deadline:
                raise _SearchTimeout
            if depth == 0:
                return evaluate(side)
            moves = self._legal_moves(work, side)
            if not moves:
                # 将死或困毙（无子可动）均判当前行棋方负
                return -_AI_MATE + ply
            for item in order(moves):
                from_row = item["from"]["row"]
                from_col = item["from"]["col"]
                to_row = item["to"]["row"]
                to_col = item["to"]["col"]
                piece = work[from_row][from_col]
                captured = work[to_row][to_col]
                work[to_row][to_col] = piece
                work[from_row][from_col] = None
                try:
                    score = -search(
                        _opposite(side), depth - 1, -beta, -alpha, ply + 1
                    )
                finally:
                    work[from_row][from_col] = piece
                    work[to_row][to_col] = captured
                if score > alpha:
                    alpha = score
                if alpha >= beta:
                    break
            return alpha

        best = root_moves[0]
        for depth in range(1, _AI_DEPTH + 1):
            alpha = -_AI_INF
            beta = _AI_INF
            local_best: dict[str, Any] | None = None
            local_score = -_AI_INF
            try:
                for item in order(root_moves):
                    from_row = item["from"]["row"]
                    from_col = item["from"]["col"]
                    to_row = item["to"]["row"]
                    to_col = item["to"]["col"]
                    piece = work[from_row][from_col]
                    captured = work[to_row][to_col]
                    work[to_row][to_col] = piece
                    work[from_row][from_col] = None
                    try:
                        score = -search(
                            _opposite(color), depth - 1, -beta, -alpha, 1
                        )
                    finally:
                        work[from_row][from_col] = piece
                        work[to_row][to_col] = captured
                    if score > local_score:
                        local_score = score
                        local_best = item
                    if score > alpha:
                        alpha = score
            except _SearchTimeout:
                if local_best is not None:
                    best = local_best
                break
            if local_best is not None:
                best = local_best
            if local_score >= _AI_MATE // 2:
                break

        return {"from": dict(best["from"]), "to": dict(best["to"])}


__all__ = ["ChessRules", "ROWS", "COLS", "RED", "BLACK"]
