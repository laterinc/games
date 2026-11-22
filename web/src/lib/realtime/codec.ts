/**
 * 协议 v3 二进制帧编解码（草案骨架）。
 *
 * 与后端 `server/app/realtime/codec.py` 共用
 * `shared/realtime-v3.fixtures.json` 黄金样例；改字段时必须同步两边并重新生成 fixture。
 *
 * 通用头 8 字节：u8 frameType、u8 flags、u16 seq、u32 tick（小端序）。
 * - 输入帧：u8 inputFlags、u16 aim
 * - 快照关键帧：u16 entityCount + N × 16 字节实体（含 hull 与 turret）
 * - 快照增量帧：u16 ackSeq、u32 baselineTick、u16 changedCount + N × (u16 id、u8 mask、变化字段)
 */

export const FRAME_INPUT = 0x01;
export const FRAME_SNAPSHOT = 0x02;

export const FLAG_KEYFRAME = 0x01;
export const FLAG_DELTA = 0x02;
export const FLAG_ACK_REQUIRED = 0x04;

export const INPUT_UP = 1 << 0;
export const INPUT_DOWN = 1 << 1;
export const INPUT_LEFT = 1 << 2;
export const INPUT_RIGHT = 1 << 3;
export const INPUT_FIRE = 1 << 4;
export const INPUT_BRAKE = 1 << 5;

export const MASK_X = 1 << 0;
export const MASK_Y = 1 << 1;
export const MASK_VX = 1 << 2;
export const MASK_VY = 1 << 3;
export const MASK_ANGLE = 1 << 4;
export const MASK_HP = 1 << 5;
export const MASK_FLAGS = 1 << 6;
export const MASK_TURRET = 1 << 7;

/** 所有已定义的增量字段 mask 之和。 */
export const DELTA_MASK_ALL =
  MASK_X | MASK_Y | MASK_VX | MASK_VY | MASK_ANGLE | MASK_HP | MASK_FLAGS | MASK_TURRET;

export const MAX_ENTITIES = 1024;
export const FIXED_SCALE = 100;
export const TAU = Math.PI * 2;

const HEADER_SIZE = 8;
const INPUT_PAYLOAD_SIZE = 3;
const KEYFRAME_HEADER_SIZE = 2;
const DELTA_HEADER_SIZE = 8;
const ENTITY_SIZE = 16;
const DELTA_ENTITY_HEADER_SIZE = 3;

export interface InputFrame {
  seq: number;
  tick: number;
  inputFlags: number;
  aim: number;
}

export interface EntitySnapshot {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  turret: number;
  hp: number;
  flags: number;
}

export interface SnapshotKeyframe {
  seq: number;
  tick: number;
  entities: EntitySnapshot[];
}

export interface EntityDelta {
  id: number;
  mask: number;
  x: number | null;
  y: number | null;
  vx: number | null;
  vy: number | null;
  angle: number | null;
  turret: number | null;
  hp: number | null;
  flags: number | null;
}

export interface SnapshotDelta {
  seq: number;
  tick: number;
  ackSeq: number;
  baselineTick: number;
  entities: EntityDelta[];
}

export type SnapshotFrame = SnapshotKeyframe | SnapshotDelta;

const U8 = { min: 0, max: 0xff } as const;
const U16 = { min: 0, max: 0xffff } as const;
const I16 = { min: -0x8000, max: 0x7fff } as const;
const U32 = { min: 0, max: 0xffffffff } as const;

function checkInt(
  name: string,
  value: number,
  range: { min: number; max: number },
): void {
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new Error(`${name} 超出范围 [${range.min}, ${range.max}]：${value}`);
  }
}

function assertSize(data: Uint8Array, expected: number): void {
  if (data.byteLength !== expected) {
    throw new Error(`帧长度不正确：期望 ${expected}，实际 ${data.byteLength}`);
  }
}

function writeHeader(
  view: DataView,
  type: number,
  flags: number,
  seq: number,
  tick: number,
): void {
  checkInt('seq', seq, U16);
  checkInt('tick', tick, U32);
  view.setUint8(0, type);
  view.setUint8(1, flags);
  view.setUint16(2, seq, true);
  view.setUint32(4, tick, true);
}

function readHeader(data: Uint8Array, expectedType: number): {
  flags: number;
  seq: number;
  tick: number;
} {
  if (data.byteLength < HEADER_SIZE) throw new Error('帧长度不足，缺少通用头');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = view.getUint8(0);
  if (type !== expectedType) {
    throw new Error(`帧类型不匹配：期望 ${expectedType}，实际 ${type}`);
  }
  return {
    flags: view.getUint8(1),
    seq: view.getUint16(2, true),
    tick: view.getUint32(4, true),
  };
}

export function encodeInput(frame: InputFrame): Uint8Array {
  checkInt('inputFlags', frame.inputFlags, U8);
  checkInt('aim', frame.aim, U16);
  const bytes = new Uint8Array(HEADER_SIZE + INPUT_PAYLOAD_SIZE);
  const view = new DataView(bytes.buffer);
  writeHeader(view, FRAME_INPUT, 0, frame.seq, frame.tick);
  view.setUint8(HEADER_SIZE, frame.inputFlags);
  view.setUint16(HEADER_SIZE + 1, frame.aim, true);
  return bytes;
}

export function decodeInput(data: Uint8Array): InputFrame {
  const header = readHeader(data, FRAME_INPUT);
  assertSize(data, HEADER_SIZE + INPUT_PAYLOAD_SIZE);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    seq: header.seq,
    tick: header.tick,
    inputFlags: view.getUint8(HEADER_SIZE),
    aim: view.getUint16(HEADER_SIZE + 1, true),
  };
}

export function encodeKeyframe(frame: SnapshotKeyframe): Uint8Array {
  if (frame.entities.length > MAX_ENTITIES) {
    throw new Error(`实体数量超过上限 ${MAX_ENTITIES}`);
  }
  const bytes = new Uint8Array(
    HEADER_SIZE + KEYFRAME_HEADER_SIZE + frame.entities.length * ENTITY_SIZE,
  );
  const view = new DataView(bytes.buffer);
  writeHeader(view, FRAME_SNAPSHOT, FLAG_KEYFRAME, frame.seq, frame.tick);
  view.setUint16(HEADER_SIZE, frame.entities.length, true);
  let offset = HEADER_SIZE + KEYFRAME_HEADER_SIZE;
  for (const entity of frame.entities) {
    checkInt('id', entity.id, U16);
    checkInt('x', entity.x, I16);
    checkInt('y', entity.y, I16);
    checkInt('vx', entity.vx, I16);
    checkInt('vy', entity.vy, I16);
    checkInt('angle', entity.angle, U16);
    checkInt('turret', entity.turret, U16);
    checkInt('hp', entity.hp, U8);
    checkInt('flags', entity.flags, U8);
    view.setUint16(offset, entity.id, true);
    view.setInt16(offset + 2, entity.x, true);
    view.setInt16(offset + 4, entity.y, true);
    view.setInt16(offset + 6, entity.vx, true);
    view.setInt16(offset + 8, entity.vy, true);
    view.setUint16(offset + 10, entity.angle, true);
    view.setUint16(offset + 12, entity.turret, true);
    view.setUint8(offset + 14, entity.hp);
    view.setUint8(offset + 15, entity.flags);
    offset += ENTITY_SIZE;
  }
  return bytes;
}

export function decodeKeyframe(data: Uint8Array): SnapshotKeyframe {
  const header = readHeader(data, FRAME_SNAPSHOT);
  if ((header.flags & FLAG_KEYFRAME) === 0 || (header.flags & FLAG_DELTA) !== 0) {
    throw new Error('快照帧不是关键帧');
  }
  if (data.byteLength < HEADER_SIZE + KEYFRAME_HEADER_SIZE) {
    throw new Error('关键帧长度不足，缺少实体数量');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint16(HEADER_SIZE, true);
  if (count > MAX_ENTITIES) throw new Error(`实体数量超过上限 ${MAX_ENTITIES}`);
  const expected = HEADER_SIZE + KEYFRAME_HEADER_SIZE + count * ENTITY_SIZE;
  assertSize(data, expected);
  const entities: EntitySnapshot[] = [];
  let offset = HEADER_SIZE + KEYFRAME_HEADER_SIZE;
  for (let index = 0; index < count; index += 1) {
    entities.push({
      id: view.getUint16(offset, true),
      x: view.getInt16(offset + 2, true),
      y: view.getInt16(offset + 4, true),
      vx: view.getInt16(offset + 6, true),
      vy: view.getInt16(offset + 8, true),
      angle: view.getUint16(offset + 10, true),
      turret: view.getUint16(offset + 12, true),
      hp: view.getUint8(offset + 14),
      flags: view.getUint8(offset + 15),
    });
    offset += ENTITY_SIZE;
  }
  return { seq: header.seq, tick: header.tick, entities };
}

function validateDeltaEntity(entity: EntityDelta): void {
  checkInt('id', entity.id, U16);
  checkInt('mask', entity.mask, { min: 0, max: DELTA_MASK_ALL });
  const fields: Array<[number, number | null]> = [
    [MASK_X, entity.x],
    [MASK_Y, entity.y],
    [MASK_VX, entity.vx],
    [MASK_VY, entity.vy],
    [MASK_ANGLE, entity.angle],
    [MASK_TURRET, entity.turret],
    [MASK_HP, entity.hp],
    [MASK_FLAGS, entity.flags],
  ];
  for (const [mask, value] of fields) {
    if ((entity.mask & mask) !== 0) {
      if (value === null) throw new Error(`mask 标记了字段 ${mask}，但值为空`);
    } else if (value !== null) {
      throw new Error(`mask 未标记字段 ${mask}，但值非空`);
    }
  }
  if (entity.x !== null) checkInt('x', entity.x, I16);
  if (entity.y !== null) checkInt('y', entity.y, I16);
  if (entity.vx !== null) checkInt('vx', entity.vx, I16);
  if (entity.vy !== null) checkInt('vy', entity.vy, I16);
  if (entity.angle !== null) checkInt('angle', entity.angle, U16);
  if (entity.turret !== null) checkInt('turret', entity.turret, U16);
  if (entity.hp !== null) checkInt('hp', entity.hp, U8);
  if (entity.flags !== null) checkInt('flags', entity.flags, U8);
}

export function encodeDelta(frame: SnapshotDelta): Uint8Array {
  if (frame.entities.length > MAX_ENTITIES) {
    throw new Error(`实体数量超过上限 ${MAX_ENTITIES}`);
  }
  checkInt('ackSeq', frame.ackSeq, U16);
  checkInt('baselineTick', frame.baselineTick, U32);
  let size = HEADER_SIZE + DELTA_HEADER_SIZE;
  for (const entity of frame.entities) {
    validateDeltaEntity(entity);
    size += DELTA_ENTITY_HEADER_SIZE;
    if (entity.mask & MASK_X) size += 2;
    if (entity.mask & MASK_Y) size += 2;
    if (entity.mask & MASK_VX) size += 2;
    if (entity.mask & MASK_VY) size += 2;
    if (entity.mask & MASK_ANGLE) size += 2;
    if (entity.mask & MASK_TURRET) size += 2;
    if (entity.mask & MASK_HP) size += 1;
    if (entity.mask & MASK_FLAGS) size += 1;
  }
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  writeHeader(view, FRAME_SNAPSHOT, FLAG_DELTA, frame.seq, frame.tick);
  view.setUint16(HEADER_SIZE, frame.ackSeq, true);
  view.setUint32(HEADER_SIZE + 2, frame.baselineTick, true);
  view.setUint16(HEADER_SIZE + 6, frame.entities.length, true);
  let offset = HEADER_SIZE + DELTA_HEADER_SIZE;
  for (const entity of frame.entities) {
    view.setUint16(offset, entity.id, true);
    view.setUint8(offset + 2, entity.mask);
    offset += DELTA_ENTITY_HEADER_SIZE;
    if (entity.mask & MASK_X) {
      view.setInt16(offset, entity.x as number, true);
      offset += 2;
    }
    if (entity.mask & MASK_Y) {
      view.setInt16(offset, entity.y as number, true);
      offset += 2;
    }
    if (entity.mask & MASK_VX) {
      view.setInt16(offset, entity.vx as number, true);
      offset += 2;
    }
    if (entity.mask & MASK_VY) {
      view.setInt16(offset, entity.vy as number, true);
      offset += 2;
    }
    if (entity.mask & MASK_ANGLE) {
      view.setUint16(offset, entity.angle as number, true);
      offset += 2;
    }
    if (entity.mask & MASK_TURRET) {
      view.setUint16(offset, entity.turret as number, true);
      offset += 2;
    }
    if (entity.mask & MASK_HP) {
      view.setUint8(offset, entity.hp as number);
      offset += 1;
    }
    if (entity.mask & MASK_FLAGS) {
      view.setUint8(offset, entity.flags as number);
      offset += 1;
    }
  }
  return bytes;
}

export function decodeDelta(data: Uint8Array): SnapshotDelta {
  const header = readHeader(data, FRAME_SNAPSHOT);
  if ((header.flags & FLAG_DELTA) === 0) throw new Error('快照帧不是增量帧');
  if (data.byteLength < HEADER_SIZE + DELTA_HEADER_SIZE) {
    throw new Error('增量帧长度不足，缺少头信息');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ackSeq = view.getUint16(HEADER_SIZE, true);
  const baselineTick = view.getUint32(HEADER_SIZE + 2, true);
  const count = view.getUint16(HEADER_SIZE + 6, true);
  if (count > MAX_ENTITIES) throw new Error(`实体数量超过上限 ${MAX_ENTITIES}`);
  let offset = HEADER_SIZE + DELTA_HEADER_SIZE;
  const entities: EntityDelta[] = [];
  for (let index = 0; index < count; index += 1) {
    if (data.byteLength < offset + DELTA_ENTITY_HEADER_SIZE) {
      throw new Error('增量帧被截断，缺少实体头');
    }
    const id = view.getUint16(offset, true);
    const mask = view.getUint8(offset + 2);
    offset += DELTA_ENTITY_HEADER_SIZE;
    if ((mask & ~DELTA_MASK_ALL) !== 0) {
      throw new Error(`未知的字段 mask：${mask}`);
    }
    const entity: EntityDelta = {
      id,
      mask,
      x: null,
      y: null,
      vx: null,
      vy: null,
      angle: null,
      turret: null,
      hp: null,
      flags: null,
    };
    if (mask & MASK_X) {
      requireBytes(data, offset, 2, 'x');
      entity.x = view.getInt16(offset, true);
      offset += 2;
    }
    if (mask & MASK_Y) {
      requireBytes(data, offset, 2, 'y');
      entity.y = view.getInt16(offset, true);
      offset += 2;
    }
    if (mask & MASK_VX) {
      requireBytes(data, offset, 2, 'vx');
      entity.vx = view.getInt16(offset, true);
      offset += 2;
    }
    if (mask & MASK_VY) {
      requireBytes(data, offset, 2, 'vy');
      entity.vy = view.getInt16(offset, true);
      offset += 2;
    }
    if (mask & MASK_ANGLE) {
      requireBytes(data, offset, 2, 'angle');
      entity.angle = view.getUint16(offset, true);
      offset += 2;
    }
    if (mask & MASK_TURRET) {
      requireBytes(data, offset, 2, 'turret');
      entity.turret = view.getUint16(offset, true);
      offset += 2;
    }
    if (mask & MASK_HP) {
      requireBytes(data, offset, 1, 'hp');
      entity.hp = view.getUint8(offset);
      offset += 1;
    }
    if (mask & MASK_FLAGS) {
      requireBytes(data, offset, 1, 'flags');
      entity.flags = view.getUint8(offset);
      offset += 1;
    }
    entities.push(entity);
  }
  if (offset !== data.byteLength) throw new Error('增量帧存在多余字节');
  return { seq: header.seq, tick: header.tick, ackSeq, baselineTick, entities };
}

function requireBytes(data: Uint8Array, offset: number, size: number, field: string): void {
  if (data.byteLength < offset + size) {
    throw new Error(`增量帧被截断，缺少字段 ${field}`);
  }
}

/** 弧度 → u16（0–2π 映射 0–65535），与后端 angle_to_u16 一致。 */
export function angleToU16(radians: number): number {
  if (!Number.isFinite(radians)) throw new Error('角度必须是有限数值');
  const normalized = ((radians % TAU) + TAU) % TAU;
  return Math.round((normalized / TAU) * 0xffff) & 0xffff;
}

/** u16 → 弧度，与后端 u16_to_angle 一致。 */
export function u16ToAngle(value: number): number {
  checkInt('angle', value, U16);
  return (value / 0xffff) * TAU;
}

/** 世界单位 → 0.01 定点（范围由调用方保证）。 */
export function toFixed(value: number): number {
  if (!Number.isFinite(value)) throw new Error('坐标必须是有限数值');
  return Math.round(value * FIXED_SCALE);
}

/** 0.01 定点 → 世界单位。 */
export function fromFixed(raw: number): number {
  return raw / FIXED_SCALE;
}

export function decodeSnapshot(data: Uint8Array): SnapshotFrame {
  if (data.byteLength < HEADER_SIZE) throw new Error('帧长度不足，缺少通用头');
  const type = data[0];
  if (type !== FRAME_SNAPSHOT) throw new Error('不是快照帧');
  const flags = data[1];
  if ((flags & FLAG_KEYFRAME) !== 0) return decodeKeyframe(data);
  if ((flags & FLAG_DELTA) !== 0) return decodeDelta(data);
  throw new Error('快照帧必须标记关键帧或增量');
}
