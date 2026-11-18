import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X, Bug, Ban, ArrowUpCircle, History, MemoryStick, Zap, Search, FileText, Check, Loader2 } from "lucide-react";
import { api, errText, fmtAgo, type CrashAction, type CrashReport } from "../api";
import { useStore } from "../store";
import { sfx } from "../../sound";

const ICONS: Record<string, typeof Bug> = { disable: Ban, updates: ArrowUpCircle, rollback: History, memory: MemoryStick, fps: Zap, store: Search };

export function CrashBody({ inst, report, onDone }: { inst: string; report: CrashReport; onDone?: () => void }) {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [raw, setRaw] = useState(false);

  const run = async (a: CrashAction) => {
    const key = a.kind + a.target;
    setBusy(key);
    sfx.click();
    try {
      if (a.kind === "disable") {
        await api.toggleMod(inst, a.target, false);
        toast(`Turned off ${a.target.replace(/\.jar$/, "")}. Try playing again.`, "ok");
      } else if (a.kind === "rollback") {
        await api.rollback(inst);
        toast("Your mods are back to how they were before the last change", "ok");
      } else if (a.kind === "memory") {
        const mb = await api.raiseMemory(inst);
        toast(`Minecraft can now use ${(mb / 1024).toFixed(1)} GB of memory`, "ok");
      } else if (a.kind === "updates") {
        useStore.setState({ modsTab: "updates", crash: null });
        useStore.getState().setPage("mods");
        onDone?.();
        return;
      } else if (a.kind === "store") {
        useStore.setState({ modsTab: "store", storeQuery: a.target, crash: null });
        useStore.getState().setPage("mods");
        onDone?.();
        return;
      }
      setDone((d) => new Set(d).add(key));
    } catch (e) {
      toast(errText(e), "err");
    }
    setBusy(null);
  };

  return (
    <div className="crash-body">
      <p className="crash-detail">{report.detail}</p>
      {report.culprits.length > 0 && (
        <div className="culprits">
          {report.culprits.map((c, i) => (
            <motion.div key={c.mod_id + i} className="culprit" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.25 + i * 0.08 }}>
              <span className="cnum">{i + 1}</span>
              <span className="t">
                <b>{c.name}</b>
                <i>{c.why}</i>
              </span>
              {c.file && <span className="cfile">{c.file}</span>}
            </motion.div>
          ))}
        </div>
      )}
      {report.steps.length > 0 && (
        <ol className="crash-steps">
          {report.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      <div className="crash-actions">
        {report.actions.map((a, i) => {
          const I = ICONS[a.kind] ?? Bug;
          const key = a.kind + a.target;
          const isDone = done.has(key);
          return (
            <motion.button key={key + i} className={"btn" + (i === 0 ? " primary" : "") + (isDone ? " done" : "")} disabled={!!busy || isDone} onClick={() => run(a)} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 + i * 0.05 }}>
              {busy === key ? <Loader2 className="spin" /> : isDone ? <Check /> : <I />}
              {a.label}
            </motion.button>
          );
        })}
      </div>
      <div className="crash-raw">
        <button className="btn ghost sm" onClick={() => setRaw((r) => !r)}>
          <FileText /> {raw ? "Hide" : "Show"} the technical part
        </button>
        {report.path && (
          <button className="btn ghost sm" onClick={() => api.openPath(report.path)}>
            Open the full report
          </button>
        )}
      </div>
      {raw && (
        <motion.pre className="crash-pre" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}>
          {report.exception ? report.exception + "\n\n" : ""}
          {report.excerpt}
        </motion.pre>
      )}
    </div>
  );
}

export default function CrashModal({ inst, report }: { inst: string; report: CrashReport }) {
  const close = () => {
    sfx.close();
    useStore.setState({ crash: null });
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  const name = useStore((s) => s.instances.find((i) => i.id === inst)?.name ?? inst);
  return (
    <motion.div className="modal-back crash-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <motion.div className="modal crash-modal" initial={{ opacity: 0, y: 30, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 14, scale: 0.98 }} transition={{ type: "spring", stiffness: 340, damping: 30 }}>
        <div className="crash-glow" />
        <div className="modal-head">
          <motion.div className="crash-icon" initial={{ rotate: -20, scale: 0.6 }} animate={{ rotate: 0, scale: 1 }} transition={{ type: "spring", stiffness: 300, damping: 12, delay: 0.1 }}>
            <Bug size={22} />
          </motion.div>
          <div>
            <div className="crash-kicker">
              {name} crashed · {fmtAgo(report.time)}
            </div>
            <h3>{report.title}</h3>
          </div>
          <button className="iconbtn" onClick={close}>
            <X />
          </button>
        </div>
        <CrashBody inst={inst} report={report} onDone={close} />
      </motion.div>
    </motion.div>
  );
}
