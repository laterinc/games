/**
 * 坦克大战的高级色彩管线（后处理）与程序化环境光照。
 *
 * 管线顺序（与 three 的色彩管理约定一致）：
 *   RenderPass（线性 HDR，渲染到 HalfFloat RenderTarget）
 *   → UnrealBloomPass（内部以 1/2 分辨率生成高光泛光）
 *   → SMAAPass（SMAAPass 要求 linear-srgb 输入，必须在 OutputPass 之前）
 *   → OutputPass（读取 renderer 的 ACESFilmicToneMapping + sRGB 输出，做色调映射与色彩空间转换）
 *   → ColorGradePass（自写色彩分级：暖高光/冷阴影/对比/饱和/暗角/极轻颗粒）
 *
 * 另提供 `createDuskEnvironmentMap()`：用程序化黄昏天穹 + 暖色太阳生成 PMREM 环境贴图，
 * 让金属/车体有真实的反射层次（不依赖外部 HDR 资源）。
 *
 * 所有 render target / 材质 / 纹理都在 dispose() 中释放。
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

/** 黄昏冷调工业战场的统一配色（天空 / 雾 / 阳光方向）。 */
export const DUSK = {
  /** 地平线冷蓝灰（参考图里被天空照亮的远景）。 */
  horizon: new THREE.Color(0x93a5b3),
  /** 天顶深蓝。 */
  zenith: new THREE.Color(0x1a3143),
  /** 太阳暖白。 */
  sun: new THREE.Color(0xffe2bd),
  /** 大气雾色（与地平线接近，保证远景无缝）。 */
  fog: new THREE.Color(0x7d8e9b),
  /** 太阳方向（单位向量，较高的冷调日光，阴影清晰且偏蓝）。 */
  sunDirection: new THREE.Vector3(0.4, 0.72, 0.3).normalize(),
} as const;

/* ------------------------------ 后处理接口 ------------------------------ */

export interface PostPipeline {
  /** 渲染一帧（dt 秒），内部推进颗粒噪点时间。 */
  render(dt: number): void;
  /** 按 canvas CSS 尺寸与像素比同步 composer 与所有 pass。 */
  setSize(width: number, height: number, pixelRatio: number): void;
  /** 自适应降级用：关闭/开启 Bloom。 */
  setBloomEnabled(enabled: boolean): void;
  /** 当前 Bloom 是否开启。 */
  isBloomEnabled(): boolean;
  dispose(): void;
}

/** 色彩分级着色器：暖高光、冷阴影、对比/饱和、暗角、电影颗粒。 */
const ColorGradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uContrast: { value: 1.12 },
    uSaturation: { value: 1.1 },
    uVignette: { value: 0.28 },
    uGrain: { value: 0.018 },
    uShadowTint: { value: new THREE.Vector3(0.74, 0.86, 1.14) },
    uHighlightTint: { value: new THREE.Vector3(1.1, 1.02, 0.9) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uVignette;
    uniform float uGrain;
    uniform vec3 uShadowTint;
    uniform vec3 uHighlightTint;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 color = texel.rgb;
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));

      // 暖高光 / 冷阴影：按亮度在冷暖 tint 之间插值，营造黄昏电影感
      vec3 graded = color * mix(uShadowTint, uHighlightTint, smoothstep(0.12, 0.72, luma));

      // 对比与饱和（围绕 0.5 中灰）
      graded = (graded - 0.5) * uContrast + 0.5;
      float gradedLuma = dot(graded, vec3(0.2126, 0.7152, 0.0722));
      graded = mix(vec3(gradedLuma), graded, uSaturation);

      // 暗角：中心亮、边缘轻微压暗
      vec2 centered = vUv - 0.5;
      float vignette = smoothstep(0.82, 0.2, length(centered));
      graded *= mix(1.0, vignette, uVignette);

      // 极轻的逐帧颗粒，避免纯色渐变出现色带
      float grain = hash(vUv * vec2(1917.0, 1081.0) + uTime * 61.7) - 0.5;
      graded += grain * uGrain;

      gl_FragColor = vec4(clamp(graded, 0.0, 1.0), texel.a);
    }
  `,
};

/**
 * 创建后处理管线。
 * Bloom 强度/半径/阈值按「昏暗战场 + 发光子弹/爆炸」调校，半分辨率由 UnrealBloomPass 内部保证。
 */
export function createPostPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): PostPipeline {
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());

  const renderPass = new RenderPass(scene, camera);
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.4, 1.05);
  const smaaPass = new SMAAPass();
  const outputPass = new OutputPass();
  const gradePass = new ShaderPass(ColorGradeShader);

  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(smaaPass);
  composer.addPass(outputPass);
  composer.addPass(gradePass);

  let bloomEnabled = true;
  let elapsed = 0;

  return {
    render(dt: number): void {
      elapsed += dt;
      gradePass.uniforms.uTime.value = elapsed;
      composer.render(dt);
    },
    setSize(width: number, height: number, pixelRatio: number): void {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
      // composer.setSize 会把全分辨率传给每个 pass；UnrealBloomPass 内部再降一半，
      // 因此这里保持默认即可得到 1/2 分辨率的泛光缓冲。
    },
    setBloomEnabled(enabled: boolean): void {
      bloomEnabled = enabled;
      bloomPass.enabled = enabled;
    },
    isBloomEnabled(): boolean {
      return bloomEnabled;
    },
    dispose(): void {
      composer.dispose();
      renderPass.dispose();
      bloomPass.dispose();
      smaaPass.dispose();
      outputPass.dispose();
      gradePass.dispose();
    },
  };
}

/* ---------------------------- 程序化环境贴图 ---------------------------- */

/**
 * 生成黄昏天穹的 PMREM 环境贴图（供 scene.environment 使用），
 * 让金属与车体反射出「冷天空 + 暖太阳」的层次。
 */
export function createDuskEnvironmentMap(renderer: THREE.WebGLRenderer): {
  texture: THREE.Texture;
  dispose(): void;
} {
  const envScene = new THREE.Scene();

  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uHorizon: { value: DUSK.horizon.clone() },
      uZenith: { value: DUSK.zenith.clone() },
      uSunColor: { value: new THREE.Color(2.4, 2.0, 1.55) },
      uSunDir: { value: DUSK.sunDirection.clone() },
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
      varying vec3 vDirection;
      void main() {
        vec3 dir = normalize(vDirection);
        float height = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 color = mix(uHorizon, uZenith, pow(height, 1.35));
        float sun = pow(max(dot(dir, normalize(uSunDir)), 0.0), 28.0);
        color += uSunColor * sun;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 20), skyMaterial);
  envScene.add(sky);

  // 地面半球：压暗下方反射，避免车底出现不自然的高光
  const groundMaterial = new THREE.MeshBasicMaterial({ color: 0x232c33 });
  const ground = new THREE.Mesh(new THREE.SphereGeometry(9.5, 24, 12), groundMaterial);
  ground.scale.set(1, 0.55, 1);
  ground.position.y = -1.2;
  envScene.add(ground);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(envScene, 0.04, 0.1, 100);
  pmrem.dispose();

  sky.geometry.dispose();
  skyMaterial.dispose();
  ground.geometry.dispose();
  groundMaterial.dispose();

  return {
    texture: target.texture,
    dispose(): void {
      target.dispose();
    },
  };
}
