// Settings sync: keep two instances (LongTerm 26.3 and astera 1.21.11) feeling the same.
// Pick which side wins for each setting, bring resource packs and mod configs across,
// or let it copy what you change in game after every session. Every sync can be undone.
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeftRight, ArrowRight, ArrowLeft, Keyboard, MonitorCog, Volume2, MessageSquare, Package, FileCog, Undo2, RefreshCw, TriangleAlert, Check, Loader2, Layers } from "lucide-react";
import { api, errText, fmtAgo, type Instance } from "../api";
import { useStore } from "../store";
import { useStore as useApp } from "../../store";
import { sfx } from "../../sound";
import { Switch } from "../../ui";

type Side = "a" | "b";
interface Row {
  key: string;
  label: string;
  cat: string;
  a: string;
  b: string;
  mod: string | null;
}
interface PackRow {
  id: string;
  name: string;
  kind: "builtin" | "file" | "mod";
  on_a: boolean;
  on_b: boolean;
  file_a: boolean;
  file_b: boolean;
  ok_a: boolean | null;
  ok_b: boolean | null;
}
interface Cmp {
  a: { id: string; name: string; version: string; format: string | null; running: boolean };
  b: { id: string; name: string; version: string; format: string | null; running: boolean };
  rows: Row[];
  same: Record<string, number>;
  only_a: number;
  only_b: number;
  packs: PackRow[];
  configs: { path: string; size_a: number; size_b: number; time_a: number; time_b: number }[];
  packs_a: string[];
  packs_b: string[];
  shared_configs: number;
}
interface SyncState {
  a: string;
  b: string;
  auto: boolean;
  cats: string[];
  packs: boolean;
  last: number;
}
interface Backup {
  id: string;
  t: number;
  label: string;
  files: { inst: string; rel: string }[];
}

const CATS = [
  { id: "controls", name: "Controls and keybinds", icon: Keyboard },
  { id: "video", name: "Video", icon: MonitorCog },
  { id: "sound", name: "Sound", icon: Volume2 },
  { id: "chat", name: "Chat, skin parts and accessibility", icon: MessageSquare },
] as const;

/** "key.keyboard.left.shift" -> "Left Shift", "0.5" on a volume -> "50%". */
function show(key: string, v: string): string {
  if (key.startsWith("key_")) {
    if (v === "key.keyboard.unknown") return "Not bound";
    if (v.startsWith("key.mouse.")) {
      const b = v.slice(10);
      return b === "left" ? "Left click" : b === "right" ? "Right click" : b === "middle" ? "Middle click" : `Mouse ${b}`;
    }
    const k = v.replace("key.keyboard.", "").split(".");
    return k.map((w) => (w.length === 1 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" ");
  }
  if (v === "true") return "On";
  if (v === "false") return "Off";
  const n = Number(v);
  if (v !== "" && !Number.isNaN(n)) {
    if (key === "fov") return String(Math.round(70 + n * 40));
    if (key.startsWith("soundCategory_") || ["gamma", "chatOpacity", "textBackgroundOpacity", "screenEffectScale", "fovEffectScale", "darknessEffectScale", "damageTiltStrength", "glintStrength", "glintSpeed", "chatScale", "chatWidth"].includes(key)) return `${Math.round(n * 100)}%`;
    if (key === "mouseSensitivity") return `${Math.round(n * 200)}%`;
    return String(Math.round(n * 100) / 100);
  }
  return v.replace(/^"|"$/g, "");
}
const packName = (p: PackRow) => (p.kind === "builtin" ? (p.id === "vanilla" ? "Default" : p.name.replace(/\b\w/g, (c) => c.toUpperCase())) : p.name);

export default function Sync() {
  const toast = useStore((s) => s.toast);
  const [insts, setInsts] = useState<Instance[]>([]);
  const [st, setSt] = useState<SyncState | null>(null);
  const [cmp, setCmp] = useState<Cmp | null>(null);
  const [loading, setLoading] = useState(false);
  const [pick, setPick] = useState<Record<string, Side>>({});
  const [packDir, setPackDir] = useState<"" | "a_to_b" | "b_to_a">("");
  const [packPick, setPackPick] = useState<Record<string, boolean>>({});
  const [cfgPick, setCfgPick] = useState<Record<string, Side>>({});
  const [backups, setBackups] = useState<Backup[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({ controls: true, video: true });

  const load = async (a: string, b: string) => {
    if (!a || !b) return;
    setLoading(true);
    try {
      const c = await api.syncCompare(a, b);
      setCmp(c as Cmp);
      setPick({});
      setCfgPick({});
      setPackDir("");
    } catch (e) {
      toast(errText(e), "err");
    }
    setLoading(false);
    api.syncBackups().then((x) => setBackups(x as Backup[])).catch(() => {});
  };
  useEffect(() => {
    api.instances().then((r) => setInsts(r.instances)).catch(() => {});
    api
      .syncState()
      .then((s) => {
        setSt(s as SyncState);
        load((s as SyncState).a, (s as SyncState).b);
      })
      .catch(() => {});
  }, []);

  const saveState = (n: SyncState) => {
    setSt(n);
    api.syncSet(n.a, n.b, n.auto, n.cats, n.packs).catch((e) => toast(errText(e), "err"));
  };

  // pack plan: the source's enabled packs, what happens to each
  const packPlan = useMemo(() => {
    if (!cmp || !packDir) return null;
    const src: Side = packDir === "a_to_b" ? "a" : "b";
    const tgt: Side = src === "a" ? "b" : "a";
    const srcList = src === "a" ? cmp.packs_a : cmp.packs_b;
    const byId = new Map(cmp.packs.map((p) => [p.id, p]));
    const bring = [...srcList]
      .reverse()
      .map((id) => byId.get(id))
      .filter((p): p is PackRow => !!p);
    const off = cmp.packs.filter((p) => (tgt === "a" ? p.on_a : p.on_b) && !srcList.includes(p.id));
    return { src, tgt, bring, off };
  }, [cmp, packDir]);
  useEffect(() => {
    // default pack picks: everything that works on the target
    if (!packPlan) return;
    const m: Record<string, boolean> = {};
    for (const p of packPlan.bring) if (p.kind === "file") m[p.id] = (packPlan.tgt === "a" ? p.ok_a : p.ok_b) !== false;
    setPackPick(m);
  }, [packPlan]);

  if (!st)
    return (
      <div className="page page-pad">
        <div className="skeleton" style={{ height: 300 }} />
      </div>
    );

  const A = cmp?.a.name ?? st.a;
  const B = cmp?.b.name ?? st.b;
  const running = !!cmp && (cmp.a.running || cmp.b.running);
  const nOpts = Object.keys(pick).length;
  const nCfg = Object.keys(cfgPick).length;
  const nPacks = packDir ? Object.values(packPick).filter(Boolean).length : 0;
  const nothing = !nOpts && !nCfg && !packDir;

  const setAll = (cat: string, side: Side | null) => {
    setPick((cur) => {
      const n = { ...cur };
      for (const r of cmp?.rows ?? []) if (r.cat === cat) side ? (n[r.key] = side) : delete n[r.key];
      return n;
    });
    sfx.click();
  };
  const toggle = (key: string, side: Side) =>
    setPick((cur) => {
      const n = { ...cur };
      if (n[key] === side) delete n[key];
      else n[key] = side;
      return n;
    });

  const apply = async () => {
    if (!cmp) return;
    setBusy(true);
    try {
      const plan = {
        to_b: Object.entries(pick)
          .filter(([, s]) => s === "a")
          .map(([k]) => k),
        to_a: Object.entries(pick)
          .filter(([, s]) => s === "b")
          .map(([k]) => k),
        packs_dir: packDir,
        packs: Object.entries(packPick)
          .filter(([, v]) => v)
          .map(([k]) => k),
        configs_to_b: Object.entries(cfgPick)
          .filter(([, s]) => s === "a")
          .map(([k]) => k),
        configs_to_a: Object.entries(cfgPick)
          .filter(([, s]) => s === "b")
          .map(([k]) => k),
      };
      const r = (await api.syncApply(cmp.a.id, cmp.b.id, plan)) as { options: number; packs_copied: number; configs: number };
      sfx.chime();
      const parts = [r.options && `${r.options} setting${r.options === 1 ? "" : "s"}`, packDir && `packs${r.packs_copied ? ` (${r.packs_copied} copied)` : ""}`, r.configs && `${r.configs} config${r.configs === 1 ? "" : "s"}`].filter(Boolean);
      toast(`Synced ${parts.join(", ")}. Undo is at the bottom if it feels wrong.`, "ok");
      await load(cmp.a.id, cmp.b.id);
    } catch (e) {
      toast(errText(e), "err");
    }
    setBusy(false);
  };
  const undo = async (b: Backup) => {
    try {
      const n = await api.syncRestore(b.id);
      sfx.click();
      toast(`Put back ${n} file${n === 1 ? "" : "s"} from before that sync.`, "ok");
      if (cmp) await load(cmp.a.id, cmp.b.id);
    } catch (e) {
      toast(errText(e), "err");
    }
  };

  const instSelect = (side: Side) => (
    <select
      className="sy-inst"
      value={side === "a" ? st.a : st.b}
      onChange={(e) => {
        const n = { ...st, [side]: e.target.value };
        saveState(n);
        load(n.a, n.b);
      }}
    >
      {!(side === "a" ? st.a : st.b) && <option value="">Pick an instance</option>}
      {insts.map((i) => (
        <option key={i.id} value={i.id} disabled={i.id === (side === "a" ? st.b : st.a)}>
          {i.name} · {i.mc_version}
        </option>
      ))}
    </select>
  );

  return (
    <div className="page page-pad sync-page">
      <div className="page-head">
        <div>
          <h1>Settings sync</h1>
          <p className="muted">Keybinds, video, packs and mod configs the same in both. Only settings both versions have are touched, and every sync can be undone.</p>
        </div>
      </div>

      <div className="sy-pair panel">
        <div className="sy-side">
          {instSelect("a")}
          {cmp && (
            <span className="muted small">
              Minecraft {cmp.a.version}
              {cmp.a.running && <em className="sy-run">running</em>}
            </span>
          )}
        </div>
        <button
          className="sy-swap iconbtn"
          title="Swap sides"
          onClick={() => {
            const n = { ...st, a: st.b, b: st.a };
            saveState(n);
            load(n.a, n.b);
          }}
        >
          <ArrowLeftRight size={16} />
        </button>
        <div className="sy-side r">
          {instSelect("b")}
          {cmp && (
            <span className="muted small">
              Minecraft {cmp.b.version}
              {cmp.b.running && <em className="sy-run">running</em>}
            </span>
          )}
        </div>
        <button className="iconbtn" title="Look again" onClick={() => (sfx.click(), load(st.a, st.b))} disabled={loading}>
          <RefreshCw size={15} className={loading ? "spin" : ""} />
        </button>
      </div>

      {running && (
        <div className="sy-warn">
          <TriangleAlert size={15} /> Minecraft is open. Close it before syncing, or it puts its old settings back when it closes.
        </div>
      )}

      <div className="sy-auto panel">
        <Switch on={st.auto} onChange={(v) => saveState({ ...st, auto: v })} />
        <div className="t">
          <b>Keep them in sync after every session</b>
          <span className="muted small">
            Change something in {A} and it is copied to {B} when the game closes, and the other way round.
          </span>
        </div>
        <div className="sy-auto-cats">
          {CATS.map((c) => (
            <button
              key={c.id}
              className={"chip" + (st.cats.includes(c.id) ? " on" : "")}
              disabled={!st.auto}
              onClick={() => saveState({ ...st, cats: st.cats.includes(c.id) ? st.cats.filter((x) => x !== c.id) : [...st.cats, c.id] })}
            >
              <c.icon size={12} /> {c.name.split(",")[0]}
            </button>
          ))}
          <button className={"chip" + (st.packs ? " on" : "")} disabled={!st.auto} onClick={() => saveState({ ...st, packs: !st.packs })}>
            <Package size={12} /> Packs
          </button>
        </div>
      </div>

      {!cmp && !loading && <div className="empty-big">Pick two instances above.</div>}
      {loading && !cmp && <div className="skeleton" style={{ height: 240 }} />}

      {cmp && (
        <>
          {/* settings */}
          {CATS.map((c) => {
            const rows = cmp.rows.filter((r) => r.cat === c.id);
            const same = cmp.same[c.id] ?? 0;
            const picked = rows.filter((r) => pick[r.key]).length;
            return (
              <div key={c.id} className="panel sy-cat">
                <button className="sy-cat-head" onClick={() => setOpen({ ...open, [c.id]: !open[c.id] })}>
                  <c.icon size={15} />
                  <b>{c.name}</b>
                  <span className="muted small">
                    {rows.length ? `${rows.length} different` : "All the same"} · {same} same{picked ? ` · ${picked} picked` : ""}
                  </span>
                  {rows.length > 0 && (
                    <span className="sy-bulk" onClick={(e) => e.stopPropagation()}>
                      <button className="btn sm ghost" onClick={() => setAll(c.id, "a")}>
                        Use {A}&apos;s
                      </button>
                      <button className="btn sm ghost" onClick={() => setAll(c.id, "b")}>
                        Use {B}&apos;s
                      </button>
                      {picked > 0 && (
                        <button className="btn sm ghost" onClick={() => setAll(c.id, null)}>
                          Clear
                        </button>
                      )}
                    </span>
                  )}
                </button>
                <AnimatePresence initial={false}>
                  {open[c.id] && rows.length > 0 && (
                    <motion.div className="sy-rows" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
                      <div className="sy-row head">
                        <span />
                        <span>{A}</span>
                        <span />
                        <span>{B}</span>
                      </div>
                      {rows.map((r) => {
                        const p = pick[r.key];
                        return (
                          <div key={r.key} className={"sy-row" + (p ? " picked" : "")}>
                            <span className="sy-name">
                              {r.label}
                              {r.mod && <em className="sy-mod">{r.mod}</em>}
                            </span>
                            <button className={"sy-val" + (p === "a" ? " win" : p === "b" ? " lose" : "")} onClick={() => toggle(r.key, "a")} title={`Use ${A}'s`}>
                              {show(r.key, r.a)}
                            </button>
                            <span className="sy-arrow">{p === "a" ? <ArrowRight size={14} /> : p === "b" ? <ArrowLeft size={14} /> : <span className="muted">≠</span>}</span>
                            <button className={"sy-val" + (p === "b" ? " win" : p === "a" ? " lose" : "")} onClick={() => toggle(r.key, "b")} title={`Use ${B}'s`}>
                              {show(r.key, r.b)}
                            </button>
                          </div>
                        );
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
          {(cmp.only_a > 0 || cmp.only_b > 0) && (
            <div className="muted small sy-note">
              {cmp.only_a + cmp.only_b} settings exist in only one of the two versions ({cmp.only_a} only in {A}, {cmp.only_b} only in {B}), so they are left alone.
            </div>
          )}

          {/* packs */}
          <div className="panel sy-cat">
            <div className="sy-cat-head">
              <Package size={15} />
              <b>Resource packs</b>
              <span className="muted small">
                {A}: {cmp.packs_a.length - 1} on · {B}: {cmp.packs_b.length - 1} on
              </span>
              <button
                className="btn sm ghost"
                title="See a pack on your base in 3D before you turn it on"
                onClick={() => {
                  sfx.nav();
                  useApp.getState().setPage("world");
                  useApp.setState({ packPreview: true });
                }}
              >
                <Layers size={12} /> Try one on your base
              </button>
              <span className="sy-bulk">
                <span className="seg sm">
                  <button className={packDir === "" ? "on" : ""} onClick={() => setPackDir("")}>
                    Leave
                  </button>
                  <button className={packDir === "a_to_b" ? "on" : ""} onClick={() => (sfx.click(), setPackDir("a_to_b"))}>
                    {A} <ArrowRight size={12} /> {B}
                  </button>
                  <button className={packDir === "b_to_a" ? "on" : ""} onClick={() => (sfx.click(), setPackDir("b_to_a"))}>
                    {A} <ArrowLeft size={12} /> {B}
                  </button>
                </span>
              </span>
            </div>
            {!packPlan && (
              <div className="sy-packs-now">
                {(["a", "b"] as Side[]).map((s) => (
                  <div key={s}>
                    <div className="sy-lbl">{s === "a" ? A : B}</div>
                    {[...(s === "a" ? cmp.packs_a : cmp.packs_b)]
                      .reverse()
                      .map((id) => cmp.packs.find((p) => p.id === id))
                      .filter((p): p is PackRow => !!p)
                      .map((p) => (
                        <div key={p.id} className="sy-pack">
                          <Package size={12} className="muted" /> {packName(p)}
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            )}
            {packPlan && (
              <div className="sy-packs">
                <div className="sy-lbl">
                  {packPlan.tgt === "a" ? A : B} gets {packPlan.src === "a" ? A : B}&apos;s packs, top one first
                </div>
                {packPlan.bring.map((p) => {
                  const ok = packPlan.tgt === "a" ? p.ok_a : p.ok_b;
                  const has = packPlan.tgt === "a" ? p.file_a : p.file_b;
                  const tgtName = packPlan.tgt === "a" ? A : B;
                  const tgtVer = packPlan.tgt === "a" ? cmp.a.version : cmp.b.version;
                  const modPack = p.kind === "mod" && !(packPlan.tgt === "a" ? p.on_a : p.on_b);
                  return (
                    <label key={p.id} className={"sy-pack" + (modPack ? " off" : "")}>
                      {p.kind === "file" ? (
                        <input type="checkbox" checked={!!packPick[p.id]} onChange={(e) => setPackPick({ ...packPick, [p.id]: e.target.checked })} />
                      ) : (
                        <input type="checkbox" checked={!modPack} disabled readOnly />
                      )}
                      <span className="n">{packName(p)}</span>
                      <span className={"sy-tag" + (ok === false ? " warn" : "")}>
                        {modPack
                          ? `Comes from a mod ${tgtName} doesn't have`
                          : p.kind === "builtin"
                            ? "Built in"
                            : p.kind === "mod"
                              ? "From a mod, already there"
                              : ok === false
                                ? `Made for another version, may look wrong on ${tgtVer}`
                                : has
                                  ? "Already there"
                                  : "Will be copied over"}
                      </span>
                    </label>
                  );
                })}
                {packPlan.off.length > 0 && (
                  <>
                    <div className="sy-lbl">Turned off in {packPlan.tgt === "a" ? A : B} (the files stay)</div>
                    {packPlan.off.map((p) => (
                      <div key={p.id} className="sy-pack off">
                        <span className="n">{packName(p)}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>

          {/* configs */}
          <div className="panel sy-cat">
            <div className="sy-cat-head">
              <FileCog size={15} />
              <b>Mod configs</b>
              <span className="muted small">
                {cmp.configs.length ? `${cmp.configs.length} different` : "All the same"} · {cmp.shared_configs} config files both have
              </span>
            </div>
            {cmp.configs.length > 0 && (
              <div className="sy-rows">
                <div className="muted small sy-note in">Only mods both instances have. Copying a config across versions can reset options the other version doesn&apos;t know, so pick only the ones you care about.</div>
                {cmp.configs.map((c) => {
                  const p = cfgPick[c.path];
                  const set = (s: Side) =>
                    setCfgPick((cur) => {
                      const n = { ...cur };
                      if (n[c.path] === s) delete n[c.path];
                      else n[c.path] = s;
                      return n;
                    });
                  return (
                    <div key={c.path} className={"sy-row" + (p ? " picked" : "")}>
                      <span className="sy-name mono">{c.path}</span>
                      <button className={"sy-val" + (p === "a" ? " win" : p === "b" ? " lose" : "")} onClick={() => set("a")}>
                        {c.time_a > c.time_b ? "Newer · " : ""}
                        {fmtAgo(c.time_a)}
                      </button>
                      <span className="sy-arrow">{p === "a" ? <ArrowRight size={14} /> : p === "b" ? <ArrowLeft size={14} /> : <span className="muted">≠</span>}</span>
                      <button className={"sy-val" + (p === "b" ? " win" : p === "a" ? " lose" : "")} onClick={() => set("b")}>
                        {c.time_b > c.time_a ? "Newer · " : ""}
                        {fmtAgo(c.time_b)}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {backups.length > 0 && (
            <div className="panel sy-cat">
              <div className="sy-cat-head">
                <Undo2 size={15} />
                <b>Undo a sync</b>
                <span className="muted small">The files from right before each sync</span>
              </div>
              <div className="sy-rows">
                {backups.slice(0, 6).map((b) => (
                  <div key={b.id} className="sy-backup">
                    <span>
                      <b>{new Date(b.t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</b>
                      <span className="muted small">
                        {" "}
                        · {b.files.length} file{b.files.length === 1 ? "" : "s"}: {[...new Set(b.files.map((f) => f.rel.split("/")[0]))].join(", ")}
                      </span>
                    </span>
                    <button className="btn sm" onClick={() => undo(b)} disabled={running}>
                      <Undo2 /> Put back
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="sy-bar glass">
            <span>{nothing ? "Click the value you want to keep, or pick a pack direction." : [nOpts && `${nOpts} setting${nOpts === 1 ? "" : "s"}`, packDir && `${nPacks} pack${nPacks === 1 ? "" : "s"}`, nCfg && `${nCfg} config${nCfg === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</span>
            <button className="btn primary" onClick={apply} disabled={nothing || busy || running}>
              {busy ? <Loader2 className="spin" /> : <Check />} Sync now
            </button>
          </div>
        </>
      )}
    </div>
  );
}
