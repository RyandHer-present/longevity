import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Plus, Star, Play, MoreHorizontal, Pencil, Image as ImageIcon, CopyPlus, MemoryStick, ArrowUpCircle, PackageOpen, FolderOpen, Trash2, Loader2, Check, X, FileUp, Coffee, AlertTriangle, Square,
} from "lucide-react";
import { api, errText, fmtAgo, fmtPlay, instIconUrl, loaderName, thumbUrl, type Instance, type InstSettings, type UpgradeCheck } from "../api";
import { useStore, st } from "../store";
import { sfx } from "../../sound";
import { Switch } from "../../ui";
import { Ring, runJob, useJobs } from "../jobs";
import { refreshInstances } from "../boot";
import { IconPicker, type IconChoice } from "./NewInstance";

/** A dropped or picked modpack file: Modrinth packs get Mio's preview; others go to Prism's importer. */
export async function handlePackFile(path: string) {
  const toast = st().toast;
  try {
    const kind = await api.packFileKind(path);
    if (kind === "modrinth") {
      sfx.open();
      useStore.setState({ packPreview: { path } });
    } else {
      await api.prismImport(path);
      toast("That's a CurseForge or Prism pack, so Prism is importing it. Finish in Prism's window.", "info");
    }
  } catch (e) {
    toast(errText(e), "err");
  }
}

function hueOf(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

type ModalKind = "rename" | "icon" | "duplicate" | "memory" | "upgrade" | "export" | "delete";

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  return (
    <motion.div className="modal-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div className={"modal2" + (wide ? " wide" : "")} initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.98 }} transition={{ type: "spring", stiffness: 340, damping: 30 }}>
        <div className="modal2-head">
          <h3>{title}</h3>
          <button className="iconbtn sm" onClick={onClose}>
            <X />
          </button>
        </div>
        {children}
      </motion.div>
    </motion.div>
  );
}

function RenameBody({ i, close }: { i: Instance; close: () => void }) {
  const [name, setName] = useState(i.name);
  const save = async () => {
    try {
      await api.renameInstance(i.id, name);
      sfx.chime();
      await refreshInstances();
      close();
    } catch (e) {
      st().toast(errText(e), "err");
    }
  };
  return (
    <>
      <input className="input big" value={name} autoFocus maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
      <p className="muted small">Only the name changes. The folder, worlds and Prism stay the same.</p>
      <div className="modal2-foot">
        <button className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button className="btn primary" onClick={save} disabled={!name.trim() || name.trim() === i.name}>
          Save
        </button>
      </div>
    </>
  );
}

function IconBody({ i, close }: { i: Instance; close: () => void }) {
  const [choice, setChoice] = useState<IconChoice | null>(null);
  const save = async (c: IconChoice) => {
    setChoice(c);
    try {
      await api.setIcon(i.id, "item" in c ? c.item : null, "file" in c ? c.file : null);
      sfx.chime();
      await refreshInstances();
      close();
    } catch (e) {
      st().toast(errText(e), "err");
    }
  };
  return <IconPicker value={choice} onChange={save} />;
}

function DuplicateBody({ i, close }: { i: Instance; close: () => void }) {
  const [name, setName] = useState(`${i.name} (copy)`);
  const [worlds, setWorlds] = useState(true);
  const [busy, setBusy] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const go = async () => {
    setBusy(true);
    try {
      await runJob({ inst: "new", label: `Copying ${i.name}`, icon: instIconUrl(i.icon), from: btn.current }, (j) => api.duplicate(i.id, name.trim(), worlds, j));
      sfx.chime();
      await refreshInstances();
      st().toast(`Made ${name.trim()}`, "ok");
      close();
    } catch (e) {
      st().toast(errText(e), "err");
      setBusy(false);
    }
  };
  return (
    <>
      <label className="lbl">Name of the copy</label>
      <input className="input big" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="optrow">
        <span>
          <b>Bring the worlds</b>
          <i>{i.worlds ? `${i.worlds} world${i.worlds === 1 ? "" : "s"}, copied. The originals aren't touched.` : "This instance has no worlds."}</i>
        </span>
        <Switch on={worlds} onChange={setWorlds} />
      </div>
      <p className="muted small">Mods, settings, resource packs and shaders all come along.</p>
      <div className="modal2-foot">
        <button className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button ref={btn} className="btn primary" onClick={go} disabled={busy || !name.trim()}>
          {busy ? <Loader2 className="spin" /> : <CopyPlus />} Duplicate
        </button>
      </div>
    </>
  );
}

function MemoryBody({ i, close }: { i: Instance; close: () => void }) {
  const [s, setS] = useState<InstSettings | null>(null);
  const [mem, setMem] = useState(i.max_mem);
  const [java, setJava] = useState<string>("");
  useEffect(() => {
    api.instSettings(i.id).then((x) => {
      setS(x);
      setMem(x.max_mem);
      setJava(x.java_path ?? "");
    });
  }, [i.id]);
  if (!s) return <div className="skeleton" style={{ height: 240, borderRadius: 12 }} />;
  const ramGb = s.ram_mb / 1024;
  const gb = mem / 1024;
  const tight = mem > s.ram_mb - 4096;
  const save = async () => {
    try {
      await api.setMemory(i.id, mem);
      await api.setJava(i.id, java || null);
      sfx.chime();
      await refreshInstances();
      st().toast(`${i.name} gets ${gb.toFixed(gb % 1 ? 1 : 0)} GB${java ? "" : ", and Prism picks the Java"}`, "ok");
      close();
    } catch (e) {
      st().toast(errText(e), "err");
    }
  };
  return (
    <>
      <div className="memhead">
        <MemoryStick size={18} />
        <b>{gb.toFixed(gb % 1 ? 1 : 0)} GB</b>
        <span className="muted">of {Math.round(ramGb)} GB in this PC</span>
      </div>
      <input className="slider" type="range" min={1024} max={Math.max(2048, s.ram_mb - 1024)} step={512} value={mem} onChange={(e) => setMem(+e.target.value)} />
      <div className="memscale">
        <span>1 GB</span>
        <span>{Math.round((s.ram_mb - 1024) / 1024)} GB</span>
      </div>
      <p className={"small " + (tight ? "warnline" : "muted")}>
        {tight ? (
          <>
            <AlertTriangle size={12} /> Leave Windows at least 4 GB, or everything slows down.
          </>
        ) : (
          `Plain game: 2 to 4 GB. Mods: 4 to 8 GB. Big modpacks: 8 GB or more. FPS and Shaders mode use this too.`
        )}
      </p>
      <label className="lbl">
        <Coffee size={12} /> Java (Minecraft {i.mc_version} wants Java {s.java_needed})
      </label>
      <div className="javalist">
        <button className={"javarow" + (java === "" ? " on" : "")} onClick={() => setJava("")}>
          <span className="radio" />
          <span className="t">
            <b>Automatic</b>
            <i>Prism picks the right Java, and downloads it if needed</i>
          </span>
          <span className="tag">Best</span>
        </button>
        {s.java_path && !s.javas.some((j) => j.path === s.java_path) && (
          <button className={"javarow" + (java === s.java_path ? " on" : "")} onClick={() => setJava(s.java_path!)}>
            <span className="radio" />
            <span className="t">
              <b>{s.java_version ? `Java ${s.java_version}` : "The Java Prism set"}</b>
              <i>{s.java_path}</i>
            </span>
            <span className="tag">Now</span>
          </button>
        )}
        {s.javas.map((j) => (
          <button key={j.path} className={"javarow" + (java === j.path ? " on" : "") + (j.major < s.java_needed ? " old" : "")} onClick={() => setJava(j.path)}>
            <span className="radio" />
            <span className="t">
              <b>
                Java {j.major || "?"} {j.vendor && <em className="muted">{j.vendor}</em>}
              </b>
              <i>{j.path}</i>
            </span>
            {j.major === s.java_needed ? <span className="tag ok">Fits</span> : j.major < s.java_needed ? <span className="tag bad">Too old</span> : null}
          </button>
        ))}
      </div>
      <div className="modal2-foot">
        <button className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button className="btn primary" onClick={save}>
          Save
        </button>
      </div>
    </>
  );
}

function UpgradeBody({ i, close }: { i: Instance; close: () => void }) {
  const [targets, setTargets] = useState<string[] | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [check, setCheck] = useState<UpgradeCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [worlds, setWorlds] = useState(true);
  const [busy, setBusy] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    api.upgradeTargets(i.id).then((t) => {
      setTargets(t.targets);
      setTarget(t.targets[0] ?? null);
    });
  }, [i.id]);
  useEffect(() => {
    if (!target) return;
    setCheck(null);
    setChecking(true);
    api
      .upgradeCheck(i.id, target)
      .then(setCheck)
      .catch((e) => st().toast(errText(e), "err"))
      .finally(() => setChecking(false));
  }, [target]);
  const go = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await runJob({ inst: "new", label: `Upgrading to ${target}`, icon: instIconUrl(i.icon), from: btn.current }, (j) => api.upgrade(i.id, target, worlds, j));
      sfx.chime();
      await refreshInstances();
      st().toast(`Made the ${target} copy. ${i.name} itself is untouched.`, "ok");
      close();
    } catch (e) {
      st().toast(errText(e), "err");
      setBusy(false);
    }
  };
  if (!targets) return <div className="skeleton" style={{ height: 200, borderRadius: 12 }} />;
  if (targets.length === 0) return <p className="muted">{i.name} is already on the newest Minecraft release.</p>;
  return (
    <>
      <p className="muted small">Mio makes an upgraded copy. {i.name} itself stays exactly as it is, so you can always go back.</p>
      <div className="chips">
        {targets.slice(0, 8).map((t) => (
          <button key={t} className={"chip" + (target === t ? " on" : "")} onClick={() => setTarget(t)}>
            {target === t && <motion.span layoutId="upgchip" className="chip-bg" />}
            <span>{t}</span>
          </button>
        ))}
      </div>
      {checking && (
        <div className="muted small flex">
          <Loader2 size={13} className="spin" /> Checking every mod for {target}…
        </div>
      )}
      {check && (
        <>
          {!check.loader_ok && <div className="dnote err">{loaderName(i.loader)} isn't out for {target} yet, so this can't be upgraded yet.</div>}
          <div className="upg-cols">
            <div>
              <div className="panel-title ok">
                <Check size={13} /> Ready · {check.ready.length}
              </div>
              <div className="upg-list">
                {check.ready.map((m) => (
                  <div key={m.file} className="upg-row">
                    {m.icon_url ? <img src={m.icon_url} /> : <span className="mletter">{m.name[0]}</span>}
                    <b>{m.name}</b>
                    <i>{m.to}</i>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="panel-title bad">
                <X size={13} /> Not ready · {check.not_ready.length}
              </div>
              <div className="upg-list">
                {check.not_ready.map((m) => (
                  <div key={m.file} className="upg-row off">
                    {m.icon_url ? <img src={m.icon_url} /> : <span className="mletter">{m.name[0]}</span>}
                    <b>{m.name}</b>
                    <i>{m.why}</i>
                  </div>
                ))}
                {check.not_ready.length === 0 && <div className="muted small">Everything is ready.</div>}
              </div>
            </div>
          </div>
          {check.not_ready.length > 0 && <p className="muted small">Mods that aren't ready get turned off in the copy. Turn them back on once they update.</p>}
          <div className="optrow">
            <span>
              <b>Bring the worlds</b>
              <i>Copied, then upgraded when you open them. The originals aren't touched.</i>
            </span>
            <Switch on={worlds} onChange={setWorlds} />
          </div>
        </>
      )}
      <div className="modal2-foot">
        <button className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button ref={btn} className="btn primary" onClick={go} disabled={busy || !check?.loader_ok}>
          {busy ? <Loader2 className="spin" /> : <ArrowUpCircle />} Make the {target} copy
        </button>
      </div>
    </>
  );
}

function ExportBody({ i, close }: { i: Instance; close: () => void }) {
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState<string | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const go = async () => {
    setBusy(true);
    try {
      const p = await runJob({ inst: i.id, label: "Exporting", from: btn.current, icon: instIconUrl(i.icon) }, (j) => api.exportInstance(i.id, j));
      sfx.chime();
      setPath(p);
    } catch (e) {
      st().toast(errText(e), "err");
    }
    setBusy(false);
  };
  return (
    <>
      <p className="muted">
        Saves {i.name} as a Modrinth modpack (.mrpack) in your Downloads folder. Friends can drop it into Mio, Prism or the Modrinth app. Mods on Modrinth are linked, everything else
        (and your config folder) is packed in. Worlds aren't included.
      </p>
      {path ? (
        <div className="exported">
          <Check size={16} />
          <span className="t">
            <b>Saved</b>
            <i>{path}</i>
          </span>
          <button className="btn sm" onClick={() => api.openPath(path)}>
            <FolderOpen /> Show
          </button>
        </div>
      ) : null}
      <div className="modal2-foot">
        <button className="btn ghost" onClick={close}>
          {path ? "Done" : "Cancel"}
        </button>
        {!path && (
          <button ref={btn} className="btn primary" onClick={go} disabled={busy}>
            {busy ? <Loader2 className="spin" /> : <PackageOpen />} Export
          </button>
        )}
      </div>
    </>
  );
}

function DeleteBody({ i, close }: { i: Instance; close: () => void }) {
  const go = async () => {
    try {
      await api.deleteInstance(i.id);
      sfx.click();
      await refreshInstances();
      st().toast(`${i.name} is in the Recycle Bin`, "ok");
      close();
    } catch (e) {
      st().toast(errText(e), "err");
    }
  };
  return (
    <>
      <p>
        Move <b>{i.name}</b> to the Recycle Bin? Its {i.worlds} world{i.worlds === 1 ? "" : "s"} and {i.mods} mod{i.mods === 1 ? "" : "s"} go with it.
      </p>
      <p className="muted small">You can restore it from the Recycle Bin until you empty it.</p>
      <div className="modal2-foot">
        <button className="btn ghost" onClick={close}>
          Keep it
        </button>
        <button className="btn danger" onClick={go}>
          <Trash2 /> Move to Recycle Bin
        </button>
      </div>
    </>
  );
}

const TITLES: Record<ModalKind, string> = { rename: "Rename", icon: "Change icon", duplicate: "Duplicate", memory: "Memory and Java", upgrade: "Upgrade to a newer Minecraft", export: "Export as a modpack", delete: "Delete" };

function Menu({ i, x, y, onPick, onClose }: { i: Instance; x: number; y: number; onPick: (k: ModalKind) => void; onClose: () => void }) {
  useEffect(() => {
    const h = () => onClose();
    setTimeout(() => window.addEventListener("mousedown", h), 0);
    return () => window.removeEventListener("mousedown", h);
  }, []);
  const items: [ModalKind | "folder", string, typeof Pencil][] = [
    ["rename", "Rename", Pencil],
    ["icon", "Change icon", ImageIcon],
    ["duplicate", "Duplicate", CopyPlus],
    ["memory", "Memory and Java", MemoryStick],
    ["upgrade", "Upgrade to newer version", ArrowUpCircle],
    ["export", "Export as modpack", PackageOpen],
    ["folder", "Open folder", FolderOpen],
    ["delete", "Delete", Trash2],
  ];
  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.min(y, window.innerHeight - 340);
  return (
    <motion.div className="ctxmenu" style={{ left, top }} initial={{ opacity: 0, scale: 0.95, y: -4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map(([k, l, I]) => (
        <button
          key={k}
          className={k === "delete" ? "danger" : ""}
          onClick={() => {
            sfx.click();
            onClose();
            if (k === "folder") api.openFolder(i.id).catch(() => {});
            else onPick(k);
          }}
        >
          <I size={14} /> {l}
        </button>
      ))}
    </motion.div>
  );
}

function Card({ i, shot, fav, n, onMenu }: { i: Instance; shot: string | null; fav: boolean; n: number; onMenu: (e: React.MouseEvent) => void }) {
  const current = useStore((s) => s.current);
  const running = useStore((s) => !!s.running[i.id]);
  const launching = useStore((s) => s.launching === i.id);
  const anyRunning = useStore((s) => Object.keys(s.running).length > 0);
  const toast = useStore((s) => s.toast);
  const [bad, setBad] = useState(false);
  const toggleFav = (e: React.MouseEvent) => {
    e.stopPropagation();
    const s = st().settings;
    if (!s) return;
    const favs = s.favorites ?? [];
    const next = { ...s, favorites: fav ? favs.filter((x) => x !== i.id) : [...favs, i.id] };
    sfx.toggle(!fav);
    useStore.setState({ settings: next });
    api.settingsSet(next).catch(() => {});
  };
  const play = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (running) {
      await api.stopGame(i.id).catch((er) => toast(errText(er), "err"));
      return;
    }
    sfx.chime();
    st().setCurrent(i.id);
    useStore.setState({ launching: i.id });
    try {
      await api.launch(i.id);
    } catch (er) {
      useStore.setState({ launching: null });
      toast(errText(er), "err");
    }
  };
  return (
    <motion.div
      layout
      className={"icard" + (current === i.id ? " sel" : "")}
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ delay: Math.min(n, 12) * 0.035, duration: 0.35, ease: [0.22, 0.7, 0.18, 1] }}
      whileHover={{ y: -4 }}
      onMouseEnter={() => sfx.hover()}
      onClick={() => {
        sfx.click();
        st().setCurrent(i.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e);
      }}
      style={{ ["--h" as any]: hueOf(i.name) }}
    >
      <div className="icard-bg">{shot && !bad ? <img src={thumbUrl(shot, 640)} onError={() => setBad(true)} loading="lazy" /> : <div className="icard-blank" />}</div>
      <div className="icard-shade" />
      <button className={"icard-star" + (fav ? " on" : "")} onClick={toggleFav} title={fav ? "Unpin" : "Pin to the top"}>
        <Star size={15} fill={fav ? "currentColor" : "none"} />
      </button>
      {running && (
        <span className="icard-live">
          <span className="dot" /> Playing
        </span>
      )}
      <div className="icard-foot">
        <span className="icard-icon" data-inst-target={i.id}>
          <img src={instIconUrl(i.icon)} className="px" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
          <Ring inst={i.id} size={40} />
        </span>
        <div className="t">
          <b>{i.name}</b>
          <i>
            {loaderName(i.loader)} {i.mc_version}
            {i.loader !== "vanilla" ? ` · ${i.mods} mods` : ""}
          </i>
          <em>
            {i.total_played ? `${fmtPlay(i.total_played)} played` : "Never played"}
            {i.last_launch ? ` · ${fmtAgo(i.last_launch)}` : ""}
          </em>
        </div>
        <div className="icard-actions">
          <button className={"btn primary sm" + (running ? " danger" : "")} onClick={play} disabled={launching || (anyRunning && !running)}>
            {launching ? <Loader2 className="spin" /> : running ? <Square /> : <Play fill="currentColor" />}
            {running ? "Stop" : launching ? "Starting" : "Play"}
          </button>
          <button
            className="iconbtn sm"
            onClick={(e) => {
              e.stopPropagation();
              onMenu(e);
            }}
          >
            <MoreHorizontal />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function GhostCard({ jobId }: { jobId: string }) {
  const j = useJobs((s) => s.jobs[jobId]);
  if (!j) return null;
  const pct = j.pct < 0 ? 0 : j.pct;
  return (
    <motion.div className="icard ghost" layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.05 }}>
      <div className="ghost-fill">
        <motion.i animate={{ height: `${pct * 100}%` }} transition={{ duration: 0.4 }} />
      </div>
      <div className="ghost-body">
        <span className="ghost-pct">{j.done ? <Check size={26} /> : j.pct < 0 ? <Loader2 className="spin" size={22} /> : `${Math.round(pct * 100)}%`}</span>
        <b>{j.label}</b>
        <i>{j.done ? "Ready" : "Working on it"}</i>
      </div>
    </motion.div>
  );
}

export default function Instances() {
  const instances = useStore((s) => s.instances);
  const favorites = useStore((s) => s.settings?.favorites ?? []);
  const jobs = useJobs((s) => s.jobs);
  const [shots, setShots] = useState<Record<string, string>>({});
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [modal, setModal] = useState<{ kind: ModalKind; id: string } | null>(null);
  useEffect(() => {
    api
      .shots()
      .then((list) => {
        const m: Record<string, { key: string; time: number }> = {};
        for (const s of list) if (!m[s.instance] || s.time > m[s.instance].time) m[s.instance] = { key: s.key, time: s.time };
        setShots(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.key])));
      })
      .catch(() => {});
  }, []);
  const favs = useMemo(() => instances.filter((i) => favorites.includes(i.id)), [instances, favorites]);
  const rest = useMemo(() => instances.filter((i) => !favorites.includes(i.id)).sort((a, b) => b.last_launch - a.last_launch || a.name.localeCompare(b.name)), [instances, favorites]);
  const newJobs = Object.values(jobs).filter((j) => j.inst === "new");
  const total = instances.reduce((a, i) => a + i.total_played, 0);
  const mi = modal ? instances.find((i) => i.id === modal.id) : null;
  const importFile = async () => {
    const p = await openDialog({ filters: [{ name: "Modpack", extensions: ["mrpack", "zip"] }], multiple: false });
    if (typeof p === "string") handlePackFile(p);
  };
  const openMenu = (i: Instance) => (e: React.MouseEvent) => {
    sfx.click();
    setMenu({ id: i.id, x: e.clientX, y: e.clientY });
  };
  let n = 0;
  return (
    <div className="page page-pad instances-page">
      <div className="page-head">
        <div>
          <h1>Instances</h1>
          <p className="muted">
            {instances.length} instance{instances.length === 1 ? "" : "s"} · {fmtPlay(total)} played in all. Click one to make it the one Mio shows.
          </p>
        </div>
        <div className="head-btns">
          <button className="btn" onClick={importFile}>
            <FileUp /> Import a modpack file
          </button>
          <button
            className="btn primary"
            onClick={() => {
              sfx.click();
              useStore.setState({ wizard: true });
            }}
          >
            <Plus /> New instance
          </button>
        </div>
      </div>
      {favs.length > 0 && (
        <>
          <div className="isection">
            <Star size={13} fill="currentColor" /> Pinned
          </div>
          <div className="igrid">
            <AnimatePresence>
              {favs.map((i) => (
                <Card key={i.id} i={i} shot={shots[i.id] ?? null} fav n={n++} onMenu={openMenu(i)} />
              ))}
            </AnimatePresence>
          </div>
        </>
      )}
      <div className="isection">{favs.length > 0 ? "Everything else" : "All instances"} · newest played first</div>
      <div className="igrid">
        <AnimatePresence>
          {newJobs.map((j) => (
            <GhostCard key={j.id} jobId={j.id} />
          ))}
          {rest.map((i) => (
            <Card key={i.id} i={i} shot={shots[i.id] ?? null} fav={false} n={n++} onMenu={openMenu(i)} />
          ))}
          <motion.button
            key="plus"
            layout
            className="icard plus"
            onClick={() => {
              sfx.click();
              useStore.setState({ wizard: true });
            }}
            whileHover={{ y: -4 }}
          >
            <span className="plus-ico">
              <Plus size={26} />
            </span>
            <b>New instance</b>
            <i>Any version, Fabric or NeoForge</i>
          </motion.button>
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {menu && instances.find((i) => i.id === menu.id) && (
          <Menu key="menu" i={instances.find((i) => i.id === menu.id)!} x={menu.x} y={menu.y} onClose={() => setMenu(null)} onPick={(k) => setModal({ kind: k, id: menu.id })} />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {modal && mi && (
          <Modal key={modal.kind} title={`${TITLES[modal.kind]} · ${mi.name}`} onClose={() => setModal(null)} wide={modal.kind === "upgrade" || modal.kind === "icon"}>
            {modal.kind === "rename" && <RenameBody i={mi} close={() => setModal(null)} />}
            {modal.kind === "icon" && <IconBody i={mi} close={() => setModal(null)} />}
            {modal.kind === "duplicate" && <DuplicateBody i={mi} close={() => setModal(null)} />}
            {modal.kind === "memory" && <MemoryBody i={mi} close={() => setModal(null)} />}
            {modal.kind === "upgrade" && <UpgradeBody i={mi} close={() => setModal(null)} />}
            {modal.kind === "export" && <ExportBody i={mi} close={() => setModal(null)} />}
            {modal.kind === "delete" && <DeleteBody i={mi} close={() => setModal(null)} />}
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

export { Modal };
