"""Unpack a bundler server jar: the real server jar plus its bundled libraries."""
import os
import zipfile


def unpack(server_jar, dest):
    """Returns (inner_jar_path, [library jar paths]). Idempotent."""
    os.makedirs(dest, exist_ok=True)
    marker = os.path.join(dest, ".done")
    with zipfile.ZipFile(server_jar) as z:
        names = z.namelist()
        inner = [n for n in names if n.startswith("META-INF/versions/") and n.endswith(".jar")][0]
        libs = [n for n in names if n.startswith("META-INF/libraries/") and n.endswith(".jar")]
        if not os.path.exists(marker):
            for n in [inner] + libs:
                out = os.path.join(dest, os.path.basename(n))
                with open(out + ".part", "wb") as f:
                    f.write(z.read(n))
                os.replace(out + ".part", out)
            open(marker, "w").close()
    return os.path.join(dest, os.path.basename(inner)), [os.path.join(dest, os.path.basename(n)) for n in libs]
