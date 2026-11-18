// Walk mode: a player body with real Minecraft-ish movement (gravity, jumping, step-up, auto-jump,
// sneaking that won't walk off edges, swimming, ladders) against the blocks around you.
// F5 cycles first person, behind, and in front, showing your own skin and gear.
import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import type { SkinViewer } from "./skinview";

/** Collision classes from the backend (see walk.rs). */
const BOX: Record<number, [number, number]> = { 1: [0, 1], 2: [0, 0.5], 3: [0.5, 1], 4: [0, 1.5], 9: [0, 0.1875] };

export class CollideGrid {
  private cells: Uint8Array | null = null;
  base = new THREE.Vector3(1e9, 1e9, 1e9);
  private loading = false;
  private want = false;
  dim = "minecraft:overworld";

  reset(dim: string) {
    this.dim = dim;
    this.cells = null;
    this.base.set(1e9, 1e9, 1e9);
  }
  /** Fetch again around `p` (after a door opens). */
  refresh(p: THREE.Vector3) {
    this.want = true;
    this.update(p);
  }
  ready() {
    return !!this.cells;
  }
  update(p: THREE.Vector3) {
    const c = new THREE.Vector3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    const center = this.base.clone().addScalar(16);
    const far = Math.abs(c.x - center.x) > 6 || Math.abs(c.y - center.y) > 6 || Math.abs(c.z - center.z) > 6;
    if (this.loading || !(far || this.want)) return;
    this.loading = true;
    this.want = false;
    const dim = this.dim;
    invoke<ArrayBuffer>("w_collide", { dim, x: c.x, y: c.y, z: c.z })
      .then((b) => {
        if (dim !== this.dim) return;
        this.cells = new Uint8Array(b);
        this.base.set(c.x - 16, c.y - 16, c.z - 16);
      })
      .catch(() => {})
      .finally(() => (this.loading = false));
  }
  /** Collision class at a block, or null when outside the fetched box. */
  at(x: number, y: number, z: number): number | null {
    if (!this.cells) return null;
    const lx = Math.floor(x) - this.base.x,
      ly = Math.floor(y) - this.base.y,
      lz = Math.floor(z) - this.base.z;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= 32 || ly >= 32 || lz >= 32) return null;
    return this.cells[(ly * 32 + lz) * 32 + lx];
  }
}

export type View = "first" | "back" | "front";

export class Walker {
  enabled = false;
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  onGround = false;
  inWater = false;
  view: View = "first";
  keys = new Set<string>();
  grid = new CollideGrid();
  rig: SkinViewer | null = null;
  walked = 0;
  private bob = 0;
  private dragging = false;
  private last = { x: 0, y: 0 };
  private bodyYaw = 0;
  private placed = false;
  onView: ((v: View) => void) | null = null;

  constructor(
    private cam: THREE.PerspectiveCamera,
    private el: HTMLElement,
    private scene: THREE.Scene,
  ) {
    el.addEventListener("pointerdown", this.down);
    window.addEventListener("pointermove", this.move);
    window.addEventListener("pointerup", this.up);
    window.addEventListener("keydown", this.kd);
    window.addEventListener("keyup", this.ku);
    window.addEventListener("blur", () => this.keys.clear());
    el.addEventListener("dblclick", this.lock);
  }

  get sneaking() {
    return this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
  }
  get height() {
    return this.sneaking ? 1.5 : 1.8;
  }
  get eye() {
    return this.sneaking ? 1.27 : 1.62;
  }

  setRig(r: SkinViewer | null) {
    if (this.rig) this.scene.remove(this.rig.root);
    this.rig = r;
    if (r) {
      r.root.scale.setScalar(1 / 16);
      r.root.visible = false;
      this.scene.add(r.root);
    }
  }

  /** Stand at (x, y, z) (feet), looking along the camera's current heading. */
  enter(x: number, y: number, z: number, dim: string) {
    if (this.grid.dim !== dim) this.grid.reset(dim);
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    const e = new THREE.Euler().setFromQuaternion(this.cam.quaternion, "YXZ");
    this.yaw = e.y;
    this.bodyYaw = e.y;
    this.pitch = Math.max(-0.6, Math.min(0.6, e.x));
    this.placed = false;
    this.grid.update(this.pos);
  }

  leave() {
    if (this.rig) this.rig.root.visible = false;
    if (document.pointerLockElement === this.el) document.exitPointerLock();
    this.keys.clear();
  }

  cycleView() {
    this.view = this.view === "first" ? "back" : this.view === "back" ? "front" : "first";
    this.onView?.(this.view);
  }

  private lock = () => {
    if (!this.enabled) return;
    this.el.requestPointerLock?.();
  };
  private down = (e: PointerEvent) => {
    if (!this.enabled || e.button !== 0) return;
    this.dragging = true;
    this.last = { x: e.clientX, y: e.clientY };
  };
  private move = (e: PointerEvent) => {
    if (!this.enabled) return;
    let dx: number, dy: number;
    if (document.pointerLockElement === this.el) {
      dx = e.movementX;
      dy = e.movementY;
    } else {
      if (!this.dragging) return;
      dx = e.clientX - this.last.x;
      dy = e.clientY - this.last.y;
      this.last = { x: e.clientX, y: e.clientY };
    }
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
    if (e.code === "F5") {
      e.preventDefault();
      this.cycleView();
      return;
    }
    if (e.code === "Space") e.preventDefault();
    this.keys.add(e.code);
  };
  private ku = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  // ---------------------------------------------------------------- collision
  /** Top of the block box in cell (x, y, z) if it overlaps [y0, y1]. Unknown cells are solid. */
  private boxTop(x: number, y: number, z: number, y0: number, y1: number): number | null {
    const c = this.grid.at(x, y, z);
    const b = BOX[c === null ? 1 : c];
    if (!b) return null;
    const lo = y + b[0],
      hi = y + b[1];
    return hi > y0 + 1e-4 && lo < y1 - 1e-4 ? hi : null;
  }
  /** Top of the highest box the player's box at `p` overlaps, or null when free. */
  private hit(p: THREE.Vector3, h = this.height): number | null {
    const r = 0.3 - 1e-3;
    let top: number | null = null;
    for (let x = Math.floor(p.x - r); x <= Math.floor(p.x + r); x++)
      for (let z = Math.floor(p.z - r); z <= Math.floor(p.z + r); z++)
        for (let y = Math.floor(p.y) - 1; y <= Math.floor(p.y + h); y++) {
          const t = this.boxTop(x, y, z, p.y, p.y + h);
          if (t !== null && (top === null || t > top)) top = t;
        }
    return top;
  }
  private touching(p: THREE.Vector3, cls: number): boolean {
    const r = 0.3;
    for (let x = Math.floor(p.x - r); x <= Math.floor(p.x + r); x++)
      for (let z = Math.floor(p.z - r); z <= Math.floor(p.z + r); z++)
        for (let y = Math.floor(p.y); y <= Math.floor(p.y + this.height * 0.6); y++) if (this.grid.at(x, y, z) === cls) return true;
    return false;
  }

  // ---------------------------------------------------------------- update
  update(dt: number) {
    if (!this.enabled) return;
    this.grid.update(this.pos);
    if (!this.grid.ready() || this.grid.at(this.pos.x, this.pos.y, this.pos.z) === null) {
      this.place();
      return;
    }
    if (!this.placed) {
      // start out of the ground: rise to the first free spot, then fall onto the floor
      let n = 0;
      while (this.hit(this.pos) !== null && n++ < 40) this.pos.y = Math.floor(this.pos.y) + 1;
      this.placed = true;
    }
    let t = dt;
    while (t > 0) {
      const s = Math.min(t, 1 / 60);
      this.step(s);
      t -= s;
    }
    this.place();
  }

  private step(dt: number) {
    const k = this.keys;
    const f = (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0);
    const sd = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
    const sneak = this.sneaking;
    const sprint = (k.has("ControlLeft") || k.has("ControlRight")) && f > 0 && !sneak;
    const water = this.touching(this.pos, 6) || this.touching(this.pos, 7);
    const ladder = this.touching(this.pos, 8);
    this.inWater = water;
    const speed = sneak ? 1.31 : sprint ? 5.61 : 4.32;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const want = new THREE.Vector3().addScaledVector(fwd, f).addScaledVector(right, sd);
    if (want.lengthSq() > 0) want.normalize().multiplyScalar(water ? speed * 0.45 : speed);
    const grip = this.onGround ? 18 : water ? 6 : 3.2;
    const a = 1 - Math.exp(-dt * grip);
    this.vel.x += (want.x - this.vel.x) * a;
    this.vel.z += (want.z - this.vel.z) * a;

    // vertical
    if (water) {
      this.vel.y -= 4 * dt;
      this.vel.y *= Math.pow(0.4, dt * 4);
      if (k.has("Space")) this.vel.y = Math.min(this.vel.y + 22 * dt, 2.4);
    } else if (ladder) {
      if (f !== 0 || sd !== 0 || k.has("Space")) this.vel.y = 2.35;
      else if (sneak) this.vel.y = 0;
      else this.vel.y = Math.max(this.vel.y - 32 * dt, -2.35);
    } else {
      this.vel.y -= 32 * dt;
      this.vel.y *= Math.pow(0.98, dt * 20);
      if (k.has("Space") && this.onGround) {
        this.vel.y = 8.4;
        if (sprint) this.vel.addScaledVector(fwd, 1.2);
      }
    }

    // move: y first, then x and z, with step-up and auto-jump
    const p = this.pos;
    const wasGround = this.onGround;
    this.onGround = false;
    const dy = this.vel.y * dt;
    p.y += dy;
    const top = this.hit(p);
    if (top !== null) {
      if (dy < 0) {
        p.y = top;
        this.onGround = true;
      } else {
        p.y -= dy;
      }
      this.vel.y = 0;
    }
    const grounded = wasGround || this.onGround;
    for (const axis of ["x", "z"] as const) {
      const d = this.vel[axis] * dt;
      if (Math.abs(d) < 1e-6) continue;
      const before = p[axis];
      p[axis] += d;
      let blocked = this.hit(p) !== null;
      if (blocked && grounded) {
        // step up to 0.6 blocks (slabs, paths, carpets on blocks)
        const t = this.hit(p);
        if (t !== null && t - p.y <= 0.6 + 1e-3) {
          const y0 = p.y;
          p.y = t;
          if (this.hit(p) === null) blocked = false;
          else p.y = y0;
        }
      }
      if (!blocked && sneak && grounded) {
        // sneaking never walks off an edge
        const below = new THREE.Vector3(p.x, p.y - 0.6, p.z);
        if (this.hit(below, 0.6) === null) blocked = true;
      }
      if (blocked) {
        p[axis] = before;
        // auto-jump onto a one-block ledge when walking into it
        if (grounded && !water && f > 0) {
          const up = p.clone();
          up[axis] += Math.sign(d) * 0.35;
          up.y += 1.05;
          if (this.hit(up) === null) this.vel.y = 8.4;
        }
        this.vel[axis] = 0;
      }
    }
    // stick to the ground walking down slabs and stairs instead of hopping
    if (!this.onGround && wasGround && this.vel.y <= 0 && !water) {
      const probe = p.clone();
      probe.y -= 0.55;
      const t3 = this.hit(probe, this.height + 0.55);
      if (t3 !== null && t3 <= p.y + 1e-3) {
        p.y = t3;
        this.onGround = true;
        this.vel.y = 0;
      }
    }
    const hs = Math.hypot(this.vel.x, this.vel.z);
    this.walked += hs * dt;
    if (this.onGround && hs > 0.3) this.bob += hs * dt;
    if (p.y < -200) p.y = 320;
  }

  /** Put the camera (and the body, in third person) where they belong. */
  private place() {
    const eye = new THREE.Vector3(this.pos.x, this.pos.y + this.eye, this.pos.z);
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const bobY = this.view === "first" ? Math.abs(Math.sin(this.bob * Math.PI * 0.62)) * 0.06 * Math.min(1, hs / 4) : 0;
    const look = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    if (this.view === "first") {
      this.cam.position.copy(eye);
      this.cam.position.y += bobY;
      this.cam.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
    } else {
      const dir = this.view === "back" ? look.clone().negate() : look.clone();
      let dist = 4;
      for (let d = 0.2; d <= 4; d += 0.1) {
        const q = eye.clone().addScaledVector(dir, d);
        const c = this.grid.at(q.x, q.y, q.z);
        if (c === 1 || c === null) {
          dist = Math.max(0.3, d - 0.3);
          break;
        }
      }
      this.cam.position.copy(eye).addScaledVector(dir, dist);
      this.cam.lookAt(eye);
    }
    const r = this.rig;
    if (r) {
      r.root.visible = this.view !== "first";
      r.root.position.copy(this.pos);
      if (this.sneaking) r.root.position.y -= 0.12;
      // the body turns towards where you walk, the head towards where you look
      const moveYaw = hs > 0.5 ? Math.atan2(-this.vel.x, -this.vel.z) : this.bodyYaw;
      let diff = moveYaw - this.bodyYaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.bodyYaw += diff * 0.2;
      let hd = this.yaw - this.bodyYaw;
      hd = Math.atan2(Math.sin(hd), Math.cos(hd));
      if (Math.abs(hd) > 0.9) this.bodyYaw = this.yaw - Math.sign(hd) * 0.9;
      r.root.rotation.y = this.bodyYaw + Math.PI;
      r.animate(this.walked * 0.55, Math.min(1, hs / 4.3));
      const head = r.parts.head;
      if (head) {
        let h2 = this.yaw - this.bodyYaw;
        h2 = Math.atan2(Math.sin(h2), Math.cos(h2));
        head.rotation.y = h2;
        head.rotation.x = -this.pitch;
      }
      if (r.parts.body) r.parts.body.rotation.x = this.sneaking ? 0.45 : 0;
    }
  }
}
