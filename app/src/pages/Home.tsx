import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, Box, Skull, Trophy, Footprints, CalendarDays } from "lucide-react";
import { api, dimName, fmtAgo, fmtDist, fmtTicks, timeOfDay, type GameEvent, type Place, type PlayerStats } from "../api";
import Glance from "../tools/Glance";
import { useStore } from "../store";
import { Engine } from "../render/engine";
import { HudRow, ItemIcon, Sprite, Ticker } from "../ui";
import { sfx } from "../sound";
import { EventGlyph } from "./Timeline";

const TIMES: { id: string; label: string; t: number | null }[] = [
  { id: "live", label: "World time", t: null },
  { id: "dawn", label: "Dawn", t: 23400 },
  { id: "noon", label: "Noon", t: 6000 },
  { id: "dusk", label: "Dusk", t: 12300 },
  { id: "night", label: "Night", t: 18000 },
];

export default function Home() {
  const world = useStore((s) => s.world)!;
  const live = useStore((s) => s.live);
  const setPage = useStore((s) => s.setPage);
  const flyTo = useStore((s) => s.flyTo);
  const host = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [home, setHome] = useState<Place | null>(null);
  const [time, setTime] = useState("live");
  const player = world.players[0];

  useEffect(() => {
    const eng = Engine.get();
    eng.setMode("cinematic");
    eng.timeOverride = null;
    const el = host.current;
    if (el) eng.attach(el);
    return () => {
      if (eng.container !== el) return; // another page already took the engine over
      eng.timeOverride = null;
      eng.detach(el);
    };
  }, []);

  useEffect(() => {
    api.playerStats().then(setStats).catch(() => {});
    api.timeline().then((t) => setEvents(t.events.filter((e) => !e.kind.startsWith("session")).slice(-5).reverse())).catch(() => {});
    api
      .places()
      .then((ps) => {
        const h = ps.find((p) => p.kind === "home" && !p.hidden) ?? null;
        setHome(h);
        const eng = Engine.get();
        if (h) {
          if (h.dim !== useStore.getState().dim) useStore.setState({ dim: h.dim });
          eng.setPOI(h.center[0], h.center[1], h.center[2]);
        } else if (player) eng.setPOI(player.pos[0], player.pos[1], player.pos[2]);
        else if (world.spawn) eng.setPOI(world.spawn[0], world.spawn[1], world.spawn[2]);
      })
      .catch(() => {});
  }, [world.path]);

  useEffect(() => {
    Engine.get().timeOverride = TIMES.find((t) => t.id === time)?.t ?? null;
  }, [time]);

  const s = stats?.summary;
  const tod = timeOfDay(world.day_time);
  const weather = world.thundering ? "Thunderstorm" : world.raining ? "Rain" : "Clear skies";
  const walked = s ? (s.distance.walk ?? 0) + (s.distance.sprint ?? 0) + (s.distance.crouch ?? 0) : 0;
  const diff = ["Peaceful", "Easy", "Normal", "Hard"][world.difficulty] ?? "Normal";

  return (
    <div className="home">
      <div className="home-canvas" ref={host} />
      <div className="home-shade" />
      <motion.div className="home-hero" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.7, ease: [0.22, 0.7, 0.18, 1] }}>
        <div className="home-kicker">
          <span>Day {world.day.toLocaleString()}</span>
          <i />
          <span>{tod.label}</span>
          <i />
          <span>{weather}</span>
          {world.hardcore && (
            <>
              <i />
              <span style={{ color: "var(--red)" }}>Hardcore</span>
            </>
          )}
        </div>
        <h1 className="home-title">{world.name || world.folder}</h1>
        <div className="home-sub">
          {world.player}'s world · {diff}
          {s ? <> · {fmtTicks(s.play_ticks)} played</> : null}
          {home?.name ? <> · home is {home.name}</> : null}
        </div>
        <div className="home-stats">
          <div className="hs">
            <CalendarDays />
            <div>
              <div className="v">
                <Ticker value={world.day} />
              </div>
              <div className="k">days survived</div>
            </div>
          </div>
          <div className="hs">
            <Skull />
            <div>
              <div className="v">
                <Ticker value={s?.deaths ?? 0} />
              </div>
              <div className="k">deaths</div>
            </div>
          </div>
          <div className="hs">
            <Footprints />
            <div>
              <div className="v num">{s ? fmtDist(walked) : "–"}</div>
              <div className="k">on foot</div>
            </div>
          </div>
          <div className="hs">
            <Trophy />
            <div>
              <div className="v">
                <Ticker value={stats?.advancements.length ?? 0} />
                <span className="of">/{stats?.advancements_total ?? "–"}</span>
              </div>
              <div className="k">advancements</div>
            </div>
          </div>
        </div>
        <div className="home-cta">
          <button
            className="btn primary"
            onClick={() => {
              sfx.click();
              const p = home?.center ?? (player ? [player.pos[0], player.pos[1], player.pos[2]] : [0, 64, 0]);
              flyTo({ x: p[0], y: p[1], z: p[2], dim: home?.dim ?? player?.dim ?? "minecraft:overworld" });
            }}
          >
            <Box /> Explore in 3D
          </button>
          <button className="btn" onClick={() => setPage("map")}>
            Open the map <ArrowRight />
          </button>
        </div>
      </motion.div>

      <motion.div className="home-side" initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.3, duration: 0.7, ease: [0.22, 0.7, 0.18, 1] }}>
        {player && (
          <div className="glass hcard">
            <div className="panel-title">
              {live ? "Right now" : "Where you left off"}
              <span className="r" style={{ textTransform: "none", letterSpacing: 0, fontFamily: "var(--ui)", fontSize: 11 }}>
                {live ? <span style={{ color: "var(--green)" }}>playing</span> : world.last_played ? fmtAgo(world.last_played) : ""}
              </span>
            </div>
            <div className="now-row">
              <div>
                <div className="now-place">{dimName(player.dim)}</div>
                <div className="coords">
                  X {Math.floor(player.pos[0])} · Y {Math.floor(player.pos[1])} · Z {Math.floor(player.pos[2])}
                </div>
              </div>
              {player.hand && (
                <div className="slot" title={player.hand.name ?? ""}>
                  <ItemIcon id={player.hand.id} size={28} />
                </div>
              )}
            </div>
            <div className="hud">
              <HudRow kind="heart" value={player.health} hardcore={world.hardcore} />
              <HudRow kind="food" value={player.food} />
            </div>
            <div className="xp">
              <span className="lvl">{player.xp_level}</span>
              <span className="muted">experience level{player.game_type === 1 ? " · creative" : player.game_type === 3 ? " · spectator" : ""}</span>
            </div>
          </div>
        )}

        <Glance />

        {events.length > 0 && (
          <div className="glass hcard">
            <div className="panel-title">
              Lately
              <button className="r btn ghost sm" style={{ height: 20 }} onClick={() => setPage("stats")}>
                all
              </button>
            </div>
            <div className="recent">
              {events.map((e, i) => (
                <div key={i} className="recent-row">
                  <EventGlyph kind={e.kind} detail={e.detail} />
                  <div className="rr-text">
                    <div className="rr-t">{e.title}</div>
                    <div className="rr-s">{e.day !== null ? `Day ${Math.floor(e.day) + 1}` : ""}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </motion.div>

      <div className="home-time">
        <div className="seg">
          {TIMES.map((t) => (
            <button key={t.id} className={time === t.id ? "on" : ""} onClick={() => setTime(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
