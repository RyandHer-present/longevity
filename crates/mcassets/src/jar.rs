//! Loads the files we need out of the Minecraft client jar into memory.

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

pub struct Jar {
    pub path: PathBuf,
    files: HashMap<String, Vec<u8>>,
}

const WANTED: &[&str] = &[
    "assets/minecraft/blockstates/",
    "assets/minecraft/models/",
    "assets/minecraft/textures/block/",
    "assets/minecraft/textures/item/",
    "assets/minecraft/textures/entity/",
    "assets/minecraft/textures/colormap/",
    "assets/minecraft/textures/environment/",
    "assets/minecraft/textures/misc/",
    "assets/minecraft/textures/map/",
    "assets/minecraft/items/",
    "assets/minecraft/lang/en_us.json",
    "assets/minecraft/textures/gui/",
    "assets/minecraft/textures/font/",
    "data/minecraft/advancement/",
    "data/minecraft/jukebox_song/",
    "data/minecraft/enchantment/",
    "data/minecraft/trim_pattern/",
    "data/minecraft/trim_material/",
    "data/minecraft/tags/enchantment/",
    "assets/minecraft/textures/trims/",
    "assets/minecraft/textures/palettes/",
];

impl Jar {
    pub fn open(path: &Path) -> Result<Jar> {
        let f = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
        let mut zip = zip::ZipArchive::new(f)?;
        let mut files = HashMap::new();
        for i in 0..zip.len() {
            let mut e = zip.by_index(i)?;
            let name = e.name().to_string();
            if e.is_dir() || !WANTED.iter().any(|w| name.starts_with(w)) {
                continue;
            }
            let mut buf = Vec::with_capacity(e.size() as usize);
            e.read_to_end(&mut buf)?;
            files.insert(name.trim_start_matches("assets/minecraft/").to_string(), buf);
        }
        Ok(Jar { path: path.to_path_buf(), files })
    }

    /// Path relative to `assets/minecraft/`, e.g. `textures/block/stone.png`.
    pub fn get(&self, rel: &str) -> Option<&[u8]> {
        self.files.get(rel).map(|v| v.as_slice())
    }

    pub fn json(&self, rel: &str) -> Option<serde_json::Value> {
        serde_json::from_slice(self.get(rel)?).ok()
    }

    pub fn list<'a>(&'a self, prefix: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.files.keys().filter(move |k| k.starts_with(prefix)).map(|k| k.as_str())
    }
}

/// Find the newest-matching client jar for a version on this PC (Prism, official launcher, Modrinth).
pub fn find_client_jar(version: &str) -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let ap = Path::new(&appdata);
    let candidates = [
        ap.join("PrismLauncher").join("libraries").join("com").join("mojang").join("minecraft").join(version).join(format!("minecraft-{version}-client.jar")),
        ap.join(".minecraft").join("versions").join(version).join(format!("{version}.jar")),
        ap.join("ModrinthApp").join("meta").join("versions").join(version).join(format!("{version}.jar")),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// Any client jar, preferring the given version, then the newest version folder found.
pub fn find_any_client_jar(preferred: &str) -> Option<PathBuf> {
    if let Some(p) = find_client_jar(preferred) {
        return Some(p);
    }
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let dir = Path::new(&appdata).join("PrismLauncher").join("libraries").join("com").join("mojang").join("minecraft");
    let mut versions: Vec<(String, PathBuf)> = std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let v = e.file_name().to_string_lossy().to_string();
            let jar = e.path().join(format!("minecraft-{v}-client.jar"));
            jar.is_file().then_some((v, jar))
        })
        .collect();
    versions.sort_by(|a, b| version_key(&a.0).cmp(&version_key(&b.0)));
    versions.pop().map(|v| v.1)
}

fn version_key(v: &str) -> Vec<u32> {
    v.split(|c: char| !c.is_ascii_digit()).filter_map(|p| p.parse().ok()).collect()
}
