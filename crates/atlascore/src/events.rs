//! The world journal: one JSON object per line in <world_dir>/events.jsonl.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Event {
    /// Real time, unix ms.
    pub t: i64,
    /// In-game day (fractional) when known.
    #[serde(default)]
    pub day: Option<f64>,
    /// session_start, session_end, death, advancement, villager_death, chat, respawn_set, trip, haul, build, milestone, dimension
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub pos: Option<[f64; 3]>,
    #[serde(default)]
    pub dim: Option<String>,
    /// "log", "recorder", "advancements", "atlas"
    #[serde(default)]
    pub source: String,
}

impl Event {
    pub fn key(&self) -> String {
        format!("{}|{}|{}", self.kind, self.t / 1000, self.title)
    }
}

pub fn path(world_dir: &Path) -> std::path::PathBuf {
    world_dir.join("events.jsonl")
}

pub fn load(world_dir: &Path) -> Vec<Event> {
    let Ok(text) = std::fs::read_to_string(path(world_dir)) else { return vec![] };
    let mut out: Vec<Event> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    out.sort_by_key(|e| e.t);
    out
}

/// Append events that aren't already in the journal. Returns how many were new.
pub fn append_new(world_dir: &Path, events: &[Event]) -> anyhow::Result<usize> {
    let existing: std::collections::HashSet<String> = load(world_dir).iter().map(|e| e.key()).collect();
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path(world_dir))?;
    let mut n = 0;
    let mut seen = existing;
    for e in events {
        let k = e.key();
        if seen.contains(&k) {
            continue;
        }
        seen.insert(k);
        writeln!(f, "{}", serde_json::to_string(e)?)?;
        n += 1;
    }
    Ok(n)
}
