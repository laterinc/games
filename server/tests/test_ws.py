"""WebSocket 端到端测试（fastapi.testclient.TestClient，不依赖外网）。"""

from __future__ import annotations

import uuid
from dataclasses import replace
from typing import Any

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.main import create_app
from app.protocol import PROTOCOL_VERSION

WELCOME_KEYS = {
    "type",
    "playerId",
    "reconnected",
    "serverTime",
    "protocolVersion",
    # 协议 v3 能力协商：实时游戏（坦克大战）的二进制帧与 tick 频率
    "binary",
    "tickRate",
}


def _welcome(ws, *, reconnected: bool | None = None) -> dict[str, Any]:
    message = ws.receive_json()
    assert message["type"] == "welcome", message
    assert set(message) == WELCOME_KEYS
    if reconnected is not None:
        assert message["reconnected"] is reconnected
    assert message["protocolVersion"] == PROTOCOL_VERSION
    # 身份是标准 UUID v4（首次访问由服务端生成）
    assert uuid.UUID(message["playerId"]).version == 4
    assert isinstance(message["serverTime"], int)
    assert message["binary"] is True
    assert message["tickRate"] == 20
    # welcome 之后紧跟一条当前玩家的最近战绩
    records = ws.receive_json()
    assert records["type"] == "records", records
    assert isinstance(records["records"], list)
    return message


def _read_type(ws, expected: str) -> dict[str, Any]:
    message = ws.receive_json()
    assert message["type"] == expected, message
    return message


def _read_room(ws) -> dict[str, Any]:
    message = _read_type(ws, "room")
    assert message["room"] is not None
    return message["room"]


def _read_rooms(ws) -> list[dict[str, Any]]:
    message = _read_type(ws, "rooms")
    return message["rooms"]


def _read_error(ws, code: str) -> dict[str, Any]:
    message = _read_type(ws, "error")
    assert message["code"] == code, message
    assert isinstance(message["message"], str) and message["message"]
    return message


def _create_room(ws, *, name: str = "小明", room_name: str = "", **extra: Any) -> dict[str, Any]:
    payload = {"type": "create_room", "name": name, "roomName": room_name, **extra}
    ws.send_json(payload)
    return _read_room(ws)


def test_welcome_ping_protocol_errors() -> None:
    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as ws:
            welcome = _welcome(ws)

            ws.send_json({"type": "ping"})
            pong = _read_type(ws, "pong")
            assert isinstance(pong["t"], int)
            assert pong["t"] > 1_600_000_000_000

            # 未知类型
            ws.send_json({"type": "no_such_type"})
            _read_error(ws, "UNKNOWN_TYPE")

            # 非法 JSON
            ws.send_text("this is not json")
            _read_error(ws, "INVALID_MESSAGE")

            # 缺少 type
            ws.send_json({"row": 1})
            _read_error(ws, "INVALID_MESSAGE")

            # 非对象 JSON
            ws.send_json([1, 2, 3])
            _read_error(ws, "INVALID_MESSAGE")

            # 不在房间时落子
            ws.send_json({"type": "move", "row": 0, "col": 0})
            _read_error(ws, "NOT_IN_ROOM")

            # 字段类型错误
            ws.send_json({"type": "move", "row": "0", "col": 0})
            _read_error(ws, "NOT_IN_ROOM")

            # list_rooms 随时可拉
            ws.send_json({"type": "list_rooms"})
            assert _read_rooms(ws) == []

            # 身份仍是 welcome 下发的那个
            room = _create_room(ws)
            assert room["hostId"] == welcome["playerId"]


def test_create_room_validation_errors() -> None:
    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as ws:
            _welcome(ws)

            ws.send_json({"type": "create_room", "name": "   "})
            _read_error(ws, "INVALID_NAME")

            ws.send_json({"type": "create_room", "name": "虫" * 17})
            _read_error(ws, "INVALID_NAME")

            ws.send_json({"type": "create_room"})
            _read_error(ws, "INVALID_MESSAGE")

            ws.send_json({"type": "create_room", "name": "小明", "roomName": "牌" * 25})
            _read_error(ws, "INVALID_ROOM_NAME")

            ws.send_json({"type": "create_room", "name": "小明", "visibility": "secret"})
            _read_error(ws, "INVALID_MESSAGE")

            ws.send_json({"type": "create_room", "name": "小明", "color": "purple"})
            _read_error(ws, "INVALID_MESSAGE")

            room = _create_room(ws, name="小明")
            assert room["name"] == "小明的棋局"
            assert room["visibility"] == "public"
            assert room["players"][0]["color"] == "black"

            ws.send_json({"type": "create_room", "name": "小明"})
            _read_error(ws, "ALREADY_IN_ROOM")

            ws.send_json({"type": "leave_room"})
            assert _read_type(ws, "room")["room"] is None


def test_full_two_player_game_and_rematch() -> None:
    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as black_ws, client.websocket_connect(
            "/ws"
        ) as white_ws:
            black_welcome = _welcome(black_ws)
            white_welcome = _welcome(white_ws)
            black_id = black_welcome["playerId"]
            white_id = white_welcome["playerId"]

            black_ws.send_json(
                {"type": "create_room", "name": "小明", "roomName": "午后棋局"}
            )
            room = _read_room(black_ws)
            # 白方此时还在大厅，会先收到一次大厅推送
            assert _read_rooms(white_ws)[0]["id"] == room["id"]
            assert room["name"] == "午后棋局"
            assert room["status"] == "waiting"
            assert room["players"][0]["id"] == black_id
            assert len(room["game"]["board"]) == 15

            white_ws.send_json(
                {"type": "join_room", "roomId": room["id"], "name": "小红"}
            )
            joined_black = _read_room(black_ws)
            joined_white = _read_room(white_ws)
            assert joined_black == joined_white
            assert [p["color"] for p in joined_white["players"]] == ["black", "white"]
            assert joined_white["players"][0]["isHost"] is True

            black_ws.send_json({"type": "ready"})
            ready_black = _read_room(black_ws)
            _read_room(white_ws)
            assert ready_black["players"][0]["ready"] is True
            assert ready_black["status"] == "waiting"

            white_ws.send_json({"type": "ready"})
            started_black = _read_room(black_ws)
            started_white = _read_room(white_ws)
            assert started_black == started_white
            assert started_black["status"] == "playing"
            assert started_black["game"]["currentTurn"] == "black"
            assert started_black["game"]["startedAt"] is not None

            latest = started_black
            for index in range(5):
                black_ws.send_json({"type": "move", "row": 7, "col": 7 + index})
                latest = _read_room(black_ws)
                assert _read_room(white_ws) == latest
                assert latest["game"]["lastMove"] == {"row": 7, "col": 7 + index}
                if index < 4:
                    white_ws.send_json({"type": "move", "row": 0, "col": index})
                    latest = _read_room(black_ws)
                    assert _read_room(white_ws) == latest
                    assert latest["game"]["currentTurn"] == "black"

            assert latest["status"] == "finished"
            assert latest["game"]["winner"] == "black"
            assert latest["game"]["endedReason"] == "five"
            assert latest["game"]["endedAt"] is not None
            win_line = latest["game"]["winLine"]
            assert win_line is not None and len(win_line) == 5
            assert latest["game"]["moves"] and len(latest["game"]["moves"]) == 9

            # 终局后服务端会推送双方各自的最近战绩
            assert _read_type(black_ws, "records")["records"][0]["result"] == "win"
            assert _read_type(white_ws, "records")["records"][0]["result"] == "loss"

            # 双方 rematch，交换黑白并重开
            black_ws.send_json({"type": "rematch"})
            vote = _read_room(black_ws)
            assert _read_room(white_ws) == vote
            assert vote["rematchVotes"] == [black_id]
            assert vote["status"] == "finished"

            white_ws.send_json({"type": "rematch"})
            rematch_black = _read_room(black_ws)
            assert _read_room(white_ws) == rematch_black
            assert rematch_black["status"] == "playing"
            assert rematch_black["rematchVotes"] == []
            assert rematch_black["game"]["winner"] is None
            assert rematch_black["game"]["winLine"] is None
            assert rematch_black["game"]["endedReason"] is None
            assert rematch_black["game"]["moves"] == []
            colors = {p["id"]: p["color"] for p in rematch_black["players"]}
            assert colors[black_id] == "white"
            assert colors[white_id] == "black"
            assert rematch_black["game"]["currentTurn"] == "black"


def test_room_errors_and_turn_validation() -> None:
    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as a, client.websocket_connect(
            "/ws"
        ) as b, client.websocket_connect("/ws") as c:
            a_welcome = _welcome(a)
            b_welcome = _welcome(b)
            _welcome(c)

            # 房间不存在
            b.send_json({"type": "join_room", "roomId": "NOPE00", "name": "小红"})
            _read_error(b, "ROOM_NOT_FOUND")

            room = _create_room(a, name="小明")
            _read_rooms(b)  # 大厅推送
            _read_rooms(c)
            b.send_json({"type": "join_room", "roomId": room["id"], "name": "小红"})
            _read_room(a)
            _read_room(b)
            _read_rooms(c)  # 大厅推送：playerCount 变化

            # 已在同一房间：幂等，直接重发快照（刷新后误点「加入」也能恢复）
            b.send_json({"type": "join_room", "roomId": room["id"], "name": "小红"})
            assert _read_room(b)["id"] == room["id"]
            _read_room(a)

            # 房间已满
            c.send_json({"type": "join_room", "roomId": room["id"], "name": "小刚"})
            _read_error(c, "ROOM_FULL")

            # waiting 房间不能落子
            a.send_json({"type": "move", "row": 0, "col": 0})
            _read_error(a, "GAME_NOT_ACTIVE")

            # 双方 ready 开局
            a.send_json({"type": "ready"})
            _read_room(a)
            _read_room(b)
            b.send_json({"type": "ready"})
            _read_room(a)
            _read_room(b)
            _read_rooms(c)  # 开局后房间从大厅移除

            # 已开始的房间不能加入
            c.send_json({"type": "join_room", "roomId": room["id"], "name": "小刚"})
            _read_error(c, "ROOM_STARTED")

            # 未轮到白方
            b.send_json({"type": "move", "row": 7, "col": 7})
            _read_error(b, "NOT_YOUR_TURN")

            # 越界 / 非整数坐标
            a.send_json({"type": "move", "row": 15, "col": 0})
            _read_error(a, "INVALID_MOVE")
            a.send_json({"type": "move", "row": -1, "col": 0})
            _read_error(a, "INVALID_MOVE")
            a.send_json({"type": "move", "row": True, "col": 0})
            _read_error(a, "INVALID_MOVE")

            # 合法落子后重复落子
            a.send_json({"type": "move", "row": 7, "col": 7})
            _read_room(a)
            _read_room(b)
            b.send_json({"type": "move", "row": 7, "col": 7})
            _read_error(b, "INVALID_MOVE")

            # playing 中不能 ready / rematch
            a.send_json({"type": "ready"})
            _read_error(a, "GAME_NOT_ACTIVE")
            a.send_json({"type": "rematch"})
            _read_error(a, "GAME_NOT_ACTIVE")

            # 不在房间
            c.send_json({"type": "leave_room"})
            _read_error(c, "NOT_IN_ROOM")

            # 房间玩家身份正确
            assert a_welcome["playerId"] != b_welcome["playerId"]


def test_uid_query_reconnect_restores_room() -> None:
    """前端用 localStorage 里的 UUID 重连：认回同一玩家与房间座位。"""
    app = create_app()
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as first:
            welcome = _welcome(first, reconnected=False)
            room = _create_room(first, name="小明", roomName="重连测试")
            player_id = welcome["playerId"]

        with client.websocket_connect(f"/ws?uid={player_id}") as second:
            recovered = _welcome(second, reconnected=True)
            assert recovered["playerId"] == player_id
            assert recovered["protocolVersion"] == PROTOCOL_VERSION

            snapshot = _read_room(second)
            assert snapshot["id"] == room["id"]
            assert snapshot["players"][0]["id"] == player_id
            assert snapshot["players"][0]["connected"] is True

            # 重连后仍可正常操作
            second.send_json({"type": "chat", "text": "我回来了"})
            chat = _read_type(second, "chat")
            assert chat["message"]["text"] == "我回来了"
            assert chat["message"]["id"] == "m_1"

            second.send_json({"type": "leave_room"})
            assert _read_type(second, "room")["room"] is None


def test_client_supplied_uid_is_adopted() -> None:
    """前端主动提供 UUID 时服务端直接采用，不再生成新身份。"""
    client_uid = str(uuid.uuid4())
    with TestClient(create_app()) as client:
        with client.websocket_connect(f"/ws?uid={client_uid}") as ws:
            welcome = _welcome(ws, reconnected=False)
            assert welcome["playerId"] == client_uid

        # 非法 UUID 不受信任：生成新的合法身份
        with client.websocket_connect("/ws?uid=not-a-uuid") as ws:
            fresh = _welcome(ws, reconnected=False)
            assert fresh["playerId"] != "not-a-uuid"
            assert uuid.UUID(fresh["playerId"]).version == 4


def test_lobby_push_list_pull_and_rest() -> None:
    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as lobby, client.websocket_connect(
            "/ws"
        ) as host, client.websocket_connect("/ws") as joiner:
            _welcome(lobby)
            _welcome(host)
            _welcome(joiner)

            room = _create_room(host, name="小明", roomName="大厅测试")
            pushed = _read_rooms(lobby)

            # 其他在大厅的连接也收到推送（joiner 尚未进入房间）
            assert _read_rooms(joiner) == pushed
            assert pushed == [
                {
                    "id": room["id"],
                    "name": "大厅测试",
                    "gameType": "gomoku",
                    "boardSize": 15,
                    "status": "waiting",
                    "playerCount": 1,
                    "maxPlayers": 2,
                    "hostName": "小明",
                    "createdAt": room["createdAt"],
                }
            ]

            # 主动 list_rooms
            lobby.send_json({"type": "list_rooms"})
            assert _read_rooms(lobby) == pushed

            # REST /api/rooms 与推送结构一致
            response = client.get("/api/rooms")
            assert response.status_code == 200
            assert response.json() == {"rooms": pushed}

            # 加入后大厅收到 playerCount 变化
            joiner.send_json({"type": "join_room", "roomId": room["id"], "name": "小红"})
            _read_room(host)
            _read_room(joiner)
            updated = _read_rooms(lobby)
            assert updated[0]["playerCount"] == 2

            # 开局后房间从大厅列表消失
            host.send_json({"type": "ready"})
            _read_room(host)
            _read_room(joiner)
            joiner.send_json({"type": "ready"})
            _read_room(host)
            _read_room(joiner)
            assert _read_rooms(lobby) == []
            assert client.get("/api/rooms").json() == {"rooms": []}

        # health / config 结构
        health = client.get("/api/health")
        assert health.status_code == 200
        body = health.json()
        assert body["status"] == "ok"
        assert body["version"] == "1.0.0"
        assert isinstance(body["uptimeSeconds"], float)
        assert isinstance(body["rooms"], int)
        assert isinstance(body["connections"], int)
        assert isinstance(body["serverTime"], int)

        config = client.get("/api/config").json()
        assert config["protocolVersion"] == PROTOCOL_VERSION
        assert config["boardSize"] == 15
        assert config["maxPlayers"] == 2
        assert isinstance(config["appName"], str)
        assert {item["key"] for item in config["games"]} >= {"gomoku", "chess"}

        unknown = client.get("/api/nope")
        assert unknown.status_code == 404
        assert unknown.headers["content-type"].startswith("application/json")
        assert unknown.json()["error"] == "NOT_FOUND"


def test_private_room_not_in_rest_list() -> None:
    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as ws:
            _welcome(ws)
            room = _create_room(ws, name="小明", roomName="私密", visibility="private")
            assert room["visibility"] == "private"
            assert client.get("/api/rooms").json() == {"rooms": []}


def test_quick_match_pairing() -> None:
    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as a, client.websocket_connect(
            "/ws"
        ) as b:
            a_welcome = _welcome(a)
            _welcome(b)

            a.send_json({"type": "quick_match", "name": "小明"})
            room_a = _read_room(a)
            assert _read_rooms(b)[0]["id"] == room_a["id"]  # 大厅推送
            assert room_a["visibility"] == "public"
            assert room_a["hostId"] == a_welcome["playerId"]

            b.send_json({"type": "quick_match", "name": "小红"})
            room_b = _read_room(b)
            assert _read_room(a) == room_b
            assert room_b["id"] == room_a["id"]
            assert len(room_b["players"]) == 2
            assert [p["color"] for p in room_b["players"]] == ["black", "white"]

            a.send_json({"type": "ready"})
            _read_room(a)
            _read_room(b)
            b.send_json({"type": "ready"})
            started_a = _read_room(a)
            started_b = _read_room(b)
            assert started_a == started_b
            assert started_a["status"] == "playing"


def test_chat_broadcast_and_snapshot() -> None:
    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as a, client.websocket_connect(
            "/ws"
        ) as b:
            a_welcome = _welcome(a)
            _welcome(b)
            room = _create_room(a, name="小明")
            _read_rooms(b)  # 大厅推送
            b.send_json({"type": "join_room", "roomId": room["id"], "name": "小红"})
            _read_room(a)
            _read_room(b)

            a.send_json({"type": "chat", "text": "  好棋！  "})
            chat_a = _read_type(a, "chat")
            chat_b = _read_type(b, "chat")
            assert chat_a == chat_b
            message = chat_a["message"]
            assert message["id"] == "m_1"
            assert message["playerId"] == a_welcome["playerId"]
            assert message["name"] == "小明"
            assert message["text"] == "好棋！"
            assert isinstance(message["at"], int)

            # 聊天为空 / 超长
            a.send_json({"type": "chat", "text": "   "})
            _read_error(a, "INVALID_MESSAGE")
            a.send_json({"type": "chat", "text": "长" * 201})
            _read_error(a, "INVALID_MESSAGE")

            # 聊天记录随 room 快照下发
            a.send_json({"type": "ready"})
            _read_room(a)
            _read_room(b)
            b.send_json({"type": "ready"})
            started = _read_room(a)
            _read_room(b)
            assert started["status"] == "playing"
            assert started["chat"] == [message]

            # 不在房间不能聊天
            with client.websocket_connect("/ws") as c:
                _welcome(c)
                c.send_json({"type": "chat", "text": "我也来"})
                _read_error(c, "NOT_IN_ROOM")


def test_rate_limit() -> None:
    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as ws:
            _welcome(ws)
            for _ in range(40):
                ws.send_json({"type": "ping"})
            for _ in range(40):
                _read_type(ws, "pong")
            ws.send_json({"type": "ping"})
            _read_error(ws, "RATE_LIMITED")


def test_disconnect_grace_forfeits_via_websocket() -> None:
    settings = Settings(disconnect_grace_seconds=0.1)
    app = create_app(settings)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as black_ws:
            _welcome(black_ws)
            with client.websocket_connect("/ws") as white_ws:
                _welcome(white_ws)
                room = _create_room(black_ws, name="小明")
                _read_rooms(white_ws)  # 大厅推送
                white_ws.send_json(
                    {"type": "join_room", "roomId": room["id"], "name": "小红"}
                )
                _read_room(black_ws)
                _read_room(white_ws)
                black_ws.send_json({"type": "ready"})
                _read_room(black_ws)
                _read_room(white_ws)
                white_ws.send_json({"type": "ready"})
                _read_room(black_ws)
                _read_room(white_ws)

            # 白方连接断开超过宽限期后按离开处理，黑方先看到 connected=false，
            # 随后收到 forfeit 结算（finished）与重置后的 waiting 快照。
            finished = None
            waiting = None
            notices: list[str] = []
            while waiting is None:
                message = black_ws.receive_json()
                if message["type"] == "notice":
                    notices.append(message["text"])
                elif message["type"] == "room" and message["room"] is not None:
                    room_state = message["room"]
                    if room_state["status"] == "finished":
                        finished = room_state
                    elif room_state["status"] == "waiting" and finished is not None:
                        waiting = room_state

            assert finished is not None
            assert finished["game"]["winner"] == "black"
            assert finished["game"]["endedReason"] == "forfeit"
            assert notices and "等待新对手" in notices[0]
            assert waiting is not None
            assert len(waiting["players"]) == 1
            assert waiting["hostId"] == finished["hostId"]


def test_websocket_origin_allowlist() -> None:
    """设置 ALLOWED_ORIGINS 时，只有白名单 Origin 能完成握手。"""
    settings = replace(Settings.from_env(), allowed_origins=("https://good.example",))
    app = create_app(settings)
    with TestClient(app) as client:
        with client.websocket_connect("/ws", headers={"origin": "https://good.example"}) as ws:
            assert ws.receive_json()["type"] == "welcome"

        try:
            with client.websocket_connect("/ws", headers={"origin": "https://evil.example"}) as ws:
                ws.receive_json()
        except WebSocketDisconnect as exc:
            assert exc.code == 1008
        else:  # pragma: no cover - 白名单失效时给出明确失败
            raise AssertionError("非白名单 Origin 不应完成 WebSocket 握手")


def test_spectator_watch_play_and_leave() -> None:
    """第三人在满房/开局后只能观战：看得到棋局与聊天，不占座、不能落子。"""
    app = create_app()
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as a, client.websocket_connect(
            "/ws"
        ) as b, client.websocket_connect("/ws") as c:
            _welcome(a)
            _welcome(b)
            c_welcome = _welcome(c)

            room = _create_room(a, name="小明")
            _read_rooms(b)
            _read_rooms(c)
            b.send_json({"type": "join_room", "roomId": room["id"], "name": "小红"})
            _read_room(a)
            _read_room(b)
            _read_rooms(c)

            a.send_json({"type": "ready"})
            _read_room(a)
            _read_room(b)
            b.send_json({"type": "ready"})
            _read_room(a)
            _read_room(b)
            _read_rooms(c)

            # 对局已开始：正常加入失败
            c.send_json({"type": "join_room", "roomId": room["id"], "name": "路人"})
            _read_error(c, "ROOM_STARTED")
            # 观战成功：拿到完整快照，观战人数 1
            c.send_json({"type": "watch_room", "roomId": room["id"], "name": "路人"})
            watcher_room = _read_room(c)
            assert watcher_room["spectators"] == 1
            assert all(p["id"] != c_welcome["playerId"] for p in watcher_room["players"])
            _read_room(a)
            _read_room(b)

            # 观战者不能落子
            c.send_json({"type": "move", "row": 0, "col": 0})
            _read_error(c, "NOT_IN_ROOM")

            # 对局落子会同步给观战者
            a.send_json({"type": "move", "row": 7, "col": 7})
            seen = _read_room(c)
            assert seen["game"]["lastMove"] == {"row": 7, "col": 7}
            _read_room(a)
            _read_room(b)

            # 观战者可以聊天
            c.send_json({"type": "chat", "text": "好棋"})
            chat = _read_type(a, "chat")
            assert chat["message"]["text"] == "好棋"
            _read_type(b, "chat")
            _read_type(c, "chat")

            # 观战者退出：房间观战人数归零
            c.send_json({"type": "leave_room"})
            assert c.receive_json()["room"] is None
            assert _read_room(a)["spectators"] == 0
            _read_room(b)


def test_spectator_cannot_watch_while_seated() -> None:
    app = create_app()
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as a:
            _welcome(a)
            room = _create_room(a)
            a.send_json({"type": "watch_room", "roomId": room["id"], "name": "小明"})
            _read_error(a, "ALREADY_IN_ROOM")


def test_uid_query_restores_player() -> None:
    """刷新/重开浏览器时凭 localStorage 里的 UUID 认回同一玩家。"""
    app = create_app()
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            welcome = _welcome(ws, reconnected=False)
        with client.websocket_connect(f"/ws?uid={welcome['playerId']}") as ws:
            again = _welcome(ws, reconnected=True)
            assert again["playerId"] == welcome["playerId"]

        # 未提供 UUID：分配新身份，不报错
        with client.websocket_connect("/ws") as ws:
            fresh = _welcome(ws, reconnected=False)
            assert fresh["playerId"] != welcome["playerId"]


def test_multiple_tabs_same_player_do_not_kick_each_other() -> None:
    """同一 playerId 允许多个连接（多标签页），广播到全部连接，不再互相顶号。"""
    app = create_app()
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as tab1:
            first = _welcome(tab1)

            with client.websocket_connect(f"/ws?uid={first['playerId']}") as tab2:
                second = _welcome(tab2, reconnected=True)
                assert second["playerId"] == first["playerId"]

                # 两个标签页都能收到同一个玩家身份的广播
                tab1.send_json({"type": "create_room", "name": "小明"})
                room1 = _read_room(tab1)
                room2 = _read_room(tab2)
                assert room1["id"] == room2["id"]

                # 一个标签页离开，另一个仍保持连接且能继续操作
                tab2.send_json({"type": "leave_room"})
                assert tab2.receive_json()["room"] is None
                assert tab1.receive_json()["room"] is None

                tab1.send_json({"type": "create_room", "name": "小明"})
                assert _read_room(tab1)["status"] == "waiting"


def test_resign_finishes_game_and_records() -> None:
    app = create_app()
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as a, client.websocket_connect("/ws") as b:
            _welcome(a)
            _welcome(b)
            room = _create_room(a, name="小明")
            _read_rooms(b)
            b.send_json({"type": "join_room", "roomId": room["id"], "name": "小红"})
            _read_room(a)
            _read_room(b)
            a.send_json({"type": "ready"})
            _read_room(a)
            _read_room(b)
            b.send_json({"type": "ready"})
            _read_room(a)
            _read_room(b)

            a.send_json({"type": "resign"})
            finished_a = _read_room(a)
            finished_b = _read_room(b)
            assert finished_a == finished_b
            assert finished_a["status"] == "finished"
            assert finished_a["game"]["winner"] == "white"
            assert finished_a["game"]["endedReason"] == "resign"
            assert _read_type(a, "records")["records"][0]["result"] == "loss"
            assert _read_type(b, "records")["records"][0]["result"] == "win"

def test_undo_request_accept_and_reject() -> None:
    app = create_app()
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as a, client.websocket_connect("/ws") as b:
            _welcome(a)
            b_welcome = _welcome(b)
            room = _create_room(a, name="小明")
            _read_rooms(b)
            b.send_json({"type": "join_room", "roomId": room["id"], "name": "小红"})
            _read_room(a)
            _read_room(b)
            a.send_json({"type": "ready"})
            _read_room(a)
            _read_room(b)
            b.send_json({"type": "ready"})
            _read_room(a)
            _read_room(b)

            a.send_json({"type": "move", "row": 7, "col": 7})
            _read_room(a)
            _read_room(b)
            b.send_json({"type": "move", "row": 0, "col": 0})
            _read_room(a)
            _read_room(b)

            # 白方请求悔棋，黑方同意：撤回白方最后一手
            b.send_json({"type": "undo_request"})
            pending = _read_room(a)
            _read_room(b)
            assert pending["pendingUndo"]["playerId"] == b_welcome["playerId"]
            assert pending["pendingUndo"]["name"] == "小红"

            a.send_json({"type": "undo_response", "accept": True})
            undone = _read_room(a)
            _read_room(b)
            assert undone["pendingUndo"] is None
            assert len(undone["game"]["moves"]) == 1
            assert undone["game"]["board"][0][0] == 0
            assert undone["game"]["currentTurn"] == "white"
            assert _read_type(a, "notice")["text"] == "对方同意悔棋"
            assert _read_type(b, "notice")["text"] == "对方同意悔棋"

            # 再次请求，黑方拒绝：棋盘不变
            b.send_json({"type": "undo_request"})
            _read_room(a)
            _read_room(b)
            a.send_json({"type": "undo_response", "accept": False})
            rejected = _read_room(a)
            _read_room(b)
            assert rejected["pendingUndo"] is None
            assert len(rejected["game"]["moves"]) == 1
            assert _read_type(a, "notice")["text"] == "对方拒绝悔棋"
            assert _read_type(b, "notice")["text"] == "对方拒绝悔棋"

def test_ai_room_flow_moves_and_resign() -> None:
    app = create_app()
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            _welcome(ws)
            ws.send_json({"type": "create_room", "name": "小明", "mode": "ai", "color": "black"})
            room = _read_room(ws)
            assert room["mode"] == "ai"
            assert room["status"] == "playing"
            assert len(room["players"]) == 2
            assert room["players"][1]["isBot"] is True
            assert room["players"][1]["name"] == "电脑"
            assert room["game"]["currentTurn"] == "black"

            ws.send_json({"type": "move", "row": 7, "col": 7})
            human_move = _read_room(ws)
            assert len(human_move["game"]["moves"]) == 1
            ai_reply = _read_room(ws)  # 电脑思考 0.45s 后应手
            assert len(ai_reply["game"]["moves"]) == 2
            assert ai_reply["game"]["currentTurn"] == "black"
            assert ai_reply["players"][1]["color"] == "white"

            ws.send_json({"type": "resign"})
            finished = _read_room(ws)
            assert finished["game"]["endedReason"] == "resign"
            assert finished["game"]["winner"] == "white"
            record = _read_type(ws, "records")["records"][0]
            assert record["result"] == "loss"
            assert record["mode"] == "ai"


def test_ai_room_when_ai_moves_first() -> None:
    app = create_app()
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            _welcome(ws)
            ws.send_json({"type": "create_room", "name": "小明", "mode": "ai", "color": "white"})
            initial = _read_room(ws)
            assert initial["players"][0]["isBot"] is True  # 电脑执黑
            opening = _read_room(ws)  # 电脑先手
            assert len(opening["game"]["moves"]) == 1
            assert opening["game"]["moves"][0]["color"] == "black"
            assert opening["game"]["currentTurn"] == "white"


def test_ai_undo_is_auto_accepted() -> None:
    app = create_app()
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            _welcome(ws)
            ws.send_json({"type": "create_room", "name": "小明", "mode": "ai", "color": "black"})
            _read_room(ws)
            ws.send_json({"type": "move", "row": 7, "col": 7})
            _read_room(ws)
            _read_room(ws)  # 电脑应手

            ws.send_json({"type": "undo_request"})
            undone = _read_room(ws)
            assert len(undone["game"]["moves"]) == 0
            assert undone["game"]["currentTurn"] == "black"
            assert _read_type(ws, "notice")["text"] == "电脑同意悔棋"


# ----------------------------------------------------------------------
# 多游戏：中国象棋房间
# ----------------------------------------------------------------------


def test_chess_room_flow_and_records() -> None:
    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as a, client.websocket_connect("/ws") as b:
            _welcome(a)
            _welcome(b)
            room = _create_room(a, name="红方", gameType="chess", color="red")
            assert room["gameType"] == "chess"
            assert room["game"]["rows"] == 10 and room["game"]["cols"] == 9
            assert room["game"]["currentTurn"] == "red"
            assert room["game"]["legalMoves"]
            _read_rooms(b)  # 大厅推送

            b.send_json({"type": "join_room", "roomId": room["id"], "name": "黑方"})
            _read_room(a)
            joined = _read_room(b)
            assert [p["color"] for p in joined["players"]] == ["red", "black"]

            a.send_json({"type": "ready"})
            _read_room(a)
            _read_room(b)
            b.send_json({"type": "ready"})
            started = _read_room(a)
            _read_room(b)
            assert started["status"] == "playing"
            assert started["game"]["moves"] == []

            # 红炮从 B3 平到 E3
            a.send_json(
                {
                    "type": "move",
                    "from": {"row": 7, "col": 1},
                    "to": {"row": 7, "col": 4},
                }
            )
            moved = _read_room(a)
            _read_room(b)
            assert moved["game"]["currentTurn"] == "black"
            assert moved["game"]["moves"][-1]["notation"] == "B3E3"

            # 非法走法：黑方不能走红子
            b.send_json(
                {
                    "type": "move",
                    "from": {"row": 9, "col": 0},
                    "to": {"row": 8, "col": 0},
                }
            )
            _read_error(b, "INVALID_MOVE")

            # 黑方直接认输 → 红胜，双方战绩带 gameType
            b.send_json({"type": "resign"})
            finished = _read_room(a)
            _read_room(b)
            assert finished["status"] == "finished"
            assert finished["game"]["winner"] == "red"
            assert finished["game"]["endedReason"] == "resign"
            records_a = _read_type(a, "records")["records"]
            records_b = _read_type(b, "records")["records"]
            assert records_a[0]["gameType"] == "chess"
            assert records_a[0]["result"] == "win"
            assert records_b[0]["gameType"] == "chess"
            assert records_b[0]["result"] == "loss"


def test_chess_ai_room_moves_first_as_red() -> None:
    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as ws:
            _welcome(ws)
            # 玩家执黑 → 电脑执红，应先走一步
            room = _create_room(ws, name="黑方", gameType="chess", mode="ai", color="black")
            assert room["gameType"] == "chess"
            assert room["mode"] == "ai"
            assert room["game"]["currentTurn"] == "red"
            after_ai = _read_room(ws)
            assert len(after_ai["game"]["moves"]) == 1
            assert after_ai["game"]["currentTurn"] == "black"
            assert after_ai["game"]["moves"][0]["color"] == "red"

            # 玩家走黑方合法一步，电脑应手 → 共 3 手
            move = after_ai["game"]["legalMoves"][0]
            ws.send_json({"type": "move", "from": move["from"], "to": move["to"]})
            after_human = _read_room(ws)
            after_reply = _read_room(ws)
            assert len(after_human["game"]["moves"]) == 2
            assert len(after_reply["game"]["moves"]) == 3
            assert after_reply["game"]["currentTurn"] == "black"


def test_unknown_game_type_rejected_and_rooms_filtered_by_game() -> None:
    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as ws:
            _welcome(ws)
            ws.send_json(
                {"type": "create_room", "name": "测试", "gameType": "go", "color": "black"}
            )
            _read_error(ws, "INVALID_MESSAGE")

        with client.websocket_connect("/ws") as a, client.websocket_connect("/ws") as b:
            _welcome(a)
            _welcome(b)
            chess = _create_room(a, name="象棋", gameType="chess", color="red")
            _read_rooms(b)
            gomoku = _create_room(b, name="五子棋", gameType="gomoku", color="black")

            chess_rooms = client.get("/api/rooms", params={"game": "chess"}).json()["rooms"]
            gomoku_rooms = client.get("/api/rooms", params={"game": "gomoku"}).json()["rooms"]
            assert [item["id"] for item in chess_rooms] == [chess["id"]]
            assert [item["id"] for item in gomoku_rooms] == [gomoku["id"]]


def test_create_room_custom_board_size() -> None:
    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as ws:
            _welcome(ws)
            room = _create_room(ws, boardSize=11)
            assert room["game"]["boardSize"] == 11
            assert len(room["game"]["board"]) == 11

        with client.websocket_connect("/ws") as ws:
            _welcome(ws)
            ws.send_json({"type": "create_room", "name": "小明", "boardSize": 10})
            _read_error(ws, "INVALID_MESSAGE")

        with client.websocket_connect("/ws") as ws:
            _welcome(ws)
            ws.send_json(
                {"type": "create_room", "name": "小明", "gameType": "chess", "boardSize": 9}
            )
            _read_error(ws, "INVALID_MESSAGE")
