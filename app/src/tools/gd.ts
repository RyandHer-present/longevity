// Vanilla game data bundled with the app (made by the extractor, in public/gamedata/<version>/).
// Load once, then read synchronously. Every reader copes with the data being missing.
export interface GItem {
  name: string;
  stack: number;
  durability?: number | null;
  rarity?: string;
  food?: { nutrition: number; saturation: number } | null;
  fuel?: number | null;
  attack_damage?: number | null;
  attack_speed?: number | null;
  enchantable?: number | null;
  repair?: string[] | null;
}
export interface GBlock {
  name: string;
  hardness: number;
  blast: number;
  tool?: string | null;
  tier?: string | null;
  light?: number;
  flammable?: boolean;
  drops?: string | null;
}
export interface GMob {
  name: string;
  category: string;
  health: number;
  armor?: number;
  toughness?: number;
  attack?: number | null;
  speed?: number;
  follow?: number;
  kb_resist?: number;
  loot?: string | null;
  biomes?: string[];
}
export interface GEnch {
  name: string;
  max_level: number;
  weight?: number;
  anvil_cost?: number;
  supported?: string[];
  primary?: string[];
  exclusive?: string[];
  min_cost?: unknown;
  max_cost?: unknown;
  treasure?: boolean;
  tradeable?: boolean;
  curse?: boolean;
}
export interface GTrade {
  buy: [string, number | [number, number]];
  buyB: [string, number] | null;
  sell: [string, number | [number, number]];
  max_uses?: number;
  xp?: number;
  price_mult?: number;
  note?: string;
}
export interface GBrewing {
  mixes: { input: string; ingredient: string; output: string }[];
  containers?: { input: string; ingredient: string; output: string }[];
  potions: Record<string, { name: string; effects: [string, number, number][] }>;
}
export interface GChange {
  from: string;
  to: string;
  mobs?: { id: string; name: string; field: string; from: unknown; to: unknown }[];
  loot?: { table: string; name: string; what: string }[];
  trades?: { profession: string; level: number | string; what: string }[];
  recipes?: { added?: (string | { id: string; name?: string })[]; removed?: (string | { id: string; name?: string })[]; changed?: { id: string; name?: string; what: string }[] };
  items?: { id: string; name?: string; what?: string; field?: string; from?: unknown; to?: unknown }[];
  blocks?: { id: string; name?: string; what?: string; field?: string; from?: unknown; to?: unknown }[];
  enchantments?: { id: string; name?: string; what?: string; field?: string; from?: unknown; to?: unknown }[];
}

type Files = {
  items: Record<string, GItem>;
  blocks: Record<string, GBlock>;
  mobs: Record<string, GMob>;
  loot: Record<string, unknown>;
  recipes: Record<string, unknown>;
  enchantments: Record<string, GEnch>;
  brewing: GBrewing;
  trades: Record<string, Record<string, GTrade[]>>;
  tags: Record<string, string[]>;
  meta: { version: string; release_time?: string; missing?: string[] };
};

const cache = new Map<string, unknown>();
const pending = new Map<string, Promise<unknown>>();
let current = "26.3";
let index: { versions: string[]; latest: string } | null = null;

async function fetchJson(path: string): Promise<unknown> {
  for (const p of [path + ".gz", path]) {
    try {
      const r = await fetch(p);
      if (!r.ok) continue;
      const buf = new Uint8Array(await r.arrayBuffer());
      // gzip magic: decompress ourselves (the server may or may not have already)
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
        return JSON.parse(await new Response(s).text());
      }
      const text = new TextDecoder().decode(buf);
      if (text.trimStart().startsWith("<")) continue; // an HTML fallback page, not data
      return JSON.parse(text);
    } catch {
      /* try the next form */
    }
  }
  return null;
}

export const gd = {
  setVersion(v: string) {
    current = v;
  },
  get version() {
    return current;
  },
  async index() {
    if (!index) index = ((await fetchJson("/gamedata/index.json")) as typeof index) ?? { versions: [], latest: current };
    return index!;
  },
  async load<K extends keyof Files>(file: K, version = current): Promise<Files[K] | null> {
    const key = version + "/" + file;
    if (cache.has(key)) return cache.get(key) as Files[K];
    if (!pending.has(key))
      pending.set(
        key,
        fetchJson(`/gamedata/${version}/${file}.json`).then((v) => {
          cache.set(key, v);
          return v;
        }),
      );
    return (await pending.get(key)) as Files[K] | null;
  },
  async change(from: string, to: string): Promise<GChange | null> {
    const key = `changes/${from}__${to}`;
    if (cache.has(key)) return cache.get(key) as GChange;
    const v = (await fetchJson(`/gamedata/changes/${from}__${to}.json`)) as GChange | null;
    cache.set(key, v);
    return v;
  },
  peek<K extends keyof Files>(file: K, version = current): Files[K] | null {
    return (cache.get(version + "/" + file) as Files[K]) ?? null;
  },
  items: () => gd.peek("items"),
  enchantments: () => gd.peek("enchantments"),
  /** Warm up the small files the tools read synchronously. */
  async preload() {
    await Promise.all([gd.load("items"), gd.load("enchantments")]);
  },
};

export function stackOf(id: string): number {
  return gd.items()?.[id]?.stack ?? 64;
}
