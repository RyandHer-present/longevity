// Calls into the world tools backend (src-tauri/src/tools).
import { invoke } from "@tauri-apps/api/core";

export type Pos = [number, number, number];

export interface Offer {
  buy: [string, number];
  buyB: [string, number] | null;
  sell: [string, number, string[]];
  uses: number;
  max: number;
  xp: number;
  mult: number;
  demand: number;
  price: number;
  price_cured: number;
}
export interface Villager {
  uuid: string;
  kind: "villager" | "zombie_villager" | "wandering_trader";
  dim: string;
  pos: [number, number, number];
  profession: string;
  type: string;
  level: number;
  xp: number;
  name: string | null;
  baby: boolean;
  reputation: number;
  cured: boolean;
  converting: boolean;
  restocks_today: number;
  offers: Offer[];
}
export interface HistoryEntry {
  t: number;
  day: number;
  level: number;
  profession: string;
  trades: [string, string[], number, [string, number] | null][];
}
export interface Roster {
  villagers: Villager[];
  names: Record<string, string>;
  history: Record<string, HistoryEntry[]>;
  player: string;
  t: number;
}

export interface Farm {
  id: string;
  kind: "iron" | "mob" | "crop" | "animal" | "other";
  sub: string;
  name: string;
  dim: string;
  box: [number, number, number, number, number, number];
  center: Pos;
  units: number;
  auto: boolean;
  custom: boolean;
  why: string[];
  confidence: string;
  /** wild cane, village fields…: shown apart and left out of totals until you say it's yours */
  maybe?: boolean;
  rate: {
    per_hour: Record<string, number>;
    source: "measured" | "rules" | "none yet";
    rules: Record<string, number>;
    measured: { minutes: number; per_hour: Record<string, number>; samples: number; last: number } | null;
  };
  outputs: { id: number; kind: string; pos: Pos; name: string | null }[];
  stored: Record<string, number>;
  history: { t: number; play: number; items: Record<string, number> }[];
}
export interface FarmReport {
  farms: Farm[];
  names: Record<string, string>;
}

export interface DoctorChest {
  group: number;
  kind: string;
  double: boolean;
  pos: Pos;
  dim: string;
  name: string | null;
  ids: number[];
  slots: number;
  used: number;
  distinct: number;
  families: string[];
  mergeable: number;
  messy: boolean;
  top: [string, number, string][];
}
export interface DoctorSplit {
  id: string;
  name: string;
  total: number;
  chests: number;
  stacks_needed: number;
  home: Pos;
  home_dim: string;
  home_free: number;
  where: { pos: Pos; dim: string; count: number; stacks: number; group: number }[];
}
export interface Shulker {
  id: string;
  name: string | null;
  in: Pos;
  in_kind: string;
  dim: string;
  slots_used: number;
  kinds: number;
  contents: [string, number, string][];
  mixed: boolean;
}
export interface PlanStep {
  take: Pos;
  put: Pos;
  item: string;
  name: string;
  count: number;
  dim: string;
}
export interface Doctor {
  ready: boolean;
  summary: { containers: number; slots: number; used: number; free: number; messy: number; split: number; mergeable: number; shulkers: number };
  chests: DoctorChest[];
  split: DoctorSplit[];
  shulkers: Shulker[];
  plan: PlanStep[];
  guide: { plan: string; step: number; done: boolean; t: number } | null;
  names: Record<string, string>;
}

export interface GearItem {
  id: string;
  count: number;
  name: string | null;
  ench: [string, number][];
  damage: number | null;
  repair_cost: number | null;
  trim: [string, string] | null;
  slot: number | null;
  where?: { pos?: Pos; dim?: string; kind: string; nested?: boolean };
}
export interface Gear {
  ready: boolean;
  player: string;
  uuid: string | null;
  xp_level: number;
  equipped: Record<string, GearItem>;
  inventory: GearItem[];
  selected: number;
  ender: GearItem[];
  stored: GearItem[];
  books: { ench: [string, number][]; count: number; repair_cost: number | null; where: { pos?: Pos; dim?: string; kind: string } }[];
  names: Record<string, string>;
}

export interface GoalItem {
  id: string;
  name?: string;
  need: number;
  have?: number;
  manual?: number;
}
export interface Project {
  id: string;
  name: string;
  template?: string;
  pinned?: boolean;
  created: number;
  done_at?: number | null;
  items: GoalItem[];
  progress?: number;
  notes?: string;
}

export interface Live {
  fresh: boolean;
  t?: number;
  in_world?: boolean;
  dim?: string;
  pos?: [number, number, number];
  yaw?: number;
  pitch?: number;
  health?: number;
  food?: number;
  xp_level?: number;
  session_start?: number;
  trail?: [number, number, number, string, number][];
  deaths?: { t: number; pos: Pos; dim: string; cause: string; drops: [string, number][] }[];
}

export interface KillBoard {
  killed: { id: string; name: string; count: number }[];
  killed_by: { id: string; name: string; count: number }[];
  mob_kills: number;
  player_kills: number;
  deaths: number;
  damage_dealt: number;
  damage_taken: number;
}

export interface Glance {
  day: number;
  play_ticks: number;
  farm_count: number;
  farm_top: { id: string; name: string; per_hour: number }[];
  projects: Project[];
}

export interface Recap {
  id: string;
  t: number;
  world: string;
  world_path: string;
  day: number;
  days_passed: number;
  minutes: number;
  crashed: boolean;
  headline: string;
  lines: string[];
  distance_m: number;
  mined: number;
  mined_top: { id: string; name: string; count: number } | null;
  killed: number;
  killed_top: { id: string; name: string; count: number } | null;
  kills: { id: string; name: string; count: number }[];
  crafted: number;
  crafted_top: { id: string; name: string; count: number } | null;
  deaths: number;
  advancements: string[];
  new_cards: number;
  goals: string[];
  picked_up: number;
  traded: number;
  bred: number;
  seen: boolean;
}

export interface ShotTag {
  t: number;
  pos: Pos;
  dim: string;
  biome: string;
  day: number;
  time: number;
  world: string;
}

export const tapi = {
  villagers: () => invoke<Roster>("t_villagers"),
  farms: () => invoke<FarmReport>("t_farms"),
  farmSave: (farm: Partial<Farm> & { outputs?: string[] | unknown; hidden?: boolean; confirmed?: boolean }) => invoke<{ id: string }>("t_farm_save", { farm }),
  farmDelete: (id: string) => invoke<void>("t_farm_delete", { id }),
  doctor: () => invoke<Doctor>("t_doctor"),
  gear: () => invoke<Gear>("t_gear"),
  projects: () => invoke<{ projects: Project[] }>("t_projects"),
  projectsSave: (projects: Project[]) => invoke<{ projects: Project[] }>("t_projects_save", { projects }),
  find: (label: string, targets: { pos: Pos; dim: string }[]) => invoke<void>("t_find", { label, targets }),
  guide: (guide: unknown | null) => invoke<void>("t_guide", { guide }),
  live: () => invoke<Live>("t_live"),
  kills: () => invoke<KillBoard>("t_kills"),
  glance: () => invoke<Glance>("t_glance"),
  recaps: () => invoke<{ recaps: Recap[] }>("t_recaps"),
  recapSeen: (id: string) => invoke<void>("t_recap_seen", { id }),
  recapLatest: () => invoke<Recap | null>("t_recap_latest"),
  statsRaw: () => invoke<Record<string, Record<string, number>>>("t_stats_raw"),
  shotTags: () => invoke<Record<string, ShotTag>>("t_shot_tags"),
};

export const short = (id: string) => id.replace(/^minecraft:/, "");
export const pretty = (id: string) =>
  short(id)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
export const fmtRate = (n: number) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : Math.round(n).toString());
export const roman = (n: number) => ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][n] ?? String(n);
export const dist = (a: Pos | number[], b: Pos | number[]) => Math.hypot(a[0] - b[0], a[2] - b[2]);
