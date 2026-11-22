"""TankWorld 纯模拟单测：移动/碰撞/子弹/结算/确定性，固定 20Hz 步长无 sleep。"""

from __future__ import annotations

import json
import math

import pytest

import app.games.tank as tank

DT = 1.0 / tank.TICK_RATE


# ----------------------------------------------------------------------
# 测试工具（直接摆位/清空掩体，让物理断言不受随机地图干扰）
# ----------------------------------------------------------------------


def make_world(
    players: list[tuple[str, str]] | None = None,
    *,
    seed: int = 7,
    started_at_ms: int | None = None,
) -> tank.TankWorld:
    if players is None:
        players = [("a", "A"), ("b", "B")]
    return tank.TankWorld(players, seed=seed, started_at_ms=started_at_ms)


def clear_obstacles(world: tank.TankWorld) -> None:
    world._obstacles = []


def place(
    world: tank.TankWorld,
    player_id: str,
    x: float,
    y: float,
    *,
    hull: float | None = None,
    turret: float | None = None,
) -> None:
    player = world._players[player_id]
    player.x = float(x)
    player.y = float(y)
    player.vx = 0.0
    player.vy = 0.0
    player.fire_cooldown = 0.0
    if hull is not None:
        player.hull = float(hull)
    if turret is not None:
        player.turret = float(turret)


def clear_bullets(world: tank.TankWorld) -> None:
    world._bullets = []


def step(world: tank.TankWorld, ticks: int = 1) -> list[dict]:
    events: list[dict] = []
    for _ in range(ticks):
        events.extend(world.tick(DT))
    return events


def tank_entity(world: tank.TankWorld, player_id: str) -> tank.EntityView | None:
    slot = world.player_slots().get(player_id)
    if slot is None:
        return None
    for entity in world.entities():
        if entity.kind == 0 and entity.owner_slot == slot:
            return entity
    return None


def bullets(world: tank.TankWorld) -> list[tank.EntityView]:
    return [entity for entity in world.entities() if entity.kind == 1]


def point_rect_distance(px: float, py: float, rect: dict) -> float:
    dx = max(rect["x"] - px, 0.0, px - (rect["x"] + rect["w"]))
    dy = max(rect["y"] - py, 0.0, py - (rect["y"] + rect["h"]))
    return math.hypot(dx, dy)


def kill_once(
    world: tank.TankWorld,
    shooter_id: str,
    victim_id: str,
    *,
    shooter_pos: tuple[float, float] = (10.0, 24.0),
    victim_pos: tuple[float, float] = (16.0, 24.0),
) -> list[dict]:
    """把两人摆成一条直线，4 发打死目标，返回直到 kill 为止的事件。"""

    place(world, shooter_id, *shooter_pos, hull=0.0, turret=0.0)
    place(world, victim_id, *victim_pos, hull=math.pi, turret=math.pi)
    world.apply_input(shooter_id, flags=tank.INPUT_FIRE, aim=0)
    events: list[dict] = []
    for _ in range(200):
        events.extend(world.tick(DT))
        if any(event["kind"] == "kill" for event in events):
            break
    assert any(event["kind"] == "kill" for event in events)
    world.apply_input(shooter_id, flags=0, aim=0)
    return events


# ----------------------------------------------------------------------
# 信息 / 初始状态 / 地图
# ----------------------------------------------------------------------


def test_info_and_initial_state() -> None:
    world = make_world(started_at_ms=1000)
    info = world.info()

    assert info["phase"] == "playing"
    assert info["tickRate"] == tank.TICK_RATE == 20
    assert info["targetKills"] == tank.TARGET_KILLS == 15
    assert info["endsAt"] == 1000 + int(tank.MATCH_SECONDS * 1000)
    assert info["endsAt"] == 181000
    assert info["winnerId"] is None
    assert info["endedReason"] is None
    assert info["scores"] == {
        "a": {"kills": 0, "deaths": 0},
        "b": {"kills": 0, "deaths": 0},
    }
    game_map = info["map"]
    assert game_map["width"] == tank.WORLD_SIZE == 96.0
    assert game_map["height"] == tank.WORLD_SIZE
    assert game_map["theme"] == "warehouse"
    assert len(game_map["spawns"]) == 8
    assert tank.MIN_OBSTACLES <= len(game_map["obstacles"]) <= tank.MAX_OBSTACLES

    # JSON-safe 且实体只含 float 坐标
    json.dumps(info)
    assert world.finished() is False
    assert world.winner() is None
    assert world.ended_reason() is None
    assert world.player_slots() == {"a": 0, "b": 1}

    entities = world.entities()
    assert [entity.entity_id for entity in entities] == [1, 2]
    assert all(entity.kind == 0 for entity in entities)
    assert all(entity.hp == 100 and entity.shielded is False for entity in entities)
    for entity in entities:
        for attr in ("x", "y", "vx", "vy", "hull", "turret"):
            assert isinstance(getattr(entity, attr), float)

    waiting = world.info("waiting")
    assert waiting["phase"] == "waiting"
    assert waiting["endsAt"] is None


def test_map_generation_constraints_and_seed() -> None:
    for seed in (0, 1, 2, 42, 2024):
        game_map = make_world(seed=seed).info()["map"]
        obstacles = game_map["obstacles"]
        spawns = game_map["spawns"]
        assert tank.MIN_OBSTACLES <= len(obstacles) <= tank.MAX_OBSTACLES
        assert len(spawns) == tank.MAX_PLAYERS == 8

        # 出生点：彼此 ≥ 8、离墙 ≥ 3、离掩体 ≥ 2
        for index, spawn in enumerate(spawns):
            for other in spawns[index + 1 :]:
                assert math.hypot(spawn["x"] - other["x"], spawn["y"] - other["y"]) >= tank.SPAWN_MIN_DISTANCE
            assert min(spawn["x"], spawn["y"]) >= tank.SPAWN_WALL_CLEARANCE
            assert min(tank.WORLD_SIZE - spawn["x"], tank.WORLD_SIZE - spawn["y"]) >= tank.SPAWN_WALL_CLEARANCE
            for rect in obstacles:
                assert point_rect_distance(spawn["x"], spawn["y"], rect) >= tank.SPAWN_OBSTACLE_CLEARANCE

        # 掩体都在世界内
        for rect in obstacles:
            assert rect["x"] >= 0.0 and rect["y"] >= 0.0
            assert rect["x"] + rect["w"] <= tank.WORLD_SIZE
            assert rect["y"] + rect["h"] <= tank.WORLD_SIZE
            assert rect["w"] > 0.0 and rect["h"] > 0.0

    same_seed_a = make_world(seed=11).info()["map"]
    same_seed_b = make_world(seed=11).info()["map"]
    assert same_seed_a == same_seed_b
    assert make_world(seed=11).info()["map"] != make_world(seed=12).info()["map"]


# ----------------------------------------------------------------------
# 移动与转向
# ----------------------------------------------------------------------


def test_forward_movement_and_hull() -> None:
    world = make_world([("a", "A")], seed=3)
    clear_obstacles(world)
    start = tank_entity(world, "a")
    assert start is not None
    # slot 0 出生在地图上方，初始车体朝向地图中心（+y，π/2）
    assert start.hull == pytest.approx(math.pi / 2.0)
    assert start.x == pytest.approx(48.0)
    assert start.y == pytest.approx(18.0)

    world.apply_input("a", flags=tank.INPUT_UP, aim=0)
    step(world, 20)  # 1 秒
    moved = tank_entity(world, "a")
    assert moved is not None
    assert moved.x == pytest.approx(48.0, abs=1e-9)
    assert moved.y == pytest.approx(24.0, abs=1e-9)
    assert moved.vx == pytest.approx(0.0, abs=1e-9)
    assert moved.vy == pytest.approx(tank.MOVE_SPEED, abs=1e-9)


def test_turning_left_and_right() -> None:
    world = make_world([("a", "A")], seed=3)
    clear_obstacles(world)
    start_hull = math.pi / 2.0

    world.apply_input("a", flags=tank.INPUT_LEFT, aim=0)
    step(world, 10)  # 0.5 秒
    left = tank_entity(world, "a")
    assert left is not None
    assert left.hull == pytest.approx((start_hull + tank.TURN_RATE * 0.5) % math.tau)

    world.apply_input("a", flags=tank.INPUT_RIGHT, aim=0)
    step(world, 10)
    right = tank_entity(world, "a")
    assert right is not None
    assert right.hull == pytest.approx(start_hull, abs=1e-9)

    # 左转 + 前进时旧速度方向会随车体一起转
    world.apply_input("a", flags=tank.INPUT_LEFT | tank.INPUT_UP, aim=0)
    step(world, 1)
    diagonal = tank_entity(world, "a")
    assert diagonal is not None
    assert diagonal.hull != start_hull


def test_reverse_and_brake() -> None:
    world = make_world([("a", "A")], seed=3)
    clear_obstacles(world)
    start = tank_entity(world, "a")
    assert start is not None

    # 倒车：沿车体反方向以 REVERSE_SPEED 移动
    world.apply_input("a", flags=tank.INPUT_DOWN, aim=0)
    step(world, 20)
    reversed_entity = tank_entity(world, "a")
    assert reversed_entity is not None
    assert reversed_entity.y == pytest.approx(start.y - tank.REVERSE_SPEED, abs=1e-9)
    assert reversed_entity.vy == pytest.approx(-tank.REVERSE_SPEED, abs=1e-9)

    # 刹车位优先于油门
    place(world, "a", 24.0, 24.0, hull=0.0)
    world.apply_input("a", flags=tank.INPUT_UP | tank.INPUT_BRAKE, aim=0)
    step(world, 20)
    braked = tank_entity(world, "a")
    assert braked is not None
    assert braked.x == pytest.approx(24.0)
    assert braked.y == pytest.approx(24.0)
    assert braked.vx == pytest.approx(0.0)

    # 上下同按 = 0
    place(world, "a", 24.0, 24.0, hull=0.0)
    world.apply_input("a", flags=tank.INPUT_UP | tank.INPUT_DOWN, aim=0)
    step(world, 20)
    idle = tank_entity(world, "a")
    assert idle is not None
    assert idle.x == pytest.approx(24.0)
    assert idle.y == pytest.approx(24.0)


def test_world_boundary_clamp() -> None:
    world = make_world([("a", "A")], seed=3)
    clear_obstacles(world)
    place(world, "a", tank.WORLD_SIZE - 1.0, tank.WORLD_SIZE / 2, hull=0.0)
    world.apply_input("a", flags=tank.INPUT_UP, aim=0)
    step(world, 100)
    entity = tank_entity(world, "a")
    assert entity is not None
    assert entity.x <= tank.WORLD_SIZE - tank.TANK_RADIUS + 1e-9
    assert entity.x == pytest.approx(tank.WORLD_SIZE - tank.TANK_RADIUS)


# ----------------------------------------------------------------------
# 碰撞
# ----------------------------------------------------------------------


def test_obstacle_push_out_min_penetration_axis() -> None:
    world = make_world([("a", "A")], seed=3)
    clear_obstacles(world)
    rect = tank.Obstacle(20.0, 20.0, 4.0, 4.0)
    world._obstacles = [rect]

    # 正中心：四边穿透相同，按最小穿透轴推出到最近一条边
    place(world, "a", 22.0, 22.0)
    step(world, 1)
    entity = tank_entity(world, "a")
    assert entity is not None
    assert not (20.0 - tank.TANK_RADIUS < entity.x < 24.0 + tank.TANK_RADIUS and 20.0 - tank.TANK_RADIUS < entity.y < 24.0 + tank.TANK_RADIUS)

    # 从上方压入 → 推到上边；从左侧压入 → 推到左边
    place(world, "a", 22.0, 20.5)
    step(world, 1)
    top = tank_entity(world, "a")
    assert top is not None and top.y == pytest.approx(20.0 - tank.TANK_RADIUS)

    place(world, "a", 19.5, 22.0)
    step(world, 1)
    left = tank_entity(world, "a")
    assert left is not None and left.x == pytest.approx(20.0 - tank.TANK_RADIUS)

    place(world, "a", 24.5, 22.0)
    step(world, 1)
    right = tank_entity(world, "a")
    assert right is not None and right.x == pytest.approx(24.0 + tank.TANK_RADIUS)


def test_tank_separation() -> None:
    world = make_world(seed=3)
    clear_obstacles(world)
    place(world, "a", 24.0, 24.0)
    place(world, "b", 24.5, 24.0)
    step(world, 1)
    first = tank_entity(world, "a")
    second = tank_entity(world, "b")
    assert first is not None and second is not None
    distance = math.hypot(first.x - second.x, first.y - second.y)
    assert distance == pytest.approx(tank.TANK_RADIUS * 2.0, abs=1e-9)
    # 分离各推一半，中点保持
    assert (first.x + second.x) / 2.0 == pytest.approx(24.25)


# ----------------------------------------------------------------------
# 子弹与伤害
# ----------------------------------------------------------------------


def test_bullet_entity_and_muzzle_offset() -> None:
    world = make_world([("a", "A")], seed=3)
    clear_obstacles(world)
    place(world, "a", 24.0, 24.0, hull=0.0, turret=0.0)
    world.apply_input("a", flags=tank.INPUT_FIRE, aim=0)
    step(world, 1)

    fired = bullets(world)
    assert len(fired) == 1
    bullet = fired[0]
    assert bullet.kind == 1
    assert bullet.entity_id >= tank.BULLET_ID_START
    assert bullet.owner_slot == 0
    assert bullet.hp == 1
    assert bullet.turret == pytest.approx(0.0, abs=1e-9)
    # 同一 tick 内先发射再推进 1/20 秒
    assert bullet.x == pytest.approx(24.0 + tank.MUZZLE_OFFSET + tank.BULLET_SPEED * DT)
    assert bullet.y == pytest.approx(24.0)
    assert bullet.vx == pytest.approx(tank.BULLET_SPEED)


def test_bullet_hit_damage_and_event() -> None:
    world = make_world(seed=3)
    clear_obstacles(world)
    place(world, "a", 10.0, 24.0, hull=0.0, turret=0.0)
    place(world, "b", 16.0, 24.0, hull=math.pi, turret=math.pi)
    world.apply_input("a", flags=tank.INPUT_FIRE, aim=0)

    events = step(world, 10)
    hits = [event for event in events if event["kind"] == "hit"]
    assert len(hits) == 1
    hit = hits[0]
    assert hit["shooterId"] == "a"
    assert hit["targetId"] == "b"
    assert hit["damage"] == tank.BULLET_DAMAGE == 25
    assert isinstance(hit["x"], float) and isinstance(hit["y"], float)
    assert hit["x"] == pytest.approx(16.0 - tank.TANK_RADIUS - tank.BULLET_RADIUS, abs=0.4)

    victim = tank_entity(world, "b")
    assert victim is not None
    assert victim.hp == 75
    json.dumps(events)


def test_four_shots_kill_scores_and_respawn_shield() -> None:
    world = make_world(seed=3)
    clear_obstacles(world)
    events = kill_once(world, "a", "b")

    kills = [event for event in events if event["kind"] == "kill"]
    assert len(kills) == 1
    kill = kills[0]
    assert kill["shooterId"] == "a" and kill["targetId"] == "b"
    assert isinstance(kill["x"], float) and isinstance(kill["y"], float)
    assert world.scores() == {
        "a": {"kills": 1, "deaths": 0},
        "b": {"kills": 0, "deaths": 1},
    }
    # 死亡期间不产出该坦克实体，也没有子弹残留到下一帧的误判
    assert tank_entity(world, "b") is None
    assert tank_entity(world, "a") is not None

    # 3 秒复活：满血 + 出生无敌
    respawn_events = step(world, 70)
    respawns = [event for event in respawn_events if event["kind"] == "respawn"]
    assert len(respawns) == 1
    assert respawns[0]["playerId"] == "b"
    respawned = tank_entity(world, "b")
    assert respawned is not None
    assert respawned.hp == tank.TANK_HP
    assert respawned.shielded is True
    assert world.scores()["b"]["deaths"] == 1


def test_respawn_shield_blocks_bullets_then_expires() -> None:
    world = make_world(seed=3)
    clear_obstacles(world)
    kill_once(world, "a", "b")
    step(world, 70)  # 等复活
    assert tank_entity(world, "b") is not None
    assert tank_entity(world, "b").shielded is True  # type: ignore[union-attr]

    # 把两人摆回一条直线：无敌期内子弹穿过，不掉血
    clear_bullets(world)
    place(world, "a", 10.0, 24.0, hull=0.0, turret=0.0)
    place(world, "b", 16.0, 24.0, hull=math.pi, turret=math.pi)
    world.apply_input("a", flags=tank.INPUT_FIRE, aim=0)
    events = step(world, 6)
    assert not any(event["kind"] == "hit" for event in events)
    assert tank_entity(world, "b").hp == tank.TANK_HP  # type: ignore[union-attr]

    # 手动结束无敌（等价于 1.5 秒后），随后同一弹道可以造成伤害
    world._players["b"].shield_timer = 0.0
    events = step(world, 30)
    hits = [event for event in events if event["kind"] == "hit"]
    assert hits, "无敌结束后应能命中"
    assert tank_entity(world, "b").hp == tank.TANK_HP - tank.BULLET_DAMAGE  # type: ignore[union-attr]


def test_obstacle_blocks_bullets() -> None:
    world = make_world(seed=3)
    clear_obstacles(world)
    world._obstacles = [tank.Obstacle(13.0, 22.0, 2.0, 4.0)]
    place(world, "a", 10.0, 24.0, hull=0.0, turret=0.0)
    place(world, "b", 18.0, 24.0, hull=math.pi, turret=math.pi)
    world.apply_input("a", flags=tank.INPUT_FIRE, aim=0)
    events = step(world, 60)
    assert not any(event["kind"] == "hit" for event in events)
    victim = tank_entity(world, "b")
    assert victim is not None and victim.hp == tank.TANK_HP


# ----------------------------------------------------------------------
# 结束条件
# ----------------------------------------------------------------------


def test_match_end_by_kills_only_once(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tank, "TARGET_KILLS", 1)
    world = make_world(seed=3)
    clear_obstacles(world)
    events = kill_once(world, "a", "b")

    assert world.finished() is True
    assert world.ended_reason() == "kills"
    assert world.winner() == "a"
    assert world.info()["endedReason"] == "kills"
    assert world.info()["winnerId"] == "a"
    match_ends = [event for event in events if event["kind"] == "match_end"]
    assert len(match_ends) == 1
    assert match_ends[-1] == {"kind": "match_end", "winnerId": "a", "reason": "kills"}

    # 结束后 tick 不再推进物理，也不会重复发 match_end
    snapshot = world.entities()
    assert world.tick(DT) == []
    assert world.tick(DT) == []
    assert world.entities() == snapshot


def test_match_end_by_time_only_once(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tank, "MATCH_SECONDS", 0.2)
    world = make_world(seed=3, started_at_ms=5000)
    info = world.info()
    assert info["endsAt"] == 5000 + 200

    events: list[dict] = []
    for _ in range(3):
        events.extend(world.tick(DT))
    assert not any(event["kind"] == "match_end" for event in events)
    assert world.finished() is False

    events.extend(world.tick(DT))  # elapsed = 0.2
    match_ends = [event for event in events if event["kind"] == "match_end"]
    assert len(match_ends) == 1
    assert match_ends[0]["reason"] == "time"
    assert match_ends[0]["winnerId"] is None  # 0:0 并列
    assert world.finished() is True
    assert world.info()["phase"] == "finished"
    assert world.tick(DT) == []


def test_end_match_forfeit() -> None:
    world = make_world(seed=3)
    world.end_match("forfeit")
    assert world.finished() is True
    assert world.ended_reason() == "forfeit"
    assert world.winner() is None

    events = world.tick(DT)
    assert events == [{"kind": "match_end", "winnerId": None, "reason": "forfeit"}]
    assert world.tick(DT) == []
    # 重复调用保持第一次的结果
    world.end_match("time")
    assert world.ended_reason() == "forfeit"
    assert world.tick(DT) == []


def test_winner_uses_top_kills_and_ties_are_draw() -> None:
    world = make_world(seed=3)
    world._scores["a"]["kills"] = 3
    world._scores["b"]["kills"] = 1
    world.end_match("time")
    assert world.winner() == "a"

    tied = make_world(seed=3)
    tied._scores["a"]["kills"] = 2
    tied._scores["b"]["kills"] = 2
    tied.end_match("time")
    assert tied.winner() is None


# ----------------------------------------------------------------------
# 座位 / 容量 / 非法输入
# ----------------------------------------------------------------------


def test_eight_player_capacity_and_slot_reuse() -> None:
    players = [(f"p{index}", f"P{index}") for index in range(tank.MAX_PLAYERS)]
    world = make_world(players, seed=4)
    assert sorted(world.player_slots().values()) == list(range(8))
    tank_ids = sorted(entity.entity_id for entity in world.entities())
    assert tank_ids == [1, 2, 3, 4, 5, 6, 7, 8]

    assert world.add_player("p8", "P8") is False
    world.remove_player("p3")
    assert "p3" not in world.player_slots()
    assert world.add_player("p8", "P8") is True
    assert world.player_slots()["p8"] == 3
    assert world.add_player("p8", "P8") is True  # 幂等
    assert len(world.player_slots()) == 8

    # 多给的玩家被截断，不会抛异常
    overflow = tank.TankWorld([(f"x{index}", f"X{index}") for index in range(12)], seed=4)
    assert len(overflow.player_slots()) == 8

    world.end_match("forfeit")
    assert world.add_player("p9", "P9") is False


def test_invalid_inputs_do_not_raise() -> None:
    world = make_world([("a", "A")], seed=3)
    assert world.apply_input is not None

    # 未知玩家 / 越界值 / 非数值：夹紧或忽略，不抛异常
    world.apply_input("ghost", flags=1, aim=1)
    world.apply_input("a", flags=-100, aim=-1)
    world.apply_input("a", flags=10**9, aim=10**9)
    world.apply_input("a", flags=None, aim="nope")  # type: ignore[arg-type]
    world.apply_input("a", flags=float("nan"), aim=float("inf"))  # type: ignore[arg-type]
    world.remove_player("ghost")

    # 非法 dt：不推进
    assert world.tick(0) == []
    assert world.tick(-1) == []
    assert world.tick(float("nan")) == []
    assert world.tick(float("inf")) == []
    assert world.finished() is False

    # 夹紧后的输入仍可用；未知玩家不产生实体
    world.apply_input("a", flags=0xFFFF, aim=0)
    world.tick(DT)
    entity = tank_entity(world, "a")
    assert entity is not None
    assert entity.turret == pytest.approx(0.0)

    # 结束后继续发输入/移除玩家也不抛异常；单人局唯一击杀最高者即 winner
    world.end_match("forfeit")
    world.apply_input("a", flags=tank.INPUT_FIRE, aim=0)
    world.remove_player("a")
    assert world.tick(DT) == [{"kind": "match_end", "winnerId": "a", "reason": "forfeit"}]


# ----------------------------------------------------------------------
# 确定性
# ----------------------------------------------------------------------


def _run_deterministic_scenario(seed: int) -> tuple[dict, list[dict], list[tuple]]:
    world = make_world([("a", "A"), ("b", "B"), ("c", "C")], seed=seed, started_at_ms=123456)
    events: list[dict] = []
    snapshots: list[tuple] = []
    for index in range(160):
        for offset, player_id in enumerate(("a", "b", "c")):
            flags = (index * 7 + offset * 13) % 64
            aim = (index * 911 + offset * 7919) % 0x10000
            world.apply_input(player_id, flags=flags, aim=aim)
        events.extend(world.tick(DT))
        snapshots.append(
            tuple(
                (
                    entity.entity_id,
                    entity.kind,
                    entity.owner_slot,
                    entity.x,
                    entity.y,
                    entity.vx,
                    entity.vy,
                    entity.hull,
                    entity.turret,
                    entity.hp,
                    entity.shielded,
                )
                for entity in world.entities()
            )
        )
    return world.info()["map"], events, snapshots


def test_same_seed_same_map_and_fire_sequence() -> None:
    map_a, events_a, snapshots_a = _run_deterministic_scenario(2024)
    map_b, events_b, snapshots_b = _run_deterministic_scenario(2024)
    assert map_a == map_b
    assert events_a == events_b
    assert snapshots_a == snapshots_b
    # 场景里确实开过火，确定性覆盖到子弹 id 序列
    assert any(entity[1] == 1 for snapshot in snapshots_a for entity in snapshot)


def test_different_seed_different_map() -> None:
    map_a = make_world(seed=1).info()["map"]
    map_b = make_world(seed=2).info()["map"]
    assert map_a["obstacles"] != map_b["obstacles"]
