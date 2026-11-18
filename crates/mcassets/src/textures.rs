//! Block textures packed as a 16x16 texture array (one layer per texture/animation frame).
//! Layers are allocated lazily, only for textures that baked models actually use.

use crate::jar::Jar;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;

pub const TILE: u32 = 16;
const LAYER_BYTES: usize = (TILE * TILE * 4) as usize;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub enum Alpha {
    Opaque,
    Cutout,
    Translucent,
}

#[derive(Clone, Debug, Serialize)]
pub struct TexInfo {
    pub layer: u16,
    pub frames: u16,
    /// Ticks per frame (1 tick = 50 ms).
    pub frametime: u16,
    pub alpha: Alpha,
    /// Average color of the opaque pixels (sRGB).
    pub avg: [u8; 3],
    pub emissive: bool,
}

struct Inner {
    by_name: HashMap<String, TexInfo>,
    rgba: Vec<u8>,
    layers: u16,
    /// (avg color, alpha) of the texture each layer belongs to
    per_layer: Vec<([u8; 3], Alpha)>,
}

/// Decoded source images (16x16 frames), keyed by "block/stone" style names.
pub struct TextureArray {
    src: HashMap<String, Source>,
    inner: Mutex<Inner>,
}

struct Source {
    frames: Vec<Vec<u8>>, // each LAYER_BYTES
    frametime: u16,
    alpha: Alpha,
    avg: [u8; 3],
}

const EMISSIVE: &[&str] = &[
    "glowstone", "sea_lantern", "shroomlight", "lava_still", "lava_flow", "fire_0", "fire_1", "soul_fire_0", "soul_fire_1",
    "torch", "soul_torch", "wall_torch", "lantern", "soul_lantern", "jack_o_lantern", "redstone_lamp_on", "magma", "beacon", "end_rod",
    "campfire_fire", "soul_campfire_fire", "campfire_log_lit", "soul_campfire_log_lit", "ochre_froglight_side", "ochre_froglight_top", "verdant_froglight_side",
    "verdant_froglight_top", "pearlescent_froglight_side", "pearlescent_froglight_top", "crying_obsidian", "respawn_anchor_top",
    "nether_portal", "end_portal_frame_eye", "redstone_torch", "glow_lichen", "candle_lit", "sculk_catalyst_top_bloom", "sculk_catalyst_side_bloom",
    "furnace_front_on", "blast_furnace_front_on", "smoker_front_on", "copper_bulb_lit", "exposed_copper_bulb_lit",
    "weathered_copper_bulb_lit", "oxidized_copper_bulb_lit", "cave_vines_lit", "cave_vines_plant_lit", "amethyst_cluster",
    "trial_spawner_side_active", "trial_spawner_top_active", "vault_front_on", "creaking_heart_awake", "conduit", "sea_pickle",
    "open_eyeblossom_emissive", "firefly_bush_emissive", "copper_torch", "copper_lantern", "end_gateway", "end_portal",
    "white_candle_lit", "redstone_ore_on", "deepslate_redstone_ore_on",
];

fn decode_layers(img: &image::RgbaImage, meta: Option<&serde_json::Value>) -> Option<Source> {
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return None;
    }
    let anim = meta.and_then(|m| m.get("animation"));
    let fw = anim.and_then(|a| a.get("width")).and_then(|v| v.as_u64()).map(|v| v as u32).unwrap_or(w.min(h));
    let fh = anim.and_then(|a| a.get("height")).and_then(|v| v.as_u64()).map(|v| v as u32).unwrap_or(w.min(h));
    let (fw, fh) = if anim.is_some() && fw > 0 && fh > 0 && w % fw == 0 && h % fh == 0 { (fw, fh) } else { (w, h) };
    let cols = (w / fw).max(1);
    let nframes = cols * (h / fh).max(1);
    let frametime = anim.and_then(|a| a.get("frametime")).and_then(|v| v.as_u64()).unwrap_or(1).max(1) as u16;
    let order: Vec<u32> = anim
        .and_then(|a| a.get("frames"))
        .and_then(|f| f.as_array())
        .map(|fr| fr.iter().filter_map(|e| e.as_u64().or_else(|| e.get("index").and_then(|i| i.as_u64())).map(|v| v as u32)).collect::<Vec<u32>>())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| (0..nframes).collect());
    let order: Vec<u32> = order.into_iter().filter(|f| *f < nframes).take(48).collect();
    let mut frames = Vec::with_capacity(order.len());
    let (mut sum, mut opaque_px, mut cut, mut semi) = ([0u64; 3], 0u64, 0u64, 0u64);
    for (fi, &f) in order.iter().enumerate() {
        let (fx, fy) = ((f % cols) * fw, (f / cols) * fh);
        let frame = image::imageops::crop_imm(img, fx, fy, fw, fh).to_image();
        let tile = if fw == TILE && fh == TILE { frame } else { image::imageops::resize(&frame, TILE, TILE, image::imageops::FilterType::Nearest) };
        if fi == 0 {
            for p in tile.pixels() {
                let a = p[3];
                if a > 200 {
                    sum[0] += p[0] as u64;
                    sum[1] += p[1] as u64;
                    sum[2] += p[2] as u64;
                    opaque_px += 1;
                }
                if a < 16 {
                    cut += 1;
                } else if a < 240 {
                    semi += 1;
                }
            }
        }
        frames.push(tile.into_raw());
    }
    if frames.is_empty() {
        return None;
    }
    let avg = if opaque_px > 0 { [(sum[0] / opaque_px) as u8, (sum[1] / opaque_px) as u8, (sum[2] / opaque_px) as u8] } else { [128, 128, 128] };
    let alpha = if semi > 8 { Alpha::Translucent } else if cut > 0 || semi > 0 { Alpha::Cutout } else { Alpha::Opaque };
    Some(Source { frames, frametime, alpha, avg })
}

impl TextureArray {
    pub fn build(jar: &Jar) -> TextureArray {
        let names: Vec<&str> = jar.list("textures/block/").filter(|n| n.ends_with(".png")).collect();
        let decoded: Vec<(String, Source)> = {
            use rayon::prelude::*;
            names
                .par_iter()
                .filter_map(|path| {
                    let bytes = jar.get(path)?;
                    let img = image::load_from_memory(bytes).ok()?.to_rgba8();
                    let meta = jar.json(&format!("{path}.mcmeta"));
                    let src = decode_layers(&img, meta.as_ref())?;
                    let short = path.trim_start_matches("textures/").trim_end_matches(".png").to_string();
                    Some((short, src))
                })
                .collect()
        };
        let src: HashMap<String, Source> = decoded.into_iter().collect();

        // layer 0: magenta/black missing texture
        let mut missing = vec![0u8; LAYER_BYTES];
        for y in 0..TILE {
            for x in 0..TILE {
                let i = ((y * TILE + x) * 4) as usize;
                let m = ((x / 8) + (y / 8)) % 2 == 0;
                missing[i..i + 4].copy_from_slice(if m { &[248, 0, 248, 255] } else { &[0, 0, 0, 255] });
            }
        }
        let mut by_name = HashMap::new();
        by_name.insert("missing".to_string(), TexInfo { layer: 0, frames: 1, frametime: 1, alpha: Alpha::Opaque, avg: [248, 0, 248], emissive: false });
        TextureArray { src, inner: Mutex::new(Inner { by_name, rgba: missing, layers: 1, per_layer: vec![([248, 0, 248], Alpha::Opaque)] }) }
    }

    fn norm(name: &str) -> &str {
        name.strip_prefix("minecraft:").unwrap_or(name)
    }

    /// Info for a texture without allocating a layer (for map colors).
    pub fn peek_avg(&self, name: &str) -> Option<([u8; 3], Alpha)> {
        let s = self.src.get(Self::norm(name))?;
        Some((s.avg, s.alpha))
    }

    pub fn exists(&self, name: &str) -> bool {
        self.src.contains_key(Self::norm(name)) || self.inner.lock().by_name.contains_key(Self::norm(name))
    }

    /// Get (allocating if needed) the layer info of a texture. Unknown textures map to the missing layer.
    pub fn get(&self, name: &str) -> TexInfo {
        let n = Self::norm(name);
        let mut inner = self.inner.lock();
        if let Some(t) = inner.by_name.get(n) {
            return t.clone();
        }
        let Some(s) = self.src.get(n) else {
            return inner.by_name["missing"].clone();
        };
        let layer = inner.layers;
        for f in &s.frames {
            inner.rgba.extend_from_slice(f);
            inner.per_layer.push((s.avg, s.alpha));
        }
        inner.layers += s.frames.len() as u16;
        let base = n.trim_start_matches("block/");
        let info = TexInfo { layer, frames: s.frames.len() as u16, frametime: s.frametime, alpha: s.alpha, avg: s.avg, emissive: EMISSIVE.contains(&base) };
        inner.by_name.insert(n.to_string(), info.clone());
        info
    }

    /// Add a 16x16 tile cut out of a bigger texture (entity textures for chests, beds, signs...).
    /// `rect` is in pixels of the source image: x, y, w, h. `rot` rotates the result by 90° steps clockwise.
    pub fn add_virtual(&self, name: &str, src: &image::RgbaImage, rect: (u32, u32, u32, u32), rot: u8, flip_x: bool, flip_y: bool) -> TexInfo {
        let mut inner = self.inner.lock();
        if let Some(t) = inner.by_name.get(name) {
            return t.clone();
        }
        let (x, y, w, h) = rect;
        if x + w > src.width() || y + h > src.height() || w == 0 || h == 0 {
            return inner.by_name["missing"].clone();
        }
        let mut part = image::imageops::crop_imm(src, x, y, w, h).to_image();
        if flip_x {
            part = image::imageops::flip_horizontal(&part);
        }
        if flip_y {
            part = image::imageops::flip_vertical(&part);
        }
        part = match rot % 4 {
            1 => image::imageops::rotate90(&part),
            2 => image::imageops::rotate180(&part),
            3 => image::imageops::rotate270(&part),
            _ => part,
        };
        let tile = image::imageops::resize(&part, TILE, TILE, image::imageops::FilterType::Nearest);
        let (mut sum, mut n, mut cut) = ([0u64; 3], 0u64, false);
        for p in tile.pixels() {
            if p[3] > 200 {
                sum[0] += p[0] as u64;
                sum[1] += p[1] as u64;
                sum[2] += p[2] as u64;
                n += 1;
            } else {
                cut = true;
            }
        }
        let layer = inner.layers;
        inner.rgba.extend_from_slice(tile.as_raw());
        inner.layers += 1;
        let avg = if n > 0 { [(sum[0] / n) as u8, (sum[1] / n) as u8, (sum[2] / n) as u8] } else { [128, 128, 128] };
        inner.per_layer.push((avg, if cut { Alpha::Cutout } else { Alpha::Opaque }));
        let info = TexInfo { layer, frames: 1, frametime: 1, alpha: if cut { Alpha::Cutout } else { Alpha::Opaque }, avg, emissive: false };
        inner.by_name.insert(name.to_string(), info.clone());
        info
    }

    pub fn layer_info(&self, layer: u16) -> ([u8; 3], Alpha) {
        self.inner.lock().per_layer.get(layer as usize).copied().unwrap_or(([128, 128, 128], Alpha::Opaque))
    }

    /// What each layer holds: (texture name, frame index). Virtual layers are named "tex#x,y,w,h".
    pub fn layer_names(&self) -> Vec<(String, u16)> {
        let inner = self.inner.lock();
        let mut out = vec![(String::from("missing"), 0u16); inner.layers as usize];
        for (name, info) in &inner.by_name {
            for f in 0..info.frames {
                if let Some(slot) = out.get_mut(info.layer as usize + f as usize) {
                    *slot = (name.clone(), f);
                }
            }
        }
        out
    }

    pub fn layer_count(&self) -> u16 {
        self.inner.lock().layers
    }

    /// Snapshot of the packed RGBA layers.
    pub fn rgba(&self) -> Vec<u8> {
        self.inner.lock().rgba.clone()
    }

    /// Per-layer animation table: for each layer that starts a texture, [frames, frametime]; others [1,1].
    pub fn anim_table(&self) -> Vec<[u16; 2]> {
        let inner = self.inner.lock();
        let mut t = vec![[1u16, 1u16]; inner.layers as usize];
        for info in inner.by_name.values() {
            if (info.layer as usize) < t.len() && info.frames > 1 {
                t[info.layer as usize] = [info.frames, info.frametime];
            }
        }
        t
    }
}
