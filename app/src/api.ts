// Thin typed wrapper over the Tauri commands and the atlas:// protocol.
import { invoke } from "@tauri-apps/api/core";

export const PROTO = "http://atlas.localhost";
export const iconUrl = (id: string) => `${PROTO}/icon/${encodeURIComponent(id)}.png`;
export const blockTex = (path: string) => `${PROTO}/block/${path.replace(/\//g, "%2F")}`;
export const tileUrl = (dim: string, style: string, rx: number, rz: number, v = 0) =>
  `${PROTO}/tile/${encodeURIComponent(dim)}/${style}/${rx}/${rz}.png?v=${v}`;
export const lodUrl = (dim: string, rx: number, rz: number, v = 0) => `${PROTO}/lod/${encodeURIComponent(dim)}/x/${rx}/${rz}?v=${v}`;
export const plateUrl = (rel: string) => `${PROTO}/${rel}`;
/** A music disc's song, straight from Minecraft's own sound files. */
export const discUrl = (song: string) => `${PROTO}/disc/${encodeURIComponent(song)}.ogg`;

export interface Settings {
  sounds: boolean;
  recorder_enabled: boolean;
  chapter_every_days: number;
  render_distance: number;
  quality: string;
  map_style: string;
  last_world: string | null;
  /** UI theme id ("atlas" = the original look) */
  theme?: string;
  notify_chapters: boolean;
  /** Longevity: icons-only sidebar */
  nav_collapsed?: boolean;
  /** close the window when a game starts (default: stay open in a light mode) */
  close_while_playing?: boolean;
  notify_goals?: boolean;
  notify_streak?: boolean;
  bookmarks?: string[];
}

export interface AppInfo {
  assets_ready: boolean;
  assets_error: string | null;
  mc_version: string | null;
  ai: { gemini: boolean; groq: boolean; model: string | null };
  settings: Settings;
  app_version: string;
  test_tour?: string | null;
  test_interval?: number | null;
}

export interface WorldListItem {
  path: string;
  folder: string;
  name: string;
  instance: string;
  source: string;
  version: string;
  last_played: number;
  size: number;
  icon: string | null;
}

export interface PlayerInfo {
  pos: [number, number, number];
  yaw: number;
  pitch: number;
  dim: string;
  health: number;
  food: number;
  xp_level: number;
  xp_total: number;
  game_type: number;
  respawn: { pos: number[] | null; dim: string | null } | null;
  last_death: { pos: number[] | null; dim: string | null } | null;
  hand: { id: string; name: string | null } | null;
}

export interface WorldSummary {
  id: string;
  path: string;
  folder: string;
  instance: string;
  name: string;
  version: string;
  day: number;
  day_time: number;
  time: number;
  hardcore: boolean;
  difficulty: number;
  raining: boolean;
  thundering: boolean;
  spawn: [number, number, number] | null;
  last_played: number;
  player: string;
  players: PlayerInfo[];
  dims: { id: string; regions: number }[];
  open: boolean;
  size: number;
}

export interface Structure {
  id: string;
  bbox: number[];
}

export interface ExploredInfo {
  visited: number[]; // flat [cx, cz, inhabitedTicks]*
  seen: number;
  generated: number;
  regions: [number, number][];
  structures: Structure[];
}

export interface Item {
  id: string;
  count: number;
  name: string | null;
  enchants: string[];
  damage: number | null;
  contents: Item[];
  slot: number | null;
}

export interface Container {
  id: number;
  kind: string;
  dim: string;
  pos: [number, number, number];
  name: string | null;
  items: Item[];
}

export interface Hit {
  container: number;
  kind: string;
  dim: string;
  pos: [number, number, number];
  name: string | null;
  matches: [string, number, string | null, string[], boolean][];
  total: number;
}

export interface GameEvent {
  t: number;
  day: number | null;
  kind: string;
  title: string;
  detail: string;
  pos: [number, number, number] | null;
  dim: string | null;
  source: string;
}

export interface Advancement {
  id: string;
  title: string;
  description: string;
  done_ms: number;
  frame: string;
}

export interface StatsSummary {
  play_ticks: number;
  total_world_ticks: number;
  deaths: number;
  mob_kills: number;
  player_kills: number;
  damage_dealt: number;
  damage_taken: number;
  jumps: number;
  sleeps: number;
  trades: number;
  bred: number;
  fish: number;
  enchanted: number;
  since_death_ticks: number;
  since_rest_ticks: number;
  chests_opened: number;
  distance: Record<string, number>;
  mined_total: number;
  crafted_total: number;
  placed_total: number;
  top_mined: [string, number][];
  top_crafted: [string, number][];
  top_used: [string, number][];
  top_killed: [string, number][];
  top_killed_by: [string, number][];
  top_picked_up: [string, number][];
  top_broken: [string, number][];
}

export interface PlayerStats {
  summary: StatsSummary;
  advancements: Advancement[];
  advancements_total: number;
  sessions: { start: number; end: number; login: number[] | null }[];
  calendar: [number, number][];
  names: Record<string, string>;
}

export interface Place {
  id: string;
  name: string;
  suggested: string | null;
  suggested_reason: string;
  kind: string;
  dim: string;
  center: [number, number, number];
  chunks: [number, number, number, number];
  score: number;
  first_day: number | null;
  hidden: boolean;
  notes: string;
}

export interface ChapterSection {
  heading: string;
  body: string;
  plate: string | null;
  plate_style: string | null;
}

export interface Chapter {
  number: number;
  title: string;
  day_from: number;
  day_to: number;
  written_at: number;
  model: string;
  draft: boolean;
  epigraph: string;
  sections: ChapterSection[];
  suggestions: { place_id: string; name: string; reason: string }[];
  summary: string;
  in_memoriam: string[];
  words: number;
}

export interface ChaptersInfo {
  chapters: Chapter[];
  every: number;
  day: number;
  writing: boolean;
  ai: { gemini: boolean; groq: boolean; model: string | null };
}

export interface EntityInfo {
  id: string;
  name: string | null;
  display: string;
  pos: [number, number, number];
  yaw: number;
  health: number | null;
  baby: boolean;
  variant: string | null;
  color: number | null;
  item: string | null;
  villager: { profession: string | null; type: string | null; level: number | null } | null;
  tamed: boolean;
  sheared: boolean;
}

export interface RecorderStatus {
  startup: boolean;
  running: boolean;
  exe: string | null;
  status: { pid?: number; updated?: number; open_world?: string | null; events_recorded?: number } | null;
}

// ------------------------------------------------------------------ Dex

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";
export interface Stamp {
  t: number;
  day: number | null;
}

interface DexBase {
  key: string;
  id: string;
  name: string;
  group: string;
  rarity: Rarity;
  unlocked: boolean;
  first: Stamp | null;
  /** unlocked before the Atlas started keeping track (no exact date) */
  before: boolean;
  /** unlocked but not opened in a pack yet */
  new: boolean;
}
export interface DexMob extends DexBase {
  killed: number;
  killed_by: number;
  tamed: number;
  how: string;
  seen_times: number;
  most: number;
}
export interface DexDeath extends DexBase {
  count: number;
  last: { t: number; day: number | null; message: string } | null;
  killers: Record<string, number>;
}
export interface DexBiome extends DexBase {
  dim: string;
  tex: string;
  tint: string;
  cave: boolean;
  spot: { dim: string; pos: [number, number, number]; minutes: number } | null;
}
export interface DexPet extends DexBase {
  uuid: string;
  species: string;
  variant: string | null;
  collar: number | null;
  baby: boolean;
  alive: boolean;
  gone: Stamp | null;
  gone_reason: string | null;
  health: number | null;
  max_health: number | null;
  speed: number | null;
  jump: number | null;
  sitting: boolean;
  pos: [number, number, number] | null;
  dim: string | null;
  kind: string;
}
export interface DexBlock extends DexBase {
  mined: number;
  placed: number;
  picked: number;
  crafted: number;
}
export interface DexAdv extends DexBase {
  desc: string;
  frame: "task" | "goal" | "challenge";
  hidden: boolean;
  icon: string;
  depth: number;
  got: number;
  need: number;
}
export interface DexDisc extends DexBase {
  song: string;
  artist: string;
  played: number;
  held: boolean;
  seconds: number;
}
export interface DexVariant extends DexBase {
  mob: string;
  how: string;
  seen_times: number;
}
export interface DexPlaqueTier {
  key: string;
  n: number;
  unlocked: boolean;
  first: Stamp | null;
  before: boolean;
  new: boolean;
}
export interface DexPlaque {
  id: string;
  one: string;
  many: string;
  icon: string;
  value: number;
  tiers: DexPlaqueTier[];
}
export interface DexData {
  advancements: DexAdv[];
  discs: DexDisc[];
  variants: DexVariant[];
  plaques: DexPlaque[];
  new_kinds: string[];
  mobs: DexMob[];
  deaths: DexDeath[];
  deaths_total: number;
  deaths_unread: number;
  biomes: DexBiome[];
  pets: DexPet[];
  blocks: DexBlock[];
  enchants?: DexEnchant[];
  trims?: DexTrim[];
  items?: DexItem[];
  intro: boolean;
  player: string;
  day: number;
  computed: number;
}
export interface DexEnchant extends DexBase {
  level: number;
  max: number;
  have: boolean;
  copies: number;
  treasure: boolean;
  curse: boolean;
  weight: number;
}
export interface DexTrim extends DexBase {
  pattern: string;
  material: string;
  pattern_name: string;
  material_name: string;
  color: string;
  decal: boolean;
  have: boolean;
}
export interface DexItem extends DexBase {
  have: boolean;
  picked: number;
  crafted: number;
  used: number;
  broken: number;
}
export type DexEntry = DexMob | DexDeath | DexBiome | DexPet | DexBlock | DexAdv | DexDisc | DexVariant | DexEnchant | DexTrim | DexItem;

export interface CapsuleMeta {
  id: string;
  day: number;
  mark: number;
  t: number;
  center: [number, number, number];
  radius: number;
  bytes: number;
  chunks: number;
  world_name: string;
  day_time: number;
  raining: boolean;
}
export interface CapsulesInfo {
  capsules: CapsuleMeta[];
  day: number;
  next: number;
  every: number;
  radius: number;
  open: string | null;
  just_taken: string | null;
  world_open: boolean;
}

export const iconxUrl = (id: string, size = 128) => `${PROTO}/iconx/${size}/${encodeURIComponent(id)}.png`;

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  dex: () => invoke<DexData>("dex"),
  dexReveal: (keys: string[]) => invoke<void>("dex_reveal", { keys }),
  /** a card the in-game Atlas Companion asked Atlas to open at launch */
  takeOpenCard: () => invoke<{ key: string; world: string | null } | null>("take_open_card"),
  companionStamp: () => invoke<number>("companion_stamp"),
  settingsSet: (settings: Settings) => invoke<void>("settings_set", { settings }),
  listWorlds: () => invoke<WorldListItem[]>("list_worlds"),
  openWorld: (path: string) => invoke<WorldSummary>("open_world", { path }),
  summary: () => invoke<WorldSummary>("world_summary"),
  explored: (dim: string) => invoke<ExploredInfo>("explored", { dim }),
  textures: () => invoke<ArrayBuffer>("textures"),
  mesh: (dim: string, chunks: [number, number, number][], ycut?: number) => invoke<ArrayBuffer>("mesh", { dim, chunks, ycut: ycut ?? null }),
  solidBox: (dim: string, x: number, y: number, z: number) => invoke<ArrayBuffer>("solid_box", { dim, x, y, z }),
  poll: (dim: string) => invoke<{ open: boolean; changed: [number, number][]; summary: WorldSummary }>("poll", { dim }),
  entities: (dim: string, x: number, z: number, radius: number) => invoke<EntityInfo[]>("entities", { dim, x, z, radius }),
  searchItems: (query: string) => invoke<{ ready: boolean; hits?: Hit[]; names?: Record<string, string>; containers?: number }>("search_items", { query }),
  storageTotals: () =>
    invoke<{ ready: boolean; items?: { id: string; name: string; count: number; containers: number }[]; containers?: number; kinds?: Record<string, number>; built?: number }>(
      "storage_totals",
    ),
  container: (id: number) => invoke<{ container: Container; names: Record<string, string>; kind_name: string }>("container", { id }),
  rebuildIndex: () => invoke<void>("rebuild_index"),
  playerStats: () => invoke<PlayerStats>("player_stats"),
  timeline: () => invoke<{ events: GameEvent[] }>("timeline"),
  places: () => invoke<Place[]>("places_list"),
  placeUpdate: (id: string, patch: { name?: string; hidden?: boolean; notes?: string; accept?: boolean; reject?: boolean }) =>
    invoke<Place[]>("place_update", { id, name: patch.name ?? null, hidden: patch.hidden ?? null, notes: patch.notes ?? null, accept: patch.accept ?? null, reject: patch.reject ?? null }),
  savePlate: (key: string, dataUrl: string) => invoke<string>("save_plate", { key, dataUrl }),
  savePhoto: (dataUrl: string) => invoke<string>("save_photo", { dataUrl }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  closeWindow: () => invoke<void>("close_window"),
  quitApp: () => invoke<void>("quit_app"),
  getAutostart: () => invoke<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => invoke<boolean>("set_autostart", { enabled }),
};

// ------------------------------------------------------------------ helpers

export const DIMS: { id: string; name: string; short: string }[] = [
  { id: "minecraft:overworld", name: "Overworld", short: "OW" },
  { id: "minecraft:the_nether", name: "The Nether", short: "NE" },
  { id: "minecraft:the_end", name: "The End", short: "END" },
];

export const dimName = (id: string | null | undefined) => DIMS.find((d) => d.id === id)?.name ?? (id ?? "").replace("minecraft:", "").replace(/_/g, " ");

export function fmtNum(n: number, digits = 0): string {
  if (!isFinite(n)) return "–";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function fmtCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
  if (a >= 1e4) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + "k";
  return fmtNum(n);
}

export function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  if (h >= 1) return `${h} h ${String(m % 60).padStart(2, "0")} m`;
  return `${m} min`;
}

export function fmtTicks(t: number): string {
  return fmtDuration((t / 20) * 1000);
}

export function fmtDist(blocks: number): string {
  if (blocks >= 10000) return (blocks / 1000).toFixed(1) + " km";
  return fmtNum(Math.round(blocks)) + " m";
}

export function fmtDate(ms: number, withTime = false): string {
  const d = new Date(ms);
  const s = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined });
  if (!withTime) return s;
  return s + " · " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function fmtAgo(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function timeOfDay(dayTime: number): { label: string; hour: number } {
  const t = ((dayTime % 24000) + 24000) % 24000;
  const hour = (t / 1000 + 6) % 24;
  let label = "Night";
  if (t < 1000) label = "Sunrise";
  else if (t < 6000) label = "Morning";
  else if (t < 9000) label = "Midday";
  else if (t < 12000) label = "Afternoon";
  else if (t < 13500) label = "Sunset";
  else if (t < 22500) label = "Night";
  else label = "Dawn";
  return { label, hour };
}

export const shortId = (id: string) => (id ?? "").replace(/^minecraft:/, "");
export const prettyId = (id: string) =>
  shortId(id)
    .split(/[_/]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
