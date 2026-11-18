import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { create } from "zustand";
import {
  Search, Download, Heart, Check, ExternalLink, Loader2, X, ChevronLeft, ChevronRight, ShieldCheck, Blocks, Sparkles, Palette, Database, Boxes, Maximize2, Globe2, Play, Cpu, HardDrive, Package, MemoryStick,
} from "lucide-react";
import { api, errText, fmtAgo, fmtBytes, fmtNum, loaderName, worldIconUrl, type Kind, type PackPreview, type PackSource, type SearchHit, type WorldItem } from "../api";
import { useStore } from "../store";
import { sfx } from "../../sound";
import { runJob, useJobs } from "../jobs";
import { refreshInstances } from "../boot";

type Tab = Kind | "saved";

export const KINDS: { k: Tab; label: string; icon: typeof Blocks }[] = [
  { k: "mod", label: "Mods", icon: Blocks },
  { k: "shader", label: "Shaders", icon: Sparkles },
  { k: "resourcepack", label: "Resource packs", icon: Palette },
  { k: "datapack", label: "Datapacks", icon: Database },
  { k: "modpack", label: "Modpacks", icon: Boxes },
  { k: "saved", label: "Saved", icon: Heart },
];

const NOUN: Record<Kind, string> = { mod: "mods", shader: "shaders", resourcepack: "resource packs", datapack: "datapacks", modpack: "modpacks" };

/** Filter chips: each group is one row of choices; a choice can stand for several tags (OR). */
type ChipGroup = { id: string; label?: string; chips: [string, string, string[]][] };
const CHIPS: Record<Kind, ChipGroup[]> = {
  mod: [
    {
      id: "cat",
      chips: [
        ["optimization", "Performance", ["optimization"]],
        ["utility", "Utility", ["utility"]],
        ["decoration", "Decoration", ["decoration"]],
        ["adventure", "Adventure", ["adventure"]],
        ["worldgen", "World gen", ["worldgen"]],
        ["mobs", "Mobs", ["mobs"]],
        ["technology", "Tech", ["technology"]],
        ["magic", "Magic", ["magic"]],
        ["storage", "Storage", ["storage"]],
        ["food", "Food", ["food"]],
        ["equipment", "Gear", ["equipment"]],
        ["social", "Social", ["social"]],
      ],
    },
  ],
  shader: [
    {
      id: "heavy",
      label: "Heaviness",
      chips: [
        ["potato", "Potato", ["potato"]],
        ["low", "Low", ["low"]],
        ["medium", "Medium", ["medium"]],
        ["high", "High", ["high", "screenshot"]],
      ],
    },
    {
      id: "style",
      label: "Look",
      chips: [
        ["vanilla-like", "Vanilla-like", ["vanilla-like"]],
        ["semi-realistic", "Semi-realistic", ["semi-realistic"]],
        ["realistic", "Realistic", ["realistic"]],
        ["fantasy", "Fantasy", ["fantasy"]],
        ["cartoon", "Cartoon", ["cartoon"]],
      ],
    },
  ],
  resourcepack: [
    {
      id: "res",
      label: "Resolution",
      chips: [
        ["16x", "16x", ["16x"]],
        ["32x", "32x", ["32x"]],
        ["64x", "64x", ["64x"]],
        ["128x", "128x and up", ["128x", "256x", "512x+"]],
      ],
    },
    {
      id: "style",
      label: "Style",
      chips: [
        ["vanilla-like", "Vanilla-like", ["vanilla-like"]],
        ["simplistic", "Simple", ["simplistic"]],
        ["realistic", "Realistic", ["realistic"]],
        ["themed", "Themed", ["themed"]],
        ["tweaks", "Tweaks", ["tweaks"]],
        ["combat", "PvP", ["combat"]],
      ],
    },
  ],
  datapack: [
    {
      id: "cat",
      chips: [
        ["worldgen", "World gen", ["worldgen"]],
        ["adventure", "Adventure", ["adventure"]],
        ["game-mechanics", "Game rules", ["game-mechanics"]],
        ["utility", "Utility", ["utility"]],
        ["mobs", "Mobs", ["mobs"]],
        ["equipment", "Gear", ["equipment"]],
        ["magic", "Magic", ["magic"]],
      ],
    },
  ],
  modpack: [
    {
      id: "cat",
      chips: [
        ["lightweight", "Lightweight", ["lightweight"]],
        ["optimization", "Performance", ["optimization"]],
        ["adventure", "Adventure", ["adventure"]],
        ["technology", "Tech", ["technology"]],
        ["magic", "Magic", ["magic"]],
        ["quests", "Quests", ["quests"]],
        ["challenging", "Hard", ["challenging"]],
        ["multiplayer", "Multiplayer", ["multiplayer"]],
        ["kitchen-sink", "Everything", ["kitchen-sink"]],
      ],
    },
  ],
};

type Shelf = { title: string; sub?: string; sort: string; filters: string[][] };
function shelves(kind: Kind, mc: string, loader: string): Shelf[] {
  const v = mc ? [[`versions:${mc}`]] : [];
  const cat = (...c: string[]) => [c.map((x) => `categories:${x}`)];
  switch (kind) {
    case "mod":
      return [
        { title: `Most downloaded for ${mc}`, sort: "downloads", filters: v },
        { title: "Performance", sub: "More FPS, less lag", sort: "downloads", filters: [...cat("optimization"), ...v] },
        { title: "Looks and feel", sub: "Decoration and little touches", sort: "downloads", filters: [...cat("decoration"), ...v] },
        { title: "Handy utilities", sort: "downloads", filters: [...cat("utility"), ...v] },
        { title: `New for ${mc}`, sub: `Just released for ${loaderName(loader)} ${mc}`, sort: "newest", filters: v },
        { title: "Recently updated", sort: "updated", filters: v },
      ];
    case "shader":
      return [
        { title: "Most downloaded", sort: "downloads", filters: [] },
        { title: "Light on FPS", sub: "Run well on most PCs", sort: "downloads", filters: cat("potato", "low") },
        { title: "Best looking", sub: "Heavy, but stunning", sort: "downloads", filters: cat("high", "screenshot") },
        { title: "Realistic", sort: "downloads", filters: cat("realistic", "semi-realistic") },
        { title: "Fantasy and cartoon", sort: "downloads", filters: cat("fantasy", "cartoon") },
        { title: "New shaders", sort: "newest", filters: [] },
      ];
    case "resourcepack":
      return [
        { title: `Most downloaded for ${mc}`, sort: "downloads", filters: v },
        { title: "Like vanilla, but better", sort: "downloads", filters: [...cat("vanilla-like"), ...v] },
        { title: "Classic 16x", sort: "downloads", filters: [...cat("16x"), ...v] },
        { title: "High resolution", sub: "64x and up", sort: "downloads", filters: [...cat("64x", "128x", "256x", "512x+"), ...v] },
        { title: "For PvP", sort: "downloads", filters: [...cat("combat"), ...v] },
        { title: `New for ${mc}`, sort: "newest", filters: v },
      ];
    case "datapack":
      return [
        { title: `Most downloaded for ${mc}`, sort: "downloads", filters: v },
        { title: "New worlds to explore", sort: "downloads", filters: [...cat("worldgen"), ...v] },
        { title: "Adventure", sort: "downloads", filters: [...cat("adventure"), ...v] },
        { title: "Game rule tweaks", sort: "downloads", filters: [...cat("game-mechanics"), ...v] },
        { title: `New for ${mc}`, sort: "newest", filters: v },
      ];
    case "modpack":
      return [
        { title: "Most downloaded", sort: "downloads", filters: [] },
        { title: "Lightweight", sub: "Vanilla, just better", sort: "downloads", filters: cat("lightweight") },
        { title: "Performance packs", sort: "downloads", filters: cat("optimization") },
        { title: "Big adventures", sort: "downloads", filters: cat("adventure") },
        { title: `For Minecraft ${mc}`, sort: "downloads", filters: v },
        { title: "New modpacks", sort: "newest", filters: [] },
      ];
  }
}

// ---------------------------------------------------------------- saved list (shared by every card)

const useSaved = create<{ items: SearchHit[]; loaded: boolean }>(() => ({ items: [], loaded: false }));
function loadSaved() {
  if (useSaved.getState().loaded) return;
  useSaved.setState({ loaded: true });
  api
    .saved()
    .then((items) => useSaved.setState({ items }))
    .catch(() => {});
}
async function toggleSaved(hit: SearchHit, kind: Kind) {
  const was = useSaved.getState().items.some((x) => x.project_id === hit.project_id);
  sfx.toggle(!was);
  // optimistic, then the real list
  useSaved.setState((s) => ({ items: was ? s.items.filter((x) => x.project_id !== hit.project_id) : [{ ...hit, mio_kind: kind }, ...s.items] }));
  try {
    useSaved.setState({ items: await api.savedToggle({ ...hit, mio_kind: kind }) });
  } catch {
    /* keep the optimistic list */
  }
}
const useIsSaved = (id: string) => useSaved((s) => s.items.some((x) => x.project_id === id));

// ---------------------------------------------------------------- bits

const HEAVY = ["potato", "low", "medium", "high", "screenshot"];
const HEAVY_LABEL: Record<string, string> = { potato: "Potato", low: "Low", medium: "Medium", high: "High", screenshot: "Ultra" };
function heaviness(cats: string[]): { label: string; tone: string } | null {
  const h = HEAVY.filter((x) => cats.includes(x));
  if (!h.length) return null;
  const label = h.length === 1 ? HEAVY_LABEL[h[0]] : `${HEAVY_LABEL[h[0]]}–${HEAVY_LABEL[h[h.length - 1]]}`;
  const tone = h[0] === "potato" || h[0] === "low" ? "green" : h[0] === "medium" ? "amber" : "red";
  return { label, tone };
}
const RES = ["8x-", "16x", "32x", "48x", "64x", "128x", "256x", "512x+"];
const LOADERS = ["fabric", "neoforge", "forge", "quilt"];

export const colorOf = (h: SearchHit) => (h.color ? `#${h.color.toString(16).padStart(6, "0")}` : "var(--panel-3)");
export const kindOf = (h: SearchHit): Kind => h.mio_kind ?? ((["mod", "shader", "resourcepack", "datapack", "modpack"].includes(h.project_type) ? h.project_type : "mod") as Kind);

function isCompatible(hit: SearchHit, kind: Kind, mc: string, loader: string): boolean {
  if (kind === "modpack" || !mc) return true;
  if (!hit.versions?.includes(mc)) return false;
  if (kind === "mod" && loader !== "vanilla") return hit.categories.includes(loader) || (loader === "quilt" && hit.categories.includes("fabric"));
  return true;
}

function Badges({ hit, kind }: { hit: SearchHit; kind: Kind }) {
  const out: { t: string; tone?: string }[] = [];
  if (kind === "shader") {
    const h = heaviness(hit.categories);
    if (h) out.push({ t: h.label, tone: h.tone });
  }
  if (kind === "resourcepack") {
    const r = RES.find((x) => hit.categories.includes(x));
    if (r) out.push({ t: r });
  }
  if (kind === "modpack") {
    const l = LOADERS.find((x) => hit.categories.includes(x));
    const v = hit.versions?.[hit.versions.length - 1];
    out.push({ t: [l ? loaderName(l) : null, v].filter(Boolean).join(" · ") });
  }
  return (
    <>
      {out
        .filter((b) => b.t)
        .map((b) => (
          <span key={b.t} className={"stbadge " + (b.tone ?? "")}>
            {b.t}
          </span>
        ))}
    </>
  );
}

function HeartBtn({ hit, kind }: { hit: SearchHit; kind: Kind }) {
  const on = useIsSaved(hit.project_id);
  return (
    <motion.span
      role="button"
      className={"heart" + (on ? " on" : "")}
      title={on ? "Saved" : "Save for later"}
      whileTap={{ scale: 0.8 }}
      onClick={(e) => {
        e.stopPropagation();
        toggleSaved(hit, kind);
      }}
    >
      <motion.span key={on ? "on" : "off"} initial={{ scale: on ? 0.4 : 1 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 600, damping: 14 }} style={{ display: "grid" }}>
        <Heart size={15} fill={on ? "currentColor" : "none"} />
      </motion.span>
    </motion.span>
  );
}

function StoreCard({ hit, kind, compat, mc, installed, i, onOpen, wide }: { hit: SearchHit; kind: Kind; compat: boolean; mc: string; installed: boolean; i: number; onOpen: () => void; wide?: boolean }) {
  return (
    <motion.button
      className={"scard" + (compat ? "" : " off") + (wide ? " wide" : "")}
      onClick={onOpen}
      onMouseEnter={() => sfx.hover()}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: (i % 24) * 0.025, duration: 0.35, ease: [0.22, 0.7, 0.18, 1] }}
      whileHover={{ y: -4 }}
      style={{ ["--c" as any]: colorOf(hit) }}
    >
      <div className="scard-banner">
        {hit.featured_gallery || hit.gallery?.[0] ? <img src={hit.featured_gallery || hit.gallery[0]} loading="lazy" /> : <div className="scard-blank" />}
        <HeartBtn hit={hit} kind={kind} />
        {!compat && <span className="notfor">Not for {mc}</span>}
      </div>
      <div className="scard-body">
        {hit.icon_url ? <img className="scard-icon" src={hit.icon_url} loading="lazy" /> : <span className="scard-icon mletter">{hit.title[0]}</span>}
        <b>{hit.title}</b>
        <i>{hit.description}</i>
        <div className="scard-foot">
          <span>
            <Download size={12} /> {fmtNum(hit.downloads)}
          </span>
          <Badges hit={hit} kind={kind} />
          {installed ? (
            <span className="have">
              <Check size={12} /> Installed
            </span>
          ) : (
            <span className="muted author">{hit.author}</span>
          )}
        </div>
      </div>
    </motion.button>
  );
}

const shelfCache = new Map<string, SearchHit[]>();

function ShelfRow({ inst, kind, shelf, mc, loader, have, onOpen, index }: { inst: string; kind: Kind; shelf: Shelf; mc: string; loader: string; have: Set<string>; onOpen: (h: SearchHit) => void; index: number }) {
  const key = `${inst}|${kind}|${shelf.title}|${shelf.sort}|${JSON.stringify(shelf.filters)}`;
  const [hits, setHits] = useState<SearchHit[] | null>(shelfCache.get(key) ?? null);
  const [err, setErr] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shelfCache.has(key)) return;
    const t = setTimeout(
      () =>
        api
          .store2Search(inst, kind, "", 0, 14, shelf.sort, shelf.filters)
          .then((r) => {
            shelfCache.set(key, r.hits);
            setHits(r.hits);
          })
          .catch(() => setErr(true)),
      index * 90,
    );
    return () => clearTimeout(t);
  }, [key]);
  const scroll = (d: number) => row.current?.scrollBy({ left: d * row.current.clientWidth * 0.85, behavior: "smooth" });
  if (err || (hits && hits.length === 0)) return null;
  return (
    <motion.section className="shelf" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.06, duration: 0.4, ease: [0.22, 0.7, 0.18, 1] }}>
      <div className="shelf-head">
        <div>
          <h3>{shelf.title}</h3>
          {shelf.sub && <span className="muted small">{shelf.sub}</span>}
        </div>
        <div className="shelf-arrows">
          <button className="iconbtn sm" onClick={() => scroll(-1)}>
            <ChevronLeft />
          </button>
          <button className="iconbtn sm" onClick={() => scroll(1)}>
            <ChevronRight />
          </button>
        </div>
      </div>
      <div className="shelf-row" ref={row}>
        {!hits && Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton shelf-skel" />)}
        {hits?.map((h, i) => (
          <StoreCard key={h.project_id} hit={h} kind={kind} mc={mc} compat={isCompatible(h, kind, mc, loader)} installed={have.has(h.project_id)} i={i} onOpen={() => onOpen(h)} wide={kind === "shader"} />
        ))}
      </div>
    </motion.section>
  );
}

// ---------------------------------------------------------------- markdown + gallery

/** Very small Markdown/HTML to React: headings, paragraphs, lists, images and links as text. */
export function MiniMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const clean = text
      .replace(/\[\s*!\[([^\]]*)\]\(([^)\s]+)[^)]*\)\s*\]\([^)]*\)/g, "\n![$1]($2)\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, "\n![]($1)\n")
      .replace(/<\/?(p|div|center|h\d|span|a|b|strong|i|em|details|summary|sup|sub|table|tr|td|th|tbody|thead|ul|ol|li|font)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "");
    const out: { kind: string; text: string }[] = [];
    for (const raw of clean.split("\n")) {
      const l = raw.trim();
      if (!l) continue;
      const img = l.match(/!\[[^\]]*\]\((https:\/\/[^)\s]+)\)/);
      if (img) {
        out.push({ kind: "img", text: img[1] });
        continue;
      }
      const h = l.match(/^(#{1,6})\s+(.*)/);
      const t = l
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, "$1")
        .replace(/^>\s?/, "");
      if (h) out.push({ kind: "h", text: t.replace(/^#+\s+/, "") });
      else if (/^[-*+]\s+/.test(l) || /^\d+\.\s+/.test(l)) out.push({ kind: "li", text: t.replace(/^([-*+]|\d+\.)\s+/, "") });
      else if (/^[-=_*]{3,}$/.test(l)) continue;
      else out.push({ kind: "p", text: t });
    }
    return out.slice(0, 80);
  }, [text]);
  return (
    <div className="md">
      {blocks.map((b, i) =>
        b.kind === "img" ? <img key={i} src={b.text} loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} /> : b.kind === "h" ? <h4 key={i}>{b.text}</h4> : b.kind === "li" ? <li key={i}>{b.text}</li> : <p key={i}>{b.text}</p>,
      )}
    </div>
  );
}

function Lightbox({ images, start, onClose }: { images: { url: string; raw?: string; title?: string }[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      } else if (e.key === "ArrowRight") setI((x) => (x + 1) % images.length);
      else if (e.key === "ArrowLeft") setI((x) => (x - 1 + images.length) % images.length);
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
  return createPortal(
    <motion.div className="lightbox2" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <AnimatePresence mode="wait">
        <motion.img key={images[i].url} src={images[i].raw || images[i].url} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }} />
      </AnimatePresence>
      {images[i].title && <div className="lb-title">{images[i].title}</div>}
      {images.length > 1 && (
        <>
          <button className="gal-btn l" onClick={() => setI((x) => (x - 1 + images.length) % images.length)}>
            <ChevronLeft />
          </button>
          <button className="gal-btn r" onClick={() => setI((x) => (x + 1) % images.length)}>
            <ChevronRight />
          </button>
          <div className="lb-strip">
            {images.map((im, n) => (
              <img key={im.url} src={im.url} className={n === i ? "on" : ""} onClick={() => setI(n)} />
            ))}
          </div>
        </>
      )}
      <button className="iconbtn lb-close" onClick={onClose}>
        <X />
      </button>
    </motion.div>,
    document.body,
  );
}

// ---------------------------------------------------------------- modpack details (store drawer + dropped files)

export function ModpackDetails({ src, title, icon, onDone }: { src: PackSource; title?: string; icon?: string | null; onDone?: (id: string) => void }) {
  const [p, setP] = useState<PackPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [newId, setNewId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const toast = useStore((s) => s.toast);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJobs((s) => (jobId ? s.jobs[jobId] : undefined));
  const pct = job?.pct ?? -1;
  useEffect(() => {
    setP(null);
    setErr(null);
    api
      .modpackPreview(src)
      .then(setP)
      .catch((e) => setErr(errText(e)));
  }, [src.version_id, src.path]);
  const install = async () => {
    if (!p) return;
    setInstalling(true);
    sfx.click();
    try {
      const id = await runJob({ inst: "new", label: `Installing ${title ?? p.name}`, icon, from: btn.current }, (j) => {
        setJobId(j);
        return api.modpackInstall(src, j);
      });
      await refreshInstances();
      sfx.chime();
      toast(`${title ?? p.name} is ready as a new instance`, "ok");
      setNewId(id);
      onDone?.(id);
    } catch (e) {
      toast(errText(e), "err");
    }
    setInstalling(false);
  };
  if (err) return <div className="dnote err">{err}</div>;
  if (!p) return <div className="skeleton" style={{ height: 220, marginTop: 12, borderRadius: 12 }} />;
  const memPct = Math.min(1, p.memory_mb / Math.max(1, p.ram_mb));
  const tight = p.memory_mb > p.ram_mb * 0.6;
  return (
    <div className="mpack">
      {!title && (
        <div className="mp-head">
          <b>{p.name}</b>
          <span className="muted">
            {p.version_name}
            {p.summary ? ` · ${p.summary}` : ""}
          </span>
        </div>
      )}
      <div className="mp-stats">
        <div className="mp-stat">
          <Cpu size={15} />
          <b>
            {loaderName(p.loader)} {p.mc}
          </b>
          <span>New instance, your others stay as they are</span>
        </div>
        <div className="mp-stat">
          <Package size={15} />
          <b>{p.mods.length} mods</b>
          <span>{p.other_files > 0 ? `plus ${p.other_files} other files` : "and its settings"}</span>
        </div>
        <div className="mp-stat">
          <HardDrive size={15} />
          <b>{fmtBytes(p.download_size)}</b>
          <span>to download</span>
        </div>
        <div className={"mp-stat" + (tight ? " warn" : "")}>
          <MemoryStick size={15} />
          <b>{(p.memory_mb / 1024).toFixed(0)} GB memory</b>
          <span className="memline">
            <i>
              <motion.u initial={{ width: 0 }} animate={{ width: `${memPct * 100}%` }} transition={{ duration: 0.8, delay: 0.2 }} />
            </i>
            of your {Math.round(p.ram_mb / 1024)} GB{tight ? ", that's a lot for this PC" : ""}
          </span>
        </div>
      </div>
      <div className="dinstall">
        {newId ? (
          <button
            className="btn primary big"
            onClick={() => {
              useStore.getState().setCurrent(newId);
              useStore.getState().setPage("home");
              useStore.setState({ packPreview: null });
            }}
          >
            <Play fill="currentColor" /> Play it
          </button>
        ) : (
          <button ref={btn} className="btn primary big" onClick={install} disabled={installing}>
            {installing ? <Loader2 className="spin" /> : <Download />}
            {installing ? (pct >= 0 ? `Installing… ${Math.round(pct * 100)}%` : "Installing…") : `Install as a new instance`}
          </button>
        )}
      </div>
      {installing && job && job.pct >= 0 && <div className="muted small mp-step">{job.label}</div>}
      <div className="dnote">
        <ShieldCheck size={13} /> Mio's guess at memory comes from the number of mods. The pack is never updated after you install it.
      </div>
      <div className="mp-list">
        <div className="panel-title">
          Mods inside <span className="muted">· {p.mods.length}</span>
        </div>
        {(showAll ? p.mods : p.mods.slice(0, 40)).map((m, i) => (
          <motion.div key={m.name + i} className="mp-mod" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i, 30) * 0.015 }}>
            {m.icon_url ? <img src={m.icon_url} loading="lazy" /> : <span className="mletter">{m.name[0]}</span>}
            <span className="t">
              <b>{m.name}</b>
              {m.description && <i>{m.description}</i>}
            </span>
            <span className="muted small">{fmtBytes(m.size)}</span>
          </motion.div>
        ))}
        {!showAll && p.mods.length > 40 && (
          <button className="btn ghost sm" onClick={() => setShowAll(true)}>
            Show all {p.mods.length}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- drawer

function WorldPicker({ inst, onPick, onClose }: { inst: string; onPick: (w: WorldItem) => void; onClose: () => void }) {
  const [worlds, setWorlds] = useState<WorldItem[] | null>(null);
  useEffect(() => {
    api
      .worlds(inst)
      .then(setWorlds)
      .catch(() => setWorlds([]));
  }, [inst]);
  return (
    <motion.div className="wpick" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}>
      <div className="wpick-head">
        <b>Which world gets it?</b>
        <button className="iconbtn sm" onClick={onClose}>
          <X />
        </button>
      </div>
      {!worlds && <div className="skeleton" style={{ height: 120 }} />}
      {worlds?.length === 0 && <div className="muted small">This instance has no worlds yet. Make one in game first.</div>}
      <div className="wpick-list">
        {worlds?.map((w) => (
          <button key={w.folder} className="wpick-item" onClick={() => onPick(w)}>
            {w.icon ? <img src={worldIconUrl(inst, w.folder)} className="px" /> : <span className="wblank">
                <Globe2 size={16} />
              </span>}
            <span className="t">
              <b>{w.name}</b>
              <i>
                Day {w.day.toLocaleString()} · {fmtAgo(w.last_played)}
              </i>
            </span>
          </button>
        ))}
      </div>
    </motion.div>
  );
}

const INSTALL_WORD: Record<Kind, string> = { mod: "Install", shader: "Install shader", resourcepack: "Download pack", datapack: "Add to a world", modpack: "Install" };

function ProjectDrawer({ inst, mc, loader, hit, kind, installed, onClose, onInstalled }: { inst: string; mc: string; loader: string; hit: SearchHit; kind: Kind; installed: boolean; onClose: () => void; onInstalled: () => void }) {
  const [data, setData] = useState<{ project: any; versions: any[]; authors: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [img, setImg] = useState(0);
  const [installing, setInstalling] = useState(false);
  const [done, setDone] = useState<string[] | null>(null);
  const [doneWorlds, setDoneWorlds] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [lb, setLb] = useState(false);
  const lbRef = useRef(false);
  lbRef.current = lb;
  const btn = useRef<HTMLButtonElement>(null);
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    sfx.open();
    api
      .store2Project(inst, kind, hit.project_id)
      .then(setData)
      .catch((e) => setErr(errText(e)));
    const k = (e: KeyboardEvent) => e.key === "Escape" && !lbRef.current && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [hit.project_id]);
  const gallery: { url: string; raw?: string; title?: string }[] = data?.project?.gallery?.length
    ? [...data.project.gallery].sort((a: any, b: any) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0)).map((g: any) => ({ url: g.url, raw: g.raw_url, title: g.title }))
    : (hit.gallery ?? []).map((url) => ({ url }));
  const compatible = data ? data.versions.length > 0 : true;
  const install = async (world?: WorldItem) => {
    setPicking(false);
    setInstalling(true);
    sfx.click();
    try {
      const files = await runJob({ inst, label: `Installing ${hit.title}`, icon: hit.icon_url, from: btn.current }, () => api.store2Install(inst, kind, hit.project_id, world?.folder));
      setDone(files);
      if (kind === "datapack" && world) setDoneWorlds((d) => (d.includes(world.name) ? d : [...d, world.name]));
      sfx.chime();
      const msg =
        kind === "mod"
          ? files.length > 1
            ? `Installed ${hit.title} and ${files.length - 1} mod${files.length > 2 ? "s" : ""} it needs`
            : `Installed ${hit.title}`
          : kind === "shader"
            ? `${hit.title} is your Shaders mode pack now${files.length > 1 ? " (Iris and Sodium added too)" : ""}`
            : kind === "resourcepack"
              ? `Downloaded ${hit.title}. Turn it on under Installed, Resource packs.`
              : `Added ${hit.title} to ${world?.name ?? "your world"}`;
      toast(msg, "ok");
      onInstalled();
    } catch (e) {
      toast(errText(e), "err");
    }
    setInstalling(false);
  };
  const url = `https://modrinth.com/${kind === "resourcepack" ? "resourcepack" : kind}/${hit.slug}`;
  return (
    <motion.div className="drawer-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div className={"drawer" + (kind === "shader" ? " wide" : "")} initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", stiffness: 340, damping: 36 }}>
        <div className={"drawer-hero" + (kind === "shader" ? " tall" : "")} style={{ ["--c" as any]: colorOf(hit) }}>
          {gallery.length > 0 ? (
            <AnimatePresence mode="wait">
              <motion.img key={gallery[img]?.url} src={gallery[img]?.url} initial={{ opacity: 0, scale: 1.04 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }} onClick={() => setLb(true)} style={{ cursor: "zoom-in" }} />
            </AnimatePresence>
          ) : (
            <div className="drawer-hero-blank" />
          )}
          {gallery.length > 1 && (
            <>
              <button className="gal-btn l" onClick={() => setImg((i) => (i - 1 + gallery.length) % gallery.length)}>
                <ChevronLeft />
              </button>
              <button className="gal-btn r" onClick={() => setImg((i) => (i + 1) % gallery.length)}>
                <ChevronRight />
              </button>
              <div className="gal-dots">
                {gallery.slice(0, 14).map((_, i) => (
                  <span key={i} className={i === img ? "on" : ""} onClick={() => setImg(i)} />
                ))}
              </div>
            </>
          )}
          {gallery.length > 0 && (
            <button className="iconbtn gal-full" onClick={() => setLb(true)} title="Full screen">
              <Maximize2 />
            </button>
          )}
          <button className="iconbtn drawer-close" onClick={onClose}>
            <X />
          </button>
        </div>
        {kind === "shader" && gallery.length > 1 && (
          <div className="gal-strip">
            {gallery.slice(0, 16).map((g, i) => (
              <img key={g.url} src={g.url} className={i === img ? "on" : ""} onClick={() => setImg(i)} loading="lazy" />
            ))}
          </div>
        )}
        <div className="drawer-body">
          <div className="dhead">
            {hit.icon_url ? <img className="dicon" src={hit.icon_url} /> : <span className="dicon mletter">{hit.title[0]}</span>}
            <div>
              <h2>{hit.title}</h2>
              <div className="muted">by {data?.authors?.length ? data.authors.slice(0, 3).join(", ") : hit.author}</div>
            </div>
            <span className="dhead-heart">
              <HeartBtn hit={hit} kind={kind} />
            </span>
          </div>
          <div className="dstats">
            <span>
              <Download size={13} /> {fmtNum(hit.downloads)}
            </span>
            <span>
              <Heart size={13} /> {fmtNum(hit.follows)}
            </span>
            <span>Updated {fmtAgo(Date.parse(hit.date_modified))}</span>
            <Badges hit={hit} kind={kind} />
          </div>
          <p className="dsum">{hit.description}</p>
          {kind === "modpack" ? (
            data ? (
              data.versions[0] ? (
                <ModpackDetails src={{ version_id: data.versions[0].id }} title={hit.title} icon={hit.icon_url} />
              ) : (
                <div className="dnote err">This modpack has no versions to install.</div>
              )
            ) : (
              !err && <div className="skeleton" style={{ height: 160, marginTop: 12, borderRadius: 12 }} />
            )
          ) : (
            <>
              <div className="dinstall">
                {(installed && kind === "mod") || (done && kind !== "datapack") ? (
                  <button className="btn done" disabled>
                    <Check /> {kind === "resourcepack" ? "Downloaded" : "Installed"}
                  </button>
                ) : (
                  <button ref={btn} className="btn primary big" onClick={() => (kind === "datapack" ? setPicking(true) : install())} disabled={installing || !compatible || !data}>
                    {installing ? <Loader2 className="spin" /> : kind === "datapack" ? <Globe2 /> : <Download />}
                    {installing ? "Installing…" : !data ? "Checking versions…" : compatible ? `${INSTALL_WORD[kind]} ${kind === "datapack" ? "" : (data.versions[0]?.version_number ?? "")}` : `Nothing for ${mc} yet`}
                  </button>
                )}
                <button className="btn ghost" onClick={() => api.openUrl(url)}>
                  <ExternalLink /> Modrinth
                </button>
              </div>
              <AnimatePresence>{picking && <WorldPicker inst={inst} onPick={(w) => install(w)} onClose={() => setPicking(false)} />}</AnimatePresence>
              {doneWorlds.length > 0 && (
                <div className="dnote okline">
                  <Check size={13} /> Added to {doneWorlds.join(", ")}. Pick another world to add it there too.
                </div>
              )}
              {done && kind === "mod" && done.length > 1 && <div className="dnote">Also added what it needs: {done.slice(1).join(", ")}</div>}
              <div className="dnote">
                <ShieldCheck size={13} />{" "}
                {kind === "mod"
                  ? "Your mods folder is backed up before anything is added."
                  : kind === "shader"
                    ? "If Iris or Sodium is missing, Mio adds them (mods backed up first). The shader becomes your Shaders mode pack."
                    : kind === "resourcepack"
                      ? "Just downloads it. Turn it on under Installed, Resource packs, or in the game's menu."
                      : "Goes into one world's datapacks folder. It starts working next time you open that world."}
              </div>
              {kind === "mod" && loader === "vanilla" && <div className="dnote err">This instance has no mod loader, so mods can't run in it.</div>}
            </>
          )}
          {err && <div className="dnote err">{err}</div>}
          {data?.project?.body ? <MiniMarkdown text={data.project.body} /> : !err && kind !== "modpack" && <div className="skeleton" style={{ height: 200, marginTop: 16 }} />}
        </div>
      </motion.div>
      <AnimatePresence>{lb && gallery.length > 0 && <Lightbox images={gallery} start={img} onClose={() => setLb(false)} />}</AnimatePresence>
    </motion.div>
  );
}

// ---------------------------------------------------------------- the store

export default function Store({ inst, loader, mc }: { inst: string; loader: string; mc: string }) {
  const kind = useStore((s) => s.storeKind);
  const storeQuery = useStore((s) => s.storeQuery);
  const [q, setQ] = useState(storeQuery ?? "");
  const [sort, setSort] = useState("relevance");
  const [chips, setChips] = useState<Record<string, string>>({});
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<{ hit: SearchHit; kind: Kind } | null>(null);
  const [have, setHave] = useState<Set<string>>(new Set());
  const saved = useSaved((s) => s.items);
  const seq = useRef(0);
  const refreshHave = () =>
    api
      .mods(inst)
      .then((ms) => setHave(new Set(ms.map((m) => m.modrinth?.project_id).filter(Boolean) as string[])))
      .catch(() => {});
  useEffect(() => {
    refreshHave();
    loadSaved();
    if (storeQuery) useStore.setState({ storeQuery: null, storeKind: "mod" });
  }, [inst]);
  const setKind = (k: Tab) => {
    sfx.click();
    useStore.setState({ storeKind: k });
    setChips({});
    setQ("");
    setSort("relevance");
  };
  // any switch of type (tabs, "Find more" buttons) starts a fresh search
  const firstKind = useRef(true);
  useEffect(() => {
    if (firstKind.current) {
      firstKind.current = false;
      return;
    }
    setChips({});
    setQ("");
    setSort("relevance");
  }, [kind]);
  const tab: Tab = kind;
  const realKind = kind as Kind;
  const filters = useMemo(() => {
    if (tab === "saved") return [];
    const groups = CHIPS[realKind] ?? [];
    return groups.map((g) => g.chips.find((c) => c[0] === chips[g.id])?.[2].map((t) => `categories:${t}`) ?? []).filter((x) => x.length);
  }, [chips, tab]);
  const searching = tab !== "saved" && (q.trim().length > 0 || filters.length > 0);
  useEffect(() => {
    if (!searching) return;
    const n = ++seq.current;
    setErr(null);
    const t = setTimeout(
      () => {
        setHits(null);
        api
          .store2Search(inst, realKind, q, 0, 24, sort === "relevance" && !q.trim() ? "downloads" : sort, filters)
          .then((r) => {
            if (n !== seq.current) return;
            setHits(r.hits);
            setTotal(r.total_hits);
          })
          .catch((e) => n === seq.current && setErr(errText(e)));
      },
      q ? 280 : 0,
    );
    return () => clearTimeout(t);
  }, [q, sort, filters, inst, tab, searching]);
  const more = async () => {
    if (!hits) return;
    setLoadingMore(true);
    try {
      const r = await api.store2Search(inst, realKind, q, hits.length, 24, sort === "relevance" && !q.trim() ? "downloads" : sort, filters);
      setHits([...hits, ...r.hits.filter((h) => !hits.find((x) => x.project_id === h.project_id))]);
    } catch (e) {
      setErr(errText(e));
    }
    setLoadingMore(false);
  };
  const openHit = (h: SearchHit, k: Kind) => setOpen({ hit: h, kind: k });
  const placeholder = tab === "saved" ? "" : realKind === "mod" ? `Search mods for ${loaderName(loader)} ${mc}` : `Search ${NOUN[realKind]}`;
  return (
    <div className="store">
      <div className="kindbar">
        {KINDS.map((k) => (
          <button key={k.k} className={"kind" + (tab === k.k ? " on" : "")} onClick={() => setKind(k.k)}>
            {tab === k.k && <motion.span layoutId="kindpill" className="kind-bg" transition={{ type: "spring", stiffness: 480, damping: 38 }} />}
            <k.icon size={15} />
            <span>{k.label}</span>
            {k.k === "saved" && saved.length > 0 && <em>{saved.length}</em>}
          </button>
        ))}
      </div>
      <AnimatePresence mode="wait">
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }}>
          {tab === "saved" ? (
            <>
              {saved.length === 0 ? (
                <div className="empty-big">
                  <Heart size={30} />
                  <h3>Nothing saved yet</h3>
                  <p>Tap the heart on anything in the store to keep it here for later.</p>
                </div>
              ) : (
                <div className="storegrid">
                  {saved.map((h, i) => {
                    const k = kindOf(h);
                    return <StoreCard key={h.project_id} hit={h} kind={k} mc={mc} compat={isCompatible(h, k, mc, loader)} installed={have.has(h.project_id)} i={i} onOpen={() => openHit(h, k)} />;
                  })}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="toolbar">
                <div className="search big">
                  <Search size={16} />
                  <input placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
                  {q && (
                    <button className="iconbtn sm clear" onClick={() => setQ("")}>
                      <X />
                    </button>
                  )}
                </div>
                {searching && (
                  <div className="seg">
                    {[
                      ["relevance", q.trim() ? "Best match" : "Popular"],
                      ["follows", "Most loved"],
                      ["updated", "Updated"],
                      ["newest", "New"],
                    ].map(([k, l]) => (
                      <button key={k} className={sort === k ? "on" : ""} onClick={() => setSort(k)}>
                        {l}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {(CHIPS[realKind] ?? []).map((g) => (
                <div className="chips" key={g.id}>
                  {g.label && <span className="chips-label">{g.label}</span>}
                  {g.chips.map(([k, l]) => (
                    <button
                      key={k}
                      className={"chip" + (chips[g.id] === k ? " on" : "")}
                      onClick={() => {
                        sfx.click();
                        setChips((c) => ({ ...c, [g.id]: c[g.id] === k ? "" : k }));
                      }}
                    >
                      {chips[g.id] === k && <motion.span layoutId={`chip-${g.id}`} className="chip-bg" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
                      <span>{l}</span>
                    </button>
                  ))}
                </div>
              ))}
              {realKind === "mod" && loader === "vanilla" && <div className="dnote err">This instance has no mod loader, so mods won't run in it. Resource packs, shaders and datapacks still work.</div>}
              {err && <div className="dnote err">{err}</div>}
              {searching ? (
                <>
                  <div className={"storegrid" + (realKind === "shader" ? " wide" : "")}>
                    {!hits && !err && Array.from({ length: 12 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 228, borderRadius: 12 }} />)}
                    {hits?.map((h, i) => (
                      <StoreCard key={h.project_id} hit={h} kind={realKind} mc={mc} compat={isCompatible(h, realKind, mc, loader)} installed={have.has(h.project_id)} i={i} onOpen={() => openHit(h, realKind)} wide={realKind === "shader"} />
                    ))}
                  </div>
                  {hits && hits.length === 0 && <div className="empty-big">Nothing matches that yet.</div>}
                  {hits && hits.length < total && (
                    <div className="more">
                      <button className="btn" onClick={more} disabled={loadingMore}>
                        {loadingMore ? <Loader2 className="spin" /> : null} Show more
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="shelves">
                  {shelves(realKind, mc, loader).map((s, i) => (
                    <ShelfRow key={realKind + s.title} inst={inst} kind={realKind} shelf={s} mc={mc} loader={loader} have={have} onOpen={(h) => openHit(h, realKind)} index={i} />
                  ))}
                </div>
              )}
            </>
          )}
        </motion.div>
      </AnimatePresence>
      <AnimatePresence>
        {open && (
          <ProjectDrawer key={open.hit.project_id} inst={inst} mc={mc} loader={loader} hit={open.hit} kind={open.kind} installed={have.has(open.hit.project_id)} onClose={() => setOpen(null)} onInstalled={refreshHave} />
        )}
      </AnimatePresence>
    </div>
  );
}
