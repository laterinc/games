/**
 * 坦克大战对局页：全屏 three.js 画布 + React HUD。
 *
 * 操作模型（商业坦克游戏手感）：
 *   - 点击画面锁定鼠标，鼠标直接转动视角（相机 yaw/pitch，360° 连续、零平滑）；
 *   - 炮塔角 = 相机视线角，准星固定在屏幕中心；
 *   - WASD 控制车体（坦克式 / 街机式可切），左键开火，滚轮缩放；
 *   - Alt 释放鼠标（系统光标出现）用于点击 HUD，再按 Alt / 点击画面重新锁定。
 *
 * 数据流：控制面走 JSON（room 快照），实时数据走 20Hz 二进制关键帧；
 * TankSnapshotBuffer 负责插值/外推/平滑，向上 20Hz 发送输入帧。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, Room, TankEvent, TankGame } from '../../types';
import type { GameSocket, SocketStatus } from '../../lib/socket';
import { copyText } from '../../lib/clipboard';
import { isSoundEnabled, playResultSound, setSoundEnabled } from '../../lib/sound';
import { roomPath } from '../../lib/router';
import { ChatPanel } from '../../components/ChatPanel';
import { TankHud, type KillFeedItem, type TankHudState } from './TankHud';
import { TankInputState } from './input';
import { TankSnapshotBuffer } from './net';
import { decodeTankFrame, encodeTankInput, nextSeq, type TankEntity } from './protocol';
import type { SceneEntityView, TankCameraMode, TankScene } from './scene';
import { TANK_COLORS } from './palette';
import {
  INPUT_BRAKE,
  INPUT_FIRE,
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_UP,
} from '../../lib/realtime/codec';
import { TankSfx } from './sfx';

interface TankRoomProps {
  room: Room;
  socket: GameSocket;
  status: SocketStatus;
  playerId: string | null;
  isSpectator: boolean;
  chat: ChatMessage[];
  onReady: () => void;
  onRematch: () => void;
  onLeave: () => void;
  onChat: (text: string) => void;
  notify: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
}

/** 第三人称相机 API（场景侧提供，用于鼠标转视角）。 */
type CameraApi = {
  setCameraYaw?: (yaw: number, pitch?: number) => void;
  getCameraPitch?: () => number;
  groundPointFromScreen?: (nx: number, ny: number) => { x: number; y: number } | null;
  worldToScreen?: (x: number, y: number) => { x: number; y: number };
  setAimDirection?: (
    angle: number | null,
    point?: { x: number; y: number } | null,
  ) => void;
};

const FIRE_COOLDOWN_MS = 900;
const HUD_INTERVAL_MS = 100;
/** 鼠标灵敏度：每像素转多少弧度。 */
/** 虚拟准星的鼠标灵敏度（NDC / 像素）。 */
const RETICLE_SENSITIVITY = 1.0;
const PITCH_BY_MODE: Record<'chase' | 'iso' | 'top', number> = {
  chase: (38 * Math.PI) / 180,
  iso: (57 * Math.PI) / 180,
  top: (57 * Math.PI) / 180,
};

const CONTROL_STORAGE_KEY = 'games.tank.control.v1';
/** 相机循环顺序：追尾（默认）→ 等距 → 全场。 */
const CAMERA_SEQUENCE: readonly TankCameraMode[] = ['chase', 'iso', 'top'];

export type ControlMode = 'tank' | 'arcade';

const EMPTY_HUD: TankHudState = {
  hp: 100,
  alive: false,
  reload: 1,
  timeLeft: 0,
  scores: {},
  feed: [],
  cameraMode: 'chase',
  tickRate: 20,
  blips: [],
  hitAt: 0,
  deadFor: 0,
};

function loadControlMode(): ControlMode {
  try {
    // 旧版本存过 'follow'（车体跟随鼠标），现在统一回落到坦克式，避免车体自己旋转。
    return window.localStorage.getItem(CONTROL_STORAGE_KEY) === 'arcade' ? 'arcade' : 'tank';
  } catch {
    return 'tank';
  }
}

function wrapAngle(angle: number): number {
  let value = angle % (Math.PI * 2);
  if (value > Math.PI) value -= Math.PI * 2;
  if (value <= -Math.PI) value += Math.PI * 2;
  return value;
}

/** 街机式操作：WASD 按屏幕方向移动，换算成车体转向 + 油门位。 */
function arcadeFlags(
  cameraYaw: number,
  intent: ReturnType<TankInputState['intent']>,
  hull: number,
): number {
  const forwardX = Math.cos(cameraYaw);
  const forwardY = Math.sin(cameraYaw);
  const rightX = -forwardY;
  const rightY = forwardX;
  let moveX = 0;
  let moveY = 0;
  if (intent.up) {
    moveX += forwardX;
    moveY += forwardY;
  }
  if (intent.down) {
    moveX -= forwardX;
    moveY -= forwardY;
  }
  if (intent.right) {
    moveX += rightX;
    moveY += rightY;
  }
  if (intent.left) {
    moveX -= rightX;
    moveY -= rightY;
  }
  let flags = 0;
  if (intent.fire) flags |= INPUT_FIRE;
  if (intent.brake) flags |= INPUT_BRAKE;
  if (moveX * moveX + moveY * moveY < 1e-6) return flags;
  const desired = Math.atan2(moveY, moveX);
  const diff = wrapAngle(desired - hull);
  if (Math.abs(diff) > 0.12) flags |= diff > 0 ? INPUT_LEFT : INPUT_RIGHT;
  if (Math.abs(diff) < 0.95) flags |= INPUT_UP;
  return flags;
}

function emptyScores(game: TankGame): Record<string, { kills: number; deaths: number }> {
  const scores: Record<string, { kills: number; deaths: number }> = {};
  for (const player of Object.keys(game.scores)) {
    const score = game.scores[player];
    scores[player] = { kills: score.kills, deaths: score.deaths };
  }
  return scores;
}

/** 事件距离本地坦克越近声音越大。 */
function proximityVolume(x: number, y: number, local: { x: number; y: number } | null): number {
  if (!local) return 0.4;
  const distance = Math.hypot(x - local.x, y - local.y);
  return Math.max(0.12, 1 - Math.min(1, distance / 34));
}

function describeResult(
  game: TankGame,
  hud: TankHudState,
  nameOf: (id: string | undefined) => string,
): string {
  if (game.endedReason === 'forfeit') return '对手已离开，本局按弃权结算';
  if (game.winnerId) {
    const kills = hud.scores[game.winnerId]?.kills ?? game.scores[game.winnerId]?.kills ?? 0;
    const reason = game.endedReason === 'kills' ? '先达击杀目标' : '时间到，击杀数领先';
    return `${nameOf(game.winnerId)} ${reason}，以 ${kills} 杀获胜`;
  }
  return '平分秋色';
}

export function TankRoom({
  room,
  socket,
  status,
  playerId,
  isSpectator,
  chat,
  onReady,
  onRematch,
  onLeave,
  onChat,
  notify,
}: TankRoomProps) {
  const game = room.game as TankGame;
  const phase = game.phase;
  const me = room.players.find((player) => player.id === playerId) ?? null;
  const localSlot = me?.slot ?? null;
  const localEntityId = localSlot !== null && localSlot !== undefined ? localSlot + 1 : null;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<TankScene | null>(null);
  const bufferRef = useRef<TankSnapshotBuffer>(new TankSnapshotBuffer());
  const inputRef = useRef<TankInputState>(new TankInputState());
  const aimRef = useRef(0);
  const reticleRef = useRef({ x: 0, y: 0 });
  const lookYawRef = useRef(0);
  const lookPitchRef = useRef(PITCH_BY_MODE.chase);
  const seqRef = useRef(1);
  const scoresRef = useRef<Record<string, { kills: number; deaths: number }>>(emptyScores(game));
  const feedRef = useRef<KillFeedItem[]>([]);
  const feedSeqRef = useRef(0);
  const lastShotRef = useRef(-Infinity);
  const hudAtRef = useRef(0);
  const hitAtRef = useRef(0);
  const prevHpRef = useRef<number | null>(null);
  const prevReloadRef = useRef(1);
  const deadSinceRef = useRef<number | null>(null);
  const localPosRef = useRef<{ x: number; y: number } | null>(null);
  const localHullRef = useRef(0);
  const crosshairRef = useRef<HTMLDivElement | null>(null);
  const hoveredHudRef = useRef<HTMLElement | null>(null);
  const feedbackSeqRef = useRef(0);
  const shakeTimerRef = useRef<number | null>(null);
  const sfxRef = useRef<TankSfx | null>(null);
  const cameraModeRef = useRef<TankCameraMode>('chase');
  const cameraTurnRef = useRef(0);
  const controlModeRef = useRef<ControlMode>('tank');
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const phaseRef = useRef(phase);

  const [hud, setHud] = useState<TankHudState>(EMPTY_HUD);
  const [cameraMode, setCameraMode] = useState<TankCameraMode>('chase');
  const [controlMode, setControlMode] = useState<ControlMode>(loadControlMode);
  const [sceneReady, setSceneReady] = useState(false);
  const [damagePopup, setDamagePopup] = useState<{ id: number; text: string } | null>(null);
  const [shake, setShake] = useState(false);
  const [pointerLocked, setPointerLocked] = useState(false);
  const [soundOn, setSoundOn] = useState(() => isSoundEnabled());

  const mapSignature = useMemo(() => {
    const map = game.map;
    if (!map) return '';
    return `${map.width}x${map.height}:${map.obstacles.length}:${map.spawns.length}`;
  }, [game.map]);

  /* ------------------------------ 准星位置 ------------------------------ */

  const updateCrosshairPosition = useCallback(() => {
    const canvas = canvasRef.current;
    const crosshair = crosshairRef.current;
    if (!canvas || !crosshair) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // 准星跟随鼠标虚拟光标（可移动、距离随光标位置变化）
    const px = (reticleRef.current.x * 0.5 + 0.5) * rect.width;
    const py = (-reticleRef.current.y * 0.5 + 0.5) * rect.height;
    crosshair.style.transform = `translate3d(${px}px, ${py}px, 0)`;
  }, []);

  /** 受击反馈：屏震 + 掉血数字（本地玩家被命中/被击毁时触发）。 */
  const triggerHitFeedback = useCallback((text: string) => {
    feedbackSeqRef.current += 1;
    setDamagePopup({ id: feedbackSeqRef.current, text });
    setShake(true);
    if (shakeTimerRef.current !== null) window.clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = window.setTimeout(() => {
      setShake(false);
      shakeTimerRef.current = null;
    }, 380);
  }, []);

  useEffect(
    () => () => {
      if (shakeTimerRef.current !== null) window.clearTimeout(shakeTimerRef.current);
    },
    [],
  );

  /** 指针锁定时的虚拟光标命中测试：准星移到 HUD 按钮上可直接点击。 */
  const hudTargetAt = useCallback((): HTMLElement | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = rect.left + (reticleRef.current.x * 0.5 + 0.5) * rect.width;
    const py = rect.top + (-reticleRef.current.y * 0.5 + 0.5) * rect.height;
    const element = document.elementFromPoint(px, py);
    const hit = element instanceof Element
      ? element.closest('button, a, [role="button"], input, label')
      : null;
    return hit instanceof HTMLElement ? hit : null;
  }, []);

  const refreshHudHover = useCallback((): void => {
    const next = hudTargetAt();
    const previous = hoveredHudRef.current;
    if (previous === next) return;
    previous?.classList.remove('is-hud-hover');
    next?.classList.add('is-hud-hover');
    hoveredHudRef.current = next;
  }, [hudTargetAt]);

  /* ------------------------------ 名字标签 ------------------------------ */

  const nameTags = useMemo(
    () =>
      room.players.map((player) => {
        const slot = player.slot ?? 0;
        return {
          entityId: slot + 1,
          label: player.name || (player.isBot ? '电脑' : '玩家'),
          color: TANK_COLORS[slot % TANK_COLORS.length] ?? '#ffffff',
        };
      }),
    [room.players],
  );

  useEffect(() => {
    sceneRef.current?.setNameTags?.(nameTags);
  }, [nameTags, sceneReady]);

  /* ------------------------------ 场景生命周期 ------------------------------ */

  useEffect(() => {
    if (!mapSignature || phase === 'waiting') return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let disposed = false;
    let scene: TankScene | null = null;
    void import('./scene').then((module) => {
      if (disposed) return;
      scene = module.createTankScene(canvas, {
        cameraMode: cameraModeRef.current,
        chaseDistance: 11,
        chasePitchDeg: 38,
      });
      scene.setMap(game.map!);
      scene.setLocal(localEntityId);
      scene.setCameraMode(cameraModeRef.current);
      const cameraScene = scene as TankScene & CameraApi;
      lookYawRef.current = scene.getCameraYaw();
      lookPitchRef.current = cameraScene.getCameraPitch?.() ?? PITCH_BY_MODE.chase;
      cameraScene.setCameraYaw?.(lookYawRef.current, lookPitchRef.current);
      sceneRef.current = scene;
      scene.setNameTags?.(nameTags);
      setSceneReady(true);
      if (import.meta.env.DEV) {
        (window as unknown as { __tankScene?: TankScene }).__tankScene = scene;
      }
    });
    return () => {
      disposed = true;
      sceneRef.current = null;
      setSceneReady(false);
      if (import.meta.env.DEV) {
        delete (window as unknown as { __tankScene?: TankScene }).__tankScene;
      }
      scene?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapSignature]);

  useEffect(() => {
    sceneRef.current?.setLocal(localEntityId);
  }, [localEntityId]);

  // 全画布：对局期间隐藏站点页头页脚。
  useEffect(() => {
    if (phase === 'waiting') return undefined;
    document.body.classList.add('tank-immersive');
    return () => document.body.classList.remove('tank-immersive');
  }, [phase]);

  // 窗口/布局变化：同步渲染尺寸与准星。
  useEffect(() => {
    if (phase === 'waiting') return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const observer = new ResizeObserver(() => {
      sceneRef.current?.resize();
      updateCrosshairPosition();
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [phase, updateCrosshairPosition]);

  /* ------------------------------ 二进制快照 ------------------------------ */

  useEffect(() => {
    const off = socket.onBinary((data) => {
      const frame = decodeTankFrame(data);
      if (frame) bufferRef.current.push(frame, performance.now());
    });
    return off;
  }, [socket]);

  /* ------------------------------ 鼠标视角 ------------------------------ */

  useEffect(() => {
    if (phase === 'waiting') return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const onLockChange = (): void => setPointerLocked(document.pointerLockElement === canvas);
    const onMouseMove = (event: MouseEvent): void => {
      if (document.pointerLockElement !== canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const nextX = reticleRef.current.x + (event.movementX / (rect.width / 2)) * RETICLE_SENSITIVITY;
      const nextY = reticleRef.current.y - (event.movementY / (rect.height / 2)) * RETICLE_SENSITIVITY;
      reticleRef.current = {
        x: Math.max(-1, Math.min(1, nextX)),
        y: Math.max(-1, Math.min(1, nextY)),
      };
      updateCrosshairPosition();
      refreshHudHover();
    };
    document.addEventListener('pointerlockchange', onLockChange);
    document.addEventListener('mousemove', onMouseMove);
    return () => {
      document.removeEventListener('pointerlockchange', onLockChange);
      document.removeEventListener('mousemove', onMouseMove);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    };
  }, [phase]);

  // 滚轮缩放（原生非 passive 监听，避免页面滚动）。
  useEffect(() => {
    if (phase === 'waiting') return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const scene = sceneRef.current as (TankScene & { zoomBy?: (delta: number) => void }) | null;
      scene?.zoomBy?.(event.deltaY);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [phase]);

  /* ------------------------------ 输入 ------------------------------ */

  useEffect(() => {
    if (phase === 'waiting' || isSpectator) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) return;
      const canvas = canvasRef.current;
      if (event.code === 'AltLeft' || event.code === 'AltRight') {
        event.preventDefault();
        if (!canvas) return;
        if (document.pointerLockElement === canvas) {
          document.exitPointerLock();
        } else {
          const request = canvas.requestPointerLock as
            | ((options?: { unadjustedMovement?: boolean }) => Promise<void> | void)
            | undefined;
          try {
            void request?.call(canvas);
          } catch {
            /* 忽略 */
          }
        }
        return;
      }
      if (TankInputState.shouldPreventDefault(event.code)) event.preventDefault();
      if (event.code === 'KeyQ' || event.code === 'KeyE') {
        cameraTurnRef.current = event.code === 'KeyQ' ? 1 : -1;
        return;
      }
      if (event.code === 'KeyC') {
        const next: ControlMode = controlModeRef.current === 'tank' ? 'arcade' : 'tank';
        controlModeRef.current = next;
        setControlMode(next);
        try {
          window.localStorage.setItem(CONTROL_STORAGE_KEY, next);
        } catch {
          /* 隐私模式忽略 */
        }
        return;
      }
      if (event.code === 'KeyV') {
        const index = CAMERA_SEQUENCE.indexOf(cameraModeRef.current);
        const next = CAMERA_SEQUENCE[(index + 1) % CAMERA_SEQUENCE.length];
        cameraModeRef.current = next;
        setCameraMode(next);
        const sceneApi = sceneRef.current as (TankScene & CameraApi) | null;
        sceneApi?.setCameraMode(next);
        if (next !== 'top') {
          lookPitchRef.current = PITCH_BY_MODE[next];
          sceneApi?.setCameraYaw?.(lookYawRef.current, lookPitchRef.current);
        }
        return;
      }
      inputRef.current.pressKey(event.code);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === 'KeyQ' || event.code === 'KeyE') {
        cameraTurnRef.current = 0;
        return;
      }
      inputRef.current.releaseKey(event.code);
    };
    const onBlur = (): void => {
      inputRef.current.reset();
      cameraTurnRef.current = 0;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      inputRef.current.reset();
    };
  }, [phase, isSpectator]);

  /* ------------------------------ 事件与播报 ------------------------------ */

  const nameOf = useCallback(
    (id: string | undefined): string => {
      if (!id) return '某人';
      return room.players.find((player) => player.id === id)?.name ?? '某人';
    },
    [room.players],
  );

  const pushFeed = useCallback((text: string, tone: KillFeedItem['tone']) => {
    feedSeqRef.current += 1;
    feedRef.current = [
      ...feedRef.current,
      { id: feedSeqRef.current, text, tone, at: performance.now() },
    ].slice(-5);
  }, []);

  const proximity = useCallback(
    (x: number, y: number): number => proximityVolume(x, y, localPosRef.current),
    [],
  );

  useEffect(() => {
    if (phaseRef.current === phase) return;
    phaseRef.current = phase;
    scoresRef.current = emptyScores(game);
  }, [phase, game]);

  useEffect(() => {
    const onMessage = (message: { type: string }): void => {
      if (message.type !== 'tank_event') return;
      const event = (message as unknown as { event: TankEvent }).event;
      if (event.kind === 'impact') {
        if (event.x !== undefined && event.y !== undefined) {
          // 场景侧按命中面生成灰尘/火花/弹坑贴花（surface 区分砖墙/集装箱/沙袋）
          sceneRef.current?.emit({ type: 'impact', x: event.x, y: event.y });
          sfxRef.current?.impact(proximity(event.x, event.y));
        }
        return;
      }
      if (event.kind === 'hit') {
        if (event.x !== undefined && event.y !== undefined) {
          sceneRef.current?.emit({ type: 'hit', x: event.x, y: event.y });
          sfxRef.current?.hit(proximity(event.x, event.y));
        }
        if (event.targetId === playerId) {
          triggerHitFeedback(`-${event.damage ?? 25}`);
        }
        return;
      }
      if (event.kind === 'kill') {
        if (event.targetId === playerId) triggerHitFeedback('被击毁');
        if (event.shooterId) {
          const score = scoresRef.current[event.shooterId] ?? { kills: 0, deaths: 0 };
          scoresRef.current[event.shooterId] = { ...score, kills: score.kills + 1 };
        }
        if (event.targetId) {
          const score = scoresRef.current[event.targetId] ?? { kills: 0, deaths: 0 };
          scoresRef.current[event.targetId] = { ...score, deaths: score.deaths + 1 };
        }
        if (event.x !== undefined && event.y !== undefined) {
          sceneRef.current?.emit({ type: 'kill', x: event.x, y: event.y });
          sfxRef.current?.explosion(proximity(event.x, event.y));
        }
        pushFeed(
          `${nameOf(event.shooterId)} 击毁 ${nameOf(event.targetId)}`,
          event.shooterId === playerId ? 'self' : 'enemy',
        );
        return;
      }
      if (event.kind === 'match_end') pushFeed('本局结束', 'system');
    };
    return socket.onMessage(onMessage as never);
  }, [socket, nameOf, pushFeed, proximity, playerId, triggerHitFeedback]);

  /* ------------------------------ 音效 ------------------------------ */

  useEffect(() => {
    if (phase === 'waiting') return undefined;
    const sfx = new TankSfx();
    sfxRef.current = sfx;
    if (!isSpectator && soundOn) sfx.startEngine();
    return () => {
      sfxRef.current = null;
      sfx.dispose();
    };
  }, [phase, isSpectator, soundOn]);

  useEffect(() => {
    if (phase !== 'finished' || isSpectator) return;
    if (game.winnerId && game.winnerId === playerId) playResultSound('win');
    else if (game.winnerId) playResultSound('loss');
    else playResultSound('draw');
  }, [phase, isSpectator, game.winnerId, playerId]);

  /* ------------------------------ 上行输入（20Hz） ------------------------------ */

  useEffect(() => {
    if (phase !== 'playing' || isSpectator || localEntityId === null) return undefined;
    const send = (): void => {
      const scene = sceneRef.current;
      const intent = inputRef.current.intent();
      const flags =
        controlModeRef.current === 'arcade' && scene
          ? arcadeFlags(scene.getCameraYaw(), intent, localHullRef.current)
          : inputRef.current.flags();
      socket.sendBinary(
        encodeTankInput(seqRef.current, bufferRef.current.latestTick, flags, aimRef.current),
      );
      seqRef.current = nextSeq(seqRef.current);
    };
    send();
    const timer = window.setInterval(send, 50);
    return () => window.clearInterval(timer);
  }, [phase, isSpectator, localEntityId, socket]);

  /* ------------------------------ 渲染循环 ------------------------------ */

  useEffect(() => {
    if (phase === 'waiting') return undefined;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number): void => {
      raf = window.requestAnimationFrame(loop);
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      const scene = sceneRef.current;
      const views = bufferRef.current.view(now, localEntityId);
      if (scene) {
        const cameraApi = scene as TankScene & CameraApi;
        const mineView =
          localEntityId !== null ? views.find((entity) => entity.id === localEntityId) : undefined;
        // 相机自动跟到车体后方（视角跟随车体；车体又跟随准星方向）。
        if (mineView && cameraModeRef.current !== 'top') {
          cameraApi.setCameraYaw?.(mineView.hull, lookPitchRef.current);
        }
        // 炮塔瞄准：准星相对坦克的屏幕方向 → 世界方向（360° 无限制）。
        if (mineView && typeof cameraApi.worldToScreen === 'function') {
          const tankNdc = cameraApi.worldToScreen(mineView.x, mineView.y);
          const dx = reticleRef.current.x - tankNdc.x;
          const dy = reticleRef.current.y - tankNdc.y;
          const yaw = scene.getCameraYaw();
          if (dx * dx + dy * dy > 0.0025) {
            const worldX = Math.cos(yaw) * dy - Math.sin(yaw) * dx;
            const worldY = Math.sin(yaw) * dy + Math.cos(yaw) * dx;
            aimRef.current = Math.atan2(worldY, worldX);
          }
          // 标靶环 = 准星正下方的地面交点：距离完全由准星位置决定（可变）。
          const groundPoint = cameraApi.groundPointFromScreen?.(
            reticleRef.current.x,
            reticleRef.current.y,
          ) ?? null;
          cameraApi.setAimDirection?.(aimRef.current, groundPoint);
        }
        updateCrosshairPosition();
        const entities: SceneEntityView[] = views.map((entity) =>
          entity.id === localEntityId ? { ...entity, turret: aimRef.current } : entity,
        );
        scene.setEntities(entities);
        scene.frame(dt);
        fireMuzzle(views, now);
      }
      if (now - hudAtRef.current >= HUD_INTERVAL_MS) {
        hudAtRef.current = now;
        updateHud(views, now);
      }
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
    // updateHud/fireMuzzle 是闭包，不参与依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, localEntityId]);

  const fireMuzzle = (views: TankEntity[], now: number): void => {
    if (localEntityId === null) return;
    const firing = (inputRef.current.flags() & 0x10) !== 0;
    const mine = views.find((entity) => entity.id === localEntityId);
    if (!firing || !mine) return;
    if (now - lastShotRef.current < FIRE_COOLDOWN_MS) return;
    lastShotRef.current = now;
    sfxRef.current?.fire();
    sceneRef.current?.emit({ type: 'muzzle', x: mine.x, y: mine.y, angle: aimRef.current });
  };

  const updateHud = (views: TankEntity[], now: number): void => {
    const mine = localEntityId !== null ? views.find((item) => item.id === localEntityId) : null;
    const timeLeft = game.endsAt ? Math.max(0, Math.ceil((game.endsAt - Date.now()) / 1000)) : 0;
    const reload = Math.min(1, Math.max(0, (now - lastShotRef.current) / FIRE_COOLDOWN_MS));
    const hp = mine ? mine.hp : 0;
    if (mine) {
      localPosRef.current = { x: mine.x, y: mine.y };
      localHullRef.current = mine.hull;
      deadSinceRef.current = null;
    } else if (deadSinceRef.current === null) {
      deadSinceRef.current = now;
    }
    const deadFor = deadSinceRef.current === null ? 0 : (now - deadSinceRef.current) / 1000;
    const speed = mine ? Math.min(1, Math.hypot(mine.vx, mine.vy) / 6) : 0;
    if (!isSpectator) sfxRef.current?.setEngine(speed, mine !== undefined);
    if (mine && prevReloadRef.current < 0.999 && reload >= 0.999) {
      sfxRef.current?.reloadReady();
    }
    prevReloadRef.current = reload;
    if (mine && prevHpRef.current !== null && hp < prevHpRef.current) hitAtRef.current = now;
    if (mine) prevHpRef.current = hp;
    const feed = feedRef.current.filter((item) => now - item.at < 6000);
    setHud({
      hp,
      alive: mine !== undefined,
      reload,
      timeLeft,
      scores: { ...scoresRef.current },
      feed,
      cameraMode: cameraModeRef.current,
      tickRate: game.tickRate,
      blips: views.map((entity) => ({
        id: entity.id,
        slot: entity.ownerSlot,
        kind: entity.kind,
        x: entity.x,
        y: entity.y,
        hull: entity.hull,
        hp: entity.hp,
      })),
      hitAt: hitAtRef.current,
      deadFor,
    });
  };

  /* ------------------------------ 指针 / 键盘交互 ------------------------------ */

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (document.pointerLockElement === event.currentTarget) return;
    const drag = dragRef.current;
    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      dragRef.current = { x: event.clientX, y: event.clientY };
      sceneRef.current?.orbit(dx * 0.006, dy * 0.004);
    }
  }, []);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    canvas.focus();
    if (event.button === 0) {
      if (document.pointerLockElement !== canvas) {
        const request = canvas.requestPointerLock as
          | ((options?: { unadjustedMovement?: boolean }) => Promise<void> | void)
          | undefined;
        try {
          void request?.call(canvas);
        } catch {
          /* 忽略 */
        }
        return;
      }
      // 指针锁定时：准星落在 HUD 按钮上 → 直接触发按钮，不用先按 Esc/Alt 释放鼠标。
      const hudTarget = hudTargetAt();
      if (hudTarget) {
        hudTarget.click();
        refreshHudHover();
        return;
      }
      inputRef.current.setPointerFiring(true);
      return;
    }
    if (event.button === 2 && document.pointerLockElement !== canvas) {
      dragRef.current = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    }
  }, []);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button === 0) inputRef.current.setPointerFiring(false);
    if (event.button === 2) dragRef.current = null;
  }, []);

  /* ------------------------------ 离开 / 准备 ------------------------------ */

  const myReady = me?.ready ?? false;
  const readyCount = room.players.filter((player) => player.ready).length;
  const canStart = room.players.length >= 2;

  const handleCopyInvite = useCallback(() => {
    const url = `${window.location.origin}${roomPath('tank', room.id)}`;
    copyText(url)
      .then(() => notify('邀请链接已复制', 'success'))
      .catch(() => notify('复制失败，请手动复制地址栏链接', 'warn'));
  }, [room.id, notify]);

  useEffect(() => {
    if (phase === 'waiting' || phase === 'playing') {
      bufferRef.current.clear();
      if (phase === 'waiting') setHud(EMPTY_HUD);
    }
  }, [phase]);

  const ranking = useMemo(() => {
    return [...room.players].sort((a, b) => {
      const ka = hud.scores[a.id]?.kills ?? game.scores[a.id]?.kills ?? 0;
      const kb = hud.scores[b.id]?.kills ?? game.scores[b.id]?.kills ?? 0;
      return kb - ka;
    });
  }, [room.players, hud.scores, game.scores]);

  // 开发/冒烟探针
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    (window as unknown as Record<string, unknown>).__tankDebug = {
      aim: () => aimRef.current,
      reticle: () => ({ ...reticleRef.current }),
      locked: () => document.pointerLockElement === canvasRef.current,
      localId: localEntityId,
      localPos: () => ({ ...(localPosRef.current ?? { x: 0, y: 0 }) }),
      hp: () => prevHpRef.current,
      cameraYaw: () => sceneRef.current?.getCameraYaw() ?? 0,
      hull: () => localHullRef.current,
      simulateHit: () => triggerHitFeedback('-25'),
      moveReticle: (nx: number, ny: number) => {
        reticleRef.current = {
          x: Math.max(-1, Math.min(1, nx)),
          y: Math.max(-1, Math.min(1, ny)),
        };
        updateCrosshairPosition();
        refreshHudHover();
      },
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__tankDebug;
    };
  }, [localEntityId, triggerHitFeedback]);

  /* ------------------------------ 渲染 ------------------------------ */

  if (phase === 'waiting') {
    return (
      <section className="tank-room tank-wait">
        <div className="tank-wait-head">
          <div>
            <h2 className="tank-wait-title">
              {room.name}
              <span className="tank-wait-code">{room.id}</span>
            </h2>
            <p className="tank-wait-sub">
              自由混战 · 2–8 人 · 先到 {game.targetKills} 杀或 180 秒结束
            </p>
          </div>
          <div className="tank-wait-actions">
            <button type="button" className="btn btn-ghost btn-small" onClick={handleCopyInvite}>
              复制邀请链接
            </button>
            <button type="button" className="btn btn-ghost btn-small" onClick={onLeave}>
              离开房间
            </button>
          </div>
        </div>

        <div className="tank-wait-body">
          <div className="tank-seats">
            {Array.from({ length: 8 }).map((_, index) => {
              const player = room.players[index];
              return (
                <div
                  key={index}
                  className={`tank-seat${player ? ' is-filled' : ''}${player?.id === playerId ? ' is-me' : ''}`}
                >
                  <span className="tank-seat-slot">{index + 1}</span>
                  {player ? (
                    <>
                      <span className="tank-seat-name">
                        {player.name}
                        {player.isHost ? <span className="tank-seat-host">房主</span> : null}
                      </span>
                      <span className={`tank-seat-ready${player.ready ? ' is-ready' : ''}`}>
                        {player.ready ? '已准备' : '未准备'}
                      </span>
                    </>
                  ) : (
                    <span className="tank-seat-empty">等待玩家…</span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="tank-wait-side">
            <div className="tank-ready-box">
              <p className="tank-ready-hint">
                {canStart
                  ? `${readyCount}/${room.players.length} 人已准备，全部准备后立即开打`
                  : '至少需要 2 名玩家才能开局'}
              </p>
              <button
                type="button"
                className={`btn ${myReady ? 'btn-ghost' : 'btn-primary'} btn-large`}
                onClick={onReady}
                disabled={status !== 'open' || me === null}
              >
                {myReady ? '取消准备' : '准备开战'}
              </button>
              <p className="tank-ready-tip">
                操作：锁定鼠标后移动鼠标移动准星（车体自动朝准星方向，A/D 辅助）· W/S 前进倒车 · 左键开火 · Shift 刹车 · V 切视角 · C 切驾驶模式 · Alt 释放鼠标
              </p>
            </div>
            <ChatPanel messages={chat} onSend={onChat} myPlayerId={playerId} />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      className={`tank-room tank-stage${isSpectator ? ' is-spectator' : ''}${shake ? ' is-hit-shake' : ''}`}
    >
      <canvas
        ref={canvasRef}
        className={`tank-canvas${isSpectator || phase !== 'playing' ? '' : ' is-aiming'}`}
        tabIndex={-1}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onContextMenu={(event) => event.preventDefault()}
      />

      {damagePopup ? (
        <div key={damagePopup.id} className="tank-damage-popup" aria-hidden="true">
          {damagePopup.text}
        </div>
      ) : null}

      <div className="tank-vignette" aria-hidden="true" />
      {isSpectator || phase !== 'playing' ? null : (
        <div ref={crosshairRef} className="tank-crosshair" aria-hidden="true">
          <span className="tank-crosshair-dot" />
          <span className="tank-crosshair-line is-up" />
          <span className="tank-crosshair-line is-down" />
          <span className="tank-crosshair-line is-left" />
          <span className="tank-crosshair-line is-right" />
        </div>
      )}
      {!pointerLocked && !isSpectator && phase === 'playing' ? (
        <button
          type="button"
          className="tank-lock-hint"
          onClick={() => {
            const canvas = canvasRef.current;
            const request = canvas?.requestPointerLock as
              | ((options?: { unadjustedMovement?: boolean }) => Promise<void> | void)
              | undefined;
            if (canvas && request) {
              try {
                void request.call(canvas);
              } catch {
                /* 忽略 */
              }
            }
          }}
        >
          <span className="tank-lock-dot" aria-hidden="true" />
          点击锁定鼠标 · 鼠标移动准星（标靶跟随准星）· Alt 释放鼠标操作界面
        </button>
      ) : null}
      {!sceneReady ? (
        <div className="tank-loading" role="status">
          <span className="conn-spinner" aria-hidden="true" />
          <span>战场加载中…</span>
        </div>
      ) : null}

      <TankHud
        room={room}
        game={game}
        hud={hud}
        cameraMode={cameraMode}
        playerId={playerId}
        isSpectator={isSpectator}
        ranking={ranking}
        localSlot={localSlot}
        onCycleCamera={() => {
          const index = CAMERA_SEQUENCE.indexOf(cameraModeRef.current);
          const next = CAMERA_SEQUENCE[(index + 1) % CAMERA_SEQUENCE.length];
          cameraModeRef.current = next;
          setCameraMode(next);
          const sceneApi = sceneRef.current as (TankScene & CameraApi) | null;
          sceneApi?.setCameraMode(next);
          if (next !== 'top') {
            lookPitchRef.current = PITCH_BY_MODE[next];
            sceneApi?.setCameraYaw?.(lookYawRef.current, lookPitchRef.current);
          }
        }}
        controlMode={controlMode}
        onToggleControl={() => {
          const next: ControlMode = controlMode === 'tank' ? 'arcade' : 'tank';
          setControlMode(next);
          controlModeRef.current = next;
          try {
            window.localStorage.setItem(CONTROL_STORAGE_KEY, next);
          } catch {
            /* 隐私模式忽略 */
          }
        }}
        soundOn={soundOn}
        onToggleSound={() => {
          const next = !soundOn;
          setSoundEnabled(next);
          setSoundOn(next);
        }}
        onExit={onLeave}
      />

      {phase === 'finished' ? (
        <div className="tank-result-backdrop">
          <div className="tank-result card glass">
            <h2 className="tank-result-title">本局结束</h2>
            <p className="tank-result-sub">{describeResult(game, hud, nameOf)}</p>
            <ol className="tank-result-list">
              {ranking.map((player, index) => (
                <li key={player.id} className={player.id === playerId ? 'is-me' : ''}>
                  <span className="tank-result-rank">{index + 1}</span>
                  <span className="tank-result-name">{player.name}</span>
                  <span className="tank-result-score">
                    {hud.scores[player.id]?.kills ?? game.scores[player.id]?.kills ?? 0} 杀 ·{' '}
                    {hud.scores[player.id]?.deaths ?? game.scores[player.id]?.deaths ?? 0} 死
                  </span>
                </li>
              ))}
            </ol>
            <div className="tank-result-actions">
              <button type="button" className="btn btn-primary" onClick={onRematch}>
                再来一局
              </button>
              <button type="button" className="btn btn-ghost" onClick={onLeave}>
                返回大厅
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
