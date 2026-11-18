import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { animate } from "framer-motion";
import { blockTex, iconUrl, prettyId, type Item } from "./api";
import { sfx } from "./sound";

export function ItemIcon({ id, size = 28, className }: { id: string; size?: number; className?: string }) {
  const [bad, setBad] = useState(false);
  if (bad) return <div style={{ width: size, height: size, borderRadius: 4, background: "rgba(255,255,255,0.05)" }} className={className} />;
  return <img src={iconUrl(id)} width={size} height={size} className={className} draggable={false} onError={() => setBad(true)} alt="" loading="lazy" />;
}

export function Sprite({ path, size = 9, style }: { path: string; size?: number; style?: React.CSSProperties }) {
  return <img src={blockTex(path)} width={size} height={size} className="px" draggable={false} style={style} alt="" />;
}

/** Hearts / hunger in the game's HUD sprites (hunger fills from the right, like the game). */
export function HudRow({ value, max = 20, kind, hardcore }: { value: number; max?: number; kind: "heart" | "food"; hardcore?: boolean }) {
  const n = Math.ceil(max / 2);
  const full = kind === "heart" ? `gui/sprites/hud/heart/${hardcore ? "hardcore_full" : "full"}` : "gui/sprites/hud/food_full";
  const half = kind === "heart" ? `gui/sprites/hud/heart/${hardcore ? "hardcore_half" : "half"}` : "gui/sprites/hud/food_half";
  const empty = kind === "heart" ? "gui/sprites/hud/heart/container" : "gui/sprites/hud/food_empty";
  const icons = [];
  for (let i = 0; i < n; i++) {
    const v = Math.round(value) - i * 2;
    icons.push(
      <span key={i} style={{ position: "relative", width: 13, height: 13, display: "inline-block" }}>
        <Sprite path={empty} size={13} style={{ position: "absolute", inset: 0 }} />
        {v >= 2 && <Sprite path={full} size={13} style={{ position: "absolute", inset: 0 }} />}
        {v === 1 && <Sprite path={half} size={13} style={{ position: "absolute", inset: 0 }} />}
      </span>,
    );
  }
  if (kind === "food") icons.reverse();
  return <div style={{ display: "flex" }}>{icons}</div>;
}

export function Ticker({ value, digits = 0, duration = 1.1 }: { value: number; digits?: number; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(0);
  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    const c = animate(from, value, {
      duration,
      ease: [0.2, 0.7, 0.2, 1],
      onUpdate: (v) => {
        if (ref.current) ref.current.textContent = v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
      },
    });
    return () => c.stop();
  }, [value, digits, duration]);
  return <span ref={ref} className="num" />;
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="spin" style={{ flex: "none" }}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.5" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      className={"switch" + (on ? " on" : "")}
      onClick={() => {
        sfx.toggle(!on);
        onChange(!on);
      }}
    />
  );
}

/** Item tooltip in the game's style, following the mouse. */
export function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null);
  const el = tip
    ? createPortal(
        <div className="mctip" style={{ left: Math.min(tip.x + 14, window.innerWidth - 260), top: Math.min(tip.y + 12, window.innerHeight - 120) }}>
          {tip.body}
        </div>,
        document.body,
      )
    : null;
  return {
    el,
    show: (e: React.MouseEvent, body: ReactNode) => setTip({ x: e.clientX, y: e.clientY, body }),
    hide: () => setTip(null),
  };
}

export function itemTip(it: { id: string; count?: number; name?: string | null; enchants?: string[]; damage?: number | null }, names: Record<string, string>) {
  const display = it.name || names[it.id] || prettyId(it.id);
  return (
    <>
      <div className="t" style={it.name ? { fontStyle: "italic" } : undefined}>
        {display}
        {it.count && it.count > 1 ? <span style={{ color: "#a8a8a8", fontWeight: 400 }}> ×{it.count}</span> : null}
      </div>
      {it.enchants?.map((e) => (
        <div key={e} className="e">
          {e.replace(/(^|_|\s)(\w)/g, (_, a, b) => (a === "_" ? " " : a) + b.toUpperCase())}
        </div>
      ))}
      {it.damage ? <div className="l">Durability used: {it.damage}</div> : null}
      <div className="g">{it.id}</div>
    </>
  );
}

export function Slot({ item, names, tip, highlight, size = 40 }: { item?: Item; names: Record<string, string>; tip: ReturnType<typeof useTip>; highlight?: boolean; size?: number }) {
  return (
    <div
      className={"slot" + (item && item.enchants.length ? " ench" : "") + (highlight ? " hl" : "")}
      style={{ width: size, height: size }}
      onMouseMove={item ? (e) => tip.show(e, itemTip(item, names)) : undefined}
      onMouseLeave={tip.hide}
    >
      {item && <ItemIcon id={item.id} size={Math.round(size * 0.75)} />}
      {item && item.count > 1 && <span className="cnt">{item.count}</span>}
    </div>
  );
}

/** Small compass-rose mark used as the app logo. */
export function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="mark" shapeRendering="crispEdges">
      <rect x="7" y="0" width="2" height="16" fill="#3b3125" />
      <rect x="0" y="7" width="16" height="2" fill="#3b3125" />
      <rect x="7" y="1" width="2" height="6" fill="#e2ad5a" />
      <rect x="6" y="3" width="1" height="4" fill="#c98d3c" />
      <rect x="9" y="3" width="1" height="4" fill="#f3cc8c" />
      <rect x="7" y="9" width="2" height="6" fill="#8b8f94" />
      <rect x="6" y="9" width="1" height="4" fill="#6c7075" />
      <rect x="9" y="9" width="1" height="4" fill="#a7abb0" />
      <rect x="6" y="6" width="4" height="4" fill="#ebe7df" />
      <rect x="7" y="7" width="2" height="2" fill="#0a0c0f" />
    </svg>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <div className="big">{title}</div>
      {children && <div style={{ maxWidth: 420, lineHeight: 1.55 }}>{children}</div>}
    </div>
  );
}
