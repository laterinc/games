"""RoomManager 状态机单测（用 FakeHub 捕获广播）。"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app import protocol
from app.protocol import ErrorCode, ProtocolError
from app.rooms import RoomManager

ROOM_KEYS = {
    "id",
    "name",
    "visibility",
    "gameType",
    "status",
    "hostId",
    "createdAt",
    "updatedAt",
    "players",
    "spectators",
    "rematchVotes",
    "mode",
    "pendingUndo",
    "game",
    "chat",
}
PLAYER_KEYS = {"id", "name", "color", "connected", "ready", "isHost", "isBot"}
GAME_KEYS = {
    "boardSize",
    "board",
    "currentTurn",
    "lastMove",
    "moves",
    "winner",
    "winLine",
    "endedReason",
    "startedAt",
    "endedAt",
}


class FakeHub:
    """记录所有消息；online 集合模拟大厅在线连接。"""

    def __init__(self) -> None:
        self.messages: list[tuple[str, dict[str, Any]]] = []
        self.online: set[str] = set()

    async def send_to_player(self, player_id: str, message: dict[str, Any]) -> None:
        self.messages.append((player_id, message))

    def online_player_ids(self) -> list[str]:
        return sorted(self.online)

    # -- 断言辅助 ---------------------------------------------------------
    def sent_to(self, player_id: str, msg_type: str | None = None) -> list[dict[str, Any]]:
        return [
            message
            for pid, message in self.messages
            if pid == player_id and (msg_type is None or message.get("type") == msg_type)
        ]

    def last_room(self, player_id: str) -> dict[str, Any] | None:
        for message in reversed(self.sent_to(player_id, "room")):
            return message["room"]
        return None

    def last_rooms(self, player_id: str) -> list[dict[str, Any]] | None:
        rooms = self.sent_to(player_id, "rooms")
        return rooms[-1]["rooms"] if rooms else None

    def clear(self) -> None:
        self.messages.clear()


async def _setup(
    *,
    board_size: int = 15,
    room_ttl: float = 6 * 3600.0,
    grace: float = 60.0,
    online: tuple[str, ...] = (),
) -> tuple[FakeHub, RoomManager]:
    hub = FakeHub()
    manager = RoomManager(
        hub,
        board_size=board_size,
        room_ttl_seconds=room_ttl,
        disconnect_grace_seconds=grace,
    )
    for player_id in online:
        hub.online.add(player_id)
    return hub, manager


def _assert_error(exc_info: pytest.ExceptionInfo[ProtocolError], code: ErrorCode) -> None:
    assert exc_info.value.code is code, f"期望 {code}，实际 {exc_info.value.code}"


async def _new_players(manager: RoomManager, hub: FakeHub, *names: str):
    players = []
    for name in names:
        player = manager.create_player()
        hub.online.add(player.id)
        players.append(player)
    return players


async def _start_playing_game(
    manager: RoomManager,
    a,
    b,
    *,
    visibility: str = "public",
    color: str = "black",
):
    room = await manager.create_room(
        a.id, name="小明", room_name="午后棋局", visibility=visibility, color=color
    )
    await manager.join_room(b.id, room_id=room.id, name="小红")
    await manager.ready(a.id)
    await manager.ready(b.id)
    return manager.room_of(a.id)


async def _win_by_black(manager: RoomManager, a, b) -> None:
    """黑方（a）在 7 行连成五子获胜；白方（b）走无关位置。"""
    white_moves = [(0, 0), (0, 1), (0, 2), (0, 3)]
    for index in range(5):
        await manager.move(a.id, row=7, col=3 + index)
        if index < 4:
            await manager.move(b.id, row=white_moves[index][0], col=white_moves[index][1])


# ---------------------------------------------------------------------------
# 创建 / 加入 / 快速匹配 / 列表
# ---------------------------------------------------------------------------


def test_create_room_snapshot_matches_protocol() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        (a,) = await _new_players(manager, hub, "小明")
        room = await manager.create_room(
            a.id, name="小明", room_name="", visibility="public", color="black"
        )

        assert room.name == "小明的棋局"  # 空房间名自动生成
        snapshot = manager.room_snapshot_for(a.id)
        assert snapshot is not None
        assert set(snapshot) == ROOM_KEYS
        assert set(snapshot["game"]) == GAME_KEYS
        assert set(snapshot["players"][0]) == PLAYER_KEYS
        assert snapshot["visibility"] == "public"
        assert snapshot["status"] == "waiting"
        assert snapshot["hostId"] == a.id
        assert snapshot["spectators"] == 0
        assert snapshot["rematchVotes"] == []
        assert snapshot["chat"] == []
        assert snapshot["game"]["boardSize"] == 15
        assert len(snapshot["game"]["board"]) == 15
        assert all(len(row) == 15 for row in snapshot["game"]["board"])
        assert snapshot["game"]["currentTurn"] == "black"
        assert snapshot["game"]["lastMove"] is None
        assert snapshot["game"]["moves"] == []
        assert snapshot["game"]["winner"] is None
        assert snapshot["game"]["winLine"] is None
        assert snapshot["game"]["endedReason"] is None
        assert snapshot["game"]["startedAt"] is None
        assert snapshot["game"]["endedAt"] is None
        assert snapshot["players"][0]["color"] == "black"
        assert snapshot["players"][0]["isHost"] is True
        assert snapshot["players"][0]["ready"] is False
        assert snapshot["players"][0]["connected"] is True
        # 毫秒时间戳
        assert snapshot["createdAt"] > 1_600_000_000_000
        assert snapshot["createdAt"] == snapshot["updatedAt"]
        # 创建者收到 room 快照；大厅在线者收到 rooms 列表
        assert hub.sent_to(a.id, "room")

    asyncio.run(scenario())


def test_room_list_only_public_waiting_sorted() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        a, b, c, d = await _new_players(manager, hub, "小明", "小红", "小刚", "小美")
        room_a = await manager.create_room(
            a.id, name="小明", room_name="第一局", visibility="public", color="black"
        )
        await manager.create_room(
            b.id, name="小红", room_name="私密局", visibility="private", color="black"
        )

        rooms = manager.rooms_snapshot()
        assert [item["id"] for item in rooms] == [room_a.id]
        assert set(rooms[0]) == {
            "id",
            "name",
            "gameType",
            "boardSize",
            "status",
            "playerCount",
            "maxPlayers",
            "hostName",
            "createdAt",
        }
        assert rooms[0]["playerCount"] == 1
        assert rooms[0]["maxPlayers"] == 2
        assert rooms[0]["hostName"] == "小明"
        assert rooms[0]["status"] == "waiting"
        assert rooms[0]["createdAt"] == room_a.created_at

        # 加入后 playerCount 变化会推送大厅（c/d 在大厅）
        await manager.join_room(d.id, room_id=room_a.id, name="小美")
        assert hub.last_rooms(c.id) is not None
        assert hub.last_rooms(c.id) == [
            {
                "id": room_a.id,
                "name": "第一局",
                "gameType": "gomoku",
                "boardSize": 15,
                "status": "waiting",
                "playerCount": 2,
                "maxPlayers": 2,
                "hostName": "小明",
                "createdAt": room_a.created_at,
            }
        ]
        # 私密房主 b 在房间内，本次变化后不会再收到新的列表推送
        assert len(hub.sent_to(b.id, "rooms")) == 1

        # 开局后不再出现在列表
        await manager.ready(a.id)
        await manager.ready(d.id)
        assert manager.rooms_snapshot() == []
        assert hub.last_rooms(c.id) == []

    asyncio.run(scenario())


def test_private_room_hidden_and_quick_match_creates_public() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        a, b = await _new_players(manager, hub, "小明", "小红")
        private_room = await manager.create_room(
            a.id, name="小明", room_name="私密", visibility="private", color="black"
        )
        assert manager.rooms_snapshot() == []

        room = await manager.quick_match(b.id, name="小红")
        assert room.id != private_room.id
        assert room.visibility == "public"
        assert manager.room_of(b.id) is room
        assert manager.rooms_snapshot()[0]["id"] == room.id

    asyncio.run(scenario())


def test_quick_match_joins_earliest_public_room() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        a, c, d = await _new_players(manager, hub, "小明", "小刚", "小美")
        first = await manager.create_room(
            a.id, name="小明", room_name="第一局", visibility="public", color="black"
        )
        second = await manager.create_room(
            c.id, name="小刚", room_name="第二局", visibility="public", color="black"
        )
        await manager.leave_room(c.id)
        hub.clear()

        room = await manager.quick_match(d.id, name="小美")
        assert room.id == first.id
        assert room.id != second.id
        assert [p.name for p in room.ordered_players()] == ["小明", "小美"]

    asyncio.run(scenario())


def test_join_assigns_opposite_color() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        a, b = await _new_players(manager, hub, "小明", "小红")
        room = await manager.create_room(
            a.id, name="小明", room_name="", visibility="public", color="black"
        )
        await manager.join_room(b.id, room_id=room.id, name="小红")
        snapshot = manager.room_snapshot_for(a.id)
        assert snapshot is not None
        assert [p["color"] for p in snapshot["players"]] == ["black", "white"]
        assert [p["id"] for p in snapshot["players"]] == [a.id, b.id]
        assert snapshot["players"][1]["isHost"] is False

        # 房主执白时，players 仍按黑方在前排序
        c, d = await _new_players(manager, hub, "小刚", "小美")
        room2 = await manager.create_room(
            c.id, name="小刚", room_name="", visibility="public", color="white"
        )
        await manager.join_room(d.id, room_id=room2.id, name="小美")
        snapshot2 = manager.room_snapshot_for(c.id)
        assert snapshot2 is not None
        assert [p["id"] for p in snapshot2["players"]] == [d.id, c.id]
        assert snapshot2["players"][0]["color"] == "black"
        assert snapshot2["players"][1]["color"] == "white"

    asyncio.run(scenario())


def test_random_color_resolves_to_black_or_white() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        a, b = await _new_players(manager, hub, "小明", "小红")
        room = await manager.create_room(
            a.id, name="小明", room_name="", visibility="public", color="random"
        )
        host_color = room.players[0].color
        assert host_color in ("black", "white")
        await manager.join_room(b.id, room_id=room.id, name="小红")
        assert room.players[1].color != host_color
        assert {p.color for p in room.players} == {"black", "white"}

    asyncio.run(scenario())


def test_join_errors() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        a, b, c = await _new_players(manager, hub, "小明", "小红", "小刚")
        with pytest.raises(ProtocolError) as exc:
            await manager.join_room(b.id, room_id="NOPE00", name="小红")
        _assert_error(exc, ErrorCode.ROOM_NOT_FOUND)

        room = await manager.create_room(
            a.id, name="小明", room_name="", visibility="public", color="black"
        )
        with pytest.raises(ProtocolError) as exc:
            await manager.create_room(
                a.id, name="小明", room_name="", visibility="public", color="black"
            )
        _assert_error(exc, ErrorCode.ALREADY_IN_ROOM)

        await manager.join_room(b.id, room_id=room.id, name="小红")
        with pytest.raises(ProtocolError) as exc:
            await manager.join_room(c.id, room_id=room.id, name="小刚")
        _assert_error(exc, ErrorCode.ROOM_FULL)

        await manager.ready(a.id)
        await manager.ready(b.id)
        with pytest.raises(ProtocolError) as exc:
            await manager.join_room(c.id, room_id=room.id, name="小刚")
        _assert_error(exc, ErrorCode.ROOM_STARTED)

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# ready / 对局 / 胜负 / rematch
# ---------------------------------------------------------------------------


def test_ready_toggles_and_starts_game() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        a, b = await _new_players(manager, hub, "小明", "小红")
        room = await manager.create_room(
            a.id, name="小明", room_name="", visibility="public", color="black"
        )
        await manager.join_room(b.id, room_id=room.id, name="小红")

        await manager.ready(a.id)
        snapshot = manager.room_snapshot_for(a.id)
        assert snapshot is not None
        assert snapshot["status"] == "waiting"
        assert snapshot["players"][0]["ready"] is True
        await manager.ready(a.id)  # 再切回未准备
        snapshot = manager.room_snapshot_for(a.id)
        assert snapshot is not None
        assert snapshot["players"][0]["ready"] is False

        await manager.ready(a.id)
        await manager.ready(b.id)
        snapshot = manager.room_snapshot_for(a.id)
        assert snapshot is not None
        assert snapshot["status"] == "playing"
        assert snapshot["game"]["currentTurn"] == "black"
        assert snapshot["game"]["startedAt"] is not None
        assert snapshot["game"]["endedAt"] is None
        assert all(cell == 0 for row in snapshot["game"]["board"] for cell in row)

        with pytest.raises(ProtocolError) as exc:
            await manager.ready(a.id)
        _assert_error(exc, ErrorCode.GAME_NOT_ACTIVE)

    asyncio.run(scenario())


def test_move_validation_and_win() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        a, b = await _new_players(manager, hub, "小明", "小红")
        await _start_playing_game(manager, a, b)
        room = manager.room_of(a.id)
        assert room is not None
        assert room.id == manager.room_of(b.id).id  # type: ignore[union-attr]

        # 白方不能先手
        with pytest.raises(ProtocolError) as exc:
            await manager.move(b.id, row=0, col=0)
        _assert_error(exc, ErrorCode.NOT_YOUR_TURN)

        # 越界 / 负数
        with pytest.raises(ProtocolError) as exc:
            await manager.move(a.id, row=15, col=0)
        _assert_error(exc, ErrorCode.INVALID_MOVE)
        with pytest.raises(ProtocolError) as exc:
            await manager.move(a.id, row=-1, col=0)
        _assert_error(exc, ErrorCode.INVALID_MOVE)

        await manager.move(a.id, row=7, col=7)
        # 重复落子（白方落在已有黑子上）
        with pytest.raises(ProtocolError) as exc:
            await manager.move(b.id, row=7, col=7)
        _assert_error(exc, ErrorCode.INVALID_MOVE)

        # 白方正常应手，黑方随后在 7 行完成五连
        await manager.move(b.id, row=0, col=0)
        for index in range(1, 5):
            await manager.move(a.id, row=7, col=7 + index)
            if index < 4:
                await manager.move(b.id, row=0, col=index)
        snapshot = manager.room_snapshot_for(a.id)
        assert snapshot is not None
        assert snapshot["status"] == "finished"
        assert snapshot["game"]["winner"] == "black"
        assert snapshot["game"]["endedReason"] == "five"
        assert snapshot["game"]["endedAt"] is not None
        win_line = snapshot["game"]["winLine"]
        assert win_line is not None and len(win_line) == 5
        assert win_line[0] == {"row": 7, "col": 7}
        assert snapshot["game"]["lastMove"] == {"row": 7, "col": 11}
        assert len(snapshot["game"]["moves"]) == 9

        with pytest.raises(ProtocolError) as exc:
            await manager.move(b.id, row=1, col=1)
        _assert_error(exc, ErrorCode.GAME_NOT_ACTIVE)

    asyncio.run(scenario())


def test_filling_board_without_five_is_draw() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        a, b = await _new_players(manager, hub, "小明", "小红")
        await _start_playing_game(manager, a, b)
        room = manager.room_of(a.id)
        assert room is not None
        # 构造一个满盘且四方向都无五连的图案，只留 (0,0) 空给黑方落子
        for row in range(15):
            for col in range(15):
                if (row, col) == (0, 0):
                    continue
                color = "black" if ((row // 2) + (col // 3)) % 2 == 0 else "white"
                room.board[row][col] = 1 if color == "black" else 2
        assert room.current_turn == "black"

        await manager.move(a.id, row=0, col=0)
        snapshot = manager.room_snapshot_for(a.id)
        assert snapshot is not None
        assert snapshot["status"] == "finished"
        assert snapshot["game"]["winner"] is None
        assert snapshot["game"]["endedReason"] == "draw"
        assert snapshot["game"]["winLine"] is None
        assert snapshot["game"]["endedAt"] is not None

    asyncio.run(scenario())


def test_move_in_waiting_room_is_game_not_active() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        (a,) = await _new_players(manager, hub, "小明")
        await manager.create_room(
            a.id, name="小明", room_name="", visibility="public", color="black"
        )
        with pytest.raises(ProtocolError) as exc:
            await manager.move(a.id, row=0, col=0)
        _assert_error(exc, ErrorCode.GAME_NOT_ACTIVE)

    asyncio.run(scenario())


def test_rematch_votes_and_swaps_colors() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        a, b = await _new_players(manager, hub, "小明", "小红")
        await _start_playing_game(manager, a, b)
        await _win_by_black(manager, a, b)

        with pytest.raises(ProtocolError) as exc:
            await manager.ready(a.id)  # finished 状态不能准备
        _assert_error(exc, ErrorCode.GAME_NOT_ACTIVE)

        await manager.rematch(a.id)
        snapshot = manager.room_snapshot_for(a.id)
        assert snapshot is not None
        assert set(snapshot["rematchVotes"]) == {a.id}
        await manager.rematch(a.id)  # 重复投票幂等
        snapshot = manager.room_snapshot_for(a.id)
        assert snapshot is not None
        assert snapshot["rematchVotes"] == [a.id]

        await manager.rematch(b.id)
        snapshot = manager.room_snapshot_for(a.id)
        assert snapshot is not None
        assert snapshot["status"] == "playing"
        assert snapshot["rematchVotes"] == []
        assert snapshot["game"]["winner"] is None
        assert snapshot["game"]["winLine"] is None
        assert snapshot["game"]["endedReason"] is None
        assert snapshot["game"]["moves"] == []
        assert snapshot["game"]["startedAt"] is not None
        colors = {p["id"]: p["color"] for p in snapshot["players"]}
        assert colors[a.id] == "white"
        assert colors[b.id] == "black"
        assert snapshot["game"]["currentTurn"] == "black"

        with pytest.raises(ProtocolError):
            await manager.rematch(a.id)  # playing 中不能投票

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# 离开 / forfeit / 断线 / TTL
# ---------------------------------------------------------------------------


def test_leave_last_player_destroys_room() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        (a,) = await _new_players(manager, hub, "小明")
        await manager.create_room(
            a.id, name="小明", room_name="", visibility="public", color="black"
        )
        await manager.leave_room(a.id)
        assert manager.room_count == 0
        assert hub.sent_to(a.id, "room")[-1] == {"type": "room", "room": None}

        with pytest.raises(ProtocolError) as exc:
            await manager.leave_room(a.id)
        _assert_error(exc, ErrorCode.NOT_IN_ROOM)

    asyncio.run(scenario())


def test_leave_waiting_room_hands_host_to_remaining_player() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        a, b = await _new_players(manager, hub, "小明", "小红")
        room = await manager.create_room(
            a.id, name="小明", room_name="", visibility="public", color="black"
        )
        await manager.join_room(b.id, room_id=room.id, name="小红")
        hub.clear()

        await manager.leave_room(a.id)
        assert hub.sent_to(a.id, "room")[-1] == {"type": "room", "room": None}
        snapshot = manager.room_snapshot_for(b.id)
        assert snapshot is not None
        assert snapshot["status"] == "waiting"
        assert snapshot["hostId"] == b.id
        assert len(snapshot["players"]) == 1
        assert snapshot["players"][0]["isHost"] is True
        assert snapshot["players"][0]["color"] == "black"
        assert snapshot["players"][0]["ready"] is False
        assert manager.room_count == 1
        assert manager.rooms_snapshot()[0]["playerCount"] == 1

    asyncio.run(scenario())


def test_leave_during_playing_forfeits_then_resets_to_waiting() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        a, b = await _new_players(manager, hub, "小明", "小红")
        room = await _start_playing_game(manager, a, b)
        await manager.move(a.id, row=7, col=7)
        await manager.move(b.id, row=0, col=0)
        hub.clear()

        await manager.leave_room(b.id)  # 白方离开 -> 黑方 forfeit 获胜
        assert hub.sent_to(b.id, "room")[-1] == {"type": "room", "room": None}

        a_rooms = hub.sent_to(a.id, "room")
        assert len(a_rooms) >= 2
        finished = a_rooms[0]["room"]
        assert finished["status"] == "finished"
        assert finished["game"]["winner"] == "black"
        assert finished["game"]["endedReason"] == "forfeit"
        assert finished["game"]["endedAt"] is not None

        notices = hub.sent_to(a.id, "notice")
        assert notices and notices[-1]["level"] == "info"
        assert "等待新对手" in notices[-1]["text"]

        waiting = a_rooms[-1]["room"]
        assert waiting["status"] == "waiting"
        assert waiting["hostId"] == a.id
        assert len(waiting["players"]) == 1
        assert waiting["players"][0]["ready"] is False
        assert all(cell == 0 for row in waiting["game"]["board"] for cell in row)
        assert waiting["game"]["winner"] is None
        assert waiting["game"]["endedReason"] is None
        assert manager.room_count == 1
        # 房间重置后重新出现在公开列表
        assert manager.rooms_snapshot()[0]["playerCount"] == 1
        # 离开者不再是成员
        assert manager.room_snapshot_for(b.id) is None
        assert manager.room_of(a.id).id == room.id  # type: ignore[union-attr]

    asyncio.run(scenario())


def test_disconnect_marks_offline_and_grace_forfeits() -> None:
    async def scenario() -> None:
        hub, manager = await _setup(grace=0.05)
        a, b = await _new_players(manager, hub, "小明", "小红")
        await _start_playing_game(manager, a, b)
        hub.clear()

        await manager.mark_disconnected(b.id)
        snapshot = manager.room_snapshot_for(a.id)
        assert snapshot is not None
        white = next(p for p in snapshot["players"] if p["id"] == b.id)
        assert white["connected"] is False

        await asyncio.sleep(0.15)
        snapshot = manager.room_snapshot_for(a.id)
        assert snapshot is not None
        assert snapshot["status"] == "waiting"
        assert len(snapshot["players"]) == 1

    asyncio.run(scenario())


def test_reconnect_within_grace_cancels_forfeit() -> None:
    async def scenario() -> None:
        hub, manager = await _setup(grace=0.05)
        a, b = await _new_players(manager, hub, "小明", "小红")
        await _start_playing_game(manager, a, b)

        await manager.mark_disconnected(b.id)
        await manager.mark_connected(b.id)
        await asyncio.sleep(0.15)
        snapshot = manager.room_snapshot_for(a.id)
        assert snapshot is not None
        assert snapshot["status"] == "playing"
        white = next(p for p in snapshot["players"] if p["id"] == b.id)
        assert white["connected"] is True

    asyncio.run(scenario())


def test_reap_idle_waiting_rooms_only() -> None:
    async def scenario() -> None:
        hub, manager = await _setup(room_ttl=0.01)
        a, b = await _new_players(manager, hub, "小明", "小红")
        room = await manager.create_room(
            a.id, name="小明", room_name="", visibility="public", color="black"
        )
        room.updated_at = protocol.now_ms() - 1000
        await asyncio.sleep(0.01)
        assert await manager.reap_idle_rooms() == 1
        assert manager.room_count == 0
        assert hub.sent_to(a.id, "room")[-1] == {"type": "room", "room": None}

        # playing 房间不回收
        (c,) = await _new_players(manager, hub, "小刚")
        c_room = await manager.create_room(
            c.id, name="小刚", room_name="", visibility="public", color="black"
        )
        await manager.join_room(b.id, room_id=c_room.id, name="小红")
        await manager.ready(c.id)
        await manager.ready(b.id)
        c_room.updated_at = protocol.now_ms() - 1000
        assert await manager.reap_idle_rooms() == 0
        assert manager.room_count == 1

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# 聊天
# ---------------------------------------------------------------------------


def test_chat_broadcast_and_history_trimmed_to_50() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        a, b = await _new_players(manager, hub, "小明", "小红")
        await _start_playing_game(manager, a, b)
        hub.clear()

        for index in range(55):
            await manager.chat(a.id, text=f"第 {index} 句")

        a_chats = hub.sent_to(a.id, "chat")
        b_chats = hub.sent_to(b.id, "chat")
        assert len(a_chats) == 55
        assert len(b_chats) == 55
        assert a_chats[0]["message"] == {
            "id": "m_1",
            "playerId": a.id,
            "name": "小明",
            "text": "第 0 句",
            "at": a_chats[0]["message"]["at"],
        }
        assert a_chats[-1]["message"]["id"] == "m_55"

        snapshot = manager.room_snapshot_for(a.id)
        assert snapshot is not None
        chat = snapshot["chat"]
        assert len(chat) == protocol.CHAT_HISTORY_LIMIT
        assert chat[0]["id"] == "m_6"
        assert chat[-1]["id"] == "m_55"
        assert [entry["id"] for entry in chat] == [
            f"m_{index}" for index in range(6, 56)
        ]

    asyncio.run(scenario())


def test_chat_requires_room() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        (a,) = await _new_players(manager, hub, "小明")
        with pytest.raises(ProtocolError) as exc:
            await manager.chat(a.id, text="你好")
        _assert_error(exc, ErrorCode.NOT_IN_ROOM)

    asyncio.run(scenario())


def test_player_identity_and_auth() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        player = manager.create_player()
        assert player.id.startswith("p_")
        assert player.token.startswith("t_")
        assert manager.authenticate(player.id, player.token) is player
        assert manager.authenticate(player.id, "wrong") is None
        assert manager.authenticate("p_missing", player.token) is None

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# 房间棋盘大小
# ---------------------------------------------------------------------------


def test_create_room_with_custom_gomoku_board_size() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        (a,) = await _new_players(manager, hub, "小明")
        room = await manager.create_room(
            a.id,
            name="小明",
            room_name="小棋盘",
            visibility="public",
            color="black",
            board_size=9,
        )
        assert room.board_size == 9
        snapshot = manager.room_snapshot_for(a.id)
        assert snapshot is not None
        assert snapshot["game"]["boardSize"] == 9
        assert len(snapshot["game"]["board"]) == 9
        assert all(len(row) == 9 for row in snapshot["game"]["board"])
        assert manager.rooms_snapshot()[0]["boardSize"] == 9
        hub.messages.clear()

    asyncio.run(scenario())


def test_custom_board_size_survives_game_start() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        a, b = await _new_players(manager, hub, "小明", "小红")
        room = await manager.create_room(
            a.id,
            name="小明",
            room_name="",
            visibility="public",
            color="black",
            board_size=11,
        )
        await manager.join_room(b.id, room_id=room.id, name="小红")
        await manager.ready(a.id)
        await manager.ready(b.id)
        state = manager.room_of(a.id).state
        assert state["boardSize"] == 11
        assert len(state["board"]) == 11

    asyncio.run(scenario())


def test_invalid_or_chess_board_size_rejected() -> None:
    async def scenario() -> None:
        hub, manager = await _setup()
        a, b = await _new_players(manager, hub, "小明", "小红")
        with pytest.raises(ProtocolError):
            await manager.create_room(
                a.id,
                name="小明",
                room_name="",
                visibility="public",
                color="black",
                board_size=10,
            )
        with pytest.raises(ProtocolError):
            await manager.create_room(
                b.id,
                name="小红",
                room_name="",
                visibility="public",
                color="red",
                game_type="chess",
                board_size=9,
            )

    asyncio.run(scenario())
