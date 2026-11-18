// Mob portraits for the Dex: one small offscreen WebGL renderer turns mob models into card art
// (cached as object URLs), and MobStage renders a live, animated model into a canvas.
import * as THREE from "three";
import { animateMobModel, createMobModel, hasMobModel, type MaterialFactory, type MobLook, type MobModel } from "./mobs";
import { blockTex } from "../api";

/** A Dex look: a mob plus extras (a rider for jockeys, the charged creeper's glow). */
export interface DexLook extends MobLook {
  rider?: MobLook | null;
  charged?: boolean;
}

const makeMat: MaterialFactory = (tex, tint) => {
  if (!tex) return new THREE.MeshLambertMaterial({ color: tint ?? 0xffffff, visible: false });
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  return new THREE.MeshLambertMaterial({ map: tex, color: tint ?? 0xffffff, alphaTest: 0.08, side: THREE.DoubleSide });
};

function lights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x4a4256, 1.25));
  const key = new THREE.DirectionalLight(0xffffff, 1.9);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbfd8ff, 1.1);
  rim.position.set(-4, 3, -5);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffe2c0, 0.5);
  fill.position.set(-3, -1, 4);
  scene.add(fill);
}

/** Puts the camera so the whole model fits, seen from the front (3/4 view) and a little above.
 * Mob models face -z (the game turns them by 180 - yaw), so yaw 0 here is straight at the face. */
function frame(cam: THREE.PerspectiveCamera, obj: THREE.Object3D, yaw = 0.55, pitch = 0.2, pad = 1.08) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const r = Math.max(0.35, 0.5 * Math.hypot(size.x, size.y, size.z)) * pad;
  const d = r / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2));
  cam.position.set(c.x + Math.sin(yaw) * Math.cos(pitch) * d, c.y + Math.sin(pitch) * d, c.z - Math.cos(yaw) * Math.cos(pitch) * d);
  cam.near = d / 50;
  cam.far = d * 6;
  cam.lookAt(c);
  cam.updateProjectionMatrix();
  return { center: c, dist: d };
}

function disposeModel(m: MobModel) {
  m.object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((x) => x?.dispose());
    }
  });
}

export const lookKey = (l: DexLook): string =>
  [l.id, l.variant ?? "", l.baby ? 1 : 0, l.collar ?? "", l.color ?? "", l.tamed ? 1 : 0, l.charged ? "c" : "", l.rider ? "r:" + lookKey(l.rider) : ""].join("|");

// ------------------------------------------------------------------ jockeys and charged creepers

/** Height of each mount's back (blocks): the rider's hips go there. */
const BACK: Record<string, number> = { chicken: 0.5, spider: 0.78, cave_spider: 0.5, skeleton_horse: 1.32, horse: 1.32, strider: 1.25, hoglin: 1.12, zoglin: 1.12 };
const LEGS = ["right_leg", "left_leg"];

let armorTex: THREE.Texture | null = null;
let armorReady: Promise<unknown> = Promise.resolve();
function auraTexture() {
  if (!armorTex) {
    let done: () => void = () => {};
    armorReady = new Promise<void>((res) => (done = res));
    armorTex = new THREE.TextureLoader().load(blockTex("entity/creeper/creeper_armor"), () => done(), undefined, () => done());
    armorTex.wrapS = armorTex.wrapT = THREE.RepeatWrapping;
    armorTex.magFilter = THREE.NearestFilter;
    armorTex.minFilter = THREE.NearestFilter;
    armorTex.colorSpace = THREE.SRGBColorSpace;
  }
  return armorTex;
}

/** One or more models arranged as one figure, animated together. */
interface Figure {
  object: THREE.Group;
  models: MobModel[];
  ready: Promise<unknown>;
  tick: (t: number) => void;
  dispose: () => void;
}

function buildFigure(look: DexLook): Figure | null {
  const base = createMobModel(look, makeMat);
  if (!base) return null;
  const object = new THREE.Group();
  object.add(base.object);
  const models = [base];
  const extra: (() => void)[] = [];
  let rider: MobModel | null = null;
  if (look.rider) {
    rider = createMobModel(look.rider, makeMat);
    if (rider) {
      const id = look.id.replace(/^minecraft:/, "");
      // humanoid hips are 12 of their 32 pixels up
      rider.object.position.y = (BACK[id] ?? base.height * 0.8) - rider.height * 0.375;
      object.add(rider.object);
      models.push(rider);
    }
  }
  let aura: MobModel | null = null;
  let auraMat: THREE.MeshBasicMaterial | null = null;
  if (look.charged) {
    auraMat = new THREE.MeshBasicMaterial({ map: auraTexture(), color: 0x8fb4ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const mat = auraMat;
    aura = createMobModel({ id: look.id }, () => mat);
    if (aura) {
      // grow every cube a little around its own centre, like the game's charged layer
      aura.object.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = mesh.geometry.clone();
        g.computeBoundingBox();
        const c = g.boundingBox!.getCenter(new THREE.Vector3());
        const s = g.boundingBox!.getSize(new THREE.Vector3());
        const grow = (v: number) => (v > 1e-4 ? (v + Math.max(0.6, v * 0.1)) / v : 1);
        g.translate(-c.x, -c.y, -c.z);
        g.scale(grow(s.x), grow(s.y), grow(s.z));
        g.translate(c.x, c.y, c.z);
        mesh.geometry = g;
        mesh.renderOrder = 2;
      });
      object.add(aura.object);
      models.push(aura);
    }
  }
  const tick = (t: number) => {
    animateMobModel(base, t, 1, !!look.tamed);
    if (aura) animateMobModel(aura, t, 1, false);
    if (rider) {
      animateMobModel(rider, t, 2, false);
      // riding pose: legs forward and a little apart
      LEGS.forEach((n, i) => {
        const p = rider!.parts.get(n);
        if (!p) return;
        p.group.rotation.x = -1.41;
        p.group.rotation.y = (i ? -1 : 1) * 0.31;
      });
    }
    if (auraMat?.map) {
      auraMat.map.offset.x = t * 0.08;
      auraMat.map.offset.y = t * 0.08;
    }
  };
  return {
    object,
    models,
    ready: Promise.all([...models.map((m) => m.ready), look.charged ? armorReady : null]),
    tick,
    dispose: () => {
      models.forEach(disposeModel);
      extra.forEach((f) => f());
    },
  };
}
export const canModel = (id: string) => {
  try {
    return hasMobModel(id);
  } catch {
    return false;
  }
};

// ------------------------------------------------------------------ cached portraits

let r: THREE.WebGLRenderer | null = null;
const cache = new Map<string, Promise<string | null>>();
let chain: Promise<unknown> = Promise.resolve();
const SIZE = 320;

function renderer() {
  if (!r) {
    r = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1);
    r.setSize(SIZE, SIZE, false);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.setClearColor(0x000000, 0);
  }
  return r;
}

async function draw(look: DexLook): Promise<string | null> {
  const fig = buildFigure(look);
  if (!fig) return null;
  await Promise.race([fig.ready, new Promise((res) => setTimeout(res, 4000))]);
  const scene = new THREE.Scene();
  lights(scene);
  scene.add(fig.object);
  fig.tick(0.6);
  const cam = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
  frame(cam, fig.object);
  const rr = renderer();
  rr.render(scene, cam);
  const blob = await new Promise<Blob | null>((res) => rr.domElement.toBlob(res, "image/png"));
  fig.dispose();
  return blob ? URL.createObjectURL(blob) : null;
}

/** Card art for a mob, rendered once per look and queued so only one renders at a time. */
export function mobPortrait(look: DexLook): Promise<string | null> {
  const k = lookKey(look);
  let p = cache.get(k);
  if (!p) {
    p = chain.then(() => draw(look).catch(() => null));
    chain = p;
    cache.set(k, p);
  }
  return p;
}

// ------------------------------------------------------------------ live stage

/** A live, gently animated model in a canvas you can spin by dragging. */
export class MobStage {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(26, 1, 0.01, 100);
  private model: Figure | null = null;
  private pivot = new THREE.Group();
  private raf = 0;
  private t0 = performance.now();
  private yaw = 0.5;
  private vel = 0.25;
  private drag: { x: number; yaw: number; t: number } | null = null;
  private ro: ResizeObserver;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    host.appendChild(this.renderer.domElement);
    Object.assign(this.renderer.domElement.style, { width: "100%", height: "100%", display: "block", cursor: "grab" });
    lights(this.scene);
    this.scene.add(this.pivot);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.down);
    window.addEventListener("pointermove", this.move);
    window.addEventListener("pointerup", this.up);
    this.loop();
  }

  private down = (e: PointerEvent) => {
    this.drag = { x: e.clientX, yaw: this.yaw, t: performance.now() };
    this.renderer.domElement.style.cursor = "grabbing";
  };
  private move = (e: PointerEvent) => {
    if (!this.drag) return;
    const ny = this.drag.yaw + (e.clientX - this.drag.x) * 0.012;
    const now = performance.now();
    this.vel = ((ny - this.yaw) / Math.max(1, now - this.drag.t)) * 1000 * 0.35;
    this.drag.t = now;
    this.yaw = ny;
  };
  private up = () => {
    if (!this.drag) return;
    this.drag = null;
    this.renderer.domElement.style.cursor = "grab";
  };

  private resize() {
    const w = Math.max(2, this.host.clientWidth),
      h = Math.max(2, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
  }

  async show(look: DexLook) {
    const m = buildFigure(look);
    if (this.model) {
      this.pivot.remove(this.model.object);
      this.model.dispose();
    }
    this.model = m;
    if (!m) return false;
    this.pivot.add(m.object);
    m.tick(0.6);
    frame(this.cam, m.object, 0, 0.16, 1.18);
    return true;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const t = (now - this.t0) / 1000;
    if (!this.drag) {
      this.vel += (0.25 - this.vel) * 0.02;
      this.yaw += this.vel / 60;
    }
    if (this.model) this.model.tick(t);
    this.pivot.rotation.y = this.yaw;
    this.renderer.render(this.scene, this.cam);
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.down);
    window.removeEventListener("pointermove", this.move);
    window.removeEventListener("pointerup", this.up);
    if (this.model) this.model.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    el.remove();
  }
}
