import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { MapPin } from "lucide-react";
import { api, dimName, fmtDate, fmtDuration, type GameEvent } from "../api";
import { useStore } from "../store";
import { ItemIcon, Sprite, Spinner, Empty } from "../ui";
import { sfx } from "../sound";

const KIND_ICON: Record<string, string> = {
  death: "minecraft:skeleton_skull",
  villager_death: "minecraft:emerald",
  dimension: "minecraft:obsidian",
  trip: "minecraft:compass",
  haul: "minecraft:diamond",
  milestone: "minecraft:experience_bottle",
  respawn_set: "minecraft:red_bed",
  session_start: "minecraft:clock",
  session_end: "minecraft:clock",
  chat: "minecraft:writable_book",
};

export function EventGlyph({ kind, detail, size = 30 }: { kind: string; detail?: string; size?: number }) {
  if (kind === "advancement") {
    const frame = detail === "goal" ? "goal" : detail === "challenge" ? "challenge" : "task";
    return (
      <div className="glyph adv" style={{ width: size, height: size }}>
        <Sprite path={`gui/sprites/advancements/${frame}_frame_obtained`} size={size} />
      </div>
    );
  }
  const icon = KIND_ICON[kind] ?? "minecraft:paper";
  return (
    <div className={"glyph k-" + kind} style={{ width: size, height: size }}>
      <ItemIcon id={icon} size={Math.round(size * 0.68)} />
    </div>
  );
}

const FILTERS: { id: string; label: string; kinds: string[] | null }[] = [
  { id: "all", label: "Everything", kinds: null },
  { id: "death", label: "Deaths", kinds: ["death", "villager_death"] },
  { id: "adv", label: "Advancements", kinds: ["advancement"] },
  { id: "travel", label: "Journeys", kinds: ["dimension", "trip", "respawn_set"] },
  { id: "haul", label: "Finds", kinds: ["haul", "milestone"] },
  { id: "session", label: "Sessions", kinds: ["session_start", "session_end"] },
];

export default function Timeline() {
  const [events, setEvents] = useState<GameEvent[] | null>(null);
  const [filter, setFilter] = useState("all");
  const flyTo = useStore((s) => s.flyTo);
  useEffect(() => {
    api.timeline().then((t) => setEvents(t.events));
  }, []);

  const groups = useMemo(() => {
    if (!events) return [];
    const f = FILTERS.find((x) => x.id === filter)!;
    let list = events.filter((e) => e.kind !== "chat");
    if (f.kinds) list = list.filter((e) => f.kinds!.includes(e.kind));
    else list = list.filter((e) => e.kind !== "session_end");
    const m = new Map<number, GameEvent[]>();
    for (const e of list) {
      const d = e.day !== null ? Math.floor(e.day) + 1 : 0;
      m.set(d, [...(m.get(d) ?? []), e]);
    }
    return [...m.entries()].sort((a, b) => b[0] - a[0]).map(([d, l]) => [d, l.sort((a, b) => b.t - a.t)] as const);
  }, [events, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of FILTERS) c[f.id] = f.kinds ? (events ?? []).filter((e) => f.kinds!.includes(e.kind)).length : 0;
    return c;
  }, [events]);

  // match a session end to its start for the duration line
  const sessionLen = (e: GameEvent) => {
    if (!events) return null;
    const end = events.find((x) => x.kind === "session_end" && x.t > e.t);
    return end ? end.t - e.t : null;
  };

  return (
    <div className="page-pad">
      <div className="page-head">
        <div>
          <div className="kicker">The record</div>
          <h1>Timeline</h1>
          <div className="lede">Everything Longevity knows happened in this world, from your saves, your game logs and the recorder. Newest first.</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 22, flexWrap: "wrap" }}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={"chip" + (filter === f.id ? " on" : "")}
            onClick={() => {
              sfx.click();
              setFilter(f.id);
            }}
          >
            {f.label}
            {f.kinds && counts[f.id] > 0 && <span className="muted">{counts[f.id]}</span>}
          </button>
        ))}
      </div>
      {!events && (
        <div className="dim" style={{ display: "flex", gap: 10 }}>
          <Spinner /> Reading the logs…
        </div>
      )}
      {events && groups.length === 0 && <Empty title="Nothing here yet">Play a little and the recorder will start writing things down.</Empty>}
      <div className="tl">
        {groups.map(([day, list], gi) => (
          <motion.div key={day} className="tl-day" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(gi, 12) * 0.03 }}>
            <div className="tl-rail">
              <div className="tl-dayno">{day ? `Day ${day}` : "Undated"}</div>
              <div className="tl-date">{fmtDate(list[0].t)}</div>
            </div>
            <div className="tl-events">
              {list.map((e, i) => {
                if (e.kind === "session_start") {
                  const len = sessionLen(e);
                  return (
                    <div key={i} className="tl-session">
                      <span className="line" />
                      <span>
                        Played {len ? fmtDuration(len) : ""} · {new Date(e.t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                      </span>
                      <span className="line" />
                    </div>
                  );
                }
                return (
                  <div key={i} className={"tl-ev k-" + e.kind}>
                    <EventGlyph kind={e.kind} detail={e.detail} />
                    <div className="tl-body">
                      <div className="tl-title">{e.title}</div>
                      <div className="tl-sub">
                        {e.kind === "death" && e.detail && !e.detail.startsWith("death #") ? e.detail : e.kind === "advancement" ? "Advancement made" : e.detail}
                        {e.dim && e.dim !== "minecraft:overworld" ? ` · ${dimName(e.dim)}` : ""}
                      </div>
                    </div>
                    <div className="tl-when">{new Date(e.t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</div>
                    {e.pos && (
                      <button className="iconbtn" title="Show this place in 3D" onClick={() => flyTo({ x: e.pos![0], y: e.pos![1], z: e.pos![2], dim: e.dim ?? "minecraft:overworld" })}>
                        <MapPin />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
