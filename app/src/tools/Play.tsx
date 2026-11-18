// Play: LongTerm big on top with a live 3D view of the base, astera below. Other instances live on
// the Instances page only (the user only plays these two).
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Play as PlayIcon, Square, Clock3, Blocks, Globe2, Server, ChevronRight, LayoutGrid } from "lucide-react";
import { api as lapi, fmtAgo, fmtPlay, instIconUrl, loaderName, type Instance, type WorldItem } from "../launcher/api";
import { useStore as useL } from "../launcher/store";
import { useStore } from "../store";
import { Engine } from "../render/engine";
import { sfx } from "../sound";
import { api } from "../api";

const isLongTerm = (i: Instance) => /^longterm$/i.test(i.name) || /^longterm$/i.test(i.id);
const isAstera = (i: Instance) => /^astera$/i.test(i.name) || /^astera$/i.test(i.id);
const MAIN_WORLD = /^longevity \(1\)$/i;

function useLaunch() {
  const launching = useL((s) => s.launching);
  const running = useL((s) => s.running);
  const toast = useL((s) => s.toast);
  async function go(i: Instance, world?: string | null) {
    if (running[i.id]) {
      sfx.click();
      await lapi.stopGame(i.id).catch((e) => toast(String(e), "err"));
      return;
    }
    sfx.open();
    useL.setState({ launching: i.id });
    try {
      await lapi.launch(i.id, null, world ?? null);
      toast(world ? `Starting ${i.name} straight into ${world}` : `Starting ${i.name}`, "ok");
    } catch (e) {
      useL.setState({ launching: null });
      toast(String(e), "err");
    }
  }
  return { go, launching, running };
}

function Hero({ inst }: { inst: Instance }) {
  const host = useRef<HTMLDivElement>(null);
  const world = useStore((s) => s.world);
  const [worlds, setWorlds] = useState<WorldItem[]>([]);
  const { go, launching, running } = useLaunch();
  const isRunning = !!running[inst.id];
  const main = worlds.find((w) => MAIN_WORLD.test(w.name) || MAIN_WORLD.test(w.folder)) ?? worlds[0];

  useEffect(() => {
    lapi.worlds(inst.id).then(setWorlds).catch(() => {});
  }, [inst.id, inst.last_launch]);

  // the base, live, behind the card
  useEffect(() => {
    if (!world) return;
    const eng = Engine.get();
    eng.setMode("cinematic");
    eng.timeOverride = null;
    const el = host.current;
    if (el) eng.attach(el);
    api
      .places()
      .then((ps) => {
        const h = ps.find((p) => p.kind === "home" && !p.hidden);
        const p = world.players[0];
        if (h) eng.setPOI(h.center[0], h.center[1], h.center[2]);
        else if (p) eng.setPOI(p.pos[0], p.pos[1], p.pos[2]);
      })
      .catch(() => {});
    return () => {
      if (eng.container === el) eng.detach(el);
    };
  }, [world?.path]);

  return (
    <motion.div className="play-hero" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: [0.2, 0.7, 0.2, 1] }}>
      <div className="play-hero-canvas" ref={host} />
      <div className="play-hero-shade" />
      <div className="play-hero-body">
        <div className="kicker">Your survival world</div>
        <h1>{main?.name ?? "LongTerm"}</h1>
        <div className="play-hero-meta">
          <span>
            <Globe2 size={13} /> Day {(main?.day ?? world?.day ?? 0).toLocaleString()}
          </span>
          <span>
            <Clock3 size={13} /> {fmtPlay(inst.total_played)} played
          </span>
          <span>
            <Blocks size={13} /> {inst.mods} mods · {inst.mc_version} {loaderName(inst.loader)}
          </span>
          {inst.last_launch > 0 && <span>Last played {fmtAgo(inst.last_launch)}</span>}
        </div>
        <div className="play-hero-actions">
          <button className={"btn play-big" + (isRunning ? " stop" : "")} disabled={launching === inst.id && !isRunning} onClick={() => go(inst, isRunning ? null : main?.folder)} onMouseEnter={() => sfx.hover()}>
            {isRunning ? <Square size={18} /> : <PlayIcon size={20} fill="currentColor" />}
            <span>{isRunning ? "Stop" : launching === inst.id ? "Starting…" : "Play"}</span>
            {!isRunning && main && <i>straight into {main.name}</i>}
          </button>
          {!isRunning && (
            <button className="btn ghost" onClick={() => go(inst, null)} onMouseEnter={() => sfx.hover()}>
              Title screen
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function SmallCard({ inst, sub, delay }: { inst: Instance; sub: string; delay: number }) {
  const { go, launching, running } = useLaunch();
  const isRunning = !!running[inst.id];
  return (
    <motion.div className="play-card glass" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay, duration: 0.4 }}>
      <img className="play-card-icon px" src={instIconUrl(inst.icon)} alt="" />
      <div className="play-card-main">
        <div className="play-card-name">{inst.name}</div>
        <div className="play-card-sub">{sub}</div>
        <div className="play-card-meta">
          {inst.mc_version} {loaderName(inst.loader)} · {inst.mods} mods · {fmtPlay(inst.total_played)}
          {inst.last_launch > 0 ? ` · ${fmtAgo(inst.last_launch)}` : ""}
        </div>
      </div>
      <button className={"btn" + (isRunning ? " stop" : " primary")} disabled={launching === inst.id && !isRunning} onClick={() => go(inst)} onMouseEnter={() => sfx.hover()}>
        {isRunning ? <Square size={14} /> : <PlayIcon size={14} fill="currentColor" />}
        {isRunning ? "Stop" : launching === inst.id ? "Starting…" : "Play"}
      </button>
    </motion.div>
  );
}

export default function Play() {
  const instances = useL((s) => s.instances);
  const info = useL((s) => s.info);
  const setPage = useStore((s) => s.setPage);
  const lt = instances.find(isLongTerm);
  const astera = instances.find(isAstera);
  if (info && !info.prism) {
    return (
      <div className="page-pad">
        <div className="empty glass">
          <h3>Prism Launcher wasn't found</h3>
          <p>Longevity signs in and starts the game through Prism, hidden. Install it from prismlauncher.org first.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="play-page page-pad">
      {lt ? <Hero inst={lt} /> : <div className="empty glass">Looking for your LongTerm instance…</div>}
      <div className="play-row">
        {astera && <SmallCard inst={astera} sub="For playing on servers" delay={0.12} />}
        <motion.button className="play-more glass" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.4 }} onClick={() => setPage("instances")} onMouseEnter={() => sfx.hover()}>
          <LayoutGrid size={18} />
          <div>
            <b>All instances</b>
            <span>{Math.max(0, instances.length - (lt ? 1 : 0) - (astera ? 1 : 0))} more, kept out of the way</span>
          </div>
          <ChevronRight size={16} />
        </motion.button>
      </div>
      {!astera && instances.length > 0 && (
        <p className="muted small">
          <Server size={12} /> No "astera" instance found.
        </p>
      )}
    </div>
  );
}
