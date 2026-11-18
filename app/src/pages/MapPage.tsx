import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Crosshair, Flame, Grid3x3, Home as HomeIcon, Layers, Minus, Plus, Tag, MapPin } from "lucide-react";
import { api, blockTex, DIMS, prettyId, tileUrl, type GameEvent, type Place, type Structure } from "../api";
import { useStore, seenSet } from "../store";
import { sfx } from "../sound";

const STRUCT_ICON: [RegExp, string, string][] = [
  [/village_desert/, "desert_village", "Desert village"],
  [/village_savanna/, "savanna_village", "Savanna village"],
  [/village_snowy/, "snowy_village", "Snowy village"],
  [/village_taiga/, "taiga_village", "Taiga village"],
  [/village/, "plains_village", "Village"],
  [/desert_pyramid/, "desert_pyramid", "Desert temple"],
  [/jungle_pyramid/, "jungle_temple", "Jungle temple"],
  [/swamp_hut/, "swamp_hut", "Witch hut"],
  [/mansion/, "woodland_mansion", "Woodland mansion"],
  [/monument/, "ocean_monument", "Ocean monument"],
  [/trial_chambers/, "trial_chambers", "Trial chambers"],
  [/ocean_ruin/, "warm_ocean_ruins", "Ocean ruins"],
  [/ancient_city/, "ancient_city", "Ancient city"],
  [/pillager_outpost/, "red_banner", "Pillager outpost"],
  [/ruined_portal/, "purple_banner", "Ruined portal"],
  [/shipwreck/, "blue_marker", "Shipwreck"],
  [/igloo/, "white_banner", "Igloo"],
  [/trail_ruins/, "brown_banner", "Trail ruins"],
  [/stronghold/, "target_x", "Stronghold"],
  [/fortress/, "red_marker", "Nether fortress"],
  [/bastion/, "black_banner", "Bastion remnant"],
  [/end_city/, "magenta_banner", "End city"],
];
const SKIP_STRUCT = /mineshaft|buried_treasure|nether_fossil|ocean_ruin_cold_small/;

function structInfo(id: string): [string, string] | null {
  if (SKIP_STRUCT.test(id)) return null;
  for (const [re, icon, name] of STRUCT_ICON) if (re.test(id)) return [icon, name];
  return null;
}

interface Marker {
  x: number;
  z: number;
  icon: string;
  label: string;
  sub?: string;
  kind: "player" | "spawn" | "death" | "place" | "structure" | "respawn";
  rot?: number;
  y?: number;
  place?: Place;
}

const imgCache = new Map<string, HTMLImageElement>();
function sprite(name: string): HTMLImageElement {
  let i = imgCache.get(name);
  if (!i) {
    i = new Image();
    i.src = blockTex(`map/decorations/${name}`);
    imgCache.set(name, i);
  }
  return i;
}

export default function MapPage() {
  const world = useStore((s) => s.world)!;
  const dim = useStore((s) => s.dim);
  const explored = useStore((s) => s.explored[dim]);
  const changed = useStore((s) => s.changed);
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const flyTo = useStore((s) => s.flyTo);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const player = world.players[0];
  const [style, setStyle] = useState<"color" | "parchment">((settings?.map_style as "color" | "parchment") || "color");
  const [heat, setHeat] = useState(false);
  const [grid, setGrid] = useState(false);
  const [labels, setLabels] = useState(true);
  const [places, setPlaces] = useState<Place[]>([]);
  const [deaths, setDeaths] = useState<GameEvent[]>([]);
  const [hoverPos, setHoverPos] = useState<[number, number] | null>(null);
  const [sel, setSel] = useState<{ m: Marker; sx: number; sy: number } | null>(null);
  const view = useRef({ cx: player && player.dim === dim ? player.pos[0] : 0, cz: player && player.dim === dim ? player.pos[2] : 0, zoom: 1 });
  const tileV = useRef<Record<string, number>>({});
  const dirty = useRef(true);
  const markersRef = useRef<Marker[]>([]);

  const seen = useMemo(() => seenSet(explored), [explored]);
  const regions = useMemo(() => {
    const s = new Set<string>();
    for (const k of seen) {
      const [x, z] = k.split(",").map(Number);
      s.add(`${x >> 5},${z >> 5}`);
    }
    return s;
  }, [seen]);

  useEffect(() => {
    api.places().then(setPlaces).catch(() => {});
    api
      .timeline()
      .then((t) => setDeaths(t.events.filter((e) => e.kind === "death" && e.pos)))
      .catch(() => {});
  }, [world.path]);

  // recentre when the dimension changes
  useEffect(() => {
    if (player && player.dim === dim) {
      view.current.cx = player.pos[0];
      view.current.cz = player.pos[2];
    } else {
      view.current.cx = 0;
      view.current.cz = 0;
    }
    dirty.current = true;
  }, [dim]);

  useEffect(() => {
    if (changed && changed.dim === dim) {
      for (const [x, z] of changed.regions) tileV.current[`${x},${z}`] = Date.now();
      dirty.current = true;
    }
  }, [changed?.n]);

  // heat canvas: one pixel per visited chunk
  const heatCanvas = useMemo(() => {
    if (!explored || !explored.visited.length) return null;
    const v = explored.visited;
    let x0 = Infinity,
      z0 = Infinity,
      x1 = -Infinity,
      z1 = -Infinity,
      max = 1;
    for (let i = 0; i < v.length; i += 3) {
      x0 = Math.min(x0, v[i]);
      z0 = Math.min(z0, v[i + 1]);
      x1 = Math.max(x1, v[i]);
      z1 = Math.max(z1, v[i + 1]);
      max = Math.max(max, v[i + 2]);
    }
    const w = x1 - x0 + 1,
      h = z1 - z0 + 1;
    if (w * h > 4096 * 4096) return null;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d")!;
    const img = g.createImageData(w, h);
    const lmax = Math.log(1 + max);
    for (let i = 0; i < v.length; i += 3) {
      const t = Math.log(1 + v[i + 2]) / lmax;
      const p = ((v[i + 1] - z0) * w + (v[i] - x0)) * 4;
      // ramp: deep blue -> teal -> gold -> hot white
      const r = t < 0.5 ? 40 + t * 2 * 60 : 100 + (t - 0.5) * 2 * 155;
      const gg = t < 0.5 ? 60 + t * 2 * 120 : 180 + (t - 0.5) * 2 * 60;
      const b = t < 0.5 ? 160 - t * 2 * 40 : 120 - (t - 0.5) * 2 * 90;
      img.data[p] = r;
      img.data[p + 1] = gg;
      img.data[p + 2] = b;
      img.data[p + 3] = 70 + t * 170;
    }
    g.putImageData(img, 0, 0);
    return { c, x0, z0 };
  }, [explored]);

  const markers = useMemo(() => {
    const out: Marker[] = [];
    for (const s of explored?.structures ?? ([] as Structure[])) {
      const si = structInfo(s.id);
      if (!si) continue;
      const x = (s.bbox[0] + s.bbox[3]) / 2,
        z = (s.bbox[2] + s.bbox[5]) / 2;
      if (out.some((m) => m.kind === "structure" && Math.abs(m.x - x) < 48 && Math.abs(m.z - z) < 48 && m.icon === si[0])) continue;
      out.push({ x, z, y: (s.bbox[1] + s.bbox[4]) / 2, icon: si[0], label: si[1], kind: "structure" });
    }
    for (const p of places) {
      if (p.dim !== dim || p.hidden || p.kind === "village" || out.some((m) => m.kind === "structure" && Math.hypot(m.x - p.center[0], m.z - p.center[2]) < 40 && !p.name)) continue;
      out.push({ x: p.center[0], z: p.center[2], y: p.center[1], icon: p.kind === "home" ? "white_banner" : "frame", label: p.name || (p.kind === "home" ? "Home" : prettyId(p.kind)), sub: p.name ? prettyId(p.kind) : "Unnamed — name it in Places", kind: "place", place: p });
    }
    for (const d of deaths) if ((d.dim ?? "minecraft:overworld") === dim) out.push({ x: d.pos![0], z: d.pos![2], y: d.pos![1], icon: "red_x", label: d.title, sub: d.day !== null ? `Day ${Math.floor(d.day) + 1}` : undefined, kind: "death" });
    if (dim === "minecraft:overworld" && world.spawn) out.push({ x: world.spawn[0], z: world.spawn[2], y: world.spawn[1], icon: "target_point", label: "World spawn", kind: "spawn" });
    if (player?.respawn?.pos && (player.respawn.dim ?? "minecraft:overworld") === dim) out.push({ x: player.respawn.pos[0], z: player.respawn.pos[2], y: player.respawn.pos[1], icon: "red_marker", label: "Your bed", sub: "Respawn point", kind: "respawn" });
    if (player && player.dim === dim) out.push({ x: player.pos[0], z: player.pos[2], y: player.pos[1], icon: "player", label: world.player, sub: "You are here", kind: "player", rot: player.yaw });
    return out;
  }, [explored, places, deaths, player?.pos[0], player?.pos[2], dim]);
  markersRef.current = markers;

  useEffect(() => {
    dirty.current = true;
  }, [style, heat, grid, labels, markers, heatCanvas]);

  // render loop (only when something changed)
  useEffect(() => {
    const cv = canvasRef.current!;
    const g = cv.getContext("2d")!;
    let raf = 0;
    let alive = true;
    const draw = () => {
      if (!alive) return;
      raf = requestAnimationFrame(draw);
      // the page can unmount between frames (its refs go before this loop is stopped)
      const wrap = wrapRef.current;
      if (!wrap) return;
      const dpr = window.devicePixelRatio || 1;
      const W = wrap.clientWidth,
        H = wrap.clientHeight;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
        dirty.current = true;
      }
      if (!dirty.current) return;
      dirty.current = false;
      const { cx, cz, zoom } = view.current;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.imageSmoothingEnabled = zoom < 1;
      const parch = style === "parchment";
      g.fillStyle = parch ? "#cdb98f" : "#0c0f12";
      g.fillRect(0, 0, W, H);
      // world -> screen
      const sx = (x: number) => (x - cx) * zoom + W / 2;
      const sz = (z: number) => (z - cz) * zoom + H / 2;
      // background pattern for the unknown
      if (!parch) {
        g.strokeStyle = "rgba(255,255,255,0.025)";
        g.lineWidth = 1;
        const step = 512 * zoom >= 64 ? 512 : 2048;
        const ox = Math.floor((cx - W / 2 / zoom) / step) * step,
          oz = Math.floor((cz - H / 2 / zoom) / step) * step;
        for (let x = ox; x < cx + W / 2 / zoom; x += step) {
          g.beginPath();
          g.moveTo(Math.round(sx(x)) + 0.5, 0);
          g.lineTo(Math.round(sx(x)) + 0.5, H);
          g.stroke();
        }
        for (let z = oz; z < cz + H / 2 / zoom; z += step) {
          g.beginPath();
          g.moveTo(0, Math.round(sz(z)) + 0.5);
          g.lineTo(W, Math.round(sz(z)) + 0.5);
          g.stroke();
        }
      } else {
        const grad = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.2, W / 2, H / 2, Math.max(W, H) * 0.75);
        grad.addColorStop(0, "#d8c59b");
        grad.addColorStop(1, "#a8915f");
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
      }
      // tiles
      const rx0 = Math.floor((cx - W / 2 / zoom) / 512),
        rx1 = Math.floor((cx + W / 2 / zoom) / 512);
      const rz0 = Math.floor((cz - H / 2 / zoom) / 512),
        rz1 = Math.floor((cz + H / 2 / zoom) / 512);
      for (let rz = rz0; rz <= rz1; rz++)
        for (let rx = rx0; rx <= rx1; rx++) {
          const k = `${rx},${rz}`;
          if (!regions.has(k)) continue;
          const cap = useStore.getState().capsule?.id ?? "";
          const key = `${cap}|${dim}|${style}|${k}|${tileV.current[k] ?? 0}`;
          let im = imgCache.get(key);
          if (!im) {
            im = new Image();
            im.onload = () => (dirty.current = true);
            im.src = tileUrl(dim, style, rx, rz, tileV.current[k] ?? 0) + (cap ? "&c=" + encodeURIComponent(cap) : "");
            imgCache.set(key, im);
          }
          if (im.complete && im.naturalWidth) g.drawImage(im, Math.round(sx(rx * 512)), Math.round(sz(rz * 512)), Math.ceil(512 * zoom), Math.ceil(512 * zoom));
        }
      // heatmap
      if (heat && heatCanvas) {
        g.save();
        g.imageSmoothingEnabled = true;
        g.globalCompositeOperation = parch ? "multiply" : "screen";
        g.filter = zoom > 2 ? "none" : "blur(1px)";
        g.drawImage(heatCanvas.c, sx(heatCanvas.x0 * 16), sz(heatCanvas.z0 * 16), heatCanvas.c.width * 16 * zoom, heatCanvas.c.height * 16 * zoom);
        g.restore();
      }
      // grid
      if (grid && zoom >= 0.5) {
        g.strokeStyle = parch ? "rgba(60,40,20,0.25)" : "rgba(255,255,255,0.08)";
        g.lineWidth = 1;
        const step = zoom >= 2 ? 16 : 128;
        const x0 = Math.floor((cx - W / 2 / zoom) / step) * step;
        const z0 = Math.floor((cz - H / 2 / zoom) / step) * step;
        g.beginPath();
        for (let x = x0; x < cx + W / 2 / zoom; x += step) {
          g.moveTo(Math.round(sx(x)) + 0.5, 0);
          g.lineTo(Math.round(sx(x)) + 0.5, H);
        }
        for (let z = z0; z < cz + H / 2 / zoom; z += step) {
          g.moveTo(0, Math.round(sz(z)) + 0.5);
          g.lineTo(W, Math.round(sz(z)) + 0.5);
        }
        g.stroke();
      }
      // markers
      g.imageSmoothingEnabled = false;
      const ms = markersRef.current;
      const S = 16;
      const labelsDrawn: [number, number, number, number][] = [];
      const order = ["structure", "death", "spawn", "respawn", "place", "player"];
      const sorted = [...ms].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
      for (const m of sorted) {
        const x = sx(m.x),
          y = sz(m.z);
        if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
        if (m.kind === "structure" && zoom < 0.18) continue;
        if (m.kind === "death" && zoom < 0.3) continue;
        const im = sprite(m.icon);
        if (!im.complete) im.onload = () => (dirty.current = true);
        g.save();
        g.translate(Math.round(x), Math.round(y));
        if (m.rot !== undefined) g.rotate(((m.rot + 180) * Math.PI) / 180);
        if (m.kind === "player") {
          g.shadowColor = "rgba(0,0,0,0.6)";
          g.shadowBlur = 6;
        }
        if (im.complete && im.naturalWidth) g.drawImage(im, -S / 2, -S / 2, S, S);
        g.restore();
        if (labels && (m.kind === "place" || m.kind === "player" || (m.kind === "structure" && zoom > 0.7)) ) {
          g.font = m.kind === "place" ? "600 12px 'Space Grotesk Variable'" : "500 11px 'Inter Variable'";
          const text = m.label;
          const tw = g.measureText(text).width;
          const lx = Math.round(x - tw / 2),
            ly = Math.round(y + S / 2 + 13);
          if (labelsDrawn.some(([a, b, c, d]) => lx < c && lx + tw > a && ly - 11 < d && ly + 3 > b)) continue;
          labelsDrawn.push([lx, ly - 11, lx + tw, ly + 3]);
          g.lineWidth = 3;
          g.strokeStyle = parch ? "rgba(230,215,180,0.9)" : "rgba(8,10,12,0.85)";
          g.strokeText(text, lx, ly);
          g.fillStyle = parch ? "#3b2a17" : m.kind === "place" ? "#f3cc8c" : "#e9e6df";
          g.fillText(text, lx, ly);
        }
      }
      // compass + vignette on parchment
      if (parch) {
        const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.72);
        v.addColorStop(0, "rgba(80,50,20,0)");
        v.addColorStop(1, "rgba(80,50,20,0.38)");
        g.fillStyle = v;
        g.fillRect(0, 0, W, H);
        drawCompass(g, W - 70, 74);
      }
    };
    draw();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [style, heat, grid, labels, regions, heatCanvas, dim]);

  // interaction
  useEffect(() => {
    const cv = canvasRef.current!;
    let drag: { x: number; y: number; moved: boolean } | null = null;
    const toWorld = (e: { clientX: number; clientY: number }) => {
      const r = cv.getBoundingClientRect();
      const { cx, cz, zoom } = view.current;
      return [(e.clientX - r.left - r.width / 2) / zoom + cx, (e.clientY - r.top - r.height / 2) / zoom + cz] as [number, number];
    };
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, moved: false };
      cv.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      setHoverPos(toWorld(e));
      if (!drag) return;
      const dx = e.clientX - drag.x,
        dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      view.current.cx -= dx / view.current.zoom;
      view.current.cz -= dy / view.current.zoom;
      dirty.current = true;
      if (drag.moved) setSel(null);
    };
    const up = (e: PointerEvent) => {
      if (drag && !drag.moved) {
        // pick a marker
        const r = cv.getBoundingClientRect();
        const { cx, cz, zoom } = view.current;
        let best: Marker | null = null,
          bd = 14;
        for (const m of markersRef.current) {
          const x = (m.x - cx) * zoom + r.width / 2 + r.left,
            y = (m.z - cz) * zoom + r.height / 2 + r.top;
          const d = Math.hypot(x - e.clientX, y - e.clientY);
          if (d < bd) {
            bd = d;
            best = m;
          }
        }
        if (best) {
          sfx.click();
          setSel({ m: best, sx: e.clientX - r.left, sy: e.clientY - r.top });
        } else setSel(null);
      }
      drag = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const before = toWorld(e);
      const v = view.current;
      v.zoom = Math.max(0.06, Math.min(12, v.zoom * (e.deltaY > 0 ? 1 / 1.18 : 1.18)));
      const after = toWorld(e);
      v.cx += before[0] - after[0];
      v.cz += before[1] - after[1];
      dirty.current = true;
      setSel(null);
    };
    const dbl = (e: MouseEvent) => {
      const [x, z] = toWorld(e);
      flyTo({ x, y: 70, z, dim });
    };
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("wheel", wheel, { passive: false });
    cv.addEventListener("dblclick", dbl);
    return () => {
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("wheel", wheel);
      cv.removeEventListener("dblclick", dbl);
    };
  }, [dim]);

  const zoomBy = (f: number) => {
    view.current.zoom = Math.max(0.06, Math.min(12, view.current.zoom * f));
    dirty.current = true;
  };
  const center = (x: number, z: number) => {
    view.current.cx = x;
    view.current.cz = z;
    if (view.current.zoom < 0.8) view.current.zoom = 1.5;
    dirty.current = true;
  };
  const home = places.find((p) => p.kind === "home" && p.dim === dim);
  const dims = DIMS.filter((d) => (world.dims.find((x) => x.id === d.id)?.regions ?? 0) > 0);
  const scaleBlocks = (() => {
    const target = 120 / view.current.zoom;
    const steps = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
    return steps.find((s) => s >= target) ?? 10000;
  })();

  return (
    <div className={"mappage" + (style === "parchment" ? " parch" : "")}>
      <div className="map-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} className="map-canvas" />
      </div>
      <div className="map-top glass">
        <div className="seg">
          <button
            className={style === "color" ? "on" : ""}
            onClick={() => {
              setStyle("color");
              saveSettings({ map_style: "color" });
            }}
          >
            True colour
          </button>
          <button
            className={style === "parchment" ? "on" : ""}
            onClick={() => {
              setStyle("parchment");
              saveSettings({ map_style: "parchment" });
            }}
          >
            Parchment
          </button>
        </div>
        {dims.length > 1 && (
          <div className="seg">
            {dims.map((d) => (
              <button key={d.id} className={dim === d.id ? "on" : ""} onClick={() => useStore.setState({ dim: d.id })}>
                {d.name.replace("The ", "")}
              </button>
            ))}
          </div>
        )}
        <div className="seg">
          <button className={heat ? "on" : ""} onClick={() => setHeat(!heat)} title="Where you've spent the most time">
            <Flame /> Heat
          </button>
          <button className={grid ? "on" : ""} onClick={() => setGrid(!grid)} title="Chunk grid">
            <Grid3x3 />
          </button>
          <button className={labels ? "on" : ""} onClick={() => setLabels(!labels)} title="Labels">
            <Tag />
          </button>
        </div>
      </div>
      <div className="map-zoom glass">
        <button className="iconbtn" onClick={() => zoomBy(1.4)}>
          <Plus />
        </button>
        <button className="iconbtn" onClick={() => zoomBy(1 / 1.4)}>
          <Minus />
        </button>
        {player && player.dim === dim && (
          <button className="iconbtn" title="Centre on you" onClick={() => center(player.pos[0], player.pos[2])}>
            <Crosshair />
          </button>
        )}
        {home && (
          <button className="iconbtn" title="Centre on home" onClick={() => center(home.center[0], home.center[2])}>
            <HomeIcon />
          </button>
        )}
      </div>
      <div className="map-foot">
        <div className="map-scale">
          <i style={{ width: scaleBlocks * view.current.zoom }} />
          <span>{scaleBlocks >= 1000 ? scaleBlocks / 1000 + " km" : scaleBlocks + " blocks"}</span>
        </div>
        {hoverPos && (
          <div className="coords">
            X {Math.floor(hoverPos[0])} · Z {Math.floor(hoverPos[1])} · chunk {Math.floor(hoverPos[0] / 16)}, {Math.floor(hoverPos[1] / 16)}
            {!seen.has(`${Math.floor(hoverPos[0] / 16)},${Math.floor(hoverPos[1] / 16)}`) && " · unexplored"}
          </div>
        )}
        <div className="muted" style={{ fontSize: 11 }}>
          <Layers size={11} style={{ verticalAlign: -1 }} /> {seen.size.toLocaleString()} chunks seen · double-click to view in 3D
        </div>
      </div>
      {sel && (
        <div className="map-pop glass" style={{ left: Math.min(sel.sx + 14, (wrapRef.current?.clientWidth ?? 800) - 250), top: Math.max(10, sel.sy - 20) }}>
          <div className="mp-title">{sel.m.label}</div>
          {sel.m.sub && <div className="mp-sub">{sel.m.sub}</div>}
          <div className="coords" style={{ margin: "6px 0 10px" }}>
            X {Math.floor(sel.m.x)} · {sel.m.y !== undefined ? `Y ${Math.floor(sel.m.y)} · ` : ""}Z {Math.floor(sel.m.z)}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn sm primary" onClick={() => flyTo({ x: sel.m.x, y: sel.m.y ?? 70, z: sel.m.z, dim })}>
              <Box /> View in 3D
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function drawCompass(g: CanvasRenderingContext2D, x: number, y: number) {
  g.save();
  g.translate(x, y);
  g.strokeStyle = "rgba(60,38,18,0.75)";
  g.fillStyle = "rgba(60,38,18,0.75)";
  g.lineWidth = 1.2;
  g.beginPath();
  g.arc(0, 0, 30, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.arc(0, 0, 25, 0, Math.PI * 2);
  g.stroke();
  for (let i = 0; i < 4; i++) {
    g.save();
    g.rotate((i * Math.PI) / 2);
    g.beginPath();
    g.moveTo(0, -36);
    g.lineTo(6, -6);
    g.lineTo(0, 0);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(0, -36);
    g.lineTo(-6, -6);
    g.lineTo(0, 0);
    g.closePath();
    g.stroke();
    g.restore();
  }
  g.font = "italic 13px 'IM Fell English'";
  g.textAlign = "center";
  g.fillText("N", 0, -42);
  g.restore();
}
