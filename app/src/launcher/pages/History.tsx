import { RecapList } from "../../tools/Recap";
import { useStore as useMain } from "../../store";
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CalendarDays, Clock, Flame, Gamepad2, Globe2, Server as ServerIcon, ScrollText } from "lucide-react";
import { api, fmtMinutes, fmtPlay, instIconUrl, type HistoryData, type Session } from "../api";
import { Ticker } from "../../ui";
import { tapi, type Recap } from "../../tools/tapi";
import { PlaytimeChart, HoursChart } from "./HistoryCharts";
import { sfx } from "../../sound";

const DAY = 86_400_000;
const WEEKS = 40;
const parse = (d: string) => {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(y, m - 1, dd);
};
const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default function History() {
  const openRecap = useMain((s) => s.openRecap);
  const [h, setH] = useState<HistoryData | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<{ k: string; x: number; y: number } | null>(null);
  const [recaps, setRecaps] = useState<Recap[]>([]);
  useEffect(() => {
    api
      .history()
      .then(setH)
      .catch(() => {});
    tapi
      .recaps()
      .then((x) => setRecaps(x.recaps))
      .catch(() => {});
  }, []);
  /** The after-game recap made when this session ended (within 20 minutes of its end). */
  const recapOf = (s: Session): Recap | null => {
    const [hh, mm] = s.start.split(":").map(Number);
    if (Number.isNaN(hh)) return null;
    const start = parse(s.date).getTime() + (hh * 60 + (mm || 0)) * 60_000;
    const end = start + s.minutes * 60_000;
    return recaps.find((r) => r.t >= start && r.t <= end + 20 * 60_000) ?? null;
  };

  const byDay = useMemo(() => {
    const m = new Map<string, Session[]>();
    for (const s of h?.sessions ?? []) m.set(s.date, [...(m.get(s.date) ?? []), s]);
    return m;
  }, [h]);
  const minutesOf = (k: string) => (byDay.get(k) ?? []).reduce((a, s) => a + s.minutes, 0);

  const weeks = useMemo(() => {
    if (!h) return [];
    const today = parse(h.today);
    const end = new Date(today);
    end.setDate(end.getDate() + (6 - end.getDay()));
    const start = new Date(end.getTime() - (WEEKS * 7 - 1) * DAY);
    const out: { k: string; d: Date; future: boolean }[][] = [];
    for (let w = 0; w < WEEKS; w++) {
      const col = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + w * 7 + i);
        col.push({ k: key(d), d, future: d > today });
      }
      out.push(col);
    }
    return out;
  }, [h]);

  const stats = useMemo(() => {
    if (!h) return null;
    const today = parse(h.today);
    const total = h.instances.reduce((a, i) => a + i.total, 0);
    let week = 0;
    for (let i = 0; i < 7; i++) week += minutesOf(key(new Date(today.getTime() - i * DAY)));
    // streaks
    let best = 0,
      run = 0,
      current = 0;
    const days = [...byDay.keys()].sort();
    if (days.length) {
      let d = parse(days[0]);
      while (d <= today) {
        if (byDay.has(key(d))) {
          run++;
          best = Math.max(best, run);
        } else run = 0;
        d = new Date(d.getTime() + DAY);
      }
      // current streak: counting back from today (or yesterday)
      let c = new Date(today);
      if (!byDay.has(key(c))) c = new Date(c.getTime() - DAY);
      while (byDay.has(key(c))) {
        current++;
        c = new Date(c.getTime() - DAY);
      }
    }
    const max = Math.max(1, ...[...byDay.keys()].map(minutesOf));
    return { total, week, best, current, max, sessions: h.sessions.length };
  }, [h, byDay]);

  const level = (m: number) => (m <= 0 ? 0 : !stats ? 1 : m < stats.max * 0.15 ? 1 : m < stats.max * 0.35 ? 2 : m < stats.max * 0.65 ? 3 : 4);
  const months = useMemo(() => {
    const out: { label: string; col: number }[] = [];
    weeks.forEach((w, i) => {
      const first = w.find((c) => c.d.getDate() <= 7 && c.d.getDate() >= 1 && c.d.getDay() === 0) ?? (i === 0 ? w[0] : null);
      if (first && (!out.length || out[out.length - 1].label !== first.d.toLocaleDateString(undefined, { month: "short" }))) out.push({ label: first.d.toLocaleDateString(undefined, { month: "short" }), col: i });
    });
    return out;
  }, [weeks]);

  if (!h || !stats)
    return (
      <div className="page page-pad">
        <div className="skeleton" style={{ height: 120, marginBottom: 16 }} />
        <div className="skeleton" style={{ height: 200 }} />
      </div>
    );

  const instMax = Math.max(1, ...h.instances.map((i) => i.total));
  const worlds = h.worlds.filter((w) => w.ticks > 0).slice(0, 8);
  const worldMax = Math.max(1, ...worlds.map((w) => w.ticks));
  const selSessions = sel ? (byDay.get(sel) ?? []) : h.sessions.slice(0, 12);
  const instName = (id: string) => h.instances.find((i) => i.id === id)?.name ?? id;

  return (
    <div className="page page-pad history-page">
      <div className="page-head">
        <div>
          <h1>Play history</h1>
          <p className="muted">Read from your game logs, so it covers every session, even before Mio existed.</p>
        </div>
      </div>
      <div className="hstats">
        {[
          { icon: Clock, v: Math.round(stats.total / 3600), unit: "h", k: "played in total" },
          { icon: CalendarDays, v: Math.round((stats.week / 60) * 10) / 10, unit: "h", k: "in the last 7 days", digits: 1 },
          { icon: Flame, v: stats.current, unit: stats.current === 1 ? "day" : "days", k: `streak now · best ${stats.best}` },
          { icon: Gamepad2, v: stats.sessions, unit: "", k: "sessions" },
        ].map((s, i) => (
          <motion.div key={i} className="hstat" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}>
            <s.icon size={16} />
            <div className="v">
              <Ticker value={s.v} digits={s.digits ?? 0} />
              <span className="unit">{s.unit}</span>
            </div>
            <div className="k">{s.k}</div>
          </motion.div>
        ))}
      </div>

      <div className="hc-row">
        <PlaytimeChart h={h} />
        <HoursChart h={h} />
      </div>

      <div className="panel heat-panel">
        <div className="panel-title">
          <CalendarDays size={14} /> Last nine months
          <span className="r muted small">{sel ? <button className="iconlink" onClick={() => setSel(null)}>Show recent sessions</button> : "Click a day to see it"}</span>
        </div>
        <div className="heat-wrap" style={{ ["--weeks" as any]: WEEKS }}>
          <div className="heat-months">
            {months.map((m) => (
              <span key={m.label + m.col} style={{ gridColumn: m.col + 2 }}>
                {m.label}
              </span>
            ))}
          </div>
          <div className="heat">
            {["Mon", "Wed", "Fri"].map((d, i) => (
              <span key={d} className="heat-day" style={{ gridColumn: 1, gridRow: i * 2 + 2 }}>
                {d}
              </span>
            ))}
            {weeks.map((w, wi) =>
              w.map((c, di) => {
                const m = minutesOf(c.k);
                return (
                  <motion.button
                    key={c.k}
                    className={"cell l" + level(m) + (c.future ? " future" : "") + (sel === c.k ? " sel" : "") + (c.k === h.today ? " today" : "")}
                    style={{ gridColumn: wi + 2, gridRow: di + 1 }}
                    initial={{ opacity: 0, scale: 0.4 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.15 + (wi + di) * 0.01, duration: 0.25 }}
                    onClick={() => !c.future && setSel(sel === c.k ? null : c.k)}
                    onMouseEnter={(e) => {
                      const r = (e.target as HTMLElement).getBoundingClientRect();
                      setHover({ k: c.k, x: r.left + r.width / 2, y: r.top });
                    }}
                    onMouseLeave={() => setHover(null)}
                  />
                );
              }),
            )}
          </div>
        </div>
        <div className="heat-legend">
          Less
          {[0, 1, 2, 3, 4].map((l) => (
            <i key={l} className={"cell l" + l} />
          ))}
          More
        </div>
      </div>

      <div className="hgrid">
        <div className="panel">
          <div className="panel-title">
            <Gamepad2 size={14} /> Instances
          </div>
          {h.instances
            .filter((i) => i.total > 0)
            .sort((a, b) => b.total - a.total)
            .map((i, n) => (
              <div key={i.id} className="hbar">
                <img src={instIconUrl(i.icon)} className="px" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
                <span className="t">
                  <b>{i.name}</b>
                  <span className="track">
                    <motion.i initial={{ width: 0 }} animate={{ width: `${(i.total / instMax) * 100}%` }} transition={{ delay: 0.2 + n * 0.06, duration: 0.8, ease: [0.22, 0.7, 0.18, 1] }} />
                  </span>
                </span>
                <span className="hv">{fmtPlay(i.total)}</span>
              </div>
            ))}
          <div className="panel-title" style={{ marginTop: 18 }}>
            <Globe2 size={14} /> Worlds
          </div>
          {worlds.length === 0 && <div className="muted small">No world stats yet.</div>}
          {worlds.map((w, n) => (
            <div key={w.instance + w.world} className="hbar">
              <span className="t">
                <b>
                  {w.name} <em className="muted">{instName(w.instance)}</em>
                </b>
                <span className="track">
                  <motion.i initial={{ width: 0 }} animate={{ width: `${(w.ticks / worldMax) * 100}%` }} transition={{ delay: 0.3 + n * 0.06, duration: 0.8, ease: [0.22, 0.7, 0.18, 1] }} />
                </span>
              </span>
              <span className="hv">{fmtPlay(w.ticks / 20)}</span>
            </div>
          ))}
        </div>
        <div className="panel">
          <div className="panel-title">
            <Clock size={14} /> {sel ? parse(sel).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) : "Recent sessions"}
          </div>
          <AnimatePresence mode="wait">
            <motion.div key={sel ?? "recent"} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
              {selSessions.length === 0 && <div className="muted small">No play that day.</div>}
              {selSessions.map((s, i) => (
                <div key={i} className="sess">
                  <span className="sess-time">
                    <b>{s.start}</b>
                    {!sel && <i>{parse(s.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</i>}
                  </span>
                  <span className="sess-dot">{s.server ? <ServerIcon size={12} /> : <Globe2 size={12} />}</span>
                  <span className="t">
                    <b>{s.place ?? "Main menu only"}</b>
                    <i>{instName(s.instance)}</i>
                  </span>
                  {(() => {
                    const r = recapOf(s);
                    return (
                      r && (
                        <button
                          className="iconlink sess-recap"
                          title={r.headline || "See the recap of this session"}
                          onClick={() => {
                            sfx.click();
                            useMain.setState({ openRecap: r.id });
                          }}
                        >
                          <ScrollText size={13} /> Recap
                        </button>
                      )
                    );
                  })()}
                  <span className="hv">{fmtMinutes(s.minutes)}</span>
                </div>
              ))}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
      <RecapList highlight={openRecap} />
      {hover && (
        <div className="heat-tip" style={{ left: hover.x, top: hover.y }}>
          <b>{minutesOf(hover.k) ? fmtMinutes(minutesOf(hover.k)) : "No play"}</b>
          <span>{parse(hover.k).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>
        </div>
      )}
    </div>
  );
}
