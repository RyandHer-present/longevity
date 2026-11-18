import * as THREE from "three";
import { releaseAfterUpload } from "./chunks";
import { lodUrl } from "../api";
import { LOD_VERT, LOD_FRAG } from "./shaders";

const N = 128; // cells per region side (4 blocks each)
const UNSEEN = -32768;

/** Blocky low-detail terrain for seen land beyond the meshed chunks (4x4-block columns). */
export class LodTerrain {
  root = new THREE.Group();
  mat: THREE.ShaderMaterial;
  private regions = new Map<string, { mesh: THREE.Mesh | null; v: number; loading: boolean }>();
  dim = "minecraft:overworld";
  available = new Set<string>();
  version = 0;
  range = 2; // regions around the focus
  heights = new Map<string, Int16Array>();

  constructor(shared: Record<string, THREE.IUniform>) {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: LOD_VERT,
      fragmentShader: LOD_FRAG,
      uniforms: { ...shared, uHoleCenter: { value: new THREE.Vector2() }, uHoleRadius: { value: 0 } },
    });
    this.root.name = "lod";
  }

  reset(dim: string, available: Set<string>) {
    this.dim = dim;
    this.available = available;
    for (const r of this.regions.values()) if (r.mesh) {
      this.root.remove(r.mesh);
      r.mesh.geometry.dispose();
    }
    this.regions.clear();
    this.heights.clear();
    this.version++;
  }

  invalidate(regions: [number, number][]) {
    for (const [x, z] of regions) {
      const r = this.regions.get(`${x},${z}`);
      if (r) r.v = -1;
    }
  }

  setHole(x: number, z: number, radius: number) {
    this.mat.uniforms.uHoleCenter.value.set(x, z);
    this.mat.uniforms.uHoleRadius.value = radius;
  }

  /** Terrain height at a world position from the LOD data (for camera paths), or null. */
  heightAt(x: number, z: number): number | null {
    const rx = Math.floor(x / 512),
      rz = Math.floor(z / 512);
    const h = this.heights.get(`${rx},${rz}`);
    if (!h) return null;
    const lx = Math.floor((x - rx * 512) / 4),
      lz = Math.floor((z - rz * 512) / 4);
    const v = h[lz * N + lx];
    return v === UNSEEN ? null : v;
  }

  update(focus: THREE.Vector3) {
    if (this.dim.includes("nether")) return;
    const frx = Math.floor(focus.x / 512),
      frz = Math.floor(focus.z / 512);
    let loading = 0;
    for (const r of this.regions.values()) if (r.loading) loading++;
    for (let dz = -this.range; dz <= this.range; dz++)
      for (let dx = -this.range; dx <= this.range; dx++) {
        const rx = frx + dx,
          rz = frz + dz;
        const k = `${rx},${rz}`;
        if (!this.available.has(k)) continue;
        const r = this.regions.get(k);
        if (r && (r.loading || r.v === this.version)) continue;
        if (loading >= 2) return;
        loading++;
        this.load(rx, rz);
      }
  }

  private async load(rx: number, rz: number) {
    const k = `${rx},${rz}`;
    const ver = this.version;
    const entry = this.regions.get(k) ?? { mesh: null, v: -1, loading: true };
    entry.loading = true;
    this.regions.set(k, entry);
    try {
      const res = await fetch(lodUrl(this.dim, rx, rz, Date.now() >> 14));
      if (!res.ok) throw new Error(String(res.status));
      const buf = await res.arrayBuffer();
      if (ver !== this.version) return;
      const heights = new Int16Array(buf.slice(0, N * N * 2));
      const rgb = new Uint8Array(buf, N * N * 2, N * N * 3);
      this.heights.set(k, heights);
      const mesh = this.build(heights, rgb);
      if (entry.mesh) {
        this.root.remove(entry.mesh);
        entry.mesh.geometry.dispose();
      }
      entry.mesh = mesh;
      if (mesh) {
        mesh.position.set(rx * 512, 0, rz * 512);
        mesh.updateMatrixWorld(true);
        this.root.add(mesh);
      }
      entry.v = this.version;
    } catch {
      entry.v = this.version; // don't hammer a failing region
    } finally {
      entry.loading = false;
    }
  }

  private build(h: Int16Array, rgb: Uint8Array): THREE.Mesh | null {
    // count quads
    const at = (x: number, z: number) => (x < 0 || z < 0 || x >= N || z >= N ? UNSEEN : h[z * N + x]);
    let quads = 0;
    const dirs: [number, number, number][] = [
      [0, -1, 2],
      [0, 1, 3],
      [-1, 0, 4],
      [1, 0, 5],
    ];
    for (let z = 0; z < N; z++)
      for (let x = 0; x < N; x++) {
        const v = h[z * N + x];
        if (v === UNSEEN) continue;
        quads++;
        for (const [dx, dz] of dirs) {
          const n = at(x + dx, z + dz);
          if (n === UNSEEN || n < v) quads++;
        }
      }
    if (!quads) return null;
    const pos = new Float32Array(quads * 12);
    const col = new Uint8Array(quads * 12);
    const face = new Uint8Array(quads * 4);
    let q = 0;
    const put = (p: number[], c: [number, number, number], f: number) => {
      pos.set(p, q * 12);
      for (let i = 0; i < 4; i++) {
        col[q * 12 + i * 3] = c[0];
        col[q * 12 + i * 3 + 1] = c[1];
        col[q * 12 + i * 3 + 2] = c[2];
        face[q * 4 + i] = f;
      }
      q++;
    };
    for (let z = 0; z < N; z++)
      for (let x = 0; x < N; x++) {
        const v = h[z * N + x];
        if (v === UNSEEN) continue;
        const i = (z * N + x) * 3;
        const c: [number, number, number] = [rgb[i], rgb[i + 1], rgb[i + 2]];
        const x0 = x * 4,
          z0 = z * 4,
          x1 = x0 + 4,
          z1 = z0 + 4,
          y = v + 1;
        // top (counter-clockwise seen from above)
        put([x0, y, z0, x0, y, z1, x1, y, z1, x1, y, z0], c, 1);
        for (const [dx, dz, f] of dirs) {
          const n = at(x + dx, z + dz);
          if (n !== UNSEEN && n >= v) continue;
          const yb = n === UNSEEN ? v - 6 : n + 1;
          if (f === 2) put([x1, y, z0, x1, yb, z0, x0, yb, z0, x0, y, z0], c, f);
          else if (f === 3) put([x0, y, z1, x0, yb, z1, x1, yb, z1, x1, y, z1], c, f);
          else if (f === 4) put([x0, y, z0, x0, yb, z0, x0, yb, z1, x0, y, z1], c, f);
          else put([x1, y, z1, x1, yb, z1, x1, yb, z0, x1, y, z0], c, f);
        }
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3).onUpload(releaseAfterUpload));
    g.setAttribute("acol", new THREE.BufferAttribute(col, 3, true).onUpload(releaseAfterUpload));
    g.setAttribute("aface", new THREE.BufferAttribute(face, 1).onUpload(releaseAfterUpload));
    const idx = new Uint32Array(quads * 6);
    for (let i = 0; i < quads; i++) {
      const v = i * 4,
        o = i * 6;
      idx[o] = v;
      idx[o + 1] = v + 1;
      idx[o + 2] = v + 2;
      idx[o + 3] = v;
      idx[o + 4] = v + 2;
      idx[o + 5] = v + 3;
    }
    // bounds first: the arrays are gone after the first draw
    g.computeBoundingSphere();
    g.setIndex(new THREE.BufferAttribute(idx, 1).onUpload(releaseAfterUpload));
    const m = new THREE.Mesh(g, this.mat);
    m.matrixAutoUpdate = false;
    return m;
  }
}
