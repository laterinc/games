"""坦克大战实时房间端到端测试：开局、二进制快照、输入驱动、离开结算。

用 fastapi.testclient 的 WebSocketTestSession：服务端 tick 循环由 TestClient 的
事件循环线程驱动，因此这里能真实跑到 20Hz 快照与输入合并。
"""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from app.main import create_app
from app.realtime import codec


def _welcome(ws) -> dict[str, Any]:
    message = ws.receive_json()
    assert message["type"] == "welcome", message
    assert message["binary"] is True
    assert message["tickRate"] == 20
    records = ws.receive_json()
    assert records["type"] == "records"
    return message


def _recv(ws) -> tuple[str, Any]:
    """读一条入站帧：("json", dict) 或 ("binary", bytes)。"""
    message = ws.receive()
    if message["type"] == "websocket.close":
        raise AssertionError(f"连接被服务端关闭：{message}")
    assert message["type"] == "websocket.send", message
    if message.get("bytes") is not None:
        return "binary", message["bytes"]
    return "json", json.loads(message["text"])


def _recv_json(ws, *, wanted: str | None = None, limit: int = 2000) -> dict[str, Any]:
    for _ in range(limit):
        kind, data = _recv(ws)
        if kind == "json" and (wanted is None or data.get("type") == wanted):
            return data
    raise AssertionError(f"没有收到 {wanted} 帧")


def _recv_room(ws, *, status: str | None = None, limit: int = 2000) -> dict[str, Any]:
    for _ in range(limit):
        data = _recv_json(ws, wanted="room")
        room = data["room"]
        if room is not None and (status is None or room["status"] == status):
            return room
    raise AssertionError(f"没有收到状态为 {status} 的房间快照")


def _recv_keyframe(ws, limit: int = 400) -> codec.SnapshotKeyframe:
    for _ in range(limit):
        kind, data = _recv(ws)
        if kind != "binary":
            continue
        frame = codec.decode_snapshot(data)
        if isinstance(frame, codec.SnapshotKeyframe):
            return frame
    raise AssertionError("没有收到二进制关键帧")


def _tank_position(frame: codec.SnapshotKeyframe, entity_id: int) -> tuple[int, int] | None:
    for entity in frame.entities:
        if entity.entity_id == entity_id:
            return entity.x, entity.y
    return None


def test_tank_room_starts_streams_and_moves() -> None:
    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as ws_a:
            _welcome(ws_a)
            ws_a.send_json(
                {
                    "type": "create_room",
                    "name": "甲",
                    "gameType": "tank",
                    "visibility": "private",
                    "color": "red",
                }
            )
            room = _recv_room(ws_a)
            assert room["gameType"] == "tank"
            assert room["status"] == "waiting"
            assert room["game"]["phase"] == "waiting"
            assert room["game"]["map"] is None
            room_id = room["id"]

            with client.websocket_connect("/ws") as ws_b:
                _welcome(ws_b)
                ws_b.send_json({"type": "join_room", "roomId": room_id, "name": "乙"})
                joined = _recv_room(ws_b)
                assert len(joined["players"]) == 2
                assert {player["slot"] for player in joined["players"]} == {0, 1}

                ws_a.send_json({"type": "ready"})
                _recv_room(ws_a)
                ws_b.send_json({"type": "ready"})

                playing = _recv_room(ws_b, status="playing")
                assert playing["game"]["phase"] == "playing"
                assert playing["game"]["tickRate"] == 20
                assert playing["game"]["targetKills"] == 15
                assert playing["game"]["endsAt"] is not None
                tank_map = playing["game"]["map"]
                assert tank_map["width"] == 48 and tank_map["height"] == 48
                assert tank_map["obstacles"], "地图应当有掩体"
                assert len(tank_map["spawns"]) == 8

                first = _recv_keyframe(ws_b)
                assert len(first.entities) == 2
                assert {entity.entity_id for entity in first.entities} == {1, 2}
                # 每个实体带车体角与炮塔角（u16 范围）
                for entity in first.entities:
                    assert 0 <= entity.angle <= 0xFFFF
                    assert 0 <= entity.turret <= 0xFFFF

                # 乙（slot 1，实体 2）持续前进：位置必须变化
                before = _tank_position(first, 2)
                assert before is not None
                for seq in range(30):
                    ws_b.send_bytes(
                        codec.encode_input(
                            codec.InputFrame(
                                seq=seq,
                                tick=0,
                                input_flags=codec.INPUT_UP,
                                aim=0,
                            )
                        )
                    )
                moved = None
                for _ in range(120):
                    frame = _recv_keyframe(ws_b)
                    after = _tank_position(frame, 2)
                    if after is not None and after != before:
                        moved = after
                        break
                assert moved is not None and moved != before

                # 非法二进制帧不应打断对局：之后仍能收到快照
                ws_b.send_bytes(b"\xde\xad\xbe\xef")
                assert _recv_keyframe(ws_b) is not None

                # 甲离开 → 不足 2 人，本局按弃权结束并下发给乙
                ws_a.send_json({"type": "leave_room"})
                finished = _recv_room(ws_b, status="finished")
                assert finished["game"]["phase"] == "finished"
                assert finished["game"]["endedReason"] == "forfeit"

                # 结算后仍可再来一局投票（最后一人同意即重开需要 2 人，这里只验证不报错）
                ws_b.send_json({"type": "chat", "text": "gg"})


def test_binary_rejected_outside_realtime_room() -> None:
    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as ws:
            _welcome(ws)
            ws.send_bytes(b"\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00")
            error = _recv_json(ws, wanted="error")
            assert error["code"] == "INVALID_MESSAGE"
