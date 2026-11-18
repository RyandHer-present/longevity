// A small 3D Minecraft player for the skin closet: classic/slim arms, overlay layers, cape,
// idle/walk/wave poses, drag to spin. Its own renderer so it never fights the world backdrop.
import * as THREE from "three";
import { trimCanvas } from "./trims";
import { blockTex, iconUrl } from "../api";

type Pose = "idle" | "walk" | "wave";

export interface PaintHit {
  x: number;
  y: number;
  /** the same spot on the other side of the body, when mirroring */
  mirror: [number, number] | null;
}

export interface GearOn {
  head?: string;
  chest?: string;
  legs?: string;
  feet?: string;
  mainhand?: string;
  offhand?: string;
  elytra?: boolean;
  shine?: { head?: boolean; chest?: boolean; legs?: boolean; feet?: boolean };
  /** Armour trims per piece: [pattern, material], e.g. ["silence", "netherite"]. */
  trims?: Partial<Record<"head" | "chest" | "legs" | "feet", [string, string]>>;
}

function setUVs(geo: THREE.BoxGeometry, u: number, v: number, w: number, h: number, d: number, tw: number, th: number) {
  const face = (x1: number, y1: number, x2: number, y2: number) => [
    new THREE.Vector2(x1 / tw, 1 - y2 / th),
    new THREE.Vector2(x2 / tw, 1 - y2 / th),
    new THREE.Vector2(x2 / tw, 1 - y1 / th),
    new THREE.Vector2(x1 / tw, 1 - y1 / th),
  ];
  const top = face(u + d, v, u + w + d, v + d);
  const bottom = face(u + w + d, v, u + w * 2 + d, v + d);
  const left = face(u, v + d, u + d, v + d + h);
  const front = face(u + d, v + d, u + w + d, v + d + h);
  const right = face(u + w + d, v + d, u + w + d * 2, v + h + d);
  const back = face(u + w + d * 2, v + d, u + w * 2 + d * 2, v + h + d);
  const order = [
    [right[3], right[2], right[0], right[1]],
    [left[3], left[2], left[0], left[1]],
    [top[3], top[2], top[0], top[1]],
    [bottom[0], bottom[1], bottom[3], bottom[2]],
    [front[3], front[2], front[0], front[1]],
    [back[3], back[2], back[0], back[1]],
  ];
  const data: number[] = [];
  for (const f of order) for (const p of f) data.push(p.x, p.y);
  (geo.attributes.uv as THREE.BufferAttribute).set(new Float32Array(data));
  geo.attributes.uv.needsUpdate = true;
}

export function part(w: number, h: number, d: number, u: number, v: number, mat: THREE.Material, inflate = 0, tw = 64, th = 64) {
  const g = new THREE.BoxGeometry(w + inflate * 2, h + inflate * 2, d + inflate * 2);
  setUVs(g, u, v, w, h, d, tw, th);
  return new THREE.Mesh(g, mat);
}

/** Old 64x32 skins: give them the 64x64 layout, copying the right limbs onto the left. */
function normalize(img: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const x = c.getContext("2d")!;
  x.imageSmoothingEnabled = false;
  x.drawImage(img, 0, 0);
  if (img.height === 32) {
    x.drawImage(img, 0, 16, 16, 16, 16, 48, 16, 16);
    x.drawImage(img, 40, 16, 16, 16, 32, 48, 16, 16);
  }
  return c;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = url;
  });
}

/** Flat front view (16x32) of a skin, for closet cards. */
export async function frontView(url: string, slim: boolean): Promise<string> {
  const img = await loadImage(url);
  const s = normalize(img);
  const c = document.createElement("canvas");
  c.width = 16;
  c.height = 32;
  const x = c.getContext("2d")!;
  x.imageSmoothingEnabled = false;
  const aw = slim ? 3 : 4;
  const blit = (sx: number, sy: number, w: number, h: number, dx: number, dy: number) => x.drawImage(s, sx, sy, w, h, dx, dy, w, h);
  // base
  blit(4, 20, 4, 12, 4, 20); // right leg
  blit(20, 52, 4, 12, 8, 20); // left leg
  blit(20, 20, 8, 12, 4, 8); // body
  blit(44, 20, aw, 12, 4 - aw, 8); // right arm
  blit(36, 52, aw, 12, 12, 8); // left arm
  blit(8, 8, 8, 8, 4, 0); // head
  // overlays
  if (img.height === 64) {
    blit(4, 36, 4, 12, 4, 20);
    blit(4, 52, 4, 12, 8, 20);
    blit(20, 36, 8, 12, 4, 8);
    blit(44, 36, aw, 12, 4 - aw, 8);
    blit(52, 52, aw, 12, 12, 8);
  }
  blit(40, 8, 8, 8, 4, 0);
  return c.toDataURL();
}

/** Just the face (with hat layer), for small avatars. */
export async function faceView(url: string): Promise<string> {
  const img = await loadImage(url);
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 8;
  const x = c.getContext("2d")!;
  x.imageSmoothingEnabled = false;
  x.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8);
  x.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8);
  return c.toDataURL();
}

export class SkinViewer {
  renderer!: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(32, 1, 1, 400);
  root = new THREE.Group();
  player = new THREE.Group();
  parts: Record<string, THREE.Group> = {};
  cape: THREE.Group | null = null;
  pose: Pose = "idle";
  yaw = -0.45;
  yawVel = 0;
  autoSpin = true;
  private raf = 0;
  private t0 = performance.now();
  private drag: { x: number; yaw: number; t: number } | null = null;
  private el: HTMLElement | null;
  private ro: ResizeObserver | null = null;
  private disposed = false;
  private intro = 0;
  private textures: THREE.Texture[] = [];
  private gearMeshes: THREE.Object3D[] = [];
  private glints: THREE.Texture[] = [];
  private slim = false;
  /** An armour stand: no breathing or swinging. */
  still = false;
  /** Paint mode (the skin editor): left-drag on the model paints, drag elsewhere turns it. */
  paint: {
    layer: "base" | "outer";
    mirror: boolean;
    onPaint: (h: PaintHit) => void;
    onHover?: (h: PaintHit | null) => void;
    onStroke?: (s: "start" | "end") => void;
  } | null = null;
  private painting = false;
  private lastPaint: { x: number; y: number } | null = null;
  private skinTex: THREE.Texture | null = null;

  /** With no element it only builds the model (for placing it in another scene; call `animate`). */
  constructor(el: HTMLElement | null) {
    this.el = el;
    if (!el) {
      this.root.add(this.player);
      this.intro = 1;
      return;
    }
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = "skin-canvas";
    this.camera.position.set(0, 19, 96);
    this.camera.lookAt(0, 15.5, 0);
    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x30343a, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(30, 50, 60);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xf3cc8c, 1.3);
    rim.position.set(-40, 30, -50);
    this.scene.add(rim);
    this.root.add(this.player);
    this.scene.add(this.root);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
    const dom = this.renderer.domElement;
    dom.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    this.loop();
  }

  private onDown = (e: PointerEvent) => {
    if (this.paint && e.button === 0) {
      const h = this.pickAt(e.clientX, e.clientY);
      if (h) {
        this.painting = true;
        this.lastPaint = { x: e.clientX, y: e.clientY };
        this.paint.onStroke?.("start");
        this.paint.onPaint(h);
        return;
      }
    }
    this.drag = { x: e.clientX, yaw: this.yaw, t: performance.now() };
    this.autoSpin = false;
    this.yawVel = 0;
  };
  private onMove = (e: PointerEvent) => {
    if (this.painting && this.paint) {
      // fill in between pointer events so a fast stroke has no gaps
      const last = this.lastPaint ?? { x: e.clientX, y: e.clientY };
      const steps = Math.max(1, Math.ceil(Math.hypot(e.clientX - last.x, e.clientY - last.y) / 2.5));
      for (let i = 1; i <= steps; i++) {
        const h = this.pickAt(last.x + ((e.clientX - last.x) * i) / steps, last.y + ((e.clientY - last.y) * i) / steps);
        if (h) this.paint.onPaint(h);
      }
      this.lastPaint = { x: e.clientX, y: e.clientY };
      return;
    }
    if (this.paint && !this.drag) {
      this.paint.onHover?.(this.pickAt(e.clientX, e.clientY));
      return;
    }
    if (!this.drag) return;
    const ny = this.drag.yaw + (e.clientX - this.drag.x) * 0.012;
    this.yawVel = (ny - this.yaw) / Math.max(1, performance.now() - this.drag.t) * 16;
    this.drag.t = performance.now();
    this.yaw = ny;
  };
  private onUp = () => {
    if (this.painting) {
      this.painting = false;
      this.paint?.onStroke?.("end");
      return;
    }
    if (!this.drag) return;
    this.drag = null;
    setTimeout(() => {
      if (!this.drag && !this.paint) this.autoSpin = true;
    }, 2500);
  };

  resize() {
    if (!this.el) return;
    const w = this.el.clientWidth || 300;
    const h = this.el.clientHeight || 400;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private clearPlayer() {
    for (const c of [...this.player.children]) this.player.remove(c);
    this.player.traverse(() => {});
    this.textures.forEach((t) => t.dispose());
    this.textures = [];
    this.parts = {};
    this.cape = null;
  }

  async load(skinUrl: string, slim: boolean, capeUrl?: string | null) {
    const img = await loadImage(skinUrl);
    if (this.disposed) return;
    await this.build(normalize(img), slim, capeUrl, img.height === 64);
  }

  /** The 64x64 canvas a skin is drawn from (the editor paints on it, then calls `refresh`). */
  static canvasOf(img: HTMLImageElement) {
    return normalize(img);
  }

  /** Re-upload the skin canvas after painting on it. */
  refresh() {
    if (this.skinTex) this.skinTex.needsUpdate = true;
  }

  /** Show or hide the outer (hat/jacket/sleeve/pants) layer; `opacity` < 1 ghosts it (painting the base under it). */
  setOuterVisible(v: boolean, opacity = 1) {
    this.player.traverse((o) => {
      if (o.userData.layer !== "outer") return;
      o.visible = v;
      const m = (o as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined;
      if (m && "opacity" in m) {
        m.opacity = opacity;
        m.depthWrite = opacity >= 1;
      }
    });
  }

  async build(canvas: HTMLCanvasElement, slim: boolean, capeUrl?: string | null, hasOverlay = true) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    this.clearPlayer();
    this.textures.push(tex);
    this.skinTex = tex;
    const base = new THREE.MeshLambertMaterial({ map: tex, side: THREE.FrontSide, alphaTest: 0.5 });
    const over = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, alphaTest: 0.1, depthWrite: true });
    const aw = slim ? 3 : 4;
    this.slim = slim;

    const mk = (name: string, pivot: [number, number, number], offset: [number, number, number], dims: [number, number, number], uv: [number, number], ouv: [number, number] | null, inflate: number) => {
      const g = new THREE.Group();
      g.position.set(...pivot);
      const m = part(dims[0], dims[1], dims[2], uv[0], uv[1], base);
      m.position.set(...offset);
      m.userData.layer = "base";
      g.add(m);
      if (ouv && (hasOverlay || name === "head")) {
        const o = part(dims[0], dims[1], dims[2], ouv[0], ouv[1], over, inflate);
        o.position.set(...offset);
        o.userData.layer = "outer";
        g.add(o);
      }
      this.player.add(g);
      this.parts[name] = g;
    };
    mk("head", [0, 24, 0], [0, 4, 0], [8, 8, 8], [0, 0], [32, 0], 0.5);
    mk("body", [0, 24, 0], [0, -6, 0], [8, 12, 4], [16, 16], [16, 32], 0.25);
    mk("rarm", [-(4 + aw / 2), 22, 0], [0, -4, 0], [aw, 12, 4], [40, 16], [40, 32], 0.25);
    mk("larm", [4 + aw / 2, 22, 0], [0, -4, 0], [aw, 12, 4], [32, 48], [48, 48], 0.25);
    mk("rleg", [-2, 12, 0], [0, -6, 0], [4, 12, 4], [0, 16], [0, 32], 0.25);
    mk("lleg", [2, 12, 0], [0, -6, 0], [4, 12, 4], [16, 48], [0, 48], 0.25);

    if (capeUrl) {
      try {
        const cimg = await loadImage(capeUrl);
        if (this.disposed) return;
        const ct = new THREE.Texture(cimg);
        ct.magFilter = THREE.NearestFilter;
        ct.minFilter = THREE.NearestFilter;
        ct.colorSpace = THREE.SRGBColorSpace;
        ct.needsUpdate = true;
        this.textures.push(ct);
        const tw = cimg.width >= 64 ? 64 : 64;
        const th = cimg.width >= 64 ? cimg.height * (64 / cimg.width) : 32;
        const cm = new THREE.MeshLambertMaterial({ map: ct, side: THREE.DoubleSide, alphaTest: 0.5 });
        const g = new THREE.Group();
        g.position.set(0, 24, -2.6);
        const m = part(10, 16, 1, 0, 0, cm, 0, tw, th);
        m.position.set(0, -8, -0.5);
        m.rotation.y = Math.PI;
        g.add(m);
        this.player.add(g);
        this.cape = g;
      } catch {
        /* no cape */
      }
    }
    this.player.position.y = 0;
    this.intro = 0;
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const t = (performance.now() - this.t0) / 1000;
    if (this.autoSpin) this.yaw += 0.0045;
    else if (!this.drag) {
      this.yaw += this.yawVel;
      this.yawVel *= 0.94;
    }
    this.intro = Math.min(1, this.intro + 0.035);
    const e = 1 - Math.pow(1 - this.intro, 3);
    this.root.rotation.y = this.yaw + (1 - e) * 1.2;
    this.root.position.y = (1 - e) * -6;
    this.animate(t);
    for (const g of this.glints) {
      g.offset.x = (t * 0.12) % 1;
      g.offset.y = (t * 0.05) % 1;
    }
    this.renderer.render(this.scene, this.camera);
  };

  /** Pose the limbs for time `t` (seconds). `swing` (0..1) scales the walk swing when given. */
  animate(t: number, swing?: number) {
    const p = this.parts;
    if (p.head && !this.still) {
      const walk = swing !== undefined ? swing > 0.02 : this.pose === "walk";
      const s = walk ? Math.sin(t * 6.5) * (swing ?? 1) : 0;
      const breathe = Math.sin(t * 1.6);
      p.rarm.rotation.x = walk ? s * 0.7 : breathe * 0.03;
      p.larm.rotation.x = walk ? -s * 0.7 : -breathe * 0.03;
      p.rarm.rotation.z = walk ? 0 : -0.05 - breathe * 0.02;
      p.larm.rotation.z = walk ? 0 : 0.05 + breathe * 0.02;
      p.rleg.rotation.x = walk ? -s * 0.7 : 0;
      p.lleg.rotation.x = walk ? s * 0.7 : 0;
      p.head.rotation.y = walk ? 0 : Math.sin(t * 0.7) * 0.18;
      p.head.rotation.x = walk ? 0 : Math.sin(t * 0.9) * 0.05;
      if (this.pose === "wave") {
        p.rarm.rotation.z = -2.6 + Math.sin(t * 7) * 0.35;
        p.rarm.rotation.x = 0;
      }
      this.player.position.y = walk ? Math.abs(Math.cos(t * 6.5)) * 0.6 : 0;
      if (this.cape) this.cape.rotation.x = walk ? 0.35 + Math.sin(t * 6.5) * 0.08 : 0.08 + Math.sin(t * 1.3) * 0.03;
    }
    for (const g of this.glints) {
      g.offset.x = (t * 0.12) % 1;
      g.offset.y = (t * 0.05) % 1;
    }
  }

  /** The skin pixel under a screen point (and its mirror twin), for painting. */
  pickAt(cx: number, cy: number): PaintHit | null {
    if (!this.renderer || !this.paint) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const layer = this.paint.layer;
    const meshes: THREE.Object3D[] = [];
    this.player.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.userData.layer === layer) meshes.push(o);
    });
    this.root.updateMatrixWorld(true);
    const hit = rc.intersectObjects(meshes, false)[0];
    if (!hit || !hit.uv || !hit.face) return null;
    const px = (uv: THREE.Vector2, face: THREE.Face, obj: THREE.Object3D, point: THREE.Vector3): [number, number] => {
      // nudge a hair toward the triangle's middle so a hit on an edge lands on this face's pixel
      void point;
      const a = ((obj as THREE.Mesh).geometry as THREE.BufferGeometry).attributes.uv;
      const mx = (a.getX(face.a) + a.getX(face.b) + a.getX(face.c)) / 3;
      const my = (a.getY(face.a) + a.getY(face.b) + a.getY(face.c)) / 3;
      const u = uv.x + (mx - uv.x) * 0.004;
      const v = uv.y + (my - uv.y) * 0.004;
      return [Math.min(63, Math.max(0, Math.floor(u * 64))), Math.min(63, Math.max(0, Math.floor((1 - v) * 64)))];
    };
    const [x, y] = px(hit.uv, hit.face, hit.object, hit.point);
    let mirror: [number, number] | null = null;
    if (this.paint.mirror) {
      // reflect the hit across the model's middle and cast back onto the other side
      const local = this.player.worldToLocal(hit.point.clone());
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      const nLocal = n.clone().transformDirection(new THREE.Matrix4().copy(this.player.matrixWorld).invert());
      const m = new THREE.Vector3(-local.x, local.y, local.z);
      const mn = new THREE.Vector3(-nLocal.x, nLocal.y, nLocal.z).normalize();
      const origin = this.player.localToWorld(m.clone().add(mn.clone().multiplyScalar(0.6)));
      const target = this.player.localToWorld(m.clone());
      const dir = target.sub(origin).normalize();
      const rc2 = new THREE.Raycaster(origin, dir, 0, 3);
      const h2 = rc2.intersectObjects(meshes, false)[0];
      if (h2?.uv && h2.face) {
        const mm = px(h2.uv, h2.face, h2.object, h2.point);
        if (mm[0] !== x || mm[1] !== y) mirror = mm;
      }
    }
    return { x, y, mirror };
  }

  /** A wooden armour stand instead of a player (the parts are named like the player's, so gear fits). */
  async loadStand() {
    const img = await loadImage(blockTex("entity/armorstand/armorstand")).catch(() => loadImage(blockTex("entity/armorstand/wood")));
    if (this.disposed) return;
    const tex = new THREE.Texture(img);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    this.clearPlayer();
    this.textures.push(tex);
    this.slim = false;
    this.still = true;
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    const g = (name: string, pivot: [number, number, number], boxes: [number, number, number, number, number, number, number, number][]) => {
      const grp = new THREE.Group();
      grp.position.set(...pivot);
      for (const [w, h, d, u, v, ox, oy, oz] of boxes) {
        const m = part(w, h, d, u, v, mat);
        m.position.set(ox, oy, oz);
        grp.add(m);
      }
      this.player.add(grp);
      this.parts[name] = grp;
    };
    g("head", [0, 24, 0], [[2, 7, 2, 0, 0, 0, 2.5, 0]]);
    g("body", [0, 24, 0], [
      [12, 3, 3, 0, 26, 0, -1.5, 0],
      [2, 7, 2, 16, 0, -2, -6.5, 0],
      [2, 7, 2, 48, 16, 2, -6.5, 0],
      [8, 2, 2, 0, 48, 0, -11, 0],
    ]);
    g("rarm", [-5, 22, 0], [[2, 12, 2, 24, 0, -1, -4, 0]]);
    g("larm", [5, 22, 0], [[2, 12, 2, 32, 16, 1, -4, 0]]);
    g("rleg", [-1.9, 12, 0], [[2, 11, 2, 8, 0, 0, -5.5, 0]]);
    g("lleg", [1.9, 12, 0], [[2, 11, 2, 40, 16, 0, -5.5, 0]]);
    const base = part(12, 1, 12, 0, 32, mat);
    base.position.set(0, 0.5, 0);
    this.player.add(base);
    this.player.position.y = 0;
    this.intro = 0;
  }

  /** Put armor and held items on the player (ids like "minecraft:diamond_chestplate"). */
  async setGear(gear: GearOn) {
    for (const m of this.gearMeshes) m.parent?.remove(m);
    this.gearMeshes = [];
    this.glints = [];
    const p = this.parts;
    if (!p.head) return;
    const load = (path: string) =>
      loadImage(path).then((img) => {
        const t = new THREE.Texture(img);
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.NearestFilter;
        t.colorSpace = THREE.SRGBColorSpace;
        t.needsUpdate = true;
        this.textures.push(t);
        return t;
      });
    let glintTex: THREE.Texture | null = null;
    const glint = async () => {
      if (glintTex) return glintTex;
      const t = await load(blockTex("misc/enchanted_glint_armor"));
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearFilter;
      glintTex = t;
      return t;
    };
    const add = async (group: THREE.Group, tex: THREE.Texture, dims: [number, number, number], uv: [number, number], offset: [number, number, number], inflate: number, mirror: boolean, shine: boolean, tint?: number) => {
      const mat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide, alphaTest: 0.5, color: tint ?? 0xffffff });
      const m = part(dims[0], dims[1], dims[2], uv[0], uv[1], mat, inflate, 64, 32);
      m.position.set(...offset);
      if (mirror) m.scale.x = -1;
      group.add(m);
      this.gearMeshes.push(m);
      if (shine) {
        const gt = await glint();
        const gm = new THREE.MeshBasicMaterial({ map: gt, color: 0x9a5cff, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, alphaMap: tex });
        const g = part(dims[0], dims[1], dims[2], uv[0], uv[1], gm, inflate + 0.02, 64, 32);
        g.position.set(...offset);
        if (mirror) g.scale.x = -1;
        group.add(g);
        this.gearMeshes.push(g);
        if (!this.glints.includes(gt)) this.glints.push(gt);
      }
    };
    const mat = (id?: string) => {
      if (!id) return null;
      const s = id.replace("minecraft:", "");
      if (s === "turtle_helmet") return "turtle_scute";
      const m = s.match(/^(leather|chainmail|iron|golden|diamond|netherite|copper)_(helmet|chestplate|leggings|boots)$/);
      if (!m) return null;
      return m[1] === "golden" ? "gold" : m[1];
    };
    const aw = this.slim ? 3 : 4;
    const leather = (id?: string) => (id?.includes("leather") ? 0xa06540 : undefined);
    const trimTex = async (slot: "head" | "chest" | "legs" | "feet", armor: string) => {
      const t = gear.trims?.[slot];
      if (!t) return null;
      try {
        const c = await trimCanvas(t[0], t[1], slot === "legs", armor);
        const tx = new THREE.CanvasTexture(c);
        tx.magFilter = THREE.NearestFilter;
        tx.minFilter = THREE.NearestFilter;
        tx.colorSpace = THREE.SRGBColorSpace;
        this.textures.push(tx);
        return tx;
      } catch {
        return null;
      }
    };
    try {
      const h = mat(gear.head);
      if (h) {
        await add(p.head, await load(blockTex(`entity/equipment/humanoid/${h}`)), [8, 8, 8], [0, 0], [0, 4, 0], 1.0, false, !!gear.shine?.head, leather(gear.head));
        const tt = await trimTex("head", h);
        if (tt) await add(p.head, tt, [8, 8, 8], [0, 0], [0, 4, 0], 1.03, false, false);
      }
      const c = mat(gear.chest);
      if (c) {
        const t = await load(blockTex(`entity/equipment/humanoid/${c}`));
        await add(p.body, t, [8, 12, 4], [16, 16], [0, -6, 0], 1.0, false, !!gear.shine?.chest, leather(gear.chest));
        await add(p.rarm, t, [4, 12, 4], [40, 16], [aw === 3 ? -0.5 : 0, -4, 0], 1.0, false, !!gear.shine?.chest, leather(gear.chest));
        await add(p.larm, t, [4, 12, 4], [40, 16], [aw === 3 ? 0.5 : 0, -4, 0], 1.0, true, !!gear.shine?.chest, leather(gear.chest));
        const tt = await trimTex("chest", c);
        if (tt) {
          await add(p.body, tt, [8, 12, 4], [16, 16], [0, -6, 0], 1.03, false, false);
          await add(p.rarm, tt, [4, 12, 4], [40, 16], [aw === 3 ? -0.5 : 0, -4, 0], 1.03, false, false);
          await add(p.larm, tt, [4, 12, 4], [40, 16], [aw === 3 ? 0.5 : 0, -4, 0], 1.03, true, false);
        }
      }
      const l = mat(gear.legs);
      if (l) {
        const t = await load(blockTex(`entity/equipment/humanoid_leggings/${l}`));
        await add(p.body, t, [8, 12, 4], [16, 16], [0, -6, 0], 0.5, false, !!gear.shine?.legs, leather(gear.legs));
        await add(p.rleg, t, [4, 12, 4], [0, 16], [0, -6, 0], 0.5, false, !!gear.shine?.legs, leather(gear.legs));
        await add(p.lleg, t, [4, 12, 4], [0, 16], [0, -6, 0], 0.5, true, !!gear.shine?.legs, leather(gear.legs));
        const tt = await trimTex("legs", l);
        if (tt) {
          await add(p.body, tt, [8, 12, 4], [16, 16], [0, -6, 0], 0.53, false, false);
          await add(p.rleg, tt, [4, 12, 4], [0, 16], [0, -6, 0], 0.53, false, false);
          await add(p.lleg, tt, [4, 12, 4], [0, 16], [0, -6, 0], 0.53, true, false);
        }
      }
      const f = mat(gear.feet);
      if (f) {
        const t = await load(blockTex(`entity/equipment/humanoid/${f}`));
        await add(p.rleg, t, [4, 12, 4], [0, 16], [0, -6, 0], 1.0, false, !!gear.shine?.feet, leather(gear.feet));
        await add(p.lleg, t, [4, 12, 4], [0, 16], [0, -6, 0], 1.0, true, !!gear.shine?.feet, leather(gear.feet));
        const tt = await trimTex("feet", f);
        if (tt) {
          await add(p.rleg, tt, [4, 12, 4], [0, 16], [0, -6, 0], 1.03, false, false);
          await add(p.lleg, tt, [4, 12, 4], [0, 16], [0, -6, 0], 1.03, true, false);
        }
      }
      if (gear.elytra) {
        const t = await load(blockTex("entity/equipment/wings/elytra"));
        for (const side of [-1, 1]) {
          const m = new THREE.MeshLambertMaterial({ map: t, side: THREE.DoubleSide, alphaTest: 0.5 });
          const w = part(10, 20, 2, 22, 0, m, 0, 64, 32);
          const g = new THREE.Group();
          g.position.set(side * 5, 24, -3);
          w.position.set(side * -5, -10, -1);
          w.rotation.z = side * 0.26;
          if (side > 0) w.scale.x = -1;
          g.add(w);
          this.player.add(g);
          this.gearMeshes.push(g);
        }
      }
      // held items: flat sprites, like the game draws them in third person
      for (const [slot, group, x] of [
        ["mainhand", p.rarm, -0.5],
        ["offhand", p.larm, 0.5],
      ] as const) {
        const id = gear[slot];
        if (!id) continue;
        const t = await load(iconUrl(id));
        const m = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshLambertMaterial({ map: t, side: THREE.DoubleSide, alphaTest: 0.4 }));
        m.position.set(x, -12, -4);
        m.rotation.set(-0.35, Math.PI / 2, 0.75);
        group.add(m);
        this.gearMeshes.push(m);
      }
    } catch {
      /* a missing texture just leaves that piece off */
    }
  }

  dispose() {
    this.disposed = true;
    this.clearPlayer();
    if (!this.el) {
      this.root.parent?.remove(this.root);
      return;
    }
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
