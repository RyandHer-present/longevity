//! Item icons: flat item textures (composited layers) or a small isometric render of the block model,
//! drawn with a tiny software rasterizer so search results look like the inventory.

use crate::model::{Quad, Tint};
use crate::Assets;
use blockdata::BlockState;
use image::{Rgba, RgbaImage};

fn tex_rgba(assets: &Assets, name: &str) -> Option<RgbaImage> {
    let n = name.strip_prefix("minecraft:").unwrap_or(name);
    let bytes = assets.jar.get(&format!("textures/{n}.png"))?;
    let img = image::load_from_memory(bytes).ok()?.to_rgba8();
    // animated strips: take the first square frame
    let (w, h) = img.dimensions();
    if h > w && h % w == 0 {
        return Some(image::imageops::crop_imm(&img, 0, 0, w, w).to_image());
    }
    Some(img)
}

fn layer_tints(assets: &Assets, item: &str) -> Vec<Option<[u8; 3]>> {
    let short = item.trim_start_matches("minecraft:");
    let Some(def) = assets.jar.json(&format!("items/{short}.json")) else { return vec![] };
    let Some(tints) = def.pointer("/model/tints").and_then(|t| t.as_array()) else { return vec![] };
    tints
        .iter()
        .map(|t| {
            let v = t.get("default").or_else(|| t.get("value")).and_then(|v| v.as_i64())?;
            let v = v as u32;
            Some([(v >> 16) as u8, (v >> 8) as u8, v as u8])
        })
        .collect()
}

fn flat_icon(assets: &Assets, layers: &[String], tints: &[Option<[u8; 3]>], size: u32) -> Option<RgbaImage> {
    let mut out: Option<RgbaImage> = None;
    for (i, l) in layers.iter().enumerate() {
        let Some(mut img) = tex_rgba(assets, l) else { continue };
        if let Some(Some(t)) = tints.get(i) {
            for p in img.pixels_mut() {
                p[0] = (p[0] as u32 * t[0] as u32 / 255) as u8;
                p[1] = (p[1] as u32 * t[1] as u32 / 255) as u8;
                p[2] = (p[2] as u32 * t[2] as u32 / 255) as u8;
            }
        }
        let img = image::imageops::resize(&img, size, size, image::imageops::FilterType::Nearest);
        match &mut out {
            None => out = Some(img),
            Some(o) => image::imageops::overlay(o, &img, 0, 0),
        }
    }
    out
}

fn sample(layer: &[u8], u: f32, v: f32) -> [u8; 4] {
    let x = ((u.clamp(0.0, 0.9999)) * 16.0) as usize;
    let y = ((v.clamp(0.0, 0.9999)) * 16.0) as usize;
    let i = (y * 16 + x) * 4;
    [layer[i], layer[i + 1], layer[i + 2], layer[i + 3]]
}

/// Isometric render of quads (block-local 0..1) the way blocks look in the inventory.
pub fn render_quads(assets: &Assets, quads: &[Quad], size: u32) -> RgbaImage {
    let ss = 3u32; // supersampling
    let s = size * ss;
    let mut color = vec![[0f32; 4]; (s * s) as usize];
    let mut depth = vec![f32::MIN; (s * s) as usize];
    let rgba = assets.tex.rgba();
    let (ry, rx) = (225f32.to_radians(), 30f32.to_radians());
    let rot = |p: [f32; 3]| -> [f32; 3] {
        let (x, y, z) = (p[0] - 0.5, p[1] - 0.5, p[2] - 0.5);
        let (sy, cy) = ry.sin_cos();
        let (x1, z1) = (x * cy + z * sy, -x * sy + z * cy);
        let (sx, cx) = rx.sin_cos();
        let (y2, z2) = (y * cx - z1 * sx, y * sx + z1 * cx);
        [x1, y2, z2]
    };
    let scale = 0.625 * 1.02;
    for q in quads {
        let n = rot([q.normal[0] + 0.5, q.normal[1] + 0.5, q.normal[2] + 0.5]);
        if n[2] < -1e-3 {
            continue;
        }
        let shade = if !q.shade {
            1.0
        } else if n[1] > 0.5 {
            1.0
        } else if n[0] < 0.0 {
            0.8
        } else {
            0.62
        };
        let pts: Vec<[f32; 3]> = q.pos.iter().map(|p| rot(*p)).map(|p| [(p[0] * scale + 0.5) * s as f32, (-p[1] * scale + 0.5) * s as f32, p[2]]).collect();
        let lay = q.tex as usize * 1024;
        if lay + 1024 > rgba.len() {
            continue;
        }
        let layer = &rgba[lay..lay + 1024];
        let tri = |a: usize, b: usize, c: usize, color: &mut Vec<[f32; 4]>, depth: &mut Vec<f32>, tintc: Option<[u8; 3]>| {
            let (p0, p1, p2) = (pts[a], pts[b], pts[c]);
            let (t0, t1, t2) = (q.uv[a], q.uv[b], q.uv[c]);
            let minx = p0[0].min(p1[0]).min(p2[0]).floor().max(0.0) as i32;
            let maxx = p0[0].max(p1[0]).max(p2[0]).ceil().min(s as f32 - 1.0) as i32;
            let miny = p0[1].min(p1[1]).min(p2[1]).floor().max(0.0) as i32;
            let maxy = p0[1].max(p1[1]).max(p2[1]).ceil().min(s as f32 - 1.0) as i32;
            let area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
            if area.abs() < 1e-6 {
                return;
            }
            for y in miny..=maxy {
                for x in minx..=maxx {
                    let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
                    let w0 = ((p1[0] - px) * (p2[1] - py) - (p2[0] - px) * (p1[1] - py)) / area;
                    let w1 = ((p2[0] - px) * (p0[1] - py) - (p0[0] - px) * (p2[1] - py)) / area;
                    let w2 = 1.0 - w0 - w1;
                    if w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4 {
                        continue;
                    }
                    let z = w0 * p0[2] + w1 * p1[2] + w2 * p2[2];
                    let i = (y as u32 * s + x as u32) as usize;
                    if z < depth[i] - 1e-5 {
                        continue;
                    }
                    let u = w0 * t0[0] + w1 * t1[0] + w2 * t2[0];
                    let v = w0 * t0[1] + w1 * t1[1] + w2 * t2[1];
                    let c = sample(layer, u, v);
                    if c[3] < 26 {
                        continue;
                    }
                    let mut rgb = [c[0] as f32, c[1] as f32, c[2] as f32];
                    if let Some(t) = tintc {
                        for k in 0..3 {
                            rgb[k] *= t[k] as f32 / 255.0;
                        }
                    }
                    let a = c[3] as f32 / 255.0;
                    let src = [rgb[0] * shade, rgb[1] * shade, rgb[2] * shade];
                    let dst = color[i];
                    color[i] = if a > 0.95 || dst[3] == 0.0 {
                        [src[0], src[1], src[2], a.max(dst[3])]
                    } else {
                        [src[0] * a + dst[0] * (1.0 - a), src[1] * a + dst[1] * (1.0 - a), src[2] * a + dst[2] * (1.0 - a), (a + dst[3] * (1.0 - a)).min(1.0)]
                    };
                    depth[i] = z;
                }
            }
        };
        let tintc = if q.tint >= 0 { Some(current_tint()) } else { None };
        tri(0, 1, 2, &mut color, &mut depth, tintc);
        tri(0, 2, 3, &mut color, &mut depth, tintc);
    }
    // downsample
    let mut out = RgbaImage::new(size, size);
    for y in 0..size {
        for x in 0..size {
            let mut acc = [0f32; 4];
            for dy in 0..ss {
                for dx in 0..ss {
                    let c = color[((y * ss + dy) * s + x * ss + dx) as usize];
                    acc[0] += c[0] * c[3];
                    acc[1] += c[1] * c[3];
                    acc[2] += c[2] * c[3];
                    acc[3] += c[3];
                }
            }
            let n = (ss * ss) as f32;
            let a = acc[3] / n;
            if a > 0.0 {
                out.put_pixel(x, y, Rgba([(acc[0] / acc[3]) as u8, (acc[1] / acc[3]) as u8, (acc[2] / acc[3]) as u8, (a * 255.0) as u8]));
            }
        }
    }
    out
}

fn tint_for_block(assets: &Assets, st: &BlockState) -> Option<[u8; 3]> {
    let b = assets.models.state(st);
    match b.tint {
        Tint::Grass => Some([0x91, 0xBD, 0x59]),
        Tint::Foliage => Some([0x48, 0xB5, 0x18]),
        Tint::Water => Some([0x3F, 0x76, 0xE4]),
        Tint::Fixed(c) => Some(c),
        _ => None,
    }
}

/// Render an item's icon at `size` pixels. Returns None for unknown items.
pub fn item_icon(assets: &Assets, item: &str, size: u32) -> Option<RgbaImage> {
    let id = if item.contains(':') { item.to_string() } else { format!("minecraft:{item}") };
    let short = id.trim_start_matches("minecraft:").to_string();
    let model = assets.models.item_model_name(&id);
    if let Some(m) = &model {
        if let Some(special) = m.strip_prefix("special:") {
            // chests, shulker boxes, beds, banners, heads... use the block itself if we can draw it
            let st = BlockState::new(&id);
            let baked = assets.models.state(&st);
            if baked.visible && !baked.parts.is_empty() {
                let quads: Vec<Quad> = baked.parts.iter().flat_map(|p| p[0].1.quads.clone()).collect();
                return Some(render_quads(assets, &quads, size));
            }
            if let Some(layers) = assets.models.item_layers(special) {
                return flat_icon(assets, &layers, &[], size);
            }
        } else if let Some(layers) = assets.models.item_layers(m) {
            return flat_icon(assets, &layers, &layer_tints(assets, &id), size);
        } else if assets.models.model_has_elements(m) {
            let baked = assets.models.bake_model(m.strip_prefix("minecraft:").unwrap_or(m), 0, 0, 0, false);
            let mut quads = baked.quads.clone();
            return Some(render_quads_tinted(assets, &mut quads, tint_for_block(assets, &BlockState::new(&id)), size));
        }
    }
    // the shield is drawn as a 3D model in game; cut its front face out of the entity texture
    if short == "shield" {
        for t in ["entity/shield/base_nopattern", "entity/shield_base_nopattern", "entity/shield/base", "entity/shield_base"] {
            if let Some(img) = tex_rgba(assets, t) {
                let k = img.width() / 64;
                let face = image::imageops::crop_imm(&img, k, k, 12 * k, 22 * k).to_image();
                let mut sq = RgbaImage::new(22 * k, 22 * k);
                image::imageops::overlay(&mut sq, &face, (5 * k) as i64, 0);
                return Some(image::imageops::resize(&sq, size, size, image::imageops::FilterType::Nearest));
            }
        }
    }
    for cand in [format!("item/{short}"), format!("block/{short}")] {
        if let Some(img) = tex_rgba(assets, &cand) {
            return Some(image::imageops::resize(&img, size, size, image::imageops::FilterType::Nearest));
        }
    }
    None
}

fn render_quads_tinted(assets: &Assets, quads: &mut [Quad], tint: Option<[u8; 3]>, size: u32) -> RgbaImage {
    // render_quads applies the default grass tint to tinted faces; swap in the block's own tint color
    match tint {
        None => {
            for q in quads.iter_mut() {
                q.tint = -1;
            }
            render_quads(assets, quads, size)
        }
        Some(t) => render_with_color(assets, quads, t, size),
    }
}

fn render_with_color(assets: &Assets, quads: &[Quad], t: [u8; 3], size: u32) -> RgbaImage {
    TINT.with(|c| c.set(t));
    let img = render_quads(assets, quads, size);
    TINT.with(|c| c.set([0x91, 0xBD, 0x59]));
    img
}

thread_local! {
    static TINT: std::cell::Cell<[u8; 3]> = const { std::cell::Cell::new([0x91, 0xBD, 0x59]) };
}

pub fn current_tint() -> [u8; 3] {
    TINT.with(|c| c.get())
}
