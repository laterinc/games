"""game.py 纯棋盘逻辑单测。"""

from __future__ import annotations

from app import ai, game


def _board_with(black: list[tuple[int, int]], white: list[tuple[int, int]] | None = None) -> game.Board:
    board = game.empty_board(15)
    for row, col in black:
        game.place(board, row, col, "black")
    for row, col in white or []:
        game.place(board, row, col, "white")
    return board


def test_empty_board_shape_and_bounds() -> None:
    board = game.empty_board(15)
    assert len(board) == 15
    assert all(len(line) == 15 for line in board)
    assert all(cell == game.EMPTY for line in board for cell in line)
    assert game.in_bounds(board, 0, 0)
    assert game.in_bounds(board, 14, 14)
    assert not game.in_bounds(board, -1, 0)
    assert not game.in_bounds(board, 15, 14)
    assert game.is_empty(board, 7, 7)
    assert not game.is_empty(board, 15, 15)


def test_horizontal_five() -> None:
    board = _board_with([(7, 3), (7, 4), (7, 5), (7, 6), (7, 7)])
    line = game.check_win(board, 7, 7)
    assert line is not None
    assert [c["col"] for c in line] == [3, 4, 5, 6, 7]
    assert all(c["row"] == 7 for c in line)


def test_vertical_five() -> None:
    board = _board_with([(2, 4), (3, 4), (4, 4), (5, 4), (6, 4)])
    line = game.check_win(board, 6, 4)
    assert line is not None
    assert [c["row"] for c in line] == [2, 3, 4, 5, 6]


def test_diagonal_down_right_five() -> None:
    board = _board_with([(2, 2), (3, 3), (4, 4), (5, 5), (6, 6)])
    line = game.check_win(board, 4, 4)
    assert line is not None
    assert line == [
        {"row": 2, "col": 2},
        {"row": 3, "col": 3},
        {"row": 4, "col": 4},
        {"row": 5, "col": 5},
        {"row": 6, "col": 6},
    ]


def test_diagonal_down_left_five() -> None:
    board = _board_with([(2, 6), (3, 5), (4, 4), (5, 3), (6, 2)])
    line = game.check_win(board, 6, 2)
    assert line is not None
    assert line[0] == {"row": 2, "col": 6}
    assert line[-1] == {"row": 6, "col": 2}


def test_long_line_counts_as_win_and_returns_full_line() -> None:
    board = _board_with([(7, 3), (7, 4), (7, 5), (7, 6), (7, 7), (7, 8)])
    line = game.check_win(board, 7, 8)
    assert line is not None
    assert len(line) == 6


def test_edge_and_corner_five() -> None:
    top_edge = _board_with([(0, 0), (0, 1), (0, 2), (0, 3), (0, 4)])
    assert game.check_win(top_edge, 0, 0) is not None

    corner_diag = _board_with([(10, 10), (11, 11), (12, 12), (13, 13), (14, 14)])
    assert game.check_win(corner_diag, 14, 14) is not None

    bottom_edge = _board_with([(14, 10), (14, 11), (14, 12), (14, 13), (14, 14)])
    assert game.check_win(bottom_edge, 14, 14) is not None


def test_four_in_a_row_is_not_a_win() -> None:
    board = _board_with([(7, 3), (7, 4), (7, 5), (7, 6)])
    assert game.check_win(board, 7, 6) is None


def test_skipped_stone_does_not_connect() -> None:
    """中间被对手/空格隔断的"跳五"不算五连（skip）。"""
    board = _board_with([(7, 3), (7, 4), (7, 5), (7, 7), (7, 8)])
    assert game.check_win(board, 7, 8) is None

    blocked = _board_with([(7, 3), (7, 4), (7, 5), (7, 7), (7, 8)], white=[(7, 6)])
    assert game.check_win(blocked, 7, 8) is None


def test_win_detected_from_any_stone_of_line() -> None:
    board = _board_with([(7, 3), (7, 4), (7, 5), (7, 6), (7, 7)])
    for col in range(3, 8):
        line = game.check_win(board, 7, col)
        assert line is not None
        assert len(line) == 5


def test_check_win_ignores_empty_and_out_of_bounds() -> None:
    board = game.empty_board(15)
    assert game.check_win(board, 7, 7) is None
    assert game.check_win(board, -1, 7) is None
    assert game.check_win(board, 7, 15) is None


def test_would_win_does_not_mutate_board() -> None:
    board = _board_with([(7, 3), (7, 4), (7, 5), (7, 6)])
    assert game.would_win(board, 7, 7, "black") is True
    assert board[7][7] == game.EMPTY


def test_is_board_full() -> None:
    board = game.empty_board(15)
    assert not game.is_board_full(board)
    for row in range(15):
        for col in range(15):
            game.place(board, row, col, "black" if (row + col) % 2 else "white")
    assert game.is_board_full(board)


def test_full_board_without_five_is_draw_pattern() -> None:
    """满盘 2x2 块状分布无任何五连，用于和棋判定。"""
    board = game.empty_board(15)
    for row in range(15):
        for col in range(15):
            color = "black" if ((row // 2) + (col // 3)) % 2 == 0 else "white"
            game.place(board, row, col, color)

    assert game.is_board_full(board)
    for row in range(15):
        for col in range(15):
            assert game.check_win(board, row, col) is None


def test_ai_chooses_winning_move() -> None:
    board = game.empty_board(15)
    for col in range(3, 7):
        board[7][col] = game.BLACK
    move = ai.choose_move(board, "black")
    assert move in {(7, 2), (7, 7)}


def test_ai_blocks_opponent_four() -> None:
    board = game.empty_board(15)
    for col in range(3, 7):
        board[7][col] = game.BLACK
    move = ai.choose_move(board, "white")
    assert move in {(7, 2), (7, 7)}


def test_ai_opens_in_center() -> None:
    board = game.empty_board(15)
    assert ai.choose_move(board, "black") == (7, 7)
