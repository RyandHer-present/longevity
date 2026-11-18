import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Box, RefreshCw, Search, X, Package } from "lucide-react";
import { api, dimName, fmtCompact, fmtNum, prettyId, type Container, type Hit } from "../api";
import { useStore } from "../store";
import { ItemIcon, Slot, Spinner, useTip, Empty } from "../ui";
import { sfx } from "../sound";
import Doctor from "../tools/Doctor";
import { Stethoscope } from "lucide-react";

const SUGGEST = ["diamond", "netherite", "mending", "shulker", "iron", "enchanted book", "food", "totem"];
const kindIcon = (k: string) => (k === "player:inventory" ? "minecraft:name_tag" : k === "player:ender_chest" ? "minecraft:ender_chest" : k);

function slotCount(c: Container): number {
  const k = c.kind.replace("minecraft:", "");
  const maxSlot = Math.max(-1, ...c.items.map((i) => i.slot ?? -1)) + 1;
  if (k === "player:inventory") return 41;
  if (k.includes("hopper")) return 5;
  if (k.includes("furnace") || k.includes("smoker")) return 3;
  if (k.includes("brewing")) return 5;
  if (k.includes("dispenser") || k.includes("dropper") || k.includes("crafter")) return 9;
  if (k.includes("chiseled_bookshelf")) return 6;
  if (k.includes("decorated_pot") || k.includes("jukebox") || k.includes("lectern")) return 1;
  if (k.includes("campfire")) return 4;
  return Math.max(27, Math.ceil(maxSlot / 9) * 9);
}

function ContainerView({ id, onClose, highlight }: { id: number; onClose: () => void; highlight: string }) {
  const [data, setData] = useState<{ container: Container; names: Record<string, string>; kind_name: string } | null>(null);
  const [inner, setInner] = useState<number | null>(null);
  const tip = useTip();
  const flyTo = useStore((s) => s.flyTo);
  useEffect(() => {
    api.container(id).then(setData);
  }, [id]);
  if (!data) return null;
  const c = data.container;
  const n = slotCount(c);
  const bySlot = new Map<number, (typeof c.items)[number]>();
  c.items.forEach((it, i) => bySlot.set(it.slot ?? i, it));
  const isPlayer = c.kind === "player:inventory";
  const rows: number[][] = [];
  if (isPlayer) {
    rows.push([9, 10, 11, 12, 13, 14, 15, 16, 17], [18, 19, 20, 21, 22, 23, 24, 25, 26], [27, 28, 29, 30, 31, 32, 33, 34, 35], [-1], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  } else for (let r = 0; r < Math.ceil(n / 9); r++) rows.push(Array.from({ length: Math.min(9, n - r * 9) }, (_, i) => r * 9 + i));
  const q = highlight.trim().toLowerCase();
  const hl = (it?: (typeof c.items)[number]) => !!it && !!q && ((data.names[it.id] ?? "").toLowerCase().includes(q) || it.id.includes(q) || it.enchants.some((e) => e.includes(q)) || (it.name ?? "").toLowerCase().includes(q));
  const innerItem = inner !== null ? bySlot.get(inner) : undefined;
  return (
    <motion.div className="modal-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div className="modal cview" initial={{ y: 14, scale: 0.98, opacity: 0 }} animate={{ y: 0, scale: 1, opacity: 1 }} exit={{ y: 8, opacity: 0 }} onClick={(e) => e.stopPropagation()}>
        <div className="cv-head">
          <div className="slot" style={{ width: 44, height: 44 }}>
            <ItemIcon id={kindIcon(c.kind)} size={32} />
          </div>
          <div>
            <div className="cv-title">{c.name || data.kind_name || prettyId(c.kind)}</div>
            <div className="coords">
              {dimName(c.dim)} · X {c.pos[0]} · Y {c.pos[1]} · Z {c.pos[2]}
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            {!c.kind.startsWith("player:") && (
              <button className="btn sm" onClick={() => flyTo({ x: c.pos[0], y: c.pos[1], z: c.pos[2], dim: c.dim })}>
                <Box /> Show in 3D
              </button>
            )}
            <button className="iconbtn" onClick={onClose}>
              <X />
            </button>
          </div>
        </div>
        <div className="cv-grid">
          {rows.map((r, i) =>
            r[0] === -1 ? (
              <div key={i} style={{ height: 8 }} />
            ) : (
              <div key={i} className="cv-row">
                {r.map((s) => {
                  const it = bySlot.get(s);
                  return (
                    <div key={s} onClick={() => it && it.contents.length && setInner(inner === s ? null : s)} style={{ cursor: it && it.contents.length ? "pointer" : undefined }}>
                      <Slot item={it} names={data.names} tip={tip} highlight={hl(it) || inner === s} size={44} />
                    </div>
                  );
                })}
              </div>
            ),
          )}
          {isPlayer && (
            <div className="cv-row" style={{ marginTop: 8 }}>
              {[103, 102, 101, 100, -106].map((s) => (
                <Slot key={s} item={bySlot.get(s)} names={data.names} tip={tip} size={44} />
              ))}
            </div>
          )}
        </div>
        {innerItem && (
          <div className="cv-inner">
            <div className="pixlabel" style={{ marginBottom: 8 }}>
              Inside {innerItem.name || data.names[innerItem.id] || prettyId(innerItem.id)}
            </div>
            <div className="cv-row" style={{ flexWrap: "wrap", maxWidth: 9 * 46 }}>
              {Array.from({ length: Math.max(27, innerItem.contents.length) }, (_, i) => innerItem.contents.find((x) => (x.slot ?? -1) === i) ?? (innerItem.contents.every((x) => x.slot === null) ? innerItem.contents[i] : undefined)).map((it, i) => (
                <Slot key={i} item={it} names={data.names} tip={tip} highlight={hl(it)} size={44} />
              ))}
            </div>
          </div>
        )}
        {c.items.some((i) => i.contents.length) && !innerItem && <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>Click a shulker box or bundle to look inside.</div>}
      </motion.div>
      {tip.el}
    </motion.div>
  );
}

export default function Storage() {
  const [tab, setTab] = useState<"search" | "doctor">("search");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [totals, setTotals] = useState<Awaited<ReturnType<typeof api.storageTotals>> | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const tip = useTip();
  const inputRef = useRef<HTMLInputElement>(null);
  const flyTo = useStore((s) => s.flyTo);

  const loadTotals = async () => {
    for (let i = 0; i < 60; i++) {
      const t = await api.storageTotals();
      if (t.ready) {
        setTotals(t);
        return;
      }
      setTotals(t);
      await new Promise((r) => setTimeout(r, 700));
    }
  };
  useEffect(() => {
    loadTotals();
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setHits(null);
      return;
    }
    const t = setTimeout(async () => {
      const r = await api.searchItems(q);
      if (r.ready) {
        setHits(r.hits ?? []);
        setNames(r.names ?? {});
      }
    }, 180);
    return () => clearTimeout(t);
  }, [q, totals?.ready]);

  const totalMatched = useMemo(() => (hits ?? []).reduce((a, h) => a + h.total, 0), [hits]);
  const topItems = useMemo(() => (totals?.items ?? []).slice().sort((a, b) => b.count - a.count), [totals]);
  const tnames = useMemo(() => Object.fromEntries((totals?.items ?? []).map((i) => [i.id, i.name])), [totals]);

  if (tab === "doctor") return <Doctor onSearch={() => setTab("search")} />;

  return (
    <div className="page-pad">
      <div className="page-head">
        <div>
          <div className="kicker">Every chest you've opened</div>
          <h1>Storage</h1>
          <div className="lede">Search across chests, barrels, shulker boxes, minecarts, your inventory and ender chest. Only containers in places you've been are counted.</div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setTab("doctor")} title="Messy chests, split items, shulker boxes and a cleanup plan">
            <Stethoscope /> Storage Doctor
          </button>
          <button
            className="btn"
            disabled={rebuilding}
            onClick={async () => {
              setRebuilding(true);
              await api.rebuildIndex();
              await loadTotals();
              setRebuilding(false);
              setQ((x) => x + "");
            }}
          >
            {rebuilding ? <Spinner size={14} /> : <RefreshCw />} Re-scan
          </button>
        </div>
      </div>
      <div className="search" style={{ marginBottom: 12 }}>
        <Search />
        <input ref={inputRef} className="input" placeholder="Find an item, an enchantment or a name…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 24, flexWrap: "wrap" }}>
        {SUGGEST.map((s) => (
          <button key={s} className={"chip" + (q === s ? " on" : "")} onClick={() => setQ(q === s ? "" : s)}>
            {s}
          </button>
        ))}
      </div>

      {!totals?.ready && (
        <div className="dim" style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Spinner /> Opening every chest in the world (it only takes a moment)…
        </div>
      )}

      {hits && (
        <>
          <div className="pixlabel" style={{ marginBottom: 12 }}>
            {hits.length ? `${fmtNum(totalMatched)} items in ${hits.length} ${hits.length === 1 ? "place" : "places"}` : "No matches"}
          </div>
          <div className="hits">
            {hits.map((h, i) => (
              <motion.div key={h.container} className="hit panel" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 15) * 0.02 }}>
                <button className="hit-head" onClick={() => (sfx.open(), setOpen(h.container))}>
                  <div className="slot" style={{ width: 38, height: 38 }}>
                    <ItemIcon id={kindIcon(h.kind)} size={28} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="hit-name">{h.name || names[h.kind] || prettyId(h.kind)}</div>
                    <div className="coords">
                      {h.kind.startsWith("player:") ? "carried" : `${dimName(h.dim)} · ${h.pos[0]}, ${h.pos[1]}, ${h.pos[2]}`}
                    </div>
                  </div>
                  <div className="hit-total num">{fmtCompact(h.total)}</div>
                </button>
                <div className="hit-items">
                  {h.matches.slice(0, 18).map(([id, count, name, ench, nested], j) => (
                    <div key={j} className={nested ? "nested" : ""} title={nested ? "inside a shulker box or bundle" : undefined}>
                      <Slot item={{ id, count, name, enchants: ench, damage: null, contents: [], slot: null }} names={names} tip={tip} size={36} />
                    </div>
                  ))}
                  {h.matches.length > 18 && <div className="muted" style={{ alignSelf: "center", fontSize: 12 }}>+{h.matches.length - 18}</div>}
                </div>
                {!h.kind.startsWith("player:") && (
                  <button className="hit-go btn ghost sm" onClick={() => flyTo({ x: h.pos[0], y: h.pos[1], z: h.pos[2], dim: h.dim })}>
                    <Box /> 3D
                  </button>
                )}
              </motion.div>
            ))}
          </div>
        </>
      )}

      {!hits && totals?.ready && (
        <div className="storage-overview">
          <div className="panel pad">
            <div className="panel-title">
              <Package size={12} /> Containers
            </div>
            <div className="big-num num">{fmtNum(totals.containers ?? 0)}</div>
            <div className="kinds">
              {Object.entries(totals.kinds ?? {})
                .sort((a, b) => b[1] - a[1])
                .slice(0, 9)
                .map(([k, n]) => (
                  <div key={k} className="kind-row">
                    <ItemIcon id={kindIcon(k)} size={20} />
                    <span>{tnames[k] || prettyId(k.replace("player:", ""))}</span>
                    <span className="num muted">{n}</span>
                  </div>
                ))}
            </div>
          </div>
          <div className="panel pad" style={{ flex: 1 }}>
            <div className="panel-title">Most of anything</div>
            {topItems.length === 0 && <Empty title="No containers found yet" />}
            <div className="item-wall">
              {topItems.slice(0, 96).map((it) => (
                <button key={it.id} className="wall-item" onClick={() => setQ(it.name)} onMouseMove={(e) => tip.show(e, <><div className="t">{it.name}</div><div className="l">{fmtNum(it.count)} in {it.containers} {it.containers === 1 ? "container" : "containers"}</div><div className="g">{it.id}</div></>)} onMouseLeave={tip.hide}>
                  <ItemIcon id={it.id} size={30} />
                  <span className="num">{fmtCompact(it.count)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <AnimatePresence>{open !== null && <ContainerView id={open} onClose={() => (sfx.close(), setOpen(null))} highlight={q} />}</AnimatePresence>
      {tip.el}
    </div>
  );
}
