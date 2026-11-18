import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/eb-garamond";
import "@fontsource/im-fell-english";
import "@fontsource/im-fell-english/400-italic.css";
import "@fontsource/silkscreen";
import "./styles.css";
import "./pages/pages.css";
import "./pages/dex.css";
import "./themes.css";
import "./launcher/launcher.css";
import "./launcher/launcher2.css";
import "./tools/tools.css";
import "./tools/tools2.css";
import App from "./App";
import { Engine } from "./render/engine";
import { RecapWindow } from "./tools/Recap";
import "./tools/sources";
import { useStore } from "./store";
import { useStore as useL } from "./launcher/store";

// handles for automated, off-screen checks
(window as any).__lv = useStore;
(window as any).__ll = useL;
(window as any).__eng = () => Engine.get();

window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!(t.tagName === "INPUT" || t.tagName === "TEXTAREA")) e.preventDefault();
});

// the after-game recap card is its own small transparent window
const isRecap = location.hash === "#recap";
createRoot(document.getElementById("root")!).render(isRecap ? <RecapWindow /> : <App />);
