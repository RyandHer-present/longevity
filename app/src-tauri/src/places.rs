//! Automatically found places: clusters of chunks where the player spent real time (builds, bases,
//! outposts) plus structures they have found. Names come from the player (or the Lore Book, once approved).

use crate::explore::Explored;
use atlascore::lore::Place;
use std::collections::{HashMap, HashSet, VecDeque};

fn structure_kind(id: &str) -> Option<&'static str> {
    let s = id.trim_start_matches("minecraft:");
    Some(match s {
        x if x.starts_with("village") => "village",
        "trial_chambers" => "trial chambers",
        "pillager_outpost" => "pillager outpost",
        "ruined_portal" | "ruined_portal_desert" | "ruined_portal_jungle" | "ruined_portal_swamp" | "ruined_portal_mountain" | "ruined_portal_ocean" | "ruined_portal_nether" => "ruined portal",
        "shipwreck" | "shipwreck_beached" => "shipwreck",
        "desert_pyramid" => "desert temple",
        "jungle_pyramid" => "jungle temple",
        "igloo" => "igloo",
        "swamp_hut" => "witch hut",
        "mansion" => "woodland mansion",
        "monument" => "ocean monument",
        "stronghold" => "stronghold",
        "fortress" => "nether fortress",
        "bastion_remnant" => "bastion",
        "end_city" => "end city",
        "ancient_city" => "ancient city",
        "trail_ruins" => "trail ruins",
        "ocean_ruin_cold" | "ocean_ruin_warm" => "ocean ruins",
        "mineshaft" | "mineshaft_mesa" => return None,
        "buried_treasure" => return None,
        _ => return None,
    })
}

pub fn detect(e: &Explored, dim: &str, existing: &[Place]) -> Vec<Place> {
    let mut out: Vec<Place> = Vec::new();
    // builds: chunks with lots of time spent (> 30 minutes of nearby presence)
    let heavy: HashSet<(i32, i32)> = e.visited.iter().filter(|(_, t)| **t > 20 * 60 * 30).map(|(k, _)| *k).collect();
    let mut done: HashSet<(i32, i32)> = HashSet::new();
    let mut clusters: Vec<Vec<(i32, i32)>> = Vec::new();
    for &c in &heavy {
        if done.contains(&c) {
            continue;
        }
        let mut q = VecDeque::from([c]);
        let mut cl = Vec::new();
        done.insert(c);
        while let Some(p) = q.pop_front() {
            cl.push(p);
            for dz in -2..=2 {
                for dx in -2..=2 {
                    let n = (p.0 + dx, p.1 + dz);
                    if heavy.contains(&n) && !done.contains(&n) {
                        done.insert(n);
                        q.push_back(n);
                    }
                }
            }
        }
        clusters.push(cl);
    }
    clusters.sort_by_key(|c| -(c.iter().map(|p| e.visited[p]).sum::<i64>()));
    for (i, cl) in clusters.iter().enumerate() {
        let w: i64 = cl.iter().map(|p| e.visited[p]).sum();
        // peak chunk (most time) is the heart of the place
        let peak = cl.iter().max_by_key(|p| e.visited[p]).copied().unwrap_or(cl[0]);
        let (mut x0, mut z0, mut x1, mut z1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        for p in cl {
            x0 = x0.min(p.0);
            z0 = z0.min(p.1);
            x1 = x1.max(p.0);
            z1 = z1.max(p.1);
        }
        let kind = if i == 0 { "home" } else if w > 20 * 60 * 60 * 3 { "settlement" } else { "outpost" };
        let id = format!("{}:{}:{}", dim.trim_start_matches("minecraft:"), peak.0 >> 2, peak.1 >> 2);
        out.push(Place {
            id,
            name: String::new(),
            suggested: None,
            suggested_reason: String::new(),
            kind: kind.into(),
            dim: dim.into(),
            center: [peak.0 * 16 + 8, 64, peak.1 * 16 + 8],
            chunks: [x0, z0, x1, z1],
            score: w as f64 / 1200.0,
            first_day: None,
            hidden: false,
            notes: String::new(),
        });
    }
    // found structures
    let mut seen_ids = HashSet::new();
    for s in &e.structures {
        let Some(kind) = structure_kind(&s.id) else { continue };
        let cx = (s.bbox[0] + s.bbox[3]) / 2;
        let cz = (s.bbox[2] + s.bbox[5]) / 2;
        let id = format!("{}:{}:{}:{}", dim.trim_start_matches("minecraft:"), kind.replace(' ', "_"), cx >> 6, cz >> 6);
        if !seen_ids.insert(id.clone()) {
            continue;
        }
        out.push(Place {
            id,
            name: String::new(),
            suggested: None,
            suggested_reason: String::new(),
            kind: kind.into(),
            dim: dim.into(),
            center: [cx, (s.bbox[1] + s.bbox[4]) / 2, cz],
            chunks: [s.bbox[0] >> 4, s.bbox[2] >> 4, s.bbox[3] >> 4, s.bbox[5] >> 4],
            score: 0.0,
            first_day: None,
            hidden: false,
            notes: String::new(),
        });
    }
    // keep names/flags the player set before
    let old: HashMap<&str, &Place> = existing.iter().map(|p| (p.id.as_str(), p)).collect();
    for p in out.iter_mut() {
        if let Some(o) = old.get(p.id.as_str()) {
            p.name = o.name.clone();
            p.suggested = o.suggested.clone();
            p.suggested_reason = o.suggested_reason.clone();
            p.hidden = o.hidden;
            p.notes = o.notes.clone();
            p.first_day = o.first_day;
            if o.center[1] != 64 {
                p.center[1] = o.center[1];
            }
        }
    }
    // keep places the player named that are no longer detected (e.g. other dimensions)
    for o in existing {
        if o.dim != dim && !out.iter().any(|p| p.id == o.id) {
            out.push(o.clone());
        }
    }
    out
}
