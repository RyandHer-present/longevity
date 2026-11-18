//! Shared pieces of LongTerm Atlas and its background recorder: storage paths, the world
//! event journal, Minecraft log parsing, and the Gemini writer used by the Lore Book.

pub mod ai;
pub mod capsules;
pub mod companion;
pub mod events;
pub mod logs;
pub mod lore;
pub mod sightings;

use std::path::{Path, PathBuf};

/// %LOCALAPPDATA%\LongTermAtlas
pub fn data_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    let d = base.join("Longevity");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Stable id for a world folder (FNV-1a of the lowercase path) plus a readable prefix.
pub fn world_id(world_path: &Path) -> String {
    let s = world_path.to_string_lossy().to_lowercase().replace('/', "\\");
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    let name: String = world_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    format!("{}-{:012x}", name.trim_matches('-'), h & 0xffff_ffff_ffff)
}

pub fn world_dir(world_path: &Path) -> PathBuf {
    let d = data_dir().join("worlds").join(world_id(world_path));
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Shared settings file written by the app and read by the recorder.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Settings {
    pub sounds: bool,
    pub recorder_enabled: bool,
    pub chapter_every_days: u32,
    pub render_distance: u32,
    pub quality: String,
    pub map_style: String,
    pub last_world: Option<String>,
    pub notify_chapters: bool,
    /// Colour theme id for the app ("atlas" is the original gold look).
    pub theme: String,
    /// Longevity's own settings (sidebar, notifications, panels...), kept as they come.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            sounds: true,
            recorder_enabled: true,
            chapter_every_days: 50,
            render_distance: 12,
            quality: "high".into(),
            map_style: "color".into(),
            last_world: None,
            notify_chapters: true,
            theme: "atlas".into(),
            extra: Default::default(),
        }
    }
}

impl Settings {
    pub fn path() -> PathBuf {
        data_dir().join("settings.json")
    }
    pub fn load() -> Settings {
        std::fs::read(Self::path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
    pub fn save(&self) -> anyhow::Result<()> {
        let tmp = Self::path().with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, Self::path())?;
        Ok(())
    }
}
