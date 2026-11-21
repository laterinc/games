"""房间与对局生命周期（游戏无关）。

具体棋盘/走法/胜负逻辑由 ``app.games`` 的 GameRules 插件提供；
房间层只负责：玩家/座位、准备、悔棋请求、认输、观战、聊天、AI 调度、战绩与广播。
"""

from __future__ import annotations

import asyncio
import copy
import logging
import random
import secrets
from dataclasses import dataclass, field
from typing import Any, Protocol

from .protocol import ErrorCode, ProtocolError, now_ms
from .games import GameRules, build_registry

logger = logging.getLogger(__name__)

_ROOM_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_ROOM_ID_LENGTH = 6
_CHAT_ID_PREFIX = "m_"
#: 单个房间最多观战人数
MAX_SPECTATORS = 20
#: 每个玩家保留的最近战绩条数
MAX_RECORDS = 10


class ConnectionHub(Protocol):
    """房间层需要的连接能力（由 ws.ConnectionHub 实现）。"""

    async def send_to_player(self, player_id: str, message: dict[str, Any]) -> None: ...

    def online_player_ids(self) -> list[str]: ...


@dataclass(slots=True)
class Player:
    """玩家身份，跨房间保留，用于 token / Cookie 重连。"""

    id: str
    token: str
    name: str = ""
    color: str = "black"
    connected: bool = True
    ready: bool = False
    disconnect_epoch: int = 0
    is_bot: bool = False
    records: list[dict[str, Any]] = field(default_factory=list)

    def snapshot(self, *, is_host: bool) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "connected": self.connected,
            "ready": self.ready,
            "isHost": is_host,
            "isBot": self.is_bot,
        }


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
    game_type: str
    created_at: int
    updated_at: int
    color_order: tuple[str, str]
    status: str = "waiting"
    players: list[Player] = field(default_factory=list)
    spectators: list[Player] = field(default_factory=list)
    mode: str = "pvp"
    ai_color: str | None = None
    pending_undo: dict[str, Any] | None = None
    rematch_votes: list[str] = field(default_factory=list)
    chat: list[ChatEntry] = field(default_factory=list)
    chat_seq: int = 0
    state: dict[str, Any] = field(default_factory=dict)

    # -- 便捷属性（兼容旧测试/调用方）-----------------------------------
    @property
    def board(self) -> list[list[Any]]:
        return self.state.get("board", [])

    @property
    def current_turn(self) -> str:
        return str(self.state.get("currentTurn", self.color_order[0]))

    @property
    def board_size(self) -> int:
        return int(self.state.get("boardSize", len(self.state.get("board") or [])) or 0)

    def player(self, player_id: str) -> Player | None:
        return next((p for p in self.players if p.id == player_id), None)

    def opponent_of(self, player_id: str) -> Player | None:
        return next((p for p in self.players if p.id != player_id), None)

    @property
    def host(self) -> Player | None:
        return self.player(self.host_id)

    def ordered_players(self) -> list[Player]:
        """players 顺序固定为执先颜色在前。"""
        return sorted(self.players, key=lambda p: 0 if p.color == self.color_order[0] else 1)


class RoomManager:
    """房间与对局状态机（游戏规则由 GameRules 插件提供）。"""

    def __init__(
        self,
        hub: ConnectionHub,
        *,
        board_size: int = 15,
        room_ttl_seconds: float = 6 * 3600.0,
        disconnect_grace_seconds: float = 60.0,
        games: dict[str, GameRules] | None = None,
    ) -> None:
        self._hub = hub
        self.board_size = board_size
        self.room_ttl_seconds = room_ttl_seconds
        self.disconnect_grace_seconds = disconnect_grace_seconds
        self._games = games or build_registry(gomoku_board_size=board_size)
        self._lock = asyncio.Lock()
        self._players: dict[str, Player] = {}
        self._rooms: dict[str, Room] = {}
        self._player_room: dict[str, str] = {}
        self._spectator_room: dict[str, str] = {}
        self._disconnect_tasks: dict[str, asyncio.Task[None]] = {}
        self._ai_tasks: dict[str, asyncio.Task[None]] = {}

    # ------------------------------------------------------------------
    # 游戏注册表
    # ------------------------------------------------------------------

    def rules(self, game_type: str) -> GameRules:
        rules = self._games.get(game_type)
        if rules is None:
            raise ProtocolError(ErrorCode.INVALID_MESSAGE, f"不支持的游戏：{game_type}")
        return rules

    def game_types(self) -> list[str]:
        return list(self._games.keys())

    # ------------------------------------------------------------------
    # 身份
    # ------------------------------------------------------------------

    def create_player(self) -> Player:
        player = Player(
            id=f"p_{secrets.token_hex(4)}",
            token=f"t_{secrets.token_urlsafe(24)}",
        )
        self._players[player.id] = player
        return player

    def authenticate(self, player_id: str, token: str) -> Player | None:
        player = self._players.get(player_id)
        if player is None or not token:
            return None
        if not secrets.compare_digest(player.token, token):
            return None
        return player

    def session_cookie_value(self, player: Player) -> str:
        return f"{player.id}.{player.token}"

    def authenticate_cookie(self, value: str | None) -> Player | None:
        if not value:
            return None
        player_id, sep, token = value.partition(".")
        if not sep:
            return None
        return self.authenticate(player_id, token)

    def discard_player(self, player_id: str) -> None:
        if player_id in self._player_room or player_id in self._spectator_room:
            return
        self._players.pop(player_id, None)

    def player_records(self, player_id: str) -> list[dict[str, Any]]:
        player = self._players.get(player_id)
        if player is None or player.is_bot:
            return []
        return [dict(record) for record in player.records]

    # ------------------------------------------------------------------
    # 连接状态 / 断线宽限
    # ------------------------------------------------------------------

    async def mark_connected(self, player_id: str) -> None:
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
        for task in self._disconnect_tasks.values():
            if not task.done():
                task.cancel()
        self._disconnect_tasks.clear()
        for task in self._ai_tasks.values():
            if not task.done():
                task.cancel()
        self._ai_tasks.clear()

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
        mode: str = "pvp",
        game_type: str = "gomoku",
    ) -> Room:
        async with self._lock:
            self._ensure_not_in_room(player_id)
            room = self._make_room_locked(
                player_id,
                name=name,
                room_name=room_name,
                visibility=visibility,
                color=color,
                game_type=game_type,
            )
            if mode == "ai":
                self._start_ai_locked(room)
                await self._broadcast_room(room)
                self._schedule_ai_move(room)
                return room
            await self._broadcast_room(room)
            await self._push_lobby()
            return room

    def _make_room_locked(
        self,
        player_id: str,
        *,
        name: str,
        room_name: str,
        visibility: str,
        color: str,
        game_type: str,
        room_id: str | None = None,
        created_at: int | None = None,
    ) -> Room:
        rules = self.rules(game_type)
        player = self._require_player(player_id)
        player.name = name
        player.ready = False
        if color == "random":
            actual_color = random.choice(rules.colors)
        elif color in rules.create_colors:
            actual_color = color
        else:
            raise ProtocolError(ErrorCode.INVALID_MESSAGE, "颜色不适用于该游戏")
        player.color = actual_color

        created = created_at or now_ms()
        room = Room(
            id=room_id or self._generate_room_id(),
            name=room_name or f"{name}的棋局",
            visibility=visibility,
            host_id=player.id,
            game_type=game_type,
            created_at=created,
            updated_at=created,
            color_order=rules.colors,
            state=rules.new_game(),
            players=[player],
        )
        self._rooms[room.id] = room
        self._player_room[player.id] = room.id
        return room

    def _start_ai_locked(self, room: Room) -> None:
        rules = self.rules(room.game_type)
        room.name = room.name if room.name != f"{room.players[0].name}的棋局" else f"{room.players[0].name} 人机对战"
        room.visibility = "private"
        room.mode = "ai"
        human = room.players[0]
        bot_color = rules.opposite(human.color)
        room.players.append(
            Player(
                id=f"bot_{secrets.token_hex(4)}",
                token="",
                name="电脑",
                color=bot_color,
                connected=True,
                is_bot=True,
            )
        )
        room.ai_color = bot_color
        self._start_game_locked(room)

    async def join_room(self, player_id: str, *, room_id: str, name: str) -> Room:
        async with self._lock:
            room = self._rooms.get(room_id)
            if player_id in self._player_room:
                if self._player_room[player_id] == room_id and room is not None:
                    # 幂等：刷新后误点「加入」也能恢复
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

    async def quick_match(self, player_id: str, *, name: str, game_type: str = "gomoku") -> Room:
        async with self._lock:
            self._ensure_not_in_room(player_id)
            self.rules(game_type)
            candidates = [
                room
                for room in self._rooms.values()
                if room.visibility == "public"
                and room.status == "waiting"
                and len(room.players) == 1
                and room.game_type == game_type
            ]
            if candidates:
                room = min(candidates, key=lambda r: r.created_at)
                self._join_room_locked(room, player_id, name)
                await self._broadcast_room(room)
                await self._push_lobby()
                return room

            room = self._make_room_locked(
                player_id,
                name=name,
                room_name="",
                visibility="public",
                color="random",
                game_type=game_type,
            )
            if game_type == "gomoku":
                # 快速匹配的默认体验：创建者执黑
                room.players[0].color = room.color_order[0]
            await self._broadcast_room(room)
            await self._push_lobby()
            return room

    async def ready(self, player_id: str) -> Room:
        async with self._lock:
            room = self._require_room(player_id)
            if room.mode == "ai" or room.status != "waiting":
                raise ProtocolError(ErrorCode.GAME_NOT_ACTIVE)
            player = self._require_player(player_id)
            player.ready = not player.ready
            started = (
                len(room.players) == 2
                and all(p.ready for p in room.players)
            )
            if started:
                self._start_game_locked(room)
            room.updated_at = now_ms()
            await self._broadcast_room(room)
            if started:
                await self._push_lobby()
            return room

    async def move(
        self,
        player_id: str,
        *,
        move: dict[str, Any] | None = None,
        row: int | None = None,
        col: int | None = None,
    ) -> Room:
        async with self._lock:
            room = self._require_room(player_id)
            if room.status != "playing":
                raise ProtocolError(ErrorCode.GAME_NOT_ACTIVE)
            player = self._require_player(player_id)
            rules = self.rules(room.game_type)
            if player.is_bot or player.color != rules.turn(room.state):
                raise ProtocolError(ErrorCode.NOT_YOUR_TURN)
            payload = move if move is not None else {"row": row, "col": col}
            rules.apply_move(room.state, player.color, payload)
            room.updated_at = now_ms()
            finished = rules.is_finished(room.state)
            if finished:
                room.status = "finished"
                self._cancel_ai_task(room.id)
                self._record_results_locked(room)
            await self._broadcast_room(room)
            if finished:
                await self._send_records_to_room(room)
            else:
                self._schedule_ai_move(room)
            return room

    async def resign(self, player_id: str) -> Room:
        async with self._lock:
            room = self._require_room(player_id)
            player = self._require_player(player_id)
            if player.is_bot or room.status != "playing":
                raise ProtocolError(ErrorCode.GAME_NOT_ACTIVE)
            opponent = next((p for p in room.players if p.id != player.id), None)
            if opponent is None:
                raise ProtocolError(ErrorCode.GAME_NOT_ACTIVE)
            self._finish_game_locked(room, opponent.color, "resign")
            await self._broadcast_room(room)
            await self._send_records_to_room(room)
            return room

    async def undo_request(self, player_id: str) -> Room:
        async with self._lock:
            room = self._require_room(player_id)
            player = self._require_player(player_id)
            rules = self.rules(room.game_type)
            if player.is_bot or room.status != "playing":
                raise ProtocolError(ErrorCode.GAME_NOT_ACTIVE)
            if not room.state.get("moves"):
                raise ProtocolError(ErrorCode.GAME_NOT_ACTIVE, "还没有走子，无法悔棋")
            if room.pending_undo is not None:
                if room.pending_undo["playerId"] == player.id:
                    await self._broadcast_room(room)
                    return room
                raise ProtocolError(ErrorCode.GAME_NOT_ACTIVE, "对方已发起悔棋请求")

            if room.mode == "ai":
                self._apply_undo_locked(room)
                await self._broadcast_room(room)
                await self._hub.send_to_player(
                    player.id, {"type": "notice", "level": "info", "text": "电脑同意悔棋"}
                )
                self._schedule_ai_move(room)
                return room

            room.pending_undo = {"playerId": player.id, "name": player.name}
            room.updated_at = now_ms()
            await self._broadcast_room(room)
            return room

    async def undo_response(self, player_id: str, *, accept: bool) -> Room:
        async with self._lock:
            room = self._require_room(player_id)
            player = self._require_player(player_id)
            pending = room.pending_undo
            if pending is None:
                raise ProtocolError(ErrorCode.GAME_NOT_ACTIVE, "没有待处理的悔棋请求")
            if pending["playerId"] == player.id:
                raise ProtocolError(ErrorCode.GAME_NOT_ACTIVE, "不能回应自己的悔棋请求")
            requester = room.player(pending["playerId"])
            if requester is None:
                room.pending_undo = None
                raise ProtocolError(ErrorCode.GAME_NOT_ACTIVE, "对方已离开房间")

            if accept:
                self._apply_undo_locked(room)
                text = "对方同意悔棋"
            else:
                room.pending_undo = None
                room.updated_at = now_ms()
                text = "对方拒绝悔棋"

            await self._broadcast_room(room)
            for member in (player, requester):
                await self._hub.send_to_player(
                    member.id, {"type": "notice", "level": "info", "text": text}
                )
            return room

    async def rematch(self, player_id: str) -> Room:
        async with self._lock:
            room = self._require_room(player_id)
            rules = self.rules(room.game_type)
            if room.status != "finished":
                raise ProtocolError(ErrorCode.GAME_NOT_ACTIVE)

            if room.mode == "ai":
                player = self._require_player(player_id)
                if player.is_bot:
                    raise ProtocolError(ErrorCode.GAME_NOT_ACTIVE)
                for member in room.players:
                    member.color = rules.opposite(member.color)
                bot = next((member for member in room.players if member.is_bot), None)
                room.ai_color = bot.color if bot is not None else None
                self._start_game_locked(room)
                await self._broadcast_room(room)
                self._schedule_ai_move(room)
                return room

            if player_id not in room.rematch_votes:
                room.rematch_votes.append(player_id)
            room.updated_at = now_ms()
            everyone_voted = (
                len(room.players) == 2
                and all(p.id in room.rematch_votes for p in room.players)
            )
            if everyone_voted:
                for member in room.players:
                    member.color = rules.opposite(member.color)
                self._start_game_locked(room)
            await self._broadcast_room(room)
            return room

    async def watch_room(self, player_id: str, *, room_id: str, name: str) -> Room:
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
            if len(room.chat) > 50:
                room.chat = room.chat[-50:]
            room.updated_at = now
            message = {"type": "chat", "message": entry.to_dict()}
            for member in [*room.players, *room.spectators]:
                await self._hub.send_to_player(member.id, message)
            return room

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------

    def rooms_snapshot(self, game_type: str | None = None) -> list[dict[str, Any]]:
        rooms = [
            room
            for room in self._rooms.values()
            if room.visibility == "public"
            and room.status == "waiting"
            and room.mode == "pvp"
            and (game_type is None or room.game_type == game_type)
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
    # 内部：开局 / 落子 / 终局 / 战绩 / 悔棋 / AI
    # ------------------------------------------------------------------

    def _start_game_locked(self, room: Room) -> None:
        rules = self.rules(room.game_type)
        now = now_ms()
        room.state = rules.new_game()
        room.state["startedAt"] = now
        room.status = "playing"
        room.rematch_votes = []
        room.pending_undo = None
        room.updated_at = now

    def _apply_undo_locked(self, room: Room) -> None:
        rules = self.rules(room.game_type)
        self._cancel_ai_task(room.id)
        last_color = rules.last_move_color(room.state)
        if not rules.undo(room.state):
            return
        if room.mode == "ai" and last_color == room.ai_color and room.state.get("moves"):
            # 电脑的应手也要撤回，同时退掉玩家上一手
            rules.undo(room.state)
        room.status = "playing"
        room.pending_undo = None
        room.updated_at = now_ms()

    def _finish_game_locked(self, room: Room, winner: str | None, reason: str) -> None:
        rules = self.rules(room.game_type)
        rules.finish(room.state, winner, reason)
        room.status = "finished"
        room.rematch_votes = []
        room.pending_undo = None
        room.updated_at = room.state.get("endedAt") or now_ms()
        self._cancel_ai_task(room.id)
        self._record_results_locked(room)

    def _record_results_locked(self, room: Room) -> None:
        rules = self.rules(room.game_type)
        winner = rules.winner(room.state)
        reason = rules.finished_reason(room.state) or "unknown"
        at = room.state.get("endedAt") or now_ms()
        for player in room.players:
            if player.is_bot:
                continue
            opponent = next((p for p in room.players if p.id != player.id), None)
            if winner is None:
                result = "draw"
            elif winner == player.color:
                result = "win"
            else:
                result = "loss"
            player.records.append(
                {
                    "result": result,
                    "opponent": opponent.name if opponent is not None else "",
                    "mode": room.mode,
                    "gameType": room.game_type,
                    "endedReason": reason,
                    "moves": len(room.state.get("moves") or []),
                    "myColor": player.color,
                    "at": at,
                }
            )
            if len(player.records) > MAX_RECORDS:
                del player.records[: len(player.records) - MAX_RECORDS]

    async def _send_records_to_room(self, room: Room) -> None:
        for player in room.players:
            if player.is_bot:
                continue
            await self._hub.send_to_player(
                player.id,
                {"type": "records", "records": [dict(record) for record in player.records]},
            )

    def _cancel_ai_task(self, room_id: str) -> None:
        task = self._ai_tasks.pop(room_id, None)
        if task is not None and not task.done():
            task.cancel()

    def _schedule_ai_move(self, room: Room) -> None:
        self._cancel_ai_task(room.id)
        if room.mode != "ai" or room.status != "playing" or room.ai_color is None:
            return
        rules = self.rules(room.game_type)
        if rules.turn(room.state) != room.ai_color:
            return
        self._ai_tasks[room.id] = asyncio.create_task(
            self._ai_move_after_delay(room.id, rules.ai_delay_seconds)
        )

    async def _ai_move_after_delay(self, room_id: str, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return
        async with self._lock:
            room = self._rooms.get(room_id)
            if room is None or room.status != "playing" or room.ai_color is None:
                return
            rules = self.rules(room.game_type)
            if rules.turn(room.state) != room.ai_color:
                return
            self._ai_tasks.pop(room_id, None)
            target = rules.ai_move(room.state, room.ai_color)
            if target is None:
                self._finish_game_locked(room, None, "draw")
            else:
                rules.apply_move(room.state, room.ai_color, target)
                if rules.is_finished(room.state):
                    room.status = "finished"
                    self._record_results_locked(room)
            room.updated_at = now_ms()
            await self._broadcast_room(room)
            if room.status == "finished":
                await self._send_records_to_room(room)

    # ------------------------------------------------------------------
    # 内部：离开 / 重置 / 加入
    # ------------------------------------------------------------------

    async def _leave_locked(self, player_id: str, *, exclude: set[str] | None = None) -> None:
        room_id = self._player_room.pop(player_id, None)
        if room_id is None:
            return
        room = self._rooms.get(room_id)
        if room is None:
            return
        rules = self.rules(room.game_type)
        self._cancel_disconnect_task(player_id)
        room.players = [p for p in room.players if p.id != player_id]
        room.updated_at = now_ms()
        opponent = room.players[0] if room.players else None

        if room.mode == "ai":
            self._cancel_ai_task(room.id)
            del self._rooms[room.id]
            await self._clear_spectators_locked(room)
            await self._push_lobby(exclude=exclude)
            return

        if opponent is None:
            del self._rooms[room.id]
            await self._clear_spectators_locked(room)
            await self._push_lobby(exclude=exclude)
            return

        if room.status == "playing":
            room.state["winner"] = opponent.color
            rules.finish(room.state, opponent.color, "forfeit")
            room.status = "finished"
            room.pending_undo = None
            self._record_results_locked(room)
            await self._broadcast_room(room)
            await self._send_records_to_room(room)
            await self._hub.send_to_player(
                opponent.id,
                {"type": "notice", "level": "info", "text": "对手已离开，等待新对手"},
            )
            self._reset_to_waiting_locked(room, opponent)
            await self._broadcast_room(room)
        else:
            self._reset_to_waiting_locked(room, opponent)
            await self._broadcast_room(room)

        await self._push_lobby(exclude=exclude)

    async def _clear_spectators_locked(self, room: Room) -> None:
        spectators = room.spectators
        room.spectators = []
        for spectator in spectators:
            self._spectator_room.pop(spectator.id, None)
            await self._hub.send_to_player(spectator.id, {"type": "room", "room": None})

    def _reset_to_waiting_locked(self, room: Room, host: Player) -> None:
        rules = self.rules(room.game_type)
        now = now_ms()
        room.host_id = host.id
        room.players = [host]
        host.color = room.color_order[0]
        host.ready = False
        room.status = "waiting"
        room.state = rules.new_game()
        room.pending_undo = None
        room.rematch_votes = []
        room.updated_at = now

    def _join_room_locked(self, room: Room, player_id: str, name: str) -> None:
        if room.status != "waiting":
            raise ProtocolError(ErrorCode.ROOM_STARTED)
        if len(room.players) >= 2:
            raise ProtocolError(ErrorCode.ROOM_FULL)
        host = room.host or room.players[0]
        player = self._require_player(player_id)
        player.name = name
        player.color = (
            room.color_order[1] if host.color == room.color_order[0] else room.color_order[0]
        )
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
        if player is None:
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
            "gameType": room.game_type,
            "status": room.status,
            "playerCount": len(room.players),
            "maxPlayers": 2,
            "hostName": host.name if host else "",
            "createdAt": room.created_at,
        }

    def _room_snapshot(self, room: Room) -> dict[str, Any]:
        return {
            "id": room.id,
            "name": room.name,
            "visibility": room.visibility,
            "gameType": room.game_type,
            "status": room.status,
            "hostId": room.host_id,
            "createdAt": room.created_at,
            "updatedAt": room.updated_at,
            "players": [
                player.snapshot(is_host=player.id == room.host_id)
                for player in room.ordered_players()
            ],
            "spectators": len(room.spectators),
            "mode": room.mode,
            "pendingUndo": room.pending_undo,
            "rematchVotes": list(room.rematch_votes),
            "game": copy.deepcopy(room.state),
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
