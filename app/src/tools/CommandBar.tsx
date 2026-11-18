// Ctrl+K: one search bar for everything (pages, chests, the lookup, villagers' trades, farms,
// goals, settings). Tools register extra sources through `searchSources`.
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Search, CornerDownLeft, Package, FileText, Settings as Cog } from "lucide-react";
import { api, iconUrl, prettyId } from "../api";
import { useStore, type Page } from "../store";
import { sfx } from "../sound";

export interface Hit {
  key: string;
  group: string;
  title: string;
  sub?: string;
  icon?: string; // item id for an icon
  glyph?: "page" | "chest" | "setting";
  run: () => void;
}

/** Extra result sources (villagers, farms, goals, lookup...). Each returns hits for a query. */
export const searchSources: ((q: string) => Promise<Hit[]>)[] = [];

const PAGES: { id: Page; label: string; words: string; then?: () => void }[] = [
  { id: "home", label: "Home", words: "overview flyover glance" },
  { id: "play", label: "Play", words: "launch start game longterm astera" },
  { id: "mods", label: "Mods", words: "store modrinth updates backups rollback resource packs shaders datapacks" },
  { id: "instances", label: "Instances", words: "prism profiles new instance" },
  { id: "skins", label: "Skins", words: "closet editor capes" },
  { id: "sync", label: "Settings sync", words: "keybinds video options resource packs configs astera longterm same" },
  { id: "world", label: "3D World", words: "fly walk explore base" },
  { id: "world", label: "Try a resource pack", words: "texture pack preview compare faithful resourcepack", then: () => useStore.setState({ packPreview: true }) },
  { id: "map", label: "Map", words: "explored overworld nether end" },
  { id: "storage", label: "Storage", words: "chests search items storage doctor shulkers ender" },
  { id: "villagers", label: "Villagers", words: "trades roster cure mending librarian" },
  { id: "farms", label: "Farms", words: "farm check rates iron mob crop" },
  { id: "projects", label: "Projects", words: "goals planner beacon checklist" },
  { id: "gear", label: "Gear + Anvil", words: "enchants armor tools anvil planner too expensive" },
  { id: "lookup", label: "Lookup", words: "recipes drops loot mobs blocks items brewing enchanting" },
  { id: "changelog", label: "Hidden Changelog", words: "versions changes updates" },
  { id: "dex", label: "Dex", words: "cards collection packs" },
  { id: "stats", label: "Stats", words: "statistics timeline kills kill board" },
  { id: "history", label: "Play history", words: "sessions streak playtime heatmap" },
  { id: "shots", label: "Screenshots", words: "pictures gallery" },
  { id: "settings", label: "Settings", words: "theme quality sounds startup notifications" },
];

export function CommandBar() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const setPage = useStore((s) => s.setPage);
  const flyTo = useStore((s) => s.flyTo);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") setOpen(false);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-cmdk", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-cmdk", onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      sfx.open();
      setQ("");
      setSel(0);
      setTimeout(() => input.current?.focus(), 20);
    }
  }, [open]);

  const pageHits = useMemo<Hit[]>(() => {
    const s = q.trim().toLowerCase();
    return PAGES.filter((p) => !s || p.label.toLowerCase().includes(s) || p.words.includes(s)).map((p) => ({
      key: "page:" + p.id + ":" + p.label,
      group: "Go to",
      title: p.label,
      glyph: "page" as const,
      run: () => {
        setPage(p.id);
        p.then?.();
      },
    }));
  }, [q]);

  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) {
      setHits([]);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      const out: Hit[] = [];
      const world = useStore.getState().world;
      if (world) {
        const r = await api.searchItems(s).catch(() => null);
        for (const h of r?.hits?.slice(0, 6) ?? []) {
          const m = h.matches[0];
          out.push({
            key: "chest:" + h.container,
            group: "In your chests",
            title: `${m ? (r?.names?.[m[0]] ?? m[0]) : "Items"} × ${h.total}`,
            sub: `${h.name ?? prettyId(h.kind)} at ${h.pos.join(", ")}`,
            icon: m?.[0],
            glyph: "chest",
            run: () => {
              setPage("storage");
              useStore.setState({ storageQuery: s } as any);
              flyTo({ x: h.pos[0], y: h.pos[1], z: h.pos[2], dim: h.dim });
            },
          });
        }
      }
      for (const src of searchSources) {
        try {
          out.push(...(await src(s)));
        } catch {
          /* a source failing never breaks the bar */
        }
      }
      if (alive) {
        setHits(out);
        setSel(0);
      }
    }, 140);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  const all = [...pageHits.slice(0, q ? 6 : 19), ...hits];
  const groups: [string, Hit[]][] = [];
  for (const h of all) {
    const g = groups.find((x) => x[0] === h.group);
    if (g) g[1].push(h);
    else groups.push([h.group, [h]]);
  }
  const flat = groups.flatMap((g) => g[1]);

  function pick(h: Hit | undefined) {
    if (!h) return;
    sfx.click();
    setOpen(false);
    h.run();
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="cmdk-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={() => setOpen(false)}>
          <motion.div
            className="cmdk glass"
            initial={{ opacity: 0, y: -14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 520, damping: 36 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="cmdk-in">
              <Search size={17} />
              <input
                ref={input}
                value={q}
                placeholder="Search chests, items, villagers, farms, goals, pages…"
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSel((s) => Math.min(flat.length - 1, s + 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSel((s) => Math.max(0, s - 1));
                  } else if (e.key === "Enter") pick(flat[sel]);
                }}
              />
              <kbd>Esc</kbd>
            </div>
            <div className="cmdk-list">
              {groups.map(([g, list]) => (
                <div key={g}>
                  <div className="cmdk-group">{g}</div>
                  {list.map((h) => {
                    const i = flat.indexOf(h);
                    return (
                      <button key={h.key} className={"cmdk-item" + (i === sel ? " on" : "")} onMouseEnter={() => setSel(i)} onClick={() => pick(h)}>
                        <span className="cmdk-ic">
                          {h.icon ? <img className="px" src={iconUrl(h.icon)} alt="" /> : h.glyph === "chest" ? <Package size={15} /> : h.glyph === "setting" ? <Cog size={15} /> : <FileText size={15} />}
                        </span>
                        <span className="cmdk-t">{h.title}</span>
                        {h.sub && <span className="cmdk-s">{h.sub}</span>}
                        {i === sel && <CornerDownLeft size={13} className="cmdk-enter" />}
                      </button>
                    );
                  })}
                </div>
              ))}
              {flat.length === 0 && <div className="cmdk-empty">Nothing found for “{q}”.</div>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
