// The Dex's extras: card levels, sets (with card backs to unlock), milestone plaques and the
// music-disc player. Kept apart from Dex.tsx so the main page stays readable.
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Lock, Pause, Play, Star, X } from "lucide-react";
import { blockTex, discUrl, fmtNum, iconxUrl, prettyId, type DexData, type DexDisc, type DexEntry, type DexPlaque, type DexPlaqueTier, type Rarity } from "../api";
import { sfx } from "../sound";
import { Ticker } from "../ui";

// ------------------------------------------------------------------ shared tables

export type Kind = "mobs" | "variants" | "biomes" | "pets" | "blocks" | "items" | "enchants" | "trims" | "advancements" | "discs" | "deaths";
export type Tab = Kind | "plaques" | "sets";
export const KINDS: Kind[] = ["mobs", "variants", "pets", "biomes", "blocks", "items", "enchants", "trims", "advancements", "discs", "deaths"];
export const TAB_ORDER: Tab[] = [...KINDS, "plaques", "sets"];
export const RANK: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };
export const RCOLOR: Record<Rarity, string> = { common: "#aab3bb", uncommon: "#7fd46e", rare: "#5cb2ff", epic: "#c084ff", legendary: "#ffbf3f" };
export const dayStr = (d: number | null | undefined) => (d == null ? "" : `Day ${Math.floor(d).toLocaleString()}`);

// ------------------------------------------------------------------ card levels (#10)

export type Tier = 0 | 1 | 2 | 3;
export const TIER_NAME = ["Unranked", "Bronze", "Silver", "Gold"];
export const TIER_COLOR = ["#6b7178", "#d08a4f", "#d5dde6", "#ffd45c"];

/* eslint-disable @typescript-eslint/no-explicit-any */
const LEVELS: Partial<Record<Kind, { steps: [number, number, number]; value: (e: any) => number; unit: string }>> = {
  mobs: { steps: [10, 100, 1000], value: (e) => e.killed, unit: "defeated" },
  blocks: { steps: [64, 1000, 10000], value: (e) => e.mined + e.placed + e.crafted, unit: "mined, placed or crafted" },
  deaths: { steps: [3, 10, 30], value: (e) => e.count, unit: "deaths this way" },
  discs: { steps: [3, 10, 50], value: (e) => e.played, unit: "plays in a jukebox" },
  variants: { steps: [5, 25, 100], value: (e) => e.seen_times, unit: "sightings" },
  biomes: { steps: [30, 300, 1500], value: (e) => e.spot?.minutes ?? 0, unit: "minutes in your favourite spot" },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface Level {
  tier: Tier;
  value: number;
  steps: [number, number, number];
  next: number | null;
  unit: string;
}
export function cardLevel(e: DexEntry, kind: Kind): Level | null {
  const L = LEVELS[kind];
  if (!L || !e.unlocked) return null;
  const v = Number(L.value(e)) || 0;
  const tier = (v >= L.steps[2] ? 3 : v >= L.steps[1] ? 2 : v >= L.steps[0] ? 1 : 0) as Tier;
  return { tier, value: v, steps: L.steps, next: tier < 3 ? (L.steps as number[])[tier] : null, unit: L.unit };
}

export function LevelBadge({ tier, size = 9 }: { tier: Tier; size?: number }) {
  if (!tier) return null;
  return (
    <span className={"lv-badge t" + tier} title={TIER_NAME[tier] + " card"}>
      {Array.from({ length: tier }, (_, i) => (
        <Star key={i} size={size} strokeWidth={0} fill="currentColor" />
      ))}
    </span>
  );
}

/** The inspector's "card level" panel. */
export function LevelPanel({ lv }: { lv: Level }) {
  const lo = lv.tier ? lv.steps[lv.tier - 1] : 0;
  const hi = lv.next ?? lv.steps[2];
  const f = lv.next == null ? 1 : Math.max(0, Math.min(1, (lv.value - lo) / Math.max(1, hi - lo)));
  return (
    <div className={"lv-panel t" + lv.tier} style={{ "--mc": TIER_COLOR[lv.tier] } as CSSProperties}>
      <div className="lvp-top">
        <span className="lvp-medal">{lv.tier ? <LevelBadge tier={lv.tier} size={11} /> : <Star size={11} />}</span>
        <b>{lv.tier ? `${TIER_NAME[lv.tier]} card` : "Card level"}</b>
        <span className="lvp-v">
          <Ticker value={lv.value} /> {lv.unit}
        </span>
      </div>
      <div className="lvp-bar">
        <motion.i initial={{ width: 0 }} animate={{ width: `${f * 100}%` }} transition={{ delay: 0.3, duration: 0.9, ease: [0.2, 0.7, 0.2, 1] }} />
      </div>
      <div className="lvp-steps">
        {lv.steps.map((s, i) => (
          <span key={s} className={lv.value >= s ? "on" : ""} style={{ "--mc": TIER_COLOR[i + 1] } as CSSProperties}>
            {TIER_NAME[i + 1]} · {fmtNum(s)}
          </span>
        ))}
      </div>
      <div className="lvp-next">{lv.next == null ? "Maxed out. This card is solid gold." : `${fmtNum(lv.next - lv.value)} more for ${TIER_NAME[lv.tier + 1]}`}</div>
    </div>
  );
}

// ------------------------------------------------------------------ card backs

export interface Back {
  id: string;
  name: string;
  a: string;
  b: string;
  ink: string;
  icon: string;
  pattern: "check" | "stripe" | "dots" | "waves" | "rays" | "rings" | "rainbow";
}
export const BACKS: Back[] = [
  { id: "atlas", name: "Atlas", a: "#1f1a12", b: "#0c0d10", ink: "var(--accent)", icon: "", pattern: "check" },
  { id: "nether", name: "Nether Natives", a: "#3b0d0a", b: "#120506", ink: "#ff6b3d", icon: "minecraft:blaze_powder", pattern: "waves" },
  { id: "ocean", name: "Ocean Dwellers", a: "#06304a", b: "#04121c", ink: "#4fd6e0", icon: "minecraft:heart_of_the_sea", pattern: "waves" },
  { id: "farm", name: "Farmyard", a: "#3a2a12", b: "#140f08", ink: "#e7c46a", icon: "minecraft:wheat", pattern: "check" },
  { id: "undead", name: "The Undead", a: "#1d2a1a", b: "#0a0e09", ink: "#8fcf6a", icon: "minecraft:rotten_flesh", pattern: "dots" },
  { id: "raid", name: "Raid Party", a: "#2a2626", b: "#0d0c0c", ink: "#d9d4c4", icon: "minecraft:ominous_bottle", pattern: "stripe" },
  { id: "boss", name: "Boss Rush", a: "#2a0f3a", b: "#0b0410", ink: "#ff5ad1", icon: "minecraft:nether_star", pattern: "rays" },
  { id: "ores", name: "All the Ores", a: "#22262b", b: "#0b0d0f", ink: "#5ee6ff", icon: "minecraft:diamond", pattern: "dots" },
  { id: "wood", name: "Lumberjack", a: "#3a2614", b: "#120c06", ink: "#d6a35f", icon: "minecraft:oak_sapling", pattern: "stripe" },
  { id: "rainbow", name: "Rainbow", a: "#221b2e", b: "#0c0a10", ink: "#ffffff", icon: "minecraft:white_wool", pattern: "rainbow" },
  { id: "crimson", name: "Nether Tour", a: "#3a0a1e", b: "#10040a", ink: "#ff4f6e", icon: "minecraft:crimson_fungus", pattern: "dots" },
  { id: "frost", name: "Frozen World", a: "#203a52", b: "#0a121a", ink: "#bfe6ff", icon: "minecraft:snowball", pattern: "check" },
  { id: "deep", name: "Seven Seas", a: "#0a1f3a", b: "#040a14", ink: "#5c8dff", icon: "minecraft:nautilus_shell", pattern: "waves" },
  { id: "vinyl", name: "C418 Collection", a: "#1a1a1a", b: "#050505", ink: "#e8e8e8", icon: "minecraft:music_disc_13", pattern: "rings" },
  { id: "gold_vinyl", name: "Gold Record", a: "#3a2c0a", b: "#120d03", ink: "#ffd45c", icon: "minecraft:jukebox", pattern: "rings" },
  { id: "story", name: "The Story", a: "#1f2a1a", b: "#0a0d08", ink: "#a7e07a", icon: "minecraft:grass_block", pattern: "check" },
  { id: "blaze", name: "Nether Conqueror", a: "#3a1a06", b: "#120802", ink: "#ffb03d", icon: "minecraft:blaze_rod", pattern: "rays" },
  { id: "end", name: "The End", a: "#1c1630", b: "#07050d", ink: "#e9e6a6", icon: "minecraft:ender_eye", pattern: "dots" },
  { id: "candy", name: "Colorful", a: "#3a1a30", b: "#10060d", ink: "#ff9bd2", icon: "minecraft:pink_dye", pattern: "dots" },
  { id: "saddle", name: "Riders", a: "#3a2410", b: "#120b05", ink: "#e09a52", icon: "minecraft:saddle", pattern: "stripe" },
  { id: "feather", name: "Clumsy", a: "#2a2a30", b: "#0b0b0e", ink: "#f0f0f0", icon: "minecraft:feather", pattern: "waves" },
  { id: "paw", name: "Pet Lover", a: "#3a1a1a", b: "#120808", ink: "#ff8a8a", icon: "minecraft:bone", pattern: "dots" },
];
export const BackCtx = createContext("atlas");

export function CardBack({ rarity, back }: { rarity?: Rarity; back?: string }) {
  const chosen = useContext(BackCtx);
  const b = BACKS.find((x) => x.id === (back ?? chosen)) ?? BACKS[0];
  const themed = b.id !== "atlas";
  const style: Record<string, string> = {};
  if (rarity) style["--rc"] = RCOLOR[rarity];
  if (themed) Object.assign(style, { "--ba": b.a, "--bb": b.b, "--ink": b.ink });
  return (
    <div className={"holo-back" + (themed ? " themed p-" + b.pattern : "")} style={style as CSSProperties}>
      <div className="hb-pattern" />
      <div className="hb-mark">
        {b.icon ? (
          <img className="px" src={iconxUrl(b.icon, 128)} alt="" draggable={false} />
        ) : (
          <svg viewBox="0 0 16 16" shapeRendering="crispEdges">
            <rect x="7" y="0" width="2" height="16" fill="#3b3125" />
            <rect x="0" y="7" width="16" height="2" fill="#3b3125" />
            <rect x="7" y="1" width="2" height="6" style={{ fill: "var(--accent)" }} />
            <rect x="7" y="9" width="2" height="6" fill="#8b8f94" />
            <rect x="6" y="6" width="4" height="4" fill="#ebe7df" />
            <rect x="7" y="7" width="2" height="2" fill="#0a0c0f" />
          </svg>
        )}
      </div>
      <div className="hb-word">DEX</div>
      <div className="hb-new">NEW</div>
    </div>
  );
}

const BACK_LS = "atlas.dex.back";
export function loadBack(): string {
  try {
    return localStorage.getItem(BACK_LS) || "atlas";
  } catch {
    return "atlas";
  }
}
export function saveBack(id: string) {
  try {
    localStorage.setItem(BACK_LS, id);
  } catch {
    /* private mode */
  }
}

// ------------------------------------------------------------------ sets (#11)

export interface SetDef {
  id: string;
  name: string;
  desc: string;
  kind: Kind;
  icon: string;
  back: string;
  ids?: string[];
  match?: (e: DexEntry) => boolean;
}
const NETHER_BIOMES = ["nether_wastes", "soul_sand_valley", "crimson_forest", "warped_forest", "basalt_deltas"];
const FROZEN = ["snowy_plains", "ice_spikes", "snowy_taiga", "snowy_slopes", "frozen_peaks", "jagged_peaks", "grove", "snowy_beach", "frozen_river", "frozen_ocean", "deep_frozen_ocean"];
export const SETS: SetDef[] = [
  { id: "farmyard", name: "Farmyard", desc: "Every classic farm animal.", kind: "mobs", icon: "minecraft:wheat", back: "farm", ids: ["cow", "pig", "sheep", "chicken", "horse", "donkey", "goat", "rabbit"] },
  { id: "undead", name: "The Undead", desc: "Everything that should have stayed buried.", kind: "mobs", icon: "minecraft:rotten_flesh", back: "undead", ids: ["zombie", "husk", "drowned", "skeleton", "stray", "bogged", "wither_skeleton", "zombie_villager", "phantom", "zombified_piglin", "zoglin", "skeleton_horse", "zombie_horse"] },
  { id: "nether_natives", name: "Nether Natives", desc: "The locals down below.", kind: "mobs", icon: "minecraft:blaze_powder", back: "nether", ids: ["piglin", "hoglin", "zombified_piglin", "ghast", "blaze", "magma_cube", "strider", "wither_skeleton", "piglin_brute"] },
  { id: "ocean", name: "Ocean Dwellers", desc: "Fins, shells and tentacles.", kind: "mobs", icon: "minecraft:heart_of_the_sea", back: "ocean", ids: ["cod", "salmon", "tropical_fish", "pufferfish", "squid", "glow_squid", "dolphin", "turtle", "guardian", "drowned", "axolotl"] },
  { id: "raid", name: "Raid Party", desc: "The whole illager crew.", kind: "mobs", icon: "minecraft:ominous_bottle", back: "raid", ids: ["pillager", "vindicator", "evoker", "ravager", "vex", "witch"] },
  { id: "bosses", name: "Boss Rush", desc: "The four big ones.", kind: "mobs", icon: "minecraft:nether_star", back: "boss", ids: ["ender_dragon", "wither", "warden", "elder_guardian"] },
  { id: "colors", name: "Colorful", desc: "Every rare colour of an ordinary mob.", kind: "variants", icon: "minecraft:pink_dye", back: "candy", match: (e) => e.group === "colors" },
  { id: "riders", name: "Riders", desc: "Every mob riding another mob.", kind: "variants", icon: "minecraft:saddle", back: "saddle", match: (e) => e.group === "riders" },
  { id: "pet_lover", name: "Pet Lover", desc: "A dog, a cat, a parrot and a horse of your own.", kind: "pets", icon: "minecraft:bone", back: "paw", ids: ["wolf", "cat", "parrot", "horse"] },
  { id: "nether_tour", name: "Nether Tour", desc: "Every Nether biome.", kind: "biomes", icon: "minecraft:crimson_fungus", back: "crimson", ids: NETHER_BIOMES },
  { id: "frozen", name: "Frozen World", desc: "Every snowy and icy biome.", kind: "biomes", icon: "minecraft:snowball", back: "frost", ids: FROZEN },
  { id: "seven_seas", name: "Seven Seas", desc: "Every kind of ocean.", kind: "biomes", icon: "minecraft:nautilus_shell", back: "deep", match: (e) => e.id.endsWith("ocean") },
  { id: "ores", name: "All the Ores", desc: "Every ore, plus Ancient Debris.", kind: "blocks", icon: "minecraft:diamond", back: "ores", ids: ["coal_ore", "iron_ore", "copper_ore", "gold_ore", "redstone_ore", "lapis_ore", "diamond_ore", "emerald_ore", "nether_quartz_ore", "nether_gold_ore", "ancient_debris"] },
  { id: "lumberjack", name: "Lumberjack", desc: "A log of every tree, and both Nether stems.", kind: "blocks", icon: "minecraft:oak_sapling", back: "wood", ids: ["oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log", "crimson_stem", "warped_stem"] },
  { id: "rainbow", name: "Rainbow", desc: "All sixteen colours of wool.", kind: "blocks", icon: "minecraft:white_wool", back: "rainbow", match: (e) => /^minecraft:[a-z_]+_wool$/.test(e.id) },
  { id: "story", name: "The Story", desc: "Every Minecraft advancement.", kind: "advancements", icon: "minecraft:grass_block", back: "story", match: (e) => e.group === "story" },
  { id: "nether_adv", name: "Nether Conqueror", desc: "Every Nether advancement.", kind: "advancements", icon: "minecraft:blaze_rod", back: "blaze", match: (e) => e.group === "nether" },
  { id: "end_adv", name: "The End", desc: "Every End advancement.", kind: "advancements", icon: "minecraft:ender_eye", back: "end", match: (e) => e.group === "end" },
  { id: "c418", name: "C418 Collection", desc: "Every disc by C418.", kind: "discs", icon: "minecraft:music_disc_13", back: "vinyl", match: (e) => e.group === "c418" },
  { id: "jukebox", name: "Gold Record", desc: "Every music disc there is.", kind: "discs", icon: "minecraft:jukebox", back: "gold_vinyl", match: () => true },
  { id: "clumsy", name: "Clumsy", desc: "Every way to fall to your death.", kind: "deaths", icon: "minecraft:feather", back: "feather", match: (e) => e.group === "fall" },
];

export interface SetMember {
  key: string;
  id: string;
  name: string;
  have: boolean;
  e: DexEntry | null;
}
export interface SetState {
  def: SetDef;
  members: SetMember[];
  have: number;
  done: boolean;
}
/** A member counts once its card is turned face up (so a set never completes before the pack is opened). */
export function setStates(lists: Record<Kind, DexEntry[]>): SetState[] {
  return SETS.map((def) => {
    const list = lists[def.kind] ?? [];
    let members: SetMember[];
    if (def.ids) {
      members = def.ids.flatMap((s) => {
        const id = "minecraft:" + s;
        const es = list.filter((e) => e.id === id);
        if (!es.length && def.kind !== "pets") return [];
        const got = es.find((e) => e.unlocked && !e.new);
        return [{ key: def.id + ":" + id, id, name: def.kind === "pets" ? prettyId(s) : (es[0]?.name ?? prettyId(s)), have: !!got, e: got ?? es[0] ?? null }];
      });
    } else {
      members = list.filter((e) => def.match!(e)).map((e) => ({ key: e.key, id: e.id, name: e.name, have: e.unlocked && !e.new, e }));
    }
    const have = members.filter((m) => m.have).length;
    return { def, members, have, done: members.length > 0 && have === members.length };
  }).filter((s) => s.members.length > 0);
}

const SEEN_LS = "atlas.dex.sets";
export function loadSetsSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_LS) || "[]"));
  } catch {
    return new Set();
  }
}
export function markSetSeen(id: string) {
  const s = loadSetsSeen();
  s.add(id);
  try {
    localStorage.setItem(SEEN_LS, JSON.stringify([...s]));
  } catch {
    /* private mode */
  }
}

function Medal({ s, size = 64, iconFor }: { s: SetState; size?: number; iconFor: (m: SetMember, kind: Kind) => string | null }) {
  void iconFor;
  const f = s.members.length ? s.have / s.members.length : 0;
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const back = BACKS.find((b) => b.id === s.def.back);
  return (
    <div className={"medal" + (s.done ? " done" : "")} style={{ width: size, height: size, "--ink": back?.ink ?? "var(--accent)" } as CSSProperties}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.08)" strokeWidth={4} fill="none" />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="var(--ink)"
          strokeWidth={4}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - f) }}
          transition={{ duration: 1.2, ease: [0.2, 0.7, 0.2, 1] }}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="medal-in">
        <img className="px" src={iconxUrl(s.def.icon, 64)} alt="" draggable={false} />
      </div>
      {s.done && (
        <span className="medal-check">
          <Check size={11} strokeWidth={3} />
        </span>
      )}
    </div>
  );
}

/** Little set chips under the tab bar: progress at a glance; clicking opens the Sets tab. */
export function SetStrip({ kind, sets, onOpen }: { kind: Kind; sets: SetState[]; onOpen: () => void }) {
  const mine = sets.filter((s) => s.def.kind === kind);
  if (!mine.length) return null;
  return (
    <div className="set-strip">
      <span className="ss-k">Sets</span>
      {mine.map((s) => (
        <button key={s.def.id} className={"ss-chip" + (s.done ? " done" : "")} onClick={() => (sfx.click(), onOpen())} onMouseEnter={() => sfx.hover()}>
          <img className="px" src={iconxUrl(s.def.icon, 32)} alt="" />
          <span>{s.def.name}</span>
          <em>
            {s.have}/{s.members.length}
          </em>
          <i style={{ width: `${(s.have / s.members.length) * 100}%` }} />
        </button>
      ))}
    </div>
  );
}

export function SetsView({ sets, back, onBack, iconFor, kindLabel }: { sets: SetState[]; back: string; onBack: (id: string) => void; iconFor: (m: SetMember, kind: Kind) => string | null; kindLabel: (k: Kind) => string }) {
  const unlocked = new Set(["atlas", ...sets.filter((s) => s.done).map((s) => s.def.back)]);
  const done = sets.filter((s) => s.done).length;
  return (
    <div className="sets">
      <div className="sets-backs">
        <div className="sb-head">
          <b>Card backs</b>
          <span>
            {unlocked.size} of {BACKS.length} unlocked · finish a set to earn its back
          </span>
        </div>
        <div className="sb-row">
          {BACKS.map((b, i) => {
            const on = unlocked.has(b.id);
            return (
              <motion.button
                key={b.id}
                className={"sb-card" + (back === b.id ? " sel" : "") + (on ? "" : " locked")}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.025 }}
                onClick={() => {
                  if (!on) return;
                  sfx.flip();
                  onBack(b.id);
                }}
                onMouseEnter={() => sfx.hover()}
                title={on ? b.name : `Finish the ${b.name} set to unlock`}
              >
                <div className="sb-face">
                  <CardBack back={b.id} />
                  {!on && (
                    <div className="sb-lock">
                      <Lock size={14} />
                    </div>
                  )}
                </div>
                <span>{b.name}</span>
                {back === b.id && <motion.div layoutId="sbsel" className="sb-sel" />}
              </motion.button>
            );
          })}
        </div>
      </div>
      <div className="sets-sum">
        <Ticker value={done} /> of {sets.length} sets complete
      </div>
      <div className="sets-grid">
        {sets.map((s, i) => (
          <motion.div key={s.def.id} className={"set-card" + (s.done ? " done" : "")} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 + i * 0.03, duration: 0.45, ease: [0.22, 0.7, 0.18, 1] }} style={{ "--ink": BACKS.find((b) => b.id === s.def.back)?.ink } as CSSProperties}>
            <div className="sc-top">
              <Medal s={s} iconFor={iconFor} />
              <div className="sc-meta">
                <span className="sc-k">{kindLabel(s.def.kind)}</span>
                <b>{s.def.name}</b>
                <span className="sc-d">{s.def.desc}</span>
              </div>
              <div className="sc-n">
                {s.have}
                <em>/{s.members.length}</em>
              </div>
            </div>
            <div className="sc-members">
              {s.members.map((m) => {
                const ic = iconFor(m, s.def.kind);
                return (
                  <span key={m.key} className={"scm" + (m.have ? " on" : "")} title={m.name}>
                    {ic ? <img className="px" src={ic} alt="" loading="lazy" /> : <i>{m.name.slice(0, 1)}</i>}
                  </span>
                );
              })}
            </div>
            <div className="sc-foot">
              <span>Reward: {BACKS.find((b) => b.id === s.def.back)?.name} card back</span>
              {s.done && back !== s.def.back && (
                <button className="btn sm" onClick={() => (sfx.flip(), onBack(s.def.back))}>
                  Use it
                </button>
              )}
              {s.done && back === s.def.back && <span className="sc-using">In use</span>}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

/** Full-screen "set complete" moment, with the new card back flipping in. */
export function SetCelebration({ s, onUse, onClose }: { s: SetState; onUse: () => void; onClose: () => void }) {
  const back = BACKS.find((b) => b.id === s.def.back) ?? BACKS[0];
  useEffect(() => {
    sfx.open();
    const t1 = setTimeout(() => sfx.reveal(4), 450);
    const t2 = setTimeout(() => sfx.flip(), 1300);
    const k = (ev: KeyboardEvent) => ev.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener("keydown", k);
    };
  }, []);
  const parts = useMemo(() => Array.from({ length: 34 }, (_, i) => ({ a: (i / 34) * 360 + Math.random() * 10, d: 170 + Math.random() * 190, s: 4 + Math.random() * 7, t: 0.7 + Math.random() * 0.6 })), []);
  return (
    <motion.div className="setc-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.3 } }} onClick={onClose}>
      <div className="pack-rays" style={{ "--rc": back.ink } as CSSProperties} />
      <div className="setc" onClick={(e) => e.stopPropagation()} style={{ "--ink": back.ink } as CSSProperties}>
        <motion.div className="setc-k" initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          Set complete
        </motion.div>
        <motion.div className="setc-medal" initial={{ scale: 0, rotate: -200 }} animate={{ scale: 1, rotate: 0 }} transition={{ delay: 0.3, type: "spring", stiffness: 140, damping: 12 }}>
          <div className="burst big" style={{ "--c": back.ink } as CSSProperties}>
            <span className="shock" />
            <span className="shock two" />
            {parts.map((p, i) => (
              <span key={i} className="pt" style={{ "--a": `${p.a}deg`, "--d": `${p.d}px`, "--s": `${p.s}px`, "--t": `${p.t}s` } as CSSProperties} />
            ))}
          </div>
          <div className="setc-hex">
            <img className="px" src={iconxUrl(s.def.icon, 128)} alt="" />
          </div>
        </motion.div>
        <motion.h1 initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.6, type: "spring", stiffness: 160, damping: 16 }}>
          {s.def.name}
        </motion.h1>
        <motion.div className="setc-d" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.8 }}>
          {s.def.desc} All {s.members.length} collected.
        </motion.div>
        <div className="setc-reward">
          <motion.div className="setc-card" initial={{ rotateY: 180, y: 30, opacity: 0 }} animate={{ rotateY: 0, y: 0, opacity: 1 }} transition={{ delay: 1.25, type: "spring", stiffness: 110, damping: 13 }}>
            <CardBack back={back.id} />
          </motion.div>
          <motion.div initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 1.6 }}>
            <span className="setc-rk">New card back</span>
            <b>{back.name}</b>
          </motion.div>
        </div>
        <motion.div className="setc-act" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.9 }}>
          <button className="btn primary big" onClick={onUse}>
            Use this card back
          </button>
          <button className="btn" onClick={onClose}>
            Later
          </button>
        </motion.div>
      </div>
    </motion.div>
  );
}

// ------------------------------------------------------------------ milestone plaques (#20)

const METALS = ["bronze", "silver", "gold", "diamond", "netherite"];
const fmtBig = (n: number) => (n >= 1e6 ? `${n / 1e6}M` : n >= 1e4 ? `${n / 1e3}k` : n.toLocaleString());
const plaqueTitle = (p: DexPlaque, n: number) => (n === 1 ? `First ${p.one}` : `${fmtBig(n)} ${p.many}`);

function Plaque({ p, t, i, next }: { p: DexPlaque; t: DexPlaqueTier; i: number; next: boolean }) {
  const stampIt = useRef(t.new && t.unlocked).current;
  const metal = METALS[Math.min(i, METALS.length - 1)];
  const prev = i > 0 ? p.tiers[i - 1].n : 0;
  const f = Math.max(0, Math.min(1, (p.value - prev) / Math.max(1, t.n - prev)));
  useEffect(() => {
    if (!stampIt) return;
    const tm = setTimeout(() => sfx.reveal(Math.min(4, i + 1)), 380 + i * 160);
    return () => clearTimeout(tm);
  }, []);
  return (
    <motion.div
      className={"plaque m-" + metal + (t.unlocked ? " on" : "") + (next ? " next" : "")}
      initial={stampIt ? { scale: 1.7, rotate: -8, opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ scale: 1, rotate: 0, opacity: 1, y: 0 }}
      transition={stampIt ? { delay: 0.3 + i * 0.16, type: "spring", stiffness: 260, damping: 15 } : { delay: i * 0.04, duration: 0.35 }}
      onMouseEnter={() => t.unlocked && sfx.hover()}
    >
      <i className="bolt a" />
      <i className="bolt b" />
      <i className="bolt c" />
      <i className="bolt d" />
      <div className="pq-n">{fmtBig(t.n)}</div>
      <div className="pq-t">{t.n === 1 ? `First ${p.one}` : p.many}</div>
      <div className="pq-when">{t.unlocked ? (t.before || !t.first ? "Before tracking" : dayStr(t.first.day)) : next ? `${Math.floor(f * 100)}%` : "Locked"}</div>
      {next && !t.unlocked && (
        <div className="pq-bar">
          <motion.i initial={{ width: 0 }} animate={{ width: `${f * 100}%` }} transition={{ delay: 0.4, duration: 0.9 }} />
        </div>
      )}
      {stampIt && <span className="pq-new">NEW</span>}
      <div className="pq-sheen" />
    </motion.div>
  );
}

export function PlaquesView({ plaques, onSeen }: { plaques: DexPlaque[]; onSeen: (keys: string[]) => void }) {
  const total = plaques.reduce((a, p) => a + p.tiers.length, 0);
  const got = plaques.reduce((a, p) => a + p.tiers.filter((t) => t.unlocked).length, 0);
  useEffect(() => {
    const keys = plaques.flatMap((p) => p.tiers.filter((t) => t.new).map((t) => t.key));
    if (!keys.length) return;
    const tm = setTimeout(() => onSeen(keys), 2500);
    return () => clearTimeout(tm);
  }, []);
  return (
    <div className="plaques">
      <div className="pq-sum">
        <b>
          <Ticker value={got} />
        </b>{" "}
        of {total} plaques earned
      </div>
      {plaques.map((p, r) => {
        const nextI = p.tiers.findIndex((t) => !t.unlocked);
        return (
          <motion.div key={p.id} className="pq-row" initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: r * 0.035, duration: 0.4 }}>
            <div className="pq-head">
              <img className="px" src={iconxUrl("minecraft:" + p.icon, 64)} alt="" />
              <div>
                <b>{p.many}</b>
                <span>
                  <Ticker value={p.value} />
                </span>
              </div>
            </div>
            <div className="pq-wall">
              {p.tiers.map((t, i) => (
                <Plaque key={t.key} p={p} t={t} i={i} next={i === nextI} />
              ))}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
export { plaqueTitle };

// ------------------------------------------------------------------ music discs (#5)

interface DiscState {
  song: string | null;
  name: string;
  artist: string;
  icon: string;
  playing: boolean;
  t: number;
  dur: number;
  error: boolean;
}
let ds: DiscState = { song: null, name: "", artist: "", icon: "", playing: false, t: 0, dur: 0, error: false };
const subs = new Set<() => void>();
const set = (p: Partial<DiscState>) => {
  ds = { ...ds, ...p };
  subs.forEach((f) => f());
};
let audio: HTMLAudioElement | null = null;
let fade = 0;

function ramp(to: number, ms: number, then?: () => void) {
  if (!audio) return;
  cancelAnimationFrame(fade);
  const a = audio;
  const from = a.volume;
  const t0 = performance.now();
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    a.volume = from + (to - from) * k;
    if (k < 1) fade = requestAnimationFrame(step);
    else then?.();
  };
  fade = requestAnimationFrame(step);
}

export const discPlayer = {
  play(d: DexDisc) {
    if (ds.song === d.song && audio) {
      if (audio.paused) discPlayer.toggle();
      return;
    }
    discPlayer.stop(true);
    const a = new Audio(discUrl(d.song));
    audio = a;
    a.volume = 0;
    a.addEventListener("timeupdate", () => audio === a && set({ t: a.currentTime, dur: a.duration || d.seconds }));
    a.addEventListener("ended", () => audio === a && discPlayer.stop());
    a.addEventListener("error", () => audio === a && set({ error: true, playing: false }));
    set({ song: d.song, name: d.name, artist: d.artist, icon: d.id, playing: true, t: 0, dur: d.seconds, error: false });
    a.play()
      .then(() => ramp(0.7, 900))
      .catch(() => set({ playing: false, error: true }));
  },
  toggle() {
    if (!audio) return;
    if (audio.paused) {
      audio.play().then(() => ramp(0.7, 400));
      set({ playing: true });
    } else {
      const a = audio;
      ramp(0, 250, () => a.pause());
      set({ playing: false });
    }
  },
  seek(f: number) {
    if (!audio || !isFinite(audio.duration)) return;
    audio.currentTime = f * audio.duration;
  },
  stop(quick = false) {
    const a = audio;
    audio = null;
    if (a) {
      if (quick) a.pause();
      else {
        const from = a.volume;
        const t0 = performance.now();
        const step = () => {
          const k = Math.min(1, (performance.now() - t0) / 300);
          a.volume = from * (1 - k);
          if (k < 1) requestAnimationFrame(step);
          else a.pause();
        };
        requestAnimationFrame(step);
      }
    }
    set({ song: null, playing: false, t: 0, error: false });
  },
};

export function useDisc() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => ds,
  );
}

const mmss = (s: number) => (isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");

// each disc's label colour, read from its own item texture (the label sits in the middle)
const labels = new Map<string, Promise<string>>();
function discLabel(id: string): Promise<string> {
  let p = labels.get(id);
  if (!p) {
    p = new Promise<string>((res) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const g = c.getContext("2d")!;
          g.drawImage(img, 0, 0);
          const s = img.width / 16;
          const px = g.getImageData(0, 0, c.width, c.height).data;
          let best = "#9a9a9a",
            score = -1;
          for (let y = Math.floor(6 * s); y <= Math.floor(10 * s); y++)
            for (let x = Math.floor(4 * s); x <= Math.floor(11 * s); x++) {
              const i = (y * c.width + x) * 4;
              if (px[i + 3] < 128) continue;
              const r = px[i],
                gg = px[i + 1],
                b = px[i + 2];
              const mx = Math.max(r, gg, b),
                mn = Math.min(r, gg, b);
              const sc = (mx ? (mx - mn) / mx : 0) * 0.75 + (mx / 255) * 0.25;
              if (sc > score) {
                score = sc;
                best = `rgb(${r},${gg},${b})`;
              }
            }
          res(best);
        } catch {
          res("#9a9a9a");
        }
      };
      img.onerror = () => res("#9a9a9a");
      img.src = blockTex("item/" + id.replace(/^minecraft:/, ""));
    });
    labels.set(id, p);
  }
  return p;
}
export function useDiscLabel(id: string) {
  const [c, setC] = useState("#9a9a9a");
  useEffect(() => {
    let alive = true;
    discLabel(id).then((v) => alive && setC(v));
    return () => {
      alive = false;
    };
  }, [id]);
  return c;
}

/** A vinyl record with the disc's label colour. */
export function Vinyl({ id, className }: { id: string; className?: string }) {
  const lab = useDiscLabel(id);
  return (
    <div className={"vinyl " + (className ?? "")} style={{ "--lab": lab } as CSSProperties}>
      <i className="vy-sheen" />
    </div>
  );
}

/** Card art for a disc: a record over a jukebox top, spinning while it plays. */
export function DiscArt({ d, jukeTop }: { d: DexDisc; jukeTop: string }) {
  const st = useDisc();
  const on = st.song === d.song && st.playing;
  return (
    <div className={"art-disc" + (on ? " playing" : "")}>
      <div className="ad-juke px" style={{ backgroundImage: `url(${jukeTop})` }} />
      <Vinyl id={d.id} className="ad-rec" />
      <img className="art-badge px" src={iconxUrl(d.id, 64)} alt="" draggable={false} />
      {on && (
        <div className="ad-eq">
          <i />
          <i />
          <i />
          <i />
        </div>
      )}
    </div>
  );
}

/** Play / pause panel in the inspector. */
export function DiscControls({ d }: { d: DexDisc }) {
  const st = useDisc();
  const mine = st.song === d.song;
  const f = mine && st.dur ? st.t / st.dur : 0;
  return (
    <div className={"disc-ctl" + (mine && st.playing ? " on" : "")}>
      <button
        className="dc-play"
        onClick={() => {
          sfx.click();
          if (mine) discPlayer.toggle();
          else discPlayer.play(d);
        }}
        aria-label={mine && st.playing ? "Pause" : "Play"}
      >
        {mine && st.playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
      </button>
      <div className="dc-mid">
        <b>{mine && st.error ? "Couldn't find this song in Minecraft's files" : mine && st.playing ? "Now playing" : "Play it here"}</b>
        <div
          className="dc-bar"
          onClick={(ev) => {
            if (!mine) return;
            const r = ev.currentTarget.getBoundingClientRect();
            discPlayer.seek((ev.clientX - r.left) / r.width);
          }}
        >
          <i style={{ width: `${f * 100}%` }} />
        </div>
        <span className="dc-t">
          {mmss(mine ? st.t : 0)} / {mmss(mine && st.dur ? st.dur : d.seconds)}
        </span>
      </div>
    </div>
  );
}

/** The little jukebox that follows you around the app while a disc plays. */
export function NowPlaying() {
  const st = useDisc();
  const f = st.dur ? st.t / st.dur : 0;
  return (
    <AnimatePresence>
      {st.song && (
        <motion.div className={"now-playing" + (st.playing ? " on" : "")} initial={{ opacity: 0, y: 20, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.95 }} transition={{ type: "spring", stiffness: 260, damping: 24 }}>
          <Vinyl id={st.icon} className="np-disc" />
          <div className="np-meta">
            <b>{st.name}</b>
            <span>{st.artist}</span>
            <div className="np-bar">
              <i style={{ width: `${f * 100}%` }} />
            </div>
          </div>
          <button className="iconbtn" onClick={() => (sfx.click(), discPlayer.toggle())} aria-label={st.playing ? "Pause" : "Play"}>
            {st.playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
          </button>
          <button className="iconbtn" onClick={() => (sfx.close(), discPlayer.stop())} aria-label="Stop">
            <X size={14} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ------------------------------------------------------------------ what's new

const NEWS_LS = "lv.dex.news.1";
export function newsSeen() {
  try {
    return localStorage.getItem(NEWS_LS) === "1";
  } catch {
    return true;
  }
}
export function WhatsNew({ data, onClose, onGo }: { data: DexData; onClose: () => void; onGo: (t: Tab) => void }) {
  const items: [Tab, string, string, string][] = [
    ["items", "minecraft:bundle", "Item Dex", `All ${data.items?.length ?? 0} items, from sticks to elytra. How many have you held?`],
    ["enchants", "minecraft:enchanted_book", "Enchant Dex", "Every enchant, at every level you've ever owned."],
    ["trims", "minecraft:silence_armor_trim_smithing_template", "Trim Dex", "Every pattern in every material, on a 3D armour stand."],
  ];
  return (
    <motion.div className="dex-news" initial={{ opacity: 0, y: -10, height: 0 }} animate={{ opacity: 1, y: 0, height: "auto" }} exit={{ opacity: 0, height: 0, marginBottom: 0 }}>
      <div className="dn-head">
        <b>New in the Dex</b>
        <span>Three new collections, built from what you own. Packs tear open in 3D now too.</span>
        <button
          className="iconbtn"
          onClick={() => {
            try {
              localStorage.setItem(NEWS_LS, "1");
            } catch {
              /* private mode */
            }
            onClose();
          }}
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
      <div className="dn-row">
        {items.map(([t, icon, name, d], i) => (
          <motion.button key={t} className="dn-item" onClick={() => (sfx.nav(), onGo(t))} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.07 }} onMouseEnter={() => sfx.hover()}>
            <img className="px" src={iconxUrl(icon, 64)} alt="" />
            <b>{name}</b>
            <span>{d}</span>
          </motion.button>
        ))}
      </div>
    </motion.div>
  );
}

export function Pill({ children }: { children: ReactNode }) {
  return <span className="dx-pill">{children}</span>;
}
