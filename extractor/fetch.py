"""Download Minecraft release metadata, server jars, mappings and the English lang file.

Everything comes from Mojang's public piston-meta / piston-data endpoints and is
cached under extractor/cache/. Requests carry only a generic User-Agent.
"""
import hashlib
import io
import json
import os
import sys
import time
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
UA = "longevity-extractor"
FIRST = "1.20"


def _get(url, dest, sha1=None, tries=6):
    if os.path.exists(dest) and (sha1 is None or _sha1(dest) == sha1):
        return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
            if sha1 and _sha1(tmp) != sha1:
                raise IOError("sha1 mismatch for " + url)
            os.replace(tmp, dest)
            return dest
        except Exception as e:  # noqa: BLE001
            print(f"  download failed ({e}), retry {attempt + 1}/{tries}", file=sys.stderr)
            time.sleep(5 + attempt * 5)
    raise SystemExit("could not download " + url)


def _sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def manifest(refresh=True):
    dest = os.path.join(CACHE, "version_manifest_v2.json")
    if refresh or not os.path.exists(dest):
        if os.path.exists(dest):
            os.remove(dest)
        _get(MANIFEST_URL, dest)
    with open(dest, encoding="utf-8") as f:
        return json.load(f)


def releases(man):
    """Releases from FIRST up to the latest release, oldest first."""
    rel = [v for v in man["versions"] if v["type"] == "release"]
    rel.sort(key=lambda v: v["releaseTime"])
    ids = [v["id"] for v in rel]
    start = ids.index(FIRST)
    return rel[start:]


def fetch_version(entry):
    """Download everything needed for one version. Returns a dict of local paths."""
    vid = entry["id"]
    vdir = os.path.join(CACHE, "versions", vid)
    vjson_path = _get(entry["url"], os.path.join(vdir, f"{vid}.json"), entry.get("sha1"))
    with open(vjson_path, encoding="utf-8") as f:
        vjson = json.load(f)
    dl = vjson["downloads"]
    out = {"id": vid, "dir": vdir, "json": vjson_path, "release_time": entry["releaseTime"],
           "java": vjson.get("javaVersion", {}).get("majorVersion", 17)}
    out["server"] = _get(dl["server"]["url"], os.path.join(vdir, "server.jar"), dl["server"]["sha1"])
    if "server_mappings" in dl:
        m = dl["server_mappings"]
        out["mappings"] = _get(m["url"], os.path.join(vdir, "server.txt"), m["sha1"])
    else:
        out["mappings"] = None
    lang = os.path.join(vdir, "en_us.json")
    if not os.path.exists(lang):
        # The server jar carries the same assets/minecraft/lang/en_us.json as the
        # client jar (byte-identical), so the 30-40 MB client download is skipped.
        with open(out["server"], "rb") as fh:
            outer = zipfile.ZipFile(fh)
            inner_name = [n for n in outer.namelist() if n.startswith("META-INF/versions/") and n.endswith(".jar")][0]
            inner = zipfile.ZipFile(io.BytesIO(outer.read(inner_name)))
            data = inner.read("assets/minecraft/lang/en_us.json")
        with open(lang + ".part", "wb") as f:
            f.write(data)
        os.replace(lang + ".part", lang)
    out["lang"] = lang
    return out


if __name__ == "__main__":
    man = manifest()
    for e in releases(man):
        print("fetch", e["id"])
        fetch_version(e)
