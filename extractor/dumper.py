"""Compile and run the Java dumper (java/*.java) against one server version."""
import glob
import hashlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
BUILD = os.path.join(CACHE, "build")
JDKS = os.path.join(os.path.expanduser("~"), ".gradle", "jdks")


def _find_java_home(major):
    """A JDK under ~/.gradle/jdks (or JAVA_HOME / PATH) whose major version is >= major."""
    cands = []
    for d in glob.glob(os.path.join(JDKS, "*")):
        if not os.path.isdir(d):
            continue
        for home in [d] + glob.glob(os.path.join(d, "*")):
            if os.path.exists(os.path.join(home, "bin", "java.exe")) or os.path.exists(os.path.join(home, "bin", "java")):
                rel = os.path.join(home, "release")
                ver = None
                if os.path.exists(rel):
                    for line in open(rel, encoding="utf-8", errors="replace"):
                        if line.startswith("JAVA_VERSION="):
                            v = line.split("=", 1)[1].strip().strip('"')
                            ver = int(v.split(".")[0])
                if ver:
                    cands.append((ver, home))
    if os.environ.get("JAVA_HOME"):
        cands.append((99, os.environ["JAVA_HOME"]))
    ok = sorted([c for c in cands if c[0] >= major])
    if not ok:
        raise SystemExit(f"no JDK >= {major} found under {JDKS}; set JAVA_HOME")
    # prefer the exact major (old servers are happiest on the Java they shipped with)
    exact = [c for c in ok if c[0] == major]
    return (exact or ok)[0][1]


def _bin(home, tool):
    p = os.path.join(home, "bin", tool + (".exe" if os.name == "nt" else ""))
    return p


def source_hash():
    h = hashlib.sha1()
    for f in sorted(glob.glob(os.path.join(HERE, "java", "*.java"))):
        h.update(open(f, "rb").read())
    return h.hexdigest()[:12]


def compile_dumper():
    stamp = os.path.join(BUILD, ".hash")
    hsh = source_hash()
    if os.path.exists(stamp) and open(stamp).read() == hsh:
        return hsh
    javac = _bin(_find_java_home(17), "javac")
    os.makedirs(BUILD, exist_ok=True)
    for f in glob.glob(os.path.join(BUILD, "**", "*.class"), recursive=True):
        os.remove(f)
    srcs = glob.glob(os.path.join(HERE, "java", "*.java"))
    subprocess.check_call([javac, "--release", "17", "-encoding", "UTF-8", "-d", BUILD] + srcs)
    open(stamp, "w").write(hsh)
    return hsh


def run(vid, java_major, inner_jar, libs, mappings, tags_tsv, out_json, log_path):
    hsh = compile_dumper()
    home = _find_java_home(java_major)
    java = _bin(home, "java")
    workdir = os.path.join(CACHE, "versions", vid, "run")  # the server may write logs here
    os.makedirs(workdir, exist_ok=True)
    ab = os.path.abspath
    inner_jar, libs, out_json = ab(inner_jar), [ab(x) for x in libs], ab(out_json)
    mappings = ab(mappings) if mappings else None
    tags_tsv = ab(tags_tsv) if tags_tsv else None
    cp = os.pathsep.join([BUILD, inner_jar] + libs)
    cmd = [java, "-Xmx3g", "-Djava.awt.headless=true", "-cp", cp, "longevity.extract.Dump",
           mappings or "-", out_json, tags_tsv or "-"]
    with open(log_path, "w", encoding="utf-8", errors="replace") as log:
        p = subprocess.run(cmd, cwd=workdir, stdout=log, stderr=subprocess.STDOUT, timeout=900)
    if p.returncode != 0 or not os.path.exists(out_json):
        tail = open(log_path, encoding="utf-8", errors="replace").read()[-3000:]
        raise RuntimeError(f"dumper failed for {vid} (exit {p.returncode}):\n{tail}")
    return hsh, home
