// Gear Check (what's missing from your gear, on a 3D stand wearing it) and the Anvil Planner
// (the cheapest order to put books on an item, using the books you actually own).
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Hammer, Shield, RefreshCw, Plus, X, AlertTriangle, ArrowRight, BookOpen, Check } from "lucide-react";
import { useStore } from "../store";
import { ItemIcon, Spinner, Empty } from "../ui";
import { sfx } from "../sound";
import { blockTex } from "../api";
import { SkinViewer, type GearOn } from "../render/skinview";
import { api as lapi, skinUrl } from "../launcher/api";
import { tapi, pretty, type Gear as GearData, type GearItem } from "./tapi";
import { ENCH, bestSet, enchLabel, enchName, gaps, maxDurability, planAnvil, planPoints, workFromRepairCost, ench, conflicts, type Piece } from "./enchants";
import { gd } from "./gd";

const SLOT_LABEL: Record<string, string> = { head: "Helmet", chest: "Chest", legs: "Leggings", feet: "Boots", mainhand: "Main hand", offhand: "Off hand", body: "Body" };
const SLOT_ORDER = ["head", "chest", "legs", "feet", "mainhand", "offhand"];

export async function currentSkin(): Promise<{ url: string; slim: boolean }> {
  try {
    const { skins, profiles } = await lapi.skins();
    const active = profiles.find((p) => p.active);
    const s = skins.find((k) => active && k.source === `account:${active.name}`) ?? skins.find((k) => k.source.startsWith("account:"));
    if (s) return { url: skinUrl(s.id), slim: s.model === "slim" };
  } catch {
    /* fall back to Steve */
  }
  return { url: blockTex("entity/player/wide/steve"), slim: false };
}

export function GearStand({ equipped, className }: { equipped: Record<string, GearItem>; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<SkinViewer | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const v = new SkinViewer(host.current);
    viewer.current = v;
    let alive = true;
    currentSkin().then(async (s) => {
      if (!alive) return;
      await v.load(s.url, s.slim).catch(() => {});
      await v.setGear(gearOn(equipped));
    });
    return () => {
      alive = false;
      v.dispose();
    };
  }, []);
  useEffect(() => {
    viewer.current?.setGear(gearOn(equipped));
  }, [JSON.stringify(Object.values(equipped).map((e) => e.id + e.ench.length))]);
  return <div className={"gear-stand " + (className ?? "")} ref={host} />;
}

export function gearOn(eq: Record<string, GearItem>): GearOn {
  const shine = (k: string) => (eq[k]?.ench?.length ?? 0) > 0;
  return {
    head: eq.head?.id,
    chest: eq.chest?.id === "minecraft:elytra" ? undefined : eq.chest?.id,
    legs: eq.legs?.id,
    feet: eq.feet?.id,
    mainhand: eq.mainhand?.id,
    offhand: eq.offhand?.id,
    elytra: eq.chest?.id === "minecraft:elytra",
    shine: { head: shine("head"), chest: shine("chest"), legs: shine("legs"), feet: shine("feet") },
  };
}

function Durability({ it }: { it: GearItem }) {
  const max = maxDurability(it.id);
  if (!max) return null;
  const left = Math.max(0, max - (it.damage ?? 0));
  const f = left / max;
  return (
    <div className="dur" title={`${left} / ${max} durability`}>
      <i style={{ width: `${f * 100}%`, background: `hsl(${Math.round(f * 120)} 70% 50%)` }} />
      <span>{f >= 0.999 ? "Like new" : `${Math.round(f * 100)}%`}</span>
    </div>
  );
}

function GearCard({ slot, it, names, onPlan }: { slot?: string; it: GearItem; names: Record<string, string>; onPlan: (it: GearItem) => void }) {
  const g = gaps(it.id, it.ench);
  const done = g && g.length === 0;
  return (
    <div className={"gcard glass" + (done ? " done" : "")}>
      <div className="gc-top">
        <div className="slot" style={{ width: 44, height: 44 }}>
          <ItemIcon id={it.id} size={30} />
        </div>
        <div className="grow">
          {slot && <div className="kicker">{SLOT_LABEL[slot] ?? slot}</div>}
          <div className="gc-name">{it.name ?? names[it.id] ?? pretty(it.id)}</div>
          <Durability it={it} />
        </div>
        {g && !done && (
          <button className="btn sm" onClick={() => onPlan(it)} title="Plan the anvil for this">
            <Hammer size={13} /> Plan
          </button>
        )}
        {done && (
          <span className="chip good">
            <Check size={12} /> Maxed
          </span>
        )}
      </div>
      <div className="gc-ench">
        {[...it.ench]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([k, l]) => (
            <span key={k} className={"ench" + (k.includes("curse") ? " curse" : l >= ench(k).max ? " max" : "")}>
              {enchLabel(k, l)}
            </span>
          ))}
        {g && g.length > 0 && <span className="gc-miss">{it.ench.length ? "Missing" : "Best to add"}</span>}
        {g?.map((x, i) => (
          <span key={i} className="ench missing" title={x.have ? `You have ${enchLabel(x.have[0], x.have[1])}` : "Missing"}>
            {x.have ? `${enchLabel(x.have[0], x.have[1])} → ${enchLabel(x.want[0][0], x.want[0][1])}` : x.want.map(([k, l]) => enchLabel(k, l)).join(" or ")}
          </span>
        ))}
        {!g && it.ench.length === 0 && <span className="muted small">No enchantments</span>}
      </div>
      {it.trim && (
        <div className="muted small">
          Trim: {pretty(it.trim[0])} in {pretty(it.trim[1])}
        </div>
      )}
      {(it.repair_cost ?? 0) > 0 && (
        <div className="muted small">
          Been on an anvil {workFromRepairCost(it.repair_cost)} time{workFromRepairCost(it.repair_cost) === 1 ? "" : "s"}, so every anvil job on it costs {it.repair_cost} more level{it.repair_cost === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- anvil planner

interface BookChoice {
  key: string;
  ench: [string, number][];
  work: number;
  owned: boolean;
  where?: string;
}

const FRESH = ["netherite_sword", "netherite_pickaxe", "netherite_axe", "netherite_shovel", "netherite_hoe", "netherite_helmet", "netherite_chestplate", "netherite_leggings", "netherite_boots", "bow", "crossbow", "trident", "mace", "elytra", "fishing_rod", "shield", "shears"].map(
  (s) => "minecraft:" + s,
);

function Anvil({ data, target, setTarget }: { data: GearData; target: GearItem | null; setTarget: (t: GearItem | null) => void }) {
  const names = data.names;
  const owned: BookChoice[] = useMemo(
    () =>
      data.books.flatMap((b, i) =>
        Array.from({ length: Math.min(b.count, 4) }, (_, j) => ({
          key: `own${i}-${j}`,
          ench: b.ench.map(([k, l]) => [k.replace("minecraft:", ""), l] as [string, number]),
          work: workFromRepairCost(b.repair_cost),
          owned: true,
          where: b.where.pos ? b.where.pos.join(", ") : "on you",
        })),
      ),
    [data],
  );
  const [picked, setPicked] = useState<string[]>([]);
  const [extra, setExtra] = useState<BookChoice[]>([]);
  const [addK, setAddK] = useState("sharpness");
  const [addL, setAddL] = useState(5);

  // when the target changes, pre-pick your books that fill its gaps
  useEffect(() => {
    if (!target) return;
    const g = gaps(target.id, target.ench) ?? [];
    const want = new Set(g.flatMap((x) => x.want.map(([k]) => k)));
    const chosen: string[] = [];
    const got = new Set<string>();
    for (const b of owned) {
      const useful = b.ench.some(([k, l]) => want.has(k) && !got.has(k) && l >= (g.find((x) => x.want.some(([w]) => w === k))?.want.find(([w]) => w === k)?.[1] ?? 1));
      const clash = b.ench.some(([k]) => target.ench.some(([t]) => conflicts(t, k)));
      if (useful && !clash) {
        chosen.push(b.key);
        b.ench.forEach(([k]) => got.add(k));
      }
    }
    setPicked(chosen);
    setExtra([]);
  }, [target?.id, JSON.stringify(target?.ench)]);

  const books = [...owned.filter((b) => picked.includes(b.key)), ...extra];
  const plan = useMemo(() => {
    if (!target) return null;
    const t: Piece = { key: target.id, label: target.name ?? names[target.id] ?? pretty(target.id), book: false, ench: target.ench.map(([k, l]) => [k.replace("minecraft:", ""), l]), work: workFromRepairCost(target.repair_cost) };
    const ps: Piece[] = books.map((b) => ({ key: b.key, label: "Book: " + b.ench.map(([k, l]) => enchLabel(k, l)).join(" + "), book: true, ench: b.ench, work: b.work }));
    return planAnvil(t, ps);
  }, [target, books.map((b) => b.key).join()]);

  const applicable = useMemo(() => {
    if (!target) return Object.keys(ENCH);
    const best = bestSet(target.id);
    const sup = gd.enchantments();
    return Object.keys(ENCH).filter((k) => (sup?.["minecraft:" + k]?.supported ? sup["minecraft:" + k].supported!.includes(target.id) : best ? best.some((n) => n.some(([e]) => e === k)) || k.includes("curse") : true));
  }, [target?.id]);

  const all = [...(Object.entries(data.equipped).map(([, v]) => v) as GearItem[]), ...data.inventory.filter((i) => bestSet(i.id)), ...data.stored.filter((i) => bestSet(i.id))];

  return (
    <div className="anvil">
      <div className="anvil-pick glass">
        <div className="kicker">1 · The item</div>
        <div className="anvil-targets">
          {all.slice(0, 40).map((it, i) => (
            <button key={i} className={"slot ab" + (target === it ? " on" : "")} title={(it.name ?? names[it.id] ?? pretty(it.id)) + (it.where?.pos ? ` (in a chest at ${it.where.pos.join(", ")})` : "")} onClick={() => setTarget(it)}>
              <ItemIcon id={it.id} size={26} />
              {it.ench.length > 0 && <i className="glint" />}
            </button>
          ))}
          <select
            className="input"
            value=""
            onChange={(e) => {
              if (e.target.value) setTarget({ id: e.target.value, count: 1, name: null, ench: [], damage: 0, repair_cost: 0, trim: null, slot: null });
            }}
          >
            <option value="">A fresh item…</option>
            {FRESH.map((f) => (
              <option key={f} value={f}>
                {pretty(f)}
              </option>
            ))}
          </select>
        </div>
        <div className="kicker" style={{ marginTop: 14 }}>
          2 · Books {owned.length ? `(you own ${data.books.reduce((a, b) => a + b.count, 0)})` : ""}
        </div>
        <div className="anvil-books">
          {owned.length === 0 && <div className="muted small">No enchanted books in your chests yet. Add the books you can get below.</div>}
          {owned.map((b) => {
            const on = picked.includes(b.key);
            const useless = target && b.ench.every(([k]) => !applicable.includes(k));
            return (
              <button key={b.key} className={"bk" + (on ? " on" : "") + (useless ? " dim" : "")} onClick={() => setPicked((p) => (on ? p.filter((x) => x !== b.key) : [...p, b.key]))} title={b.where ? `At ${b.where}` : ""}>
                <ItemIcon id="minecraft:enchanted_book" size={18} />
                {b.ench.map(([k, l]) => enchLabel(k, l)).join(", ")}
              </button>
            );
          })}
          {extra.map((b) => (
            <button key={b.key} className="bk on extra" onClick={() => setExtra((x) => x.filter((y) => y.key !== b.key))}>
              <BookOpen size={14} /> {b.ench.map(([k, l]) => enchLabel(k, l)).join(", ")} <X size={11} />
            </button>
          ))}
        </div>
        <div className="anvil-add">
          <select className="input" value={addK} onChange={(e) => setAddK(e.target.value)}>
            {applicable.map((k) => (
              <option key={k} value={k}>
                {enchName(k)}
              </option>
            ))}
          </select>
          <select className="input" value={addL} onChange={(e) => setAddL(+e.target.value)}>
            {Array.from({ length: ench(addK).max }, (_, i) => i + 1).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <button
            className="btn sm"
            onClick={() => {
              sfx.click();
              setExtra((x) => [...x, { key: `x${Date.now()}`, ench: [[addK, Math.min(addL, ench(addK).max)]], work: 0, owned: false }]);
            }}
          >
            <Plus size={13} /> Add a book you can get
          </button>
        </div>
      </div>

      <div className="anvil-plan glass">
        <div className="kicker">3 · Cheapest order</div>
        {!target && <div className="muted">Pick an item to plan.</div>}
        {target && books.length === 0 && <div className="muted">Pick some books.</div>}
        {target && plan && books.length > 0 && (
          <>
            <div className="ap-total">
              <div>
                <b>{plan.total}</b>
                <span>levels in total</span>
              </div>
              <div>
                <b>{plan.max}</b>
                <span>most expensive step</span>
              </div>
              <div title="Doing each step as soon as you reach its level is the cheapest way; saving up for the whole plan costs far more">
                <b>{planPoints(plan.steps.map((st) => st.cost)).toLocaleString()}</b>
                <span>XP points, doing each step as soon as you can</span>
              </div>
            </div>
            {plan.tooExpensive && (
              <div className="ap-warn">
                <AlertTriangle size={14} /> One step costs 40+ levels, which the anvil refuses in survival ("Too Expensive!"). Leave a book out, or use a fresh item.
              </div>
            )}
            <ol className="ap-steps">
              {plan.steps.map((s, i) => (
                <motion.li key={i} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }} className={s.cost >= 40 ? "bad" : ""}>
                  <span className="ap-n">{i + 1}</span>
                  <span className="ap-l">{s.left}</span>
                  <Plus size={12} />
                  <span className="ap-r">{s.right}</span>
                  <ArrowRight size={12} />
                  <b>{s.cost} levels</b>
                </motion.li>
              ))}
            </ol>
            <div className="muted small">Put the left one in the anvil's first slot. Every anvil use makes the next one cost more, which is why the order matters.</div>
          </>
        )}
        {target && !plan && books.length > 0 && <div className="muted">Too many books to work out (11 max).</div>}
      </div>
    </div>
  );
}

export default function Gear() {
  const world = useStore((s) => s.world)!;
  const [data, setData] = useState<GearData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"gear" | "anvil">("gear");
  const [target, setTarget] = useState<GearItem | null>(null);
  const load = () => {
    setErr(null);
    gd.preload().catch(() => {});
    tapi
      .gear()
      .then(setData)
      .catch((e) => setErr(String(e)));
  };
  useEffect(load, [world.path]);
  if (err) return <Empty title="Couldn't read your gear">{err}</Empty>;
  if (!data)
    return (
      <div className="page-pad center-fill">
        <Spinner size={22} />
      </div>
    );
  if (!data.ready) return <Empty title="No player data in this world yet" />;
  const eq = data.equipped;
  const hotbar = data.inventory.filter((i) => (i.slot ?? 99) < 9 && bestSet(i.id) && i !== eq.mainhand);
  const spare = data.stored.filter((i) => bestSet(i.id));
  const missing = SLOT_ORDER.filter((s) => eq[s]).reduce((a, s) => a + (gaps(eq[s].id, eq[s].ench)?.length ?? 0), 0);
  function plan(it: GearItem) {
    sfx.click();
    setTarget(it);
    setTab("anvil");
  }
  return (
    <div className="page-pad gear-page">
      <div className="tool-head">
        <div>
          <div className="kicker">Plan · Gear + Anvil</div>
          <h1>{tab === "gear" ? "Gear Check" : "Anvil Planner"}</h1>
          <p>
            {tab === "gear"
              ? missing
                ? `${missing} enchantments missing from what you're wearing and holding.`
                : "Everything you're wearing and holding has its best enchantments."
              : "The cheapest order to put books on an item, with the books you actually own."}
          </p>
        </div>
        <div className="flex gap">
          <div className="tabs">
            <button className={tab === "gear" ? "on" : ""} onClick={() => setTab("gear")}>
              <Shield size={13} /> Gear Check
            </button>
            <button className={tab === "anvil" ? "on" : ""} onClick={() => setTab("anvil")}>
              <Hammer size={13} /> Anvil Planner
            </button>
          </div>
          <button className="iconbtn" onClick={load} title="Read again">
            <RefreshCw size={15} />
          </button>
        </div>
      </div>
      {tab === "gear" ? (
        <div className="gear-grid">
          <div className="gear-left glass">
            <GearStand equipped={eq} />
            <div className="gear-name">{data.player}</div>
            <div className="muted small">Level {data.xp_level}</div>
          </div>
          <div className="gear-right">
            <div className="gcards">
              {SLOT_ORDER.filter((s) => eq[s]).map((s) => (
                <GearCard key={s} slot={s} it={eq[s]} names={data.names} onPlan={plan} />
              ))}
            </div>
            {hotbar.length > 0 && (
              <>
                <h3 className="vr-h">On your hotbar</h3>
                <div className="gcards">
                  {hotbar.map((it, i) => (
                    <GearCard key={i} it={it} names={data.names} onPlan={plan} />
                  ))}
                </div>
              </>
            )}
            {spare.length > 0 && (
              <>
                <h3 className="vr-h">Spare gear in your chests ({spare.length})</h3>
                <div className="gcards small">
                  {spare.slice(0, 24).map((it, i) => (
                    <GearCard key={i} it={it} names={data.names} onPlan={plan} />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      ) : (
        <Anvil data={data} target={target} setTarget={setTarget} />
      )}
    </div>
  );
}
