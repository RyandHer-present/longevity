//! Play history: sessions read from each instance's game logs, playtime per instance and world.

use super::prism;
use super::util::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Session {
    pub instance: String,
    pub date: String,
    pub start: String,
    pub minutes: i64,
    pub place: Option<String>,
    pub server: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Cache {
    /// file key -> sessions in that file
    files: HashMap<String, Vec<Session>>,
}

fn secs(ts: &str) -> Option<i64> {
    // "[12:06:18]"
    let t = ts.trim_start_matches('[');
    let p: Vec<&str> = t.get(0..8)?.split(':').collect();
    if p.len() != 3 {
        return None;
    }
    Some(p[0].parse::<i64>().ok()? * 3600 + p[1].parse::<i64>().ok()? * 60 + p[2].parse::<i64>().ok()?)
}

fn local_date_of(ms: i64) -> String {
    // civil date from days since epoch, shifted by the local offset Windows uses
    let off = local_offset_secs();
    let days = (ms / 1000 + off).div_euclid(86400);
    let (y, m, d) = civil(days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn civil(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Seconds east of UTC, from Windows' time zone info.
pub fn local_offset_secs() -> i64 {
    #[cfg(windows)]
    {
        #[repr(C)]
        struct SystemTime([u16; 8]);
        #[repr(C)]
        struct Tzi {
            bias: i32,
            standard_name: [u16; 32],
            standard_date: SystemTime,
            standard_bias: i32,
            daylight_name: [u16; 32],
            daylight_date: SystemTime,
            daylight_bias: i32,
        }
        unsafe extern "system" {
            fn GetTimeZoneInformation(tz: *mut Tzi) -> u32;
        }
        let mut tz: Tzi = unsafe { std::mem::zeroed() };
        let r = unsafe { GetTimeZoneInformation(&mut tz) };
        let bias = tz.bias + if r == 2 { tz.daylight_bias } else { tz.standard_bias };
        return -(bias as i64) * 60;
    }
    #[allow(unreachable_code)]
    0
}

fn read_log(p: &Path) -> String {
    let raw = std::fs::read(p).unwrap_or_default();
    if raw.len() > 2 && raw[0] == 0x1f && raw[1] == 0x8b {
        let mut s = String::new();
        let _ = flate2::read::GzDecoder::new(&raw[..]).read_to_string(&mut s);
        s
    } else {
        String::from_utf8_lossy(&raw).to_string()
    }
}

fn parse_file(inst: &str, p: &Path) -> Vec<Session> {
    let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let date = if name.len() >= 10 && name.as_bytes()[4] == b'-' && name.as_bytes()[7] == b'-' { name[..10].to_string() } else { local_date_of(mtime_ms(p)) };
    let text = read_log(p);
    let mut first = None;
    let mut last = None;
    let mut place: Option<String> = None;
    let mut server = false;
    let re_level = regex::Regex::new(r"ServerLevel\[(.+?)\]").unwrap();
    let re_conn = regex::Regex::new(r"Connecting to ([^,\s]+), ?(\d+)").unwrap();
    for l in text.lines() {
        if l.starts_with('[') {
            if let Some(s) = secs(l) {
                if first.is_none() {
                    first = Some(s);
                }
                last = Some(s);
            }
        }
        if place.is_none() {
            if let Some(c) = re_level.captures(l) {
                place = Some(c[1].to_string());
            } else if let Some(c) = re_conn.captures(l) {
                place = Some(if &c[2] == "25565" { c[1].to_string() } else { format!("{}:{}", &c[1], &c[2]) });
                server = true;
            }
        }
    }
    let (Some(a), Some(mut b)) = (first, last) else { return vec![] };
    if b < a {
        b += 86400;
    }
    let minutes = (b - a) / 60;
    if minutes < 1 {
        return vec![];
    }
    vec![Session { instance: inst.to_string(), date, start: format!("{:02}:{:02}", a / 3600, (a / 60) % 60), minutes, place, server }]
}

pub fn sessions() -> Vec<Session> {
    let cpath = data_dir().join("cache").join("sessions.json");
    let mut cache: Cache = read_json(&cpath);
    let mut out = vec![];
    let mut used = std::collections::HashSet::new();
    let mut dirty = false;
    for inst in prism::instances() {
        let logs = PathBuf::from(&inst.mc_dir).join("logs");
        let Ok(rd) = std::fs::read_dir(&logs) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let n = e.file_name().to_string_lossy().to_string();
            if !(n.ends_with(".log.gz") || n == "latest.log") || n.starts_with("debug") {
                continue;
            }
            let key = format!("{}|{}|{}|{}", inst.id, n, e.metadata().map(|m| m.len()).unwrap_or(0), mtime_ms(&p));
            used.insert(key.clone());
            let s = match cache.files.get(&key) {
                Some(s) => s.clone(),
                None => {
                    let s = parse_file(&inst.id, &p);
                    cache.files.insert(key, s.clone());
                    dirty = true;
                    s
                }
            };
            out.extend(s);
        }
    }
    let before = cache.files.len();
    cache.files.retain(|k, _| used.contains(k));
    if dirty || cache.files.len() != before {
        let _ = write_json(&cpath, &cache);
    }
    // latest.log duplicates the newest archived log once the game has restarted; drop exact twins
    out.sort_by(|a, b| (b.date.clone(), b.start.clone()).cmp(&(a.date.clone(), a.start.clone())));
    out.dedup_by(|a, b| a.instance == b.instance && a.date == b.date && a.start == b.start);
    out
}

#[derive(Serialize, Clone, Debug)]
pub struct WorldTime {
    pub instance: String,
    pub world: String,
    pub name: String,
    pub ticks: i64,
    pub last_played: i64,
}

pub fn world_times() -> Vec<WorldTime> {
    let mut out = vec![];
    for inst in prism::instances() {
        let saves = PathBuf::from(&inst.mc_dir).join("saves");
        let Ok(rd) = std::fs::read_dir(&saves) else { continue };
        for e in rd.flatten() {
            let w = e.path();
            if !w.join("level.dat").is_file() {
                continue;
            }
            let mut ticks = 0;
            for sd in [w.join("stats"), w.join("players").join("stats")] {
                if let Ok(rd) = std::fs::read_dir(&sd) {
                    for f in rd.flatten() {
                        if let Ok(t) = std::fs::read_to_string(f.path()) {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                                ticks += v.pointer("/stats/minecraft:custom/minecraft:play_time").and_then(|x| x.as_i64()).unwrap_or(0);
                            }
                        }
                    }
                }
            }
            let info = mcworld::world::read_level(&w).ok();
            out.push(WorldTime {
                instance: inst.id.clone(),
                world: e.file_name().to_string_lossy().to_string(),
                name: info.as_ref().map(|i| i.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| e.file_name().to_string_lossy().to_string()),
                ticks,
                last_played: info.map(|i| i.last_played).unwrap_or_else(|| mtime_ms(&w.join("level.dat"))),
            });
        }
    }
    out.sort_by(|a, b| b.ticks.cmp(&a.ticks));
    out
}

pub fn today() -> String {
    local_date_of(now_ms())
}
