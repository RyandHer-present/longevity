// Kill board: every mob you've killed and every mob that killed you, side by side.
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Swords, Skull } from "lucide-react";
import { ItemIcon } from "../ui";
import { tapi, type KillBoard as K } from "./tapi";

export default function KillBoard() {
  const [k, setK] = useState<K | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    tapi.kills().then(setK).catch(() => {});
  }, []);
  const rows = useMemo(() => {
    if (!k) return [];
    const by = new Map(k.killed_by.map((x) => [x.id, x.count]));
    const ids = new Set([...k.killed.map((x) => x.id), ...k.killed_by.map((x) => x.id)]);
    const name = (id: string) => k.killed.find((x) => x.id === id)?.name ?? k.killed_by.find((x) => x.id === id)?.name ?? id;
    return [...ids]
      .map((id) => ({ id, name: name(id), kills: k.killed.find((x) => x.id === id)?.count ?? 0, deaths: by.get(id) ?? 0 }))
      .sort((a, b) => b.kills + b.deaths * 50 - (a.kills + a.deaths * 50));
  }, [k]);
  if (!k || rows.length === 0) return null;
  const max = Math.max(1, ...rows.map((r) => r.kills));
  const nemesis = [...rows].sort((a, b) => b.deaths - a.deaths)[0];
  const shown = all ? rows : rows.slice(0, 14);
  return (
    <div className="panel pad kb" style={{ marginBottom: 14 }}>
      <div className="panel-title">
        Kill board
        <span className="r num">
          {Number(k.mob_kills).toLocaleString()} kills · {Number(k.deaths).toLocaleString()} deaths
        </span>
      </div>
      {nemesis && nemesis.deaths > 0 && (
        <div className="kb-nemesis">
          <ItemIcon id={nemesis.id + "_spawn_egg"} size={30} />
          <div>
            <div className="kicker">Your nemesis</div>
            <b>{nemesis.name}</b>
            <span className="muted small">
              {" "}
              killed you {nemesis.deaths} time{nemesis.deaths === 1 ? "" : "s"}
              {nemesis.kills ? `, you got it back ${nemesis.kills.toLocaleString()} times` : ""}
            </span>
          </div>
        </div>
      )}
      <div className="kb-rows">
        {shown.map((r, i) => (
          <motion.div key={r.id} className="kb-row" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i, 14) * 0.025 }}>
            <ItemIcon id={r.id + "_spawn_egg"} size={22} />
            <span className="kb-name">{r.name}</span>
            <div className="kb-bar">
              <motion.i initial={{ width: 0 }} animate={{ width: `${(r.kills / max) * 100}%` }} transition={{ duration: 0.8, delay: 0.1 + Math.min(i, 14) * 0.02 }} />
            </div>
            <span className="kb-n" title="You killed">
              <Swords size={11} /> {r.kills.toLocaleString()}
            </span>
            <span className={"kb-d" + (r.deaths ? " on" : "")} title="Killed you">
              <Skull size={11} /> {r.deaths}
            </span>
          </motion.div>
        ))}
      </div>
      {rows.length > 14 && (
        <button className="btn ghost sm" onClick={() => setAll(!all)} style={{ marginTop: 8 }}>
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}
