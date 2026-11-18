import { Component, memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Box, Eye, EyeOff, Lock, PackageOpen, RefreshCw, Search, Sparkles, X } from "lucide-react";
import {
  api,
  blockTex,
  dimName,
  fmtDate,
  fmtNum,
  iconxUrl,
  plateUrl,
  prettyId,
  type DexAdv,
  type DexBiome,
  type DexBlock,
  type DexData,
  type DexDeath,
  type DexDisc,
  type DexEntry,
  type DexMob,
  type DexPet,
  type DexVariant,
  type Rarity,
  DexEnchant,
  DexTrim,
  DexItem,
} from "../api";
import { useStore } from "../store";
import { sfx } from "../sound";
import { HudRow, Spinner, Ticker } from "../ui";
import { Engine } from "../render/engine";
import { canModel, mobPortrait, MobStage, type DexLook } from "../render/portrait";
import { trimFront } from "../render/trims";
import { SkinViewer } from "../render/skinview";
import type { MobLook } from "../render/mobs";
import { enqueueRender } from "./Places";
import {
  BackCtx,
  BACKS,
  CardBack,
  cardLevel,
  DiscArt,
  DiscControls,
  dayStr,
  KINDS,
  LevelBadge,
  LevelPanel,
  loadBack,
  loadSetsSeen,
  markSetSeen,
  newsSeen,
  PlaquesView,
  RANK,
  RCOLOR,
  saveBack,
  SetCelebration,
  setStates,
  SetsView,
  SetStrip,
  TAB_ORDER,
  WhatsNew,
  type Kind,
  type SetMember,
  type SetState,
  type Tab,
} from "./dexextra";

// ------------------------------------------------------------------ tables

const TABS: Record<Tab, { label: string; icon: string; noun: string; hint: string }> = {
  mobs: { label: "Field Guide", icon: "minecraft:zombie_spawn_egg", noun: "mobs", hint: "Defeat one, tame one, or get a good look at one up close." },
  biomes: { label: "Biomes", icon: "minecraft:grass_block", noun: "biomes", hint: "Spend a little while in one." },
  pets: { label: "Pets", icon: "minecraft:lead", noun: "companions", hint: "Tame or befriend one." },
  blocks: { label: "Blocks", icon: "minecraft:diamond_ore", noun: "blocks", hint: "Mine, place, craft or pick one up." },
  items: { label: "Items", icon: "minecraft:bundle", noun: "items", hint: "Hold one: pick it up, craft it or keep it in a chest." },
  enchants: { label: "Enchants", icon: "minecraft:enchanted_book", noun: "enchant levels", hint: "Own a book or a piece of gear with this enchant at this level." },
  trims: { label: "Trims", icon: "minecraft:silence_armor_trim_smithing_template", noun: "trims", hint: "Own a piece of armour with this trim in this material." },
  deaths: { label: "Deaths", icon: "minecraft:bone", noun: "ways to die", hint: "Die this way once. Not a challenge. Probably." },
  variants: { label: "Variants", icon: "minecraft:axolotl_bucket", noun: "variants", hint: "Get a good look at one up close." },
  advancements: { label: "Advancements", icon: "minecraft:knowledge_book", noun: "advancements", hint: "Earn it in game." },
  discs: { label: "Discs", icon: "minecraft:music_disc_cat", noun: "discs", hint: "Get it into your hands. Then you can play it here too." },
  plaques: { label: "Plaques", icon: "minecraft:gold_ingot", noun: "plaques", hint: "" },
  sets: { label: "Sets", icon: "minecraft:item_frame", noun: "sets", hint: "" },
};
const GROUP_ORDER: Record<Kind, string[]> = {
  variants: ["colors", "riders", "special"],
  advancements: ["story", "nether", "end", "adventure", "husbandry"],
  discs: ["c418", "new"],
  mobs: ["passive", "neutral", "hostile", "aquatic", "boss"],
  biomes: ["plains", "forest", "jungle", "desert", "mountain", "snowy", "swamp", "beach", "water", "cave", "rare", "nether", "end"],
  pets: [],
  blocks: ["natural", "building", "wood", "colors", "plants", "ores", "ocean", "redstone", "utility", "nether", "end"],
  items: ["tools", "combat", "food", "materials", "brewing", "smithing", "transport", "dyes", "decor"],
  enchants: ["weapons", "armor", "tools", "ranged", "trident", "any", "curses"],
  trims: ["sentry", "dune", "coast", "wild", "tide", "ward", "vex", "rib", "snout", "eye", "spire", "silence", "wayfinder", "shaper", "raiser", "host", "flow", "bolt"],
  deaths: ["fall", "combat", "nature", "fire", "explosion", "magic", "void"],
};
const GROUP_NAME: Record<string, string> = {
  yours: "Yours",
  befriend: "Not befriended yet",
  colors: "Colorful",
  utility: "Utility",
  water: "Ocean & River",
  rare: "Rare",
  combat: "Combat",
  nature: "Nature",
  void: "The Void",
  riders: "Riders",
  special: "Special",
  c418: "C418",
  new: "Newer discs",
  story: "Minecraft",
  end: "The End",
};
for (const [k, v] of Object.entries({
  tools: "Tools",
  food: "Food",
  materials: "Materials",
  brewing: "Brewing",
  smithing: "Smithing",
  transport: "Transport",
  dyes: "Dyes",
  decor: "Decoration",
  weapons: "Weapons",
  armor: "Armour",
  ranged: "Bows & Crossbows",
  trident: "Trident",
  any: "Any gear",
  curses: "Curses",
}))
  GROUP_NAME[k] ??= v;
const FRAME_NAME: Record<string, string> = { task: "Advancement", goal: "Goal", challenge: "Challenge" };

/** How each rare variant looks (and a small item badge for the ones a model can't show). */
const VLOOK: Record<string, DexLook & { badge?: string }> = {
  pink_sheep: { id: "minecraft:sheep", color: 6 },
  brown_panda: { id: "minecraft:panda", variant: "brown" },
  blue_axolotl: { id: "minecraft:axolotl", variant: "blue" },
  brown_mooshroom: { id: "minecraft:mooshroom", variant: "brown" },
  charged_creeper: { id: "minecraft:creeper", charged: true },
  chicken_jockey: { id: "minecraft:chicken", rider: { id: "minecraft:zombie", baby: true } },
  spider_jockey: { id: "minecraft:spider", rider: { id: "minecraft:skeleton" } },
  skeleton_horseman: { id: "minecraft:skeleton_horse", rider: { id: "minecraft:skeleton" } },
  strider_jockey: { id: "minecraft:strider", rider: { id: "minecraft:zombified_piglin" } },
  hoglin_jockey: { id: "minecraft:hoglin", rider: { id: "minecraft:piglin", baby: true } },
  snowy_wolf: { id: "minecraft:wolf", variant: "snowy" },
  black_cat: { id: "minecraft:cat", variant: "all_black" },
  snow_fox: { id: "minecraft:fox", variant: "snow" },
  patrol_captain: { id: "minecraft:pillager", badge: "minecraft:ominous_bottle" },
  trident_drowned: { id: "minecraft:drowned", badge: "minecraft:trident" },
};
const VFACT: Record<string, string> = {
  pink_sheep: "Only about 1 in 600 sheep is born pink.",
  brown_panda: "Brown is the rarest panda gene. It needs two copies to show.",
  blue_axolotl: "The rarest axolotl colour of all.",
  brown_mooshroom: "The brown kind of mooshroom.",
  charged_creeper: "A creeper with a crackling blue aura, and a much bigger bang.",
  chicken_jockey: "A baby riding a chicken. About 1 in 20 babies tries it.",
  spider_jockey: "Around 1 in 100 spiders spawns with a skeleton on its back.",
  skeleton_horseman: "Four skeletons on four skeleton horses arrive together.",
  strider_jockey: "A zombified piglin riding a strider across the lava.",
  hoglin_jockey: "A baby piglin riding a hoglin.",
  snowy_wolf: "The rarest wolf of the nine.",
  black_cat: "The all-black cat. Rare, and a little spooky.",
  snow_fox: "A fox in its white winter coat.",
  patrol_captain: "The illager carrying the banner.",
  trident_drowned: "Only some drowned ever carry a trident.",
};
const vlook = (v: DexVariant): DexLook => VLOOK[v.id] ?? { id: v.mob };
const JUKE_TOP = blockTex("block/jukebox_top");
const advFrame = (a: DexAdv) => blockTex(`gui/sprites/advancements/${a.frame}_frame_${a.unlocked ? "obtained" : "unobtained"}`);
const TAMEABLE = ["wolf", "cat", "parrot", "horse", "donkey", "mule", "llama", "camel", "fox", "allay", "skeleton_horse", "nautilus"];

const kindOf = (key: string): Kind =>
  key.startsWith("mob:")
    ? "mobs"
    : key.startsWith("death:")
      ? "deaths"
      : key.startsWith("biome:")
        ? "biomes"
        : key.startsWith("pet")
          ? "pets"
          : key.startsWith("adv:")
            ? "advancements"
            : key.startsWith("disc:")
              ? "discs"
              : key.startsWith("variant:")
                ? "variants"
                : key.startsWith("ench:")
                  ? "enchants"
                  : key.startsWith("trim:")
                    ? "trims"
                    : key.startsWith("item:")
                      ? "items"
                      : "blocks";
const safe = (k: string) => k.replace(/[^A-Za-z0-9_-]/g, "_");
const groupName = (g: string | null | undefined) => GROUP_NAME[g ?? ""] ?? prettyId(g || "other");

function deathIcon(id: string): string {
  const s = id.replace(/^death\./, "");
  const M: [RegExp, string][] = [
    [/anvil/, "anvil"],
    [/witherSkull/, "nether_star"],
    [/arrow/, "arrow"],
    [/badRespawn/, "respawn_anchor"],
    [/cactus/, "cactus"],
    [/cramming/, "minecart"],
    [/dragonBreath/, "dragon_breath"],
    [/drown/, "water_bucket"],
    [/dryout/, "axolotl_bucket"],
    [/fireworks/, "firework_rocket"],
    [/fireball/, "fire_charge"],
    [/explosion/, "tnt"],
    [/fallingStalactite|stalagmite/, "pointed_dripstone"],
    [/fallingBlock/, "gravel"],
    [/flyIntoWall/, "elytra"],
    [/freeze/, "powder_snow_bucket"],
    [/outsideBorder/, "compass"],
    [/generic|outOfWorld/, "ender_eye"],
    [/hotFloor/, "magma_block"],
    [/inFire/, "campfire"],
    [/onFire/, "blaze_powder"],
    [/inWall/, "sand"],
    [/indirectMagic|attack\.magic/, "splash_potion"],
    [/lava/, "lava_bucket"],
    [/lightning/, "lightning_rod"],
    [/mace/, "mace"],
    [/sonic_boom/, "sculk_shrieker"],
    [/spear/, "iron_spear"],
    [/starve/, "rotten_flesh"],
    [/sting/, "honeycomb"],
    [/sulfurCube/, "magma_cream"],
    [/sweetBerry/, "sweet_berries"],
    [/thorns/, "rose_bush"],
    [/thrown/, "snowball"],
    [/trident/, "trident"],
    [/wither/, "wither_rose"],
    [/attack\.mob/, "iron_sword"],
    [/ladder/, "ladder"],
    [/scaffolding/, "scaffolding"],
    [/twisting/, "twisting_vines"],
    [/weeping/, "weeping_vines"],
    [/vines|other_climbable/, "vine"],
    [/fell|fall/, "feather"],
  ];
  for (const [re, item] of M) if (re.test(s)) return "minecraft:" + item;
  return "minecraft:bone";
}

/** If an icon can't be drawn, show a bone instead (once). */
const iconFallback = (ev: React.SyntheticEvent<HTMLImageElement>) => {
  const img = ev.currentTarget;
  if (img.dataset.fb) return;
  img.dataset.fb = "1";
  img.src = iconxUrl("minecraft:bone", 128);
};

function entryTitle(e: DexEntry, kind: Kind) {
  if (kind === "pets") {
    const p = e as DexPet;
    return p.name || (p.unlocked ? `Your ${p.species.toLowerCase()}` : p.species);
  }
  return e.name;
}

function entrySub(e: DexEntry, kind: Kind): string {
  if (!e.unlocked) {
    if (kind === "pets") return "Not befriended yet";
    if (kind === "advancements") {
      const a = e as DexAdv;
      return a.need > 1 && a.got > 0 ? `${a.got} / ${a.need}` : a.hidden ? "Secret" : "Not earned yet";
    }
    return "Not discovered";
  }
  switch (kind) {
    case "variants": {
      const v = e as DexVariant;
      return v.how === "tamed" ? "One of yours" : v.seen_times > 1 ? `Spotted ×${v.seen_times}` : "Spotted";
    }
    case "advancements": {
      const a = e as DexAdv;
      return a.first?.day != null && !a.before ? `${FRAME_NAME[a.frame]} · ${dayStr(a.first.day)}` : `${FRAME_NAME[a.frame]} earned`;
    }
    case "discs":
      return (e as DexDisc).artist || "Music Disc";
    case "mobs": {
      const m = e as DexMob;
      if (m.tamed) return `Tamed ×${m.tamed}`;
      if (m.killed) return `Defeated ×${fmtNum(m.killed)}`;
      if (m.killed_by) return `Got you ×${m.killed_by}`;
      return "Spotted nearby";
    }
    case "deaths": {
      const d = e as DexDeath;
      return `×${d.count}${d.last?.day != null ? " · " + dayStr(d.last.day) : ""}`;
    }
    case "biomes": {
      const b = e as DexBiome;
      if (b.first?.day != null) return `Found ${dayStr(b.first.day)}`;
      return b.spot ? `${b.spot.minutes} min here` : "Visited";
    }
    case "pets": {
      const p = e as DexPet;
      if (!p.alive) return p.gone?.day != null ? `Lost ${dayStr(p.gone.day)}` : "Gone";
      return p.kind === "tamed" ? (p.sitting ? "Sitting at home" : "Alive and well") : prettyId(p.kind);
    }
    case "items": {
      const it = e as DexItem;
      const best = ([["Picked up", it.picked], ["Crafted", it.crafted], ["Used", it.used], ["Broken", it.broken]] as [string, number][]).sort((a, z) => z[1] - a[1])[0];
      return best[1] > 0 ? `${best[0]} ${fmtCompact2(best[1])}` : it.have ? "In your storage" : "Held before";
    }
    case "enchants": {
      const en = e as DexEnchant;
      return en.copies > 0 ? `${en.copies} owned now` : "Owned before";
    }
    case "trims": {
      const t = e as DexTrim;
      return t.have ? "In your storage" : "Owned before";
    }
    case "blocks": {
      const b = e as DexBlock;
      const best = ([["Mined", b.mined], ["Placed", b.placed], ["Crafted", b.crafted], ["Picked up", b.picked]] as [string, number][]).sort((a, z) => z[1] - a[1])[0];
      return best[1] > 0 ? `${best[0]} ${fmtCompact2(best[1])}` : "Collected";
    }
  }
}
function fmtCompact2(n: number) {
  return n >= 10000 ? (n / 1000).toFixed(n >= 1e5 ? 0 : 1) + "k" : fmtNum(n);
}

function petLook(p: DexPet): MobLook {
  return { id: p.id, variant: p.variant, collar: p.collar, baby: p.baby, tamed: true };
}

let cached: { path: string; data: DexData } | null = null;
let introShown = false;
const countNew = (d: DexData) =>
  [...d.mobs, ...d.deaths, ...d.biomes, ...d.pets, ...d.blocks, ...(d.advancements ?? []), ...(d.discs ?? []), ...(d.variants ?? []), ...(d.items ?? []), ...(d.enchants ?? []), ...(d.trims ?? [])].filter((e) => e.new).length +
  (d.plaques ?? []).reduce((a, p) => a + p.tiers.filter((t) => t.new).length, 0);

/** Background refresh used by the app for the sidebar badge (also remembers a pending intro). */
export async function refreshDexBadge() {
  const w = useStore.getState().world;
  if (!w) return;
  try {
    const d = await api.dex();
    cached = { path: w.path, data: d };
    useStore.setState({ dexNew: countNew(d), dexIntro: !introShown && (useStore.getState().dexIntro || d.intro) });
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ art

function MobArt({ look, fallback }: { look: DexLook; fallback?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const can = canModel(look.id);
  useEffect(() => {
    if (!can) return;
    let alive = true;
    mobPortrait(look).then((u) => {
      if (!alive) return;
      if (u) setUrl(u);
      else setBad(true);
    });
    return () => {
      alive = false;
    };
  }, [look.id, look.variant, look.collar, look.baby, look.color, look.charged, look.rider?.id]);
  if (url) return <img className="art-mob" src={url} alt="" draggable={false} />;
  if (!can || bad) return <img className="art-egg px" src={iconxUrl(fallback ?? look.id + "_spawn_egg", 128)} alt="" draggable={false} />;
  return <div className="art-wait" />;
}

function useBiomePlate(b: DexBiome | null, enabled: boolean) {
  const worldId = useStore((s) => s.world?.id ?? "");
  const dim = useStore((s) => s.dim);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!b || !enabled || !b.unlocked || !b.spot) return;
    let alive = true;
    const key = `biome-${b.id}`;
    const cachedUrl = plateUrl(`plate/${worldId}/${safe(key)}.jpg`);
    const img = new Image();
    img.onload = () => alive && setUrl(cachedUrl);
    img.onerror = () => {
      if (!alive || !b.spot || b.spot.dim !== dim || useStore.getState().capsule) return;
      enqueueRender(async () => {
        if (!alive || !b.spot) return;
        const [x, y, z] = b.spot.pos;
        const data = await Engine.get().capturePlace(x, y, z, { width: 420, height: 420, style: "render", type: "jpeg", dayTime: 2600, dist: 30, angle: 0.9, radius: 5 });
        const rel = await api.savePlate(key, data);
        if (alive) setUrl(plateUrl(rel) + "?t=" + Date.now());
      });
    };
    img.src = cachedUrl;
    return () => {
      alive = false;
    };
  }, [b?.id, b?.unlocked, enabled, worldId, dim]);
  return url;
}

const SKY: Record<string, [string, string]> = {
  nether: ["#3a0d0b", "#8a2a16"],
  end: ["#0b0816", "#2c2148"],
  cave: ["#07090c", "#1b2027"],
  water: ["#163a6b", "#3f7fd0"],
  snowy: ["#8fb3d9", "#e3eef8"],
  desert: ["#d68a4a", "#f2cf8b"],
  jungle: ["#2b6a43", "#8fd4a0"],
  swamp: ["#3a4630", "#7e9070"],
  rare: ["#5b3a6b", "#c9a0d9"],
};

function BiomeArt({ b, live = true }: { b: DexBiome; live?: boolean }) {
  const plate = useBiomePlate(b, live);
  const [s0, s1] = SKY[b.group] ?? ["#3d6fb3", "#a9cdf0"];
  const tex = blockTex(b.tex);
  const face: CSSProperties = { backgroundImage: `url(${tex})`, backgroundColor: b.tint || undefined };
  return (
    <div className="art-biome" style={{ background: `linear-gradient(180deg, ${s0}, ${s1})` }}>
      <div className="bi-cube">
        <div className="f top px" style={face} />
        <div className="f left px" style={face} />
        <div className="f right px" style={face} />
      </div>
      <AnimatePresence>{plate && <motion.img key={plate} className="bi-plate" src={plate} alt="" initial={{ opacity: 0, scale: 1.08 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.9 }} />}</AnimatePresence>
    </div>
  );
}

function CardArt({ e, kind, live = true }: { e: DexEntry; kind: Kind; live?: boolean }) {
  switch (kind) {
    case "mobs":
      return <MobArt look={{ id: e.id }} />;
    case "pets":
      return <MobArt look={petLook(e as DexPet)} />;
    case "enchants": {
      const en = e as DexEnchant;
      return (
        <div className={`art-ench g-${en.group}${en.curse ? " curse" : ""}`}>
          <div className="ae-glow" />
          <img className="px" src={iconxUrl("minecraft:enchanted_book", 128)} alt="" draggable={false} loading="lazy" />
          {en.max > 1 && <span className="ae-lvl">{ROMAN[en.level] ?? en.level}</span>}
        </div>
      );
    }
    case "trims":
      return <TrimArt t={e as DexTrim} />;
    case "items":
    case "blocks":
      return (
        <div className="art-block">
          <img className="px" src={iconxUrl(e.id, 128)} alt="" draggable={false} loading="lazy" onError={iconFallback} />
        </div>
      );
    case "deaths":
      return (
        <div className="art-death">
          <img className="skull px" src={iconxUrl("minecraft:bone", 128)} alt="" draggable={false} />
          <img className="cause px" src={iconxUrl(deathIcon(e.id), 128)} alt="" draggable={false} onError={iconFallback} />
        </div>
      );
    case "biomes":
      return <BiomeArt b={e as DexBiome} live={live} />;
    case "variants": {
      const v = e as DexVariant;
      const L = VLOOK[v.id];
      return (
        <>
          <MobArt look={vlook(v)} fallback={v.mob + "_spawn_egg"} />
          {L?.badge && <img className="art-badge px" src={iconxUrl(L.badge, 64)} alt="" draggable={false} />}
        </>
      );
    }
    case "advancements": {
      const a = e as DexAdv;
      return (
        <div className={`art-adv g-${a.group} f-${a.frame}`}>
          <div className="aa-rays" />
          <div className="aa-frame px" style={{ backgroundImage: `url(${advFrame(a)})` }}>
            <img className="px" src={iconxUrl("minecraft:" + a.icon, 64)} alt="" draggable={false} loading="lazy" onError={iconFallback} />
          </div>
        </div>
      );
    }
    case "discs":
      return <DiscArt d={e as DexDisc} jukeTop={JUKE_TOP} />;
  }
}

// ------------------------------------------------------------------ enchants + trims

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
/** The armour drawn under a trim: light armour for dark trim materials, dark armour for the rest. */
const trimArmor = (m: string) => (["netherite", "lapis", "redstone", "resin", "amethyst"].includes(m) ? "iron" : "netherite");

function TrimArt({ t }: { t: DexTrim }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    trimFront(t.pattern, t.material, trimArmor(t.material))
      .then((u) => live && setSrc(u))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [t.pattern, t.material]);
  return (
    <div className="art-trim" style={{ "--trim": t.color } as CSSProperties}>
      <div className="at-glow" />
      {src ? <img className="px at-fig" src={src} alt="" draggable={false} /> : <img className="px at-tpl" src={iconxUrl(t.id, 64)} alt="" draggable={false} />}
      <img className="px at-badge" src={iconxUrl(t.id, 32)} alt="" draggable={false} />
    </div>
  );
}

/** A slowly turning armour stand wearing the full set with this trim. */
function TrimStand({ t }: { t: DexTrim }) {
  const el = useRef<HTMLDivElement>(null);
  const armor = trimArmor(t.material);
  useEffect(() => {
    if (!el.current) return;
    const v = new SkinViewer(el.current);
    v.camera.position.set(0, 18, 66);
    v.camera.lookAt(0, 15, 0);
    const tr: [string, string] = [t.pattern, t.material];
    v.loadStand()
      .then(() =>
        v.setGear({
          head: `minecraft:${armor}_helmet`,
          chest: `minecraft:${armor}_chestplate`,
          legs: `minecraft:${armor}_leggings`,
          feet: `minecraft:${armor}_boots`,
          trims: { head: tr, chest: tr, legs: tr, feet: tr },
        }),
      )
      .catch(() => {});
    return () => v.dispose();
  }, [t.pattern, t.material, armor]);
  return <div className="trim-stand" ref={el} />;
}

function TrimInfo({ t }: { t: DexTrim }) {
  return (
    <>
      <TrimStand t={t} />
      <div className="ins-stats">
        <Stat label="Pattern" value={t.pattern_name} sub={<img className="px ins-ico" src={iconxUrl(t.id, 32)} alt="" />} />
        <Stat label="Material" value={t.material_name} sub={<i className="ins-swatch" style={{ background: t.color }} />} />
      </div>
      <div className="ins-quote">
        <div className="q">Drag the stand to turn it. Shown on {trimArmor(t.material)} armour.</div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ bits

function Pips({ r }: { r: Rarity }) {
  const n = RANK[r] + 1;
  return (
    <span className="pips" title={prettyId(r)}>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

function Ring({ value, max, size = 46, stroke = 4, color = "var(--accent)", children }: { value: number; max: number; size?: number; stroke?: number; color?: string; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const f = max ? Math.min(1, value / max) : 0;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} fill="none" />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - f) }}
          transition={{ duration: 1.3, ease: [0.2, 0.7, 0.2, 1] }}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {children && <div className="ring-in">{children}</div>}
    </div>
  );
}

/** Particles + shockwave in the rarity's colour. */
function Burst({ rarity, big = false }: { rarity: Rarity; big?: boolean }) {
  const rank = RANK[rarity];
  const n = (big ? 18 : 10) + rank * (big ? 8 : 5);
  const parts = useMemo(
    () =>
      Array.from({ length: n }, (_, i) => ({
        a: (i / n) * 360 + Math.random() * 20,
        d: (big ? 150 : 80) + Math.random() * (big ? 160 : 70) + rank * 18,
        s: 3 + Math.random() * (big ? 7 : 4),
        t: 0.55 + Math.random() * 0.5,
      })),
    [n],
  );
  return (
    <div className={"burst" + (big ? " big" : "")} style={{ "--c": RCOLOR[rarity] } as CSSProperties}>
      <span className="shock" />
      {rank >= 3 && <span className="shock two" />}
      {parts.map((p, i) => (
        <span key={i} className="pt" style={{ "--a": `${p.a}deg`, "--d": `${p.d}px`, "--s": `${p.s}px`, "--t": `${p.t}s` } as CSSProperties} />
      ))}
    </div>
  );
}


// ------------------------------------------------------------------ the card

interface CardProps {
  e: DexEntry;
  kind: Kind;
  n: number;
  i: number;
  compact?: boolean;
  big?: boolean;
  /** no entrance animation / no click */
  still?: boolean;
  /** replaces the art area (the live 3D stage in the inspector) */
  art?: ReactNode;
  onOpen?: (e: DexEntry, rect: DOMRect) => void;
  onFlip?: (e: DexEntry) => void;
}

function tiltHandlers(ref: React.RefObject<HTMLDivElement | null>, rank: number, unlocked: boolean, strength = 1) {
  return {
    onPointerMove: (ev: React.PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const px = (ev.clientX - r.left) / r.width,
        py = (ev.clientY - r.top) / r.height;
      el.style.setProperty("--px", `${(px * 100).toFixed(1)}%`);
      el.style.setProperty("--py", `${(py * 100).toFixed(1)}%`);
      el.style.setProperty("--rx", `${((0.5 - py) * 20 * strength).toFixed(2)}deg`);
      el.style.setProperty("--ry", `${((px - 0.5) * 24 * strength).toFixed(2)}deg`);
      el.style.setProperty("--hyp", `${Math.min(1, Math.hypot(px - 0.5, py - 0.5) * 1.7).toFixed(3)}`);
    },
    onPointerEnter: () => {
      ref.current?.classList.add("hov");
      if (unlocked && rank >= 3) sfx.sparkle();
      else sfx.hover();
    },
    onPointerLeave: () => {
      const el = ref.current;
      if (!el) return;
      el.classList.remove("hov");
      el.style.setProperty("--rx", "0deg");
      el.style.setProperty("--ry", "0deg");
      el.style.setProperty("--px", "50%");
      el.style.setProperty("--py", "50%");
      el.style.setProperty("--hyp", "0");
    },
  };
}

const HoloCard = memo(function HoloCard({ e, kind, n, i, compact, big, still, art, onOpen, onFlip }: CardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const rank = RANK[e.rarity];
  const locked = !e.unlocked;
  const wasNew = useRef(e.new);
  const [justFlipped, setJustFlipped] = useState(false);
  useEffect(() => {
    if (wasNew.current && !e.new) {
      setJustFlipped(true);
      const t = setTimeout(() => setJustFlipped(false), 1400);
      wasNew.current = false;
      return () => clearTimeout(t);
    }
    wasNew.current = e.new;
  }, [e.new]);
  const lv = cardLevel(e, kind);
  const cls = ["holo", `r-${e.rarity}`, `k-${kind}`, lv?.tier ? `lv-${lv.tier}` : "", locked ? "locked" : "", e.new ? "facedown" : "", compact ? "compact" : "", big ? "big" : "", still ? "still" : "", justFlipped ? "flipin" : "", kind === "pets" && !(e as DexPet).alive && e.unlocked ? "gone" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      ref={ref}
      className={cls}
      style={{ "--i": Math.min(i, 36), "--rc": RCOLOR[e.rarity] } as CSSProperties}
      {...tiltHandlers(ref, rank, !locked, big ? 0.6 : 1)}
      onClick={() => {
        if (!ref.current || still) return;
        if (e.new && onFlip) onFlip(e);
        else onOpen?.(e, ref.current.getBoundingClientRect());
      }}
    >
      <div className="holo-in">
        {e.new ? (
          <CardBack rarity={e.rarity} />
        ) : (
          <div className="holo-face">
            <div className="hf-top">
              <span className="hf-num">{n > 0 ? "#" + String(n).padStart(kind === "blocks" ? 4 : 3, "0") : TABS[kind].label}</span>
              <span className="hf-tr">
                {lv && <LevelBadge tier={lv.tier} size={compact ? 7 : 8} />}
                <Pips r={e.rarity} />
              </span>
            </div>
            <div className="hf-art">
              {art ?? <CardArt e={e} kind={kind} live={!compact} />}
              {locked && (
                <div className="hf-lock">
                  <Lock size={compact ? 14 : 18} strokeWidth={2.2} />
                </div>
              )}
            </div>
            <div className="hf-name">{entryTitle(e, kind)}</div>
            <div className="hf-sub">{entrySub(e, kind)}</div>
            <div className="hf-foil" />
            <div className="hf-sparkle" />
            <div className="hf-glare" />
          </div>
        )}
      </div>
      {justFlipped && <Burst rarity={e.rarity} />}
    </div>
  );
});

// ------------------------------------------------------------------ inspector

function MobLive({ look, fallback }: { look: DexLook; fallback: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [ok, setOk] = useState(true);
  useEffect(() => {
    if (!host.current || !canModel(look.id)) {
      setOk(false);
      return;
    }
    const st = new MobStage(host.current);
    st.show(look).then((v) => setOk(v));
    return () => st.dispose();
  }, [look.id, look.variant, look.collar, look.color, look.charged, look.rider?.id]);
  return (
    <>
      <div ref={host} className="live-stage" style={{ display: ok ? "block" : "none" }} />
      {!ok && fallback}
    </>
  );
}

function Diorama({ b }: { b: DexBiome }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el || !b.spot) return;
    const eng = Engine.get();
    const prevR = eng.chunks.radius,
      prevL = eng.lod.range;
    eng.chunks.radius = Math.min(prevR, 7);
    eng.lod.range = 1;
    eng.attach(el);
    eng.setMode("orbit");
    const [x, y, z] = b.spot.pos;
    eng.lookAtPoint(x, y, z, 40);
    eng.orbit.autoRotate = true;
    eng.orbit.autoRotateSpeed = 0.7;
    return () => {
      eng.orbit.autoRotate = false;
      eng.chunks.radius = prevR;
      eng.lod.range = prevL;
      eng.detach(el);
    };
  }, [b.id]);
  return <div ref={host} className="diorama" />;
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="ins-stat">
      <div className="v">{value}</div>
      <div className="l">{label}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

function jumpBlocks(j: number) {
  return -0.1817584952 * j ** 3 + 3.689713992 * j ** 2 + 2.128599134 * j - 0.343930367;
}

function Inspect({ e, kind, n, from, onClose, onNav, hasPrev, hasNext }: { e: DexEntry; kind: Kind; n: number; from: DOMRect | null; onClose: () => void; onNav: (d: number) => void; hasPrev: boolean; hasNext: boolean }) {
  const dim = useStore((s) => s.dim);
  const capsule = useStore((s) => s.capsule);
  const flyTo = useStore((s) => s.flyTo);
  useEffect(() => {
    const k = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
      if (ev.key === "ArrowRight" && hasNext) onNav(1);
      if (ev.key === "ArrowLeft" && hasPrev) onNav(-1);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, onNav, hasNext, hasPrev]);

  // fly out of the grid: start at the clicked card's spot
  const W = 300;
  const init = useMemo(() => {
    if (!from) return { opacity: 0, scale: 0.85, rotateY: -40 };
    const cx = window.innerWidth / 2 - 252,
      cy = window.innerHeight / 2;
    return { x: from.left + from.width / 2 - cx, y: from.top + from.height / 2 - cy, scale: from.width / W, rotateY: -180, opacity: 1 };
  }, [e.key]);

  const locked = !e.unlocked;
  const isMob = kind === "mobs" || kind === "pets" || kind === "variants";
  const look: DexLook = kind === "pets" ? petLook(e as DexPet) : kind === "variants" ? vlook(e as DexVariant) : { id: e.id };
  const lv = cardLevel(e, kind);
  const biome = kind === "biomes" ? (e as DexBiome) : null;
  const canDiorama = !!biome?.spot && biome.spot.dim === dim && !capsule && !locked;
  const art = isMob && !locked ? <MobLive key={e.key} look={look} fallback={<CardArt e={e} kind={kind} />} /> : undefined;

  return (
    <motion.div className="ins-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <div className="ins-rays" style={{ "--rc": RCOLOR[e.rarity] } as CSSProperties} />
      <div className="ins" onClick={(ev) => ev.stopPropagation()}>
        <motion.div className="ins-card" key={e.key} initial={init} animate={{ x: 0, y: 0, scale: 1, rotateY: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 170, damping: 21, mass: 0.9 }}>
          <HoloCard e={e} kind={kind} n={n} i={0} big still art={art} />
        </motion.div>
        <motion.div className="ins-info" key={e.key + "i"} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.18, duration: 0.4, ease: [0.22, 0.7, 0.18, 1] }}>
          <div className="ins-kicker">
            <span className="rar" style={{ color: RCOLOR[e.rarity] }}>
              <Pips r={e.rarity} /> {prettyId(e.rarity)}
            </span>
            <span>·</span>
            <span>{kind === "pets" ? (e as DexPet).species : kind === "advancements" ? `${groupName(e.group)} · ${FRAME_NAME[(e as DexAdv).frame]}` : groupName(e.group)}</span>
            <span>·</span>
            <span>
              {TABS[kind].label} #{n}
            </span>
          </div>
          <h2>{entryTitle(e, kind)}</h2>
          {locked ? (
            <div className="ins-locked">
              <div className="lk">
                <Lock size={18} />
              </div>
              <div>
                <b>{kind === "advancements" ? "Not earned yet" : "Not discovered yet"}</b>
                <div>{kind === "advancements" && (e as DexAdv).hidden ? "A secret advancement. What it asks for stays hidden until you get it." : kind === "advancements" ? (e as DexAdv).desc : TABS[kind].hint}</div>
                {kind === "advancements" && (e as DexAdv).need > 1 && (
                  <div className="ins-prog">
                    <div className="bar">
                      <motion.i initial={{ width: 0 }} animate={{ width: `${((e as DexAdv).got / (e as DexAdv).need) * 100}%` }} transition={{ delay: 0.3, duration: 0.9 }} />
                    </div>
                    <span>
                      {(e as DexAdv).got} / {(e as DexAdv).need}
                    </span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="ins-first">
                <Sparkles size={13} />
                {e.before || !e.first ? (
                  <span>Discovered before Longevity started keeping track</span>
                ) : (
                  <span>
                    Discovered <b>{dayStr(e.first.day)}</b> · {fmtDate(e.first.t, true)}
                  </span>
                )}
              </div>
              <InfoBody e={e} kind={kind} />
              {lv && <LevelPanel lv={lv} />}
              {biome && biome.spot && (
                <div className="ins-dio">
                  {canDiorama ? <Diorama b={biome} /> : <div className="dio-off">{dimName(biome.spot.dim)}</div>}
                  <div className="dio-cap">
                    <span>
                      Where you spent the most time · {biome.spot.minutes} min · {biome.spot.pos[0]}, {biome.spot.pos[2]}
                    </span>
                    <button
                      className="btn sm"
                      onClick={() => {
                        const s = biome.spot!;
                        onClose();
                        flyTo({ x: s.pos[0], y: s.pos[1], z: s.pos[2], dim: s.dim });
                      }}
                    >
                      <Box /> Open in 3D
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </motion.div>
      </div>
      <button className="ins-x iconbtn" onClick={onClose} aria-label="Close">
        <X />
      </button>
      {hasPrev && (
        <button
          className="ins-nav l"
          onClick={(ev) => {
            ev.stopPropagation();
            onNav(-1);
          }}
        >
          <ArrowLeft />
        </button>
      )}
      {hasNext && (
        <button
          className="ins-nav r"
          onClick={(ev) => {
            ev.stopPropagation();
            onNav(1);
          }}
        >
          <ArrowRight />
        </button>
      )}
    </motion.div>
  );
}

function InfoBody({ e, kind }: { e: DexEntry; kind: Kind }) {
  switch (kind) {
    case "variants": {
      const v = e as DexVariant;
      return (
        <>
          <div className="ins-stats">
            <Stat label="Times spotted" value={<Ticker value={v.seen_times} />} sub={v.how === "tamed" ? "and one of them is yours" : undefined} />
          </div>
          {VFACT[v.id] && (
            <div className="ins-quote">
              <div className="q">{VFACT[v.id]}</div>
            </div>
          )}
        </>
      );
    }
    case "advancements": {
      const a = e as DexAdv;
      return (
        <>
          <div className="ins-quote">
            <div className="q">{a.desc || "A secret advancement."}</div>
            <div className="w">{FRAME_NAME[a.frame]} · {groupName(a.group)}</div>
          </div>
          {a.need > 1 && (
            <div className="ins-stats">
              <Stat label="Criteria" value={<span>{a.need}</span>} sub="all done" />
            </div>
          )}
        </>
      );
    }
    case "discs": {
      const d = e as DexDisc;
      return (
        <>
          <DiscControls d={d} />
          <div className="ins-list">
            <div>
              <span>Artist</span>
              <b>{d.artist || "Unknown"}</b>
            </div>
            <div>
              <span>Length</span>
              <b>
                {Math.floor(d.seconds / 60)}:{String(Math.round(d.seconds % 60)).padStart(2, "0")}
              </b>
            </div>
            <div>
              <span>Played in a jukebox</span>
              <b>×{d.played}</b>
            </div>
            {d.held && (
              <div>
                <span>Right now</span>
                <b>In your stuff</b>
              </div>
            )}
          </div>
        </>
      );
    }
    case "mobs": {
      const m = e as DexMob;
      return (
        <div className="ins-stats">
          <Stat label="Defeated" value={<Ticker value={m.killed} />} />
          <Stat label="Got you" value={<Ticker value={m.killed_by} />} />
          {m.tamed > 0 && <Stat label="Tamed" value={<Ticker value={m.tamed} />} />}
          {m.seen_times > 0 && <Stat label="Times spotted" value={<Ticker value={m.seen_times} />} sub={m.most > 1 ? `up to ${m.most} at once` : undefined} />}
        </div>
      );
    }
    case "deaths": {
      const d = e as DexDeath;
      const killers = Object.entries(d.killers).sort((a, b) => b[1] - a[1]);
      return (
        <>
          <div className="ins-stats">
            <Stat label="Times" value={<Ticker value={d.count} />} />
          </div>
          {d.last && (
            <div className="ins-quote">
              <div className="q">“{d.last.message}”</div>
              <div className="w">
                Last time · {dayStr(d.last.day)} · {fmtDate(d.last.t, true)}
              </div>
            </div>
          )}
          {killers.length > 0 && (
            <div className="ins-list">
              {killers.map(([k, c]) => (
                <div key={k}>
                  <span>{k}</span>
                  <b>×{c}</b>
                </div>
              ))}
            </div>
          )}
        </>
      );
    }
    case "biomes": {
      const b = e as DexBiome;
      return <div className="ins-stats">{b.spot && <Stat label="Minutes in your favourite spot" value={<Ticker value={b.spot.minutes} />} sub={dimName(b.spot.dim)} />}</div>;
    }
    case "pets": {
      const p = e as DexPet;
      return (
        <>
          <div className="ins-stats">
            {p.health != null && (
              <Stat
                label="Health"
                value={
                  <span style={{ fontSize: 15 }}>
                    {fmtNum(p.health, 1)} / {fmtNum(p.max_health ?? 20)}
                  </span>
                }
                sub={<HudRow value={p.health} max={Math.min(40, p.max_health ?? 20)} kind="heart" />}
              />
            )}
            {p.speed != null && <Stat label="Speed" value={<span>{fmtNum(p.speed * 43.17, 1)}</span>} sub="blocks / second" />}
            {p.jump != null && <Stat label="Jump" value={<span>{fmtNum(jumpBlocks(p.jump), 1)}</span>} sub="blocks high" />}
          </div>
          <div className="ins-list">
            {p.variant && (
              <div>
                <span>Variant</span>
                <b>{prettyId(p.variant)}</b>
              </div>
            )}
            {p.collar != null && (
              <div>
                <span>Collar</span>
                <b>
                  <i className="swatch" style={{ background: DYE_HEX[p.collar] ?? "#b02e26" }} /> {prettyId(DYE[p.collar] ?? "red")}
                </b>
              </div>
            )}
            <div>
              <span>Status</span>
              <b>{p.alive ? (p.sitting ? "Sitting, waiting for you" : "Alive and well") : p.gone_reason || "Gone"}</b>
            </div>
            {p.alive && p.pos && p.dim && (
              <div>
                <span>Last seen</span>
                <b>
                  {dimName(p.dim)} · {Math.round(p.pos[0])}, {Math.round(p.pos[2])}
                </b>
              </div>
            )}
            {!p.alive && p.gone && (
              <div>
                <span>Lost</span>
                <b>
                  {dayStr(p.gone.day)} · {fmtDate(p.gone.t)}
                </b>
              </div>
            )}
          </div>
        </>
      );
    }
    case "enchants": {
      const en = e as DexEnchant;
      const table = en.treasure ? "Never from the enchanting table: find it in loot, trades or fishing." : en.curse ? "A curse. It only shows up on loot and trades." : en.weight >= 10 ? "One of the most common enchants at the table." : en.weight >= 5 ? "Shows up at the table fairly often." : en.weight >= 2 ? "Rare at the enchanting table." : "Very rare at the enchanting table.";
      return (
        <>
          <div className="ins-stats">
            <Stat label="Level" value={`${ROMAN[en.level] ?? en.level} of ${ROMAN[en.max] ?? en.max}`} sub={en.level === en.max && en.max > 1 ? "the max" : undefined} />
            <Stat label="Owned right now" value={<Ticker value={en.copies} />} sub={en.copies === 1 ? "item or book" : "items and books"} />
          </div>
          <div className="ins-quote">
            <div className="q">{table}</div>
          </div>
        </>
      );
    }
    case "trims":
      return <TrimInfo t={e as DexTrim} />;
    case "items": {
      const it = e as DexItem;
      const rows: [string, number][] = [
        ["Picked up", it.picked],
        ["Crafted", it.crafted],
        ["Used", it.used],
        ["Broken", it.broken],
      ];
      const max = Math.max(1, ...rows.map((r) => r[1]));
      return (
        <>
          {it.have && <div className="ins-tag">In your storage right now</div>}
          <div className="ins-bars">
            {rows.map(([l, v], i) => (
              <div key={l}>
                <span>{l}</span>
                <div className="bar">
                  <motion.i initial={{ width: 0 }} animate={{ width: `${(v / max) * 100}%` }} transition={{ delay: 0.25 + i * 0.07, duration: 0.8, ease: [0.2, 0.7, 0.2, 1] }} />
                </div>
                <b>{fmtNum(v)}</b>
              </div>
            ))}
          </div>
        </>
      );
    }
    case "blocks": {
      const b = e as DexBlock;
      const rows: [string, number][] = [
        ["Mined", b.mined],
        ["Placed", b.placed],
        ["Crafted", b.crafted],
        ["Picked up", b.picked],
      ];
      const max = Math.max(1, ...rows.map((r) => r[1]));
      return (
        <div className="ins-bars">
          {rows.map(([l, v], i) => (
            <div key={l}>
              <span>{l}</span>
              <div className="bar">
                <motion.i initial={{ width: 0 }} animate={{ width: `${(v / max) * 100}%` }} transition={{ delay: 0.25 + i * 0.07, duration: 0.8, ease: [0.2, 0.7, 0.2, 1] }} />
              </div>
              <b>{fmtNum(v)}</b>
            </div>
          ))}
        </div>
      );
    }
  }
}
const DYE = ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"];
const DYE_HEX = ["#f9fffe", "#f9801d", "#c74ebd", "#3ab3da", "#fed83d", "#80c71f", "#f38baa", "#474f52", "#9d9d97", "#169c9c", "#8932b8", "#3c44aa", "#835432", "#5e7c16", "#b02e26", "#1d1d21"];

// ------------------------------------------------------------------ pack opening

const PACK_MAX = 10;

function Pack({ cards, nums, onDone }: { cards: DexEntry[]; nums: Map<string, number>; onDone: (keys: string[]) => void }) {
  // weakest first so the best card is the last one turned over
  const sorted = useMemo(() => [...cards].sort((a, b) => RANK[a.rarity] - RANK[b.rarity]), [cards]);
  const shown = sorted.length > PACK_MAX ? sorted.slice(sorted.length - PACK_MAX + 1) : sorted;
  const extra = sorted.length > PACK_MAX ? sorted.slice(0, sorted.length - PACK_MAX + 1) : [];
  const best = sorted[sorted.length - 1]?.rarity ?? "common";
  const [stage, setStage] = useState<"pack" | "tear" | "deal" | "open">("pack");
  const [dealt, setDealt] = useState(0);
  const [flipped, setFlipped] = useState<Set<number>>(new Set());
  const flippedRef = useRef<Set<number>>(new Set());
  const [shake, setShake] = useState(0);
  const [flash, setFlash] = useState(0);
  const [slow, setSlow] = useState<number | null>(null);
  const tilt = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const total = shown.length + (extra.length ? 1 : 0);
  const done = flipped.size >= total;
  const rankAt = (i: number) => (i < shown.length ? RANK[shown[i].rarity] : 1);

  // the pack leans toward the mouse, and the foil shine follows it
  const onMove = (e: { clientX: number; clientY: number; currentTarget: HTMLDivElement }) => {
    const el = tilt.current;
    if (!el || stage !== "pack") return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.style.setProperty("--rx", `${(-y * 24).toFixed(2)}deg`);
    el.style.setProperty("--ry", `${(x * 30).toFixed(2)}deg`);
    el.style.setProperty("--sx", `${((x + 0.5) * 100).toFixed(1)}%`);
  };
  const onLeave = () => {
    const el = tilt.current;
    if (!el) return;
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--ry", "0deg");
    el.style.setProperty("--sx", "50%");
  };

  const open = () => {
    if (stage !== "pack") return;
    onLeave();
    setStage("tear");
    sfx.rumble();
    later(() => sfx.tear(), 620);
    later(() => {
      setFlash((f) => f + 1);
      setStage("deal");
    }, 1250);
  };
  // cards come out of the pack one at a time
  useEffect(() => {
    if (stage !== "deal") return;
    if (dealt >= total) {
      const t = window.setTimeout(() => setStage("open"), 650);
      return () => clearTimeout(t);
    }
    const t = window.setTimeout(() => {
      sfx.flip();
      setDealt((d) => d + 1);
    }, dealt === 0 ? 120 : 210);
    return () => clearTimeout(t);
  }, [stage, dealt, total]);

  /** Turn card i over. Epic and legendary cards go slow-motion, then flash. Returns how long it takes. */
  const flip = (i: number) => {
    if (flippedRef.current.has(i) || i >= dealt) return 0;
    flippedRef.current.add(i);
    const rank = rankAt(i);
    const isSlow = rank >= 3;
    if (isSlow) {
      setSlow(i);
      sfx.rumble();
    }
    sfx.flip();
    later(
      () => {
        sfx.reveal(rank);
        if (isSlow) {
          setFlash((f) => f + 1);
          setShake((s) => s + 1);
        } else if (rank >= 2) setShake((s) => s + 1);
      },
      isSlow ? 1000 : 120,
    );
    if (isSlow) later(() => setSlow((s) => (s === i ? null : s)), 2100);
    setFlipped((f) => new Set(f).add(i));
    return isSlow ? 2100 : 0;
  };
  const flipAll = () => {
    let d = 0;
    for (let i = 0; i < total; i++)
      if (!flippedRef.current.has(i)) {
        const idx = i;
        later(() => flip(idx), d);
        d += 240 + (rankAt(idx) >= 3 ? 2000 : 0);
      }
  };

  // grid layout
  const cols = Math.min(5, total);
  const rows = Math.ceil(total / cols);
  const cw = 168,
    ch = 236,
    gap = 18,
    gapY = 46;
  const W = cols * cw + (cols - 1) * gap;
  const H = Math.max(rows * ch + (rows - 1) * gapY, 380);
  // where cards leave the pack: its top edge, in the middle
  const outX = W / 2 - cw / 2;
  const outY = H / 2 - 170 - ch * 0.25;

  return (
    <motion.div className={"pack-back" + (slow !== null ? " slowmo" : "")} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.3 } }}>
      <div className="pack-rays" style={{ "--rc": RCOLOR[best] } as CSSProperties} />
      {flash > 0 && <motion.div key={"fl" + flash} className="pack-flash" initial={{ opacity: 0.95 }} animate={{ opacity: 0 }} transition={{ duration: 1.1, ease: "easeOut" }} />}
      <motion.div className="pack-stage" key={shake} animate={shake ? { x: [0, -10, 9, -7, 5, -2, 0], y: [0, 4, -5, 3, -2, 0] } : {}} transition={{ duration: 0.5 }}>
        <div className="pack-cards" style={{ width: W, height: H }}>
          <AnimatePresence>
            {(stage === "pack" || stage === "tear" || (stage === "deal" && dealt < total)) && (
              <motion.div
                className="pack3d-wrap"
                style={{ left: W / 2 - 120, top: H / 2 - 170 }}
                initial={{ y: 140, opacity: 0, scale: 0.85 }}
                animate={{ y: stage === "deal" ? 30 : 0, opacity: 1, scale: 1 }}
                exit={{ y: 320, opacity: 0, rotate: 8, transition: { duration: 0.55, ease: [0.5, 0, 0.75, 0] } }}
                transition={{ type: "spring", stiffness: 110, damping: 15 }}
                onPointerMove={onMove}
                onPointerLeave={onLeave}
                onClick={open}
                onMouseEnter={() => sfx.hover()}
              >
                <div ref={tilt} className={"pack3d s-" + stage} style={{ "--rc": RCOLOR[best] } as CSSProperties}>
                  <div className="p3-shake">
                    <div className="p3-body">
                      <div className="p3-face front">
                        <div className="p3-foil" />
                        <div className="p3-sheen" />
                        <div className="pack-label">
                          <div className="pl-k">Longevity</div>
                          <div className="pl-t">Dex Pack</div>
                          <div className="pl-n">
                            {cards.length} new card{cards.length === 1 ? "" : "s"}
                          </div>
                        </div>
                        <div className="pack-hint">{stage === "pack" ? "Click to tear it open" : ""}</div>
                      </div>
                      <div className="p3-face back" />
                      <div className="p3-side l" />
                      <div className="p3-side r" />
                      <div className="p3-crimp bottom" />
                      <div className="p3-leak" />
                    </div>
                    <div className="p3-top">
                      <div className="p3-crimp" />
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {Array.from({ length: total }, (_, i) => {
            if (i >= dealt) return null;
            const c = i < shown.length ? shown[i] : null;
            const col = i % cols,
              row = Math.floor(i / cols);
            const tx = col * (cw + gap),
              ty = row * (ch + gapY) + (H - (rows * ch + (rows - 1) * gapY)) / 2;
            const isF = flipped.has(i);
            const kind = c ? kindOf(c.key) : "blocks";
            const isSlow = slow === i;
            const spin = ((i * 37) % 13) - 6;
            return (
              <motion.div
                key={i}
                className={"pack-card" + (isF ? " up" : "") + (isSlow ? " slow" : "") + (c && RANK[c.rarity] >= 3 ? " hot" : "")}
                style={{ width: cw, height: ch, zIndex: isSlow ? 40 : 10 + i, "--rc": c ? RCOLOR[c.rarity] : RCOLOR.uncommon } as CSSProperties}
                initial={{ x: outX, y: outY + 120, scale: 0.5, rotate: 0, opacity: 0 }}
                animate={{ x: [outX, outX, tx], y: [outY + 120, outY - 60, ty], scale: [0.5, 0.8, isSlow ? 1.16 : 1], rotate: [0, spin, 0], opacity: [0, 1, 1] }}
                transition={{ duration: 0.75, times: [0, 0.35, 1], ease: [0.25, 0.7, 0.3, 1] }}
                onClick={() => flip(i)}
              >
                <div className="pc-flip">
                  <div className="pc-side back">
                    <CardBack />
                  </div>
                  <div className="pc-side front">
                    {c ? (
                      <HoloCard e={{ ...c, new: false } as DexEntry} kind={kind} n={nums.get(c.key) ?? 0} i={0} still />
                    ) : (
                      <div className="pack-more">
                        <b>+{extra.length}</b>
                        <span>more cards</span>
                        <div className="pm-icons">
                          {extra.slice(-6).map((x) => (
                            <img key={x.key} className="px" src={kindOf(x.key) === "blocks" || kindOf(x.key) === "items" ? iconxUrl(x.id, 64) : iconxUrl(TABS[kindOf(x.key)].icon, 64)} alt="" />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                {isSlow && <div className="pc-charge" />}
                {isF && !isSlow && c && RANK[c.rarity] >= 1 && <Burst rarity={c.rarity} big={RANK[c.rarity] >= 3} />}
                {isF && !isSlow && c && RANK[c.rarity] >= 2 && (
                  <motion.div className="pc-tag" initial={{ y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.35 }}>
                    {prettyId(c.rarity)}!
                  </motion.div>
                )}
              </motion.div>
            );
          })}
        </div>
        <motion.div className="pack-actions" initial={{ opacity: 0, y: 10 }} animate={stage === "open" ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }} transition={{ delay: 0.2 }} style={{ pointerEvents: stage === "open" ? "auto" : "none" }}>
          {!done ? (
            <>
              <span className="dim">Click the cards to turn them over</span>
              <button className="btn" onClick={flipAll}>
                <Sparkles /> Reveal all
              </button>
            </>
          ) : (
            <button
              className="btn primary big"
              onClick={() => {
                sfx.chime();
                onDone(cards.map((c) => c.key));
              }}
            >
              Add to the Dex
            </button>
          )}
        </motion.div>
      </motion.div>
    </motion.div>
  );
}

// ------------------------------------------------------------------ first-time intro

function Intro({ data, onDone }: { data: DexData; onDone: () => void }) {
  const rows = KINDS.map((k) => {
    const list = k === "pets" ? data.pets.map((p) => ({ ...p, unlocked: true })) : (data[k] as DexEntry[]);
    const total = k === "pets" ? Math.max(list.length, 1) : list.length;
    return { k, have: list.filter((e) => e.unlocked).length, total };
  });
  const best = useMemo(
    () =>
      KINDS.flatMap((k) => (data[k] as DexEntry[]).filter((e) => e.unlocked).map((e) => ({ e, k })))
        .sort((a, b) => RANK[b.e.rarity] - RANK[a.e.rarity] || (a.k === "blocks" ? 1 : 0) - (b.k === "blocks" ? 1 : 0))
        .slice(0, 5),
    [data],
  );
  useEffect(() => {
    sfx.open();
    const t = setTimeout(() => sfx.chime(), 1700);
    return () => clearTimeout(t);
  }, []);
  return (
    <motion.div className="intro-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.4 } }}>
      <div className="pack-rays" style={{ "--rc": "var(--accent)" } as CSSProperties} />
      <div className="intro">
        <motion.div className="intro-k" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          Welcome to the Dex
        </motion.div>
        <motion.h1 initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.25, type: "spring", stiffness: 160, damping: 16 }}>
          Your collection so far
        </motion.h1>
        <div className="intro-rows">
          {rows.map((r, i) => (
            <motion.div key={r.k} className="intro-row" initial={{ opacity: 0, x: -30 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.5 + i * 0.18, duration: 0.5, ease: [0.22, 0.7, 0.18, 1] }}>
              <img className="px" src={iconxUrl(TABS[r.k].icon, 64)} alt="" />
              <span className="n">{TABS[r.k].label}</span>
              <div className="bar">
                <motion.i initial={{ width: 0 }} animate={{ width: `${(r.have / r.total) * 100}%` }} transition={{ delay: 0.7 + i * 0.18, duration: 1.1, ease: [0.2, 0.7, 0.2, 1] }} />
              </div>
              <span className="c">
                <Ticker value={r.have} duration={1.4} />
                {r.k !== "pets" && <em> / {r.total.toLocaleString()}</em>}
              </span>
            </motion.div>
          ))}
        </div>
        {best.length > 0 && (
          <div className="intro-best">
            {best.map(({ e, k }, i) => (
              <motion.div
                key={e.key}
                initial={{ y: 120, opacity: 0, rotate: (i - 2) * 14 }}
                animate={{ y: Math.abs(i - 2) * 12, opacity: 1, rotate: (i - 2) * 7 }}
                transition={{ delay: 1.6 + i * 0.12, type: "spring", stiffness: 120, damping: 14 }}
              >
                <HoloCard e={e} kind={k} n={0} i={0} still />
              </motion.div>
            ))}
          </div>
        )}
        <motion.button className="btn primary big" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 2.4 }} onClick={onDone}>
          Open the Dex
        </motion.button>
      </div>
    </motion.div>
  );
}

// ------------------------------------------------------------------ page

type Sort = "dex" | "rarity" | "recent";
const LS = "atlas.dex.ui";
function loadUi(): { tab: Tab; showLocked: boolean; sort: Sort } {
  try {
    const v = JSON.parse(localStorage.getItem(LS) || "{}");
    return { tab: TAB_ORDER.includes(v.tab) ? v.tab : "mobs", showLocked: v.showLocked !== false, sort: ["dex", "rarity", "recent"].includes(v.sort) ? v.sort : "dex" };
  } catch {
    return { tab: "mobs", showLocked: true, sort: "dex" };
  }
}

/** Keeps a bug in one card from blanking the whole app. */
class DexBoundary extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { err: String(e) };
  }
  componentDidCatch(e: unknown) {
    console.error("Dex crashed", e);
  }
  render() {
    if (this.state.err)
      return (
        <div className="page-pad dex">
          <div className="dex-loading">
            <span>Something went wrong drawing the Dex.</span>
            <span style={{ fontSize: 11, color: "var(--text-4)" }}>{this.state.err}</span>
            <button className="btn" onClick={() => this.setState({ err: null })}>
              Try again
            </button>
          </div>
        </div>
      );
    return this.props.children;
  }
}

export default function Dex() {
  return (
    <DexBoundary>
      <DexPage />
    </DexBoundary>
  );
}

function DexPage() {
  const world = useStore((s) => s.world)!;
  const [data, setData] = useState<DexData | null>(cached?.path === world.path ? cached.data : null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const ui0 = useMemo(loadUi, []);
  const [tab, setTab] = useState<Tab>(ui0.tab);
  const [back, setBack] = useState(loadBack);
  const [celebrate, setCelebrate] = useState<SetState[]>([]);
  const [news, setNews] = useState(() => !newsSeen());
  const dexOpen = useStore((s) => s.dexOpen);
  const dexReload = useStore((s) => s.dexReload);
  const pendingOpen = useRef<{ key: string; n: number } | null>(null);
  const [showLocked, setShowLocked] = useState(ui0.showLocked);
  const [sort, setSort] = useState<Sort>(ui0.sort);
  const [group, setGroup] = useState("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<{ key: string; from: DOMRect | null } | null>(null);
  const [pack, setPack] = useState<DexEntry[] | null>(null);
  const [intro, setIntro] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(LS, JSON.stringify({ tab, showLocked, sort }));
    } catch {
      /* private mode */
    }
  }, [tab, showLocked, sort]);

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.dex();
      cached = { path: world.path, data: d };
      setData(d);
      setErr(null);
      const pending = useStore.getState().dexIntro;
      useStore.setState({ dexNew: countNew(d), dexIntro: false });
      if ((d.intro || pending) && !introShown) {
        introShown = true;
        setIntro(true);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, [world.path]);

  const reveal = async (keys: string[]) => {
    const ks = new Set(keys);
    setData((d) => {
      if (!d) return d;
      const f = <T extends { key: string; new: boolean }>(l: T[]) => (l ?? []).map((e) => (ks.has(e.key) ? { ...e, new: false } : e));
      const nd = {
        ...d,
        mobs: f(d.mobs),
        deaths: f(d.deaths),
        biomes: f(d.biomes),
        pets: f(d.pets),
        blocks: f(d.blocks),
        advancements: f(d.advancements),
        discs: f(d.discs),
        variants: f(d.variants),
        items: d.items && f(d.items),
        enchants: d.enchants && f(d.enchants),
        trims: d.trims && f(d.trims),
        plaques: (d.plaques ?? []).map((p) => ({ ...p, tiers: f(p.tiers) })),
      };
      cached = { path: world.path, data: nd };
      useStore.setState({ dexNew: countNew(nd) });
      return nd;
    });
    await api.dexReveal(keys).catch(() => {});
  };

  // the per-kind lists (pets gets the species you haven't befriended yet as locked cards)
  const lists = useMemo(() => {
    if (!data) return null;
    const have = new Set(data.pets.map((p) => p.id.replace("minecraft:", "")));
    const missing: DexPet[] = TAMEABLE.filter((s) => !have.has(s)).map((s) => ({
      key: `pet-species:${s}`,
      id: "minecraft:" + s,
      name: prettyId(s),
      species: prettyId(s),
      group: "befriend",
      rarity: (data.mobs.find((m) => m.id === "minecraft:" + s)?.rarity ?? "common") as Rarity,
      unlocked: false,
      first: null,
      before: false,
      new: false,
      uuid: "",
      variant: null,
      collar: null,
      baby: false,
      alive: false,
      gone: null,
      gone_reason: null,
      health: null,
      max_health: null,
      speed: null,
      jump: null,
      sitting: false,
      pos: null,
      dim: null,
      kind: "",
    }));
    const pets = [...data.pets.map((p) => ({ ...p, unlocked: true, group: "yours", name: p.name ?? "" })).sort((a, b) => Number(b.alive) - Number(a.alive) || (a.first?.t ?? 0) - (b.first?.t ?? 0)), ...missing];
    return {
      mobs: data.mobs,
      deaths: data.deaths,
      biomes: data.biomes,
      pets,
      blocks: data.blocks,
      advancements: data.advancements ?? [],
      discs: data.discs ?? [],
      variants: data.variants ?? [],
      items: data.items ?? [],
      enchants: data.enchants ?? [],
      trims: data.trims ?? [],
    } as Record<Kind, DexEntry[]>;
  }, [data]);

  const nums = useMemo(() => {
    const m = new Map<string, number>();
    if (lists) for (const k of KINDS) lists[k].forEach((e, i) => m.set(e.key, i + 1));
    return m;
  }, [lists]);

  const kindTab: Kind = KINDS.includes(tab as Kind) ? (tab as Kind) : "mobs";
  const isCards = KINDS.includes(tab as Kind);
  const list = lists?.[kindTab] ?? [];
  const sets = useMemo(() => (lists ? setStates(lists) : []), [lists]);
  // a set finished (and its last card turned over) since last time: celebrate it
  useEffect(() => {
    if (!sets.length || pack || intro) return;
    const seen = loadSetsSeen();
    const fresh = sets.filter((s) => s.done && !seen.has(s.def.id));
    if (fresh.length) setCelebrate(fresh);
  }, [sets, pack, intro]);
  const iconFor = (m: SetMember, kind: Kind): string | null => {
    switch (kind) {
      case "mobs":
        return iconxUrl(m.id + "_spawn_egg", 32);
      case "pets":
        return iconxUrl(m.id + "_spawn_egg", 32);
      case "blocks":
      case "items":
      case "discs":
      case "trims":
        return iconxUrl(m.id, 32);
      case "enchants":
        return iconxUrl("minecraft:enchanted_book", 32);
      case "advancements":
        return m.e ? iconxUrl("minecraft:" + (m.e as DexAdv).icon, 32) : null;
      case "variants":
        return m.e ? iconxUrl((m.e as DexVariant).mob + "_spawn_egg", 32) : null;
      case "deaths":
        return iconxUrl(deathIcon(m.id), 32);
      case "biomes":
        return m.e ? blockTex((m.e as DexBiome).tex) : null;
    }
  };
  const groups = useMemo(() => {
    const g = new Map<string, [number, number]>();
    for (const e of list) {
      const c = g.get(e.group) ?? [0, 0];
      c[1]++;
      if (e.unlocked) c[0]++;
      g.set(e.group, c);
    }
    const order = GROUP_ORDER[kindTab];
    return [...g.entries()].sort((a, b) => (order.indexOf(a[0]) + 99) % 99 - ((order.indexOf(b[0]) + 99) % 99));
  }, [list, kindTab]);

  const shown = useMemo(() => {
    const qq = q.trim().toLowerCase();
    let l = list.filter((e) => (showLocked || e.unlocked) && (group === "all" || e.group === group) && (!qq || entryTitle(e, kindTab).toLowerCase().includes(qq) || e.id.includes(qq)));
    if (sort === "rarity") l = [...l].sort((a, b) => RANK[b.rarity] - RANK[a.rarity] || Number(b.unlocked) - Number(a.unlocked));
    if (sort === "recent") l = [...l].sort((a, b) => Number(b.unlocked) - Number(a.unlocked) || (b.first?.t ?? (b.before ? 1 : 0)) - (a.first?.t ?? (a.before ? 1 : 0)));
    return l;
  }, [list, showLocked, group, q, sort, kindTab]);

  const allNew = useMemo(() => (lists ? KINDS.flatMap((k) => lists[k].filter((e) => e.new)) : []), [lists]);
  const total = lists ? KINDS.filter((k) => k !== "pets").reduce((a, k) => a + lists[k].length, 0) : 0;
  const have = lists ? KINDS.filter((k) => k !== "pets").reduce((a, k) => a + lists[k].filter((e) => e.unlocked).length, 0) : 0;
  const selIdx = sel ? shown.findIndex((e) => e.key === sel.key) : -1;
  const selE = selIdx >= 0 ? shown[selIdx] : sel && lists ? KINDS.flatMap((k) => lists[k]).find((e) => e.key === sel.key) : null;

  const switchTab = (k: Tab) => {
    if (k === tab) return;
    sfx.nav();
    setTab(k);
    setGroup("all");
    setQ("");
  };

  // the in-game companion: alt-tabbing back after it saw something, and its "open Atlas" key
  useEffect(() => {
    if (dexReload && data) load();
  }, [dexReload]);
  useEffect(() => {
    if (!dexOpen) return;
    pendingOpen.current = dexOpen;
    if (data) load();
  }, [dexOpen?.n]);
  useEffect(() => {
    const p = pendingOpen.current;
    if (!p || !lists || loading) return;
    pendingOpen.current = null;
    if (p.key.startsWith("plaque:")) {
      switchTab("plaques");
      return;
    }
    const e = KINDS.flatMap((k) => lists[k]).find((x) => x.key === p.key);
    if (!e) return;
    if (e.new) {
      // still face down: open the pack instead of spoiling it in the inspector
      setPack(allNew);
      return;
    }
    switchTab(kindOf(p.key));
    setSel({ key: p.key, from: null });
  }, [lists, loading]);

  if (!data || !lists) {
    return (
      <div className="page-pad dex">
        <div className="dex-loading">
          {err ? (
            <span>{err}</span>
          ) : (
            <>
              <div className="dl-cards">
                {[0, 1, 2].map((i) => (
                  <div key={i} style={{ "--i": i } as CSSProperties}>
                    <CardBack />
                  </div>
                ))}
              </div>
              <span>Sorting your collection…</span>
            </>
          )}
        </div>
      </div>
    );
  }

  const stats = (k: Tab) => {
    if (k === "plaques") {
      const ts = (data.plaques ?? []).flatMap((p) => p.tiers);
      return { have: ts.filter((t) => t.unlocked).length, total: ts.length, fresh: ts.filter((t) => t.new).length };
    }
    if (k === "sets") return { have: sets.filter((s) => s.done).length, total: sets.length, fresh: 0 };
    const l = lists[k];
    return { have: l.filter((e) => e.unlocked).length, total: l.length, fresh: l.filter((e) => e.new).length };
  };

  return (
    <BackCtx.Provider value={back}>
    <div className="page-pad dex">
      <div className="page-head dex-head">
        <div>
          <div className="kicker">Collection</div>
          <h1>The Dex</h1>
          <div className="lede">Everything you've met, found, befriended and been killed by in {world.name || world.folder}. Missing cards stay locked, and none of them will tell you where to look.</div>
        </div>
        <div className="actions">
          <button className="iconbtn" title="Refresh" onClick={() => (sfx.click(), load())}>
            {loading ? <Spinner size={14} /> : <RefreshCw />}
          </button>
          <Ring value={have} max={total} size={74} stroke={6}>
            <b>{Math.floor((have / Math.max(1, total)) * 100)}%</b>
            <span>
              {have}/{total}
            </span>
          </Ring>
        </div>
      </div>

      <AnimatePresence>
        {news && (
          <WhatsNew
            data={data}
            onClose={() => setNews(false)}
            onGo={(t) => {
              switchTab(t);
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {allNew.length > 0 && (
          <motion.button
            className="dex-packbar"
            initial={{ opacity: 0, y: -10, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            onClick={() => {
              sfx.open();
              setPack(allNew);
            }}
            style={{ "--rc": RCOLOR[allNew.reduce((b, e) => (RANK[e.rarity] > RANK[b] ? e.rarity : b), "common" as Rarity)] } as CSSProperties}
          >
            <div className="pb-pack">
              <PackageOpen size={20} />
            </div>
            <div className="pb-text">
              <b>
                {allNew.length} new card{allNew.length === 1 ? "" : "s"} to open
              </b>
              <span>{[...new Set(allNew.map((e) => TABS[kindOf(e.key)].label))].join(" · ")}</span>
            </div>
            <span className="pb-go">Open pack</span>
          </motion.button>
        )}
      </AnimatePresence>

      <div className="dex-tabs">
        {TAB_ORDER.map((k) => {
          const s = stats(k);
          const nn = s.fresh;
          return (
            <button key={k} className={"dex-tab" + (tab === k ? " on" : "")} onClick={() => switchTab(k)} onMouseEnter={() => sfx.hover()}>
              {tab === k && <motion.div layoutId="dextab" className="dt-bg" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
              <img className="px" src={iconxUrl(TABS[k].icon, 64)} alt="" />
              <div className="dt-meta">
                <span className="dt-l">{TABS[k].label}</span>
                <span className="dt-c">{k === "pets" ? `${data.pets.length} companion${data.pets.length === 1 ? "" : "s"}` : k === "sets" ? `${s.have} of ${s.total} done` : `${s.have} / ${s.total.toLocaleString()}`}</span>
              </div>
              {k !== "pets" && <Ring value={s.have} max={s.total} size={26} stroke={3} />}
              {nn > 0 && <span className="dt-new">{nn}</span>}
            </button>
          );
        })}
      </div>

      {isCards && (
      <>
      <div className="dex-bar">
        <div className="dex-groups">
          <button className={"chip" + (group === "all" ? " on" : "")} onClick={() => (sfx.click(), setGroup("all"))}>
            All
          </button>
          {groups.map(([g, [h, t]]) => (
            <button key={g} className={"chip" + (group === g ? " on" : "")} onClick={() => (sfx.click(), setGroup(g))}>
              {groupName(g)} <em>{kindTab === "pets" ? h : `${h}/${t}`}</em>
            </button>
          ))}
        </div>
        <div className="dex-tools">
          <label className="dex-search">
            <Search size={13} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${TABS[kindTab].noun}`} />
          </label>
          <div className="seg">
            {(["dex", "rarity", "recent"] as Sort[]).map((s) => (
              <button key={s} className={sort === s ? "on" : ""} onClick={() => (sfx.click(), setSort(s))}>
                {s === "dex" ? "#" : s === "rarity" ? "Rarity" : "Newest"}
              </button>
            ))}
          </div>
          <button className={"btn sm ghost" + (showLocked ? " on" : "")} onClick={() => (sfx.toggle(!showLocked), setShowLocked(!showLocked))} title="Show the ones you haven't found yet">
            {showLocked ? <Eye /> : <EyeOff />} Missing
          </button>
        </div>
      </div>
      <SetStrip kind={kindTab} sets={sets} onOpen={() => switchTab("sets")} />

      {tab === "deaths" && (
        <div className="dex-note">
          {data.deaths_total > 0 ? (
            <>
              <b>{data.deaths_total}</b> death{data.deaths_total === 1 ? "" : "s"} so far, in <b>{stats("deaths").have}</b> different way{stats("deaths").have === 1 ? "" : "s"}.
            </>
          ) : (
            "Not a single death yet. Impressive."
          )}
        </div>
      )}

      <div className={"dex-grid" + (kindTab === "blocks" || kindTab === "items" ? " compact" : "")} key={tab + group + sort + (showLocked ? 1 : 0)}>
        {shown.map((e, i) => (
          <HoloCard
            key={e.key}
            e={e}
            kind={kindTab}
            n={nums.get(e.key) ?? 0}
            i={i}
            compact={kindTab === "blocks" || kindTab === "items"}
            onOpen={(x, rect) => {
              sfx.open();
              setSel({ key: x.key, from: rect });
            }}
            onFlip={(x) => {
              sfx.flip();
              setTimeout(() => sfx.reveal(RANK[x.rarity]), 100);
              reveal([x.key]);
            }}
          />
        ))}
        {shown.length === 0 && <div className="dex-empty">{q ? "Nothing matches that." : showLocked ? "Nothing here." : "None found yet. Turn on Missing to see what's out there."}</div>}
      </div>
      </>
      )}

      {tab === "plaques" && <PlaquesView key="plaques" plaques={data.plaques ?? []} onSeen={(keys) => reveal(keys)} />}
      {tab === "sets" && (
        <SetsView
          sets={sets}
          back={back}
          onBack={(id) => {
            setBack(id);
            saveBack(id);
          }}
          iconFor={iconFor}
          kindLabel={(k) => TABS[k].label}
        />
      )}

      <AnimatePresence>
        {selE && (
          <Inspect
            key="ins"
            e={selE}
            kind={kindOf(selE.key)}
            n={nums.get(selE.key) ?? 0}
            from={sel?.from ?? null}
            onClose={() => {
              sfx.close();
              setSel(null);
            }}
            hasPrev={selIdx > 0}
            hasNext={selIdx >= 0 && selIdx < shown.length - 1}
            onNav={(d) => {
              const nx = shown[selIdx + d];
              if (!nx) return;
              sfx.flip();
              if (nx.new) reveal([nx.key]);
              setSel({ key: nx.key, from: null });
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {pack && (
          <Pack
            key="pack"
            cards={pack}
            nums={nums}
            onDone={(keys) => {
              setPack(null);
              reveal(keys);
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {intro && (
          <Intro
            key="intro"
            data={data}
            onDone={() => {
              sfx.click();
              setIntro(false);
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {!intro && !pack && celebrate.length > 0 && (
          <SetCelebration
            key={celebrate[0].def.id}
            s={celebrate[0]}
            onUse={() => {
              const s = celebrate[0];
              markSetSeen(s.def.id);
              setBack(s.def.back);
              saveBack(s.def.back);
              sfx.chime();
              setCelebrate((c) => c.slice(1));
            }}
            onClose={() => {
              markSetSeen(celebrate[0].def.id);
              sfx.close();
              setCelebrate((c) => c.slice(1));
            }}
          />
        )}
      </AnimatePresence>
    </div>
    </BackCtx.Provider>
  );
}
void BACKS;
