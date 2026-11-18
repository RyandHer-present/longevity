import * as THREE from "three";
import { api } from "../api";

/** Solid-block lookup around the camera (32^3 bits fetched from the backend). Unseen land is solid. */
export class Collider {
  private bits: Uint8Array | null = null;
  private base = new THREE.Vector3(1e9, 1e9, 1e9);
  private loading = false;
  dim = "minecraft:overworld";

  reset(dim: string) {
    this.dim = dim;
    this.bits = null;
    this.base.set(1e9, 1e9, 1e9);
  }

  update(p: THREE.Vector3) {
    const c = new THREE.Vector3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    const center = this.base.clone().addScalar(16);
    if (!this.loading && (Math.abs(c.x - center.x) > 7 || Math.abs(c.y - center.y) > 7 || Math.abs(c.z - center.z) > 7)) {
      this.loading = true;
      const dim = this.dim;
      api
        .solidBox(dim, c.x, c.y, c.z)
        .then((b) => {
          if (dim !== this.dim) return;
          this.bits = new Uint8Array(b);
          this.base.set(c.x - 16, c.y - 16, c.z - 16);
        })
        .catch(() => {})
        .finally(() => (this.loading = false));
    }
  }

  /** true/false when known, null when outside the fetched box */
  solid(x: number, y: number, z: number): boolean | null {
    if (!this.bits) return null;
    const lx = Math.floor(x) - this.base.x,
      ly = Math.floor(y) - this.base.y,
      lz = Math.floor(z) - this.base.z;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= 32 || ly >= 32 || lz >= 32) return null;
    const i = (ly * 32 + lz) * 32 + lx;
    return (this.bits[i >> 3] & (1 << (i & 7))) !== 0;
  }

  blocked(p: THREE.Vector3, r = 0.25): boolean {
    for (const dx of [-r, r])
      for (const dy of [-r, r])
        for (const dz of [-r, r]) {
          if (this.solid(p.x + dx, p.y + dy, p.z + dz) === true) return true;
        }
    return false;
  }
}

/** Free-flying camera: WASD + Space/Shift, drag to look, wheel for speed. Collides with blocks. */
export class FlyControls {
  enabled = false;
  yaw = 0;
  pitch = 0;
  speed = 12;
  vel = new THREE.Vector3();
  keys = new Set<string>();
  collide = true;
  private dragging = false;
  private last = { x: 0, y: 0 };
  onSpeed: ((s: number) => void) | null = null;

  constructor(
    private cam: THREE.PerspectiveCamera,
    private el: HTMLElement,
    private collider: Collider,
  ) {
    el.addEventListener("pointerdown", this.down);
    window.addEventListener("pointermove", this.move);
    window.addEventListener("pointerup", this.up);
    window.addEventListener("keydown", this.kd);
    window.addEventListener("keyup", this.ku);
    window.addEventListener("blur", () => this.keys.clear());
    el.addEventListener("wheel", this.wheel, { passive: false });
  }

  syncFromCamera() {
    const e = new THREE.Euler().setFromQuaternion(this.cam.quaternion, "YXZ");
    this.yaw = e.y;
    this.pitch = e.x;
  }

  private down = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.dragging = true;
    this.last = { x: e.clientX, y: e.clientY };
  };
  private move = (e: PointerEvent) => {
    if (!this.enabled || !this.dragging) return;
    const dx = e.clientX - this.last.x,
      dy = e.clientY - this.last.y;
    this.last = { x: e.clientX, y: e.clientY };
    this.yaw -= dx * 0.0032;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - dy * 0.0032));
  };
  private up = () => {
    this.dragging = false;
  };
  private typing() {
    const a = document.activeElement as HTMLElement | null;
    return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
  }
  private kd = (e: KeyboardEvent) => {
    if (!this.enabled || this.typing()) return;
    this.keys.add(e.code);
  };
  private ku = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };
  private wheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    this.speed = Math.max(2, Math.min(120, this.speed * (e.deltaY > 0 ? 0.85 : 1.18)));
    this.onSpeed?.(this.speed);
  };

  update(dt: number) {
    if (!this.enabled) return;
    const k = this.keys;
    const f = (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0);
    const s = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
    const u = (k.has("Space") || k.has("KeyE") ? 1 : 0) - (k.has("ShiftLeft") || k.has("KeyQ") ? 1 : 0);
    const boost = k.has("ControlLeft") ? 3 : 1;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const want = new THREE.Vector3().addScaledVector(fwd, f).addScaledVector(right, s);
    want.y += u;
    if (want.lengthSq() > 0) want.normalize().multiplyScalar(this.speed * boost);
    this.vel.lerp(want, 1 - Math.exp(-dt * 8));
    const p = this.cam.position;
    const step = this.vel.clone().multiplyScalar(dt);
    if (this.collide) {
      this.collider.update(p);
      const wasBlocked = this.collider.blocked(p);
      for (const axis of ["x", "y", "z"] as const) {
        const before = p[axis];
        p[axis] += step[axis];
        if (!wasBlocked && this.collider.blocked(p)) {
          p[axis] = before;
          this.vel[axis] = 0;
        }
      }
    } else p.add(step);
    this.cam.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
  }
}

/** Slow cinematic camera moves around a point of interest. */
export interface Shot {
  dur: number;
  at: (t: number, c: THREE.Vector3) => { pos: THREE.Vector3; look: THREE.Vector3 };
}

export function cinematicShots(seed: number): Shot[] {
  const r = (n: number) => {
    const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const a0 = r(1) * Math.PI * 2;
  return [
    {
      // high, slow orbit
      dur: 34,
      at: (t, c) => {
        const a = a0 + t * 0.028;
        const R = 62 + Math.sin(t * 0.09) * 8;
        return { pos: new THREE.Vector3(c.x + Math.cos(a) * R, c.y + 34 + Math.sin(t * 0.07) * 5, c.z + Math.sin(a) * R), look: c.clone().add(new THREE.Vector3(0, 3, 0)) };
      },
    },
    {
      // low dolly across the base
      dur: 26,
      at: (t, c) => {
        const a = a0 + 1.9;
        const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
        const side = new THREE.Vector3(-dir.z, 0, dir.x);
        const p = c.clone().addScaledVector(dir, 34).addScaledVector(side, -28 + t * 2.1);
        p.y = c.y + 9 + t * 0.12;
        const look = c.clone().addScaledVector(side, -10 + t * 0.9);
        look.y = c.y + 2;
        return { pos: p, look };
      },
    },
    {
      // rising crane shot
      dur: 28,
      at: (t, c) => {
        const a = a0 + 3.6 - t * 0.012;
        const R = 30 + t * 1.1;
        return { pos: new THREE.Vector3(c.x + Math.cos(a) * R, c.y + 6 + t * 1.25, c.z + Math.sin(a) * R), look: c.clone().add(new THREE.Vector3(0, 1 + t * 0.2, 0)) };
      },
    },
    {
      // wide establishing pass
      dur: 30,
      at: (t, c) => {
        const a = a0 + 5.0 + t * 0.018;
        const R = 120 - t * 1.2;
        return { pos: new THREE.Vector3(c.x + Math.cos(a) * R, c.y + 55 - t * 0.6, c.z + Math.sin(a) * R), look: c.clone() };
      },
    },
  ];
}
