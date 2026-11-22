/**
 * 坦克战场特效：炮口火光、命中火花、击杀爆炸（火球 + 烟 + 冲击环 + 闪光），
 * 以及受伤坦克持续冒烟 / 濒死火花。全部基于 dt 推进、生命周期结束自动回收。
 *
 * 性能要点：
 * - 粒子用两个 `THREE.Points`（加色发光 / 普通混合烟雾）批量绘制，每类只 1 个 drawcall；
 * - 火球/冲击环/炮口闪光用固定大小的对象池，不每帧 new；
 * - 全局只共享一个 PointLight 做瞬时照亮，避免每颗子弹一个点光。
 *
 * 坐标约定：入参是世界平面坐标 (x, y)，内部映射到 three 的 (x, height, y)。
 */
import * as THREE from 'three';

/** 特效系统对外接口。 */
/** 命中表面信息（由 scene-world.getSurfaceAt 提供，用于贴合表面的贴花与分层粒子）。 */
export interface ImpactSurface {
  kind: 'brick' | 'metal' | 'sandbag' | 'concrete' | 'ground';
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

export interface FxSystem {
  update(dt: number): void;
  /** 由 resize 调用：把点精灵的世界尺寸换算成像素（gl_PointSize 依赖画布高度与 fov）。 */
  setScreenScale(scale: number): void;
  /** 地图尺寸变化时重建漂浮尘埃的分布范围。 */
  setMapBounds(width: number, height: number): void;
  muzzle(worldX: number, worldY: number, angle: number): void;
  hit(worldX: number, worldY: number): void;
  /** 子弹命中掩体/边界墙：按表面材质给砖屑/金属火花/沙粒 + 贴合表面的弹坑/烧蚀贴花。 */
  impact(worldX: number, worldY: number, surface: ImpactSurface): void;
  kill(worldX: number, worldY: number): void;
  /** 受伤坦克的循环冒烟（由场景按间隔调用）。 */
  damageSmoke(worldX: number, worldY: number): void;
  /** 受伤坦克的循环火花（由场景按间隔调用）。 */
  damageSpark(worldX: number, worldY: number): void;
  dispose(): void;
}

/* --------------------------------- 粒子着色器 -------------------------------- */

const PARTICLE_VERTEX = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uScale / max(0.1, -mv.z), 1.0, 384.0);
  gl_Position = projectionMatrix * mv;
}
`;

const PARTICLE_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float alpha = texture2D(uMap, gl_PointCoord).a * vAlpha;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(vColor, alpha);
}
`;

/** 确定性伪随机（贴花图集的颗粒/裂纹用）。 */
function hash2(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/* ------------------------- 贴花 / 碎片（实例化） ------------------------- */

const DECAL_VERTEX = /* glsl */ `
attribute float aAlpha;
attribute vec2 aTile;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vUv = uv * 0.5 + aTile;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const DECAL_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec4 texel = texture2D(uMap, vUv);
  float alpha = texel.a * vAlpha;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(texel.rgb, alpha);
}
`;

const DEBRIS_VERTEX = /* glsl */ `
attribute float aAlpha;
attribute vec3 aTint;
varying float vAlpha;
varying vec3 vTint;
void main() {
  vAlpha = aAlpha;
  vTint = aTint;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const DEBRIS_FRAGMENT = /* glsl */ `
varying float vAlpha;
varying vec3 vTint;
void main() {
  if (vAlpha < 0.01) discard;
  gl_FragColor = vec4(vTint, vAlpha);
}
`;

/** 生成 512 的贴花图集（2×2）：地面焦痕 / 砖弹坑 / 金属烧蚀 / 沙地弹坑。 */
function makeDecalAtlasTexture(): THREE.CanvasTexture {
  const size = 512;
  const tile = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建贴花图集：Canvas 2D 上下文不可用');

  const drawTile = (col: number, row: number, paint: (x: number, y: number) => void): void => {
    ctx.save();
    ctx.translate(col * tile, row * tile);
    paint(0, 0);
    ctx.restore();
  };

  // 0,0 地面焦痕
  drawTile(0, 0, (x, y) => {
    const cx = x + tile / 2;
    const cy = y + tile / 2;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, tile * 0.45);
    gradient.addColorStop(0, 'rgba(8, 8, 8, 0.9)');
    gradient.addColorStop(0.45, 'rgba(24, 20, 16, 0.7)');
    gradient.addColorStop(0.8, 'rgba(60, 48, 36, 0.25)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, tile, tile);
    for (let index = 0; index < 40; index += 1) {
      const angle = hash2(index, 1.1) * Math.PI * 2;
      const radius = tile * (0.18 + hash2(index, 2.2) * 0.22);
      ctx.fillStyle = `rgba(18, 14, 10, ${0.2 + hash2(index, 3.3) * 0.4})`;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 2 + hash2(index, 4.4) * 7, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  // 1,0 砖弹坑
  drawTile(1, 0, (x, y) => {
    const cx = x + tile / 2;
    const cy = y + tile / 2;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, tile * 0.4);
    gradient.addColorStop(0, 'rgba(20, 16, 14, 0.95)');
    gradient.addColorStop(0.35, 'rgba(74, 48, 38, 0.85)');
    gradient.addColorStop(0.7, 'rgba(120, 86, 66, 0.4)');
    gradient.addColorStop(1, 'rgba(90, 70, 56, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, tile, tile);
    for (let index = 0; index < 30; index += 1) {
      const angle = hash2(index, 5.1) * Math.PI * 2;
      const radius = tile * (0.12 + hash2(index, 6.2) * 0.26);
      const wedge = 3 + hash2(index, 7.3) * 9;
      ctx.fillStyle = `rgba(${90 + Math.floor(hash2(index, 8.4) * 60)}, ${58 + Math.floor(hash2(index, 9.5) * 40)}, 44, ${0.35 + hash2(index, 2.6) * 0.5})`;
      ctx.save();
      ctx.translate(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
      ctx.rotate(angle);
      ctx.fillRect(-wedge / 2, -wedge / 4, wedge, wedge / 2);
      ctx.restore();
    }
    ctx.strokeStyle = 'rgba(24, 20, 18, 0.6)';
    ctx.lineWidth = 2;
    for (let crack = 0; crack < 7; crack += 1) {
      const angle = (crack / 7) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * tile * 0.12, cy + Math.sin(angle) * tile * 0.12);
      ctx.lineTo(cx + Math.cos(angle) * tile * 0.42, cy + Math.sin(angle) * tile * 0.42);
      ctx.stroke();
    }
  });

  // 0,1 金属烧蚀
  drawTile(0, 1, (x, y) => {
    const cx = x + tile / 2;
    const cy = y + tile / 2;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, tile * 0.42);
    gradient.addColorStop(0, 'rgba(16, 14, 12, 0.92)');
    gradient.addColorStop(0.45, 'rgba(48, 40, 32, 0.75)');
    gradient.addColorStop(0.8, 'rgba(110, 92, 64, 0.28)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, tile, tile);
    for (let index = 0; index < 34; index += 1) {
      const angle = hash2(index, 3.7) * Math.PI * 2;
      const radius = tile * (0.1 + hash2(index, 4.8) * 0.3);
      ctx.strokeStyle = `rgba(${180 + Math.floor(hash2(index, 5.9) * 60)}, ${150 + Math.floor(hash2(index, 6.1) * 40)}, 110, ${0.2 + hash2(index, 7.2) * 0.45})`;
      ctx.lineWidth = 1 + hash2(index, 8.3) * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * radius * 0.35, cy + Math.sin(angle) * radius * 0.35);
      ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
      ctx.stroke();
    }
  });

  // 1,1 沙地弹坑
  drawTile(1, 1, (x, y) => {
    const cx = x + tile / 2;
    const cy = y + tile / 2;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, tile * 0.4);
    gradient.addColorStop(0, 'rgba(92, 74, 48, 0.9)');
    gradient.addColorStop(0.4, 'rgba(150, 128, 86, 0.8)');
    gradient.addColorStop(0.75, 'rgba(168, 150, 108, 0.3)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, tile, tile);
    for (let index = 0; index < 70; index += 1) {
      const angle = hash2(index, 1.9) * Math.PI * 2;
      const radius = tile * hash2(index, 2.8) * 0.4;
      ctx.fillStyle = `rgba(120, 100, 66, ${0.2 + hash2(index, 3.9) * 0.4})`;
      ctx.fillRect(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 2, 2);
    }
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // 图集按 Canvas 行序取样：tile (0,0) 对应左上角的地面焦痕
  texture.flipY = false;
  return texture;
}

/** 软圆点贴图（粒子与烟共用）。 */
function makeSoftTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建粒子贴图：Canvas 2D 上下文不可用');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.35, 'rgba(255, 255, 255, 0.62)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

interface ParticleSpawnOptions {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  color: THREE.Color;
  size: number;
  /** 每秒尺寸增长量（世界单位/秒），负值表示收缩。 */
  growth: number;
  life: number;
  gravity: number;
  drag: number;
  alpha: number;
}

/** 固定容量的 CPU 粒子池，只占一个 drawcall。 */
class ParticlePool {
  readonly object: THREE.Points;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly capacity: number;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly alphas: Float32Array;
  private readonly initialAlphas: Float32Array;
  private readonly velocities: Float32Array;
  private readonly lifetimes: Float32Array;
  private readonly maxLifetimes: Float32Array;
  private readonly growths: Float32Array;
  private readonly gravities: Float32Array;
  private readonly drags: Float32Array;
  private readonly positionAttribute: THREE.BufferAttribute;
  private readonly colorAttribute: THREE.BufferAttribute;
  private readonly sizeAttribute: THREE.BufferAttribute;
  private readonly alphaAttribute: THREE.BufferAttribute;
  private cursor = 0;

  constructor(capacity: number, texture: THREE.Texture, blending: THREE.Blending) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    this.initialAlphas = new Float32Array(capacity);
    this.velocities = new Float32Array(capacity * 3);
    this.lifetimes = new Float32Array(capacity);
    this.maxLifetimes = new Float32Array(capacity);
    this.growths = new Float32Array(capacity);
    this.gravities = new Float32Array(capacity);
    this.drags = new Float32Array(capacity);

    this.geometry = new THREE.BufferGeometry();
    this.positionAttribute = new THREE.BufferAttribute(this.positions, 3).setUsage(
      THREE.DynamicDrawUsage,
    );
    this.colorAttribute = new THREE.BufferAttribute(this.colors, 3).setUsage(
      THREE.DynamicDrawUsage,
    );
    this.sizeAttribute = new THREE.BufferAttribute(this.sizes, 1).setUsage(
      THREE.DynamicDrawUsage,
    );
    this.alphaAttribute = new THREE.BufferAttribute(this.alphas, 1).setUsage(
      THREE.DynamicDrawUsage,
    );
    this.geometry.setAttribute('position', this.positionAttribute);
    this.geometry.setAttribute('aColor', this.colorAttribute);
    this.geometry.setAttribute('aSize', this.sizeAttribute);
    this.geometry.setAttribute('aAlpha', this.alphaAttribute);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uScale: { value: 700 },
      },
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.object = new THREE.Points(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 4;
  }

  spawn(options: ParticleSpawnOptions): void {
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const offset = index * 3;
    this.positions[offset] = options.x;
    this.positions[offset + 1] = options.y;
    this.positions[offset + 2] = options.z;
    this.velocities[offset] = options.vx;
    this.velocities[offset + 1] = options.vy;
    this.velocities[offset + 2] = options.vz;
    this.colors[offset] = options.color.r;
    this.colors[offset + 1] = options.color.g;
    this.colors[offset + 2] = options.color.b;
    this.sizes[index] = options.size;
    this.alphas[index] = options.alpha;
    this.initialAlphas[index] = options.alpha;
    this.lifetimes[index] = options.life;
    this.maxLifetimes[index] = options.life;
    this.growths[index] = options.growth;
    this.gravities[index] = options.gravity;
    this.drags[index] = options.drag;
  }

  update(dt: number): void {
    for (let index = 0; index < this.capacity; index += 1) {
      if (this.lifetimes[index] <= 0) continue;
      this.lifetimes[index] -= dt;
      if (this.lifetimes[index] <= 0) {
        this.lifetimes[index] = 0;
        this.alphas[index] = 0;
        continue;
      }
      const offset = index * 3;
      const dragFactor = Math.max(0, 1 - this.drags[index] * dt);
      this.velocities[offset] *= dragFactor;
      this.velocities[offset + 1] *= dragFactor;
      this.velocities[offset + 2] *= dragFactor;
      this.velocities[offset + 1] += this.gravities[index] * dt;

      this.positions[offset] += this.velocities[offset] * dt;
      this.positions[offset + 1] += this.velocities[offset + 1] * dt;
      this.positions[offset + 2] += this.velocities[offset + 2] * dt;

      this.sizes[index] = Math.max(0.001, this.sizes[index] + this.growths[index] * dt);
      const remain = this.lifetimes[index] / this.maxLifetimes[index];
      this.alphas[index] = this.initialAlphas[index] * (remain * remain * (3 - 2 * remain));
    }
    this.positionAttribute.needsUpdate = true;
    this.colorAttribute.needsUpdate = true;
    this.sizeAttribute.needsUpdate = true;
    this.alphaAttribute.needsUpdate = true;
  }

  setScreenScale(scale: number): void {
    this.material.uniforms.uScale.value = scale;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* -------------------------------- 漂浮尘埃 -------------------------------- */

const DUST_VERTEX = /* glsl */ `
attribute float aPhase;
attribute float aSize;
uniform float uTime;
uniform float uScale;
varying float vAlpha;
void main() {
  vec3 p = position;
  p.x += sin(uTime * 0.17 + aPhase * 6.283) * 1.7;
  p.y += sin(uTime * 0.12 + aPhase * 4.1) * 0.4;
  p.z += cos(uTime * 0.15 + aPhase * 5.3) * 1.7;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(aSize * uScale / max(0.1, -mv.z), 1.0, 26.0);
  vAlpha = 0.1 + 0.10 * sin(uTime * 0.5 + aPhase * 9.0);
  gl_Position = projectionMatrix * mv;
}
`;

const DUST_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
varying float vAlpha;
void main() {
  float alpha = texture2D(uMap, gl_PointCoord).a * vAlpha;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(uColor, alpha);
}
`;

/* --------------------------------- 池化网格特效 -------------------------------- */

type EffectKind = 'flash' | 'fireball' | 'ring';

interface EffectInstance {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
  readonly kind: EffectKind;
  readonly duration: number;
  age: number;
}

/**
 * 创建特效系统。所有资源在 dispose 时释放；场景里只新增 2 个 Points + 若干池化网格 + 1 个点光。
 */
export function createFx(scene: THREE.Scene): FxSystem {
  const texture = makeSoftTexture();
  const bright = new ParticlePool(320, texture, THREE.AdditiveBlending);
  const smoke = new ParticlePool(380, texture, THREE.NormalBlending);
  bright.object.renderOrder = 5;
  smoke.object.renderOrder = 3;
  scene.add(bright.object, smoke.object);

  const spinner = new THREE.Group();
  scene.add(spinner);

  /* ------------------------------ 漂浮尘埃 ------------------------------ */
  const DUST_COUNT = 220;
  const dustPositions = new Float32Array(DUST_COUNT * 3);
  const dustPhases = new Float32Array(DUST_COUNT);
  const dustSizes = new Float32Array(DUST_COUNT);
  const dustGeometry = new THREE.BufferGeometry();
  const dustPositionAttribute = new THREE.BufferAttribute(dustPositions, 3).setUsage(
    THREE.DynamicDrawUsage,
  );
  const dustPhaseAttribute = new THREE.BufferAttribute(dustPhases, 1);
  const dustSizeAttribute = new THREE.BufferAttribute(dustSizes, 1);
  dustGeometry.setAttribute('position', dustPositionAttribute);
  dustGeometry.setAttribute('aPhase', dustPhaseAttribute);
  dustGeometry.setAttribute('aSize', dustSizeAttribute);
  const dustMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uColor: { value: new THREE.Color(0.85, 0.72, 0.5) },
      uTime: { value: 0 },
      uScale: { value: 700 },
    },
    vertexShader: DUST_VERTEX,
    fragmentShader: DUST_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const dust = new THREE.Points(dustGeometry, dustMaterial);
  dust.frustumCulled = false;
  dust.renderOrder = 2;
  scene.add(dust);

  /** 在竞技场上空重新撒一遍漂浮尘埃（确定性由 Math.random 即可，尘埃无需与布局一致）。 */
  function scatterDust(width: number, height: number): void {
    for (let index = 0; index < DUST_COUNT; index += 1) {
      const offset = index * 3;
      dustPositions[offset] = Math.random() * width;
      dustPositions[offset + 1] = 0.3 + Math.random() * 7.5;
      dustPositions[offset + 2] = Math.random() * height;
      dustPhases[index] = Math.random();
      dustSizes[index] = 0.035 + Math.random() * 0.07;
    }
    dustPositionAttribute.needsUpdate = true;
    dustPhaseAttribute.needsUpdate = true;
    dustSizeAttribute.needsUpdate = true;
  }
  scatterDust(48, 48);

  /* ------------------------------ 池化网格 ------------------------------ */
  const flashGeometry = new THREE.ConeGeometry(0.5, 1.5, 8);
  flashGeometry.rotateZ(-Math.PI / 2); // 锥体轴线转到 +x，配合 rotation.y = -angle
  const fireballGeometry = new THREE.SphereGeometry(1, 16, 12);
  const ringGeometry = new THREE.RingGeometry(0.9, 1.25, 40);
  ringGeometry.rotateX(-Math.PI / 2);

  const effects: EffectInstance[] = [];

  function addEffectPool(
    geometry: THREE.BufferGeometry,
    kind: EffectKind,
    count: number,
    duration: number,
    color: number,
    opacity: number,
  ): void {
    for (let index = 0; index < count; index += 1) {
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      // 炮口火光用 HDR 颜色，让 Bloom 能够拾取到眩光
      if (kind === 'flash') material.color.setRGB(1.6, 1.1, 0.6);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      spinner.add(mesh);
      effects.push({ mesh, material, kind, duration, age: duration });
    }
  }

  addEffectPool(flashGeometry, 'flash', 8, 0.1, 0xffd08a, 1);
  addEffectPool(fireballGeometry, 'fireball', 4, 0.55, 0xff8f42, 0.85);
  addEffectPool(ringGeometry, 'ring', 4, 0.65, 0xffb066, 0.75);

  function activate(
    kind: EffectKind,
    x: number,
    y: number,
    z: number,
    rotationY: number,
  ): void {
    for (const effect of effects) {
      if (effect.kind !== kind || effect.age < effect.duration) continue;
      effect.age = 0;
      effect.mesh.position.set(x, y, z);
      effect.mesh.rotation.set(0, rotationY, 0);
      effect.mesh.scale.setScalar(1);
      effect.mesh.visible = true;
      return;
    }
  }

  /* -------------------------------- 闪光灯 -------------------------------- */
  /* ------------------------------ 贴花池 ------------------------------ */
  const DECAL_CAPACITY = 24;
  const decalAtlas = makeDecalAtlasTexture();
  const decalGeometry = new THREE.PlaneGeometry(1, 1);
  const decalAlphaAttribute = new THREE.InstancedBufferAttribute(
    new Float32Array(DECAL_CAPACITY),
    1,
  ).setUsage(THREE.DynamicDrawUsage);
  const decalTileAttribute = new THREE.InstancedBufferAttribute(
    new Float32Array(DECAL_CAPACITY * 2),
    2,
  ).setUsage(THREE.DynamicDrawUsage);
  decalGeometry.setAttribute('aAlpha', decalAlphaAttribute);
  decalGeometry.setAttribute('aTile', decalTileAttribute);
  const decalMaterial = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: decalAtlas } },
    vertexShader: DECAL_VERTEX,
    fragmentShader: DECAL_FRAGMENT,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const decalMesh = new THREE.InstancedMesh(decalGeometry, decalMaterial, DECAL_CAPACITY);
  decalMesh.frustumCulled = false;
  decalMesh.renderOrder = 2;
  scene.add(decalMesh);
  const decalAge = new Float32Array(DECAL_CAPACITY).fill(1e6);
  const decalLife = new Float32Array(DECAL_CAPACITY).fill(1);
  const decalSize = new Float32Array(DECAL_CAPACITY).fill(1);
  const decalMatrix = new THREE.Matrix4();
  const decalPosition = new THREE.Vector3();
  const decalQuaternion = new THREE.Quaternion();
  const decalScaleVector = new THREE.Vector3();
  const decalNormal = new THREE.Vector3();
  const DECAL_FORWARD = new THREE.Vector3(0, 0, 1);
  let decalCursor = 0;

  function spawnDecal(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    kind: number,
    size: number,
    life: number,
  ): void {
    const slot = decalCursor;
    decalCursor = (decalCursor + 1) % DECAL_CAPACITY;
    decalAge[slot] = 0;
    decalLife[slot] = life;
    decalSize[slot] = size;
    decalNormal.copy(normal).normalize();
    decalPosition.copy(point).addScaledVector(decalNormal, 0.03);
    decalQuaternion.setFromUnitVectors(DECAL_FORWARD, decalNormal);
    decalScaleVector.set(size, size, 1);
    decalMatrix.compose(decalPosition, decalQuaternion, decalScaleVector);
    decalMesh.setMatrixAt(slot, decalMatrix);
    decalAlphaAttribute.array[slot] = 1;
    const tileChoices: Array<[number, number]> = [
      [0, 0],
      [0.5, 0],
      [0, 0.5],
      [0.5, 0.5],
    ];
    const tile = tileChoices[kind % 4] ?? tileChoices[0];
    decalTileAttribute.array[slot * 2] = tile[0];
    decalTileAttribute.array[slot * 2 + 1] = tile[1];
    decalTileAttribute.needsUpdate = true;
    decalAlphaAttribute.needsUpdate = true;
    decalMesh.instanceMatrix.needsUpdate = true;
  }

  /* ------------------------------ 碎片池 ------------------------------ */
  const DEBRIS_CAPACITY = 28;
  const debrisGeometry = new THREE.BoxGeometry(1, 1, 1);
  const debrisAlphaAttribute = new THREE.InstancedBufferAttribute(
    new Float32Array(DEBRIS_CAPACITY),
    1,
  ).setUsage(THREE.DynamicDrawUsage);
  const debrisTintAttribute = new THREE.InstancedBufferAttribute(
    new Float32Array(DEBRIS_CAPACITY * 3),
    3,
  ).setUsage(THREE.DynamicDrawUsage);
  debrisGeometry.setAttribute('aAlpha', debrisAlphaAttribute);
  debrisGeometry.setAttribute('aTint', debrisTintAttribute);
  const debrisMaterial = new THREE.ShaderMaterial({
    vertexShader: DEBRIS_VERTEX,
    fragmentShader: DEBRIS_FRAGMENT,
    transparent: true,
    depthWrite: false,
  });
  const debrisMesh = new THREE.InstancedMesh(debrisGeometry, debrisMaterial, DEBRIS_CAPACITY);
  debrisMesh.frustumCulled = false;
  debrisMesh.renderOrder = 3;
  scene.add(debrisMesh);
  const debrisPos = new Float32Array(DEBRIS_CAPACITY * 3);
  const debrisVel = new Float32Array(DEBRIS_CAPACITY * 3);
  const debrisRot = new Float32Array(DEBRIS_CAPACITY * 3);
  const debrisRotVel = new Float32Array(DEBRIS_CAPACITY * 3);
  const debrisLife = new Float32Array(DEBRIS_CAPACITY).fill(0);
  const debrisMaxLife = new Float32Array(DEBRIS_CAPACITY).fill(1);
  const debrisSize = new Float32Array(DEBRIS_CAPACITY).fill(0.1);
  let debrisCursor = 0;
  const debrisMatrix = new THREE.Matrix4();
  const debrisQuaternion = new THREE.Quaternion();
  const debrisEuler = new THREE.Euler();
  const debrisPosV = new THREE.Vector3();
  const debrisScaleV = new THREE.Vector3();
  for (let slot = 0; slot < DEBRIS_CAPACITY; slot += 1) {
    debrisAlphaAttribute.array[slot] = 0;
    debrisMesh.setMatrixAt(slot, new THREE.Matrix4().makeScale(0, 0, 0));
  }
  debrisMesh.instanceMatrix.needsUpdate = true;
  debrisAlphaAttribute.needsUpdate = true;

  function spawnDebris(
    worldX: number,
    worldY: number,
    count: number,
    speedMin: number,
    speedMax: number,
    sizeMin: number,
    sizeMax: number,
    life: number,
    tints: Array<[number, number, number]>,
  ): void {
    for (let index = 0; index < count; index += 1) {
      const slot = debrisCursor;
      debrisCursor = (debrisCursor + 1) % DEBRIS_CAPACITY;
      const angle = Math.random() * Math.PI * 2;
      const speed = speedMin + Math.random() * (speedMax - speedMin);
      const offset = slot * 3;
      debrisPos[offset] = worldX + (Math.random() - 0.5) * 0.8;
      debrisPos[offset + 1] = 0.6 + Math.random() * 0.8;
      debrisPos[offset + 2] = worldY + (Math.random() - 0.5) * 0.8;
      debrisVel[offset] = Math.cos(angle) * speed;
      debrisVel[offset + 1] = 1.5 + Math.random() * speed * 0.9;
      debrisVel[offset + 2] = Math.sin(angle) * speed;
      debrisRot[offset] = Math.random() * Math.PI;
      debrisRot[offset + 1] = Math.random() * Math.PI;
      debrisRot[offset + 2] = Math.random() * Math.PI;
      debrisRotVel[offset] = (Math.random() - 0.5) * 8;
      debrisRotVel[offset + 1] = (Math.random() - 0.5) * 8;
      debrisRotVel[offset + 2] = (Math.random() - 0.5) * 8;
      debrisLife[slot] = life * (0.7 + Math.random() * 0.3);
      debrisMaxLife[slot] = debrisLife[slot];
      debrisSize[slot] = sizeMin + Math.random() * (sizeMax - sizeMin);
      const tint = tints[Math.floor(Math.random() * tints.length)] ?? [0.3, 0.28, 0.25];
      debrisTintAttribute.array[offset] = tint[0];
      debrisTintAttribute.array[offset + 1] = tint[1];
      debrisTintAttribute.array[offset + 2] = tint[2];
      debrisAlphaAttribute.array[slot] = 1;
    }
    debrisTintAttribute.needsUpdate = true;
    debrisAlphaAttribute.needsUpdate = true;
  }

  /* ------------------------------ 黑烟柱 ------------------------------ */
  interface SmokeColumn {
    x: number;
    z: number;
    elapsed: number;
    duration: number;
    emitTimer: number;
  }
  const smokeColumns: SmokeColumn[] = [];

  const flashLight = new THREE.PointLight(0xffb066, 0, 34, 2);
  flashLight.position.set(0, 8, 0);
  scene.add(flashLight);

  /* -------------------------------- 颜色常量 -------------------------------- */
  const FIRE_COLOR = new THREE.Color(1.0, 0.72, 0.32);
  const SPARK_COLOR = new THREE.Color(1.0, 0.86, 0.5);
  const SMOKE_COLOR = new THREE.Color(0.34, 0.36, 0.4);
  const DARK_SMOKE_COLOR = new THREE.Color(0.22, 0.23, 0.26);
  const LIGHT_SMOKE_COLOR = new THREE.Color(0.46, 0.47, 0.5);

  /* -------------------------------- 事件特效 -------------------------------- */
  function muzzle(worldX: number, worldY: number, angle: number): void {
    const z = worldY;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const originX = worldX + dx * 0.6;
    const originZ = z + dz * 0.6;

    // 炮口闪光锥
    activate('flash', originX, 0.96, originZ, -angle);
    flashLight.position.set(originX, 1.4, originZ);
    flashLight.intensity = 7;
    flashLight.color.setHex(0xffcf8a);

    // 前向喷出的火星
    for (let index = 0; index < 12; index += 1) {
      const spreadX = (Math.random() - 0.5) * 0.7;
      const spreadZ = (Math.random() - 0.5) * 0.7;
      const speed = 5 + Math.random() * 10;
      bright.spawn({
        x: originX,
        y: 0.95,
        z: originZ,
        vx: (dx + spreadX) * speed,
        vy: (Math.random() - 0.15) * 3,
        vz: (dz + spreadZ) * speed,
        color: FIRE_COLOR,
        size: 0.16,
        growth: 0.1,
        life: 0.16 + Math.random() * 0.14,
        gravity: -6,
        drag: 2.4,
        alpha: 1,
      });
    }
    // 炮口余烟
    for (let index = 0; index < 5; index += 1) {
      smoke.spawn({
        x: originX + (Math.random() - 0.5) * 0.3,
        y: 0.95,
        z: originZ + (Math.random() - 0.5) * 0.3,
        vx: dx * (1.2 + Math.random()) + (Math.random() - 0.5) * 0.6,
        vy: 0.5 + Math.random() * 0.5,
        vz: dz * (1.2 + Math.random()) + (Math.random() - 0.5) * 0.6,
        color: SMOKE_COLOR,
        size: 0.5,
        growth: 1.4,
        life: 0.5 + Math.random() * 0.4,
        gravity: 0.5,
        drag: 1.4,
        alpha: 0.32,
      });
    }
  }

  function hit(worldX: number, worldY: number): void {
    const z = worldY;
    flashLight.position.set(worldX, 1.2, z);
    flashLight.intensity = 5;
    flashLight.color.setHex(0xffd7a0);
    activate('flash', worldX, 1.0, z, 0);

    // 金属火花：更多、更快、带一点拖尾感
    for (let index = 0; index < 24; index += 1) {
      const theta = Math.random() * Math.PI * 2;
      const speed = 3 + Math.random() * 8;
      bright.spawn({
        x: worldX,
        y: 0.85,
        z,
        vx: Math.cos(theta) * speed,
        vy: 1.4 + Math.random() * 5,
        vz: Math.sin(theta) * speed,
        color: index % 4 === 0 ? SPARK_COLOR : FIRE_COLOR,
        size: 0.13 + Math.random() * 0.1,
        growth: -0.05,
        life: 0.25 + Math.random() * 0.3,
        gravity: -14,
        drag: 1.1,
        alpha: 1,
      });
    }
    // 小烟团 + 高亮碎片
    for (let index = 0; index < 4; index += 1) {
      smoke.spawn({
        x: worldX + (Math.random() - 0.5) * 0.5,
        y: 0.85,
        z: z + (Math.random() - 0.5) * 0.5,
        vx: (Math.random() - 0.5) * 1.4,
        vy: 0.9 + Math.random() * 1.1,
        vz: (Math.random() - 0.5) * 1.4,
        color: SMOKE_COLOR,
        size: 0.42,
        growth: 1.4,
        life: 0.6 + Math.random() * 0.5,
        gravity: 0.7,
        drag: 1.2,
        alpha: 0.3,
      });
    }
  }

  function kill(worldX: number, worldY: number): void {
    const z = worldY;

    // 第一段：瞬时闪光 + 冲击环
    activate('flash', worldX, 1.1, z, 0);
    activate('ring', worldX, 0.06, z, 0);
    flashLight.position.set(worldX, 2.6, z);
    flashLight.color.setHex(0xffa04a);
    flashLight.intensity = 32;

    // 第二段：双火球（避免一整片白，用两层不同大小/位置）
    activate('fireball', worldX, 1.0, z, 0);
    activate('fireball', worldX + (Math.random() - 0.5) * 1.2, 0.6, z + (Math.random() - 0.5) * 1.2, 0);

    // 第三段：地面焦痕（大贴花，缓慢淡出）
    spawnDecal(
      new THREE.Vector3(worldX, 0.02, z),
      new THREE.Vector3(0, 1, 0),
      0,
      3.4,
      12,
    );

    // 第四段：抛物碎片（金属/泥土混合）
    spawnDebris(worldX, z, 20, 2.5, 7.5, 0.09, 0.24, 1.9, [
      [0.22, 0.2, 0.18],
      [0.35, 0.3, 0.26],
      [0.16, 0.13, 0.1],
      [0.5, 0.3, 0.12],
    ]);

    // 第五段：火球碎屑
    for (let index = 0; index < 28; index += 1) {
      const theta = Math.random() * Math.PI * 2;
      const speed = 3 + Math.random() * 12;
      bright.spawn({
        x: worldX,
        y: 0.9 + Math.random() * 0.8,
        z,
        vx: Math.cos(theta) * speed,
        vy: 1 + Math.random() * 9,
        vz: Math.sin(theta) * speed,
        color: index % 3 === 0 ? SPARK_COLOR : FIRE_COLOR,
        size: 0.18 + Math.random() * 0.2,
        growth: -0.05,
        life: 0.45 + Math.random() * 0.7,
        gravity: -9,
        drag: 1.3,
        alpha: 1,
      });
    }
    // 第六段：初始烟团
    for (let index = 0; index < 16; index += 1) {
      const theta = Math.random() * Math.PI * 2;
      const radius = 1.2 + Math.random() * 2.2;
      smoke.spawn({
        x: worldX + Math.cos(theta) * radius,
        y: 0.7 + Math.random() * 1.2,
        z: z + Math.sin(theta) * radius,
        vx: Math.cos(theta) * (0.6 + Math.random() * 2.2),
        vy: 1.4 + Math.random() * 2.6,
        vz: Math.sin(theta) * (0.6 + Math.random() * 2.2),
        color: index % 2 === 0 ? LIGHT_SMOKE_COLOR : SMOKE_COLOR,
        size: 0.9 + Math.random() * 0.6,
        growth: 2.2,
        life: 1.0 + Math.random() * 1.1,
        gravity: 0.9,
        drag: 1.1,
        alpha: 0.34,
      });
    }
    // 第七段：持续 3.6s 的黑烟柱
    smokeColumns.push({ x: worldX, z, elapsed: 0, duration: 3.6, emitTimer: 0 });
  }

  /** 子弹命中掩体/边界墙：按表面材质分层 + 贴合表面的弹坑/烧蚀贴花。 */
  function impact(_worldX: number, _worldY: number, surface: ImpactSurface): void {
    const point = surface.point;
    const normal = surface.normal.clone().normalize();
    const kind = surface.kind;
    flashLight.position.set(point.x, point.y + 0.35, point.z);
    flashLight.color.setHex(0xffd9b0);
    flashLight.intensity = 4;

    const push = (speedMin: number, speedMax: number): [number, number, number] => {
      const theta = Math.random() * Math.PI * 2;
      const speed = speedMin + Math.random() * (speedMax - speedMin);
      return [
        normal.x * speed + Math.cos(theta) * speed * 0.55,
        normal.y * speed + 1 + Math.random() * 2.4,
        normal.z * speed + Math.sin(theta) * speed * 0.55,
      ];
    };

    if (kind === 'metal') {
      // 金属火花 + 烧蚀痕
      for (let index = 0; index < 26; index += 1) {
        const [vx, vy, vz] = push(3, 9);
        bright.spawn({
          x: point.x,
          y: point.y,
          z: point.z,
          vx,
          vy,
          vz,
          color: index % 4 === 0 ? SPARK_COLOR : FIRE_COLOR,
          size: 0.12 + Math.random() * 0.1,
          growth: -0.04,
          life: 0.22 + Math.random() * 0.3,
          gravity: -13,
          drag: 1.1,
          alpha: 1,
        });
      }
      for (let index = 0; index < 3; index += 1) {
        const [vx, vy, vz] = push(0.6, 1.8);
        smoke.spawn({
          x: point.x,
          y: point.y,
          z: point.z,
          vx,
          vy,
          vz,
          color: DARK_SMOKE_COLOR,
          size: 0.4,
          growth: 1.4,
          life: 0.7 + Math.random() * 0.5,
          gravity: 0.5,
          drag: 1,
          alpha: 0.28,
        });
      }
      spawnDebris(point.x, point.z, 5, 1.6, 4.2, 0.05, 0.11, 1.0, [
        [0.32, 0.3, 0.26],
        [0.45, 0.38, 0.3],
      ]);
      spawnDecal(point, normal, 2, 1.1, 9);
    } else if (kind === 'brick') {
      // 砖屑 + 灰尘 + 弹坑
      for (let index = 0; index < 20; index += 1) {
        const [vx, vy, vz] = push(1.6, 5);
        bright.spawn({
          x: point.x,
          y: point.y,
          z: point.z,
          vx,
          vy,
          vz,
          color: new THREE.Color(0.62, 0.4, 0.26),
          size: 0.1 + Math.random() * 0.08,
          growth: 0.02,
          life: 0.4 + Math.random() * 0.5,
          gravity: -11,
          drag: 1.2,
          alpha: 0.9,
        });
      }
      for (let index = 0; index < 7; index += 1) {
        const [vx, vy, vz] = push(0.4, 1.6);
        smoke.spawn({
          x: point.x + (Math.random() - 0.5) * 0.4,
          y: point.y + (Math.random() - 0.5) * 0.3,
          z: point.z + (Math.random() - 0.5) * 0.4,
          vx,
          vy,
          vz,
          color: new THREE.Color(0.42, 0.36, 0.3),
          size: 0.5,
          growth: 1.6,
          life: 0.9 + Math.random() * 0.7,
          gravity: 0.5,
          drag: 1,
          alpha: 0.34,
        });
      }
      spawnDebris(point.x, point.z, 7, 1.6, 4.5, 0.06, 0.14, 1.1, [
        [0.42, 0.24, 0.16],
        [0.5, 0.3, 0.2],
        [0.32, 0.28, 0.24],
      ]);
      spawnDecal(point, normal, 1, 1.25, 9.5);
    } else if (kind === 'sandbag') {
      // 沙粒飞散
      for (let index = 0; index < 22; index += 1) {
        const [vx, vy, vz] = push(1.2, 4);
        bright.spawn({
          x: point.x,
          y: point.y,
          z: point.z,
          vx,
          vy,
          vz,
          color: new THREE.Color(0.78, 0.66, 0.44),
          size: 0.09 + Math.random() * 0.07,
          growth: 0,
          life: 0.3 + Math.random() * 0.4,
          gravity: -10,
          drag: 1.4,
          alpha: 0.85,
        });
      }
      for (let index = 0; index < 4; index += 1) {
        const [vx, vy, vz] = push(0.4, 1.4);
        smoke.spawn({
          x: point.x,
          y: point.y,
          z: point.z,
          vx,
          vy,
          vz,
          color: new THREE.Color(0.52, 0.46, 0.34),
          size: 0.45,
          growth: 1.5,
          life: 0.8 + Math.random() * 0.6,
          gravity: 0.4,
          drag: 1,
          alpha: 0.3,
        });
      }
      spawnDecal(point, normal, 3, 0.95, 9);
    } else if (kind === 'concrete') {
      // 混凝土碎屑 + 灰尘
      for (let index = 0; index < 16; index += 1) {
        const [vx, vy, vz] = push(1.5, 4.5);
        bright.spawn({
          x: point.x,
          y: point.y,
          z: point.z,
          vx,
          vy,
          vz,
          color: new THREE.Color(0.7, 0.7, 0.66),
          size: 0.1,
          growth: 0,
          life: 0.35 + Math.random() * 0.4,
          gravity: -11,
          drag: 1.2,
          alpha: 0.9,
        });
      }
      for (let index = 0; index < 6; index += 1) {
        const [vx, vy, vz] = push(0.4, 1.5);
        smoke.spawn({
          x: point.x,
          y: point.y,
          z: point.z,
          vx,
          vy,
          vz,
          color: SMOKE_COLOR,
          size: 0.5,
          growth: 1.6,
          life: 0.9 + Math.random() * 0.6,
          gravity: 0.5,
          drag: 1,
          alpha: 0.3,
        });
      }
      spawnDecal(point, normal, 1, 1.0, 9);
    } else {
      // 地面：尘土 + 小焦痕
      for (let index = 0; index < 5; index += 1) {
        smoke.spawn({
          x: point.x + (Math.random() - 0.5) * 0.5,
          y: 0.25,
          z: point.z + (Math.random() - 0.5) * 0.5,
          vx: (Math.random() - 0.5) * 1.6,
          vy: 0.6 + Math.random() * 0.8,
          vz: (Math.random() - 0.5) * 1.6,
          color: new THREE.Color(0.5, 0.46, 0.4),
          size: 0.45,
          growth: 1.4,
          life: 0.7 + Math.random() * 0.5,
          gravity: 0.4,
          drag: 1.2,
          alpha: 0.3,
        });
      }
      spawnDecal(point, normal, 0, 0.9, 8);
    }

    // 瞬间亮光内的一小簇火花（所有表面通用）
    for (let index = 0; index < 4; index += 1) {
      const [vx, vy, vz] = push(2, 5);
      bright.spawn({
        x: point.x,
        y: point.y,
        z: point.z,
        vx,
        vy,
        vz,
        color: SPARK_COLOR,
        size: 0.1,
        growth: -0.03,
        life: 0.18 + Math.random() * 0.2,
        gravity: -12,
        drag: 1.1,
        alpha: 1,
      });
    }
  }

  function damageSmoke(worldX: number, worldY: number): void {
    smoke.spawn({
      x: worldX + (Math.random() - 0.5) * 0.3,
      y: 0.8,
      z: worldY + (Math.random() - 0.5) * 0.3,
      vx: (Math.random() - 0.5) * 0.35,
      vy: 1.0 + Math.random() * 0.7,
      vz: (Math.random() - 0.5) * 0.35,
      color: DARK_SMOKE_COLOR,
      size: 0.55,
      growth: 1.5,
      life: 0.9 + Math.random() * 0.7,
      gravity: 0.8,
      drag: 0.9,
      alpha: 0.34,
    });
  }

  function damageSpark(worldX: number, worldY: number): void {
    for (let index = 0; index < 3; index += 1) {
      const theta = Math.random() * Math.PI * 2;
      bright.spawn({
        x: worldX + (Math.random() - 0.5) * 0.5,
        y: 0.75,
        z: worldY + (Math.random() - 0.5) * 0.5,
        vx: Math.cos(theta) * (0.8 + Math.random() * 2.2),
        vy: 1.4 + Math.random() * 2.4,
        vz: Math.sin(theta) * (0.8 + Math.random() * 2.2),
        color: SPARK_COLOR,
        size: 0.1,
        growth: -0.02,
        life: 0.2 + Math.random() * 0.3,
        gravity: -10,
        drag: 1.2,
        alpha: 1,
      });
    }
  }

  /* -------------------------------- 帧更新 -------------------------------- */
  function update(dt: number): void {
    bright.update(dt);
    smoke.update(dt);
    dustMaterial.uniforms.uTime.value += dt;

    // 贴花：缓慢淡出并回收
    let decalDirty = false;
    for (let slot = 0; slot < DECAL_CAPACITY; slot += 1) {
      if (decalAge[slot] > decalLife[slot]) continue;
      decalAge[slot] += dt;
      const remain = 1 - decalAge[slot] / decalLife[slot];
      if (remain <= 0) {
        decalAge[slot] = decalLife[slot] + 1;
        decalAlphaAttribute.array[slot] = 0;
        decalMesh.setMatrixAt(slot, decalMatrix.makeScale(0, 0, 0));
      } else {
        // 前 60% 时间保持，最后 40% 淡出
        decalAlphaAttribute.array[slot] = Math.min(1, remain / 0.4);
      }
      decalDirty = true;
    }
    if (decalDirty) {
      decalAlphaAttribute.needsUpdate = true;
      decalMesh.instanceMatrix.needsUpdate = true;
    }

    // 碎片：重力/旋转/落地反弹/淡出
    let debrisDirty = false;
    for (let slot = 0; slot < DEBRIS_CAPACITY; slot += 1) {
      if (debrisLife[slot] <= 0) continue;
      debrisLife[slot] -= dt;
      const offset = slot * 3;
      if (debrisLife[slot] <= 0) {
        debrisAlphaAttribute.array[slot] = 0;
        debrisMesh.setMatrixAt(slot, debrisMatrix.makeScale(0, 0, 0));
        debrisDirty = true;
        continue;
      }
      debrisVel[offset + 1] -= 18 * dt;
      debrisPos[offset] += debrisVel[offset] * dt;
      debrisPos[offset + 1] += debrisVel[offset + 1] * dt;
      debrisPos[offset + 2] += debrisVel[offset + 2] * dt;
      const half = debrisSize[slot] * 0.5;
      if (debrisPos[offset + 1] < half) {
        debrisPos[offset + 1] = half;
        debrisVel[offset + 1] *= -0.32;
        debrisVel[offset] *= 0.68;
        debrisVel[offset + 2] *= 0.68;
        debrisRotVel[offset] *= 0.6;
        debrisRotVel[offset + 1] *= 0.6;
        debrisRotVel[offset + 2] *= 0.6;
      }
      debrisRot[offset] += debrisRotVel[offset] * dt;
      debrisRot[offset + 1] += debrisRotVel[offset + 1] * dt;
      debrisRot[offset + 2] += debrisRotVel[offset + 2] * dt;
      debrisPosV.set(debrisPos[offset], debrisPos[offset + 1], debrisPos[offset + 2]);
      debrisEuler.set(debrisRot[offset], debrisRot[offset + 1], debrisRot[offset + 2]);
      debrisQuaternion.setFromEuler(debrisEuler);
      debrisScaleV.setScalar(debrisSize[slot]);
      debrisMatrix.compose(debrisPosV, debrisQuaternion, debrisScaleV);
      debrisMesh.setMatrixAt(slot, debrisMatrix);
      const remain = debrisLife[slot] / debrisMaxLife[slot];
      debrisAlphaAttribute.array[slot] = Math.min(1, remain / 0.45);
      debrisDirty = true;
    }
    if (debrisDirty) {
      debrisAlphaAttribute.needsUpdate = true;
      debrisMesh.instanceMatrix.needsUpdate = true;
    }

    // 黑烟柱：击毁后持续 3–4 秒
    for (let index = smokeColumns.length - 1; index >= 0; index -= 1) {
      const column = smokeColumns[index];
      if (!column) continue;
      column.elapsed += dt;
      if (column.elapsed >= column.duration) {
        smokeColumns.splice(index, 1);
        continue;
      }
      column.emitTimer -= dt;
      if (column.emitTimer > 0) continue;
      column.emitTimer = 0.09;
      const intensity = 1 - column.elapsed / column.duration;
      const radius = 0.5 + column.elapsed * 0.35;
      const theta = Math.random() * Math.PI * 2;
      smoke.spawn({
        x: column.x + Math.cos(theta) * radius * 0.5,
        y: 0.5 + Math.random() * 0.9,
        z: column.z + Math.sin(theta) * radius * 0.5,
        vx: (Math.random() - 0.5) * 0.5,
        vy: 1.2 + Math.random() * 1.6,
        vz: (Math.random() - 0.5) * 0.5,
        color: index % 2 === 0 ? DARK_SMOKE_COLOR : SMOKE_COLOR,
        size: 0.8 + Math.random() * 0.8,
        growth: 2.0 + intensity * 1.4,
        life: 1.4 + Math.random() * 1.6,
        gravity: 0.7,
        drag: 0.9,
        alpha: 0.42 * (0.4 + intensity * 0.6),
      });
    }

    for (const effect of effects) {
      if (effect.age >= effect.duration) continue;
      effect.age += dt;
      const progress = Math.min(1, effect.age / effect.duration);
      if (effect.kind === 'flash') {
        effect.mesh.scale.setScalar(1 + progress * 0.8);
        effect.material.opacity = (1 - progress) * 0.95;
      } else if (effect.kind === 'fireball') {
        const grow = 0.55 + (1 - Math.pow(1 - progress, 3)) * 2.4;
        effect.mesh.scale.setScalar(grow);
        effect.material.opacity = (1 - progress) * (1 - progress) * 0.62;
        // HDR 颜色：偏橙红，避免整片白，随进度衰减
        effect.material.color.setRGB(
          0.95 * (1 - progress * 0.65),
          0.45 * (1 - progress * 0.75),
          0.1 * (1 - progress * 0.85),
        );
      } else {
        effect.mesh.scale.setScalar(1 + progress * 7);
        effect.material.opacity = (1 - progress) * 0.75;
      }
      if (progress >= 1) {
        effect.age = effect.duration;
        effect.mesh.visible = false;
      }
    }

    // 瞬时照亮快速衰减
    flashLight.intensity *= Math.exp(-dt * 9);
    if (flashLight.intensity < 0.02) flashLight.intensity = 0;
  }

  function setScreenScale(scale: number): void {
    bright.setScreenScale(scale);
    smoke.setScreenScale(scale);
    dustMaterial.uniforms.uScale.value = scale;
  }

  function dispose(): void {
    scene.remove(
      bright.object,
      smoke.object,
      spinner,
      flashLight,
      dust,
      decalMesh,
      debrisMesh,
    );
    decalAtlas.dispose();
    decalGeometry.dispose();
    decalMaterial.dispose();
    debrisGeometry.dispose();
    debrisMaterial.dispose();
    smokeColumns.length = 0;
    dustGeometry.dispose();
    dustMaterial.dispose();
    bright.dispose();
    smoke.dispose();
    for (const effect of effects) effect.material.dispose();
    effects.length = 0;
    flashGeometry.dispose();
    fireballGeometry.dispose();
    ringGeometry.dispose();
    texture.dispose();
  }

  return {
    update,
    setScreenScale,
    setMapBounds: scatterDust,
    muzzle,
    hit,
    impact,
    kill,
    damageSmoke,
    damageSpark,
    dispose,
  };
}
