import { describe, expect, it } from 'vitest';
import fixtures from '../../../../shared/realtime-v3.fixtures.json';
import {
  FLAG_DELTA,
  FRAME_SNAPSHOT,
  MASK_TURRET,
  MASK_X,
  MAX_ENTITIES,
  decodeDelta,
  decodeInput,
  decodeKeyframe,
  decodeSnapshot,
  encodeDelta,
  encodeInput,
  encodeKeyframe,
  type EntityDelta,
  type EntitySnapshot,
  type InputFrame,
  type SnapshotDelta,
  type SnapshotKeyframe,
} from './codec';

const CASES = new Map(fixtures.cases.map((item) => [item.name, item]));

function hexToBytes(hex: string): Uint8Array {
  const pairs = hex.match(/../g);
  if (!pairs) throw new Error(`非法 hex：${hex}`);
  return Uint8Array.from(pairs.map((pair) => Number.parseInt(pair, 16)));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function expectedInput(decoded: (typeof fixtures.cases)[number]['decoded']): InputFrame {
  const data = decoded as { seq: number; tick: number; inputFlags: number; aim: number };
  return { seq: data.seq, tick: data.tick, inputFlags: data.inputFlags, aim: data.aim };
}

function expectedKeyframe(
  decoded: (typeof fixtures.cases)[number]['decoded'],
): SnapshotKeyframe {
  const data = decoded as {
    seq: number;
    tick: number;
    entities: Array<EntitySnapshot & { id: number }>;
  };
  return {
    seq: data.seq,
    tick: data.tick,
    entities: data.entities.map((item) => ({
      id: item.id,
      x: item.x,
      y: item.y,
      vx: item.vx,
      vy: item.vy,
      angle: item.angle,
      turret: item.turret,
      hp: item.hp,
      flags: item.flags,
    })),
  };
}

function expectedDelta(decoded: (typeof fixtures.cases)[number]['decoded']): SnapshotDelta {
  const data = decoded as {
    seq: number;
    tick: number;
    ackSeq: number;
    baselineTick: number;
    entities: Array<EntityDelta & { id: number }>;
  };
  return {
    seq: data.seq,
    tick: data.tick,
    ackSeq: data.ackSeq,
    baselineTick: data.baselineTick,
    entities: data.entities.map((item) => ({
      id: item.id,
      mask: item.mask,
      x: item.x,
      y: item.y,
      vx: item.vx,
      vy: item.vy,
      angle: item.angle,
      turret: item.turret,
      hp: item.hp,
      flags: item.flags,
    })),
  };
}

describe('协议 v3 二进制帧 golden fixture', () => {
  it('输入帧：解码与回编码一致', () => {
    const testCase = CASES.get('input-basic');
    expect(testCase).toBeDefined();
    const bytes = hexToBytes(testCase!.hex);
    const frame = expectedInput(testCase!.decoded);
    expect(decodeInput(bytes)).toEqual(frame);
    expect(bytesToHex(encodeInput(frame))).toBe(testCase!.hex);
  });

  it('快照关键帧：解码与回编码一致', () => {
    const testCase = CASES.get('snapshot-keyframe');
    expect(testCase).toBeDefined();
    const bytes = hexToBytes(testCase!.hex);
    const frame = expectedKeyframe(testCase!.decoded);
    expect(decodeKeyframe(bytes)).toEqual(frame);
    expect(decodeSnapshot(bytes)).toEqual(frame);
    expect(bytesToHex(encodeKeyframe(frame))).toBe(testCase!.hex);
  });

  it('快照增量帧：解码与回编码一致', () => {
    const testCase = CASES.get('snapshot-delta');
    expect(testCase).toBeDefined();
    const bytes = hexToBytes(testCase!.hex);
    const frame = expectedDelta(testCase!.decoded);
    expect(decodeDelta(bytes)).toEqual(frame);
    expect(decodeSnapshot(bytes)).toEqual(frame);
    expect(bytesToHex(encodeDelta(frame))).toBe(testCase!.hex);
  });
});

describe('协议 v3 编解码防御', () => {
  it('拒绝空帧/截断帧', () => {
    expect(() => decodeInput(new Uint8Array())).toThrow();
    expect(() => decodeInput(new Uint8Array([FRAME_SNAPSHOT]))).toThrow();
    const keyframe = hexToBytes(CASES.get('snapshot-keyframe')!.hex);
    expect(() => decodeKeyframe(keyframe.slice(0, -1))).toThrow();
  });

  it('拒绝错误帧类型与多余字节', () => {
    const keyframe = hexToBytes(CASES.get('snapshot-keyframe')!.hex);
    expect(() => decodeInput(keyframe)).toThrow(/帧类型/);
    const input = hexToBytes(CASES.get('input-basic')!.hex);
    expect(() => decodeInput(Uint8Array.from([...input, 0]))).toThrow(/长度/);
  });

  it('增量 mask 标记字段却缺少字节时按截断拒绝', () => {
    const bytes = new Uint8Array(19);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, FRAME_SNAPSHOT);
    view.setUint8(1, FLAG_DELTA);
    view.setUint16(2, 1, true);
    view.setUint32(4, 1, true);
    view.setUint16(8, 0, true);
    view.setUint32(10, 0, true);
    view.setUint16(14, 1, true);
    view.setUint16(16, 1, true);
    view.setUint8(18, MASK_TURRET);
    expect(() => decodeDelta(bytes)).toThrow(/截断/);
  });

  it('编码时检查范围与 mask 一致性', () => {
    expect(() =>
      encodeInput({ seq: 0x10000, tick: 0, inputFlags: 0, aim: 0 }),
    ).toThrow();
    expect(() =>
      encodeKeyframe({
        seq: 0,
        tick: 0,
        entities: [
          { id: 1, x: 0x8000, y: 0, vx: 0, vy: 0, angle: 0, turret: 0, hp: 0, flags: 0 },
        ],
      }),
    ).toThrow();
    expect(() =>
      encodeDelta({
        seq: 0,
        tick: 0,
        ackSeq: 0,
        baselineTick: 0,
        entities: [
          {
            id: 1,
            mask: MASK_X,
            x: null,
            y: null,
            vx: null,
            vy: null,
            angle: null,
            turret: null,
            hp: null,
            flags: null,
          },
        ],
      }),
    ).toThrow();
  });

  it('实体数量上限保持与后端一致', () => {
    expect(MAX_ENTITIES).toBe(1024);
  });
});
