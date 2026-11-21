"""纯棋盘逻辑：落子合法性、四方向连珠判定、满盘判定。

本模块不持有任何状态，也不依赖网络层，便于单测与复用。
"""

from __future__ import annotations

from typing import Literal, TypeAlias

Color: TypeAlias = Literal["black", "white"]
Stone: TypeAlias = int
Board: TypeAlias = list[list[int]]
Coord: TypeAlias = dict[str, int]

EMPTY: Stone = 0
BLACK: Stone = 1
WHITE: Stone = 2

COLOR_TO_STONE: dict[str, Stone] = {"black": BLACK, "white": WHITE}
STONE_TO_COLOR: dict[Stone, str] = {BLACK: "black", WHITE: "white"}
OPPOSITE_COLOR: dict[str, str] = {"black": "white", "white": "black"}

#: 判定方向：横、竖、右下斜、左下斜。
DIRECTIONS: tuple[tuple[int, int], ...] = ((0, 1), (1, 0), (1, 1), (1, -1))

WIN_LENGTH = 5


def empty_board(size: int) -> Board:
    """返回 size × size 的空棋盘（0 空 / 1 黑 / 2 白）。"""
    return [[EMPTY for _ in range(size)] for _ in range(size)]


def board_size(board: Board) -> int:
    return len(board)


def in_bounds(board: Board, row: int, col: int) -> bool:
    size = len(board)
    return 0 <= row < size and 0 <= col < size


def is_empty(board: Board, row: int, col: int) -> bool:
    return in_bounds(board, row, col) and board[row][col] == EMPTY


def is_board_full(board: Board) -> bool:
    return all(cell != EMPTY for line in board for cell in line)


def place(board: Board, row: int, col: int, color: str) -> None:
    """在棋盘上落子；调用方需先完成合法性校验。"""
    board[row][col] = COLOR_TO_STONE[color]


def check_win(board: Board, row: int, col: int) -> list[Coord] | None:
    """以 (row, col) 为终点检查是否形成 ≥5 连珠。

    返回整条连续棋子的坐标（可能长于 5，即"长连"），无胜负返回 ``None``。
    """
    if not in_bounds(board, row, col):
        return None
    stone = board[row][col]
    if stone == EMPTY:
        return None

    for dr, dc in DIRECTIONS:
        line: list[Coord] = [{"row": row, "col": col}]
        # 向正方向延伸
        r, c = row + dr, col + dc
        while in_bounds(board, r, c) and board[r][c] == stone:
            line.append({"row": r, "col": c})
            r, c = r + dr, c + dc
        # 向反方向延伸
        r, c = row - dr, col - dc
        while in_bounds(board, r, c) and board[r][c] == stone:
            line.insert(0, {"row": r, "col": c})
            r, c = r - dr, c - dc
        if len(line) >= WIN_LENGTH:
            return line
    return None


def would_win(board: Board, row: int, col: int, color: str) -> bool:
    """在副本上试落一子并判定胜负（不修改原棋盘）。"""
    trial = [line[:] for line in board]
    place(trial, row, col, color)
    return check_win(trial, row, col) is not None
