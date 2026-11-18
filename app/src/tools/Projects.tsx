// Project Planner: ready-made goals (beacon, conduit, netherite, every disc…) and your own, with
// progress counted from all your chests, shulkers, inventory and ender chest; where to get what's
// missing (your farms and villagers first); and pins for Home and the in-game checklist.
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Pin, PinOff, Plus, Trash2, Target, Search, Check, ChevronDown, Clock3 } from "lucide-react";
import { useStore } from "../store";
import { ItemIcon, Spinner, Empty } from "../ui";
import { sfx } from "../sound";
import { api } from "../api";
import { tapi, pretty, type Project, type GoalItem } from "./tapi";
import { gd } from "./gd";
import { whereToGet, setWorldSources } from "./where";

const DISCS = ["13", "cat", "blocks", "chirp", "far", "mall", "mellohi", "stal", "strad", "ward", "11", "wait", "otherside", "5", "pigstep", "relic", "creator", "creator_music_box", "precipice", "tears", "lava_chicken"];
const TRIMS = ["sentry", "dune", "coast", "wild", "ward", "eye", "vex", "tide", "snout", "rib", "spire", "wayfinder", "shaper", "silence", "raiser", "host", "flow", "bolt"];
const COLORS = ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"];
const m = (id: string) => "minecraft:" + id;

export const TEMPLATES: { id: string; name: string; blurb: string; icon: string; items: GoalItem[] }[] = [
  {
    id: "beacon",
    name: "Full beacon",
    blurb: "A 4-layer pyramid (164 blocks) for every effect plus the second power.",
    icon: m("beacon"),
    items: [
      { id: m("iron_block"), need: 164 },
      { id: m("nether_star"), need: 1 },
      { id: m("glass"), need: 5 },
      { id: m("obsidian"), need: 3 },
    ],
  },
  {
    id: "conduit",
    name: "Full-power conduit",
    blurb: "42 prismarine blocks around it for the full 96-block range and killing hostile mobs.",
    icon: m("conduit"),
    items: [
      { id: m("heart_of_the_sea"), need: 1 },
      { id: m("nautilus_shell"), need: 8 },
      { id: m("prismarine_bricks"), need: 42 },
    ],
  },
  {
    id: "netherite_armor",
    name: "Netherite armor",
    blurb: "All four pieces upgraded on a smithing table.",
    icon: m("netherite_chestplate"),
    items: [
      { id: m("netherite_ingot"), need: 4 },
      { id: m("netherite_upgrade_smithing_template"), need: 4 },
      { id: m("diamond"), need: 24 },
    ],
  },
  {
    id: "netherite_tools",
    name: "Netherite tools",
    blurb: "Sword, pickaxe, axe, shovel and hoe.",
    icon: m("netherite_pickaxe"),
    items: [
      { id: m("netherite_ingot"), need: 5 },
      { id: m("netherite_upgrade_smithing_template"), need: 5 },
      { id: m("diamond"), need: 11 },
    ],
  },
  {
    id: "elytra_kit",
    name: "Elytra kit",
    blurb: "Wings plus a good stack of rockets.",
    icon: m("elytra"),
    items: [
      { id: m("elytra"), need: 1 },
      { id: m("firework_rocket"), need: 256 },
      { id: m("gunpowder"), need: 128 },
      { id: m("paper"), need: 128 },
    ],
  },
  {
    id: "wither",
    name: "Fight the Wither",
    blurb: "The summon plus what you'll want with you.",
    icon: m("wither_skeleton_skull"),
    items: [
      { id: m("wither_skeleton_skull"), need: 3 },
      { id: m("soul_sand"), need: 4 },
      { id: m("golden_apple"), need: 16 },
      { id: m("milk_bucket"), need: 2 },
    ],
  },
  { id: "totems", name: "Totem stash", blurb: "Enough totems to stop worrying.", icon: m("totem_of_undying"), items: [{ id: m("totem_of_undying"), need: 8 }] },
  { id: "discs", name: "Every music disc", blurb: "The full jukebox collection.", icon: m("music_disc_pigstep"), items: DISCS.map((d) => ({ id: m("music_disc_" + d), need: 1 })) },
  { id: "trims", name: "Every armor trim", blurb: "One of each smithing template.", icon: m("silence_armor_trim_smithing_template"), items: TRIMS.map((t) => ({ id: m(`${t}_armor_trim_smithing_template`), need: 1 })) },
  { id: "shulkers", name: "Shulker box wall", blurb: "One of every colour.", icon: m("purple_shulker_box"), items: COLORS.map((c) => ({ id: m(`${c}_shulker_box`), need: 1 })) },
  { id: "dyes", name: "Every dye", blurb: "A stack of each of the 16 dyes.", icon: m("red_dye"), items: COLORS.map((c) => ({ id: m(`${c}_dye`), need: 64 })) },
  {
    id: "gapples",
    name: "Golden apple stock",
    blurb: "For the next big fight.",
    icon: m("golden_apple"),
    items: [
      { id: m("golden_apple"), need: 32 },
      { id: m("enchanted_golden_apple"), need: 2 },
    ],
  },
];

function GoalCard({ p, names, onChange, onDelete, i, focus }: { p: Project; names: Record<string, string>; onChange: (p: Project) => void; onDelete: () => void; i: number; focus?: boolean }) {
  const [open, setOpen] = useState(!!focus);
  const prog = p.progress ?? 0;
  const missing = p.items.filter((it) => (it.have ?? 0) < it.need);
  return (
    <motion.div className={"pj-card glass" + (prog >= 1 ? " done" : "")} layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.04 }}>
      <div className="pj-top" onClick={() => setOpen(!open)}>
        <div className="slot" style={{ width: 44, height: 44 }}>
          <ItemIcon id={TEMPLATES.find((t) => t.id === p.template)?.icon ?? p.items[0]?.id ?? m("chest")} size={30} />
        </div>
        <div className="grow">
          <div className="pj-name">
            {p.name}
            {prog >= 1 && (
              <span className="chip good">
                <Check size={11} /> Done
              </span>
            )}
          </div>
          <div className="pbar">
            <i style={{ width: `${Math.round(prog * 100)}%` }} />
          </div>
          <div className="muted small">
            {Math.round(prog * 100)}% · {missing.length ? `${missing.length} of ${p.items.length} items still needed` : "you have everything"}
          </div>
        </div>
        <button
          className={"iconbtn" + (p.pinned ? " on" : "")}
          title={p.pinned ? "Unpin (Home + in-game checklist)" : "Pin to Home and the in-game checklist"}
          onClick={(e) => {
            e.stopPropagation();
            sfx.click();
            onChange({ ...p, pinned: !p.pinned });
          }}
        >
          {p.pinned ? <Pin size={15} /> : <PinOff size={15} />}
        </button>
        <ChevronDown size={16} className={"pj-chev" + (open ? " open" : "")} />
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="pj-items" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            {p.items.map((it, j) => {
              const have = it.have ?? 0;
              const left = Math.max(0, it.need - have);
              const src = left > 0 ? whereToGet(it.id) : [];
              const farm = src.find((s) => s.rate);
              return (
                <div key={j} className={"pj-item" + (left === 0 ? " ok" : "")}>
                  <ItemIcon id={it.id} size={24} />
                  <div className="grow">
                    <div className="pj-iname">
                      {it.name ?? names[it.id] ?? pretty(it.id)}
                      <span className="pj-count">
                        {have.toLocaleString()} / {it.need.toLocaleString()}
                      </span>
                    </div>
                    <div className="pbar thin">
                      <i style={{ width: `${Math.min(100, (have / it.need) * 100)}%` }} />
                    </div>
                    {left > 0 && (
                      <div className="pj-src">
                        {farm?.rate && (
                          <span className="pj-eta">
                            <Clock3 size={11} /> ~{fmtEta(left / farm.rate)} of play from your farm
                          </span>
                        )}
                        {src.slice(0, 3).map((s, k) => (
                          <span key={k} className={"pj-s " + s.kind}>
                            {s.text}
                          </span>
                        ))}
                        {src.length === 0 && <span className="pj-s hint">Not something Longevity can find a source for yet.</span>}
                      </div>
                    )}
                  </div>
                  <input
                    className="input pj-need"
                    type="number"
                    min={1}
                    value={it.need}
                    title="How many you need"
                    onChange={(e) => onChange({ ...p, items: p.items.map((x, k) => (k === j ? { ...x, need: Math.max(1, +e.target.value || 1) } : x)) })}
                  />
                  <button className="iconbtn" title="Remove" onClick={() => onChange({ ...p, items: p.items.filter((_, k) => k !== j) })}>
                    ×
                  </button>
                </div>
              );
            })}
            <div className="pj-foot">
              <AddItem onAdd={(id) => onChange({ ...p, items: [...p.items, { id, need: 1 }] })} />
              <button className="btn ghost sm" onClick={onDelete}>
                <Trash2 size={13} /> Delete goal
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function fmtEta(hours: number) {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
  return `${Math.round(hours / 24)} days`;
}

function AddItem({ onAdd }: { onAdd: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [pool, setPool] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    const items = gd.items();
    if (items) setPool(Object.entries(items).map(([id, v]) => ({ id, name: v.name })));
    else
      api
        .storageTotals()
        .then((t: { items?: { id: string; name: string }[] }) => setPool((t.items ?? []).map((x) => ({ id: x.id, name: x.name }))))
        .catch(() => {});
  }, []);
  const hits = q.length < 2 ? [] : pool.filter((x) => x.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  return (
    <div className="pj-add">
      <div className="search">
        <Search size={13} />
        <input className="input" placeholder="Add an item…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {hits.length > 0 && (
        <div className="pj-hits glass">
          {hits.map((h) => (
            <button
              key={h.id}
              onClick={() => {
                onAdd(h.id);
                setQ("");
              }}
            >
              <ItemIcon id={h.id} size={18} /> {h.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Projects() {
  const world = useStore((s) => s.world)!;
  const [list, setList] = useState<Project[] | null>(null);
  const [names] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [custom, setCustom] = useState("");
  const [focusId] = useState(() => {
    const f = useStore.getState().toolFocus;
    if (f?.page !== "projects") return null;
    useStore.setState({ toolFocus: null });
    return f.id;
  });

  useEffect(() => {
    gd.preload().then(() => Promise.all([gd.load("recipes"), gd.load("mobs"), gd.load("loot")])).catch(() => {});
    tapi
      .projects()
      .then((r) => setList(r.projects))
      .catch((e) => setErr(String(e)));
    Promise.all([tapi.farms().catch(() => null), tapi.villagers().catch(() => null)]).then(([f, v]) => setWorldSources(f, v));
  }, [world.path]);

  async function save(next: Project[]) {
    setList(next);
    const r = await tapi.projectsSave(next).catch((e) => {
      useStore.getState().toastMsg(String(e));
      return null;
    });
    if (r) setList(r.projects);
  }

  const used = useMemo(() => new Set((list ?? []).map((p) => p.template)), [list]);
  if (err) return <Empty title="Couldn't load your goals">{err}</Empty>;
  if (!list)
    return (
      <div className="page-pad center-fill">
        <Spinner size={22} />
      </div>
    );
  const active = list.filter((p) => (p.progress ?? 0) < 1);
  const done = list.filter((p) => (p.progress ?? 0) >= 1);
  return (
    <div className="page-pad pj-page">
      <div className="tool-head">
        <div>
          <div className="kicker">Plan · Project Planner</div>
          <h1>Projects</h1>
          <p>Progress counts everything in your chests, shulker boxes, inventory and ender chest. Pinned goals show on Home and as a checklist in game.</p>
        </div>
        <button className="btn primary" onClick={() => setAdding(!adding)}>
          <Plus size={14} /> New goal
        </button>
      </div>
      <AnimatePresence>
        {adding && (
          <motion.div className="pj-new glass" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
            <div className="kicker">Ready-made</div>
            <div className="pj-tpls">
              {TEMPLATES.filter((t) => !used.has(t.id)).map((t) => (
                <button
                  key={t.id}
                  className="pj-tpl"
                  onClick={() => {
                    sfx.open();
                    setAdding(false);
                    save([...list, { id: t.id + "-" + Date.now(), name: t.name, template: t.id, pinned: true, created: Date.now(), items: t.items.map((x) => ({ ...x })) }]);
                  }}
                >
                  <ItemIcon id={t.icon} size={28} />
                  <b>{t.name}</b>
                  <span>{t.blurb}</span>
                </button>
              ))}
            </div>
            <div className="kicker" style={{ marginTop: 12 }}>
              Your own
            </div>
            <div className="flex gap">
              <input className="input grow" placeholder="Name it: Mega base, Mob tower, Stock up for the End…" value={custom} onChange={(e) => setCustom(e.target.value)} />
              <button
                className="btn"
                disabled={!custom.trim()}
                onClick={() => {
                  setAdding(false);
                  save([...list, { id: "custom-" + Date.now(), name: custom.trim(), pinned: true, created: Date.now(), items: [] }]);
                  setCustom("");
                }}
              >
                <Target size={14} /> Create
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {list.length === 0 && !adding && <Empty title="No goals yet">Pick a ready-made one like the full beacon, or make your own.</Empty>}
      <div className="pj-list">
        {active.map((p, i) => (
          <GoalCard key={p.id} p={p} i={i} focus={p.id === focusId} names={names} onChange={(np) => save(list.map((x) => (x.id === p.id ? np : x)))} onDelete={() => save(list.filter((x) => x.id !== p.id))} />
        ))}
      </div>
      {done.length > 0 && (
        <>
          <h3 className="vr-h">Done</h3>
          <div className="pj-list">
            {done.map((p, i) => (
              <GoalCard key={p.id} p={p} i={i} names={names} onChange={(np) => save(list.map((x) => (x.id === p.id ? np : x)))} onDelete={() => save(list.filter((x) => x.id !== p.id))} />
            ))}
          </div>
        </>
      )}
      <p className="muted small" style={{ marginTop: 18 }}>
        Time estimates use your farms' rates from Farm Check.
      </p>
    </div>
  );
}
