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
export interface FxSystem {
  update(dt: number): void;
  /** 由 resize 调用：把点精灵的世界尺寸换算成像素（gl_PointSize 依赖画布高度与 fov）。 */
  setScreenScale(scale: number): void;
  /** 地图尺寸变化时重建漂浮尘埃的分布范围。 */
  setMapBounds(width: number, height: number): void;
  muzzle(worldX: number, worldY: number, angle: number): void;
  hit(worldX: number, worldY: number): void;
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
  const smoke = new ParticlePool(240, texture, THREE.NormalBlending);
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
    flashLight.intensity = 3;
    flashLight.color.setHex(0xffd7a0);

    for (let index = 0; index < 16; index += 1) {
      const theta = Math.random() * Math.PI * 2;
      const speed = 2.5 + Math.random() * 6;
      bright.spawn({
        x: worldX,
        y: 0.85,
        z,
        vx: Math.cos(theta) * speed,
        vy: 1.5 + Math.random() * 4.5,
        vz: Math.sin(theta) * speed,
        color: SPARK_COLOR,
        size: 0.14,
        growth: -0.05,
        life: 0.24 + Math.random() * 0.24,
        gravity: -14,
        drag: 1.1,
        alpha: 1,
      });
    }
    for (let index = 0; index < 3; index += 1) {
      smoke.spawn({
        x: worldX + (Math.random() - 0.5) * 0.4,
        y: 0.85,
        z: z + (Math.random() - 0.5) * 0.4,
        vx: (Math.random() - 0.5) * 1.2,
        vy: 0.8 + Math.random(),
        vz: (Math.random() - 0.5) * 1.2,
        color: SMOKE_COLOR,
        size: 0.4,
        growth: 1.2,
        life: 0.5 + Math.random() * 0.4,
        gravity: 0.6,
        drag: 1.2,
        alpha: 0.28,
      });
    }
  }

  function kill(worldX: number, worldY: number): void {
    const z = worldY;
    activate('fireball', worldX, 1.0, z, 0);
    activate('ring', worldX, 0.06, z, 0);

    flashLight.position.set(worldX, 2.6, z);
    flashLight.color.setHex(0xffb066);
    flashLight.intensity = 42;

    // 火球碎屑
    for (let index = 0; index < 26; index += 1) {
      const theta = Math.random() * Math.PI * 2;
      const speed = 3 + Math.random() * 11;
      bright.spawn({
        x: worldX,
        y: 0.9 + Math.random() * 0.8,
        z,
        vx: Math.cos(theta) * speed,
        vy: 1 + Math.random() * 8,
        vz: Math.sin(theta) * speed,
        color: index % 3 === 0 ? SPARK_COLOR : FIRE_COLOR,
        size: 0.2 + Math.random() * 0.2,
        growth: -0.05,
        life: 0.4 + Math.random() * 0.6,
        gravity: -9,
        drag: 1.3,
        alpha: 1,
      });
    }
    // 爆炸烟柱：从火球外侧升起，避免深色烟雾压在火球上形成「黑洞」
    for (let index = 0; index < 18; index += 1) {
      const theta = Math.random() * Math.PI * 2;
      const radius = 1.3 + Math.random() * 2.1;
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
        effect.material.opacity = (1 - progress) * (1 - progress) * 0.72;
        // HDR 颜色：爆炸初期明显超过 Bloom 阈值，随进度迅速衰减
        effect.material.color.setRGB(
          1.25 * (1 - progress * 0.6),
          0.72 * (1 - progress * 0.7),
          0.2 * (1 - progress * 0.8),
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
    scene.remove(bright.object, smoke.object, spinner, flashLight, dust);
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
    kill,
    damageSmoke,
    damageSpark,
    dispose,
  };
}
