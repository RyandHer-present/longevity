"""Turn one version's raw data (jar data pack + Java code dump) into gamedata/<version>/*.json."""
import json
import math
import os
import re

from jardata import JarData, Tags

EMERALD = "minecraft:emerald"


# ----------------------------------------------------------------------------- small helpers

def num(x):
    """Clean float noise from Java floats (0.23000000417 -> 0.23)."""
    if isinstance(x, bool) or x is None:
        return x
    if isinstance(x, float):
        if math.isnan(x) or math.isinf(x):
            return None
        r = float(f"{x:.6g}")
        return int(r) if r.is_integer() and abs(r) < 1e15 else r
    return x


def clean(o):
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, list):
        return [clean(v) for v in o]
    return num(o)


def short(i):
    return i.split(":", 1)[1] if isinstance(i, str) and i.startswith("minecraft:") else i


def titleize(path):
    return " ".join(w.capitalize() for w in re.split(r"[_/]", short(path)))


class Lang:
    def __init__(self, path):
        with open(path, encoding="utf-8") as f:
            self.d = json.load(f)

    def get(self, key, fallback=None):
        if key and key in self.d:
            return self.d[key]
        return fallback

    def item(self, iid, code_items=None):
        if code_items and iid in code_items and code_items[iid].get("lang") in self.d:
            return self.d[code_items[iid]["lang"]]
        p = short(iid).replace("/", ".")
        for k in ("item.minecraft." + p, "block.minecraft." + p, "entity.minecraft." + p):
            if k in self.d:
                return self.d[k]
        return titleize(iid)

    def enchant(self, eid):
        return self.d.get("enchantment.minecraft." + short(eid), titleize(eid))

    def effect(self, eid):
        return self.d.get("effect.minecraft." + short(eid), titleize(eid))

    def entity(self, eid):
        return self.d.get("entity.minecraft." + short(eid), titleize(eid))

    def biome(self, bid):
        return self.d.get("biome.minecraft." + short(bid), titleize(bid))


def attr_name(a):
    a = short(a)
    for p in ("generic.", "player.", "zombie.", "horse."):
        if a.startswith(p):
            return a[len(p):]
    return a


OPS = {"addition": "add_value", "multiply_base": "add_multiplied_base", "multiply_total": "add_multiplied_total"}
RARITY_ANVIL = {"common": 1, "uncommon": 2, "rare": 4, "very_rare": 8}  # AnvilMenu, 1.20-1.20.4


# ----------------------------------------------------------------------------- number providers

def eval_ctx(v, providers, fast=False, depth=0):
    """Evaluate a 26.3 context int/float provider (normal furnace unless fast)."""
    if depth > 20:
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v
    if isinstance(v, str):
        return eval_ctx(providers.get(v if ":" in v else "minecraft:" + v), providers, fast, depth + 1)
    if not isinstance(v, dict):
        return None
    t = short(v.get("type", ""))
    ev = lambda x: eval_ctx(x, providers, fast, depth + 1)  # noqa: E731
    if t == "conditional":
        cond = v.get("condition")
        truth = fast if isinstance(cond, str) and "fast" in cond else False
        return ev(v["on_true"] if truth else v["on_false"])
    if t in ("constant",):
        return ev(v.get("value"))
    if t == "div":
        a, b = ev(v.get("left")), ev(v.get("right"))
        return None if a is None or not b else (a // b if isinstance(a, int) and isinstance(b, int) else a / b)
    if t in ("mul", "multiply"):
        a, b = ev(v.get("left")), ev(v.get("right"))
        return None if a is None or b is None else a * b
    if t in ("add", "sum"):
        xs = v.get("inputs") or v.get("summands") or [v.get("left"), v.get("right")]
        vals = [ev(x) for x in xs]
        return None if any(x is None for x in vals) else sum(vals)
    return None


def provider_text(p):
    """Readable text for a loot number provider."""
    if isinstance(p, (int, float)) and not isinstance(p, bool):
        return str(num(p))
    if not isinstance(p, dict):
        return str(p)
    t = short(p.get("type", "constant"))
    if t == "uniform":
        return f"{num(p.get('min'))}–{num(p.get('max'))}"
    if t == "binomial":
        return f"binomial(n={num(p.get('n'))}, p={num(p.get('p'))})"
    if t == "constant":
        return str(num(p.get("value")))
    if t in ("sum", "add"):
        return " + ".join(provider_text(x) for x in (p.get("summands") or p.get("inputs") or []))
    return t


def provider_range(p):
    """(min, max) of a loot number provider, or None."""
    if isinstance(p, (int, float)) and not isinstance(p, bool):
        return (num(p), num(p))
    if not isinstance(p, dict):
        return None
    t = short(p.get("type", "constant"))
    if t == "constant":
        return provider_range(p.get("value"))
    if t == "uniform":
        a, b = provider_range(p.get("min")), provider_range(p.get("max"))
        return (a[0], b[1]) if a and b else None
    if t == "binomial":
        n = provider_range(p.get("n"))
        return (0, n[1]) if n else None
    if t in ("sum", "add"):
        parts = [provider_range(x) for x in (p.get("summands") or p.get("inputs") or [])]
        if any(x is None for x in parts):
            return None
        return (num(sum(x[0] for x in parts)), num(sum(x[1] for x in parts)))
    return None


# ----------------------------------------------------------------------------- builder

class VersionBuild:
    def __init__(self, vid, release_time, jar: JarData, code, lang: Lang):
        self.vid = vid
        self.release_time = release_time
        self.jar = jar
        self.code = code
        self.lang = lang
        self.tags = Tags(jar.tags)
        self.missing = []
        self.notes = []
        self.referenced_tags = {"item": set(), "block": set(), "enchantment": set(), "entity_type": set(),
                                "potion": set()}
        ci = code.get("items", {})
        self.code_items = ci
        self.vanilla_items = {k for k, v in ci.items() if not v.get("experimental")}
        self.loot_ids = set(jar.cat("loot_table").keys())

    def ref_tag(self, registry, ref):
        if isinstance(ref, str) and ref.startswith("#"):
            self.referenced_tags.setdefault(registry, set()).add(ref[1:])
        elif isinstance(ref, list):
            for r in ref:
                self.ref_tag(registry, r)

    def iname(self, iid):
        return self.lang.item(iid, self.code_items)

    # ------------------------------------------------------------------ items
    def items(self):
        out = {}
        code_fuel = self.code.get("fuel")
        providers = dict(self.jar.cat("context_int_provider"))
        providers.update(self.jar.cat("context_float_provider"))
        for iid, it in self.code_items.items():
            if it.get("experimental") or "stack" not in it:
                continue
            mods = []
            for m in it.get("modifiers", []):
                mods.append({"attr": attr_name(m["attr"]), "amount": num(m["amount"]),
                             "op": OPS.get(m["op"], m["op"]), "slot": m["slot"]})
            hand = [m for m in mods if m["slot"] in ("mainhand", "hand", "any")]
            dmg = [m["amount"] for m in hand if m["attr"] == "attack_damage" and m["op"] == "add_value"]
            spd = [m["amount"] for m in hand if m["attr"] == "attack_speed" and m["op"] == "add_value"]
            worn = [m for m in mods if m["slot"] not in ("mainhand", "offhand", "hand", "any")]

            def worn_sum(a):
                v = [m["amount"] for m in worn if m["attr"] == a and m["op"] == "add_value"]
                return num(sum(v)) if v else None

            food = None
            if it.get("food"):
                f = it["food"]
                food = {"nutrition": f["nutrition"], "saturation": num(f["saturation"])}
                if f.get("canAlwaysEat"):
                    food["always_edible"] = True

            fuel = None
            comps = it.get("components") or {}
            if code_fuel is not None:
                fuel = code_fuel.get(iid)
            elif "cooking_fuel" in comps:
                bt = comps["cooking_fuel"].get("burnTime")
                ref = bt.get("key") if isinstance(bt, dict) else bt
                if isinstance(bt, dict) and "key" not in bt:
                    ref = bt.get("value", bt.get("provider"))
                fuel = eval_ctx(ref, providers)
                if fuel is None:
                    self.notes.append(f"fuel for {iid} could not be evaluated")

            repair = it.get("repair")
            if repair is not None:
                self.ref_tag("item", repair)
                repair = [x for x in self.tags.expand("item", repair) if x != iid or iid == "minecraft:elytra"]

            e = {
                "name": self.iname(iid),
                "stack": it["stack"],
                "durability": it["durability"] or None,
                "rarity": it["rarity"],
                "food": food,
                "fuel": fuel,
                "attack_damage": num(1 + sum(dmg)) if dmg else None,
                "attack_speed": num(4 + sum(spd)) if spd else None,
                # only items an enchanting table accepts (durability or a book); 1.20.5-1.21.1 horse armor
                # reports a material value it can never use
                "enchantable": (it.get("enchantable") or None) if (it.get("durability") or iid == "minecraft:book") else None,
                "repair": repair or None,
            }
            armor = worn_sum("armor")
            if armor is not None:
                e["armor"] = armor
                e["toughness"] = worn_sum("armor_toughness") or 0
                kb = worn_sum("knockback_resistance")
                if kb:
                    e["kb_resist"] = kb
            if mods:
                e["modifiers"] = mods
            if comps.get("fire_resistant") or comps.get("damage_resistant"):
                e["fire_resistant"] = True
            if "consumable" in comps and isinstance(comps["consumable"], dict):
                cs = comps["consumable"].get("consumeSeconds")
                if cs is not None:
                    e["use_seconds"] = num(cs)
            elif it.get("food") and it["food"].get("eatSeconds") is not None:
                e["use_seconds"] = num(it["food"]["eatSeconds"])
            if "tool" in comps and isinstance(comps["tool"], dict):
                e["mining_speed"] = num(comps["tool"].get("defaultMiningSpeed"))
                rules = []
                for r in comps["tool"].get("rules", []):
                    self.ref_tag("block", r.get("blocks"))
                    rules.append({"blocks": r.get("blocks"), "speed": num(r.get("speed")),
                                  "correct_for_drops": r.get("correctForDrops")})
                e["tool_rules"] = rules
            out[iid] = clean(e)
        return out

    # ------------------------------------------------------------------ blocks
    def blocks(self):
        out = {}
        tool_tags = ["pickaxe", "axe", "shovel", "hoe"]
        tiers = ["netherite", "diamond", "iron", "copper", "stone", "gold", "golden", "wood", "wooden"]
        needs = {}
        for t in tiers:
            tid = f"minecraft:needs_{t}_tool"
            if self.tags.has("block", tid):
                needs[t] = set(self.tags.get("block", tid))
                self.referenced_tags["block"].add(tid)
        mine = {}
        for t in tool_tags:
            tid = f"minecraft:mineable/{t}"
            mine[t] = set(self.tags.get("block", tid))
            self.referenced_tags["block"].add(tid)
        for bid, b in self.code.get("blocks", {}).items():
            if b.get("experimental"):
                continue
            tools = [t for t in tool_tags if bid in mine[t]]
            tier = None
            for t in tiers:
                if t in needs and bid in needs[t]:
                    tier = t
                    break
            if tier is None and b.get("requires_tool") and tools:
                tier = "wood"
            drops = b.get("loot")
            if drops not in self.loot_ids:
                drops = None
            e = {
                "name": self.lang.get(b.get("lang"), titleize(bid)),
                "hardness": num(b["hardness"]),
                "blast": num(b["blast"]),
                "tool": tools[0] if tools else None,
                "tier": tier,
                "light": b.get("light", 0),
                "flammable": (b.get("ignite_odds") or 0) > 0,
                "drops": drops,
                "requires_tool": b.get("requires_tool", False),
            }
            if len(tools) > 1:
                e["tools"] = tools
            if b.get("ignite_odds"):
                e["ignite_odds"] = b["ignite_odds"]
                e["burn_odds"] = b.get("burn_odds", 0)
            if b.get("lava_ignites"):
                e["lava_ignites"] = True
            for k in ("friction", "speed_factor", "jump_factor"):
                dv = {"friction": 0.6, "speed_factor": 1, "jump_factor": 1}[k]
                if b.get(k) is not None and num(b[k]) != dv:
                    e[k] = num(b[k])
            if b.get("item") and b["item"] != "minecraft:air":
                e["item"] = b["item"]
            out[bid] = clean(e)
        return out

    # ------------------------------------------------------------------ mobs
    def spawns(self):
        """entity -> {biome: [weight, min, max, category]} from biome spawn settings."""
        res = {}
        for bid, bj in self.jar.cat("worldgen/biome").items():
            sp = bj.get("spawners") or {}
            attr = (bj.get("attributes") or {}).get("minecraft:gameplay/natural_mob_spawns")
            if isinstance(attr, dict):  # 26.3+: spawns are an environment attribute
                arg = attr.get("argument", attr)
                sp = arg.get("spawns_by_category") or arg.get("spawners") or {}
            groups = sp.items() if isinstance(sp, dict) else [("?", sp)]
            for cat, lst in groups:
                if isinstance(lst, dict):  # weighted list wrapper
                    lst = lst.get("entries") or lst.get("values") or []
                for s in lst or []:
                    data = s.get("data", s) if isinstance(s, dict) else {}
                    t = data.get("type")
                    if not t:
                        continue
                    w = s.get("weight", data.get("weight"))
                    lo, hi = data.get("minCount"), data.get("maxCount")
                    if "count" in data:
                        c = data["count"]
                        if isinstance(c, dict):
                            lo = c.get("min_inclusive", c.get("min"))
                            hi = c.get("max_inclusive", c.get("max"))
                        else:
                            lo = hi = c
                    res.setdefault(t, {})[bid] = [w, lo, hi, cat]
        return res

    def mobs(self):
        out = {}
        spawns = self.spawns()
        for eid, e in self.code.get("entities", {}).items():
            if e.get("experimental") or "attributes" not in e or eid in ("minecraft:player", "minecraft:armor_stand"):
                continue
            at = {attr_name(k): num(v) for k, v in e["attributes"].items()}
            loot = e.get("loot")
            sp = spawns.get(eid, {})
            m = {
                "name": self.lang.get(e.get("lang"), titleize(eid)),
                "category": e.get("category"),
                "health": at.get("max_health"),
                "armor": at.get("armor", 0),
                "toughness": at.get("armor_toughness", 0),
                "attack": at.get("attack_damage"),
                "speed": at.get("movement_speed"),
                "follow": at.get("follow_range"),
                "kb_resist": at.get("knockback_resistance", 0),
                "loot": loot if loot in self.loot_ids else None,
                "biomes": sorted(sp.keys()),
            }
            if at.get("flying_speed") is not None:
                m["flying_speed"] = at["flying_speed"]
            if sp:
                m["spawns"] = {b: {"weight": v[0], "min": v[1], "max": v[2], "group": v[3]} for b, v in sorted(sp.items())}
            m["attributes"] = at
            m["width"] = num(e.get("width"))
            m["height"] = num(e.get("height"))
            if e.get("fire_immune"):
                m["fire_immune"] = True
            out[eid] = clean(m)
        return out

    # ------------------------------------------------------------------ loot / recipes
    def loot(self):
        """Every loot table in the vanilla pack, minus tables that belong to experimental (feature-flagged) content."""
        tables = self.jar.cat("loot_table")
        blocks, ents = self.code.get("blocks", {}), self.code.get("entities", {})
        on = {b.get("loot") for b in blocks.values() if not b.get("experimental")}
        on |= {e.get("loot") for e in ents.values() if not e.get("experimental")}
        off = {b.get("loot") for b in blocks.values() if b.get("experimental")}
        off |= {e.get("loot") for e in ents.values() if e.get("experimental")}
        off_ents = {short(k) for k, e in ents.items() if e.get("experimental")}
        feature_packs = [ov["files"].get("loot_table", {}) for name, ov in self.jar.overlays.items()
                         if name != "trade_rebalance"]
        out, dropped = {}, 0
        for tid, t in sorted(tables.items()):
            path = short(tid)
            exp = tid in off and tid not in on
            if path.startswith("entities/") and path.split("/")[1] in off_ents:
                exp = True
            # a table that a feature pack also defines, and that the main pack only has as an empty stub
            # (or as the same table), belongs to that experimental feature
            if any(tid in fp and (fp[tid] == t or not t.get("pools")) for fp in feature_packs):
                exp = True
            if exp and tid not in on:
                dropped += 1
                continue
            out[tid] = t
        if dropped:
            self.notes.append(f"loot: left out {dropped} tables that only serve experimental content")
        return out

    def predicates(self):
        """26.3+: named loot predicates that loot tables reference by id (e.g. minecraft:tool/can_shear)."""
        p = self.jar.cat("predicate")
        return dict(sorted(p.items())) if p else None

    def cooking_speed(self):
        """Recipe type -> cooking speed multiplier. 26.3 stores base times (200) and speeds up the blast furnace
        and smoker through context providers; earlier versions store the real time in the recipe."""
        floats = self.jar.cat("context_float_provider")
        fast = floats.get("minecraft:cooking/fast_speed_multiplier")
        pred = self.jar.cat("predicate").get("minecraft:block/fast_cooking")
        if not isinstance(fast, (int, float)) or not isinstance(pred, dict):
            return None
        blocks = pred.get("blocks") or []
        blocks = blocks if isinstance(blocks, list) else [blocks]
        kinds = {"minecraft:blast_furnace": "minecraft:blasting", "minecraft:smoker": "minecraft:smoking"}
        return {kinds[b]: num(fast) for b in blocks if b in kinds}

    def recipes(self):
        return dict(sorted(self.jar.cat("recipe").items()))

    # ------------------------------------------------------------------ enchantments
    @staticmethod
    def _fit(levels):
        if not levels:
            return {}
        if len(levels) == 1:
            return {"base": levels[0], "per_level_above_first": 0}
        step = levels[1] - levels[0]
        if all(levels[i] - levels[i - 1] == step for i in range(1, len(levels))):
            return {"base": levels[0], "per_level_above_first": step}
        return {"levels": levels}

    @staticmethod
    def _levels(cost, max_level):
        if not isinstance(cost, dict) or "base" not in cost:
            return None
        return [cost["base"] + cost.get("per_level_above_first", 0) * (lv - 1) for lv in range(1, max_level + 1)]

    def enchantments(self):
        out = {}
        data = self.jar.cat("enchantment")
        if data:
            tag = lambda t: set(self.tags.get("enchantment", t))  # noqa: E731
            treasure, tradeable, curse = tag("minecraft:treasure"), tag("minecraft:tradeable"), tag("minecraft:curse")
            table = tag("minecraft:in_enchanting_table")
            for t in ("minecraft:treasure", "minecraft:tradeable", "minecraft:curse", "minecraft:in_enchanting_table"):
                self.referenced_tags["enchantment"].add(t)
            for eid, d in sorted(data.items()):
                desc = d.get("description")
                key = desc.get("translate") if isinstance(desc, dict) else None
                sup = d.get("supported_items")
                prim = d.get("primary_items", sup)
                excl = d.get("exclusive_set")
                self.ref_tag("item", sup)
                self.ref_tag("item", prim)
                self.ref_tag("enchantment", excl)
                mx = d.get("max_level", 1)
                e = {
                    "name": self.lang.get(key, self.lang.enchant(eid)),
                    "max_level": mx,
                    "weight": d.get("weight"),
                    "anvil_cost": d.get("anvil_cost"),
                    "supported": self.tags.expand("item", sup),
                    "primary": self.tags.expand("item", prim),
                    "exclusive": [x for x in self.tags.expand("enchantment", excl) if x != eid],
                    "min_cost": d.get("min_cost"),
                    "max_cost": d.get("max_cost"),
                    "treasure": eid in treasure,
                    "tradeable": eid in tradeable,
                    "curse": eid in curse,
                    "in_enchanting_table": eid in table,
                    "min_cost_levels": self._levels(d.get("min_cost"), mx),
                    "max_cost_levels": self._levels(d.get("max_cost"), mx),
                    "slots": d.get("slots"),
                    "effects": sorted((d.get("effects") or {}).keys()),
                    "supported_ref": sup,
                    "primary_ref": prim,
                    "exclusive_ref": excl,
                }
                out[eid] = clean(e)
            # vanilla checks exclusivity both ways (Enchantment.areCompatible), so make the lists symmetric
            for eid, e in out.items():
                for other in e["exclusive"]:
                    if other in out and eid not in out[other]["exclusive"]:
                        out[other]["exclusive"].append(eid)
            for e in out.values():
                e["exclusive"].sort()
            return out
        code = self.code.get("enchantments")
        if not code:
            self.missing.append("enchantments")
            return None
        for eid, c in code.items():
            anvil = c.get("anvil_cost")
            if anvil is None and c.get("rarity"):
                anvil = RARITY_ANVIL.get(c["rarity"])
            e = {
                "name": self.lang.get(c.get("lang"), self.lang.enchant(eid)),
                "max_level": c["max_level"],
                "weight": c["weight"],
                "anvil_cost": anvil,
                "supported": c["supported"],
                # the table never offers an item the enchantment can't go on (only matters for curses <=1.20.4)
                "primary": [i for i in c["primary"] if i in set(c["supported"])],
                "exclusive": c["exclusive"],
                "min_cost": self._fit(c["min_cost_levels"]),
                "max_cost": self._fit(c["max_cost_levels"]),
                "treasure": c["treasure"],
                "tradeable": c["tradeable"],
                "curse": c["curse"],
                "in_enchanting_table": bool(c.get("discoverable", True)) and not c["treasure"],
                "min_cost_levels": c["min_cost_levels"],
                "max_cost_levels": c["max_cost_levels"],
            }
            if c.get("rarity"):
                e["rarity"] = c["rarity"]
            if c.get("category"):
                e["category"] = c["category"]
            if c.get("slots") is not None:
                e["slots"] = c["slots"]
            out[eid] = clean(e)
        return out

    # ------------------------------------------------------------------ brewing
    def potions(self):
        out = {}
        for pid, p in (self.code.get("potions") or {}).items():
            if p.get("experimental"):
                continue
            base = p.get("name") or short(pid)
            out[pid] = {
                "name": self.lang.get("item.minecraft.potion.effect." + base, titleize(pid)),
                "effects": [[e[0], e[1], e[2]] for e in p.get("effects", [])],
            }
            if base != short(pid):
                out[pid]["base"] = "minecraft:" + base
        return out

    def brewing(self):
        potions = self.potions()
        code = self.code.get("brewing")
        mixes, containers, bottles = [], [], []
        if code:
            for m in code["mixes"]:
                for ing in self.tags.expand("item", m["ingredient"]):
                    mixes.append({"input": m["input"], "ingredient": ing, "output": m["output"]})
            for m in code["container_mixes"]:
                for ing in self.tags.expand("item", m["ingredient"]):
                    containers.append({"input": m["input"], "ingredient": ing, "output": m["output"]})
            for c in code.get("containers", []):
                bottles.extend(self.tags.expand("item", c))
            source = "code"
        else:
            recs = {k: v for k, v in self.jar.cat("recipe").items() if v.get("type") == "minecraft:brewing"}
            if not recs:
                self.missing.append("brewing")
                return None
            seen_c = set()
            for rid, r in sorted(recs.items()):
                inp = r.get("input", {})
                in_item = inp.get("item") or inp.get("items")
                in_pots = (inp.get("potion_contents") or {}).get("potions")
                out_o = r.get("output", {})
                out_item = out_o.get("id")
                out_pot = ((out_o.get("components") or {}).get("minecraft:potion_contents") or {})
                out_pot = out_pot.get("potion") if isinstance(out_pot, dict) else out_pot
                reag = r.get("reagent", {})
                reag_items = self.tags.expand("item", reag.get("item") or reag.get("items") or reag.get("tag"))
                in_pots_l = self.tags.expand("potion", in_pots) if in_pots else [None]
                for ing in reag_items:
                    if in_item == out_item:
                        if in_item != "minecraft:potion":
                            continue  # same mix repeated for splash/lingering
                        for ip in in_pots_l:
                            mixes.append({"input": ip, "ingredient": ing, "output": out_pot})
                    else:
                        key = (in_item, ing, out_item)
                        if key not in seen_c:
                            seen_c.add(key)
                            containers.append({"input": in_item, "ingredient": ing, "output": out_item})
                if in_item not in bottles and isinstance(in_item, str):
                    bottles.append(in_item)
            source = "recipes (minecraft:brewing)"
        allowed = set(potions.keys())
        mixes = [m for m in mixes if (m["input"] in allowed or m["input"] is None) and m["output"] in allowed]
        return {"mixes": mixes, "containers": containers, "bottles": bottles, "potions": potions, "source": source}

    # ------------------------------------------------------------------ trades
    def trades(self):
        """Returns (trades, rebalance_trades, picks)."""
        if self.jar.cat("villager_trade"):
            return self._data_trades()
        code = self.code.get("trades")
        if not code:
            self.missing.append("trades")
            return None, None, None
        picks = {}
        base = self._code_villager(code["villager"], picks)
        wt, wpicks = self._code_wandering(code["wandering_trader"])
        base["wandering_trader"] = wt
        picks["wandering_trader"] = wpicks
        reb = None
        if code.get("experimental_villager") is not None:
            exp_raw = dict(code["villager"])
            exp_raw.update(code["experimental_villager"])
            reb = self._code_villager(exp_raw, {})
            if code.get("experimental_wandering_trader") is not None:
                reb["wandering_trader"] = self._code_wandering(code["experimental_wandering_trader"])[0]
            else:
                reb["wandering_trader"] = wt
        return base, reb, picks

    def _code_villager(self, raw, picks):
        out = {}
        for prof, levels in raw.items():
            p = short(prof)
            out[p] = {}
            for lvl, listings in sorted(levels.items(), key=lambda kv: int(kv[0])):
                rows = []
                for l in listings:
                    rows.extend(self._listing(l))
                out[p][str(lvl)] = rows
            picks[p] = {lv: 2 for lv in out[p]}
        return out

    def _code_wandering(self, raw):
        out, picks = {}, {}
        if isinstance(raw, dict):  # Int2ObjectMap: 1 = common pool (5 picked), 2 = rare pool (1 picked)
            names = {"1": ("common", 5), "2": ("rare", 1)}
            for k, listings in raw.items():
                n, c = names.get(str(k), (str(k), 1))
                out[n] = [r for l in listings for r in self._listing(l)]
                picks[n] = c
        else:  # list of [listings, count]: buying pool first, then the two selling pools
            names = [f"pool_{i + 1}" for i in range(len(raw))]
            if len(raw) == 3:
                names[0] = "buying"
                big = 1 if raw[1][1] >= raw[2][1] else 2  # the pool with more picks is the common one
                names[big], names[3 - big] = "common", "uncommon"
            for i, (listings, count) in enumerate(raw):
                out[names[i]] = [r for l in listings for r in self._listing(l)]
                picks[names[i]] = count
        return out, picks

    @staticmethod
    def _stack(x, count_override=None):
        if x is None:
            return None
        if isinstance(x, str):
            return [x, count_override or 1]
        if isinstance(x, dict):
            iid = x.get("item")
            cnt = x.get("count", 1)
            if count_override is not None:
                cnt = count_override
            return [iid, cnt]
        return None

    def _row(self, buy, sell, uses, xp, mult, note="", buyB=None, **extra):
        r = {"buy": buy, "buyB": buyB, "sell": sell, "max_uses": uses, "xp": xp,
             "price_mult": num(mult), "note": note}
        r.update(extra)
        return r

    def _map_dest(self, dest):
        structs = []
        if isinstance(dest, str):
            bare = dest.lstrip("#")
            if self.tags.has("worldgen/structure", bare):
                structs = self.tags.get("worldgen/structure", bare)
        if structs:
            return "points to the nearest " + " or ".join(titleize(x) for x in structs)
        return f"points to the nearest {titleize(str(dest).lstrip('#'))}"

    def _ench_tag_names(self, ref):
        ids = self.tags.expand("enchantment", ref) if isinstance(ref, (str, list)) else []
        return ", ".join(self.lang.enchant(i) for i in ids)

    def _listing(self, l):
        if not isinstance(l, dict):
            return []
        t = l.get("_type", "").split("$")[-1]
        g = l.get
        if t == "EmeraldForItems":
            buy = self._stack(g("itemStack")) if g("itemStack") else [g("item"), g("cost")]
            return [self._row(buy, [EMERALD, g("emeraldAmount") or 1], g("maxUses"), g("villagerXp"), g("priceMultiplier"))]
        if t == "ItemsForEmeralds":
            sell = self._stack(g("itemStack"), g("numberOfItems"))
            note = ""
            if g("enchantmentProvider"):
                note = f"comes enchanted ({short(g('enchantmentProvider'))})"
            return [self._row([EMERALD, g("emeraldCost")], sell, g("maxUses"), g("villagerXp"), g("priceMultiplier"), note)]
        if t == "ItemsAndEmeraldsToItems":
            buyB = self._stack(g("fromItem"), g("fromCount"))
            sell = self._stack(g("toItem"), g("toCount"))
            note = f"comes enchanted ({short(g('enchantmentProvider'))})" if g("enchantmentProvider") else ""
            return [self._row([EMERALD, g("emeraldCost")], sell, g("maxUses"), g("villagerXp"), g("priceMultiplier"),
                              note, buyB=buyB)]
        if t == "TippedArrowForItemsAndEmeralds":
            return [self._row([EMERALD, g("emeraldCost")], self._stack(g("toItem"), g("toCount")), g("maxUses"),
                              g("villagerXp"), g("priceMultiplier"),
                              "random brewable potion that has effects (not Water, Mundane, Thick or Awkward)",
                              buyB=self._stack(g("fromItem"), g("fromCount")))]
        if t == "DyedArmorForEmeralds":
            return [self._row([EMERALD, g("value")], [g("item"), 1], g("maxUses"), g("villagerXp"), 0.2,
                              "dyed a random color: 1 random dye, 30% chance of a 2nd and 20% chance of a 3rd mixed in")]
        if t == "EnchantBookForEmeralds":
            tr = g("tradeableEnchantments")
            lo, hi = g("minLevel"), g("maxLevel")
            if isinstance(tr, str):
                self.ref_tag("enchantment", tr)
            which = "any tradeable enchantment"
            all_tradeable = {k for k, e in (self.code.get("enchantments") or {}).items()
                             if e.get("tradeable") and not e.get("experimental")}
            if isinstance(tr, list) and set(tr) != all_tradeable:
                which = "one of: " + ", ".join(self.lang.enchant(i) for i in tr)
            elif isinstance(tr, str) and tr != "#minecraft:tradeable":
                which = "one of: " + self._ench_tag_names(tr)
            lvl = "a random level"
            if lo is not None and hi is not None and (lo > 0 or hi < 1000):
                lvl = f"level {max(lo, 1)}–{hi}" if hi < 1000 else f"level {max(lo, 1)} or higher"
            note = (f"random enchantment ({which}) at {lvl}; costs 2 + random(0 to 4 + 10×level) + 3×level emeralds, "
                    f"doubled for treasure enchantments (e.g. Mending), max 64; plus 1 Book")
            return [self._row([EMERALD, None], [ "minecraft:enchanted_book", 1], 12, g("villagerXp"), 0.2, note,
                              buyB=["minecraft:book", 1], buy_range=[5, 64])]
        if t == "EnchantedItemForEmeralds":
            base = g("baseEmeraldCost")
            item = self._stack(g("itemStack"))
            note = (f"enchanted like an enchanting table at level 5–19 (no treasure); costs {base} + that level emeralds, max 64")
            return [self._row([EMERALD, None], item, g("maxUses"), g("villagerXp"), g("priceMultiplier"), note,
                              buy_range=[base + 5, min(64, base + 19)])]
        if t == "TreasureMapForEmeralds":
            name = self.lang.get(g("displayName"), short(g("displayName") or ""))
            return [self._row([EMERALD, g("emeraldCost")], ["minecraft:filled_map", 1], g("maxUses"), g("villagerXp"), 0.2,
                              f"{name}: {self._map_dest(g('destination'))}", buyB=["minecraft:compass", 1])]
        if t == "SuspiciousStewForEmerald":
            effs = g("effects")
            if isinstance(effs, dict):
                effs = effs.get("effects")
            if effs is None and g("effect"):
                effs = [{"effect": g("effect"), "duration": g("duration")}]
            desc = ", ".join(f"{self.lang.effect(e['effect'])} {num(e['duration'] / 20)} s" for e in effs or [])
            return [self._row([EMERALD, 1], ["minecraft:suspicious_stew", 1], 12, g("xp"), g("priceMultiplier"),
                              f"stew effect: {desc}")]
        if t == "EmeraldsForVillagerTypeItem":
            by_item = {}
            for vt, item in (g("trades") or {}).items():
                by_item.setdefault(item, []).append(short(vt))
            return [self._row([item, g("cost")], [EMERALD, 1], g("maxUses"), g("villagerXp"), 0.05,
                              "only villagers from: " + ", ".join(sorted(types)), villager_types=sorted(types))
                    for item, types in by_item.items()]
        if t == "TypeSpecificTrade":
            grouped = []
            for vt, sub in (g("trades") or {}).items():
                for r in self._listing(sub):
                    key = json.dumps(r, sort_keys=True)
                    for gk in grouped:
                        if gk[0] == key:
                            gk[1].append(short(vt))
                            break
                    else:
                        grouped.append([key, [short(vt)], r])
            out = []
            for _, types, r in grouped:
                r = dict(r)
                types = sorted(types)
                r["villager_types"] = types
                r["note"] = ((r["note"] + "; ") if r["note"] else "") + "only villagers from: " + ", ".join(types)
                out.append(r)
            return out
        if t == "FailureItemListing":
            return []
        return [self._row(None, None, None, None, None, f"unparsed trade type {t}")]

    # 26.x data-driven trades
    def _data_trades(self):
        base = self._data_trade_tables(self.jar.cat("villager_trade"), self.tags, self.jar.cat("trade_set"))
        reb = None
        ov = self.jar.overlays.get("trade_rebalance")
        if ov:
            vt = dict(self.jar.cat("villager_trade"))
            vt.update(ov["files"].get("villager_trade", {}))
            tags = Tags(self.jar.tags, ov.get("tags"))
            ts = dict(self.jar.cat("trade_set"))
            ts.update(ov["files"].get("trade_set", {}))
            reb = self._data_trade_tables(vt, tags, ts)[0]
        return base[0], reb, base[1]

    def _data_trade_tables(self, trades, tags, sets):
        out, picks = {}, {}
        for sid, s in sorted(sets.items()):
            path = short(sid)
            prof, _, part = path.partition("/")
            lvl = part.replace("level_", "") if part.startswith("level_") else part
            ref = s.get("trades")
            ids = tags.expand("villager_trade", ref) if isinstance(ref, (str, list)) else []
            rows = []
            for tid in ids:
                if tid in trades:
                    rows.extend(self._data_trade(trades[tid], tid))
            out.setdefault(prof, {})[lvl] = rows
            amt = s.get("amount", 1)
            picks.setdefault(prof, {})[lvl] = num(amt) if isinstance(amt, (int, float)) else provider_text(amt)
        # keep levels in order
        for prof in out:
            out[prof] = dict(sorted(out[prof].items(), key=lambda kv: (not kv[0].isdigit(), int(kv[0]) if kv[0].isdigit() else 0, kv[0])))
        return out, picks

    def _cost(self, c):
        if not isinstance(c, dict):
            return None
        cnt = c.get("count", 1)
        if isinstance(cnt, (int, float)):
            return [c.get("id"), num(cnt)]
        rng = provider_range(cnt)
        return [c.get("id"), None, rng]

    def _data_trade(self, t, tid):
        def val(x, default):
            if x is None:
                return default
            if isinstance(x, (int, float)):
                return num(x)
            return provider_text(x)

        buy = self._cost(t.get("wants"))
        buyB = self._cost(t.get("additional_wants"))
        gives = t.get("gives") or {}
        sell = [gives.get("id"), num(gives.get("count", 1))]
        extra = {}
        if buy and len(buy) == 3:
            extra["buy_range"] = list(buy[2]) if buy[2] else None
            buy = buy[:2]
        if buyB and len(buyB) == 3:
            buyB = buyB[:2]
        notes = []
        mods = t.get("given_item_modifier", t.get("given_item_modifiers"))
        if isinstance(mods, dict):
            mods = [mods]
        base_cost = buy[1] if buy and isinstance(buy[1], (int, float)) else 0
        doubled = t.get("double_trade_price_enchantments")
        mods = mods or []
        set_name = None
        for m in mods:
            if short(m.get("type") or m.get("function") or "") == "set_name":
                nm = m.get("name")
                if isinstance(nm, dict) and nm.get("translate"):
                    set_name = self.lang.get(nm["translate"], short(nm["translate"]))
                elif isinstance(nm, str):
                    set_name = nm
        for m in mods:
            mt = short(m.get("type") or m.get("function") or "")
            if mt in ("filtered", "discard", "set_name"):
                continue
            if mt == "enchant_randomly":
                opts = m.get("options")
                which = "any tradeable enchantment" if opts == "#minecraft:tradeable" else "one of: " + self._ench_tag_names(opts)
                self.ref_tag("enchantment", opts)
                if m.get("include_additional_cost_component"):
                    dbl = ""
                    if doubled:
                        self.ref_tag("enchantment", doubled)
                        dbl = (", doubled for treasure enchantments (e.g. Mending)" if doubled == "#minecraft:double_trade_price"
                               else f", doubled for {self._ench_tag_names(doubled)}")
                    pre = f"{base_cost} + " if base_cost else ""
                    notes.append(f"random enchantment ({which}) at a random level; costs {pre}2 + random(0 to 4 + 10×level) "
                                 f"+ 3×level emeralds{dbl}, max 64")
                    buy = [buy[0], None] if buy else buy
                    extra["buy_range"] = [base_cost + 5, 64]
                else:
                    notes.append(f"random enchantment ({which})")
            elif mt == "enchant_with_levels":
                lv = provider_text(m.get("levels"))
                rng = provider_range(m.get("levels"))
                self.ref_tag("enchantment", m.get("options"))
                txt = f"enchanted like an enchanting table at level {lv}"
                if m.get("options") == "#minecraft:on_traded_equipment":
                    txt += " (no treasure)"
                if m.get("include_additional_cost_component") and rng:
                    txt += f"; costs {base_cost} + that level emeralds, max 64"
                    buy = [buy[0], None] if buy else buy
                    extra["buy_range"] = [base_cost + rng[0], min(64, base_cost + rng[1])]
                notes.append(txt)
            elif mt == "exploration_map":
                if sell[0] == "minecraft:map":  # 26.1-26.2: an empty map turned into a filled explorer map
                    sell = ["minecraft:filled_map", sell[1]]
                notes.append(f"{set_name or self.iname(sell[0])}: {self._map_dest(m.get('destination', ''))}")
            elif mt == "set_stew_effect":
                effs = ", ".join(f"{self.lang.effect(e.get('type'))} {provider_text(e.get('duration'))} s"
                                 for e in m.get("effects", []))
                notes.append(f"stew with one random effect: {effs}")
            elif mt == "set_random_dyes":
                notes.append(f"dyed with {provider_text(m.get('number_of_dyes'))} random dyes")
            elif mt == "set_random_potion":
                opts = m.get("options")
                pots = self.tags.expand("potion", opts) if isinstance(opts, str) else []
                self.ref_tag("potion", opts)
                notes.append("random potion from " + (", ".join(short(p) for p in pots) if pots else str(opts)))
            elif mt == "set_potion":
                notes.append("potion: " + self.lang.get("item.minecraft.potion.effect." + short(m.get("id", "")),
                                                        short(m.get("id", ""))))
            elif mt == "set_count":
                notes.append(f"count {provider_text(m.get('count'))}")
            else:
                notes.append(mt.replace("_", " "))
        pred = t.get("merchant_predicate")
        types = None
        if isinstance(pred, dict):
            pr = pred.get("predicate") or {}
            pp = pr.get("minecraft:predicates") or pr.get("predicates") or pr
            vv = pp.get("minecraft:villager/variant")
            if vv is not None:
                types = sorted(short(x) for x in (vv if isinstance(vv, list) else [vv]))
        if types:
            extra["villager_types"] = types
            notes.append("only villagers from: " + ", ".join(types))
        row = self._row(buy, sell, val(t.get("max_uses"), 4), val(t.get("xp"), 1), val(t.get("reputation_discount"), 0),
                        "; ".join(notes), buyB=buyB, **extra)
        row["id"] = tid
        return [row]

    # ------------------------------------------------------------------ tags
    def tags_out(self, *payloads):
        found = {r: set(v) for r, v in self.referenced_tags.items()}
        pat = re.compile(r'"#([a-z0-9_.-]+:[a-z0-9_./-]+)"')
        tagpat = re.compile(r'"tag"\s*:\s*"([a-z0-9_.-]+:[a-z0-9_./-]+)"')
        for p in payloads:
            s = json.dumps(p)
            for m in pat.finditer(s):
                for r in ("item", "block", "enchantment", "entity_type", "potion"):
                    if self.tags.has(r, m.group(1)):
                        found.setdefault(r, set()).add(m.group(1))
            for m in tagpat.finditer(s):
                for r in ("item", "block"):
                    if self.tags.has(r, m.group(1)):
                        found.setdefault(r, set()).add(m.group(1))
        # loot "minecraft:tag" entries use "name"
        out = {}
        for r, ids in found.items():
            if not ids or r.startswith("worldgen"):
                continue
            out[r] = {t: self.tags.get(r, t) for t in sorted(ids) if self.tags.has(r, t)}
        return out

    def loot_tag_refs(self, loot):
        for tbl in loot.values():
            stack = [tbl]
            while stack:
                x = stack.pop()
                if isinstance(x, dict):
                    if x.get("type") in ("minecraft:tag", "tag"):
                        tag = x.get("name") or x.get("tag") or x.get("items")
                        if isinstance(tag, str):
                            self.referenced_tags["item"].add(tag.lstrip("#"))
                    stack.extend(x.values())
                elif isinstance(x, list):
                    stack.extend(x)
