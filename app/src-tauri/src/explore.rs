//! Which chunks the player has actually been near (InhabitedTime > 0), the "seen" area around them,
//! and the structures the player has found. Everything else stays hidden (no spoilers).

use mcworld::region::Region;
use mcworld::nbt::V;
use mcworld::{Dim, World};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// How far beyond the simulated chunks the player could see (render distance minus simulation distance).
pub const SEEN_RADIUS: i32 = 3;

/// Bump when the scan format changes so old caches are rebuilt.
const SCAN_VER: u32 = 3;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct RegionScan {
    pub mtime: i64,
    /// (lx, lz, inhabited ticks, last update tick)
    pub chunks: Vec<(u8, u8, i64, i64)>,
    pub generated: u32,
    pub structures: Vec<mcworld::StructureStart>,
    /// parallel to `structures`: true when the structure sits below the ground at its start chunk
    #[serde(default)]
    pub buried: Vec<bool>,
    /// signs the player was physically somewhere: [x, y, z, kind] (0 = torch they placed,
    /// 1 = a container that was opened or placed, a vault or trial spawner that saw them)
    #[serde(default)]
    pub evidence: Vec<[i32; 4]>,
    #[serde(default)]
    pub ver: u32,
}

/// Structures that are underground: these only count as found with evidence the player was inside,
/// otherwise walking over one would reveal it (no x-ray, no spoilers).
fn underground_kind(id: &str) -> bool {
    matches!(
        id.trim_start_matches("minecraft:"),
        "ancient_city" | "trial_chambers" | "stronghold" | "mineshaft" | "mineshaft_mesa" | "buried_treasure" | "trail_ruins"
    )
}

fn non_empty_list_anywhere(v: &mcworld::nbt::Value, keys: &[&str], depth: u32) -> bool {
    use mcworld::nbt::Value;
    if depth > 4 {
        return false;
    }
    match v {
        Value::Compound(m) => m.iter().any(|(k, x)| {
            let listed = match x {
                Value::List(l) => !l.is_empty(),
                Value::IntArray(a) => !a.is_empty(),
                _ => false,
            };
            (keys.contains(&k.as_str()) && listed) || non_empty_list_anywhere(x, keys, depth + 1)
        }),
        _ => false,
    }
}

fn chunk_evidence(c: &mcworld::chunk::Chunk, out: &mut Vec<[i32; 4]>) {
    for (i, sec) in c.sections.iter().enumerate() {
        let Some(sec) = sec else { continue };
        let idx: Vec<u16> = sec.palette.iter().enumerate().filter(|(_, b)| matches!(b.short(), "torch" | "wall_torch")).map(|(i, _)| i as u16).collect();
        if idx.is_empty() {
            continue;
        }
        let sy = c.min_section + i as i32;
        let mut n = 0;
        for (j, &d) in sec.data.iter().enumerate() {
            if idx.contains(&d) {
                let (x, z, y) = (j as i32 & 15, (j as i32 >> 4) & 15, j as i32 >> 8);
                out.push([c.x * 16 + x, sy * 16 + y, c.z * 16 + z, 0]);
                n += 1;
                if n >= 6 {
                    break;
                }
            }
        }
    }
    for be in &c.block_entities {
        let id = be.get_str("id").unwrap_or("");
        let short = id.trim_start_matches("minecraft:");
        let pos = [be.get_i64("x").unwrap_or(0) as i32, be.get_i64("y").unwrap_or(0) as i32, be.get_i64("z").unwrap_or(0) as i32];
        let hit = match short {
            // structure chests are generated with a loot table that disappears once opened (barrels are
            // not evidence: trial chambers come with filled barrels of their own)
            "chest" | "trapped_chest" => be.get("LootTable").is_none(),
            "vault" => non_empty_list_anywhere(be, &["rewarded_players"], 0),
            "trial_spawner" => non_empty_list_anywhere(be, &["registered_players"], 0),
            _ => false,
        };
        if hit {
            out.push([pos[0], pos[1], pos[2], 1]);
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Explored {
    pub visited: HashMap<(i32, i32), i64>,
    pub seen: HashSet<(i32, i32)>,
    pub generated: usize,
    pub structures: Vec<mcworld::StructureStart>,
    pub regions: Vec<(i32, i32)>,
    pub region_mtimes: HashMap<(i32, i32), i64>,
}

fn find_tag_i64(b: &[u8], name: &[u8]) -> Option<i64> {
    // TAG_Long (4), u16 name length, name, i64 BE
    let mut pat = vec![4u8, 0, name.len() as u8];
    pat.extend_from_slice(name);
    let pos = b.windows(pat.len()).position(|w| w == pat.as_slice())?;
    let s = pos + pat.len();
    let v = b.get(s..s + 8)?;
    Some(i64::from_be_bytes(v.try_into().ok()?))
}

fn has_structure_starts(b: &[u8]) -> bool {
    let pat = b"\x0a\x00\x06starts";
    match b.windows(pat.len()).position(|w| w == pat) {
        Some(p) => b.get(p + pat.len()).map(|&x| x != 0).unwrap_or(false),
        None => false,
    }
}

pub fn scan_region(path: &Path, rx: i32, rz: i32) -> RegionScan {
    let mtime = mcworld::world::mtime_ms(path);
    let Ok(reg) = Region::open(path) else { return RegionScan { mtime, ver: SCAN_VER, ..Default::default() } };
    let present: Vec<(usize, usize)> = reg.present().collect();
    type Row = (u8, u8, i64, i64, Vec<mcworld::StructureStart>, Vec<bool>, Vec<[i32; 4]>);
    let results: Vec<Row> = present
        .par_iter()
        .filter_map(|&(lx, lz)| {
            let bytes = reg.chunk_bytes(lx, lz).ok()??;
            let inh = find_tag_i64(&bytes, b"InhabitedTime").unwrap_or(0);
            let lu = find_tag_i64(&bytes, b"LastUpdate").unwrap_or(0);
            let starts = has_structure_starts(&bytes);
            let has = |n: &[u8]| bytes.windows(n.len()).any(|w| w == n);
            let want_evidence = inh > 0 && (has(b"torch") || has(b"_players") || has(b"minecraft:chest") || has(b"minecraft:barrel") || has(b"trapped_chest"));
            let mut st = Vec::new();
            let mut buried = Vec::new();
            let mut ev = Vec::new();
            if starts || want_evidence {
                if let Ok(v) = mcworld::nbt::parse(&bytes) {
                    if let Ok(c) = mcworld::chunk::decode(&v, false) {
                        if want_evidence {
                            chunk_evidence(&c, &mut ev);
                        }
                        for s in &c.structures {
                            // ground height at the middle of the start chunk
                            let ground = c.surface.as_ref().and_then(|h| h.get(8 * 16 + 8).copied()).filter(|&g| g > i32::MIN).unwrap_or(62);
                            buried.push(s.bbox[4] < ground - 4);
                        }
                        st = c.structures;
                    }
                }
            }
            let _ = (rx, rz);
            Some((lx as u8, lz as u8, inh, lu, st, buried, ev))
        })
        .collect();
    let mut out = RegionScan { mtime, generated: results.len() as u32, ver: SCAN_VER, ..Default::default() };
    for (lx, lz, inh, lu, st, buried, ev) in results {
        if inh > 0 {
            out.chunks.push((lx, lz, inh, lu));
        }
        out.structures.extend(st);
        out.buried.extend(buried);
        out.evidence.extend(ev);
    }
    out
}

/// Scan (or load from cache) all regions of a dimension.
pub fn explore(world: &World, dim: Dim, cache_dir: &Path) -> Explored {
    let cache_path = cache_dir.join(format!("explore-{}.json", dim.id().replace(':', "_")));
    let mut cache: HashMap<String, RegionScan> = std::fs::read(&cache_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let regions = world.regions(dim);
    let todo: Vec<&(i32, i32, std::path::PathBuf)> = regions
        .iter()
        .filter(|(rx, rz, p)| cache.get(&format!("{rx},{rz}")).map(|c| c.ver != SCAN_VER || c.mtime != mcworld::world::mtime_ms(p)).unwrap_or(true))
        .collect();
    let fresh: Vec<(String, RegionScan)> = todo.iter().map(|(rx, rz, p)| (format!("{rx},{rz}"), scan_region(p, *rx, *rz))).collect();
    let changed = !fresh.is_empty();
    for (k, v) in fresh {
        cache.insert(k, v);
    }
    let keep: HashSet<String> = regions.iter().map(|(x, z, _)| format!("{x},{z}")).collect();
    cache.retain(|k, _| keep.contains(k));
    if changed {
        if let Ok(b) = serde_json::to_vec(&cache) {
            let _ = std::fs::write(&cache_path, b);
        }
    }
    let mut e = Explored::default();
    for (k, scan) in &cache {
        let mut it = k.split(',');
        let rx: i32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let rz: i32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        e.regions.push((rx, rz));
        e.region_mtimes.insert((rx, rz), scan.mtime);
        e.generated += scan.generated as usize;
        for &(lx, lz, inh, _) in &scan.chunks {
            e.visited.insert((rx * 32 + lx as i32, rz * 32 + lz as i32), inh);
        }
    }
    for &(cx, cz) in e.visited.keys() {
        for dz in -SEEN_RADIUS..=SEEN_RADIUS {
            for dx in -SEEN_RADIUS..=SEEN_RADIUS {
                if dx * dx + dz * dz <= SEEN_RADIUS * SEEN_RADIUS + 1 {
                    e.seen.insert((cx + dx, cz + dz));
                }
            }
        }
    }
    // Structures count as found if a chunk they cover was visited. Underground ones (and buried
    // ruined portals) also need evidence the player was actually inside: a chest they opened, a vault
    // that rewarded them, a trial spawner that registered them, or (for mineshafts, which have no
    // torches of their own) torches they placed. Strongholds also count with the "Eye Spy" advancement.
    let eye_spy = world
        .players()
        .first()
        .and_then(|(u, _)| world.advancements_json(u))
        .and_then(|a| a.get("minecraft:story/follow_ender_eye").and_then(|x| x.get("done")).and_then(|d| d.as_bool()))
        .unwrap_or(false);
    let mut ev_by_chunk: HashMap<(i32, i32), Vec<[i32; 4]>> = HashMap::new();
    for scan in cache.values() {
        for ev in &scan.evidence {
            ev_by_chunk.entry((ev[0] >> 4, ev[2] >> 4)).or_default().push(*ev);
        }
    }
    for scan in cache.values() {
        for (i, s) in scan.structures.iter().enumerate() {
            let (x0, z0, x1, z1) = (s.bbox[0] >> 4, s.bbox[2] >> 4, s.bbox[3] >> 4, s.bbox[5] >> 4);
            let mut visited = false;
            'o: for cz in z0..=z1 {
                for cx in x0..=x1 {
                    if e.visited.contains_key(&(cx, cz)) {
                        visited = true;
                        break 'o;
                    }
                }
            }
            if !visited {
                continue;
            }
            let short = s.id.trim_start_matches("minecraft:");
            let buried = scan.buried.get(i).copied().unwrap_or(false);
            let needs_proof = underground_kind(&s.id) || (short == "ruined_portal" && buried);
            let found = if !needs_proof {
                true
            } else if short == "stronghold" && eye_spy {
                true
            } else {
                let b = s.bbox;
                let inside = |ev: &[i32; 4]| ev[0] >= b[0] - 1 && ev[0] <= b[3] + 1 && ev[1] >= b[1] - 1 && ev[1] <= b[4] + 1 && ev[2] >= b[2] - 1 && ev[2] <= b[5] + 1;
                let mut hit = false;
                'p: for cz in z0..=z1 {
                    for cx in x0..=x1 {
                        if let Some(list) = ev_by_chunk.get(&(cx, cz)) {
                            // torches only prove a visit where the structure never has torches of its own
                            let torch_ok = matches!(short, "mineshaft" | "mineshaft_mesa" | "buried_treasure");
                            if list.iter().any(|ev| inside(ev) && (ev[3] != 0 || torch_ok)) {
                                hit = true;
                                break 'p;
                            }
                        }
                    }
                }
                hit
            };
            if found {
                e.structures.push(s.clone());
            }
        }
    }
    e.regions.sort();
    e
}
