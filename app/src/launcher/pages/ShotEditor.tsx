// Quick edit for a screenshot: crop (free or a fixed shape), light and colour, a few looks,
// then copy it for Discord or save a copy next to the original. The original file never changes.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { motion } from "framer-motion";
import { Copy, Save, X, RotateCcw, Crop } from "lucide-react";
import { api, errText, shotUrl } from "../api";
import { useStore } from "../store";
import { loadImage } from "../../render/skinview";
import { sfx } from "../../sound";

interface Look {
  b: number; // brightness -50..50
  c: number; // contrast -50..50
  s: number; // saturation -100..100
  w: number; // warmth -50..50
  v: number; // vignette 0..100
}
const NONE: Look = { b: 0, c: 0, s: 0, w: 0, v: 0 };
const LOOKS: [string, Look][] = [
  ["None", NONE],
  ["Vivid", { b: 2, c: 12, s: 35, w: 0, v: 15 }],
  ["Warm", { b: 4, c: 4, s: 10, w: 30, v: 10 }],
  ["Cool", { b: 0, c: 6, s: 0, w: -30, v: 10 }],
  ["Noir", { b: 0, c: 30, s: -100, w: 0, v: 35 }],
  ["Dreamy", { b: 10, c: -15, s: -10, w: 12, v: 12 }],
  ["Sunset", { b: 0, c: 8, s: 20, w: 45, v: 25 }],
];
const ASPECTS: [string, number | null][] = [
  ["Free", null],
  ["16:9", 16 / 9],
  ["1:1", 1],
  ["4:5", 4 / 5],
  ["9:16", 9 / 16],
];
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Draw `src` (the `from` part of it) onto `out` at `out`'s size, with the look applied. */
function render(img: HTMLImageElement, from: Rect, out: HTMLCanvasElement, look: Look) {
  const x = out.getContext("2d")!;
  const W = out.width,
    H = out.height;
  x.clearRect(0, 0, W, H);
  x.filter = `brightness(${1 + look.b / 100}) contrast(${1 + look.c / 100}) saturate(${1 + look.s / 100})`;
  x.drawImage(img, from.x, from.y, from.w, from.h, 0, 0, W, H);
  x.filter = "none";
  if (look.w) {
    x.globalCompositeOperation = "soft-light";
    x.fillStyle = look.w > 0 ? `rgba(255, 150, 60, ${look.w / 100})` : `rgba(70, 140, 255, ${-look.w / 100})`;
    x.fillRect(0, 0, W, H);
    x.globalCompositeOperation = "source-over";
  }
  if (look.v) {
    const g = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${(look.v / 100) * 0.85})`);
    x.fillStyle = g;
    x.fillRect(0, 0, W, H);
  }
}

export default function ShotEditor({ shotKey, onClose, onSaved }: { shotKey: string; onClose: () => void; onSaved: (key: string) => void }) {
  const toast = useStore((s) => s.toast);
  const stage = useRef<HTMLDivElement>(null);
  const prev = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [look, setLook] = useState<Look>(NONE);
  const [lookName, setLookName] = useState("None");
  const [aspect, setAspect] = useState<number | null>(null);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [fit, setFit] = useState({ s: 1, ox: 0, oy: 0 });
  const [busy, setBusy] = useState<"copy" | "save" | null>(null);
  const drag = useRef<{ mode: "move" | "nw" | "ne" | "sw" | "se"; sx: number; sy: number; r: Rect } | null>(null);

  useEffect(() => {
    loadImage(shotUrl(shotKey))
      .then((i) => {
        setImg(i);
        setCrop({ x: 0, y: 0, w: i.width, h: i.height });
      })
      .catch((e) => toast(errText(e), "err"));
  }, [shotKey]);

  // fit the whole picture in the stage; draw the preview (the whole picture, crop shown on top)
  useEffect(() => {
    if (!img || !stage.current || !prev.current) return;
    const r = stage.current.getBoundingClientRect();
    const s = Math.min((r.width - 40) / img.width, (r.height - 40) / img.height);
    const w = Math.round(img.width * s),
      h = Math.round(img.height * s);
    const c = prev.current;
    c.width = w;
    c.height = h;
    setFit({ s, ox: (r.width - w) / 2, oy: (r.height - h) / 2 });
    render(img, { x: 0, y: 0, w: img.width, h: img.height }, c, look);
  }, [img, look]);

  const setShape = (a: number | null) => {
    setAspect(a);
    if (!img) return;
    if (a === null) return;
    // the biggest centred box of that shape
    let w = img.width,
      h = w / a;
    if (h > img.height) {
      h = img.height;
      w = h * a;
    }
    setCrop({ x: (img.width - w) / 2, y: (img.height - h) / 2, w, h });
  };

  const onDown = (e: RPointerEvent<HTMLElement>, mode: "move" | "nw" | "ne" | "sw" | "se") => {
    if (!crop) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, sx: e.clientX, sy: e.clientY, r: { ...crop } };
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !img) return;
    const dx = (e.clientX - d.sx) / fit.s,
      dy = (e.clientY - d.sy) / fit.s;
    let { x, y, w, h } = d.r;
    if (d.mode === "move") {
      x = Math.max(0, Math.min(img.width - w, x + dx));
      y = Math.max(0, Math.min(img.height - h, y + dy));
    } else {
      const left = d.mode.includes("w"),
        top = d.mode.includes("n");
      let nw = Math.max(40, w + (left ? -dx : dx));
      let nh = Math.max(40, h + (top ? -dy : dy));
      if (aspect) {
        if (Math.abs(dx) > Math.abs(dy)) nh = nw / aspect;
        else nw = nh * aspect;
      }
      const nx = left ? x + w - nw : x;
      const ny = top ? y + h - nh : y;
      if (nx < 0 || ny < 0 || nx + nw > img.width || ny + nh > img.height) return;
      x = nx;
      y = ny;
      w = nw;
      h = nh;
    }
    setCrop({ x, y, w, h });
  };
  const onUp = () => (drag.current = null);

  const exportPng = () => {
    if (!img || !crop) return null;
    const c = document.createElement("canvas");
    c.width = Math.round(crop.w);
    c.height = Math.round(crop.h);
    render(img, crop, c, look);
    return c.toDataURL("image/png");
  };
  const copy = async () => {
    const png = exportPng();
    if (!png) return;
    setBusy("copy");
    try {
      await api.shotCopyData(png);
      sfx.shutter();
      toast("Copied. Paste it into Discord.", "ok");
    } catch (e) {
      toast(errText(e), "err");
    }
    setBusy(null);
  };
  const save = async () => {
    const png = exportPng();
    if (!png) return;
    setBusy("save");
    try {
      const k = await api.shotSaveEdit(shotKey, png);
      sfx.chime();
      toast("Saved a copy next to the original.", "ok");
      onSaved(k);
    } catch (e) {
      toast(errText(e), "err");
    }
    setBusy(null);
  };

  const slider = (key: keyof Look, label: string, min: number, max: number) => (
    <label className="se-slider">
      <span>
        {label}
        <b>{look[key] > 0 ? "+" + look[key] : look[key]}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={look[key]}
        onChange={(e) => {
          setLook({ ...look, [key]: +e.target.value });
          setLookName("");
        }}
        onDoubleClick={() => setLook({ ...look, [key]: 0 })}
      />
    </label>
  );

  const box = crop && { left: fit.ox + crop.x * fit.s, top: fit.oy + crop.y * fit.s, width: crop.w * fit.s, height: crop.h * fit.s };
  const full = !!img && !!crop && crop.x === 0 && crop.y === 0 && Math.round(crop.w) === img.width && Math.round(crop.h) === img.height;

  return (
    <motion.div className="se-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="se">
        <div className="se-stage" ref={stage} onPointerMove={onMove} onPointerUp={onUp}>
          <canvas ref={prev} className="se-prev" style={{ left: fit.ox, top: fit.oy }} />
          {box && (
            <div className={"se-crop" + (full ? " full" : "")} style={box} onPointerDown={(e) => onDown(e, "move")}>
              <i className="se-third v1" />
              <i className="se-third v2" />
              <i className="se-third h1" />
              <i className="se-third h2" />
              {(["nw", "ne", "sw", "se"] as const).map((m) => (
                <b key={m} className={"se-h " + m} onPointerDown={(e) => onDown(e, m)} />
              ))}
            </div>
          )}
          {crop && <div className="se-size">{`${Math.round(crop.w)} × ${Math.round(crop.h)}`}</div>}
        </div>
        <div className="se-side">
          <div className="se-head">
            <h3>Quick edit</h3>
            <button className="iconbtn" onClick={onClose} title="Close">
              <X size={16} />
            </button>
          </div>
          <div className="se-lbl">
            <Crop size={12} /> Crop
          </div>
          <div className="se-chips">
            {ASPECTS.map(([n, a]) => (
              <button key={n} className={"chip" + (aspect === a ? " on" : "")} onClick={() => (sfx.click(), setShape(a))}>
                {n}
              </button>
            ))}
          </div>
          <div className="se-lbl">Looks</div>
          <div className="se-looks">
            {LOOKS.map(([n, l]) => (
              <button
                key={n}
                className={"se-look" + (lookName === n ? " on" : "")}
                onClick={() => {
                  sfx.click();
                  setLook(l);
                  setLookName(n);
                }}
              >
                <span className={"sw l-" + n.toLowerCase()} />
                {n}
              </button>
            ))}
          </div>
          <div className="se-lbl">Light and colour</div>
          {slider("b", "Brightness", -50, 50)}
          {slider("c", "Contrast", -50, 50)}
          {slider("s", "Saturation", -100, 100)}
          {slider("w", "Warmth", -50, 50)}
          {slider("v", "Vignette", 0, 100)}
          <button
            className="btn sm ghost"
            onClick={() => {
              setLook(NONE);
              setLookName("None");
              setAspect(null);
              if (img) setCrop({ x: 0, y: 0, w: img.width, h: img.height });
            }}
          >
            <RotateCcw /> Start over
          </button>
          <div className="se-actions">
            <button className="btn primary" onClick={copy} disabled={!img || !!busy}>
              <Copy /> Copy for Discord
            </button>
            <button className="btn" onClick={save} disabled={!img || !!busy}>
              <Save /> Save a copy
            </button>
          </div>
          <div className="muted small">The original screenshot stays as it is.</div>
        </div>
      </div>
    </motion.div>
  );
}
