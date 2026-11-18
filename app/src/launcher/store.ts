import { create } from "zustand";
import type { AppInfo, CrashReport, HomeWorld, Instance, Kind, PackSource, Settings } from "./api";

export type Page = "home" | "instances" | "mods" | "skins" | "shots" | "history" | "settings";

export interface Toast {
  id: number;
  text: string;
  kind?: "ok" | "err" | "info";
}

interface State {
  info: AppInfo | null;
  settings: Settings | null;
  page: Page;
  instances: Instance[];
  running: Record<string, number>;
  current: string | null;
  home: HomeWorld | null;
  crash: { inst: string; report: CrashReport } | null;
  toasts: Toast[];
  modsTab: "installed" | "store" | "updates" | "backups" | "crashes";
  storeQuery: string | null;
  launching: string | null;
  storeKind: Kind | "saved";
  wizard: boolean;
  packPreview: PackSource | null;
  setPage: (p: Page) => void;
  setCurrent: (id: string) => void;
  toast: (text: string, kind?: Toast["kind"]) => void;
}

let toastId = 0;

export const useStore = create<State>((set, get) => ({
  info: null,
  settings: null,
  page: "home",
  instances: [],
  running: {},
  current: null,
  home: null,
  crash: null,
  toasts: [],
  modsTab: "installed",
  storeQuery: null,
  launching: null,
  storeKind: "mod",
  wizard: false,
  packPreview: null,
  setPage: (page) => {
    // launcher pages live inside Longevity's own navigation ("home" here is the Play page)
    set({ page });
    import("../store").then(({ useStore: main }) => main.getState().setPage((page === "home" ? "play" : page) as any));
  },
  setCurrent: (id) => {
    set({ current: id });
    const s = get().settings;
    if (s && s.instance !== id) {
      const next = { ...s, instance: id };
      set({ settings: next });
      import("./api").then(({ api }) => api.settingsSet(next).catch(() => {}));
    }
  },
  toast: (text, kind = "info") => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, text, kind }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 4200);
  },
}));

export const st = () => useStore.getState();

export function currentInstance(): Instance | null {
  const s = st();
  return s.instances.find((i) => i.id === s.current) ?? null;
}
