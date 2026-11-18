// Resource pack preview on your real base: pick a pack, then compare it with vanilla in a
// split view (drag the line), at day or night, walking around, with the pack's HUD on screen,
// and a drawer for its items and inventory screens. Packs are only read, never installed.
import React, { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Footprints, Layers, Loader2, X, Sun, Moon, Sunset, Columns2, LayoutGrid, AlertTriangle, ChevronsLeftRight, Square } from "lucide-react";
import { Engine, type Mode } from "../render/engine";
import { PackTextures } from "../render/packtex";
import type { View } from "../render/walker";
import { PROTO } from "../api";
import { packIconUrl } from "../launcher/api";
import { sfx } from "../sound";

export interface PackInfo {
  inst: string;
  inst_name: string;
  file: string;
  name: string;
  desc: string;
  res: number;
  /** the size the preview shows it at */
  shown: number;
  ok: boolean | null;
  on: boolean;
  blocks: number;
  items: number;
  gui: number;
  entity: number;
  sky: number;
  models: number;
  ctm: boolean;
}
type PackRef = { inst: string; file: string };

const enc = encodeURIComponent;
const relUrl = (rel: string) => rel.split("/").map(enc).join("/") + ".png";
export const packImg = (p: PackRef, rel: string) => `${PROTO}/packimg/${enc(p.inst)}/${enc(p.file)}/${relUrl(rel)}`;
export const vanillaImg = (rel: string) => `${PROTO}/vanillaimg/${relUrl(rel)}`;

/** A texture from the pack, or vanilla where the pack doesn't change it. */
function PImg({ pack, rel, style, className }: { pack: PackRef | null; rel: string; style?: CSSProperties; className?: string }) {
  const want = pack ? packImg(pack, rel) : vanillaImg(rel);
  const [src, setSrc] = useState(want);
  useEffect(() => setSrc(want), [want]);
  return <img src={src} style={style} className={className} draggable={false} alt="" onError={() => src !== vanillaImg(rel) && setSrc(vanillaImg(rel))} />;
}

const HOTBAR = ["netherite_sword", "diamond_pickaxe", "bow", "golden_apple", "ender_pearl", "cooked_beef", "totem_of_undying", "water_bucket", "firework_rocket"];

const ITEMS = [
  "netherite_sword", "diamond_sword", "iron_sword", "golden_sword", "netherite_pickaxe", "diamond_pickaxe", "diamond_axe", "diamond_shovel",
  "bow", "crossbow_standby", "trident", "mace", "fishing_rod", "flint_and_steel", "shears", "spyglass",
  "totem_of_undying", "ender_pearl", "ender_eye", "elytra", "golden_apple", "apple", "bread", "cooked_beef",
  "cooked_porkchop", "golden_carrot", "baked_potato", "cookie", "sweet_berries", "honey_bottle", "diamond", "emerald",
  "netherite_ingot", "iron_ingot", "gold_ingot", "copper_ingot", "redstone", "lapis_lazuli", "amethyst_shard", "coal",
  "blaze_rod", "nether_star", "experience_bottle", "firework_rocket", "name_tag", "book", "enchanted_book", "bucket",
  "water_bucket", "lava_bucket", "arrow", "string", "bone", "gunpowder", "slime_ball", "heart_of_the_sea",
];

const SCREENS: { rel: string; label: string; w: number; h: number }[] = [
  { rel: "gui/container/inventory", label: "Inventory", w: 176, h: 166 },
  { rel: "gui/container/crafting_table", label: "Crafting table", w: 176, h: 166 },
  { rel: "gui/container/generic_54", label: "Big chest", w: 176, h: 222 },
  { rel: "gui/container/furnace", label: "Furnace", w: 176, h: 166 },
];

const HUD_PARTS = [
  "gui/sprites/hud/hotbar",
  "gui/sprites/hud/hotbar_selection",
  "gui/sprites/hud/heart/full",
  "gui/sprites/hud/heart/container",
  "gui/sprites/hud/food_full",
  "gui/sprites/hud/food_empty",
  "gui/sprites/hud/experience_bar_background",
  "gui/sprites/hud/experience_bar_progress",
];

/** The survival HUD (hotbar, hearts, food, XP), drawn from a pack's sprites. Box: 182 x 41 GUI pixels. */
function Hud({ pack, s }: { pack: PackRef | null; s: number }) {
  const at = (x: number, y: number, w: number, h: number): CSSProperties => ({ left: x * s, top: y * s, width: w * s, height: h * s });
  return (
    <div className="pp-hud" style={{ width: 182 * s, height: 41 * s }}>
      {Array.from({ length: 10 }).map((_, i) => (
        <Fragment key={i}>
          <PImg pack={pack} rel="gui/sprites/hud/heart/container" style={at(i * 8, 2, 9, 9)} />
          <PImg pack={pack} rel="gui/sprites/hud/heart/full" style={at(i * 8, 2, 9, 9)} />
          <PImg pack={pack} rel="gui/sprites/hud/food_empty" style={at(182 - 9 - i * 8, 2, 9, 9)} />
          <PImg pack={pack} rel="gui/sprites/hud/food_full" style={at(182 - 9 - i * 8, 2, 9, 9)} />
        </Fragment>
      ))}
      <PImg pack={pack} rel="gui/sprites/hud/experience_bar_background" style={at(0, 12, 182, 5)} />
      <div style={{ position: "absolute", overflow: "hidden", ...at(0, 12, 182 * 0.62, 5) }}>
        <PImg pack={pack} rel="gui/sprites/hud/experience_bar_progress" style={{ position: "absolute", left: 0, top: 0, width: 182 * s, height: 5 * s }} />
      </div>
      <PImg pack={pack} rel="gui/sprites/hud/hotbar" style={at(0, 19, 182, 22)} />
      <PImg pack={pack} rel="gui/sprites/hud/hotbar_selection" style={at(-1, 18, 24, 23)} />
      {HOTBAR.map((it, i) => (
        <PImg key={it} pack={pack} rel={`item/${it}`} style={at(3 + i * 20, 22, 16, 16)} />
      ))}
    </div>
  );
}

function GuiTex({ src, w, h, s }: { src: string; w: number; h: number; s: number }) {
  return <div className="pp-gui" style={{ width: w * s, height: h * s, backgroundImage: `url("${src}")`, backgroundSize: `${256 * s}px ${256 * s}px` }} />;
}

/** Items and screens, vanilla next to the pack. */
function Drawer({ pack, name, onClose }: { pack: PackRef; name: string; onClose: () => void }) {
  const [tab, setTab] = useState<"items" | "screens">("items");
  const [has, setHas] = useState<Record<string, boolean>>({});
  const [onlyChanged, setOnlyChanged] = useState(false);
  useEffect(() => {
    const names = [...ITEMS.map((i) => `item/${i}`), ...SCREENS.map((x) => x.rel), ...HUD_PARTS, "gui/widgets", "gui/icons"];
    invoke<boolean[]>("pack_has", { inst: pack.inst, file: pack.file, names })
      .then((r) => setHas(Object.fromEntries(names.map((n, i) => [n, r[i]]))))
      .catch(() => {});
  }, [pack.inst, pack.file]);
  const changedItems = ITEMS.filter((i) => has[`item/${i}`]);
  const list = onlyChanged ? changedItems : ITEMS;
  const hudChanged = HUD_PARTS.some((p) => has[p]);
  const oldHud = !hudChanged && (has["gui/widgets"] || has["gui/icons"]);
  const src = (rel: string) => (has[rel] ? packImg(pack, rel) : vanillaImg(rel));
  return (
    <motion.div className="pp-drawer glass" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}>
      <div className="pp-drawer-head">
        <b>{name}</b>
        <div className="seg sm">
          <button className={tab === "items" ? "on" : ""} onClick={() => setTab("items")}>
            Items
          </button>
          <button className={tab === "screens" ? "on" : ""} onClick={() => setTab("screens")}>
            Screens and HUD
          </button>
        </div>
        <button className="iconbtn" onClick={onClose} title="Close">
          <X size={15} />
        </button>
      </div>
      {tab === "items" ? (
        <>
          <div className="pp-drawer-sub">
            <span className="muted small">
              It changes {changedItems.length} of these {ITEMS.length} items. Vanilla on the left, the pack on the right.
            </span>
            <label className="pp-check">
              <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> Only the changed ones
            </label>
          </div>
          <div className="pp-items">
            {list.map((it) => {
              const changed = !!has[`item/${it}`];
              return (
                <div key={it} className={"pp-item" + (changed ? "" : " same")} title={it.replace(/_/g, " ")}>
                  <img src={vanillaImg(`item/${it}`)} alt="" draggable={false} />
                  <span className="pp-arrow">{changed ? "→" : "="}</span>
                  <img src={changed ? packImg(pack, `item/${it}`) : vanillaImg(`item/${it}`)} alt="" draggable={false} />
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="pp-screens">
          <div className="pp-pair">
            <div>
              <div className="pixlabel">Vanilla HUD</div>
              <div className="pp-hudbox">
                <Hud pack={null} s={2} />
              </div>
            </div>
            <div>
              <div className="pixlabel">{name}</div>
              <div className="pp-hudbox">
                <Hud pack={hudChanged ? pack : null} s={2} />
              </div>
            </div>
          </div>
          {oldHud && (
            <div className="pp-note">
              <AlertTriangle size={13} /> This pack has a hotbar and hearts made for older versions (before 1.20.2). Minecraft 26.3 doesn&apos;t use them, so you&apos;d see the normal ones.
            </div>
          )}
          {SCREENS.map((sc) => (
            <div key={sc.rel} className="pp-pair">
              <div>
                <div className="pixlabel">{sc.label} · vanilla</div>
                <GuiTex src={vanillaImg(sc.rel)} w={sc.w} h={sc.h} s={2} />
              </div>
              <div>
                <div className="pixlabel">
                  {sc.label} · {has[sc.rel] ? name : "not changed"}
                </div>
                <GuiTex src={src(sc.rel)} w={sc.w} h={sc.h} s={2} />
              </div>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}

type ViewMode = "split" | "pack" | "vanilla";

export default function PackPreview({
  open,
  panelHidden,
  onClose,
  time,
  setTime,
  mode,
  switchMode,
  view,
  host,
}: {
  open: boolean;
  /** another panel (a chest, a sign) is open in the same spot */
  panelHidden: boolean;
  onClose: () => void;
  time: string;
  setTime: (id: string) => void;
  mode: Mode;
  switchMode: (m: Mode) => void;
  view: View;
  /** the 3D view's element (the split line is measured against it) */
  host: React.RefObject<HTMLDivElement | null>;
}) {
  const [packs, setPacks] = useState<PackInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<PackInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [vm, setVm] = useState<ViewMode>("split");
  const [frac, setFrac] = useState(0.5);
  const [width, setWidth] = useState(1280);
  const [height, setHeight] = useState(720);
  const [stats, setStats] = useState({ changed: 0, layers: 0, res: 16 });
  const [hud, setHud] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const dragging = useRef(false);

  // leaving the 3D world closes the preview
  useEffect(() => () => onClose(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // the list, once opened
  useEffect(() => {
    if (!open || packs) return;
    invoke<PackInfo[]>("pack_list")
      .then(setPacks)
      .catch((e) => setErr(String(e)));
  }, [open, packs]);

  // closing the panel ends the preview
  useEffect(() => {
    if (!open) {
      setSel(null);
      setDrawer(false);
    }
  }, [open]);

  // load the chosen pack into the 3D view
  useEffect(() => {
    const eng = Engine.get();
    if (!sel) {
      eng.setPack(null);
      return;
    }
    const p = new PackTextures(sel.inst, sel.file);
    setLoading(true);
    eng.setPack(p);
    const tick = () => setStats({ changed: p.changed, layers: p.layers, res: p.res });
    const prev = p.onChange;
    p.onChange = () => {
      prev?.();
      tick();
    };
    p.ensure(0)
      .then(() => {
        setLoading(false);
        tick();
      })
      .catch((e) => {
        setLoading(false);
        setErr(String(e));
        setSel(null);
      });
    return () => {
      if (Engine.get().pack === p) Engine.get().setPack(null);
      else p.dispose();
    };
  }, [sel]);

  // the view size (for the split line and the HUD scale)
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setHeight(el.clientHeight);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [open]);

  const x = Math.round(frac * width);
  useEffect(() => {
    const eng = Engine.get();
    if (!sel || loading) return;
    eng.setSplit(vm === "vanilla" ? null : vm === "pack" ? 0 : x);
  }, [sel, loading, vm, x]);

  const onMove = (e: PointerEvent) => {
    if (!dragging.current) return;
    const el = host.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setFrac(Math.min(0.97, Math.max(0.03, (e.clientX - r.left) / r.width)));
  };
  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", up);
    };
  });

  if (!open) return null;
  const ref: PackRef | null = sel ? { inst: sel.inst, file: sel.file } : null;
  const s = height >= 820 ? 3 : 2;
  const showHud = !!sel && !loading && hud && mode === "walk" && view === "first";

  return (
    <>
      {sel && !loading && vm === "split" && (
        <div className="pp-split" style={{ left: x }}>
          <span className="pp-label left">Vanilla</span>
          <span className="pp-label right">{sel.name}</span>
          <button
            className="pp-handle"
            title="Drag to compare"
            onPointerDown={(e) => {
              e.stopPropagation();
              dragging.current = true;
            }}
          >
            <ChevronsLeftRight size={16} />
          </button>
        </div>
      )}

      {showHud && ref && (
        <>
          {vm !== "pack" && (
            <div className="pp-hudlayer" style={vm === "split" ? { clipPath: `inset(0 ${width - x}px 0 0)` } : undefined}>
              <Hud pack={null} s={s} />
            </div>
          )}
          {vm !== "vanilla" && (
            <div className="pp-hudlayer" style={vm === "split" ? { clipPath: `inset(0 0 0 ${x}px)` } : undefined}>
              <Hud pack={ref} s={s} />
            </div>
          )}
        </>
      )}

      <div className="w3d-panel pp-panel glass" style={panelHidden ? { display: "none" } : undefined}>
        <button className="iconbtn w3d-panel-x" onClick={onClose} title="Close the preview">
          <X size={15} />
        </button>
        {!sel ? (
          <>
            <div className="wp-head">
              <Layers size={18} />
              <div>
                <b>Try a resource pack</b>
                <div className="muted small">See it on your base before you switch. Nothing is installed or turned on.</div>
              </div>
            </div>
            {err && <div className="pp-note">{err}</div>}
            {!packs && !err && (
              <div className="muted small pp-wait">
                <Loader2 className="spin" size={14} /> Looking through your packs…
              </div>
            )}
            {packs && packs.length === 0 && <div className="muted small">No resource packs in your instances yet. Packs you add to LongTerm&apos;s resourcepacks folder show up here.</div>}
            <div className="pp-list">
              {packs?.map((p, i) => (
                <Fragment key={p.inst + p.file}>
                {(i === 0 || packs[i - 1].inst !== p.inst) && <div className="pixlabel pp-group">From {p.inst_name}</div>}
                <button className="pp-row" onClick={() => (sfx.click(), setErr(null), setVm("split"), setFrac(0.5), setSel(p))}>
                  <img className="pp-icon" src={packIconUrl(p.inst, "resourcepack", p.file)} alt="" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                  <div className="pp-row-main">
                    <div className="pp-row-name">{p.name}</div>
                    {p.desc && <div className="pp-row-desc">{p.desc}</div>}
                    <div className="pp-tags">
                      <span className="pp-tag">{p.res}x</span>
                      {p.blocks > 0 ? <span className="pp-tag">{p.blocks} blocks</span> : <span className="pp-tag">No blocks</span>}
                      {p.items > 0 && <span className="pp-tag">{p.items} items</span>}
                      {p.gui > 0 && <span className="pp-tag">GUI</span>}
                      {p.on && <span className="pp-tag on">Turned on</span>}
                      {p.ok === false && <span className="pp-tag warn">Made for another version</span>}
                    </div>
                  </div>
                </button>
                </Fragment>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="wp-head">
              <button className="iconbtn" onClick={() => (sfx.nav(), setSel(null))} title="Pick another pack">
                <ArrowLeft size={15} />
              </button>
              <div style={{ minWidth: 0 }}>
                <b className="pp-title">{sel.name}</b>
                <div className="muted small">
                  {loading
                    ? "Putting it on your base…"
                    : `${sel.res}x${sel.res > stats.res ? ` (shown at ${stats.res}x)` : ""} · changes ${stats.changed} of the ${stats.layers} textures in view`}
                </div>
              </div>
            </div>
            {loading && (
              <div className="muted small pp-wait">
                <Loader2 className="spin" size={14} /> Reading {sel.blocks} block textures
              </div>
            )}
            <div className="pp-ctl">
              <span className="pixlabel">Compare</span>
              <div className="seg sm">
                <button className={vm === "split" ? "on" : ""} onClick={() => setVm("split")}>
                  <Columns2 size={13} /> Split
                </button>
                <button className={vm === "pack" ? "on" : ""} onClick={() => setVm("pack")}>
                  <Layers size={13} /> Pack
                </button>
                <button className={vm === "vanilla" ? "on" : ""} onClick={() => setVm("vanilla")}>
                  <Square size={13} /> Vanilla
                </button>
              </div>
            </div>
            <div className="pp-ctl">
              <span className="pixlabel">Time</span>
              <div className="seg sm">
                <button className={time === "noon" ? "on" : ""} onClick={() => setTime("noon")}>
                  <Sun size={13} /> Day
                </button>
                <button className={time === "dusk" ? "on" : ""} onClick={() => setTime("dusk")}>
                  <Sunset size={13} /> Dusk
                </button>
                <button className={time === "night" ? "on" : ""} onClick={() => setTime("night")}>
                  <Moon size={13} /> Night
                </button>
              </div>
            </div>
            <div className="pp-ctl">
              <span className="pixlabel">Look</span>
              <div className="pp-btns">
                {mode === "walk" ? (
                  <button className="btn sm" onClick={() => switchMode("orbit")}>
                    <Footprints size={13} /> Stop walking
                  </button>
                ) : (
                  <button className="btn sm primary" onClick={() => switchMode("walk")}>
                    <Footprints size={13} /> Walk around
                  </button>
                )}
                <button className="btn sm" onClick={() => (sfx.open(), setDrawer(true))}>
                  <LayoutGrid size={13} /> Items and screens
                </button>
              </div>
            </div>
            {mode === "walk" && (
              <label className="pp-check">
                <input type="checkbox" checked={hud} onChange={(e) => setHud(e.target.checked)} /> Show the hotbar and hearts{view !== "first" ? " (in first person)" : ""}
              </label>
            )}
            {(sel.ctm || sel.models > 0 || sel.ok === false) && (
              <div className="pp-note">
                <AlertTriangle size={13} />
                <span>
                  {sel.ok === false && "It says it was made for another Minecraft version, so some textures may not match. "}
                  {sel.models > 0 && `It also changes ${sel.models === 1 ? "a model" : `${sel.models} models`}; the preview shows its textures on the normal shapes. `}
                  {sel.ctm && "Connected and glowing textures (OptiFine/Continuity) aren't shown."}
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <AnimatePresence>{drawer && ref && sel && <Drawer pack={ref} name={sel.name} onClose={() => setDrawer(false)} />}</AnimatePresence>
    </>
  );
}
