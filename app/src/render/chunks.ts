import * as THREE from "three";
import { api } from "../api";
import type { BlockTextures } from "./textures";

export interface ParsedMesh {
  cx: number;
  cz: number;
  minY: number;
  maxY: number;
  opaque: Buf | null;
  translucent: Buf | null;
}
interface Buf {
  quads: number;
  pos: Int16Array;
  uv: Uint16Array;
  layer: Uint16Array;
  color: Uint8Array;
  extra: Uint8Array;
}

function readBuf(buf: ArrayBuffer, dv: DataView, o: number): [Buf | null, number] {
  const q = dv.getUint32(o, true);
  o += 4;
  if (q === 0) return [null, o];
  const pos = new Int16Array(buf.slice(o, o + q * 24));
  o += q * 24;
  const uv = new Uint16Array(buf.slice(o, o + q * 16));
  o += q * 16;
  const layer = new Uint16Array(buf.slice(o, o + q * 8));
  o += q * 8;
  const color = new Uint8Array(buf.slice(o, o + q * 16));
  o += q * 16;
  const extra = new Uint8Array(buf.slice(o, o + q * 16));
  o += q * 16;
  return [{ quads: q, pos, uv, layer, color, extra }, o];
}

export function parseMeshes(buf: ArrayBuffer): { layers: number; meshes: ParsedMesh[] } {
  const dv = new DataView(buf);
  const layers = dv.getUint32(0, true);
  const n = dv.getUint32(4, true);
  let o = 8;
  const meshes: ParsedMesh[] = [];
  for (let i = 0; i < n; i++) {
    const len = dv.getUint32(o, true);
    o += 4;
    const start = o;
    // "CMSH"
    const cx = dv.getInt32(o + 4, true);
    const cz = dv.getInt32(o + 8, true);
    const minY = dv.getInt32(o + 12, true);
    const maxY = dv.getInt32(o + 16, true);
    let p = o + 20;
    const [opaque, p2] = readBuf(buf, dv, p);
    const [translucent] = readBuf(buf, dv, p2);
    meshes.push({ cx, cz, minY, maxY, opaque, translucent });
    o = start + len;
  }
  return { layers, meshes };
}

// one shared index buffer for all quad meshes (0,1,2, 0,2,3 per quad)
let sharedIndex: THREE.BufferAttribute | null = null;
let sharedQuads = 0;
export function quadIndex(quads: number): THREE.BufferAttribute {
  if (!sharedIndex || sharedQuads < quads) {
    let n = Math.max(65536, sharedQuads);
    while (n < quads) n *= 2;
    const idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const v = i * 4,
        o = i * 6;
      idx[o] = v;
      idx[o + 1] = v + 1;
      idx[o + 2] = v + 2;
      idx[o + 3] = v;
      idx[o + 4] = v + 2;
      idx[o + 5] = v + 3;
    }
    sharedIndex = new THREE.BufferAttribute(idx, 1);
    sharedQuads = n;
  }
  return sharedIndex;
}

/** After upload nothing reads a mesh's arrays again (clicks ask the backend, bounds are set by
 * hand), so the page's copy is dropped. If the GPU context is lost, the engine reloads chunks. */
export function releaseAfterUpload(this: THREE.BufferAttribute) {
  (this as unknown as { array: unknown }).array = null;
}

function geometryOf(b: Buf, minY: number, maxY: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(b.pos, 3).onUpload(releaseAfterUpload));
  g.setAttribute("auv", new THREE.BufferAttribute(b.uv, 2, true).onUpload(releaseAfterUpload));
  g.setAttribute("alayer", new THREE.BufferAttribute(b.layer, 1).onUpload(releaseAfterUpload));
  g.setAttribute("acolor", new THREE.BufferAttribute(b.color, 4, true).onUpload(releaseAfterUpload));
  g.setAttribute("aextra", new THREE.BufferAttribute(b.extra, 4).onUpload(releaseAfterUpload));
  g.setIndex(quadIndex(b.quads));
  g.setDrawRange(0, b.quads * 6);
  const lo = Math.min(minY, maxY),
    hi = Math.max(minY, maxY) + 1;
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-1, lo - 1, -1), new THREE.Vector3(17, hi + 1, 17));
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  return g;
}

interface Entry {
  key: string;
  cx: number;
  cz: number;
  group: THREE.Group | null;
  state: "pending" | "loaded" | "empty";
  stale: boolean;
  maxY: number;
  quads: number;
}

export interface ChunkMaterials {
  opaque: THREE.ShaderMaterial;
  translucent: THREE.ShaderMaterial;
  depth: THREE.ShaderMaterial;
}

/** Streams chunk meshes around a focus point. Only chunks the player has seen are requested. */
export class ChunkManager {
  root = new THREE.Group();
  entries = new Map<string, Entry>();
  seen: Set<string> = new Set();
  dim = "minecraft:overworld";
  radius = 12;
  inflight = 0;
  maxInflight = 2;
  batch = 12;
  generation = 0;
  totalQuads = 0;
  onLoaded: (() => void) | null = null;
  private lastFocus = new THREE.Vector2(1e9, 1e9);
  private wantList: [number, number][] = [];

  constructor(
    private mats: ChunkMaterials,
    private tex: BlockTextures,
  ) {
    this.root.name = "chunks";
  }

  reset(dim: string, seen: Set<string>) {
    this.generation++;
    this.dim = dim;
    this.seen = seen;
    for (const e of this.entries.values()) this.disposeEntry(e);
    this.entries.clear();
    this.totalQuads = 0;
    this.lastFocus.set(1e9, 1e9);
  }

  /** Re-check what to keep on the next update (after the radius shrank). */
  trimTo(_radius: number) {
    this.lastFocus.set(1e9, 1e9);
    this.wantList = [];
  }

  setSeen(seen: Set<string>) {
    this.seen = seen;
    this.lastFocus.set(1e9, 1e9);
  }

  private waiters = new Map<string, (() => void)[]>();
  /** Keys ("cx,cz") of chunks that have a mesh. */
  loadedKeys(): string[] {
    const out: string[] = [];
    for (const e of this.entries.values()) if (e.state === "loaded") out.push(e.key);
    return out;
  }
  /** Re-mesh these chunks now (a door opened); resolves once the new meshes are in (or after 3 s). */
  refreshChunks(list: [number, number][]): Promise<void> {
    const ps: Promise<void>[] = [];
    for (const [cx, cz] of list) {
      const k = `${cx},${cz}`;
      const e = this.entries.get(k);
      if (!e) continue;
      e.stale = true;
      ps.push(
        new Promise<void>((res) => {
          const arr = this.waiters.get(k) ?? [];
          arr.push(res);
          this.waiters.set(k, arr);
          setTimeout(res, 3000);
        }),
      );
    }
    // closest first
    this.wantList = [...list.map(([x, z]) => [x, z] as [number, number]), ...this.wantList];
    return Promise.all(ps).then(() => {});
  }

  /** Re-mesh chunks inside changed regions (live updates). Old meshes stay until the new ones arrive. */
  invalidateRegions(regions: [number, number][]) {
    const set = new Set(regions.map(([x, z]) => `${x},${z}`));
    for (const e of this.entries.values()) {
      if (set.has(`${e.cx >> 5},${e.cz >> 5}`)) e.stale = true;
    }
    this.lastFocus.set(1e9, 1e9);
  }

  private disposeEntry(e: Entry) {
    if (e.group) {
      this.root.remove(e.group);
      for (const c of e.group.children) (c as THREE.Mesh).geometry.dispose();
      e.group = null;
    }
    this.totalQuads -= e.quads;
    e.quads = 0;
  }

  /** Fully loaded radius (in blocks) around the focus, used to cut a hole in the LOD terrain. */
  loadedRadius(fx: number, fz: number): number {
    const fcx = Math.floor(fx / 16),
      fcz = Math.floor(fz / 16);
    for (let r = 0; r <= this.radius; r++) {
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const k = `${fcx + dx},${fcz + dz}`;
          if (!this.seen.has(k)) continue;
          const e = this.entries.get(k);
          if (!e || e.state === "pending") return Math.max(0, r * 16 - 8);
        }
    }
    return this.radius * 16;
  }

  update(focus: THREE.Vector3) {
    const fcx = Math.floor(focus.x / 16),
      fcz = Math.floor(focus.z / 16);
    if (Math.abs(fcx - this.lastFocus.x) >= 1 || Math.abs(fcz - this.lastFocus.y) >= 1 || this.wantList.length === 0) {
      this.lastFocus.set(fcx, fcz);
      const R = this.radius;
      const list: [number, number, number][] = [];
      for (let dz = -R; dz <= R; dz++)
        for (let dx = -R; dx <= R; dx++) {
          const d2 = dx * dx + dz * dz;
          if (d2 > R * R + R) continue;
          const cx = fcx + dx,
            cz = fcz + dz;
          if (!this.seen.has(`${cx},${cz}`)) continue;
          list.push([cx, cz, d2]);
        }
      list.sort((a, b) => a[2] - b[2]);
      this.wantList = list.map(([x, z]) => [x, z]);
      // drop far chunks
      const keep = (R + 3) * (R + 3);
      for (const [k, e] of this.entries) {
        const dx = e.cx - fcx,
          dz = e.cz - fcz;
        if (dx * dx + dz * dz > keep && e.state !== "pending") {
          this.disposeEntry(e);
          this.entries.delete(k);
        }
      }
    }
    while (this.inflight < this.maxInflight) {
      const req: [number, number, number][] = [];
      for (const [cx, cz] of this.wantList) {
        const k = `${cx},${cz}`;
        const e = this.entries.get(k);
        if (e && e.state !== "pending" && !e.stale) continue;
        if (e && e.state === "pending") continue;
        if (e) e.state = "pending";
        else this.entries.set(k, { key: k, cx, cz, group: null, state: "pending", stale: false, maxY: 0, quads: 0 });
        req.push([cx, cz, 0]);
        if (req.length >= this.batch) break;
      }
      if (!req.length) break;
      this.request(req);
    }
  }

  pendingCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.state === "pending") n++;
    return n;
  }

  private async request(req: [number, number, number][]) {
    const gen = this.generation;
    this.inflight++;
    try {
      const buf = await api.mesh(this.dim, req);
      if (gen !== this.generation) return;
      const { layers, meshes } = parseMeshes(buf);
      await this.tex.ensure(layers);
      if (gen !== this.generation) return;
      for (const m of meshes) this.install(m);
      this.onLoaded?.();
    } catch (e) {
      console.warn("mesh request failed", e);
      for (const [cx, cz] of req) {
        const en = this.entries.get(`${cx},${cz}`);
        if (en && en.state === "pending") {
          this.entries.delete(en.key);
        }
      }
      await new Promise((r) => setTimeout(r, 800));
    } finally {
      if (gen === this.generation) this.inflight--;
      else this.inflight = Math.max(0, this.inflight - 1);
    }
  }

  private install(m: ParsedMesh) {
    const k = `${m.cx},${m.cz}`;
    let e = this.entries.get(k);
    if (!e) return;
    this.disposeEntry(e);
    e.stale = false;
    const w = this.waiters.get(k);
    if (w) {
      this.waiters.delete(k);
      setTimeout(() => w.forEach((f) => f()), 0);
    }
    if (!m.opaque && !m.translucent) {
      e.state = "empty";
      return;
    }
    const g = new THREE.Group();
    g.position.set(m.cx * 16, 0, m.cz * 16);
    g.matrixAutoUpdate = false;
    g.updateMatrix();
    let quads = 0;
    if (m.opaque) {
      const mesh = new THREE.Mesh(geometryOf(m.opaque, m.minY, m.maxY), this.mats.opaque);
      mesh.customDepthMaterial = this.mats.depth;
      mesh.matrixAutoUpdate = false;
      mesh.userData.kind = "opaque";
      g.add(mesh);
      quads += m.opaque.quads;
    }
    if (m.translucent) {
      const mesh = new THREE.Mesh(geometryOf(m.translucent, m.minY, m.maxY), this.mats.translucent);
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 2;
      mesh.userData.kind = "translucent";
      g.add(mesh);
      quads += m.translucent.quads;
    }
    g.updateMatrixWorld(true);
    e.group = g;
    e.state = "loaded";
    e.maxY = m.maxY;
    e.quads = quads;
    this.totalQuads += quads;
    this.root.add(g);
  }

  /** Highest meshed block near (x, z), if that chunk is loaded. */
  topNear(x: number, z: number): number | null {
    const e = this.entries.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
    return e && e.state === "loaded" ? e.maxY : null;
  }
}
