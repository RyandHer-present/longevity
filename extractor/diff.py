"""Hidden-changelog diffs between two built versions (gamedata/<v>/*.json.gz)."""
import gzip
import json
import os
import re
from collections import Counter

# ----------------------------------------------------------------------------- io


def load(outdir, v, name):
    base = os.path.join(outdir, v, name + ".json")
    if os.path.exists(base + ".gz"):
        with gzip.open(base + ".gz", "rt", encoding="utf-8") as f:
            return json.load(f)
    if os.path.exists(base):
        with open(base, encoding="utf-8") as f:
            return json.load(f)
    return None


# ----------------------------------------------------------------------------- helpers

def short(i):
    return i.split(":", 1)[1] if isinstance(i, str) and i.startswith("minecraft:") else i


def titleize(s):
    return " ".join(w.capitalize() for w in re.split(r"[_/]", short(str(s))) if w)


def same(a, b):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool):
        return abs(a - b) <= 1e-6 * max(1, abs(a), abs(b))
    return a == b


def fmt(v):
    if v is None:
        return "none"
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, float):
        return f"{v:g}"
    if isinstance(v, (list, tuple)) and len(v) == 2 and all(isinstance(x, (int, float)) for x in v):
        return rng(v)
    if isinstance(v, dict):
        return ", ".join(f"{k} {fmt(x)}" for k, x in v.items())
    return str(v)


def rng(r):
    if r is None:
        return "?"
    a, b = r
    a, b = round(a, 4), round(b, 4)
    a = int(a) if float(a).is_integer() else a
    b = int(b) if float(b).is_integer() else b
    return f"{a}" if a == b else f"{a}–{b}"


def pct(p):
    if p is None:
        return "?"
    v = p * 100
    return f"{v:.3g}%"


class Names:
    def __init__(self, *sources):
        self.d = {}
        for s in sources:
            for k, v in (s or {}).items():
                if isinstance(v, dict) and v.get("name"):
                    self.d.setdefault(k, v["name"])

    def __call__(self, i):
        if isinstance(i, str) and i.startswith("#"):
            return "#" + short(i[1:])
        return self.d.get(i, titleize(i) if i else "?")


# ----------------------------------------------------------------------------- simple field diffs

def field_diff(old, new, fields, names, label_added=True):
    out = []
    for i in sorted(set(old) | set(new)):
        if i not in old:
            if label_added:
                out.append({"id": i, "name": names(i), "field": "added", "from": None, "to": None,
                            "what": f"{names(i)} added"})
            continue
        if i not in new:
            if label_added:
                out.append({"id": i, "name": names(i), "field": "removed", "from": None, "to": None,
                            "what": f"{names(i)} removed"})
            continue
        a, b = old[i], new[i]
        for f, label in fields:
            x, y = a.get(f), b.get(f)
            if isinstance(x, list) and isinstance(y, list) and all(isinstance(z, str) for z in x + y):
                sx, sy = set(x), set(y)
                if f == "repair":
                    sy = {z for z in sy if z in old or z in sx}
                if sx != sy:
                    add, rem = sorted(sy - sx), sorted(sx - sy)
                    parts = []
                    if add:
                        parts.append("adds " + ", ".join(names(z) for z in add[:12]) + (f" (+{len(add) - 12} more)" if len(add) > 12 else ""))
                    if rem:
                        parts.append("drops " + ", ".join(names(z) for z in rem[:12]) + (f" (+{len(rem) - 12} more)" if len(rem) > 12 else ""))
                    out.append({"id": i, "name": names(i), "field": f, "added": add, "removed": rem,
                                "what": f"{names(i)} {label}: " + "; ".join(parts)})
                continue
            if isinstance(x, dict) or isinstance(y, dict):
                if json.dumps(x, sort_keys=True) != json.dumps(y, sort_keys=True):
                    out.append({"id": i, "name": names(i), "field": f, "from": x, "to": y,
                                "what": f"{names(i)} {label} {fmt(x)} → {fmt(y)}"})
                continue
            if isinstance(x, list) or isinstance(y, list):
                if x != y:
                    out.append({"id": i, "name": names(i), "field": f, "from": x, "to": y,
                                "what": f"{names(i)} {label} {fmt_list(x)} → {fmt_list(y)}"})
                continue
            if not same(x, y):
                out.append({"id": i, "name": names(i), "field": f, "from": x, "to": y,
                            "what": f"{names(i)} {label} {fmt(x)} → {fmt(y)}"})
    return out


def fmt_list(v):
    if v is None:
        return "none"
    return "[" + ", ".join(fmt(x) for x in v) + "]"


# ----------------------------------------------------------------------------- mobs

MOB_FIELDS = [("health", "health"), ("armor", "armor"), ("toughness", "armor toughness"), ("attack", "attack damage"),
              ("speed", "speed"), ("follow", "follow range"), ("kb_resist", "knockback resistance"),
              ("flying_speed", "flying speed"), ("category", "mob category"), ("loot", "loot table"),
              ("width", "hitbox width"), ("height", "hitbox height")]
CORE_ATTRS = {"max_health", "armor", "armor_toughness", "attack_damage", "movement_speed", "follow_range",
              "knockback_resistance", "flying_speed"}


def diff_mobs(old, new, biome_name):
    names = Names(old, new)
    out = field_diff(old, new, MOB_FIELDS, names)
    old_biomes = {b for m in old.values() for b in m.get("spawns", {})}
    new_biomes = {b for m in new.values() for b in m.get("spawns", {})}
    for bi in sorted(new_biomes - old_biomes):
        who = sorted(names(i) for i, m in new.items() if bi in m.get("spawns", {}))
        out.append({"id": bi, "name": biome_name(bi), "field": "new_biome", "mobs": who,
                    "what": f"New biome {biome_name(bi)} spawns: " + ", ".join(who)})
    for bi in sorted(old_biomes - new_biomes):
        out.append({"id": bi, "name": biome_name(bi), "field": "removed_biome",
                    "what": f"Biome {biome_name(bi)} no longer has natural spawns"})
    for i in sorted(set(old) & set(new)):
        a, b = old[i], new[i]
        aa, ba = a.get("attributes", {}), b.get("attributes", {})
        for k in sorted(set(aa) & set(ba)):
            if k in CORE_ATTRS:
                continue
            if not same(aa[k], ba[k]):
                out.append({"id": i, "name": names(i), "field": k, "from": aa[k], "to": ba[k],
                            "what": f"{names(i)} {k.replace('_', ' ')} {fmt(aa[k])} → {fmt(ba[k])}"})
        sa, sb = a.get("spawns", {}), b.get("spawns", {})
        added = sorted(set(sb) - set(sa) - (new_biomes - old_biomes))
        removed = sorted(set(sa) - set(sb) - (old_biomes - new_biomes))
        if added:
            out.append({"id": i, "name": names(i), "field": "biomes", "added": added, "removed": [],
                        "what": f"{names(i)} now spawns in " + ", ".join(biome_name(x) for x in added)})
        if removed:
            out.append({"id": i, "name": names(i), "field": "biomes", "added": [], "removed": removed,
                        "what": f"{names(i)} no longer spawns in " + ", ".join(biome_name(x) for x in removed)})
        # weight / group size changes, grouped when the same change hits many biomes
        groups = {}
        for bi in sorted(set(sa) & set(sb)):
            x, y = sa[bi], sb[bi]
            parts = []
            if not same(x.get("weight"), y.get("weight")):
                parts.append(f"weight {fmt(x.get('weight'))} → {fmt(y.get('weight'))}")
            if (x.get("min"), x.get("max")) != (y.get("min"), y.get("max")):
                parts.append(f"group size {rng((x.get('min'), x.get('max')))} → {rng((y.get('min'), y.get('max')))}")
            if parts:
                groups.setdefault("; ".join(parts), []).append(bi)
        for change, bis in groups.items():
            where = ", ".join(biome_name(x) for x in bis[:8]) + (f" and {len(bis) - 8} more biomes" if len(bis) > 8 else "")
            out.append({"id": i, "name": names(i), "field": "spawn", "biomes": bis,
                        "what": f"{names(i)} spawning in {where}: {change}"})
    return out


# ----------------------------------------------------------------------------- loot

def loot_name(tid, names):
    p = short(tid)
    parts = p.split("/")
    head = parts[0]
    if head == "entities" and len(parts) >= 2:
        n = names("minecraft:" + parts[1])
        extra = " (" + " ".join(titleize(x) for x in parts[2:]) + ")" if len(parts) > 2 else ""
        return f"{n}{extra} drops"
    if head == "blocks" and len(parts) == 2:
        return f"{names('minecraft:' + parts[1])} (block)"
    if head == "chests":
        words = " ".join(titleize(x) for x in parts[1:]).split()
        words = [w for i, w in enumerate(words) if i == 0 or w != words[i - 1]]  # village/village_x -> Village X
        return " ".join(words) + " chest"
    if head == "gameplay":
        return ": ".join(titleize(x) for x in parts[1:])
    return ": ".join(titleize(x) for x in parts)


def _as_list(x):
    if x is None:
        return []
    return list(x) if isinstance(x, list) else [x]


def _mc(t):
    return t if not isinstance(t, str) or ":" in t else "minecraft:" + t


def canon_cond(c, preds, depth=0):
    """One loot condition in the pre-26.3 shape: {"condition": type, ...}. 26.3 uses "type", single
    "condition" objects, named predicate references ("minecraft:tool/can_shear") and match_block."""
    if isinstance(c, str):
        ref = (preds or {}).get(c)
        if ref is not None and depth < 8:
            return canon_cond(ref, preds, depth + 1)
        return {"condition": c}
    if isinstance(c, list):
        return {"condition": "minecraft:all_of", "terms": [canon_cond(x, preds, depth + 1) for x in c]}
    if not isinstance(c, dict):
        return c
    d = dict(c)
    t = d.pop("condition", None) or d.pop("type", None)
    t = _mc(t)
    if t == "minecraft:match_block":
        d = {"block": d.get("blocks"), "properties": d.get("state", {})}
        t = "minecraft:block_state_property"
    if t == "minecraft:alternative":
        t = "minecraft:any_of"
    if "terms" in d:
        d["terms"] = [canon_cond(x, preds, depth + 1) for x in _as_list(d["terms"])]
    if "term" in d:
        d["term"] = canon_cond(d["term"], preds, depth + 1)
    if t == "minecraft:entity_properties" and isinstance(d.get("predicate"), dict):
        d["predicate"] = {short(k): v for k, v in d["predicate"].items()}
    d["condition"] = t
    return d


def _flatten_all(conds):
    out = []
    for c in conds:
        if isinstance(c, dict) and c.get("condition") == "minecraft:all_of":
            out.extend(_flatten_all(c.get("terms", [])))
        else:
            out.append(c)
    return out


def _canon_node(d, preds):
    conds = _as_list(d.pop("conditions", None)) + _as_list(d.pop("condition", None))
    if conds:
        d["conditions"] = _flatten_all([canon_cond(c, preds) for c in conds])
    fns = _as_list(d.pop("functions", None)) + _as_list(d.pop("modifier", None)) + _as_list(d.pop("modifiers", None))
    if fns:
        d["functions"] = [canon_fn(f, preds) for f in fns]
    return d


def canon_fn(f, preds):
    if isinstance(f, str):
        return {"function": "reference", "name": f}
    if not isinstance(f, dict):
        return f
    d = dict(f)
    t = d.pop("function", None) or d.pop("type", None)
    _canon_node(d, preds)
    d["function"] = _mc(t)
    return d


def canon_entry(e, preds):
    if not isinstance(e, dict):
        return e
    d = _canon_node(dict(e), preds)
    if "children" in d:
        d["children"] = [canon_entry(x, preds) for x in _as_list(d["children"])]
    return d


def canon_loot(table, preds=None):
    """Loot table in one shape for every version, so a format change is not a gameplay change."""
    if not isinstance(table, dict):
        return table
    d = _canon_node(dict(table), preds)
    pools = []
    for p in _as_list(d.get("pools")):
        q = _canon_node(dict(p), preds)
        q["entries"] = [canon_entry(x, preds) for x in _as_list(q.get("entries"))]
        pools.append(q)
    d["pools"] = pools
    return d


def _num_range(p):
    if p is None:
        return None
    if isinstance(p, (int, float)) and not isinstance(p, bool):
        return (p, p)
    if isinstance(p, dict):
        t = short(p.get("type", "minecraft:uniform" if "min" in p else "minecraft:constant"))
        if t == "constant":
            return _num_range(p.get("value"))
        if t == "uniform":
            a, b = _num_range(p.get("min")), _num_range(p.get("max"))
            return (a[0], b[1]) if a and b else None
        if t == "binomial":
            n = _num_range(p.get("n"))
            return (0, n[1]) if n else None
    return None


def _biome_sig(c):
    """'in a, b' for a location_check that only tests biomes, else None."""
    if not isinstance(c, dict) or short(c.get("condition", c.get("type", ""))) != "location_check":
        return None
    pred = c.get("predicate") or {}
    bs = pred.get("biomes", pred.get("biome"))
    if bs is None or set(pred) - {"biome", "biomes"}:
        return None
    bs = bs if isinstance(bs, list) else [bs]
    return "in " + ", ".join(sorted(short(b) for b in bs))


def _cond_sig(conds):
    """(signature string, chance, chance bonus per enchant level)."""
    sig, chance, bonus = [], 1.0, None
    for c in conds or []:
        t = short(c.get("condition", c.get("type", "")))
        if t == "random_chance":
            ch = c.get("chance")
            r = _num_range(ch)
            if r:
                chance *= r[0]
            else:
                sig.append("random_chance")
        elif t == "random_chance_with_looting":
            chance *= c.get("chance", 1)
            bonus = c.get("looting_multiplier")
        elif t == "random_chance_with_enchanted_bonus":
            un = c.get("unenchanted_chance", 0)
            chance *= un if isinstance(un, (int, float)) else 1
            ec = c.get("enchanted_chance")
            if isinstance(ec, dict):
                bonus = ec.get("per_level_above_first", ec.get("added"))
        elif t == "killed_by_player":
            sig.append("player kill")
        elif t == "survives_explosion":
            continue
        elif t == "match_tool":
            pred = json.dumps(c.get("predicate", {}), sort_keys=True)
            if "silk_touch" in pred:
                sig.append("silk touch")
            elif "shears" in pred:
                sig.append("shears")
            else:
                sig.append("tool")
        elif t == "inverted":
            inner, _, _ = _cond_sig([c.get("term", {})])
            sig.append("not " + inner if inner else "not")
        elif t == "all_of":
            s2, c2, b2 = _cond_sig(c.get("terms", []))
            if s2:
                sig.append(s2)
            chance *= c2
            bonus = b2 if b2 is not None else bonus
        elif t == "location_check":
            sig.append(_biome_sig(c) or "location_check")
        elif (t == "any_of" or t == "alternative") and c.get("terms") and all(
                _biome_sig(x) for x in c.get("terms", [])):
            # 1.20.4 checks one biome per term; 1.20.5+ uses one term with a biome list
            bs = sorted({b for x in c["terms"] for b in _biome_sig(x)[3:].split(", ")})
            sig.append("in " + ", ".join(bs))
        elif t == "any_of" or t == "alternative":
            inner = [_cond_sig([x])[0] for x in c.get("terms", [])]
            sig.append("(" + " or ".join(x for x in inner if x) + ")")
        elif t == "table_bonus":
            sig.append("fortune table " + json.dumps(c.get("chances")))
        elif t == "block_state_property":
            sig.append("state " + json.dumps(c.get("properties", {}), sort_keys=True))
        elif t == "entity_properties":
            pred = c.get("predicate", {}) or {}
            if isinstance(pred.get("flags"), dict) and pred["flags"].get("is_on_fire"):
                sig.append("on fire")
            else:
                sig.append("entity " + short(c.get("entity", "")))
        else:
            sig.append(t)
    return " & ".join(sig), chance, bonus


def _fn_info(funcs):
    count, add, looting, fx = None, None, None, []
    for f in funcs or []:
        if not isinstance(f, dict):
            continue
        t = short(f.get("function", f.get("type", "")))
        if t == "set_count":
            r = _num_range(f.get("count"))
            if f.get("add"):
                add = r
            else:
                count = r
        elif t in ("looting_enchant", "enchanted_count_increase"):
            looting = _num_range(f.get("count"))
        elif t in ("set_nbt", "set_components", "set_custom_data", "set_name", "set_lore", "copy_components", "set_contents",
                   "copy_nbt", "copy_name", "copy_state", "explosion_decay", "set_custom_model_data", "toggle_tooltips",
                   "set_item"):
            continue
        else:
            fx.append(t)
    if count is None:
        count = (1, 1)
    if add and count:
        count = (count[0] + add[0], count[1] + add[1])
    return count, looting, fx


def summarize_loot(table, preds=None):
    table = canon_loot(table, preds)
    out = {}
    for pi, pool in enumerate(table.get("pools", []) or []):
        rolls = _num_range(pool.get("rolls", 1)) or (1, 1)
        psig, pchance, pbonus = _cond_sig(pool.get("conditions"))
        entries = []

        def walk(es, csig, chance, bonus):
            for e in es or []:
                t = short(e.get("type", ""))
                sig, ch, bo = _cond_sig(e.get("conditions"))
                s = " & ".join(x for x in (csig, sig) if x)
                if t in ("alternatives", "group", "sequence"):
                    walk(e.get("children"), s, chance * ch, bo or bonus)
                    continue
                if t == "item":
                    key = e.get("name")
                elif t == "tag":
                    key = "#" + str(e.get("name") or e.get("tag") or e.get("items") or "").lstrip("#")
                elif t == "loot_table":
                    v = e.get("value", e.get("name"))
                    key = "table " + (v if isinstance(v, str) else "inline")
                elif t == "empty":
                    key = None
                elif t == "dynamic":
                    key = "dynamic " + str(e.get("name"))
                else:
                    key = t
                count, looting, fx = _fn_info(e.get("functions"))
                entries.append({"key": key, "sig": s, "weight": e.get("weight", 1), "quality": e.get("quality", 0),
                                "chance": chance * ch, "bonus": bo or bonus, "count": count, "looting": looting,
                                "fx": fx})

        walk(pool.get("entries"), psig, pchance, pbonus)
        total = sum(x["weight"] for x in entries) or 1
        pool_fx = _fn_info(pool.get("functions"))[2]
        for x in entries:
            if x["key"] is None:
                continue
            base = x["key"] + ("|" + x["sig"] if x["sig"] else "")
            k = f"{pi}@{base}"
            n = 2
            while k in out:
                k = f"{pi}@{base}#{n}"
                n += 1
            x["base"] = base
            x["rolls"] = rolls
            x["total"] = total
            x["pool_fx"] = pool_fx
            x["single"] = len([y for y in entries if y["key"] is not None]) == 1 and total == x["weight"]
            out[k] = x
    return out


def canon(o):
    """Canonical JSON for loot/recipes so pure reformatting is not a change."""
    if isinstance(o, dict):
        d = {}
        for k, v in o.items():
            if k in ("random_sequence", "__comment", "group", "category", "show_notification"):
                continue
            d[k] = canon(v)
        return d
    if isinstance(o, list):
        return [canon(v) for v in o]
    if isinstance(o, float) and o.is_integer():
        return int(o)
    return o


def _match_pools(sa, sb):
    """Pair summary keys: same pool first, then the same item+condition in another pool when that is unique."""
    pairs = [(k, k) for k in sa if k in sb]
    ra = [k for k in sa if k not in sb]
    rb = [k for k in sb if k not in sa]
    for k in list(ra):
        cand = [j for j in rb if sb[j]["base"] == sa[k]["base"]]
        same_a = [i for i in ra if sa[i]["base"] == sa[k]["base"]]
        if len(cand) == 1 and len(same_a) == 1:
            pairs.append((k, cand[0]))
            ra.remove(k)
            rb.remove(cand[0])
    return pairs, ra, rb


def describe_loot_change(a, b, names, pa=None, pb=None):
    sa, sb = summarize_loot(a, pa), summarize_loot(b, pb)
    msgs = []
    pairs, only_a, only_b = _match_pools(sa, sb)
    ka = {k: sa[k]["base"] for k in sa}
    kb = {k: sb[k]["base"] for k in sb}

    def iname(k):
        k = ka.get(k) or kb.get(k) or k
        key = k.split("|")[0].split("#")[0] if not k.startswith("#") else "#" + k[1:].split("|")[0]
        n = names(key) if not key.startswith("table ") else loot_name(key[6:], names)
        cond = k.split("|", 1)[1] if "|" in k else ""
        cond = cond.split("#")[0]
        return n + (f" ({cond})" if cond else "")

    def desc(x):
        bits = [f"{rng(x['count'])}"]
        if not x["single"]:
            bits.append(f"weight {x['weight']}/{x['total']}")
        if x["chance"] < 1:
            bits.append(pct(x["chance"]))
        return ", ".join(bits)

    tb = [k for k in only_b if sb[k]["key"].startswith("table ")]
    ta = [k for k in only_a if sa[k]["key"].startswith("table ")]
    for k in only_b:
        if k not in tb:
            msgs.append(f"now includes {iname(k)} ({desc(sb[k])})")
    for k in only_a:
        if k not in ta:
            msgs.append(f"no longer includes {iname(k)} (was {desc(sa[k])})")
    if tb:
        msgs.append("now also rolls " + ", ".join(loot_name(sb[k]["key"][6:], names) for k in tb[:6])
                    + (f" and {len(tb) - 6} more tables" if len(tb) > 6 else ""))
    if ta:
        msgs.append("no longer rolls " + ", ".join(loot_name(sa[k]["key"][6:], names) for k in ta[:6])
                    + (f" and {len(ta) - 6} more tables" if len(ta) > 6 else ""))
    rolls_msgs = set()
    for k, k2 in pairs:
        x, y = sa[k], sb[k2]
        parts = []
        if x["count"] != y["count"]:
            parts.append(f"count {rng(x['count'])} → {rng(y['count'])}")
        if (x["weight"], x["total"]) != (y["weight"], y["total"]) and not (x["single"] and y["single"]):
            if x["weight"] != y["weight"]:
                parts.append(f"weight {x['weight']} → {y['weight']} (chance per roll {pct(x['weight'] / x['total'])} → {pct(y['weight'] / y['total'])})")
            else:
                parts.append(f"chance per roll {pct(x['weight'] / x['total'])} → {pct(y['weight'] / y['total'])} (pool total weight {x['total']} → {y['total']})")
        if not same(x["chance"], y["chance"]):
            parts.append(f"chance {pct(x['chance'])} → {pct(y['chance'])}")
        if x["bonus"] != y["bonus"] and x["bonus"] is not None and y["bonus"] is not None and not same(x["bonus"], y["bonus"]):
            parts.append(f"Looting chance bonus {fmt(x['bonus'])} → {fmt(y['bonus'])} per level")
        if x["looting"] != y["looting"]:
            parts.append(f"Looting bonus {('+' + rng(x['looting'])) if x['looting'] else 'none'} → "
                         f"{('+' + rng(y['looting'])) if y['looting'] else 'none'} per level")
        fa, fb = Counter(x["fx"]), Counter(y["fx"])
        if fa != fb:
            add = list((fb - fa).elements())
            rem = list((fa - fb).elements())
            fx = []
            if add:
                fx.append("now " + ", ".join(f.replace("_", " ") for f in add))
            if rem:
                fx.append("no longer " + ", ".join(f.replace("_", " ") for f in rem))
            parts.append("; ".join(fx))
        if x["rolls"] != y["rolls"]:
            if k != k2:  # the item moved to another pool
                parts.append(f"moved to a pool rolled {rng(y['rolls'])} (was {rng(x['rolls'])})")
            else:
                rolls_msgs.add(f"rolls {rng(x['rolls'])} → {rng(y['rolls'])}")
        if parts:
            msgs.append(f"{iname(k)}: " + ", ".join(parts))
    msgs = sorted(rolls_msgs) + msgs
    return msgs


def diff_loot(old, new, names, pa=None, pb=None):
    out = []
    for t in sorted(set(old) | set(new)):
        n = loot_name(t, names)
        if t not in old:
            items = [x["key"] for x in summarize_loot(new[t], pb).values() if not x["key"].startswith("table ")]
            out.append({"table": t, "name": n, "what": "new loot table" + (": " + ", ".join(
                sorted({names(k) for k in items})[:15]) if items else "")})
            continue
        if t not in new:
            out.append({"table": t, "name": n, "what": "loot table removed"})
            continue
        if canon(canon_loot(old[t], pa)) == canon(canon_loot(new[t], pb)):
            continue
        msgs = describe_loot_change(old[t], new[t], names, pa, pb)
        if not msgs:
            continue  # only formatting / non-gameplay changes
        out.append({"table": t, "name": n, "what": "; ".join(msgs)})
    return out


# ----------------------------------------------------------------------------- trades

def trade_desc(r, names):
    def side(s):
        if not s:
            return None
        cnt = s[1]
        return f"{cnt if cnt is not None else '?'} {names(s[0])}"
    left = side(r.get("buy"))
    if r.get("buyB"):
        left += " + " + side(r["buyB"])
    return f"{left} → {side(r.get('sell'))}"


def trade_key(r):
    def i(s):
        return s[0] if s else None
    wants = tuple(sorted(x for x in (i(r.get("buy")), i(r.get("buyB"))) if x))
    return (wants, i(r.get("sell")), tuple(sorted(r.get("villager_types") or ())))


def _note_tail(n):
    n = n or ""
    return n.split(": ", 1)[1] if ": " in n else n


def _costs(r):
    c = {}
    for s in (r.get("buy"), r.get("buyB")):
        if s:
            c[s[0]] = s[1]
    return c


def diff_trades(old, new, names, same_source):
    out = []
    pnames = lambda p: titleize(p)  # noqa: E731
    for prof in sorted(set(old) | set(new)):
        if prof not in old:
            out.append({"profession": prof, "level": None, "what": f"{pnames(prof)}: new trade table"})
            continue
        if prof not in new:
            out.append({"profession": prof, "level": None, "what": f"{pnames(prof)}: trade table removed"})
            continue
        lo, ln = old[prof], new[prof]
        for lvl in sorted(set(lo) | set(ln), key=lambda x: (not str(x).isdigit(), int(x) if str(x).isdigit() else 0, str(x))):
            a, b = lo.get(lvl, []), ln.get(lvl, [])
            ka = {}
            for r in a:
                ka.setdefault(trade_key(r), []).append(r)
            kb = {}
            for r in b:
                kb.setdefault(trade_key(r), []).append(r)
            lvl_out = int(lvl) if str(lvl).isdigit() else lvl
            where = f"{pnames(prof)} " + (f"level {lvl}" if str(lvl).isdigit() else str(lvl))
            fresh = [r for k in kb if k not in ka for r in kb[k]]
            gone = [r for k in ka if k not in kb for r in ka[k]]
            # same trade, new item (26.3 explorer maps became their own items)
            for r in list(fresh):
                for o in gone:
                    if ((trade_key(o)[0], trade_key(o)[2], _note_tail(o.get("note")), _costs(o))
                            == (trade_key(r)[0], trade_key(r)[2], _note_tail(r.get("note")), _costs(r))):
                        out.append({"profession": prof, "level": lvl_out,
                                    "what": f"{where}: {trade_desc(o, names)} now gives {names(r['sell'][0])} instead"})
                        fresh.remove(r)
                        gone.remove(o)
                        break
            for r in fresh:
                out.append({"profession": prof, "level": lvl_out,
                            "what": f"{where}: new trade {trade_desc(r, names)}"
                                    + (f" ({r['note']})" if r.get("note") else "")})
            for r in gone:
                out.append({"profession": prof, "level": lvl_out, "what": f"{where}: trade removed: {trade_desc(r, names)}"})
            for k in ka:
                if k not in kb:
                    continue
                for x, y in zip(ka[k], kb[k]):
                    parts = []
                    cx, cy = _costs(x), _costs(y)
                    for item in sorted(set(cx) & set(cy)):
                        if cx[item] != cy[item]:
                            parts.append(f"{names(item)} cost {fmt(cx[item])} → {fmt(cy[item])}")
                    if x.get("sell") and y.get("sell") and x["sell"][1] != y["sell"][1]:
                        parts.append(f"gives {fmt(x['sell'][1])} → {fmt(y['sell'][1])}")
                    if x.get("buy_range") != y.get("buy_range") and x.get("buy_range") and y.get("buy_range"):
                        parts.append(f"price range {rng(x['buy_range'])} → {rng(y['buy_range'])}")
                    for f, label in (("max_uses", "max uses"), ("xp", "villager XP"), ("price_mult", "price multiplier")):
                        if not same(x.get(f), y.get(f)):
                            parts.append(f"{label} {fmt(x.get(f))} → {fmt(y.get(f))}")
                    if same_source and x.get("note") != y.get("note"):
                        parts.append(f"rule changed: {y.get('note') or 'none'}")
                    if parts:
                        out.append({"profession": prof, "level": lvl_out,
                                    "what": f"{where}: {trade_desc(y, names)}: " + "; ".join(parts)})
    return out


# ----------------------------------------------------------------------------- recipes

COOK_DEFAULT = {"minecraft:smelting": 200, "minecraft:blasting": 100, "minecraft:smoking": 100,
                "minecraft:campfire_cooking": 100}


class RecipeCtx:
    """Per-version facts a recipe needs to be compared fairly: item tags and the 26.3 cooking speed."""

    def __init__(self, tags=None, speed=None):
        self.tags = (tags or {}).get("item", {})
        self.speed = speed or {}
        self.shared = set()  # tags both versions know: compared by name, so a tag that grows is not a recipe change

    def expand(self, ref):
        if ref[1:] in self.shared:
            return None
        return self.tags.get(ref[1:])


def norm_ing(x, ctx=None):
    """An ingredient -> sorted tuple of item ids (tags expanded when the tag is known)."""
    if x is None:
        return ()
    if isinstance(x, list):
        out = set()
        for y in x:
            out.update(norm_ing(y, ctx))
        return tuple(sorted(out))
    if isinstance(x, str):
        if x.startswith("#") and ctx is not None:
            got = ctx.expand(x)
            if got is not None:
                return tuple(sorted(set(got)))
        return (x,)
    if isinstance(x, dict):
        if "item" in x:
            return (x["item"],)
        if "tag" in x:
            return norm_ing("#" + x["tag"], ctx)
        if "items" in x:
            return norm_ing(x["items"], ctx)
    return (json.dumps(x, sort_keys=True),)


def norm_result(r):
    if r is None:
        return None
    if isinstance(r, str):
        return {"id": r, "count": 1}
    d = {"id": r.get("id") or r.get("item"), "count": r.get("count", 1)}
    if r.get("components"):
        comps = dict(r["components"])
        stew = comps.get("minecraft:suspicious_stew_effects")
        if isinstance(stew, list):  # duration defaults to 160 ticks when left out
            comps["minecraft:suspicious_stew_effects"] = [dict({"duration": 160}, **e) if isinstance(e, dict) else e
                                                          for e in stew]
        d["components"] = comps
    return d


ING_KEYS = ("ingredient", "base", "addition", "template", "input", "material", "map", "source")


def _is_ing(v):
    return isinstance(v, (str, list)) or (isinstance(v, dict) and bool({"item", "tag", "items"} & set(v)))


def norm_recipe(r, ctx=None):
    t = r.get("type", "")
    n = {"type": t}
    if isinstance(r.get("pattern"), list):
        pat = r["pattern"]
        key = {k: norm_ing(v, ctx) for k, v in r.get("key", {}).items()}
        n["grid"] = [[key.get(ch, ()) if ch != " " else () for ch in row] for row in pat]
    if "ingredients" in r:
        n["ingredients"] = sorted(norm_ing(x, ctx) for x in r["ingredients"])
    for k in ING_KEYS:
        if k in r and _is_ing(r[k]):
            n[k] = norm_ing(r[k], ctx)
    if "result" in r:
        n["result"] = norm_result(r["result"])
        if "count" in r and isinstance(n["result"], dict):  # stonecutting before 1.20.5
            n["result"]["count"] = r["count"]
        if isinstance(n["result"], dict) and not n["result"].get("id"):
            # 26.3 transmute/map recipes: no id means "the same item as the input"
            src = n.get("input") or n.get("map") or ()
            n["result"]["id"] = src[0] if len(src) == 1 else "=input"
    if "experience" in r:
        n["experience"] = r["experience"]
    if t in COOK_DEFAULT:
        ticks = r.get("cookingtime", COOK_DEFAULT[t])
        speed = (ctx.speed.get(t) if ctx else None) or 1
        n["cookingtime"] = ticks / speed  # real ticks in the matching furnace
    if isinstance(r.get("pattern"), str):  # smithing_trim pattern id (1.21.5+)
        n["trim_pattern"] = r["pattern"]
    return n


def _ckey(n):
    return json.dumps(n, sort_keys=True, default=list)


def _short_json(v, limit=140):
    t = json.dumps(v, sort_keys=True, ensure_ascii=False, separators=(",", ":")).replace('"minecraft:', '"')
    return t if len(t) <= limit else t[:limit] + "…"


def describe_recipe_change(a, b, names, ca=None, cb=None):
    x, y = norm_recipe(a, ca), norm_recipe(b, cb)
    if _ckey(x) == _ckey(y):
        return None
    parts = []
    special = x["type"].startswith("minecraft:crafting_special_") or y["type"].startswith("minecraft:crafting_special_")
    if x["type"] != y["type"] and not special:
        parts.append(f"type {short(x['type'])} → {short(y['type'])}")

    def rname(i):
        return "the input item" if i == "=input" else names(i)

    rx, ry = x.get("result"), y.get("result")
    if rx and ry:
        if rx.get("id") != ry.get("id"):
            parts.append(f"result {rname(rx.get('id'))} → {rname(ry.get('id'))}")
        elif rx.get("count") != ry.get("count"):
            parts.append(f"makes {rx.get('count')} → {ry.get('count')}")
        kx, ky = rx.get("components") or {}, ry.get("components") or {}
        for k in sorted(set(kx) | set(ky)):
            if kx.get(k) != ky.get(k):
                parts.append(f"result {short(k).replace('_', ' ')} {_short_json(kx.get(k))} → {_short_json(ky.get(k))}")

    def ing_counter(n):
        c = Counter()
        for row in n.get("grid", []):
            for cell in row:
                if cell:
                    c[cell] += 1
        for i in n.get("ingredients", []):
            c[i] += 1
        for k in ING_KEYS:
            if n.get(k):
                c[n[k]] += 1
        return c

    def ing_name(t):
        return " or ".join(names(z) for z in t[:3]) + (" …" if len(t) > 3 else "")

    def list_names(ids):
        ids = list(ids)
        return ", ".join(names(z) for z in ids[:8]) + (f" and {len(ids) - 8} more" if len(ids) > 8 else "")

    cx, cy = ing_counter(x), ing_counter(y)
    if cx != cy and cx and cy:  # a special recipe that became data-driven has no ingredients on one side
        add, rem = cy - cx, cx - cy
        for ta in list(rem):
            for tb in list(add):
                if rem[ta] == add[tb] and set(ta) & set(tb):
                    plus, minus = sorted(set(tb) - set(ta)), sorted(set(ta) - set(tb))
                    bits = []
                    if plus:
                        bits.append("now also accepts " + list_names(plus))
                    if minus:
                        bits.append("no longer accepts " + list_names(minus))
                    parts.append(f"{ing_name(ta)} slot: " + "; ".join(bits))
                    del rem[ta]
                    del add[tb]
                    break
        if add:
            parts.append("now needs " + ", ".join(f"{n}× {ing_name(t)}" for t, n in add.items()))
        if rem:
            parts.append("no longer needs " + ", ".join(f"{n}× {ing_name(t)}" for t, n in rem.items()))
    elif cx == cy and x.get("grid") and y.get("grid") and x["grid"] != y["grid"]:
        parts.append("crafting pattern changed")
    if "experience" in x and "experience" in y and not same(x["experience"], y["experience"]):
        parts.append(f"XP {fmt(x['experience'])} → {fmt(y['experience'])}")
    if not same(x.get("cookingtime"), y.get("cookingtime")):
        parts.append(f"cooking time {fmt(x.get('cookingtime'))} → {fmt(y.get('cookingtime'))} ticks")
    if x.get("trim_pattern") != y.get("trim_pattern") and "trim_pattern" in x:
        parts.append("trim pattern changed")
    return "; ".join(parts) if parts else None


def diff_recipes(old, new, names, ca=None, cb=None):
    def rname(rid, r):
        res = norm_result(r.get("result")) if isinstance(r, dict) else None
        return names(res["id"]) if res and res.get("id") else titleize(rid)

    gone, fresh = sorted(set(old) - set(new)), sorted(set(new) - set(old))
    # a recipe that only got a new id (same ingredients and result) is not a change
    by_content = {}
    for i in gone:
        by_content.setdefault(_ckey(norm_recipe(old[i], ca)), []).append(i)
    renamed_new, renamed_old = set(), set()
    for i in fresh:
        lst = by_content.get(_ckey(norm_recipe(new[i], cb)))
        if lst:
            renamed_old.add(lst.pop())
            renamed_new.add(i)
    added = [{"id": i, "name": rname(i, new[i])} for i in fresh if i not in renamed_new]
    removed = [{"id": i, "name": rname(i, old[i])} for i in gone if i not in renamed_old]
    changed = []
    for i in sorted(set(old) & set(new)):
        w = describe_recipe_change(old[i], new[i], names, ca, cb)
        if w:
            changed.append({"id": i, "name": rname(i, new[i]), "what": w})
    return {"added": added, "removed": removed, "changed": changed}


# ----------------------------------------------------------------------------- top level

ITEM_FIELDS = [("stack", "stack size"), ("durability", "durability"), ("rarity", "rarity"), ("food", "food"),
               ("fuel", "furnace fuel (ticks)"), ("attack_damage", "attack damage"), ("attack_speed", "attack speed"),
               ("enchantable", "enchantability"), ("repair", "repair materials"), ("armor", "armor"),
               ("toughness", "armor toughness"), ("kb_resist", "knockback resistance"), ("fire_resistant", "fire resistant")]
BLOCK_FIELDS = [("hardness", "hardness"), ("blast", "blast resistance"), ("tool", "tool"), ("tier", "tool tier"),
                ("light", "light level"), ("flammable", "flammable"), ("drops", "loot table"),
                ("requires_tool", "needs the right tool"), ("friction", "slipperiness"), ("speed_factor", "speed factor"),
                ("jump_factor", "jump factor")]
ENCH_FIELDS = [("max_level", "max level"), ("weight", "weight"), ("anvil_cost", "anvil cost"),
               ("min_cost_levels", "min enchanting cost per level"), ("max_cost_levels", "max enchanting cost per level"),
               ("treasure", "treasure"), ("tradeable", "tradeable"), ("curse", "curse"),
               ("in_enchanting_table", "in enchanting table"), ("supported", "works on"), ("primary", "table items"),
               ("exclusive", "incompatible with")]


def diff_versions(outdir, va, vb):
    res = {"from": va, "to": vb}
    ia, ib = load(outdir, va, "items") or {}, load(outdir, vb, "items") or {}
    ba, bb = load(outdir, va, "blocks") or {}, load(outdir, vb, "blocks") or {}
    ma, mb = load(outdir, va, "mobs"), load(outdir, vb, "mobs")
    names = Names(ib, bb, mb, ia, ba, ma)
    meta_b = load(outdir, vb, "meta") or {}
    meta_a = load(outdir, va, "meta") or {}
    import_lang = {}
    for v in (vb,):
        try:
            from fetch import CACHE  # noqa: WPS433
            with open(os.path.join(CACHE, "versions", v, "en_us.json"), encoding="utf-8") as f:
                import_lang = json.load(f)
        except Exception:  # noqa: BLE001
            pass
    biome_name = lambda b: import_lang.get("biome.minecraft." + short(b), titleize(b))  # noqa: E731

    res["mobs"] = diff_mobs(ma, mb, biome_name) if ma is not None and mb is not None else None
    la, lb = load(outdir, va, "loot"), load(outdir, vb, "loot")
    res["loot"] = (diff_loot(la, lb, names, load(outdir, va, "predicates"), load(outdir, vb, "predicates"))
                   if la is not None and lb is not None else None)
    ta, tb = load(outdir, va, "trades"), load(outdir, vb, "trades")
    same_src = (meta_a.get("sources") or {}).get("trades") == (meta_b.get("sources") or {}).get("trades")
    res["trades"] = diff_trades(ta, tb, names, same_src) if ta is not None and tb is not None else None
    ra, rb = load(outdir, va, "recipes"), load(outdir, vb, "recipes")
    ca = RecipeCtx(load(outdir, va, "tags"), meta_a.get("cooking_speed"))
    cb = RecipeCtx(load(outdir, vb, "tags"), meta_b.get("cooking_speed"))
    ca.shared = cb.shared = set(ca.tags) & set(cb.tags)
    res["recipes"] = diff_recipes(ra, rb, names, ca, cb) if ra is not None and rb is not None else None
    no_air = lambda d: {k: v for k, v in d.items() if k != "minecraft:air"}  # noqa: E731
    res["items"] = field_diff(no_air(ia), no_air(ib), ITEM_FIELDS, names) if ia and ib else None
    res["blocks"] = field_diff(ba, bb, BLOCK_FIELDS, names) if ba and bb else None
    ea, eb = load(outdir, va, "enchantments"), load(outdir, vb, "enchantments")
    res["enchantments"] = field_diff(ea, eb, ENCH_FIELDS, Names(ea, eb, ia, ib)) if ea and eb else None
    pa, pb = load(outdir, va, "brewing"), load(outdir, vb, "brewing")
    if pa and pb:
        sa = {(m["input"], m["ingredient"], m["output"]) for m in pa["mixes"]}
        sb = {(m["input"], m["ingredient"], m["output"]) for m in pb["mixes"]}
        pn = Names(pa.get("potions"), pb.get("potions"), ia, ib)
        br = [{"input": m[0], "ingredient": m[1], "output": m[2], "change": "added",
               "what": f"new brew: {pn(m[0])} + {pn(m[1])} → {pn(m[2])}"} for m in sorted(sb - sa, key=str)]
        br += [{"input": m[0], "ingredient": m[1], "output": m[2], "change": "removed",
                "what": f"brew removed: {pn(m[0])} + {pn(m[1])} → {pn(m[2])}"} for m in sorted(sa - sb, key=str)]
        for pid in sorted(set(pa["potions"]) & set(pb["potions"])):
            if pa["potions"][pid]["effects"] != pb["potions"][pid]["effects"]:
                br.append({"potion": pid, "change": "effects",
                           "from": pa["potions"][pid]["effects"], "to": pb["potions"][pid]["effects"],
                           "what": f"{pn(pid)} effects {fmt_eff(pa['potions'][pid]['effects'])} → {fmt_eff(pb['potions'][pid]['effects'])}"})
        res["brewing"] = br
    else:
        res["brewing"] = None
    missing = sorted(k for k, v in res.items() if v is None)
    for k in missing:
        res[k] = [] if k != "recipes" else {"added": [], "removed": [], "changed": []}
    if missing:
        res["not_compared"] = missing
    return res


def fmt_eff(effs):
    return ", ".join(f"{short(e[0])} {e[1] / 20:g}s" + (f" {['I', 'II', 'III', 'IV', 'V'][e[2]] if e[2] < 5 else e[2] + 1}" if e[2] else "")
                     for e in effs) or "none"
