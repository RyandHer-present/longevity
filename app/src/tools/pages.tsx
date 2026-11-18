// Routes for Longevity's own tool pages.
import type { Page } from "../store";
import Villagers from "./Villagers";
import Farms from "./Farms";
import Projects from "./Projects";
import Gear from "./Gear";
import Lookup from "./Lookup";
import Changelog from "./Changelog";

export function ToolPage({ page }: { page: Page }) {
  switch (page) {
    case "villagers":
      return <Villagers />;
    case "farms":
      return <Farms />;
    case "projects":
      return <Projects />;
    case "gear":
      return <Gear />;
    case "lookup":
      return <Lookup />;
    case "changelog":
      return <Changelog />;
    default:
      return null;
  }
}
