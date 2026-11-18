import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Images, Copy, FolderOpen, Trash2, ChevronLeft, ChevronRight, X, MapPin, Wand2, Box } from "lucide-react";
import { api, errText, fmtBytes, shotUrl, thumbUrl, type Shot } from "../api";
import { useStore } from "../store";
import { useStore as useMain } from "../../store";
import { tapi, type ShotTag } from "../../tools/tapi";
import { sfx } from "../../sound";
import ShotEditor from "./ShotEditor";

const prettyBiome = (b: string) =>
  (b.split(":").pop() ?? b)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
const timeOfDay = (t: number) => (t < 5000 ? "morning" : t < 9000 ? "midday" : t < 12000 ? "afternoon" : t < 13500 ? "sunset" : t < 22500 ? "night" : "sunrise");
/** The companion's note of where a screenshot was taken (edited copies share their original's). */
export function tagOf(tags: Record<string, ShotTag>, s: Shot): ShotTag | null {
  const t = tags[s.file] ?? tags[s.file.replace(/_edit\d*\.png$/, ".png")];
  return t && (!t.world || t.world.includes(s.instance)) ? t : null;
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

export default function Shots() {
  const [shots, setShots] = useState<Shot[] | null>(null);
  const [inst, setInst] = useState<string>("all");
  const [open, setOpen] = useState<number | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [tags, setTags] = useState<Record<string, ShotTag>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [onlyTagged, setOnlyTagged] = useState(false);
  const toast = useStore((s) => s.toast);
  const reload = () =>
    api
      .shots()
      .then((l) => (setShots(l), l))
      .catch(() => (setShots([]), [] as Shot[]));
  useEffect(() => {
    reload().then((l) => {
      // opened from a camera marker in the 3D world
      const want = useMain.getState().openShot;
      if (want) {
        useMain.setState({ openShot: null });
        const i = l.findIndex((s) => s.key === want);
        if (i >= 0) {
          setInst("all");
          setOpen(i);
        }
      }
    });
    tapi
      .shotTags()
      .then(setTags)
      .catch(() => {});
  }, []);
  const insts = useMemo(() => {
    const m = new Map<string, { name: string; n: number }>();
    for (const s of shots ?? []) m.set(s.instance, { name: s.instance_name, n: (m.get(s.instance)?.n ?? 0) + 1 });
    return [...m.entries()];
  }, [shots]);
  const shown = useMemo(() => (shots ?? []).filter((s) => (inst === "all" || s.instance === inst) && (!onlyTagged || tagOf(tags, s))), [shots, inst, onlyTagged, tags]);
  const nTagged = useMemo(() => (shots ?? []).filter((s) => tagOf(tags, s)).length, [shots, tags]);
  const groups = useMemo(() => {
    const out: { label: string; items: { s: Shot; i: number }[] }[] = [];
    shown.forEach((s, i) => {
      const l = dayLabel(s.time);
      if (!out.length || out[out.length - 1].label !== l) out.push({ label: l, items: [] });
      out[out.length - 1].items.push({ s, i });
    });
    return out;
  }, [shown]);
  const cur = open !== null ? shown[open] : null;
  const curTag = cur ? tagOf(tags, cur) : null;
  const showIn3D = (t: ShotTag) => {
    sfx.nav();
    setOpen(null);
    useMain.getState().flyTo({ x: t.pos[0], y: t.pos[1], z: t.pos[2], dim: t.dim, label: "Screenshot" });
  };

  useEffect(() => {
    if (open === null) return;
    setConfirmDel(false);
    const k = (e: KeyboardEvent) => {
      if (editing) return;
      if (e.key === "Escape") setOpen(null);
      if (e.key === "ArrowRight") setOpen((o) => (o === null ? o : Math.min(shown.length - 1, o + 1)));
      if (e.key === "ArrowLeft") setOpen((o) => (o === null ? o : Math.max(0, o - 1)));
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, shown.length, editing]);

  const copy = async () => {
    if (!cur) return;
    try {
      await api.shotCopy(cur.key);
      sfx.shutter();
      toast("Copied. Paste it into Discord or anywhere.", "ok");
    } catch (e) {
      toast(errText(e), "err");
    }
  };
  const del = async () => {
    if (!cur) return;
    try {
      await api.shotDelete(cur.key);
      const key = cur.key;
      setShots((s) => s?.filter((x) => x.key !== key) ?? null);
      toast("Moved to the Recycle Bin", "ok");
      if (shown.length <= 1) setOpen(null);
      else setOpen((o) => (o === null ? null : Math.min(o, shown.length - 2)));
    } catch (e) {
      toast(errText(e), "err");
    }
  };

  return (
    <div className="page page-pad shots-page">
      <div className="page-head">
        <div>
          <h1>Screenshots</h1>
          <p className="muted">Every F2 from every instance, newest first. Pins show where the companion saw you take them.</p>
        </div>
        {nTagged > 0 && (
          <button className={"chip" + (onlyTagged ? " on" : "")} onClick={() => (sfx.click(), setOnlyTagged(!onlyTagged))} title="Only screenshots with a place">
            <MapPin size={12} /> With a place {nTagged}
          </button>
        )}
        {insts.length > 1 && (
          <div className="seg">
            <button className={inst === "all" ? "on" : ""} onClick={() => setInst("all")}>
              All {shots?.length}
            </button>
            {insts.map(([id, v]) => (
              <button key={id} className={inst === id ? "on" : ""} onClick={() => setInst(id)}>
                {v.name} {v.n}
              </button>
            ))}
          </div>
        )}
      </div>
      {!shots && (
        <div className="shotgrid">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ aspectRatio: "16/9" }} />
          ))}
        </div>
      )}
      {shots && shots.length === 0 && (
        <div className="empty-big">
          <Images size={30} />
          <h3>No screenshots yet</h3>
          <p>Press F2 in game and they show up here.</p>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.label} className="shotday">
          <h4>
            {g.label}
            <span>{g.items.length}</span>
          </h4>
          <div className="shotgrid">
            {g.items.map(({ s, i }) => (
              <motion.button
                key={s.key}
                layoutId={"shot-" + s.key}
                className="shot"
                onClick={() => {
                  sfx.click();
                  setOpen(i);
                }}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i, 24) * 0.02 }}
                whileHover={{ scale: 1.025 }}
              >
                <img src={thumbUrl(s.key, 480)} loading="lazy" />
                {(() => {
                  const t = tagOf(tags, s);
                  return (
                    t && (
                      <span className="shot-where">
                        <MapPin size={10} /> {prettyBiome(t.biome)} · Day {t.day}
                      </span>
                    )
                  );
                })()}
                <span className="shot-cap">
                  {new Date(s.time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                  {inst === "all" && insts.length > 1 && <em>{s.instance_name}</em>}
                </span>
              </motion.button>
            ))}
          </div>
        </section>
      ))}

      <AnimatePresence>
        {cur && (
          <motion.div className="lightbox" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && setOpen(null)}>
            <motion.div className="lb-frame" layoutId={"shot-" + cur.key} transition={{ type: "spring", stiffness: 320, damping: 34 }}>
              <img src={thumbUrl(cur.key, 1280)} className="lb-low" />
              <img src={shotUrl(cur.key)} className="lb-full" onLoad={(e) => ((e.target as HTMLImageElement).style.opacity = "1")} />
            </motion.div>
            <button className="lb-nav l" onClick={() => setOpen(Math.max(0, open! - 1))} disabled={open === 0}>
              <ChevronLeft />
            </button>
            <button className="lb-nav r" onClick={() => setOpen(Math.min(shown.length - 1, open! + 1))} disabled={open === shown.length - 1}>
              <ChevronRight />
            </button>
            <motion.div className="lb-bar glass" initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }} transition={{ delay: 0.1 }}>
              <span className="t">
                <b>{new Date(cur.time).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</b>
                <i>
                  {cur.instance_name} · {fmtBytes(cur.size)} · {open! + 1} of {shown.length}
                </i>
                {curTag && (
                  <i className="lb-where">
                    <MapPin size={11} /> {prettyBiome(curTag.biome)} · {curTag.pos.join(", ")} · Day {curTag.day}, {timeOfDay(curTag.time)}
                    {curTag.dim.includes("nether") ? " · Nether" : curTag.dim.includes("end") ? " · The End" : ""}
                  </i>
                )}
              </span>
              {curTag && (
                <button className="btn sm" onClick={() => showIn3D(curTag)} title="Fly there in the 3D world">
                  <Box /> Show in 3D
                </button>
              )}
              <button className="btn sm" onClick={() => (sfx.open(), setEditing(cur.key))}>
                <Wand2 /> Edit
              </button>
              <button className="btn sm primary" onClick={copy}>
                <Copy /> Copy
              </button>
              <button className="btn sm" onClick={() => api.shotReveal(cur.key)}>
                <FolderOpen /> Show
              </button>
              {confirmDel ? (
                <button className="btn sm danger" onClick={del}>
                  Really delete?
                </button>
              ) : (
                <button className="iconbtn" onClick={() => setConfirmDel(true)} title="Delete">
                  <Trash2 />
                </button>
              )}
              <button className="iconbtn" onClick={() => setOpen(null)}>
                <X />
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {editing && (
          <ShotEditor
            key={editing}
            shotKey={editing}
            onClose={() => setEditing(null)}
            onSaved={async (k) => {
              setEditing(null);
              const l = await reload();
              const i = l.filter((s) => inst === "all" || s.instance === inst).findIndex((s) => s.key === k);
              if (i >= 0) setOpen(i);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
