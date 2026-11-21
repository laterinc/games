"""房间、玩家与对局状态管理（服务端权威裁判）。

所有状态变更都在 ``RoomManager._lock`` 下完成；变更后先更新内存，再逐条广播。
``RoomManager`` 只依赖 ``ConnectionHub`` 抽象（由 ws 层实现），便于单测注入假连接。
"""

from __future__ import annotations

import asyncio
import logging
import random
import secrets
from dataclasses import dataclass, field
from typing import Any, Protocol

from . import game, protocol
from .protocol import ErrorCode, ProtocolError, now_ms

logger = logging.getLogger(__name__)

_ROOM_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_ROOM_ID_LENGTH = 6
_CHAT_ID_PREFIX = "m_"
#: 单个房间最多观战人数（防止被当成聊天室滥用）
MAX_SPECTATORS = 20


class ConnectionHub(Protocol):
    """房间层需要的连接能力（由 ws.ConnectionHub 实现）。"""

    async def send_to_player(self, player_id: str, message: dict[str, Any]) -> None:
        """向玩家当前连接发送一条消息；玩家离线时静默丢弃。"""

    def online_player_ids(self) -> list[str]:
        """返回当前有活动连接的玩家 id 列表。"""


@dataclass(slots=True)
class Player:
    """玩家身份，跨房间保留，用于 token 重连。"""

    id: str
    token: str
    name: str = ""
    color: str = "black"
    connected: bool = True
    ready: bool = False
    disconnect_epoch: int = 0

    def snapshot(self, *, is_host: bool) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "connected": self.connected,
            "ready": self.ready,
            "isHost": is_host,
        }


@dataclass(slots=True)
class Move:
    row: int
    col: int
    color: str
    at: int

    def to_dict(self) -> dict[str, Any]:
        return {"row": self.row, "col": self.col, "color": self.color, "at": self.at}


@dataclass(slots=True)
class ChatEntry:
    id: str
    player_id: str
    name: str
    text: str
    at: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "playerId": self.player_id,
            "name": self.name,
            "text": self.text,
            "at": self.at,
        }


@dataclass(slots=True)
class Room:
    id: str
    name: str
    visibility: str
    host_id: str
    created_at: int
    updated_at: int
    board_size: int
    status: str = "waiting"
    players: list[Player] = field(default_factory=list)
    spectators: list[Player] = field(default_factory=list)
    board: game.Board = field(default_factory=list)
    current_turn: str = "black"
    last_move: Move | None = None
    moves: list[Move] = field(default_factory=list)
    winner: str | None = None
    win_line: list[game.Coord] | None = None
    ended_reason: str | None = None
    started_at: int | None = None
    ended_at: int | None = None
    rematch_votes: list[str] = field(default_factory=list)
    chat: list[ChatEntry] = field(default_factory=list)
    chat_seq: int = 0

    # -- 便捷属性 ---------------------------------------------------------
    def player(self, player_id: str) -> Player | None:
        return next((p for p in self.players if p.id == player_id), None)

    def opponent_of(self, player_id: str) -> Player | None:
        return next((p for p in self.players if p.id != player_id), None)

    @property
    def host(self) -> Player | None:
        return self.player(self.host_id)

    def ordered_players(self) -> list[Player]:
        """players 顺序固定为黑方在前。"""
        return sorted(self.players, key=lambda p: 0 if p.color == "black" else 1)


class RoomManager:
    """房间与对局状态机。"""

    def __init__(
        self,
        hub: ConnectionHub,
        *,
        board_size: int = protocol.BOARD_SIZE_DEFAULT,
        room_ttl_seconds: float = 6 * 3600.0,
        disconnect_grace_seconds: float = 60.0,
    ) -> None:
        self._hub = hub
        self.board_size = board_size
        self.room_ttl_seconds = room_ttl_seconds
        self.disconnect_grace_seconds = disconnect_grace_seconds
        self._lock = asyncio.Lock()
        self._players: dict[str, Player] = {}
        self._rooms: dict[str, Room] = {}
        self._player_room: dict[str, str] = {}
        self._spectator_room: dict[str, str] = {}
        self._disconnect_tasks: dict[str, asyncio.Task[None]] = {}

    # ------------------------------------------------------------------
    # 身份
    # ------------------------------------------------------------------

    def create_player(self) -> Player:
        """生成新的匿名身份（welcome 时下发 playerId + token）。"""
        player = Player(
            id=f"p_{secrets.token_hex(4)}",
            token=f"t_{secrets.token_urlsafe(24)}",
        )
        self._players[player.id] = player
        return player

    def authenticate(self, player_id: str, token: str) -> Player | None:
        """校验 playerId + token；成功返回玩家。"""
        player = self._players.get(player_id)
        if player is None or not token:
            return None
        if not secrets.compare_digest(player.token, token):
            return None
        return player

    def session_cookie_value(self, player: Player) -> str:
        """WS 握手 Cookie 中保存的身份值：playerId.token。"""
        return f"{player.id}.{player.token}"

    def authenticate_cookie(self, value: str | None) -> Player | None:
        """从握手 Cookie 恢复身份；无效返回 None。"""
        if not value:
            return None
        player_id, sep, token = value.partition(".")
        if not sep:
            return None
        return self.authenticate(player_id, token)

    def discard_player(self, player_id: str) -> None:
        """丢弃未被使用的匿名身份（hello 成功后清掉临时身份）。"""
        if player_id in self._player_room or player_id in self._spectator_room:
            return
        self._players.pop(player_id, None)

    # ------------------------------------------------------------------
    # 连接状态 / 断线宽限
    # ------------------------------------------------------------------

    async def mark_connected(self, player_id: str) -> None:
        """标记玩家在线；取消断线宽限计时，并让房间内对手看到重连。"""
        async with self._lock:
            player = self._players.get(player_id)
            if player is None:
                return
            self._cancel_disconnect_task(player_id)
            player.disconnect_epoch += 1
            was_disconnected = not player.connected
            player.connected = True
            room = self._room_of(player_id)
            if room is not None and was_disconnected:
                await self._broadcast_room(room, exclude={player_id})

    async def mark_disconnected(self, player_id: str) -> None:
        """标记玩家离线；在房间内则开始 DISCONNECT_GRACE_SECONDS 宽限倒计时。"""
        async with self._lock:
            player = self._players.get(player_id)
            if player is None:
                return
            self._cancel_disconnect_task(player_id)
            player.connected = False
            player.disconnect_epoch += 1
            room = self._room_of(player_id)
            if room is None:
                return
            room.updated_at = now_ms()
            await self._broadcast_room(room)
            if self.disconnect_grace_seconds > 0:
                epoch = player.disconnect_epoch
                self._disconnect_tasks[player_id] = asyncio.create_task(
                    self._disconnect_timeout(player_id, epoch)
                )

    async def _disconnect_timeout(self, player_id: str, epoch: int) -> None:
        try:
            await asyncio.sleep(self.disconnect_grace_seconds)
        except asyncio.CancelledError:
            return
        async with self._lock:
            player = self._players.get(player_id)
            if player is None or player.connected or player.disconnect_epoch != epoch:
                return
            if player_id not in self._player_room:
                return
            self._disconnect_tasks.pop(player_id, None)
            logger.info("玩家 %s 断线超过宽限期，按离开处理", player_id)
            await self._leave_locked(player_id)

    def _cancel_disconnect_task(self, player_id: str) -> None:
        task = self._disconnect_tasks.pop(player_id, None)
        if task is not None and not task.done():
            task.cancel()

    def cancel_background_tasks(self) -> None:
        """取消所有断线计时任务（应用关闭时调用）。"""
        for task in self._disconnect_tasks.values():
            if not task.done():
                task.cancel()
        self._disconnect_tasks.clear()

    # ------------------------------------------------------------------
    # 房间操作
    # ------------------------------------------------------------------

    async def create_room(
        self,
        player_id: str,
        *,
        name: str,
        room_name: str,
        visibility: str,
        color: str,
    ) -> Room:
        async with self._lock:
            self._ensure_not_in_room(player_id)
            player = self._require_player(player_id)
            player.name = name
            player.ready = False
            actual_color = random.choice(protocol.COLORS) if color == "random" else color
            player.color = actual_color

            created_at = now_ms()
            room = Room(
                id=self._generate_room_id(),
                name=room_name or f"{name}的棋局",
                visibility=visibility,
                host_id=player.id,
                created_at=created_at,
                updated_at=created_at,
                board_size=self.board_size,
                board=game.empty_board(self.board_size),
                players=[player],
            )
            self._rooms[room.id] = room
            self._player_room[player.id] = room.id
            await self._broadcast_room(room)
            await self._push_lobby()
            return room

    async def join_room(self, player_id: str, *, room_id: str, name: str) -> Room:
        async with self._lock:
            room = self._rooms.get(room_id)
            if player_id in self._player_room:
                if self._player_room[player_id] == room_id and room is not None:
                    # 幂等：已经在目标房间（常见于刷新后 UI 误点「加入」），直接回快照
                    await self._broadcast_room(room)
                    return room
                raise ProtocolError(ErrorCode.ALREADY_IN_ROOM)
            if player_id in self._spectator_room:
                raise ProtocolError(ErrorCode.ALREADY_IN_ROOM)
            if room is None:
                raise ProtocolError(ErrorCode.ROOM_NOT_FOUND)
            self._join_room_locked(room, player_id, name)
            await self._broadcast_room(room)
            await self._push_lobby()
            return room

    async def quick_match(self, player_id: str, *, name: str) -> Room:
        async with self._lock:
            self._ensure_not_in_room(player_id)
            candidates = [
                room
                for room in self._rooms.values()
                if room.visibility == "public"
                and room.status == "waiting"
                and len(room.players) == 1
            ]
            if candidates:
                room = min(candidates, key=lambda r: r.created_at)
                self._join_room_locked(room, player_id, name)
                await self._broadcast_room(room)
                await self._push_lobby()
                return room

            # 没有可加入的房间：新建公开房，创建者执黑
            player = self._require_player(player_id)
            player.name = name
            player.color = "black"
            player.ready = False
            created_at = now_ms()
            room = Room(
                id=self._generate_room_id(),
                name=f"{name}的棋局",
                visibility="public",
                host_id=player.id,
                created_at=created_at,
                updated_at=created_at,
                board_size=self.board_size,
                board=game.empty_board(self.board_size),
                players=[player],
            )
            self._rooms[room.id] = room
            self._player_room[player.id] = room.id
            await self._broadcast_room(room)
            await self._push_lobby()
            return room

    async def ready(self, player_id: str) -> Room:
        async with self._lock:
            room = self._require_room(player_id)
            if room.status != "waiting":
                raise ProtocolError(ErrorCode.GAME_NOT_ACTIVE)
            player = self._require_player(player_id)
            player.ready = not player.ready
            started = (
                len(room.players) == protocol.MAX_PLAYERS
                and all(p.ready for p in room.players)
            )
            if started:
                self._start_game_locked(room)
            room.updated_at = now_ms()
            await self._broadcast_room(room)
            if started:
                await self._push_lobby()
            return room

    async def move(self, player_id: str, *, row: int, col: int) -> Room:
        async with self._lock:
            room = self._require_room(player_id)
            if room.status != "playing":
                raise ProtocolError(ErrorCode.GAME_NOT_ACTIVE)
            player = self._require_player(player_id)
            if player.color != room.current_turn:
                raise ProtocolError(ErrorCode.NOT_YOUR_TURN)
            if not game.is_empty(room.board, row, col):
                raise ProtocolError(ErrorCode.INVALID_MOVE)

            game.place(room.board, row, col, player.color)
            now = now_ms()
            move = Move(row=row, col=col, color=player.color, at=now)
            room.moves.append(move)
            room.last_move = move
            room.updated_at = now

            win_line = game.check_win(room.board, row, col)
            if win_line is not None:
                room.status = "finished"
                room.winner = player.color
                room.win_line = win_line
                room.ended_reason = "five"
                room.ended_at = now
            elif game.is_board_full(room.board):
                room.status = "finished"
                room.winner = None
                room.win_line = None
                room.ended_reason = "draw"
                room.ended_at = now
            else:
                room.current_turn = game.OPPOSITE_COLOR[player.color]

            await self._broadcast_room(room)
            return room

    async def rematch(self, player_id: str) -> Room:
        async with self._lock:
            room = self._require_room(player_id)
            if room.status != "finished":
                raise ProtocolError(ErrorCode.GAME_NOT_ACTIVE)
            if player_id not in room.rematch_votes:
                room.rematch_votes.append(player_id)
            room.updated_at = now_ms()

            everyone_voted = (
                len(room.players) == protocol.MAX_PLAYERS
                and all(p.id in room.rematch_votes for p in room.players)
            )
            if everyone_voted:
                for player in room.players:
                    player.color = game.OPPOSITE_COLOR[player.color]
                self._start_game_locked(room)
                room.updated_at = now_ms()
            await self._broadcast_room(room)
            return room

    async def watch_room(self, player_id: str, *, room_id: str, name: str) -> Room:
        """以观战者身份进入房间（不占座），可看棋盘与聊天。"""
        async with self._lock:
            if player_id in self._player_room:
                raise ProtocolError(ErrorCode.ALREADY_IN_ROOM)
            room = self._rooms.get(room_id)
            if room is None:
                raise ProtocolError(ErrorCode.ROOM_NOT_FOUND)
            current = self._spectator_room.get(player_id)
            if current == room_id:
                await self._broadcast_room(room)
                return room
            if current is not None:
                raise ProtocolError(ErrorCode.ALREADY_IN_ROOM)
            if len(room.spectators) >= MAX_SPECTATORS:
                raise ProtocolError(ErrorCode.ROOM_FULL, "观战人数已满")
            player = self._require_player(player_id)
            player.name = name
            room.spectators.append(player)
            self._spectator_room[player_id] = room.id
            room.updated_at = now_ms()
            await self._broadcast_room(room)
            return room

    async def remove_spectator(self, player_id: str, *, notify: bool = True) -> bool:
        async with self._lock:
            room_id = self._spectator_room.pop(player_id, None)
            if room_id is None:
                return False
            room = self._rooms.get(room_id)
            if room is not None:
                room.spectators = [p for p in room.spectators if p.id != player_id]
                room.updated_at = now_ms()
                await self._broadcast_room(room)
        if notify:
            await self._hub.send_to_player(player_id, {"type": "room", "room": None})
        return True

    async def leave_room(self, player_id: str) -> None:
        async with self._lock:
            if player_id in self._player_room:
                await self._leave_locked(player_id, exclude={player_id})
            elif player_id in self._spectator_room:
                room_id = self._spectator_room.pop(player_id)
                room = self._rooms.get(room_id)
                if room is not None:
                    room.spectators = [p for p in room.spectators if p.id != player_id]
                    room.updated_at = now_ms()
                    await self._broadcast_room(room)
            else:
                raise ProtocolError(ErrorCode.NOT_IN_ROOM)
        await self._hub.send_to_player(player_id, {"type": "room", "room": None})

    async def chat(self, player_id: str, *, text: str) -> Room:
        async with self._lock:
            room = self._member_room(player_id)
            player = self._require_player(player_id)
            now = now_ms()
            room.chat_seq += 1
            entry = ChatEntry(
                id=f"{_CHAT_ID_PREFIX}{room.chat_seq}",
                player_id=player.id,
                name=player.name,
                text=text,
                at=now,
            )
            room.chat.append(entry)
            if len(room.chat) > protocol.CHAT_HISTORY_LIMIT:
                room.chat = room.chat[-protocol.CHAT_HISTORY_LIMIT:]
            room.updated_at = now
            message = {"type": "chat", "message": entry.to_dict()}
            for member in [*room.players, *room.spectators]:
                await self._hub.send_to_player(member.id, message)
            return room

    # ------------------------------------------------------------------
    # 查询（同步，供 REST / 快照使用）
    # ------------------------------------------------------------------

    def rooms_snapshot(self) -> list[dict[str, Any]]:
        """大厅房间列表：仅 public + waiting，按创建时间升序。"""
        rooms = [
            room
            for room in self._rooms.values()
            if room.visibility == "public" and room.status == "waiting"
        ]
        rooms.sort(key=lambda r: r.created_at)
        return [self._room_summary(room) for room in rooms]

    def room_snapshot_for(self, player_id: str) -> dict[str, Any] | None:
        room = self._member_room_or_none(player_id)
        if room is None:
            return None
        return self._room_snapshot(room)

    def room_of(self, player_id: str) -> Room | None:
        return self._room_of(player_id)

    def is_spectator(self, player_id: str) -> bool:
        return player_id in self._spectator_room

    @property
    def room_count(self) -> int:
        return len(self._rooms)

    async def reap_idle_rooms(self) -> int:
        """回收超过 ROOM_TTL_SECONDS 无活动的 waiting 房间，返回回收数量。"""
        if self.room_ttl_seconds < 0:
            return 0
        async with self._lock:
            deadline = now_ms() - int(self.room_ttl_seconds * 1000)
            expired = [
                room
                for room in self._rooms.values()
                if room.status == "waiting" and room.updated_at <= deadline
            ]
            for room in expired:
                del self._rooms[room.id]
                for player in room.players:
                    self._player_room.pop(player.id, None)
                    self._cancel_disconnect_task(player.id)
                    await self._hub.send_to_player(player.id, {"type": "room", "room": None})
                for spectator in room.spectators:
                    self._spectator_room.pop(spectator.id, None)
                    await self._hub.send_to_player(spectator.id, {"type": "room", "room": None})
                room.spectators = []
            if expired:
                logger.info("回收 %d 个空闲 waiting 房间", len(expired))
                await self._push_lobby()
            return len(expired)

    # ------------------------------------------------------------------
    # 内部：状态机
    # ------------------------------------------------------------------

    def _start_game_locked(self, room: Room) -> None:
        now = now_ms()
        room.status = "playing"
        room.board = game.empty_board(room.board_size)
        room.current_turn = "black"
        room.last_move = None
        room.moves = []
        room.winner = None
        room.win_line = None
        room.ended_reason = None
        room.started_at = now
        room.ended_at = None
        room.rematch_votes = []
        room.updated_at = now

    async def _leave_locked(self, player_id: str, *, exclude: set[str] | None = None) -> None:
        room_id = self._player_room.pop(player_id, None)
        if room_id is None:
            return
        room = self._rooms.get(room_id)
        if room is None:  # pragma: no cover - 防御性
            return
        self._cancel_disconnect_task(player_id)
        room.players = [p for p in room.players if p.id != player_id]
        room.updated_at = now_ms()
        opponent = room.players[0] if room.players else None

        if opponent is None:
            # 房间无人：销毁，并通知观战者/清掉残留映射
            del self._rooms[room.id]
            spectators = room.spectators
            room.spectators = []
            for spectator in spectators:
                self._spectator_room.pop(spectator.id, None)
                await self._hub.send_to_player(spectator.id, {"type": "room", "room": None})
            await self._push_lobby(exclude=exclude)
            return

        if room.status == "playing":
            # 对手 forfeit 获胜后房间重置为 waiting，等待新对手
            now = now_ms()
            room.status = "finished"
            room.winner = opponent.color
            room.win_line = None
            room.ended_reason = "forfeit"
            room.ended_at = now
            room.updated_at = now
            await self._broadcast_room(room)
            await self._hub.send_to_player(
                opponent.id,
                {"type": "notice", "level": "info", "text": "对手已离开，等待新对手"},
            )
            self._reset_to_waiting_locked(room, host=opponent)
            await self._broadcast_room(room)
        else:
            # waiting / finished：剩余玩家成为房主，房间回到 waiting
            self._reset_to_waiting_locked(room, host=opponent)
            await self._broadcast_room(room)

        await self._push_lobby(exclude=exclude)

    def _reset_to_waiting_locked(self, room: Room, *, host: Player) -> None:
        now = now_ms()
        room.host_id = host.id
        room.players = [host]
        host.color = "black"
        host.ready = False
        room.status = "waiting"
        room.board = game.empty_board(room.board_size)
        room.current_turn = "black"
        room.last_move = None
        room.moves = []
        room.winner = None
        room.win_line = None
        room.ended_reason = None
        room.started_at = None
        room.ended_at = None
        room.rematch_votes = []
        room.updated_at = now

    def _join_room_locked(self, room: Room, player_id: str, name: str) -> None:
        if room.status != "waiting":
            raise ProtocolError(ErrorCode.ROOM_STARTED)
        if len(room.players) >= protocol.MAX_PLAYERS:
            raise ProtocolError(ErrorCode.ROOM_FULL)
        host = room.host or room.players[0]
        player = self._require_player(player_id)
        player.name = name
        player.color = game.OPPOSITE_COLOR[host.color]
        player.ready = False
        player.connected = True
        room.players.append(player)
        room.updated_at = now_ms()
        self._player_room[player.id] = room.id

    # ------------------------------------------------------------------
    # 内部：查询与广播
    # ------------------------------------------------------------------

    def _room_of(self, player_id: str) -> Room | None:
        room_id = self._player_room.get(player_id)
        if room_id is None:
            return None
        return self._rooms.get(room_id)

    def _member_room_or_none(self, player_id: str) -> Room | None:
        room = self._room_of(player_id)
        if room is not None:
            return room
        room_id = self._spectator_room.get(player_id)
        if room_id is None:
            return None
        return self._rooms.get(room_id)

    def _member_room(self, player_id: str) -> Room:
        room = self._member_room_or_none(player_id)
        if room is None:
            raise ProtocolError(ErrorCode.NOT_IN_ROOM)
        return room

    def _require_room(self, player_id: str) -> Room:
        room = self._room_of(player_id)
        if room is None:
            raise ProtocolError(ErrorCode.NOT_IN_ROOM)
        return room

    def _require_player(self, player_id: str) -> Player:
        player = self._players.get(player_id)
        if player is None:  # pragma: no cover - 防御性
            raise ProtocolError(ErrorCode.AUTH_FAILED)
        return player

    def _ensure_not_in_room(self, player_id: str) -> None:
        if player_id in self._player_room or player_id in self._spectator_room:
            raise ProtocolError(ErrorCode.ALREADY_IN_ROOM)

    def _generate_room_id(self) -> str:
        while True:
            room_id = "".join(random.choice(_ROOM_ID_ALPHABET) for _ in range(_ROOM_ID_LENGTH))
            if room_id not in self._rooms:
                return room_id

    def _room_summary(self, room: Room) -> dict[str, Any]:
        host = room.host or (room.players[0] if room.players else None)
        return {
            "id": room.id,
            "name": room.name,
            "status": room.status,
            "playerCount": len(room.players),
            "maxPlayers": protocol.MAX_PLAYERS,
            "hostName": host.name if host else "",
            "createdAt": room.created_at,
        }

    def _room_snapshot(self, room: Room) -> dict[str, Any]:
        return {
            "id": room.id,
            "name": room.name,
            "visibility": room.visibility,
            "status": room.status,
            "hostId": room.host_id,
            "createdAt": room.created_at,
            "updatedAt": room.updated_at,
            "players": [
                player.snapshot(is_host=player.id == room.host_id)
                for player in room.ordered_players()
            ],
            "spectators": len(room.spectators),
            "rematchVotes": list(room.rematch_votes),
            "game": {
                "boardSize": room.board_size,
                "board": [line[:] for line in room.board],
                "currentTurn": room.current_turn,
                "lastMove": (
                    {"row": room.last_move.row, "col": room.last_move.col}
                    if room.last_move is not None
                    else None
                ),
                "moves": [move.to_dict() for move in room.moves],
                "winner": room.winner,
                "winLine": room.win_line,
                "endedReason": room.ended_reason,
                "startedAt": room.started_at,
                "endedAt": room.ended_at,
            },
            "chat": [entry.to_dict() for entry in room.chat],
        }

    async def _broadcast_room(self, room: Room, *, exclude: set[str] | None = None) -> None:
        message = {"type": "room", "room": self._room_snapshot(room)}
        excluded = exclude or set()
        for player in [*room.players, *room.spectators]:
            if player.id in excluded:
                continue
            await self._hub.send_to_player(player.id, message)

    async def _push_lobby(self, *, exclude: set[str] | None = None) -> None:
        message = {"type": "rooms", "rooms": self.rooms_snapshot()}
        excluded = exclude or set()
        for player_id in self._hub.online_player_ids():
            if player_id in self._player_room or player_id in self._spectator_room:
                continue
            if player_id in excluded:
                continue
            await self._hub.send_to_player(player_id, message)
