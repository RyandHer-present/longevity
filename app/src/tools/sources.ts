// Ctrl+K results from the tools: villagers' trades, farms, goals and the vanilla Lookup.
import { searchSources, type Hit } from "./CommandBar";
import { useStore } from "../store";
import { tapi, pretty, fmtRate, type Roster, type FarmReport, type Project } from "./tapi";
import { gd } from "./gd";

// small per-world caches so typing stays instant
const cache = new Map<string, { t: number; v: unknown }>();
async function cached<T>(key: string, f: () => Promise<T>): Promise<T> {
  const world = useStore.getState().world?.path ?? "";
  const k = key + "|" + world;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.t < 60_000) return hit.v as T;
  const v = await f();
  cache.set(k, { t: Date.now(), v });
  return v;
}

function go(page: Parameters<ReturnType<typeof useStore.getState>["setPage"]>[0], id?: string) {
  useStore.setState({ toolFocus: id ? { page, id, n: Date.now() } : null });
  useStore.getState().setPage(page);
}

searchSources.push(async (q) => {
  if (!useStore.getState().world) return [];
  const s = q.toLowerCase();
  const r = await cached<Roster>("villagers", () => tapi.villagers());
  const out: Hit[] = [];
  for (const v of r.villagers) {
    for (const o of v.offers) {
      const name = (r.names[o.sell[0]] ?? pretty(o.sell[0])).toLowerCase();
      const ench = (o.sell[2] ?? []).join(" ").toLowerCase();
      if (!name.includes(s) && !ench.includes(s)) continue;
      out.push({
        key: "vill:" + v.uuid + o.sell[0] + ench,
        group: "Villagers selling it",
        title: `${o.sell[2]?.length ? o.sell[2].join(", ") : (r.names[o.sell[0]] ?? pretty(o.sell[0]))} for ${o.price} ${pretty(o.buy[0]).toLowerCase()}`,
        sub: `${v.name ?? pretty(v.profession)} at ${Math.floor(v.pos[0])}, ${Math.floor(v.pos[2])}${o.uses >= o.max ? " · sold out" : ""}`,
        icon: o.sell[0],
        run: () => go("villagers", v.uuid),
      });
      break;
    }
    if (out.length >= 5) break;
  }
  return out;
});

searchSources.push(async (q) => {
  if (!useStore.getState().world) return [];
  const s = q.toLowerCase();
  const r = await cached<FarmReport>("farms", () => tapi.farms());
  return r.farms
    .filter((f) => !f.maybe)
    .filter((f) => f.name.toLowerCase().includes(s) || Object.keys(f.rate.per_hour).some((k) => (r.names[k] ?? k).toLowerCase().includes(s)))
    .slice(0, 4)
    .map((f) => {
      const main = Object.entries(f.rate.per_hour).sort((a, b) => b[1] - a[1])[0];
      return {
        key: "farm:" + f.id,
        group: "Farms",
        title: f.name,
        sub: main ? `about ${fmtRate(main[1])} ${(r.names[main[0]] ?? pretty(main[0])).toLowerCase()} an hour` : undefined,
        icon: main?.[0],
        run: () => go("farms", f.id),
      };
    });
});

searchSources.push(async (q) => {
  if (!useStore.getState().world) return [];
  const s = q.toLowerCase();
  const r = await cached<{ projects: Project[] }>("projects", () => tapi.projects());
  return r.projects
    .filter((p) => p.name.toLowerCase().includes(s) || p.items.some((i) => (i.name ?? pretty(i.id)).toLowerCase().includes(s)))
    .slice(0, 3)
    .map((p) => ({
      key: "goal:" + p.id,
      group: "Goals",
      title: p.name,
      sub: `${Math.round((p.progress ?? 0) * 100)}% done`,
      icon: p.items[0]?.id,
      run: () => go("projects", p.id),
    }));
});

searchSources.push(async (q) => {
  const s = q.toLowerCase();
  const items = gd.items() ?? (await gd.load("items").catch(() => null));
  const mobs = gd.peek("mobs") ?? (await gd.load("mobs").catch(() => null));
  const out: Hit[] = [];
  for (const [id, it] of Object.entries(items ?? {})) {
    if (it.name.toLowerCase().includes(s)) out.push({ key: "lk:" + id, group: "Lookup", title: it.name, sub: "stats, how to get it, your numbers", icon: id, run: () => go("lookup", "items:" + id) });
    if (out.length >= 3) break;
  }
  for (const [id, m] of Object.entries(mobs ?? {})) {
    if (m.name.toLowerCase().includes(s)) out.push({ key: "lkm:" + id, group: "Lookup", title: m.name, sub: "health, drops, your kills", icon: id + "_spawn_egg", run: () => go("lookup", "mobs:" + id) });
    if (out.length >= 5) break;
  }
  return out;
});
