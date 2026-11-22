"""协议 v3 二进制帧编解码（草案骨架）。

与前端 ``web/src/lib/realtime/codec.ts`` 共用 ``shared/realtime-v3.fixtures.json``
黄金样例；改字段时必须同步两边并重新生成 fixture。

帧格式（小端序）：

- 通用头 8 字节：u8 frameType、u8 flags、u16 seq、u32 tick
- 输入帧：u8 inputFlags、u16 aim（共 11 字节）
- 快照关键帧：u16 entityCount + N × 16 字节实体
  （id、x、y、vx、vy、hull、turret、hp、flags）
- 快照增量帧：u16 ackSeq、u32 baselineTick、u16 changedCount
  + N × (u16 id、u8 mask、按 mask 顺序的变化字段)
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass
from typing import Final

FRAME_INPUT: Final = 0x01
FRAME_SNAPSHOT: Final = 0x02

FLAG_KEYFRAME: Final = 0x01
FLAG_DELTA: Final = 0x02
FLAG_ACK_REQUIRED: Final = 0x04

INPUT_UP: Final = 1 << 0
INPUT_DOWN: Final = 1 << 1
INPUT_LEFT: Final = 1 << 2
INPUT_RIGHT: Final = 1 << 3
INPUT_FIRE: Final = 1 << 4
INPUT_BRAKE: Final = 1 << 5

MASK_X: Final = 1 << 0
MASK_Y: Final = 1 << 1
MASK_VX: Final = 1 << 2
MASK_VY: Final = 1 << 3
MASK_ANGLE: Final = 1 << 4
MASK_TURRET: Final = 1 << 7
MASK_HP: Final = 1 << 5
MASK_FLAGS: Final = 1 << 6
DELTA_MASK_ALL: Final = 0xFF

MAX_ENTITIES: Final = 1024
FIXED_SCALE: Final = 100.0
TAU: Final = math.tau

HEADER = struct.Struct("<BBHI")
INPUT_PAYLOAD = struct.Struct("<BH")
KEYFRAME_HEADER = struct.Struct("<H")
DELTA_HEADER = struct.Struct("<HIH")
ENTITY = struct.Struct("<HhhhhHHBB")
DELTA_ENTITY_HEADER = struct.Struct("<HB")

# (mask, 属性名, struct 格式)；顺序即编码顺序，所有端必须一致。
DELTA_FIELDS: Final = (
    (MASK_X, "x", "<h"),
    (MASK_Y, "y", "<h"),
    (MASK_VX, "vx", "<h"),
    (MASK_VY, "vy", "<h"),
    (MASK_ANGLE, "angle", "<H"),
    (MASK_TURRET, "turret", "<H"),
    (MASK_HP, "hp", "<B"),
    (MASK_FLAGS, "flags", "<B"),
)

U8 = (0, 0xFF)
U16 = (0, 0xFFFF)
I16 = (-0x8000, 0x7FFF)
U32 = (0, 0xFFFFFFFF)


@dataclass(frozen=True, slots=True)
class InputFrame:
    seq: int
    tick: int
    input_flags: int
    aim: int


@dataclass(frozen=True, slots=True)
class EntitySnapshot:
    entity_id: int
    x: int
    y: int
    vx: int
    vy: int
    angle: int
    turret: int
    hp: int
    flags: int


@dataclass(frozen=True, slots=True)
class SnapshotKeyframe:
    seq: int
    tick: int
    entities: tuple[EntitySnapshot, ...]


@dataclass(frozen=True, slots=True)
class EntityDelta:
    entity_id: int
    mask: int
    x: int | None = None
    y: int | None = None
    vx: int | None = None
    vy: int | None = None
    angle: int | None = None
    turret: int | None = None
    hp: int | None = None
    flags: int | None = None


@dataclass(frozen=True, slots=True)
class SnapshotDelta:
    seq: int
    tick: int
    ack_seq: int
    baseline_tick: int
    entities: tuple[EntityDelta, ...]


def angle_to_u16(radians: float) -> int:
    """弧度 → u16（0–2π 映射 0–65535）。"""
    if not math.isfinite(radians):
        raise ValueError("角度必须是有限数值")
    return int(round((radians % TAU) / TAU * 0xFFFF)) & 0xFFFF


def u16_to_angle(value: int) -> float:
    """u16 → 弧度。"""
    _check_int("angle", value, *U16)
    return value / 0xFFFF * TAU


def to_fixed(value: float) -> int:
    """世界单位 → 0.01 定点（调用方负责范围检查）。"""
    if not math.isfinite(value):
        raise ValueError("坐标必须是有限数值")
    return int(round(value * FIXED_SCALE))


def from_fixed(raw: int) -> float:
    return raw / FIXED_SCALE


def _check_int(name: str, value: int, low: int, high: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} 必须是整数")
    if not low <= value <= high:
        raise ValueError(f"{name} 超出范围 [{low}, {high}]：{value}")


def _write_header(kind: int, flags: int, seq: int, tick: int) -> bytearray:
    _check_int("seq", seq, *U16)
    _check_int("tick", tick, *U32)
    buf = bytearray(HEADER.size)
    HEADER.pack_into(buf, 0, kind, flags, seq, tick)
    return buf


def _read_header(data: bytes, expected_kind: int) -> tuple[int, int, int]:
    if len(data) < HEADER.size:
        raise ValueError("帧长度不足，缺少通用头")
    kind, flags, seq, tick = HEADER.unpack_from(data, 0)
    if kind != expected_kind:
        raise ValueError(f"帧类型不匹配：期望 {expected_kind:#04x}，实际 {kind:#04x}")
    return flags, seq, tick


def encode_input(frame: InputFrame) -> bytes:
    _check_int("seq", frame.seq, *U16)
    _check_int("tick", frame.tick, *U32)
    _check_int("input_flags", frame.input_flags, *U8)
    _check_int("aim", frame.aim, *U16)
    buf = _write_header(FRAME_INPUT, 0, frame.seq, frame.tick)
    buf += INPUT_PAYLOAD.pack(frame.input_flags, frame.aim)
    return bytes(buf)


def decode_input(data: bytes) -> InputFrame:
    _flags, seq, tick = _read_header(data, FRAME_INPUT)
    if len(data) != HEADER.size + INPUT_PAYLOAD.size:
        raise ValueError("输入帧长度不正确")
    input_flags, aim = INPUT_PAYLOAD.unpack_from(data, HEADER.size)
    return InputFrame(seq=seq, tick=tick, input_flags=input_flags, aim=aim)


def encode_keyframe(frame: SnapshotKeyframe) -> bytes:
    if len(frame.entities) > MAX_ENTITIES:
        raise ValueError(f"实体数量超过上限 {MAX_ENTITIES}")
    buf = _write_header(FRAME_SNAPSHOT, FLAG_KEYFRAME, frame.seq, frame.tick)
    buf += KEYFRAME_HEADER.pack(len(frame.entities))
    for entity in frame.entities:
        _check_int("entity_id", entity.entity_id, *U16)
        _check_int("x", entity.x, *I16)
        _check_int("y", entity.y, *I16)
        _check_int("vx", entity.vx, *I16)
        _check_int("vy", entity.vy, *I16)
        _check_int("angle", entity.angle, *U16)
        _check_int("turret", entity.turret, *U16)
        _check_int("hp", entity.hp, *U8)
        _check_int("flags", entity.flags, *U8)
        buf += ENTITY.pack(
            entity.entity_id,
            entity.x,
            entity.y,
            entity.vx,
            entity.vy,
            entity.angle,
            entity.turret,
            entity.hp,
            entity.flags,
        )
    return bytes(buf)


def decode_keyframe(data: bytes) -> SnapshotKeyframe:
    flags, seq, tick = _read_header(data, FRAME_SNAPSHOT)
    if not flags & FLAG_KEYFRAME or flags & FLAG_DELTA:
        raise ValueError("快照帧不是关键帧")
    offset = HEADER.size
    if len(data) < offset + KEYFRAME_HEADER.size:
        raise ValueError("关键帧长度不足，缺少实体数量")
    (count,) = KEYFRAME_HEADER.unpack_from(data, offset)
    if count > MAX_ENTITIES:
        raise ValueError(f"实体数量超过上限 {MAX_ENTITIES}")
    offset += KEYFRAME_HEADER.size
    expected = offset + count * ENTITY.size
    if len(data) != expected:
        raise ValueError(f"关键帧长度不正确：期望 {expected}，实际 {len(data)}")
    entities: list[EntitySnapshot] = []
    for _ in range(count):
        values = ENTITY.unpack_from(data, offset)
        offset += ENTITY.size
        entities.append(EntitySnapshot(*values))
    return SnapshotKeyframe(seq=seq, tick=tick, entities=tuple(entities))


def _validate_delta_entity(entity: EntityDelta) -> None:
    _check_int("entity_id", entity.entity_id, *U16)
    _check_int("mask", entity.mask, 0, DELTA_MASK_ALL)
    for mask, attr, _fmt in DELTA_FIELDS:
        value = getattr(entity, attr)
        if entity.mask & mask:
            if value is None:
                raise ValueError(f"mask 标记了 {attr}，但字段为空")
        elif value is not None:
            raise ValueError(f"mask 未标记 {attr}，但字段有值")
    for attr in ("x", "y", "vx", "vy"):
        value = getattr(entity, attr)
        if value is not None:
            _check_int(attr, value, *I16)
    if entity.angle is not None:
        _check_int("angle", entity.angle, *U16)
    if entity.turret is not None:
        _check_int("turret", entity.turret, *U16)
    if entity.hp is not None:
        _check_int("hp", entity.hp, *U8)
    if entity.flags is not None:
        _check_int("flags", entity.flags, *U8)


def encode_delta(frame: SnapshotDelta) -> bytes:
    if len(frame.entities) > MAX_ENTITIES:
        raise ValueError(f"实体数量超过上限 {MAX_ENTITIES}")
    _check_int("ack_seq", frame.ack_seq, *U16)
    _check_int("baseline_tick", frame.baseline_tick, *U32)
    buf = _write_header(FRAME_SNAPSHOT, FLAG_DELTA, frame.seq, frame.tick)
    buf += DELTA_HEADER.pack(frame.ack_seq, frame.baseline_tick, len(frame.entities))
    for entity in frame.entities:
        _validate_delta_entity(entity)
        buf += DELTA_ENTITY_HEADER.pack(entity.entity_id, entity.mask)
        for mask, attr, fmt in DELTA_FIELDS:
            if entity.mask & mask:
                buf += struct.pack(fmt, getattr(entity, attr))
    return bytes(buf)


def decode_delta(data: bytes) -> SnapshotDelta:
    flags, seq, tick = _read_header(data, FRAME_SNAPSHOT)
    if not flags & FLAG_DELTA:
        raise ValueError("快照帧不是增量帧")
    offset = HEADER.size
    if len(data) < offset + DELTA_HEADER.size:
        raise ValueError("增量帧长度不足，缺少头信息")
    ack_seq, baseline_tick, count = DELTA_HEADER.unpack_from(data, offset)
    if count > MAX_ENTITIES:
        raise ValueError(f"实体数量超过上限 {MAX_ENTITIES}")
    offset += DELTA_HEADER.size
    entities: list[EntityDelta] = []
    for _ in range(count):
        if len(data) < offset + DELTA_ENTITY_HEADER.size:
            raise ValueError("增量帧被截断，缺少实体头")
        entity_id, mask = DELTA_ENTITY_HEADER.unpack_from(data, offset)
        offset += DELTA_ENTITY_HEADER.size
        if mask & ~DELTA_MASK_ALL:
            raise ValueError(f"未知的字段 mask：{mask:#04x}")
        values: dict[str, int | None] = {attr: None for _m, attr, _f in DELTA_FIELDS}
        for field_mask, attr, fmt in DELTA_FIELDS:
            if not mask & field_mask:
                continue
            size = struct.calcsize(fmt)
            if len(data) < offset + size:
                raise ValueError(f"增量帧被截断，缺少字段 {attr}")
            values[attr] = struct.unpack_from(fmt, data, offset)[0]
            offset += size
        entities.append(EntityDelta(entity_id=entity_id, mask=mask, **values))
    if offset != len(data):
        raise ValueError("增量帧存在多余字节")
    return SnapshotDelta(
        seq=seq,
        tick=tick,
        ack_seq=ack_seq,
        baseline_tick=baseline_tick,
        entities=tuple(entities),
    )


def decode_snapshot(data: bytes) -> SnapshotKeyframe | SnapshotDelta:
    if len(data) < HEADER.size:
        raise ValueError("帧长度不足，缺少通用头")
    kind, flags, _seq, _tick = HEADER.unpack_from(data, 0)
    if kind != FRAME_SNAPSHOT:
        raise ValueError("不是快照帧")
    if flags & FLAG_KEYFRAME:
        return decode_keyframe(data)
    if flags & FLAG_DELTA:
        return decode_delta(data)
    raise ValueError("快照帧必须标记关键帧或增量")
