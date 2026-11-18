import { useFinder } from "../finder";
import { Fragment, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Search, Check, Trash2, ExternalLink, ArrowUpCircle, History, Bug, Package, Loader2, RefreshCw, FolderOpen, Undo2, ArrowRight, Blocks, Palette, Sparkles, X, ShieldCheck, Download } from "lucide-react";
import { api, errText, fmtAgo, fmtBytes, fmtNum, loaderName, modIconUrl, packIconUrl, type Backup, type CrashItem, type CrashReport, type InstalledMod, type Pack, type UpdateInfo } from "../api";
import Store, { MiniMarkdown } from "./Store";
import { useStore } from "../store";
import { Switch } from "../../ui";
import { sfx } from "../../sound";

type Tab = "installed" | "store" | "updates" | "backups";

function ModIcon({ inst, m, size = 38 }: { inst: string; m: InstalledMod; size?: number }) {
  const [src, setSrc] = useState(m.modrinth?.icon_url || (m.meta.icon ? modIconUrl(inst, m.file) : null));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setSrc(m.modrinth?.icon_url || (m.meta.icon ? modIconUrl(inst, m.file) : null));
    setFailed(false);
  }, [m.file, m.modrinth?.icon_url]);
  return (
    <span className="micon" style={{ width: size, height: size }}>
      {src && !failed ? (
        <img
          src={src}
          className="px"
          onError={() => {
            if (m.meta.icon && src !== modIconUrl(inst, m.file)) setSrc(modIconUrl(inst, m.file));
            else setFailed(true);
          }}
        />
      ) : (
        <span className="mletter">{(m.meta.name || m.file).charAt(0).toUpperCase()}</span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- installed

function InstalledMods({ inst }: { inst: string }) {
  const [mods, setMods] = useState<InstalledMod[] | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "on" | "off">("all");
  const [identifying, setIdentifying] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const toast = useStore((s) => s.toast);
  const load = async () => {
    const m = await api.mods(inst).catch(() => []);
    setMods(m);
    if (m.some((x) => !x.modrinth)) {
      setIdentifying(true);
      api
        .modsIdentify(inst)
        .then(setMods)
        .catch(() => {})
        .finally(() => setIdentifying(false));
    }
  };
  useEffect(() => {
    setMods(null);
    load();
  }, [inst]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (mods ?? [])
      .filter((m) => (filter === "all" ? true : filter === "on" ? m.enabled : !m.enabled))
      .filter((m) => !s || m.meta.name.toLowerCase().includes(s) || m.file.toLowerCase().includes(s) || m.meta.id.toLowerCase().includes(s) || m.meta.authors.join(" ").toLowerCase().includes(s))
      .sort((a, b) => (a.meta.name || a.file).localeCompare(b.meta.name || b.file));
  }, [mods, q, filter]);
  const toggle = async (m: InstalledMod, on: boolean) => {
    sfx.click();
    try {
      const file = await api.toggleMod(inst, m.file, on);
      setMods((ms) => ms?.map((x) => (x.file === m.file ? { ...x, file, enabled: on } : x)) ?? null);
    } catch (e) {
      toast(errText(e), "err");
    }
  };
  const remove = async (m: InstalledMod) => {
    try {
      await api.removeMod(inst, m.file);
      toast(`Removed ${m.meta.name}. It's in the Recycle Bin and in Backups.`, "ok");
      setMods((ms) => ms?.filter((x) => x.file !== m.file) ?? null);
    } catch (e) {
      toast(errText(e), "err");
    }
    setConfirm(null);
  };
  const on = mods?.filter((m) => m.enabled).length ?? 0;
  return (
    <div className="mods-installed">
      <div className="toolbar">
        <div className="search">
          <Search size={15} />
          <input placeholder={`Search ${mods?.length ?? ""} mods`} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="seg">
          {(["all", "on", "off"] as const).map((f) => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
              {f === "all" ? `All ${mods?.length ?? ""}` : f === "on" ? `On ${on}` : `Off ${(mods?.length ?? 0) - on}`}
            </button>
          ))}
        </div>
        <div className="grow" />
        {identifying && (
          <span className="muted small flex">
            <Loader2 size={13} className="spin" /> Matching with Modrinth…
          </span>
        )}
        <button className="btn sm ghost" onClick={() => api.openFolder(inst, "mods")}>
          <FolderOpen /> Mods folder
        </button>
      </div>
      {!mods && (
        <div className="modlist">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 62 }} />
          ))}
        </div>
      )}
      {mods && mods.length === 0 && (
        <div className="empty-big">
          <Package size={30} />
          <h3>No mods yet</h3>
          <p>Find some in the store. Each install is backed up first.</p>
          <button className="btn primary" onClick={() => useStore.setState({ modsTab: "store" })}>
            Open the store
          </button>
        </div>
      )}
      <div className="modlist">
        <AnimatePresence initial={false}>
          {shown.map((m, i) => (
            <motion.div
              key={m.sha1 || m.file}
              layout="position"
              className={"modrow" + (m.enabled ? "" : " off")}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 20) * 0.015 } }}
              exit={{ opacity: 0, x: -20, transition: { duration: 0.2 } }}
            >
              <ModIcon inst={inst} m={m} />
              <div className="t">
                <b>
                  {m.meta.name || m.file}
                  <span className="ver">{m.modrinth?.version_number || m.meta.version}</span>
                </b>
                <i>{m.meta.description || (m.meta.authors.length ? `by ${m.meta.authors.join(", ")}` : m.file)}</i>
              </div>
              <div className="modrow-meta">
                {m.meta.authors.length > 0 && <span className="muted">{m.meta.authors.slice(0, 2).join(", ")}</span>}
                <span className="muted">{fmtBytes(m.size)}</span>
              </div>
              <div className="modrow-actions">
                {m.modrinth && (
                  <button className="iconbtn sm" title="Open on Modrinth" onClick={() => api.openUrl(`https://modrinth.com/mod/${m.modrinth!.slug}`)}>
                    <ExternalLink />
                  </button>
                )}
                <AnimatePresence mode="wait">
                  {confirm === m.file ? (
                    <motion.div key="c" className="confirm" initial={{ opacity: 0, width: 0 }} animate={{ opacity: 1, width: "auto" }} exit={{ opacity: 0, width: 0 }}>
                      <button className="btn sm danger" onClick={() => remove(m)}>
                        Remove
                      </button>
                      <button className="btn sm ghost" onClick={() => setConfirm(null)}>
                        Keep
                      </button>
                    </motion.div>
                  ) : (
                    <motion.button key="d" className="iconbtn sm" title="Remove" onClick={() => setConfirm(m.file)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      <Trash2 />
                    </motion.button>
                  )}
                </AnimatePresence>
                <Switch on={m.enabled} onChange={(v) => toggle(m, v)} />
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}


function PacksList({ inst, kind }: { inst: string; kind: "resourcepack" | "shader" }) {
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [q, setQ] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const toast = useStore((s) => s.toast);
  const load = () =>
    api
      .packs(inst, kind)
      .then(setPacks)
      .catch(() => setPacks([]));
  useEffect(() => {
    setPacks(null);
    load();
  }, [inst, kind]);
  const shown = (packs ?? []).filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()));
  const noun = kind === "shader" ? "shader packs" : "resource packs";
  const toggle = async (p: Pack, on: boolean) => {
    sfx.toggle(on);
    try {
      await api.packToggle(inst, p.file, on);
      setPacks((ps) => ps?.map((x) => (x.file === p.file ? { ...x, enabled: on } : x)) ?? null);
    } catch (e) {
      toast(errText(e), "err");
    }
  };
  const useShader = async (p: Pack) => {
    sfx.click();
    try {
      await api.packUseShader(inst, p.file);
      setPacks((ps) => ps?.map((x) => ({ ...x, enabled: x.file === p.file })) ?? null);
      toast(`Shaders mode uses ${p.name} now`, "ok");
    } catch (e) {
      toast(errText(e), "err");
    }
  };
  const remove = async (p: Pack) => {
    try {
      await api.packDelete(inst, kind, p.file);
      toast(`Moved ${p.name} to the Recycle Bin`, "ok");
      setPacks((ps) => ps?.filter((x) => x.file !== p.file) ?? null);
    } catch (e) {
      toast(errText(e), "err");
    }
    setConfirm(null);
  };
  return (
    <div className="mods-installed">
      <div className="toolbar">
        <div className="search">
          <Search size={15} />
          <input placeholder={packs?.length === 1 ? `Search 1 ${noun.replace(/s$/, "")}` : `Search ${packs?.length ?? ""} ${noun}`} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="grow" />
        <button
          className="btn sm"
          onClick={() => {
            sfx.click();
            useStore.setState({ modsTab: "store", storeKind: kind });
          }}
        >
          <Search /> Find more
        </button>
        <button className="btn sm ghost" onClick={() => api.openFolder(inst, kind === "shader" ? "shaderpacks" : "resourcepacks")}>
          <FolderOpen /> Folder
        </button>
      </div>
      {kind === "resourcepack" && packs && packs.length > 0 && <div className="dnote">Packs you turn on go on top of the others. Changes wait until the game is closed.</div>}
      {!packs && (
        <div className="modlist">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 62 }} />
          ))}
        </div>
      )}
      {packs && packs.length === 0 && (
        <div className="empty-big">
          {kind === "shader" ? <Sparkles size={30} /> : <Palette size={30} />}
          <h3>No {noun} yet</h3>
          <p>{kind === "shader" ? "Shaders from the store come with Iris set up for you." : "Download some from the store, then turn them on here."}</p>
          <button className="btn primary" onClick={() => useStore.setState({ modsTab: "store", storeKind: kind })}>
            Open the store
          </button>
        </div>
      )}
      <div className="modlist">
        <AnimatePresence initial={false}>
          {shown.map((p, i) => (
            <motion.div
              key={p.file}
              layout="position"
              className={"modrow" + (p.enabled || kind === "shader" ? "" : " off")}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 20) * 0.015 } }}
              exit={{ opacity: 0, x: -20, transition: { duration: 0.2 } }}
            >
              <PackIcon inst={inst} kind={kind} p={p} />
              <div className="t">
                <b>{p.name}</b>
                <i>{p.description || p.file}</i>
              </div>
              <div className="modrow-meta">
                <span className="muted">{fmtBytes(p.size)}</span>
              </div>
              <div className="modrow-actions">
                <AnimatePresence mode="wait">
                  {confirm === p.file ? (
                    <motion.div key="c" className="confirm" initial={{ opacity: 0, width: 0 }} animate={{ opacity: 1, width: "auto" }} exit={{ opacity: 0, width: 0 }}>
                      <button className="btn sm danger" onClick={() => remove(p)}>
                        Delete
                      </button>
                      <button className="btn sm ghost" onClick={() => setConfirm(null)}>
                        Keep
                      </button>
                    </motion.div>
                  ) : (
                    <motion.button key="d" className="iconbtn sm" title="Delete" onClick={() => setConfirm(p.file)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      <Trash2 />
                    </motion.button>
                  )}
                </AnimatePresence>
                {kind === "resourcepack" ? (
                  <Switch on={p.enabled} onChange={(v) => toggle(p, v)} />
                ) : p.enabled ? (
                  <span className="inuse">
                    <Check size={13} /> Shaders mode
                  </span>
                ) : (
                  <button className="btn sm" onClick={() => useShader(p)}>
                    Use in Shaders mode
                  </button>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function PackIcon({ inst, kind, p }: { inst: string; kind: string; p: Pack }) {
  const [bad, setBad] = useState(false);
  return (
    <span className="micon" style={{ width: 38, height: 38 }}>
      {!bad ? <img src={packIconUrl(inst, kind, p.file)} className="px" onError={() => setBad(true)} /> : <span className="mletter">{kind === "shader" ? <Sparkles size={16} /> : p.name.charAt(0).toUpperCase()}</span>}
    </span>
  );
}

function Installed({ inst }: { inst: string }) {
  const [kind, setKind] = useState<"mod" | "resourcepack" | "shader">("mod");
  return (
    <>
      <div className="seg kindseg">
        {(
          [
            ["mod", "Mods", Blocks],
            ["resourcepack", "Resource packs", Palette],
            ["shader", "Shader packs", Sparkles],
          ] as const
        ).map(([k, l, I]) => (
          <button
            key={k}
            className={kind === k ? "on" : ""}
            onClick={() => {
              sfx.click();
              setKind(k);
            }}
          >
            <I size={13} /> {l}
          </button>
        ))}
      </div>
      {kind === "mod" ? <InstalledMods inst={inst} /> : <PacksList inst={inst} kind={kind} />}
    </>
  );
}

// ---------------------------------------------------------------- updates

function Updates({ inst }: { inst: string }) {
  const [ups, setUps] = useState<UpdateInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string[] | null>(null);
  const toast = useStore((s) => s.toast);
  const load = () => {
    setUps(null);
    setErr(null);
    api
      .updates(inst)
      .then((u) => {
        setUps(u);
        setPick(new Set(u.map((x) => x.file)));
      })
      .catch((e) => setErr(errText(e)));
  };
  useEffect(load, [inst]);
  const apply = async () => {
    if (!ups) return;
    setBusy(true);
    sfx.click();
    try {
      const picks = ups.filter((u) => pick.has(u.file)).map((u) => [u.file, u.version_id] as [string, string]);
      const files = await api.applyUpdates(inst, picks);
      setDone(files);
      sfx.chime();
      toast(`Updated ${files.length} mod${files.length === 1 ? "" : "s"}. Backups has the old ones.`, "ok");
      setUps(ups.filter((u) => !pick.has(u.file)));
    } catch (e) {
      toast(errText(e), "err");
    }
    setBusy(false);
  };
  return (
    <div className="updates">
      <div className="upd-hero glass-soft">
        <ShieldCheck size={22} />
        <div>
          <b>Safe updates</b>
          <p>Before anything changes, Mio copies your whole mods folder into Backups. If the game crashes after an update, one click puts everything back.</p>
        </div>
        <button className="btn sm ghost" onClick={load}>
          <RefreshCw /> Check again
        </button>
      </div>
      {err && <div className="dnote err">{err}</div>}
      {!ups && !err && (
        <div className="checking">
          <Loader2 className="spin" /> Asking Modrinth about every mod…
        </div>
      )}
      {ups && ups.length === 0 && (
        <motion.div className="allgood" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}>
          <Check size={30} />
          <h3>Everything's up to date</h3>
          {done && <p>{done.length} mods were just updated.</p>}
        </motion.div>
      )}
      {ups && ups.length > 0 && (
        <>
          <div className="toolbar">
            <span className="muted">
              {ups.length} update{ups.length === 1 ? "" : "s"} for this instance
            </span>
            <div className="grow" />
            <button className="btn sm ghost" onClick={() => setPick(pick.size === ups.length ? new Set() : new Set(ups.map((u) => u.file)))}>
              {pick.size === ups.length ? "Pick none" : "Pick all"}
            </button>
            <button className="btn primary" onClick={apply} disabled={busy || pick.size === 0}>
              {busy ? <Loader2 className="spin" /> : <ArrowUpCircle />}
              {busy ? "Backing up and updating…" : `Update ${pick.size}`}
            </button>
          </div>
          <div className="modlist">
            {ups.map((u, i) => (
              <Fragment key={u.file}>
                <motion.div className={"modrow upd" + (pick.has(u.file) ? "" : " off")} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
                  <button
                    className={"check" + (pick.has(u.file) ? " on" : "")}
                    onClick={() => {
                      const n = new Set(pick);
                      n.has(u.file) ? n.delete(u.file) : n.add(u.file);
                      setPick(n);
                    }}
                  >
                    {pick.has(u.file) && <Check size={12} />}
                  </button>
                  <span className="micon">{u.icon_url ? <img src={u.icon_url} /> : <span className="mletter">{u.name[0]}</span>}</span>
                  <div className="t">
                    <b>{u.name}</b>
                    <i className="vers">
                      <span>{u.from}</span>
                      <ArrowRight size={12} />
                      <span className="to">{u.to}</span>
                      <span className="muted"> · {fmtAgo(Date.parse(u.date))}</span>
                    </i>
                  </div>
                  {u.changelog && (
                    <button className="btn sm ghost" onClick={() => setOpenLog(openLog === u.file ? null : u.file)}>
                      What's new
                    </button>
                  )}
                </motion.div>
                <AnimatePresence>
                  {openLog === u.file && (
                    <motion.div className="changelog" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                      <MiniMarkdown text={u.changelog} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </Fragment>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- backups

function Backups({ inst }: { inst: string }) {
  const [list, setList] = useState<Backup[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useStore((s) => s.toast);
  const load = () => api.backups(inst).then(setList).catch(() => setList([]));
  useEffect(() => {
    load();
  }, [inst]);
  const roll = async (b: Backup) => {
    setBusy(b.id);
    sfx.click();
    try {
      await api.rollback(inst, b.id);
      sfx.chime();
      toast("Mods rolled back. Your current mods were saved first, just in case.", "ok");
      load();
    } catch (e) {
      toast(errText(e), "err");
    }
    setBusy(null);
  };
  if (!list) return <div className="skeleton" style={{ height: 200 }} />;
  if (list.length === 0)
    return (
      <div className="empty-big">
        <History size={30} />
        <h3>No backups yet</h3>
        <p>Mio makes one automatically before every install, update or removal.</p>
      </div>
    );
  return (
    <div className="timeline">
      {list.map((b, i) => (
        <motion.div key={b.id} className="tl-item" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}>
          <span className="tl-dot" />
          <div className="tl-card">
            <div className="t">
              <b>{b.reason}</b>
              <i>
                {new Date(b.time).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {b.files.length} mods
              </i>
            </div>
            <button className="btn sm" onClick={() => roll(b)} disabled={!!busy}>
              {busy === b.id ? <Loader2 className="spin" /> : <Undo2 />} Roll back to this
            </button>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

export default function Mods() {
  const tab = useStore((s) => s.modsTab);
  const inst = useStore((s) => s.instances.find((i) => i.id === s.current));
  const running = useStore((s) => (inst ? !!s.running[inst.id] : false));
  if (!inst) return null;
  const TABS: { id: Tab; label: string; icon: typeof Package }[] = [
    { id: "installed", label: "Installed", icon: Package },
    { id: "store", label: "Store", icon: Search },
    { id: "updates", label: "Updates", icon: ArrowUpCircle },
    { id: "backups", label: "Backups", icon: History },
  ];
  return (
    <div className="page page-pad mods-page">
      <div className="page-head">
        <div>
          <h1>Mods</h1>
          <p className="muted">
            {inst.name} · {loaderName(inst.loader)} {inst.mc_version}
            <button className="iconlink cf-open" onClick={() => (sfx.click(), useFinder.setState({ ask: { inst: inst.id, name: inst.name, report: null } }))} title="Crashing and the log doesn't say why? Find the mod by testing">
              <Bug size={13} /> Find a crashing mod
            </button>
          </p>
        </div>
        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={"tab" + (tab === t.id ? " on" : "")}
              onClick={() => {
                sfx.click();
                useStore.setState({ modsTab: t.id });
              }}
            >
              {tab === t.id && <motion.span layoutId="modtab" className="tab-bg" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
              <t.icon size={14} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>
      {running && <div className="runwarn">Minecraft is running. Changes to mods wait until you close it.</div>}
      <AnimatePresence mode="wait">
        <motion.div key={tab + inst.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22 }}>
          {tab === "installed" && <Installed inst={inst.id} />}
          {tab === "store" && <Store inst={inst.id} loader={inst.loader} mc={inst.mc_version} />}
          {tab === "updates" && <Updates inst={inst.id} />}
          {tab === "backups" && <Backups inst={inst.id} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
