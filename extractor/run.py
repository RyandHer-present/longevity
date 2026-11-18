"""Longevity game-data extractor: python extractor/run.py [--versions 1.21.11,26.3] [--offline] [--force]

Builds gamedata/<version>/ for every Minecraft release from 1.20 to the latest,
then gamedata/changes/<from>__<to>.json and gamedata/index.json.
"""
import argparse
import gzip
import json
import os
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import build  # noqa: E402
import diff  # noqa: E402
import dumper  # noqa: E402
import fetch  # noqa: E402
import unpack  # noqa: E402
from jardata import JarData  # noqa: E402

ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "gamedata")
RAW = os.path.join(HERE, "cache", "raw")
SCHEMA = 1


def dump_json(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def write(path, obj, gz=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = dump_json(obj).encode("utf-8")
    if gz:
        path += ".gz"
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            # mtime=0 keeps output byte-identical between runs
            with gzip.GzipFile(filename="", mode="wb", fileobj=f, compresslevel=9, mtime=0) as g:
                g.write(data)
    else:
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
    os.replace(tmp, path)


def code_dump(info, inner, libs, jar, force):
    vid = info["id"]
    rdir = os.path.join(RAW, vid)
    os.makedirs(rdir, exist_ok=True)
    out = os.path.join(rdir, "code.json")
    stamp = os.path.join(rdir, "code.stamp")
    want = dumper.source_hash() + "|" + vid
    if not force and os.path.exists(out) and os.path.exists(stamp) and open(stamp).read() == want:
        with open(out, encoding="utf-8") as f:
            return json.load(f)
    tags = build.Tags(jar.tags)
    tsv = os.path.join(rdir, "tags.tsv")
    with open(tsv, "w", encoding="utf-8") as f:
        f.write(tags.tsv(["item", "block", "entity_type"]))
    t0 = time.time()
    dumper.run(vid, info["java"], inner, libs, info["mappings"], tsv, out, os.path.join(rdir, "dump.log"))
    print(f"  java dump {time.time() - t0:.1f}s")
    open(stamp, "w").write(want)
    with open(out, encoding="utf-8") as f:
        return json.load(f)


def build_version(entry, force=False):
    info = fetch.fetch_version(entry)
    vid = info["id"]
    inner, libs = unpack.unpack(info["server"], os.path.join(fetch.CACHE, "versions", vid, "cp"))
    jar = JarData(inner)
    code = code_dump(info, inner, libs, jar, force)
    lang = build.Lang(info["lang"])
    vb = build.VersionBuild(vid, info["release_time"], jar, code, lang)
    vdir = os.path.join(OUT, vid)

    for e in code.get("errors", []):
        vb.notes.append("java: " + e.split("\n")[0][:300])

    files = {}

    def attempt(name, fn):
        try:
            v = fn()
            if v is None:
                if name not in vb.missing:
                    vb.missing.append(name)
                return None
            files[name] = v
            return v
        except Exception as ex:  # noqa: BLE001
            traceback.print_exc()
            vb.missing.append(name)
            vb.notes.append(f"{name} failed: {ex}")
            return None

    items = attempt("items", vb.items) if code.get("items") else vb.missing.append("items")
    blocks = attempt("blocks", vb.blocks) if code.get("blocks") else vb.missing.append("blocks")
    mobs = attempt("mobs", vb.mobs) if code.get("entities") else vb.missing.append("mobs")
    loot = attempt("loot", vb.loot)
    recipes = attempt("recipes", vb.recipes)
    ench = attempt("enchantments", vb.enchantments)
    brewing = attempt("brewing", vb.brewing)
    try:
        trades, rebalance, picks = vb.trades()
        if trades is not None:
            files["trades"] = trades
        if rebalance is not None:
            files["trades_rebalance"] = rebalance
    except Exception as ex:  # noqa: BLE001
        traceback.print_exc()
        vb.missing.append("trades")
        vb.notes.append(f"trades failed: {ex}")
        picks = None
    if loot:
        vb.loot_tag_refs(loot)
    preds = vb.predicates()
    if preds:
        files["predicates"] = preds
    files["tags"] = vb.tags_out(*(v for k, v in files.items() if k not in ("loot",)))

    for name, obj in files.items():
        write(os.path.join(vdir, name + ".json"), obj)

    meta = {
        "version": vid,
        "release_time": info["release_time"],
        "data_version": jar.version.get("world_version"),
        "java": info["java"],
        "missing": sorted(set(vb.missing)),
        "files": sorted(k + ".json.gz" for k in files),
        "counts": {k: len(v) for k, v in files.items() if isinstance(v, dict)},
        "sources": {
            "code": "server classes booted by extractor/java (" + ("Mojang server mappings" if info["mappings"] else "unobfuscated jar") + ")",
            "enchantments": "data/enchantment" if jar.cat("enchantment") else "code",
            "trades": "data/villager_trade + trade_set" if jar.cat("villager_trade") else "code (VillagerTrades)",
            "brewing": (files.get("brewing") or {}).get("source"),
        },
        "trade_picks": picks,
        "cooking_speed": vb.cooking_speed(),
        "trades_rebalance": "trades_rebalance" in files,
        "notes": vb.notes,
        "schema": SCHEMA,
    }
    if "trades_rebalance" in files:
        meta["trades_rebalance_note"] = ("trades_rebalance.json = villager trades with the experimental "
                                         "'Villager Trade Rebalance' data pack turned on (not vanilla default)")
    write(os.path.join(vdir, "meta.json"), meta, gz=False)
    return meta


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--versions", help="comma separated subset (default: all releases from 1.20)")
    ap.add_argument("--offline", action="store_true", help="use the cached version manifest")
    ap.add_argument("--force", action="store_true", help="re-run the Java dump even if cached")
    ap.add_argument("--no-diff", action="store_true")
    a = ap.parse_args()

    man = fetch.manifest(refresh=not a.offline)
    rels = fetch.releases(man)
    all_ids = [e["id"] for e in rels]
    todo = rels
    if a.versions:
        want = set(a.versions.split(","))
        todo = [e for e in rels if e["id"] in want]
    t0 = time.time()
    for e in todo:
        print(f"== {e['id']}")
        try:
            meta = build_version(e, a.force)
            print(f"  missing: {meta['missing']}  counts: {meta['counts']}")
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            print(f"  FAILED {e['id']}")
    built = [v for v in all_ids if os.path.exists(os.path.join(OUT, v, "meta.json"))]
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        f.write(dump_json({"versions": built, "latest": man["latest"]["release"] if man["latest"]["release"] in built
                           else (built[-1] if built else None), "format": "per-version files are minified JSON, gzipped (.json.gz)"}))
    if not a.no_diff:
        for i in range(1, len(built)):
            d = diff.diff_versions(OUT, built[i - 1], built[i])
            write(os.path.join(OUT, "changes", f"{built[i - 1]}__{built[i]}.json"), d, gz=False)
            print(f"  diff {built[i - 1]} -> {built[i]}: " + ", ".join(
                f"{k} {len(v) if isinstance(v, list) else sum(len(x) for x in v.values())}"
                for k, v in d.items() if k not in ("from", "to")))
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
