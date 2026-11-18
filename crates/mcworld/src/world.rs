//! A Minecraft save folder: dimensions, regions, level.dat, players.

use crate::chunk::{self, Chunk};
use crate::nbt::{self, V, Value};
use crate::region::{self, Region};
use anyhow::Result;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Dim {
    Overworld,
    Nether,
    End,
}

impl Dim {
    pub fn all() -> [Dim; 3] {
        [Dim::Overworld, Dim::Nether, Dim::End]
    }
    pub fn id(self) -> &'static str {
        match self {
            Dim::Overworld => "minecraft:overworld",
            Dim::Nether => "minecraft:the_nether",
            Dim::End => "minecraft:the_end",
        }
    }
    pub fn from_id(s: &str) -> Option<Dim> {
        match s.strip_prefix("minecraft:").unwrap_or(s) {
            "overworld" => Some(Dim::Overworld),
            "the_nether" | "nether" => Some(Dim::Nether),
            "the_end" | "end" => Some(Dim::End),
            _ => None,
        }
    }
    pub fn min_y(self) -> i32 {
        match self {
            Dim::Overworld => -64,
            _ => 0,
        }
    }
    pub fn max_y(self) -> i32 {
        match self {
            Dim::Overworld => 319,
            _ => 255,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct LevelInfo {
    pub name: String,
    pub version: String,
    pub data_version: i64,
    /// Total ticks the world has run.
    pub time: i64,
    /// Time of day counter (advances when sleeping); day number = day_time / 24000.
    pub day_time: i64,
    pub game_type: i64,
    pub hardcore: bool,
    pub difficulty: i64,
    pub seed: Option<i64>,
    pub spawn: Option<[i32; 3]>,
    pub raining: bool,
    pub thundering: bool,
    pub last_played: i64,
}

impl LevelInfo {
    pub fn day(&self) -> i64 {
        self.day_time / 24000
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct WorldEntry {
    pub path: PathBuf,
    pub folder: String,
    pub name: String,
    pub source: String,
    pub instance: String,
    pub version: String,
    pub last_played: i64,
    pub size_bytes: u64,
    pub icon: Option<PathBuf>,
}

/// Find every world on this PC: Prism instances, the official launcher and Modrinth profiles.
pub fn discover() -> Vec<WorldEntry> {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let mut roots: Vec<(String, String, PathBuf)> = Vec::new();
    let prism = Path::new(&appdata).join("PrismLauncher").join("instances");
    if let Ok(rd) = std::fs::read_dir(&prism) {
        for e in rd.flatten() {
            let inst = e.file_name().to_string_lossy().to_string();
            for sub in ["minecraft", ".minecraft"] {
                let saves = e.path().join(sub).join("saves");
                if saves.is_dir() {
                    roots.push(("Prism".into(), inst.clone(), saves));
                }
            }
        }
    }
    let official = Path::new(&appdata).join(".minecraft").join("saves");
    if official.is_dir() {
        roots.push(("Minecraft Launcher".into(), "Minecraft".into(), official));
    }
    let modrinth = Path::new(&appdata).join("ModrinthApp").join("profiles");
    if let Ok(rd) = std::fs::read_dir(&modrinth) {
        for e in rd.flatten() {
            let saves = e.path().join("saves");
            if saves.is_dir() {
                roots.push(("Modrinth".into(), e.file_name().to_string_lossy().to_string(), saves));
            }
        }
    }
    let mut out = Vec::new();
    for (source, instance, saves) in roots {
        let Ok(rd) = std::fs::read_dir(&saves) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let level = p.join("level.dat");
            if !level.is_file() {
                continue;
            }
            let folder = e.file_name().to_string_lossy().to_string();
            let info = read_level(&p).ok();
            let last_played = info.as_ref().map(|i| i.last_played).filter(|t| *t > 0).unwrap_or_else(|| mtime_ms(&level));
            out.push(WorldEntry {
                name: info.as_ref().map(|i| i.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| folder.clone()),
                version: info.as_ref().map(|i| i.version.clone()).unwrap_or_default(),
                folder,
                source: source.clone(),
                instance: instance.clone(),
                last_played,
                size_bytes: 0,
                icon: Some(p.join("icon.png")).filter(|i| i.is_file()),
                path: p,
            });
        }
    }
    out.sort_by(|a, b| b.last_played.cmp(&a.last_played));
    out
}

pub fn dir_size(p: &Path) -> u64 {
    let mut total = 0;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            match e.metadata() {
                Ok(m) if m.is_dir() => total += dir_size(&e.path()),
                Ok(m) => total += m.len(),
                _ => {}
            }
        }
    }
    total
}

pub fn mtime_ms(p: &Path) -> i64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn read_level(world: &Path) -> Result<LevelInfo> {
    let v = nbt::read_file(&world.join("level.dat"))?;
    let d = v.get("Data").unwrap_or(&v);
    let spawn = d
        .path(&["spawn", "pos"])
        .and_then(|p| p.int_array())
        .filter(|a| a.len() == 3)
        .map(|a| [a[0], a[1], a[2]])
        .or_else(|| match (d.get_i64("SpawnX"), d.get_i64("SpawnY"), d.get_i64("SpawnZ")) {
            (Some(x), Some(y), Some(z)) => Some([x as i32, y as i32, z as i32]),
            _ => None,
        });
    // 26.x moved the clock, seed and weather into data/minecraft/*.dat
    let data = |f: &str| nbt::read_file(&world.join("data").join("minecraft").join(f)).ok();
    let clocks = data("world_clocks.dat");
    let clock_day_time = clocks.as_ref().and_then(|c| c.path(&["data", "minecraft:overworld", "total_ticks"]).and_then(|v| v.i64()));
    let gen_seed = data("world_gen_settings.dat").and_then(|g| g.path(&["data", "seed"]).and_then(|v| v.i64()));
    let weather = data("weather.dat");
    let w_flag = |k: &str| weather.as_ref().and_then(|w| w.path(&["data", k]).and_then(|v| v.i64()));
    let hardcore = d.path(&["difficulty_settings", "hardcore"]).and_then(|v| v.i64()).or_else(|| d.get_i64("hardcore")).unwrap_or(0) != 0;
    let difficulty = match d.path(&["difficulty_settings", "difficulty"]).and_then(|v| v.str()) {
        Some("peaceful") => 0,
        Some("easy") => 1,
        Some("normal") => 2,
        Some("hard") => 3,
        _ => d.get_i64("Difficulty").unwrap_or(2),
    };
    Ok(LevelInfo {
        name: strip_codes(d.get_str("LevelName").unwrap_or("")),
        version: d.path(&["Version", "Name"]).and_then(|v| v.str()).unwrap_or("").to_string(),
        data_version: d.get_i64("DataVersion").unwrap_or(0),
        time: d.get_i64("Time").unwrap_or(0),
        day_time: clock_day_time.or_else(|| d.get_i64("DayTime")).unwrap_or(0),
        game_type: d.get_i64("GameType").unwrap_or(0),
        hardcore,
        difficulty,
        seed: gen_seed.or_else(|| d.path(&["WorldGenSettings", "seed"]).and_then(|v| v.i64())).or_else(|| d.get_i64("RandomSeed")),
        spawn,
        raining: w_flag("raining").or_else(|| d.get_i64("raining")).unwrap_or(0) != 0,
        thundering: w_flag("thundering").or_else(|| d.get_i64("thundering")).unwrap_or(0) != 0,
        last_played: d.get_i64("LastPlayed").unwrap_or(0),
    })
}

type ChunkKey = (Dim, i32, i32);

pub struct World {
    pub root: PathBuf,
    regions: Mutex<lru::LruCache<(Dim, i32, i32), Arc<Region>>>,
    region_mtimes: Mutex<HashMap<(Dim, i32, i32), i64>>,
    chunks: Mutex<lru::LruCache<ChunkKey, Arc<Chunk>>>,
}

impl World {
    pub fn open(root: &Path) -> Result<World> {
        anyhow::ensure!(root.join("level.dat").is_file(), "no level.dat in {}", root.display());
        Ok(World {
            root: root.to_path_buf(),
            regions: Mutex::new(lru::LruCache::new(NonZeroUsize::new(12).unwrap())),
            region_mtimes: Mutex::new(HashMap::new()),
            chunks: Mutex::new(lru::LruCache::new(NonZeroUsize::new(1500).unwrap())),
        })
    }

    /// Forget the cached region files and decoded chunks (they're read again when needed).
    pub fn trim(&self) {
        self.regions.lock().clear();
        self.chunks.lock().clear();
    }

    pub fn level(&self) -> Result<LevelInfo> {
        read_level(&self.root)
    }

    /// Folder holding region/, entities/, poi/ for a dimension (supports the 26.x and the classic layout).
    pub fn dim_dir(&self, dim: Dim) -> PathBuf {
        let modern = self.root.join("dimensions").join("minecraft").join(match dim {
            Dim::Overworld => "overworld",
            Dim::Nether => "the_nether",
            Dim::End => "the_end",
        });
        if modern.join("region").is_dir() || modern.join("entities").is_dir() {
            return modern;
        }
        match dim {
            Dim::Overworld => self.root.clone(),
            Dim::Nether => self.root.join("DIM-1"),
            Dim::End => self.root.join("DIM1"),
        }
    }

    pub fn regions(&self, dim: Dim) -> Vec<(i32, i32, PathBuf)> {
        region::list_regions(&self.dim_dir(dim).join("region"))
    }

    pub fn entity_regions(&self, dim: Dim) -> Vec<(i32, i32, PathBuf)> {
        region::list_regions(&self.dim_dir(dim).join("entities"))
    }

    fn region_path(&self, dim: Dim, folder: &str, rx: i32, rz: i32) -> PathBuf {
        self.dim_dir(dim).join(folder).join(format!("r.{rx}.{rz}.mca"))
    }

    /// Cached region (block data). Re-read automatically when the file changes on disk.
    pub fn region(&self, dim: Dim, rx: i32, rz: i32) -> Option<Arc<Region>> {
        let path = self.region_path(dim, "region", rx, rz);
        let mt = mtime_ms(&path);
        if mt == 0 {
            return None;
        }
        let key = (dim, rx, rz);
        {
            let mut cache = self.regions.lock();
            let fresh = self.region_mtimes.lock().get(&key).copied() == Some(mt);
            if fresh {
                if let Some(r) = cache.get(&key) {
                    return Some(r.clone());
                }
            }
        }
        let r = Arc::new(Region::open(&path).ok()?);
        let changed = self.region_mtimes.lock().insert(key, mt).is_some_and(|old| old != mt);
        if changed {
            // drop stale chunks of this region
            let mut ch = self.chunks.lock();
            let stale: Vec<ChunkKey> = ch.iter().filter(|(k, _)| k.0 == dim && k.1 >> 5 == rx && k.2 >> 5 == rz).map(|(k, _)| *k).collect();
            for k in stale {
                ch.pop(&k);
            }
        }
        self.regions.lock().put(key, r.clone());
        Some(r)
    }

    /// Decoded chunk (with light), cached.
    pub fn chunk(&self, dim: Dim, cx: i32, cz: i32) -> Option<Arc<Chunk>> {
        let key = (dim, cx, cz);
        let region = self.region(dim, cx >> 5, cz >> 5)?;
        if let Some(c) = self.chunks.lock().get(&key) {
            return Some(c.clone());
        }
        let bytes = region.chunk_bytes((cx & 31) as usize, (cz & 31) as usize).ok()??;
        let v = nbt::parse(&bytes).ok()?;
        let c = Arc::new(chunk::decode(&v, true).ok()?);
        self.chunks.lock().put(key, c.clone());
        Some(c)
    }

    /// Decode a chunk without caching and without light (for big scans like the map).
    pub fn chunk_uncached(region: &Region, lx: usize, lz: usize) -> Option<Chunk> {
        let bytes = region.chunk_bytes(lx, lz).ok()??;
        let v = nbt::parse(&bytes).ok()?;
        chunk::decode(&v, false).ok()
    }

    /// Entities chunk NBT (list of entity compounds) from entities/ region files.
    pub fn entities_in_region(&self, dim: Dim, rx: i32, rz: i32) -> Vec<Value> {
        let path = self.region_path(dim, "entities", rx, rz);
        let Ok(r) = Region::open(&path) else { return Vec::new() };
        let mut out = Vec::new();
        for (lx, lz) in r.present().collect::<Vec<_>>() {
            if let Ok(Some(b)) = r.chunk_bytes(lx, lz) {
                if let Ok(v) = nbt::parse(&b) {
                    out.extend(v.get_list("Entities").iter().cloned());
                }
            }
        }
        out
    }

    pub fn players_dir(&self) -> PathBuf {
        let modern = self.root.join("players");
        if modern.is_dir() { modern } else { self.root.clone() }
    }

    /// (uuid, player NBT) for every player that has a data file.
    pub fn players(&self) -> Vec<(String, Value)> {
        let mut out = Vec::new();
        let dirs = [self.root.join("players").join("data"), self.root.join("playerdata")];
        for d in dirs {
            let Ok(rd) = std::fs::read_dir(&d) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("dat") {
                    continue;
                }
                let uuid = p.file_stem().unwrap().to_string_lossy().to_string();
                if let Ok(v) = nbt::read_file(&p) {
                    out.push((uuid, v));
                }
            }
            if !out.is_empty() {
                break;
            }
        }
        if out.is_empty() {
            // single player data inside level.dat
            if let Ok(v) = nbt::read_file(&self.root.join("level.dat")) {
                if let Some(p) = v.path(&["Data", "Player"]) {
                    out.push(("local".to_string(), p.clone()));
                }
            }
        }
        out
    }

    pub fn stats_json(&self, uuid: &str) -> Option<serde_json::Value> {
        for p in [self.root.join("players").join("stats").join(format!("{uuid}.json")), self.root.join("stats").join(format!("{uuid}.json"))] {
            if let Ok(s) = std::fs::read_to_string(&p) {
                return serde_json::from_str(&s).ok();
            }
        }
        None
    }

    pub fn advancements_json(&self, uuid: &str) -> Option<serde_json::Value> {
        for p in [self.root.join("players").join("advancements").join(format!("{uuid}.json")), self.root.join("advancements").join(format!("{uuid}.json"))] {
            if let Ok(s) = std::fs::read_to_string(&p) {
                return serde_json::from_str(&s).ok();
            }
        }
        None
    }

    /// Is Minecraft currently running this world? (session.lock is held exclusively while open.)
    pub fn is_open_in_game(&self) -> bool {
        session_locked(&self.root.join("session.lock"))
    }
}

#[cfg(windows)]
fn session_locked(p: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    // FILE_SHARE_NONE: fails with a sharing violation if Minecraft holds the lock.
    match std::fs::OpenOptions::new().read(true).share_mode(0).open(p) {
        Ok(_) => false,
        Err(e) => e.raw_os_error() == Some(32) || e.raw_os_error() == Some(33),
    }
}

#[cfg(not(windows))]
fn session_locked(_p: &Path) -> bool {
    false
}

/// Remove Minecraft's § formatting codes (colours, bold...) from a name.
pub fn strip_codes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut skip = false;
    for c in s.chars() {
        if skip {
            skip = false;
            continue;
        }
        if c == '§' {
            skip = true;
            continue;
        }
        out.push(c);
    }
    out.trim().to_string()
}
