// Villager Roster: 3D first (every villager pinned where they stand, click one to see their
// trades), plus a table. Trade search, the cure planner, and each villager's trade history.
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Search, Box, Table2, RefreshCw, HeartPulse, Users, Crosshair, ArrowRight, Sparkles } from "lucide-react";
import { useStore } from "../store";
import { ItemIcon, Spinner, Empty } from "../ui";
import { sfx } from "../sound";
import { Engine } from "../render/engine";
import { Markers3D, useEngineView } from "./Markers3D";
import { tapi, pretty, roman, type Roster, type Villager, type Offer, type HistoryEntry } from "./tapi";

const WORKSTATION: Record<string, string> = {
  armorer: "minecraft:blast_furnace",
  butcher: "minecraft:smoker",
  cartographer: "minecraft:cartography_table",
  cleric: "minecraft:brewing_stand",
  farmer: "minecraft:composter",
  fisherman: "minecraft:barrel",
  fletcher: "minecraft:fletching_table",
  leatherworker: "minecraft:cauldron",
  librarian: "minecraft:lectern",
  mason: "minecraft:stonecutter",
  shepherd: "minecraft:loom",
  toolsmith: "minecraft:smithing_table",
  weaponsmith: "minecraft:grindstone",
};
export const LEVEL = ["", "Novice", "Apprentice", "Journeyman", "Expert", "Master"];

export const vIcon = (v: Villager) =>
  v.kind === "zombie_villager" ? "minecraft:zombie_villager_spawn_egg" : v.kind === "wandering_trader" ? "minecraft:wandering_trader_spawn_egg" : WORKSTATION[v.profession] ?? "minecraft:villager_spawn_egg";
export const vTitle = (v: Villager) =>
  v.name ??
  (v.kind === "zombie_villager"
    ? `Zombie ${v.profession !== "none" ? pretty(v.profession).toLowerCase() : "villager"}`
    : v.kind === "wandering_trader"
      ? "Wandering Trader"
      : v.profession === "none"
        ? "Unemployed villager"
        : v.profession === "nitwit"
          ? "Nitwit"
          : pretty(v.profession));

export function offerText(o: Offer, names: Record<string, string>) {
  const s = o.sell;
  const ench = s[2]?.length ? ` ${s[2].join(", ")}` : "";
  return `${names[s[0]] ?? pretty(s[0])}${ench}`.toLowerCase() + " " + (names[o.buy[0]] ?? "").toLowerCase() + " " + (o.buyB ? (names[o.buyB[0]] ?? "").toLowerCase() : "");
}

function matches(v: Villager, q: string, names: Record<string, string>) {
  if (!q) return true;
  const s = q.toLowerCase();
  return vTitle(v).toLowerCase().includes(s) || v.offers.some((o) => offerText(o, names).includes(s));
}

export function TradeRow({ o, names, cured }: { o: Offer; names: Record<string, string>; cured?: boolean }) {
  const out = o.uses >= o.max && o.max > 0;
  const p = cured ? o.price_cured : o.price;
  const changed = p !== o.buy[1];
  return (
    <div className={"trade" + (out ? " out" : "")}>
      <div className="trade-in">
        <span className="tslot">
          <ItemIcon id={o.buy[0]} size={26} />
          <b className={changed ? (p < o.buy[1] ? "cheap" : "dear") : ""}>{p}</b>
        </span>
        {changed && <s className="was">{o.buy[1]}</s>}
        {o.buyB && (
          <span className="tslot">
            <ItemIcon id={o.buyB[0]} size={26} />
            {o.buyB[1] > 1 && <b>{o.buyB[1]}</b>}
          </span>
        )}
      </div>
      <ArrowRight size={14} className="trade-arrow" />
      <div className="trade-out">
        <span className="tslot">
          <ItemIcon id={o.sell[0]} size={26} />
          {o.sell[1] > 1 && <b>{o.sell[1]}</b>}
        </span>
        <span className="trade-name">
          {names[o.sell[0]] ?? pretty(o.sell[0])}
          {o.sell[2]?.length > 0 && <em>{o.sell[2].map((e) => e.replace(/\b\w/g, (c) => c.toUpperCase())).join(", ")}</em>}
        </span>
      </div>
      <span className="trade-uses" title="Uses left before restock">
        {out ? "sold out" : `${o.max - o.uses}/${o.max}`}
      </span>
    </div>
  );
}

function historyLines(h: HistoryEntry[], names: Record<string, string>) {
  const out: { day: number; text: string }[] = [];
  for (let i = 0; i < h.length; i++) {
    const cur = h[i];
    const prev = h[i - 1];
    if (!prev) {
      out.push({ day: cur.day, text: `First seen as ${LEVEL[cur.level] ?? "level " + cur.level} ${pretty(cur.profession).toLowerCase()} with ${cur.trades.length} trades` });
      continue;
    }
    if (cur.profession !== prev.profession) out.push({ day: cur.day, text: `Became a ${pretty(cur.profession).toLowerCase()}` });
    if (cur.level > prev.level) out.push({ day: cur.day, text: `Levelled up to ${LEVEL[cur.level] ?? cur.level}` });
    const key = (t: HistoryEntry["trades"][number]) => t[0] + (t[1] ?? []).join(",");
    const before = new Map(prev.trades.map((t) => [key(t), t]));
    for (const t of cur.trades) {
      const old = before.get(key(t));
      const label = `${names[t[0]] ?? pretty(t[0])}${t[1]?.length ? " (" + t[1].join(", ") + ")" : ""}`;
      if (!old) out.push({ day: cur.day, text: `New trade: ${label} for ${t[2]}` });
      else if (old[2] !== t[2]) out.push({ day: cur.day, text: `${label}: ${old[2]} → ${t[2]}` });
    }
  }
  return out.reverse();
}

function Detail({ v, roster, onClose }: { v: Villager; roster: Roster; onClose: () => void }) {
  const [tab, setTab] = useState<"trades" | "history">("trades");
  const hist = roster.history[v.uuid] ?? [];
  const lines = useMemo(() => historyLines(hist, roster.names), [hist]);
  const saving = v.offers.reduce((a, o) => a + (o.price - o.price_cured) * Math.max(1, o.max), 0);
  const job = v.kind === "villager" && v.profession !== "none" && v.profession !== "nitwit";
  return (
    <motion.div className="vr-detail glass" initial={{ x: 30, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 20, opacity: 0 }} transition={{ type: "spring", stiffness: 380, damping: 34 }}>
      <div className="vr-dhead">
        <div className="slot" style={{ width: 46, height: 46 }}>
          <ItemIcon id={vIcon(v)} size={32} />
        </div>
        <div className="grow">
          <div className="vr-dname">{vTitle(v)}</div>
          <div className="muted small">
            {job ? `${LEVEL[v.level]} · ` : ""}
            {pretty(v.type)} · {Math.floor(v.pos[0])}, {Math.floor(v.pos[1])}, {Math.floor(v.pos[2])}
          </div>
        </div>
        <button className="iconbtn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {job && (
        <div className="vr-xp">
          {[1, 2, 3, 4, 5].map((l) => (
            <i key={l} className={l <= v.level ? "on" : ""} />
          ))}
        </div>
      )}
      <div className="vr-badges">
        {v.cured && <span className="chip good">Cured by you</span>}
        {!v.cured && v.kind === "villager" && saving > 0 && <span className="chip">Curing saves {saving} emeralds a restock</span>}
        {v.reputation !== 0 && (
          <span className={"chip " + (v.reputation > 0 ? "good" : "bad")}>
            Reputation {v.reputation > 0 ? "+" : ""}
            {v.reputation}
          </span>
        )}
        {v.converting && <span className="chip good">Being cured right now</span>}
      </div>
      <div className="tabs" style={{ margin: "6px 0 10px" }}>
        <button className={tab === "trades" ? "on" : ""} onClick={() => setTab("trades")}>
          Trades
        </button>
        <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>
          History {hist.length > 1 ? `(${lines.length})` : ""}
        </button>
      </div>
      {tab === "trades" ? (
        <div className="vr-trades">
          {v.offers.length === 0 && <div className="muted small">No trades yet.</div>}
          {v.offers.map((o, i) => (
            <TradeRow key={i} o={o} names={roster.names} />
          ))}
          {!v.cured && v.kind === "villager" && saving > 0 && (
            <>
              <div className="vr-sub">If you cure them</div>
              {v.offers
                .filter((o) => o.price_cured < o.price)
                .map((o, i) => (
                  <TradeRow key={"c" + i} o={o} names={roster.names} cured />
                ))}
            </>
          )}
        </div>
      ) : (
        <div className="vr-hist">
          {lines.length === 0 && <div className="muted small">Longevity starts a history the first time it sees a villager. Changes show up here after you play.</div>}
          {lines.map((l, i) => (
            <div key={i} className="vr-hline">
              <span className="vr-hday">Day {l.day}</span>
              {l.text}
            </div>
          ))}
        </div>
      )}
      <div className="vr-actions">
        <button
          className="btn sm"
          onClick={() => {
            sfx.click();
            tapi
              .find(vTitle(v), [{ pos: [Math.floor(v.pos[0]), Math.floor(v.pos[1]), Math.floor(v.pos[2])], dim: v.dim }])
              .then(() => useStore.getState().toastMsg("They'll glow in game for 5 minutes"))
              .catch((e) => useStore.getState().toastMsg(String(e)));
          }}
        >
          <Sparkles size={14} /> Glow in game
        </button>
      </div>
    </motion.div>
  );
}

function CurePlanner({ roster, pick }: { roster: Roster; pick: (v: Villager) => void }) {
  const zombies = roster.villagers.filter((v) => v.kind === "zombie_villager");
  const uncured = roster.villagers
    .filter((v) => v.kind === "villager" && !v.cured && v.offers.length > 0)
    .map((v) => ({
      v,
      save: v.offers.reduce((a, o) => a + (o.price - o.price_cured) * Math.max(1, o.max), 0),
      best: [...v.offers].sort((a, b) => b.price - b.price_cured - (a.price - a.price_cured))[0],
    }))
    .filter((x) => x.save > 0)
    .sort((a, b) => b.save - a.save);
  return (
    <div className="vr-cure">
      <div className="vr-note glass">
        <HeartPulse size={16} />
        <div>
          Curing a zombie villager (Weakness + a golden apple) makes their trades cheaper for you. Since 1.20.2 the discount doesn't stack, so <b>one cure per villager is enough</b>. Prices below use your real reputation with
          each villager.
        </div>
      </div>
      {zombies.length > 0 && (
        <>
          <h3 className="vr-h">Zombie villagers you could cure</h3>
          <div className="vr-cards">
            {zombies.map((v) => (
              <button key={v.uuid} className="vr-card glass" onClick={() => pick(v)}>
                <ItemIcon id={vIcon(v)} size={28} />
                <div>
                  <b>{vTitle(v)}</b>
                  <span>
                    {v.offers.length ? `Keeps ${v.offers.length} trades` : "No trades yet"} · {Math.floor(v.pos[0])}, {Math.floor(v.pos[2])}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
      <h3 className="vr-h">Best villagers to cure</h3>
      {uncured.length === 0 && <div className="muted">Every trading villager you know is already cured (or has no discount to gain).</div>}
      <div className="vr-table">
        {uncured.map(({ v, save, best }) => (
          <button key={v.uuid} className="vr-trow" onClick={() => pick(v)}>
            <ItemIcon id={vIcon(v)} size={22} />
            <span className="vr-tname">{vTitle(v)}</span>
            <span className="muted small">{LEVEL[v.level]}</span>
            {best && (
              <span className="vr-tbest">
                <ItemIcon id={best.sell[0]} size={18} /> {roster.names[best.sell[0]] ?? pretty(best.sell[0])}
                {best.sell[2]?.length ? " · " + best.sell[2].join(", ") : ""}: <s>{best.price}</s> → <b>{best.price_cured}</b>
              </span>
            )}
            <span className="vr-save">−{save} per restock</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Villagers() {
  const world = useStore((s) => s.world)!;
  const [roster, setRoster] = useState<Roster | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [view, setView] = useState<"3d" | "table">("3d");
  const [tab, setTab] = useState<"roster" | "cure">("roster");
  const [sel, setSel] = useState<string | null>(() => {
    const f = useStore.getState().toolFocus;
    if (f?.page !== "villagers") return null;
    useStore.setState({ toolFocus: null });
    return f.id;
  });
  const [kinds, setKinds] = useState<"all" | "traders" | "zombies">("all");
  const host = useRef<HTMLDivElement>(null);

  const load = () => {
    setErr(null);
    tapi
      .villagers()
      .then(setRoster)
      .catch((e) => setErr(String(e)));
  };
  useEffect(load, [world.path]);

  const list = useMemo(() => {
    if (!roster) return [];
    return roster.villagers
      .filter((v) => (kinds === "zombies" ? v.kind === "zombie_villager" : kinds === "traders" ? v.kind === "villager" && v.offers.length > 0 : true))
      .filter((v) => matches(v, q.trim(), roster.names))
      .sort((a, b) => b.level - a.level || a.profession.localeCompare(b.profession));
  }, [roster, q, kinds]);

  // look at where most of your villagers are (usually the trading hall)
  const centre = useMemo<[number, number, number] | null>(() => {
    const vs = roster?.villagers.filter((v) => v.dim === "minecraft:overworld" && v.kind === "villager") ?? [];
    if (!vs.length) return null;
    // the densest group (villages are far apart, so a median lands between them)
    let best = vs[0];
    let bestN = 0;
    for (const a of vs) {
      const n = vs.filter((b) => Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]) < 32).length;
      if (n > bestN) {
        bestN = n;
        best = a;
      }
    }
    const group = vs.filter((b) => Math.hypot(best.pos[0] - b.pos[0], best.pos[2] - b.pos[2]) < 32);
    const mean = (k: 0 | 1 | 2) => group.reduce((s, v) => s + v.pos[k], 0) / group.length;
    return [mean(0), mean(1), mean(2)];
  }, [roster]);

  const is3d = view === "3d" && tab === "roster";
  useEngineView(host, centre, 46, [is3d, centre?.[0], centre?.[2]]);

  const selected = roster?.villagers.find((v) => v.uuid === sel) ?? null;
  function pick(v: Villager) {
    sfx.click();
    setSel(v.uuid);
    if (is3d) Engine.get().lookAtPoint(v.pos[0], v.pos[1] + 1, v.pos[2], 12);
  }

  if (err) return <Empty title="Couldn't read the villagers">{err}</Empty>;
  if (!roster)
    return (
      <div className="page-pad center-fill">
        <Spinner size={22} /> <span className="muted">Finding every villager you've met…</span>
      </div>
    );

  const traders = roster.villagers.filter((v) => v.kind === "villager").length;
  const zombies = roster.villagers.filter((v) => v.kind === "zombie_villager").length;

  return (
    <div className={"vr-page" + (is3d ? " is3d" : "")}>
      <div className="tool-head page-pad-x">
        <div>
          <div className="kicker">World · Villager Roster</div>
          <h1>Villagers</h1>
          <p>
            {traders} villagers{zombies ? `, ${zombies} zombie villagers` : ""} in the places you've been. Prices are what <b>you</b> pay, with your reputation.
          </p>
        </div>
        <div className="flex gap">
          <div className="tabs">
            <button className={tab === "roster" ? "on" : ""} onClick={() => setTab("roster")}>
              <Users size={13} /> Roster
            </button>
            <button className={tab === "cure" ? "on" : ""} onClick={() => setTab("cure")}>
              <HeartPulse size={13} /> Cure planner
            </button>
          </div>
          {tab === "roster" && (
            <div className="tabs">
              <button className={view === "3d" ? "on" : ""} onClick={() => setView("3d")}>
                <Box size={13} /> 3D
              </button>
              <button className={view === "table" ? "on" : ""} onClick={() => setView("table")}>
                <Table2 size={13} /> Table
              </button>
            </div>
          )}
          <button className="iconbtn" onClick={load} title="Read again">
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {tab === "cure" ? (
        <div className="page-pad-x vr-scroll">
          <CurePlanner roster={roster} pick={(v) => setSel(v.uuid)} />
        </div>
      ) : (
        <div className={"vr-body" + (is3d ? " three" : "")}>
          {is3d && (
            <div className="vr-canvas" ref={host}>
              <Markers3D
                markers={list.map((v) => ({
                  key: v.uuid,
                  pos: [v.pos[0], v.pos[1] + 2.4, v.pos[2]] as [number, number, number],
                  active: v.uuid === sel,
                  range: 160,
                  onClick: () => pick(v),
                  children: (
                    <div className={"vr-pin " + v.kind}>
                      <ItemIcon id={vIcon(v)} size={18} />
                      {v.kind === "villager" && v.level > 1 && <b>{roman(v.level)}</b>}
                    </div>
                  ),
                }))}
              />
              {!centre && <div className="vr-empty3d muted">No villagers in the overworld places you've explored yet.</div>}
            </div>
          )}
          <div className="vr-side">
            <div className="search glass">
              <Search size={15} />
              <input className="input" placeholder="Search trades: mending, emerald, bread…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="vr-filter">
              {(["all", "traders", "zombies"] as const).map((k) => (
                <button key={k} className={"chip" + (kinds === k ? " on" : "")} onClick={() => setKinds(k)}>
                  {k === "all" ? "All" : k === "traders" ? "With trades" : "Zombie villagers"}
                </button>
              ))}
            </div>
            <div className={"vr-list" + (view === "table" ? " table" : "")}>
              {list.length === 0 && (
                <div className="muted small" style={{ padding: 12 }}>
                  {q ? "No villager sells that." : "No villagers found yet."}
                </div>
              )}
              {list.map((v) => {
                const hit = q.trim() ? v.offers.filter((o) => offerText(o, roster.names).includes(q.trim().toLowerCase())) : [];
                return (
                  <button key={v.uuid} className={"vr-row" + (v.uuid === sel ? " on" : "")} onClick={() => pick(v)}>
                    <span className="slot" style={{ width: 34, height: 34 }}>
                      <ItemIcon id={vIcon(v)} size={22} />
                    </span>
                    <span className="vr-rmain">
                      <b>{vTitle(v)}</b>
                      <span className="muted small">
                        {v.kind === "villager" && v.level ? LEVEL[v.level] + " · " : ""}
                        {v.offers.length} trades{v.cured ? " · cured" : ""}
                      </span>
                    </span>
                    {view === "table" && (
                      <span className="vr-chips">
                        {(hit.length ? hit : v.offers).slice(0, 7).map((o, i) => (
                          <span key={i} className="vr-chip" title={offerText(o, roster.names)}>
                            <ItemIcon id={o.sell[0]} size={16} />
                            {o.sell[2]?.length ? <em>{o.sell[2][0]}</em> : null}
                            <i>{o.price}</i>
                          </span>
                        ))}
                      </span>
                    )}
                    {view === "3d" && hit.length > 0 && (
                      <span className="vr-hit">
                        <ItemIcon id={hit[0].buy[0]} size={14} /> {hit[0].price}
                      </span>
                    )}
                    <Crosshair size={13} className="muted" />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
      <AnimatePresence>{selected && <Detail key={selected.uuid} v={selected} roster={roster} onClose={() => setSel(null)} />}</AnimatePresence>
    </div>
  );
}
