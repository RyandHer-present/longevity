import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import {
  Crosshair, Home as HomeIcon, Move3d, Plane, Rotate3d, X, Flag, Eye, EyeOff, Footprints, Moon, Radio, Skull, ChevronLeft, ChevronRight, Users, Disc3, Sparkles, Camera, Layers
} from "lucide-react";
import PackPreview from "./PackPreview";
import { api, DIMS, prettyId, dimName, type EntityInfo, type Place } from "../api";
import { useStore } from "../store";
import { Engine, type Mode } from "../render/engine";
import { SkinViewer } from "../render/skinview";
import { ContainerAnim } from "../render/props3d";
import type { View } from "../render/walker";
import { ItemIcon } from "../ui";
import { sfx } from "../sound";
import { tapi, type Live, type Roster, type ShotTag, type Villager } from "../tools/tapi";
import { api as lapi, thumbUrl } from "../launcher/api";
import { tagOf } from "../launcher/pages/Shots";
import { currentSkin, gearOn } from "../tools/Gear";
import { TradeRow, vTitle } from "../tools/Villagers";

const TIMES: { id: string; label: string; t: number | null }[] = [
  { id: "live", label: "World", t: null },
  { id: "dawn", label: "Dawn", t: 23400 },
  { id: "noon", label: "Noon", t: 6000 },
  { id: "dusk", label: "Dusk", t: 12300 },
  { id: "night", label: "Night", t: 18000 },
];

const VIEW_LABEL: Record<View, string> = { first: "First person", back: "Behind you", front: "In front of you" };

function mobLine(e: EntityInfo): string[] {
  const out: string[] = [];
  if (e.villager?.profession) {
    const p = e.villager.profession.replace("minecraft:", "");
    if (p !== "none") out.push(prettyId(p) + (e.villager.level ? ` · level ${e.villager.level}` : ""));
    else out.push("No profession");
  }
  if (e.villager?.type) out.push(prettyId(e.villager.type) + " villager");
  if (e.variant && !/^\d+$/.test(e.variant)) out.push(prettyId(e.variant) + " variant");
  if (e.baby) out.push("Baby");
  if (e.tamed) out.push("Tamed");
  if (e.sheared) out.push("Sheared");
  if (e.health !== null) out.push(`${Math.round(e.health)} health`);
  return out;
}

// what the backend says is under the mouse (walk.rs `w_ray`)
interface SlotItem {
  slot: number;
  id: string;
  count: number;
  name: string;
  custom: boolean;
  ench: string[];
  inner: number;
}
interface SignSide {
  lines: string[];
  color: string;
  glow: boolean;
}
interface Hit {
  kind: "block" | "toggle" | "container" | "sign" | "book" | "jukebox" | "spawner" | "beacon" | "frame";
  pos: [number, number, number];
  block?: string;
  props?: Record<string, string>;
  name: string;
  title?: string;
  open?: boolean;
  slots?: number;
  items?: SlotItem[];
  anim?: "chest" | "shulker" | "barrel";
  other?: [number, number, number];
  front?: SignSide | null;
  back?: SignSide | null;
  book?: { title: string; author: string; pages: string[] } | null;
  page?: number;
  disc?: { id: string; name: string } | null;
  mob?: { id: string; name: string } | null;
  primary?: string | null;
  secondary?: string | null;
  item?: { id: string; count: number; name: string | null } | null;
  glow?: boolean;
  dist: number;
}
type Panel = { type: "hit"; hit: Hit } | { type: "villager"; v: Villager; names: Record<string, string> };

const SIGN_COLORS: Record<string, string> = {
  black: "#1d1d21", white: "#f9fffe", orange: "#f9801d", magenta: "#c74ebd", light_blue: "#3ab3da", yellow: "#fed83d", lime: "#80c71f", pink: "#f38baa",
  gray: "#474f52", light_gray: "#9d9d97", cyan: "#169c9c", purple: "#8932b8", blue: "#3c44aa", brown: "#835432", green: "#5e7c16", red: "#b02e26",
};

const chunkOf = (p: [number, number, number]): [number, number] => [Math.floor(p[0] / 16), Math.floor(p[2] / 16)];
function chunksAround(ps: [number, number, number][]): [number, number][] {
  // a changed block can change faces in the next chunk too
  const set = new Set<string>();
  for (const p of ps)
    for (const dx of [-1, 0, 1])
      for (const dz of [-1, 0, 1]) set.add(chunkOf([p[0] + dx, p[1], p[2] + dz]).join(","));
  return [...set].map((k) => k.split(",").map(Number) as [number, number]);
}

export default function World3D() {
  const world = useStore((s) => s.world)!;
  const dim = useStore((s) => s.dim);
  const focus = useStore((s) => s.focus);
  const toastMsg = useStore((s) => s.toastMsg);
  const setPage = useStore((s) => s.setPage);
  const tryOn = useStore((s) => s.tryOn);
  const [shotPins, setShotPins] = useState<{ key: string; tag: ShotTag }[]>([]);
  const [shotTip, setShotTip] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([tapi.shotTags(), lapi.shots()])
      .then(([tags, shots]) => setShotPins(shots.map((s) => ({ key: s.key, tag: tagOf(tags, s) })).filter((x): x is { key: string; tag: ShotTag } => !!x.tag && !/_edit\d*\.png$/.test(x.key))))
      .catch(() => {});
  }, []);
  const host = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [mode, setModeS] = useState<Mode>("orbit");
  const [time, setTime] = useState("live");
  const [stats, setStats] = useState({ fps: 0, chunks: 0, pending: 0, quads: 0 });
  const [pos, setPos] = useState<[number, number, number]>([0, 0, 0]);
  const [hover, setHover] = useState<{ e: EntityInfo; x: number; y: number } | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [speed, setSpeed] = useState(12);
  const [mobsOn, setMobsOn] = useState(true);
  const [night, setNight] = useState(false);
  const [view, setView] = useState<View>("first");
  const [panel, setPanel] = useState<Panel | null>(null);
  const packOpen = useStore((s) => s.packPreview);
  const [page, setBookPage] = useState(0);
  const [live, setLive] = useState<Live | null>(null);
  const [follow, setFollow] = useState(false);
  const [deathTip, setDeathTip] = useState<number | null>(null);
  const [aim, setAim] = useState<string | null>(null);
  const opened = useRef<{ anims: ContainerAnim[]; hidden: [number, number, number][]; barrel: [number, number, number] | null } | null>(null);
  const roster = useRef<Roster | null>(null);
  const rightDown = useRef<{ x: number; y: number } | null>(null);
  const followRef = useRef(false);
  const liveRef = useRef<Live | null>(null);
  const outline = useRef<THREE.LineSegments | null>(null);
  const player = world.players[0];
  const [meName, setMeName] = useState("You");

  // ------------------------------------------------------------ engine setup
  useEffect(() => {
    const eng = Engine.get();
    const el = host.current;
    if (el) eng.attach(el);
    eng.setMode("orbit");
    eng.onStats = (s) => {
      setStats(s);
      const p = eng.mode === "walk" ? eng.walker.pos : eng.focusPoint();
      setPos([Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]);
    };
    eng.fly.onSpeed = setSpeed;
    eng.walker.onView = setView;
    const f = useStore.getState().focus;
    if (!f && player) eng.lookAtPoint(player.pos[0], player.pos[1], player.pos[2], 50);
    api.places().then(setPlaces).catch(() => {});
    tapi
      .gear()
      .then((g) => g.player && setMeName(g.player))
      .catch(() => {});

    // your skin and gear, for walk mode's third person and the live marker
    let dead = false;
    const rigs: SkinViewer[] = [];
    const trying = useStore.getState().tryOn;
    (async () => {
      const skin = await currentSkin();
      const gear = await tapi.gear().catch(() => null);
      for (const target of ["walker", "live"] as const) {
        const sv = new SkinViewer(null);
        // "Try on in your base": the walker wears the closet skin; the live marker stays you
        const use = target === "walker" && trying ? trying : skin;
        await sv.load(use.url, use.slim);
        if (gear?.equipped) await sv.setGear(gearOn(gear.equipped));
        if (dead) {
          sv.dispose();
          return;
        }
        rigs.push(sv);
        if (target === "walker") eng.walker.setRig(sv);
        else eng.live.setRig(sv);
      }
      if (trying && !dead) {
        // stand in your base and turn around to face the camera
        setTimeout(() => {
          if (dead) return;
          switchMode("walk");
          const w = Engine.get().walker;
          w.view = "front";
          w.onView?.("front");
        }, 900);
      }
    })().catch(() => {});

    return () => {
      dead = true;
      useStore.setState({ tryOn: null });
      eng.onStats = null;
      eng.fly.onSpeed = null;
      eng.walker.onView = null;
      eng.timeOverride = null;
      eng.mobs.enabled = true;
      eng.nightVision = false;
      eng.setMode("orbit");
      eng.walker.setRig(null);
      eng.live.setRig(null);
      eng.live.set(null, "", 0);
      for (const r of rigs) r.dispose();
      for (const a of eng.anims) a.dispose();
      eng.anims.clear();
      if (outline.current) eng.scene.remove(outline.current);
      // put every opened door and hidden chest back
      invoke<[number, number, number][]>("w_clear")
        .then((ps) => {
          if (ps.length) eng.chunks.refreshChunks(chunksAround(ps));
        })
        .catch(() => {});
      eng.detach(el);
    };
  }, []);

  useEffect(() => {
    if (!focus) return;
    const eng = Engine.get();
    if (eng.mode !== "orbit") {
      eng.setMode("orbit");
      setModeS("orbit");
    }
    eng.lookAtPoint(focus.x, focus.y, focus.z, 46);
  }, [focus?.n]);

  useEffect(() => {
    Engine.get().timeOverride = TIMES.find((t) => t.id === time)?.t ?? null;
  }, [time]);
  useEffect(() => {
    Engine.get().mobs.enabled = mobsOn;
  }, [mobsOn]);
  useEffect(() => {
    Engine.get().nightVision = night;
  }, [night]);
  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  // ------------------------------------------------------------ live link (companion mod)
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const l = await tapi.live().catch(() => null);
      if (stop) return;
      const fresh = l && l.fresh && l.pos ? l : null;
      liveRef.current = fresh;
      setLive(fresh);
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().replace("#", "");
      const accent = parseInt(raw.length === 6 ? raw : "e8a24a", 16);
      Engine.get().live.set(
        fresh ? { dim: fresh.dim ?? "minecraft:overworld", pos: fresh.pos!, yaw: fresh.yaw ?? 0, pitch: fresh.pitch ?? 0, trail: fresh.trail ?? [] } : null,
        useStore.getState().dim,
        isNaN(accent) ? 0xe8a24a : accent,
      );
      if (!fresh) setFollow(false);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [dim]);

  // place the HTML markers (your name, death spots) and run the follow camera every frame
  useEffect(() => {
    let raf = 0;
    let last: THREE.Vector3 | null = null;
    const v = new THREE.Vector3();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const eng = Engine.get();
      const box = host.current?.getBoundingClientRect();
      const ov = overlay.current;
      if (!box || !ov) return;
      const lv = eng.live;
      // follow cam: carry the orbit along with you
      if (followRef.current && lv.has && eng.mode === "orbit") {
        if (last) {
          const d = lv.shown.clone().sub(last);
          eng.orbit.target.add(d);
          eng.camera.position.add(d);
        } else eng.lookAtPoint(lv.shown.x, lv.shown.y, lv.shown.z, 30);
        last = lv.shown.clone();
      } else last = null;
      for (const node of Array.from(ov.children) as HTMLElement[]) {
        let p: number[] | undefined = node.dataset.p?.split(",").map(Number);
        if (node.dataset.kind === "me") p = lv.has && lv.group.visible ? [lv.shown.x, lv.shown.y + 2.3, lv.shown.z] : undefined;
        if (!p) {
          node.style.display = "none";
          continue;
        }
        v.set(p[0], p[1], p[2]).project(eng.camera);
        const dist = eng.camera.position.distanceTo(new THREE.Vector3(p[0], p[1], p[2]));
        if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1 || dist > 600) {
          node.style.display = "none";
          continue;
        }
        node.style.display = "";
        node.style.transform = `translate(${((v.x + 1) / 2) * box.width}px, ${((1 - v.y) / 2) * box.height}px) translate(-50%, -100%)`;
        node.style.opacity = String(Math.max(0.35, 1 - dist / 600));
      }
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);

  // ------------------------------------------------------------ keys
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const a = document.activeElement as HTMLElement | null;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
    if (e.code === "KeyF") switchMode(Engine.get().mode === "fly" ? "orbit" : "fly");
    if (e.code === "KeyV") switchMode(Engine.get().mode === "walk" ? "orbit" : "walk");
    if (e.code === "KeyN") setNight((n) => !n);
    if (e.code === "KeyE" && Engine.get().mode === "walk") {
      if (panel) closePanel();
      else useAt(null);
    }
    if (e.code === "Escape") closePanel();
  };
  useEffect(() => {
    const kd = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", kd);
    return () => window.removeEventListener("keydown", kd);
  }, []);

  // walk mode: outline the block you're aiming at, like in game
  useEffect(() => {
    const eng = Engine.get();
    if (mode !== "walk") {
      setAim(null);
      if (outline.current) outline.current.visible = false;
      return;
    }
    let busy = false;
    const t = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const h = await rayAt(null, 5);
        if (!outline.current) {
          const g = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004));
          outline.current = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 }));
          eng.scene.add(outline.current);
        }
        const o = outline.current;
        o.visible = !!h && eng.walker.view === "first";
        if (h) o.position.set(h.pos[0] + 0.5, h.pos[1] + 0.5, h.pos[2] + 0.5);
        setAim(h && h.kind !== "block" ? (h.title ?? h.name) : null);
      } finally {
        busy = false;
      }
    }, 120);
    return () => clearInterval(t);
  }, [mode]);

  function switchMode(m: Mode) {
    sfx.click();
    const eng = Engine.get();
    if (m === "walk" && eng.mode !== "walk") {
      // stand where you were looking (orbit) or right under the camera (fly)
      const p = eng.mode === "orbit" ? eng.orbit.target.clone() : eng.camera.position.clone().add(new THREE.Vector3(0, -1.62, 0));
      const lv = liveRef.current;
      if (eng.mode === "orbit" && followRef.current && lv?.pos) p.set(lv.pos[0], lv.pos[1], lv.pos[2]);
      eng.walker.enter(p.x, p.y + 0.5, p.z, useStore.getState().dim);
      setFollow(false);
    }
    if (eng.mode === "walk" && m !== "walk") {
      // leave the camera where you stood, a bit back and up
      const w = eng.walker;
      eng.camera.position.set(w.pos.x + Math.sin(w.yaw) * 10, w.pos.y + 8, w.pos.z + Math.cos(w.yaw) * 10);
      eng.camera.lookAt(w.pos);
      eng.orbit.target.copy(w.pos);
    }
    eng.setMode(m);
    setModeS(m);
  }

  function changeDim(d: string) {
    if (d === dim) return;
    sfx.click();
    closePanel();
    const eng = Engine.get();
    if (eng.mode === "walk") switchMode("orbit");
    useStore.setState({ dim: d });
    const p = player && player.dim === d ? player.pos : d.includes("nether") ? [0, 70, 0] : d.includes("end") ? [0, 64, 0] : (world.spawn ?? [0, 64, 0]);
    setTimeout(() => eng.lookAtPoint(p[0], p[1], p[2], 50), 50);
  }

  function go(x: number, y: number, z: number) {
    sfx.click();
    const eng = Engine.get();
    setFollow(false);
    if (eng.mode === "fly") {
      eng.camera.position.set(x + 0.5, y + 2, z + 0.5);
      eng.fly.syncFromCamera();
    } else if (eng.mode === "walk") eng.walker.enter(x + 0.5, y + 0.5, z + 0.5, useStore.getState().dim);
    else eng.lookAtPoint(x, y, z, 44);
  }

  // ------------------------------------------------------------ using things
  /** Ray from the camera through a screen point (null = screen centre). */
  async function rayAt(pt: { x: number; y: number } | null, max: number): Promise<Hit | null> {
    const eng = Engine.get();
    const r = host.current!.getBoundingClientRect();
    const ndc = pt ? new THREE.Vector2(((pt.x - r.left) / r.width) * 2 - 1, -((pt.y - r.top) / r.height) * 2 + 1) : new THREE.Vector2(0, 0);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, eng.camera);
    let o = rc.ray.origin.clone();
    let d = rc.ray.direction.clone();
    // in third person, aim from your eyes rather than from the camera behind you
    if (eng.mode === "walk" && eng.walker.view !== "first") {
      o = eng.walker.pos.clone().add(new THREE.Vector3(0, eng.walker.eye, 0));
      const w = eng.walker;
      d = new THREE.Vector3(-Math.sin(w.yaw) * Math.cos(w.pitch), Math.sin(w.pitch), -Math.cos(w.yaw) * Math.cos(w.pitch));
    }
    return invoke<Hit | null>("w_ray", { dim: useStore.getState().dim, o: [o.x, o.y, o.z], d: [d.x, d.y, d.z], max }).catch(() => null);
  }

  async function useAt(pt: { x: number; y: number } | null) {
    const eng = Engine.get();
    const walk = eng.mode === "walk";
    const locked = document.pointerLockElement === eng.canvas;
    const at = locked ? null : pt;
    // a villager under the mouse comes first
    if (at) {
      const mob = eng.pick(at.x, at.y);
      if (mob && (mob.id.endsWith("villager") || mob.id.endsWith("wandering_trader"))) return openVillager(mob);
    }
    const h = await rayAt(at, walk ? 6 : 400);
    if (!h) return;
    if (h.kind === "toggle") return toggle(h);
    if (h.kind === "block") {
      setAim(h.name);
      setTimeout(() => setAim(null), 1200);
      return;
    }
    await closePanel();
    setBookPage(h.page ?? 0);
    if (h.kind === "container") await openContainer(h);
    else sfx.open();
    setPanel({ type: "hit", hit: h });
  }

  async function toggle(h: Hit) {
    const eng = Engine.get();
    const d = useStore.getState().dim;
    const r = await invoke<{ open: boolean; changed: [number, number, number][] }>("w_toggle", { dim: d, x: h.pos[0], y: h.pos[1], z: h.pos[2] }).catch(() => null);
    if (!r) return;
    sfx.toggle(r.open);
    await eng.chunks.refreshChunks(chunksAround(r.changed));
    eng.walker.grid.refresh(eng.walker.pos);
  }

  async function openContainer(h: Hit) {
    const eng = Engine.get();
    const d = useStore.getState().dim;
    if (h.anim === "barrel") {
      const r = await invoke<{ changed: [number, number, number][] }>("w_toggle", { dim: d, x: h.pos[0], y: h.pos[1], z: h.pos[2] }).catch(() => null);
      sfx.open();
      if (r) eng.chunks.refreshChunks(chunksAround(r.changed));
      opened.current = { anims: [], hidden: [], barrel: h.pos };
      return;
    }
    if (h.anim !== "chest" && h.anim !== "shulker") {
      sfx.open();
      return;
    }
    // build the moving model(s), swap the real block(s) out, then lift the lid
    const parts: { pos: [number, number, number]; props: Record<string, string> }[] = [{ pos: h.pos, props: h.props ?? {} }];
    if (h.other) parts.push({ pos: h.other, props: { ...(h.props ?? {}), type: h.props?.type === "left" ? "right" : "left" } });
    const anims = (await Promise.all(parts.map((p) => ContainerAnim.make(h.block ?? "", p.props, p.pos)))).filter((a): a is ContainerAnim => !!a);
    if (!anims.length) {
      sfx.open();
      return;
    }
    for (const a of anims) {
      eng.scene.add(a.group);
      eng.anims.add(a);
    }
    const hidden = parts.map((p) => p.pos);
    await invoke("w_hide", { dim: d, at: hidden, hide: true }).catch(() => {});
    await eng.chunks.refreshChunks(chunksAround(hidden));
    for (const a of anims) a.target = 1;
    sfx.open();
    opened.current = { anims, hidden, barrel: null };
  }

  async function closePanel() {
    const o = opened.current;
    opened.current = null;
    setPanel(null);
    if (!o) return;
    const eng = Engine.get();
    const d = useStore.getState().dim;
    sfx.close();
    if (o.barrel) {
      const r = await invoke<{ changed: [number, number, number][] }>("w_toggle", { dim: d, x: o.barrel[0], y: o.barrel[1], z: o.barrel[2] }).catch(() => null);
      if (r) eng.chunks.refreshChunks(chunksAround(r.changed));
      return;
    }
    await Promise.all(
      o.anims.map(
        (a) =>
          new Promise<void>((res) => {
            a.target = 0;
            a.onClosed = res;
            setTimeout(res, 900);
          }),
      ),
    );
    await invoke("w_hide", { dim: d, at: o.hidden, hide: false }).catch(() => {});
    await eng.chunks.refreshChunks(chunksAround(o.hidden));
    for (const a of o.anims) {
      eng.anims.delete(a);
      a.dispose();
    }
  }

  async function openVillager(mob: EntityInfo) {
    if (!roster.current) roster.current = await tapi.villagers().catch(() => null);
    const r = roster.current;
    if (!r) return;
    let best: Villager | null = null;
    let bd = 3;
    for (const v of r.villagers) {
      if (v.dim !== useStore.getState().dim) continue;
      const d = Math.hypot(v.pos[0] - mob.pos[0], v.pos[1] - mob.pos[1], v.pos[2] - mob.pos[2]);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    if (!best) {
      toastMsg("Couldn't find this villager's trades.");
      return;
    }
    await closePanel();
    sfx.open();
    setPanel({ type: "villager", v: best, names: r.names });
  }

  const dims = DIMS.filter((d) => (world.dims.find((x) => x.id === d.id)?.regions ?? 0) > 0);
  const home = places.find((p) => p.kind === "home" && p.dim === dim);
  const liveHere = live && live.dim === dim ? live : null;
  const deaths = (live?.deaths ?? []).filter((d) => d.dim === dim);
  const shotsHere = shotPins.filter((p) => p.tag.dim === dim);
  const me = liveHere?.pos ?? (player && player.dim === dim ? player.pos : null);

  return (
    <div className="w3d">
      <div
        className={"w3d-canvas" + (mode === "walk" ? " walking" : "")}
        ref={host}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (e.button === 2) rightDown.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          if (e.button !== 2 || !rightDown.current) return;
          const moved = Math.hypot(e.clientX - rightDown.current.x, e.clientY - rightDown.current.y);
          rightDown.current = null;
          if (moved < 5) useAt({ x: e.clientX, y: e.clientY });
        }}
        onMouseMove={(e) => {
          if (e.buttons || mode === "walk") return;
          const info = Engine.get().pick(e.clientX, e.clientY);
          setHover(info ? { e: info, x: e.clientX, y: e.clientY } : null);
        }}
        onMouseLeave={() => setHover(null)}
      />

      {/* markers that follow points in the world */}
      <div className="w3d-overlay" ref={overlay}>
        <div className="w3d-me" data-kind="me">
          {meName}
        </div>
        {shotsHere.map((p) => (
          <button
            key={p.key}
            className="w3d-shot"
            data-p={`${p.tag.pos[0] + 0.5},${p.tag.pos[1] + 2.2},${p.tag.pos[2] + 0.5}`}
            onMouseEnter={() => setShotTip(p.key)}
            onMouseLeave={() => setShotTip(null)}
            onClick={() => {
              sfx.nav();
              useStore.setState({ openShot: p.key });
              setPage("shots");
            }}
          >
            <Camera size={12} />
            {shotTip === p.key && (
              <div className="w3d-shot-tip">
                <img src={thumbUrl(p.key, 320)} alt="" />
                <span>
                  Day {p.tag.day} · {new Date(p.tag.t).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · click to open
                </span>
              </div>
            )}
          </button>
        ))}
        {deaths.map((d, i) => (
          <button
            key={d.t}
            className="w3d-death"
            data-p={`${d.pos[0] + 0.5},${d.pos[1] + 1.2},${d.pos[2] + 0.5}`}
            onMouseEnter={() => setDeathTip(i)}
            onMouseLeave={() => setDeathTip(null)}
            onClick={() => go(d.pos[0], d.pos[1], d.pos[2])}
          >
            <Skull size={13} />
            {deathTip === i && (
              <div className="w3d-death-tip">
                <b>{d.cause}</b>
                <span>
                  {new Date(d.t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · {Math.floor(d.pos[0])}, {Math.floor(d.pos[1])}, {Math.floor(d.pos[2])}
                </span>
                {d.drops.length > 0 && (
                  <div className="w3d-drops">
                    {d.drops.slice(0, 18).map(([id, n], j) => (
                      <span key={j} title={`${prettyId(id)} ×${n}`}>
                        <ItemIcon id={id} size={18} />
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </button>
        ))}
      </div>

      {mode === "walk" && view === "first" && <div className="w3d-cross" />}
      {aim && <div className="w3d-aim">{aim}</div>}

      <div className="w3d-top glass">
        <div className="seg">
          <button className={mode === "orbit" ? "on" : ""} onClick={() => switchMode("orbit")} title="Orbit around a point">
            <Rotate3d /> Orbit
          </button>
          <button className={mode === "fly" ? "on" : ""} onClick={() => switchMode("fly")} title="Fly freely (F)">
            <Plane /> Fly
          </button>
          <button className={mode === "walk" ? "on" : ""} onClick={() => switchMode("walk")} title="Walk around like in game (V)">
            <Footprints /> Walk
          </button>
        </div>
        {dims.length > 1 && (
          <div className="seg">
            {dims.map((d) => (
              <button key={d.id} className={dim === d.id ? "on" : ""} onClick={() => changeDim(d.id)}>
                {d.name.replace("The ", "")}
              </button>
            ))}
          </div>
        )}
        <div className="seg">
          {TIMES.map((t) => (
            <button key={t.id} className={time === t.id ? "on" : ""} onClick={() => setTime(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {live && (
          <button className={"w3d-live" + (follow ? " on" : "")} onClick={() => liveHere && setFollow(!follow)} title={liveHere ? (follow ? "Stop following" : "Follow yourself as you play") : "You're playing in another dimension"}>
            <Radio size={13} /> Live{liveHere ? (follow ? " · following" : " · follow") : ` in ${dimName(live.dim ?? "")}`}
          </button>
        )}
      </div>
      {tryOn && (
        <div className="w3d-tryon glass">
          <span>
            Trying on <b>{tryOn.name}</b> · F5 to turn around
          </span>
          <button className="btn sm" onClick={() => (sfx.nav(), setPage("skins"))}>
            Back to Skins
          </button>
          <button
            className="btn sm ghost"
            onClick={async () => {
              sfx.click();
              useStore.setState({ tryOn: null });
              const me = await currentSkin();
              const rig = Engine.get().walker.rig as SkinViewer | null;
              if (rig) await rig.load(me.url, me.slim);
              const g = await tapi.gear().catch(() => null);
              if (rig && g?.equipped) await rig.setGear(gearOn(g.equipped));
            }}
          >
            Done
          </button>
        </div>
      )}
      <div className="w3d-right glass">
        {me && (
          <button className="iconbtn" title={liveHere ? "Go to where you are now" : "Go to where you are"} onClick={() => go(me[0], me[1], me[2])}>
            <Crosshair />
          </button>
        )}
        {home && (
          <button className="iconbtn" title={`Go home${home.name ? ` (${home.name})` : ""}`} onClick={() => go(home.center[0], home.center[1], home.center[2])}>
            <HomeIcon />
          </button>
        )}
        {world.spawn && dim === "minecraft:overworld" && (
          <button className="iconbtn" title="Go to world spawn" onClick={() => go(world.spawn![0], world.spawn![1], world.spawn![2])}>
            <Flag />
          </button>
        )}
        <button className="iconbtn" title={mobsOn ? "Hide mobs" : "Show mobs"} onClick={() => setMobsOn(!mobsOn)}>
          {mobsOn ? <Eye /> : <EyeOff />}
        </button>
        <button className={"iconbtn" + (night ? " on" : "")} title="Night vision (N)" onClick={() => setNight(!night)}>
          <Moon />
        </button>
        <button
          className={"iconbtn" + (packOpen ? " on" : "")}
          title="Try a resource pack on your base"
          onClick={() => {
            sfx.click();
            setPanel(null);
            useStore.setState({ packPreview: !packOpen });
          }}
        >
          <Layers />
        </button>
      </div>
      <div className="w3d-bottom">
        <div className="coords big">
          X {pos[0]} · Y {pos[1]} · Z {pos[2]}
        </div>
        <div className="w3d-meta">
          {stats.fps} fps · {stats.chunks} chunks{stats.pending ? ` · loading ${stats.pending}` : ""}
          {Engine.get().gameMode ? " · light while you play" : ""}
          {mode === "walk" ? ` · ${VIEW_LABEL[view]}` : ""}
        </div>
      </div>
      <div className="w3d-help">
        {mode === "fly" ? (
          <>
            <span className="kbd">W</span>
            <span className="kbd">A</span>
            <span className="kbd">S</span>
            <span className="kbd">D</span> move · <span className="kbd">Space</span>/<span className="kbd">Shift</span> up/down · <span className="kbd">Ctrl</span> fast · drag to look · wheel speed{" "}
            <b>{Math.round(speed)}</b> · right-click to open
          </>
        ) : mode === "walk" ? (
          <>
            <span className="kbd">WASD</span> walk · <span className="kbd">Space</span> jump · <span className="kbd">Ctrl</span> sprint · <span className="kbd">Shift</span> sneak · <span className="kbd">F5</span> view · right-click or{" "}
            <span className="kbd">E</span> use · double-click to grab the mouse
          </>
        ) : (
          <>
            drag to orbit · right-drag to pan · right-click a chest, door or sign · <span className="kbd">F</span> fly · <span className="kbd">V</span> walk · <span className="kbd">N</span> night vision
          </>
        )}
      </div>
      {!panel && !packOpen && places.filter((p) => p.dim === dim && !p.hidden && p.name).length > 0 && (
        <div className="w3d-places glass">
          <div className="pixlabel" style={{ padding: "2px 4px 6px" }}>
            Places
          </div>
          {places
            .filter((p) => p.dim === dim && !p.hidden && p.name)
            .slice(0, 8)
            .map((p) => (
              <button key={p.id} className="w3d-place" onClick={() => go(p.center[0], p.center[1], p.center[2])}>
                <Move3d size={12} /> {p.name}
              </button>
            ))}
        </div>
      )}

      <AnimatePresence>
        {panel && (
          <motion.div
            className="w3d-panel glass"
            key={panel.type === "hit" ? panel.hit.pos.join() : panel.v.uuid}
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 30 }}
          >
            <button className="iconbtn w3d-panel-x" onClick={closePanel} title="Close (Esc)">
              <X size={14} />
            </button>
            {panel.type === "villager" ? (
              <VillagerPanel
                v={panel.v}
                names={panel.names}
                onRoster={() => {
                  useStore.setState({ toolFocus: { page: "villagers", id: panel.v.uuid, n: Date.now() } });
                  setPage("villagers");
                }}
              />
            ) : (
              <HitPanel hit={panel.hit} page={page} setPage={setBookPage} />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {hover && !panel && mode !== "walk" && (
        <div className="mobtip" style={{ left: hover.x + 16, top: hover.y + 10 }}>
          <div className="mt-name">{hover.e.name || hover.e.display}</div>
          {hover.e.name && <div className="mt-kind">{hover.e.display}</div>}
          {mobLine(hover.e).map((l) => (
            <div key={l} className="mt-l">
              {l}
            </div>
          ))}
          {(hover.e.id.endsWith("villager") || hover.e.id.endsWith("wandering_trader")) && <div className="mt-l mt-hint">Right-click for trades</div>}
          <div className="coords" style={{ marginTop: 4 }}>
            {Math.floor(hover.e.pos[0])} {Math.floor(hover.e.pos[1])} {Math.floor(hover.e.pos[2])}
          </div>
        </div>
      )}
      <PackPreview
        open={packOpen}
        panelHidden={!!panel}
        onClose={() => useStore.setState({ packPreview: false })}
        time={time}
        setTime={setTime}
        mode={mode}
        switchMode={switchMode}
        view={view}
        host={host}
      />
    </div>
  );
}

// ------------------------------------------------------------ panels

function Head({ icon, title, sub }: { icon?: string; title: string; sub?: string }) {
  return (
    <div className="wp-head">
      {icon && <ItemIcon id={icon} size={30} />}
      <div>
        <b>{title}</b>
        {sub && <div className="muted small">{sub}</div>}
      </div>
    </div>
  );
}

function HitPanel({ hit, page, setPage }: { hit: Hit; page: number; setPage: (n: number) => void }) {
  const where = `${hit.pos[0]}, ${hit.pos[1]}, ${hit.pos[2]}`;
  if (hit.kind === "container") {
    const n = hit.slots ?? 27;
    const cols = n === 5 ? 5 : n === 3 ? 3 : n === 1 ? 1 : n === 4 ? 4 : n === 6 ? 3 : 9;
    const items = hit.items ?? [];
    const bySlot = new Map(items.map((it) => [it.slot, it]));
    const total = items.reduce((a, it) => a + it.count, 0);
    return (
      <>
        <Head icon={hit.block} title={hit.title ?? (n === 54 ? "Large " + hit.name : hit.name)} sub={`${where} · ${items.length} of ${n} slots · ${total.toLocaleString()} items`} />
        <div className="wp-slots" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {Array.from({ length: n }, (_, i) => {
            const it = bySlot.get(i);
            return (
              <div
                key={i}
                className={"wp-slot" + (it?.ench.length ? " ench" : "")}
                title={it ? `${it.name}${it.count > 1 ? ` ×${it.count}` : ""}${it.ench.length ? "\n" + it.ench.join(", ") : ""}${it.inner ? `\nHolds ${it.inner} stacks` : ""}` : ""}
              >
                {it && <ItemIcon id={it.id} size={26} />}
                {it && it.count > 1 && <i>{it.count}</i>}
              </div>
            );
          })}
        </div>
        {items.length === 0 && (
          <div className="muted small" style={{ marginTop: 8 }}>
            Empty.
          </div>
        )}
      </>
    );
  }
  if (hit.kind === "sign") {
    const side = (s: SignSide | null | undefined, label: string) =>
      s && s.lines.some((l) => l.trim()) ? (
        <div className="wp-sign-wrap">
          <div className="kicker">{label}</div>
          <div className={"wp-sign" + (s.glow ? " glow" : "")} style={{ color: SIGN_COLORS[s.color] ?? "#1d1d21" }}>
            {s.lines.map((l, i) => (
              <div key={i}>{l || " "}</div>
            ))}
          </div>
        </div>
      ) : null;
    const front = side(hit.front, "Front");
    const back = side(hit.back, "Back");
    const icon = hit.block?.replace("_wall_hanging_sign", "_hanging_sign").replace("_wall_sign", "_sign");
    return (
      <>
        <Head icon={icon} title={hit.name} sub={where} />
        {front}
        {back}
        {!front && !back && <div className="muted small">Nothing written on it.</div>}
      </>
    );
  }
  if (hit.kind === "book") {
    const b = hit.book;
    if (!b) return <Head icon="minecraft:lectern" title="Lectern" sub={`${where} · no book on it`} />;
    const pages = b.pages.length ? b.pages : [""];
    const p = Math.min(page, pages.length - 1);
    return (
      <>
        <Head icon="minecraft:written_book" title={b.title || "Book"} sub={(b.author ? `by ${b.author} · ` : "") + where} />
        <div className="wp-book">
          <div className="wp-page">{pages[p] || <span className="muted">(blank page)</span>}</div>
          <div className="wp-book-nav">
            <button className="iconbtn" disabled={p === 0} onClick={() => setPage(p - 1)}>
              <ChevronLeft size={15} />
            </button>
            <span className="muted small">
              Page {p + 1} of {pages.length}
            </span>
            <button className="iconbtn" disabled={p >= pages.length - 1} onClick={() => setPage(p + 1)}>
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
      </>
    );
  }
  if (hit.kind === "jukebox")
    return (
      <>
        <Head icon="minecraft:jukebox" title="Jukebox" sub={where} />
        <div className="wp-one">
          {hit.disc ? (
            <>
              <ItemIcon id={hit.disc.id} size={40} />
              <div>
                <Disc3 size={12} /> {hit.disc.name}
              </div>
            </>
          ) : (
            <span className="muted">No disc in it.</span>
          )}
        </div>
      </>
    );
  if (hit.kind === "spawner")
    return (
      <>
        <Head icon="minecraft:spawner" title={hit.name} sub={where} />
        <div className="wp-one">
          {hit.mob ? (
            <>
              <ItemIcon id={hit.mob.id + "_spawn_egg"} size={40} />
              <div>Spawns {hit.mob.name}</div>
            </>
          ) : (
            <span className="muted">Empty spawner.</span>
          )}
        </div>
      </>
    );
  if (hit.kind === "beacon")
    return (
      <>
        <Head icon="minecraft:beacon" title={hit.title ?? "Beacon"} sub={where} />
        <div className="wp-one">
          <Sparkles size={14} />
          <div>
            {hit.primary ? prettyId(hit.primary) : "No power picked"}
            {hit.secondary && hit.secondary !== hit.primary ? ` + ${prettyId(hit.secondary)}` : hit.secondary ? " II" : ""}
          </div>
        </div>
      </>
    );
  if (hit.kind === "frame")
    return (
      <>
        <Head icon={hit.glow ? "minecraft:glow_item_frame" : "minecraft:item_frame"} title={hit.glow ? "Glow Item Frame" : "Item Frame"} sub={where} />
        <div className="wp-one">
          {hit.item ? (
            <>
              <ItemIcon id={hit.item.id} size={44} />
              <div>{hit.item.name ?? prettyId(hit.item.id)}</div>
            </>
          ) : (
            <span className="muted">Empty frame.</span>
          )}
        </div>
      </>
    );
  return <Head icon={hit.block} title={hit.name} sub={where} />;
}

function VillagerPanel({ v, names, onRoster }: { v: Villager; names: Record<string, string>; onRoster: () => void }) {
  return (
    <>
      <Head
        icon={v.kind === "wandering_trader" ? "minecraft:wandering_trader_spawn_egg" : "minecraft:villager_spawn_egg"}
        title={vTitle(v)}
        sub={`${Math.floor(v.pos[0])}, ${Math.floor(v.pos[1])}, ${Math.floor(v.pos[2])}${v.cured ? " · cured" : ""}`}
      />
      <div className="wp-trades">{v.offers.length === 0 ? <div className="muted small">No trades yet.</div> : v.offers.map((o, i) => <TradeRow key={i} o={o} names={names} cured={v.cured} />)}</div>
      <button className="btn sm" onClick={onRoster} style={{ marginTop: 10 }}>
        <Users size={13} /> Open in Villager Roster
      </button>
    </>
  );
}
