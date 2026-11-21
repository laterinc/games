"""中国象棋规则引擎测试：走子、将军/将死/困毙、悔棋与 AI。"""

from __future__ import annotations

from typing import Any

import pytest

from app.games.chess import ChessRules
from app.protocol import ErrorCode, ProtocolError


def _empty_board() -> list[list[str | None]]:
    return [[None for _ in range(9)] for _ in range(10)]


def _state(board: list[list[str | None]], turn: str = "red") -> dict[str, Any]:
    rules = ChessRules()
    state = rules.new_game()
    state["board"] = board
    state["currentTurn"] = turn
    state["moves"] = []
    state["lastMove"] = None
    state["winner"] = None
    state["endedReason"] = None
    state["endedAt"] = None
    state["captured"] = {"red": [], "black": []}
    rules._refresh(state)  # noqa: SLF001 - 测试需要从构造局面重建合法走法
    return state


def _legal_pairs(state: dict[str, Any]) -> set[tuple[int, int, int, int]]:
    return {
        (move["from"]["row"], move["from"]["col"], move["to"]["row"], move["to"]["col"])
        for move in state["legalMoves"]
    }


def _base_board() -> list[list[str | None]]:
    board = _empty_board()
    board[9][4] = "K"
    board[0][3] = "k"
    return board


# ----------------------------------------------------------------------
# 初始局面与基础走法
# ----------------------------------------------------------------------


def test_initial_board_and_legal_moves() -> None:
    rules = ChessRules()
    state = rules.new_game()
    assert state["currentTurn"] == "red"
    assert state["board"][0][:9] == ["r", "n", "b", "a", "k", "a", "b", "n", "r"]
    assert state["board"][9][:9] == ["R", "N", "B", "A", "K", "A", "B", "N", "R"]
    assert state["board"][3][0] == "p" and state["board"][6][0] == "P"
    assert state["board"][2][1] == "c" and state["board"][7][1] == "C"
    assert len(state["legalMoves"]) == 44
    assert _legal_pairs(state)


def test_rook_moves_and_blocking() -> None:
    board = _base_board()
    board[5][4] = "R"
    board[5][1] = "p"
    state = _state(board)
    pairs = _legal_pairs(state)
    assert (5, 4, 5, 1) in pairs       # 吃子
    assert (5, 4, 5, 0) not in pairs   # 不能越子
    assert (5, 4, 5, 6) in pairs


def test_horse_leg_is_blocked() -> None:
    board = _base_board()
    board[5][4] = "N"
    board[4][4] = "P"  # 蹩马腿
    state = _state(board)
    pairs = _legal_pairs(state)
    assert (5, 4, 3, 5) not in pairs
    assert (5, 4, 4, 2) in pairs


def test_elephant_eye_and_river() -> None:
    board = _base_board()
    board[7][2] = "B"
    state = _state(board)
    pairs = _legal_pairs(state)
    assert (7, 2, 5, 4) in pairs

    board[6][3] = "P"  # 塞象眼
    state = _state(board)
    assert (7, 2, 5, 4) not in _legal_pairs(state)

    board = _base_board()
    board[5][2] = "B"  # 红相不能过河到 row3
    state = _state(board)
    assert (5, 2, 3, 4) not in _legal_pairs(state)

    board = _base_board()
    board[4][2] = "b"  # 黑象不能过河到 row6
    state = _state(board, "black")
    assert (4, 2, 6, 4) not in _legal_pairs(state)


def test_advisor_and_king_stay_in_palace() -> None:
    board = _base_board()
    board[9][3] = "A"
    state = _state(board)
    pairs = _legal_pairs(state)
    assert (9, 4, 9, 3) in pairs or (9, 4, 9, 5) in pairs
    assert (9, 4, 8, 4) in pairs
    assert (9, 3, 8, 4) in pairs
    assert (9, 3, 7, 2) not in pairs


def test_cannon_screen_and_capture() -> None:
    board = _base_board()
    board[5][0] = "C"
    board[5][1] = "P"   # 炮架
    board[5][3] = "r"   # 目标
    state = _state(board)
    pairs = _legal_pairs(state)
    assert (5, 0, 5, 3) in pairs       # 隔一子吃
    assert (5, 0, 5, 2) not in pairs   # 有炮架时不能走到炮架与目标之间

    board[5][1] = None  # 无炮架，不能吃
    state = _state(board)
    pairs = _legal_pairs(state)
    assert (5, 0, 5, 3) not in pairs
    assert (5, 0, 5, 2) in pairs


def test_pawn_before_and_after_river() -> None:
    board = _base_board()
    board[6][0] = "P"
    state = _state(board)
    pairs = _legal_pairs(state)
    assert (6, 0, 5, 0) in pairs
    assert (6, 0, 6, 1) not in pairs

    board[6][0] = None
    board[4][0] = "P"  # 已过河
    state = _state(board)
    pairs = _legal_pairs(state)
    assert (4, 0, 3, 0) in pairs
    assert (4, 0, 4, 1) in pairs
    assert (4, 0, 5, 0) not in pairs  # 不能后退


def test_cannot_leave_king_in_check() -> None:
    board = _base_board()
    board[0][4] = None
    board[0][3] = None
    board[0][4] = "r"  # 黑车直照红帅
    board[5][0] = "R"
    state = _state(board)
    pairs = _legal_pairs(state)
    assert (5, 0, 5, 4) in pairs       # 可垫在将帅之间
    assert (5, 0, 4, 0) not in pairs   # 不解除将军的走法不合法


def test_kings_facing_is_illegal() -> None:
    board = _empty_board()
    board[9][4] = "K"
    board[0][4] = "k"  # 将帅照面，红方正在被将军
    board[5][0] = "R"
    state = _state(board)
    pairs = _legal_pairs(state)
    assert (5, 0, 5, 4) in pairs
    assert (5, 0, 4, 0) not in pairs


def test_checkmate_detection() -> None:
    board = _empty_board()
    board[0][4] = "k"
    board[1][4] = "p"   # 挡住将帅照面，且无法解将
    board[2][0] = "R"
    board[2][8] = "R"
    board[9][4] = "K"
    state = _state(board)
    rules = ChessRules()
    # 红车沉底将军
    rules.apply_move(state, "red", {"from": {"row": 2, "col": 0}, "to": {"row": 0, "col": 0}})
    assert state["winner"] == "red"
    assert state["endedReason"] == "checkmate"
    assert state["legalMoves"] == []


def test_stalemate_is_loss_for_side_to_move() -> None:
    board = _empty_board()
    board[0][4] = "k"
    board[1][3] = "R"
    board[1][5] = "R"
    board[6][4] = "P"  # 挡住将帅照面
    board[9][4] = "K"
    state = _state(board)
    rules = ChessRules()
    rules.apply_move(state, "red", {"from": {"row": 6, "col": 4}, "to": {"row": 5, "col": 4}})
    assert state["winner"] == "red"
    assert state["endedReason"] == "stalemate"
    assert state["legalMoves"] == []


def test_undo_restores_board_turn_and_captures() -> None:
    rules = ChessRules()
    state = rules.new_game()
    rules.apply_move(state, "red", {"from": {"row": 7, "col": 1}, "to": {"row": 7, "col": 4}})
    before = [line[:] for line in state["board"]]
    rules.apply_move(state, "black", {"from": {"row": 0, "col": 1}, "to": {"row": 2, "col": 2}})
    assert rules.undo(state) is True
    assert state["currentTurn"] == "black"
    assert state["moves"][-1]["color"] == "red"
    assert state["board"] == before  # 撤回黑方一步，棋盘回到黑方走之前
    assert rules.undo(state) is True
    assert rules.undo(state) is False


def test_ai_prefers_free_capture_and_returns_legal_move() -> None:
    board = _base_board()
    board[5][0] = "R"
    board[5][4] = "r"  # 黑车无保护，红车可白吃
    state = _state(board)
    rules = ChessRules()
    move = rules.ai_move(state, "red")
    assert move is not None
    assert move["from"] == {"row": 5, "col": 0}
    assert move["to"] == {"row": 5, "col": 4}
    assert (
        move["from"]["row"], move["from"]["col"], move["to"]["row"], move["to"]["col"]
    ) in _legal_pairs(state)


def test_invalid_move_raises_and_state_unchanged() -> None:
    rules = ChessRules()
    state = rules.new_game()
    snapshot = [line[:] for line in state["board"]]
    with pytest.raises(ProtocolError) as exc:
        rules.apply_move(state, "black", {"from": {"row": 3, "col": 0}, "to": {"row": 4, "col": 0}})
    assert exc.value.code == ErrorCode.NOT_YOUR_TURN
    with pytest.raises(ProtocolError) as exc2:
        rules.apply_move(state, "red", {"from": {"row": 7, "col": 1}, "to": {"row": 9, "col": 1}})
    assert exc2.value.code == ErrorCode.INVALID_MOVE
    assert state["board"] == snapshot
    assert state["moves"] == []


def test_legal_moves_are_empty_after_finish() -> None:
    rules = ChessRules()
    state = rules.new_game()
    rules.finish(state, "red", "resign")
    assert rules.legal_moves(state) == []
