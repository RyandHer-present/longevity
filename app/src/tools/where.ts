// "Where do I get this?" for one item, from YOUR world first (farms making it, villagers selling
// it, chests already holding some), then from the game's rules (recipes, mob drops, chest loot).
import { gd } from "./gd";
import type { FarmReport, Roster } from "./tapi";
import { pretty } from "./tapi";

export interface Source {
  kind: "farm" | "villager" | "craft" | "drop" | "loot" | "smelt" | "trade" | "hint";
  text: string;
  rate?: number; // per hour, for farms
  icon?: string;
}

const HINTS: Record<string, string> = {
  "minecraft:nether_star": "Kill the Wither (soul sand T + 3 wither skeleton skulls)",
  "minecraft:wither_skeleton_skull": "Wither skeletons in nether fortresses (2.5%, +1% per Looting level)",
  "minecraft:heart_of_the_sea": "Buried treasure chests (use a treasure map from shipwrecks or ocean ruins)",
  "minecraft:nautilus_shell": "Fishing treasure, wandering traders, or drowned holding one",
  "minecraft:elytra": "End ships in End cities, past the dragon's gateway",
  "minecraft:totem_of_undying": "Evokers in woodland mansions and raids",
  "minecraft:netherite_upgrade_smithing_template": "Bastion remnant chests (copy it with 7 diamonds + netherrack)",
  "minecraft:ancient_debris": "Y 8-22 in the Nether (Y 15 is best); bed or TNT mining",
  "minecraft:shulker_shell": "Shulkers in End cities",
  "minecraft:trident": "Drowned holding one (8.5%, +1% per Looting level)",
  "minecraft:enchanted_golden_apple": "Chests in ancient cities, bastions, ruined portals and dungeons",
  "minecraft:music_disc_pigstep": "Bastion remnant chests",
  "minecraft:music_disc_otherside": "Dungeon and stronghold chests",
  "minecraft:music_disc_relic": "Suspicious gravel in trail ruins",
  "minecraft:music_disc_5": "Craft from 9 disc fragments (ancient cities)",
  "minecraft:echo_shard": "Ancient city chests",
  "minecraft:sniffer_egg": "Suspicious sand in warm ocean ruins",
  "minecraft:breeze_rod": "Breezes in trial chambers",
  "minecraft:heavy_core": "Ominous vaults in trial chambers",
};

let farmCache: FarmReport | null = null;
let rosterCache: Roster | null = null;
export function setWorldSources(f: FarmReport | null, r: Roster | null) {
  farmCache = f;
  rosterCache = r;
}

/** A recipe that makes `id` (shaped/shapeless/smelting), as plain words. */
function recipesFor(id: string): Source[] {
  const all = gd.peek("recipes");
  if (!all) return [];
  const out: Source[] = [];
  const name = (x: string) => gd.items()?.[x]?.name ?? pretty(x);
  const ing = (v: unknown): string | null => {
    if (typeof v === "string") return v.startsWith("#") ? "any " + pretty(v.slice(1)).toLowerCase() : name(v);
    if (Array.isArray(v)) return ing(v[0]);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.item === "string") return name(o.item);
      if (typeof o.tag === "string") return "any " + pretty(o.tag).toLowerCase();
    }
    return null;
  };
  for (const r of Object.values(all) as Record<string, unknown>[]) {
    const res = r.result as Record<string, unknown> | string | undefined;
    const rid = typeof res === "string" ? res : (res?.id as string) ?? (res?.item as string);
    if (rid !== id) continue;
    const count = (typeof res === "object" && (res?.count as number)) || 1;
    const type = String(r.type ?? "");
    if (type.includes("smelting") || type.includes("blasting")) {
      out.push({ kind: "smelt", text: `Smelt ${ing(r.ingredient) ?? "?"}` });
    } else if (type.includes("crafting_shaped")) {
      const counts = new Map<string, number>();
      const pattern = (r.pattern as string[]) ?? [];
      const key = (r.key as Record<string, unknown>) ?? {};
      for (const row of pattern)
        for (const ch of row) {
          if (ch === " ") continue;
          const n = ing(key[ch]);
          if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
        }
      out.push({ kind: "craft", text: `Craft${count > 1 ? ` ${count}` : ""} from ${[...counts].map(([k, n]) => `${n} ${k}`).join(" + ")}` });
    } else if (type.includes("crafting_shapeless")) {
      const counts = new Map<string, number>();
      for (const x of (r.ingredients as unknown[]) ?? []) {
        const n = ing(x);
        if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
      }
      out.push({ kind: "craft", text: `Craft${count > 1 ? ` ${count}` : ""} from ${[...counts].map(([k, n]) => `${n} ${k}`).join(" + ")}` });
    } else if (type.includes("smithing")) {
      out.push({ kind: "craft", text: `Smithing: ${ing(r.base) ?? "?"} + ${ing(r.addition) ?? "?"}` });
    } else if (type.includes("stonecutting")) {
      out.push({ kind: "craft", text: `Stonecutter: ${ing(r.ingredient) ?? "?"}` });
    }
    if (out.length >= 3) break;
  }
  return out;
}

/** Mobs whose loot table can drop `id`. */
function dropsOf(id: string): Source[] {
  const mobs = gd.peek("mobs");
  const loot = gd.peek("loot") as Record<string, unknown> | null;
  if (!mobs || !loot) return [];
  const out: Source[] = [];
  for (const [mid, m] of Object.entries(mobs)) {
    if (!m.loot) continue;
    const t = loot[m.loot];
    if (t && JSON.stringify(t).includes(`"${id}"`)) out.push({ kind: "drop", text: `Dropped by ${m.name}`, icon: mid + "_spawn_egg" });
    if (out.length >= 4) break;
  }
  return out;
}

export function whereToGet(id: string): Source[] {
  const out: Source[] = [];
  for (const f of farmCache?.farms ?? []) {
    const r = f.rate.per_hour[id];
    if (r) out.push({ kind: "farm", text: `Your ${f.name} makes about ${Math.round(r)} an hour`, rate: r });
  }
  // blocks of an ingot / gem from a farm item
  const block = id.match(/^minecraft:(iron|gold|diamond|emerald|copper|redstone|lapis|coal)_block$/);
  if (block) {
    const unit = `minecraft:${block[1] === "lapis" ? "lapis_lazuli" : block[1] === "redstone" || block[1] === "coal" ? block[1] : block[1] + (block[1] === "diamond" || block[1] === "emerald" ? "" : "_ingot")}`;
    for (const f of farmCache?.farms ?? []) {
      const r = f.rate.per_hour[unit];
      if (r) out.push({ kind: "farm", text: `Your ${f.name}: about ${Math.round(r / 9)} blocks' worth an hour`, rate: r / 9 });
    }
  }
  for (const v of rosterCache?.villagers ?? []) {
    for (const o of v.offers) {
      if (o.sell[0] === id && o.uses < o.max) {
        out.push({ kind: "villager", text: `${pretty(v.profession)} at ${Math.floor(v.pos[0])}, ${Math.floor(v.pos[2])} sells ${o.sell[1]} for ${o.price} ${pretty(o.buy[0]).toLowerCase()}` });
        break;
      }
    }
    if (out.filter((s) => s.kind === "villager").length >= 2) break;
  }
  out.push(...recipesFor(id));
  out.push(...dropsOf(id));
  if (HINTS[id]) out.push({ kind: "hint", text: HINTS[id] });
  return out;
}
