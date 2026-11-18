// Lookup: vanilla blocks/items, mobs, loot, villager trades, enchantments and brewing, for the
// version you play, with "your numbers" (what you own, mined, killed…) and bookmarks.
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Search, Star, Box, Skull, Gem, Users, Sparkles, FlaskConical, Pickaxe } from "lucide-react";
import { useStore } from "../store";
import { ItemIcon, Spinner, Empty } from "../ui";
import { api } from "../api";
import { sfx } from "../sound";
import { gd, type GBlock, type GItem, type GMob, type GEnch, type GTrade } from "./gd";
import { pretty, tapi, type Gear } from "./tapi";
import { whereToGet } from "./where";
import { enchName } from "./enchants";

type Tab = "items" | "mobs" | "loot" | "trades" | "enchantments" | "brewing";
const TABS: { id: Tab; label: string; icon: typeof Box }[] = [
  { id: "items", label: "Blocks & items", icon: Box },
  { id: "mobs", label: "Mobs", icon: Skull },
  { id: "loot", label: "Loot", icon: Gem },
  { id: "trades", label: "Trades", icon: Users },
  { id: "enchantments", label: "Enchantments", icon: Sparkles },
  { id: "brewing", label: "Brewing", icon: FlaskConical },
];

// ---------------------------------------------------------------- loot maths

interface LootLine {
  item: string;
  chance: number; // chance per roll of this pool picking it
  atLeastOne: number;
  min: number;
  max: number;
  notes: string[];
}
function num(v: unknown, d = 1): [number, number] {
  if (typeof v === "number") return [v, v];
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.type === "minecraft:uniform" || ("min" in o && "max" in o)) return [Number(o.min ?? d), Number(o.max ?? d)];
    if (o.type === "minecraft:binomial") return [0, Number(o.n ?? 1)];
    if (o.type === "minecraft:constant") return [Number(o.value ?? d), Number(o.value ?? d)];
  }
  return [d, d];
}
/** Conditions as a flat list: 1.20-26.2 use `conditions: [...]`; 26.3 uses `condition: {...}`, often `all_of`. */
function condList(o: Record<string, unknown>): Record<string, unknown>[] {
  const raw = [...((o.conditions as unknown[]) ?? []), ...(o.condition ? [o.condition] : [])] as Record<string, unknown>[];
  return raw.flatMap((c) => (String(c.type ?? c.condition ?? "").endsWith("all_of") ? ((c.terms as Record<string, unknown>[]) ?? []) : [c]));
}
/** Modifiers as a list: `functions: [...]` before 26.3, `modifier: {...} | [...]` on 26.3. */
function modList(o: Record<string, unknown>): Record<string, unknown>[] {
  const m = o.modifier;
  return [...((o.functions as Record<string, unknown>[]) ?? []), ...(Array.isArray(m) ? m : m ? [m] : [])] as Record<string, unknown>[];
}
function entityNote(c: Record<string, unknown>): string {
  const pr = (c.predicate ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  const flags = (pr.flags ?? pr["minecraft:flags"]) as Record<string, unknown> | undefined;
  if (flags?.is_baby) parts.push("a baby");
  if (flags?.is_on_fire) parts.push("on fire");
  const veh = (pr.vehicle ?? pr["minecraft:vehicle"]) as Record<string, unknown> | undefined;
  const vt = veh && ((veh.type ?? veh["minecraft:entity_type"]) as string | undefined);
  if (vt) parts.push("riding a " + pretty(String(vt).replace("#", "")).toLowerCase());
  const ty = (pr.type ?? pr["minecraft:entity_type"]) as string | undefined;
  if (c.entity === "attacker" || c.entity === "direct_attacker") {
    if (ty) return "killed by a " + pretty(String(ty).replace("#", "")).toLowerCase();
    return "";
  }
  return parts.length ? "only when it's " + parts.join(", ") : "";
}
function condNotes(conds: unknown[]): { chance: number; notes: string[] } {
  let chance = 1;
  const notes: string[] = [];
  for (const c of conds as Record<string, unknown>[]) {
    const t = String(c.condition ?? c.type ?? "");
    if (t.endsWith("random_chance")) chance *= Number(typeof c.chance === "number" ? c.chance : ((c.chance as Record<string, unknown>)?.value ?? 1));
    else if (t.endsWith("random_chance_with_enchanted_bonus") || t.endsWith("random_chance_with_looting")) {
      const u = c.unenchanted_chance ?? c.chance;
      const base = typeof u === "number" ? u : Number((u as Record<string, unknown>)?.value ?? 0.025);
      chance *= base;
      notes.push("more with Looting");
    } else if (t.endsWith("killed_by_player")) notes.push("player kill only");
    else if (t.endsWith("survives_explosion")) {
      /* normal */
    } else if (t.endsWith("match_tool")) notes.push("needs the right tool");
    else if (t.endsWith("table_bonus")) notes.push("more with Fortune");
    else if (t.endsWith("damage_source_properties")) notes.push("special kill");
    else if (t.endsWith("entity_properties")) {
      const n = entityNote(c);
      notes.push(n || "special condition");
      // a rider/baby condition makes it rare in practice, but we can't put a number on it
    }
  }
  return { chance, notes };
}
export function lootLines(table: unknown): LootLine[] {
  const out: LootLine[] = [];
  const t = table as { pools?: Record<string, unknown>[] };
  for (const pool of t?.pools ?? []) {
    const [r0, r1] = num(pool.rolls, 1);
    const rolls = (r0 + r1) / 2;
    const pc = condNotes(condList(pool));
    const entries = ((pool.entries as Record<string, unknown>[]) ?? []).flatMap((e) => (e.type === "minecraft:alternatives" || e.type === "minecraft:group" ? ((e.children as Record<string, unknown>[]) ?? []) : [e]));
    const total = entries.reduce((a, e) => a + Number(e.weight ?? 1), 0) || 1;
    for (const e of entries) {
      if (e.type !== "minecraft:item" && e.type !== "item") continue;
      let [mn, mx] = [1, 1];
      const notes = [...pc.notes];
      for (const f of modList(e)) {
        const fn = String(f.function ?? f.type ?? "");
        if (fn.endsWith("set_count")) [mn, mx] = num(f.count, 1);
        if (fn.endsWith("enchant_randomly") || fn.endsWith("enchant_with_levels")) notes.push("enchanted");
        if (fn.endsWith("looting_enchant") || fn.endsWith("enchanted_count_increase")) notes.push("+ with Looting");
        if (fn.endsWith("apply_bonus")) notes.push("+ with Fortune");
        if (fn.endsWith("set_potion")) notes.push(pretty(String(f.id ?? "")));
        if (fn.endsWith("furnace_smelt")) notes.push("cooked if it burns");
      }
      const ec = condNotes(condList(e));
      notes.push(...ec.notes);
      const p = (Number(e.weight ?? 1) / total) * pc.chance * ec.chance;
      out.push({ item: String(e.name), chance: p, atLeastOne: 1 - Math.pow(1 - p, rolls), min: mn, max: mx, notes: [...new Set(notes)] });
    }
  }
  return out;
}
const pct = (p: number) => (p >= 0.995 ? "always" : p < 0.001 ? "<0.1%" : `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`);

// ---------------------------------------------------------------- mining time

const TIER_SPEED: Record<string, number> = { wooden: 2, stone: 4, iron: 6, golden: 12, diamond: 8, netherite: 9, copper: 5 };
const TIER_RANK: Record<string, number> = { wooden: 0, golden: 0, stone: 1, copper: 1, iron: 2, diamond: 3, netherite: 4 };
const NEED_RANK: Record<string, number> = { wood: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 };
function miningSeconds(b: GBlock, tool: { tier: string; eff: number } | null, kind: string) {
  if (b.hardness < 0) return null;
  if (b.hardness === 0) return 0;
  const right = !!tool && b.tool === kind;
  const canHarvest = !b.tier || (right && (TIER_RANK[tool!.tier] ?? 0) >= (NEED_RANK[b.tier] ?? 0));
  let speed = right ? (TIER_SPEED[tool!.tier] ?? 1) : 1;
  if (right && tool!.eff > 0) speed += tool!.eff * tool!.eff + 1;
  const dmg = speed / b.hardness / (canHarvest ? 30 : 100);
  if (dmg > 1) return 0;
  return Math.ceil(1 / dmg) / 20;
}

// ---------------------------------------------------------------- page

export default function Lookup() {
  const world = useStore((s) => s.world)!;
  const info = useStore((s) => s.info);
  const settings = useStore((s) => s.settings);
  const [tab, setTab] = useState<Tab>("items");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [missing, setMissing] = useState(false);
  const [versions, setVersions] = useState<string[]>([]);
  const [ver, setVer] = useState(info?.mc_version ?? "26.3");
  const [mine, setMine] = useState<{ have: Map<string, number>; stats: Record<string, Record<string, number>>; gear: Gear | null }>({ have: new Map(), stats: {}, gear: null });
  const bookmarks: string[] = ((settings as unknown as { bookmarks?: string[] })?.bookmarks ?? []) as string[];

  useEffect(() => {
    gd.index().then((i) => setVersions(i.versions ?? []));
  }, []);
  useEffect(() => {
    setReady(false);
    gd.setVersion(ver);
    Promise.all((["items", "blocks", "mobs", "loot", "enchantments", "trades", "brewing", "recipes"] as const).map((f) => gd.load(f, ver))).then((r) => {
      setMissing(r[0] === null);
      setReady(true);
    });
  }, [ver]);
  useEffect(() => {
    Promise.all([api.storageTotals().catch(() => null), tapi.statsRaw().catch(() => ({})), tapi.gear().catch(() => null)]).then(([t, stats, g]) => {
      const have = new Map<string, number>();
      for (const it of (t as { items?: { id: string; count: number }[] } | null)?.items ?? []) have.set(it.id, it.count);
      setMine({ have, stats, gear: g });
    });
  }, [world.path]);

  function toggleBookmark(key: string) {
    const cur = new Set(bookmarks);
    if (cur.has(key)) cur.delete(key);
    else cur.add(key);
    sfx.click();
    useStore.getState().saveSettings({ bookmarks: [...cur] } as never);
  }

  const items = gd.peek("items", ver) ?? {};
  const blocks = gd.peek("blocks", ver) ?? {};
  const mobs = gd.peek("mobs", ver) ?? {};
  const loot = (gd.peek("loot", ver) ?? {}) as Record<string, unknown>;
  const enchs = gd.peek("enchantments", ver) ?? {};
  const trades = gd.peek("trades", ver) ?? {};
  const brewing = gd.peek("brewing", ver);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const f = (name: string, id: string) => !s || name.toLowerCase().includes(s) || id.includes(s);
    let rows: { key: string; name: string; icon: string; sub?: string }[] = [];
    if (tab === "items") {
      // blocks with no item of their own (wall signs, wall torches...) share an item's name; leave them out
      const itemNames = new Set(Object.values(items).map((i) => i.name));
      const keys = [...Object.keys(items), ...Object.keys(blocks).filter((k) => !items[k] && !itemNames.has(blocks[k]?.name ?? "") && !/(^|:)(air|cave_air|void_air|moving_piston|piston_head)$/.test(k))];
      rows = keys.map((k) => ({ key: k, name: items[k]?.name ?? blocks[k]?.name ?? pretty(k), icon: k })).filter((r) => f(r.name, r.key));
    } else if (tab === "mobs") rows = Object.entries(mobs).map(([k, m]) => ({ key: k, name: m.name, icon: k + "_spawn_egg", sub: `${m.health / 2} hearts` })).filter((r) => f(r.name, r.key));
    else if (tab === "loot")
      rows = Object.keys(loot)
        .filter((k) => !k.includes("blocks/"))
        .map((k) => ({ key: k, name: pretty(k.split("/").slice(-1)[0]), icon: k.includes("entities/") ? "minecraft:" + k.split("/").pop() + "_spawn_egg" : "minecraft:chest", sub: k.replace("minecraft:", "").split("/").slice(0, -1).join(" / ") }))
        .filter((r) => f(r.name + " " + r.sub, r.key));
    else if (tab === "trades") rows = Object.keys(trades).map((k) => ({ key: k, name: pretty(k), icon: "minecraft:emerald" })).filter((r) => f(r.name, r.key));
    else if (tab === "enchantments") rows = Object.entries(enchs).map(([k, e]) => ({ key: k, name: e.name, icon: "minecraft:enchanted_book", sub: `max ${e.max_level}` })).filter((r) => f(r.name, r.key));
    else if (tab === "brewing") rows = Object.entries(brewing?.potions ?? {}).map(([k, p]) => ({ key: k, name: p.name, icon: "minecraft:potion" })).filter((r) => f(r.name, r.key));
    rows.sort((a, b) => Number(bookmarks.includes(tab + ":" + b.key)) - Number(bookmarks.includes(tab + ":" + a.key)) || a.name.localeCompare(b.name));
    return rows.slice(0, 400);
  }, [tab, q, ready, bookmarks.join()]);

  // opened from Ctrl+K on one entry ("items:minecraft:diamond")
  const focus = useRef(
    (() => {
      const f = useStore.getState().toolFocus;
      if (f?.page !== "lookup") return null;
      useStore.setState({ toolFocus: null });
      const i = f.id.indexOf(":");
      return { tab: f.id.slice(0, i) as Tab, key: f.id.slice(i + 1) };
    })(),
  );
  useEffect(() => {
    if (focus.current) setTab(focus.current.tab);
  }, []);
  useEffect(() => {
    const f = focus.current;
    if (f && ready && f.tab === tab) {
      setSel(f.key);
      focus.current = null;
    } else if (!f) setSel(null);
  }, [tab, ver, ready]);

  if (!ready)
    return (
      <div className="page-pad center-fill">
        <Spinner size={22} />
      </div>
    );
  if (missing) return <Empty title="Game data isn't bundled yet">This build of Longevity doesn't have the vanilla data files for {ver}.</Empty>;

  return (
    <div className="lk-page">
      <div className="tool-head page-pad-x">
        <div>
          <div className="kicker">Plan · Lookup</div>
          <h1>Lookup</h1>
          <p>Vanilla {ver}, straight from the game's own data. "Yours" shows what you own, mined and killed in {world.name}.</p>
        </div>
        <div className="flex gap">
          {versions.length > 1 && (
            <select className="input" value={ver} onChange={(e) => setVer(e.target.value)} title="Version">
              {[...versions].reverse().map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="lk-tabs page-pad-x">
        {TABS.map((t) => (
          <button key={t.id} className={"chip" + (tab === t.id ? " on" : "")} onClick={() => setTab(t.id)}>
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>
      <div className="lk-body">
        <div className="lk-list">
          <div className="search glass">
            <Search size={14} />
            <input className="input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          </div>
          <div className="lk-rows">
            {list.map((r) => (
              <button key={r.key} className={"lk-row" + (sel === r.key ? " on" : "")} onClick={() => setSel(r.key)}>
                <ItemIcon id={r.icon} size={22} />
                <span className="grow">
                  {r.name}
                  {r.sub && <i>{r.sub}</i>}
                </span>
                {bookmarks.includes(tab + ":" + r.key) && <Star size={12} fill="currentColor" className="lk-star" />}
              </button>
            ))}
          </div>
        </div>
        <div className="lk-detail">
          {!sel ? (
            <div className="lk-empty muted">
              {bookmarks.filter((b) => b.startsWith(tab + ":")).length ? "Your bookmarks are at the top of the list." : "Pick something on the left."}
            </div>
          ) : (
            <motion.div key={sel} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="lk-card glass">
              <button className={"iconbtn lk-bm" + (bookmarks.includes(tab + ":" + sel) ? " on" : "")} title="Bookmark" onClick={() => toggleBookmark(tab + ":" + sel)}>
                <Star size={15} fill={bookmarks.includes(tab + ":" + sel) ? "currentColor" : "none"} />
              </button>
              {tab === "items" && <ItemDetail id={sel} item={items[sel]} block={blocks[sel]} loot={loot} mine={mine} />}
              {tab === "mobs" && <MobDetail id={sel} mob={mobs[sel]} loot={loot} mine={mine} />}
              {tab === "loot" && <LootDetail id={sel} table={loot[sel]} items={items} />}
              {tab === "trades" && <TradeDetail prof={sel} levels={trades[sel]} items={items} />}
              {tab === "enchantments" && <EnchDetail id={sel} e={enchs[sel]} items={items} />}
              {tab === "brewing" && brewing && <BrewDetail id={sel} brewing={brewing} items={items} />}
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}

type Mine = { have: Map<string, number>; stats: Record<string, Record<string, number>>; gear: Gear | null };
const stat = (m: Mine, cat: string, id: string) => m.stats?.[cat]?.[id] ?? 0;

function Yours({ rows }: { rows: [string, number | string][] }) {
  const shown = rows.filter((r) => r[1] !== 0 && r[1] !== "");
  if (!shown.length) return null;
  return (
    <div className="lk-yours">
      <div className="kicker">Yours</div>
      <div className="lk-ygrid">
        {shown.map(([k, v]) => (
          <div key={k}>
            <b>{typeof v === "number" ? v.toLocaleString() : v}</b>
            <span>{k}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Facts({ rows }: { rows: [string, unknown][] }) {
  return (
    <div className="lk-facts">
      {rows
        .filter((r) => r[1] !== undefined && r[1] !== null && r[1] !== "")
        .map(([k, v]) => (
          <div key={k}>
            <span>{k}</span>
            <b>{String(v)}</b>
          </div>
        ))}
    </div>
  );
}

function bestTool(g: Gear | null, kind: string): { tier: string; eff: number } | null {
  if (!g) return null;
  const all = [...Object.values(g.equipped), ...g.inventory, ...g.ender];
  let best: { tier: string; eff: number; score: number } | null = null;
  for (const it of all) {
    const m = it.id.replace("minecraft:", "").match(/^(\w+?)_(pickaxe|axe|shovel|hoe)$/);
    if (!m || m[2] !== kind) continue;
    const eff = it.ench.find(([k]) => k.endsWith("efficiency"))?.[1] ?? 0;
    const score = (TIER_SPEED[m[1]] ?? 1) + eff * eff;
    if (!best || score > best.score) best = { tier: m[1], eff, score };
  }
  return best;
}

function ItemDetail({ id, item, block, loot, mine }: { id: string; item?: GItem; block?: GBlock; loot: Record<string, unknown>; mine: Mine }) {
  const src = whereToGet(id);
  const tool = block?.tool ? bestTool(mine.gear, block.tool) : null;
  const t = block ? miningSeconds(block, tool, block.tool ?? "") : null;
  const drops = block?.drops && loot[block.drops] ? lootLines(loot[block.drops]) : [];
  return (
    <>
      <div className="lk-head">
        <div className="slot" style={{ width: 56, height: 56 }}>
          <ItemIcon id={id} size={40} />
        </div>
        <div>
          <h2>{item?.name ?? block?.name ?? pretty(id)}</h2>
          <code>{id}</code>
        </div>
      </div>
      <Facts
        rows={[
          ["Stacks to", item?.stack],
          ["Durability", item?.durability],
          ["Attack damage", item?.attack_damage],
          ["Attack speed", item?.attack_speed],
          ["Food", item?.food ? `${item.food.nutrition / 2} drumsticks, ${item.food.saturation} saturation` : undefined],
          ["Smelts", item?.fuel ? `${item.fuel / 200} items as fuel` : undefined],
          ["Enchantability", item?.enchantable],
          ["Repaired with", item?.repair?.map((r) => pretty(r)).join(", ")],
          ["Hardness", block?.hardness],
          ["Blast resistance", block?.blast],
          ["Best tool", block?.tool ? pretty(block.tool) + (block.tier ? ` (${block.tier} or better)` : "") : undefined],
          ["Light", block?.light || undefined],
          ["Burns", block?.flammable ? "yes" : undefined],
        ]}
      />
      {block && t !== null && (
        <div className="lk-mine">
          <Pickaxe size={14} /> {t === 0 ? "Breaks instantly" : `${t.toFixed(2)} s to mine`}
          {tool ? ` with your ${pretty(tool.tier)} ${block.tool}${tool.eff ? ` (Efficiency ${tool.eff})` : ""}` : " by hand"}
        </div>
      )}
      <Yours
        rows={[
          ["in your storage", mine.have.get(id) ?? 0],
          ["mined", stat(mine, "minecraft:mined", id)],
          ["crafted", stat(mine, "minecraft:crafted", id)],
          ["used", stat(mine, "minecraft:used", id)],
          ["picked up", stat(mine, "minecraft:picked_up", id)],
        ]}
      />
      {drops.length > 0 && (
        <>
          <div className="kicker">Drops when mined</div>
          <LootTable lines={drops} />
        </>
      )}
      {src.length > 0 && (
        <>
          <div className="kicker">How to get it</div>
          <div className="lk-src">
            {src.map((s, i) => (
              <span key={i} className={"pj-s " + s.kind}>
                {s.text}
              </span>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function lootName(id: string) {
  const n = gd.items()?.[id]?.name ?? pretty(id);
  // every disc is just "Music Disc" in the item names; say which one
  return n === "Music Disc" && id.includes("music_disc_") ? `Music Disc (${pretty(id.split("music_disc_")[1])})` : n;
}

function LootTable({ lines }: { lines: LootLine[] }) {
  return (
    <div className="lk-loot">
      {lines.map((l, i) => (
        <div key={i} className="lk-lrow">
          <ItemIcon id={l.item} size={20} />
          <span className="grow">{lootName(l.item)}</span>
          <span className="lk-cnt">{l.min === l.max ? `×${l.min}` : `${l.min}–${l.max}`}</span>
          <b>{pct(l.atLeastOne)}</b>
          {l.notes.length > 0 && <i>{l.notes.join(", ")}</i>}
        </div>
      ))}
    </div>
  );
}

function MobDetail({ id, mob, loot, mine }: { id: string; mob: GMob; loot: Record<string, unknown>; mine: Mine }) {
  const lines = mob.loot && loot[mob.loot] ? lootLines(loot[mob.loot]) : [];
  return (
    <>
      <div className="lk-head">
        <div className="slot" style={{ width: 56, height: 56 }}>
          <ItemIcon id={id + "_spawn_egg"} size={40} />
        </div>
        <div>
          <h2>{mob.name}</h2>
          <code>{id}</code>
        </div>
      </div>
      <Facts
        rows={[
          ["Health", `${mob.health} (${mob.health / 2} hearts)`],
          ["Armor", mob.armor || undefined],
          ["Armor toughness", mob.toughness || undefined],
          ["Attack", mob.attack ?? undefined],
          ["Speed", mob.speed],
          ["Follow range", mob.follow],
          ["Knockback resistance", mob.kb_resist || undefined],
          ["Type", pretty(mob.category ?? "")],
        ]}
      />
      <Yours
        rows={[
          ["you killed", stat(mine, "minecraft:killed", id)],
          ["killed you", stat(mine, "minecraft:killed_by", id)],
        ]}
      />
      {lines.length > 0 && (
        <>
          <div className="kicker">Drops (per kill)</div>
          <LootTable lines={lines} />
        </>
      )}
      {mob.biomes && mob.biomes.length > 0 && (
        <>
          <div className="kicker">Spawns in</div>
          <div className="lk-src">
            {mob.biomes.slice(0, 40).map((b) => (
              <span key={b} className="pj-s">
                {pretty(b)}
              </span>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function LootDetail({ id, table }: { id: string; table: unknown; items: Record<string, GItem> }) {
  const lines = lootLines(table);
  return (
    <>
      <div className="lk-head">
        <div>
          <h2>{pretty(id.split("/").pop() ?? id)}</h2>
          <code>{id}</code>
        </div>
      </div>
      <div className="muted small" style={{ marginBottom: 10 }}>
        Chance of at least one per {id.includes("entities/") ? "kill" : id.includes("chests/") ? "chest" : "roll"}.
      </div>
      <LootTable lines={lines.sort((a, b) => b.atLeastOne - a.atLeastOne)} />
    </>
  );
}

const LV = ["", "Novice", "Apprentice", "Journeyman", "Expert", "Master"];
function TradeDetail({ prof, levels, items }: { prof: string; levels: Record<string, GTrade[]>; items: Record<string, GItem> }) {
  const n = (v: number | [number, number]) => (Array.isArray(v) ? `${v[0]}–${v[1]}` : v);
  return (
    <>
      <div className="lk-head">
        <div>
          <h2>{pretty(prof)}</h2>
        </div>
      </div>
      {Object.entries(levels).map(([lvl, ts]) => (
        <div key={lvl} className="lk-tlevel">
          <div className="kicker">{LV[+lvl] ?? `Level ${lvl}`}</div>
          {ts.map((t, i) => (
            <div key={i} className="lk-trow">
              <ItemIcon id={t.buy[0]} size={20} /> {n(t.buy[1])}
              {t.buyB && (
                <>
                  {" "}
                  + <ItemIcon id={t.buyB[0]} size={20} /> {t.buyB[1]}
                </>
              )}
              <span className="muted">→</span>
              <ItemIcon id={t.sell[0]} size={20} /> {n(t.sell[1])} {items[t.sell[0]]?.name ?? pretty(t.sell[0])}
              <i>
                {t.max_uses ? `${t.max_uses} uses` : ""}
                {t.note ? ` · ${t.note}` : ""}
              </i>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function EnchDetail({ id, e, items }: { id: string; e: GEnch; items: Record<string, GItem> }) {
  return (
    <>
      <div className="lk-head">
        <div className="slot" style={{ width: 56, height: 56 }}>
          <ItemIcon id="minecraft:enchanted_book" size={40} />
        </div>
        <div>
          <h2>{e.name}</h2>
          <code>{id}</code>
        </div>
      </div>
      <Facts
        rows={[
          ["Max level", e.max_level],
          ["Weight (how common)", e.weight],
          ["Anvil cost per level", e.anvil_cost ? `${e.anvil_cost} on items, ${Math.max(1, Math.floor(e.anvil_cost / 2))} from books` : undefined],
          ["Treasure", e.treasure ? "yes (not from the enchanting table)" : "no"],
          ["Villagers sell it", e.tradeable === false ? "no" : "yes"],
          ["Curse", e.curse ? "yes" : undefined],
        ]}
      />
      {e.exclusive && e.exclusive.length > 0 && (
        <>
          <div className="kicker">Can't go with</div>
          <div className="lk-src">
            {e.exclusive.map((x) => (
              <span key={x} className="pj-s">
                {enchName(x)}
              </span>
            ))}
          </div>
        </>
      )}
      {e.supported && (
        <>
          <div className="kicker">Goes on</div>
          <div className="lk-onitems">
            {e.supported.slice(0, 60).map((x) => (
              <span key={x} title={items[x]?.name ?? pretty(x)}>
                <ItemIcon id={x} size={22} />
              </span>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function BrewDetail({ id, brewing, items }: { id: string; brewing: NonNullable<ReturnType<typeof gd.peek<"brewing">>>; items: Record<string, GItem> }) {
  // shortest chain of mixes from a water bottle to this potion
  const path = useMemo(() => {
    const prev = new Map<string, { from: string; ing: string }>();
    const start = "minecraft:water";
    const queue = [start];
    const seen = new Set([start]);
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === id) break;
      for (const m of brewing.mixes)
        if (m.input === cur && !seen.has(m.output)) {
          seen.add(m.output);
          prev.set(m.output, { from: cur, ing: m.ingredient });
          queue.push(m.output);
        }
    }
    const steps: { from: string; ing: string; to: string }[] = [];
    let c = id;
    while (prev.has(c)) {
      const p = prev.get(c)!;
      steps.unshift({ from: p.from, ing: p.ing, to: c });
      c = p.from;
    }
    return steps;
  }, [id]);
  const p = brewing.potions[id];
  const name = (x: string) => brewing.potions[x]?.name ?? pretty(x);
  return (
    <>
      <div className="lk-head">
        <div className="slot" style={{ width: 56, height: 56 }}>
          <ItemIcon id="minecraft:potion" size={40} />
        </div>
        <div>
          <h2>{p?.name ?? pretty(id)}</h2>
          <code>{id}</code>
        </div>
      </div>
      {p?.effects?.length > 0 && (
        <Facts rows={p.effects.map(([e, dur, amp]) => [pretty(e) + (amp ? ` ${["I", "II", "III", "IV", "V"][amp]}` : ""), dur > 1 ? `${Math.floor(dur / 1200)}:${String(Math.floor((dur % 1200) / 20)).padStart(2, "0")}` : "instant"])} />
      )}
      <div className="kicker">How to brew it</div>
      {path.length === 0 ? (
        <div className="muted small">Not brewable from a water bottle (it might come from a wandering trader or a witch).</div>
      ) : (
        <ol className="ap-steps">
          {path.map((s, i) => (
            <li key={i}>
              <span className="ap-n">{i + 1}</span>
              <span className="ap-l">{name(s.from)}</span>+
              <span className="ap-r">
                <ItemIcon id={s.ing} size={18} /> {items[s.ing]?.name ?? pretty(s.ing)}
              </span>
              →<b>{name(s.to)}</b>
            </li>
          ))}
        </ol>
      )}
      <div className="muted small" style={{ marginTop: 8 }}>
        Gunpowder makes it a splash potion, then dragon's breath a lingering one.
      </div>
    </>
  );
}
