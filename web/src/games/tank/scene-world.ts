/**
 * 坦克战场的「世界资产」：工业地坪、光照/雾之外的静态环境（边界矮墙、掩体、出生点标记），
 * 以及完全程序化的坦克 / 子弹模型工厂（不加载任何外部模型资源）。
 *
 * 坐标约定：世界平面坐标 (x, y) → three 的 (x, 0, y)（即世界 y 轴对应 three 的 z 轴）。
 * 世界角度 0 指向 +x、逆时针为正；three 绕 Y 轴旋转会把局部 +X 转向 -Z，
 * 因此「世界角度 → three 旋转」一律取 -angle（炮塔局部旋转为 hull - turret）。
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TANK_COLORS } from './palette';
import { DUSK } from './scene-post';

/* ------------------------------- 地图数据类型 ------------------------------- */

/** 轴对齐矩形掩体：x/y 是最小角（与服务端 Obstacle 的左上角语义一致），w/h 是尺寸。 */
export interface TankObstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TankSpawn {
  x: number;
  y: number;
}

/**
 * 渲染层需要的地图字段；与 `web/src/types.ts` 的 TankMap 结构兼容（那边多出的字段会被忽略），
 * spawns / theme 允许缺省，方便用默认地图先渲染再等房间信息。
 */
export interface TankMap {
  width: number;
  height: number;
  obstacles: readonly TankObstacle[];
  spawns?: readonly TankSpawn[];
  theme?: string;
}

export const DEFAULT_MAP: TankMap = { width: 48, height: 48, obstacles: [], spawns: [] };

/** 一个「地图单位」对应的地坪贴图像素：8 个世界单位铺一张 512px 的重复贴图。 */
const FLOOR_TEXTURE_UNITS = 8;

/* --------------------------------- 工具函数 --------------------------------- */

interface DisposableResource {
  dispose(): void;
}

/** 确定性伪随机（同一张地图每次渲染的钢板纹理一致，避免闪烁感）。 */
function hash2(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function clampSlot(slot: number): number {
  if (!Number.isFinite(slot)) return 0;
  return Math.min(Math.max(Math.trunc(slot), 0), TANK_COLORS.length - 1);
}

/** 地坪色/粗糙度贴图对：程序化沥青（湿斑、裂纹、碎石、旧网格线）。 */
interface AsphaltTextures {
  color: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
}

/**
 * 程序生成沥青地坪的「颜色 + 粗糙度」双贴图。
 * 同一张 8×8 世界单位的贴图平铺；湿斑在两张贴图上用同一组参数绘制，
 * 因此湿处颜色更深、粗糙度更低（更亮的高光反射），与 PMREM 环境反射配合出湿地效果。
 */
function makeAsphaltTextures(renderer: THREE.WebGLRenderer): AsphaltTextures {
  const size = 512;
  const units = FLOOR_TEXTURE_UNITS;
  const cell = size / units;

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = size;
  colorCanvas.height = size;
  const colorCtx = colorCanvas.getContext('2d');
  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = size;
  roughCanvas.height = size;
  const roughCtx = roughCanvas.getContext('2d');
  if (!colorCtx || !roughCtx) throw new Error('无法创建沥青贴图：Canvas 2D 上下文不可用');

  // 底色：冷调沥青/水泥地
  colorCtx.fillStyle = '#4a555d';
  colorCtx.fillRect(0, 0, size, size);
  // 粗糙度底色：整体偏粗糙（白 = rough）
  roughCtx.fillStyle = '#e2e2e2';
  roughCtx.fillRect(0, 0, size, size);

  // 骨料颗粒：确定性散点，颜色与粗糙度各自微扰
  for (let index = 0; index < 2600; index += 1) {
    const x = hash2(index * 1.37, 0.71) * size;
    const y = hash2(0.29, index * 2.11) * size;
    const grain = hash2(index * 0.53, index * 1.19);
    const radius = 0.6 + grain * 1.6;
    colorCtx.fillStyle = grain > 0.55 ? 'rgba(150, 163, 176, 0.10)' : 'rgba(0, 0, 0, 0.18)';
    colorCtx.fillRect(x, y, radius, radius);
    roughCtx.fillStyle = grain > 0.5 ? 'rgba(255, 255, 255, 0.25)' : 'rgba(120, 120, 120, 0.35)';
    roughCtx.fillRect(x, y, radius, radius);
  }

  // 斑驳色块：大尺度明暗/苔绿差异，让地面不再像纯色塑料
  const mottleColors = ['rgba(28, 34, 38, 0.1)', 'rgba(150, 160, 168, 0.08)', 'rgba(70, 82, 62, 0.08)'];
  for (let index = 0; index < 14; index += 1) {
    const cx = hash2(index * 1.37, 6.1) * size;
    const cy = hash2(2.7, index * 1.9) * size;
    const rx = 30 + hash2(index, 4.9) * 90;
    const ry = 24 + hash2(8.3, index) * 70;
    const rotation = hash2(index * 2.1, 5.3) * Math.PI;
    colorCtx.save();
    colorCtx.translate(cx, cy);
    colorCtx.rotate(rotation);
    const gradient = colorCtx.createRadialGradient(0, 0, 0, 0, 0, rx);
    const mottle = mottleColors[index % mottleColors.length] ?? mottleColors[0];
    gradient.addColorStop(0, mottle);
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    colorCtx.fillStyle = gradient;
    colorCtx.beginPath();
    colorCtx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    colorCtx.fill();
    colorCtx.restore();
  }

  // 轮胎压痕：成对的深色曲线（坦克/车辆走过留下的痕迹）
  colorCtx.lineCap = 'round';
  for (let track = 0; track < 1; track += 1) {
    const startX = hash2(track * 3.3, 1.1) * size;
    const startY = hash2(4.7, track * 2.3) * size;
    const controlX = hash2(track * 1.7, 7.3) * size;
    const controlY = hash2(8.9, track * 1.3) * size;
    const endX = hash2(track * 2.9, 3.7) * size;
    const endY = hash2(6.1, track * 4.1) * size;
    for (const offset of [-0.28, 0.28]) {
      colorCtx.strokeStyle = 'rgba(26, 30, 33, 0.06)';
      colorCtx.lineWidth = 4;
      colorCtx.beginPath();
      colorCtx.moveTo(startX + offset * size * 0.02, startY);
      colorCtx.quadraticCurveTo(
        controlX + offset * size * 0.02,
        controlY,
        endX + offset * size * 0.02,
        endY,
      );
      colorCtx.stroke();
      roughCtx.strokeStyle = 'rgba(150, 150, 150, 0.16)';
      roughCtx.lineWidth = 4;
      roughCtx.beginPath();
      roughCtx.moveTo(startX + offset * size * 0.02, startY);
      roughCtx.quadraticCurveTo(
        controlX + offset * size * 0.02,
        controlY,
        endX + offset * size * 0.02,
        endY,
      );
      roughCtx.stroke();
    }
  }

  // 油渍：深色不规则斑块 + 更光滑（低粗糙度）
  for (let index = 0; index < 5; index += 1) {
    const cx = hash2(index * 4.1, 2.3) * size;
    const cy = hash2(1.7, index * 5.9) * size;
    const rx = 14 + hash2(index, 3.3) * 34;
    const ry = 10 + hash2(6.7, index) * 26;
    const gradient = colorCtx.createRadialGradient(cx, cy, 0, cx, cy, rx);
    gradient.addColorStop(0, 'rgba(14, 16, 18, 0.42)');
    gradient.addColorStop(0.75, 'rgba(14, 16, 18, 0.16)');
    gradient.addColorStop(1, 'rgba(14, 16, 18, 0)');
    colorCtx.fillStyle = gradient;
    colorCtx.beginPath();
    colorCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    colorCtx.fill();
    const roughGradient = roughCtx.createRadialGradient(cx, cy, 0, cx, cy, rx);
    roughGradient.addColorStop(0, 'rgba(40, 40, 40, 0.85)');
    roughGradient.addColorStop(1, 'rgba(226, 226, 226, 0)');
    roughCtx.fillStyle = roughGradient;
    roughCtx.beginPath();
    roughCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    roughCtx.fill();
  }

  // 湿斑：颜色压暗、粗糙度显著降低（配合环境反射形成湿亮反光）
  const puddles = 5;
  for (let index = 0; index < puddles; index += 1) {
    const cx = hash2(index * 3.1, 1.7) * size;
    const cy = hash2(5.3, index * 2.9) * size;
    const rx = 20 + hash2(index, 9.1) * 40;
    const ry = 14 + hash2(7.7, index) * 30;
    const rotation = hash2(index * 1.9, 4.2) * Math.PI;
    colorCtx.save();
    colorCtx.translate(cx, cy);
    colorCtx.rotate(rotation);
    const colorGradient = colorCtx.createRadialGradient(0, 0, 0, 0, 0, rx);
    colorGradient.addColorStop(0, 'rgba(132, 152, 172, 0.13)');
    colorGradient.addColorStop(0.7, 'rgba(132, 152, 172, 0.06)');
    colorGradient.addColorStop(1, 'rgba(132, 152, 172, 0)');
    colorCtx.fillStyle = colorGradient;
    colorCtx.beginPath();
    colorCtx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    colorCtx.fill();
    colorCtx.restore();

    roughCtx.save();
    roughCtx.translate(cx, cy);
    roughCtx.rotate(rotation);
    const roughGradient = roughCtx.createRadialGradient(0, 0, 0, 0, 0, rx);
    roughGradient.addColorStop(0, 'rgba(64, 64, 64, 0.9)');
    roughGradient.addColorStop(0.75, 'rgba(120, 120, 120, 0.55)');
    roughGradient.addColorStop(1, 'rgba(226, 226, 226, 0)');
    roughCtx.fillStyle = roughGradient;
    roughCtx.beginPath();
    roughCtx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    roughCtx.fill();
    roughCtx.restore();
  }

  // 裂纹：深色细折线（颜色） + 略粗糙（粗糙度）
  for (let index = 0; index < 4; index += 1) {
    let x = hash2(index * 2.2, 8.1) * size;
    let y = hash2(4.9, index * 1.7) * size;
    colorCtx.strokeStyle = 'rgba(8, 11, 15, 0.22)';
    colorCtx.lineWidth = 1;
    colorCtx.beginPath();
    colorCtx.moveTo(x, y);
    for (let step = 0; step < 5; step += 1) {
      x += (hash2(index + step * 0.7, 9.3) - 0.5) * 90;
      y += (hash2(6.1, index + step * 1.3) - 0.5) * 70;
      colorCtx.lineTo(x, y);
    }
    colorCtx.stroke();

    roughCtx.strokeStyle = 'rgba(160, 160, 160, 0.6)';
    roughCtx.lineWidth = 1.2;
    roughCtx.beginPath();
    roughCtx.moveTo(x, y);
    roughCtx.lineTo(x + 8, y + 4);
    roughCtx.stroke();
  }

  // 旧工业网格线（每 1 世界单位细线、每 4 单位主线）
  colorCtx.strokeStyle = 'rgba(150, 178, 200, 0.045)';
  colorCtx.lineWidth = 1;
  for (let i = 0; i <= units; i += 1) {
    const p = i * cell + 0.5;
    colorCtx.beginPath();
    colorCtx.moveTo(p, 0);
    colorCtx.lineTo(p, size);
    colorCtx.stroke();
    colorCtx.beginPath();
    colorCtx.moveTo(0, p);
    colorCtx.lineTo(size, p);
    colorCtx.stroke();
  }
  colorCtx.strokeStyle = 'rgba(170, 200, 225, 0.1)';
  colorCtx.lineWidth = 2;
  for (let i = 0; i <= units; i += 4) {
    const p = i * cell + 0.5;
    colorCtx.beginPath();
    colorCtx.moveTo(p, 0);
    colorCtx.lineTo(p, size);
    colorCtx.stroke();
    colorCtx.beginPath();
    colorCtx.moveTo(0, p);
    colorCtx.lineTo(size, p);
    colorCtx.stroke();
  }

  const anisotropy = Math.min(16, Math.max(1, renderer.capabilities.getMaxAnisotropy()));
  const color = new THREE.CanvasTexture(colorCanvas);
  color.wrapS = THREE.RepeatWrapping;
  color.wrapT = THREE.RepeatWrapping;
  color.colorSpace = THREE.SRGBColorSpace;
  color.anisotropy = anisotropy;
  const roughness = new THREE.CanvasTexture(roughCanvas);
  roughness.wrapS = THREE.RepeatWrapping;
  roughness.wrapT = THREE.RepeatWrapping;
  roughness.anisotropy = anisotropy;
  return { color, roughness };
}

/** 接触阴影贴图：柔和的径向黑斑（贴在坦克脚下，补足 shadow map 的「落地感」）。 */
function makeContactShadowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建接触阴影贴图：Canvas 2D 上下文不可用');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0.92)');
  gradient.addColorStop(0.45, 'rgba(255, 255, 255, 0.55)');
  gradient.addColorStop(0.8, 'rgba(255, 255, 255, 0.14)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/** 履带贴图：链节 + 销轴 + 锈迹，随速度滚动 uv 偏移（每辆坦克独立，避免互相干扰）。 */
function makeTrackTexture(): THREE.CanvasTexture {
  const width = 128;
  const height = 64;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建履带贴图：Canvas 2D 上下文不可用');

  // 深色链节底色
  ctx.fillStyle = '#3d3f42';
  ctx.fillRect(0, 0, width, height);

  // 链节：沿 u 方向一块块金属板，中间留缝
  const linkCount = 5;
  const linkWidth = width / linkCount;
  for (let index = 0; index < linkCount; index += 1) {
    const x = index * linkWidth;
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#5a5c5e');
    gradient.addColorStop(0.25, '#6c6e70');
    gradient.addColorStop(0.65, '#4a4c4e');
    gradient.addColorStop(1, '#333537');
    ctx.fillStyle = gradient;
    ctx.fillRect(x + 2, 2, linkWidth - 5, height - 4);
    // 链节中间的加强筋
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fillRect(x + linkWidth * 0.32, 4, linkWidth * 0.36, height - 8);
    // 销轴孔
    ctx.fillStyle = '#15171a';
    ctx.beginPath();
    ctx.arc(x + linkWidth / 2, height / 2, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(200, 210, 220, 0.25)';
    ctx.fillRect(x + 3, height * 0.2, linkWidth - 8, 2);
  }

  // 锈迹与泥污
  for (let index = 0; index < 90; index += 1) {
    const x = hash2(index * 1.3, 2.7) * width;
    const y = hash2(4.9, index * 1.9) * height;
    const size = 1 + hash2(index, 8.1) * 5;
    ctx.fillStyle = hash2(index, 3.1) > 0.55 ? 'rgba(122, 82, 52, 0.32)' : 'rgba(28, 26, 24, 0.35)';
    ctx.fillRect(x, y, size, size);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2.4, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/* --------------------------- 掩体程序化贴图 --------------------------- */

/** 一组 PBR 贴图（颜色 / 凹凸 / 粗糙度），全部程序化生成。 */
interface SurfaceTextures {
  map: THREE.CanvasTexture;
  bump: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
}

function createCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建程序化贴图：Canvas 2D 上下文不可用');
  return { canvas, ctx };
}

function finishTexture(canvas: HTMLCanvasElement, srgb: boolean, anisotropy: number): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

/** 砖砌仓库墙面：砖缝、砖块色差、雨渍与磨损，附带凹凸/粗糙度。 */
function makeBrickTextures(anisotropy: number): SurfaceTextures {
  const size = 256;
  const { canvas, ctx } = createCanvas(size);
  const { canvas: bumpCanvas, ctx: bumpCtx } = createCanvas(size);
  const { canvas: roughCanvas, ctx: roughCtx } = createCanvas(size);

  // 砖块尺寸：64×16 px（贴图世界尺寸 1.6m × 0.8m）
  ctx.fillStyle = '#6a5f53';
  ctx.fillRect(0, 0, size, size);
  bumpCtx.fillStyle = '#4a4a4a';
  bumpCtx.fillRect(0, 0, size, size);
  roughCtx.fillStyle = '#e8e8e8';
  roughCtx.fillRect(0, 0, size, size);

  const brickW = 64;
  const brickH = 16;
  const brickColors = ['#8a5643', '#7c4b3a', '#96654c', '#74463a', '#8f5b45', '#684238'];
  for (let row = 0; row < size / brickH; row += 1) {
    const offset = row % 2 === 0 ? 0 : brickW / 2;
    for (let col = -1; col < size / brickW + 1; col += 1) {
      const x = col * brickW + offset;
      const y = row * brickH;
      const seed = row * 31 + col * 17;
      const color = brickColors[Math.floor(hash2(seed, 3.7) * brickColors.length) % brickColors.length] ?? brickColors[0];
      ctx.fillStyle = color;
      ctx.fillRect(x + 1, y + 1, brickW - 2, brickH - 2);
      ctx.fillStyle = `rgba(0, 0, 0, ${0.05 + hash2(seed, 7.1) * 0.14})`;
      ctx.fillRect(x + 1, y + brickH - 5, brickW - 2, 4);
      ctx.fillStyle = `rgba(255, 235, 210, ${0.03 + hash2(seed, 1.3) * 0.06})`;
      ctx.fillRect(x + 1, y + 1, brickW - 2, 2);
      bumpCtx.fillStyle = `rgba(220, 220, 220, ${0.75 + hash2(seed, 5.5) * 0.2})`;
      bumpCtx.fillRect(x + 2, y + 2, brickW - 4, brickH - 4);
      roughCtx.fillStyle = '#b8b8b8';
      roughCtx.fillRect(x + 2, y + 2, brickW - 4, brickH - 4);
      if (hash2(seed, 9.9) > 0.72) {
        const stain = ctx.createLinearGradient(x, y, x, y + brickH * 2.2);
        stain.addColorStop(0, 'rgba(28, 30, 30, 0.24)');
        stain.addColorStop(1, 'rgba(28, 30, 30, 0)');
        ctx.fillStyle = stain;
        ctx.fillRect(x + 2, y, brickW - 4, brickH * 2.2);
      }
    }
  }
  for (let index = 0; index < 1200; index += 1) {
    const x = hash2(index * 1.7, 2.3) * size;
    const y = hash2(4.1, index * 0.9) * size;
    ctx.fillStyle = hash2(index, 5.9) > 0.5 ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.04)';
    ctx.fillRect(x, y, 2, 2);
    bumpCtx.fillStyle = 'rgba(0, 0, 0, 0.05)';
    bumpCtx.fillRect(x, y, 2, 2);
  }

  return {
    map: finishTexture(canvas, true, anisotropy),
    bump: finishTexture(bumpCanvas, false, anisotropy),
    roughness: finishTexture(roughCanvas, false, anisotropy),
  };
}

/** 集装箱：竖向瓦楞 + 掉漆/锈迹，贴图偏亮灰以便用材质颜色染色。 */
function makeContainerTextures(anisotropy: number): SurfaceTextures {
  const size = 256;
  const { canvas, ctx } = createCanvas(size);
  const { canvas: bumpCanvas, ctx: bumpCtx } = createCanvas(size);
  const { canvas: roughCanvas, ctx: roughCtx } = createCanvas(size);

  ctx.fillStyle = '#c3c8cc';
  ctx.fillRect(0, 0, size, size);
  bumpCtx.fillStyle = '#808080';
  bumpCtx.fillRect(0, 0, size, size);
  roughCtx.fillStyle = '#9a9a9a';
  roughCtx.fillRect(0, 0, size, size);

  const rib = 16;
  for (let x = 0; x < size; x += rib) {
    const gradient = ctx.createLinearGradient(x, 0, x + rib, 0);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.16)');
    gradient.addColorStop(0.35, 'rgba(255, 255, 255, 0.03)');
    gradient.addColorStop(0.55, 'rgba(0, 0, 0, 0.18)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0.04)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x, 0, rib, size);
    const bumpGradient = bumpCtx.createLinearGradient(x, 0, x + rib, 0);
    bumpGradient.addColorStop(0, 'rgba(255, 255, 255, 0.5)');
    bumpGradient.addColorStop(0.5, 'rgba(0, 0, 0, 0.5)');
    bumpGradient.addColorStop(1, 'rgba(255, 255, 255, 0.35)');
    bumpCtx.fillStyle = bumpGradient;
    bumpCtx.fillRect(x, 0, rib, size);
  }
  for (let index = 0; index < 90; index += 1) {
    const x = hash2(index * 2.7, 1.9) * size;
    const y = hash2(3.3, index * 1.4) * size;
    const w = 2 + hash2(index, 7.3) * 8;
    const h = 4 + hash2(9.1, index) * 26;
    ctx.fillStyle = hash2(index, 2.2) > 0.4 ? 'rgba(120, 74, 48, 0.28)' : 'rgba(70, 78, 82, 0.22)';
    ctx.fillRect(x, y, w, h);
  }
  const grime = ctx.createLinearGradient(0, size, 0, size * 0.55);
  grime.addColorStop(0, 'rgba(40, 44, 42, 0.5)');
  grime.addColorStop(1, 'rgba(40, 44, 42, 0)');
  ctx.fillStyle = grime;
  ctx.fillRect(0, 0, size, size);
  roughCtx.fillStyle = 'rgba(230, 230, 230, 0.55)';
  roughCtx.fillRect(0, size * 0.55, size, size * 0.45);

  return {
    map: finishTexture(canvas, true, anisotropy),
    bump: finishTexture(bumpCanvas, false, anisotropy),
    roughness: finishTexture(roughCanvas, false, anisotropy),
  };
}

/** 沙袋矮墙：麻布颗粒 + 缝线，偏暖沙色。 */
function makeSandbagTextures(anisotropy: number): SurfaceTextures {
  const size = 128;
  const { canvas, ctx } = createCanvas(size);
  const { canvas: bumpCanvas, ctx: bumpCtx } = createCanvas(size);
  const { canvas: roughCanvas, ctx: roughCtx } = createCanvas(size);

  ctx.fillStyle = '#9d8e6f';
  ctx.fillRect(0, 0, size, size);
  bumpCtx.fillStyle = '#808080';
  bumpCtx.fillRect(0, 0, size, size);
  roughCtx.fillStyle = '#f0f0f0';
  roughCtx.fillRect(0, 0, size, size);

  for (let index = 0; index < 2400; index += 1) {
    const x = hash2(index * 1.1, 3.7) * size;
    const y = hash2(2.9, index * 1.7) * size;
    ctx.fillStyle = hash2(index, 6.3) > 0.5 ? 'rgba(255, 240, 210, 0.1)' : 'rgba(60, 50, 34, 0.12)';
    ctx.fillRect(x, y, 1.6, 1.6);
    bumpCtx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    bumpCtx.fillRect(x, y, 1.6, 1.6);
  }
  ctx.strokeStyle = 'rgba(70, 60, 44, 0.5)';
  bumpCtx.strokeStyle = 'rgba(200, 200, 200, 0.5)';
  for (let index = 0; index < 6; index += 1) {
    const y = 12 + index * 20;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + 2);
    ctx.stroke();
    bumpCtx.beginPath();
    bumpCtx.moveTo(0, y);
    bumpCtx.lineTo(size, y + 2);
    bumpCtx.stroke();
  }

  return {
    map: finishTexture(canvas, true, anisotropy),
    bump: finishTexture(bumpCanvas, false, anisotropy),
    roughness: finishTexture(roughCanvas, false, anisotropy),
  };
}

/** 坦克漆面贴图：近白底 + 掉漆/划痕/污渍，乘上队伍色后形成有磨损的军械漆面。 */
function makePaintTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const { canvas, ctx } = createCanvas(size);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  // 细微色差
  for (let index = 0; index < 26; index += 1) {
    const cx = hash2(index * 2.3, 1.1) * size;
    const cy = hash2(4.7, index * 1.7) * size;
    const radius = 18 + hash2(index, 6.3) * 60;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, 'rgba(210, 205, 195, 0.10)');
    gradient.addColorStop(1, 'rgba(210, 205, 195, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  }

  // 划痕 / 掉漆
  for (let index = 0; index < 80; index += 1) {
    const x = hash2(index * 1.9, 3.3) * size;
    const y = hash2(7.1, index * 2.7) * size;
    const length = 4 + hash2(index, 5.9) * 26;
    const angle = hash2(index * 2.1, 8.7) * Math.PI;
    ctx.strokeStyle = hash2(index, 4.3) > 0.55 ? 'rgba(70, 66, 60, 0.34)' : 'rgba(245, 240, 230, 0.18)';
    ctx.lineWidth = 0.6 + hash2(index, 9.1);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
  }

  // 面板缝 + 铆钉/螺栓点 + 边缘掉漆：提高对比，近距离能看出"刻线感"
  const seamYs = [18, 58, 96, 140, 182, 222];
  ctx.strokeStyle = 'rgba(44, 48, 52, 0.36)';
  ctx.lineWidth = 1.4;
  for (const seamY of seamYs) {
    ctx.beginPath();
    ctx.moveTo(0, seamY);
    ctx.lineTo(size, seamY + 2);
    ctx.stroke();
  }
  // 垂直短缝
  ctx.lineWidth = 1.2;
  const verticalSeams: Array<[number, number, number]> = [
    [64, 18, 58],
    [176, 96, 140],
    [120, 182, 222],
    [232, 58, 96],
  ];
  for (const [seamX, y0, y1] of verticalSeams) {
    ctx.beginPath();
    ctx.moveTo(seamX, y0);
    ctx.lineTo(seamX + 1, y1);
    ctx.stroke();
  }
  // 铆钉 / 螺栓点
  for (const seamY of seamYs) {
    for (let boltX = 8; boltX < size; boltX += 24) {
      ctx.fillStyle = 'rgba(30, 33, 36, 0.45)';
      ctx.beginPath();
      ctx.arc(boltX, seamY + 4, 1.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 255, 250, 0.3)';
      ctx.beginPath();
      ctx.arc(boltX - 0.5, seamY + 3.2, 0.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 边缘磨损 / 掉漆亮点
  for (let index = 0; index < 160; index += 1) {
    const x = hash2(index * 4.3, 2.9) * size;
    const y = hash2(7.7, index * 1.1) * size;
    ctx.fillStyle = hash2(index, 5.1) > 0.45 ? 'rgba(238, 233, 222, 0.32)' : 'rgba(60, 55, 48, 0.28)';
    ctx.fillRect(x, y, 1 + hash2(index, 3.7) * 4, 1 + hash2(index, 9.3) * 2);
  }

  // 灰尘与油点
  for (let index = 0; index < 60; index += 1) {
    const x = hash2(index * 3.7, 6.7) * size;
    const y = hash2(2.9, index * 1.3) * size;
    ctx.fillStyle = 'rgba(82, 72, 58, 0.14)';
    ctx.fillRect(x, y, 2 + hash2(index, 3.1) * 4, 1.5);
  }

  return finishTexture(canvas, true, anisotropy);
}

/** 米白识别板贴图：轻微污渍 + 细stencil线，用来做车体/炮塔的浅色识别块。 */
function makeAccentTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 128;
  const { canvas, ctx } = createCanvas(size);
  ctx.fillStyle = '#e9e4d7';
  ctx.fillRect(0, 0, size, size);
  for (let index = 0; index < 40; index += 1) {
    const x = hash2(index * 1.7, 2.3) * size;
    const y = hash2(5.1, index * 2.9) * size;
    ctx.fillStyle = hash2(index, 7.7) > 0.5 ? 'rgba(120, 110, 92, 0.10)' : 'rgba(255, 255, 255, 0.16)';
    ctx.fillRect(x, y, 3 + hash2(index, 1.9) * 8, 2);
  }
  ctx.strokeStyle = 'rgba(70, 66, 58, 0.22)';
  ctx.lineWidth = 1;
  for (let index = 0; index < 4; index += 1) {
    const y = 18 + index * 30;
    ctx.beginPath();
    ctx.moveTo(8, y);
    ctx.lineTo(size - 8, y);
    ctx.stroke();
  }
  return finishTexture(canvas, true, anisotropy);
}

/** 金属锈蚀/灰尘贴图：灰底 + 锈棕斑 + 油污，用作深色钢件与履带的颜色变化。 */
function makeRustTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 128;
  const { canvas, ctx } = createCanvas(size);
  ctx.fillStyle = '#b9b9b9';
  ctx.fillRect(0, 0, size, size);
  for (let index = 0; index < 160; index += 1) {
    const x = hash2(index * 2.9, 1.3) * size;
    const y = hash2(6.1, index * 1.1) * size;
    const radius = 1.5 + hash2(index, 4.7) * 7;
    const roll = hash2(index, 8.3);
    const color = roll > 0.66
      ? 'rgba(132, 82, 48, 0.32)'
      : roll > 0.33
        ? 'rgba(70, 66, 60, 0.28)'
        : 'rgba(210, 205, 195, 0.22)';
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  // 纵向油污/锈痕
  for (let index = 0; index < 18; index += 1) {
    const x = hash2(index * 3.3, 5.9) * size;
    const gradient = ctx.createLinearGradient(0, 0, 0, size);
    gradient.addColorStop(0, 'rgba(60, 54, 46, 0.22)');
    gradient.addColorStop(1, 'rgba(60, 54, 46, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x, 0, 2 + hash2(index, 1.7) * 4, size);
  }
  return finishTexture(canvas, true, anisotropy);
}

/** 按世界尺寸缩放 BoxGeometry 的 UV，让程序化纹理在不同大小的建筑上保持真实比例。 */
function scaleBoxUvs(
  geometry: THREE.BoxGeometry,
  width: number,
  height: number,
  depth: number,
  tileWidth: number,
  tileHeight: number,
): void {
  const uv = geometry.getAttribute('uv');
  // BoxGeometry 面顺序：px, nx, py, ny, pz, nz；每个面 4 个顶点
  const faceScales: Array<[number, number]> = [
    [depth / tileWidth, height / tileHeight],
    [depth / tileWidth, height / tileHeight],
    [width / tileWidth, depth / tileHeight],
    [width / tileWidth, depth / tileHeight],
    [width / tileWidth, height / tileHeight],
    [width / tileWidth, height / tileHeight],
  ];
  for (let face = 0; face < 6; face += 1) {
    const scale = faceScales[face] ?? [1, 1];
    for (let vertex = 0; vertex < 4; vertex += 1) {
      const index = face * 4 + vertex;
      uv.setXY(index, uv.getX(index) * scale[0], uv.getY(index) * scale[1]);
    }
  }
  uv.needsUpdate = true;
}

/** 沙袋墙几何：两排错位的扁球体合并成一段矮墙（局部 x 为长度方向，底面 y=0）。 */
function makeSandbagGeometry(length: number, thickness: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const bagRadius = Math.min(0.34, thickness * 0.55);
  const spacing = bagRadius * 1.55;
  const rows = 2;
  for (let row = 0; row < rows; row += 1) {
    const count = Math.max(2, Math.ceil(length / spacing));
    for (let index = 0; index < count; index += 1) {
      const bag = new THREE.SphereGeometry(bagRadius, 7, 5);
      bag.scale(1.15, 0.62, 0.9);
      const offset = (row % 2 === 0 ? 0 : spacing / 2) + index * spacing;
      const x = -length / 2 + offset - spacing / 2;
      const jitter = (hash2(index * 1.3 + row * 5.1, length) - 0.5) * 0.06;
      bag.translate(
        THREE.MathUtils.clamp(x, -length / 2 + bagRadius * 0.6, length / 2 - bagRadius * 0.6),
        bagRadius * (0.62 + row * 0.85) + jitter,
        (hash2(index * 2.7, row + 1.7) - 0.5) * 0.08,
      );
      parts.push(bag);
    }
  }
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('沙袋几何合并失败');
  merged.computeVertexNormals();
  return merged;
}

/* -------------------------------- 环境搭建 -------------------------------- */

export interface Environment {
  /** 应用/切换地图：地坪尺寸、边界矮墙、掩体、出生点标记、植被与阴影相机全部重建。 */
  setMap(map: TankMap): void;
  /** 每帧更新：天空穹顶跟随相机、灯带/云层时间流逝。 */
  update(dt: number, camera: THREE.Camera): void;
  /** 自适应降级：切换阴影贴图分辨率（2048 / 1024）。 */
  setShadowQuality(high: boolean): void;
  /** 当前阴影贴图边长，供调试统计。 */
  getShadowMapSize(): number;
  /** 相机穿模夹紧用的障碍物 AABB 列表（掩体 + 边界墙，随 setMap 重建）。 */
  getCameraColliders(): readonly THREE.Box3[];
  dispose(): void;
}

/**
 * 创建战场环境（地坪、半球光、带阴影的平行光、边界、掩体、出生点）。
 * 全部几何/材质/纹理都在这里登记，dispose 时统一释放。
 */
export function createEnvironment(scene: THREE.Scene, renderer: THREE.WebGLRenderer): Environment {
  const root = new THREE.Group();
  root.name = 'tank-environment';
  scene.add(root);

  const resources: DisposableResource[] = [];
  const keep = <T extends DisposableResource>(resource: T): T => {
    resources.push(resource);
    return resource;
  };

  /* ------------------------------ 地面与纹理 ------------------------------ */
  const asphalt = makeAsphaltTextures(renderer);
  const floorColorTexture = keep(asphalt.color);
  const floorRoughnessTexture = keep(asphalt.roughness);
  const floorMaterial = keep(
    new THREE.MeshStandardMaterial({
      map: floorColorTexture,
      roughnessMap: floorRoughnessTexture,
      roughness: 1,
      metalness: 0.08,
      envMapIntensity: 0.85,
    }),
  );
  const unitPlane = keep(new THREE.PlaneGeometry(1, 1));
  const floor = new THREE.Mesh(unitPlane, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  // 地图之外的深色地坪，避免边界处出现「虚空」
  const apronMaterial = keep(
    new THREE.MeshStandardMaterial({ color: 0x0f1419, roughness: 0.96, metalness: 0.05 }),
  );
  const apron = new THREE.Mesh(unitPlane, apronMaterial);
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.06;
  apron.scale.set(420, 420, 1);
  root.add(apron);

  /* -------------------------------- 天空 -------------------------------- */
  // 天空穹顶：跟随相机的大球壳，地平线冷灰蓝 → 天顶深青，太阳方向暖橙光晕。
  // 亮度是 HDR（>1）的，因此会被 Bloom 轻微拾取，形成黄昏眩光。
  const skyMaterial = keep(
    new THREE.ShaderMaterial({
      uniforms: {
        uHorizon: { value: DUSK.horizon.clone() },
        uZenith: { value: DUSK.zenith.clone() },
        uSunColor: { value: new THREE.Color(2.6, 1.35, 0.6) },
        uSunDir: { value: DUSK.sunDirection.clone() },
        uGround: { value: new THREE.Color(0x11161b) },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDirection;
        void main() {
          vDirection = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uHorizon;
        uniform vec3 uZenith;
        uniform vec3 uSunColor;
        uniform vec3 uSunDir;
        uniform vec3 uGround;
        uniform float uTime;
        varying vec3 vDirection;

        void main() {
          vec3 dir = normalize(vDirection);
          float height = clamp(dir.y, -1.0, 1.0);

          // 地平线到天顶的冷色渐变
          vec3 color = mix(uHorizon, uZenith, pow(clamp(height, 0.0, 1.0), 0.62));
          // 地平线以下压暗（远处地面 / 森林剪影）
          color = mix(color, uGround, smoothstep(0.0, -0.22, height));

          // 太阳：核心圆盘 + 宽光晕 + 大气散射
          float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
          color += uSunColor * (
            pow(sunDot, 1200.0) * 5.0 +
            pow(sunDot, 26.0) * 0.7 +
            pow(sunDot, 4.0) * 0.16
          );

          // 地平线附近的冷雾带
          color += vec3(0.055, 0.075, 0.095) * exp(-abs(height) * 8.0);

          // 极淡的横向云带（缓慢漂移），避免天空过于干净
          float bands = sin(height * 30.0 + dir.x * 2.4 + uTime * 0.02) * 0.5 + 0.5;
          color += vec3(0.035, 0.04, 0.048) * bands * smoothstep(0.02, 0.4, height);

          gl_FragColor = vec4(color, 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  const skyGeometry = keep(new THREE.SphereGeometry(1, 32, 20));
  const sky = new THREE.Mesh(skyGeometry, skyMaterial);
  sky.scale.setScalar(240);
  sky.frustumCulled = false;
  sky.renderOrder = -100;
  root.add(sky);
  let skyTime = 0;

  /* -------------------------------- 光照 -------------------------------- */
  const hemi = new THREE.HemisphereLight(0xa9c6e2, 0x333c42, 2.1);
  root.add(hemi);

  // 黄昏暖阳：低角度平行光，收紧阴影相机让近处阴影更锐利
  const sun = new THREE.DirectionalLight(0xffe6c4, 3.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 220;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.028;
  root.add(sun);
  root.add(sun.target);

  // 冷色补光（不投影），压出工业仓库的冷调
  const fill = new THREE.DirectionalLight(0x86a8cc, 0.85);
  root.add(fill);
  root.add(fill.target);

  /* -------------------------------- 材质 -------------------------------- */
  const unitBox = keep(new THREE.BoxGeometry(1, 1, 1));
  const anisotropy = Math.min(16, Math.max(1, renderer.capabilities.getMaxAnisotropy()));

  // ---- 砖砌仓库：程序化砖墙（颜色 / 凹凸 / 粗糙度） ----
  const brickTextures = makeBrickTextures(anisotropy);
  const brickMaterial = keep(
    new THREE.MeshStandardMaterial({
      map: keep(brickTextures.map),
      bumpMap: keep(brickTextures.bump),
      bumpScale: 0.05,
      roughnessMap: keep(brickTextures.roughness),
      roughness: 1,
      metalness: 0.04,
      envMapIntensity: 0.65,
    }),
  );
  const concreteMaterial = keep(
    new THREE.MeshStandardMaterial({ color: 0x8d9499, roughness: 0.86, metalness: 0.06 }),
  );
  const roofMaterial = keep(
    new THREE.MeshStandardMaterial({ color: 0x3b4650, roughness: 0.58, metalness: 0.42, envMapIntensity: 1 }),
  );
  const ventMaterial = keep(
    new THREE.MeshStandardMaterial({ color: 0x2c343b, roughness: 0.5, metalness: 0.55 }),
  );
  const warehouseLightMaterial = keep(
    new THREE.MeshStandardMaterial({
      color: 0x2a2f33,
      emissive: 0xffc27a,
      emissiveIntensity: 0.85,
      roughness: 0.5,
      metalness: 0.1,
    }),
  );

  // ---- 集装箱：瓦楞贴图 + 4 种常见箱体涂装（用材质颜色染色） ----
  const containerTextures = makeContainerTextures(anisotropy);
  const containerMap = keep(containerTextures.map);
  const containerBump = keep(containerTextures.bump);
  const containerRoughness = keep(containerTextures.roughness);
  const containerMaterials = [0x94493b, 0x3f6d92, 0x4c7a58, 0x6f7c86].map((color) =>
    keep(
      new THREE.MeshStandardMaterial({
        color,
        map: containerMap,
        bumpMap: containerBump,
        bumpScale: 0.04,
        roughnessMap: containerRoughness,
        roughness: 1,
        metalness: 0.32,
        envMapIntensity: 0.9,
      }),
    ),
  );
  const containerFrameMaterial = keep(
    new THREE.MeshStandardMaterial({ color: 0x374049, roughness: 0.55, metalness: 0.5 }),
  );

  // ---- 沙袋矮墙：麻布贴图 ----
  const sandbagTextures = makeSandbagTextures(anisotropy);
  const sandbagMaterial = keep(
    new THREE.MeshStandardMaterial({
      color: 0xa99a7c,
      map: keep(sandbagTextures.map),
      bumpMap: keep(sandbagTextures.bump),
      bumpScale: 0.06,
      roughnessMap: keep(sandbagTextures.roughness),
      roughness: 1,
      metalness: 0.02,
      envMapIntensity: 0.5,
    }),
  );

  const wallMaterial = keep(
    new THREE.MeshStandardMaterial({ color: 0x6b767e, roughness: 0.82, metalness: 0.12 }),
  );
  const wallCapMaterial = keep(
    new THREE.MeshStandardMaterial({ color: 0x8f9aa2, roughness: 0.62, metalness: 0.3 }),
  );
  // 边界内侧暖色灯带：与 HUD 暖金强调色呼应，并被 Bloom 拾取
  const accentLightMaterial = keep(
    new THREE.MeshStandardMaterial({
      color: 0x1a1f26,
      emissive: 0xffb066,
      emissiveIntensity: 1.2,
      roughness: 0.45,
      metalness: 0.2,
      transparent: false,
    }),
  );
  const spawnMaterial = keep(
    new THREE.MeshBasicMaterial({
      color: 0x69b9ff,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  const spawnRingGeometry = keep(
    (() => {
      const geometry = new THREE.RingGeometry(0.8, 1.0, 28);
      geometry.rotateX(-Math.PI / 2);
      return geometry;
    })(),
  );

  /* ------------------------------ 植被材质/几何 ------------------------------ */
  const barkMaterial = keep(
    new THREE.MeshStandardMaterial({ color: 0x453a2d, roughness: 0.95, metalness: 0.02, flatShading: true }),
  );
  const foliageMaterial = keep(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, metalness: 0.0, flatShading: true }),
  );
  const bushMaterial = keep(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0, flatShading: true }),
  );
  const grassMaterial = keep(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0.0, side: THREE.DoubleSide }),
  );
  const rockMaterial = keep(
    new THREE.MeshStandardMaterial({ color: 0x5a636d, roughness: 0.82, metalness: 0.12, flatShading: true }),
  );
  const leafMaterial = keep(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide }),
  );
  const trunkGeometry = keep(
    (() => {
      const geometry = new THREE.CylinderGeometry(0.62, 1, 1, 6);
      geometry.translate(0, 0.5, 0); // 底面在 y=0，实例按高度缩放
      return geometry;
    })(),
  );
  const canopyGeometry = keep(new THREE.IcosahedronGeometry(1, 0));
  // 锥形针叶树：3 层圆锥合并，归一化到底面 y=0、总高 1
  const coniferGeometry = keep(
    (() => {
      const parts: THREE.BufferGeometry[] = [];
      for (let index = 0; index < 3; index += 1) {
        const cone = new THREE.ConeGeometry(1 - index * 0.24, 0.62, 7);
        cone.translate(0, 0.3 + index * 0.26, 0);
        parts.push(cone);
      }
      const merged = mergeGeometries(parts, false);
      for (const part of parts) part.dispose();
      if (!merged) throw new Error('针叶树几何合并失败');
      merged.computeBoundingBox();
      const box = merged.boundingBox;
      const minY = box ? box.min.y : 0;
      const height = box ? box.max.y - box.min.y : 1;
      merged.translate(0, -minY, 0);
      merged.scale(1, 1 / Math.max(0.001, height), 1);
      return merged;
    })(),
  );
  const bushGeometry = keep(new THREE.IcosahedronGeometry(1, 0));
  const grassGeometry = keep(new THREE.ConeGeometry(1, 1, 4, 1, true));
  const rockGeometry = keep(new THREE.DodecahedronGeometry(1, 0));
  const leafGeometry = keep(
    (() => {
      const geometry = new THREE.CircleGeometry(1, 5);
      geometry.rotateX(-Math.PI / 2);
      return geometry;
    })(),
  );
  const patchGeometry = keep(
    (() => {
      const geometry = new THREE.CircleGeometry(1, 7);
      geometry.rotateX(-Math.PI / 2);
      return geometry;
    })(),
  );
  const patchMaterial = keep(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    }),
  );
  /** 树冠配色：冷绿 → 橄榄绿 → 暖褐绿；针叶树另用更深的蓝绿。 */
  const foliageColors = [0x2f4a3a, 0x35543c, 0x3d5b3d, 0x475f3d, 0x52603c, 0x3a4f42].map(
    (hex) => new THREE.Color(hex),
  );
  const coniferColors = [0x2b412f, 0x324a36, 0x394f35, 0x263a2c].map(
    (hex) => new THREE.Color(hex),
  );

  /* ----------------------------- 动态分组 ----------------------------- */
  const wallGroup = new THREE.Group();
  const obstacleGroup = new THREE.Group();
  const spawnGroup = new THREE.Group();
  const vegetationGroup = new THREE.Group();
  root.add(wallGroup, obstacleGroup, spawnGroup, vegetationGroup);
  /** 掩体几何按地图生成，切换地图时需要单独释放。 */
  const dynamicGeometries: THREE.BufferGeometry[] = [];
  /** 植被 InstancedMesh 按地图重建，实例缓冲需要单独释放。 */
  const vegetationMeshes: THREE.InstancedMesh[] = [];
  /** 相机穿模夹紧用的障碍物 AABB（掩体 + 边界墙）。 */
  const cameraColliders: THREE.Box3[] = [];

  function pushCollider(
    centerX: number,
    centerZ: number,
    sizeX: number,
    sizeZ: number,
    height: number,
  ): void {
    cameraColliders.push(
      new THREE.Box3(
        new THREE.Vector3(centerX - sizeX / 2, 0, centerZ - sizeZ / 2),
        new THREE.Vector3(centerX + sizeX / 2, height, centerZ + sizeZ / 2),
      ),
    );
  }

  function clearChildren(group: THREE.Group): void {
    for (const child of [...group.children]) group.remove(child);
  }

  function buildWalls(width: number, height: number): void {
    clearChildren(wallGroup);
    const thickness = 1;
    const wallHeight = 1.6;
    const segments: Array<[number, number, number, number]> = [
      [width / 2, -thickness / 2, width + thickness * 2, thickness],
      [width / 2, height + thickness / 2, width + thickness * 2, thickness],
      [-thickness / 2, height / 2, thickness, height + thickness * 2],
      [width + thickness / 2, height / 2, thickness, height + thickness * 2],
    ];
    for (const [cx, cz, scaleX, scaleZ] of segments) {
      const body = new THREE.Mesh(unitBox, wallMaterial);
      body.position.set(cx, wallHeight / 2, cz);
      body.scale.set(scaleX, wallHeight, scaleZ);
      body.castShadow = true;
      body.receiveShadow = true;
      wallGroup.add(body);
      const cap = new THREE.Mesh(unitBox, wallCapMaterial);
      cap.position.set(cx, wallHeight + 0.04, cz);
      cap.scale.set(scaleX * 1.03, 0.08, scaleZ * 1.03);
      wallGroup.add(cap);
      pushCollider(cx, cz, scaleX, scaleZ, wallHeight + 0.2);
    }
    // 内侧暖色灯带
    const strips: Array<[number, number, number, number]> = [
      [width / 2, 0.09, width * 0.98, 0.09],
      [width / 2, height - 0.09, width * 0.98, 0.09],
      [0.09, height / 2, 0.09, height * 0.98],
      [width - 0.09, height / 2, 0.09, height * 0.98],
    ];
    for (const [cx, cz, scaleX, scaleZ] of strips) {
      const strip = new THREE.Mesh(unitBox, accentLightMaterial);
      strip.position.set(cx, wallHeight - 0.16, cz);
      strip.scale.set(scaleX, 0.07, scaleZ);
      wallGroup.add(strip);
    }
    // 四角立柱，强化「竞技场」边界感
    const corners: Array<[number, number]> = [
      [-thickness / 2, -thickness / 2],
      [width + thickness / 2, -thickness / 2],
      [-thickness / 2, height + thickness / 2],
      [width + thickness / 2, height + thickness / 2],
    ];
    for (const [cx, cz] of corners) {
      const post = new THREE.Mesh(unitBox, wallMaterial);
      post.position.set(cx, 1.15, cz);
      post.scale.set(thickness * 1.7, 2.3, thickness * 1.7);
      post.castShadow = true;
      post.receiveShadow = true;
      wallGroup.add(post);
      const cap = new THREE.Mesh(unitBox, wallCapMaterial);
      cap.position.set(cx, 2.34, cz);
      cap.scale.set(thickness * 1.9, 0.1, thickness * 1.9);
      wallGroup.add(cap);
    }
  }

  /** 掩体类型：按尺寸与哈希确定性分配（同一张地图每次一致）。 */
  type ObstacleKind = 'warehouse' | 'container' | 'sandbag';

  function pickObstacleKind(width: number, depth: number, index: number): ObstacleKind {
    const longSide = Math.max(width, depth);
    const shortSide = Math.min(width, depth);
    const aspect = longSide / Math.max(0.001, shortSide);
    if (longSide >= 4.2 && aspect >= 1.5) return 'container';
    if (aspect >= 1.35) return hash2(index * 3.1, 5.7) < 0.7 ? 'container' : 'warehouse';
    if (width * depth <= 7.5) return hash2(index * 1.9, 8.3) < 0.75 ? 'sandbag' : 'container';
    return hash2(index * 2.7, 1.3) < 0.6 ? 'warehouse' : 'container';
  }

  function buildObstacles(map: TankMap): void {
    clearChildren(obstacleGroup);
    for (const geometry of dynamicGeometries) geometry.dispose();
    dynamicGeometries.length = 0;

    map.obstacles.forEach((obstacle, index) => {
      const width = Math.max(1.2, obstacle.w);
      const depth = Math.max(1.2, obstacle.h);
      const centerX = obstacle.x + width / 2;
      const centerZ = obstacle.y + depth / 2;
      const kind = pickObstacleKind(width, depth, index);

      // 每个掩体一个 group：集装箱/沙袋沿长边布置，必要时整体转 90°
      const group = new THREE.Group();
      group.position.set(centerX, 0, centerZ);
      obstacleGroup.add(group);

      if (kind === 'warehouse') {
        const height = 3.1 + hash2(index * 0.73, 4.1) * 2.2;
        pushCollider(centerX, centerZ, width, depth, height + 0.4);
        const bodyGeometry = new THREE.BoxGeometry(width, height, depth);
        scaleBoxUvs(bodyGeometry, width, height, depth, 1.6, 0.8);
        dynamicGeometries.push(bodyGeometry);
        const body = new THREE.Mesh(bodyGeometry, brickMaterial);
        body.position.y = height / 2;
        body.castShadow = true;
        body.receiveShadow = true;
        group.add(body);

        // 檐口 + 屋顶压边 + 通风口 + 暖色窗带
        const cornice = new THREE.Mesh(unitBox, concreteMaterial);
        cornice.position.y = height + 0.1;
        cornice.scale.set(width + 0.3, 0.2, depth + 0.3);
        cornice.castShadow = true;
        group.add(cornice);
        const roof = new THREE.Mesh(unitBox, roofMaterial);
        roof.position.y = height + 0.24;
        roof.scale.set(width * 0.96, 0.14, depth * 0.96);
        group.add(roof);
        for (let ventIndex = 0; ventIndex < 2; ventIndex += 1) {
          const vent = new THREE.Mesh(unitBox, ventMaterial);
          vent.position.set(
            (hash2(index * 1.7 + ventIndex * 3.1, 2.2) - 0.5) * Math.max(0.5, width - 1.6),
            height + 0.36,
            (hash2(index * 2.3 + ventIndex, 4.4) - 0.5) * Math.max(0.5, depth - 1.6),
          );
          vent.scale.set(0.62, 0.4, 0.62);
          group.add(vent);
        }
        const windowStrip = new THREE.Mesh(unitBox, warehouseLightMaterial);
        windowStrip.position.set(0, height * 0.62, depth / 2 + 0.03);
        windowStrip.scale.set(width * 0.42, 0.42, 0.06);
        group.add(windowStrip);
      } else if (kind === 'container') {
        const length = Math.max(width, depth);
        const thickness = Math.min(width, depth);
        const height = 2.6;
        pushCollider(centerX, centerZ, width, depth, height + 0.2);
        // 长边沿局部 x；若地图矩形是纵向的则整体转 90°
        group.rotation.y = depth > width ? Math.PI / 2 : 0;
        const bodyGeometry = new THREE.BoxGeometry(length, height, thickness);
        scaleBoxUvs(bodyGeometry, length, height, thickness, 4.8, 3.2);
        dynamicGeometries.push(bodyGeometry);
        const tintIndex = Math.floor(hash2(index * 5.3, 7.9) * containerMaterials.length);
        const body = new THREE.Mesh(
          bodyGeometry,
          containerMaterials[tintIndex % containerMaterials.length] ?? containerMaterials[0],
        );
        body.position.y = height / 2;
        body.castShadow = true;
        body.receiveShadow = true;
        group.add(body);

        const topRail = new THREE.Mesh(unitBox, containerFrameMaterial);
        topRail.position.y = height + 0.07;
        topRail.scale.set(length + 0.08, 0.14, thickness + 0.08);
        group.add(topRail);
        const bottomRail = new THREE.Mesh(unitBox, containerFrameMaterial);
        bottomRail.position.y = 0.09;
        bottomRail.scale.set(length + 0.08, 0.18, thickness + 0.08);
        group.add(bottomRail);
      } else {
        const length = Math.max(width, depth);
        const thickness = Math.min(width, depth);
        pushCollider(centerX, centerZ, width, depth, 0.85);
        group.rotation.y = depth > width ? Math.PI / 2 : 0;
        const bagGeometry = makeSandbagGeometry(length, thickness);
        dynamicGeometries.push(bagGeometry);
        const sandbags = new THREE.Mesh(bagGeometry, sandbagMaterial);
        sandbags.castShadow = true;
        sandbags.receiveShadow = true;
        group.add(sandbags);
      }
    });
  }

  function buildSpawns(spawns: readonly TankSpawn[]): void {
    clearChildren(spawnGroup);
    for (const spawn of spawns) {
      const ring = new THREE.Mesh(spawnRingGeometry, spawnMaterial);
      ring.position.set(spawn.x, 0.03, spawn.y);
      spawnGroup.add(ring);
    }
  }

  /* ------------------------------ 植被与装饰 ------------------------------ */
  interface InstanceSpec {
    matrix: THREE.Matrix4;
    color?: THREE.Color;
  }
  const dummy = new THREE.Object3D();
  const scratchColor = new THREE.Color(1, 1, 1);

  function instanceMatrix(
    x: number,
    y: number,
    z: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
    rotationY: number,
    rotationX = 0,
    rotationZ = 0,
  ): THREE.Matrix4 {
    dummy.position.set(x, y, z);
    dummy.rotation.set(rotationX, rotationY, rotationZ);
    dummy.scale.set(scaleX, scaleY, scaleZ);
    dummy.updateMatrix();
    return dummy.matrix.clone();
  }

  function buildInstances(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    specs: InstanceSpec[],
    castShadow: boolean,
  ): void {
    if (specs.length === 0) return;
    const mesh = new THREE.InstancedMesh(geometry, material, specs.length);
    let hasColor = false;
    for (const spec of specs) {
      if (spec.color) {
        hasColor = true;
        break;
      }
    }
    specs.forEach((spec, index) => {
      mesh.setMatrixAt(index, spec.matrix);
      if (hasColor) mesh.setColorAt(index, spec.color ?? scratchColor.setRGB(1, 1, 1));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = false;
    // 植被分布范围很大（含外围森林），禁用视锥剔除避免包围球误判
    mesh.frustumCulled = false;
    vegetationGroup.add(mesh);
    vegetationMeshes.push(mesh);
  }

  let currentWidth = DEFAULT_MAP.width;
  let currentHeight = DEFAULT_MAP.height;
  let currentObstacles: readonly TankObstacle[] = DEFAULT_MAP.obstacles;
  let currentSpawns: readonly TankSpawn[] = DEFAULT_MAP.spawns ?? [];

  function isInsideObstacle(x: number, z: number, margin: number): boolean {
    for (const obstacle of currentObstacles) {
      if (
        x > obstacle.x - margin &&
        x < obstacle.x + obstacle.w + margin &&
        z > obstacle.y - margin &&
        z < obstacle.y + obstacle.h + margin
      ) {
        return true;
      }
    }
    return false;
  }

  function isNearSpawn(x: number, z: number, radius: number): boolean {
    for (const spawn of currentSpawns) {
      const dx = x - spawn.x;
      const dz = z - spawn.y;
      if (dx * dx + dz * dz < radius * radius) return true;
    }
    return false;
  }

  /** 一棵程序化树：细树干 + 3 层低多边形宽树冠（写入实例数组）。 */
  function addTree(
    trunkSpecs: InstanceSpec[],
    canopySpecs: InstanceSpec[],
    x: number,
    z: number,
    height: number,
    trunkRadius: number,
  ): void {
    const rotationY = hash2(x * 1.7, z * 2.3) * Math.PI * 2;
    // 树干只到树冠内部，避免出现长光杆
    trunkSpecs.push({
      matrix: instanceMatrix(x, 0, z, trunkRadius, height * 0.8, trunkRadius, rotationY),
    });

    // 树冠半径按树高比例，宽大于高，形成蓬松的低多边形树冠
    const crown = height * 0.32;
    const baseColorIndex = Math.floor(hash2(x + 3.1, z + 7.7) * foliageColors.length);
    const blobs: Array<[number, number, number, number, number, number]> = [
      // [dx, dy, dz 相对树冠半径 / 高度; sx, sy, sz 相对树冠半径]
      [0, 0.84, 0, 1.0, 0.9, 1.0],
      [0.52, 0.96, 0.24, 0.72, 0.62, 0.72],
      [-0.48, 1.02, -0.3, 0.62, 0.54, 0.62],
    ];
    blobs.forEach((blob, blobIndex) => {
      const color = foliageColors[(baseColorIndex + blobIndex) % foliageColors.length] ?? foliageColors[0];
      canopySpecs.push({
        matrix: instanceMatrix(
          x + crown * blob[0],
          height * blob[1],
          z + crown * blob[2],
          crown * blob[3],
          crown * blob[4],
          crown * blob[5],
          rotationY + blobIndex * 0.9,
        ),
        color: new THREE.Color().copy(color).multiplyScalar(0.85 + blobIndex * 0.08),
      });
    });
  }

  /** 一棵锥形针叶树：细树干 + 3 层圆锥树冠。 */
  function addConifer(
    trunkSpecs: InstanceSpec[],
    canopySpecs: InstanceSpec[],
    x: number,
    z: number,
    height: number,
    trunkRadius: number,
  ): void {
    const rotationY = hash2(x * 2.1, z * 1.3) * Math.PI * 2;
    trunkSpecs.push({
      matrix: instanceMatrix(x, 0, z, trunkRadius, height * 0.62, trunkRadius, rotationY),
    });
    const crownRadius = height * 0.21;
    const colorIndex = Math.floor(hash2(x + 5.3, z + 2.9) * coniferColors.length);
    canopySpecs.push({
      matrix: instanceMatrix(
        x,
        height * 0.14,
        z,
        crownRadius,
        height * 0.86,
        crownRadius,
        rotationY,
      ),
      color: new THREE.Color()
        .copy(coniferColors[colorIndex % coniferColors.length] ?? coniferColors[0])
        .multiplyScalar(0.9 + hash2(x, z) * 0.18),
    });
  }

  function buildVegetation(map: TankMap): void {
    for (const mesh of vegetationMeshes) {
      vegetationGroup.remove(mesh);
      mesh.dispose();
    }
    vegetationMeshes.length = 0;
    currentWidth = map.width;
    currentHeight = map.height;
    currentObstacles = map.obstacles;
    currentSpawns = map.spawns ?? [];

    const exteriorTrunks: InstanceSpec[] = [];
    const exteriorCanopies: InstanceSpec[] = [];
    const exteriorConifers: InstanceSpec[] = [];
    const interiorTrunks: InstanceSpec[] = [];
    const interiorCanopies: InstanceSpec[] = [];
    const interiorConifers: InstanceSpec[] = [];
    const bushes: InstanceSpec[] = [];
    const grass: InstanceSpec[] = [];
    const rocks: InstanceSpec[] = [];
    const leaves: InstanceSpec[] = [];

    // 1) 边界墙外的森林环带：网格采样 + 确定性哈希抖动/择优，远处树更高更大
    const bandOuter = 30;
    const bandInner = 2.2;
    const step = 4.2;
    for (let gx = -bandOuter; gx <= currentWidth + bandOuter; gx += step) {
      for (let gz = -bandOuter; gz <= currentHeight + bandOuter; gz += step) {
        const x = gx + (hash2(gx + 0.37, gz + 0.11) - 0.5) * 3.4;
        const z = gz + (hash2(gz + 5.3, gx + 8.9) - 0.5) * 3.4;
        const distanceOutside = Math.max(
          Math.max(-x, x - currentWidth, 0),
          Math.max(-z, z - currentHeight, 0),
        );
        if (distanceOutside < bandInner || distanceOutside > bandOuter) continue;
        const keepChance = 0.6 + Math.min(0.22, distanceOutside * 0.012);
        if (hash2(x * 4.7, z * 3.9) > keepChance) continue;
        const sizeNoise = hash2(x * 1.13, z * 2.31);
        const height = 4.6 + sizeNoise * 3.6 + Math.min(2.6, distanceOutside * 0.1);
        const trunkRadius = 0.12 + sizeNoise * 0.11;
        if (hash2(x * 2.9, z * 4.1) < 0.48) {
          addConifer(exteriorTrunks, exteriorConifers, x, z, height * 0.95, trunkRadius);
        } else {
          addTree(exteriorTrunks, exteriorCanopies, x, z, height, trunkRadius);
        }
      }
    }

    // 2) 场内靠墙的 2–3 棵树：树干细、树冠高，坦克从下方穿过也不显眼
    const interiorPoints: Array<{ x: number; z: number }> = [];
    for (let attempt = 0; attempt < 90 && interiorPoints.length < 3; attempt += 1) {
      const side = Math.floor(hash2(attempt * 1.9 + 0.7, 3.1) * 4) % 4;
      const alongX = side % 2 === 0;
      const along = 7 + hash2(attempt * 2.7, 4.3) * ((alongX ? currentWidth : currentHeight) - 14);
      const inset = 2.4 + hash2(attempt * 1.3, 8.7) * 1.3;
      let x = 0;
      let z = 0;
      if (side === 0) {
        x = along;
        z = inset;
      } else if (side === 1) {
        x = currentWidth - inset;
        z = along;
      } else if (side === 2) {
        x = along;
        z = currentHeight - inset;
      } else {
        x = inset;
        z = along;
      }
      if (isInsideObstacle(x, z, 1.0) || isNearSpawn(x, z, 3.2)) continue;
      if (interiorPoints.some((point) => Math.hypot(point.x - x, point.z - z) < 8)) continue;
      interiorPoints.push({ x, z });
      const interiorHeight = 4.6 + hash2(x, z) * 1.0;
      // 前两棵固定一棵阔叶、一棵针叶，保证两种树形都能在场内看到
      const wantConifer = interiorPoints.length === 2 ? true : hash2(z * 3.3, x * 1.7) < 0.34;
      if (wantConifer) {
        addConifer(interiorTrunks, interiorConifers, x, z, interiorHeight * 0.9, 0.12 + hash2(z, x) * 0.04);
      } else {
        addTree(interiorTrunks, interiorCanopies, x, z, interiorHeight, 0.13 + hash2(z, x) * 0.04);
      }
    }

    // 3) 场内低矮装饰：草丛 / 落叶 / 碎石 / 小灌木（不参与碰撞，坦克可直接碾过）
    const scatter = (
      count: number,
      salt: number,
      margin: number,
      place: (x: number, z: number, index: number) => void,
    ): void => {
      let placed = 0;
      let attempt = 0;
      const maxAttempts = count * 40;
      while (placed < count && attempt < maxAttempts) {
        const x = margin + hash2(attempt * 1.31 + salt, salt * 0.73 + 0.11) * (currentWidth - margin * 2);
        const z = margin + hash2(salt * 1.97 + 0.31, attempt * 2.17 + salt) * (currentHeight - margin * 2);
        attempt += 1;
        if (isInsideObstacle(x, z, 0.6)) continue;
        if (isNearSpawn(x, z, 2.2)) continue;
        place(x, z, placed);
        placed += 1;
      }
    };

    scatter(130, 3.7, 1.6, (x, z, index) => {
      const height = 0.22 + hash2(x * 3.1, z * 2.7) * 0.3;
      const spread = 0.07 + hash2(z, x) * 0.09;
      const color = new THREE.Color()
        .copy(foliageColors[index % foliageColors.length] ?? foliageColors[0])
        .multiplyScalar(0.85 + hash2(x, z) * 0.35);
      grass.push({
        matrix: instanceMatrix(x, 0, z, spread, height, spread, hash2(x, z) * Math.PI),
        color,
      });
    });

    scatter(90, 8.3, 1.2, (x, z, index) => {
      const scale = 0.055 + hash2(z * 1.7, x * 2.1) * 0.09;
      const warm = new THREE.Color(
        index % 3 === 0 ? 0x4f3720 : index % 3 === 1 ? 0x5c4424 : 0x3c4a28,
      );
      leaves.push({
        matrix: instanceMatrix(x, 0.025, z, scale * 1.6, 1, scale, hash2(x, z) * Math.PI * 2),
        color: warm,
      });
    });

    scatter(26, 11.9, 1.4, (x, z) => {
      const scale = 0.08 + hash2(x * 1.3, z * 0.7) * 0.15;
      rocks.push({
        matrix: instanceMatrix(x, scale * 0.35, z, scale * 1.4, scale * 0.7, scale, hash2(x, z) * Math.PI),
      });
    });

    scatter(16, 15.1, 2.0, (x, z, index) => {
      const scale = 0.35 + hash2(x * 0.9, z * 1.9) * 0.35;
      const color = new THREE.Color()
        .copy(foliageColors[(index + 2) % foliageColors.length] ?? foliageColors[0])
        .multiplyScalar(0.95);
      bushes.push({
        matrix: instanceMatrix(x, scale * 0.75, z, scale * 1.5, scale * 0.85, scale * 1.5, hash2(x, z) * Math.PI),
        color,
      });
    });

    // 斑驳苔草/草皮色块：贴地的低对比绿色块，参考图里泥土与草的交界
    const patches: InstanceSpec[] = [];
    scatter(64, 21.7, 2.2, (x, z, index) => {
      const scale = 0.16 + hash2(x * 1.7, z * 0.9) * 0.34;
      const color = new THREE.Color(
        index % 3 === 0 ? 0x3c4a2f : index % 3 === 1 ? 0x44502f : 0x33402a,
      ).multiplyScalar(0.75 + hash2(x, z) * 0.35);
      patches.push({
        matrix: instanceMatrix(x, 0.012, z, scale * 1.5, 1, scale, hash2(x, z) * Math.PI),
        color,
      });
    });

    buildInstances(trunkGeometry, barkMaterial, exteriorTrunks, false);
    buildInstances(canopyGeometry, foliageMaterial, exteriorCanopies, false);
    buildInstances(coniferGeometry, foliageMaterial, exteriorConifers, false);
    buildInstances(trunkGeometry, barkMaterial, interiorTrunks, true);
    buildInstances(canopyGeometry, foliageMaterial, interiorCanopies, true);
    buildInstances(coniferGeometry, foliageMaterial, interiorConifers, true);
    buildInstances(patchGeometry, patchMaterial, patches, false);
    buildInstances(bushGeometry, bushMaterial, bushes, false);
    buildInstances(grassGeometry, grassMaterial, grass, false);
    buildInstances(rockGeometry, rockMaterial, rocks, true);
    buildInstances(leafGeometry, leafMaterial, leaves, false);
  }

  /* -------------------------------- 接口 -------------------------------- */
  const center = new THREE.Vector3(DEFAULT_MAP.width / 2, 0, DEFAULT_MAP.height / 2);

  function setMap(map: TankMap): void {
    const width = Number.isFinite(map.width) && map.width > 0 ? map.width : DEFAULT_MAP.width;
    const height = Number.isFinite(map.height) && map.height > 0 ? map.height : DEFAULT_MAP.height;
    center.set(width / 2, 0, height / 2);

    // 地坪铺满地图范围，沥青贴图按「每 8 单位一张」平铺
    floor.scale.set(width, height, 1);
    floor.position.set(center.x, 0, center.z);
    const repeatX = width / FLOOR_TEXTURE_UNITS;
    const repeatY = height / FLOOR_TEXTURE_UNITS;
    floorColorTexture.repeat.set(repeatX, repeatY);
    floorRoughnessTexture.repeat.set(repeatX, repeatY);
    apron.position.set(center.x, -0.06, center.z);

    cameraColliders.length = 0;
    buildWalls(width, height);
    buildObstacles(map);
    buildSpawns(map.spawns ?? []);
    buildVegetation(map);

    // 光照：低角度黄昏太阳，阴影相机收紧到竞技场范围（近处阴影更锐利）
    const extent = Math.max(width, height);
    sun.position.copy(center).addScaledVector(DUSK.sunDirection, extent * 1.9);
    sun.target.position.copy(center);
    sun.target.updateMatrixWorld();
    const shadowCamera = sun.shadow.camera;
    const shadowExtent = extent * 0.8;
    shadowCamera.left = -shadowExtent;
    shadowCamera.right = shadowExtent;
    shadowCamera.top = shadowExtent;
    shadowCamera.bottom = -shadowExtent;
    shadowCamera.near = 1;
    shadowCamera.far = extent * 3.4;
    shadowCamera.updateProjectionMatrix();

    fill.position.copy(center).addScaledVector(DUSK.sunDirection.clone().negate(), extent * 1.5);
    fill.position.y = extent * 0.7;
    fill.target.position.copy(center);
    fill.target.updateMatrixWorld();
  }

  function update(dt: number, camera: THREE.Camera): void {
    skyTime += dt;
    skyMaterial.uniforms.uTime.value = skyTime;
    // 天空穹顶跟随相机，保证无论相机在哪，远景都正确
    sky.position.copy(camera.position);
    // 灯带极轻微的呼吸感，避免完全静态
    accentLightMaterial.emissiveIntensity = 1.15 + Math.sin(skyTime * 1.6) * 0.12;
  }

  function setShadowQuality(high: boolean): void {
    const size = high ? 2048 : 1024;
    if (sun.shadow.mapSize.x === size) return;
    sun.shadow.mapSize.set(size, size);
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null;
    }
  }

  function getShadowMapSize(): number {
    return sun.shadow.mapSize.x;
  }

  function dispose(): void {
    for (const mesh of vegetationMeshes) mesh.dispose();
    vegetationMeshes.length = 0;
    for (const geometry of dynamicGeometries) geometry.dispose();
    dynamicGeometries.length = 0;
    scene.remove(root);
    for (const resource of resources) resource.dispose();
    resources.length = 0;
  }

  setMap(DEFAULT_MAP);

  return {
    setMap,
    update,
    setShadowQuality,
    getShadowMapSize,
    getCameraColliders: () => cameraColliders,
    dispose,
  };
}

/* --------------------------- 程序化坦克 / 子弹模型 --------------------------- */

/** 坦克模型句柄：对象池由调用方管理，模型内部把「按 slot 换装」暴露成方法。 */
export interface TankModel {
  readonly root: THREE.Group;
  /** 炮塔（车体局部坐标），rotation.y 由调用方设置为 hull - turret。 */
  readonly turret: THREE.Group;
  setSlot(slot: number): void;
  setShield(active: boolean): void;
  setLocal(active: boolean): void;
  /** dt 秒的视觉更新：履带滚动、护盾/本地指示脉冲。signedSpeed 是沿车头方向的速度。 */
  update(dt: number, signedSpeed: number, elapsed: number): void;
  /** 坦克脚下接触阴影强度（0 隐藏，0.2–0.7 常显），随血量衰减让它更「落地」。 */
  setContactShadow(strength: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/** 子弹模型句柄：root 的局部 +Z 指向「子弹后方」，由调用方用速度方向摆正。 */
export interface BulletModel {
  readonly root: THREE.Group;
  setSlot(slot: number): void;
  setTrail(length: number): void;
  setVisible(visible: boolean): void;
}

export interface ModelFactory {
  createTank(slot: number): TankModel;
  createBullet(slot: number): BulletModel;
  /** 释放工厂创建的全部几何/材质/纹理（含所有坦克实例的履带贴图）。 */
  dispose(): void;
}

/**
 * 创建共享几何/材质的模型工厂：同类坦克共用几何与（按 slot 分组的）材质，
 * 每个实例只额外拥有一张自己的履带贴图（滚动偏移互不影响）。
 */
export function createModelFactory(): ModelFactory {
  const resources: DisposableResource[] = [];
  const keep = <T extends DisposableResource>(resource: T): T => {
    resources.push(resource);
    return resource;
  };
  const tankModels: TankModel[] = [];
  const bulletModels: BulletModel[] = [];

  // 接触阴影：共享贴图 + 共享平面几何，每个坦克实例只有一份独立材质（透明度随血量）
  const contactShadowTexture = keep(makeContactShadowTexture());
  const contactShadowGeometry = keep(
    (() => {
      const geometry = new THREE.PlaneGeometry(1, 1);
      geometry.rotateX(-Math.PI / 2);
      return geometry;
    })(),
  );

  /* --------------------------- 精细化坦克几何 --------------------------- */
  // 所有零件按「材质分组」合并成共享几何：每辆坦克实例只持有 9 个 Mesh（+接触阴影）。
  const tmpMatrix = new THREE.Matrix4();
  const tmpQuaternion = new THREE.Quaternion();
  const tmpEuler = new THREE.Euler();
  const tmpPosition = new THREE.Vector3();
  const tmpScale = new THREE.Vector3();

  /** 给几何体施加 位置/旋转/缩放（返回同一个几何体，便于链式收集）。 */
  function placed(
    geometry: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    rotationX = 0,
    rotationY = 0,
    rotationZ = 0,
    scaleX = 1,
    scaleY = 1,
    scaleZ = 1,
  ): THREE.BufferGeometry {
    tmpEuler.set(rotationX, rotationY, rotationZ);
    tmpQuaternion.setFromEuler(tmpEuler);
    tmpPosition.set(x, y, z);
    tmpScale.set(scaleX, scaleY, scaleZ);
    tmpMatrix.compose(tmpPosition, tmpQuaternion, tmpScale);
    geometry.applyMatrix4(tmpMatrix);
    return geometry;
  }

  function rounded(width: number, height: number, depth: number, radius: number, segments = 1): THREE.BufferGeometry {
    return new RoundedBoxGeometry(width, height, depth, segments, radius);
  }

  function tube(
    radiusTop: number,
    radiusBottom: number,
    length: number,
    segments: number,
    axis: 'x' | 'y' | 'z',
  ): THREE.BufferGeometry {
    const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, length, segments);
    if (axis === 'x') geometry.rotateZ(-Math.PI / 2);
    else if (axis === 'z') geometry.rotateX(Math.PI / 2);
    return geometry;
  }

  /** 合并同材质零件（全部转非索引后再合并，避免索引/属性不一致）。 */
  function mergeGroup(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
    const converted = parts.map((part) => (part.index ? part.toNonIndexed() : part));
    const merged = mergeGeometries(converted, false);
    for (const part of parts) part.dispose();
    for (const part of converted) {
      if (!parts.includes(part)) part.dispose();
    }
    if (!merged) throw new Error('坦克几何合并失败');
    merged.computeBoundingSphere();
    return keep(merged);
  }

  /* -------- 车体（炮塔之外的固定部分） -------- */
  const hullPaintParts: THREE.BufferGeometry[] = [];
  const hullAccentParts: THREE.BufferGeometry[] = [];
  const hullDarkParts: THREE.BufferGeometry[] = [];
  const hullMetalParts: THREE.BufferGeometry[] = [];
  const hullLightParts: THREE.BufferGeometry[] = [];
  const hullTeamParts: THREE.BufferGeometry[] = [];
  const turretTeamParts: THREE.BufferGeometry[] = [];
  const trackBandParts: THREE.BufferGeometry[] = [];
  const turretPaintParts: THREE.BufferGeometry[] = [];
  const turretAccentParts: THREE.BufferGeometry[] = [];
  const turretGunParts: THREE.BufferGeometry[] = [];

  // 下车体 + 上车体分层，全部倒角
  hullPaintParts.push(placed(rounded(2.46, 0.44, 1.26, 0.08, 2), 0, 0.5, 0));
  hullPaintParts.push(placed(rounded(2.04, 0.3, 1.3, 0.07, 2), -0.04, 0.82, 0));
  // 倾斜首上装甲 + 尾板
  hullPaintParts.push(placed(rounded(0.5, 0.5, 1.24, 0.06), 1.0, 0.76, 0, 0, 0, 0.62));
  hullPaintParts.push(placed(rounded(0.44, 0.46, 1.24, 0.06), -1.04, 0.74, 0, 0, 0, -0.22));
  // 翼子板
  for (const side of [-1, 1]) {
    hullPaintParts.push(placed(rounded(2.64, 0.1, 0.34, 0.035), 0, 0.98, side * 0.72));
  }
  // 侧裙板：三段带缝
  for (const side of [-1, 1]) {
    for (const segment of [-0.8, 0, 0.8]) {
      hullPaintParts.push(placed(rounded(0.74, 0.36, 0.08, 0.025), segment, 0.52, side * 0.84));
    }
  }
  // 炮塔座圈
  hullPaintParts.push(placed(tube(0.56, 0.6, 0.12, 16, 'y'), 0, 0.98, 0));
  // 后部储物箱
  hullPaintParts.push(placed(rounded(0.62, 0.24, 0.32, 0.05), -0.62, 1.08, 0.72));
  hullPaintParts.push(placed(rounded(0.62, 0.24, 0.32, 0.05), -0.62, 1.08, -0.72));

  // 米白识别板 / 头灯透镜 / 工具箱
  for (const side of [-1, 1]) {
    hullAccentParts.push(placed(rounded(0.72, 0.24, 0.035, 0.012), 0.05, 0.6, side * 0.888));
    hullAccentParts.push(placed(rounded(0.24, 0.2, 0.03, 0.01), -1.3, 0.72, side * 0.4));
  }
  hullAccentParts.push(placed(rounded(0.44, 0.18, 0.03, 0.01), 0.98, 0.86, 0, 0, 0, 0.62));
  hullAccentParts.push(placed(tube(0.062, 0.062, 0.03, 12, 'x'), 1.3, 0.93, 0.5));
  hullAccentParts.push(placed(tube(0.062, 0.062, 0.03, 12, 'x'), 1.3, 0.93, -0.5));
  hullAccentParts.push(placed(rounded(0.52, 0.2, 0.26, 0.04), 0.5, 1.1, -0.72));

  // 发动机舱百叶格栅 / 排气管 / 悬挂摆臂 / 负重轮 / 履带链节
  hullDarkParts.push(placed(rounded(0.9, 0.07, 0.96, 0.02), -0.7, 1.02, 0));
  for (let slat = 0; slat < 7; slat += 1) {
    hullDarkParts.push(placed(rounded(0.9, 0.04, 0.07, 0.01), -0.7, 1.06, -0.36 + slat * 0.12));
  }
  for (const side of [-1, 1]) {
    hullDarkParts.push(placed(tube(0.062, 0.075, 0.56, 8, 'x'), -1.28, 0.62, side * 0.44));
    hullDarkParts.push(placed(tube(0.08, 0.08, 0.1, 8, 'x'), -1.58, 0.62, side * 0.44));
    // 悬挂摆臂
    for (const wheelX of [-0.86, -0.43, 0, 0.43, 0.86]) {
      hullDarkParts.push(placed(rounded(0.14, 0.1, 0.2, 0.02), wheelX, 0.28, side * 0.68, 0.18, 0, 0));
      // 负重轮
      hullDarkParts.push(placed(tube(0.26, 0.26, 0.24, 14, 'z'), wheelX, 0.32, side * 0.72));
      // 主动轮 / 诱导轮
    }
    hullDarkParts.push(placed(tube(0.3, 0.3, 0.26, 14, 'z'), -1.16, 0.35, side * 0.72));
    hullDarkParts.push(placed(tube(0.27, 0.27, 0.24, 14, 'z'), 1.16, 0.34, side * 0.72));
    // 履带链节：每侧上下各 11 段（共 22 段/侧）
    for (let link = 0; link < 11; link += 1) {
      const linkX = -1.0 + link * 0.2;
      hullDarkParts.push(placed(new THREE.BoxGeometry(0.16, 0.05, 0.42), linkX, 0.75, side * 0.72));
      hullDarkParts.push(placed(new THREE.BoxGeometry(0.16, 0.05, 0.42), linkX, 0.045, side * 0.72));
    }
    // 备用履带块
    for (let spare = 0; spare < 2; spare += 1) {
      hullDarkParts.push(placed(rounded(0.12, 0.08, 0.44, 0.015), 1.24, 0.56, side * (0.26 + spare * 0.26)));
    }
  }

  // 轮毂 / 拖车钩 / 头灯外壳 / 工具
  for (const side of [-1, 1]) {
    for (const wheelX of [-0.86, -0.43, 0, 0.43, 0.86]) {
      hullMetalParts.push(placed(tube(0.075, 0.075, 0.04, 10, 'z'), wheelX, 0.32, side * 0.86));
    }
    hullMetalParts.push(placed(tube(0.07, 0.07, 0.05, 10, 'z'), -1.16, 0.35, side * 0.86));
    hullMetalParts.push(placed(tube(0.07, 0.07, 0.05, 10, 'z'), 1.16, 0.34, side * 0.86));
    hullMetalParts.push(placed(rounded(0.18, 0.12, 0.14, 0.02), 1.3, 0.66, side * 0.42));
    hullMetalParts.push(placed(tube(0.085, 0.085, 0.16, 12, 'x'), 1.24, 0.93, side * 0.5));
  }
  hullMetalParts.push(placed(tube(0.022, 0.022, 0.78, 6, 'x'), -0.1, 0.92, -0.86));
  hullMetalParts.push(placed(rounded(0.1, 0.06, 0.16, 0.015), 0.34, 0.92, -0.86));
  // 侧裙铰链
  for (const side of [-1, 1]) {
    for (const hingeX of [-1.18, -0.4, 0.4, 1.18]) {
      hullMetalParts.push(placed(rounded(0.08, 0.1, 0.04, 0.01), hingeX, 0.52, side * 0.885));
    }
    // 车体侧面扶手
    hullMetalParts.push(placed(tube(0.016, 0.016, 0.7, 6, 'x'), -0.05, 0.9, side * 0.79));
    hullMetalParts.push(placed(tube(0.016, 0.016, 0.12, 6, 'y'), -0.4, 0.96, side * 0.79));
    hullMetalParts.push(placed(tube(0.016, 0.016, 0.12, 6, 'y'), 0.3, 0.96, side * 0.79));
    // 拖缆
    hullMetalParts.push(placed(tube(0.014, 0.014, 1.1, 6, 'x'), -0.55, 1.02, side * 0.35));
  }

  // 前示宽橙灯 + 侧标灯 + 挡泥板橙色识别块（emissive 小件）
  for (const side of [-1, 1]) {
    hullLightParts.push(placed(rounded(0.055, 0.06, 0.14, 0.012), 1.29, 0.98, side * 0.36));
    hullLightParts.push(placed(rounded(0.3, 0.035, 0.1, 0.008), 0.95, 1.045, side * 0.72));
  }

  // 尾灯（红）
  for (const side of [-1, 1]) {
    hullLightParts.push(placed(rounded(0.035, 0.14, 0.2, 0.012), -1.3, 0.9, side * 0.5));
  }

  // 高饱和队伍色点缀：远处也能一眼认出队伍
  hullTeamParts.push(placed(rounded(0.5, 0.16, 0.92, 0.02), 1.08, 0.9, 0, 0, 0, 0.62));
  for (const side of [-1, 1]) {
    hullTeamParts.push(placed(rounded(0.36, 0.22, 0.035, 0.012), 0.82, 0.6, side * 0.892));
    hullTeamParts.push(placed(rounded(0.14, 0.1, 0.02, 0.008), -1.31, 1.0, side * 0.5));
    hullTeamParts.push(placed(rounded(0.2, 0.1, 0.03, 0.01), 1.19, 0.56, side * 0.45, 0, 0, 0.62));
  }

  // 车体到炮塔的细电缆 / 软管、储物箱绑带、备用履带块、侧面工具
  for (const side of [-1, 1]) {
    hullDarkParts.push(placed(tube(0.02, 0.02, 0.6, 6, 'x'), -0.9, 0.92, side * 0.58));
    hullDarkParts.push(placed(tube(0.02, 0.02, 0.22, 6, 'y'), -0.6, 1.0, side * 0.58));
    hullDarkParts.push(placed(rounded(0.05, 0.025, 0.4, 0.008), -0.44, 1.215, side * 0.72));
    hullDarkParts.push(placed(rounded(0.05, 0.025, 0.4, 0.008), -0.8, 1.215, side * 0.72));
    hullDarkParts.push(placed(rounded(0.08, 0.06, 0.5, 0.012), 1.12, 0.98, side * 0.3));
    // 侧裙支架
    hullDarkParts.push(placed(rounded(0.06, 0.18, 0.05, 0.01), -0.42, 0.7, side * 0.87));
    hullDarkParts.push(placed(rounded(0.06, 0.18, 0.05, 0.01), 0.42, 0.7, side * 0.87));
  }
  // 备用履带块（首上）
  hullDarkParts.push(placed(rounded(0.5, 0.07, 0.12, 0.012), 1.02, 0.98, 0.24, 0, 0, 0.62));
  hullDarkParts.push(placed(rounded(0.5, 0.07, 0.12, 0.012), 1.02, 0.98, -0.24, 0, 0, 0.62));

  // 履带带面：上下两段（每辆坦克独立贴图，滚动偏移做行进感）
  for (const side of [-1, 1]) {
    trackBandParts.push(placed(rounded(2.4, 0.12, 0.42, 0.04), 0, 0.72, side * 0.72));
    trackBandParts.push(placed(rounded(2.4, 0.12, 0.42, 0.04), 0, 0.04, side * 0.72));
  }

  /* -------- 炮塔（原点在座圈中心，单独 rotate） -------- */
  turretPaintParts.push(placed(rounded(1.12, 0.46, 0.98, 0.13, 2), 0, 0.23, 0));
  for (const side of [-1, 1]) {
    turretPaintParts.push(placed(rounded(0.42, 0.4, 0.3, 0.06), 0.34, 0.18, side * 0.34, 0, -side * 0.32, 0));
  }
  turretPaintParts.push(placed(rounded(0.5, 0.32, 0.82, 0.06), -0.46, 0.2, 0));
  turretPaintParts.push(placed(tube(0.23, 0.25, 0.2, 12, 'y'), -0.1, 0.52, 0.16));
  turretPaintParts.push(placed(rounded(0.4, 0.06, 0.34, 0.02), -0.1, 0.64, 0.16));
  turretPaintParts.push(placed(rounded(0.34, 0.05, 0.28, 0.02), -0.34, 0.44, -0.18));
  turretPaintParts.push(placed(tube(0.52, 0.56, 0.08, 16, 'y'), 0, 0.02, 0));

  for (const side of [-1, 1]) {
    turretAccentParts.push(placed(rounded(0.54, 0.2, 0.03, 0.01), -0.05, 0.24, side * 0.51));
  }
  // （舱盖环改用队伍色，见下方 turretTeamParts）


  // 炮塔队伍色：座圈环带 + 舱盖环 + 侧面识别色带
  turretTeamParts.push(placed(tube(0.59, 0.61, 0.08, 24, 'y'), 0, 0.06, 0));
  turretTeamParts.push(placed(tube(0.25, 0.25, 0.03, 16, 'y'), -0.1, 0.66, 0.16));
  for (const side of [-1, 1]) {
    turretTeamParts.push(placed(rounded(0.62, 0.07, 0.03, 0.01), -0.05, 0.42, side * 0.5));
  }

  // 炮盾 / 长身管 / 热护套 / 抽烟装置 / 制退器
  turretGunParts.push(placed(rounded(0.34, 0.34, 0.54, 0.06), 0.6, 0.2, 0));
  turretGunParts.push(placed(tube(0.055, 0.07, 2.2, 12, 'x'), 1.75, 0.2, 0));
  turretGunParts.push(placed(tube(0.1, 0.1, 0.7, 12, 'x'), 1.5, 0.2, 0));
  turretGunParts.push(placed(tube(0.13, 0.13, 0.3, 12, 'x'), 2.05, 0.2, 0));
  turretGunParts.push(placed(tube(0.14, 0.14, 0.32, 12, 'x'), 2.82, 0.2, 0));
  turretGunParts.push(placed(new THREE.BoxGeometry(0.2, 0.08, 0.4), 2.82, 0.2, 0));
  // 烟雾弹发射器：两侧各 4 管
  for (const side of [-1, 1]) {
    for (let tubeIndex = 0; tubeIndex < 4; tubeIndex += 1) {
      turretGunParts.push(
        placed(tube(0.034, 0.034, 0.18, 6, 'x'), 0.16, 0.34 + tubeIndex * 0.045, side * (0.49 + tubeIndex * 0.012)),
      );
    }
  }
  // 车长塔潜望镜 + 炮长镜
  for (let scope = 0; scope < 3; scope += 1) {
    turretGunParts.push(placed(rounded(0.09, 0.07, 0.06, 0.012), -0.18 + scope * 0.09, 0.49, 0.26));
  }
  turretGunParts.push(placed(rounded(0.16, 0.12, 0.22, 0.02), 0.16, 0.44, -0.22));
  // 尾舱储物架（框架 + 网格底板）
  turretGunParts.push(placed(new THREE.BoxGeometry(0.52, 0.03, 0.74), -0.72, 0.12, 0));
  for (const side of [-1, 1]) {
    turretGunParts.push(placed(new THREE.BoxGeometry(0.05, 0.5, 0.05), -0.72, 0.34, side * 0.34));
    turretGunParts.push(placed(new THREE.BoxGeometry(0.05, 0.05, 0.72), -0.72, 0.58, 0));
  }
  // 天线 + 底座 + 细电缆
  turretGunParts.push(placed(tube(0.05, 0.06, 0.08, 8, 'y'), -0.56, 0.66, -0.34));
  turretGunParts.push(placed(tube(0.012, 0.016, 0.95, 4, 'y'), -0.56, 1.16, -0.34));
  turretGunParts.push(placed(tube(0.014, 0.014, 0.9, 6, 'x'), -0.2, 0.36, -0.44));

  const hullPaintGeometry = mergeGroup(hullPaintParts);
  const hullAccentGeometry = mergeGroup(hullAccentParts);
  // 轮毂/拖钩等亮金属小件并入深色钢件，单辆少一个 drawcall（颜色靠深钢底色区分）
  const hullDarkGeometry = mergeGroup([...hullDarkParts, ...hullMetalParts]);
  const hullLightGeometry = mergeGroup(hullLightParts);
  const trackBandGeometry = mergeGroup(trackBandParts);
  const turretPaintGeometry = mergeGroup(turretPaintParts);
  const turretAccentGeometry = mergeGroup(turretAccentParts);
  const turretGunGeometry = mergeGroup(turretGunParts);
  const hullTeamGeometry = mergeGroup(hullTeamParts);
  const turretTeamGeometry = mergeGroup(turretTeamParts);

  /** 漆面底部尘土渐变：用顶点色压暗车体下部，配合贴图形成"下脏上净"。 */
  function applyDustGradient(geometry: THREE.BufferGeometry, bottomY: number, topY: number): void {
    const position = geometry.getAttribute('position');
    const colors = new Float32Array(position.count * 3);
    for (let index = 0; index < position.count; index += 1) {
      const clean = THREE.MathUtils.smoothstep(position.getY(index), bottomY, topY);
      const shade = 0.66 + 0.34 * clean;
      colors[index * 3] = shade;
      colors[index * 3 + 1] = shade * 0.97;
      colors[index * 3 + 2] = shade * 0.9;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  applyDustGradient(hullPaintGeometry, 0.12, 0.95);
  applyDustGradient(turretPaintGeometry, 0.02, 0.6);

  // 本地坦克描边外壳（比车体略大）
  const outlineGeometry = keep(rounded(2.56, 1.02, 1.34, 0.1, 2));

  /* ------------------------------ 子弹几何 ------------------------------ */
  const bulletGeometry = {
    core: keep(new THREE.SphereGeometry(0.13, 12, 8)),
    glow: keep(new THREE.SphereGeometry(0.28, 12, 8)),
    trail: keep(new THREE.BoxGeometry(0.1, 0.1, 1)),
  };
  const ringGeometry = keep(
    (() => {
      const geometry = new THREE.RingGeometry(0.66, 0.74, 36);
      geometry.rotateX(-Math.PI / 2);
      return geometry;
    })(),
  );
  const shieldGeometry = keep(new THREE.SphereGeometry(1.44, 20, 14));

  /* ------------------------------ 材质（按层分组） ------------------------------ */
  const paintTexture = keep(makePaintTexture(4));
  const accentTexture = keep(makeAccentTexture(4));
  const rustTexture = keep(makeRustTexture(4));

  // 漆面：clearcoat 微光泽，贴图提供掉漆/划痕/污渍
  const accentMaterial = keep(
    new THREE.MeshPhysicalMaterial({
      color: 0xe9e4d7,
      map: accentTexture,
      roughness: 0.52,
      metalness: 0.08,
      clearcoat: 0.6,
      clearcoatRoughness: 0.35,
      envMapIntensity: 0.9,
    }),
  );
  // 深色钢件（履带/轮组/格栅）：高粗糙 + 锈迹
  const darkMetalMaterial = keep(
    new THREE.MeshStandardMaterial({
      color: 0x8a8a8a,
      map: rustTexture,
      roughness: 0.86,
      metalness: 0.62,
      envMapIntensity: 0.8,
    }),
  );
  // 炮管/钢制小件：较亮金属
  const gunMetalMaterial = keep(
    new THREE.MeshStandardMaterial({
      color: 0xc9cdd1,
      map: rustTexture,
      roughness: 0.42,
      metalness: 0.82,
      envMapIntensity: 1.1,
    }),
  );
  // 尾灯 / 小橙灯（emissive）
  const tailLightMaterial = keep(
    new THREE.MeshStandardMaterial({
      color: 0x2a0d08,
      emissive: 0xff4a24,
      emissiveIntensity: 2.2,
      roughness: 0.4,
      metalness: 0.2,
    }),
  );
  const shieldMaterial = keep(
    new THREE.MeshBasicMaterial({
      color: 0x7fd6ff,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const ringMaterial = keep(
    new THREE.MeshBasicMaterial({
      color: 0x9fe8ff,
      transparent: true,
      opacity: 0.26,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const outlineMaterial = keep(
    new THREE.MeshBasicMaterial({
      color: 0xcfeeff,
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  const bulletCoreMaterial = keep(
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.5, 1.3, 1.0),
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );

  // 按 slot 预建的漆面材质（8 套共享）：
  // 主漆 = mix(队伍色, #EFEAE0, 0.55) 米白化；队伍色本身留给高饱和点缀件。
  const OFF_WHITE_PAINT = new THREE.Color(0xefeae0);
  const bodyMaterials: THREE.MeshPhysicalMaterial[] = [];
  const teamMaterials: THREE.MeshPhysicalMaterial[] = [];
  const bulletGlowMaterials: THREE.MeshBasicMaterial[] = [];
  const bulletTrailMaterials: THREE.MeshBasicMaterial[] = [];
  for (const hex of TANK_COLORS) {
    const accent = new THREE.Color(hex);
    const body = new THREE.Color(hex).lerp(OFF_WHITE_PAINT, 0.55);
    bodyMaterials.push(
      keep(
        new THREE.MeshPhysicalMaterial({
          color: body,
          map: paintTexture,
          roughnessMap: paintTexture,
          bumpMap: paintTexture,
          bumpScale: 0.0035,
          roughness: 0.56,
          metalness: 0.18,
          clearcoat: 1,
          clearcoatRoughness: 0.24,
          envMapIntensity: 1.05,
          vertexColors: true,
        }),
      ),
    );
    // 高饱和队伍色点缀（环带/色块/色标）：略自发光，保证远距离可辨队
    teamMaterials.push(
      keep(
        new THREE.MeshPhysicalMaterial({
          color: accent,
          roughness: 0.36,
          metalness: 0.18,
          clearcoat: 0.9,
          clearcoatRoughness: 0.2,
          envMapIntensity: 1.05,
          emissive: accent,
          emissiveIntensity: 0.22,
        }),
      ),
    );
    bulletGlowMaterials.push(
      keep(
        new THREE.MeshBasicMaterial({
          color: accent.clone().multiplyScalar(1.25),
          transparent: true,
          opacity: 0.42,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      ),
    );
    bulletTrailMaterials.push(
      keep(
        new THREE.MeshBasicMaterial({
          color: accent.clone().multiplyScalar(1.1),
          transparent: true,
          opacity: 0.3,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      ),
    );
  }

  /* ------------------------------- 坦克模型 ------------------------------- */
  function createTankModel(initialSlot: number): TankModel {
    const root = new THREE.Group();
    // 0.7 缩放：车长约 1.75，匹配服务端 0.9 碰撞半径；iso 相机 24 距离下约占屏高 8%
    root.scale.setScalar(0.7);
    const body = new THREE.Group();
    root.add(body);

    // 车体 6 个 drawcall：漆面 / 米白识别板 / 深色钢件 / 亮金属 / 灯 / 履带带面
    const hullPaint = new THREE.Mesh(hullPaintGeometry, bodyMaterials[0]);
    hullPaint.castShadow = true;
    hullPaint.receiveShadow = true;
    body.add(hullPaint);

    const hullAccent = new THREE.Mesh(hullAccentGeometry, accentMaterial);
    body.add(hullAccent);

    const hullDark = new THREE.Mesh(hullDarkGeometry, darkMetalMaterial);
    body.add(hullDark);

    // 高饱和队伍色点缀（首上装甲条 / 侧裙前段 / 尾灯旁色标）
    const hullTeam = new THREE.Mesh(hullTeamGeometry, teamMaterials[0]);
    body.add(hullTeam);

    const hullLights = new THREE.Mesh(hullLightGeometry, tailLightMaterial);
    body.add(hullLights);

    // 履带带面（每辆坦克独立贴图，滚动偏移做行进感）
    const trackTexture = makeTrackTexture();
    const trackMaterial = new THREE.MeshStandardMaterial({
      map: trackTexture,
      color: 0x8f9295,
      roughness: 0.82,
      metalness: 0.5,
      envMapIntensity: 0.8,
    });
    const trackBand = new THREE.Mesh(trackBandGeometry, trackMaterial);
    trackBand.receiveShadow = true;
    body.add(trackBand);

    // 本地坦克描边
    const outline = new THREE.Mesh(outlineGeometry, outlineMaterial);
    outline.position.y = 0.62;
    outline.visible = false;
    body.add(outline);

    // 接触阴影
    const contactMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      alphaMap: contactShadowTexture,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });
    const contactShadow = new THREE.Mesh(contactShadowGeometry, contactMaterial);
    contactShadow.position.y = 0.02;
    contactShadow.scale.set(2.7, 1, 2.2);
    contactShadow.renderOrder = 1;
    contactShadow.visible = false;
    root.add(contactShadow);

    // 炮塔 3 个 drawcall：漆面 / 识别板 / 炮管钢件
    const turret = new THREE.Group();
    turret.position.y = 0.98;
    root.add(turret);
    const turretPaint = new THREE.Mesh(turretPaintGeometry, bodyMaterials[0]);
    turretPaint.castShadow = true;
    turret.add(turretPaint);
    const turretAccent = new THREE.Mesh(turretAccentGeometry, accentMaterial);
    turret.add(turretAccent);
    const turretGun = new THREE.Mesh(turretGunGeometry, gunMetalMaterial);
    turret.add(turretGun);
    // 炮塔队伍色环带 / 舱盖环 / 侧面识别色带
    const turretTeam = new THREE.Mesh(turretTeamGeometry, teamMaterials[0]);
    turret.add(turretTeam);

    // 护盾球与地面指示环
    const shield = new THREE.Mesh(shieldGeometry, shieldMaterial);
    shield.position.y = 0.86;
    shield.visible = false;
    root.add(shield);
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.position.y = 0.04;
    ring.visible = false;
    root.add(ring);

    const bodyMeshes: THREE.Mesh[] = [hullPaint, turretPaint];
    const teamMeshes: THREE.Mesh[] = [hullTeam, turretTeam];
    let currentSlot = -1;

    function applySlot(slot: number): void {
      const index = clampSlot(slot);
      if (index === currentSlot) return;
      currentSlot = index;
      const bodyMaterial = bodyMaterials[index] ?? bodyMaterials[0];
      const teamMaterial = teamMaterials[index] ?? teamMaterials[0];
      for (const mesh of bodyMeshes) mesh.material = bodyMaterial;
      for (const mesh of teamMeshes) mesh.material = teamMaterial;
    }

    applySlot(initialSlot);

    return {
      root,
      turret,
      setSlot: applySlot,
      setShield(active: boolean): void {
        shield.visible = active;
      },
      setLocal(active: boolean): void {
        outline.visible = active;
        ring.visible = active;
      },
      update(dt: number, signedSpeed: number, elapsed: number): void {
        // 履带滚动
        const offset = trackTexture.offset;
        offset.x = (offset.x - signedSpeed * dt * 0.45) % 1;
        if (offset.x < 0) offset.x += 1;

        if (shield.visible) {
          const pulse = 0.5 + 0.5 * Math.sin(elapsed * 9);
          shield.scale.setScalar(1 + pulse * 0.05);
          shieldMaterial.opacity = 0.03 + pulse * 0.06;
        }
        if (ring.visible) {
          const pulse = 0.5 + 0.5 * Math.sin(elapsed * 5);
          ringMaterial.opacity = 0.08 + pulse * 0.06;
          ring.scale.setScalar(1 + pulse * 0.05);
        }
        if (outline.visible) {
          outlineMaterial.opacity = 0.13 + 0.1 * (0.5 + 0.5 * Math.sin(elapsed * 6));
        }
      },
      setContactShadow(strength: number): void {
        contactShadow.visible = strength > 0.02;
        contactMaterial.opacity = strength;
      },
      setVisible(visible: boolean): void {
        root.visible = visible;
      },
      dispose(): void {
        trackTexture.dispose();
        trackMaterial.dispose();
        contactMaterial.dispose();
      },
    };
  }

  /* ------------------------------- 子弹模型 ------------------------------- */
  function createBulletModel(initialSlot: number): BulletModel {
    const root = new THREE.Group();
    const core = new THREE.Mesh(bulletGeometry.core, bulletCoreMaterial);
    root.add(core);

    const index = clampSlot(initialSlot);
    const glow = new THREE.Mesh(bulletGeometry.glow, bulletGlowMaterials[index]);
    root.add(glow);
    const trail = new THREE.Mesh(bulletGeometry.trail, bulletTrailMaterials[index]);
    trail.position.z = 0.5;
    root.add(trail);

    let currentSlot = index;

    return {
      root,
      setSlot(slot: number): void {
        const next = clampSlot(slot);
        if (next === currentSlot) return;
        currentSlot = next;
        glow.material = bulletGlowMaterials[next] ?? bulletGlowMaterials[0];
        trail.material = bulletTrailMaterials[next] ?? bulletTrailMaterials[0];
      },
      setTrail(length: number): void {
        const clamped = Math.max(0.4, length);
        trail.scale.z = clamped;
        trail.position.z = clamped / 2;
      },
      setVisible(visible: boolean): void {
        root.visible = visible;
      },
    };
  }

  return {
    createTank(slot: number): TankModel {
      const model = createTankModel(slot);
      tankModels.push(model);
      return model;
    },
    createBullet(slot: number): BulletModel {
      const model = createBulletModel(slot);
      bulletModels.push(model);
      return model;
    },
    dispose(): void {
      for (const model of tankModels) model.dispose();
      tankModels.length = 0;
      bulletModels.length = 0;
      for (const resource of resources) resource.dispose();
      resources.length = 0;
    },
  };
}
