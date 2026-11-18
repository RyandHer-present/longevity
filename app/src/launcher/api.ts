// Typed wrapper over the Mio Launcher backend and the mio:// protocol.
import { invoke } from "@tauri-apps/api/core";

export const PROTO = "http://mio.localhost";
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// used by the shared 3D renderer (copied from LongTerm Atlas)
export const iconUrl = (id: string) => `${PROTO}/icon/${encodeURIComponent(id)}.png`;
export const blockTex = (path: string) => `${PROTO}/block/${encodeURIComponent(path)}`;
export const lodUrl = (dim: string, rx: number, rz: number, v = 0) => `${PROTO}/lod/${encodeURIComponent(dim)}/x/${rx}/${rz}?v=${v}`;

export const instIconUrl = (key: string) => `${PROTO}/insticon/${encodeURIComponent(key)}`;
export const worldIconUrl = (inst: string, folder: string) => `${PROTO}/worldicon/${encodeURIComponent(inst)}/${encodeURIComponent(folder)}`;
export const modIconUrl = (inst: string, file: string) => `${PROTO}/modicon/${encodeURIComponent(inst)}/${encodeURIComponent(file)}`;
export const thumbUrl = (key: string, w = 480) => `${PROTO}/thumb/${w}/${b64(key)}.jpg`;
export const shotUrl = (key: string) => `${PROTO}/shot/${b64(key)}.png`;
export const packIconUrl = (inst: string, kind: string, file: string) => `${PROTO}/packicon/${encodeURIComponent(inst)}/${encodeURIComponent(kind)}/${encodeURIComponent(file)}`;
export const skinUrl = (id: string) => `${PROTO}/skin/${id}.png`;
export const capeUrl = (id: string) => `${PROTO}/cape/${id}.png`;

export const prettyId = (id: string) =>
  id
    .replace(/^minecraft:/, "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

export interface Item {
  id: string;
  count: number;
  name?: string | null;
  enchants: string[];
  damage?: number | null;
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

export interface Settings {
  sounds: boolean;
  instance: string | null;
  hide_on_play: boolean;
  backdrop: boolean;
  quality: string;
  favorites: string[];
}

export interface AppInfo {
  version: string;
  prism: string | null;
  prism_data: string;
  assets_ready: boolean;
  assets_error: string | null;
  settings: Settings;
  test_tour: string | null;
  test_interval: number | null;
  ram_mb: number;
}

export interface Instance {
  id: string;
  name: string;
  dir: string;
  mc_dir: string;
  group: string | null;
  icon: string;
  mc_version: string;
  loader: string;
  loader_version: string;
  total_played: number;
  last_session: number;
  last_launch: number;
  mods: number;
  worlds: number;
  max_mem: number;
  min_mem: number;
  notes: string;
}

export interface WorldItem {
  folder: string;
  name: string;
  last_played: number;
  icon: boolean;
  hardcore: boolean;
  day: number;
  mode: number;
}

export interface ModMeta {
  id: string;
  name: string;
  version: string;
  description: string;
  authors: string[];
  icon: string | null;
  loader: string;
  depends: string[];
  homepage: string | null;
}

export interface MrInfo {
  project_id: string;
  version_id: string;
  version_number: string;
  slug: string;
  title: string;
  icon_url: string | null;
  downloads: number;
  date: string;
}

export interface InstalledMod {
  file: string;
  enabled: boolean;
  size: number;
  mtime: number;
  sha1: string;
  meta: ModMeta;
  modrinth: MrInfo | null;
}

export interface UpdateInfo {
  file: string;
  name: string;
  project_id: string;
  icon_url: string | null;
  from: string;
  to: string;
  version_id: string;
  date: string;
  changelog: string;
  file_name: string;
  size: number;
}

export interface Backup {
  id: string;
  time: number;
  reason: string;
  files: string[];
}

export interface SearchHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string | null;
  downloads: number;
  follows: number;
  author: string;
  categories: string[];
  date_modified: string;
  featured_gallery: string | null;
  gallery: string[];
  color: number | null;
  versions: string[];
  project_type: string;
  display_categories?: string[];
  /** set on Saved items: which store tab it came from */
  mio_kind?: Kind;
}

export type Kind = "mod" | "shader" | "resourcepack" | "datapack" | "modpack";

export interface Pack {
  file: string;
  name: string;
  description: string;
  enabled: boolean;
  size: number;
  mtime: number;
}

export interface McVersion {
  version: string;
  kind: string;
  released: string;
}

export interface LoaderChoice {
  loader: string;
  version: string | null;
}

export interface StarterMod {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string | null;
  available: boolean;
}

export interface NewInstanceSpec {
  name: string;
  mc: string;
  loader: string;
  loader_version: string | null;
  icon_item: string | null;
  icon_file: string | null;
  copy_from: string | null;
  starter: string[];
}

export interface PackSource {
  version_id?: string | null;
  path?: string | null;
}

export interface PackPreview {
  name: string;
  version_name: string;
  summary: string;
  mc: string;
  loader: string;
  loader_version: string;
  mods: { name: string; icon_url: string | null; description: string; size: number }[];
  other_files: number;
  download_size: number;
  unpacked_size: number;
  memory_mb: number;
  ram_mb: number;
  project_id: string | null;
}

export interface Java {
  path: string;
  version: string;
  major: number;
  vendor: string;
}

export interface InstSettings {
  max_mem: number;
  ram_mb: number;
  java_path: string | null;
  java_version: string | null;
  java_needed: number;
  javas: Java[];
}

export interface UpgradeCheck {
  target: string;
  loader_ok: boolean;
  loader_version: string | null;
  ready: { file: string; name: string; icon_url: string | null; to: string }[];
  not_ready: { file: string; name: string; icon_url: string | null; why: string }[];
}

export interface Culprit {
  mod_id: string;
  name: string;
  file: string | null;
  why: string;
}

export interface CrashAction {
  kind: string;
  label: string;
  target: string;
}

export interface CrashReport {
  id: string;
  time: number;
  source: string;
  title: string;
  detail: string;
  culprits: Culprit[];
  steps: string[];
  actions: CrashAction[];
  exception: string;
  excerpt: string;
  path: string;
}

export interface CrashItem {
  id: string;
  time: number;
  title: string;
  source: string;
}

export interface Setup {
  render_distance: number;
  simulation_distance: number;
  max_fps: number;
  shaders: boolean;
  shader_pack: string;
  clouds: boolean;
  particles: number;
  memory_mb: number;
  vsync: boolean;
}

export interface PerfState {
  active: string | null;
  fps: Setup;
  shaders: Setup;
  current: Setup;
  shader_packs: string[];
  has_iris: boolean;
  ram_mb: number;
}

export interface Skin {
  id: string;
  name: string;
  model: "classic" | "slim";
  source: string;
  added: number;
  cape: boolean;
  favorite: boolean;
}

/** A skin someone was seen wearing ("account:Name" or "player:Name"), first and last time. */
export interface SkinSeen {
  who: string;
  id: string;
  first: number;
  last: number;
}

export interface Profile {
  name: string;
  id: string;
  active: boolean;
  skin_url: string | null;
  skin_variant: string | null;
}

export interface Shot {
  key: string;
  instance: string;
  instance_name: string;
  file: string;
  time: number;
  size: number;
}

export interface Session {
  instance: string;
  date: string;
  start: string;
  minutes: number;
  place: string | null;
  server: boolean;
}

export interface WorldTime {
  instance: string;
  world: string;
  name: string;
  ticks: number;
  last_played: number;
}

export interface HistoryData {
  sessions: Session[];
  worlds: WorldTime[];
  instances: { id: string; name: string; icon: string; total: number; last: number; last_launch: number }[];
  today: string;
}

export interface Server {
  name: string;
  address: string;
  icon: string | null;
}

export interface Ping {
  online: number | null;
  max: number | null;
  sample: string[];
  version: string | null;
  protocol: number | null;
  motd: string;
  favicon: string | null;
  latency: number;
}

export interface HomeWorld {
  path: string;
  folder: string;
  instance: string | null;
  name: string | null;
  day: number;
  day_time: number;
  raining: boolean;
  thundering: boolean;
  hardcore: boolean;
  last_played: number;
  poi: [number, number, number];
  home_name: string | null;
  seen: number[];
}

export const api = {
  appInfo: () => invoke<AppInfo>("l_app_info"),
  settingsSet: (settings: Settings) => invoke<void>("l_settings_set", { settings }),
  instances: () => invoke<{ instances: Instance[]; running: Record<string, number> }>("instances"),
  worlds: (id: string) => invoke<WorldItem[]>("worlds", { id }),
  launch: (id: string, server?: string | null, world?: string | null) => invoke<{ profile: string | null }>("launch", { id, server: server ?? null, world: world ?? null }),
  stopGame: (id: string) => invoke<void>("stop_game", { id }),
  openPath: (path: string) => invoke<void>("l_open_path", { path }),
  openFolder: (id: string, sub?: string) => invoke<void>("open_instance_folder", { id, sub: sub ?? null }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  openPrism: () => invoke<void>("open_prism"),

  mods: (id: string) => invoke<InstalledMod[]>("mods_list", { id }),
  modsIdentify: (id: string) => invoke<InstalledMod[]>("mods_identify", { id }),
  updates: (id: string) => invoke<UpdateInfo[]>("mods_updates", { id }),
  applyUpdates: (id: string, picks: [string, string][]) => invoke<string[]>("mods_apply_updates", { id, picks }),
  toggleMod: (id: string, file: string, enabled: boolean) => invoke<string>("mods_toggle", { id, file, enabled }),
  removeMod: (id: string, file: string) => invoke<void>("mods_remove", { id, file }),
  backups: (id: string) => invoke<Backup[]>("backups", { id }),
  rollback: (id: string, backup?: string) => invoke<string>("rollback", { id, backup: backup ?? null }),
  search: (id: string, query: string, offset: number, sort: string, category: string | null) =>
    invoke<{ hits: SearchHit[]; total_hits: number; offset: number }>("store_search", { id, query, offset, sort, category }),
  project: (id: string, project: string) => invoke<{ project: any; versions: any[]; authors: string[] }>("store_project", { id, project }),
  install: (id: string, project: string) => invoke<string[]>("store_install", { id, project }),

  crashes: (id: string) => invoke<CrashItem[]>("crashes", { id }),
  crashReport: (id: string, crash: string) => invoke<CrashReport>("crash_report", { id, crash }),
  raiseMemory: (id: string) => invoke<number>("raise_memory", { id }),


  skins: () => invoke<{ skins: Skin[]; profiles: Profile[] }>("skins_list"),
  skinsSync: () => invoke<Skin[]>("skins_sync"),
  skinAddPlayer: (name: string) => invoke<Skin>("skins_add_player", { name }),
  skinImport: (path: string) => invoke<Skin>("skins_import", { path }),
  skinUpdate: (id: string, patch: { name?: string; model?: string; favorite?: boolean }) =>
    invoke<Skin[]>("skins_update", { id, name: patch.name ?? null, model: patch.model ?? null, favorite: patch.favorite ?? null }),
  skinDelete: (id: string) => invoke<Skin[]>("skins_delete", { id }),
  skinWear: (id: string) => invoke<string>("skins_wear", { id }),
  skinsHistory: () => invoke<SkinSeen[]>("skins_history"),
  syncState: () => invoke<unknown>("sync_state"),
  syncSet: (a: string, b: string, auto: boolean, cats: string[], packs: boolean) => invoke<void>("sync_set", { a, b, auto, cats, packs }),
  syncCompare: (a: string, b: string) => invoke<unknown>("sync_compare", { a, b }),
  syncApply: (a: string, b: string, plan: unknown) => invoke<unknown>("sync_apply", { a, b, plan }),
  syncBackups: () => invoke<unknown[]>("sync_backups"),
  syncRestore: (id: string) => invoke<number>("sync_restore", { id }),
  shotCopyData: (png: string) => invoke<void>("shot_copy_data", { pngB64: png }),
  shotSaveEdit: (key: string, png: string) => invoke<string>("shot_save_edit", { key, pngB64: png }),
  skinsRefresh: () => invoke<{ skins: Skin[]; history: SkinSeen[]; changed: string[] }>("skins_refresh"),
  skinSave: (name: string, model: string, png: string) => invoke<Skin>("skins_save", { name, model, pngB64: png }),

  shots: () => invoke<Shot[]>("shots_list"),
  shotCopy: (key: string) => invoke<void>("shot_copy", { key }),
  shotDelete: (key: string) => invoke<void>("shot_delete", { key }),
  shotReveal: (key: string) => invoke<void>("shot_reveal", { key }),

  history: () => invoke<HistoryData>("history"),

  store2Search: (id: string | null, kind: Kind, query: string, offset: number, limit: number, sort: string, filters: string[][]) =>
    invoke<{ hits: SearchHit[]; total_hits: number; offset: number }>("store2_search", { id, kind, query, offset, limit, sort, filters }),
  store2Project: (id: string | null, kind: Kind, project: string) => invoke<{ project: any; versions: any[]; authors: string[] }>("store2_project", { id, kind, project }),
  store2Install: (id: string, kind: Kind, project: string, world?: string | null) => invoke<string[]>("store2_install", { id, kind, project, world: world ?? null }),
  saved: () => invoke<SearchHit[]>("saved_list"),
  savedToggle: (hit: SearchHit) => invoke<SearchHit[]>("saved_toggle", { hit }),
  packs: (id: string, kind: "resourcepack" | "shader") => invoke<Pack[]>("packs_list", { id, kind }),
  packToggle: (id: string, file: string, on: boolean) => invoke<void>("pack_toggle", { id, file, on }),
  packUseShader: (id: string, file: string) => invoke<void>("pack_use_shader", { id, file }),
  packDelete: (id: string, kind: string, file: string) => invoke<void>("pack_delete", { id, kind, file }),

  mcVersions: () => invoke<McVersion[]>("inst_versions"),
  loaders: (mc: string) => invoke<LoaderChoice[]>("inst_loaders", { mc }),
  starter: (mc: string, loader: string) => invoke<StarterMod[]>("inst_starter", { mc, loader }),
  items: () => invoke<{ id: string; name: string }[]>("inst_items"),
  createInstance: (spec: NewInstanceSpec, job: string) => invoke<{ id: string; warnings: string[] }>("inst_create", { spec, job }),
  modpackPreview: (src: PackSource) => invoke<PackPreview>("modpack_preview", { src }),
  modpackInstall: (src: PackSource, job: string) => invoke<string>("modpack_install", { src, job }),
  packFileKind: (path: string) => invoke<string>("pack_file_kind", { path }),
  prismImport: (path: string) => invoke<void>("prism_import", { path }),
  exportInstance: (id: string, job: string) => invoke<string>("inst_export", { id, job }),
  duplicate: (id: string, name: string, withWorlds: boolean, job: string) => invoke<string>("inst_duplicate", { id, name, withWorlds, job }),
  renameInstance: (id: string, name: string) => invoke<void>("inst_rename", { id, name }),
  deleteInstance: (id: string) => invoke<void>("inst_delete", { id }),
  setIcon: (id: string, item: string | null, file: string | null) => invoke<string>("inst_set_icon", { id, item, file }),
  instSettings: (id: string) => invoke<InstSettings>("inst_settings", { id }),
  setMemory: (id: string, mb: number) => invoke<void>("inst_set_memory", { id, mb }),
  setJava: (id: string, path: string | null) => invoke<void>("inst_set_java", { id, path }),
  upgradeTargets: (id: string) => invoke<{ targets: string[] }>("inst_upgrade_targets", { id }),
  upgradeCheck: (id: string, target: string) => invoke<UpgradeCheck>("inst_upgrade_check", { id, target }),
  upgrade: (id: string, target: string, withWorlds: boolean, job: string) => invoke<string>("inst_upgrade", { id, target, withWorlds, job }),

};

// ---------------------------------------------------------------- formatting

export function fmtPlay(seconds: number): string {
  if (!seconds || seconds < 60) return seconds > 0 ? "under a minute" : "never";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m} min`;
  if (h < 10) return m ? `${h} h ${m} min` : `${h} h`;
  return `${h.toLocaleString()} h`;
}

export function fmtMinutes(min: number): string {
  return fmtPlay(min * 60);
}

export function fmtAgo(ms: number): string {
  if (!ms) return "never";
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  const days = Math.floor(d / 86_400_000);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${n}`;
}

export function fmtBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${Math.round(n / (1 << 10))} KB`;
  return `${n} B`;
}

export function loaderName(l: string): string {
  return ({ fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge", vanilla: "Vanilla" } as Record<string, string>)[l] ?? l;
}

export function timeOfDay(t: number): { label: string; t: number } {
  const x = ((t % 24000) + 24000) % 24000;
  const label = x < 1000 ? "Sunrise" : x < 6000 ? "Morning" : x < 11500 ? "Afternoon" : x < 13500 ? "Sunset" : x < 22500 ? "Night" : "Dawn";
  return { label, t: x };
}

export const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
