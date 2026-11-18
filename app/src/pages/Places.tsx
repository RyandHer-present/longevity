import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Box, Check, EyeOff, Eye, Feather, Map as MapIcon, Pencil, X } from "lucide-react";
import { api, dimName, fmtNum, plateUrl, prettyId, type Place } from "../api";
import { useStore } from "../store";
import { Engine } from "../render/engine";
import { Spinner, Empty } from "../ui";
import { sfx } from "../sound";

const safe = (k: string) => k.replace(/[^A-Za-z0-9_-]/g, "_");

/** Renders (or loads a cached render of) a place, one at a time. */
const queue: (() => Promise<void>)[] = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift()!;
    try {
      await job();
    } catch {
      /* skip */
    }
  }
  busy = false;
}

/** Queue an engine capture behind the others (only one runs at a time). */
export function enqueueRender(job: () => Promise<void>) {
  queue.push(job);
  pump();
}

export function usePlaceRender(p: Place | null, worldId: string, style: "render" | "drawn" = "render", w = 640, h = 400) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "rendering" | "done" | "none">("idle");
  const dim = useStore((s) => s.dim);
  useEffect(() => {
    if (!p) return;
    let alive = true;
    const key = `${style === "drawn" ? "drawn" : "place"}-${p.id}`;
    const cached = plateUrl(`plate/${worldId}/${safe(key)}.jpg`);
    setState("loading");
    const img = new Image();
    img.onload = () => {
      if (!alive) return;
      setUrl(cached + "?t=" + Date.now());
      setState("done");
    };
    img.onerror = () => {
      if (!alive) return;
      if (p.dim !== dim) {
        setState("none");
        return;
      }
      setState("rendering");
      queue.push(async () => {
        if (!alive) return;
        const data = await Engine.get().capturePlace(p.center[0], p.center[1], p.center[2], { width: w, height: h, style, type: "jpeg", dayTime: style === "drawn" ? 6000 : 2500, dist: p.kind === "home" ? 58 : 46 });
        const rel = await api.savePlate(key, data);
        if (alive) {
          setUrl(plateUrl(rel) + "?t=" + Date.now());
          setState("done");
        }
      });
      pump();
    };
    img.src = cached;
    return () => {
      alive = false;
    };
  }, [p?.id, worldId, style, dim]);
  return { url, state };
}

function PlaceCard({ p, worldId, onChange, i }: { p: Place; worldId: string; onChange: (ps: Place[]) => void; i: number }) {
  const { url, state } = usePlaceRender(p, worldId);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [notes, setNotes] = useState(p.notes);
  const flyTo = useStore((s) => s.flyTo);
  const setPage = useStore((s) => s.setPage);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setName(p.name), [p.name]);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);
  const save = async (patch: Parameters<typeof api.placeUpdate>[1]) => onChange(await api.placeUpdate(p.id, patch));
  const minutes = Math.round(p.score);
  return (
    <motion.div className={"place-card panel" + (p.hidden ? " hidden" : "")} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.04 }}>
      <div className="pc-img">
        {url ? <img src={url} alt="" /> : <div className="pc-ph">{state === "rendering" ? <><Spinner size={14} /> rendering</> : state === "none" ? dimName(p.dim) : ""}</div>}
        <div className="pc-kind">{prettyId(p.kind)}</div>
      </div>
      <div className="pc-body">
        {editing ? (
          <form
            className="pc-edit"
            onSubmit={(e) => {
              e.preventDefault();
              sfx.click();
              save({ name });
              setEditing(false);
            }}
          >
            <input ref={inputRef} className="input" value={name} placeholder="Give it a name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(false)} />
            <button className="iconbtn" type="submit">
              <Check />
            </button>
          </form>
        ) : (
          <button className="pc-name" onClick={() => setEditing(true)} title="Rename">
            {p.name || <span className="muted">Unnamed {p.kind}</span>}
            <Pencil size={12} />
          </button>
        )}
        <div className="coords">
          {dimName(p.dim)} · {p.center[0]}, {p.center[1]}, {p.center[2]}
          {minutes > 0 ? ` · ${minutes >= 120 ? fmtNum(minutes / 60, 1) + " h" : minutes + " min"} spent here` : ""}
        </div>
        <textarea className="pc-notes" placeholder="Notes…" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== p.notes && save({ notes })} rows={2} />
        <div className="pc-actions">
          <button className="btn sm" onClick={() => flyTo({ x: p.center[0], y: p.center[1], z: p.center[2], dim: p.dim })}>
            <Box /> 3D
          </button>
          <button
            className="btn sm ghost"
            onClick={() => {
              useStore.setState({ dim: p.dim });
              setPage("map");
            }}
          >
            <MapIcon /> Map
          </button>
          <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => save({ hidden: !p.hidden })} title={p.hidden ? "Show on the map and in the book" : "Hide from the map and the book"}>
            {p.hidden ? <Eye /> : <EyeOff />}
          </button>
        </div>
      </div>
    </motion.div>
  );
}

export default function Places() {
  const world = useStore((s) => s.world)!;
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  useEffect(() => {
    api.places().then(setPlaces);
  }, [world.path]);
  if (!places)
    return (
      <div className="page-pad dim" style={{ display: "flex", gap: 10 }}>
        <Spinner /> Finding places…
      </div>
    );
  const suggestions = places.filter((p) => p.suggested && !p.name);
  const visible = places.filter((p) => showHidden || !p.hidden).sort((a, b) => (a.kind === "home" ? -1 : b.kind === "home" ? 1 : b.score - a.score));
  const builds = visible.filter((p) => ["home", "settlement", "outpost"].includes(p.kind));
  const found = visible.filter((p) => !["home", "settlement", "outpost"].includes(p.kind));
  return (
    <div className="page-pad">
      <div className="page-head">
        <div>
          <div className="kicker">Named by you</div>
          <h1>Places</h1>
          <div className="lede">Your builds are found automatically from where you've spent your time; structures appear once you've been there. Name them and they'll show up on the map and in the Lore Book.</div>
        </div>
        <div className="actions">
          <button className={"chip" + (showHidden ? " on" : "")} onClick={() => setShowHidden(!showHidden)}>
            <EyeOff /> Hidden ({places.filter((p) => p.hidden).length})
          </button>
        </div>
      </div>
      {suggestions.length > 0 && (
        <div className="suggest panel">
          <div className="sg-head">
            <Feather size={16} />
            <div>
              <div className="sg-title">The historian has some names in mind</div>
              <div className="muted">Accept the ones you like. Nothing is renamed without you.</div>
            </div>
          </div>
          {suggestions.map((p) => (
            <div key={p.id} className="sg-row">
              <div className="sg-name">“{p.suggested}”</div>
              <div className="sg-for">
                for your {p.kind} at {p.center[0]}, {p.center[2]}
                {p.suggested_reason && <div className="sg-why">{p.suggested_reason}</div>}
              </div>
              <button
                className="btn sm primary"
                onClick={async () => {
                  sfx.chime();
                  setPlaces(await api.placeUpdate(p.id, { accept: true }));
                }}
              >
                <Check /> Use it
              </button>
              <button className="btn sm ghost" onClick={async () => setPlaces(await api.placeUpdate(p.id, { reject: true }))}>
                <X /> No
              </button>
            </div>
          ))}
        </div>
      )}
      {builds.length > 0 && <div className="section-label">Your builds</div>}
      <div className="place-grid">
        {builds.map((p, i) => (
          <PlaceCard key={p.id} p={p} worldId={world.id} onChange={setPlaces} i={i} />
        ))}
      </div>
      {found.length > 0 && <div className="section-label">Found in the world</div>}
      <div className="place-grid">
        {found.map((p, i) => (
          <PlaceCard key={p.id} p={p} worldId={world.id} onChange={setPlaces} i={i} />
        ))}
      </div>
      {visible.length === 0 && <Empty title="No places yet">Spend some time somewhere and it'll appear here.</Empty>}
    </div>
  );
}
