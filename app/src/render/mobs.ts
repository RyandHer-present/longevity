// Mobs and dropped items near the camera, drawn with the game's own model geometry (extracted from
// the client's LayerDefinitions into mobdefs.json) and textures, with gentle idle animations.
// createMobModel / animateMobModel are shared with the Dex, which brings its own materials.
import * as THREE from "three";
import { api, blockTex, iconUrl, type EntityInfo } from "../api";
import DEFS from "./mobdefs.json";
import { mobSpec, type TexLayer } from "./mobtex";

interface CubeDef {
  o: number[];
  s: number[];
  uv: number[];
  g: number[];
  m: boolean;
}
interface PartDef {
  name: string;
  pose: number[];
  cubes: CubeDef[];
  children: PartDef[];
  scale?: number;
}
interface ModelDef {
  tex: [number, number];
  scale: number;
  root: PartDef;
}
const defs = DEFS as unknown as Record<string, ModelDef>;

// ------------------------------------------------------------------ public API

export interface MobLook {
  id: string;
  variant?: string | null;
  tamed?: boolean;
  baby?: boolean;
  color?: number | null;
  villager?: { profession?: string | null; type?: string | null; level?: number | null } | null;
  sheared?: boolean;
  collar?: number | null;
}
export interface MobModel {
  object: THREE.Group /* centered at origin, feet on y=0, already in block units incl. the -1/16 flip and per-mob scale */;
  parts: Map<string, { group: THREE.Group; base: THREE.Euler }>;
  key: string;
  height: number;
  width: number;
  ready: Promise<void> /* resolves when textures are applied */;
}
export type MaterialFactory = (tex: THREE.Texture | null, tint?: number) => THREE.Material;

// ------------------------------------------------------------------ geometry

const MOB_VERT = /* glsl */ `
out vec2 vUv;
out vec3 vN;
out vec3 vWorld;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const MOB_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D map;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform vec3 uMinLight;
uniform vec3 uBlockColor;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uHover;
uniform vec3 uTint;
uniform float uEmissive;
uniform float uAlpha;
in vec2 vUv;
in vec3 vN;
in vec3 vWorld;
void main() {
  vec4 t = texture(map, vUv);
  if (t.a < 0.1) discard;
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 light = uSkyAmbient * (0.72 + 0.28 * max(n.y, 0.0)) + uSunColor * ndl * 0.85 + uMinLight * 1.5 + uBlockColor * 0.06;
  vec3 col = t.rgb * uTint * light;
  col = mix(col, t.rgb * uTint * 1.4, uEmissive);
  float d = length(vWorld - cameraPosition);
  col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, d));
  col += uHover * vec3(0.10, 0.085, 0.04);
  gl_FragColor = vec4(col, mix(1.0, t.a, uAlpha));
}`;

const DIR_N: Record<string, [number, number, number]> = {
  down: [0, -1, 0],
  up: [0, 1, 0],
  west: [-1, 0, 0],
  north: [0, 0, -1],
  east: [1, 0, 0],
  south: [0, 0, 1],
};

/** Geometry for one part's cubes (in part-local model units, 1/16 block). */
function partGeometry(cubes: CubeDef[], tw: number, th: number): THREE.BufferGeometry | null {
  if (!cubes.length) return null;
  const pos: number[] = [],
    nor: number[] = [],
    uvs: number[] = [],
    idx: number[] = [];
  for (const c of cubes) {
    const [w, h, d] = c.s;
    const [gx, gy, gz] = c.g;
    let x0 = c.o[0] - gx,
      x1 = c.o[0] + w + gx;
    const y0 = c.o[1] - gy,
      y1 = c.o[1] + h + gy,
      z0 = c.o[2] - gz,
      z1 = c.o[2] + d + gz;
    if (c.m) [x0, x1] = [x1, x0];
    const t0 = [x0, y0, z0],
      t1 = [x1, y0, z0],
      t2 = [x1, y1, z0],
      t3 = [x0, y1, z0];
    const l0 = [x0, y0, z1],
      l1 = [x1, y0, z1],
      l2 = [x1, y1, z1],
      l3 = [x0, y1, z1];
    const [u, v] = c.uv;
    const u0 = u,
      u1 = u + d,
      u2 = u + d + w,
      u22 = u + d + w + w,
      u3 = u + d + w + d,
      u4 = u + d + w + d + w;
    const v0 = v,
      v1 = v + d,
      v2 = v + d + h;
    const faces: [string, number[][], number[]][] = [
      ["down", [l1, l0, t0, t1], [u1, v0, u2, v1]],
      ["up", [t2, t3, l3, l2], [u2, v1, u22, v0]],
      ["west", [t0, l0, l3, t3], [u0, v1, u1, v2]],
      ["north", [t1, t0, t3, t2], [u1, v1, u2, v2]],
      ["east", [l1, t1, t2, l2], [u2, v1, u3, v2]],
      ["south", [l0, l1, l2, l3], [u3, v1, u4, v2]],
    ];
    for (const [dir, verts, [pu0, pv0, pu1, pv1]] of faces) {
      let uv = [
        [pu1, pv0],
        [pu0, pv0],
        [pu0, pv1],
        [pu1, pv1],
      ];
      let vs = verts;
      if (c.m) {
        vs = [...verts].reverse();
        uv = [...uv].reverse();
      }
      const n = DIR_N[dir].slice() as [number, number, number];
      if (c.m && (dir === "west" || dir === "east")) n[0] = -n[0];
      const base = pos.length / 3;
      for (let i = 0; i < 4; i++) {
        pos.push(vs[i][0], vs[i][1], vs[i][2]);
        nor.push(n[0], n[1], n[2]);
        uvs.push(uv[i][0] / tw, uv[i][1] / th);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

interface BuiltPart {
  group: THREE.Group;
  base: THREE.Euler;
}

interface Template {
  def: ModelDef;
  geos: Map<PartDef, THREE.BufferGeometry | null>;
}
const templates = new Map<string, Template>();
function template(key: string): Template | null {
  const def = defs[key];
  if (!def) return null;
  let t = templates.get(key);
  if (!t) {
    t = { def, geos: new Map() };
    const walk = (p: PartDef) => {
      t!.geos.set(p, partGeometry(p.cubes, def.tex[0], def.tex[1]));
      p.children.forEach(walk);
    };
    walk(def.root);
    templates.set(key, t);
  }
  return t;
}

/** Builds one model's part tree. Hidden parts keep their group (for structure) but get no mesh. */
function buildModel(key: string, mat: THREE.Material, parts: Map<string, BuiltPart>, meshes: THREE.Mesh[], hide: Set<string>): THREE.Group | null {
  const t = template(key);
  if (!t) return null;
  const make = (p: PartDef): THREE.Group => {
    const g = new THREE.Group();
    g.name = p.name;
    g.position.set(p.pose[0], p.pose[1], p.pose[2]);
    g.rotation.set(p.pose[3], p.pose[4], p.pose[5], "ZYX");
    if (p.scale) g.scale.setScalar(p.scale);
    const geo = t.geos.get(p);
    if (hide.has(p.name)) g.visible = false;
    else if (geo) {
      const m = new THREE.Mesh(geo, mat);
      meshes.push(m);
      g.add(m);
    }
    parts.set(p.name, { group: g, base: g.rotation.clone() });
    for (const c of p.children) g.add(make(c));
    return g;
  };
  return make(t.def.root);
}

// ------------------------------------------------------------------ textures

const texCache = new Map<string, Promise<THREE.Texture | null>>();
function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = url;
  });
}
/** The image multiplied by a colour, keeping its alpha (the game's tinted entity layers). */
function tinted(img: HTMLImageElement, tint: number, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0, w, h);
  g.globalCompositeOperation = "multiply";
  g.fillStyle = "#" + (tint & 0xffffff).toString(16).padStart(6, "0");
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = "destination-in";
  g.drawImage(img, 0, 0, w, h);
  return c;
}
function compositeTexture(layers: TexLayer[]): Promise<THREE.Texture | null> {
  const key = layers.map((l) => (l.tint == null ? l.path : `${l.path}#${l.tint.toString(16)}`)).join("|");
  let p = texCache.get(key);
  if (!p) {
    p = Promise.all(layers.map((l) => loadImage(blockTex(l.path)))).then((imgs) => {
      const first = imgs[0];
      if (!first) return null;
      const c = document.createElement("canvas");
      c.width = first.width;
      c.height = first.height;
      const g = c.getContext("2d")!;
      g.imageSmoothingEnabled = false;
      imgs.forEach((im, i) => {
        if (!im) return;
        const tint = layers[i].tint;
        g.drawImage(tint == null ? im : tinted(im, tint, c.width, c.height), 0, 0, c.width, c.height);
      });
      const t = new THREE.CanvasTexture(c);
      t.flipY = false;
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      return t;
    });
    texCache.set(key, p);
  }
  return p;
}

// ------------------------------------------------------------------ models

interface Internal {
  bob: THREE.Group;
  /** extra-layer part -> the main-model part it follows */
  links: [THREE.Group, THREE.Group][];
  linked: Set<THREE.Group>;
  baseScale: Map<THREE.Group, number>;
}
const internals = new WeakMap<MobModel, Internal>();

export function hasMobModel(id: string): boolean {
  const spec = mobSpec({ id });
  return !!spec && spec.layers.every((l) => !!defs[l.key]);
}

/**
 * Builds a mob from the game's geometry. Every layer gets a material from `makeMaterial(null, tint)`
 * straight away; once its texture has loaded it is swapped for `makeMaterial(texture, tint)` (and the
 * placeholder disposed). Translucent layers get `transparent = true` set on their materials.
 */
export function createMobModel(look: MobLook, makeMaterial: MaterialFactory): MobModel | null {
  const spec = mobSpec(look);
  if (!spec) return null;
  const def = defs[spec.key];
  if (!def) return null;
  const hide = new Set(spec.hide);
  const parts = new Map<string, BuiltPart>();
  const links: [THREE.Group, THREE.Group][] = [];
  const loads: Promise<void>[] = [];
  // the game renders models upside down: scale(-1,-1,1), translate(0,-1.501,0)
  const flip = new THREE.Group();
  flip.scale.set(-1 / 16, -1 / 16, 1 / 16);
  flip.position.y = 1.501;
  spec.layers.forEach((layer, i) => {
    const placeholder = makeMaterial(null, layer.tint);
    if (layer.translucent) placeholder.transparent = true;
    const meshes: THREE.Mesh[] = [];
    const lp = new Map<string, BuiltPart>();
    const root = buildModel(layer.key, placeholder, lp, meshes, hide);
    if (!root) {
      placeholder.dispose();
      return;
    }
    if (i > 0) for (const m of meshes) m.renderOrder = i; // extra layers draw after the body
    flip.add(root);
    const prefix = i === 0 ? "" : (layer.prefix ?? `layer${i}_`);
    for (const [name, p] of lp) {
      if (i > 0) {
        const main = parts.get(name);
        if (main) links.push([p.group, main.group]);
      }
      parts.set(prefix + name, p);
    }
    loads.push(
      compositeTexture(layer.tex).then((tex) => {
        if (!tex) return;
        const mat = makeMaterial(tex, layer.tint);
        if (layer.translucent) mat.transparent = true;
        for (const m of meshes) m.material = mat;
        placeholder.dispose();
      }),
    );
  });

  // default poses the game sets in setupAnim
  const setBase = (name: string, f: (e: THREE.Euler) => void) => {
    const main = parts.get(name);
    if (!main) return;
    const followers = links.filter(([, b]) => b === main.group).map(([o]) => o);
    for (const p of parts.values()) {
      if (p === main || followers.includes(p.group)) {
        f(p.base);
        p.group.rotation.copy(p.base);
      }
    }
  };
  if (spec.zombieArms) {
    for (const [n, sgn] of [["right_arm", -1], ["left_arm", 1]] as const) {
      setBase(n, (e) => {
        e.x = -Math.PI / 2.25;
        e.y = 0.1 * sgn;
      });
    }
  }
  if (spec.key === "wolf") setBase("tail", (e) => (e.x = look.tamed ? 0.55 * Math.PI : Math.PI / 5));

  const scaled = new THREE.Group();
  let s = (def.scale || 1) * spec.scale;
  if (look.baby) s *= 0.55;
  scaled.scale.setScalar(s);
  scaled.add(flip);
  const bob = new THREE.Group();
  bob.add(scaled);
  const center = new THREE.Group();
  center.add(bob);
  const object = new THREE.Group();
  object.add(center);
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(center);
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.3, 0, -0.3), new THREE.Vector3(0.3, 0.6, 0.3));
  center.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  object.updateMatrixWorld(true);
  const size = box.getSize(new THREE.Vector3());

  const baseScale = new Map<THREE.Group, number>();
  for (const p of parts.values()) baseScale.set(p.group, p.group.scale.x);
  const model: MobModel = {
    object,
    parts,
    key: spec.key,
    width: Math.max(size.x, size.z),
    height: size.y,
    ready: Promise.all(loads).then(() => undefined),
  };
  internals.set(model, { bob, links, linked: new Set(links.map(([o]) => o)), baseScale });
  return model;
}

const GRAZERS = new Set(["sheep", "cow", "cow_cold", "cow_warm", "horse", "donkey", "goat", "llama"]);
const FLOATERS = new Set(["bee", "bat", "allay", "vex", "ghast", "happy_ghast", "blaze", "phantom", "wither", "ender_dragon"]);

/** Gentle idle animation; `t` in seconds. */
export function animateMobModel(m: MobModel, t: number, seed = 0, tamed = false): void {
  const inn = internals.get(m);
  const s = seed;
  const key = m.key;
  const n = (a: number, b: number) => Math.sin(t * a + s * b) * 0.5 + Math.sin(t * a * 2.13 + s * b * 1.7) * 0.25;
  for (const [name, p] of m.parts) {
    const g = p.group;
    if (inn?.linked.has(g)) continue;
    g.rotation.copy(p.base);
    if (name === "head" || name === "head_parts") {
      const graze = GRAZERS.has(key) && Math.sin(t * 0.13 + s) > 0.82;
      g.rotation.y = p.base.y + n(0.31, 1) * 0.65;
      g.rotation.x = p.base.x + (graze ? 0.95 : n(0.23, 2) * 0.18);
    } else if (name.endsWith("_head") && key === "wither") {
      g.rotation.y = p.base.y + n(0.37, name.length) * 0.4;
    } else if (name === "tail" || name === "real_tail") {
      const wag = tamed ? Math.sin(t * 9 + s) * 0.45 : Math.sin(t * 1.4 + s) * 0.12;
      g.rotation.y = p.base.y + wag;
    } else if (name.includes("wing")) {
      const side = name.startsWith("right") ? 1 : -1;
      if (key === "bee") g.rotation.x = p.base.x + Math.sin(t * 60) * 0.5;
      else if (key === "chicken" || key === "chicken_cold") {
        const flap = Math.sin(t * 0.7 + s) > 0.93 ? Math.abs(Math.sin(t * 22)) * 0.9 : 0;
        g.rotation.z = p.base.z + side * flap;
      } else if (key === "allay" || key === "vex") g.rotation.y = p.base.y + side * Math.sin(t * 14 + s) * 0.35;
      else if (key === "bat") g.rotation.y = p.base.y + side * Math.sin(t * 16 + s) * (name.endsWith("tip") ? 0.5 : 0.7);
      else if (key === "phantom" || key === "ender_dragon") {
        const speed = key === "phantom" ? 4 : 1.6;
        const tip = name.includes("tip") ? -0.6 : 1;
        g.rotation.z = p.base.z - side * Math.sin(t * speed + s) * 0.35 * tip;
      }
    } else if (name.startsWith("tentacle")) {
      const i = parseInt(name.slice(8), 10) || 0;
      g.rotation.x = p.base.x + Math.sin(t * 2.4 + s + i) * (key === "squid" ? 0.15 : 0.2);
    } else if (name === "body") {
      g.scale.setScalar((inn?.baseScale.get(g) ?? 1) * (1 + Math.sin(t * 1.6 + s) * 0.008));
    }
  }
  if (inn) {
    for (const [o, b] of inn.links) {
      o.rotation.copy(b.rotation);
      o.scale.copy(b.scale);
    }
    if (FLOATERS.has(key)) {
      const amp = key === "bee" || key === "bat" ? 0.08 : Math.max(0.06, m.height * 0.04);
      inn.bob.position.y = Math.sin(t * 2.2 + s) * amp;
    }
  }
}

// ------------------------------------------------------------------ world instances

interface Mob {
  info: EntityInfo;
  key: string;
  root: THREE.Group; // world placement
  sprite: THREE.Mesh | null; // dropped items
  model: MobModel | null;
  mats: THREE.ShaderMaterial[];
  seed: number;
  box: THREE.Box3;
  kind: "mob" | "item";
  dead: boolean;
}

export class Mobs {
  root = new THREE.Group();
  private mobs: Mob[] = [];
  private last = new THREE.Vector3(1e9, 0, 1e9);
  private lastAt = 0;
  private loading = false;
  private dim = "minecraft:overworld";
  private gen = 0;
  hovered: Mob | null = null;
  enabled = true;
  private itemGeo = new THREE.PlaneGeometry(0.5, 0.5);

  constructor(private shared: Record<string, THREE.IUniform>) {
    this.root.name = "mobs";
  }

  reset(dim: string) {
    this.dim = dim;
    this.gen++;
    this.clear();
    this.last.set(1e9, 0, 1e9);
  }

  refresh() {
    this.lastAt = 0;
  }

  private clear() {
    for (const m of this.mobs) {
      m.dead = true;
      this.root.remove(m.root);
      for (const mat of m.mats) mat.dispose();
    }
    this.mobs = [];
    this.hovered = null;
  }

  private material(tex: THREE.Texture | null, tint = 0xffffff, emissive = 0): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: MOB_VERT,
      fragmentShader: MOB_FRAG,
      uniforms: {
        ...this.shared,
        map: { value: tex },
        uHover: { value: 0 },
        uTint: { value: new THREE.Color(tint) },
        uEmissive: { value: emissive },
        uAlpha: { value: 0 },
      },
      side: THREE.DoubleSide,
    });
  }

  update(dt: number, focus: THREE.Vector3, camera: THREE.Camera) {
    if (!this.enabled) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;
    const now = performance.now();
    if (!this.loading && (focus.distanceTo(this.last) > 28 || now - this.lastAt > 25000)) {
      this.load(focus.clone());
    }
    const t = now / 1000;
    for (const m of this.mobs) this.animate(m, t, camera);
  }

  private async load(focus: THREE.Vector3) {
    this.loading = true;
    this.last.copy(focus);
    this.lastAt = performance.now();
    const gen = this.gen;
    try {
      const list = await api.entities(this.dim, focus.x, focus.z, 112);
      if (gen !== this.gen) return;
      list.sort((a, b) => Math.hypot(a.pos[0] - focus.x, a.pos[2] - focus.z) - Math.hypot(b.pos[0] - focus.x, b.pos[2] - focus.z));
      const keep = list.filter((e) => e.id !== "minecraft:chest_minecart" && e.id !== "minecraft:falling_block" && e.id !== "minecraft:experience_orb" && e.id !== "minecraft:arrow").slice(0, 260);
      this.clear();
      for (const e of keep) this.spawn(e);
    } catch {
      /* world not ready */
    } finally {
      this.loading = false;
    }
  }

  private spawn(e: EntityInfo) {
    const root = new THREE.Group();
    root.position.set(e.pos[0], e.pos[1], e.pos[2]);
    const seed = Math.abs(Math.sin(e.pos[0] * 12.9898 + e.pos[2] * 78.233)) * 1000;
    if (e.id === "minecraft:item" && e.item) {
      const mat = this.material(null);
      const sprite = new THREE.Mesh(this.itemGeo, mat);
      sprite.position.y = 0.3;
      root.add(sprite);
      new THREE.TextureLoader().load(iconUrl(e.item), (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.magFilter = THREE.LinearFilter;
        tex.flipY = true;
        mat.uniforms.map.value = tex;
        mat.uniforms.uEmissive.value = 0.35;
      });
      this.root.add(root);
      this.mobs.push({ info: e, key: "item", root, sprite, model: null, mats: [mat], seed, box: new THREE.Box3(new THREE.Vector3(-0.3, 0, -0.3), new THREE.Vector3(0.3, 0.6, 0.3)), kind: "item", dead: false });
      return;
    }
    const mob: Mob = { info: e, key: "", root, sprite: null, model: null, mats: [], seed, box: new THREE.Box3(), kind: "mob", dead: false };
    const look: MobLook = { id: e.id, variant: e.variant, tamed: e.tamed, baby: e.baby, color: e.color, villager: e.villager, sheared: e.sheared };
    const model = createMobModel(look, (tex, tint) => {
      const mat = this.material(tex, tint ?? 0xffffff);
      mob.mats.push(mat);
      if (mob.dead) mat.dispose();
      return mat;
    });
    if (!model) {
      for (const mat of mob.mats) mat.dispose();
      return;
    }
    mob.model = model;
    mob.key = model.key;
    const yawGroup = new THREE.Group();
    yawGroup.rotation.y = THREE.MathUtils.degToRad(180 - e.yaw);
    yawGroup.add(model.object);
    root.add(yawGroup);
    this.root.add(root);
    const box = new THREE.Box3().setFromObject(root);
    box.min.sub(root.position);
    box.max.sub(root.position);
    mob.box = box;
    this.mobs.push(mob);
  }

  private animate(m: Mob, t: number, camera: THREE.Camera) {
    if (m.sprite) {
      m.sprite.position.y = 0.32 + Math.sin(t * 2 + m.seed) * 0.06;
      m.sprite.quaternion.copy(camera.quaternion);
      return;
    }
    if (m.model) animateMobModel(m.model, t, m.seed, m.info.tamed);
    const hov = this.hovered === m ? 1 : 0;
    for (const mat of m.mats) {
      mat.uniforms.uHover.value += (hov - mat.uniforms.uHover.value) * 0.25;
      mat.uniforms.uAlpha.value = mat.transparent ? 1 : 0;
    }
  }

  pick(ndc: THREE.Vector2, camera: THREE.Camera): EntityInfo | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    let best: Mob | null = null;
    let bestD = Infinity;
    const b = new THREE.Box3();
    const hit = new THREE.Vector3();
    for (const m of this.mobs) {
      b.copy(m.box).translate(m.root.position);
      b.expandByScalar(0.15);
      if (ray.ray.intersectBox(b, hit)) {
        const d = hit.distanceTo(ray.ray.origin);
        if (d < bestD && d < 160) {
          bestD = d;
          best = m;
        }
      }
    }
    this.hovered = best;
    return best?.info ?? null;
  }
}
