import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeftRight, Anvil, Blocks, Box, BookMarked, CalendarDays, ChartNoAxesColumn, Compass, FileDiff, FolderKanban, Home as HomeIcon, Images, LayoutGrid, Map as MapIcon, Minus, Play as PlayIcon, Settings as Cog, Shirt, Square, Sprout, Users, X, Copy, GalleryVerticalEnd, Search } from "lucide-react";
import { api, blockTex, dimName, fmtAgo, timeOfDay, type WorldListItem, type WorldSummary } from "./api";
import { useStore, seenSet, type Page } from "./store";
import { sfx } from "./sound";
import { Mark, Spinner } from "./ui";
import { Engine } from "./render/engine";
import Home from "./pages/Home";
import MapPage from "./pages/MapPage";
import World3D from "./pages/World3D";
import Storage from "./pages/Storage";
import Stats from "./pages/Stats";
import SettingsPage from "./pages/Settings";
import Dex, { refreshDexBadge } from "./pages/Dex";
import { NowPlaying } from "./pages/dexextra";
import { useLauncherBoot, LauncherOverlays } from "./launcher/boot";
import { useStore as useLauncher } from "./launcher/store";
import Mods from "./launcher/pages/Mods";
import Instances from "./launcher/pages/Instances";
import Skins from "./launcher/pages/Skins";
import Sync from "./launcher/pages/Sync";
import Shots from "./launcher/pages/Shots";
import History from "./launcher/pages/History";
import Play from "./tools/Play";
import { ToolPage } from "./tools/pages";
import { CommandBar } from "./tools/CommandBar";
import { UpdateCard } from "./tools/Updater";
import { gd } from "./tools/gd";

/** Same world folder, however Windows spelled it. */
const normPath = (p: string) => p.replace(/[\\/]+/g, "/").toLowerCase();
const samePath = (a?: string | null, b?: string | null) => !!a && !!b && normPath(a) === normPath(b);

const NAV: { id: Page; label: string; icon: typeof HomeIcon; group?: string; needsWorld?: boolean }[] = [
  { id: "home", label: "Home", icon: HomeIcon, needsWorld: true },
  { id: "play", label: "Play", icon: PlayIcon, group: "Game" },
  { id: "mods", label: "Mods", icon: Blocks, group: "Game" },
  { id: "instances", label: "Instances", icon: LayoutGrid, group: "Game" },
  { id: "skins", label: "Skins", icon: Shirt, group: "Game" },
  { id: "sync", label: "Settings sync", icon: ArrowLeftRight, group: "Game" },
  { id: "world", label: "3D World", icon: Box, group: "World", needsWorld: true },
  { id: "map", label: "Map", icon: MapIcon, group: "World", needsWorld: true },
  { id: "storage", label: "Storage", icon: Compass, group: "World", needsWorld: true },
  { id: "villagers", label: "Villagers", icon: Users, group: "World", needsWorld: true },
  { id: "farms", label: "Farms", icon: Sprout, group: "World", needsWorld: true },
  { id: "projects", label: "Projects", icon: FolderKanban, group: "Plan", needsWorld: true },
  { id: "gear", label: "Gear + Anvil", icon: Anvil, group: "Plan", needsWorld: true },
  { id: "lookup", label: "Lookup", icon: BookMarked, group: "Plan" },
  { id: "changelog", label: "Hidden Changelog", icon: FileDiff, group: "Plan" },
  { id: "dex", label: "Dex", icon: GalleryVerticalEnd, group: "Records", needsWorld: true },
  { id: "stats", label: "Stats", icon: ChartNoAxesColumn, group: "Records", needsWorld: true },
  { id: "history", label: "Play history", icon: CalendarDays, group: "Records" },
  { id: "shots", label: "Screenshots", icon: Images, group: "Records" },
];

function regionSet(seen: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const k of seen) {
    const [x, z] = k.split(",").map(Number);
    out.add(`${x >> 5},${z >> 5}`);
  }
  return out;
}

function TitleBar() {
  const world = useStore((s) => s.world);
  const live = useStore((s) => s.live);
  const [max, setMax] = useState(false);
  const win = getCurrentWindow();
  useEffect(() => {
    win.isMaximized().then(setMax);
    const un = win.onResized(() => win.isMaximized().then(setMax));
    return () => {
      un.then((f) => f());
    };
  }, []);
  const tod = world ? timeOfDay(world.day_time) : null;
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <Mark />
        <span className="word">
          Long<em>evity</em>
        </span>
      </div>
      {world && (
        <div className="crumb" data-tauri-drag-region>
          <b>{world.name || world.folder}</b>
          <span className="sep" />
          <span>Day {world.day.toLocaleString()}</span>
          <span className="sep" />
          <span>{tod?.label}</span>
          {world.raining && (
            <>
              <span className="sep" />
              <span>{world.thundering ? "Thunderstorm" : "Rain"}</span>
            </>
          )}
        </div>
      )}
      <div className="spacer" data-tauri-drag-region />
      <button className="cmdk-btn" onClick={() => window.dispatchEvent(new Event("open-cmdk"))} title="Search everything (Ctrl+K)">
        <Search size={13} />
        <span>Search</span>
        <kbd>Ctrl K</kbd>
      </button>
      <div className={"livepill" + (live ? " on" : "")} title={live ? "Minecraft has LongTerm open; Longevity follows along" : "Minecraft isn't running LongTerm"}>
        <span className="dot" />
        {live ? "Live" : "Offline"}
      </div>
      <div className="winbtns">
        <button onClick={() => win.minimize()} aria-label="Minimize">
          <Minus size={15} strokeWidth={1.6} />
        </button>
        <button onClick={() => win.toggleMaximize()} aria-label="Maximize">
          {max ? <Copy size={12} strokeWidth={1.6} style={{ transform: "scaleX(-1)" }} /> : <Square size={12} strokeWidth={1.6} />}
        </button>
        <button className="close" onClick={() => api.closeWindow()} aria-label="Close" title="Close (Longevity keeps running in the tray)">
          <X size={16} strokeWidth={1.6} />
        </button>
      </div>
    </div>
  );
}

function Sidebar() {
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  const world = useStore((s) => s.world);
  const setPicker = useStore((s) => s.setPicker);
  const dexNew = useStore((s) => s.dexNew);
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    if (!world) return;
    api.listWorlds().then((l) => setIcon(l.find((w) => w.path === world.path)?.icon ?? null));
  }, [world?.path]);
  const collapsed = useStore((s) => s.settings?.nav_collapsed ?? false);
  let lastGroup: string | undefined;
  return (
    <nav className={"sidebar" + (collapsed ? " collapsed" : "")}>
      {NAV.filter((n) => !n.needsWorld || world).map((n) => {
        const label = n.group && n.group !== lastGroup ? n.group : null;
        if (n.group) lastGroup = n.group;
        const I = n.icon;
        return (
          <div key={n.id} style={{ display: "contents" }}>
            {label && <div className="group-label">{label}</div>}
            <button
              className={"navitem" + (page === n.id ? " active" : "")}
              title={collapsed ? n.label : undefined}
              onMouseEnter={() => sfx.hover()}
              onClick={() => {
                if (page !== n.id) sfx.nav();
                setPage(n.id);
              }}
            >
              {page === n.id && <motion.div layoutId="navbg" className="bg" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
              <I />
              <span>{n.label}</span>
              {n.id === "dex" && dexNew > 0 && (
                <motion.span className="nav-badge" key={dexNew} initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 600, damping: 18 }}>
                  {dexNew > 99 ? "99+" : dexNew}
                </motion.span>
              )}
            </button>
          </div>
        );
      })}
      <div className="grow" />
      <button
        className={"navitem" + (page === "settings" ? " active" : "")}
        onMouseEnter={() => sfx.hover()}
        onClick={() => {
          sfx.nav();
          setPage("settings");
        }}
      >
        {page === "settings" && <motion.div layoutId="navbg" className="bg" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
        <Cog />
        <span>Settings</span>
      </button>
      {world && (
        <button
          className="worldcard"
          onClick={() => {
            sfx.open();
            setPicker(true);
          }}
          title="Switch world"
        >
          {icon ? <img src={icon} alt="" /> : <div className="noicon" style={{ backgroundImage: `url(${blockTex("block/grass_block_side")})`, backgroundSize: "cover" }} />}
          <div className="meta">
            <div className="name">{world.name || world.folder}</div>
            <div className="sub">{world.hardcore ? "HARDCORE · " : ""}DAY {world.day}</div>
          </div>
        </button>
      )}
      <div className="grass-strip px" style={{ backgroundImage: `url(${blockTex("block/grass_block_side")})` }} />
    </nav>
  );
}

function fmtSize(b: number) {
  if (b > 1e9) return (b / 1e9).toFixed(1) + " GB";
  return Math.max(1, Math.round(b / 1e6)) + " MB";
}

function WorldPicker({ onPick, closable }: { onPick: (w: WorldListItem) => void; closable: boolean }) {
  const [worlds, setWorlds] = useState<WorldListItem[] | null>(null);
  const setPicker = useStore((s) => s.setPicker);
  const current = useStore((s) => s.world?.path);
  useEffect(() => {
    api.listWorlds().then((w) => setWorlds(w.sort((a, b) => b.last_played - a.last_played)));
  }, []);
  const groups = useMemo(() => {
    const m = new Map<string, WorldListItem[]>();
    for (const w of worlds ?? []) {
      const k = w.instance || w.source;
      m.set(k, [...(m.get(k) ?? []), w]);
    }
    return [...m.entries()];
  }, [worlds]);
  return (
    <motion.div className="picker-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => closable && setPicker(false)}>
      <motion.div className="picker" initial={{ y: 16, opacity: 0, scale: 0.98 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: 10, opacity: 0 }} transition={{ duration: 0.28, ease: [0.22, 0.7, 0.18, 1] }} onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <div>
            <div className="pixlabel" style={{ color: "var(--accent)" }}>
              Choose a world
            </div>
            <h2>Which world should the Atlas read?</h2>
            <p className="dim">The Atlas only reads your saves. It never changes them, and it only shows what you've already seen.</p>
          </div>
          {closable && (
            <button className="iconbtn" onClick={() => setPicker(false)}>
              <X />
            </button>
          )}
        </div>
        <div className="picker-list">
          {!worlds && (
            <div style={{ padding: 30, display: "flex", gap: 10, alignItems: "center" }} className="dim">
              <Spinner /> Looking for worlds…
            </div>
          )}
          {groups.map(([inst, list]) => (
            <div key={inst} className="picker-group">
              <div className="pixlabel" style={{ padding: "4px 4px 8px" }}>
                {inst}
              </div>
              {list.map((w) => (
                <button
                  key={w.path}
                  className={"picker-item" + (w.path === current ? " cur" : "")}
                  onMouseEnter={() => sfx.hover()}
                  onClick={() => {
                    sfx.click();
                    onPick(w);
                  }}
                >
                  {w.icon ? <img src={w.icon} className="px" alt="" /> : <div className="noicon px" style={{ backgroundImage: `url(${blockTex("block/grass_block_side")})` }} />}
                  <div className="pi-meta">
                    <div className="pi-name">{w.name || w.folder}</div>
                    <div className="pi-sub">
                      {w.folder !== w.name && <span>{w.folder} · </span>}
                      {w.version || "?"} · {fmtSize(w.size)}
                    </div>
                  </div>
                  <div className="pi-when">{w.last_played ? fmtAgo(w.last_played) : ""}</div>
                </button>
              ))}
            </div>
          ))}
          {worlds && worlds.length === 0 && <div className="empty">No Minecraft worlds were found on this PC.</div>}
        </div>
      </motion.div>
    </motion.div>
  );
}

function Boot({ status, error }: { status: string; error?: string | null }) {
  return (
    <div className="boot">
      <div className="boot-inner">
        <Mark size={44} />
        <div className="boot-title">
          LongTerm <em>Atlas</em>
        </div>
        <div className="boot-status">
          {!error && <Spinner size={14} />}
          <span>{error ?? status}</span>
        </div>
      </div>
    </div>
  );
}

/** Test-only: steps like "lore|key=ArrowRight|key=ArrowRight" or "map|click=Parchment". Actions are
 * synthetic events inside this page only (nothing is sent to the OS). Each step titles the window
 * "tour:<step>" so an outside script knows when to take its screenshot. */
async function runTour(spec: string, ms: number, alive: () => boolean) {
  const sleep = (t: number) => new Promise((r) => setTimeout(r, t));
  const win = getCurrentWindow();
  for (const step of spec.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (!alive()) return;
    const [pg, ...acts] = step.split("|");
    if (pg) useStore.getState().setPage(pg as Page);
    await sleep(1800);
    for (const a of acts) {
      const [k, ...rest] = a.split("=");
      const v = rest.join("=");
      if (k === "key") {
        const code = v.length === 1 ? "Key" + v.toUpperCase() : v;
        window.dispatchEvent(new KeyboardEvent("keydown", { key: v, code, bubbles: true }));
        await sleep(60);
        window.dispatchEvent(new KeyboardEvent("keyup", { key: v, code, bubbles: true }));
      } else if (k === "click") {
        const el = [...document.querySelectorAll<HTMLElement>("button, [role=button], .navitem, .wall-item, .hit-head")].find((b) => b.textContent?.trim() === v || b.title === v);
        el?.click();
      } else if (k === "sel") {
        document.querySelector<HTMLElement>(v)?.click();
      } else if (k === "type") {
        const inp = document.querySelector<HTMLInputElement>("input.search input, input.input, .search input, input[type=search], input");
        if (inp) {
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
          set.call(inp, v);
          inp.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } else if (k === "wait") {
        await sleep(+v * 1000);
      }
      await sleep(900);
    }
    await win.setTitle("tour:" + step.replace(/[^a-z0-9]+/gi, "_").slice(0, 60));
    await sleep(ms);
  }
  await win.setTitle("tour:done");
}

export default function App() {
  const { info, world, page, pickerOpen, toast, photo } = useStore();
  useLauncherBoot();
  const st = useStore.getState;
  const [status, setStatus] = useState("Reading Minecraft's textures…");
  const [opening, setOpening] = useState(false);
  const dim = useStore((s) => s.dim);
  const explored = useStore((s) => s.explored);
  const capsule = useStore((s) => s.capsule);
  const pollRef = useRef<number | null>(null);

  // show the window once React has painted
  useEffect(() => {
    requestAnimationFrame(() => getCurrentWindow().show());
  }, []);

  // the desktop recap card was clicked while this window was already open
  useEffect(() => {
    const un = listen<{ id: string }>("open-recap", (e) => {
      invoke("t_take_recap").catch(() => {});
      useStore.setState({ page: "history", openRecap: e.payload.id });
    });
    const un3 = listen<{ text: string }>("sync-note", (e) => useLauncher.getState().toast(e.payload.text, "ok"));
    const un2 = listen("recap-new", () => {
      if (useStore.getState().page === "history") useStore.setState({ openRecap: null });
    });
    return () => {
      un.then((f) => f());
      un2.then((f) => f());
      un3.then((f) => f());
    };
  }, []);

  // boot: assets, then the last (or most recent) world
  useEffect(() => {
    let alive = true;
    (async () => {
      let i = await api.appInfo();
      st().setInfo(i);
      while (alive && !i.assets_ready && !i.assets_error) {
        await new Promise((r) => setTimeout(r, 250));
        i = await api.appInfo();
      }
      if (!alive) return;
      st().setInfo(i);
      if (i.assets_error) return;
      Engine.get().applyQuality(i.settings.quality || "high");
      Engine.get().setRenderDistance(i.settings.render_distance || 12);
      // while Minecraft runs, the 3D view goes light so the game keeps the memory
      const follow = (running: Record<string, number>) => Engine.get().setGameMode(Object.keys(running).length > 0);
      follow(useLauncher.getState().running);
      useLauncher.subscribe((s, prev) => s.running !== prev.running && follow(s.running));
      setStatus("Finding your worlds…");
      const worlds = await api.listWorlds();
      const oc = await api.takeOpenCard().catch(() => null);
      const pick =
        worlds.find((w) => samePath(w.path, oc?.world)) ??
        worlds.find((w) => /longterm/i.test(w.instance) && /^longevity \(1\)$/i.test(w.folder)) ??
        worlds.find((w) => w.path === i.settings.last_world) ??
        worlds.filter((w) => /longterm/i.test(w.instance)).sort((a, b) => b.last_played - a.last_played)[0] ??
        worlds.sort((a, b) => b.last_played - a.last_played)[0];
      if (pick) await openWorld(pick);
      else st().setPicker(true);
      if (oc && pick) st().openDexCard(oc.key);
      const rid = await invoke<string | null>("t_take_recap").catch(() => null);
      if (rid) useStore.setState({ page: "history", openRecap: rid });
      // test-only page tour (ATLAS_TEST_TOUR), used to screenshot every page hands-free
      if (i.test_tour) await runTour(i.test_tour, (i.test_interval ?? 12) * 1000, () => alive);
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function openWorld(w: WorldListItem) {
    setOpening(true);
    setStatus(`Opening ${w.name || w.folder}…`);
    st().setPicker(false);
    try {
      const s = await api.openWorld(w.path);
      const pdim = s.players[0]?.dim ?? "minecraft:overworld";
      useStore.setState({ explored: {}, dim: pdim, live: s.open });
      const e = await api.explored(pdim);
      st().setExplored(pdim, e);
      st().setWorld(s);
      // vanilla data for the game version this world runs (falls back to the newest bundled)
      api
        .appInfo()
        .then(async (i) => {
          const idx = await gd.index();
          const v = i.mc_version && idx.versions.includes(i.mc_version) ? i.mc_version : idx.latest;
          gd.setVersion(v);
          await gd.preload();
        })
        .catch(() => {});
    } catch (err) {
      st().toastMsg(String(err));
      st().setPicker(true);
    } finally {
      setOpening(false);
    }
  }

  // load explored data for the active dimension
  useEffect(() => {
    if (!world || explored[dim]) return;
    api.explored(dim).then((e) => st().setExplored(dim, e));
  }, [world?.path, dim]);

  // keep the engine in sync with the world
  const seen = useMemo(() => seenSet(explored[dim]), [explored[dim]]);
  const engineKey = useRef("");
  useEffect(() => {
    if (!world || !explored[dim]) return;
    const eng = Engine.get();
    const key = `${world.path}|${dim}|${capsule?.id ?? ""}`;
    if (engineKey.current !== key) {
      engineKey.current = key;
      let h = 0;
      for (const c of world.id) h = (h * 31 + c.charCodeAt(0)) | 0;
      eng.setWorld(dim, seen, regionSet(seen), Math.abs(h % 1000));
    } else eng.updateSeen(seen, regionSet(seen));
  }, [world?.path, dim, seen, capsule?.id]);

  useEffect(() => {
    if (!world || st().capsule) return;
    const eng = Engine.get();
    eng.setTime(world.day_time, world.open);
    eng.setWeather(world.raining, world.thundering);
  }, [world?.day_time, world?.raining, world?.thundering, world?.open]);

  // the in-game Atlas Companion: its "open Atlas" key, and fresh cards when you alt-tab back
  useEffect(() => {
    let lastStamp = Date.now();
    const un1 = listen<{ key: string; world: string | null }>("open-card", async (e) => {
      const { key, world: wp } = e.payload;
      if (wp && !samePath(wp, st().world?.path)) {
        const w = (await api.listWorlds()).find((x) => samePath(x.path, wp));
        if (w) await openWorld(w);
      }
      st().openDexCard(key);
    });
    const un2 = getCurrentWindow().onFocusChanged(async ({ payload }) => {
      if (!payload || !st().world) return;
      const s = await api.companionStamp().catch(() => 0);
      if (s > lastStamp) {
        lastStamp = s;
        if (st().page === "dex") st().reloadDex();
        else refreshDexBadge();
      }
    });
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
    };
  }, []);

  // the Dex badge in the sidebar (unopened cards), refreshed now and then
  useEffect(() => {
    if (!world) return;
    const t0 = setTimeout(refreshDexBadge, 6000);
    const t = setInterval(() => {
      if (st().page !== "dex" && st().live) refreshDexBadge();
    }, 180000);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [world?.path]);

  // live updates while Minecraft has the world open
  useEffect(() => {
    if (!world) return;
    let alive = true;
    const tick = async () => {
      try {
        const d = st().dim;
        const r = await api.poll(d);
        if (!alive) return;
        const prev = st().world;
        st().setWorld(r.summary);
        st().setLive(r.open);
        if (r.changed.length && !st().capsule) {
          st().pushChanged(d, r.changed);
          Engine.get().invalidate(r.changed);
          Engine.get().mobs.refresh();
          const e = await api.explored(d);
          if (alive) st().setExplored(d, e);
        }
        if (prev && prev.open && !r.open) st().toastMsg("Minecraft closed. Longevity has the final save.");
      } catch {
        /* ignore */
      }
      if (alive) pollRef.current = window.setTimeout(tick, st().live ? 5000 : 15000);
    };
    pollRef.current = window.setTimeout(tick, 4000);
    return () => {
      alive = false;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [world?.path]);

  const [toastShown, setToastShown] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    setToastShown(toast.text);
    const t = setTimeout(() => setToastShown(null), 4200);
    return () => clearTimeout(t);
  }, [toast?.n]);

  if (!info || (!world && !pickerOpen) || opening) {
    return (
      <div className="shell">
        <TitleBar />
        <div style={{ gridColumn: "1 / -1" }}>
          <Boot status={status} error={info?.assets_error} />
        </div>
        <NowPlaying />
      <AnimatePresence>{pickerOpen && <WorldPicker onPick={openWorld} closable={false} />}</AnimatePresence>
      </div>
    );
  }

  return (
    <div className={"shell" + (photo ? " photo" : "")}>
      <TitleBar />
      <Sidebar />
      <main className="content">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={page + (world?.path ?? "")}
            className="page"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.28, ease: [0.22, 0.7, 0.18, 1] }}
          >
            {world && page === "home" && <Home />}
            {page === "play" && <Play />}
            {page === "mods" && <Mods />}
            {page === "instances" && <Instances />}
            {page === "skins" && <Skins />}
            {page === "sync" && <Sync />}
            {world && page === "map" && <MapPage />}
            {world && page === "world" && <World3D />}
            {world && page === "storage" && <Storage />}
            {world && page === "stats" && <Stats />}
            {world && page === "dex" && <Dex />}
            {page === "history" && <History />}
            {page === "shots" && <Shots />}
            {page === "settings" && <SettingsPage />}
            {["villagers", "farms", "projects", "gear", "lookup", "changelog"].includes(page) && <ToolPage page={page} />}
          </motion.div>
        </AnimatePresence>
      </main>
      <NowPlaying />
      <CommandBar />
      <UpdateCard />
      <LauncherOverlays />
      <AnimatePresence>{pickerOpen && <WorldPicker onPick={openWorld} closable={!!world} />}</AnimatePresence>
      <AnimatePresence>
        {toastShown && (
          <motion.div className="toast" initial={{ opacity: 0, y: 12, x: "-50%" }} animate={{ opacity: 1, y: 0, x: "-50%" }} exit={{ opacity: 0, y: 8, x: "-50%" }}>
            {toastShown}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export { dimName };
export type { WorldSummary };
