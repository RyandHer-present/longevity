// Which model (mobdefs.json key), textures, extra layers, scale and hidden parts each mob uses.
// Mirrors the game's renderers: EntityRenderers, LayerDefinitions and each *Renderer / *Layer class.
// Pure data + functions (no imports with runtime effects) so it can also be checked from node.
import type { MobLook } from "./mobs";

/** One texture in a composite, optionally multiplied by a colour (tropical fish, collars). */
export interface TexLayer {
  path: string; // e.g. "entity/cow/cow_temperate"
  tint?: number;
}
/** One model drawn with one composited texture. */
export interface LayerSpec {
  key: string; // mobdefs.json key
  tex: TexLayer[];
  tint?: number; // material tint (sheep wool)
  translucent?: boolean;
  prefix?: string; // part-name prefix for extra layers in MobModel.parts
}
export interface MobSpec {
  key: string; // main model key
  layers: LayerSpec[]; // [0] is the main model
  scale: number; // renderer / shared-layer scale on top of the def's own scale
  hide: string[]; // parts the game keeps invisible in the default state
  zombieArms?: boolean; // arms held forward (AnimationUtils.animateZombieArms)
}

/** DyeColor.getTextureDiffuseColor, by dye id. */
export const DYE: number[] = [0xf9fffe, 0xf9801d, 0xc74ebd, 0x3ab3da, 0xfed83d, 0x80c71f, 0xf38baa, 0x474f52, 0x9d9d97, 0x169c9c, 0x8932b8, 0x3c44aa, 0x835432, 0x5e7c16, 0xb02e26, 0x1d1d21];
export const DYE_NAMES = ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"];

const strip = (s: string | null | undefined) => (s ?? "").replace(/^minecraft:/, "");
const V = (s: string | null | undefined, d: string) => (s ? strip(s) : d);
const num = (s: string | null | undefined, d: number) => {
  if (s == null || s === "") return d;
  const n = Number(s);
  return Number.isFinite(n) ? n : d;
};
/** A variant that is either an index into `names` or one of the names. */
const pick = (s: string | null | undefined, names: string[], d: string) => {
  if (s == null || s === "") return d;
  const n = Number(s);
  if (Number.isInteger(n)) return names[n] ?? d;
  const v = strip(s);
  return names.includes(v) ? v : d;
};

const T = (p: string, tint?: number): TexLayer => (tint == null ? { path: `entity/${p}` } : { path: `entity/${p}`, tint });

interface Opts {
  scale?: number;
  hide?: string[];
  zombieArms?: boolean;
  translucent?: boolean;
  extra?: LayerSpec[];
}
function mk(key: string, tex: (string | TexLayer)[], o: Opts = {}): MobSpec {
  const main: LayerSpec = { key, tex: tex.map((t) => (typeof t === "string" ? T(t) : t)) };
  if (o.translucent) main.translucent = true;
  return { key, layers: [main, ...(o.extra ?? [])], scale: o.scale ?? 1, hide: o.hide ?? [], zombieArms: o.zombieArms };
}
const over = (key: string, tex: string, translucent = false): LayerSpec => ({ key, tex: [T(tex)], translucent, prefix: "outer_" });

type Maker = (l: MobLook, v: string | null) => MobSpec;
const one =
  (key: string, tex: string, o: Opts = {}): Maker =>
  () =>
    mk(key, [tex], o);

const CHESTS = ["left_chest", "right_chest"];
const ILLAGER_CROSSED = ["left_arm", "right_arm", "hat"]; // IllagerModel: crossed arms, hat hidden
const ILLAGER_OPEN = ["arms", "hat"];
const AXOLOTL = ["lucy", "wild", "gold", "cyan", "blue"];
const PARROT = ["red_blue", "blue", "green", "yellow_blue", "grey"];
const LLAMA = ["creamy", "white", "brown", "gray"];
const RABBIT: Record<string, string> = { "0": "brown", "1": "white", "2": "black", "3": "white_splotched", "4": "gold", "5": "salt", "6": "toast", "99": "caerbannog" };
const HORSE_COLORS = ["white", "creamy", "chestnut", "brown", "black", "gray", "darkbrown"];
const HORSE_MARKS = ["", "white", "whitefield", "whitedots", "blackdots"];
const LEVELS = ["", "stone", "iron", "gold", "emerald", "diamond"];

/** Collar overlay: tamed wolves and cats always wear one (red by default). */
function collar(l: MobLook, path: string): TexLayer[] {
  const c = l.collar ?? (l.tamed ? 14 : null);
  return c == null ? [] : [T(path, DYE[c & 15])];
}
/** Slimes / magma cubes come in sizes 1, 2 and 4 (AbstractCubeMobRenderer scales by size). */
const cubeSize = (v: string | null) => {
  const n = num(v, 2);
  return n > 0 && n <= 16 ? n : 2;
};
function villagerLike(dir: "villager" | "zombie_villager", key: string, l: MobLook): MobSpec {
  const vt = V(l.villager?.type, "plains");
  const p = strip(l.villager?.profession);
  const tex = [`${dir}/${dir}`, `${dir}/type/${vt}`];
  if (p && p !== "none" && !l.baby) {
    tex.push(`${dir}/profession/${p}`);
    const lv = LEVELS[l.villager?.level ?? 1];
    if (p !== "nitwit" && lv) tex.push(`${dir}/profession_level/${lv}`);
  }
  return mk(key, tex, { zombieArms: dir === "zombie_villager" });
}
function llama(trader: boolean): Maker {
  return (l, v) => {
    const extra = trader ? [over("llama_decor", "equipment/llama_body/trader_llama")] : [];
    return mk("llama", [`llama/llama_${pick(v, LLAMA, "creamy")}`], { hide: CHESTS, extra });
  };
}

const MAKERS: Record<string, Maker> = {
  allay: one("allay", "allay/allay", { translucent: true }),
  armadillo: one("armadillo", "armadillo/armadillo", { hide: ["cube"] }),
  axolotl: (l, v) => mk("axolotl", [`axolotl/axolotl_${pick(v, AXOLOTL, "lucy")}`]),
  bat: one("bat", "bat/bat"),
  bee: one("bee", "bee/bee"),
  blaze: one("blaze", "blaze/blaze"),
  bogged: one("bogged", "skeleton/bogged", { extra: [over("bogged_outer", "skeleton/bogged_overlay")] }),
  breeze: one("breeze", "breeze/breeze", { translucent: true, extra: [over("breeze_wind", "breeze/breeze_wind", true)] }),
  camel: one("camel", "camel/camel"),
  camel_husk: one("camel", "camel/camel_husk"),
  cat: (l, v) => mk("cat", [`cat/cat_${V(v, "tabby")}`, ...collar(l, "cat/cat_collar")]),
  cave_spider: one("spider", "spider/cave_spider", { scale: 0.7 }),
  chicken: (l, v) => {
    const n = V(v, "temperate");
    return mk(n === "cold" ? "chicken_cold" : "chicken", [`chicken/chicken_${n}`]);
  },
  cod: one("cod", "fish/cod"),
  copper_golem: (l, v) => {
    const n = V(v, "unaffected");
    return mk("copper_golem", [n === "unaffected" ? "copper_golem/copper_golem" : `copper_golem/copper_golem_${n}`]);
  },
  cow: (l, v) => {
    const n = V(v, "temperate");
    return mk(n === "cold" ? "cow_cold" : n === "warm" ? "cow_warm" : "cow", [`cow/cow_${n}`]);
  },
  creaking: one("creaking", "creaking/creaking"),
  creeper: one("creeper", "creeper/creeper"),
  dolphin: one("dolphin", "dolphin/dolphin"),
  donkey: one("donkey", "horse/donkey", { scale: 0.87, hide: CHESTS }),
  drowned: one("drowned", "zombie/drowned", { zombieArms: true, extra: [over("drowned_outer", "zombie/drowned_outer_layer")] }),
  elder_guardian: one("elder_guardian", "guardian/guardian_elder"),
  ender_dragon: one("ender_dragon", "enderdragon/dragon"),
  enderman: one("enderman", "enderman/enderman"),
  endermite: one("endermite", "endermite/endermite"),
  evoker: one("illager", "illager/evoker", { hide: ILLAGER_CROSSED }),
  fox: (l, v) => mk("fox", [V(v, "red") === "snow" ? "fox/fox_snow" : "fox/fox"]),
  frog: (l, v) => mk("frog", [`frog/frog_${V(v, "temperate")}`], { hide: ["croaking_body"] }),
  ghast: one("ghast", "ghast/ghast"),
  giant: one("zombie", "zombie/zombie", { scale: 6, zombieArms: true }),
  glow_squid: one("squid", "squid/glow_squid"),
  goat: one("goat", "goat/goat"),
  guardian: one("guardian", "guardian/guardian"),
  happy_ghast: one("happy_ghast", "ghast/happy_ghast"),
  hoglin: one("hoglin", "hoglin/hoglin"),
  horse: (l, v) => {
    const n = num(v, 3) | 0;
    const tex = [`horse/horse_${HORSE_COLORS[n & 0xff] ?? "brown"}`];
    const m = HORSE_MARKS[(n >> 8) & 0xff];
    if (m) tex.push(`horse/horse_markings_${m}`);
    return mk("horse", tex, { scale: 1.1 });
  },
  husk: one("zombie", "zombie/husk", { scale: 1.0625, zombieArms: true }),
  illusioner: one("illager", "illager/illusioner", { hide: ["left_arm", "right_arm"] }),
  iron_golem: one("iron_golem", "iron_golem/iron_golem"),
  llama: llama(false),
  magma_cube: (l, v) => mk("magma_cube", ["slime/magmacube"], { scale: cubeSize(v) }),
  mooshroom: (l, v) => mk("cow", [`cow/mooshroom_${V(v, "red")}`]),
  mule: one("donkey", "horse/mule", { scale: 0.92, hide: CHESTS }),
  nautilus: one("nautilus", "nautilus/nautilus"),
  ocelot: one("ocelot", "cat/ocelot"),
  panda: (l, v) => {
    const g = V(v, "normal");
    return mk("panda", [g === "normal" ? "panda/panda" : `panda/panda_${g}`]);
  },
  parched: one("parched", "skeleton/parched"),
  parrot: (l, v) => mk("parrot", [`parrot/parrot_${pick(v, PARROT, "red_blue")}`]),
  phantom: (l, v) => mk("phantom", ["phantom/phantom"], { scale: 1 + 0.15 * num(v, 0) }),
  pig: (l, v) => {
    const n = V(v, "temperate");
    return mk(n === "cold" ? "pig_cold" : "pig", [`pig/pig_${n}`]);
  },
  piglin: one("piglin", "piglin/piglin"),
  piglin_brute: one("piglin", "piglin/piglin_brute"),
  pillager: one("illager", "illager/pillager", { hide: ILLAGER_OPEN }),
  polar_bear: one("polar_bear", "bear/polarbear"),
  pufferfish: (l, v) => {
    const s = num(v, 0);
    return mk(s >= 2 ? "pufferfish_big" : s === 1 ? "pufferfish_mid" : "pufferfish_small", ["fish/pufferfish"]);
  },
  rabbit: (l, v) => mk("rabbit", [`rabbit/rabbit_${RABBIT[v ?? "0"] ?? V(v, "brown")}`]),
  ravager: one("ravager", "illager/ravager"),
  salmon: (l, v) => mk("salmon", ["fish/salmon"], { scale: ({ small: 0.5, large: 1.5 } as Record<string, number>)[V(v, "medium")] ?? 1 }),
  sheep: (l) =>
    mk("sheep", ["sheep/sheep"], {
      extra: l.sheared ? [] : [{ key: "sheep_fur", tex: [T("sheep/sheep_wool")], tint: DYE[(l.color ?? 0) & 15], prefix: "wool_" }],
    }),
  shulker: (l) => {
    const c = l.color;
    return mk("shulker", [c != null && c >= 0 && c < 16 ? `shulker/shulker_${DYE_NAMES[c]}` : "shulker/shulker"]);
  },
  silverfish: one("silverfish", "silverfish/silverfish"),
  skeleton: one("skeleton", "skeleton/skeleton"),
  skeleton_horse: one("horse", "horse/horse_skeleton"),
  slime: (l, v) => mk("slime", ["slime/slime"], { scale: cubeSize(v), extra: [over("slime_outer", "slime/slime", true)] }),
  sniffer: one("sniffer", "sniffer/sniffer"),
  snow_golem: one("snow_golem", "snow_golem/snow_golem"),
  spider: one("spider", "spider/spider"),
  squid: one("squid", "squid/squid"),
  stray: one("skeleton", "skeleton/stray", { extra: [over("humanoid_outer", "skeleton/stray_overlay")] }),
  strider: one("strider", "strider/strider"),
  // adult sulfur cube: size 2 x the renderer's extra 0.5 downscale
  sulfur_cube: one("sulfur_cube", "sulfur_cube/sulfur_cube_inner", { translucent: true, extra: [over("sulfur_cube_outer", "sulfur_cube/sulfur_cube_outer", true)] }),
  tadpole: one("tadpole", "tadpole/tadpole"),
  trader_llama: llama(true),
  tropical_fish: (l, v) => {
    // packed: size | pattern << 8 | base colour << 16 | pattern colour << 24; default = clownfish
    const n = num(v, 0x10000) | 0;
    const large = (n & 0xff) === 1;
    const ab = large ? "b" : "a";
    const pattern = ((n >> 8) & 0xff) % 6;
    return mk(large ? "tropical_fish_large" : "tropical_fish_small", [T(`fish/tropical_${ab}`, DYE[(n >> 16) & 15]), T(`fish/tropical_${ab}_pattern_${pattern + 1}`, DYE[(n >>> 24) & 15])]);
  },
  turtle: one("turtle", "turtle/turtle", { hide: ["egg_belly"] }),
  vex: one("vex", "illager/vex", { translucent: true }),
  villager: (l) => villagerLike("villager", "villager", l),
  vindicator: one("illager", "illager/vindicator", { hide: ILLAGER_CROSSED }),
  wandering_trader: one("villager", "wandering_trader/wandering_trader"),
  warden: one("warden", "warden/warden"),
  witch: one("witch", "witch/witch"),
  wither: one("wither", "wither/wither", { scale: 2 }),
  wither_skeleton: one("skeleton", "skeleton/wither_skeleton", { scale: 1.2 }),
  wolf: (l, v) => {
    const name = V(v, "pale");
    const base = name === "pale" ? "wolf/wolf" : `wolf/wolf_${name}`;
    return mk("wolf", [l.tamed ? base + "_tame" : base, ...collar(l, "wolf/wolf_collar")]);
  },
  zoglin: one("hoglin", "hoglin/zoglin"),
  zombie: one("zombie", "zombie/zombie", { zombieArms: true }),
  zombie_horse: one("horse", "horse/horse_zombie"),
  zombie_nautilus: (l, v) =>
    V(v, "temperate") === "warm" ? mk("zombie_nautilus_coral", ["nautilus/zombie_nautilus_coral"]) : mk("nautilus", ["nautilus/zombie_nautilus"]),
  zombie_villager: (l) => villagerLike("zombie_villager", "zombie_villager", l),
  zombified_piglin: one("zombified_piglin", "piglin/zombified_piglin", { zombieArms: true }),
};

/** Every mob id (without namespace) that has a model. */
export const MOB_IDS: string[] = Object.keys(MAKERS);

/** Model + texture plan for a mob, or null for ids without a model. */
export function mobSpec(look: MobLook): MobSpec | null {
  const id = strip(look.id);
  const make = MAKERS[id];
  if (!make) return null;
  const v = look.variant == null ? null : String(look.variant);
  return make(look, v);
}
