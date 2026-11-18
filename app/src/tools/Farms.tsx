// Farm Check: every farm Longevity found (or you added), its real rate per hour, what's waiting in
// its output chests, and how the output has grown over your play time.
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Box, Pencil, Plus, RefreshCw, Sparkles, Trash2, EyeOff, Gauge, Info, Check, ChevronRight } from "lucide-react";
import { useStore } from "../store";
import { ItemIcon, Spinner, Empty } from "../ui";
import { sfx } from "../sound";
import { tapi, fmtRate, pretty, type Farm, type FarmReport } from "./tapi";

const KIND_LABEL: Record<string, string> = { iron: "Iron", mob: "Mob", crop: "Crops", animal: "Animals", other: "Other" };
const KIND_ICON: Record<string, string> = { iron: "minecraft:iron_ingot", mob: "minecraft:rotten_flesh", crop: "minecraft:wheat", animal: "minecraft:leather", other: "minecraft:hopper" };
const SOURCE: Record<string, string> = { measured: "Measured in game", rules: "Worked out from the game's rules", "none yet": "Waiting for a measurement" };

function mainItem(f: Farm): [string, number] | null {
  const e = Object.entries(f.rate.per_hour).sort((a, b) => b[1] - a[1])[0];
  return e ? [e[0], e[1]] : null;
}

/** Output rate from the chests themselves: items gained per hour of play between snapshots. */
function chestRate(f: Farm, item: string): number | null {
  const h = f.history;
  if (h.length < 2) return null;
  let gained = 0;
  let ticks = 0;
  for (let i = 1; i < h.length; i++) {
    const dt = h[i].play - h[i - 1].play;
    const d = (h[i].items[item] ?? 0) - (h[i - 1].items[item] ?? 0);
    if (dt <= 0) continue;
    // a drop means you emptied the chest: that stretch can't be measured
    if (d < 0) continue;
    gained += d;
    ticks += dt;
  }
  if (ticks < 20 * 60 * 15) return null; // need 15+ minutes of play
  return gained / (ticks / 72000);
}

function Spark({ f, item }: { f: Farm; item: string }) {
  const pts = f.history.map((h) => [h.play / 72000, h.items[item] ?? 0] as [number, number]);
  if (pts.length < 2) return <div className="fm-spark empty">The chart fills in as you play.</div>;
  const x0 = pts[0][0];
  const x1 = pts[pts.length - 1][0] || x0 + 1;
  const y1 = Math.max(1, ...pts.map((p) => p[1]));
  const W = 260;
  const H = 54;
  const path = pts.map((p, i) => `${i ? "L" : "M"}${(((p[0] - x0) / (x1 - x0 || 1)) * W).toFixed(1)},${(H - (p[1] / y1) * (H - 4) - 2).toFixed(1)}`).join(" ");
  return (
    <svg className="fm-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={path + ` L${W},${H} L0,${H} Z`} className="area" />
      <path d={path} className="line" />
    </svg>
  );
}

function EditFarm({ f, onClose, onSaved }: { f: Farm | null; onClose: () => void; onSaved: () => void }) {
  const world = useStore((s) => s.world)!;
  const p = world.players[0]?.pos ?? [0, 64, 0];
  const [name, setName] = useState(f?.name ?? "My farm");
  const [kind, setKind] = useState<string>(f?.kind ?? "mob");
  const [units, setUnits] = useState(f?.units ?? 1);
  const [c, setC] = useState<[number, number, number]>(f ? f.center : [Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])]);
  const [size, setSize] = useState(16);
  const [outs, setOuts] = useState<string[] | null>(f ? f.outputs.map((o) => o.pos.join(",")) : null);
  async function save() {
    sfx.click();
    const isNew = !f;
    const body: Record<string, unknown> = { id: f?.id, name, kind, units };
    if (isNew || f?.custom) {
      body.custom = true;
      body.dim = f?.dim ?? world.players[0]?.dim ?? "minecraft:overworld";
      body.box = [c[0] - size, c[1] - size, c[2] - size, c[0] + size, c[1] + size, c[2] + size];
    }
    if (outs) body.outputs = outs;
    await tapi.farmSave(body as never);
    onSaved();
    onClose();
  }
  return (
    <motion.div className="modal-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div className="modal fm-edit" initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 8, opacity: 0 }} onClick={(e) => e.stopPropagation()}>
        <h3>{f ? "Edit farm" : "Add a farm"}</h3>
        <label>
          Name
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Type
          <div className="seg">
            {Object.keys(KIND_LABEL).map((k) => (
              <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </label>
        <label>
          How many copies of this farm are there? <span className="muted small">(e.g. 2 iron farm modules)</span>
          <input className="input" type="number" min={1} max={32} value={units} onChange={(e) => setUnits(Math.max(1, +e.target.value || 1))} />
        </label>
        {(!f || f.custom) && (
          <>
            <label>
              Where (the middle of the farm)
              <div className="fm-xyz">
                {(["X", "Y", "Z"] as const).map((l, i) => (
                  <input key={l} className="input" type="number" value={c[i]} onChange={(e) => setC((o) => o.map((v, j) => (j === i ? +e.target.value : v)) as never)} placeholder={l} />
                ))}
              </div>
            </label>
            <label>
              Size (blocks from the middle)
              <input className="input" type="number" min={4} max={64} value={size} onChange={(e) => setSize(+e.target.value || 16)} />
            </label>
          </>
        )}
        {f && f.outputs.length > 0 && (
          <label>
            Output chests <span className="muted small">(untick chests that aren't this farm's)</span>
            <div className="fm-outs">
              {f.outputs.map((o) => {
                const k = o.pos.join(",");
                const on = !outs || outs.includes(k);
                return (
                  <button key={k} className={"chip" + (on ? " on" : "")} onClick={() => setOuts((cur) => (cur ?? f.outputs.map((x) => x.pos.join(","))).filter((x) => x !== k).concat(on ? [] : [k]))}>
                    <ItemIcon id={o.kind} size={14} /> {o.name ?? pretty(o.kind)} · {o.pos.join(", ")}
                  </button>
                );
              })}
            </div>
          </label>
        )}
        <div className="flex gap" style={{ justifyContent: "flex-end", marginTop: 8 }}>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function FarmCard({ f, names, i, reload, edit }: { f: Farm; names: Record<string, string>; i: number; reload: () => void; edit: () => void }) {
  const flyTo = useStore((s) => s.flyTo);
  const m = mainItem(f);
  const cr = m ? chestRate(f, m[0]) : null;
  const items = Object.entries(f.rate.per_hour).sort((a, b) => b[1] - a[1]);
  const stored = Object.entries(f.stored)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  return (
    <motion.div id={"farm-" + f.id} className="fm-card glass" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 10) * 0.04 }}>
      <div className="fm-top">
        <div className="slot fm-ic">
          <ItemIcon id={m?.[0] ?? KIND_ICON[f.kind]} size={30} />
        </div>
        <div className="grow">
          <div className="fm-name">
            {f.name}
            {f.units > 1 && <span className="chip">×{f.units}</span>}
            {!f.auto && <span className="chip">by hand</span>}
          </div>
          <div className="muted small">
            {KIND_LABEL[f.kind]} · {f.center.join(", ")}
            {f.dim !== "minecraft:overworld" ? ` · ${pretty(f.dim)}` : ""}
          </div>
        </div>
        <div className="fm-acts">
          <button className="iconbtn" title="Show in 3D" onClick={() => flyTo({ x: f.center[0], y: f.center[1], z: f.center[2], dim: f.dim })}>
            <Box size={15} />
          </button>
          {f.outputs.length > 0 && (
            <button
              className="iconbtn"
              title="Glow its output chests in game"
              onClick={() =>
                tapi
                  .find(f.name + " output", f.outputs.map((o) => ({ pos: o.pos, dim: f.dim })))
                  .then(() => useStore.getState().toastMsg("Its chests will glow in game for 5 minutes"))
              }
            >
              <Sparkles size={15} />
            </button>
          )}
          {f.maybe && (
            <button
              className="btn sm"
              title="Count it as one of your farms"
              onClick={async () => {
                sfx.click();
                await tapi.farmSave({ id: f.id, confirmed: true });
                reload();
              }}
            >
              <Check size={13} /> It's mine
            </button>
          )}
          <button className="iconbtn" title="Edit" onClick={edit}>
            <Pencil size={15} />
          </button>
          <button
            className="iconbtn"
            title={f.custom ? "Delete" : "Not a farm: hide it"}
            onClick={async () => {
              sfx.click();
              await tapi.farmDelete(f.id);
              reload();
            }}
          >
            {f.custom ? <Trash2 size={15} /> : <EyeOff size={15} />}
          </button>
        </div>
      </div>
      <div className="fm-rate">
        {m ? (
          <>
            <div className="fm-big">
              {fmtRate(m[1])}
              <span>/ hour</span>
            </div>
            <div className="fm-src" title={SOURCE[f.rate.source]}>
              <Gauge size={12} /> {SOURCE[f.rate.source]}
              {f.rate.source === "rules" && f.rate.measured && <> · measuring ({Math.round(f.rate.measured.minutes)} of 10 min)</>}
            </div>
          </>
        ) : (
          <div className="muted small">Play near it with the companion mod and Longevity measures it for you.</div>
        )}
      </div>
      <div className="fm-items">
        {items.map(([id, n]) => (
          <span key={id} className="fm-item" title={names[id] ?? pretty(id)}>
            <ItemIcon id={id} size={18} />
            <b>{fmtRate(n)}</b>
            <i>{names[id] ?? pretty(id)}</i>
          </span>
        ))}
      </div>
      {cr !== null && m && (
        <div className="fm-cr">
          From its chests over your play time: <b>{fmtRate(cr)}</b> {names[m[0]] ?? pretty(m[0])} an hour
        </div>
      )}
      {m && <Spark f={f} item={m[0]} />}
      <div className="fm-foot">
        {stored.length > 0 ? (
          <div className="fm-stored">
            <span className="muted small">Waiting in its chests</span>
            {stored.map(([id, n]) => (
              <span key={id} className="fm-sitem">
                <ItemIcon id={id} size={16} /> {n.toLocaleString()}
              </span>
            ))}
          </div>
        ) : (
          <span className="muted small">{f.outputs.length ? "Its chests are empty" : "No output chests found near it"}</span>
        )}
      </div>
      <div className="fm-why">
        <Info size={11} /> {f.why.join(" · ")}
      </div>
    </motion.div>
  );
}

export default function Farms() {
  const world = useStore((s) => s.world)!;
  const [r, setR] = useState<FarmReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Farm | null | "new">(null);
  const [filter, setFilter] = useState("all");
  const load = () => {
    setErr(null);
    tapi
      .farms()
      .then(setR)
      .catch((e) => setErr(String(e)));
  };
  useEffect(load, [world.path]);
  // opened from Ctrl+K on one farm: scroll to it
  useEffect(() => {
    const f = useStore.getState().toolFocus;
    if (!r || f?.page !== "farms") return;
    useStore.setState({ toolFocus: null });
    setTimeout(() => document.getElementById("farm-" + f.id)?.scrollIntoView({ behavior: "smooth", block: "center" }), 350);
  }, [r]);

  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of r?.farms ?? []) if (!f.maybe) for (const [k, v] of Object.entries(f.rate.per_hour)) m.set(k, (m.get(k) ?? 0) + v);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [r]);

  if (err) return <Empty title="Couldn't check your farms">{err}</Empty>;
  if (!r)
    return (
      <div className="page-pad center-fill">
        <Spinner size={22} /> <span className="muted">Looking for farms around your base…</span>
      </div>
    );
  const shown = r.farms.filter((f) => filter === "all" || f.kind === filter);
  const farms = shown.filter((f) => !f.maybe);
  const maybes = shown.filter((f) => f.maybe);
  return (
    <div className="page-pad fm-page">
      <div className="tool-head">
        <div>
          <div className="kicker">World · Farm Check</div>
          <h1>Farms</h1>
          <p>Found from the blocks and mobs around where you spend time. Rates start from the game's own rules and switch to real measurements once the companion mod has watched a farm for 10 minutes.</p>
        </div>
        <div className="flex gap">
          <button className="btn" onClick={() => setEditing("new")}>
            <Plus size={14} /> Add a farm
          </button>
          <button className="iconbtn" onClick={load} title="Look again">
            <RefreshCw size={15} />
          </button>
        </div>
      </div>
      {totals.length > 0 && (
        <div className="fm-total glass">
          <span className="kicker">All farms, per hour</span>
          <div className="fm-tlist">
            {totals.map(([id, n]) => (
              <span key={id} className="fm-titem">
                <ItemIcon id={id} size={22} />
                <b>{fmtRate(n)}</b>
                <i>{r.names[id] ?? pretty(id)}</i>
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="vr-filter" style={{ margin: "14px 0" }}>
        {["all", "iron", "mob", "crop", "animal", "other"].map((k) => (
          <button key={k} className={"chip" + (filter === k ? " on" : "")} onClick={() => setFilter(k)}>
            {k === "all" ? `All (${r.farms.length})` : `${KIND_LABEL[k]} (${r.farms.filter((f) => f.kind === k).length})`}
          </button>
        ))}
      </div>
      {farms.length === 0 && maybes.length === 0 ? (
        <Empty title="No farms found here yet">Longevity looks around the places you spend the most time. If it missed one, add it and it'll measure it while you play.</Empty>
      ) : (
        <div className="fm-grid">
          {farms.map((f, i) => (
            <FarmCard key={f.id} f={f} names={r.names} i={i} reload={load} edit={() => setEditing(f)} />
          ))}
        </div>
      )}
      {maybes.length > 0 && (
        <details className="fm-maybe">
          <summary>
            <ChevronRight size={14} /> Might be farms ({maybes.length})
            <span className="muted small"> · wild sugar cane, village fields and such. They don't count until you say one is yours.</span>
          </summary>
          <div className="fm-grid">
            {maybes.map((f, i) => (
              <FarmCard key={f.id} f={f} names={r.names} i={i} reload={load} edit={() => setEditing(f)} />
            ))}
          </div>
        </details>
      )}
      <AnimatePresence>{editing && <EditFarm f={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}</AnimatePresence>
    </div>
  );
}
