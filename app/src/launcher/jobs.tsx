// Long installs: progress rings on the instance they're going into, and the icon that flies there.
import { useEffect } from "react";
import { create } from "zustand";
import { AnimatePresence, motion } from "framer-motion";
import { Check } from "lucide-react";
import { listen } from "@tauri-apps/api/event";

export interface Job {
  id: string;
  /** instance id, or "new" for something that becomes a new instance */
  inst: string;
  label: string;
  /** 0..1, or -1 while there's no number yet */
  pct: number;
  done: boolean;
}

interface Flight {
  id: number;
  icon: string | null;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

interface JobState {
  jobs: Record<string, Job>;
  flights: Flight[];
}

export const useJobs = create<JobState>(() => ({ jobs: {}, flights: [] }));

let seq = 0;

/** Where something for `inst` flies to: its card on the Instances page if it's showing, else the sidebar. */
function targetRect(inst: string): DOMRect | null {
  const sel = inst === "new" ? `[data-job-target="new"]` : `[data-inst-target="${CSS.escape(inst)}"]`;
  const els = [...document.querySelectorAll<HTMLElement>(sel)].filter((e) => e.offsetParent !== null);
  const el = els[0] ?? document.querySelector<HTMLElement>(inst === "new" ? `[data-job-target="new"]` : ".ipick-btn .ipick-icon");
  return el ? el.getBoundingClientRect() : null;
}

export function fly(inst: string, from: Element | DOMRect | null | undefined, icon: string | null) {
  if (!from) return;
  const r = from instanceof Element ? from.getBoundingClientRect() : from;
  const t = targetRect(inst);
  if (!t) return;
  const f: Flight = { id: ++seq, icon, from: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, to: { x: t.left + t.width / 2, y: t.top + t.height / 2 } };
  useJobs.setState((s) => ({ flights: [...s.flights, f] }));
  setTimeout(() => useJobs.setState((s) => ({ flights: s.flights.filter((x) => x.id !== f.id) })), 1100);
}

/** Run something long with a ring on its instance. `run` gets the job id to pass to the backend. */
export async function runJob<T>(opts: { inst: string; label: string; icon?: string | null; from?: Element | DOMRect | null }, run: (job: string) => Promise<T>): Promise<T> {
  const id = `job${Date.now()}_${++seq}`;
  useJobs.setState((s) => ({ jobs: { ...s.jobs, [id]: { id, inst: opts.inst, label: opts.label, pct: -1, done: false } } }));
  fly(opts.inst, opts.from, opts.icon ?? null);
  const drop = () =>
    useJobs.setState((s) => {
      const j = { ...s.jobs };
      delete j[id];
      return { jobs: j };
    });
  try {
    const r = await run(id);
    useJobs.setState((s) => ({ jobs: { ...s.jobs, [id]: { ...s.jobs[id], pct: 1, done: true } } }));
    setTimeout(drop, 1400);
    return r;
  } catch (e) {
    drop();
    throw e;
  }
}

/** Listens for the backend's progress events. Mount once. */
export function useJobEvents() {
  useEffect(() => {
    const un = listen<{ job: string; pct: number; label: string }>("job", (e) => {
      const { job, pct, label } = e.payload;
      useJobs.setState((s) => (s.jobs[job] && !s.jobs[job].done ? { jobs: { ...s.jobs, [job]: { ...s.jobs[job], pct, label } } } : s));
    });
    return () => {
      un.then((f) => f());
    };
  }, []);
}

export function useInstJobs(inst: string): Job[] {
  return Object.values(useJobs((s) => s.jobs)).filter((j) => j.inst === inst);
}

/** A ring drawn around an icon while something installs into it; pops with a check when done. */
export function Ring({ inst, size = 36 }: { inst: string; size?: number }) {
  const jobs = useInstJobs(inst);
  const active = jobs.filter((j) => !j.done);
  const done = jobs.length > 0 && active.length === 0;
  const known = active.filter((j) => j.pct >= 0);
  const pct = known.length ? known.reduce((a, j) => a + j.pct, 0) / known.length : -1;
  const r = size / 2 + 3;
  const c = 2 * Math.PI * r;
  return (
    <AnimatePresence>
      {jobs.length > 0 && (
        <motion.span
          key="ring"
          className={"jobring" + (done ? " done" : "") + (pct < 0 && !done ? " spin" : "")}
          style={{ width: r * 2 + 4, height: r * 2 + 4 }}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={done ? { opacity: 1, scale: [1, 1.22, 1] } : { opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 1.3 }}
          transition={{ duration: done ? 0.45 : 0.25 }}
          title={active[0]?.label}
        >
          <svg viewBox={`0 0 ${r * 2 + 4} ${r * 2 + 4}`}>
            <circle cx={r + 2} cy={r + 2} r={r} className="track" />
            <motion.circle
              cx={r + 2}
              cy={r + 2}
              r={r}
              className="fill"
              strokeDasharray={c}
              animate={{ strokeDashoffset: done ? 0 : pct < 0 ? c * 0.72 : c * (1 - Math.max(0.04, pct)) }}
              transition={{ duration: 0.35, ease: "easeOut" }}
            />
          </svg>
          {done && (
            <motion.i className="jobcheck" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 500, damping: 18 }}>
              <Check size={10} strokeWidth={3.2} />
            </motion.i>
          )}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

/** The flying icons. Mount once at the top. */
export function Flights() {
  const flights = useJobs((s) => s.flights);
  return (
    <div className="flights">
      {flights.map((f) => {
        const mx = (f.from.x + f.to.x) / 2;
        const my = Math.min(f.from.y, f.to.y) - 140;
        return (
          <motion.div
            key={f.id}
            className="flyer"
            initial={{ x: f.from.x - 22, y: f.from.y - 22, scale: 0.6, opacity: 0 }}
            animate={{ x: [f.from.x - 22, mx - 22, f.to.x - 22], y: [f.from.y - 22, my - 22, f.to.y - 22], scale: [0.6, 1.25, 0.35], opacity: [0, 1, 0.9], rotate: [0, -12, 8] }}
            transition={{ duration: 0.85, ease: [0.45, 0, 0.3, 1], times: [0, 0.45, 1] }}
          >
            {f.icon ? <img src={f.icon} /> : <span className="flyer-dot" />}
          </motion.div>
        );
      })}
    </div>
  );
}
