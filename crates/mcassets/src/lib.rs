//! Minecraft client assets: textures, block models, biome colors, names and item icons.

pub mod colors;
pub mod entity_models;
pub mod icons;
pub mod jar;
pub mod lang;
pub mod model;
pub mod textures;

pub use colors::Colormaps;
pub use jar::Jar;
pub use lang::Lang;
pub use model::{BakedModel, BakedState, Dir, Fluid, Models, Quad, Tint};
pub use textures::{Alpha, TexInfo, TextureArray};

use std::sync::Arc;

/// Everything loaded from one client jar.
pub struct Assets {
    pub jar: Arc<Jar>,
    pub tex: Arc<TextureArray>,
    pub models: Models,
    pub colors: Colormaps,
    pub lang: Lang,
    pub version: String,
}

impl Assets {
    pub fn load(jar_path: &std::path::Path, version: &str) -> anyhow::Result<Assets> {
        let jar = Arc::new(Jar::open(jar_path)?);
        let tex = Arc::new(TextureArray::build(&jar));
        // allocate the fluid textures first so their layers are stable
        for t in ["block/water_still", "block/water_flow", "block/lava_still", "block/lava_flow", "block/water_overlay"] {
            tex.get(t);
        }
        let models = Models::new(jar.clone(), tex.clone());
        let colors = Colormaps::load(&jar);
        let lang = Lang::load(&jar);
        Ok(Assets { jar, tex, models, colors, lang, version: version.to_string() })
    }

    /// Find the jar for `version` (or the newest installed) and load it.
    pub fn discover(version: &str) -> anyhow::Result<Assets> {
        let path = jar::find_any_client_jar(version).ok_or_else(|| anyhow::anyhow!("no Minecraft client jar found for {version}"))?;
        let v = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.trim_start_matches("minecraft-").trim_end_matches("-client.jar").trim_end_matches(".jar").to_string())
            .unwrap_or_else(|| version.to_string());
        Self::load(&path, &v)
    }
}
