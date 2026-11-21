"""多游戏公共接口：房间生命周期只依赖 GameRules，新增小游戏只需注册一份规则。"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from ..protocol import ErrorCode, ProtocolError, now_ms


class GameRules(ABC):
    """单种棋类/小游戏的规则插件。

    约定：``state`` 是可直接 JSON 序列化的字典（就是下发给前端的 ``game`` 字段），
    必须包含 ``currentTurn``、``moves``、``lastMove``、``winner``、``endedReason``、
    ``startedAt``、``endedAt`` 这些公共字段。
    """

    #: 注册键，例如 "gomoku" / "chess"
    key: str
    #: 展示名
    name: str
    #: 执子颜色顺序（第一个为先手）
    colors: tuple[str, str]
    #: 创建房间允许的颜色（额外支持 "random"）
    create_colors: tuple[str, ...]
    #: 电脑落子思考时间
    ai_delay_seconds: float = 0.45

    @abstractmethod
    def new_game(self) -> dict[str, Any]:
        """返回一局新棋的初始状态。"""

    @abstractmethod
    def apply_move(self, state: dict[str, Any], color: str, move: dict[str, Any]) -> None:
        """校验并执行一步；非法时抛 ProtocolError。"""

    @abstractmethod
    def ai_move(self, state: dict[str, Any], color: str) -> dict[str, Any] | None:
        """返回电脑选中的一步；无可下时为 None。"""

    @abstractmethod
    def undo(self, state: dict[str, Any]) -> bool:
        """撤回最后一手（含棋盘/回合/终局状态）；无棋可撤返回 False。"""

    @abstractmethod
    def legal_moves(self, state: dict[str, Any]) -> list[dict[str, Any]]:
        """给前端的合法走法提示；不支持/无概念时返回空列表。"""

    # ------------------------------------------------------------------
    # 通用工具
    # ------------------------------------------------------------------

    def opposite(self, color: str) -> str:
        return self.colors[1] if color == self.colors[0] else self.colors[0]

    def turn(self, state: dict[str, Any]) -> str:
        return str(state.get("currentTurn", self.colors[0]))

    def last_move_color(self, state: dict[str, Any]) -> str | None:
        moves = state.get("moves") or []
        if not moves:
            return None
        return moves[-1].get("color")

    def is_finished(self, state: dict[str, Any]) -> bool:
        return state.get("endedReason") is not None

    def winner(self, state: dict[str, Any]) -> str | None:
        value = state.get("winner")
        return value if isinstance(value, str) else None

    def finished_reason(self, state: dict[str, Any]) -> str | None:
        value = state.get("endedReason")
        return value if isinstance(value, str) else None

    def finish(self, state: dict[str, Any], winner: str | None, reason: str) -> None:
        """认输 / 弃权 / 外部判负等直接结算。"""
        state["winner"] = winner
        state["endedReason"] = reason
        state["endedAt"] = now_ms()

    @staticmethod
    def require_move_object(move: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(move, dict):
            raise ProtocolError(ErrorCode.INVALID_MOVE, "走法格式不正确")
        return move


def require_int(payload: dict[str, Any], key: str) -> int:
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProtocolError(ErrorCode.INVALID_MOVE, f"字段 {key} 必须是整数")
    return value


def require_point(payload: dict[str, Any], key: str) -> tuple[int, int]:
    value = payload.get(key)
    if not isinstance(value, dict):
        raise ProtocolError(ErrorCode.INVALID_MOVE, f"缺少坐标 {key}")
    return require_int(value, "row"), require_int(value, "col")
