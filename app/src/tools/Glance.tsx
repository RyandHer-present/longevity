// Home's "world at a glance": day and time played, what your farms make, your streak and Dex %,
// and progress on pinned goals.
import { useEffect, useState } from "react";
import { Flame, Sprout, Target, Clock3, BookOpen } from "lucide-react";
import { useStore } from "../store";
import { ItemIcon } from "../ui";
import { api } from "../api";
import { api as lapi } from "../launcher/api";
import { tapi, fmtRate, type Glance as G } from "./tapi";

export function streakOf(dates: string[], today: string) {
  const set = new Set(dates);
  const day = (s: string) => Math.round(Date.parse(s + "T00:00:00Z") / 86400000);
  const t = day(today);
  let cur = 0;
  // a streak still counts if you haven't played yet today
  let d = set.has(today) ? t : t - 1;
  while (set.has(new Date(d * 86400000).toISOString().slice(0, 10))) {
    cur++;
    d--;
  }
  const sorted = [...set].map(day).sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  for (let i = 0; i < sorted.length; i++) {
    run = i && sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return { current: cur, best, playedToday: set.has(today) };
}

export default function Glance() {
  const world = useStore((s) => s.world);
  const setPage = useStore((s) => s.setPage);
  const [g, setG] = useState<G | null>(null);
  const [streak, setStreak] = useState<{ current: number; best: number; playedToday: boolean } | null>(null);
  const [dex, setDex] = useState<number | null>(null);

  useEffect(() => {
    if (!world) return;
    tapi.glance().then(setG).catch(() => {});
    lapi
      .history()
      .then((h) => {
        const lt = h.instances.find((i) => /longterm/i.test(i.name) || /longterm/i.test(i.id));
        const dates = h.sessions.filter((s) => s.minutes >= 5 && (!lt || s.instance === lt.id)).map((s) => s.date);
        setStreak(streakOf(dates, h.today));
      })
      .catch(() => {});
    api
      .dex()
      .then((d) => {
        // every card kind with a fixed total (pets and deaths aren't "collectable")
        const all = [...d.mobs, ...d.biomes, ...d.blocks, ...d.advancements, ...d.discs, ...d.variants, ...(d.items ?? []), ...(d.enchants ?? []), ...(d.trims ?? [])];
        if (all.length) setDex(all.filter((c) => c.unlocked).length / all.length);
      })
      .catch(() => {});
  }, [world?.path]);

  if (!world || !g) return null;
  const hours = g.play_ticks / 72000;
  const pinned = g.projects.filter((p) => p.pinned && (p.progress ?? 0) < 1).slice(0, 3);
  return (
    <div className="glass hcard glance">
      <div className="panel-title">At a glance</div>
      <div className="gl-grid">
        <div className="gl-cell">
          <Clock3 size={14} />
          <b>Day {g.day.toLocaleString()}</b>
          <span>{hours >= 1 ? `${Math.floor(hours)} h ${Math.round((hours % 1) * 60)} m played` : `${Math.round(hours * 60)} min played`}</span>
        </div>
        <div className="gl-cell" onClick={() => setPage("history")}>
          <Flame size={14} className={streak?.current ? "hot" : ""} />
          <b>{streak ? `${streak.current}-day streak` : "Streak"}</b>
          <span>{streak ? (streak.playedToday ? "played today" : streak.current ? "play today to keep it" : `best ${streak.best} days`) : ""}</span>
        </div>
        <div className="gl-cell" onClick={() => setPage("dex")}>
          <BookOpen size={14} />
          <b>{dex !== null ? `${Math.round(dex * 100)}% of the Dex` : "Dex"}</b>
          <span>cards collected</span>
        </div>
        <div className="gl-cell" onClick={() => setPage("farms")}>
          <Sprout size={14} />
          <b>
            {g.farm_count} farm{g.farm_count === 1 ? "" : "s"}
          </b>
          <span>{g.farm_top.length ? "per hour of play" : "none found yet"}</span>
        </div>
      </div>
      {g.farm_top.length > 0 && (
        <div className="gl-farms" onClick={() => setPage("farms")}>
          {g.farm_top.map((f) => (
            <span key={f.id} title={f.name}>
              <ItemIcon id={f.id} size={18} />
              <b>{fmtRate(f.per_hour)}</b>
            </span>
          ))}
        </div>
      )}
      {pinned.length > 0 && (
        <div className="gl-goals" onClick={() => setPage("projects")}>
          {pinned.map((p) => (
            <div key={p.id} className="gl-goal">
              <div className="gl-gtop">
                <Target size={12} /> {p.name}
                <span>{Math.round((p.progress ?? 0) * 100)}%</span>
              </div>
              <div className="pbar">
                <i style={{ width: `${Math.round((p.progress ?? 0) * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
