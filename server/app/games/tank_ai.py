"""坦克大战电脑对手：纯决策模块（无 asyncio / 网络 / 渲染依赖）。

每个 bot 每 tick 读一次世界实体快照，输出一帧输入（inputFlags + 炮塔绝对角度），
由 ``TankSession`` 与真人输入一起喂给 ``TankWorld.apply_input``，因此 AI 与真人
受完全相同的物理、碰撞、冷却与命中规则约束——服务端权威，不做任何"作弊"。

行为目标（v1）：
- 追击最近的敌方坦克，朝目标转向并保持距离；
- 前方有掩体/墙时换边绕行，卡住时倒车脱困；
- 炮塔带提前量瞄准（按子弹飞行时间预测），有视线才开火，并带轻微随机误差与反应延迟；
- 死亡等待复活期间不输出输入。
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Final, Literal, Sequence

from .tank import BULLET_SPEED, TANK_RADIUS, WORLD_SIZE, EntityView

INPUT_UP: Final = 1 << 0
INPUT_DOWN: Final = 1 << 1
INPUT_LEFT: Final = 1 << 2
INPUT_RIGHT: Final = 1 << 3
INPUT_FIRE: Final = 1 << 4
INPUT_BRAKE: Final = 1 << 5

U16_MAX: Final = 0xFFFF
TAU: Final = math.tau

#: 开火距离区间：太近容易打空、太远无意义。
MIN_FIRE_DISTANCE: Final = 2.5
MAX_FIRE_DISTANCE: Final = 30.0
BotDifficulty = Literal["easy", "normal", "hard"]


@dataclass(frozen=True, slots=True)
class _Profile:
    """难度档位：所有可调参数集中在这里，便于平衡。"""

    #: 基础瞄准误差（弧度）与随距离增长的系数
    aim_error_base: float
    aim_error_per_unit: float
    #: 误差重掷间隔（秒）
    aim_error_interval: tuple[float, float]
    #: 炮塔跟瞄速度（弧度/秒）
    turret_track_rate: float
    #: 反应延迟（秒）
    reaction_delay: float
    #: 开火所需对准精度（弧度）
    fire_align: float
    #: 重新选目标的间隔（秒）
    retarget_interval: float
    #: 残血时保持距离的阈值
    keep_distance: float


PROFILES: Final[dict[str, _Profile]] = {
    # 简单：慢半拍、瞄准误差大，适合休闲/新手
    "easy": _Profile(0.062, 0.0062, (0.4, 0.7), 2.2, 0.8, 0.2, 0.75, 7.5),
    # 普通：默认手感
    "normal": _Profile(0.018, 0.0016, (0.22, 0.4), 4.2, 0.22, 0.1, 0.35, 5.0),
    # 困难：几乎指哪打哪
    "hard": _Profile(0.009, 0.0008, (0.15, 0.28), 6.2, 0.1, 0.055, 0.25, 4.0),
}


def _wrap(angle: float) -> float:
    """把角度收敛到 (-π, π]。"""

    while angle > math.pi:
        angle -= TAU
    while angle <= -math.pi:
        angle += TAU
    return angle


def _angle_to_u16(angle: float) -> int:
    return int(round((angle % TAU) / TAU * U16_MAX)) & U16_MAX


@dataclass(slots=True)
class _Brain:
    slot: int
    rng: random.Random
    target_id: int | None = None
    retarget_in: float = 0.0
    target_seen: float = 0.0
    aim: float = math.pi / 2
    aim_error: float = 0.0
    aim_error_in: float = 0.0
    reaction: float = 0.0
    reverse_in: float = 0.0
    reverse_turn: int = INPUT_LEFT
    stuck: float = 0.0
    last_x: float = 0.0
    last_y: float = 0.0
    wander_in: float = 0.0
    wander_angle: float = math.pi / 2
    prev_flags: int = 0
    prev_aim_u16: int = 0


@dataclass(frozen=True, slots=True)
class _Rect:
    x0: float
    y0: float
    x1: float
    y1: float

    def inflated(self, margin: float) -> "_Rect":
        return _Rect(self.x0 - margin, self.y0 - margin, self.x1 + margin, self.y1 + margin)

    def contains(self, x: float, y: float) -> bool:
        return self.x0 <= x <= self.x1 and self.y0 <= y <= self.y1


def _to_rects(obstacles: Sequence[object]) -> tuple[_Rect, ...]:
    """把 ``info()["map"]["obstacles"]`` 的字典转成不可变矩形元组。"""

    rects: list[_Rect] = []
    for item in obstacles:
        if isinstance(item, dict):
            x = float(item.get("x", 0.0))
            y = float(item.get("y", 0.0))
            w = float(item.get("w", 0.0))
            h = float(item.get("h", 0.0))
        else:  # 兼容直接传 objects 的场景（测试里方便）
            x = float(getattr(item, "x"))
            y = float(getattr(item, "y"))
            w = float(getattr(item, "w"))
            h = float(getattr(item, "h"))
        if w <= 0.0 or h <= 0.0:
            continue
        rects.append(_Rect(x, y, x + w, y + h))
    return tuple(rects)


class TankBotController:
    """一组 bot 的决策器：每 tick 为每个 bot 产出一帧输入。"""

    def __init__(
        self,
        bots: dict[str, int],
        obstacles: Sequence[object] = (),
        *,
        seed: int | None = None,
        difficulty: str = "normal",
    ) -> None:
        self._profile = PROFILES.get(str(difficulty), PROFILES["normal"])
        self._rects = tuple(rect.inflated(TANK_RADIUS + 0.05) for rect in _to_rects(obstacles))
        self._brains: dict[str, _Brain] = {}
        for index, (player_id, slot) in enumerate(sorted(bots.items())):
            rng = random.Random(seed if seed is not None else hash(player_id) & 0xFFFFFFFF)
            self._brains[player_id] = _Brain(slot=slot, rng=rng)
            self._brains[player_id].wander_angle = rng.uniform(-math.pi, math.pi)

    # ------------------------------------------------------------------
    # 对外入口
    # ------------------------------------------------------------------

    def think(
        self, player_id: str, entities: Sequence[EntityView], dt: float
    ) -> tuple[int, int]:
        """返回 (input_flags, aim_u16)。未知玩家或已死亡时输出空输入。"""

        brain = self._brains.get(player_id)
        if brain is None:
            return 0, 0
        step = max(0.0, min(0.1, dt))

        own = self._find_own(entities, brain.slot)
        if own is None:
            # 死亡/等待复活：清空输入，避免尸体继续开火。
            brain.prev_flags = 0
            return 0, brain.prev_aim_u16
        brain.last_x = own.x
        brain.last_y = own.y

        enemies = [
            entity
            for entity in entities
            if entity.kind == 0 and entity.entity_id != own.entity_id
        ]
        target = self._pick_target(brain, enemies, step)
        if own.hp < 40 and target is not None:
            # 残血时保持距离：目标太近就边退边打
            if _distance(own, target) < self._profile.keep_distance:
                brain.reverse_in = max(brain.reverse_in, 0.5)

        flags = self._drive(brain, own, target, step)
        aim_u16 = self._aim(brain, own, target, step)
        if target is not None:
            aim_angle = math.atan2(target.y - own.y, target.x - own.x)
            distance = _distance(own, target)
            aligned = abs(_wrap(brain.aim - aim_angle)) < self._profile.fire_align
            if (
                aligned
                and MIN_FIRE_DISTANCE <= distance <= MAX_FIRE_DISTANCE
                and brain.reaction <= 0.0
                and self._line_of_sight(own.x, own.y, target.x, target.y)
            ):
                flags |= INPUT_FIRE
        brain.prev_flags = flags
        brain.prev_aim_u16 = aim_u16
        return flags, aim_u16

    # ------------------------------------------------------------------
    # 目标选择
    # ------------------------------------------------------------------

    def _find_own(self, entities: Sequence[EntityView], slot: int) -> EntityView | None:
        for entity in entities:
            if entity.kind == 0 and entity.owner_slot == slot:
                return entity
        return None

    def _pick_target(
        self, brain: _Brain, enemies: Sequence[EntityView], dt: float
    ) -> EntityView | None:
        brain.retarget_in -= dt
        brain.target_seen = max(0.0, brain.target_seen - dt)
        if brain.retarget_in <= 0.0 or brain.target_id is None:
            brain.retarget_in = self._profile.retarget_interval
            current = next(
                (enemy for enemy in enemies if enemy.entity_id == brain.target_id), None
            )
            if current is not None and _distance_to(brain, current) < 14.0:
                return current
            brain.target_id = None
            if not enemies:
                return None
            # 距离为主、残血为次：优先打近处和快死的目标。
            best = min(
                enemies,
                key=lambda enemy: _distance_to(brain, enemy) + enemy.hp * 0.04,
            )
            brain.target_id = best.entity_id
            brain.target_seen = 0.0
            brain.reaction = self._profile.reaction_delay
            return best
        target = next((enemy for enemy in enemies if enemy.entity_id == brain.target_id), None)
        if target is None:
            brain.retarget_in = 0.0
        return target

    # ------------------------------------------------------------------
    # 行驶
    # ------------------------------------------------------------------

    def _drive(
        self,
        brain: _Brain,
        own: EntityView,
        target: EntityView | None,
        dt: float,
    ) -> int:
        flags = 0
        speed = math.hypot(own.vx, own.vy)

        # 卡住检测：想走但几乎没动 → 倒车脱困
        if brain.reverse_in > 0.0:
            brain.reverse_in -= dt
            flags = INPUT_DOWN | brain.reverse_turn
            if brain.reverse_in <= 0.0:
                brain.stuck = 0.0
            return flags
        if speed < 0.6 and brain.prev_flags & INPUT_UP:
            brain.stuck += dt
            if brain.stuck > 0.7:
                brain.stuck = 0.0
                brain.reverse_in = 0.75
                brain.reverse_turn = INPUT_LEFT if brain.rng.random() < 0.5 else INPUT_RIGHT
                return INPUT_DOWN | brain.reverse_turn
        else:
            brain.stuck = max(0.0, brain.stuck - dt * 0.5)

        free_ahead = self._free_distance(own.x, own.y, own.hull, 3.4)

        # 前进受阻：比较左右两侧空间，朝更宽敞的一侧转向
        if free_ahead < 2.2 and target is not None:
            left_free = self._free_distance(own.x, own.y, own.hull + 0.75, 3.0)
            right_free = self._free_distance(own.x, own.y, own.hull - 0.75, 3.0)
            flags |= INPUT_LEFT if left_free >= right_free else INPUT_RIGHT
            if free_ahead < 1.1:
                brain.reverse_in = 0.6
                brain.reverse_turn = INPUT_LEFT if left_free >= right_free else INPUT_RIGHT
            return flags

        # 没有敌人时漫游
        if target is None:
            brain.wander_in -= dt
            if brain.wander_in <= 0.0:
                brain.wander_in = brain.rng.uniform(1.6, 3.2)
                brain.wander_angle = own.hull + brain.rng.uniform(-1.6, 1.6)
            desired = brain.wander_angle
        else:
            distance = _distance(own, target)
            lead = distance / BULLET_SPEED * 0.85
            desired = math.atan2(
                target.y + target.vy * lead - own.y,
                target.x + target.vx * lead - own.x,
            )
            if distance < 3.2 and brain.rng.random() < 0.02:
                # 贴脸时偶尔拉开，避免两车互相顶着
                brain.reverse_in = 0.4

        diff = _wrap(desired - own.hull)
        if abs(diff) > 0.1:
            flags |= INPUT_LEFT if diff > 0 else INPUT_RIGHT
        if abs(diff) > 2.1:
            # 车头方向差太多：先原地转向，不硬冲
            flags |= INPUT_BRAKE
        elif free_ahead > 1.6:
            flags |= INPUT_UP
        return flags

    def _free_distance(self, x: float, y: float, angle: float, max_distance: float) -> float:
        """沿 angle 方向探测到最近掩体/墙的距离（不超过 max_distance）。"""

        cos = math.cos(angle)
        sin = math.sin(angle)
        step = 0.45
        travelled = 0.0
        while travelled < max_distance:
            travelled += step
            px = x + cos * travelled
            py = y + sin * travelled
            if px < TANK_RADIUS or py < TANK_RADIUS:
                return travelled
            if px > WORLD_SIZE - TANK_RADIUS or py > WORLD_SIZE - TANK_RADIUS:
                return travelled
            for rect in self._rects:
                if rect.contains(px, py):
                    return travelled
        return max_distance

    # ------------------------------------------------------------------
    # 瞄准与开火
    # ------------------------------------------------------------------

    def _aim(
        self,
        brain: _Brain,
        own: EntityView,
        target: EntityView | None,
        dt: float,
    ) -> int:
        profile = self._profile
        brain.aim_error_in -= dt
        if brain.aim_error_in <= 0.0:
            brain.aim_error_in = brain.rng.uniform(*profile.aim_error_interval)
            distance = _distance(own, target) if target is not None else 0.0
            spread = profile.aim_error_base + distance * profile.aim_error_per_unit
            brain.aim_error = brain.rng.uniform(-spread, spread)

        if target is None:
            desired = own.hull
            brain.reaction = profile.reaction_delay
        else:
            distance = _distance(own, target)
            lead = distance / BULLET_SPEED
            desired = math.atan2(
                target.y + target.vy * lead - own.y,
                target.x + target.vx * lead - own.x,
            )
            if brain.reaction > 0.0:
                brain.reaction = max(0.0, brain.reaction - dt)
            brain.target_seen += dt

        desired += brain.aim_error
        diff = _wrap(desired - brain.aim)
        max_step = profile.turret_track_rate * dt
        brain.aim = _wrap(brain.aim + max(-max_step, min(max_step, diff)))
        return _angle_to_u16(brain.aim)

    def _line_of_sight(self, x1: float, y1: float, x2: float, y2: float) -> bool:
        """粗略视线检测：沿线段采样，被掩体挡住则返回 False。"""

        distance = math.hypot(x2 - x1, y2 - y1)
        if distance < 0.01:
            return True
        steps = max(2, int(distance / 0.45))
        for index in range(1, steps):
            t = index / steps
            px = x1 + (x2 - x1) * t
            py = y1 + (y2 - y1) * t
            for rect in self._rects:
                if rect.contains(px, py):
                    return False
        return True

    def aim_error(self, player_id: str) -> float:
        """调试/测试用：当前炮塔与理想瞄准角的误差。"""

        brain = self._brains.get(player_id)
        return brain.aim_error if brain is not None else 0.0


def _distance(a: EntityView, b: EntityView) -> float:
    return math.hypot(a.x - b.x, a.y - b.y)


def _distance_to(brain: _Brain, entity: EntityView) -> float:
    return math.hypot(brain.last_x - entity.x, brain.last_y - entity.y)
