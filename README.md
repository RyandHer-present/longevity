# Longevity

An all-in-one desktop hub for one long-term Minecraft survival world, built with Tauri 2, React and three.js.

It reads your save (it never writes to it) and puts everything about that world in one app:

- **Home**: where you left off, your day, streak and lately-happened list over a live 3D view of your base.
- **Play**: launches your instances through Prism Launcher, and finds which mod crashed the game by testing it hidden in the background.
- **Mods, Instances, Skins, Settings sync**: a Modrinth store with updates and backups, instance management, a 3D skin editor, and keybinds/video/packs kept the same between two instances.
- **3D World + Map**: fly or walk around your real world, open chests, read signs and books, and try a resource pack on your base in a split view before you switch to it.
- **Storage, Villagers, Farms, Projects, Gear + Anvil**: search every container, find messy storage, a villager roster with trades and a cure planner, farm rates, project checklists, missing enchants and the cheapest anvil order.
- **Lookup + Hidden Changelog**: vanilla game data, plus the mob/loot/trade changes Mojang doesn't list.
- **Dex, Stats, Play history, Screenshots**: card collections for items, enchants and armor trims, your stats, playtime charts and recaps after each session.

## Install

Download `Longevity_x.y.z_x64-setup.exe` from [Releases](../../releases) and run it. Longevity updates itself from new releases.

Windows 10/11 with the WebView2 runtime. Launching and the crash finder use [Prism Launcher](https://prismlauncher.org/).

## Build

```
cd app
npm install
npx tauri build
```

Needs Rust (stable) and Node 20+. The vanilla game data in `gamedata/` comes from `extractor/` (see its README).

## Privacy

Everything stays on your PC. Longevity only reads your world, never sends it anywhere, and never uses your Minecraft login (it only reads your player name and skin from Prism). The only network calls are Modrinth (mod store), Mojang (skins, game files) and GitHub (its own updates).
