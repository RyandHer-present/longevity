// The after-game recap: a card that slides in at the bottom-right of the desktop when you stop
// playing and stays until you click it, plus the saved list of every recap on the History page.
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, Footprints, Pickaxe, Swords, Skull, Award, Target, Sparkles, Clock3 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { ItemIcon } from "../ui";
import { applyTheme } from "../store";
import { api } from "../api";
import { tapi, type Recap } from "./tapi";

function fmtMin(m: number) {
  if (m < 60) return `${Math.max(1, Math.round(m))} min`;
  return `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;
}
function fmtM(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

export function RecapBody({ r, compact }: { r: Recap; compact?: boolean }) {
  const chips: { icon: typeof Pickaxe; text: string; item?: string }[] = [];
  if (r.distance_m > 20) chips.push({ icon: Footprints, text: fmtM(r.distance_m) });
  if (r.mined) chips.push({ icon: Pickaxe, text: `${r.mined.toLocaleString()} mined`, item: r.mined_top?.id });
  if (r.killed) chips.push({ icon: Swords, text: `${r.killed.toLocaleString()} killed`, item: r.killed_top ? r.killed_top.id + "_spawn_egg" : undefined });
  if (r.crafted) chips.push({ icon: Sparkles, text: `${r.crafted.toLocaleString()} crafted`, item: r.crafted_top?.id });
  if (r.deaths) chips.push({ icon: Skull, text: `${r.deaths} death${r.deaths === 1 ? "" : "s"}` });
  return (
    <>
      <div className="rc-head">
        <div className="rc-kicker">
          <Clock3 size={11} /> {fmtMin(r.minutes)} on {r.world} · Day {r.day.toLocaleString()}
          {r.crashed ? " · crashed" : ""}
        </div>
        <div className="rc-title">{r.headline}</div>
      </div>
      <div className="rc-chips">
        {chips.slice(0, compact ? 4 : 8).map((c, i) => (
          <span key={i}>
            {c.item ? <ItemIcon id={c.item} size={16} /> : <c.icon size={12} />} {c.text}
          </span>
        ))}
      </div>
      {(r.advancements.length > 0 || r.goals.length > 0 || r.new_cards > 0) && (
        <div className="rc-wins">
          {r.goals.map((g) => (
            <span key={g} className="gold">
              <Target size={11} /> {g} done
            </span>
          ))}
          {r.new_cards > 0 && (
            <span className="card">
              <Sparkles size={11} /> {r.new_cards} new Dex card{r.new_cards === 1 ? "" : "s"}
            </span>
          )}
          {r.advancements.slice(0, compact ? 2 : 10).map((a) => (
            <span key={a}>
              <Award size={11} /> {a}
            </span>
          ))}
          {compact && r.advancements.length > 2 && <span>+{r.advancements.length - 2} more</span>}
        </div>
      )}
      {!compact && r.lines.length > 0 && (
        <ul className="rc-lines">
          {r.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The little always-on-top window (index.html#recap). */
export function RecapWindow() {
  const [r, setR] = useState<Recap | null>(null);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    document.documentElement.classList.add("recap-win");
    api
      .appInfo()
      .then((i) => applyTheme(i.settings?.theme))
      .catch(() => {});
    tapi
      .recapLatest()
      .then(setR)
      .catch(() => {});
  }, []);
  async function open() {
    if (!r) return;
    setLeaving(true);
    await new Promise((res) => setTimeout(res, 260));
    invoke("t_recap_open", { id: r.id }).catch(() => {});
  }
  async function dismiss(e: React.MouseEvent) {
    e.stopPropagation();
    if (!r) return;
    setLeaving(true);
    await new Promise((res) => setTimeout(res, 260));
    tapi.recapSeen(r.id).catch(() => {});
  }
  return (
    <AnimatePresence>
      {r && !leaving && (
        <motion.div
          className="rc-card rc-float"
          onClick={open}
          initial={{ x: 430, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 430, opacity: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 28 }}
          title="Open in Longevity"
        >
          <button className="rc-x" onClick={dismiss} title="Dismiss">
            <X size={13} />
          </button>
          <RecapBody r={r} compact />
          <div className="rc-foot">Click to see it in Longevity</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Every saved recap, newest first (History page). */
export function RecapList({ highlight }: { highlight?: string | null }) {
  const [list, setList] = useState<Recap[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    tapi
      .recaps()
      .then((x) => setList(x.recaps))
      .catch(() => setList([]));
  }, []);
  useEffect(() => {
    if (highlight) document.getElementById("recap-" + highlight)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlight, list]);
  if (!list || list.length === 0) return null;
  const shown = all ? list : list.slice(0, 6);
  return (
    <div className="rc-list">
      <div className="panel-title">
        After-game recaps <span className="r num">{list.length}</span>
      </div>
      <div className="rc-grid">
        {shown.map((r, i) => (
          <motion.div
            key={r.id}
            id={"recap-" + r.id}
            className={"rc-card glass" + (r.id === highlight ? " hl" : "")}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i, 8) * 0.04 }}
          >
            <div className="rc-date">{new Date(r.t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
            <RecapBody r={r} />
          </motion.div>
        ))}
      </div>
      {list.length > 6 && (
        <button className="btn ghost sm" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${list.length}`}
        </button>
      )}
    </div>
  );
}
