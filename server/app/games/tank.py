"""坦克大战纯模拟（TankWorld）。

设计约束（见 ``docs/TANK.md`` §1/§5.1）：

- 只有 Python 标准库，**不依赖 asyncio / 网络 / 项目内其它模块**，可独立单测；
- 固定步长由调用方驱动（实时引擎按 20Hz 调 ``tick(1/20)``），本模块不认识真实时间；
- 输入是**持续状态**：``apply_input`` 保存玩家最近一帧输入，之后每个 tick 都按它推进；
- 坐标/速度单位是「世界单位/秒」，``entities()`` 返回 float，定点编码由实时引擎负责；
- 地图、开火序列、复活点全部由 seed 决定，同 seed + 同输入 = 完全相同的结果。

实体 id：坦克固定为 ``slot + 1``（1–8），子弹从 100 开始递增（u16 内循环）。
"""

from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass
from typing import Any, Final, Sequence

# ----------------------------------------------------------------------
# 常量（协议/渲染/客户端共用，改动需同步 docs/TANK.md）
# ----------------------------------------------------------------------

TICK_RATE: Final = 20
WORLD_SIZE: Final = 96.0

TANK_RADIUS: Final = 0.9
BULLET_RADIUS: Final = 0.18
TANK_HP: Final = 100
BULLET_DAMAGE: Final = 25
BULLET_SPEED: Final = 22.0
BULLET_LIFETIME: Final = 3.0
FIRE_COOLDOWN: Final = 0.9
RESPAWN_DELAY: Final = 3.0
SPAWN_SHIELD: Final = 1.5

MAX_PLAYERS: Final = 8
TARGET_KILLS: Final = 15
#: 默认对局时长（秒）；房主可在创建房间时覆盖。
MATCH_SECONDS: Final = 180.0
MATCH_SECONDS_MIN: Final = 60
MATCH_SECONDS_MAX: Final = 900
MATCH_SECONDS_STEP: Final = 30

MOVE_SPEED: Final = 6.0
REVERSE_SPEED: Final = 3.5
TURN_RATE: Final = 2.4

#: 炮口相对坦克中心的偏移（避免子弹一出生就撞到自己）
MUZZLE_OFFSET: Final = TANK_RADIUS + 0.35

#: 座位固定色板（slot 0–7），房间层直接把 ``SLOT_COLORS[slot]`` 写进 Player.color
SLOT_COLORS: Final = (
    "red",
    "orange",
    "yellow",
    "green",
    "cyan",
    "blue",
    "purple",
    "pink",
)

#: 输入位域（与 app/realtime/codec.py、web 端保持一致）
INPUT_UP: Final = 1 << 0
INPUT_DOWN: Final = 1 << 1
INPUT_LEFT: Final = 1 << 2
INPUT_RIGHT: Final = 1 << 3
INPUT_FIRE: Final = 1 << 4
INPUT_BRAKE: Final = 1 << 5
INPUT_FLAGS_MASK: Final = 0x3F

#: u16 满量程（aim 0..65535 映射 0..2π）
U16_MAX: Final = 0xFFFF
BULLET_ID_START: Final = 100

#: 子弹每帧最多推进 0.35 世界单位再检测碰撞，避免高速穿透
_BULLET_SUBSTEP: Final = 0.35

#: 浮点计时容差（3.0 - 60 * 0.05 不严格等于 0）
_EPS: Final = 1e-9

#: 地图生成参数（96×96 地图，掩体数量随面积等比放大）
MIN_OBSTACLES: Final = 40
MAX_OBSTACLES: Final = 64
OBSTACLE_MIN_SIZE: Final = 2.0
OBSTACLE_MAX_SIZE: Final = 6.0
OBSTACLE_WALL_MARGIN: Final = 1.5
OBSTACLE_MIN_GAP: Final = 1.0
SPAWN_RING_RADIUS: Final = 30.0
SPAWN_MIN_DISTANCE: Final = 8.0
SPAWN_WALL_CLEARANCE: Final = 3.0
SPAWN_OBSTACLE_CLEARANCE: Final = 2.0

_THEME: Final = "warehouse"


# ----------------------------------------------------------------------
# 对外视图
# ----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class EntityView:
    """一帧内下发给实时引擎的实体快照（浮点世界单位/弧度）。

    ``kind``：0 坦克 / 1 子弹；坦克 id = slot+1，子弹 id 从 100 递增。
    """

    entity_id: int
    kind: int
    owner_slot: int
    x: float
    y: float
    vx: float
    vy: float
    hull: float
    turret: float
    hp: int
    shielded: bool


@dataclass(frozen=True, slots=True)
class Obstacle:
    """轴对齐矩形掩体：``(x, y)`` 是左上角，``w/h`` 是尺寸（世界单位）。"""

    x: float
    y: float
    w: float
    h: float

    def to_dict(self) -> dict[str, float]:
        return {"x": self.x, "y": self.y, "w": self.w, "h": self.h}


@dataclass(slots=True)
class _Player:
    """内部玩家状态（不对外暴露）。"""

    player_id: str
    name: str
    slot: int
    x: float
    y: float
    hull: float
    turret: float
    hp: int
    alive: bool
    fire_cooldown: float
    shield_timer: float
    respawn_timer: float
    input_flags: int = 0
    input_aim: int = 0
    input_tick: int = 0
    vx: float = 0.0
    vy: float = 0.0


@dataclass(slots=True)
class _Bullet:
    """内部子弹状态。``owner_slot`` 在发射时固化，玩家掉线后仍能编码。"""

    entity_id: int
    owner_id: str
    owner_slot: int
    x: float
    y: float
    vx: float
    vy: float
    hull: float
    life: float


# ----------------------------------------------------------------------
# 小工具
# ----------------------------------------------------------------------


def _clamp_int(value: Any, low: int, high: int, *, default: int = 0) -> int:
    """把任意输入夹到 [low, high]；无法转换时返回 default（不抛异常）。"""

    if isinstance(value, bool):
        value = int(value)
    if not isinstance(value, int):
        try:
            value = int(value)
        except (TypeError, ValueError, OverflowError):
            return default
    if value < low:
        return low
    if value > high:
        return high
    return value


def _clamp(value: float, low: float, high: float) -> float:
    if value < low:
        return low
    if value > high:
        return high
    return value


def _aim_to_radians(aim: int) -> float:
    """u16 绝对角度 → 弧度（0 指向 +x，逆时针为正）。"""

    return aim / U16_MAX * math.tau


def _normalize_angle(radians: float) -> float:
    return radians % math.tau


def _angle_towards(x: float, y: float, tx: float, ty: float) -> float:
    return math.atan2(ty - y, tx - x) % math.tau


def _circle_hits_rect(x: float, y: float, radius: float, rect: Obstacle) -> bool:
    """圆与矩形是否相交（最近点距离 < 半径）。"""

    cx = _clamp(x, rect.x, rect.x + rect.w)
    cy = _clamp(y, rect.y, rect.y + rect.h)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy < radius * radius


def _point_rect_distance(px: float, py: float, rect: Obstacle) -> float:
    """点到矩形的最短距离（点在矩形内时为 0）。"""

    dx = max(rect.x - px, 0.0, px - (rect.x + rect.w))
    dy = max(rect.y - py, 0.0, py - (rect.y + rect.h))
    return math.hypot(dx, dy)


def _rect_distance(a: Obstacle, b: Obstacle) -> float:
    """两个轴对齐矩形之间的最短距离（相交为 0）。"""

    dx = max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0.0)
    dy = max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0.0)
    return math.hypot(dx, dy)


# ----------------------------------------------------------------------
# 地图生成
# ----------------------------------------------------------------------


def default_spawns() -> tuple[tuple[float, float], ...]:
    """8 个出生点：以地图中心为圆心均匀分布，保证彼此/离墙的安全距离。"""

    center = WORLD_SIZE / 2.0
    points: list[tuple[float, float]] = []
    for index in range(MAX_PLAYERS):
        angle = -math.pi / 2.0 + math.tau * index / MAX_PLAYERS
        points.append(
            (
                center + SPAWN_RING_RADIUS * math.cos(angle),
                center + SPAWN_RING_RADIUS * math.sin(angle),
            )
        )
    return tuple(points)


def _spawn_is_clear(rect: Obstacle, spawns: Sequence[tuple[float, float]]) -> bool:
    return all(
        _point_rect_distance(px, py, rect) >= SPAWN_OBSTACLE_CLEARANCE
        for px, py in spawns
    )


def _generate_obstacles(
    seed: int | None, spawns: Sequence[tuple[float, float]]
) -> list[Obstacle]:
    """按 seed 生成 40–64 个矩形掩体，且都避开出生点（距离 ≥ 2）。"""

    rng = random.Random(seed)
    count = rng.randint(MIN_OBSTACLES, MAX_OBSTACLES)
    obstacles: list[Obstacle] = []

    for _ in range(count):
        placed = False
        # 正常候选：完整尺寸 + 出生点净空 + 掩体之间留缝
        for _attempt in range(240):
            width = round(rng.uniform(OBSTACLE_MIN_SIZE, OBSTACLE_MAX_SIZE), 2)
            height = round(rng.uniform(OBSTACLE_MIN_SIZE, OBSTACLE_MAX_SIZE), 2)
            x = round(rng.uniform(OBSTACLE_WALL_MARGIN, WORLD_SIZE - OBSTACLE_WALL_MARGIN - width), 2)
            y = round(rng.uniform(OBSTACLE_WALL_MARGIN, WORLD_SIZE - OBSTACLE_WALL_MARGIN - height), 2)
            rect = Obstacle(x, y, width, height)
            if not _spawn_is_clear(rect, spawns):
                continue
            if any(_rect_distance(rect, other) < OBSTACLE_MIN_GAP for other in obstacles):
                continue
            obstacles.append(rect)
            placed = True
            break
        if placed:
            continue

        # 退让候选：允许与已有掩体贴靠，但绝不侵占出生点净空
        for _attempt in range(2000):
            width = round(rng.uniform(OBSTACLE_MIN_SIZE, OBSTACLE_MAX_SIZE), 2)
            height = round(rng.uniform(OBSTACLE_MIN_SIZE, OBSTACLE_MAX_SIZE), 2)
            x = round(rng.uniform(OBSTACLE_WALL_MARGIN, WORLD_SIZE - OBSTACLE_WALL_MARGIN - width), 2)
            y = round(rng.uniform(OBSTACLE_WALL_MARGIN, WORLD_SIZE - OBSTACLE_WALL_MARGIN - height), 2)
            rect = Obstacle(x, y, width, height)
            if _spawn_is_clear(rect, spawns):
                obstacles.append(rect)
                placed = True
                break
        if placed:
            continue

        # 兜底：网格扫描（理论上到不了这里；保证数量恒定与地图可玩性）
        for grid_y in range(2, int(WORLD_SIZE) - 2):
            for grid_x in range(2, int(WORLD_SIZE) - 2):
                rect = Obstacle(float(grid_x), float(grid_y), 1.5, 1.5)
                if _spawn_is_clear(rect, spawns):
                    obstacles.append(rect)
                    placed = True
                    break
            if placed:
                break

    return obstacles


# ----------------------------------------------------------------------
# 世界
# ----------------------------------------------------------------------


class TankWorld:
    """一局坦克大战的服务端权威模拟。

    构造即进入 ``playing``；``tick`` 负责推进物理、结算伤害与死亡复活，
    并在满足结束条件时追加一条 ``match_end`` 事件（整局只发一次）。
    """

    def __init__(
        self,
        players: Sequence[tuple[str, str]],
        *,
        seed: int | None = None,
        started_at_ms: int | None = None,
        match_seconds: float | int | None = None,
    ) -> None:
        # 不传时在运行时读取 MATCH_SECONDS（便于测试 monkeypatch）；范围校验由房间层负责。
        requested_seconds = MATCH_SECONDS if match_seconds is None else match_seconds
        try:
            requested_seconds = float(requested_seconds)
        except (TypeError, ValueError):
            requested_seconds = MATCH_SECONDS
        if not math.isfinite(requested_seconds) or requested_seconds <= 0:
            requested_seconds = MATCH_SECONDS
        self._match_seconds = requested_seconds
        self._spawns = default_spawns()
        self._obstacles = _generate_obstacles(seed, self._spawns)
        # 地图用独立的 Random；复活点等运行时随机同样由 seed 决定，保证整局确定性
        self._rng = random.Random(seed)

        if started_at_ms is None:
            started_at_ms = int(time.time() * 1000)
        self._started_at_ms = int(started_at_ms)
        self._ends_at_ms = self._started_at_ms + int(self._match_seconds * 1000)

        self._elapsed = 0.0
        self._ended_reason: str | None = None
        self._winner: str | None = None
        self._pending_events: list[dict[str, Any]] = []

        self._players: dict[str, _Player] = {}
        self._scores: dict[str, dict[str, int]] = {}
        self._bullets: list[_Bullet] = []
        self._next_bullet_id = BULLET_ID_START

        for entry in players or ():
            if not isinstance(entry, (tuple, list)) or not entry:
                continue
            player_id = entry[0]
            if not isinstance(player_id, str) or not player_id:
                continue
            name = entry[1] if len(entry) > 1 else player_id
            if len(self._players) >= MAX_PLAYERS:
                break
            if player_id in self._players:
                continue
            self._seat_player_locked(player_id, str(name))

    # ------------------------------------------------------------------
    # 生命周期 / 座位
    # ------------------------------------------------------------------

    def add_player(self, player_id: str, name: str) -> bool:
        """断线重连/补充入座：复用空 slot（0–7）。

        成功（含已在本局中的幂等情况）返回 True；满员或已结束返回 False。
        """

        if not isinstance(player_id, str) or not player_id:
            return False
        if player_id in self._players:
            return True
        if self._finished:
            return False
        return self._seat_player_locked(player_id, str(name))

    def remove_player(self, player_id: str) -> None:
        """移除玩家及其最近输入；已经发射的子弹继续飞行。"""

        if not isinstance(player_id, str):
            return
        self._players.pop(player_id, None)

    def player_slots(self) -> dict[str, int]:
        return {player_id: player.slot for player_id, player in self._players.items()}

    def _seat_player_locked(self, player_id: str, name: str) -> bool:
        slot = self._free_slot()
        if slot is None:
            return False
        spawn_x, spawn_y = self._spawns[slot]
        self._players[player_id] = _Player(
            player_id=player_id,
            name=name,
            slot=slot,
            x=spawn_x,
            y=spawn_y,
            hull=_angle_towards(spawn_x, spawn_y, WORLD_SIZE / 2.0, WORLD_SIZE / 2.0),
            turret=_angle_towards(spawn_x, spawn_y, WORLD_SIZE / 2.0, WORLD_SIZE / 2.0),
            hp=TANK_HP,
            alive=True,
            fire_cooldown=0.0,
            shield_timer=0.0,
            respawn_timer=0.0,
        )
        # 重连回座时保留已有战绩
        self._scores.setdefault(player_id, {"kills": 0, "deaths": 0})
        return True

    def _free_slot(self) -> int | None:
        used = {player.slot for player in self._players.values()}
        for slot in range(MAX_PLAYERS):
            if slot not in used:
                return slot
        return None

    def _active_players(self) -> list[_Player]:
        """按 slot 排序的当前玩家，保证遍历顺序与入座顺序无关。"""

        return sorted(self._players.values(), key=lambda player: player.slot)

    # ------------------------------------------------------------------
    # 输入
    # ------------------------------------------------------------------

    def apply_input(
        self, player_id: str, *, flags: int, aim: int, tick: int = 0
    ) -> None:
        """保存玩家最近一帧输入（持续状态）；越界值夹紧，未知玩家/已结束忽略。"""

        if not isinstance(player_id, str):
            return
        player = self._players.get(player_id)
        if player is None or self._finished:
            return
        input_flags = _clamp_int(flags, 0, INPUT_FLAGS_MASK)
        input_aim = _clamp_int(aim, 0, U16_MAX)
        player.input_flags = input_flags
        player.input_aim = input_aim
        player.input_tick = _clamp_int(tick, 0, 0xFFFFFFFF)
        # 炮塔无转速限制：直接用最近一帧的绝对角度
        player.turret = _aim_to_radians(input_aim)

    # ------------------------------------------------------------------
    # 单步模拟
    # ------------------------------------------------------------------

    def tick(self, dt: float) -> list[dict[str, Any]]:
        """推进一帧并返回本帧事件（按发生顺序）。

        已结束时不再推进物理；``end_match`` 排队的 ``match_end`` 会在下一次
        ``tick`` 里只返回一次。
        """

        if self._finished:
            if self._pending_events:
                pending = self._pending_events
                self._pending_events = []
                return pending
            return []

        if isinstance(dt, bool) or not isinstance(dt, (int, float)):
            return []
        step = float(dt)
        if not math.isfinite(step) or step <= 0.0:
            return []

        events: list[dict[str, Any]] = []
        self._elapsed += step

        self._update_timers(step, events)
        self._update_tanks(step)
        self._resolve_collisions()
        self._update_fire()
        self._update_bullets(step, events)
        self._check_finish(events)
        return events

    def _update_timers(self, dt: float, events: list[dict[str, Any]]) -> None:
        """推进护盾/复活计时；到点的玩家在随机出生点满血复活。"""

        for player in self._active_players():
            if player.shield_timer > 0.0:
                player.shield_timer = max(0.0, player.shield_timer - dt)
            if player.alive:
                continue
            player.respawn_timer -= dt
            if player.respawn_timer > _EPS:
                continue
            spawn_x, spawn_y = self._spawns[self._rng.randrange(MAX_PLAYERS)]
            player.x = spawn_x
            player.y = spawn_y
            player.hull = _angle_towards(
                spawn_x, spawn_y, WORLD_SIZE / 2.0, WORLD_SIZE / 2.0
            )
            player.hp = TANK_HP
            player.alive = True
            player.vx = 0.0
            player.vy = 0.0
            player.respawn_timer = 0.0
            player.fire_cooldown = 0.0
            player.shield_timer = SPAWN_SHIELD
            events.append(
                {
                    "kind": "respawn",
                    "playerId": player.player_id,
                    "x": float(spawn_x),
                    "y": float(spawn_y),
                }
            )

    def _update_tanks(self, dt: float) -> None:
        """车体转向、油门、位置积分与开火冷却。"""

        for player in self._active_players():
            if not player.alive:
                player.vx = 0.0
                player.vy = 0.0
                continue

            flags = player.input_flags
            turn = 0.0
            if flags & INPUT_LEFT:
                turn += 1.0
            if flags & INPUT_RIGHT:
                turn -= 1.0
            player.hull = _normalize_angle(player.hull + turn * TURN_RATE * dt)

            forward = bool(flags & INPUT_UP)
            backward = bool(flags & INPUT_DOWN)
            braking = bool(flags & INPUT_BRAKE)
            if braking or (forward and backward):
                speed = 0.0
            elif forward:
                speed = MOVE_SPEED
            elif backward:
                speed = -REVERSE_SPEED
            else:
                speed = 0.0

            player.vx = math.cos(player.hull) * speed
            player.vy = math.sin(player.hull) * speed
            player.x += player.vx * dt
            player.y += player.vy * dt

            if player.fire_cooldown > 0.0:
                player.fire_cooldown = max(0.0, player.fire_cooldown - dt)

    def _resolve_collisions(self) -> None:
        """世界边界 clamp + 圆/矩形掩体最小穿透轴推出 + 坦克半径分离。"""

        for _ in range(2):
            for player in self._active_players():
                if not player.alive:
                    continue
                self._clamp_to_world(player)
                for rect in self._obstacles:
                    self._push_out_of_rect(player, rect)
            self._separate_tanks()

        for player in self._active_players():
            if not player.alive:
                continue
            self._clamp_to_world(player)
            for rect in self._obstacles:
                self._push_out_of_rect(player, rect)
            self._clamp_to_world(player)

    def _clamp_to_world(self, player: _Player) -> None:
        limit = WORLD_SIZE - TANK_RADIUS
        player.x = _clamp(player.x, TANK_RADIUS, limit)
        player.y = _clamp(player.y, TANK_RADIUS, limit)

    def _push_out_of_rect(self, player: _Player, rect: Obstacle) -> None:
        """把坦克圆按最小穿透轴推出矩形（膨胀矩形的四条边）。"""

        left = rect.x - TANK_RADIUS
        right = rect.x + rect.w + TANK_RADIUS
        top = rect.y - TANK_RADIUS
        bottom = rect.y + rect.h + TANK_RADIUS
        if not (left < player.x < right and top < player.y < bottom):
            return
        penetrations = (
            (player.x - left, "left"),
            (right - player.x, "right"),
            (player.y - top, "top"),
            (bottom - player.y, "bottom"),
        )
        _, axis = min(penetrations, key=lambda item: item[0])
        if axis == "left":
            player.x = left
        elif axis == "right":
            player.x = right
        elif axis == "top":
            player.y = top
        else:
            player.y = bottom

    def _separate_tanks(self) -> None:
        """活着的坦克两两按半径和分离，各推一半（碰巧完全重叠时按 slot 定方向）。"""

        players = [player for player in self._active_players() if player.alive]
        min_distance = TANK_RADIUS * 2.0
        for _ in range(2):
            for index, first in enumerate(players):
                for second in players[index + 1 :]:
                    dx = second.x - first.x
                    dy = second.y - first.y
                    distance = math.hypot(dx, dy)
                    if distance >= min_distance:
                        continue
                    if distance > _EPS:
                        nx = dx / distance
                        ny = dy / distance
                    else:
                        nx, ny = (1.0, 0.0) if first.slot < second.slot else (-1.0, 0.0)
                    push = (min_distance - distance) / 2.0
                    first.x -= nx * push
                    first.y -= ny * push
                    second.x += nx * push
                    second.y += ny * push

    def _update_fire(self) -> None:
        """按住开火位 + 冷却结束 → 自动连发（无开火事件，客户端看子弹实体）。"""

        for player in self._active_players():
            if not player.alive:
                continue
            if not (player.input_flags & INPUT_FIRE):
                continue
            if player.fire_cooldown > _EPS:
                continue
            player.fire_cooldown = FIRE_COOLDOWN
            cos_angle = math.cos(player.turret)
            sin_angle = math.sin(player.turret)
            self._bullets.append(
                _Bullet(
                    entity_id=self._allocate_bullet_id(),
                    owner_id=player.player_id,
                    owner_slot=player.slot,
                    x=player.x + cos_angle * MUZZLE_OFFSET,
                    y=player.y + sin_angle * MUZZLE_OFFSET,
                    vx=cos_angle * BULLET_SPEED,
                    vy=sin_angle * BULLET_SPEED,
                    hull=player.turret,
                    life=BULLET_LIFETIME,
                )
            )

    def _allocate_bullet_id(self) -> int:
        """子弹 id 从 100 递增，u16 内循环并避开仍在飞行的 id。"""

        used = {bullet.entity_id for bullet in self._bullets}
        for _ in range(U16_MAX - BULLET_ID_START + 1):
            candidate = self._next_bullet_id
            self._next_bullet_id = (
                BULLET_ID_START if candidate >= U16_MAX else candidate + 1
            )
            if candidate not in used:
                return candidate
        return BULLET_ID_START

    def _update_bullets(self, dt: float, events: list[dict[str, Any]]) -> None:
        """子弹按小步推进，检测出界/掩体/敌方坦克，并结算伤害。"""

        survivors: list[_Bullet] = []
        for bullet in self._bullets:
            bullet.life -= dt
            if bullet.life <= 0.0:
                continue

            dx = bullet.vx * dt
            dy = bullet.vy * dt
            travel = math.hypot(dx, dy)
            steps = max(1, int(math.ceil(travel / _BULLET_SUBSTEP)))
            removed = False
            for _ in range(steps):
                bullet.x += dx / steps
                bullet.y += dy / steps
                if (
                    bullet.x < 0.0
                    or bullet.x > WORLD_SIZE
                    or bullet.y < 0.0
                    or bullet.y > WORLD_SIZE
                ):
                    events.append(
                        {
                            "kind": "impact",
                            "x": round(bullet.x, 2),
                            "y": round(bullet.y, 2),
                            "surface": "wall",
                        }
                    )
                    removed = True
                    break
                if any(
                    _circle_hits_rect(bullet.x, bullet.y, BULLET_RADIUS, rect)
                    for rect in self._obstacles
                ):
                    events.append(
                        {
                            "kind": "impact",
                            "x": round(bullet.x, 2),
                            "y": round(bullet.y, 2),
                            "surface": "obstacle",
                        }
                    )
                    removed = True
                    break
                victim = self._find_bullet_target(bullet)
                if victim is not None:
                    self._apply_hit(bullet, victim, events)
                    removed = True
                    break
            if not removed:
                survivors.append(bullet)
        self._bullets = survivors

    def _find_bullet_target(self, bullet: _Bullet) -> _Player | None:
        """命中条件：存活、非 owner、非护盾、圆心距 < 半径和；多人重叠取最近。"""

        best: _Player | None = None
        best_distance = TANK_RADIUS + BULLET_RADIUS
        for player in self._active_players():
            if not player.alive or player.player_id == bullet.owner_id:
                continue
            if player.shield_timer > 0.0:
                continue
            distance = math.hypot(player.x - bullet.x, player.y - bullet.y)
            if distance < best_distance:
                best = player
                best_distance = distance
        return best

    def _apply_hit(
        self, bullet: _Bullet, victim: _Player, events: list[dict[str, Any]]
    ) -> None:
        events.append(
            {
                "kind": "hit",
                "shooterId": bullet.owner_id,
                "targetId": victim.player_id,
                "x": float(bullet.x),
                "y": float(bullet.y),
                "damage": BULLET_DAMAGE,
            }
        )
        victim.hp = max(0, victim.hp - BULLET_DAMAGE)
        if victim.hp > 0:
            return
        self._kill(bullet.owner_id, victim, events)

    def _kill(
        self, shooter_id: str, victim: _Player, events: list[dict[str, Any]]
    ) -> None:
        victim.hp = 0
        victim.alive = False
        victim.vx = 0.0
        victim.vy = 0.0
        victim.shield_timer = 0.0
        victim.fire_cooldown = 0.0
        victim.respawn_timer = RESPAWN_DELAY
        self._bump_score(victim.player_id, "deaths")
        if shooter_id != victim.player_id:
            self._bump_score(shooter_id, "kills")
        events.append(
            {
                "kind": "kill",
                "shooterId": shooter_id,
                "targetId": victim.player_id,
                "x": float(victim.x),
                "y": float(victim.y),
            }
        )

    def _bump_score(self, player_id: str, key: str) -> None:
        record = self._scores.get(player_id)
        if record is None:
            record = {"kills": 0, "deaths": 0}
            self._scores[player_id] = record
        record[key] = int(record.get(key, 0)) + 1

    def _check_finish(self, events: list[dict[str, Any]]) -> None:
        if self._finished:
            return
        reason: str | None = None
        for player in self._active_players():
            if self._scores.get(player.player_id, {}).get("kills", 0) >= TARGET_KILLS:
                reason = "kills"
                break
        if reason is None and self._elapsed >= self._match_seconds - _EPS:
            reason = "time"
        if reason is not None:
            self._finish(reason, events)

    def _finish(self, reason: str, events: list[dict[str, Any]]) -> None:
        self._ended_reason = reason
        self._winner = self._compute_winner()
        events.append(
            {
                "kind": "match_end",
                "winnerId": self._winner,
                "reason": reason,
            }
        )

    def _compute_winner(self) -> str | None:
        """击杀数最高者；并列或无人则 None（FFA 无胜负）。"""

        best = -1
        leaders: list[str] = []
        for player in self._active_players():
            kills = int(self._scores.get(player.player_id, {}).get("kills", 0))
            if kills > best:
                best = kills
                leaders = [player.player_id]
            elif kills == best:
                leaders.append(player.player_id)
        if not leaders:
            return None
        return leaders[0] if len(leaders) == 1 else None

    # ------------------------------------------------------------------
    # 外部结算
    # ------------------------------------------------------------------

    def end_match(self, reason: str) -> None:
        """房间层强制结束（人数不足/对手离开等）。

        结果通过下一次 ``tick`` 的 ``match_end`` 事件交给实时引擎，保证只发一次。
        """

        if self._finished:
            return
        text = reason if isinstance(reason, str) and reason else "forfeit"
        self._ended_reason = text
        self._winner = self._compute_winner()
        self._pending_events.append(
            {"kind": "match_end", "winnerId": self._winner, "reason": text}
        )

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------

    @property
    def _finished(self) -> bool:
        return self._ended_reason is not None

    def finished(self) -> bool:
        return self._finished

    def winner(self) -> str | None:
        return self._winner

    def ended_reason(self) -> str | None:
        return self._ended_reason

    def scores(self) -> dict[str, dict[str, int]]:
        """{playerId: {kills, deaths}}；掉线玩家在整局内保留战绩。"""

        return {
            player_id: {
                "kills": int(record.get("kills", 0)),
                "deaths": int(record.get("deaths", 0)),
            }
            for player_id, record in self._scores.items()
        }

    def entities(self) -> list[EntityView]:
        """当前存活实体：先是坦克（slot 顺序），再是子弹（发射顺序）。"""

        views: list[EntityView] = []
        for player in self._active_players():
            if not player.alive:
                continue
            views.append(
                EntityView(
                    entity_id=player.slot + 1,
                    kind=0,
                    owner_slot=player.slot,
                    x=float(player.x),
                    y=float(player.y),
                    vx=float(player.vx),
                    vy=float(player.vy),
                    hull=float(player.hull),
                    turret=float(player.turret),
                    hp=int(player.hp),
                    shielded=player.shield_timer > 0.0,
                )
            )
        for bullet in self._bullets:
            views.append(
                EntityView(
                    entity_id=bullet.entity_id,
                    kind=1,
                    owner_slot=bullet.owner_slot,
                    x=float(bullet.x),
                    y=float(bullet.y),
                    vx=float(bullet.vx),
                    vy=float(bullet.vy),
                    hull=float(bullet.hull),
                    turret=float(bullet.hull),
                    hp=1,
                    shielded=False,
                )
            )
        return views

    def info(self, phase: str | None = None) -> dict[str, Any]:
        """TankGameInfo（JSON-safe，不含实体）。

        ``phase`` 可由房间层显式覆盖（例如等待中的 ``"waiting"``）；
        缺省时按内部状态返回 ``playing`` / ``finished``。
        """

        if isinstance(phase, str) and phase:
            effective = phase
        else:
            effective = "finished" if self._finished else "playing"
        return {
            "phase": effective,
            "tickRate": TICK_RATE,
            "map": {
                "width": WORLD_SIZE,
                "height": WORLD_SIZE,
                "obstacles": [rect.to_dict() for rect in self._obstacles],
                "spawns": [
                    {"x": float(x), "y": float(y)} for x, y in self._spawns
                ],
                "theme": _THEME,
            },
            "targetKills": TARGET_KILLS,
            "matchSeconds": int(round(self._match_seconds)),
            "endsAt": None if effective == "waiting" else self._ends_at_ms,
            "winnerId": self._winner,
            "endedReason": self._ended_reason,
            "scores": self.scores(),
        }


__all__ = [
    "BULLET_DAMAGE",
    "BULLET_LIFETIME",
    "BULLET_RADIUS",
    "BULLET_SPEED",
    "EntityView",
    "FIRE_COOLDOWN",
    "MATCH_SECONDS",
    "MATCH_SECONDS_MAX",
    "MATCH_SECONDS_MIN",
    "MATCH_SECONDS_STEP",
    "MAX_PLAYERS",
    "MOVE_SPEED",
    "Obstacle",
    "RESPAWN_DELAY",
    "REVERSE_SPEED",
    "SLOT_COLORS",
    "SPAWN_SHIELD",
    "TANK_HP",
    "TANK_RADIUS",
    "TARGET_KILLS",
    "TICK_RATE",
    "TURN_RATE",
    "TankWorld",
    "WORLD_SIZE",
]
