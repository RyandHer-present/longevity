import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, ArrowRight, Check, Loader2, Search, Upload, X, Sparkles, Copy, Blocks } from "lucide-react";
import { api, errText, instIconUrl, loaderName, type LoaderChoice, type McVersion, type StarterMod } from "../api";
import { useStore } from "../store";
import { sfx } from "../../sound";
import { ItemIcon, Switch } from "../../ui";
import { runJob, useJobs } from "../jobs";
import { refreshInstances } from "../boot";

// ---------------------------------------------------------------- icon picker (wizard + instance page)

let itemCache: { id: string; name: string }[] | null = null;

export type IconChoice = { item: string } | { file: string };

export function IconPicker({ value, onChange }: { value: IconChoice | null; onChange: (c: IconChoice) => void }) {
  const [items, setItems] = useState(itemCache);
  const [q, setQ] = useState("");
  const [n, setN] = useState(84);
  useEffect(() => {
    if (!itemCache)
      api
        .items()
        .then((l) => {
          itemCache = l;
          setItems(l);
        })
        .catch(() => setItems([]));
  }, []);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (items ?? []).filter((i) => !s || i.name.toLowerCase().includes(s) || i.id.includes(s));
  }, [items, q]);
  const upload = async () => {
    const p = await openDialog({ filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }], multiple: false });
    if (typeof p === "string") onChange({ file: p });
  };
  const selItem = value && "item" in value ? value.item : null;
  return (
    <div className="iconpick">
      <div className="toolbar">
        <div className="search">
          <Search size={15} />
          <input placeholder={`Search ${items?.length ?? ""} items and blocks`} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="btn sm" onClick={upload}>
          <Upload /> Your own image
        </button>
      </div>
      {value && "file" in value && (
        <div className="dnote">
          <Check size={13} /> Using {value.file.split(/[\\/]/).pop()}
        </div>
      )}
      <div className="iconpick-grid" onScroll={(e) => {
        const el = e.currentTarget;
        if (el.scrollTop + el.clientHeight > el.scrollHeight - 80) setN((x) => Math.min(x + 84, shown.length));
      }}>
        {!items && Array.from({ length: 28 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 46, borderRadius: 8 }} />)}
        {shown.slice(0, n).map((it) => (
          <button key={it.id} className={"iconpick-cell" + (selItem === it.id ? " on" : "")} title={it.name} onClick={() => {
            sfx.click();
            onChange({ item: it.id });
          }}>
            <ItemIcon id={it.id} size={32} />
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the wizard

const STEPS = ["Version", "Loader", "Name and icon", "Mods"];
type VTab = "release" | "snapshot" | "experiment" | "old";
const VTABS: [VTab, string][] = [
  ["release", "Releases"],
  ["snapshot", "Snapshots"],
  ["experiment", "Experiments"],
  ["old", "Old versions"],
];
const inTab = (v: McVersion, t: VTab) => (t === "old" ? v.kind.startsWith("old_") : v.kind === t);

function LoaderLogo({ l }: { l: string }) {
  if (l === "fabric")
    return (
      <svg viewBox="0 0 16 16" width="34" height="34" shapeRendering="crispEdges">
        <rect x="2" y="2" width="12" height="12" fill="#dbd0b4" />
        <rect x="3" y="3" width="10" height="10" fill="#c6bba5" />
        <rect x="5" y="4" width="2" height="8" fill="#38342a" />
        <rect x="7" y="4" width="4" height="2" fill="#38342a" />
        <rect x="7" y="7" width="3" height="2" fill="#38342a" />
      </svg>
    );
  if (l === "neoforge")
    return (
      <svg viewBox="0 0 16 16" width="34" height="34" shapeRendering="crispEdges">
        <rect x="2" y="3" width="12" height="4" fill="#d7742f" />
        <rect x="4" y="7" width="8" height="2" fill="#a8521c" />
        <rect x="6" y="9" width="4" height="3" fill="#7b3a12" />
        <rect x="3" y="12" width="10" height="2" fill="#d7742f" />
      </svg>
    );
  return <ItemIcon id="grass_block" size={34} />;
}

export default function NewInstance() {
  const instances = useStore((s) => s.instances);
  const toast = useStore((s) => s.toast);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [versions, setVersions] = useState<McVersion[] | null>(null);
  const [verr, setVerr] = useState<string | null>(null);
  const [vtab, setVtab] = useState<VTab>("release");
  const [vq, setVq] = useState("");
  const [vn, setVn] = useState(90);
  const [mc, setMc] = useState<string | null>(null);
  const [loaders, setLoaders] = useState<LoaderChoice[] | null>(null);
  const [loader, setLoader] = useState<string>("fabric");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [icon, setIcon] = useState<IconChoice | null>({ item: "grass_block" });
  const defaultCopy = instances.find((i) => i.name.toLowerCase() === "longterm")?.id ?? instances[0]?.id ?? "";
  const [copyFrom, setCopyFrom] = useState<string>(defaultCopy);
  const [starter, setStarter] = useState<StarterMod[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<string | null>(null);
  const job = useJobs((s) => (creating ? s.jobs[creating] : undefined));
  const jobRef = useRef<string | null>(null);

  const close = () => !creating && useStore.setState({ wizard: false });
  useEffect(() => {
    sfx.open();
    api
      .mcVersions()
      .then((v) => {
        setVersions(v);
        const latest = v.find((x) => x.kind === "release");
        if (latest) setMc(latest.version);
      })
      .catch((e) => setVerr(errText(e)));
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  useEffect(() => {
    if (!mc) return;
    setLoaders(null);
    api.loaders(mc).then((l) => {
      setLoaders(l);
      const ok = l.filter((x) => x.version);
      setLoader(ok.find((x) => x.loader === loader)?.loader ?? ok[0]?.loader ?? "vanilla");
    });
  }, [mc]);
  useEffect(() => {
    if (!nameTouched && mc) setName(`${mc}${loader !== "vanilla" ? " " + loaderName(loader) : ""}`);
  }, [mc, loader]);
  useEffect(() => {
    if (!mc || loader === "vanilla") {
      setStarter([]);
      return;
    }
    setStarter(null);
    api
      .starter(mc, loader)
      .then((s) => {
        setStarter(s);
        setPicked(new Set(s.filter((x) => x.available).map((x) => x.project_id)));
      })
      .catch(() => setStarter([]));
  }, [mc, loader]);

  const shown = useMemo(() => {
    const s = vq.trim().toLowerCase();
    return (versions ?? []).filter((v) => inTab(v, vtab) && (!s || v.version.toLowerCase().includes(s)));
  }, [versions, vtab, vq]);
  const latestRelease = versions?.find((v) => v.kind === "release");
  const latestSnap = versions?.find((v) => v.kind === "snapshot");
  const lchoice = loaders?.find((l) => l.loader === loader);
  const anyLoader = loaders?.some((l) => l.version) ?? true;

  const go = (d: number) => {
    sfx.click();
    setDir(d);
    setStep((s) => Math.max(0, Math.min(STEPS.length - 1, s + d)));
  };
  const canNext = step === 0 ? !!mc : step === 1 ? !!loaders : step === 2 ? name.trim().length > 0 : true;

  const create = async () => {
    if (!mc) return;
    sfx.chime();
    try {
      const r = await runJob({ inst: "new", label: `Making ${name.trim()}` }, (j) => {
        jobRef.current = j;
        setCreating(j);
        return api.createInstance(
          {
            name: name.trim(),
            mc,
            loader: anyLoader ? loader : "vanilla",
            loader_version: lchoice?.version ?? null,
            icon_item: icon && "item" in icon ? icon.item : null,
            icon_file: icon && "file" in icon ? icon.file : null,
            copy_from: copyFrom || null,
            starter: [...picked],
          },
          j,
        );
      });
      await refreshInstances();
      useStore.getState().setCurrent(r.id);
      if (r.warnings.length) toast(`Made it, but: ${r.warnings[0]}`, "err");
      else toast(`${name.trim()} is ready. Add some mods!`, "ok");
      useStore.setState({ wizard: false, page: loader === "vanilla" ? "home" : "mods", modsTab: "store", storeKind: "mod" });
    } catch (e) {
      setCreating(null);
      toast(errText(e), "err");
    }
  };

  return (
    <motion.div className="modal-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <motion.div className="wizard" initial={{ opacity: 0, y: 30, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.98 }} transition={{ type: "spring", stiffness: 320, damping: 30 }}>
        <div className="wiz-head">
          <h2>New instance</h2>
          <div className="wiz-steps">
            {STEPS.map((s, i) => (
              <div key={s} className={"wiz-step" + (i === step ? " on" : i < step ? " done" : "")}>
                <motion.span className="wiz-dot" animate={{ scale: i === step ? 1.15 : 1 }}>
                  {i < step ? <Check size={11} strokeWidth={3} /> : i + 1}
                </motion.span>
                <span className="wiz-label">{s}</span>
                {i < STEPS.length - 1 && (
                  <span className="wiz-line">
                    <motion.i animate={{ width: i < step ? "100%" : "0%" }} transition={{ duration: 0.35 }} />
                  </span>
                )}
              </div>
            ))}
          </div>
          <button className="iconbtn" onClick={close} disabled={!!creating}>
            <X />
          </button>
        </div>

        <div className="wiz-body">
          <AnimatePresence mode="wait" custom={dir}>
            {creating ? (
              <motion.div key="making" className="wiz-making" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}>
                <div className="bigring">
                  <svg viewBox="0 0 120 120">
                    <circle cx="60" cy="60" r="52" className="track" />
                    <motion.circle cx="60" cy="60" r="52" className="fill" strokeDasharray={2 * Math.PI * 52} animate={{ strokeDashoffset: 2 * Math.PI * 52 * (1 - Math.max(0.03, job?.pct ?? 0.03)) }} transition={{ duration: 0.4 }} />
                  </svg>
                  <span className="bigring-icon">{icon && "item" in icon ? <ItemIcon id={icon.item} size={44} /> : <img src={instIconUrl("default")} className="px" width={44} />}</span>
                </div>
                <h3>{job?.done ? "Ready!" : `Making ${name}`}</h3>
                <p className="muted">{job?.label ?? "Starting"}</p>
              </motion.div>
            ) : (
              <motion.div
                key={step}
                custom={dir}
                initial={{ opacity: 0, x: dir * 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: dir * -40 }}
                transition={{ duration: 0.24, ease: [0.22, 0.7, 0.18, 1] }}
                className="wiz-page"
              >
                {step === 0 && (
                  <>
                    <p className="wiz-lead">Which Minecraft? Every version Prism knows is here, back to the first alphas.</p>
                    {verr && <div className="dnote err">{verr}</div>}
                    <div className="wiz-latest">
                      {latestRelease && (
                        <button className={"wiz-big" + (mc === latestRelease.version ? " on" : "")} onClick={() => setMc(latestRelease.version)}>
                          <span className="tag">Latest release</span>
                          <b>{latestRelease.version}</b>
                          <i>{new Date(latestRelease.released).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</i>
                        </button>
                      )}
                      {latestSnap && (
                        <button className={"wiz-big snap" + (mc === latestSnap.version ? " on" : "")} onClick={() => setMc(latestSnap.version)}>
                          <span className="tag">Latest snapshot</span>
                          <b>{latestSnap.version}</b>
                          <i>Test build, can break worlds</i>
                        </button>
                      )}
                    </div>
                    <div className="toolbar">
                      <div className="seg">
                        {VTABS.map(([k, l]) => (
                          <button key={k} className={vtab === k ? "on" : ""} onClick={() => {
                            setVtab(k);
                            setVn(90);
                          }}>
                            {l}
                          </button>
                        ))}
                      </div>
                      <div className="search">
                        <Search size={15} />
                        <input placeholder="Find a version" value={vq} onChange={(e) => setVq(e.target.value)} />
                      </div>
                    </div>
                    <div className="vgrid" onScroll={(e) => {
                      const el = e.currentTarget;
                      if (el.scrollTop + el.clientHeight > el.scrollHeight - 60) setVn((x) => x + 90);
                    }}>
                      {!versions && !verr && Array.from({ length: 24 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 50, borderRadius: 10 }} />)}
                      {shown.slice(0, vn).map((v) => (
                        <button key={v.version} className={"vcell" + (mc === v.version ? " on" : "")} onClick={() => {
                          sfx.click();
                          setMc(v.version);
                        }}>
                          <b>{v.version}</b>
                          <i>{new Date(v.released).toLocaleDateString(undefined, { month: "short", year: "numeric" })}</i>
                        </button>
                      ))}
                      {versions && shown.length === 0 && <div className="muted small">No versions match.</div>}
                    </div>
                  </>
                )}

                {step === 1 && (
                  <>
                    <p className="wiz-lead">Mods need a loader. Pick the one your mods are made for.</p>
                    {!loaders && <div className="skeleton" style={{ height: 150, borderRadius: 14 }} />}
                    {loaders && !anyLoader && (
                      <div className="loader-card on solo">
                        <LoaderLogo l="vanilla" />
                        <div>
                          <b>Plain Minecraft</b>
                          <i>Neither Fabric nor NeoForge works on {mc}, so this instance will be plain Minecraft, with no mods.</i>
                        </div>
                      </div>
                    )}
                    {loaders && anyLoader && (
                      <div className="loader-cards">
                        {loaders.map((l, i) => (
                          <motion.button
                            key={l.loader}
                            className={"loader-card" + (loader === l.loader ? " on" : "") + (l.version ? "" : " off")}
                            disabled={!l.version}
                            onClick={() => {
                              sfx.click();
                              setLoader(l.loader);
                            }}
                            initial={{ opacity: 0, y: 12 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.08 }}
                            whileHover={l.version ? { y: -3 } : {}}
                          >
                            <LoaderLogo l={l.loader} />
                            <div>
                              <b>{loaderName(l.loader)}</b>
                              <i>{l.version ? (l.loader === "fabric" ? "Light and quick to update. Most performance mods, like Sodium, are made for it." : "Big content mods and most tech packs.") : `Not out for ${mc} yet`}</i>
                              {l.version && <span className="tag">Loader {l.version}</span>}
                            </div>
                            {loader === l.loader && l.version && (
                              <motion.span layoutId="loadercheck" className="loader-check">
                                <Check size={14} strokeWidth={3} />
                              </motion.span>
                            )}
                          </motion.button>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {step === 2 && (
                  <div className="wiz-name">
                    <div className="wiz-name-top">
                      <span className="wiz-iconbig">{icon && "item" in icon ? <ItemIcon id={icon.item} size={48} /> : <Upload size={26} />}</span>
                      <div className="grow">
                        <label className="lbl">Name</label>
                        <input
                          className="input big"
                          value={name}
                          maxLength={60}
                          onChange={(e) => {
                            setName(e.target.value);
                            setNameTouched(true);
                          }}
                        />
                      </div>
                    </div>
                    <label className="lbl">Icon</label>
                    <IconPicker value={icon} onChange={setIcon} />
                    <label className="lbl">
                      <Copy size={12} /> Copy keybinds and video settings from
                    </label>
                    <select className="input" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                      <option value="">Nothing, start with the game's defaults</option>
                      {instances.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {step === 3 && (
                  <>
                    {loader === "vanilla" || !anyLoader ? (
                      <p className="wiz-lead">Plain Minecraft has no mods, so it's ready to go.</p>
                    ) : (
                      <p className="wiz-lead">A starter kit that makes the game run better. Untick anything you don't want.</p>
                    )}
                    {!starter && <div className="skeleton" style={{ height: 220, borderRadius: 12 }} />}
                    <div className="starter">
                      {starter?.map((m, i) => (
                        <motion.div key={m.project_id} className={"starter-row" + (m.available ? "" : " off")} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}>
                          {m.icon_url ? <img src={m.icon_url} /> : <span className="mletter">{m.title[0]}</span>}
                          <span className="t">
                            <b>{m.title}</b>
                            <i>{m.available ? m.description : `Not out for ${loaderName(loader)} ${mc} yet`}</i>
                          </span>
                          <Switch
                            on={picked.has(m.project_id)}
                            onChange={(v) => {
                              if (!m.available) return;
                              const n = new Set(picked);
                              v ? n.add(m.project_id) : n.delete(m.project_id);
                              setPicked(n);
                            }}
                          />
                        </motion.div>
                      ))}
                    </div>
                    <div className="wiz-summary">
                      <span className="wiz-iconsm">{icon && "item" in icon ? <ItemIcon id={icon.item} size={28} /> : <Blocks size={20} />}</span>
                      <span>
                        <b>{name}</b>
                        <i>
                          {anyLoader && loader !== "vanilla" ? `${loaderName(loader)} ` : ""}
                          {mc} · {picked.size} starter mod{picked.size === 1 ? "" : "s"}
                          {copyFrom ? ` · settings from ${instances.find((i) => i.id === copyFrom)?.name ?? copyFrom}` : ""}
                        </i>
                      </span>
                    </div>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {!creating && (
          <div className="wiz-foot">
            <button className="btn ghost" onClick={() => (step === 0 ? close() : go(-1))}>
              {step === 0 ? (
                "Cancel"
              ) : (
                <>
                  <ArrowLeft /> Back
                </>
              )}
            </button>
            <span className="muted small">
              {mc && (
                <>
                  {mc}
                  {step > 0 && anyLoader && loader !== "vanilla" ? ` · ${loaderName(loader)}` : ""}
                </>
              )}
            </span>
            {step < STEPS.length - 1 ? (
              <button className="btn primary" onClick={() => go(1)} disabled={!canNext}>
                Next <ArrowRight />
              </button>
            ) : (
              <button className="btn primary" onClick={create} disabled={!starter}>
                {!starter ? <Loader2 className="spin" /> : <Sparkles />} Make it
              </button>
            )}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

