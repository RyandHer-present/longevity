//! Minecraft's own sound files, read from the launcher's asset store (Prism, the official launcher or
//! Modrinth), so the Dex can play music discs. Nothing is downloaded and nothing is copied.

use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

struct Store {
    objects: PathBuf,
    map: HashMap<String, String>,
}

fn stores() -> &'static Vec<Store> {
    static S: OnceLock<Vec<Store>> = OnceLock::new();
    S.get_or_init(|| {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        let ap = Path::new(&appdata);
        let roots = [ap.join("PrismLauncher").join("assets"), ap.join(".minecraft").join("assets"), ap.join("ModrinthApp").join("meta").join("assets")];
        let mut files: Vec<(std::time::SystemTime, PathBuf, PathBuf)> = Vec::new();
        for r in &roots {
            let Ok(rd) = std::fs::read_dir(r.join("indexes")) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().map(|x| x == "json").unwrap_or(false) {
                    let t = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                    files.push((t, p, r.join("objects")));
                }
            }
        }
        // newest index first: it has the newest discs
        files.sort_by(|a, b| b.0.cmp(&a.0));
        files
            .into_iter()
            .take(8)
            .filter_map(|(_, p, objects)| {
                let j: Value = serde_json::from_slice(&std::fs::read(p).ok()?).ok()?;
                let map: HashMap<String, String> = j
                    .get("objects")?
                    .as_object()?
                    .iter()
                    .filter(|(k, _)| k.starts_with("minecraft/sounds/records/") || k.as_str() == "minecraft/sounds.json")
                    .filter_map(|(k, v)| Some((k.clone(), v.get("hash")?.as_str()?.to_string())))
                    .collect();
                (!map.is_empty()).then_some(Store { objects, map })
            })
            .collect()
    })
}

fn read(key: &str) -> Option<Vec<u8>> {
    for s in stores() {
        if let Some(h) = s.map.get(key) {
            if h.len() > 2 {
                if let Ok(b) = std::fs::read(s.objects.join(&h[..2]).join(h)) {
                    return Some(b);
                }
            }
        }
    }
    None
}

/// The .ogg for a jukebox song's sound event (e.g. "minecraft:music_disc.pigstep").
pub fn disc(sound_event: &str) -> Option<Vec<u8>> {
    let ev = sound_event.trim_start_matches("minecraft:");
    let mut names: Vec<String> = Vec::new();
    if let Some(j) = read("minecraft/sounds.json").and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
        for x in j.get(ev).and_then(|e| e.get("sounds")).and_then(|s| s.as_array()).into_iter().flatten() {
            if let Some(n) = x.as_str().or_else(|| x.get("name").and_then(|n| n.as_str())) {
                names.push(n.trim_start_matches("minecraft:").to_string());
            }
        }
    }
    names.push(format!("records/{}", ev.trim_start_matches("music_disc.")));
    names.iter().find_map(|n| read(&format!("minecraft/sounds/{n}.ogg")))
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_disc_audio() {
        for ev in ["minecraft:music_disc.13", "minecraft:music_disc.pigstep", "minecraft:music_disc.creator_music_box"] {
            let b = super::disc(ev).unwrap_or_default();
            println!("{ev}: {} bytes", b.len());
            assert!(b.len() > 10_000 && &b[..4] == b"OggS", "{ev}");
        }
    }
}
