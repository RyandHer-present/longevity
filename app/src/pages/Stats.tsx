import KillBoard from "../tools/KillBoard";
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { api, fmtDate, fmtDist, fmtNum, fmtTicks, prettyId, type PlayerStats } from "../api";
import { ItemIcon, Sprite, Spinner, Ticker, useTip } from "../ui";

const MODES: { k: string; label: string; color: string }[] = [
  { k: "walk", label: "Walking", color: "#86c06c" },
  { k: "sprint", label: "Sprinting", color: "#b7d36a" },
  { k: "crouch", label: "Sneaking", color: "#6b8f5a" },
  { k: "swim", label: "Swimming", color: "#5aa6d6" },
  { k: "walk_on_water", label: "On water", color: "#7fc4e6" },
  { k: "walk_under_water", label: "Underwater", color: "#3e7fb0" },
  { k: "boat", label: "Boat", color: "#c8a06a" },
  { k: "horse", label: "Horse", color: "#a87a4a" },
  { k: "minecart", label: "Minecart", color: "#9a9ea3" },
  { k: "pig", label: "Pig", color: "#e7a3a6" },
  { k: "strider", label: "Strider", color: "#c45a4a" },
  { k: "happy_ghast", label: "Happy ghast", color: "#e8e3da" },
  { k: "nautilus", label: "Nautilus", color: "#8f7ad1" },
  { k: "elytra", label: "Elytra", color: "#a88bd6" },
  { k: "fly", label: "Flying", color: "#d6c38b" },
  { k: "climb", label: "Climbing", color: "#8a7a5a" },
  { k: "fall", label: "Falling", color: "#dd6b5b" },
];

const entityIcon = (id: string) => `${id}_spawn_egg`;

function TopList({ title, rows, names, entity, unit }: { title: string; rows: [string, number][]; names: Record<string, string>; entity?: boolean; unit?: string }) {
  const max = rows[0]?.[1] ?? 1;
  return (
    <div className="panel pad toplist">
      <div className="panel-title">{title}</div>
      {rows.length === 0 && <div className="muted">Nothing yet.</div>}
      {rows.slice(0, 10).map(([id, n], i) => (
        <motion.div key={id} className="tl-row" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.03 }}>
          <span className="rank num">{i + 1}</span>
          <ItemIcon id={entity ? entityIcon(id) : id} size={22} />
          <span className="nm">{names[id] || prettyId(id)}</span>
          <span className="bar-bg">
            <i style={{ width: `${(n / max) * 100}%` }} />
          </span>
          <span className="n num">
            {fmtNum(n)}
            {unit}
          </span>
        </motion.div>
      ))}
    </div>
  );
}

function Calendar({ data }: { data: [number, number][] }) {
  const tip = useTip();
  const days = 7 * 26;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today.getTime() - (days - 1) * 86400000);
  start.setDate(start.getDate() - start.getDay());
  const map = new Map<string, number>();
  for (const [t, m] of data) {
    const d = new Date(t);
    const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    map.set(k, (map.get(k) ?? 0) + m);
  }
  const cols: { d: Date; m: number }[][] = [];
  const cur = new Date(start);
  while (cur <= today) {
    const col: { d: Date; m: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const k = `${cur.getFullYear()}-${cur.getMonth()}-${cur.getDate()}`;
      col.push({ d: new Date(cur), m: cur <= today ? map.get(k) ?? 0 : -1 });
      cur.setDate(cur.getDate() + 1);
    }
    cols.push(col);
  }
  const lvl = (m: number) => (m <= 0 ? 0 : m < 30 ? 1 : m < 90 ? 2 : m < 180 ? 3 : 4);
  return (
    <div className="cal">
      {cols.map((c, i) => (
        <div key={i} className="cal-col">
          {c.map((d, j) => (
            <div key={j} className={"cal-cell l" + (d.m < 0 ? "x" : lvl(d.m))} onMouseMove={(e) => d.m >= 0 && tip.show(e, <><div className="t">{d.m ? `${Math.floor(d.m / 60)} h ${d.m % 60} min` : "Didn't play"}</div><div className="l">{d.d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}</div></>)} onMouseLeave={tip.hide} />
          ))}
        </div>
      ))}
      {tip.el}
    </div>
  );
}

export default function Stats() {
  const [st, setSt] = useState<PlayerStats | null>(null);
  useEffect(() => {
    api.playerStats().then(setSt);
  }, []);
  const travel = useMemo(() => {
    if (!st) return { total: 0, parts: [] as { k: string; label: string; color: string; v: number }[] };
    const parts = MODES.map((m) => ({ ...m, v: st.summary.distance[m.k] ?? 0 })).filter((p) => p.v > 1);
    parts.sort((a, b) => b.v - a.v);
    return { total: parts.filter((p) => p.k !== "fall").reduce((a, p) => a + p.v, 0), parts };
  }, [st]);
  if (!st)
    return (
      <div className="page-pad dim" style={{ display: "flex", gap: 10 }}>
        <Spinner /> Counting…
      </div>
    );
  const s = st.summary;
  const n = st.names;
  const hours = s.play_ticks / 72000;
  const recentAdv = [...st.advancements].sort((a, b) => b.done_ms - a.done_ms);
  const pct = st.advancements_total ? st.advancements.length / st.advancements_total : 0;
  const totalSessions = st.sessions.length;
  const longest = st.sessions.reduce((a, x) => Math.max(a, x.end - x.start), 0);

  return (
    <div className="page-pad">
      <div className="page-head">
        <div>
          <div className="kicker">By the numbers</div>
          <h1>Statistics</h1>
          <div className="lede">Straight from the game's own statistics file, plus every session in your logs.</div>
        </div>
      </div>

      <div className="hero-nums">
        <div className="hn">
          <div className="k">Time played</div>
          <div className="v num">{fmtTicks(s.play_ticks)}</div>
          <div className="s">{totalSessions} sessions · longest {Math.round(longest / 60000)} min</div>
        </div>
        <div className="hn">
          <div className="k">Travelled</div>
          <div className="v num">{fmtDist(travel.total)}</div>
          <div className="s">{hours > 0 ? `${fmtNum(travel.total / hours)} blocks an hour` : ""}</div>
        </div>
        <div className="hn">
          <div className="k">Blocks mined</div>
          <div className="v">
            <Ticker value={s.mined_total} />
          </div>
          <div className="s">{fmtNum(s.placed_total)} items used or placed</div>
        </div>
        <div className="hn">
          <div className="k">Mobs defeated</div>
          <div className="v">
            <Ticker value={s.mob_kills} />
          </div>
          <div className="s">{fmtNum(s.damage_dealt)} damage dealt</div>
        </div>
        <div className="hn red">
          <div className="k">Deaths</div>
          <div className="v">
            <Ticker value={s.deaths} />
          </div>
          <div className="s">last one {fmtTicks(s.since_death_ticks)} of play ago</div>
        </div>
      </div>

      <div className="panel pad" style={{ marginBottom: 14 }}>
        <div className="panel-title">
          How you got around<span className="r num">{fmtDist(travel.total)}</span>
        </div>
        <div className="travel-bar">
          {travel.parts
            .filter((p) => p.k !== "fall")
            .map((p) => (
              <motion.i key={p.k} style={{ background: p.color }} initial={{ width: 0 }} animate={{ width: `${(p.v / travel.total) * 100}%` }} transition={{ duration: 0.9, ease: [0.2, 0.7, 0.2, 1] }} title={`${p.label}: ${fmtDist(p.v)}`} />
            ))}
        </div>
        <div className="travel-legend">
          {travel.parts.map((p) => (
            <div key={p.k}>
              <span className="sw" style={{ background: p.color }} />
              <span>{p.label}</span>
              <span className="num muted">{fmtDist(p.v)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="stats-grid">
        <TopList title="Mined" rows={s.top_mined} names={n} />
        <TopList title="Crafted" rows={s.top_crafted} names={n} />
        <TopList title="Used & placed" rows={s.top_used} names={n} />
        <TopList title="Defeated" rows={s.top_killed} names={n} entity />
        <TopList title="Defeated you" rows={s.top_killed_by} names={n} entity />
        <TopList title="Picked up" rows={s.top_picked_up} names={n} />
      </div>

      <KillBoard />

      <div className="stats-two">
        <div className="panel pad">
          <div className="panel-title">
            Advancements
            <span className="r num">
              {st.advancements.length} / {st.advancements_total}
            </span>
          </div>
          <div className="adv-top">
            <svg viewBox="0 0 120 120" width="120" height="120">
              <circle cx="60" cy="60" r="50" stroke="rgba(255,255,255,0.07)" strokeWidth="9" fill="none" />
              <motion.circle cx="60" cy="60" r="50" stroke="url(#ag)" strokeWidth="9" fill="none" strokeLinecap="round" transform="rotate(-90 60 60)" strokeDasharray={Math.PI * 100} initial={{ strokeDashoffset: Math.PI * 100 }} animate={{ strokeDashoffset: Math.PI * 100 * (1 - pct) }} transition={{ duration: 1.2, ease: [0.2, 0.7, 0.2, 1] }} />
              <defs>
                <linearGradient id="ag" x1="0" x2="1">
                  <stop offset="0" stopColor="#c98d3c" />
                  <stop offset="1" stopColor="#f3cc8c" />
                </linearGradient>
              </defs>
              <text x="60" y="66" textAnchor="middle" className="num" fill="#ebe7df" fontSize="22" fontWeight="600">
                {Math.round(pct * 100)}%
              </text>
            </svg>
            <div className="adv-counts">
              {["challenge", "goal", "task"].map((f) => (
                <div key={f}>
                  <Sprite path={`gui/sprites/advancements/${f}_frame_obtained`} size={22} />
                  <span className="num">{st.advancements.filter((a) => a.frame === f).length}</span>
                  <span className="muted">{f === "task" ? "tasks" : f + "s"}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="adv-list">
            {recentAdv.slice(0, 40).map((a) => (
              <div key={a.id} className={"adv-row f-" + a.frame}>
                <Sprite path={`gui/sprites/advancements/${a.frame}_frame_obtained`} size={26} />
                <div style={{ minWidth: 0 }}>
                  <div className="at">{a.title}</div>
                  <div className="ad">{a.description}</div>
                </div>
                <div className="aw">{a.done_ms ? fmtDate(a.done_ms) : ""}</div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="panel pad">
            <div className="panel-title">When you played</div>
            <Calendar data={st.calendar} />
            <div className="cal-legend">
              less <i className="cal-cell l0" />
              <i className="cal-cell l1" />
              <i className="cal-cell l2" />
              <i className="cal-cell l3" />
              <i className="cal-cell l4" /> more
            </div>
          </div>
          <div className="panel pad facts">
            <div className="panel-title">Odds and ends</div>
            {(
              [
                ["Jumps", s.jumps],
                ["Nights slept", s.sleeps],
                ["Trades with villagers", s.trades],
                ["Animals bred", s.bred],
                ["Fish caught", s.fish],
                ["Items enchanted", s.enchanted],
                ["Chests opened", s.chests_opened],
                ["Damage taken", Math.round(s.damage_taken)],
                ["Fallen", Math.round(s.distance.fall ?? 0)],
              ] as [string, number][]
            ).map(([k, v]) => (
              <div key={k} className="fact">
                <span>{k}</span>
                <span className="num">{fmtNum(v)}</span>
              </div>
            ))}
            <div className="fact">
              <span>Since you last slept</span>
              <span className="num">{fmtTicks(s.since_rest_ticks)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
