//! Mobs the player has actually been close to, recorded by the background recorder while they play
//! (from the entities saved around the player). Used by the Dex's Field Guide.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Sighting {
    /// First time seen (unix ms) and the in-game day then.
    pub t: i64,
    #[serde(default)]
    pub day: Option<f64>,
    /// How many recorder snapshots saw at least one.
    #[serde(default)]
    pub n: u32,
    /// Most seen near the player at once.
    #[serde(default)]
    pub most: u32,
}

pub fn path(world_dir: &Path) -> PathBuf {
    world_dir.join("sightings.json")
}

pub fn load(world_dir: &Path) -> HashMap<String, Sighting> {
    std::fs::read(path(world_dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// The recorder's sightings plus what the in-game Atlas Companion saw on screen (mobs, rare variants
/// as "variant:<k>", biomes as "biome:<id>"). Only for reading: the recorder keeps writing its own file.
pub fn load_all(world_dir: &Path) -> HashMap<String, Sighting> {
    let mut all = load(world_dir);
    let extra: HashMap<String, Sighting> = std::fs::read(world_dir.join(crate::companion::SIGHTINGS)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    for (k, s) in extra {
        match all.get_mut(&k) {
            Some(e) => {
                if s.t > 0 && s.t < e.t {
                    e.t = s.t;
                    e.day = s.day.or(e.day);
                }
                e.n += s.n;
                e.most = e.most.max(s.most);
            }
            None => {
                all.insert(k, s);
            }
        }
    }
    all
}

/// Merge one snapshot's counts (entity id -> how many near the player). Returns ids seen for the first time.
pub fn record(world_dir: &Path, counts: &HashMap<String, u32>, t: i64, day: Option<f64>) -> Vec<String> {
    if counts.is_empty() {
        return vec![];
    }
    let mut all = load(world_dir);
    let mut new = Vec::new();
    for (id, &c) in counts {
        let e = all.entry(id.clone()).or_insert_with(|| {
            new.push(id.clone());
            Sighting { t, day, n: 0, most: 0 }
        });
        e.n += 1;
        e.most = e.most.max(c);
    }
    let tmp = path(world_dir).with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_vec(&all).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(tmp, path(world_dir));
    }
    new
}

/// Entity ids that are never Dex entries (projectiles, items, vehicles, effects...).
pub fn is_creature(id: &str) -> bool {
    let s = id.trim_start_matches("minecraft:");
    !(s.is_empty()
        || s == "item"
        || s == "experience_orb"
        || s.ends_with("arrow")
        || s.ends_with("minecart")
        || s.ends_with("boat")
        || s.ends_with("raft")
        || s.contains("projectile")
        || s.ends_with("fireball")
        || s.ends_with("_charge")
        || s.ends_with("potion")
        || s.ends_with("pearl")
        || s.ends_with("_bottle")
        || s.ends_with("_display")
        || s.ends_with("_firework")
        || s == "firework_rocket"
        || matches!(
            s,
            "painting" | "item_frame" | "glow_item_frame" | "armor_stand" | "falling_block" | "tnt" | "leash_knot" | "area_effect_cloud" | "marker" | "interaction" | "eye_of_ender" | "egg" | "snowball" | "trident" | "end_crystal" | "lightning_bolt" | "evoker_fangs" | "llama_spit" | "shulker_bullet" | "fishing_bobber" | "ominous_item_spawner" | "player"
        ))
}
