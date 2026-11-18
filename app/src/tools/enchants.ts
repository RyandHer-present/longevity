// Enchanting rules (Java 1.21+ / 26.x): max levels, anvil multipliers, what conflicts, the best set
// for each piece of gear, and the Anvil Planner's cheapest-order solver.
import { gd } from "./gd";

type E = { max: number; item: number; book: number; group?: string };
// item multiplier = the enchantment's anvil_cost; books cost half (at least 1)
export const ENCH: Record<string, E> = {
  protection: { max: 4, item: 1, book: 1, group: "prot" },
  fire_protection: { max: 4, item: 2, book: 1, group: "prot" },
  blast_protection: { max: 4, item: 4, book: 2, group: "prot" },
  projectile_protection: { max: 4, item: 2, book: 1, group: "prot" },
  feather_falling: { max: 4, item: 2, book: 1 },
  thorns: { max: 3, item: 8, book: 4 },
  respiration: { max: 3, item: 4, book: 2 },
  aqua_affinity: { max: 1, item: 4, book: 2 },
  depth_strider: { max: 3, item: 4, book: 2, group: "boots" },
  frost_walker: { max: 2, item: 4, book: 2, group: "boots" },
  soul_speed: { max: 3, item: 8, book: 4 },
  swift_sneak: { max: 3, item: 8, book: 4 },
  sharpness: { max: 5, item: 1, book: 1, group: "dmg" },
  smite: { max: 5, item: 2, book: 1, group: "dmg" },
  bane_of_arthropods: { max: 5, item: 2, book: 1, group: "dmg" },
  density: { max: 5, item: 2, book: 1, group: "dmg" },
  breach: { max: 4, item: 4, book: 2, group: "dmg" },
  knockback: { max: 2, item: 2, book: 1 },
  fire_aspect: { max: 2, item: 4, book: 2 },
  looting: { max: 3, item: 4, book: 2 },
  sweeping_edge: { max: 3, item: 4, book: 2 },
  wind_burst: { max: 3, item: 4, book: 2 },
  lunge: { max: 3, item: 2, book: 1 },
  efficiency: { max: 5, item: 1, book: 1 },
  silk_touch: { max: 1, item: 8, book: 4, group: "drops" },
  fortune: { max: 3, item: 4, book: 2, group: "drops" },
  unbreaking: { max: 3, item: 2, book: 1 },
  mending: { max: 1, item: 4, book: 2, group: "bowinf" },
  power: { max: 5, item: 1, book: 1 },
  punch: { max: 2, item: 4, book: 2 },
  flame: { max: 1, item: 4, book: 2 },
  infinity: { max: 1, item: 8, book: 4, group: "bowinf" },
  luck_of_the_sea: { max: 3, item: 4, book: 2 },
  lure: { max: 3, item: 4, book: 2 },
  impaling: { max: 5, item: 4, book: 2 },
  riptide: { max: 3, item: 4, book: 2, group: "trident" },
  loyalty: { max: 3, item: 1, book: 1, group: "trident" },
  channeling: { max: 1, item: 8, book: 4, group: "trident" },
  multishot: { max: 1, item: 4, book: 2, group: "xbow" },
  piercing: { max: 4, item: 1, book: 1, group: "xbow" },
  quick_charge: { max: 3, item: 2, book: 1 },
  binding_curse: { max: 1, item: 8, book: 4 },
  vanishing_curse: { max: 1, item: 8, book: 4 },
};

/** Live values from the bundled game data when it has them. */
export function ench(id: string): E {
  const k = id.replace("minecraft:", "");
  const base = ENCH[k] ?? { max: 1, item: 2, book: 1 };
  const g = gd.enchantments()?.["minecraft:" + k];
  if (g) return { ...base, max: g.max_level ?? base.max, item: g.anvil_cost ?? base.item, book: Math.max(1, Math.floor((g.anvil_cost ?? base.item * 2) / 2)) };
  return base;
}

export function conflicts(a: string, b: string): boolean {
  const x = a.replace("minecraft:", "");
  const y = b.replace("minecraft:", "");
  if (x === y) return false;
  const g = gd.enchantments();
  if (g?.["minecraft:" + x]?.exclusive) return g["minecraft:" + x].exclusive!.includes("minecraft:" + y);
  const ga = ENCH[x]?.group;
  const gb = ENCH[y]?.group;
  if (ga && ga === gb) {
    // riptide clashes with loyalty and channeling; loyalty + channeling are fine
    if (ga === "trident") return x === "riptide" || y === "riptide";
    return true;
  }
  return false;
}

export const enchName = (id: string) => {
  const k = id.replace("minecraft:", "");
  const n = gd.enchantments()?.["minecraft:" + k]?.name;
  return n ?? k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(" Of ", " of ").replace(" The ", " the ");
};
const ROMAN = ["", "I", "II", "III", "IV", "V"];
export const enchLabel = (id: string, lvl: number) => (ench(id).max === 1 ? enchName(id) : `${enchName(id)} ${ROMAN[lvl] ?? lvl}`);

// ------------------------------------------------------------------ best sets

type Need = [string, number][]; // any one of these (enchant, level)
const ARMOR = (extra: Need[]): Need[] => [[["protection", 4]], [["unbreaking", 3]], [["mending", 1]], ...extra];
const TOOL = (extra: Need[]): Need[] => [[["efficiency", 5]], [["unbreaking", 3]], [["mending", 1]], ...extra];

export function bestSet(id: string): Need[] | null {
  const s = id.replace("minecraft:", "");
  if (s.endsWith("_helmet") || s === "turtle_helmet") return ARMOR([[["respiration", 3]], [["aqua_affinity", 1]]]);
  if (s.endsWith("_chestplate")) return ARMOR([]);
  if (s.endsWith("_leggings")) return ARMOR([[["swift_sneak", 3]]]);
  if (s.endsWith("_boots"))
    return ARMOR([
      [["feather_falling", 4]],
      [
        ["depth_strider", 3],
        ["frost_walker", 2],
      ],
      [["soul_speed", 3]],
    ]);
  if (s.endsWith("_sword")) return [[["sharpness", 5]], [["unbreaking", 3]], [["mending", 1]], [["looting", 3]], [["sweeping_edge", 3]], [["fire_aspect", 2]]];
  if (s.endsWith("_spear")) return [[["sharpness", 5]], [["unbreaking", 3]], [["mending", 1]], [["lunge", 3]], [["looting", 3]], [["fire_aspect", 2]]];
  if (s.endsWith("_pickaxe"))
    return TOOL([
      [
        ["fortune", 3],
        ["silk_touch", 1],
      ],
    ]);
  if (s.endsWith("_shovel"))
    return TOOL([
      [
        ["silk_touch", 1],
        ["fortune", 3],
      ],
    ]);
  if (s.endsWith("_axe"))
    return TOOL([
      [["sharpness", 5]],
      [
        ["silk_touch", 1],
        ["fortune", 3],
      ],
    ]);
  if (s.endsWith("_hoe")) return TOOL([[["fortune", 3]]]);
  if (s === "bow")
    return [
      [["power", 5]],
      [["unbreaking", 3]],
      [
        ["mending", 1],
        ["infinity", 1],
      ],
      [["punch", 2]],
      [["flame", 1]],
    ];
  if (s === "crossbow")
    return [
      [["quick_charge", 3]],
      [["unbreaking", 3]],
      [["mending", 1]],
      [
        ["multishot", 1],
        ["piercing", 4],
      ],
    ];
  if (s === "trident")
    return [
      [["impaling", 5]],
      [["unbreaking", 3]],
      [["mending", 1]],
      [
        ["loyalty", 3],
        ["riptide", 3],
      ],
      [["channeling", 1]],
    ];
  if (s === "mace")
    return [
      [
        ["density", 5],
        ["breach", 4],
      ],
      [["wind_burst", 3]],
      [["unbreaking", 3]],
      [["mending", 1]],
      [["fire_aspect", 2]],
    ];
  if (s === "fishing_rod") return [[["luck_of_the_sea", 3]], [["lure", 3]], [["unbreaking", 3]], [["mending", 1]]];
  if (s === "shears") return TOOL([]);
  if (s === "elytra" || s === "shield" || s === "flint_and_steel" || s === "brush" || s === "carrot_on_a_stick" || s === "warped_fungus_on_a_stick")
    return [[["unbreaking", 3]], [["mending", 1]]];
  return null;
}

export interface Gap {
  want: Need;
  have: [string, number] | null;
}
/** What's missing or too low compared to the best set. Options that clash with what you have are skipped. */
export function gaps(id: string, have: [string, number][]): Gap[] | null {
  const best = bestSet(id);
  if (!best) return null;
  const h = new Map(have.map(([k, l]) => [k.replace("minecraft:", ""), l]));
  const out: Gap[] = [];
  for (const need of best) {
    const met = need.some(([k, l]) => (h.get(k) ?? 0) >= l);
    if (met) continue;
    const partial = need.find(([k]) => h.has(k));
    // options that conflict with something already on it are not really missing
    const open = need.filter(([k]) => ![...h.keys()].some((x) => conflicts(x, k)));
    if (!partial && open.length === 0) continue;
    out.push({ want: partial ? [need.find(([k]) => k === partial[0])!] : open, have: partial ? [partial[0], h.get(partial[0])!] : null });
  }
  return out;
}

// ------------------------------------------------------------------ durability

const DUR: Record<string, number> = {
  wooden: 59,
  stone: 131,
  iron: 250,
  golden: 32,
  diamond: 1561,
  netherite: 2031,
  copper: 190,
};
const ARMOR_BASE: Record<string, number> = { leather: 5, chainmail: 15, iron: 15, golden: 7, diamond: 33, netherite: 37, copper: 11, turtle: 25 };
const ARMOR_SLOT: Record<string, number> = { helmet: 11, chestplate: 16, leggings: 15, boots: 13 };
export function maxDurability(id: string): number | null {
  const g = gd.items()?.[id]?.durability;
  if (g) return g;
  const s = id.replace("minecraft:", "");
  const m = s.match(/^(\w+?)_(sword|pickaxe|axe|shovel|hoe|spear)$/);
  if (m && DUR[m[1]]) return DUR[m[1]];
  const a = s.match(/^(\w+?)_(helmet|chestplate|leggings|boots)$/);
  if (a && ARMOR_BASE[a[1]]) return ARMOR_BASE[a[1]] * ARMOR_SLOT[a[2]];
  return (
    {
      turtle_helmet: 275,
      elytra: 432,
      bow: 384,
      crossbow: 465,
      trident: 250,
      shield: 336,
      fishing_rod: 64,
      shears: 238,
      flint_and_steel: 64,
      mace: 500,
      brush: 64,
      carrot_on_a_stick: 25,
      warped_fungus_on_a_stick: 100,
    }[s] ?? null
  );
}

// ------------------------------------------------------------------ anvil planner

export interface Piece {
  key: string;
  label: string;
  book: boolean;
  ench: [string, number][];
  work: number; // anvil uses so far (prior work penalty = 2^work - 1)
}
export interface Step {
  left: string;
  right: string;
  cost: number;
  result: string;
}
export interface Plan {
  steps: Step[];
  total: number;
  max: number;
  tooExpensive: boolean;
}

const pen = (n: number) => (1 << n) - 1;
export const workFromRepairCost = (rc: number | null | undefined) => (rc ? Math.round(Math.log2(rc + 1)) : 0);

function merge(a: [string, number][], b: [string, number][]): { ench: [string, number][]; cost: number } {
  const m = new Map(a.map(([k, l]) => [k.replace("minecraft:", ""), l]));
  let cost = 0;
  for (const [k0, l] of b) {
    const k = k0.replace("minecraft:", "");
    if ([...m.keys()].some((x) => conflicts(x, k))) {
      cost += 1; // Java charges 1 per conflicting enchantment and drops it
      continue;
    }
    const e = ench(k);
    const cur = m.get(k) ?? 0;
    const lvl = cur === l ? Math.min(e.max, l + 1) : Math.max(cur, l);
    m.set(k, lvl);
    // the sacrifice is always a book here, so the book multiplier applies
    cost += lvl * e.book;
  }
  return { ench: [...m.entries()], cost };
}

/**
 * Cheapest order to put every book onto the target (the target always stays on the left).
 * Exact search over every way of combining (fine for up to ~10 books). Steps that would cost
 * 40+ levels are "Too Expensive!" in survival, so they're never used if any other order works.
 */
export function planAnvil(target: Piece, books: Piece[]): Plan | null {
  const n = books.length;
  if (n === 0) return { steps: [], total: 0, max: 0, tooExpensive: false };
  if (n > 11) return null;
  type Node = { cost: number; max: number; work: number; ench: [string, number][]; steps: Step[]; label: string };
  // memo over subsets of books; bit n means "includes the target"
  const memo = new Map<number, Node[]>();
  const all = (1 << (n + 1)) - 1;
  const T = 1 << n;
  function leaf(mask: number): Node {
    if (mask === T) return { cost: 0, max: 0, work: target.work, ench: target.ench, steps: [], label: target.label };
    const i = Math.log2(mask);
    const b = books[i];
    return { cost: 0, max: 0, work: b.work, ench: b.ench, steps: [], label: b.label };
  }
  function solve(mask: number): Node[] {
    const hit = memo.get(mask);
    if (hit) return hit;
    if ((mask & (mask - 1)) === 0) {
      const r = [leaf(mask)];
      memo.set(mask, r);
      return r;
    }
    const best = new Map<number, Node>(); // by resulting work count, cheapest
    const hasT = (mask & T) !== 0;
    // split into left (contains the target if present) and right
    for (let sub = (mask - 1) & mask; sub > 0; sub = (sub - 1) & mask) {
      const left = sub;
      const right = mask ^ sub;
      if (hasT && !(left & T)) continue;
      if (!hasT && left > right) continue; // books: each split once... both orders matter for penalties, so allow both
      for (const L of solve(left))
        for (const R of solve(right)) {
          for (const [A, B] of hasT ? [[L, R]] : [
                [L, R],
                [R, L],
              ]) {
            const m = merge(A.ench, B.ench);
            const step = m.cost + pen(A.work) + pen(B.work);
            const node: Node = {
              cost: A.cost + B.cost + step,
              max: Math.max(A.max, B.max, step),
              work: Math.max(A.work, B.work) + 1,
              ench: m.ench,
              steps: [...A.steps, ...B.steps, { left: A.label, right: B.label, cost: step, result: "" }],
              label: hasT ? target.label : m.ench.map(([k, l]) => enchLabel(k, l)).join(" + "),
            };
            const key = node.work;
            const cur = best.get(key);
            const better = (x: Node, y: Node) => (x.max >= 40) !== (y.max >= 40) ? x.max < 40 : x.cost < y.cost;
            if (!cur || better(node, cur)) best.set(key, node);
          }
        }
    }
    // keep only nodes not beaten on both cost and work
    const list = [...best.values()].sort((a, b) => a.work - b.work);
    const out: Node[] = [];
    for (const x of list) if (!out.some((y) => y.cost <= x.cost && y.max <= x.max && y.work <= x.work)) out.push(x);
    memo.set(mask, out);
    return out;
  }
  const res = solve(all);
  const pick = res.filter((r) => r.max < 40).sort((a, b) => a.cost - b.cost)[0] ?? res.sort((a, b) => a.max - b.max)[0];
  if (!pick) return null;
  return { steps: pick.steps, total: pick.cost, max: pick.max, tooExpensive: pick.max >= 40 };
}

/** XP points lost spending `levels` levels when you're at level `from`. */
export function pointsFor(from: number, levels: number) {
  const total = (l: number) => (l <= 16 ? l * l + 6 * l : l <= 31 ? 2.5 * l * l - 40.5 * l + 360 : 4.5 * l * l - 162.5 * l + 2220);
  return Math.round(total(from) - total(Math.max(0, from - levels)));
}

/** XP points a plan really costs when you do each step as soon as you have exactly its level
 * (the cheapest way: levels get dearer the higher you are, so never save up for a whole plan). */
export function planPoints(costs: number[]) {
  return costs.reduce((a, c) => a + pointsFor(c, c), 0);
}
