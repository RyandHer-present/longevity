import * as THREE from "three";
import { api } from "../api";

/** The block texture array (16x16 layers, allocated lazily by the backend as chunks are meshed). */
export class BlockTextures {
  capacity = 2048;
  layers = 0;
  tex: THREE.DataArrayTexture;
  anim: THREE.DataTexture;
  private data: Uint8Array<ArrayBuffer>;
  private animData: Uint8Array<ArrayBuffer>;
  private loading: Promise<void> | null = null;
  private wanted = 0;
  onChange: (() => void) | null = null;

  constructor() {
    this.data = new Uint8Array(16 * 16 * 4 * this.capacity);
    this.tex = this.makeTex();
    this.animData = new Uint8Array(256 * (this.capacity / 256) * 4);
    this.anim = this.makeAnim();
  }

  private makeTex() {
    const t = new THREE.DataArrayTexture(this.data, 16, 16, this.capacity);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestMipmapLinearFilter;
    t.generateMipmaps = true;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  }
  private makeAnim() {
    const a = new THREE.DataTexture(this.animData, 256, this.capacity / 256, THREE.RGBAFormat, THREE.UnsignedByteType);
    a.magFilter = THREE.NearestFilter;
    a.minFilter = THREE.NearestFilter;
    a.needsUpdate = true;
    return a;
  }

  /** Make sure at least `n` layers are uploaded (call with the layer count a mesh response reports). */
  ensure(n: number): Promise<void> {
    if (n <= this.layers) return Promise.resolve();
    this.wanted = Math.max(this.wanted, n);
    if (!this.loading) {
      this.loading = this.load().finally(() => {
        this.loading = null;
        if (this.wanted > this.layers) this.ensure(this.wanted);
      });
    }
    return this.loading;
  }

  async load() {
    const buf = await api.textures();
    const dv = new DataView(buf);
    const layers = dv.getUint32(0, true);
    const animCount = dv.getUint32(4, true);
    if (layers > this.capacity) {
      let cap = this.capacity;
      while (cap < layers) cap *= 2;
      this.capacity = cap;
      this.tex.dispose();
      this.anim.dispose();
      this.data = new Uint8Array(16 * 16 * 4 * cap);
      this.animData = new Uint8Array(256 * (cap / 256) * 4);
      this.tex = this.makeTex();
      this.anim = this.makeAnim();
    }
    let o = 8;
    this.animData.fill(0);
    for (let i = 0; i < animCount; i++) {
      const frames = dv.getUint16(o, true);
      const ft = dv.getUint16(o + 2, true);
      o += 4;
      this.animData[i * 4] = Math.min(frames, 255);
      this.animData[i * 4 + 1] = Math.min(ft, 255);
    }
    const rgba = new Uint8Array(buf, o, layers * 1024);
    this.data.set(rgba);
    this.layers = layers;
    this.tex.needsUpdate = true;
    this.anim.needsUpdate = true;
    this.onChange?.();
  }
}

/** Load an image from the atlas protocol as a pixelated texture. */
export function loadPixelTexture(url: string, srgb = true): Promise<THREE.Texture> {
  return new Promise((res, rej) => {
    new THREE.TextureLoader().load(
      url,
      (t) => {
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.NearestFilter;
        t.generateMipmaps = false;
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        res(t);
      },
      undefined,
      rej,
    );
  });
}
