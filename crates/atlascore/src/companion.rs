//! Files shared with the Atlas Companion, the small in-game mod for LongTerm. Both sides only use the
//! world's Atlas folder (never the save itself):
//!
//! - the mod writes `companion-sightings.json` (mobs, rare variants and biomes it saw on screen) and
//!   `companion-popped.json` (cards it already showed), both whenever the game pauses;
//! - Atlas writes `companion.json`: every card with its name, rarity and whether it's unlocked yet.
//!
//! Stats and advancements need nothing extra: singleplayer saves them whenever the game pauses
//! (alt-tabbing included), and Atlas reads them from the save as always.

use serde_json::Value;
use std::path::Path;

pub const SIGHTINGS: &str = "companion-sightings.json";
pub const POPPED: &str = "companion-popped.json";
pub const CATALOG: &str = "companion.json";

fn mtime_ms(p: &Path) -> Option<i64> {
    let m = std::fs::metadata(p).ok()?.modified().ok()?;
    Some(m.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
}

/// Write the card list for the mod (atomically, so it never reads half a file).
pub fn write_catalog(atlas_dir: &Path, v: &Value) {
    let p = atlas_dir.join(CATALOG);
    let tmp = p.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_vec(v).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(tmp, p);
    }
}

/// When the mod last wrote anything for this world (unix ms), so Atlas can refresh when you alt-tab to it.
pub fn stamp(atlas_dir: &Path) -> i64 {
    [SIGHTINGS, POPPED].iter().filter_map(|n| mtime_ms(&atlas_dir.join(n))).max().unwrap_or(0)
}
