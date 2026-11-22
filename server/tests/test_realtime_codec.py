"""协议 v3 二进制帧：与前端共享 golden fixture 的编解码测试。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.realtime import codec
from app.realtime.codec import (
    EntityDelta,
    EntitySnapshot,
    InputFrame,
    SnapshotDelta,
    SnapshotKeyframe,
)

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = json.loads((ROOT / "shared" / "realtime-v3.fixtures.json").read_text())
CASES = {case["name"]: case for case in FIXTURES["cases"]}


def _input(data: dict) -> InputFrame:
    return InputFrame(
        seq=data["seq"],
        tick=data["tick"],
        input_flags=data["inputFlags"],
        aim=data["aim"],
    )


def _keyframe(data: dict) -> SnapshotKeyframe:
    return SnapshotKeyframe(
        seq=data["seq"],
        tick=data["tick"],
        entities=tuple(
            EntitySnapshot(
                entity_id=item["id"],
                x=item["x"],
                y=item["y"],
                vx=item["vx"],
                vy=item["vy"],
                angle=item["angle"],
                turret=item["turret"],
                hp=item["hp"],
                flags=item["flags"],
            )
            for item in data["entities"]
        ),
    )


def _delta(data: dict) -> SnapshotDelta:
    return SnapshotDelta(
        seq=data["seq"],
        tick=data["tick"],
        ack_seq=data["ackSeq"],
        baseline_tick=data["baselineTick"],
        entities=tuple(
            EntityDelta(
                entity_id=item["id"],
                mask=item["mask"],
                x=item["x"],
                y=item["y"],
                vx=item["vx"],
                vy=item["vy"],
                angle=item["angle"],
                turret=item["turret"],
                hp=item["hp"],
                flags=item["flags"],
            )
            for item in data["entities"]
        ),
    )


def test_fixture_has_all_frame_kinds() -> None:
    assert set(CASES) == {"input-basic", "snapshot-keyframe", "snapshot-delta"}


def test_input_golden() -> None:
    case = CASES["input-basic"]
    raw = bytes.fromhex(case["hex"])
    expected = _input(case["decoded"])
    assert codec.decode_input(raw) == expected
    assert codec.encode_input(expected) == raw


def test_keyframe_golden() -> None:
    case = CASES["snapshot-keyframe"]
    raw = bytes.fromhex(case["hex"])
    expected = _keyframe(case["decoded"])
    assert codec.decode_keyframe(raw) == expected
    assert codec.decode_snapshot(raw) == expected
    assert codec.encode_keyframe(expected) == raw


def test_delta_golden() -> None:
    case = CASES["snapshot-delta"]
    raw = bytes.fromhex(case["hex"])
    expected = _delta(case["decoded"])
    assert codec.decode_delta(raw) == expected
    assert codec.decode_snapshot(raw) == expected
    assert codec.encode_delta(expected) == raw


@pytest.mark.parametrize(
    "decoder",
    [codec.decode_input, codec.decode_keyframe, codec.decode_delta, codec.decode_snapshot],
)
def test_truncated_and_empty_frames_rejected(decoder) -> None:
    with pytest.raises(ValueError):
        decoder(b"")
    with pytest.raises(ValueError):
        decoder(b"\x02")


def test_wrong_type_rejected() -> None:
    with pytest.raises(ValueError, match="帧类型不匹配"):
        codec.decode_input(bytes.fromhex(CASES["snapshot-keyframe"]["hex"]))


def test_trailing_bytes_rejected() -> None:
    raw = bytes.fromhex(CASES["input-basic"]["hex"])
    with pytest.raises(ValueError, match="长度"):
        codec.decode_input(raw + b"\x00")


def test_delta_mask_requires_its_bytes() -> None:
    header = bytes([codec.FRAME_SNAPSHOT, codec.FLAG_DELTA, 1, 0, 1, 0, 0, 0])
    payload = (0).to_bytes(2, "little") + (0).to_bytes(4, "little") + (1).to_bytes(2, "little")
    # mask 标记了 turret，但没带 turret 的两个字节 → 必须按截断拒绝
    entity = (1).to_bytes(2, "little") + bytes([codec.MASK_TURRET])
    with pytest.raises(ValueError, match="截断"):
        codec.decode_delta(header + payload + entity)


def test_encode_ranges_rejected() -> None:
    with pytest.raises(ValueError):
        codec.encode_input(InputFrame(seq=0x10000, tick=0, input_flags=0, aim=0))
    with pytest.raises(ValueError):
        codec.encode_keyframe(
            SnapshotKeyframe(
                seq=0,
                tick=0,
                entities=(EntitySnapshot(1, 0x8000, 0, 0, 0, 0, 0, 0, 0),),
            )
        )


def test_delta_mask_must_match_fields() -> None:
    # mask 标记了 x，但 x 为空
    with pytest.raises(ValueError, match="x"):
        codec.encode_delta(
            SnapshotDelta(seq=0, tick=0, ack_seq=0, baseline_tick=0, entities=(EntityDelta(1, codec.MASK_X),))
        )
    # mask 未标记 x，但带着值
    with pytest.raises(ValueError, match="x"):
        codec.encode_delta(
            SnapshotDelta(
                seq=0,
                tick=0,
                ack_seq=0,
                baseline_tick=0,
                entities=(EntityDelta(1, 0, x=10),),
            )
        )


def test_quantization_helpers() -> None:
    assert codec.to_fixed(12.34) == 1234
    assert codec.from_fixed(-1234) == pytest.approx(-12.34)
    assert codec.angle_to_u16(0) == 0
    assert codec.angle_to_u16(codec.TAU / 2) == 32768
    assert codec.u16_to_angle(32768) == pytest.approx(codec.TAU / 2, rel=1e-4)
