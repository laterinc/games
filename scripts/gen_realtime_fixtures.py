#!/usr/bin/env python3
"""从后端 codec 生成协议 v3 的共享黄金样例。

用法：server/.venv/bin/python scripts/gen_realtime_fixtures.py
任何字段/字节序调整后都必须重新生成并提交，否则前后端测试会各说各话。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from app.realtime.codec import (  # noqa: E402
    MASK_ANGLE,
    MASK_FLAGS,
    MASK_HP,
    MASK_TURRET,
    MASK_X,
    MASK_Y,
    EntityDelta,
    EntitySnapshot,
    InputFrame,
    SnapshotDelta,
    SnapshotKeyframe,
    encode_delta,
    encode_input,
    encode_keyframe,
)

FIXTURE_PATH = ROOT / "shared" / "realtime-v3.fixtures.json"


def entity_json(entity: EntitySnapshot) -> dict[str, int]:
    return {
        "id": entity.entity_id,
        "x": entity.x,
        "y": entity.y,
        "vx": entity.vx,
        "vy": entity.vy,
        "angle": entity.angle,
        "turret": entity.turret,
        "hp": entity.hp,
        "flags": entity.flags,
    }


def delta_json(entity: EntityDelta) -> dict[str, int | None]:
    return {
        "id": entity.entity_id,
        "mask": entity.mask,
        "x": entity.x,
        "y": entity.y,
        "vx": entity.vx,
        "vy": entity.vy,
        "angle": entity.angle,
        "turret": entity.turret,
        "hp": entity.hp,
        "flags": entity.flags,
    }


def main() -> None:
    input_frame = InputFrame(seq=42, tick=1000, input_flags=0b00010101, aim=16384)
    keyframe = SnapshotKeyframe(
        seq=7,
        tick=120,
        entities=(
            EntitySnapshot(1, 12345, -6789, 30, 0, 16384, 20000, 100, 1),
            EntitySnapshot(2, -100, 200, 0, -15, 32768, 4000, 80, 5),
        ),
    )
    delta = SnapshotDelta(
        seq=9,
        tick=130,
        ack_seq=7,
        baseline_tick=120,
        entities=(
            EntityDelta(1, MASK_X | MASK_Y, x=12400, y=-6700),
            EntityDelta(2, MASK_ANGLE | MASK_TURRET, angle=33000, turret=1234),
            EntityDelta(3, MASK_HP | MASK_FLAGS, hp=42, flags=0x0A),
        ),
    )

    payload = {
        "protocolVersion": 3,
        "note": "协议 v3 二进制帧黄金样例；由 scripts/gen_realtime_fixtures.py 生成，请勿手改 hex。",
        "cases": [
            {
                "name": "input-basic",
                "type": "input",
                "hex": encode_input(input_frame).hex(),
                "decoded": {
                    "seq": input_frame.seq,
                    "tick": input_frame.tick,
                    "inputFlags": input_frame.input_flags,
                    "aim": input_frame.aim,
                },
            },
            {
                "name": "snapshot-keyframe",
                "type": "keyframe",
                "hex": encode_keyframe(keyframe).hex(),
                "decoded": {
                    "seq": keyframe.seq,
                    "tick": keyframe.tick,
                    "entities": [entity_json(item) for item in keyframe.entities],
                },
            },
            {
                "name": "snapshot-delta",
                "type": "delta",
                "hex": encode_delta(delta).hex(),
                "decoded": {
                    "seq": delta.seq,
                    "tick": delta.tick,
                    "ackSeq": delta.ack_seq,
                    "baselineTick": delta.baseline_tick,
                    "entities": [delta_json(item) for item in delta.entities],
                },
            },
        ],
    }
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {FIXTURE_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
