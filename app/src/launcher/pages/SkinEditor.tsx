// The skin editor: paint straight onto the 3D model (or the flat map), on the base or outer layer,
// with mirroring across the body. Saves as a new skin in the closet; the original is never changed.
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { motion } from "framer-motion";
import { Brush, Eraser, Pipette, Sun, Moon, FlipHorizontal2, Undo2, Redo2, Eye, EyeOff, Save, X, Layers } from "lucide-react";
import { api, errText, skinUrl, type Skin } from "../api";
import { useStore } from "../store";
import { SkinViewer, loadImage, type PaintHit } from "../../render/skinview";
import { sfx } from "../../sound";

type Tool = "pencil" | "eraser" | "picker" | "lighten" | "darken";
const TOOLS: [Tool, typeof Brush, string, string][] = [
  ["pencil", Brush, "Pencil", "P"],
  ["eraser", Eraser, "Eraser (outer layer)", "E"],
  ["picker", Pipette, "Pick a colour", "I"],
  ["lighten", Sun, "Lighten", "L"],
  ["darken", Moon, "Darken", "D"],
];

const hex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
const rgb = (h: string): [number, number, number] => {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Which layer a pixel of the 64x64 layout belongs to. */
function layerOf(x: number, y: number): "base" | "outer" | null {
  if (y < 16) return x < 32 ? "base" : "outer";
  if (y < 32) return x < 56 ? "base" : null;
  if (y < 48) return x < 56 ? "outer" : null;
  return x < 16 ? "outer" : x < 48 ? "base" : "outer";
}

export default function SkinEditor({ skin, onClose, onSaved }: { skin: Skin; onClose: () => void; onSaved: (s: Skin) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const flat = useRef<HTMLCanvasElement>(null);
  const viewer = useRef<SkinViewer | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);
  const [tool, setTool] = useState<Tool>("pencil");
  const [color, setColor] = useState("#d0763a");
  const [layer, setLayer] = useState<"base" | "outer">("base");
  const [mirror, setMirror] = useState(true);
  const [showOuter, setShowOuter] = useState(true);
  const [name, setName] = useState(skin.name + " (edited)");
  const [saving, setSaving] = useState(false);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [palette, setPalette] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [, bump] = useState(0);
  const undo = useRef<ImageData[]>([]);
  const redo = useRef<ImageData[]>([]);
  const touched = useRef<Set<number>>(new Set());
  const toast = useStore((s) => s.toast);
  // the latest values, for the viewer's callbacks
  const st = useRef({ tool, color, layer });
  st.current = { tool, color, layer };

  const ctx = () => canvas.current!.getContext("2d", { willReadFrequently: true })!;
  const drawFlat = () => {
    const f = flat.current;
    if (!f || !canvas.current) return;
    const x = f.getContext("2d")!;
    x.imageSmoothingEnabled = false;
    x.clearRect(0, 0, f.width, f.height);
    x.drawImage(canvas.current, 0, 0, f.width, f.height);
  };
  const changed = () => {
    viewer.current?.refresh();
    drawFlat();
  };

  // load the skin onto an editable canvas and the 3D model
  useEffect(() => {
    let dead = false;
    const v = new SkinViewer(host.current);
    viewer.current = v;
    v.still = true;
    v.autoSpin = false;
    v.yaw = -0.35;
    v.camera.position.set(0, 17, 74);
    v.camera.lookAt(0, 16, 0);
    loadImage(skinUrl(skin.id))
      .then(async (img) => {
        if (dead) return;
        const c = SkinViewer.canvasOf(img);
        canvas.current = c;
        await v.build(c, skin.model === "slim", null, true);
        // the skin's own colours, most used first
        const d = c.getContext("2d")!.getImageData(0, 0, 64, 64).data;
        const n = new Map<string, number>();
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) n.set(hex(d[i], d[i + 1], d[i + 2]), (n.get(hex(d[i], d[i + 1], d[i + 2])) ?? 0) + 1);
        const pal = [...n.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
        setPalette(pal.slice(0, 24));
        if (pal[0]) setColor(pal[0]);
        drawFlat();
        setReady(true);
      })
      .catch((e) => toast(errText(e), "err"));
    return () => {
      dead = true;
      v.dispose();
    };
  }, [skin.id]);

  const snapshot = () => {
    undo.current.push(ctx().getImageData(0, 0, 64, 64));
    if (undo.current.length > 80) undo.current.shift();
    redo.current = [];
    touched.current.clear();
    bump((n) => n + 1);
  };

  /** Paint one pixel with the current tool. */
  const dab = (x: number, y: number) => {
    const { tool, color, layer: want } = st.current;
    const lay = layerOf(x, y);
    if (!lay) return;
    const c = ctx();
    const k = y * 64 + x;
    if (tool === "picker") {
      const d = c.getImageData(x, y, 1, 1).data;
      if (d[3] > 0) {
        setColor(hex(d[0], d[1], d[2]));
        setTool("pencil");
      }
      return;
    }
    if (tool === "eraser") {
      if (lay === "base") {
        if (!touched.current.has(-1)) toast("The base layer can't be see-through. Paint over it instead.", "info");
        touched.current.add(-1);
        return;
      }
      c.clearRect(x, y, 1, 1);
      return;
    }
    if (tool === "lighten" || tool === "darken") {
      if (touched.current.has(k)) return; // once per stroke
      touched.current.add(k);
      const d = c.getImageData(x, y, 1, 1);
      if (d.data[3] === 0) return;
      const f = tool === "lighten" ? 1.12 : 0.88;
      for (let i = 0; i < 3; i++) d.data[i] = Math.max(0, Math.min(255, Math.round(d.data[i] * f + (tool === "lighten" ? 4 : 0))));
      c.putImageData(d, x, y);
      return;
    }
    const [r, g, b] = rgb(color);
    const d = c.createImageData(1, 1);
    d.data.set([r, g, b, 255]);
    c.putImageData(d, x, y);
    void want;
  };
  const paintHit = (h: PaintHit) => {
    dab(h.x, h.y);
    if (h.mirror && st.current.tool !== "picker") dab(h.mirror[0], h.mirror[1]);
    changed();
  };

  // hook the viewer's paint mode to the current settings
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    v.paint = {
      layer,
      mirror,
      onPaint: paintHit,
      onHover: (h) => setHover(h ? [h.x, h.y] : null),
      onStroke: (s) => {
        if (s === "start") snapshot();
        else if (st.current.tool === "pencil") setRecent((r) => [st.current.color, ...r.filter((c) => c !== st.current.color)].slice(0, 10));
      },
    };
  }, [layer, mirror, ready]);
  useEffect(() => {
    // painting the base: ghost the outer layer so you can see what you paint under it
    viewer.current?.setOuterVisible(showOuter || layer === "outer", layer === "base" ? 0.28 : 1);
  }, [showOuter, layer, ready]);

  const doUndo = () => {
    const u = undo.current.pop();
    if (!u) return;
    redo.current.push(ctx().getImageData(0, 0, 64, 64));
    ctx().putImageData(u, 0, 0);
    changed();
    bump((n) => n + 1);
  };
  const doRedo = () => {
    const r = redo.current.pop();
    if (!r) return;
    undo.current.push(ctx().getImageData(0, 0, 64, 64));
    ctx().putImageData(r, 0, 0);
    changed();
    bump((n) => n + 1);
  };

  // keys
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.ctrlKey && e.key.toLowerCase() === "z") (e.preventDefault(), e.shiftKey ? doRedo() : doUndo());
      else if (e.ctrlKey && e.key.toLowerCase() === "y") (e.preventDefault(), doRedo());
      else if (e.key === "Escape") onClose();
      else if (!e.ctrlKey) {
        const t = TOOLS.find((t) => t[3].toLowerCase() === e.key.toLowerCase());
        if (t) setTool(t[0]);
        if (e.key.toLowerCase() === "m") setMirror((m) => !m);
        if (e.key.toLowerCase() === "o") setLayer((l) => (l === "base" ? "outer" : "base"));
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  // the flat map: paint on it too (no mirroring there)
  const flatDown = useRef(false);
  const flatAt = (e: RPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [Math.floor(((e.clientX - r.left) / r.width) * 64), Math.floor(((e.clientY - r.top) / r.height) * 64)] as [number, number];
  };

  const save = async () => {
    if (!canvas.current) return;
    setSaving(true);
    try {
      const s = await api.skinSave(name, skin.model, canvas.current.toDataURL("image/png"));
      sfx.chime();
      toast("Saved to your closet.", "ok");
      onSaved(s);
    } catch (e) {
      toast(errText(e), "err");
    }
    setSaving(false);
  };

  const hoverInfo = useMemo(() => {
    if (!hover || !canvas.current) return null;
    const lay = layerOf(hover[0], hover[1]);
    return `${hover[0]}, ${hover[1]} · ${lay === "outer" ? "outer layer" : "base layer"}`;
  }, [hover]);

  return (
    <motion.div className="sked-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="sked" initial={{ y: 16, scale: 0.98 }} animate={{ y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 260, damping: 26 }}>
        <div className="sked-tools">
          {TOOLS.map(([t, I, label, key]) => (
            <button key={t} className={"iconbtn" + (tool === t ? " on" : "")} onClick={() => (sfx.click(), setTool(t))} title={`${label} (${key})`}>
              <I size={17} />
            </button>
          ))}
          <i className="sked-sep" />
          <button className={"iconbtn" + (mirror ? " on" : "")} onClick={() => setMirror(!mirror)} title="Mirror left and right (M)">
            <FlipHorizontal2 size={17} />
          </button>
          <button className={"iconbtn" + (layer === "outer" ? " on" : "")} onClick={() => setLayer(layer === "base" ? "outer" : "base")} title={`Painting the ${layer} layer (O to switch)`}>
            <Layers size={17} />
          </button>
          <button className="iconbtn" onClick={() => setShowOuter(!showOuter)} title={showOuter ? "Hide the outer layer" : "Show the outer layer"}>
            {showOuter ? <Eye size={17} /> : <EyeOff size={17} />}
          </button>
          <i className="sked-sep" />
          <button className="iconbtn" onClick={doUndo} disabled={!undo.current.length} title="Undo (Ctrl+Z)">
            <Undo2 size={17} />
          </button>
          <button className="iconbtn" onClick={doRedo} disabled={!redo.current.length} title="Redo (Ctrl+Y)">
            <Redo2 size={17} />
          </button>
        </div>

        <div className="sked-stage">
          <div className="stage-glow" />
          <div className="sked-host" ref={host} />
          <div className="sked-layer">
            Painting the <b>{layer === "base" ? "base" : "outer"}</b> layer{mirror ? " · mirrored" : ""}
          </div>
          <div className="sked-hint">{hoverInfo ?? "Drag on the skin to paint. Drag around it to turn it."}</div>
        </div>

        <div className="sked-side">
          <div className="sked-head">
            <h3>Skin editor</h3>
            <button className="iconbtn" onClick={onClose} title="Close (Esc)">
              <X size={16} />
            </button>
          </div>
          <label className="sked-color">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            <span className="sw" style={{ background: color }} />
            <code>{color}</code>
          </label>
          {recent.length > 0 && (
            <>
              <div className="sked-lbl">Recent</div>
              <div className="sked-pal">
                {recent.map((c) => (
                  <button key={c} style={{ background: c }} className={c === color ? "on" : ""} onClick={() => setColor(c)} title={c} />
                ))}
              </div>
            </>
          )}
          <div className="sked-lbl">From this skin</div>
          <div className="sked-pal">
            {palette.map((c) => (
              <button key={c} style={{ background: c }} className={c === color ? "on" : ""} onClick={() => setColor(c)} title={c} />
            ))}
          </div>
          <div className="sked-lbl">Flat map</div>
          <canvas
            ref={flat}
            className="sked-flat px"
            width={256}
            height={256}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              flatDown.current = true;
              snapshot();
              const [x, y] = flatAt(e);
              dab(x, y);
              changed();
            }}
            onPointerMove={(e) => {
              const [x, y] = flatAt(e);
              setHover([x, y]);
              if (flatDown.current) {
                dab(x, y);
                changed();
              }
            }}
            onPointerUp={() => (flatDown.current = false)}
            onPointerLeave={() => setHover(null)}
          />
          <div className="sked-lbl">Save as</div>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          <div className="sked-actions">
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" onClick={save} disabled={saving || !ready}>
              <Save /> Save to closet
            </button>
          </div>
          <div className="muted small">Your original skin stays as it is.</div>
        </div>
      </motion.div>
    </motion.div>
  );
}
