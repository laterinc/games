/**
 * 坦克输入采集：键盘持续位 + 鼠标瞄准角。
 *
 * 位定义与 server/app/realtime/codec.py 完全一致：
 * 上=前进、下=倒车、左/右=车体转向、空格/左键=开火、Shift=刹车。
 */
import {
  INPUT_BRAKE,
  INPUT_DOWN,
  INPUT_FIRE,
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_UP,
} from '../../lib/realtime/codec';

const KEY_ACTIONS: Record<string, 'up' | 'down' | 'left' | 'right' | 'brake'> = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  ShiftLeft: 'brake',
  ShiftRight: 'brake',
};

const FIRE_KEYS = new Set(['Space']);

export class TankInputState {
  private readonly dirs = { up: false, down: false, left: false, right: false };
  private firing = false;
  private braking = false;

  /** 当前按键位（发给服务端）：注意 A/D 的视觉方向修正。 */
  flags(): number {
    let flags = 0;
    if (this.dirs.up) flags |= INPUT_UP;
    if (this.dirs.down) flags |= INPUT_DOWN;
    // 服务端 INPUT_LEFT 是"世界角增大"，在第三人称视角里看起来是右转，
    // 所以物理 A（向左）发送 INPUT_RIGHT，D 发送 INPUT_LEFT，保证视觉方向正确。
    if (this.dirs.left) flags |= INPUT_RIGHT;
    if (this.dirs.right) flags |= INPUT_LEFT;
    if (this.firing) flags |= INPUT_FIRE;
    if (this.braking) flags |= INPUT_BRAKE;
    return flags;
  }

  /** 原始意图（街机式操作需要方向分离，用物理方向而不是位域）。 */
  intent(): {
    up: boolean;
    down: boolean;
    left: boolean;
    right: boolean;
    fire: boolean;
    brake: boolean;
  } {
    return {
      up: this.dirs.up,
      down: this.dirs.down,
      left: this.dirs.left,
      right: this.dirs.right,
      fire: this.firing,
      brake: this.braking,
    };
  }

  pressKey(code: string): void {
    if (FIRE_KEYS.has(code)) {
      this.firing = true;
      return;
    }
    const action = KEY_ACTIONS[code];
    if (action === undefined) return;
    if (action === 'brake') this.braking = true;
    else this.dirs[action] = true;
  }

  releaseKey(code: string): void {
    if (FIRE_KEYS.has(code)) {
      this.firing = false;
      return;
    }
    const action = KEY_ACTIONS[code];
    if (action === undefined) return;
    if (action === 'brake') this.braking = false;
    else this.dirs[action] = false;
  }

  setPointerFiring(firing: boolean): void {
    this.firing = firing;
  }

  setBrakeLatched(latched: boolean): void {
    this.braking = latched;
  }

  /** 有输入变化时提示页面是否需要阻止默认行为（空格/方向键滚动）。 */
  static shouldPreventDefault(code: string): boolean {
    return code in KEY_ACTIONS || FIRE_KEYS.has(code);
  }

  reset(): void {
    this.dirs.up = false;
    this.dirs.down = false;
    this.dirs.left = false;
    this.dirs.right = false;
    this.firing = false;
    this.braking = false;
  }
}
