"""实时对局会话：固定步长 tick 循环 + 二进制关键帧广播。

一个 ``TankSession`` 对应一个实时房间：持有 ``TankWorld``（纯模拟），按 20Hz 推进，
每个 tick 把世界快照编码成协议 v3 关键帧，通过 ``ConnectionHub.send_bytes_to_player``
广播给房间内的玩家与观战者；低频事件（命中/击杀/复活/结束）走 JSON ``tank_event``。

设计约束见 ``docs/TANK.md`` §5.2：
- 单房间一个 asyncio 任务；固定步长 + 累计器补帧，单次最多追 5 步。
- 输入只接受二进制帧，按玩家限频 30 次/秒，队列只保留最新一帧（按 tick 合并）。
- 结束时通过 ``on_finish`` 回调让房间层结算，回调用 ``asyncio.create_task`` 调度，
  避免与房间层持有的锁互相等待。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from typing import Any, Awaitable, Callable, Protocol

from ..games.tank import TICK_RATE, EntityView, TankWorld
from ..games.tank_ai import TankBotController
from . import codec

logger = logging.getLogger(__name__)

#: 单个玩家输入频率上限（次/秒），超出直接丢弃。
MAX_INPUT_RATE = 30.0
#: 观战者快照降频：每 N 个 tick 发一次。
SPECTATOR_EVERY = 4
#: 单次循环最多补多少帧，避免卡顿后雪崩。
MAX_CATCHUP_STEPS = 5
#: 落后超过该秒数时直接重同步基准时间。
RESYNC_THRESHOLD = 1.0

#: 实体 flags 位域（与 web/src/games/tank/protocol.ts 保持一致）。
FLAG_KIND_BULLET = 1
SHIFT_OWNER = 2
BIT_ALIVE = 1 << 5
BIT_SHIELDED = 1 << 6


class RoomMembers(Protocol):
    """会话需要的房间成员来源（由 rooms.Room 满足）。"""

    @property
    def players(self) -> list[Any]: ...

    @property
    def spectators(self) -> list[Any]: ...


class RealtimeHub(Protocol):
    """会话需要的广播能力（由 ws.ConnectionHub 实现）。"""

    async def send_bytes_to_player(self, player_id: str, data: bytes) -> None: ...

    async def send_to_player(self, player_id: str, message: dict[str, Any]) -> None: ...


def entity_flags(entity: EntityView) -> int:
    flags = 0
    if entity.kind == 1:
        flags |= FLAG_KIND_BULLET
    flags |= (entity.owner_slot & 0x07) << SHIFT_OWNER
    flags |= BIT_ALIVE
    if entity.shielded:
        flags |= BIT_SHIELDED
    return flags


def encode_keyframe(entities: list[EntityView], *, seq: int, tick: int) -> bytes:
    """把模拟实体编码成协议 v3 关键帧（定点坐标 + u16 角度）。"""
    snapshots = [
        codec.EntitySnapshot(
            entity_id=entity.entity_id,
            x=codec.to_fixed(entity.x),
            y=codec.to_fixed(entity.y),
            vx=codec.to_fixed(entity.vx),
            vy=codec.to_fixed(entity.vy),
            angle=codec.angle_to_u16(entity.hull),
            turret=codec.angle_to_u16(entity.turret),
            hp=entity.hp,
            flags=entity_flags(entity),
        )
        for entity in entities
    ]
    return codec.encode_keyframe(
        codec.SnapshotKeyframe(seq=seq & 0xFFFF, tick=tick, entities=tuple(snapshots))
    )


class TankSession:
    """一个实时房间的对局任务。"""

    def __init__(
        self,
        room: RoomMembers,
        world: TankWorld,
        hub: RealtimeHub,
        *,
        on_finish: Callable[[str], Awaitable[None]] | None = None,
        room_id: str = "",
        tick_rate: int = TICK_RATE,
    ) -> None:
        self._room = room
        self._world = world
        self._hub = hub
        self._on_finish = on_finish
        self._room_id = room_id
        self._tick_rate = tick_rate
        self._task: asyncio.Task[None] | None = None
        self._stopped = False
        self._finished_notified = False
        self._tick = 0
        #: playerId → (input_flags, aim)，只保留最新一帧
        self._inputs: dict[str, tuple[int, int]] = {}
        self._input_times: dict[str, float] = {}
        #: 电脑玩家：每个 tick 由本地 AI 生成输入（与真人共用同一套物理规则）
        self._bot_ids: tuple[str, ...] = tuple(
            player.id for player in getattr(room, "players", ()) if getattr(player, "is_bot", False)
        )
        self._bot_controller = self._build_bot_controller()

    def _build_bot_controller(self) -> TankBotController | None:
        if not self._bot_ids:
            return None
        slots = self._world.player_slots()
        bots = {player_id: slots[player_id] for player_id in self._bot_ids if player_id in slots}
        if not bots:
            return None
        try:
            obstacles = self._world.info()["map"]["obstacles"]
        except (KeyError, TypeError):
            obstacles = ()
        difficulty = getattr(self._room, "bot_difficulty", "normal")
        return TankBotController(bots, obstacles, difficulty=difficulty)

    @property
    def world(self) -> TankWorld:
        return self._world

    @property
    def tick(self) -> int:
        return self._tick

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    def start(self) -> None:
        if self._task is not None:
            return
        self._stopped = False
        self._task = asyncio.create_task(self._run(), name=f"tank-session-{self._room_id}")

    def cancel(self) -> None:
        """同步取消任务（进程退出时用，避免 await 造成二次事件循环调度）。"""
        self._stopped = True
        task = self._task
        self._task = None
        if task is not None and not task.done():
            task.cancel()

    async def stop(self) -> None:
        self._stopped = True
        task = self._task
        self._task = None
        if task is None or task.done():
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    # ------------------------------------------------------------------
    # 输入
    # ------------------------------------------------------------------

    def submit(self, player_id: str, data: bytes) -> None:
        """解码客户端二进制输入帧；非法帧、超频、非对局玩家一律丢弃。"""
        if self._stopped or self._world.finished():
            return
        if player_id not in self._world.player_slots():
            return
        now = time.monotonic()
        last = self._input_times.get(player_id)
        if last is not None and now - last < 1.0 / MAX_INPUT_RATE:
            return
        self._input_times[player_id] = now
        try:
            frame = codec.decode_input(data)
        except ValueError:
            return
        self._inputs[player_id] = (frame.input_flags & 0x3F, frame.aim & 0xFFFF)

    def clear_input(self, player_id: str) -> None:
        """断线/离开时清空输入，避免坦克一直前进或按住开火。"""
        self._inputs.pop(player_id, None)
        self._input_times.pop(player_id, None)
        if player_id in self._world.player_slots():
            self._world.apply_input(player_id, flags=0, aim=0)

    # ------------------------------------------------------------------
    # 主循环
    # ------------------------------------------------------------------

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        period = 1.0 / self._tick_rate
        next_time = loop.time()
        try:
            while not self._stopped:
                now = loop.time()
                if now < next_time:
                    await asyncio.sleep(next_time - now)
                steps = 0
                while not self._stopped and loop.time() >= next_time and steps < MAX_CATCHUP_STEPS:
                    await self._step(period)
                    next_time += period
                    steps += 1
                    if self._world.finished():
                        break
                if loop.time() - next_time > RESYNC_THRESHOLD:
                    next_time = loop.time()
                if self._world.finished():
                    break
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - 单房间异常不能影响整个服务
            logger.exception("实时房间 %s tick 循环异常", self._room_id)
        finally:
            if self._world.finished():
                await self._notify_finished()

    async def _step(self, dt: float) -> None:
        if self._bot_controller is not None:
            entities = self._world.entities()
            for player_id in self._bot_ids:
                flags, aim = self._bot_controller.think(player_id, entities, dt)
                self._world.apply_input(player_id, flags=flags, aim=aim, tick=self._tick)
        for player_id, (flags, aim) in self._inputs.items():
            self._world.apply_input(player_id, flags=flags, aim=aim, tick=self._tick)
        events = self._world.tick(dt)
        self._tick += 1
        await self._broadcast_snapshot()
        if events:
            await self._broadcast_events(events)

    async def _broadcast_snapshot(self) -> None:
        try:
            frame = encode_keyframe(self._world.entities(), seq=self._tick, tick=self._tick)
        except ValueError:
            logger.exception("编码坦克快照失败（房间 %s tick %d）", self._room_id, self._tick)
            return
        for player in list(self._room.players):
            if player.is_bot:
                continue
            await self._hub.send_bytes_to_player(player.id, frame)
        if self._tick % SPECTATOR_EVERY == 0:
            for spectator in list(self._room.spectators):
                await self._hub.send_bytes_to_player(spectator.id, frame)

    async def _broadcast_events(self, events: list[dict[str, Any]]) -> None:
        for player in [*self._room.players, *self._room.spectators]:
            if player.is_bot:
                continue
            for event in events:
                await self._hub.send_to_player(
                    player.id, {"type": "tank_event", "event": event}
                )

    async def _notify_finished(self) -> None:
        if self._finished_notified or self._on_finish is None:
            return
        self._finished_notified = True
        # 用独立任务回调房间层：房间层可能正持有锁，这里 await 会互相等待。
        asyncio.create_task(self._on_finish(self._room_id), name=f"tank-finish-{self._room_id}")
