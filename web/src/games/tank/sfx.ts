/**
 * 坦克大战合成音效（WebAudio，无音频资源）。
 *
 * 与棋类音效共用静音开关（lib/sound.ts 的 localStorage 键），但独立维护自己的
 * AudioContext 与节点图：引擎声是持续的振荡器，必须能随车速连续变化、在死亡/离开时停掉。
 *
 * 全部音量都很克制（引擎约 0.05，爆炸峰值约 0.3），避免多人对战时吵。
 */
import { isSoundEnabled } from '../../lib/sound';

const MASTER_VOLUME = 0.5;

type Ctor = typeof AudioContext;

function audioContextCtor(): Ctor | null {
  if (typeof window === 'undefined') return null;
  const ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
  return ctor ?? null;
}

export class TankSfx {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private engine: {
    oscA: OscillatorNode;
    oscB: OscillatorNode;
    filter: BiquadFilterNode;
    gain: GainNode;
  } | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private disposed = false;

  /** 懒创建音频图；首帧通常发生在用户点击「准备」之后，可安全 resume。 */
  private ensure(): AudioContext | null {
    if (this.disposed || !isSoundEnabled()) return null;
    if (this.context) {
      if (this.context.state === 'suspended') void this.context.resume();
      return this.context;
    }
    const ctor = audioContextCtor();
    if (!ctor) return null;
    try {
      const context = new ctor();
      const master = context.createGain();
      master.gain.value = MASTER_VOLUME;
      master.connect(context.destination);
      this.context = context;
      this.master = master;
      this.noiseBuffer = this.buildNoise(context);
      return context;
    } catch {
      return null;
    }
  }

  private buildNoise(context: AudioContext): AudioBuffer {
    const length = Math.floor(context.sampleRate * 1.2);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 0x1234abcd;
    for (let index = 0; index < length; index += 1) {
      // 简单 LCG 白噪声，避免依赖 Math.random 造成每次波形不同
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[index] = (seed / 0xffffffff) * 2 - 1;
    }
    return buffer;
  }

  /* ------------------------------ 引擎声 ------------------------------ */

  startEngine(): void {
    const context = this.ensure();
    if (!context || !this.master || this.engine) return;
    try {
      const oscA = context.createOscillator();
      oscA.type = 'sawtooth';
      oscA.frequency.value = 42;
      const oscB = context.createOscillator();
      oscB.type = 'square';
      oscB.frequency.value = 63;
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 320;
      filter.Q.value = 0.8;
      const gain = context.createGain();
      gain.gain.value = 0;
      oscA.connect(filter);
      oscB.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      oscA.start();
      oscB.start();
      this.engine = { oscA, oscB, filter, gain };
    } catch {
      this.engine = null;
    }
  }

  /** speedRatio: 0（静止）–1（全速）；alive=false 时静音。10Hz 调用即可。 */
  setEngine(speedRatio: number, alive: boolean): void {
    const context = this.context;
    const engine = this.engine;
    if (!context || !engine) return;
    const now = context.currentTime;
    const speed = Math.max(0, Math.min(1, speedRatio));
    const targetGain = alive ? 0.035 + speed * 0.05 : 0;
    engine.gain.gain.setTargetAtTime(targetGain, now, 0.12);
    engine.oscA.frequency.setTargetAtTime(42 + speed * 26, now, 0.15);
    engine.oscB.frequency.setTargetAtTime(63 + speed * 34, now, 0.15);
    engine.filter.frequency.setTargetAtTime(300 + speed * 380, now, 0.15);
  }

  stopEngine(): void {
    const engine = this.engine;
    if (!engine) return;
    this.engine = null;
    const context = this.context;
    if (context) {
      engine.gain.gain.setTargetAtTime(0, context.currentTime, 0.05);
    }
    try {
      engine.oscA.stop(context ? context.currentTime + 0.3 : 0);
      engine.oscB.stop(context ? context.currentTime + 0.3 : 0);
    } catch {
      /* 已停止 */
    }
  }

  /* ------------------------------ 一次性音效 ------------------------------ */

  /** 炮声：低频冲击 + 噪声爆破。 */
  fire(): void {
    const context = this.ensure();
    if (!context || !this.master) return;
    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
    gain.connect(this.master);

    const thump = context.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(110, now);
    thump.frequency.exponentialRampToValueAtTime(38, now + 0.25);
    thump.connect(gain);
    thump.start(now);
    thump.stop(now + 0.34);

    const noise = this.noiseSource(context);
    if (noise) {
      const noiseGain = context.createGain();
      noiseGain.gain.setValueAtTime(0.16, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      const lowpass = context.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.setValueAtTime(1800, now);
      lowpass.frequency.exponentialRampToValueAtTime(240, now + 0.2);
      noise.connect(lowpass);
      lowpass.connect(noiseGain);
      noiseGain.connect(this.master);
      noise.start(now);
      noise.stop(now + 0.24);
    }
  }

  /** 命中：金属叮 + 短噪声。 */
  hit(volume = 1): void {
    const context = this.ensure();
    if (!context || !this.master) return;
    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.12 * volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    gain.connect(this.master);
    const tone = context.createOscillator();
    tone.type = 'square';
    tone.frequency.setValueAtTime(1250, now);
    tone.frequency.exponentialRampToValueAtTime(720, now + 0.12);
    tone.connect(gain);
    tone.start(now);
    tone.stop(now + 0.17);

    const noise = this.noiseSource(context);
    if (noise) {
      const noiseGain = context.createGain();
      noiseGain.gain.setValueAtTime(0.08 * volume, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
      const bandpass = context.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 2600;
      noise.connect(bandpass);
      bandpass.connect(noiseGain);
      noiseGain.connect(this.master);
      noise.start(now);
      noise.stop(now + 0.12);
    }
  }

  /** 爆炸：噪声下扫 + 次低音，volume 由距离衰减。 */
  explosion(volume = 1): void {
    const context = this.ensure();
    if (!context || !this.master) return;
    const level = Math.max(0.12, Math.min(1, volume));
    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.3 * level, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
    gain.connect(this.master);

    const boom = context.createOscillator();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(70, now);
    boom.frequency.exponentialRampToValueAtTime(24, now + 0.7);
    boom.connect(gain);
    boom.start(now);
    boom.stop(now + 0.95);

    const noise = this.noiseSource(context);
    if (noise) {
      const noiseGain = context.createGain();
      noiseGain.gain.setValueAtTime(0.22 * level, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
      const lowpass = context.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.setValueAtTime(1400, now);
      lowpass.frequency.exponentialRampToValueAtTime(120, now + 0.7);
      noise.connect(lowpass);
      lowpass.connect(noiseGain);
      noiseGain.connect(this.master);
      noise.start(now);
      noise.stop(now + 0.85);
    }
  }

  /** 装填完成：轻微机械咔哒。 */
  reloadReady(): void {
    const context = this.ensure();
    if (!context || !this.master) return;
    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.05, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    gain.connect(this.master);
    const tone = context.createOscillator();
    tone.type = 'triangle';
    tone.frequency.setValueAtTime(880, now);
    tone.connect(gain);
    tone.start(now);
    tone.stop(now + 0.08);
  }

  private noiseSource(context: AudioContext): AudioBufferSourceNode | null {
    if (!this.noiseBuffer) return null;
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    return source;
  }

  dispose(): void {
    this.stopEngine();
    const context = this.context;
    this.context = null;
    this.master = null;
    this.noiseBuffer = null;
    this.disposed = true;
    if (context) {
      try {
        void context.close();
      } catch {
        /* 已关闭 */
      }
    }
  }
}
