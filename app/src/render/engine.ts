import type { PackTextures } from "./packtex";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { blockTex } from "../api";
import { BlockTextures, loadPixelTexture } from "./textures";
import { ChunkManager } from "./chunks";
import { LodTerrain } from "./lod";
import { SkyDome, Clouds, skyState } from "./sky";
import { CHUNK_VERT, CHUNK_FRAG, DEPTH_VERT, DEPTH_FRAG, GRADE_FRAG } from "./shaders";
import { Collider, FlyControls, cinematicShots, type Shot } from "./controls";
import { Mobs } from "./mobs";
import { Walker } from "./walker";
import { Glow, LiveLayer, ContainerAnim } from "./props3d";
import { invoke } from "@tauri-apps/api/core";

export type Mode = "cinematic" | "orbit" | "fly" | "walk";

export interface EngineStats {
  fps: number;
  chunks: number;
  pending: number;
  quads: number;
}

export interface CaptureOpts {
  width: number;
  height: number;
  style?: "render" | "drawn" | "film" | "mono" | "cool";
  type?: "png" | "jpeg";
}

const GRADE_MODES: Record<string, number> = { render: 0, film: 1, mono: 2, drawn: 3, cool: 4 };

export class Engine {
  private static inst: Engine | null = null;
  static get(): Engine {
    if (!Engine.inst) Engine.inst = new Engine();
    return Engine.inst;
  }

  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(65, 16 / 9, 0.1, 4000);
  tex = new BlockTextures();
  chunks: ChunkManager;
  lod: LodTerrain;
  sky: SkyDome;
  clouds: Clouds;
  mobs: Mobs;
  orbit: OrbitControls;
  fly: FlyControls;
  walker: Walker;
  glow: Glow;
  live = new LiveLayer();
  anims = new Set<ContainerAnim>();
  nightVision = false;
  private hemi = new THREE.HemisphereLight(0xffffff, 0x404040, 1);
  private sunLight = new THREE.DirectionalLight(0xffffff, 1);
  collider = new Collider();
  mode: Mode = "cinematic";
  dim = "minecraft:overworld";
  uniforms: Record<string, THREE.IUniform>;
  private mats: { opaque: THREE.ShaderMaterial; translucent: THREE.ShaderMaterial; depth: THREE.ShaderMaterial };
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;
  private shadowRT: THREE.WebGLRenderTarget;
  private lightCam = new THREE.OrthographicCamera(-90, 90, 90, -90, 1, 700);
  container: HTMLElement | null = null;
  private running = false;
  private clock = new THREE.Clock();
  private frames = 0;
  private fpsT = 0;
  stats: EngineStats = { fps: 0, chunks: 0, pending: 0, quads: 0 };
  onStats: ((s: EngineStats) => void) | null = null;
  // time of day
  private dayTime = 6000;
  private dayTimeAt = 0;
  private timeLive = false;
  timeOverride: number | null = null;
  rain = 0;
  thunder = 0;
  private rainTarget = 0;
  // cinematic
  private shots: Shot[] = cinematicShots(1);
  private shotIdx = 0;
  private shotT = 0;
  poi = new THREE.Vector3(0, 70, 0);
  private camSmooth = { pos: new THREE.Vector3(), look: new THREE.Vector3(), init: false };
  quality = "high";
  gradeMode = "render";
  private resizeObs: ResizeObserver | null = null;
  private fade = 1;
  private fadeTarget = 1;

  private constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "engine-canvas";
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: "high-performance", alpha: false, stencil: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = true;
    this.renderer.setClearColor(0x0b0d10, 1);

    this.uniforms = {
      uTime: { value: 0 },
      uTicks: { value: 0 },
      uWind: { value: 1 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color() },
      uSkyAmbient: { value: new THREE.Color() },
      uBlockColor: { value: new THREE.Color() },
      uFogColor: { value: new THREE.Color() },
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uFogNear: { value: 120 },
      uFogFar: { value: 600 },
      uDaylight: { value: 1 },
      uRain: { value: 0 },
      uNether: { value: 0 },
      uMinLight: { value: new THREE.Color() },
    };
    const shadowDepth = new THREE.DepthTexture(2048, 2048);
    shadowDepth.type = THREE.UnsignedIntType;
    shadowDepth.compareFunction = THREE.LessEqualCompare;
    shadowDepth.magFilter = THREE.LinearFilter;
    shadowDepth.minFilter = THREE.LinearFilter;
    this.shadowRT = new THREE.WebGLRenderTarget(2048, 2048, { depthTexture: shadowDepth, depthBuffer: true });
    const chunkUniforms = (pass: number) => ({
      ...this.uniforms,
      uTex: { value: this.tex.tex },
      uAnim: { value: this.tex.anim },
      uShadowMap: { value: shadowDepth },
      uShadowOn: { value: 1 },
      uShadowTexel: { value: 1 / 2048 },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uPass: { value: pass },
      uFlash: { value: 0 },
      uTex2: { value: this.tex.tex },
      uSplit: { value: 1e9 },
    });
    this.mats = {
      opaque: new THREE.ShaderMaterial({ vertexShader: CHUNK_VERT, fragmentShader: CHUNK_FRAG, uniforms: chunkUniforms(0) }),
      translucent: new THREE.ShaderMaterial({ vertexShader: CHUNK_VERT, fragmentShader: CHUNK_FRAG, uniforms: chunkUniforms(1), transparent: true, depthWrite: false }),
      depth: new THREE.ShaderMaterial({
        vertexShader: DEPTH_VERT,
        fragmentShader: DEPTH_FRAG,
        uniforms: { ...this.uniforms, uTex: { value: this.tex.tex }, uAnim: { value: this.tex.anim } },
        side: THREE.DoubleSide,
      }),
    };
    // share the shadow matrix between the two chunk materials
    this.mats.translucent.uniforms.uShadowMatrix = this.mats.opaque.uniforms.uShadowMatrix;
    this.mats.translucent.uniforms.uShadowOn = this.mats.opaque.uniforms.uShadowOn;
    this.mats.translucent.uniforms.uSplit = this.mats.opaque.uniforms.uSplit;
    this.tex.onChange = () => {
      for (const m of [this.mats.opaque, this.mats.translucent, this.mats.depth]) {
        m.uniforms.uTex.value = this.tex.tex;
        m.uniforms.uAnim.value = this.tex.anim;
      }
      this.bindPack();
      // new blocks came into view: the pack needs their layers too
      this.pack?.ensure(this.tex.layers);
    };
    this.chunks = new ChunkManager(this.mats, this.tex);
    this.lod = new LodTerrain(this.uniforms);
    this.sky = new SkyDome(this.uniforms);
    this.clouds = new Clouds(this.uniforms, null);
    this.mobs = new Mobs(this.uniforms);
    this.scene.add(this.sky.mesh, this.lod.root, this.chunks.root, this.clouds.mesh, this.mobs.root);
    loadPixelTexture(blockTex("environment/clouds"))
      .then((t) => this.clouds.setTexture(t))
      .catch(() => {});

    this.orbit = new OrbitControls(this.camera, this.canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.minDistance = 3;
    this.orbit.maxDistance = 520;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.orbit.screenSpacePanning = false;
    this.orbit.zoomSpeed = 1.2;
    this.orbit.enabled = false;
    this.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.fly = new FlyControls(this.camera, this.canvas, this.collider);
    this.walker = new Walker(this.camera, this.canvas, this.scene);
    this.glow = new Glow(this.uniforms);
    this.glow.fetcher = (dim, chunks) => invoke<number[][]>("w_lights", { dim, chunks });
    // lights for the few plain three.js models (your player, opening chests); blocks use their own shader
    this.scene.add(this.hemi, this.sunLight, this.sunLight.target, this.glow.points, this.live.group);

    // post
    const rt = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.55, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uRes: { value: new THREE.Vector2(1, 1) },
        uVignette: { value: 0.35 },
        uMode: { value: 0 },
        uTime: { value: 0 },
        uGrain: { value: 0.018 },
        uFade: { value: 1 },
      },
      vertexShader: `out vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: GRADE_FRAG.replace("gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);", "gl_FragColor = vec4(clamp(c, 0.0, 1.0) * uFade, 1.0);").replace("uniform float uGrain;", "uniform float uGrain;\nuniform float uFade;"),
    });
    this.composer.addPass(this.grade);
    this.camera.position.set(40, 110, 40);
    this.camera.lookAt(0, 64, 0);
    this.applyQuality("high");
  }

  applyQuality(q: string) {
    this.quality = q;
    const high = q !== "low";
    this.mats.opaque.uniforms.uShadowOn.value = high ? 1 : 0;
    this.bloom.enabled = high;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q === "ultra" ? 2 : high ? 1.5 : 1));
    this.lod.range = q === "low" ? 1 : q === "ultra" ? 3 : 2;
    this.resize();
  }

  setRenderDistance(r: number) {
    this.chunks.radius = Math.max(4, Math.min(32, r));
    const R = this.chunks.radius * 16;
    this.uniforms.uFogNear.value = R * 0.9;
    this.uniforms.uFogFar.value = Math.max(R * 3.2, 700);
  }

  attach(el: HTMLElement) {
    if (this.container === el) return;
    if (this.container) this.detach();
    this.container = el;
    el.appendChild(this.canvas);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(el);
    this.resize();
    if (!this.running) {
      this.running = true;
      this.clock.getDelta();
      this.renderer.setAnimationLoop(() => this.tick());
    }
  }

  /** Stop rendering. With `el`, only if the engine is still attached to that element (a page that is
   * animating out must not detach the engine from the page that just took it over). */
  detach(el?: HTMLElement | null) {
    if (el && this.container !== el) return;
    if (this.container && this.canvas.parentElement === this.container) this.container.removeChild(this.canvas);
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.container = null;
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  get attached() {
    return !!this.container;
  }

  /** The resource pack being previewed (null: none). */
  pack: PackTextures | null = null;
  setPack(p: PackTextures | null) {
    if (this.pack && this.pack !== p) this.pack.dispose();
    this.pack = p;
    if (p) {
      p.onChange = () => this.bindPack();
      void p.ensure(this.tex.layers);
    } else {
      this.setSplit(null);
    }
    this.bindPack();
  }
  private bindPack() {
    const t = this.pack?.tex ?? this.tex.tex;
    this.mats.opaque.uniforms.uTex2.value = t;
    this.mats.translucent.uniforms.uTex2.value = t;
    this.setSplit(this.splitCss);
  }
  private splitCss: number | null = null;
  /** Where the pack starts on screen, in CSS px from the left of the view (0: everywhere; null: nowhere). */
  setSplit(cssX: number | null) {
    this.splitCss = cssX;
    const u = this.mats.opaque.uniforms.uSplit;
    if (cssX === null || !this.pack?.tex) u.value = 1e9;
    else u.value = cssX <= 0 ? -1 : cssX * this.renderer.getPixelRatio();
  }

  resize() {
    const el = this.container;
    const w = el ? el.clientWidth : 1280,
      h = el ? el.clientHeight : 720;
    if (w < 2 || h < 2) return;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.grade.uniforms.uRes.value.set(w * pr, h * pr);
    this.bloom.resolution.set(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setWorld(dim: string, seen: Set<string>, regions: Set<string>, seed: number) {
    this.dim = dim;
    this.chunks.reset(dim, seen);
    this.lod.reset(dim, regions);
    this.collider.reset(dim);
    this.mobs.reset(dim);
    this.glow.reset(dim);
    this.walker.grid.reset(dim);
    this.shots = cinematicShots(seed);
    this.shotIdx = 0;
    this.shotT = 0;
    this.camSmooth.init = false;
    this.clouds.mesh.visible = !dim.includes("nether") && !dim.includes("end") && !!this.clouds.mat.uniforms.uClouds.value;
  }

  updateSeen(seen: Set<string>, regions: Set<string>) {
    this.chunks.setSeen(seen);
    this.lod.available = regions;
  }

  invalidate(regions: [number, number][]) {
    this.chunks.invalidateRegions(regions);
    this.lod.invalidate(regions);
  }

  setTime(dayTime: number, live: boolean) {
    this.dayTime = dayTime;
    this.dayTimeAt = performance.now();
    this.timeLive = live;
  }

  setWeather(raining: boolean, thundering: boolean) {
    this.rainTarget = raining ? 1 : 0;
    this.thunder = thundering ? 1 : 0;
  }

  currentDayTime(): number {
    if (this.timeOverride !== null) return this.timeOverride;
    if (!this.timeLive) return this.dayTime;
    return this.dayTime + ((performance.now() - this.dayTimeAt) / 1000) * 20;
  }

  setMode(m: Mode) {
    this.mode = m;
    this.orbit.enabled = m === "orbit";
    this.fly.enabled = m === "fly";
    if (this.walker.enabled && m !== "walk") this.walker.leave();
    this.walker.enabled = m === "walk";
    if (m === "fly") this.fly.syncFromCamera();
    if (m === "orbit") {
      // keep looking at the same spot
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      const dist = Math.max(20, Math.min(120, this.camera.position.distanceTo(this.orbit.target)));
      this.orbit.target.copy(this.camera.position).addScaledVector(dir, dist);
      this.orbit.update();
    }
    if (m === "cinematic") this.camSmooth.init = false;
  }

  /** Point the camera at a spot (orbit mode) from a nice angle. */
  lookAtPoint(x: number, y: number, z: number, dist = 48) {
    this.orbit.target.set(x, y, z);
    const a = Math.atan2(this.camera.position.z - z, this.camera.position.x - x);
    this.camera.position.set(x + Math.cos(a) * dist * 0.75, y + dist * 0.6, z + Math.sin(a) * dist * 0.75);
    this.camera.lookAt(x, y, z);
    this.orbit.update();
  }

  setPOI(x: number, y: number, z: number) {
    this.poi.set(x, y, z);
    this.camSmooth.init = false;
  }

  focusPoint(): THREE.Vector3 {
    if (this.mode === "orbit") return this.orbit.target;
    if (this.mode === "cinematic") return this.poi;
    return this.camera.position;
  }

  fadeTo(v: number) {
    this.fadeTarget = v;
  }

  private updateCinematic(dt: number) {
    this.shotT += dt;
    let shot = this.shots[this.shotIdx % this.shots.length];
    if (this.shotT > shot.dur) {
      this.shotT = 0;
      this.shotIdx++;
      shot = this.shots[this.shotIdx % this.shots.length];
      this.camSmooth.init = false;
    }
    // fade at the cut
    const edge = Math.min(this.shotT, shot.dur - this.shotT);
    this.fadeTarget = Math.min(1, edge / 1.6);
    const { pos, look } = shot.at(this.shotT, this.poi);
    // keep above the ground
    const g = this.groundAt(pos.x, pos.z);
    if (g !== null && pos.y < g + 7) pos.y = g + 7;
    if (!this.camSmooth.init) {
      this.camSmooth.pos.copy(pos);
      this.camSmooth.look.copy(look);
      this.camSmooth.init = true;
    }
    const k = 1 - Math.exp(-dt * 1.5);
    this.camSmooth.pos.lerp(pos, k);
    this.camSmooth.look.lerp(look, k);
    this.camera.position.copy(this.camSmooth.pos);
    this.camera.lookAt(this.camSmooth.look);
  }

  groundAt(x: number, z: number): number | null {
    const l = this.lod.heightAt(x, z);
    const c = this.chunks.topNear(x, z);
    if (l !== null) return l;
    return c;
  }

  private updateUniforms(dt: number) {
    const t = this.clock.elapsedTime;
    this.uniforms.uTime.value = t;
    const dayTime = this.currentDayTime();
    this.uniforms.uTicks.value = (t * 20) % 1e6;
    this.rain += (this.rainTarget - this.rain) * Math.min(1, dt * 0.5);
    const s = skyState(dayTime, this.dim, this.rain, this.thunder);
    this.uniforms.uSunDir.value.copy(s.sunDir);
    this.uniforms.uSunColor.value.copy(s.sunColor);
    this.uniforms.uSkyAmbient.value.copy(s.skyAmbient);
    this.uniforms.uBlockColor.value.copy(s.blockColor);
    this.uniforms.uFogColor.value.copy(s.fog);
    this.uniforms.uZenith.value.copy(s.zenith);
    this.uniforms.uHorizon.value.copy(s.horizon);
    this.uniforms.uDaylight.value = s.daylight;
    this.uniforms.uRain.value = this.rain;
    this.uniforms.uNether.value = s.nether;
    this.uniforms.uMinLight.value.copy(s.minLight);
    if (this.nightVision) {
      const m = this.uniforms.uMinLight.value as THREE.Color;
      m.setRGB(Math.max(m.r, 0.78), Math.max(m.g, 0.78), Math.max(m.b, 0.82));
    }
    // plain models get the same sun and sky as the blocks
    this.hemi.color.copy(s.skyAmbient).multiplyScalar(1.6).add(this.uniforms.uMinLight.value as THREE.Color);
    this.hemi.groundColor.copy(s.skyAmbient).multiplyScalar(0.6);
    this.sunLight.color.copy(s.sunColor);
    this.sunLight.intensity = 1.2;
    this.sunLight.position.copy(this.camera.position).addScaledVector(s.sunDir, 50);
    this.sunLight.target.position.copy(this.camera.position);
    this.uniforms.uWind.value = 1 + this.rain * 0.8;
    this.sky.mat.uniforms.uRealSun.value.copy(s.realSun);
    this.sky.mat.uniforms.uStars.value = s.stars;
    this.clouds.follow(this.camera.position);
    this.renderer.setClearColor(s.fog);
  }

  private renderShadows() {
    if (!this.mats.opaque.uniforms.uShadowOn.value) return;
    const sun = this.uniforms.uSunDir.value as THREE.Vector3;
    if (sun.y < 0.02 || (this.uniforms.uSunColor.value as THREE.Color).r < 0.02) return;
    const focus = this.mode === "fly" || this.mode === "walk" ? this.camera.position.clone().add(this.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(40)) : this.focusPoint().clone();
    const size = 90;
    this.lightCam.left = -size;
    this.lightCam.right = size;
    this.lightCam.top = size;
    this.lightCam.bottom = -size;
    this.lightCam.near = 1;
    this.lightCam.far = 800;
    // stabilise: snap the focus to shadow texels in light space
    const lightPos = focus.clone().addScaledVector(sun, 350);
    this.lightCam.position.copy(lightPos);
    this.lightCam.up.set(0, 1, 0);
    if (Math.abs(sun.y) > 0.99) this.lightCam.up.set(0, 0, 1);
    this.lightCam.lookAt(focus);
    this.lightCam.updateMatrixWorld();
    const texel = (size * 2) / 2048;
    const inv = this.lightCam.matrixWorldInverse.clone();
    const fl = focus.clone().applyMatrix4(inv);
    fl.x = Math.round(fl.x / texel) * texel;
    fl.y = Math.round(fl.y / texel) * texel;
    const snapped = fl.applyMatrix4(this.lightCam.matrixWorld);
    this.lightCam.position.copy(snapped).addScaledVector(sun, 350);
    this.lightCam.lookAt(snapped);
    this.lightCam.updateMatrixWorld();
    this.lightCam.updateProjectionMatrix();
    const m = this.mats.opaque.uniforms.uShadowMatrix.value as THREE.Matrix4;
    m.multiplyMatrices(this.lightCam.projectionMatrix, this.lightCam.matrixWorldInverse);
    // swap materials, render the opaque chunk meshes from the light
    const swapped: THREE.Mesh[] = [];
    const hidden: THREE.Object3D[] = [];
    for (const g of this.chunks.root.children) {
      for (const c of g.children) {
        const mesh = c as THREE.Mesh;
        if (mesh.userData.kind === "opaque") {
          mesh.material = this.mats.depth;
          swapped.push(mesh);
        } else if (mesh.visible) {
          mesh.visible = false;
          hidden.push(mesh);
        }
      }
    }
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.shadowRT);
    this.renderer.clear(false, true, false);
    this.renderer.render(this.chunks.root, this.lightCam);
    this.renderer.setRenderTarget(prevTarget);
    for (const m2 of swapped) m2.material = this.mats.opaque;
    for (const h of hidden) h.visible = true;
  }

  private tick() {
    const dt = Math.min(0.1, this.clock.getDelta());
    if (document.hidden) return;
    if (this.mode === "cinematic") this.updateCinematic(dt);
    else this.fadeTarget = 1;
    if (this.mode === "orbit") this.orbit.update();
    if (this.mode === "fly") this.fly.update(dt);
    if (this.mode === "walk") this.walker.update(dt);
    this.live.update(dt);
    for (const a of this.anims) a.update(dt);
    this.fade += (this.fadeTarget - this.fade) * Math.min(1, dt * 3);
    this.grade.uniforms.uFade.value = this.fade;
    const focus = this.focusPoint();
    this.chunks.update(focus);
    this.lod.update(focus);
    this.lod.setHole(Math.floor(focus.x / 16) * 16 + 8, Math.floor(focus.z / 16) * 16 + 8, this.chunks.loadedRadius(focus.x, focus.z));
    this.mobs.update(dt, focus, this.camera);
    this.updateUniforms(dt);
    {
      const day = this.uniforms.uDaylight.value as number;
      const night = this.dim.includes("nether") ? 0.7 : this.dim.includes("end") ? 0.5 : Math.pow(Math.max(0, 1 - day), 1.4);
      this.glow.update(dt, this.chunks.loadedKeys(), this.nightVision ? night * 0.35 : night, this.canvas.height);
    }
    this.renderFrame();
    this.frames++;
    this.fpsT += dt;
    if (this.fpsT > 0.5) {
      this.stats = { fps: Math.round(this.frames / this.fpsT), chunks: this.chunks.root.children.length, pending: this.chunks.pendingCount(), quads: this.chunks.totalQuads };
      this.frames = 0;
      this.fpsT = 0;
      this.onStats?.(this.stats);
    }
  }

  private renderFrame() {
    this.renderShadows();
    this.grade.uniforms.uMode.value = GRADE_MODES[this.gradeMode] ?? 0;
    this.grade.uniforms.uTime.value = this.clock.elapsedTime;
    this.grade.uniforms.uVignette.value = this.mode === "cinematic" ? 0.55 : 0.3;
    this.composer.render();
  }

  /** Render the current view at a given size and return a data URL (photos, plates). */
  capture(opts: CaptureOpts): string {
    const prevSize = new THREE.Vector2();
    this.renderer.getSize(prevSize);
    const prevPR = this.renderer.getPixelRatio();
    const prevMode = this.gradeMode;
    const prevAspect = this.camera.aspect;
    const prevFade = this.grade.uniforms.uFade.value;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(opts.width, opts.height, false);
    this.composer.setSize(opts.width, opts.height);
    this.grade.uniforms.uRes.value.set(opts.width, opts.height);
    this.camera.aspect = opts.width / opts.height;
    this.camera.updateProjectionMatrix();
    this.gradeMode = opts.style ?? prevMode;
    this.grade.uniforms.uFade.value = 1;
    this.updateUniforms(0);
    this.renderFrame();
    const url = this.canvas.toDataURL(opts.type === "jpeg" ? "image/jpeg" : "image/png", 0.92);
    this.gradeMode = prevMode;
    this.grade.uniforms.uFade.value = prevFade;
    this.renderer.setPixelRatio(prevPR);
    this.camera.aspect = prevAspect;
    this.camera.updateProjectionMatrix();
    if (this.container) this.resize();
    else {
      this.renderer.setSize(prevSize.x, prevSize.y, false);
      this.composer.setSize(prevSize.x, prevSize.y);
    }
    return url;
  }

  /** Wait until the chunks around the focus are meshed (or a timeout). */
  async settle(timeoutMs = 9000): Promise<void> {
    const t0 = performance.now();
    // drive the streaming even when detached
    while (performance.now() - t0 < timeoutMs) {
      const focus = this.focusPoint();
      this.chunks.update(focus);
      this.lod.update(focus);
      await new Promise((r) => setTimeout(r, 120));
      if (this.chunks.pendingCount() === 0 && performance.now() - t0 > 400) break;
    }
  }

  /** Frame a place from above at an angle and capture it (for the Lore Book and Places). */
  async capturePlace(x: number, y: number, z: number, opts: CaptureOpts & { dayTime?: number; dist?: number; angle?: number; radius?: number }): Promise<string> {
    const prev = { mode: this.mode, pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), poi: this.poi.clone(), target: this.orbit.target.clone(), override: this.timeOverride, radius: this.chunks.radius, lod: this.lod.range };
    // small captures only need the chunks right around the spot (keeps memory flat when hopping around)
    if (opts.radius) {
      this.chunks.radius = Math.min(this.chunks.radius, opts.radius);
      this.lod.range = 1;
    }
    this.mode = "orbit";
    this.orbit.enabled = false;
    this.orbit.target.set(x, y, z);
    const d = opts.dist ?? 46;
    const a = opts.angle ?? 0.7;
    this.camera.position.set(x + Math.cos(a) * d, y + d * 0.62, z + Math.sin(a) * d);
    this.camera.lookAt(x, y + 2, z);
    if (opts.dayTime !== undefined) this.timeOverride = opts.dayTime;
    await this.settle();
    const url = this.capture(opts);
    this.chunks.radius = prev.radius;
    this.lod.range = prev.lod;
    this.timeOverride = prev.override;
    this.camera.position.copy(prev.pos);
    this.camera.quaternion.copy(prev.quat);
    this.orbit.target.copy(prev.target);
    this.poi.copy(prev.poi);
    this.setMode(prev.mode);
    return url;
  }

  pick(clientX: number, clientY: number) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    return this.mobs.pick(ndc, this.camera);
  }
}
