//! One-time move-in: brings LongTerm Atlas's per-world data (Dex, explored map, places, tiles) and
//! settings, and Mio Launcher's skins, closet and mod backups into Longevity. The old apps stay
//! installed and untouched; this only copies, never moves or deletes.

use std::path::Path;

fn copy_tree(from: &Path, to: &Path, skip: &[&str]) {
    let Ok(rd) = std::fs::read_dir(from) else { return };
    let _ = std::fs::create_dir_all(to);
    for e in rd.flatten() {
        let name = e.file_name();
        let n = name.to_string_lossy();
        if skip.iter().any(|s| n.eq_ignore_ascii_case(s)) {
            continue;
        }
        let src = e.path();
        let dst = to.join(&name);
        if src.is_dir() {
            copy_tree(&src, &dst, &[]);
        } else if !dst.exists() {
            let _ = std::fs::copy(&src, &dst);
        }
    }
}

pub fn run_once() {
    let Ok(la) = std::env::var("LOCALAPPDATA") else { return };
    let la = Path::new(&la);
    let marker = atlascore::data_dir().join("imported");
    if marker.exists() {
        return;
    }
    let atlas = la.join("LongTermAtlas");
    if atlas.is_dir() {
        // every world's Atlas data, minus what Longevity dropped (time capsules, the Lore Book)
        if let Ok(rd) = std::fs::read_dir(atlas.join("worlds")) {
            for w in rd.flatten() {
                if w.path().is_dir() {
                    copy_tree(&w.path(), &atlascore::data_dir().join("worlds").join(w.file_name()), &["capsules", "lore"]);
                }
            }
        }
        if let Some(old) = std::fs::read(atlas.join("settings.json")).ok().and_then(|b| serde_json::from_slice::<atlascore::Settings>(&b).ok()) {
            let mut s = atlascore::Settings::load();
            s.sounds = old.sounds;
            s.render_distance = old.render_distance;
            s.quality = old.quality;
            s.map_style = old.map_style;
            s.theme = old.theme;
            if s.last_world.is_none() {
                s.last_world = old.last_world;
            }
            let _ = s.save();
        }
    }
    let mio = la.join("MioLauncher");
    if mio.is_dir() {
        let dst = crate::launcher::util::data_dir();
        copy_tree(&mio.join("skins"), &dst.join("skins"), &[]);
        copy_tree(&mio.join("backups"), &dst.join("backups"), &[]);
        if let Some(old) = std::fs::read(mio.join("settings.json")).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) {
            let p = dst.join("settings.json");
            let mut cur: serde_json::Value = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| serde_json::json!({}));
            if let (Some(c), Some(fav)) = (cur.as_object_mut(), old.get("favorites")) {
                c.insert("favorites".into(), fav.clone());
                let _ = std::fs::write(&p, serde_json::to_vec_pretty(&cur).unwrap_or_default());
            }
        }
    }
    let _ = std::fs::write(marker, b"1");
}
