// The Mio Launcher side of Longevity: boot (instances, running games, jobs) and its overlays
// (new-instance wizard, modpack preview, flying job icons, toasts).
import { CrashFinder } from "./finder";
import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { useStore, st } from "./store";
import { Modal } from "./pages/Instances";
import NewInstance from "./pages/NewInstance";
import { ModpackDetails } from "./pages/Store";
import { Flights, useJobEvents } from "./jobs";

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            className={"toast2 " + (t.kind ?? "info")}
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.18 } }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
          >
            <span className="dot" />
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export async function refreshInstances() {
  try {
    const r = await api.instances();
    const s = st();
    useStore.setState({ instances: r.instances, running: r.running });
    if (!s.current || !r.instances.find((i) => i.id === s.current)) {
      const pick = (s.settings?.instance && r.instances.find((i) => i.id === s.settings!.instance)) || r.instances[0];
      if (pick) useStore.setState({ current: pick.id });
    }
    if (s.launching && r.running[s.launching]) useStore.setState({ launching: null });
  } catch {
    /* Prism folder missing; the home page explains */
  }
}

/** Start the launcher side once: settings, instances, and running games. */
export function useLauncherBoot() {
  useJobEvents();
  useEffect(() => {
    (async () => {
      try {
        const i = await api.appInfo();
        // Longevity is about LongTerm: it is the default instance for mods and play
        useStore.setState({ info: i, settings: i.settings, current: i.settings.instance });
        await refreshInstances();
        const s = st();
        if (!i.settings.instance) {
          const lt = s.instances.find((x) => /^longterm$/i.test(x.name) || /^longterm$/i.test(x.id));
          if (lt) useStore.setState({ current: lt.id });
        }
      } catch {
        /* Prism missing: the Play page explains */
      }
    })();
    const poll = window.setInterval(refreshInstances, 4000);
    const uns = [
      listen("game-started", () => refreshInstances()),
      listen("game-stopped", () => {
        refreshInstances();
        useStore.setState({ launching: null });
      }),
    ];
    return () => {
      window.clearInterval(poll);
      uns.forEach((u) => u.then((f) => f()));
    };
  }, []);
}

export function LauncherOverlays() {
  const wizard = useStore((s) => s.wizard);
  const packPreview = useStore((s) => s.packPreview);
  return (
    <>
      <AnimatePresence>{wizard && <NewInstance key="wizard" />}</AnimatePresence>
      <AnimatePresence>
        {packPreview && (
          <Modal key="packprev" title="Install a modpack" wide onClose={() => useStore.setState({ packPreview: null })}>
            <ModpackDetails src={packPreview} onDone={() => {}} />
          </Modal>
        )}
      </AnimatePresence>
      <Flights />
      <CrashFinder />
      <Toasts />
    </>
  );
}
