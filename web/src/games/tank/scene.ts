/**
 * 坦克大战渲染层（three.js）：相机、实体同步、特效应答与帧驱动。
 *
 * 画面管线：场景 → EffectComposer（ACES 色调映射 + 半分辨率 Bloom + SMAA + 自写色彩分级），
 * 天空/雾/植被/接触阴影等世界资产见 scene-world.ts，后处理管线见 scene-post.ts。
 *
 * 契约见 docs/TANK.md §6.3。本模块只做「纯渲染」：
 * - 不启动 rAF（由调用方每帧调用 frame(dt)）；
 * - 不碰网络与 React（实体由调用方解码/插值后每帧 setEntities）；
 * - 不加载外部模型，坦克/子弹全部程序化拼装（见 scene-world.ts）。
 *
 * 坐标约定：世界平面 (x, y) → three 的 (x, 0, y)；世界角度 0 指向 +x、逆时针为正，
 * 因此 three 中绕 Y 轴旋转为 -angle，炮塔局部旋转为 hull - turret。
 * 世界单位即米，地图范围通常是 [0, width] × [0, height]。
 */
import * as THREE from 'three';
import { createEnvironment, createModelFactory } from './scene-world';
import type { BulletModel, TankMap, TankModel } from './scene-world';
import { createFx } from './scene-fx';
import { createDuskEnvironmentMap, createPostPipeline, DUSK } from './scene-post';
import { TANK_COLORS } from './palette';
import type { PostPipeline } from './scene-post';

export type { TankMap } from './scene-world';

/* -------------------------------- 对外类型 -------------------------------- */

/** 单帧实体视图：已是解码后的世界单位与弧度（见 docs/TANK.md §3/§6.2）。 */
export interface SceneEntityView {
  id: number;
  /** 0 = 坦克，1 = 子弹。 */
  kind: 0 | 1;
  ownerSlot: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 车体朝向（弧度）。 */
  hull: number;
  /** 炮塔朝向（弧度，世界绝对角度）。 */
  turret: number;
  hp: number;
  shielded: boolean;
}

/** 履带印贴图：柔和边缘的深色履带带，带横向履带板纹理（只用 alpha 通道）。 */
function makeTrackMarkTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建履带印贴图：Canvas 2D 上下文不可用');
  // 左右软边
  const horizontal = ctx.createLinearGradient(0, 0, size, 0);
  horizontal.addColorStop(0, 'rgba(0,0,0,0)');
  horizontal.addColorStop(0.16, 'rgba(0,0,0,0.85)');
  horizontal.addColorStop(0.84, 'rgba(0,0,0,0.85)');
  horizontal.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = horizontal;
  ctx.fillRect(0, 0, size, size);
  // 横向履带板（沿 v 方向交替明暗）
  ctx.globalCompositeOperation = 'destination-out';
  for (let y = 0; y < size; y += 8) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, y, size, 3);
  }
  for (let index = 0; index < 60; index += 1) {
    const x = hash2(index, 1.7) * size;
    const y = hash2(2.9, index) * size;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(x, y, 1.5, 1.5);
  }
  ctx.globalCompositeOperation = 'source-over';
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** 确定性伪随机（履带印贴图颗粒用）。 */
function hash2(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/** 坦克头顶名字标签（entityId = 坦克实体 id = slot + 1）。 */
export interface SceneNameTag {
  entityId: number;
  label: string;
  /** 标签配色（通常是队伍色），用于名字前的小色点/「你」徽标。 */
  color?: string;
}

/** 单次视觉特效：炮口火光 / 命中火花 / 击杀爆炸（坐标是世界平面坐标）。 */
export type SceneFxEvent =
  | { type: 'muzzle'; x: number; y: number; angle: number }
  | { type: 'hit'; x: number; y: number }
  /** 子弹命中掩体/边界墙：场景内部按命中面材质分层（砖屑/金属火花/沙粒 + 表面贴花）。 */
  | { type: 'impact'; x: number; y: number }
  | { type: 'kill'; x: number; y: number };

/** 调试统计：预览页/性能排查用，不参与渲染逻辑。 */
export interface TankDebugStats {
  /** 一帧内所有 pass 的 drawcall 总数。 */
  drawCalls: number;
  /** 一帧内三角形总数。 */
  triangles: number;
  /** Bloom 是否开启（自适应降级后会关闭）。 */
  bloom: boolean;
  /** 当前阴影贴图边长。 */
  shadowMapSize: number;
  /** 最近一个 2 秒窗口的平均帧耗时（毫秒）。 */
  averageFrameMs: number;
  /** 是否已触发自适应降级。 */
  degraded: boolean;
}

/** 相机模式：iso = 等距俯视对局视角（默认），chase = 第三人称追尾，top = 整场俯视。 */
export type TankCameraMode = 'chase' | 'iso' | 'top';

export interface TankSceneOptions {
  /** 初始相机模式，默认 'iso'。 */
  cameraMode?: TankCameraMode;
  /** 追尾相机距离（世界单位），默认 14。 */
  chaseDistance?: number;
  /** 追尾相机仰角（度），默认 38。 */
  chasePitchDeg?: number;
  /** 等距相机距离（世界单位），默认 24（该距离下坦克屏高约占 8%）。 */
  isoDistance?: number;
  /** 等距相机俯角（度），默认 57。 */
  isoPitchDeg?: number;
  /** 注视点相对本地坦克前移的距离（世界单位，默认 10）：越大坦克越靠画面下方。 */
  cameraLead?: number;
  /** devicePixelRatio 上限，默认 2。 */
  maxPixelRatio?: number;
}

/** 渲染层对外接口（与 docs/TANK.md §6.3 一致）。 */
export interface TankScene {
  /** 设置/切换地图（新一局时调用），会重建环境并清空当前实体。 */
  setMap(map: TankMap): void;
  /** 指定本地玩家实体 id；传 null 时相机聚焦地图中心。 */
  setLocal(entityId: number | null): void;
  /** 每帧传入插值/预测后的实体列表；按 id 复用 Object3D，消失的实体回收。 */
  setEntities(entities: readonly SceneEntityView[]): void;
  /** 推进相机、履带、烟雾与特效并渲染一帧（dt 秒）。 */
  frame(dt: number): void;
  /**
   * 归一化设备坐标（-1..1）→ 炮塔世界角度（atan2(z, x)）。
   * 优先用射线与 y=0 地面的交点；指向天空/地平线时退化为射线方向的水平投影，
   * 因此除「几乎垂直向上」的极端情况外恒定返回数值（返回类型保留 null 仅为契约兼容）。
   */
  aimFromScreen(nx: number, ny: number): number | null;
  /** 鼠标拖拽转视角（仅 chase 模式生效，松手不回正）。 */
  orbit(dx: number, dy: number): void;
  /**
   * 滚轮缩放：delta 为 wheel 事件的 deltaY（一格约 ±100）。
   * chase / iso 模式平滑调整相机距离（chase ≥0.82x、iso ≥0.5x、上限 1.6x，正数拉远、负数拉近）；
   * top 模式忽略。缩放状态在 resize / 切换相机模式后保留。
   */
  zoomBy(delta: number): void;
  setCameraMode(mode: TankCameraMode): void;
  /**
   * 相机前向的水平世界角度（atan2(dir.z, dir.x)，弧度）。
   * iso 下为固定值（默认 -3π/4），chase 下随追尾朝向变化；用于把 WASD 换算成世界方向。
   */
  getCameraYaw(): number;
  /** 相机当前仰角（弧度，10°–80° 之间）；top 模式返回实际俯仰。 */
  getCameraPitch(): number;
  /**
   * 直接设置相机绕本地坦克的视线方位角（世界弧度，不做夹紧/归一化，可任意累加 360°），
   * 可选 pitch（内部夹到 10°–80°）。立即生效、不走平滑：同一帧 getCameraYaw() 即等于传入值。
   * 炮塔角可直接使用 getCameraYaw()。chase / iso 生效，top 忽略。
   */
  setCameraYaw(yaw: number, pitch?: number): void;
  /**
   * 世界平面坐标 (x, y) → 归一化设备坐标 NDC（y 向上为正）。
   * 供调用方用「准星 NDC − 本地坦克 NDC」求屏幕方向，再结合 getCameraYaw() 转世界角。
   */
  worldToScreen(x: number, y: number): { x: number; y: number };
  /**
   * 屏幕 NDC（-1..1）→ 射线与 y=0 地面交点世界坐标（世界平面 (x, y)）；打不到地面返回 null。
   * 纯查询，不改变任何瞄准状态，供客户端把鼠标位置换算成"鼠标地面点"。
   */
  groundPointFromScreen(nx: number, ny: number): { x: number; y: number } | null;
  /**
   * 直接按世界角度驱动瞄准可视化，角度不做夹紧（任意弧度有效）；null 隐藏全部瞄准可视化。
   * - point 传入时：瞄准环/虚线画在该地面点（跟随鼠标）；不传或传 null：沿用旧行为，画在坦克沿角度 10 单位处。
   * - 与 aimFromScreen 并存，以最近一次调用为准。
   */
  setAimDirection(angle: number | null, point?: { x: number; y: number } | null): void;
  /**
   * 设置每辆坦克头顶的名字标签（可反复调用；实体消失/换人自动回收）。
   * 屏幕恒定尺寸，本地坦克标签额外带「你」徽标；标签不写深度，始终可见（HUD 顶部 6% 内自动隐藏）。
   */
  setNameTags(tags: readonly SceneNameTag[]): void;
  emit(event: SceneFxEvent): void;
  /** 按 canvas 的 CSS 尺寸与 devicePixelRatio 适配渲染尺寸。 */
  resize(): void;
  /** 释放全部 geometry / material / texture / renderer（含 composer / render target）。 */
  dispose(): void;
  /** 可选调试统计（drawcall / 帧耗时 / 降级状态）。 */
  debugStats?(): TankDebugStats;
  /** 开发/冒烟用：本地坦克炮塔朝向的世界角度（弧度），用于校验"炮管跟鼠标"。 */
  debugTurretDirection?(): number | null;
  /** 开发/冒烟用：炮口尖端与瞄准方向的屏幕坐标，校验"看到的炮管"是否指向准星。 */
  debugBarrelScreen?(): {
    tank: { x: number; y: number };
    tip: { x: number; y: number };
    aim: { x: number; y: number } | null;
  } | null;
  /** 可选调试统计（drawcall / 帧耗时 / 降级状态）。 */
  debugStats?(): TankDebugStats;
  /** 开发/冒烟用：本地坦克炮塔朝向的世界角度（弧度），用于校验"炮管跟鼠标"。 */
  debugTurretDirection?(): number | null;
  /** 开发/冒烟用：炮口尖端与瞄准方向的屏幕坐标，校验"看到的炮管"是否指向准星。 */
  debugBarrelScreen?(): {
    tank: { x: number; y: number };
    tip: { x: number; y: number };
    aim: { x: number; y: number } | null;
  } | null;
  /** 开发/冒烟用：把本地坦克中心 / 炮口 / 瞄准点投影到 NDC，校验三者是否共线。 */
  debugAimScreen?(nx: number, ny: number): {
    tank: { x: number; y: number };
    muzzle: { x: number; y: number };
    aim: { x: number; y: number } | null;
  } | null;
}

/* -------------------------------- 内部类型 -------------------------------- */

/** 一辆坦克的渲染簿记（每帧由 setEntities 刷新）。 */
interface TrackedTank {
  model: TankModel;
  slot: number;
  hp: number;
  x: number;
  y: number;
  hull: number;
  turret: number;
  signedSpeed: number;
  /** 履带印锚点：上一次留下印记的位置。 */
  markX: number;
  markY: number;
  smokeTimer: number;
  sparkTimer: number;
}

interface TrackedBullet {
  model: BulletModel;
  slot: number;
}

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const CAMERA_FORWARD = new THREE.Vector3();
const BACK_DIRECTION = new THREE.Vector3();
const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const AIM_POINT = new THREE.Vector3();
const NDC = new THREE.Vector2();
const DRAWING_BUFFER_SIZE = new THREE.Vector2();

/** 低于该血量开始冒烟。 */
const SMOKE_HP = 50;
/** 低于该血量追加火花。 */
const SPARK_HP = 25;

/** 注视点高度（世界单位）：相机看向前方地面/掩体，而不是自家坦克。 */
const CAMERA_LOOK_HEIGHT = 1.2;
/** 默认注视点前移距离（世界单位）：坦克落在画面下方约 1/3。 */
const DEFAULT_CAMERA_LEAD = 10;

/** 炮口尖端在炮塔局部坐标（模型单位，root 的 0.7 缩放由 matrixWorld 处理）。 */
const MUZZLE_LOCAL = new THREE.Vector3(2.95, 0.2, 0);
/** 瞄准辅助线分段数（虚线感，规避 WebGL 线宽限制）。 */
const AIM_LINE_DASHES = 12;

/** 角度归一化到 (-π, π]。 */
function normalizeAngle(angle: number): number {
  let value = angle % (Math.PI * 2);
  if (value > Math.PI) value -= Math.PI * 2;
  if (value < -Math.PI) value += Math.PI * 2;
  return value;
}

/**
 * 生成坦克名字标签贴图：深色 pill 背板 + 队伍色圆点 + 白色名字（深色描边）。
 * 宽度按 Canvas 实测文字宽度动态生成（左右 padding 10px），最长 16 字符；
 * 本地坦克文本为「你 · 名字」单条 pill，不再叠加旧头顶标识。
 */
function makeNameTagTexture(label: string, color: string, isLocal: boolean): THREE.CanvasTexture {
  const font = '600 28px "PingFang SC", "Microsoft YaHei", sans-serif';
  const raw = label.trim().length > 0 ? label.trim() : '玩家';
  const characters = Array.from(raw);
  const clipped =
    characters.length > 16 ? `${characters.slice(0, 15).join('')}…` : characters.join('');
  const displayText = isLocal ? `你 · ${clipped}` : clipped;

  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  if (!measureCtx) throw new Error('无法创建名字标签贴图：Canvas 2D 上下文不可用');
  measureCtx.font = font;
  const textWidth = Math.ceil(measureCtx.measureText(displayText).width);

  const dotSize = 14;
  const dotGap = 8;
  const paddingX = 10;
  const height = 56;
  const width = Math.max(72, paddingX * 2 + dotSize + dotGap + textWidth);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建名字标签贴图：Canvas 2D 上下文不可用');

  const centerY = height / 2;
  // 队伍色圆点
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(paddingX + dotSize / 2, centerY, dotSize / 2, 0, Math.PI * 2);
  ctx.fill();

  // 名字：先画深色描边（3px）+ 轻微投影，再填白字（无底板，保证任何地面都清晰）
  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const textX = paddingX + dotSize + dotGap;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
  ctx.strokeText(displayText, textX, centerY + 1);
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(displayText, textX, centerY + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/* -------------------------------- 工厂函数 -------------------------------- */

export function createTankScene(
  canvas: HTMLCanvasElement,
  options: TankSceneOptions = {},
): TankScene {
  const maxPixelRatio = Math.max(1, options.maxPixelRatio ?? 2);

  /* ------------------------------ 渲染器与场景 ------------------------------ */
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  // 手动管理 renderer.info，使 debugStats 能统计到 composer 内所有 pass 的 drawcall
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  scene.background = DUSK.fog.clone();
  // 指数大气雾：黄昏冷调，远处森林与竞技场边缘自然融合
  scene.fog = new THREE.FogExp2(DUSK.fog.clone(), 0.0078);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 320);
  camera.position.set(24, 15, 40);

  // 程序化黄昏环境贴图：让金属/车体反射出「冷天空 + 暖太阳」的层次
  const duskEnvironment = createDuskEnvironmentMap(renderer);
  scene.environment = duskEnvironment.texture;
  scene.environmentIntensity = 0.55;

  const environment = createEnvironment(scene, renderer);
  const models = createModelFactory();
  const fx = createFx(scene);
  const post: PostPipeline = createPostPipeline(renderer, scene, camera);

  /* -------------------------------- 状态 -------------------------------- */
  let map: TankMap = { width: 48, height: 48, obstacles: [], spawns: [] };
  let mode: TankCameraMode = options.cameraMode ?? 'iso';
  const chaseDistance = options.chaseDistance ?? 14;
  const isoDistance = options.isoDistance ?? 24;
  /** 注视点前移距离：坦克在画面下方约 1/3，屏幕中心指向可射击的前方地面。 */
  const cameraLead = Number.isFinite(options.cameraLead)
    ? Math.max(0, options.cameraLead ?? DEFAULT_CAMERA_LEAD)
    : DEFAULT_CAMERA_LEAD;
  const chasePitchDefault = THREE.MathUtils.degToRad(options.chasePitchDeg ?? 38);
  const isoPitchDefault = THREE.MathUtils.degToRad(options.isoPitchDeg ?? 57);
  /** 相机"视线朝向"的水平世界角：相机放在焦点的反方向，因此它同时就是 getCameraYaw。 */
  let viewYaw = options.cameraMode === 'iso' ? -Math.PI * 0.75 : -Math.PI / 2;
  /** 相机仰角（高于水平面，弧度），由 setCameraYaw / orbit 更新。 */
  let viewPitch = options.cameraMode === 'iso' ? isoPitchDefault : chasePitchDefault;
  /** 是否由 setCameraYaw 明确设置过 pitch（否则切模式时使用该模式默认仰角）。 */
  let viewPitchExplicit = false;
  /** setCameraYaw 后下一帧相机位置立即吸附（yaw 不允许平滑延迟）。 */
  let cameraYawSnap = false;
  /** 相机距离缩放：zoomTarget 由滚轮累积，zoomFactor 每帧平滑逼近它。 */
  let zoomTarget = 1;
  let zoomFactor = 1;

  let localId: number | null = null;
  /** 本地实体首次出现时，把追尾相机摆到车尾正后方。 */
  let yawInitPending = true;
  let snapCamera = true;
  let elapsed = 0;

  /** 鼠标指向的地面点（用于瞄准环与辅助线；打不到地面时隐藏）。 */
  const aimPoint = new THREE.Vector3(24, 0, 24);
  const muzzleWorld = new THREE.Vector3(24, 0.8, 24);
  const worldToScreenPoint = new THREE.Vector3();
  const groundQueryPoint = new THREE.Vector3();
  /** setAimDirection 传入的鼠标地面点（无则退回固定 10 单位）。 */
  let aimDirectionHasPoint = false;
  let aimDirectionPointX = 0;
  let aimDirectionPointZ = 0;
  /** 瞄准可视化最近一次由谁驱动：屏幕射线 or 外部世界角度。 */
  let useAimDirection = false;
  /** setAimDirection 是否处于激活状态（null 时隐藏）。 */
  let aimDirectionActive = false;
  /** 本帧是否调用过 setAimDirection（未调用则退回 aimFromScreen 的可视化）。 */
  let directionUsedSinceLastFrame = false;
  /** 最近一次瞄准 API 调用是否是 setAimDirection（否则 aimFromScreen 优先）。 */
  let lastAimCallWasDirection = false;
  /** 外部传入的世界角度（不归一化，渲染时直接取 cos/sin）。 */
  let aimDirectionAngle = 0;
  let aimHasGroundPoint = false;
  let lastAimAngle = 0;

  const focus = new THREE.Vector3(24, 0.85, 24);
  const desiredFocus = new THREE.Vector3(24, 0.85, 24);
  const desiredPosition = new THREE.Vector3();
  const lastLocal = new THREE.Vector3(24, 0.85, 24);
  let hasLastLocal = false;

  // 俯视相机取景用的临时对象（预先分配，避免每帧 new）
  const fitCamera = new THREE.PerspectiveCamera(52, 1, 0.1, 320);
  const fitCorner = new THREE.Vector3();
  const fitCorners = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];

  const tanks = new Map<number, TrackedTank>();
  const bullets = new Map<number, TrackedBullet>();
  const tankPool: TankModel[] = [];
  const bulletPool: BulletModel[] = [];
  const seenIds = new Set<number>();

  const raycaster = new THREE.Raycaster();

  // 相机穿模夹紧用（复用临时对象，避免每帧分配）
  const cameraCollisionRay = new THREE.Ray();
  const cameraCollisionHit = new THREE.Vector3();
  const cameraOffsetDirection = new THREE.Vector3();

  /** 各相机模式允许的最小距离倍数（top 是固定整场视图，不缩放）。 */
  function minZoomFor(target: TankCameraMode): number {
    if (target === 'chase') return 0.82;
    if (target === 'iso') return 0.5;
    return 1;
  }

  /**
   * 从相机焦点向目标机位打一条射线，与掩体/边界墙 AABB 求最近交点；
   * 命中则把机位夹到命中点前 0.4，避免相机钻进集装箱。
   */
  function clampCameraAgainstObstacles(origin: THREE.Vector3, target: THREE.Vector3): void {
    cameraOffsetDirection.copy(target).sub(origin);
    const distance = cameraOffsetDirection.length();
    if (distance < 0.001) return;
    cameraOffsetDirection.divideScalar(distance);
    cameraCollisionRay.set(origin, cameraOffsetDirection);
    let closest = distance;
    for (const box of environment.getCameraColliders()) {
      const hit = cameraCollisionRay.intersectBox(box, cameraCollisionHit);
      if (!hit) continue;
      const hitDistance = cameraCollisionHit.distanceTo(origin);
      if (hitDistance > 0.05 && hitDistance < closest) closest = hitDistance;
    }
    if (closest < distance) {
      const safeDistance = Math.max(0.9, closest - 0.4);
      target.copy(origin).addScaledVector(cameraOffsetDirection, safeDistance);
    }
  }

  /* ------------------------------ 瞄准反馈 ------------------------------ */
  // 分层瞄准环：外环 + 更亮的细内环 + 中心点；颜色跟随本地队伍色。
  const aimRingGeometry = new THREE.RingGeometry(0.46, 0.56, 36);
  aimRingGeometry.rotateX(-Math.PI / 2);
  const aimInnerRingGeometry = new THREE.RingGeometry(0.25, 0.3, 32);
  aimInnerRingGeometry.rotateX(-Math.PI / 2);
  const aimDotGeometry = new THREE.CircleGeometry(0.055, 12);
  aimDotGeometry.rotateX(-Math.PI / 2);
  const aimRingMaterial = new THREE.MeshBasicMaterial({
    color: 0xb9e8ff,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const aimInnerMaterial = new THREE.MeshBasicMaterial({
    color: 0xe8f8ff,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const aimDotMaterial = new THREE.MeshBasicMaterial({
    color: 0xe8f8ff,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const AIM_SCALE_TMP = new THREE.Vector3();
  /** 瞄准环随距离的基础缩放（保持屏幕可读性），与"对准收束"的缩放相乘。 */
  let aimVisualBaseScale = 1;
  const aimRing = new THREE.Mesh(aimRingGeometry, aimRingMaterial);
  const aimInnerRing = new THREE.Mesh(aimInnerRingGeometry, aimInnerMaterial);
  const aimDot = new THREE.Mesh(aimDotGeometry, aimDotMaterial);
  aimRing.position.y = 0.05;
  aimInnerRing.position.y = 0.052;
  aimDot.position.y = 0.055;
  aimRing.visible = false;
  aimInnerRing.visible = false;
  aimDot.visible = false;
  aimRing.renderOrder = 24;
  aimInnerRing.renderOrder = 24;
  aimDot.renderOrder = 25;
  scene.add(aimRing, aimInnerRing, aimDot);

  // 从真实炮口尖端到瞄准点的分段虚线（用 LineSegments 规避线宽限制）
  const aimLineGeometry = new THREE.BufferGeometry();
  const aimLinePositions = new THREE.BufferAttribute(
    new Float32Array(AIM_LINE_DASHES * 6),
    3,
  ).setUsage(THREE.DynamicDrawUsage);
  aimLineGeometry.setAttribute('position', aimLinePositions);
  const aimLineMaterial = new THREE.LineBasicMaterial({
    color: 0x9fd8ff,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const aimLine = new THREE.LineSegments(aimLineGeometry, aimLineMaterial);
  aimLine.frustumCulled = false;
  aimLine.renderOrder = 24;
  aimLine.visible = false;
  scene.add(aimLine);

  /* ------------------------- 本地玩家标识 / 朝向 ------------------------- */
  // 脚下脉冲高亮环（在原有本地指示环之外扩张淡出）
  const pulseRingGeometry = new THREE.RingGeometry(0.92, 1.04, 40);
  pulseRingGeometry.rotateX(-Math.PI / 2);
  const pulseRingMaterial = new THREE.MeshBasicMaterial({
    color: 0x9fe8ff,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const pulseRing = new THREE.Mesh(pulseRingGeometry, pulseRingMaterial);
  pulseRing.position.y = 0.045;
  pulseRing.visible = false;
  scene.add(pulseRing);

  /** 当前本地视觉颜色对应的 slot（变化时刷新颜色/贴图）。 */
  let localVisualSlot = -1;

  /** 按本地坦克队伍色刷新标识/瞄准环/楔形箭头颜色。 */
  function updateLocalAccent(slot: number): void {
    const index = Math.min(Math.max(Math.trunc(slot), 0), TANK_COLORS.length - 1);
    localVisualSlot = slot;
    const team = new THREE.Color(TANK_COLORS[index] ?? '#e5544b');
    const bright = team.clone().multiplyScalar(1.4);
    aimRingMaterial.color.copy(bright);
    aimInnerMaterial.color.copy(team.clone().multiplyScalar(1.75));
    aimDotMaterial.color.copy(team.clone().lerp(new THREE.Color(0xffffff), 0.55));
    aimLineMaterial.color.copy(bright);
    pulseRingMaterial.color.copy(team.clone().multiplyScalar(1.2));
  }

  /* ------------------------------ 履带印 ------------------------------ */
  const TRACK_MARK_CAPACITY = 200;
  const trackMarkTexture = makeTrackMarkTexture();
  const trackMarkGeometry = new THREE.PlaneGeometry(1, 1);
  trackMarkGeometry.rotateX(-Math.PI / 2);
  const trackMarkAlphaAttribute = new THREE.InstancedBufferAttribute(
    new Float32Array(TRACK_MARK_CAPACITY),
    1,
  ).setUsage(THREE.DynamicDrawUsage);
  trackMarkGeometry.setAttribute('aAlpha', trackMarkAlphaAttribute);
  const trackMarkMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: trackMarkTexture },
      uColor: { value: new THREE.Color(0x0d1114) },
    },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vUv = uv;
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        float alpha = texture2D(uMap, vUv).a * vAlpha;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const trackMarkMesh = new THREE.InstancedMesh(
    trackMarkGeometry,
    trackMarkMaterial,
    TRACK_MARK_CAPACITY,
  );
  trackMarkMesh.frustumCulled = false;
  trackMarkMesh.renderOrder = 1;
  scene.add(trackMarkMesh);
  const trackMarkAge = new Float32Array(TRACK_MARK_CAPACITY).fill(1e6);
  const trackMarkLife = new Float32Array(TRACK_MARK_CAPACITY).fill(8);
  let trackMarkCursor = 0;
  const trackMarkMatrix = new THREE.Matrix4();
  const trackMarkQuaternion = new THREE.Quaternion();
  const trackMarkEuler = new THREE.Euler();
  const trackMarkPosition = new THREE.Vector3();
  const trackMarkScale = new THREE.Vector3();
  for (let slot = 0; slot < TRACK_MARK_CAPACITY; slot += 1) {
    trackMarkMesh.setMatrixAt(slot, trackMarkMatrix.makeScale(0, 0, 0));
  }
  trackMarkMesh.instanceMatrix.needsUpdate = true;

  /** 在 (x,z) 处沿 heading 方向留下左右两条履带印。 */
  function spawnTrackMark(x: number, z: number, heading: number): void {
    const perpX = -Math.sin(heading);
    const perpZ = Math.cos(heading);
    for (const side of [-1, 1]) {
      const slot = trackMarkCursor;
      trackMarkCursor = (trackMarkCursor + 1) % TRACK_MARK_CAPACITY;
      trackMarkAge[slot] = 0;
      trackMarkLife[slot] = 7 + Math.random() * 2;
      trackMarkPosition.set(x + perpX * side * 0.42, 0.018, z + perpZ * side * 0.42);
      trackMarkEuler.set(0, -heading, 0);
      trackMarkQuaternion.setFromEuler(trackMarkEuler);
      trackMarkScale.set(0.62, 1, 0.34);
      trackMarkMatrix.compose(trackMarkPosition, trackMarkQuaternion, trackMarkScale);
      trackMarkMesh.setMatrixAt(slot, trackMarkMatrix);
      trackMarkAlphaAttribute.array[slot] = 0.55;
    }
    trackMarkMesh.instanceMatrix.needsUpdate = true;
    trackMarkAlphaAttribute.needsUpdate = true;
  }

  /** 每帧检查坦克位移并铺履带印，同时推进淡出。 */
  function updateTrackMarks(dt: number): void {
    for (const tracked of tanks.values()) {
      const dx = tracked.x - tracked.markX;
      const dz = tracked.y - tracked.markY;
      const distance = Math.hypot(dx, dz);
      if (distance > 3) {
        // 复活/传送：直接重置锚点，不画一条长线
        tracked.markX = tracked.x;
        tracked.markY = tracked.y;
        continue;
      }
      if (distance < 0.4) continue;
      const dirX = dx / distance;
      const dirZ = dz / distance;
      const heading = Math.atan2(dirZ, dirX);
      const steps = Math.min(6, Math.floor(distance / 0.4));
      for (let step = 0; step < steps; step += 1) {
        const t = (step + 1) * 0.4;
        spawnTrackMark(tracked.markX + dirX * t, tracked.markY + dirZ * t, heading);
      }
      tracked.markX = tracked.x;
      tracked.markY = tracked.y;
    }

    let dirty = false;
    for (let slot = 0; slot < TRACK_MARK_CAPACITY; slot += 1) {
      if (trackMarkAge[slot] > trackMarkLife[slot]) continue;
      trackMarkAge[slot] += dt;
      const remain = 1 - trackMarkAge[slot] / trackMarkLife[slot];
      trackMarkAlphaAttribute.array[slot] = Math.max(0, remain) * 0.55;
      if (remain <= 0) {
        trackMarkAge[slot] = trackMarkLife[slot] + 1;
        trackMarkMesh.setMatrixAt(slot, trackMarkMatrix.makeScale(0, 0, 0));
      }
      dirty = true;
    }
    if (dirty) {
      trackMarkAlphaAttribute.needsUpdate = true;
      trackMarkMesh.instanceMatrix.needsUpdate = true;
    }
  }

  /* ------------------------------ 坦克名字标签 ------------------------------ */
  const nameTagStates = new Map<number, SceneNameTag>();
  const nameTagSprites = new Map<number, THREE.Sprite>();
  const nameTagTextureCache = new Map<string, THREE.CanvasTexture>();
  const nameTagMaterialCache = new Map<string, THREE.SpriteMaterial>();
  const nameTagPool: THREE.Sprite[] = [];
  const nameTagProjection = new THREE.Vector3();
  const nameTagCameraSpace = new THREE.Vector3();
  const nameTagCameraUp = new THREE.Vector3();
  /** 标签世界高度（坦克上方约 2.2，再叠加屏幕空间上移避免压住车顶）。 */
  const TAG_HEIGHT = 2.2;
  /** 贴图 56px 高、字高 28px → 屏幕上文字约 12–14px。 */
  const TAG_PIXEL_HEIGHT = 26;
  /** 屏幕空间再上移的像素数（避免压住车顶）。 */
  const TAG_SCREEN_OFFSET_PX = 8;

  function nameTagMaterialFor(label: string, color: string, isLocal: boolean): THREE.SpriteMaterial {
    const key = `${label}|${color}|${isLocal ? 1 : 0}`;
    const cached = nameTagMaterialCache.get(key);
    if (cached) return cached;
    let texture = nameTagTextureCache.get(key);
    if (!texture) {
      texture = makeNameTagTexture(label, color, isLocal);
      nameTagTextureCache.set(key, texture);
    }
    const material = new THREE.SpriteMaterial({
      map: texture,
      sizeAttenuation: false,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    nameTagMaterialCache.set(key, material);
    return material;
  }

  /** 设置/更新名字标签列表（可反复调用；实体消失或换人时自动回收 Sprite）。 */
  function setNameTags(tags: readonly SceneNameTag[]): void {
    nameTagStates.clear();
    for (const tag of tags) {
      if (!Number.isFinite(tag.entityId)) continue;
      nameTagStates.set(tag.entityId, {
        entityId: tag.entityId,
        label: tag.label ?? '',
        color: tag.color ?? '#e5544b',
      });
    }
    for (const [id, sprite] of nameTagSprites) {
      if (nameTagStates.has(id)) continue;
      scene.remove(sprite);
      nameTagSprites.delete(id);
      nameTagPool.push(sprite);
    }
  }

  /** 每帧更新标签位置/屏幕尺寸/可见性（顶部 6% 隐藏，避免压 HUD）。 */
  function updateNameTags(): void {
    if (nameTagStates.size === 0) {
      for (const sprite of nameTagSprites.values()) sprite.visible = false;
      return;
    }
    const cssHeight = canvas.clientHeight || canvas.height || 1;
    const projectionScale = 1 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const ndcPerPixel = 2 / (projectionScale * cssHeight);
    const ndcScreenOffset = (2 * TAG_SCREEN_OFFSET_PX) / cssHeight;
    nameTagCameraUp.setFromMatrixColumn(camera.matrixWorld, 1);
    const topLimit = 0.88;
    for (const [id, state] of nameTagStates) {
      const tracked = tanks.get(id);
      let sprite = nameTagSprites.get(id);
      if (!tracked) {
        if (sprite) sprite.visible = false;
        continue;
      }
      const isLocal = id === localId;
      const material = nameTagMaterialFor(state.label, state.color ?? '#e5544b', isLocal);
      if (!sprite) {
        const pooled = nameTagPool.pop();
        sprite = pooled ?? new THREE.Sprite(material);
        sprite.material = material;
        scene.add(sprite);
        nameTagSprites.set(id, sprite);
      } else if (sprite.material !== material) {
        sprite.material = material;
      }
      sprite.position.set(tracked.x, TAG_HEIGHT, tracked.y);
      // 屏幕空间上移约 8px：按相机 up 方向换算成该深度下的世界位移
      nameTagCameraSpace.copy(sprite.position).applyMatrix4(camera.matrixWorldInverse);
      const depth = Math.max(0.2, -nameTagCameraSpace.z);
      sprite.position.addScaledVector(
        nameTagCameraUp,
        (ndcScreenOffset * depth) / projectionScale,
      );
      nameTagProjection.copy(sprite.position).project(camera);
      // 屏幕最上方 6% 内隐藏（相机后方的点也隐藏）
      if (nameTagProjection.y > topLimit || nameTagProjection.z >= 1) {
        sprite.visible = false;
        continue;
      }
      sprite.visible = true;
      const texture = material.map as THREE.CanvasTexture | null;
      const image = texture?.image as HTMLCanvasElement | undefined;
      const aspect = image && image.height > 0 ? image.width / image.height : 3;
      sprite.scale.set(
        TAG_PIXEL_HEIGHT * ndcPerPixel * aspect,
        TAG_PIXEL_HEIGHT * ndcPerPixel,
        1,
      );
      sprite.renderOrder = 25;
    }
  }

  /** 当前生效的相机仰角（未显式设置时使用各模式默认值）。 */
  function currentViewPitch(): number {
    if (viewPitchExplicit) return viewPitch;
    return mode === 'iso' ? isoPitchDefault : chasePitchDefault;
  }

  /** 设置仰角并夹紧到 10°–80°。 */
  function applyViewPitch(pitch: number): void {
    viewPitch = THREE.MathUtils.clamp(
      pitch,
      THREE.MathUtils.degToRad(10),
      THREE.MathUtils.degToRad(80),
    );
    viewPitchExplicit = true;
  }

  /* ---------------------------- 性能自适应降级 ---------------------------- */
  /** 平均帧耗时超过该值（约 50fps 下限）时降级，保证集成显卡不至于持续掉帧。 */
  const FRAME_BUDGET_SECONDS = 0.02;
  /** 统计窗口：最近 2 秒。 */
  const FRAME_WINDOW_SECONDS = 2;
  let frameSampleSum = 0;
  let frameSampleCount = 0;
  let averageFrameMs = 0;
  let degraded = false;

  function samplePerformance(rawDt: number): void {
    // 忽略切后台 / 首帧的异常间隔
    if (rawDt <= 0 || rawDt > 0.25) return;
    frameSampleSum += rawDt;
    frameSampleCount += 1;
    if (frameSampleSum < FRAME_WINDOW_SECONDS) return;
    const average = frameSampleSum / frameSampleCount;
    averageFrameMs = average * 1000;
    frameSampleSum = 0;
    frameSampleCount = 0;
    if (!degraded && average > FRAME_BUDGET_SECONDS) {
      degraded = true;
      post.setBloomEnabled(false);
      environment.setShadowQuality(false);
    }
  }

  /* ------------------------------ 实体同步 ------------------------------ */

  function syncTank(entity: SceneEntityView): void {
    let tracked = tanks.get(entity.id);
    if (!tracked) {
      const model = tankPool.pop() ?? models.createTank(entity.ownerSlot);
      if (model.root.parent !== scene) scene.add(model.root);
      model.setSlot(entity.ownerSlot);
      model.setVisible(true);
      tracked = {
        model,
        slot: entity.ownerSlot,
        hp: entity.hp,
        x: entity.x,
        y: entity.y,
        hull: entity.hull,
        turret: entity.turret,
        signedSpeed: 0,
        markX: entity.x,
        markY: entity.y,
        smokeTimer: 0,
        sparkTimer: 0,
      };
      tanks.set(entity.id, tracked);
    }
    if (tracked.slot !== entity.ownerSlot) {
      tracked.slot = entity.ownerSlot;
      tracked.model.setSlot(entity.ownerSlot);
    }
    tracked.x = entity.x;
    tracked.y = entity.y;
    tracked.hull = entity.hull;
    tracked.turret = entity.turret;
    tracked.hp = entity.hp;
    tracked.signedSpeed = entity.vx * Math.cos(entity.hull) + entity.vy * Math.sin(entity.hull);

    const root = tracked.model.root;
    root.position.set(entity.x, 0, entity.y);
    root.rotation.y = -entity.hull;
    // 炮塔角是世界绝对角，扣掉车体旋转得到局部角
    tracked.model.turret.rotation.y = entity.hull - entity.turret;
    tracked.model.setShield(entity.shielded);
  }

  function syncBullet(entity: SceneEntityView): void {
    let tracked = bullets.get(entity.id);
    if (!tracked) {
      const model = bulletPool.pop() ?? models.createBullet(entity.ownerSlot);
      if (model.root.parent !== scene) scene.add(model.root);
      model.setSlot(entity.ownerSlot);
      model.setVisible(true);
      tracked = { model, slot: entity.ownerSlot };
      bullets.set(entity.id, tracked);
    }
    if (tracked.slot !== entity.ownerSlot) {
      tracked.slot = entity.ownerSlot;
      tracked.model.setSlot(entity.ownerSlot);
    }

    const root = tracked.model.root;
    root.position.set(entity.x, 0.92, entity.y);
    const speed = Math.hypot(entity.vx, entity.vy);
    if (speed > 0.001) {
      // 模型局部 +Z 是「子弹后方」：把 +Z 对准速度反方向，拖尾自然落在身后
      BACK_DIRECTION.set(-entity.vx / speed, 0, -entity.vy / speed);
      root.quaternion.setFromUnitVectors(Z_AXIS, BACK_DIRECTION);
    }
    tracked.model.setTrail(THREE.MathUtils.clamp(speed * 0.05, 0.6, 2.6));
  }

  function setEntities(entities: readonly SceneEntityView[]): void {
    seenIds.clear();
    for (const entity of entities) {
      seenIds.add(entity.id);
      if (entity.kind === 0) syncTank(entity);
      else syncBullet(entity);
    }
    for (const [id, tracked] of tanks) {
      if (seenIds.has(id)) continue;
      tracked.model.setVisible(false);
      tankPool.push(tracked.model);
      tanks.delete(id);
    }
    for (const [id, tracked] of bullets) {
      if (seenIds.has(id)) continue;
      tracked.model.setVisible(false);
      bulletPool.push(tracked.model);
      bullets.delete(id);
    }
  }

  /* -------------------------------- 相机 -------------------------------- */

  function resolveFocusTarget(out: THREE.Vector3): void {
    const tracked = localId !== null ? tanks.get(localId) : undefined;
    if (tracked) {
      hasLastLocal = true;
      lastLocal.set(tracked.x, 0.85, tracked.y);
      out.copy(lastLocal);
      return;
    }
    // 本地坦克临时消失（死亡等待复活）时保持上一个位置，避免镜头瞬移
    if (localId !== null && hasLastLocal) {
      out.copy(lastLocal);
      return;
    }
    out.set(map.width / 2, 0.85, map.height / 2);
  }

  function updateCamera(dt: number): void {
    if (mode === 'chase' || mode === 'iso') {
      // chase / iso 都跟随本地坦克（iso 角度固定、只平移跟随）
      resolveFocusTarget(desiredFocus);
    } else {
      // 俯视固定看竞技场中心（优先保证整张地图入画），本地坦克在画面内自然可见
      desiredFocus.set(map.width / 2, 0.5, map.height / 2);
    }
    if (snapCamera) {
      focus.copy(desiredFocus);
    } else {
      focus.lerp(desiredFocus, 1 - Math.exp(-(mode === 'iso' ? 9 : 7) * dt));
    }

    // 滚轮缩放平滑趋近（top 模式固定整场取景，不使用缩放）
    if (mode !== 'top') {
      const minZoom = minZoomFor(mode);
      if (zoomTarget < minZoom) zoomTarget = minZoom;
      zoomFactor += (zoomTarget - zoomFactor) * (1 - Math.exp(-12 * dt));
      if (Math.abs(zoomTarget - zoomFactor) < 0.0005) zoomFactor = zoomTarget;
      // 模式切换/降级时兜底，保证当前帧不低于该模式的最小缩放
      if (zoomFactor < minZoom) zoomFactor = minZoom;
    }

    if (mode === 'chase' || mode === 'iso') {
      const distance = (mode === 'chase' ? chaseDistance : isoDistance) * zoomFactor;
      const sphericalPitch = currentViewPitch();
      const cosPitch = Math.cos(sphericalPitch);
      const sinPitch = Math.sin(sphericalPitch);
      // 相机放在视线方向的"后方"：相机前向水平角 = viewYaw（可直接当炮塔角使用）
      desiredPosition.set(
        focus.x - Math.cos(viewYaw) * cosPitch * distance,
        focus.y + sinPitch * distance,
        focus.z - Math.sin(viewYaw) * cosPitch * distance,
      );
    } else {
      // 近正俯视：相机位于竞技场中心正上方、向 +z 后撤一点形成轻微倾斜；
      // 只做俯仰（无 yaw），因此地图在屏幕上与世界轴对齐、不会旋转。
      const tilt = 0.22;
      const cosTilt = Math.cos(tilt);
      const sinTilt = Math.sin(tilt);
      const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov) / 2;
      const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
      const halfFov = Math.max(0.05, Math.min(verticalHalfFov, horizontalHalfFov));
      const radius = 0.5 * Math.max(map.width, map.height) + 2;
      let distance = radius / Math.tan(halfFov);
      const centerX = map.width / 2;
      const centerZ = map.height / 2;
      const targetY = 0.5;
      fitCorners[0].set(0, 1.8, 0);
      fitCorners[1].set(map.width, 1.8, 0);
      fitCorners[2].set(0, 1.8, map.height);
      fitCorners[3].set(map.width, 1.8, map.height);
      fitCamera.fov = camera.fov;
      fitCamera.aspect = camera.aspect;
      fitCamera.near = camera.near;
      fitCamera.far = camera.far;
      fitCamera.updateProjectionMatrix();
      // 倾斜取景下解析距离不直观：迭代调整距离，让地图四角刚好落在画框内（留 12% 边距）
      const fitTarget = 0.85;
      for (let iteration = 0; iteration < 6; iteration += 1) {
        fitCamera.position.set(
          centerX,
          targetY + distance * cosTilt,
          centerZ + distance * sinTilt,
        );
        fitCamera.lookAt(centerX, targetY, centerZ);
        fitCamera.updateMatrixWorld(true);
        let maxNdc = 0;
        for (const corner of fitCorners) {
          fitCorner.copy(corner).project(fitCamera);
          maxNdc = Math.max(maxNdc, Math.abs(fitCorner.x), Math.abs(fitCorner.y));
        }
        if (!Number.isFinite(maxNdc) || maxNdc <= 0) break;
        const ratio = maxNdc / fitTarget;
        if (Math.abs(ratio - 1) < 0.02) break;
        distance = THREE.MathUtils.clamp(distance * Math.pow(ratio, 0.8), 24, 320);
      }
      desiredPosition.set(
        centerX,
        targetY + distance * cosTilt,
        centerZ + distance * sinTilt,
      );
    }

    // 相机与掩体/墙体做射线夹紧（chase / iso 均生效，top 是整场视图无需处理）
    if (mode !== 'top') {
      clampCameraAgainstObstacles(focus, desiredPosition);
    }

    if (cameraYawSnap || snapCamera) {
      // setCameraYaw 的 yaw 不允许平滑延迟：当帧直接吸附到目标机位
      camera.position.copy(desiredPosition);
      cameraYawSnap = false;
    } else {
      camera.position.lerp(desiredPosition, 1 - Math.exp(-9 * dt));
    }
    if (mode === 'top') {
      camera.lookAt(focus.x, focus.y + 0.1, focus.z);
    } else {
      // 注视点前移到坦克前方：坦克落在画面下方约 1/3，屏幕中心准星指向前方可打击的地面
      camera.lookAt(
        focus.x + Math.cos(viewYaw) * cameraLead,
        CAMERA_LOOK_HEIGHT,
        focus.z + Math.sin(viewYaw) * cameraLead,
      );
    }
    snapCamera = false;
  }

  /* ------------------------------ 受伤反馈 ------------------------------ */

  function updateDamageFx(tracked: TrackedTank, dt: number): void {
    if (tracked.hp <= SMOKE_HP) {
      tracked.smokeTimer -= dt;
      if (tracked.smokeTimer <= 0) {
        tracked.smokeTimer = 0.13;
        // 从车尾发动机舱冒出
        const backX = tracked.x - Math.cos(tracked.hull) * 0.75;
        const backY = tracked.y - Math.sin(tracked.hull) * 0.75;
        fx.damageSmoke(backX, backY);
      }
    }
    if (tracked.hp <= SPARK_HP) {
      tracked.sparkTimer -= dt;
      if (tracked.sparkTimer <= 0) {
        tracked.sparkTimer = 0.22;
        fx.damageSpark(tracked.x, tracked.y);
      }
    }
  }

  /* -------------------------------- 帧循环 -------------------------------- */

  function frame(dt: number): void {
    // 掉帧/切后台时夹紧步长，避免特效与相机瞬移
    const step = Math.min(Math.max(dt, 0), 0.05);
    elapsed += step;

    if (yawInitPending && localId !== null) {
      const tracked = tanks.get(localId);
      if (tracked) {
        viewYaw = tracked.hull;
        if (!viewPitchExplicit) {
          viewPitch = mode === 'iso' ? isoPitchDefault : chasePitchDefault;
        }
        yawInitPending = false;
        snapCamera = true;
      }
    }

    updateCamera(step);

    for (const [id, tracked] of tanks) {
      tracked.model.setLocal(id === localId);
      tracked.model.update(step, tracked.signedSpeed, elapsed);
      // 接触阴影随血量变淡（存活感），血量归零则完全隐藏
      tracked.model.setContactShadow(
        tracked.hp > 0 ? 0.24 + 0.4 * (tracked.hp / 100) : 0,
      );
      updateDamageFx(tracked, step);
    }

    // 本地玩家标识：头顶 billboard + 脚下脉冲环 + 炮塔方向楔形箭头
    const localTracked = localId !== null ? tanks.get(localId) : undefined;

    // 瞄准可视化驱动源：本帧调用过 setAimDirection → 用世界角度（可 360° 无死角）；
    // 否则退回最近一次 aimFromScreen 的屏幕射线结果。
    const useDirectionThisFrame = directionUsedSinceLastFrame && lastAimCallWasDirection;
    directionUsedSinceLastFrame = false;
    if (useDirectionThisFrame) {
      useAimDirection = true;
      if (aimDirectionActive) refreshDirectionAimVisual();
      else hideAimVisuals();
    } else if (useAimDirection) {
      useAimDirection = false;
      refreshAimVisual();
    }

    if (localTracked) {
      if (localVisualSlot !== localTracked.slot) updateLocalAccent(localTracked.slot);
      const pulsePhase = (elapsed % 1.25) / 1.25;
      pulseRing.visible = true;
      pulseRing.position.set(localTracked.x, 0.045, localTracked.y);
      pulseRing.scale.setScalar(1 + pulsePhase * 0.65);
      pulseRingMaterial.opacity = 0.42 * (1 - pulsePhase);
    } else {
      pulseRing.visible = false;
      localVisualSlot = -1;
    }

    // 名字标签（每帧跟随实体位置、按屏幕恒定尺寸）
    updateNameTags();

    // 瞄准环分层 + 对准反馈（炮管与瞄准方向夹角 < 0.05 rad 时变亮收束）
    if (aimRing.visible) {
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 5);
      const aimActive = aimHasGroundPoint || (useAimDirection && aimDirectionActive);
      const aligned =
        localTracked !== undefined &&
        aimActive &&
        Math.abs(normalizeAngle(lastAimAngle - localTracked.turret)) < 0.05;
      const ringScale = (aligned ? 0.82 : 1) * aimVisualBaseScale;
      aimRing.scale.setScalar(ringScale * (1 + pulse * 0.05));
      aimInnerRing.scale.setScalar((aligned ? 0.9 : 1) * (1 + pulse * 0.1) * aimVisualBaseScale);
      aimDot.scale.setScalar((aligned ? 1.25 : 1 + pulse * 0.1) * aimVisualBaseScale);
      aimRingMaterial.opacity = (aligned ? 0.55 : 0.28) + pulse * 0.12;
      aimInnerMaterial.opacity = (aligned ? 0.85 : 0.5) + pulse * 0.12;
      aimDotMaterial.opacity = aligned ? 0.9 : 0.45 + pulse * 0.16;
    }

    updateTrackMarks(step);
    fx.update(step);
    environment.update(step, camera);

    renderer.info.reset();
    post.render(step);
    samplePerformance(dt);
  }

  /* ------------------------------ 瞄准 / 交互 ------------------------------ */

  function aimFromScreen(nx: number, ny: number): number | null {
    useAimDirection = false;
    directionUsedSinceLastFrame = false;
    lastAimCallWasDirection = false;
    NDC.set(THREE.MathUtils.clamp(nx, -1, 1), THREE.MathUtils.clamp(ny, -1, 1));
    raycaster.setFromCamera(NDC, camera);

    // 1) 优先用与 y=0 地面的交点：iso / 低仰角下屏幕绝大部分区域都能命中
    if (raycaster.ray.intersectPlane(GROUND_PLANE, AIM_POINT)) {
      aimPoint.set(AIM_POINT.x, 0, AIM_POINT.z);
      aimHasGroundPoint = true;
      const angle = Math.atan2(AIM_POINT.z, AIM_POINT.x);
      lastAimAngle = angle;
      refreshAimVisual();
      return angle;
    }

    // 2) 指向天空/地平线以上：退化为射线方向的水平投影（屏幕上任意位置都有稳定角度）
    aimHasGroundPoint = false;
    const direction = raycaster.ray.direction;
    const horizontal = Math.hypot(direction.x, direction.z);
    if (horizontal < 1e-4) return null;
    const angle = Math.atan2(direction.z, direction.x);
    lastAimAngle = angle;
    refreshAimVisual();
    return angle;
  }

  /** 把瞄准环/内环/中心点放到世界坐标 (x, z)，并从真实炮口尖端画分段虚线过去。 */
  function placeAimVisuals(x: number, z: number): void {
    // 距离越远环越远，按相机距离做轻微缩放，保证屏幕上的可读性（距离本身仍然跟随准星地面点）。
    const cameraDistance = camera.position.distanceTo(AIM_SCALE_TMP.set(x, 0, z));
    aimVisualBaseScale = THREE.MathUtils.clamp(cameraDistance / 16, 1, 2.2);
    aimRing.scale.setScalar(aimVisualBaseScale);
    aimInnerRing.scale.setScalar(aimVisualBaseScale);
    aimDot.scale.setScalar(aimVisualBaseScale);
    aimRing.position.set(x, 0.05, z);
    aimInnerRing.position.set(x, 0.052, z);
    aimDot.position.set(x, 0.055, z);
    aimRing.visible = true;
    aimInnerRing.visible = true;
    aimDot.visible = true;

    const tracked = localId !== null ? tanks.get(localId) : undefined;
    if (!tracked) {
      aimLine.visible = false;
      return;
    }
    tracked.model.turret.updateWorldMatrix(true, false);
    muzzleWorld.copy(MUZZLE_LOCAL).applyMatrix4(tracked.model.turret.matrixWorld);
    const positions = aimLinePositions.array as Float32Array;
    for (let dash = 0; dash < AIM_LINE_DASHES; dash += 1) {
      const startT = dash / AIM_LINE_DASHES;
      const endT = startT + 0.55 / AIM_LINE_DASHES;
      const offset = dash * 6;
      positions[offset] = muzzleWorld.x + (x - muzzleWorld.x) * startT;
      positions[offset + 1] = muzzleWorld.y + (0.06 - muzzleWorld.y) * startT;
      positions[offset + 2] = muzzleWorld.z + (z - muzzleWorld.z) * startT;
      positions[offset + 3] = muzzleWorld.x + (x - muzzleWorld.x) * endT;
      positions[offset + 4] = muzzleWorld.y + (0.06 - muzzleWorld.y) * endT;
      positions[offset + 5] = muzzleWorld.z + (z - muzzleWorld.z) * endT;
    }
    aimLinePositions.needsUpdate = true;
    aimLine.visible = true;
  }

  function hideAimVisuals(): void {
    aimRing.visible = false;
    aimInnerRing.visible = false;
    aimDot.visible = false;
    aimLine.visible = false;
  }

  /** 根据最近一次 aimFromScreen 的结果刷新瞄准环 / 炮口虚线。 */
  function refreshAimVisual(): void {
    // 屏幕射线驱动时，覆盖掉 direction 模式（以最近一次调用为准）
    useAimDirection = false;
    if (!aimHasGroundPoint) {
      hideAimVisuals();
      return;
    }
    // 环贴在竞技场地面内，避免屏幕边缘瞄到很远时环飞出地图
    const x = THREE.MathUtils.clamp(aimPoint.x, 0.6, map.width - 0.6);
    const z = THREE.MathUtils.clamp(aimPoint.z, 0.6, map.height - 0.6);
    placeAimVisuals(x, z);
  }

  /**
   * 外部世界角度驱动瞄准可视化：环放在坦克沿该方向 10 单位的地面处，
   * 虚线从炮口连过去，朝向楔形按同一角度旋转。null 时隐藏。
   */
  function refreshDirectionAimVisual(): void {
    if (!aimDirectionActive) {
      hideAimVisuals();
      return;
    }
    const tracked = localId !== null ? tanks.get(localId) : undefined;
    if (!tracked) {
      hideAimVisuals();
      return;
    }
    // 瞄准环 = 准星正下方的地面交点（可能落在场地外），距离随视角俯仰/地形变化，绝不夹到固定位置。
    const x = aimDirectionHasPoint
      ? aimDirectionPointX
      : tracked.x + Math.cos(aimDirectionAngle) * 10;
    const z = aimDirectionHasPoint
      ? aimDirectionPointZ
      : tracked.y + Math.sin(aimDirectionAngle) * 10;
    placeAimVisuals(x, z);
  }

  function orbit(dx: number, dy: number): void {
    // chase / iso 都是可旋转轨道相机；top 是固定整场视图
    if (mode === 'top') return;
    viewYaw -= dx * 0.005;
    applyViewPitch(currentViewPitch() - dy * 0.004);
    // 用户已经手动转过视角，本地车出现时不再自动摆位
    yawInitPending = false;
    snapCamera = false;
  }

  function zoomBy(delta: number): void {
    if (!Number.isFinite(delta)) return;
    // top 模式是固定整场视图，忽略缩放
    if (mode === 'top') return;
    // delta 正数（滚轮向下）= 拉远、负数 = 拉近；指数累计让不同 delta 下缩放节奏一致。
    // 最小缩放按相机模式限制：chase 不小于 0.82x（避免镜头贴地/穿掩体），iso 不小于 0.5x。
    const minZoom = minZoomFor(mode);
    zoomTarget = THREE.MathUtils.clamp(zoomTarget * Math.exp(delta * 0.0012), minZoom, 1.6);
  }

  function setCameraMode(next: TankCameraMode): void {
    if (mode === next) return;
    mode = next;
    if (next !== 'top') {
      // 切模式保留缩放，但不能低于该模式的最小缩放
      zoomTarget = Math.max(zoomTarget, minZoomFor(next));
      zoomFactor = Math.max(zoomFactor, minZoomFor(next));
      if (!viewPitchExplicit) {
        viewPitch = next === 'iso' ? isoPitchDefault : chasePitchDefault;
      }
    }
    snapCamera = true;
  }

  /** 直接设置相机视线方位角（立即生效，同一帧 getCameraYaw 即等于传入值）。 */
  function setCameraYaw(yaw: number, pitch?: number): void {
    if (!Number.isFinite(yaw)) return;
    // top 是固定整场视图，忽略
    if (mode === 'top') return;
    viewYaw = yaw; // 不夹紧、不归一化：允许任意弧度与累加 360°
    if (pitch !== undefined && Number.isFinite(pitch)) applyViewPitch(pitch);
    cameraYawSnap = true;
    yawInitPending = false;
  }

  /** 当前相机仰角（弧度）；top 模式返回实际俯仰。 */
  function getCameraPitch(): number {
    if (mode !== 'top') return currentViewPitch();
    camera.getWorldDirection(CAMERA_FORWARD);
    return Math.asin(THREE.MathUtils.clamp(-CAMERA_FORWARD.y, -1, 1));
  }

  /**
   * 相机前向的水平世界角度；chase / iso 下直接返回 viewYaw（与 setCameraYaw 立即一致，
   * 无平滑延迟，可直接作为炮塔角）；top 下返回实际相机朝向。
   */
  function getCameraYaw(): number {
    if (mode !== 'top') return viewYaw;
    camera.getWorldDirection(CAMERA_FORWARD);
    const horizontal = Math.hypot(CAMERA_FORWARD.x, CAMERA_FORWARD.z);
    if (horizontal < 1e-5) return 0;
    return Math.atan2(CAMERA_FORWARD.z, CAMERA_FORWARD.x);
  }

  /** 世界平面坐标 → NDC（以车体中心高度 0.8 投影，坦克在屏幕中心时返回接近 (0,0)）。 */
  function worldToScreen(x: number, y: number): { x: number; y: number } {
    worldToScreenPoint.set(x, 0.8, y).project(camera);
    return { x: worldToScreenPoint.x, y: worldToScreenPoint.y };
  }

  /**
   * 外部世界角度驱动瞄准可视化：角度不夹紧（任意弧度均有效），
   * 环放在坦克沿该方向 10 单位处；null 隐藏。以最近一次 setAimDirection / aimFromScreen 为准。
   */
  function setAimDirection(
    angle: number | null,
    point?: { x: number; y: number } | null,
  ): void {
    useAimDirection = true;
    directionUsedSinceLastFrame = true;
    lastAimCallWasDirection = true;
    if (angle === null || !Number.isFinite(angle)) {
      aimDirectionActive = false;
      aimDirectionHasPoint = false;
      hideAimVisuals();
      return;
    }
    aimDirectionActive = true;
    aimDirectionAngle = angle;
    lastAimAngle = normalizeAngle(angle);
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      aimDirectionHasPoint = true;
      aimDirectionPointX = point.x;
      aimDirectionPointZ = point.y;
    } else {
      aimDirectionHasPoint = false;
    }
    refreshDirectionAimVisual();
  }

  /** 屏幕 NDC → y=0 地面交点世界坐标（纯查询，不改变瞄准状态）。 */
  function groundPointFromScreen(nx: number, ny: number): { x: number; y: number } | null {
    NDC.set(THREE.MathUtils.clamp(nx, -1, 1), THREE.MathUtils.clamp(ny, -1, 1));
    raycaster.setFromCamera(NDC, camera);
    if (!raycaster.ray.intersectPlane(GROUND_PLANE, groundQueryPoint)) return null;
    return { x: groundQueryPoint.x, y: groundQueryPoint.z };
  }

  function emit(event: SceneFxEvent): void {
    switch (event.type) {
      case 'muzzle':
        fx.muzzle(event.x, event.y, event.angle);
        break;
      case 'hit':
        fx.hit(event.x, event.y);
        break;
      case 'impact':
        fx.impact(event.x, event.y, environment.getSurfaceAt(event.x, event.y));
        break;
      case 'kill':
        fx.kill(event.x, event.y);
        break;
    }
  }

  /* -------------------------------- 生命周期 -------------------------------- */

  function setMap(next: TankMap): void {
    map = next;
    environment.setMap(next);
    fx.setMapBounds(next.width || 48, next.height || 48);
    // 换图视为新一局：回收旧实体，避免残留位置
    for (const tracked of tanks.values()) tracked.model.setVisible(false);
    for (const tracked of bullets.values()) tracked.model.setVisible(false);
    tanks.clear();
    bullets.clear();
    tankPool.length = 0;
    bulletPool.length = 0;
    hasLastLocal = false;
    snapCamera = true;
  }

  function setLocal(entityId: number | null): void {
    localId = entityId;
    yawInitPending = entityId !== null;
    snapCamera = true;
  }

  function resize(): void {
    const cssWidth = canvas.clientWidth || canvas.width || 1;
    const cssHeight = canvas.clientHeight || canvas.height || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
    renderer.setSize(cssWidth, cssHeight, false);
    camera.aspect = cssWidth / cssHeight;
    camera.updateProjectionMatrix();
    renderer.getDrawingBufferSize(DRAWING_BUFFER_SIZE);
    // 点精灵像素尺寸 = 世界尺寸 * 高度/(2tan(fov/2)) / 距离
    fx.setScreenScale(
      DRAWING_BUFFER_SIZE.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)),
    );
    // 后处理链同步尺寸与像素比（Bloom 缓冲由 pass 内部按半分辨率维护）
    post.setSize(cssWidth, cssHeight, renderer.getPixelRatio());
  }

  function dispose(): void {
    for (const tracked of tanks.values()) tracked.model.setVisible(false);
    for (const tracked of bullets.values()) tracked.model.setVisible(false);
    tanks.clear();
    bullets.clear();
    tankPool.length = 0;
    bulletPool.length = 0;

    trackMarkGeometry.dispose();
    trackMarkMaterial.dispose();
    trackMarkTexture.dispose();
    scene.remove(trackMarkMesh);
    aimRingGeometry.dispose();
    aimInnerRingGeometry.dispose();
    aimDotGeometry.dispose();
    aimRingMaterial.dispose();
    aimInnerMaterial.dispose();
    aimDotMaterial.dispose();
    aimLineGeometry.dispose();
    aimLineMaterial.dispose();
    pulseRingGeometry.dispose();
    pulseRingMaterial.dispose();
    for (const sprite of nameTagSprites.values()) scene.remove(sprite);
    for (const sprite of nameTagPool) scene.remove(sprite);
    nameTagSprites.clear();
    nameTagPool.length = 0;
    nameTagStates.clear();
    for (const material of nameTagMaterialCache.values()) material.dispose();
    nameTagMaterialCache.clear();
    for (const texture of nameTagTextureCache.values()) texture.dispose();
    nameTagTextureCache.clear();
    scene.remove(
      aimRing,
      aimInnerRing,
      aimDot,
      aimLine,
      pulseRing,
    );

    post.dispose();
    fx.dispose();
    environment.dispose();
    models.dispose();
    duskEnvironment.dispose();
    scene.environment = null;
    scene.clear();
    renderer.dispose();
    try {
      renderer.forceContextLoss();
    } catch {
      // 上下文已丢失时无需处理
    }
  }

  function debugTurretDirection(): number | null {
    const tracked = localId !== null ? tanks.get(localId) : undefined;
    if (!tracked) return null;
    tracked.model.turret.updateWorldMatrix(true, false);
    const direction = new THREE.Vector3(1, 0, 0).transformDirection(tracked.model.turret.matrixWorld);
    return Math.atan2(direction.z, direction.x);
  }

  function debugBarrelScreen(): {
    tank: { x: number; y: number };
    tip: { x: number; y: number };
    aim: { x: number; y: number } | null;
  } | null {
    const tracked = localId !== null ? tanks.get(localId) : undefined;
    if (!tracked) return null;
    tracked.model.turret.updateWorldMatrix(true, false);
    const turretMatrix = tracked.model.turret.matrixWorld;
    const tipWorld = new THREE.Vector3(2.82, 0.2, 0).applyMatrix4(turretMatrix);
    const tankWorld = new THREE.Vector3(tracked.x, 0.9, tracked.y);
    const project = (point: THREE.Vector3): { x: number; y: number } => {
      const ndc = point.clone().project(camera);
      return { x: ndc.x, y: ndc.y };
    };
    const direction = debugTurretDirection() ?? tracked.hull;
    const aimWorld = new THREE.Vector3(
      tracked.x + Math.cos(direction) * 10,
      0.05,
      tracked.y + Math.sin(direction) * 10,
    );
    return {
      tank: project(tankWorld),
      tip: project(tipWorld),
      aim: project(aimWorld),
    };
  }

  function debugStats(): TankDebugStats {
    return {
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      bloom: post.isBloomEnabled(),
      shadowMapSize: environment.getShadowMapSize(),
      averageFrameMs,
      degraded,
    };
  }

  // 初始化尺寸后返回，调用方仍需在布局变化时自行调用 resize()
  resize();
  // 先摆一次相机，保证首帧前 getCameraYaw() / aimFromScreen() 已可用
  updateCamera(0.016);

  return {
    setMap,
    setLocal,
    setEntities,
    frame,
    aimFromScreen,
    orbit,
    setCameraMode,
    zoomBy,
    getCameraYaw,
    getCameraPitch,
    setCameraYaw,
    worldToScreen,
    groundPointFromScreen,
    setAimDirection,
    setNameTags,
    emit,
    resize,
    dispose,
    debugStats,
    debugTurretDirection,
    debugBarrelScreen,
  };
}
