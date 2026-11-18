// Hidden Changelog: what changed between Minecraft releases in mob stats, loot and drops, trades
// and recipes (plus items, blocks and enchantments). These are the changes that don't make the
// official notes, worked out by comparing each release's own data.
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Skull, Gem, Users, Hammer, Box, Sparkles, ArrowRight, Filter } from "lucide-react";
import { useStore } from "../store";
import { ItemIcon, Spinner, Empty } from "../ui";
import { gd, type GChange } from "./gd";
import { pretty } from "./tapi";

const SECTIONS = [
  { id: "mobs", label: "Mob stats", icon: Skull },
  { id: "loot", label: "Loot & drops", icon: Gem },
  { id: "trades", label: "Trades", icon: Users },
  { id: "recipes", label: "Recipes", icon: Hammer },
  { id: "items", label: "Items & blocks", icon: Box },
  { id: "enchantments", label: "Enchantments", icon: Sparkles },
] as const;
type Sec = (typeof SECTIONS)[number]["id"];

const fieldName: Record<string, string> = {
  health: "health",
  armor: "armor",
  toughness: "armor toughness",
  attack: "attack damage",
  speed: "speed",
  follow: "follow range",
  kb_resist: "knockback resistance",
};

function val(v: unknown): string {
  if (v === null || v === undefined) return "none";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "");
  if (Array.isArray(v)) return v.map(val).join(", ");
  return String(v);
}

function lines(c: GChange, sec: Sec): { key: string; icon?: string; text: React.ReactNode }[] {
  const out: { key: string; icon?: string; text: React.ReactNode }[] = [];
  if (sec === "mobs")
    for (const [i, m] of (c.mobs ?? []).entries())
      out.push({
        key: "m" + i,
        icon: m.id + "_spawn_egg",
        text: (
          <>
            <b>{m.name}</b> {fieldName[m.field] ?? m.field.replace(/_/g, " ")}: <s>{val(m.from)}</s> <ArrowRight size={11} /> <em>{val(m.to)}</em>
          </>
        ),
      });
  if (sec === "loot")
    for (const [i, l] of (c.loot ?? []).entries())
      out.push({
        key: "l" + i,
        icon: l.table.includes("entities/") ? "minecraft:" + l.table.split("/").pop() + "_spawn_egg" : l.table.includes("chests/") ? "minecraft:chest" : undefined,
        text: (
          <>
            <b>{l.name}</b> {l.what}
          </>
        ),
      });
  if (sec === "trades")
    for (const [i, t] of (c.trades ?? []).entries())
      out.push({
        key: "t" + i,
        icon: "minecraft:emerald",
        text: (
          <>
            <b>
              {pretty(t.profession)}
              {t.level ? ` (level ${t.level})` : ""}
            </b>{" "}
            {t.what}
          </>
        ),
      });
  if (sec === "recipes") {
    for (const r of c.recipes?.added ?? []) {
      const { id, name } = rec(r);
      out.push({
        key: "ra" + id,
        icon: guessIcon(id),
        text: (
          <>
            <span className="cl-new">New</span> {name}
          </>
        ),
      });
    }
    for (const r of c.recipes?.removed ?? []) {
      const { id, name } = rec(r);
      out.push({
        key: "rr" + id,
        icon: guessIcon(id),
        text: (
          <>
            <span className="cl-gone">Removed</span> {name}
          </>
        ),
      });
    }
    for (const r of c.recipes?.changed ?? [])
      out.push({
        key: "rc" + r.id,
        icon: guessIcon(r.id),
        text: (
          <>
            <b>{r.name ?? pretty(r.id)}</b> {r.what}
          </>
        ),
      });
  }
  if (sec === "items")
    for (const [i, x] of [...(c.items ?? []), ...(c.blocks ?? [])].entries())
      out.push({
        key: "i" + i,
        icon: x.id,
        text: (
          <>
            <b>{x.name ?? pretty(x.id)}</b>{" "}
            {x.what ?? (
              <>
                {(x.field ?? "").replace(/_/g, " ")}: <s>{val(x.from)}</s> <ArrowRight size={11} /> <em>{val(x.to)}</em>
              </>
            )}
          </>
        ),
      });
  if (sec === "enchantments")
    for (const [i, x] of (c.enchantments ?? []).entries())
      out.push({
        key: "e" + i,
        icon: "minecraft:enchanted_book",
        text: (
          <>
            <b>{x.name ?? pretty(x.id)}</b>{" "}
            {x.what ?? (
              <>
                {(x.field ?? "").replace(/_/g, " ")}: <s>{val(x.from)}</s> <ArrowRight size={11} /> <em>{val(x.to)}</em>
              </>
            )}
          </>
        ),
      });
  return out;
}

/** Recipe entries are `{ id, name }` (older data had bare ids). */
function rec(r: string | { id: string; name?: string }) {
  return typeof r === "string" ? { id: r, name: pretty(r) } : { id: r.id, name: r.name ?? pretty(r.id) };
}

function guessIcon(recipeId: string) {
  const s = recipeId.replace("minecraft:", "").replace(/_from_.*$/, "").replace(/_(smelting|blasting|smoking|stonecutting|campfire_cooking)$/, "");
  return "minecraft:" + s;
}

export default function Changelog() {
  const info = useStore((s) => s.info);
  const [versions, setVersions] = useState<string[] | null>(null);
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [changes, setChanges] = useState<GChange[] | null>(null);
  const [only, setOnly] = useState<Sec | "all">("all");

  useEffect(() => {
    gd.index().then((i) => {
      const v = i.versions ?? [];
      setVersions(v);
      const latest = info?.mc_version && v.includes(info.mc_version) ? info.mc_version : v[v.length - 1];
      const astera = v.includes("1.21.11") ? "1.21.11" : v[Math.max(0, v.indexOf(latest) - 1)];
      setTo(latest ?? "");
      setFrom(astera ?? "");
    });
  }, []);

  useEffect(() => {
    if (!versions || !from || !to) return;
    const a = versions.indexOf(from);
    const b = versions.indexOf(to);
    if (a < 0 || b < 0 || a >= b) {
      setChanges([]);
      return;
    }
    setChanges(null);
    const pairs = versions.slice(a, b + 1).map((v, i, arr) => (i ? [arr[i - 1], v] : null)).filter(Boolean) as [string, string][];
    Promise.all(pairs.map(([x, y]) => gd.change(x, y))).then((r) => setChanges(r.filter(Boolean).reverse() as GChange[]));
  }, [from, to, versions]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of changes ?? []) for (const s of SECTIONS) m[s.id] = (m[s.id] ?? 0) + lines(c, s.id).length;
    return m;
  }, [changes]);

  if (!versions)
    return (
      <div className="page-pad center-fill">
        <Spinner size={22} />
      </div>
    );
  if (versions.length < 2) return <Empty title="No version data bundled yet">This build of Longevity doesn't have the release-by-release data.</Empty>;

  return (
    <div className="page-pad cl-page">
      <div className="tool-head">
        <div>
          <div className="kicker">Plan · Hidden Changelog</div>
          <h1>Hidden Changelog</h1>
          <p>The quiet changes between releases: mob stats, drops and chest loot, villager trades and recipes, found by comparing each release's own data.</p>
        </div>
        <div className="cl-range glass">
          <select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
            {versions.slice(0, -1).map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
          <ArrowRight size={14} />
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>
            {versions.slice(1).map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="vr-filter" style={{ marginBottom: 14 }}>
        <button className={"chip" + (only === "all" ? " on" : "")} onClick={() => setOnly("all")}>
          <Filter size={12} /> Everything
        </button>
        {SECTIONS.map((s) => (
          <button key={s.id} className={"chip" + (only === s.id ? " on" : "")} onClick={() => setOnly(s.id)} disabled={!counts[s.id]}>
            <s.icon size={12} /> {s.label} {counts[s.id] ? `(${counts[s.id]})` : ""}
          </button>
        ))}
      </div>
      {!changes ? (
        <Spinner size={20} />
      ) : changes.length === 0 ? (
        <Empty title="Pick two versions">The first one has to be older.</Empty>
      ) : (
        changes.map((c, ci) => {
          const secs = SECTIONS.filter((s) => (only === "all" || only === s.id) && lines(c, s.id).length);
          return (
            <motion.div key={c.from + c.to} className="cl-ver" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: ci * 0.05 }}>
              <div className="cl-vhead">
                <span className="cl-vtag">{c.to}</span>
                <span className="muted small">since {c.from}</span>
              </div>
              {secs.length === 0 && <div className="muted small cl-none">Nothing hidden changed here.</div>}
              {secs.map((s) => (
                <div key={s.id} className="cl-sec glass">
                  <div className="cl-stitle">
                    <s.icon size={14} /> {s.label}
                  </div>
                  {lines(c, s.id)
                    .slice(0, 200)
                    .map((l) => (
                      <div key={l.key} className="cl-line">
                        {l.icon ? <ItemIcon id={l.icon} size={18} /> : <span style={{ width: 18 }} />}
                        <span>{l.text}</span>
                      </div>
                    ))}
                </div>
              ))}
            </motion.div>
          );
        })
      )}
    </div>
  );
}
