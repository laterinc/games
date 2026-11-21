"""服务端人机对战 AI：启发式评分（进攻 + 防守），无外部依赖。"""

from __future__ import annotations

import random

from . import game

#: 候选点只考虑已有棋子周围 2 格，兼顾棋力与速度
_NEIGHBOR_RANGE = 2
_WIN_SCORE = 10**8


def _line_pattern(board: game.Board, row: int, col: int, dr: int, dc: int, stone: int) -> tuple[int, int]:
    """在 (row,col) 落子后，统计该方向连续同色数量与两端开放度。"""
    count = 1
    open_ends = 0
    for sign in (1, -1):
        r, c = row + dr * sign, col + dc * sign
        while game.in_bounds(board, r, c) and board[r][c] == stone:
            count += 1
            r += dr * sign
            c += dc * sign
        if game.in_bounds(board, r, c) and board[r][c] == game.EMPTY:
            open_ends += 1
    return count, open_ends


def _shape_score(count: int, open_ends: int) -> int:
    if count >= 5:
        return _WIN_SCORE
    if count == 4:
        return 1_000_000 if open_ends == 2 else 80_000 if open_ends == 1 else 0
    if count == 3:
        return 12_000 if open_ends == 2 else 900 if open_ends == 1 else 0
    if count == 2:
        return 600 if open_ends == 2 else 60 if open_ends == 1 else 0
    if count == 1:
        return 20 if open_ends == 2 else 4 if open_ends == 1 else 0
    return 0


def _point_score(board: game.Board, row: int, col: int, stone: int) -> int:
    score = 0
    for dr, dc in game.DIRECTIONS:
        count, open_ends = _line_pattern(board, row, col, dr, dc, stone)
        score += _shape_score(count, open_ends)
    return score


def _candidates(board: game.Board) -> list[tuple[int, int]]:
    size = len(board)
    points: set[tuple[int, int]] = set()
    for r in range(size):
        for c in range(size):
            if board[r][c] != game.EMPTY:
                continue
            near = False
            for rr in range(max(0, r - _NEIGHBOR_RANGE), min(size, r + _NEIGHBOR_RANGE + 1)):
                for cc in range(max(0, c - _NEIGHBOR_RANGE), min(size, c + _NEIGHBOR_RANGE + 1)):
                    if board[rr][cc] != game.EMPTY:
                        near = True
                        break
                if near:
                    break
            if near:
                points.add((r, c))
    if not points:
        center = size // 2
        return [(center, center)]
    return sorted(points)


def choose_move(board: game.Board, color: str) -> tuple[int, int] | None:
    """返回 AI 的落子坐标；棋盘已满返回 None。"""
    if not any(cell != game.EMPTY for line in board for cell in line):
        center = len(board) // 2
        return center, center

    my_stone = game.COLOR_TO_STONE[color]
    enemy_stone = game.WHITE if my_stone == game.BLACK else game.BLACK

    best: list[tuple[int, int]] = []
    best_score = -1
    for row, col in _candidates(board):
        attack = _point_score(board, row, col, my_stone)
        defense = _point_score(board, row, col, enemy_stone)
        score = attack * 2 + defense  # 稍偏进攻，但必须堵对手的关键点
        if score > best_score:
            best_score = score
            best = [(row, col)]
        elif score == best_score:
            best.append((row, col))

    if not best:
        return None
    return random.choice(best)
