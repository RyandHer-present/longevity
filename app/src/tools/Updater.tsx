// Longevity's own updates: a quiet check a little after start (and every few hours), a small card
// when a new version is out, and a "Check for updates" row in Settings.
import { useEffect } from "react";
import { create } from "zustand";
import { AnimatePresence, motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Download, X } from "lucide-react";
import { sfx } from "../sound";

export interface AppUpdate {
  current: string;
  latest: string | null;
  notes: string;
  url: string | null;
  size: number;
}

interface UpdState {
  info: AppUpdate | null;
  checking: boolean;
  error: string | null;
  checkedAt: number;
  dismissed: string | null;
  installing: boolean;
  progress: number;
  check: () => Promise<void>;
  install: () => Promise<void>;
}

export const useUpdate = create<UpdState>((set, get) => ({
  info: null,
  checking: false,
  error: null,
  checkedAt: 0,
  dismissed: null,
  installing: false,
  progress: 0,
  check: async () => {
    if (get().checking) return;
    set({ checking: true, error: null });
    try {
      const info = await invoke<AppUpdate>("update_check");
      set({ info, checkedAt: Date.now() });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ checking: false });
    }
  },
  install: async () => {
    const url = get().info?.url;
    if (!url || get().installing) return;
    set({ installing: true, progress: 0, error: null });
    const un = await listen<{ done: number; total: number }>("update-progress", (e) => set({ progress: e.payload.total ? e.payload.done / e.payload.total : 0 }));
    try {
      await invoke("update_install", { url });
    } catch (e) {
      set({ installing: false, error: String(e) });
    } finally {
      un();
    }
  },
}));

const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;

/** Mounted once in App: checks in the background and shows the card. */
export function UpdateCard() {
  const { info, dismissed, installing, progress, error, check, install } = useUpdate();
  useEffect(() => {
    const first = setTimeout(() => void check(), 25_000);
    const again = setInterval(() => void check(), 6 * 3600_000);
    return () => {
      clearTimeout(first);
      clearInterval(again);
    };
  }, [check]);
  const show = !!info?.latest && dismissed !== info.latest;
  const notes = (info?.notes || "")
    .split("\n")
    .map((l) => l.replace(/^[-*#\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 4);
  return (
    <AnimatePresence>
      {show && info && (
        <motion.div className="upd-card glass" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}>
          <div className="upd-head">
            <Download size={16} />
            <b>Longevity {info.latest} is out</b>
            {!installing && (
              <button className="iconbtn" title="Later" onClick={() => useUpdate.setState({ dismissed: info.latest })}>
                <X size={14} />
              </button>
            )}
          </div>
          {notes.length > 0 && (
            <ul className="upd-notes">
              {notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          {error && <div className="upd-err">{error}</div>}
          {installing ? (
            <div className="upd-bar">
              <i style={{ width: `${Math.round(progress * 100)}%` }} />
              <span>{progress < 1 ? `Downloading… ${Math.round(progress * 100)}%` : "Installing, Longevity will open again by itself"}</span>
            </div>
          ) : (
            <div className="upd-btns">
              <button
                className="btn sm primary"
                onClick={() => {
                  sfx.click();
                  void install();
                }}
              >
                Update now{info.size ? ` (${mb(info.size)})` : ""}
              </button>
              <button className="btn sm ghost" onClick={() => useUpdate.setState({ dismissed: info.latest })}>
                Later
              </button>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The row in Settings. */
export function UpdateRow() {
  const { info, checking, error, checkedAt, installing, check, install } = useUpdate();
  const status = checking
    ? "Looking…"
    : error
      ? `Couldn't check: ${error}`
      : info?.latest
        ? `Version ${info.latest} is out (you have ${info.current}).`
        : checkedAt
          ? `You have the newest version (${info?.current}).`
          : "Longevity looks for updates by itself a little after it starts.";
  return (
    <div className="set-row">
      <div>
        <div className="set-t">Updates</div>
        <div className="set-s">{status}</div>
      </div>
      <div className="set-c">
      {info?.latest ? (
        <button className="btn sm primary" disabled={installing} onClick={() => void install()}>
          <Download size={14} /> {installing ? "Updating…" : "Update now"}
        </button>
      ) : (
        <button className="btn sm" disabled={checking} onClick={() => void check()}>
          Check now
        </button>
      )}
      </div>
    </div>
  );
}
