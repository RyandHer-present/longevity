"""Spot-check gamedata/ against well-known vanilla facts. python extractor/check.py"""
import gzip
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "gamedata")


def load(v, name):
    p = os.path.join(OUT, v, name + ".json")
    if os.path.exists(p + ".gz"):
        with gzip.open(p + ".gz", "rt", encoding="utf-8") as f:
            return json.load(f)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return None


def vkey(v):
    return tuple(int(x) for x in v.split("."))


fails = []
passes = 0


def check(v, label, cond, got=None):
    global passes
    if cond:
        passes += 1
    else:
        fails.append(f"{v}: {label} (got {got!r})")


def main():
    with open(os.path.join(OUT, "index.json"), encoding="utf-8") as f:
        idx = json.load(f)
    for v in idx["versions"]:
        mobs, blocks, items = load(v, "mobs"), load(v, "blocks"), load(v, "items")
        ench, trades, brew, loot = load(v, "enchantments"), load(v, "trades"), load(v, "brewing"), load(v, "loot")
        recipes, meta = load(v, "recipes"), load(v, "meta")
        z = mobs["minecraft:zombie"]
        check(v, "zombie health 20", z["health"] == 20, z["health"])
        check(v, "zombie armor 2", z["armor"] == 2, z["armor"])
        check(v, "zombie attack 3", z["attack"] == 3, z["attack"])
        check(v, "zombie speed 0.23", z["speed"] == 0.23, z["speed"])
        check(v, "zombie follow 35", z["follow"] == 35, z["follow"])
        check(v, "zombie loot table", z["loot"] == "minecraft:entities/zombie", z["loot"])
        check(v, "zombie spawns in plains", "minecraft:plains" in z["biomes"], len(z["biomes"]))
        check(v, "zombie category monster", z["category"] == "monster", z["category"])
        check(v, "iron golem health 100", mobs["minecraft:iron_golem"]["health"] == 100, mobs["minecraft:iron_golem"]["health"])
        check(v, "iron golem kb resist 1", mobs["minecraft:iron_golem"]["kb_resist"] == 1, mobs["minecraft:iron_golem"]["kb_resist"])
        check(v, "wither health 300", mobs["minecraft:wither"]["health"] == 300, mobs["minecraft:wither"]["health"])
        check(v, "ender dragon health 200", mobs["minecraft:ender_dragon"]["health"] == 200, mobs["minecraft:ender_dragon"]["health"])
        check(v, "skeleton no attack attr needed", mobs["minecraft:skeleton"]["health"] == 20, mobs["minecraft:skeleton"]["health"])
        ob = blocks["minecraft:obsidian"]
        check(v, "obsidian hardness 50", ob["hardness"] == 50, ob["hardness"])
        check(v, "obsidian blast 1200", ob["blast"] == 1200, ob["blast"])
        check(v, "obsidian pickaxe/diamond", (ob["tool"], ob["tier"]) == ("pickaxe", "diamond"), (ob["tool"], ob["tier"]))
        check(v, "bedrock unbreakable", blocks["minecraft:bedrock"]["hardness"] == -1, blocks["minecraft:bedrock"]["hardness"])
        check(v, "glowstone light 15", blocks["minecraft:glowstone"]["light"] == 15, blocks["minecraft:glowstone"]["light"])
        check(v, "oak planks flammable", blocks["minecraft:oak_planks"]["flammable"] is True, blocks["minecraft:oak_planks"]["flammable"])
        check(v, "stone not flammable", blocks["minecraft:stone"]["flammable"] is False, blocks["minecraft:stone"]["flammable"])
        check(v, "iron ore needs stone tier", blocks["minecraft:iron_ore"]["tier"] == "stone", blocks["minecraft:iron_ore"]["tier"])
        check(v, "stone drops table", blocks["minecraft:stone"]["drops"] == "minecraft:blocks/stone", blocks["minecraft:stone"]["drops"])
        ds = items["minecraft:diamond_sword"]
        check(v, "diamond sword 7 dmg", ds["attack_damage"] == 7, ds["attack_damage"])
        check(v, "diamond sword 1.6 speed", ds["attack_speed"] == 1.6, ds["attack_speed"])
        check(v, "diamond sword 1561 durability", ds["durability"] == 1561, ds["durability"])
        check(v, "diamond sword repaired by diamond", ds["repair"] == ["minecraft:diamond"], ds["repair"])
        check(v, "diamond sword enchantability 10", ds["enchantable"] == 10, ds["enchantable"])
        check(v, "wooden pickaxe repair includes oak planks", "minecraft:oak_planks" in (items["minecraft:wooden_pickaxe"]["repair"] or []),
              items["minecraft:wooden_pickaxe"]["repair"])
        check(v, "netherite chestplate armor 8 toughness 3", (items["minecraft:netherite_chestplate"].get("armor"), items["minecraft:netherite_chestplate"].get("toughness")) == (8, 3),
              (items["minecraft:netherite_chestplate"].get("armor"), items["minecraft:netherite_chestplate"].get("toughness")))
        check(v, "ender pearl stacks to 16", items["minecraft:ender_pearl"]["stack"] == 16, items["minecraft:ender_pearl"]["stack"])
        gc = items["minecraft:golden_carrot"]["food"]
        check(v, "golden carrot 6/14.4", gc == {"nutrition": 6, "saturation": 14.4} or (gc["nutrition"], gc["saturation"]) == (6, 14.4), gc)
        check(v, "coal fuel 1600", items["minecraft:coal"]["fuel"] == 1600, items["minecraft:coal"]["fuel"])
        check(v, "oak planks fuel 300", items["minecraft:oak_planks"]["fuel"] == 300, items["minecraft:oak_planks"]["fuel"])
        check(v, "lava bucket fuel 20000", items["minecraft:lava_bucket"]["fuel"] == 20000, items["minecraft:lava_bucket"]["fuel"])
        check(v, "stick fuel 100", items["minecraft:stick"]["fuel"] == 100, items["minecraft:stick"]["fuel"])
        check(v, "elytra repaired by phantom membrane", items["minecraft:elytra"]["repair"] == ["minecraft:phantom_membrane"], items["minecraft:elytra"]["repair"])
        sh = ench["minecraft:sharpness"]
        check(v, "sharpness max 5", sh["max_level"] == 5, sh["max_level"])
        check(v, "sharpness weight 10", sh["weight"] == 10, sh["weight"])
        check(v, "sharpness excludes smite", "minecraft:smite" in sh["exclusive"], sh["exclusive"])
        check(v, "sharpness on axes (anvil)", "minecraft:diamond_axe" in sh["supported"], len(sh["supported"]))
        check(v, "sharpness table: swords not axes... primary has sword", "minecraft:diamond_sword" in sh["primary"], len(sh["primary"]))
        check(v, "sharpness min cost lvl1 1", sh["min_cost_levels"][0] == 1, sh["min_cost_levels"])
        m = ench["minecraft:mending"]
        check(v, "mending treasure", m["treasure"] is True, m["treasure"])
        check(v, "mending tradeable", m["tradeable"] is True, m["tradeable"])
        check(v, "mending excludes infinity", "minecraft:infinity" in m["exclusive"], m["exclusive"])
        check(v, "binding curse is curse", ench["minecraft:binding_curse"]["curse"] is True, ench["minecraft:binding_curse"]["curse"])
        check(v, "soul speed not tradeable", ench["minecraft:soul_speed"]["tradeable"] is False, ench["minecraft:soul_speed"]["tradeable"])
        check(v, "protection anvil cost 1", ench["minecraft:protection"]["anvil_cost"] == 1, ench["minecraft:protection"]["anvil_cost"])
        check(v, "unbreaking max 3", ench["minecraft:unbreaking"]["max_level"] == 3, ench["minecraft:unbreaking"]["max_level"])
        bad = [k for k, e in ench.items() if not set(e.get("primary") or []) <= set(e.get("supported") or [])]
        check(v, "table items are a subset of supported items", not bad, bad[:3])
        check(v, "aqua affinity table items are helmets", all("helmet" in i for i in ench["minecraft:aqua_affinity"]["primary"]),
              ench["minecraft:aqua_affinity"]["primary"][:5])
        speed = (meta.get("cooking_speed") or {}).get("minecraft:blasting", 1)
        ib = recipes["minecraft:iron_ingot_from_blasting_iron_ore"]
        check(v, "blasting iron ore takes 100 ticks", ib.get("cookingtime", 100) / speed == 100, (ib.get("cookingtime"), speed))
        carto = [r for lvl in trades["cartographer"].values() for r in lvl]
        check(v, "cartographer sells explorer maps", any(r["sell"] and "map" in r["sell"][0] and r["sell"][0] != "minecraft:map"
                                                          for r in carto), [r["sell"] for r in carto][:6])
        lib = trades["librarian"]
        books = [r for lvl in lib.values() for r in lvl if r["sell"] and r["sell"][0] == "minecraft:enchanted_book"]
        check(v, "librarian sells enchanted books", len(books) >= 4, len(books))
        check(v, "librarian buys 24 paper at level 1",
              any(r["buy"] == ["minecraft:paper", 24] for r in lib["1"]), [r["buy"] for r in lib["1"]])
        check(v, "wandering trader present", bool(trades.get("wandering_trader")), list(trades))
        mix = {(x["input"], x["ingredient"], x["output"]) for x in brew["mixes"]}
        check(v, "awkward + sugar -> swiftness", ("minecraft:awkward", "minecraft:sugar", "minecraft:swiftness") in mix, len(mix))
        check(v, "water + nether wart -> awkward", ("minecraft:water", "minecraft:nether_wart", "minecraft:awkward") in mix, len(mix))
        check(v, "gunpowder makes splash", any(c["ingredient"] == "minecraft:gunpowder" and c["output"] == "minecraft:splash_potion" for c in brew["containers"]),
              brew["containers"])
        sw = brew["potions"]["minecraft:swiftness"]
        check(v, "swiftness = speed 3:00", sw["effects"] == [["minecraft:speed", 3600, 0]], sw["effects"])
        check(v, "swiftness name", sw["name"] == "Potion of Swiftness", sw["name"])
        check(v, "loot has fishing + bartering + hero gifts",
              all(k in loot for k in ("minecraft:gameplay/fishing", "minecraft:gameplay/piglin_bartering",
                                      "minecraft:gameplay/hero_of_the_village/librarian_gift", "minecraft:gameplay/sniffer_digging",
                                      "minecraft:archaeology/desert_pyramid")), None)
        check(v, "iron golem drop table", "minecraft:entities/iron_golem" in loot, None)
        check(v, "recipes include diamond_pickaxe", "minecraft:diamond_pickaxe" in recipes, len(recipes))
        check(v, "meta missing empty", meta["missing"] == [], meta["missing"])
    # diffs
    vs = idx["versions"]
    for a, b in zip(vs, vs[1:]):
        p = os.path.join(OUT, "changes", f"{a}__{b}.json")
        check(f"{a}->{b}", "diff file exists", os.path.exists(p))
    print(f"{passes} checks passed, {len(fails)} failed")
    for f in fails:
        print("  FAIL", f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
