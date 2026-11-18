// Play history charts: playtime per week/month split LongTerm / astera / everything else,
// and when in the day you play. Colours follow the instance (never its rank) and pass the
// colour-blind checks on every theme's panel.
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { BarChart3, Sun, Table2 } from "lucide-react";
import { fmtMinutes, type HistoryData } from "../api";

const SERIES = [
  { id: "longterm", name: "LongTerm", color: "#3987e5" },
  { id: "astera", name: "astera", color: "#d95926" },
  { id: "other", name: "Other instances", color: "#199e70" },
] as const;
type SeriesId = (typeof SERIES)[number]["id"];

const parse = (d: string) => {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(y, m - 1, dd);
};
/** A tidy axis: 0..max in 3-5 steps of 1/2/5 x 10^n hours (values in minutes). */
function ticks(maxMin: number): number[] {
  const h = Math.max(1, maxMin / 60);
  const raw = h / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= h + step * 0.999; v += step) out.push(Math.round(v * 60));
  return out;
}
const hrs = (m: number) => (m >= 60 ? `${Math.round((m / 60) * 10) / 10}h` : m ? `${Math.round(m)}m` : "0");

export function PlaytimeChart({ h }: { h: HistoryData }) {
  const [unit, setUnit] = useState<"week" | "month">("week");
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  const buckets = useMemo(() => {
    const seriesOf = (inst: string): SeriesId => {
      const n = (h.instances.find((i) => i.id === inst)?.name ?? inst).toLowerCase();
      return n === "longterm" ? "longterm" : n === "astera" ? "astera" : "other";
    };
    const today = parse(h.today);
    const out: { label: string; long: string; start: number; end: number; v: Record<SeriesId, number> }[] = [];
    if (unit === "week") {
      const sun = new Date(today);
      sun.setDate(today.getDate() - today.getDay());
      for (let i = 15; i >= 0; i--) {
        const s = new Date(sun);
        s.setDate(sun.getDate() - i * 7);
        const e = new Date(s);
        e.setDate(s.getDate() + 7);
        out.push({
          label: s.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
          long: `Week of ${s.toLocaleDateString(undefined, { month: "long", day: "numeric" })}`,
          start: s.getTime(),
          end: e.getTime(),
          v: { longterm: 0, astera: 0, other: 0 },
        });
      }
    } else {
      for (let i = 11; i >= 0; i--) {
        const s = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const e = new Date(today.getFullYear(), today.getMonth() - i + 1, 1);
        out.push({
          label: s.toLocaleDateString(undefined, { month: "short" }),
          long: s.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
          start: s.getTime(),
          end: e.getTime(),
          v: { longterm: 0, astera: 0, other: 0 },
        });
      }
    }
    for (const s of h.sessions) {
      const t = parse(s.date).getTime();
      const b = out.find((x) => t >= x.start && t < x.end);
      if (b) b.v[seriesOf(s.instance)] += s.minutes;
    }
    return out;
  }, [h, unit]);

  const totals = useMemo(() => {
    const t: Record<SeriesId, number> = { longterm: 0, astera: 0, other: 0 };
    for (const b of buckets) for (const s of SERIES) t[s.id] += b.v[s.id];
    return t;
  }, [buckets]);
  const shown = SERIES.filter((s) => totals[s.id] > 0);
  const sum = (b: (typeof buckets)[number]) => shown.reduce((a, s) => a + b.v[s.id], 0);
  const tk = ticks(Math.max(1, ...buckets.map(sum)));
  const top = tk[tk.length - 1] || 60;

  return (
    <div className="panel hc-panel">
      <div className="panel-title">
        <BarChart3 size={14} /> Playtime by {unit}
        <span className="r hc-ctl">
          <span className="seg sm">
            <button className={unit === "week" ? "on" : ""} onClick={() => setUnit("week")}>
              Weeks
            </button>
            <button className={unit === "month" ? "on" : ""} onClick={() => setUnit("month")}>
              Months
            </button>
          </span>
          <button className={"iconbtn" + (table ? " on" : "")} onClick={() => setTable(!table)} title={table ? "Show the chart" : "Show the numbers as a table"}>
            <Table2 size={14} />
          </button>
        </span>
      </div>
      <div className="hc-legend">
        {shown.map((s) => (
          <span key={s.id}>
            <i style={{ background: s.color }} />
            {s.name}
            <b>{fmtMinutes(totals[s.id])}</b>
          </span>
        ))}
        {shown.length === 0 && <span className="muted">No play in this stretch.</span>}
      </div>
      {table ? (
        <div className="hc-table-wrap">
          <table className="hc-table">
            <thead>
              <tr>
                <th>{unit === "week" ? "Week of" : "Month"}</th>
                {shown.map((s) => (
                  <th key={s.id}>{s.name}</th>
                ))}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {[...buckets].reverse().map((b) => (
                <tr key={b.start}>
                  <td>{b.label}</td>
                  {shown.map((s) => (
                    <td key={s.id}>{b.v[s.id] ? fmtMinutes(b.v[s.id]) : "–"}</td>
                  ))}
                  <td>
                    <b>{sum(b) ? fmtMinutes(sum(b)) : "–"}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="hc-plot">
          <div className="hc-axis">
            {tk.map((t) => (
              <span key={t} style={{ bottom: `${(t / top) * 100}%` }}>
                {hrs(t)}
              </span>
            ))}
          </div>
          <div className="hc-area">
            <div className="hc-gridbox">
              {tk.map((t) => (
                <i key={t} className="hc-grid" style={{ bottom: `${(t / top) * 100}%` }} />
              ))}
            </div>
            <div className="hc-cols" style={{ gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))` }}>
              {buckets.map((b, i) => {
                const segs = shown.filter((s) => b.v[s.id] > 0);
                return (
                  <div key={b.start} className={"hc-col" + (hover === i ? " hot" : "")} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                    <div className="hc-stack">
                      {segs.map((s, j) => (
                        <motion.i
                          key={s.id}
                          className={j === segs.length - 1 ? "top" : ""}
                          style={{ background: s.color }}
                          initial={{ height: 0 }}
                          animate={{ height: `${(b.v[s.id] / top) * 100}%` }}
                          transition={{ delay: 0.1 + i * 0.025, duration: 0.6, ease: [0.22, 0.7, 0.18, 1] }}
                        />
                      ))}
                    </div>
                    <span className="hc-x">{unit === "month" || (buckets.length - 1 - i) % 3 === 0 ? b.label : ""}</span>
                    {hover === i && (
                      <div className={"hc-tip" + (i > buckets.length * 0.6 ? " left" : "")}>
                        <b>{b.long}</b>
                        {shown.map((s) => (
                          <span key={s.id}>
                            <i style={{ background: s.color }} />
                            {s.name}
                            <em>{b.v[s.id] ? fmtMinutes(b.v[s.id]) : "–"}</em>
                          </span>
                        ))}
                        <span className="tot">
                          Total<em>{sum(b) ? fmtMinutes(sum(b)) : "No play"}</em>
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Minutes played in each hour of the day (all sessions; a session spreads across the hours it covers). */
export function HoursChart({ h }: { h: HistoryData }) {
  const [hover, setHover] = useState<number | null>(null);
  const { per, peak, days } = useMemo(() => {
    const per: number[] = new Array(24).fill(0);
    const ds = new Set<string>();
    for (const s of h.sessions) {
      const [hh, mm] = s.start.split(":").map(Number);
      if (Number.isNaN(hh)) continue;
      ds.add(s.date);
      let at = hh * 60 + (mm || 0);
      let left = s.minutes;
      while (left > 0) {
        const hour = Math.floor(at / 60) % 24;
        const take = Math.min(left, 60 - (at % 60));
        per[hour] += take;
        left -= take;
        at += take;
      }
    }
    const peak = per.indexOf(Math.max(...per));
    return { per, peak, days: Math.max(1, ds.size) };
  }, [h]);
  const max = Math.max(1, ...per);
  const label = (hr: number) => new Date(2000, 0, 1, hr).toLocaleTimeString(undefined, { hour: "numeric" });
  return (
    <div className="panel hc-panel">
      <div className="panel-title">
        <Sun size={14} /> When you play
        <span className="r muted small">{per[peak] > 0 ? `Most often around ${label(peak)}` : ""}</span>
      </div>
      <div className="hc-hours">
        {per.map((m, i) => (
          <div key={i} className={"hc-hr" + (hover === i ? " hot" : "")} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <motion.i initial={{ height: 0 }} animate={{ height: `${(m / max) * 100}%` }} transition={{ delay: 0.1 + i * 0.015, duration: 0.5 }} />
            <span className="hc-x">{i % 6 === 0 ? label(i) : ""}</span>
            {hover === i && (
              <div className={"hc-tip" + (i > 15 ? " left" : "")}>
                <b>
                  {label(i)} – {label((i + 1) % 24)}
                </b>
                <span className="tot">
                  In total<em>{m ? fmtMinutes(m) : "Never"}</em>
                </span>
                <span className="tot">
                  Per play day<em>{m ? fmtMinutes(Math.round(m / days)) : "–"}</em>
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
