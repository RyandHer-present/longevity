import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";

/**
 * A resource pack's version of the block texture array: the same layers as the vanilla one
 * (so meshes don't change), at the pack's own resolution. Built by packview.rs.
 */
export class PackTextures {
  res = 16;
  layers = 0;
  /** layers whose texture the pack changes */
  changed = 0;
  tex: THREE.DataArrayTexture | null = null;
  onChange: (() => void) | null = null;
  private data: Uint8Array<ArrayBuffer> | null = null;
  private capacity = 0;
  private loading: Promise<void> | null = null;
  private wanted = 0;
  private dead = false;

  constructor(
    public inst: string,
    public file: string,
  ) {}

  /** Make sure the first `n` layers are there (call with the vanilla array's layer count). */
  ensure(n: number): Promise<void> {
    if (this.dead || (n <= this.layers && this.tex)) return this.loading ?? Promise.resolve();
    this.wanted = Math.max(this.wanted, n);
    if (!this.loading) {
      this.loading = this.load().finally(() => {
        this.loading = null;
        if (!this.dead && this.wanted > this.layers) void this.ensure(this.wanted);
      });
    }
    return this.loading;
  }

  private async load() {
    const buf = await invoke<ArrayBuffer>("pack_tex", { inst: this.inst, file: this.file, from: this.layers });
    if (this.dead) return;
    const dv = new DataView(buf);
    const res = dv.getUint32(0, true);
    const total = dv.getUint32(4, true);
    const from = dv.getUint32(8, true);
    this.changed = dv.getUint32(12, true);
    const per = res * res * 4;
    if (!this.tex || res !== this.res || total > this.capacity) {
      const cap = Math.max(total + 256, Math.ceil(this.capacity * 1.5));
      const next = new Uint8Array(per * cap);
      if (this.data && res === this.res) next.set(this.data.subarray(0, this.layers * per));
      this.tex?.dispose();
      this.data = next;
      this.capacity = cap;
      this.res = res;
      const t = new THREE.DataArrayTexture(this.data, res, res, cap);
      t.format = THREE.RGBAFormat;
      t.type = THREE.UnsignedByteType;
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestMipmapLinearFilter;
      t.generateMipmaps = true;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      this.tex = t;
    }
    this.data!.set(new Uint8Array(buf, 16, (total - from) * per), from * per);
    this.layers = total;
    this.tex.needsUpdate = true;
    this.onChange?.();
  }

  dispose() {
    this.dead = true;
    this.tex?.dispose();
    this.tex = null;
    this.data = null;
    invoke("pack_close").catch(() => {});
  }
}
