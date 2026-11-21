"""WebSocket 端到端测试（fastapi.testclient.TestClient，不依赖外网）。"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.main import create_app

WELCOME_KEYS = {
    "type",
    "playerId",
    "token",
    "reconnected",
    "serverTime",
    "protocolVersion",
}


def _welcome(ws) -> dict[str, Any]:
    message = ws.receive_json()
    assert message["type"] == "welcome", message
    assert set(message) == WELCOME_KEYS
    assert message["reconnected"] is False
    assert message["protocolVersion"] == 1
    assert message["playerId"].startswith("p_")
    assert message["token"].startswith("t_")
    assert isinstance(message["serverTime"], int)
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
            _read_error(ws, "INVALID_MESSAGE")

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

            # 已在房间
            b.send_json({"type": "join_room", "roomId": room["id"], "name": "小红"})
            _read_error(b, "ALREADY_IN_ROOM")

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
            _read_error(a, "INVALID_MESSAGE")

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


def test_hello_reconnect_restores_room() -> None:
    app = create_app()
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as first:
            welcome = _welcome(first)
            room = _create_room(first, name="小明", roomName="重连测试")
            player_id = welcome["playerId"]
            token = welcome["token"]

        with client.websocket_connect("/ws") as second:
            fresh = _welcome(second)
            assert fresh["playerId"] != player_id
            second.send_json({"type": "hello", "playerId": player_id, "token": token})
            recovered = _read_type(second, "welcome")
            assert recovered["reconnected"] is True
            assert recovered["playerId"] == player_id
            assert recovered["token"] == token
            assert recovered["protocolVersion"] == 1

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


def test_hello_bad_token_keeps_current_identity() -> None:
    with TestClient(create_app()) as client:
        with client.websocket_connect("/ws") as ws:
            welcome = _welcome(ws)
            ws.send_json({"type": "hello", "playerId": "p_deadbeef", "token": "t_wrong"})
            _read_error(ws, "AUTH_FAILED")

            # 失败后保持当前全新身份，可正常创建房间
            room = _create_room(ws, name="新玩家")
            assert room["hostId"] == welcome["playerId"]


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
        assert config == {
            "protocolVersion": 1,
            "boardSize": 15,
            "maxPlayers": 2,
            "appName": "五子棋",
        }

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


def test_static_disabled_when_dist_missing(tmp_path: Path) -> None:
    app = create_app(Settings(web_dist=tmp_path / "not-built"))
    with TestClient(app) as client:
        response = client.get("/")
        assert response.status_code == 404
        assert response.json()["error"] == "STATIC_NOT_BUILT"

        deep = client.get("/some/spa/route")
        assert deep.status_code == 404

        assert client.get("/api/health").status_code == 200
        assert client.get("/api/config").status_code == 200
        unknown = client.get("/api/nope")
        assert unknown.status_code == 404
        assert unknown.json()["error"] == "NOT_FOUND"


def test_static_serves_dist_with_spa_fallback(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html><body>gomoku</body></html>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log('app')", encoding="utf-8")

    app = create_app(Settings(web_dist=dist))
    with TestClient(app) as client:
        index = client.get("/")
        assert index.status_code == 200
        assert "gomoku" in index.text
        assert "no-cache" in index.headers["cache-control"]

        deep = client.get("/game/room-123")
        assert deep.status_code == 200
        assert "gomoku" in deep.text
        assert "no-cache" in deep.headers["cache-control"]

        asset = client.get("/assets/app.js")
        assert asset.status_code == 200
        assert "console.log" in asset.text
        assert "max-age=31536000" in asset.headers["cache-control"]

        unknown_api = client.get("/api/nope")
        assert unknown_api.status_code == 404
        assert unknown_api.headers["content-type"].startswith("application/json")
        assert unknown_api.json()["error"] == "NOT_FOUND"

        # /api 仍正常
        assert client.get("/api/config").json()["boardSize"] == 15


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
