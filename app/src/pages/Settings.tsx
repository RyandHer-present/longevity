import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Check, FolderOpen, Power } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { Engine } from "../render/engine";
import { Switch, Spinner } from "../ui";
import { sfx } from "../sound";
import { UpdateRow } from "../tools/Updater";

/** Colour themes; the palettes live in themes.css. "atlas" is the original look. */
export const THEMES: { id: string; name: string; sub: string }[] = [
  { id: "atlas", name: "Atlas", sub: "The original gold" },
  { id: "nether", name: "Nether", sub: "Crimson and ember" },
  { id: "end", name: "The End", sub: "Void purple, end stone" },
  { id: "deep_dark", name: "Deep Dark", sub: "Sculk on black" },
  { id: "cherry", name: "Cherry Grove", sub: "Blossom pink" },
  { id: "ocean", name: "Ocean", sub: "Prismarine and sea lantern" },
  { id: "lush", name: "Lush Caves", sub: "Moss and glow berries" },
  { id: "desert", name: "Desert", sub: "Sandstone and terracotta" },
  { id: "pale_garden", name: "Pale Garden", sub: "Ashen, one orange eye" },
  { id: "snowy", name: "Snowy Peaks", sub: "Ice blue" },
];

type VTDoc = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };

/** Switch theme with a circle that grows out of the clicked swatch. */
function switchTheme(apply: () => void, el: HTMLElement, e: React.MouseEvent) {
  const doc = document as VTDoc;
  const root = document.documentElement;
  if (!("startViewTransition" in document) || !doc.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    apply();
    return;
  }
  let x = e.clientX;
  let y = e.clientY;
  if (!x && !y) {
    const r = el.getBoundingClientRect();
    x = r.left + r.width / 2;
    y = r.top + r.height / 2;
  }
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  root.style.setProperty("--vt-x", `${x}px`);
  root.style.setProperty("--vt-y", `${y}px`);
  root.style.setProperty("--vt-r", `${Math.ceil(radius) + 2}px`);
  root.classList.add("theme-switching");
  try {
    doc.startViewTransition(() => flushSync(apply)).finished.finally(() => root.classList.remove("theme-switching"));
  } catch {
    root.classList.remove("theme-switching");
    apply();
  }
}

function Row({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div>
        <div className="set-t">{title}</div>
        {sub && <div className="set-s">{sub}</div>}
      </div>
      <div className="set-c">{children}</div>
    </div>
  );
}

export default function SettingsPage() {
  const settings = useStore((s) => s.settings);
  const info = useStore((s) => s.info);
  const world = useStore((s) => s.world);
  const save = useStore((s) => s.saveSettings);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  useEffect(() => {
    api.getAutostart().then(setAutostart).catch(() => {});
  }, []);
  if (!settings) return null;
  return (
    <div className="page-pad" style={{ maxWidth: 860 }}>
      <div className="page-head">
        <div>
          <div className="kicker">Preferences</div>
          <h1>Settings</h1>
        </div>
      </div>

      <div className="set-group">
        <div className="section-label">Appearance</div>
        <div className="panel">
          <div className="theme-grid">
            {THEMES.map((t) => {
              const on = (settings.theme || "atlas") === t.id;
              return (
                <button
                  key={t.id}
                  className={"tsw" + (on ? " on" : "")}
                  data-tp={t.id}
                  title={t.name}
                  onClick={(e) => {
                    if (on) return;
                    sfx.click();
                    switchTheme(() => void save({ theme: t.id }), e.currentTarget, e);
                  }}
                >
                  <div className="tsw-prev">
                    <div className="tsw-side">
                      <i />
                      <i />
                      <i />
                    </div>
                    <div className="tsw-main">
                      <div className="tsw-bar" />
                      <div className="tsw-card">
                        <b />
                        <span />
                      </div>
                      <div className="tsw-dots">
                        <i />
                        <i />
                        <i />
                      </div>
                    </div>
                    {on && (
                      <span className="tsw-check">
                        <Check size={12} strokeWidth={3} />
                      </span>
                    )}
                  </div>
                  <div className="tsw-name">{t.name}</div>
                  <div className="tsw-sub">{t.sub}</div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="set-group">
        <div className="section-label">3D view</div>
        <div className="panel">
          <Row title="Quality" sub="Shadows, bloom and resolution. Lower it if the 3D view feels slow.">
            <div className="seg">
              {["low", "high", "ultra"].map((q) => (
                <button
                  key={q}
                  className={settings.quality === q ? "on" : ""}
                  onClick={() => {
                    save({ quality: q });
                    Engine.get().applyQuality(q);
                  }}
                >
                  {q[0].toUpperCase() + q.slice(1)}
                </button>
              ))}
            </div>
          </Row>
          <Row title="Render distance" sub={`${settings.render_distance} chunks of full detail; the rest of what you've seen is drawn as distant terrain.`}>
            <input
              type="range"
              min={6}
              max={24}
              value={settings.render_distance}
              onChange={(e) => {
                const v = +e.target.value;
                save({ render_distance: v });
                Engine.get().setRenderDistance(v);
              }}
              style={{ width: 180 }}
            />
          </Row>
        </div>
      </div>

      <div className="set-group">
        <div className="section-label">General</div>
        <div className="panel">
          <Row title="Interface sounds" sub="Quiet clicks and page turns.">
            <Switch on={settings.sounds} onChange={(v) => save({ sounds: v })} />
          </Row>
        </div>
      </div>

      <div className="set-group">
        <div className="section-label">Longevity</div>
        <div className="panel">
          <Row title="Start with Windows" sub="Starts quietly in the tray, so session recaps and card packs are ready the moment you quit Minecraft.">
            <Switch
              on={!!autostart}
              onChange={async (v) => {
                setAutostart(await api.setAutostart(v).catch(() => !v));
              }}
            />
          </Row>
          <Row title="Icons-only sidebar" sub="A slimmer sidebar; hover an icon to see its name.">
            <Switch on={!!settings.nav_collapsed} onChange={(v) => save({ nav_collapsed: v })} />
          </Row>
        </div>
      </div>

      <div className="set-group">
        <div className="section-label">Notifications</div>
        <div className="panel">
          <Row title="Goal done" sub="When a Project Planner goal gets finished during your last session.">
            <Switch on={settings.notify_goals ?? true} onChange={(v) => save({ notify_goals: v })} />
          </Row>
          <Row title="Streak reminder" sub="In the evening, if you haven't played LongTerm today and your streak would end.">
            <Switch on={settings.notify_streak ?? true} onChange={(v) => save({ notify_streak: v })} />
          </Row>
        </div>
      </div>

      <div className="set-group">
        <div className="section-label">About</div>
        <div className="panel">
          {world && (
            <Row title="Your world" sub="Longevity only reads your save. It never changes a single block.">
              <button className="btn sm" onClick={() => api.openPath(world.path)}>
                <FolderOpen /> Save folder
              </button>
            </Row>
          )}
          <UpdateRow />
          <Row title="Longevity" sub={`Version ${info?.app_version ?? ""} · Minecraft ${info?.mc_version ?? "?"} files read from your own game.`}>
            <button className="btn sm danger" onClick={() => api.quitApp()}>
              <Power /> Quit completely
            </button>
          </Row>
        </div>
      </div>
    </div>
  );
}
