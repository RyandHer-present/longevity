"""Read the vanilla data pack that ships inside a server jar."""
import json
import zipfile

PLURAL = {"items": "item", "blocks": "block", "entity_types": "entity_type", "fluids": "fluid",
          "game_events": "game_event", "functions": "function"}
FOLDERS = {  # old (<=1.20.6) folder names -> current
    "loot_tables": "loot_table", "recipes": "recipe", "advancements": "advancement",
    "structures": "structure", "predicates": "predicate", "item_modifiers": "item_modifier",
}


def _loads(b):
    return json.loads(b.decode("utf-8"))


class JarData:
    def __init__(self, inner_jar):
        self.files = {}      # category -> {id: json}
        self.tags = {}       # registry -> {tag id: raw values}
        self.overlays = {}   # datapack name -> {category: {id: json}}, plus "tags"
        self.version = {}
        with zipfile.ZipFile(inner_jar) as z:
            self.version = _loads(z.read("version.json"))
            for n in z.namelist():
                if not n.endswith(".json") or not n.startswith("data/"):
                    continue
                parts = n[:-5].split("/")
                if len(parts) < 4:
                    continue
                if parts[1] == "minecraft" and parts[2] == "datapacks":
                    # data/minecraft/datapacks/<pack>/data/<ns>/<cat>/...
                    if len(parts) < 8 or parts[4] != "data":
                        continue
                    pack, ns, rest = parts[3], parts[5], parts[6:]
                    target = self.overlays.setdefault(pack, {"files": {}, "tags": {}})
                    self._add(target["files"], target["tags"], ns, rest, z.read(n))
                    continue
                ns, rest = parts[1], parts[2:]
                self._add(self.files, self.tags, ns, rest, z.read(n))

    @staticmethod
    def _add(files, tags, ns, rest, raw):
        try:
            data = _loads(raw)
        except Exception:  # noqa: BLE001
            return
        if rest[0] == "tags":
            reg = rest[1]
            # registry folder may be nested, e.g. tags/worldgen/biome/x
            i = 2
            if reg == "worldgen":
                reg = "worldgen/" + rest[2]
                i = 3
            reg = PLURAL.get(reg, reg)
            tags.setdefault(reg, {})[ns + ":" + "/".join(rest[i:])] = data
            return
        cat = rest[0]
        i = 1
        if cat == "worldgen":
            cat = "worldgen/" + rest[1]
            i = 2
        cat = FOLDERS.get(cat, cat)
        files.setdefault(cat, {})[ns + ":" + "/".join(rest[i:])] = data

    def cat(self, name):
        return self.files.get(name, {})


class Tags:
    """Fully expanded tags for one registry set."""

    def __init__(self, raw_by_registry, overlay=None):
        self.raw = {r: dict(t) for r, t in raw_by_registry.items()}
        if overlay:
            for r, t in overlay.items():
                for tid, data in t.items():
                    base = self.raw.setdefault(r, {})
                    if data.get("replace") or tid not in base:
                        base[tid] = data
                    else:
                        base[tid] = {"values": list(base[tid].get("values", [])) + list(data.get("values", []))}
        self._memo = {}

    def get(self, registry, tag_id, _stack=None):
        tag_id = tag_id.lstrip("#")
        key = (registry, tag_id)
        if key in self._memo:
            return self._memo[key]
        _stack = _stack or set()
        if key in _stack:
            return []
        _stack.add(key)
        raw = self.raw.get(registry, {}).get(tag_id)
        out = []
        if raw is not None:
            for v in raw.get("values", []):
                vid = v["id"] if isinstance(v, dict) else v
                if vid.startswith("#"):
                    sub = self.get(registry, vid[1:], _stack)
                    out.extend(x for x in sub if x not in out)
                elif vid not in out:
                    out.append(vid)
        self._memo[key] = out
        return out

    def has(self, registry, tag_id):
        return tag_id.lstrip("#") in self.raw.get(registry, {})

    def ids(self, registry):
        return list(self.raw.get(registry, {}).keys())

    def expand(self, registry, ref):
        """A tag ("#x"), an id, or a list of either -> list of ids."""
        if ref is None:
            return []
        if isinstance(ref, list):
            out = []
            for r in ref:
                for x in self.expand(registry, r):
                    if x not in out:
                        out.append(x)
            return out
        if isinstance(ref, str) and ref.startswith("#"):
            return self.get(registry, ref)
        return [ref]

    def tsv(self, registries):
        lines = []
        for r in registries:
            for tid in self.ids(r):
                lines.append(f"{r}\t{tid}\t{' '.join(self.get(r, tid))}")
        return "\n".join(lines) + "\n"
