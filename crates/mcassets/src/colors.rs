//! Biome tint colors (grass, foliage, water) using the game's colormaps and biome climate values.

use crate::jar::Jar;
use crate::model::Tint;

pub struct Colormaps {
    grass: Option<image::RgbaImage>,
    foliage: Option<image::RgbaImage>,
    dry_foliage: Option<image::RgbaImage>,
}

#[derive(Clone, Copy, Debug)]
pub struct Climate {
    pub temperature: f32,
    pub downfall: f32,
    pub water: u32,
    pub grass: Option<u32>,
    pub foliage: Option<u32>,
    pub dry_foliage: Option<u32>,
    pub dark_forest: bool,
    pub swamp: bool,
}

const fn c(t: f32, d: f32, water: u32) -> Climate {
    Climate { temperature: t, downfall: d, water, grass: None, foliage: None, dry_foliage: None, dark_forest: false, swamp: false }
}

pub fn climate(biome: &str) -> Climate {
    let b = biome.trim_start_matches("minecraft:");
    let w = 0x3F76E4;
    match b {
        "plains" | "sunflower_plains" | "beach" => c(0.8, 0.4, w),
        "snowy_plains" | "ice_spikes" => c(0.0, 0.5, w),
        "desert" => c(2.0, 0.0, w),
        "swamp" => Climate { foliage: Some(0x6A7039), swamp: true, ..c(0.8, 0.9, 0x617B64) },
        "mangrove_swamp" => Climate { foliage: Some(0x8DB127), swamp: true, ..c(0.8, 0.9, 0x3A7A6A) },
        "forest" | "flower_forest" => c(0.7, 0.8, w),
        "birch_forest" | "old_growth_birch_forest" => c(0.6, 0.6, w),
        "dark_forest" => Climate { dark_forest: true, ..c(0.7, 0.8, w) },
        "pale_garden" => Climate { grass: Some(0x778272), foliage: Some(0x878D76), ..c(0.7, 0.8, 0x76889D) },
        "taiga" | "old_growth_spruce_taiga" => c(0.25, 0.8, w),
        "old_growth_pine_taiga" => c(0.3, 0.8, w),
        "snowy_taiga" => c(-0.5, 0.4, 0x3D57D6),
        "savanna" | "savanna_plateau" | "windswept_savanna" => c(2.0, 0.0, w),
        "windswept_hills" | "windswept_gravelly_hills" | "windswept_forest" | "stony_shore" => c(0.2, 0.3, w),
        "jungle" | "bamboo_jungle" => c(0.95, 0.9, w),
        "sparse_jungle" => c(0.95, 0.8, w),
        "badlands" | "eroded_badlands" | "wooded_badlands" => Climate { grass: Some(0x90814D), foliage: Some(0x9E814D), ..c(2.0, 0.0, w) },
        "meadow" => c(0.5, 0.8, 0x0E4ECF),
        "cherry_grove" => Climate { grass: Some(0xB6DB61), foliage: Some(0xB6DB61), ..c(0.5, 0.8, 0x5DB7EF) },
        "grove" => c(-0.2, 0.8, w),
        "snowy_slopes" => c(-0.3, 0.9, w),
        "frozen_peaks" | "jagged_peaks" => c(-0.7, 0.9, w),
        "stony_peaks" => c(1.0, 0.3, w),
        "river" => c(0.5, 0.5, w),
        "frozen_river" => c(0.0, 0.5, 0x3938C9),
        "snowy_beach" => c(0.05, 0.3, 0x3D57D6),
        "warm_ocean" => c(0.5, 0.5, 0x43D5EE),
        "lukewarm_ocean" | "deep_lukewarm_ocean" => c(0.5, 0.5, 0x45ADF2),
        "ocean" | "deep_ocean" => c(0.5, 0.5, w),
        "cold_ocean" | "deep_cold_ocean" => c(0.5, 0.5, 0x3D57D6),
        "frozen_ocean" => c(0.0, 0.5, 0x3938C9),
        "deep_frozen_ocean" => c(0.5, 0.5, 0x3938C9),
        "mushroom_fields" => c(0.9, 1.0, w),
        "dripstone_caves" | "deep_dark" => c(0.8, 0.4, w),
        "lush_caves" => c(0.5, 0.5, w),
        "nether_wastes" | "soul_sand_valley" | "crimson_forest" | "warped_forest" | "basalt_deltas" => c(2.0, 0.0, 0x3F76E4),
        "the_end" | "end_highlands" | "end_midlands" | "small_end_islands" | "end_barrens" | "the_void" => c(0.5, 0.5, w),
        _ => c(0.8, 0.4, w),
    }
}

fn rgb(v: u32) -> [u8; 3] {
    [(v >> 16) as u8, (v >> 8) as u8, v as u8]
}

/// Small deterministic value noise standing in for the swamp grass noise.
fn swamp_noise(x: i32, z: i32) -> f32 {
    let h = |x: i32, z: i32| -> f32 {
        let mut n = (x as u32).wrapping_mul(0x27d4eb2d) ^ (z as u32).wrapping_mul(0x165667b1);
        n = (n ^ (n >> 15)).wrapping_mul(0x85ebca6b);
        n ^= n >> 13;
        (n & 0xffff) as f32 / 65535.0 * 2.0 - 1.0
    };
    let fx = x as f32 * 0.0225 * 4.0;
    let fz = z as f32 * 0.0225 * 4.0;
    let (ix, iz) = (fx.floor() as i32, fz.floor() as i32);
    let (tx, tz) = (fx - ix as f32, fz - iz as f32);
    let s = |t: f32| t * t * (3.0 - 2.0 * t);
    let a = h(ix, iz) + (h(ix + 1, iz) - h(ix, iz)) * s(tx);
    let b = h(ix, iz + 1) + (h(ix + 1, iz + 1) - h(ix, iz + 1)) * s(tx);
    a + (b - a) * s(tz)
}

impl Colormaps {
    pub fn load(jar: &Jar) -> Colormaps {
        let get = |n: &str| jar.get(&format!("textures/colormap/{n}.png")).and_then(|b| image::load_from_memory(b).ok()).map(|i| i.to_rgba8());
        Colormaps { grass: get("grass"), foliage: get("foliage"), dry_foliage: get("dry_foliage") }
    }

    fn sample(map: &Option<image::RgbaImage>, t: f32, d: f32, fallback: u32) -> [u8; 3] {
        let Some(m) = map else { return rgb(fallback) };
        let t = t.clamp(0.0, 1.0);
        let d = d.clamp(0.0, 1.0) * t;
        let x = ((1.0 - t) * 255.0) as u32;
        let y = ((1.0 - d) * 255.0) as u32;
        let (w, h) = m.dimensions();
        let p = m.get_pixel(x.min(w - 1), y.min(h - 1));
        [p[0], p[1], p[2]]
    }

    pub fn grass(&self, biome: &str, x: i32, z: i32) -> [u8; 3] {
        let c = climate(biome);
        if let Some(g) = c.grass {
            return rgb(g);
        }
        if c.swamp {
            return rgb(if swamp_noise(x, z) < -0.1 { 0x4C763C } else { 0x6A7039 });
        }
        let base = Self::sample(&self.grass, c.temperature, c.downfall, 0x91BD59);
        if c.dark_forest {
            let v = ((base[0] as u32) << 16) | ((base[1] as u32) << 8) | base[2] as u32;
            return rgb(((v & 0xFEFEFE) + 0x28340A) >> 1);
        }
        base
    }

    pub fn foliage(&self, biome: &str) -> [u8; 3] {
        let c = climate(biome);
        if let Some(f) = c.foliage {
            return rgb(f);
        }
        Self::sample(&self.foliage, c.temperature, c.downfall, 0x77AB2F)
    }

    pub fn dry_foliage(&self, biome: &str) -> [u8; 3] {
        let c = climate(biome);
        if let Some(f) = c.dry_foliage {
            return rgb(f);
        }
        Self::sample(&self.dry_foliage, c.temperature, c.downfall, 0x9E7B4F)
    }

    pub fn water(&self, biome: &str) -> [u8; 3] {
        rgb(climate(biome).water)
    }

    /// Resolve a tint for a block at a position in a biome. White = no tint.
    pub fn tint(&self, t: Tint, biome: &str, x: i32, z: i32) -> [u8; 3] {
        match t {
            Tint::None => [255, 255, 255],
            Tint::Grass => self.grass(biome, x, z),
            Tint::Foliage => self.foliage(biome),
            Tint::DryFoliage => self.dry_foliage(biome),
            Tint::Water => self.water(biome),
            Tint::Fixed(c) => c,
            Tint::Redstone(p) => {
                let f = p as f32 / 15.0;
                let r = f * 0.6 + if f > 0.0 { 0.4 } else { 0.3 };
                let g = (f * f * 0.7 - 0.5).clamp(0.0, 1.0);
                let b = (f * f * 0.6 - 0.7).clamp(0.0, 1.0);
                [(r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8]
            }
        }
    }
}

/// Biome display colors for the 2D map's biome layer.
pub fn biome_map_color(biome: &str) -> [u8; 3] {
    let b = biome.trim_start_matches("minecraft:");
    rgb(match b {
        "ocean" => 0x000070,
        "deep_ocean" => 0x000030,
        "warm_ocean" => 0x0000AC,
        "lukewarm_ocean" => 0x000090,
        "deep_lukewarm_ocean" => 0x000040,
        "cold_ocean" => 0x202070,
        "deep_cold_ocean" => 0x202038,
        "frozen_ocean" | "deep_frozen_ocean" => 0x7070D6,
        "river" => 0x0000FF,
        "frozen_river" => 0xA0A0FF,
        "plains" => 0x8DB360,
        "sunflower_plains" => 0xB5DB88,
        "desert" => 0xFA9418,
        "forest" => 0x056621,
        "flower_forest" => 0x2D8E49,
        "birch_forest" => 0x307444,
        "old_growth_birch_forest" => 0x589C6C,
        "dark_forest" => 0x40511A,
        "pale_garden" => 0x9B9F96,
        "taiga" => 0x0B6659,
        "snowy_taiga" => 0x31554A,
        "old_growth_pine_taiga" => 0x596651,
        "old_growth_spruce_taiga" => 0x818E79,
        "swamp" => 0x07F9B2,
        "mangrove_swamp" => 0x67352B,
        "jungle" => 0x537B09,
        "sparse_jungle" => 0x628B17,
        "bamboo_jungle" => 0x768E14,
        "savanna" => 0xBDB25F,
        "savanna_plateau" => 0xA79D64,
        "windswept_savanna" => 0xE5DA87,
        "badlands" => 0xD94515,
        "eroded_badlands" => 0xFF6D3D,
        "wooded_badlands" => 0xB09765,
        "beach" => 0xFADE55,
        "snowy_beach" => 0xFAF0C0,
        "stony_shore" => 0xA2A284,
        "snowy_plains" => 0xFFFFFF,
        "ice_spikes" => 0xB4DCDC,
        "windswept_hills" => 0x606060,
        "windswept_gravelly_hills" => 0x888888,
        "windswept_forest" => 0x507050,
        "meadow" => 0x83BB6D,
        "cherry_grove" => 0xFFB7D5,
        "grove" => 0x47726A,
        "snowy_slopes" => 0xC4C4C4,
        "jagged_peaks" => 0xDCDCC8,
        "frozen_peaks" => 0xB0B3CE,
        "stony_peaks" => 0x7B8F74,
        "mushroom_fields" => 0xFF00FF,
        "dripstone_caves" => 0x7B5E4A,
        "lush_caves" => 0x3C6E2A,
        "deep_dark" => 0x0E1A25,
        "nether_wastes" => 0x572526,
        "soul_sand_valley" => 0x4D3A2E,
        "crimson_forest" => 0x981A11,
        "warped_forest" => 0x49907B,
        "basalt_deltas" => 0x403636,
        _ => 0x808080,
    })
}
