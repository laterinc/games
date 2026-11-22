"""坦克大战电脑对手：决策单测 + 人机房端到端。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.games.tank import TankWorld
from app.games.tank_ai import INPUT_FIRE, TankBotController
from app.main import create_app
from app.realtime import codec

from test_tank_room import _recv_json, _recv_keyframe, _recv_room, _welcome  # noqa: F401


def test_bot_moves_aims_and_scores() -> None:
    """静止的对手会在一个回合内被电脑坦克追上并打掉血。"""

    world = TankWorld([("human", "人类"), ("bot", "电脑1")], seed=7, started_at_ms=0)
    controller = TankBotController({"bot": 1}, world.info()["map"]["obstacles"], seed=11)
    start = next(entity for entity in world.entities() if entity.entity_id == 2)

    fired = 0
    for tick in range(600):
        flags, aim = controller.think("bot", world.entities(), 1 / 20)
        if flags & INPUT_FIRE:
            fired += 1
        world.apply_input("bot", flags=flags, aim=aim, tick=tick)
        world.tick(1 / 20)

    scores = world.scores()
    assert scores["bot"]["kills"] >= 1 or scores["human"]["deaths"] >= 1
    assert fired > 0, "电脑应当开过火"

    # 电脑确实移动过（不是原地转圈）
    view = world.entities()
    bot = next((entity for entity in view if entity.entity_id == 2), None)
    if bot is not None:
        assert abs(bot.x - start.x) + abs(bot.y - start.y) > 1.0


def test_difficulty_changes_aim_error() -> None:
    """简单档的瞄准误差应明显大于困难档。"""

    def average_error(difficulty: str) -> float:
        world = TankWorld([("human", "人类"), ("bot", "电脑1")], seed=5, started_at_ms=0)
        controller = TankBotController(
            {"bot": 1}, world.info()["map"]["obstacles"], seed=9, difficulty=difficulty
        )
        samples: list[float] = []
        for _ in range(240):
            controller.think("bot", world.entities(), 1 / 20)
            world.tick(1 / 20)
            samples.append(abs(controller.aim_error("bot")))
        return sum(samples) / len(samples)

    easy = average_error("easy")
    hard = average_error("hard")
    assert easy > hard * 1.5, f"简单档误差 {easy:.4f} 应显著大于困难档 {hard:.4f}"


def test_bot_ignores_unknown_and_dead_players() -> None:
    world = TankWorld([("bot", "电脑1")], seed=3, started_at_ms=0)
    controller = TankBotController({"bot": 0}, world.info()["map"]["obstacles"], seed=5)
    assert controller.think("missing", world.entities(), 1 / 20) == (0, 0)
    world.remove_player("bot")
    assert controller.think("bot", world.entities(), 1 / 20) == (0, 0)


def test_ai_tank_room_supports_any_bot_count() -> None:
    """1–7 台任意数量都能开局（总人数 2–8）。"""

    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as ws:
            _welcome(ws)
            for count in (1, 4, 7):
                ws.send_json(
                    {
                        "type": "create_room",
                        "name": "小明",
                        "gameType": "tank",
                        "mode": "ai",
                        "botCount": count,
                    }
                )
                room = _recv_room(ws, status="playing")
                assert len(room["players"]) == count + 1
                assert sum(1 for player in room["players"] if player["isBot"]) == count
                ws.send_json({"type": "leave_room"})
                _recv_json(ws, wanted="room")


def test_ai_tank_room_end_to_end() -> None:
    """建房选人机 → 立即开局 → 实体含电脑坦克 → 电脑会移动/开火 → 离开后房间解散。"""

    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as ws:
            _welcome(ws)
            ws.send_json(
                {
                    "type": "create_room",
                    "name": "小明",
                    "gameType": "tank",
                    "mode": "ai",
                    "botCount": 1,
                    "color": "red",
                }
            )
            room = _recv_room(ws, status="playing")
            assert room["mode"] == "ai"
            assert room["visibility"] == "private"
            players = room["players"]
            assert len(players) == 2
            bots = [player for player in players if player["isBot"]]
            assert len(bots) == 1
            assert {player["slot"] for player in players} == {0, 1}
            room_id = room["id"]

            first = _recv_keyframe(ws)
            assert {entity.entity_id for entity in first.entities if (entity.flags & 0x03) == 0} == {1, 2}
            before = {
                entity.entity_id: (entity.x, entity.y)
                for entity in first.entities
                if (entity.flags & 0x03) == 0
            }

            moved = False
            saw_bullet = False
            # 单台电脑会直奔玩家；随机地图下最多等 16 秒（320 帧 @20Hz）。
            # 只要求「开始行动（移动或开火）」，避免被随机掩体布局拖成偶发失败；
            # 精确的移动/开火/击杀行为由 test_bot_moves_aims_and_scores 用固定 seed 覆盖。
            for _ in range(320):
                frame = _recv_keyframe(ws)
                for entity in frame.entities:
                    if (entity.flags & 0x03) == 1:
                        saw_bullet = True
                    elif entity.entity_id in before:
                        origin = before[entity.entity_id]
                        if abs(entity.x - origin[0]) + abs(entity.y - origin[1]) > 20:
                            moved = True
                if moved or saw_bullet:
                    break
            assert moved or saw_bullet, "电脑坦克应当开始移动或开火"

            # 非法难度一律拒绝
            ws.send_json({"type": "leave_room"})
            _recv_json(ws, wanted="room")
            ws.send_json(
                {
                    "type": "create_room",
                    "name": "小明",
                    "gameType": "tank",
                    "mode": "ai",
                    "botCount": 1,
                    "botDifficulty": "insane",
                }
            )
            error = _recv_json(ws, wanted="error")
            assert error["code"] == "INVALID_MESSAGE"

            # 合法难度可以直接开局
            ws.send_json(
                {
                    "type": "create_room",
                    "name": "小明",
                    "gameType": "tank",
                    "mode": "ai",
                    "botCount": 1,
                    "botDifficulty": "easy",
                }
            )
            room_easy = _recv_room(ws, status="playing")
            assert room_easy["mode"] == "ai"
            ws.send_json({"type": "leave_room"})
            _recv_json(ws, wanted="room")

            # 非法 botCount 一律拒绝
            ws.send_json(
                {
                    "type": "create_room",
                    "name": "小明",
                    "gameType": "tank",
                    "mode": "ai",
                    "botCount": 8,
                }
            )
            error = _recv_json(ws, wanted="error")
            assert error["code"] == "INVALID_MESSAGE"

            # 真人离开后房间直接解散（不能只剩电脑互打）
            ws.send_json(
                {
                    "type": "create_room",
                    "name": "小明",
                    "gameType": "tank",
                    "mode": "ai",
                    "botCount": 1,
                }
            )
            room = _recv_room(ws, status="playing")
            ws.send_json({"type": "leave_room"})
            leftovers = _recv_json(ws, wanted="room")
            assert leftovers["room"] is None
