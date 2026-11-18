// Storage Doctor: messy chests, items split across many chests, what's in your shulker boxes, and
// a step-by-step cleanup plan the companion mod can walk you through in game with glowing chests.
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Stethoscope, Search, Sparkles, Package, ListChecks, Play, Square, Eye, ArrowRight, Check } from "lucide-react";
import { useStore } from "../store";
import { ItemIcon, Spinner, Empty } from "../ui";
import { sfx } from "../sound";
import { dimName } from "../api";
import { tapi, pretty, type Doctor as D, type Pos } from "./tapi";

type Tab = "messy" | "split" | "shulkers" | "plan";
const p3 = (p: Pos) => `${Math.floor(p[0])}, ${Math.floor(p[1])}, ${Math.floor(p[2])}`;

export default function Doctor({ onSearch }: { onSearch: () => void }) {
  const world = useStore((s) => s.world)!;
  const flyTo = useStore((s) => s.flyTo);
  const toast = useStore((s) => s.toastMsg);
  const [d, setD] = useState<D | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("messy");

  const load = () => {
    setErr(null);
    tapi
      .doctor()
      .then(setD)
      .catch((e) => setErr(String(e)));
  };
  useEffect(load, [world.path]);

  async function glow(label: string, targets: { pos: Pos; dim: string }[]) {
    sfx.click();
    try {
      await tapi.find(label, targets);
      toast("Those chests will glow in game for 5 minutes.");
    } catch (e) {
      toast(String(e));
    }
  }
  async function startGuide() {
    if (!d) return;
    sfx.open();
    await tapi.guide({ plan: "cleanup-" + Date.now(), title: "Storage cleanup", step: 0, steps: d.plan });
    toast("Cleanup started. In game, the chest to take from glows first, then the one to put into.");
    load();
  }
  async function stopGuide() {
    await tapi.guide(null);
    load();
  }

  const head = (
    <div className="tool-head">
      <div>
        <div className="kicker">Storage · Doctor</div>
        <h1>Storage Doctor</h1>
        <p>
          {d?.ready
            ? `${d.summary.containers} containers, ${Math.round((d.summary.used / Math.max(1, d.summary.slots)) * 100)}% full. ${d.summary.messy} messy, ${d.summary.split} items split up, ${d.summary.mergeable} stacks that could merge.`
            : "Finds messy chests, items scattered across your base, and what's packed in your shulker boxes."}
        </p>
      </div>
      <div className="tabs">
        <button onClick={onSearch}>
          <Search size={13} /> Search
        </button>
        <button className="on">
          <Stethoscope size={13} /> Doctor
        </button>
      </div>
    </div>
  );

  if (err)
    return (
      <div className="page-pad">
        {head}
        <Empty title="Couldn't check your storage">{err}</Empty>
      </div>
    );
  if (!d)
    return (
      <div className="page-pad">
        {head}
        <div className="center-fill">
          <Spinner size={22} />
        </div>
      </div>
    );
  if (!d.ready)
    return (
      <div className="page-pad">
        {head}
        <Empty title="Still opening every chest">Give it a moment and try again.</Empty>
      </div>
    );

  const messy = d.chests.filter((c) => c.messy);
  const full = d.summary.used / Math.max(1, d.summary.slots);

  return (
    <div className="page-pad dr-page">
      {head}
      <div className="statgrid">
        <div className="stat">
          <b>{d.summary.free.toLocaleString()}</b>
          <span>free slots</span>
          <div className="pbar thin">
            <i style={{ width: `${full * 100}%` }} />
          </div>
        </div>
        <div className="stat">
          <b>{d.summary.messy}</b>
          <span>messy chests</span>
        </div>
        <div className="stat">
          <b>{d.summary.split}</b>
          <span>items split up</span>
        </div>
        <div className="stat">
          <b>{d.summary.shulkers}</b>
          <span>shulker boxes</span>
        </div>
      </div>
      <div className="vr-filter" style={{ margin: "16px 0" }}>
        {(
          [
            ["messy", "Messy chests", Sparkles, messy.length],
            ["split", "Split items", Package, d.split.length],
            ["shulkers", "Shulker boxes", Package, d.shulkers.length],
            ["plan", "Cleanup plan", ListChecks, d.plan.length],
          ] as const
        ).map(([id, label, Icon, n]) => (
          <button key={id} className={"chip" + (tab === id ? " on" : "")} onClick={() => setTab(id)}>
            <Icon size={12} /> {label} ({n})
          </button>
        ))}
      </div>

      {tab === "messy" &&
        (messy.length === 0 ? (
          <Empty title="No messy chests">Every chest sticks to a few kinds of thing. Nice.</Empty>
        ) : (
          <div className="dr-grid">
            {messy.map((c, i) => (
              <motion.div key={c.group} className="dr-card glass" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.03 }}>
                <div className="dr-top">
                  <ItemIcon id={c.kind} size={26} />
                  <div className="grow">
                    <b>{c.name ?? (c.double ? "Double chest" : pretty(c.kind))}</b>
                    <div className="muted small">
                      {p3(c.pos)} · {dimName(c.dim)}
                    </div>
                  </div>
                  <span className="chip warn">{c.distinct} kinds</span>
                </div>
                <div className="dr-fams">
                  {c.families.map((f) => (
                    <span key={f}>{f}</span>
                  ))}
                </div>
                <div className="dr-items">
                  {c.top.slice(0, 12).map(([id, n, name]) => (
                    <span key={id} title={`${name} ×${n}`}>
                      <ItemIcon id={id} size={20} />
                    </span>
                  ))}
                </div>
                <div className="dr-foot">
                  <span className="muted small">
                    {c.used}/{c.slots} slots{c.mergeable ? ` · ${c.mergeable} stack${c.mergeable === 1 ? "" : "s"} could merge` : ""}
                  </span>
                  <button className="iconbtn" title="Show in 3D" onClick={() => flyTo({ x: c.pos[0], y: c.pos[1], z: c.pos[2], dim: c.dim })}>
                    <Eye size={14} />
                  </button>
                  <button className="btn sm" onClick={() => glow(c.name ?? "Messy chest", [{ pos: c.pos, dim: c.dim }])}>
                    <Sparkles size={12} /> Glow
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        ))}

      {tab === "split" &&
        (d.split.length === 0 ? (
          <Empty title="Nothing's scattered">Each item lives in one place.</Empty>
        ) : (
          <div className="dr-list">
            {d.split.map((s) => (
              <div key={s.id} className="dr-row glass">
                <ItemIcon id={s.id} size={26} />
                <div className="grow">
                  <b>{s.name}</b>
                  <div className="muted small">
                    {s.total.toLocaleString()} in {s.chests} containers · fits in {s.stacks_needed} stack{s.stacks_needed === 1 ? "" : "s"}
                  </div>
                  <div className="dr-where">
                    {s.where.slice(0, 6).map((w, i) => (
                      <span key={i} className={w.pos.join() === s.home.join() ? "home" : ""}>
                        {p3(w.pos)} ×{w.count}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="dr-home">
                  <span className="muted small">Best home</span>
                  <b>{p3(s.home)}</b>
                  <span className="muted small">{s.home_free} free slots</span>
                </div>
                <button className="btn sm" onClick={() => glow(s.name, s.where.map((w) => ({ pos: w.pos, dim: w.dim })))}>
                  <Sparkles size={12} /> Glow all
                </button>
              </div>
            ))}
          </div>
        ))}

      {tab === "shulkers" &&
        (d.shulkers.length === 0 ? (
          <Empty title="No shulker boxes found" />
        ) : (
          <div className="dr-grid">
            {d.shulkers.map((s, i) => (
              <div key={i} className={"dr-card glass" + (s.mixed ? " mixed" : "")}>
                <div className="dr-top">
                  <ItemIcon id={s.id} size={26} />
                  <div className="grow">
                    <b>{s.name ?? pretty(s.id)}</b>
                    <div className="muted small">
                      {s.in_kind === "placed" ? "Placed" : `In a ${pretty(s.in_kind).toLowerCase()}`} at {p3(s.in)}
                    </div>
                  </div>
                  <span className={"chip" + (s.mixed ? " warn" : "")}>
                    {s.slots_used}/27{s.mixed ? " · mixed" : ""}
                  </span>
                </div>
                <div className="dr-items">
                  {s.contents.slice(0, 27).map(([id, n, name], j) => (
                    <span key={j} title={`${name} ×${n}`}>
                      <ItemIcon id={id} size={20} />
                      {n > 1 && <i>{n}</i>}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}

      {tab === "plan" &&
        (d.plan.length === 0 ? (
          <Empty title="Nothing to move">Your storage is already in good shape.</Empty>
        ) : (
          <div className="dr-plan glass">
            <div className="dr-plan-head">
              <div>
                <b>{d.plan.length} moves</b>
                <div className="muted small">Each move takes one item from a chest to its best home. In game, the chest to take from glows first, then the one to put it in, and it ticks off by itself.</div>
              </div>
              {d.guide && !d.guide.done ? (
                <button className="btn" onClick={stopGuide}>
                  <Square size={13} /> Stop the guide ({d.guide.step}/{d.plan.length})
                </button>
              ) : (
                <button className="btn primary" onClick={startGuide}>
                  <Play size={13} /> Start in game
                </button>
              )}
            </div>
            <ol className="dr-steps">
              {d.plan.map((s, i) => {
                const done = !!d.guide && i < d.guide.step;
                return (
                  <li key={i} className={done ? "done" : d.guide && i === d.guide.step ? "now" : ""}>
                    <span className="ap-n">{done ? <Check size={11} /> : i + 1}</span>
                    <ItemIcon id={s.item} size={20} />
                    <span className="grow">
                      {s.count} {s.name}
                    </span>
                    <span className="muted small">{p3(s.take)}</span>
                    <ArrowRight size={12} />
                    <span className="small">{p3(s.put)}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
    </div>
  );
}
