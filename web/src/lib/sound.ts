/**
 * 极简合成音效（WebAudio，无音频资源）：
 * - 落子：短促的木质/玻璃「哒」声（黑棋低沉、白棋清脆）
 * - 获胜 / 失败 / 和棋：短琶音
 * 静音状态持久化在 localStorage；浏览器自动播放策略要求首次交互后才能出声。
 */

const STORAGE_KEY = 'games.sound.enabled.v1';

let context: AudioContext | null = null;
let enabled = loadEnabled();

function loadEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function saveEnabled(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    /* 隐私模式下忽略 */
  }
}

function ensureContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (context !== null) return context;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    context = null;
  }
  return context;
}

/** 首次用户手势时调用，解除浏览器自动播放限制。 */
export function unlockAudio(): void {
  const ctx = ensureContext();
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume();
  }
}

export function isSoundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(value: boolean): void {
  enabled = value;
  saveEnabled(value);
  if (value) unlockAudio();
}

function tone(
  ctx: AudioContext,
  options: {
    freq: number;
    start: number;
    duration: number;
    gain: number;
    type?: OscillatorType;
  },
): void {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = options.type ?? 'sine';
  osc.frequency.setValueAtTime(options.freq, options.start);
  amp.gain.setValueAtTime(0.0001, options.start);
  amp.gain.exponentialRampToValueAtTime(options.gain, options.start + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, options.start + options.duration);
  osc.connect(amp).connect(ctx.destination);
  osc.start(options.start);
  osc.stop(options.start + options.duration + 0.02);
}

function noiseClick(ctx: AudioContext, start: number, duration: number, gain: number): void {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) {
    // 指数衰减的白噪声，更接近棋子落盘的短促摩擦声
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (frames * 0.16));
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(2200, start);
  filter.Q.setValueAtTime(0.9, start);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(gain, start);
  source.connect(filter).connect(amp).connect(ctx.destination);
  source.start(start);
}

function playNotes(notes: number[], step: number, duration: number, gain: number): void {
  const ctx = ensureContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();
  const start = ctx.currentTime + 0.02;
  notes.forEach((freq, index) => {
    tone(ctx, { freq, start: start + index * step, duration, gain, type: 'triangle' });
    tone(ctx, { freq: freq * 2, start: start + index * step, duration: duration * 0.6, gain: gain * 0.25 });
  });
}

export function playStoneSound(color: 'black' | 'white' | 'red'): void {
  if (!enabled) return;
  const ctx = ensureContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();
  const start = ctx.currentTime + 0.005;
  const base = color === 'black' ? 196 : color === 'red' ? 233.1 : 261.6;
  noiseClick(ctx, start, 0.055, 0.09);
  tone(ctx, { freq: base, start, duration: 0.11, gain: 0.075, type: 'sine' });
  tone(ctx, { freq: base * 2.05, start: start + 0.004, duration: 0.07, gain: 0.03, type: 'triangle' });
}

export function playResultSound(outcome: 'win' | 'loss' | 'draw'): void {
  if (!enabled) return;
  if (outcome === 'win') {
    playNotes([523.25, 659.25, 783.99, 1046.5], 0.105, 0.42, 0.06);
  } else if (outcome === 'loss') {
    playNotes([392, 329.63, 261.63], 0.13, 0.4, 0.05);
  } else {
    playNotes([440, 440], 0.15, 0.32, 0.05);
  }
}
