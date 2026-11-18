# Longevity game-data extractor

Builds `../gamedata/`, the vanilla Minecraft data that the Lookup and Hidden Changelog pages read.
It covers every release from 1.20 up to the latest release, with no snapshots.

## Rerun it

From the repo root:

```
python extractor/run.py
```

That checks Mojang's version manifest, downloads any new release, rebuilds every version and rewrites
all the diffs. With the Java dumps cached it takes about 20 seconds; after a change to `java/` (which
re-runs every dump) about 4–5 minutes. The first run downloads about 1.5 GB of server jars and mappings;
with the unpacked classpaths `extractor/cache/` grows to about 2.8 GB.

Useful flags:

| Flag | What it does |
| --- | --- |
| `--versions 1.21.11,26.3` | Rebuild only these versions. Diffs and `index.json` are still rewritten for everything built. |
| `--offline` | Use the cached version manifest and make no network calls. Works once the jars are cached. |
| `--force` | Rerun the Java dump even when its cached output is still valid. |
| `--no-diff` | Skip `gamedata/changes/`. |

Check the output against known facts with `python extractor/check.py`. It runs about 70 checks per
version, for example zombie health 20, obsidian hardness 50, Mending is treasure, and librarians sell
books.

Requirements: Python 3.10+ (standard library only) and JDKs under `~/.gradle/jdks/` (or `JAVA_HOME`).
The extractor picks the JDK that matches each version's `javaVersion`: 17 for 1.20–1.20.4, and 21 or
newer for 1.20.5 onward. If there is no 21, it uses 25. 26.x needs 25.

## How it works

1. **`fetch.py`** downloads the version manifest, each version JSON, `server.jar` and, for obfuscated
   versions, Mojang's official `server_mappings` (ProGuard `server.txt`). It uses
   piston-meta/piston-data with User-Agent `longevity-extractor` and nothing else. Every file is
   sha1-checked. `en_us.json` is read from the server jar, which carries the same file as the client
   jar (byte-identical), so the client jar is not downloaded.
2. **`unpack.py`** extracts the bundler jar's real server jar and its libraries.
3. **`jardata.py`** reads the vanilla data pack inside the jar: loot tables, recipes, tags, biomes,
   enchantments (1.21+), villager trades (26.x), context providers (26.3) and the
   experimental `trade_rebalance` pack.
4. **`java/`** (`Dump.java` + `R.java`) boots the server classes with `SharedConstants.tryDetectVersion()`
   and `Bootstrap.bootStrap()`, with no world and no network. It then reads code-only values by
   reflection: mob attributes (`DefaultAttributes`), block hardness, blast resistance, light and fire
   odds, item stack size, durability, rarity, food, attribute modifiers, enchantability and repair
   materials, fuel, potions, brewing mixes (`PotionBrewing`), pre-1.21 enchantments and pre-26
   villager trades (`VillagerTrades`). `R` translates Mojang names through the ProGuard mappings, so
   one program runs on both the obfuscated (≤1.21.11) and unobfuscated (26.x) jars. Before reading,
   it binds item, block and entity tags from the jar, so tag-based fuel and repair work. On 26.x it
   also runs the item component initializers, the same way the data generator does.
5. **`build.py`** turns the jar data plus the dump into the app schema. **`diff.py`** writes the
   changelog, and **`run.py`** ties it together.

Caches live in `extractor/cache/` (gitignored). They hold the jars, the unpacked classpaths, the
compiled dumper and the raw dumps (`cache/raw/<v>/code.json`, plus `dump.log`). A raw dump is reused
until the Java source changes.

## Output (`gamedata/`)

Every file is minified JSON. Per-version data files are **gzipped** (`*.json.gz`; read them with
`flate2` in Rust or `DecompressionStream('gzip')` in the webview). `index.json`, each `meta.json`
and `changes/*.json` stay plain JSON.

```
gamedata/index.json                 {"versions": [...oldest→newest], "latest": "26.3"}
gamedata/<v>/meta.json              version, release_time, data_version, missing[], notes[], trade_picks, sources, cooking_speed
gamedata/<v>/items.json.gz          id -> {name, stack, durability, rarity, food, fuel, attack_damage, attack_speed, enchantable, repair, (+armor, toughness, kb_resist, modifiers, tool_rules, use_seconds, fire_resistant)}
gamedata/<v>/blocks.json.gz         id -> {name, hardness, blast, tool, tier, light, flammable, drops, requires_tool, (+tools, ignite_odds, burn_odds, lava_ignites, friction, item)}
gamedata/<v>/mobs.json.gz           id -> {name, category, health, armor, toughness, attack, speed, follow, kb_resist, loot, biomes, (+spawns{biome:{weight,min,max,group}}, attributes, width, height, flying_speed)}
gamedata/<v>/loot.json.gz           table id -> raw loot table JSON (every table in the vanilla pack)
gamedata/<v>/recipes.json.gz        recipe id -> raw recipe JSON
gamedata/<v>/enchantments.json.gz   id -> {name, max_level, weight, anvil_cost, supported, primary, exclusive, min_cost, max_cost, treasure, tradeable, curse, (+in_enchanting_table, min_cost_levels, max_cost_levels, slots, effects)}
gamedata/<v>/brewing.json.gz        {mixes[], containers[], bottles[], potions{id:{name, effects[[effect, ticks, amplifier]]}}}
gamedata/<v>/trades.json.gz         profession -> level -> [{buy, buyB, sell, max_uses, xp, price_mult, note, (+buy_range, villager_types, id)}]; wandering_trader -> pool -> [...]
gamedata/<v>/trades_rebalance.json.gz  the same shape, with the experimental Villager Trade Rebalance pack on (1.20.2+, not vanilla default)
gamedata/<v>/tags.json.gz           registry -> tag -> [ids], fully expanded; only tags the other files reference
gamedata/<v>/predicates.json.gz     26.3+: the named loot predicates that 26.3 loot tables reference by id (e.g. minecraft:tool/can_shear)
gamedata/changes/<a>__<b>.json      the hidden changelog between consecutive releases
```

Notes on the schema:

- **Floats.** Java floats are rounded to 6 significant digits, so movement speed 0.23000000417
  becomes 0.23.
- **Items.** `attack_damage` and `attack_speed` are the tooltip values: base 1 or 4 plus the
  main-hand modifiers. `food.saturation` is saturation points (nutrition × modifier × 2) in every
  version. `fuel` is furnace ticks. `repair` is the anvil repair items, with tags expanded.
- **Blocks.** `tier` comes from the `needs_<tier>_tool` tags. If a block needs the right tool but has
  no needs tag, `tier` is `"wood"`. `flammable` means fire can spread to it (fire `igniteOdds > 0`).
  `drops` is null when the loot table does not exist, as for air.
- **Mobs.** Only entities with attributes are listed, minus player and armor stand. `biomes` and
  `spawns` come from the biome spawners, so structure-only spawns (witch huts, monuments, fortresses)
  are not included.
- **Trades.** Random trades are a single entry with a plain-words `note` and the real numbers from
  code or data. They include enchanted books, enchanted gear, dyed armor, explorer maps, suspicious
  stew and tipped arrows. A random price gives `buy: ["minecraft:emerald", null]` plus
  `buy_range: [min, max]`. Biome-specific trades are one entry per item, with `villager_types`.
  `meta.json → trade_picks` says how many offers each level or pool rolls. That is 2 per level in
  code; in 26.x the number comes from `trade_set`. The wandering trader uses pools: `common` and
  `rare` through 1.21.4, then `buying`, `common` and `uncommon` from 1.21.5.
- **Loot.** 26.3 rewrote the loot format (`type` instead of `condition`/`function`, single `condition` and
  `modifier` fields, `match_block`, and named predicates such as `"minecraft:tool/can_shear"` that live in
  `predicates.json`). `loot.json` keeps each version's raw format.
- **Recipes.** 26.3 cooking recipes store a base time (200 ticks for blasting and smoking too). The blast
  furnace and smoker run them faster; `meta.json → cooking_speed` gives the multiplier per recipe type
  (`{"minecraft:blasting": 2, "minecraft:smoking": 2}`), so real time = `cookingtime / multiplier`.
  26.2 leaves `cookingtime` out when it is the default (200 smelting, 100 blasting/smoking/campfire).
- **Experimental content.** Anything behind a feature flag that plain vanilla does not enable is left
  out, including experimental data packs and the loot tables of experimental blocks, mobs and structures.
  The one exception is `trades_rebalance.json`.

## Diffs (`gamedata/changes/<from>__<to>.json`)

```
{ "from", "to",
  "mobs":   [{id, name, field, from, to, what}],          // stats, other attributes, spawn biomes/weights, added/removed
  "loot":   [{table, name, what}],                         // per-item count/weight/chance/looting/function changes
  "trades": [{profession, level, what}],
  "recipes": {"added": [{id, name}], "removed": [...], "changed": [{id, name, what}]},
  "items": [...], "blocks": [...], "enchantments": [...], // {id, name, field, from, to, what}
  "brewing": [...] }
```

The diff compares normalized structures, not raw JSON. Loot tables are first converted to one shape
(the 26.3 format and named predicates are mapped back), then summarized: items, counts, weights,
chances, Looting bonuses and the functions that matter. Recipes are compared by ingredients (tags
expanded to items, so `#diamond_tool_materials` equals Diamond), result, pattern, XP and the real
cooking time. A table or recipe whose JSON changed only in format (the 1.20.5 component rewrite, the
1.21.2 ingredient syntax, the 26.2 default cooking times, the 26.3 loot format) does not appear, and a
recipe that only got a new id is not listed as removed + added. Trade notes are compared only when
both versions use the same source (code or data), so the move from code to data in 26.1 does not flag
every random trade.
