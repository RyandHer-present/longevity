// Crash finder UI: the one question after an unclear crash, the progress card while it tests,
// and the answer. The work happens in Rust (finder.rs) on a throwaway copy of the instance.
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Bug, Check, Loader2, Search, X, PowerOff } from "lucide-react";
import { create } from "zustand";
import { api, errText, type CrashReport } from "./api";
import { useStore } from "./store";
import { sfx } from "../sound";

export interface FinderStatus {
  running: boolean;
  inst: string;
  inst_name: string;
  phase: string;
  test: number;
  tests_est: number;
  left: number;
  lines: string[];
  result: null | {
    kind: "mod" | "clash" | "no_crash" | "not_mods" | "cancelled" | "error";
    culprits?: { file: string; id: string | null; name: string; needed_by: string[] }[];
    confirmed?: boolean;
    tests?: number;
    error?: string;
  };
  started: number;
}

/** Someone asked for the finder: after a crash, or from the Mods page. */
export const useFinder = create<{ ask: { inst: string; name: string; report: CrashReport | null } | null }>(() => ({ ask: null }));

const AUTO_LS = "lv.finder.noask";
const autoOn = () => {
  try {
    return localStorage.getItem(AUTO_LS) === "1";
  } catch {
    return false;
  }
};

export const finderApi = {
  start: (id: string) => invoke<void>("finder_start", { id }),
  status: () => invoke<FinderStatus>("finder_status"),
  cancel: () => invoke<void>("finder_cancel"),
  dismiss: () => invoke<void>("finder_dismiss"),
  disable: (id: string, file: string) => invoke<void>("finder_disable", { id, file }),
};

export function CrashFinder() {
  const toast = useStore((s) => s.toast);
  const ask = useFinder((s) => s.ask);
  const [st, setSt] = useState<FinderStatus | null>(null);
  const [noAsk, setNoAsk] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [turnedOff, setTurnedOff] = useState<string[]>([]);

  const start = async (inst: string) => {
    try {
      await finderApi.start(inst);
      sfx.open();
      setTurnedOff([]);
    } catch (e) {
      toast(errText(e), "err");
    }
  };

  useEffect(() => {
    finderApi
      .status()
      .then((s) => (s.running || s.result) && setSt(s))
      .catch(() => {});
    const uns = [
      listen<FinderStatus>("finder", (e) => setSt(e.payload)),
      // a crash whose log doesn't say which mod did it: ask once (or just start)
      listen<{ id: string; crash: CrashReport | null }>("game-stopped", async (e) => {
        const r = e.payload.crash;
        if (!r || r.culprits.length > 0) return;
        const name = (await api.instances().catch(() => null))?.instances.find((i) => i.id === e.payload.id)?.name ?? e.payload.id;
        if (autoOn()) start(e.payload.id);
        else useFinder.setState({ ask: { inst: e.payload.id, name, report: r } });
      }),
    ];
    return () => uns.forEach((u) => u.then((f) => f()));
  }, []);

  const close = () => {
    finderApi.dismiss().catch(() => {});
    setSt(null);
  };

  const r = st?.result ?? null;
  const pct = st ? Math.min(96, Math.round((st.test / Math.max(1, st.tests_est)) * 100)) : 0;

  return (
    <>
      <AnimatePresence>
        {ask && (
          <motion.div className="cf-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div className="cf-ask glass" initial={{ y: 16, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 10, opacity: 0 }}>
              <div className="cf-ico">
                <Bug size={20} />
              </div>
              <h3>{ask.report ? `${ask.name} crashed, and the log doesn't say which mod did it` : `Find a crashing mod in ${ask.name}`}</h3>
              {ask.report?.title && <div className="cf-why">{ask.report.title}</div>}
              <p>
                Longevity can find it by testing. It starts the game a few times, hidden and muted, each time with half of the mods turned off, until one is left. It works on a throwaway copy, never opens your world, and doesn&apos;t change {ask.name}.
              </p>
              <p className="muted small">Usually 6 to 9 tests, about a minute each. You can keep using your PC; nothing pops up.</p>
              <label className="cf-noask">
                <input type="checkbox" checked={noAsk} onChange={(e) => setNoAsk(e.target.checked)} /> Next time, just start it
              </label>
              <div className="cf-btns">
                <button className="btn ghost" onClick={() => useFinder.setState({ ask: null })}>
                  Not now
                </button>
                <button
                  className="btn primary"
                  onClick={() => {
                    if (noAsk)
                      try {
                        localStorage.setItem(AUTO_LS, "1");
                      } catch {
                        /* private mode */
                      }
                    const a = ask;
                    useFinder.setState({ ask: null });
                    start(a.inst);
                  }}
                >
                  <Search /> Find the mod
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {st && (st.running || r) && (
          <motion.div className="cf-card glass" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}>
            <div className="cf-head">
              {st.running ? <Loader2 className="spin" size={16} /> : r?.kind === "mod" || r?.kind === "clash" ? <Check size={16} className="ok" /> : <Bug size={16} />}
              <div className="cf-title">
                <b>{st.running ? "Finding the crashing mod" : "Crash finder"}</b>
                <span className="muted small">{st.inst_name}</span>
              </div>
              <button className="iconbtn" onClick={st.running ? () => finderApi.cancel() : close} title={st.running ? "Stop" : "Close"}>
                <X size={14} />
              </button>
            </div>
            {st.running && (
              <>
                <div className="cf-bar">
                  <i style={{ width: `${pct}%` }} />
                </div>
                <div className="cf-phase">
                  Test {Math.max(1, st.test)} of about {st.tests_est} · {st.phase}
                  {st.left > 1 && <span className="muted"> · {st.left} mods left to check</span>}
                </div>
              </>
            )}
            {r && (
              <div className="cf-result">
                {r.kind === "mod" && r.culprits && (
                  <>
                    <div className="cf-found">
                      <span className="muted small">Found it</span>
                      <b>{r.culprits[0].name}</b>
                      <span className="muted small mono">{r.culprits[0].file}</span>
                      {r.culprits[0].needed_by.length > 0 && <span className="small">Also needed by {r.culprits[0].needed_by.join(", ")}, which can&apos;t run without it.</span>}
                    </div>
                    <p className="small">{r.confirmed ? `With it off, ${st.inst_name} starts fine.` : "The game still had trouble without it, so there may be more than one problem."}</p>
                  </>
                )}
                {r.kind === "clash" && r.culprits && (
                  <>
                    <div className="cf-found">
                      <span className="muted small">These mods clash</span>
                      <b>{r.culprits.map((c) => c.name).join(" + ")}</b>
                    </div>
                    <p className="small">Each one is fine alone; together the game crashes. Turn one of them off.</p>
                  </>
                )}
                {r.kind === "no_crash" && <p className="small">The game started fine with every mod. So this crash happens in a world, not while starting, and the finder doesn&apos;t open worlds. It might be a world-specific thing, or random.</p>}
                {r.kind === "not_mods" && <p className="small">It crashes even with every mod off, so it isn&apos;t a mod. It may be Java, memory settings, or the graphics driver.</p>}
                {r.kind === "cancelled" && <p className="small">Stopped. Nothing was changed.</p>}
                {r.kind === "error" && <p className="small">It couldn&apos;t finish: {r.error}</p>}
                {(r.kind === "mod" || r.kind === "clash") && r.culprits && (
                  <div className="cf-btns">
                    {r.culprits.map((c) => (
                      <button
                        key={c.file}
                        className="btn sm primary"
                        disabled={turnedOff.includes(c.file)}
                        onClick={async () => {
                          try {
                            await finderApi.disable(st.inst, c.file);
                            sfx.click();
                            setTurnedOff((t) => [...t, c.file]);
                            toast(`${c.name} is off. Turn it back on in Mods any time.`, "ok");
                          } catch (e) {
                            toast(errText(e), "err");
                          }
                        }}
                      >
                        {turnedOff.includes(c.file) ? <Check /> : <PowerOff />} {turnedOff.includes(c.file) ? "Turned off" : `Turn off ${r.culprits!.length > 1 ? c.name : "in " + st.inst_name}`}
                      </button>
                    ))}
                    <button className="btn sm" onClick={close}>
                      Done
                    </button>
                  </div>
                )}
                {r.tests !== undefined && <div className="muted small">{r.tests} tests</div>}
              </div>
            )}
            <button className="cf-logbtn" onClick={() => setShowLog(!showLog)}>
              {showLog ? "Hide" : "Show"} what it did
            </button>
            {showLog && (
              <pre className="cf-log">
                {st.lines.join("\n")}
              </pre>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
