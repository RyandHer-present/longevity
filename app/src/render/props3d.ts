// Things drawn on top of the world in the 3D view:
//  - ContainerAnim: a chest or shulker box whose lid opens like in game (the real block is hidden
//    from the chunk mesh while it plays),
//  - Glow: soft halos around torches, lanterns and lamps that come up at night,
//  - LiveLayer: you, live from the companion mod, with your path and where you died.
import * as THREE from "three";
import { blockTex } from "../api";
import type { SkinViewer } from "./skinview";

// ------------------------------------------------------------------ entity-model geometry

interface Cube {
  u: number;
  v: number;
  min: [number, number, number];
  size: [number, number, number];
  hide?: string;
}

/** A cube in the game's box-UV layout (same vertex/UV order as ModelPart.Cube), in pixels / 16. */
function cubeGeometry(cubes: Cube[], tw: number, th: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const c of cubes) {
    const [x0, y0, z0] = c.min;
    const [x1, y1, z1] = [c.min[0] + c.size[0], c.min[1] + c.size[1], c.min[2] + c.size[2]];
    const t0 = [x0, y0, z0],
      t1 = [x1, y0, z0],
      t2 = [x1, y1, z0],
      t3 = [x0, y1, z0];
    const l0 = [x0, y0, z1],
      l1 = [x1, y0, z1],
      l2 = [x1, y1, z1],
      l3 = [x0, y1, z1];
    const [w, h, d] = c.size;
    const u0 = c.u,
      u1 = c.u + d,
      u2 = c.u + d + w,
      u22 = c.u + d + w + w,
      u3 = c.u + d + w + d,
      u4 = c.u + d + w + d + w;
    const v0 = c.v,
      v1 = c.v + d,
      v2 = c.v + d + h;
    const faces: [string, number[][], number[]][] = [
      ["down", [l1, l0, t0, t1], [u1, v0, u2, v1]],
      ["up", [t2, t3, l3, l2], [u2, v1, u22, v0]],
      ["west", [t0, l0, l3, t3], [u0, v1, u1, v2]],
      ["north", [t1, t0, t3, t2], [u1, v1, u2, v2]],
      ["east", [l1, t1, t2, l2], [u2, v1, u3, v2]],
      ["south", [l0, l1, l2, l3], [u3, v1, u4, v2]],
    ];
    for (const [name, verts, [pu0, pv0, pu1, pv1]] of faces) {
      if (c.hide?.includes(name)) continue;
      const base = pos.length / 3;
      const uvs = [
        [pu1, pv0],
        [pu0, pv0],
        [pu0, pv1],
        [pu1, pv1],
      ];
      verts.forEach((v, i) => {
        pos.push(v[0] / 16, v[1] / 16, v[2] / 16);
        uv.push(uvs[i][0] / tw, 1 - uvs[i][1] / th);
      });
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const texCache = new Map<string, Promise<THREE.Texture>>();
function tex(path: string): Promise<THREE.Texture> {
  if (!texCache.has(path))
    texCache.set(
      path,
      new Promise((res, rej) => {
        new THREE.TextureLoader().load(
          blockTex(path),
          (t) => {
            t.magFilter = THREE.NearestFilter;
            t.minFilter = THREE.NearestFilter;
            t.colorSpace = THREE.SRGBColorSpace;
            res(t);
          },
          undefined,
          rej,
        );
      }),
    );
  return texCache.get(path)!;
}

function material(t: THREE.Texture) {
  // a little self-light so it never goes black inside a torch-lit room at night
  return new THREE.MeshLambertMaterial({ map: t, side: THREE.DoubleSide, alphaTest: 0.5, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.22 });
}

const FACING_DEG: Record<string, number> = { south: 0, west: 90, north: 180, east: 270 };

export class ContainerAnim {
  group = new THREE.Group();
  private lid = new THREE.Group();
  private kind: "chest" | "shulker";
  open = 0;
  target = 0;
  onClosed: (() => void) | null = null;

  private constructor(kind: "chest" | "shulker") {
    this.kind = kind;
  }

  /** `block` like "minecraft:chest", props from the block state. */
  static async make(block: string, props: Record<string, string>, pos: [number, number, number]): Promise<ContainerAnim | null> {
    const n = block.replace("minecraft:", "");
    if (n.endsWith("shulker_box")) return ContainerAnim.shulker(n, props, pos);
    let base = "normal";
    if (n === "trapped_chest") base = "trapped";
    else if (n === "ender_chest") base = "ender";
    else if (n.includes("copper_chest")) {
      const m = n.replace("waxed_", "");
      base = m.startsWith("exposed") ? "copper_exposed" : m.startsWith("weathered") ? "copper_weathered" : m.startsWith("oxidized") ? "copper_oxidized" : "copper";
    } else if (n !== "chest") return null;
    const type = base === "ender" ? "single" : (props.type ?? "single");
    const path = type === "single" ? `entity/chest/${base}` : `entity/chest/${base}_${type}`;
    const t = await tex(path).catch(() => null);
    if (!t) return null;
    const a = new ContainerAnim("chest");
    const mat = material(t);
    let bottom: Cube[], lid: Cube[];
    if (type === "right") {
      bottom = [{ u: 0, v: 19, min: [1, 0, 1], size: [15, 10, 14], hide: "east" }];
      lid = [
        { u: 0, v: 0, min: [1, 0, 0], size: [15, 5, 14], hide: "east" },
        { u: 0, v: 0, min: [15, -2, 14], size: [1, 4, 1], hide: "east" },
      ];
    } else if (type === "left") {
      bottom = [{ u: 0, v: 19, min: [0, 0, 1], size: [15, 10, 14], hide: "west" }];
      lid = [
        { u: 0, v: 0, min: [0, 0, 0], size: [15, 5, 14], hide: "west" },
        { u: 0, v: 0, min: [0, -2, 14], size: [1, 4, 1], hide: "west" },
      ];
    } else {
      bottom = [{ u: 0, v: 19, min: [1, 0, 1], size: [14, 10, 14] }];
      lid = [
        { u: 0, v: 0, min: [1, 0, 0], size: [14, 5, 14] },
        { u: 0, v: 0, min: [7, -2, 14], size: [2, 4, 1] },
      ];
    }
    const inner = new THREE.Group();
    inner.add(new THREE.Mesh(cubeGeometry(bottom, 64, 64), mat));
    a.lid.position.set(0, 9 / 16, 1 / 16);
    a.lid.add(new THREE.Mesh(cubeGeometry(lid, 64, 64), mat));
    inner.add(a.lid);
    // rotate about the block centre to face the right way
    const pivot = new THREE.Group();
    pivot.position.set(0.5, 0, 0.5);
    pivot.rotation.y = (-(FACING_DEG[props.facing ?? "north"] ?? 0) * Math.PI) / 180;
    inner.position.set(-0.5, 0, -0.5);
    pivot.add(inner);
    a.group.add(pivot);
    a.group.position.set(pos[0], pos[1], pos[2]);
    return a;
  }

  private static async shulker(n: string, props: Record<string, string>, pos: [number, number, number]) {
    const color = n.replace("shulker_box", "").replace(/_$/, "");
    const t = await tex(color ? `entity/shulker/shulker_${color}` : "entity/shulker/shulker").catch(() => null);
    if (!t) return null;
    const a = new ContainerAnim("shulker");
    const mat = material(t);
    // built upright (the game builds it upside down and flips it)
    const flip = new THREE.Group();
    flip.scale.set(1, -1, -1);
    flip.position.set(0, 1, 0);
    const base = new THREE.Group();
    base.position.set(0, 24 / 16, 0);
    base.add(new THREE.Mesh(cubeGeometry([{ u: 0, v: 28, min: [-8, -8, -8], size: [16, 8, 16] }], 64, 64), mat));
    a.lid.position.set(0, 24 / 16, 0);
    a.lid.add(new THREE.Mesh(cubeGeometry([{ u: 0, v: 0, min: [-8, -16, -8], size: [16, 12, 16] }], 64, 64), mat));
    flip.add(base, a.lid);
    const turn = new THREE.Group();
    turn.position.set(0.5, 0.5, 0.5);
    const inner = new THREE.Group();
    inner.position.set(-0.5, -0.5, -0.5);
    inner.add(flip);
    turn.add(inner);
    const f = props.facing ?? "up";
    const h = Math.PI / 2;
    if (f === "down") turn.rotation.set(Math.PI, 0, 0);
    else if (f === "north") turn.rotation.set(-h, 0, 0);
    else if (f === "south") turn.rotation.set(h, 0, 0);
    else if (f === "west") turn.rotation.set(0, 0, h);
    else if (f === "east") turn.rotation.set(0, 0, -h);
    a.group.add(turn);
    a.group.position.set(pos[0], pos[1], pos[2]);
    return a;
  }

  /** Returns false once fully closed and finished. */
  update(dt: number): boolean {
    const was = this.open;
    const speed = this.kind === "chest" ? 4.2 : 3.2;
    this.open += Math.sign(this.target - this.open) * Math.min(Math.abs(this.target - this.open), dt * speed);
    const e = 1 - Math.pow(1 - this.open, 3);
    if (this.kind === "chest") this.lid.rotation.x = -e * (Math.PI / 2);
    else {
      // the lid rises half a block while twisting, like in game
      this.lid.position.y = (24 - this.open * 8) / 16;
      this.lid.rotation.y = this.open * 1.5 * Math.PI;
    }
    if (was > 0 && this.open === 0 && this.target === 0) {
      this.onClosed?.();
      this.onClosed = null;
    }
    return true;
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }
}

// ------------------------------------------------------------------ night glows

const GLOW_COLORS = [0xffb054, 0x58dcff, 0xffd788, 0xcdeeff, 0xff3b2e, 0xfff1ea, 0xffdf86, 0xb6ffad, 0xffc0ec, 0x9effc8];

export class Glow {
  points: THREE.Points;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private have = new Map<string, number[]>();
  private asking = false;
  private dirty = false;
  private t = 0;
  dim = "";
  fetcher: ((dim: string, chunks: [number, number][]) => Promise<number[][]>) | null = null;

  constructor(uniforms: Record<string, THREE.IUniform>) {
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uNight: { value: 0 }, uTime: uniforms.uTime, uFogFar: uniforms.uFogFar, uScale: { value: 600 } },
      vertexShader: `
        attribute vec3 color; attribute float level;
        uniform float uScale; uniform float uFogFar; uniform float uTime;
        varying vec3 vColor; varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float d = length(mv.xyz);
          mv.xyz *= max(0.0, d - 0.75) / max(d, 0.001); // pull towards the camera so the block itself doesn't hide it
          gl_Position = projectionMatrix * mv;
          float lv = level / 15.0;
          float flick = 0.88 + 0.12 * sin(uTime * 9.0 + position.x * 7.1 + position.z * 3.3) * sin(uTime * 5.3 + position.y);
          gl_PointSize = uScale * (0.9 + 2.6 * lv) / max(d, 0.5);
          vColor = color;
          vA = lv * flick * (1.0 - smoothstep(uFogFar * 0.35, uFogFar * 0.8, d));
        }`,
      fragmentShader: `
        uniform float uNight; varying vec3 vColor; varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float r = length(c) * 2.0;
          float a = exp(-r * r * 4.2) * (1.0 - smoothstep(0.85, 1.0, r));
          gl_FragColor = vec4(vColor * a * vA * uNight * 0.55, 1.0);
        }`,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  reset(dim: string) {
    this.dim = dim;
    this.have.clear();
    this.dirty = true;
  }

  /** `loaded` = chunk keys "cx,cz" currently meshed; `night` = 0..1. */
  update(dt: number, loaded: string[], night: number, pxHeight: number) {
    this.mat.uniforms.uNight.value = night;
    this.mat.uniforms.uScale.value = pxHeight * 0.55;
    this.points.visible = night > 0.02;
    this.t += dt;
    if (this.t > 0.8 && !this.asking && this.fetcher) {
      this.t = 0;
      const want = new Set(loaded);
      for (const k of [...this.have.keys()])
        if (!want.has(k)) {
          this.have.delete(k);
          this.dirty = true;
        }
      const missing = loaded.filter((k) => !this.have.has(k)).slice(0, 96);
      if (missing.length) {
        this.asking = true;
        const dim = this.dim;
        this.fetcher(
          dim,
          missing.map((k) => k.split(",").map(Number) as [number, number]),
        )
          .then((list) => {
            if (dim !== this.dim) return;
            for (const k of missing) this.have.set(k, []);
            for (const l of list) {
              const k = `${Math.floor(l[0] / 16)},${Math.floor(l[2] / 16)}`;
              this.have.get(k)?.push(l[0], l[1], l[2], l[3], l[4]);
            }
            this.dirty = true;
          })
          .catch(() => {})
          .finally(() => (this.asking = false));
      }
    }
    if (this.dirty) this.rebuild();
  }

  private rebuild() {
    this.dirty = false;
    const pos: number[] = [];
    const col: number[] = [];
    const lev: number[] = [];
    const c = new THREE.Color();
    for (const arr of this.have.values())
      for (let i = 0; i < arr.length; i += 5) {
        pos.push(arr[i] + 0.5, arr[i + 1] + 0.55, arr[i + 2] + 0.5);
        c.setHex(GLOW_COLORS[arr[i + 3]] ?? GLOW_COLORS[0]);
        col.push(c.r, c.g, c.b);
        lev.push(arr[i + 4]);
      }
    this.geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    this.geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    this.geo.setAttribute("level", new THREE.Float32BufferAttribute(lev, 1));
    this.geo.computeBoundingSphere();
  }

  count() {
    let n = 0;
    for (const a of this.have.values()) n += a.length / 5;
    return n;
  }
}

// ------------------------------------------------------------------ you, live

export interface LiveData {
  dim: string;
  pos: [number, number, number];
  yaw: number;
  pitch: number;
  trail: [number, number, number, string, number][];
}

export class LiveLayer {
  group = new THREE.Group();
  rig: SkinViewer | null = null;
  private line: THREE.Line;
  private target = new THREE.Vector3();
  shown = new THREE.Vector3();
  private yaw = 0;
  private walked = 0;
  private speed = 0;
  has = false;
  private trailKey = "";

  constructor() {
    this.line = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.line.frustumCulled = false;
    this.line.renderOrder = 4;
    this.group.add(this.line);
    this.group.visible = false;
  }

  setRig(r: SkinViewer | null) {
    if (this.rig) this.group.remove(this.rig.root);
    this.rig = r;
    if (r) {
      r.root.scale.setScalar(1 / 16);
      this.group.add(r.root);
    }
  }

  /** New data from the mod (null hides everything). `dim` is the dimension being viewed. */
  set(d: LiveData | null, dim: string, accent: number) {
    if (!d) {
      this.has = false;
      this.group.visible = false;
      return;
    }
    const same = d.dim === dim;
    this.group.visible = same;
    this.target.set(d.pos[0], d.pos[1], d.pos[2]);
    if (!this.has) this.shown.copy(this.target);
    this.has = true;
    this.yaw = (-d.yaw * Math.PI) / 180;
    const key = d.trail.length + ":" + (d.trail[d.trail.length - 1]?.[4] ?? 0) + dim;
    if (key !== this.trailKey) {
      this.trailKey = key;
      const pts = d.trail.filter((p) => p[3] === dim);
      const pos: number[] = [];
      const col: number[] = [];
      const c = new THREE.Color(accent);
      pts.forEach((p, i) => {
        pos.push(p[0] + 0.5, p[1] + 0.15, p[2] + 0.5);
        const f = 0.25 + 0.75 * (i / Math.max(1, pts.length - 1));
        col.push(c.r * f, c.g * f, c.b * f);
      });
      if (same) {
        pos.push(d.pos[0], d.pos[1] + 0.15, d.pos[2]);
        col.push(c.r, c.g, c.b);
      }
      const g = this.line.geometry;
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      g.computeBoundingSphere();
    }
  }

  update(dt: number) {
    if (!this.has) return;
    const before = this.shown.clone();
    // glide between the once-a-second updates
    this.shown.lerp(this.target, 1 - Math.exp(-dt * 3.5));
    if (this.shown.distanceTo(this.target) > 40) this.shown.copy(this.target);
    const moved = Math.hypot(this.shown.x - before.x, this.shown.z - before.z);
    this.walked += moved;
    this.speed += (moved / Math.max(dt, 1e-3) - this.speed) * 0.2;
    const r = this.rig;
    if (r) {
      r.root.position.copy(this.shown);
      r.root.rotation.y = this.yaw;
      r.animate(this.walked * 0.55, Math.min(1, this.speed / 4.3));
    }
  }
}
