import { create } from "zustand";
import type { AppInfo, CapsuleMeta, ExploredInfo, Settings, WorldSummary } from "./api";
import { api } from "./api";

export type Page =
  | "home"
  | "play"
  | "mods"
  | "instances"
  | "skins"
  | "sync"
  | "world"
  | "map"
  | "storage"
  | "villagers"
  | "farms"
  | "projects"
  | "gear"
  | "lookup"
  | "changelog"
  | "dex"
  | "stats"
  | "history"
  | "shots"
  | "settings";

export interface FocusRequest {
  x: number;
  y: number;
  z: number;
  dim: string;
  label?: string;
  n: number;
}

interface State {
  info: AppInfo | null;
  settings: Settings | null;
  world: WorldSummary | null;
  explored: Record<string, ExploredInfo>;
  page: Page;
  pickerOpen: boolean;
  live: boolean;
  dim: string;
  focus: FocusRequest | null;
  changed: { dim: string; regions: [number, number][]; n: number } | null;
  toast: { text: string; n: number } | null;
  photo: boolean;
  /** a time capsule open in the 3D view (null = today's world) */
  capsule: CapsuleMeta | null;
  /** unopened Dex cards, for the sidebar badge */
  dexNew: number;
  /** the first-ever Dex load happened in the background; show the intro on the next visit */
  dexIntro: boolean;
  /** open the Dex on one card (asked for by the in-game companion) */
  dexOpen: { key: string; n: number } | null;
  /** bumped when the Dex page should recompute (the companion saw something new) */
  dexReload: number;
  /** a recap to scroll to on the History page (clicked on the desktop card) */
  openRecap: string | null;
  /** open a tool page on one thing (from Ctrl+K): a villager, farm, goal or lookup entry */
  toolFocus: { page: Page; id: string; n: number } | null;
  /** a closet skin to wear in the 3D world's walk mode (Skins -> "Try on in your base") */
  tryOn: { url: string; slim: boolean; name: string } | null;
  /** a screenshot to open on the Screenshots page (clicked in the 3D world) */
  openShot: string | null;
  /** the resource pack preview is open in the 3D world */
  packPreview: boolean;
  openDexCard: (key: string) => void;
  reloadDex: () => void;
  setPage: (p: Page) => void;
  setInfo: (i: AppInfo) => void;
  setWorld: (w: WorldSummary | null) => void;
  setExplored: (dim: string, e: ExploredInfo) => void;
  setPicker: (o: boolean) => void;
  setLive: (l: boolean) => void;
  setDim: (d: string) => void;
  flyTo: (f: Omit<FocusRequest, "n">) => void;
  pushChanged: (dim: string, regions: [number, number][]) => void;
  toastMsg: (text: string) => void;
  setPhoto: (p: boolean) => void;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
}

let toastN = 0;

export const useStore = create<State>((set, get) => ({
  info: null,
  settings: null,
  world: null,
  explored: {},
  page: "home",
  pickerOpen: false,
  live: false,
  dim: "minecraft:overworld",
  focus: null,
  changed: null,
  toast: null,
  openRecap: null,
  toolFocus: null,
  tryOn: null,
  packPreview: false,
  openShot: null,
  photo: false,
  capsule: null,
  dexNew: 0,
  dexIntro: false,
  dexOpen: null,
  dexReload: 0,
  openDexCard: (key) => set({ dexOpen: { key, n: (get().dexOpen?.n ?? 0) + 1 }, page: "dex" }),
  reloadDex: () => set({ dexReload: get().dexReload + 1 }),
  setPage: (page) => set({ page }),
  setInfo: (info) => {
    applyTheme(info.settings?.theme);
    set({ info, settings: info.settings });
  },
  setWorld: (world) => set({ world, explored: world ? get().explored : {} }),
  setExplored: (dim, e) => set({ explored: { ...get().explored, [dim]: e } }),
  setPicker: (pickerOpen) => set({ pickerOpen }),
  setLive: (live) => set({ live }),
  setDim: (dim) => set({ dim }),
  flyTo: (f) => set({ focus: { ...f, n: (get().focus?.n ?? 0) + 1 }, page: "world", dim: f.dim }),
  pushChanged: (dim, regions) => set({ changed: { dim, regions, n: (get().changed?.n ?? 0) + 1 } }),
  toastMsg: (text) => set({ toast: { text, n: ++toastN } }),
  setPhoto: (photo) => set({ photo }),
  saveSettings: async (patch) => {
    const cur = get().settings;
    if (!cur) return;
    const next = { ...cur, ...patch };
    if (patch.theme !== undefined) applyTheme(next.theme);
    set({ settings: next });
    await api.settingsSet(next);
  },
}));

/** Puts the colour theme on <html data-theme>; themes.css does the rest. */
export function applyTheme(theme: string | undefined) {
  const t = theme || "atlas";
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem("atlas-theme", t);
  } catch {}
}
// Paint the last theme straight away so the boot screen does not flash gold first.
try {
  applyTheme(localStorage.getItem("atlas-theme") ?? undefined);
} catch {}

/** Set of seen chunk keys ("cx,cz"), derived from the visited list the same way the backend does it. */
export function seenSet(e: ExploredInfo | undefined): Set<string> {
  const out = new Set<string>();
  if (!e) return out;
  const v = e.visited;
  for (let i = 0; i < v.length; i += 3) {
    const cx = v[i],
      cz = v[i + 1];
    for (let dz = -3; dz <= 3; dz++)
      for (let dx = -3; dx <= 3; dx++) if (dx * dx + dz * dz <= 10) out.add(`${cx + dx},${cz + dz}`);
  }
  return out;
}
