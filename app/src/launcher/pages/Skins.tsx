import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Plus, Upload, RefreshCw, Star, Trash2, Shirt, Loader2, Footprints, Hand, PersonStanding, UserRound, Pencil, Check, Brush, MapPin, Users } from "lucide-react";
import { api, capeUrl, errText, fmtAgo, skinUrl, type Profile, type Skin, type SkinSeen } from "../api";
import { useStore } from "../store";
import { useStore as useMain } from "../../store";
import SkinEditor from "./SkinEditor";
import { SkinViewer, faceView, frontView } from "../../render/skinview";
import { sfx } from "../../sound";

const fmtDay = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function Face({ skin }: { skin?: Skin }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (skin) faceView(skinUrl(skin.id)).then(setSrc).catch(() => {});
  }, [skin?.id]);
  return src ? <img src={src} className="px face" /> : <UserRound size={14} />;
}

function Paper({ skin }: { skin: Skin }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    frontView(skinUrl(skin.id), skin.model === "slim")
      .then(setSrc)
      .catch(() => setSrc(null));
  }, [skin.id, skin.model]);
  return <div className="paper">{src ? <img src={src} className="px" /> : <div className="skeleton" style={{ width: 40, height: 80 }} />}</div>;
}

function Stage({ skin, pose }: { skin: Skin | null; pose: "idle" | "walk" | "wave" }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<SkinViewer | null>(null);
  useEffect(() => {
    if (!host.current) return;
    viewer.current = new SkinViewer(host.current);
    return () => viewer.current?.dispose();
  }, []);
  useEffect(() => {
    if (skin && viewer.current) viewer.current.load(skinUrl(skin.id), skin.model === "slim", skin.cape ? capeUrl(skin.id) : null).catch(() => {});
  }, [skin?.id, skin?.model]);
  useEffect(() => {
    if (viewer.current) viewer.current.pose = pose;
  }, [pose]);
  return (
    <div className="stage">
      <div className="stage-glow" />
      <div className="stage-floor" />
      <div className="stage-host" ref={host} />
    </div>
  );
}

export default function Skins() {
  const [skins, setSkins] = useState<Skin[] | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pose, setPose] = useState<"idle" | "walk" | "wave">("idle");
  const [rename, setRename] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [history, setHistory] = useState<SkinSeen[]>([]);
  const [filter, setFilter] = useState<"all" | "mine" | "friends" | "favorites">("all");
  const [editing, setEditing] = useState<Skin | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const toast = useStore((s) => s.toast);

  /** Your accounts + every friend: pick up new skins (and note them in the history). */
  const refresh = async (quiet = false) => {
    setRefreshing(true);
    try {
      const r = await api.skinsRefresh();
      setSkins(r.skins);
      setHistory(r.history);
      try {
        localStorage.setItem("lv.skins.refreshed", String(Date.now()));
      } catch {
        /* private mode */
      }
      if (r.changed.length) toast(`New skin${r.changed.length > 1 ? "s" : ""} from ${r.changed.join(", ")}`, "ok");
      else if (!quiet) toast("Everyone's skins are up to date.", "info");
    } catch (e) {
      if (!quiet) toast(errText(e), "err");
    }
    setRefreshing(false);
  };

  const load = async () => {
    const r = await api.skins().catch(() => ({ skins: [], profiles: [] }));
    setSkins(r.skins);
    setProfiles(r.profiles);
    if (!sel && r.skins[0]) setSel(r.skins[0].id);
    return r;
  };
  useEffect(() => {
    load().then((r) => {
      // first visit: bring in the skins your accounts wear
      if (r.skins.length === 0 && r.profiles.length) sync();
      else {
        // otherwise look for new skins on you and your friends a few times a day
        let last = 0;
        try {
          last = Number(localStorage.getItem("lv.skins.refreshed") ?? 0);
        } catch {
          /* private mode */
        }
        if (Date.now() - last > 6 * 3600_000) refresh(true);
      }
    });
    api.skinsHistory().then(setHistory).catch(() => {});
    const un = getCurrentWebview().onDragDropEvent(async (e) => {
      if (e.payload.type === "over" || e.payload.type === "enter") setDropping(true);
      else if (e.payload.type === "leave") setDropping(false);
      else if (e.payload.type === "drop") {
        setDropping(false);
        for (const p of e.payload.paths.filter((p) => p.toLowerCase().endsWith(".png"))) await importPath(p);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const sync = async () => {
    setSyncing(true);
    try {
      const l = await api.skinsSync();
      setSkins(l);
      if (l[0]) setSel((s) => s ?? l[0].id);
    } catch (e) {
      toast(errText(e), "err");
    }
    setSyncing(false);
  };
  const add = async () => {
    if (!name.trim()) return;
    setAdding(true);
    try {
      const s = await api.skinAddPlayer(name.trim());
      sfx.chime();
      setName("");
      await load();
      setSel(s.id);
    } catch (e) {
      toast(errText(e), "err");
    }
    setAdding(false);
  };
  const importPath = async (p: string) => {
    try {
      const s = await api.skinImport(p);
      sfx.chime();
      await load();
      setSel(s.id);
    } catch (e) {
      toast(errText(e), "err");
    }
  };
  const pick = async () => {
    const p = await openDialog({ filters: [{ name: "Minecraft skin", extensions: ["png"] }], multiple: false });
    if (typeof p === "string") importPath(p);
  };

  const skin = skins?.find((s) => s.id === sel) ?? null;
  const sorted = useMemo(
    () =>
      [...(skins ?? [])]
        .filter((s) => (filter === "all" ? true : filter === "friends" ? s.source.startsWith("player:") : filter === "favorites" ? s.favorite : !s.source.startsWith("player:")))
        .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.added - a.added),
    [skins, filter],
  );
  // friends: everyone added by name, newest skin first
  const friends = useMemo(() => {
    const m = new Map<string, Skin>();
    for (const s of [...(skins ?? [])].sort((a, b) => b.added - a.added)) {
      if (!s.source.startsWith("player:")) continue;
      const n = s.source.slice(7);
      const latest = history.filter((h) => h.who === s.source).sort((a, b) => b.last - a.last)[0];
      const cur = latest ? (skins ?? []).find((x) => x.id === latest.id) : null;
      if (!m.has(n.toLowerCase())) m.set(n.toLowerCase(), cur ?? s);
    }
    return [...m.values()];
  }, [skins, history]);
  // whose history to show: the selected skin's owner, or your accounts
  const owner = skin && (skin.source.startsWith("player:") || skin.source.startsWith("account:")) ? skin.source : null;
  const timeline = useMemo(() => {
    const h = history.filter((x) => (owner ? x.who === owner : x.who.startsWith("account:")));
    return h.sort((a, b) => b.first - a.first).slice(0, 12);
  }, [history, owner]);
  const tryOn = () => {
    if (!skin) return;
    sfx.click();
    useMain.setState({ tryOn: { url: skinUrl(skin.id), slim: skin.model === "slim", name: skin.name } });
    useMain.getState().setPage("world");
  };
  const accountIds = useMemo(() => new Set((skins ?? []).filter((s) => s.source.startsWith("account:")).map((s) => s.id)), [skins]);

  const update = async (patch: { name?: string; model?: string; favorite?: boolean }) => {
    if (!skin) return;
    try {
      setSkins(await api.skinUpdate(skin.id, patch));
    } catch (e) {
      toast(errText(e), "err");
    }
  };
  const del = async () => {
    if (!skin) return;
    const l = await api.skinDelete(skin.id);
    setSkins(l);
    setSel(l[0]?.id ?? null);
  };
  const wear = async () => {
    if (!skin) return;
    sfx.click();
    try {
      await api.skinWear(skin.id);
      toast("Saved to Downloads and opened minecraft.net. Upload it there to wear it everywhere.", "ok");
    } catch (e) {
      toast(errText(e), "err");
    }
  };

  return (
    <div className="page skins-page">
      <div className="skins-left">
        <Stage skin={skin} pose={pose} />
        <AnimatePresence mode="wait">
          {skin ? (
            <motion.div key={skin.id} className="skin-info" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22 }}>
              <div className="skin-name">
                {rename !== null ? (
                  <input
                    className="input"
                    autoFocus
                    value={rename}
                    onChange={(e) => setRename(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        update({ name: rename });
                        setRename(null);
                      } else if (e.key === "Escape") setRename(null);
                    }}
                    onBlur={() => {
                      update({ name: rename });
                      setRename(null);
                    }}
                  />
                ) : (
                  <h2 onDoubleClick={() => setRename(skin.name)}>
                    {skin.name}
                    <button className="iconlink" onClick={() => setRename(skin.name)} title="Rename">
                      <Pencil size={13} />
                    </button>
                  </h2>
                )}
                <div className="muted small">
                  {skin.source.startsWith("account:") ? "Your account's skin" : skin.source.startsWith("player:") ? `${skin.source.slice(7)}'s skin` : "Imported file"} · added {fmtAgo(skin.added)}
                  {skin.cape && " · has a cape"}
                </div>
              </div>
              <div className="skin-row">
                <div className="seg">
                  {(["classic", "slim"] as const).map((m) => (
                    <button key={m} className={skin.model === m ? "on" : ""} onClick={() => update({ model: m })}>
                      {m === "classic" ? "Wide arms" : "Slim arms"}
                    </button>
                  ))}
                </div>
                <div className="seg">
                  {(
                    [
                      ["idle", PersonStanding],
                      ["walk", Footprints],
                      ["wave", Hand],
                    ] as const
                  ).map(([p, I]) => (
                    <button key={p} className={pose === p ? "on" : ""} onClick={() => setPose(p)} title={p}>
                      <I size={14} />
                    </button>
                  ))}
                </div>
              </div>
              <div className="skin-row">
                <button className="btn" onClick={() => (sfx.open(), setEditing(skin))} title="Paint on it in 3D (saves a copy)">
                  <Brush /> Edit
                </button>
                <button className="btn" onClick={tryOn} title="Walk around your base wearing it, in your real gear">
                  <MapPin /> Try on in your base
                </button>
              </div>
              <div className="skin-row">
                <button className="btn primary" onClick={wear}>
                  <Shirt /> Wear this skin
                </button>
                <button className={"iconbtn" + (skin.favorite ? " fav" : "")} onClick={() => update({ favorite: !skin.favorite })} title="Favorite">
                  <Star fill={skin.favorite ? "currentColor" : "none"} />
                </button>
                <button className="iconbtn" onClick={del} title="Remove from closet">
                  <Trash2 />
                </button>
              </div>
            </motion.div>
          ) : (
            <div className="skin-info muted">Add a skin to start your closet.</div>
          )}
        </AnimatePresence>
        {timeline.length > 0 && (
          <div className="skin-hist">
            <div className="sh-title">{owner?.startsWith("player:") ? `${owner.slice(7)}'s skins over time` : "Your skins over time"}</div>
            <div className="sh-row">
              {timeline.map((h) => {
                const s = skins?.find((x) => x.id === h.id);
                return (
                  <button key={h.who + h.id} className={"sh-item" + (h.id === sel ? " on" : "")} disabled={!s} onClick={() => s && (sfx.click(), setSel(s.id))} title={s ? s.name : "Removed from the closet"}>
                    {s ? <Face skin={s} /> : <UserRound size={14} />}
                    <span>{h.first === h.last ? fmtDay(h.first) : `${fmtDay(h.first)} – ${fmtDay(h.last)}`}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="skins-right">
        <div className="page-head">
          <div>
            <h1>Skin closet</h1>
            <p className="muted">Keep every skin you like, try them on in 3D, then wear one with a click.</p>
          </div>
        </div>
        <div className="addbar">
          <div className="search">
            <UserRound size={15} />
            <input placeholder="Add any player's skin by their name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          </div>
          <button className="btn" onClick={add} disabled={adding || !name.trim()}>
            {adding ? <Loader2 className="spin" /> : <Plus />} Add
          </button>
          <button className="btn ghost" onClick={pick}>
            <Upload /> Import PNG
          </button>
          <button className="btn ghost" onClick={sync} disabled={syncing} title="Bring in the skins your Prism accounts wear">
            <RefreshCw className={syncing ? "spin" : ""} /> My accounts
          </button>
        </div>
        {profiles.length > 0 && (
          <div className="accounts">
            {profiles.map((p) => (
              <span key={p.id} className={"acct" + (p.active ? " on" : "")}>
                <Face skin={skins?.find((s) => s.source === `account:${p.name}`)} />
                {p.name}
                {p.active && <Check size={12} />}
              </span>
            ))}
          </div>
        )}
        {friends.length > 0 && (
          <div className="friends">
            <Users size={14} className="muted" />
            {friends.map((f) => (
              <button key={f.source} className={"friend" + (skin?.source === f.source ? " on" : "")} onClick={() => (sfx.click(), setSel(f.id))} title={`${f.source.slice(7)}'s newest skin`}>
                <Face skin={f} />
                {f.source.slice(7)}
              </button>
            ))}
            <button className="iconlink" onClick={() => refresh(false)} disabled={refreshing} title="Check everyone for new skins">
              <RefreshCw size={13} className={refreshing ? "spin" : ""} />
            </button>
          </div>
        )}
        <div className="closet-filter">
          {(
            [
              ["all", "All"],
              ["mine", "Mine"],
              ["friends", "Friends"],
              ["favorites", "Favorites"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={"chip" + (filter === k ? " on" : "")} onClick={() => (sfx.click(), setFilter(k))}>
              {l}
            </button>
          ))}
        </div>
        <div className={"closet" + (dropping ? " dropping" : "")}>
          {!skins && Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 150, borderRadius: 12 }} />)}
          <AnimatePresence>
            {sorted.map((s, i) => (
              <motion.button
                key={s.id}
                layout
                className={"skincard" + (s.id === sel ? " on" : "")}
                onClick={() => {
                  sfx.click();
                  setSel(s.id);
                }}
                onMouseEnter={() => sfx.hover()}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1, transition: { delay: Math.min(i, 16) * 0.03 } }}
                exit={{ opacity: 0, scale: 0.9 }}
                whileHover={{ y: -4 }}
              >
                {s.id === sel && <motion.span layoutId="skinsel" className="skincard-sel" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
                <Paper skin={s} />
                <span className="sn">
                  {s.favorite && <Star size={11} fill="currentColor" className="favstar" />}
                  {s.name}
                </span>
                {accountIds.has(s.id) && <span className="sbadge">Account</span>}
              </motion.button>
            ))}
          </AnimatePresence>
          {dropping && <div className="drophint">Drop PNG skins to add them</div>}
        </div>
      </div>
      <AnimatePresence>
        {editing && (
          <SkinEditor
            key={editing.id}
            skin={editing}
            onClose={() => setEditing(null)}
            onSaved={async (s) => {
              setEditing(null);
              await load();
              setSel(s.id);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
