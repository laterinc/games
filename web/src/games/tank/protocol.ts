/**
 * 坦克大战的帧级协议：二进制快照 → 渲染用实体，输入态 → 二进制输入帧。
 *
 * 帧格式与领域字段见 docs/TANK.md §3；编解码完全复用 lib/realtime/codec，
 * 这里只负责「位域拆包」与「定点/角度换算」，不重复实现字节布局。
 */
import {
  angleToU16,
  decodeSnapshot,
  encodeInput,
  fromFixed,
  u16ToAngle,
  type EntitySnapshot,
} from '../../lib/realtime/codec';

/** 实体 flags 位域（与 server/app/realtime/engine.py 保持一致）。 */
const FLAG_KIND_BULLET = 1;
const SHIFT_OWNER = 2;
const BIT_SHIELDED = 1 << 6;

export const TANK_KIND = 0;
export const BULLET_KIND = 1;

/** 解码后的实体，单位是世界单位与弧度。 */
export interface TankEntity {
  id: number;
  kind: typeof TANK_KIND | typeof BULLET_KIND;
  ownerSlot: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hull: number;
  turret: number;
  hp: number;
  shielded: boolean;
  alive: boolean;
}

export interface TankSnapshotFrame {
  tick: number;
  entities: TankEntity[];
}

function decodeEntity(entity: EntitySnapshot): TankEntity {
  const flags = entity.flags;
  const kind = (flags & 0x03) === FLAG_KIND_BULLET ? BULLET_KIND : TANK_KIND;
  return {
    id: entity.id,
    kind,
    ownerSlot: (flags >> SHIFT_OWNER) & 0x07,
    x: fromFixed(entity.x),
    y: fromFixed(entity.y),
    vx: fromFixed(entity.vx),
    vy: fromFixed(entity.vy),
    hull: u16ToAngle(entity.angle),
    turret: u16ToAngle(entity.turret),
    hp: entity.hp,
    shielded: (flags & BIT_SHIELDED) !== 0,
    alive: (flags & (1 << 5)) !== 0,
  };
}

/** 解码服务端快照帧；增量帧暂不支持（v1 服务端只发关键帧）。 */
export function decodeTankFrame(buffer: ArrayBuffer): TankSnapshotFrame | null {
  try {
    const frame = decodeSnapshot(new Uint8Array(buffer));
    if ('baselineTick' in frame) return null;
    return { tick: frame.tick, entities: frame.entities.map(decodeEntity) };
  } catch {
    return null;
  }
}

/** 编码一帧客户端输入（flags 见 codec.INPUT_*，aim 为炮塔世界角度）。 */
export function encodeTankInput(
  seq: number,
  tick: number,
  flags: number,
  aimRadians: number,
): ArrayBuffer {
  const bytes = encodeInput({
    seq: seq & 0xffff,
    tick: tick >>> 0,
    inputFlags: flags & 0x3f,
    aim: angleToU16(aimRadians),
  });
  // encodeInput 总是新分配一个 Uint8Array，buffer 从 0 开始。
  return bytes.buffer as ArrayBuffer;
}

/** 把 0..65535 的 seq 自增回绕。 */
export function nextSeq(seq: number): number {
  return (seq + 1) & 0xffff;
}
