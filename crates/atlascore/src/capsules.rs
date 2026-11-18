//! Time Capsules: a frozen copy of the area around the player's base, taken every 200 in-game days.
//! Only the chunks inside the radius are copied (block data + entities), into the Atlas's own data
//! folder. The real world is only ever read.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Days between capsules.
pub const EVERY_DAYS: i64 = 200;
/// Blocks around the base that are kept (about 1,000 blocks across).
pub const RADIUS: i32 = 512;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct CapsuleMeta {
    pub id: String,
    /// In-game day when the copy was taken.
    pub day: i64,
    /// The 200-day mark this capsule stands for (0 = the first capsule, taken when the Atlas started).
    pub mark: i64,
    /// Real time, unix ms.
    pub t: i64,
    pub center: [i32; 3],
    pub radius: i32,
    pub bytes: u64,
    pub chunks: u32,
    #[serde(default)]
    pub world_name: String,
    /// In-game time of day (ticks) at capture.
    #[serde(default)]
    pub day_time: i64,
    #[serde(default)]
    pub raining: bool,
}

pub fn dir(world_dir: &Path) -> PathBuf {
    world_dir.join("capsules")
}

pub fn list(world_dir: &Path) -> Vec<CapsuleMeta> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir(world_dir)) {
        for e in rd.flatten() {
            if let Ok(b) = std::fs::read(e.path().join("capsule.json")) {
                if let Ok(m) = serde_json::from_slice::<CapsuleMeta>(&b) {
                    out.push(m);
                }
            }
        }
    }
    out.sort_by_key(|m| (m.day, m.t));
    out
}

pub fn path_of(world_dir: &Path, id: &str) -> PathBuf {
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    dir(world_dir).join(safe)
}

/// The capsule that is due now, if any: the latest 200-day mark that has passed and isn't captured,
/// or the very first capsule when there are none at all.
pub fn due(world_dir: &Path, day: i64) -> Option<i64> {
    let have = list(world_dir);
    if have.is_empty() {
        return Some(0);
    }
    let mark = (day / EVERY_DAYS) * EVERY_DAYS;
    if mark >= EVERY_DAYS && !have.iter().any(|c| c.mark == mark) && have.iter().all(|c| c.day < mark) {
        return Some(mark);
    }
    None
}

fn chunk_in(cx: i32, cz: i32, center: [i32; 3], radius: i32) -> bool {
    let x = cx * 16 + 8 - center[0];
    let z = cz * 16 + 8 - center[2];
    (x as i64 * x as i64 + z as i64 * z as i64) <= (radius as i64 + 8) * (radius as i64 + 8)
}

/// Copy the chunks of one region file that lie inside the circle into a new region file.
/// Returns the number of chunks written.
fn copy_region(src: &Path, dst: &Path, rx: i32, rz: i32, center: [i32; 3], radius: i32) -> Result<u32> {
    let mut data = Vec::new();
    std::fs::File::open(src)?.read_to_end(&mut data)?;
    if data.len() < 8192 {
        return Ok(0);
    }
    let mut locs = vec![0u8; 4096];
    let mut times = vec![0u8; 4096];
    times.copy_from_slice(&data[4096..8192]);
    let mut body: Vec<u8> = Vec::new();
    let mut n = 0u32;
    for i in 0..1024usize {
        let (lx, lz) = ((i % 32) as i32, (i / 32) as i32);
        let b = &data[i * 4..i * 4 + 4];
        let off = ((b[0] as usize) << 16) | ((b[1] as usize) << 8) | b[2] as usize;
        let count = b[3] as usize;
        if off == 0 || count == 0 {
            continue;
        }
        if !chunk_in(rx * 32 + lx, rz * 32 + lz, center, radius) {
            continue;
        }
        let start = off * 4096;
        if start + 5 > data.len() {
            continue;
        }
        let len = u32::from_be_bytes([data[start], data[start + 1], data[start + 2], data[start + 3]]) as usize;
        if len == 0 || start + 4 + len > data.len() {
            continue;
        }
        let kind = data[start + 4];
        if kind & 0x80 != 0 {
            // oversized chunk stored next to the region file
            let name = format!("c.{}.{}.mcc", rx * 32 + lx, rz * 32 + lz);
            let _ = std::fs::copy(src.with_file_name(&name), dst.with_file_name(&name));
        }
        let chunk = &data[start..start + 4 + len];
        let sectors = chunk.len().div_ceil(4096);
        let sector = 2 + body.len() / 4096;
        body.extend_from_slice(chunk);
        body.resize((sector - 2 + sectors) * 4096, 0);
        locs[i * 4] = (sector >> 16) as u8;
        locs[i * 4 + 1] = (sector >> 8) as u8;
        locs[i * 4 + 2] = sector as u8;
        locs[i * 4 + 3] = sectors.min(255) as u8;
        n += 1;
    }
    if n == 0 {
        return Ok(0);
    }
    let tmp = dst.with_extension("mca.tmp");
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(&locs)?;
    f.write_all(&times)?;
    f.write_all(&body)?;
    drop(f);
    std::fs::rename(&tmp, dst)?;
    Ok(n)
}

fn dir_size(p: &Path) -> u64 {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let Ok(m) = e.metadata() else { continue };
            n += if m.is_dir() { dir_size(&e.path()) } else { m.len() };
        }
    }
    n
}

pub struct CaptureInput<'a> {
    /// The world folder (holds level.dat).
    pub world_root: &'a Path,
    /// The overworld folder that holds region/ and entities/ (the 26.x layout or the classic one).
    pub overworld_dir: &'a Path,
    pub center: [i32; 3],
    pub day: i64,
    pub mark: i64,
    pub world_name: String,
    pub day_time: i64,
    pub raining: bool,
}

/// Copy the base area into `<world_dir>/capsules/<id>`. The copy is a small world of its own
/// (level.dat + the same folder layout) so it can be opened with the same reader.
pub fn capture(world_dir: &Path, inp: &CaptureInput) -> Result<CapsuleMeta> {
    let id = if inp.mark == 0 { format!("first-day-{}", inp.day) } else { format!("day-{}", inp.mark) };
    let out = path_of(world_dir, &id);
    let tmp = dir(world_dir).join(format!(".{id}.partial"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;
    std::fs::copy(inp.world_root.join("level.dat"), tmp.join("level.dat")).context("copy level.dat")?;
    let rel = inp.overworld_dir.strip_prefix(inp.world_root).unwrap_or(Path::new("")).to_path_buf();
    let c = inp.center;
    let r = RADIUS;
    let (cx0, cx1) = ((c[0] - r) >> 4, (c[0] + r) >> 4);
    let (cz0, cz1) = ((c[2] - r) >> 4, (c[2] + r) >> 4);
    let mut chunks = 0u32;
    for folder in ["region", "entities"] {
        let dst_dir = tmp.join(&rel).join(folder);
        std::fs::create_dir_all(&dst_dir)?;
        for rz in (cz0 >> 5)..=(cz1 >> 5) {
            for rx in (cx0 >> 5)..=(cx1 >> 5) {
                let name = format!("r.{rx}.{rz}.mca");
                let src = inp.overworld_dir.join(folder).join(&name);
                if !src.is_file() {
                    continue;
                }
                let n = copy_region(&src, &dst_dir.join(&name), rx, rz, c, r).unwrap_or(0);
                if folder == "region" {
                    chunks += n;
                }
            }
        }
    }
    anyhow::ensure!(chunks > 0, "no chunks around the base to copy");
    let mut meta = CapsuleMeta {
        id: id.clone(),
        day: inp.day,
        mark: inp.mark,
        t: crate::now_ms(),
        center: c,
        radius: r,
        bytes: 0,
        chunks,
        world_name: inp.world_name.clone(),
        day_time: inp.day_time,
        raining: inp.raining,
    };
    meta.bytes = dir_size(&tmp);
    std::fs::write(tmp.join("capsule.json"), serde_json::to_vec_pretty(&meta)?)?;
    let _ = std::fs::remove_dir_all(&out);
    std::fs::rename(&tmp, &out)?;
    Ok(meta)
}
