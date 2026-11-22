/**
 * 快照缓冲与渲染位置生成。
 *
 * 网络策略（v1，见 docs/TANK.md §6）：服务端 20Hz 关键帧；远端坦克按 100ms 缓冲
 * 插值，子弹与自己按最新快照外推，再统一做指数平滑，避免 20Hz 抖动。
 */
import type { TankEntity, TankSnapshotFrame } from './protocol';
import { BULLET_KIND } from './protocol';

interface Sample {
  recvAt: number;
  tick: number;
  byId: Map<number, TankEntity>;
}

/** 远端坦克插值延迟：略大于一个 tick 周期，容忍网络抖动。 */
const INTERP_MS = 110;
/** 外推上限，避免长时间无快照时坦克「飞出去」。 */
const MAX_EXTRAPOLATE_MS = 250;
/** 平滑速度（每秒趋近比例）。 */
const SMOOTH_RATE = 14;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

export class TankSnapshotBuffer {
  private samples: Sample[] = [];
  private smoothed = new Map<number, { x: number; y: number; hull: number; turret: number }>();
  private lastNow = 0;

  push(frame: TankSnapshotFrame, now: number): void {
    const byId = new Map<number, TankEntity>();
    for (const entity of frame.entities) byId.set(entity.id, entity);
    this.samples.push({ recvAt: now, tick: frame.tick, byId });
    if (this.samples.length > 40) this.samples.splice(0, this.samples.length - 40);
  }

  clear(): void {
    this.samples = [];
    this.smoothed.clear();
  }

  get latestTick(): number {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1].tick : 0;
  }

  get hasData(): boolean {
    return this.samples.length > 0;
  }

  /** 生成这一帧要交给渲染器的实体列表。 */
  view(now: number, localId: number | null): TankEntity[] {
    const latest = this.samples[this.samples.length - 1];
    if (!latest) return [];
    const dt = this.lastNow === 0 ? 0.016 : Math.min(0.1, (now - this.lastNow) / 1000);
    this.lastNow = now;
    const smooth = 1 - Math.exp(-SMOOTH_RATE * dt);

    const renderAt = now - INTERP_MS;
    const result: TankEntity[] = [];
    const seen = new Set<number>();

    for (const [id, newest] of latest.byId) {
      const isLocal = id === localId;
      const isBullet = newest.kind === BULLET_KIND;
      let target: TankEntity = newest;

      if (isLocal || isBullet) {
        // 自己与子弹：用最新快照 + 速度外推，减少操作与弹道的迟滞感。
        const elapsed = Math.min(now - latest.recvAt, MAX_EXTRAPOLATE_MS) / 1000;
        target = {
          ...newest,
          x: newest.x + newest.vx * elapsed,
          y: newest.y + newest.vy * elapsed,
        };
      } else {
        const pair = this.findPair(renderAt);
        if (pair) {
          const [before, after, alpha] = pair;
          const from = before.byId.get(id);
          const to = after.byId.get(id);
          if (from && to) {
            target = {
              ...to,
              x: lerp(from.x, to.x, alpha),
              y: lerp(from.y, to.y, alpha),
              vx: lerp(from.vx, to.vx, alpha),
              vy: lerp(from.vy, to.vy, alpha),
              hull: lerpAngle(from.hull, to.hull, alpha),
              turret: lerpAngle(from.turret, to.turret, alpha),
            };
          }
        }
      }

      const previous = this.smoothed.get(id);
      if (!previous || isBullet) {
        this.smoothed.set(id, {
          x: target.x,
          y: target.y,
          hull: target.hull,
          turret: target.turret,
        });
        result.push(target);
      } else {
        const x = lerp(previous.x, target.x, smooth);
        const y = lerp(previous.y, target.y, smooth);
        const hull = lerpAngle(previous.hull, target.hull, smooth);
        const turret = lerpAngle(previous.turret, target.turret, smooth);
        this.smoothed.set(id, { x, y, hull, turret });
        result.push({ ...target, x, y, hull, turret });
      }
      seen.add(id);
    }

    // 清理已消失实体的平滑缓存，避免复活后瞬移残留。
    for (const id of [...this.smoothed.keys()]) {
      if (!seen.has(id)) this.smoothed.delete(id);
    }
    return result;
  }

  private findPair(renderAt: number): [Sample, Sample, number] | null {
    for (let index = this.samples.length - 1; index > 0; index -= 1) {
      const after = this.samples[index];
      const before = this.samples[index - 1];
      if (after.recvAt >= renderAt && before.recvAt <= renderAt) {
        const span = after.recvAt - before.recvAt;
        const alpha = span > 0 ? (renderAt - before.recvAt) / span : 1;
        return [before, after, Math.min(1, Math.max(0, alpha))];
      }
    }
    return null;
  }
}
