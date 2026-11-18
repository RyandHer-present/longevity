//! Map tiles: one 512x512 image per region (1 pixel per block) in two styles, plus a coarse
//! height + color grid used for the distant terrain in 3D. Unseen chunks are left transparent.

use mcassets::{Alpha, Assets};
use mcworld::{Dim, World};
use std::collections::HashSet;

pub struct RegionData {
    /// top block Y per column (i16::MIN where unseen), 512*512
    pub heights: Vec<i16>,
    /// RGBA color per column
    pub color: Vec<[u8; 4]>,
    /// water depth per column (0 = dry)
    pub water: Vec<u8>,
    /// 1 where the top block is foliage
    pub leafy: Vec<u8>,
}

fn mul(c: [u8; 3], t: [u8; 3]) -> [u8; 3] {
    [(c[0] as u32 * t[0] as u32 / 255) as u8, (c[1] as u32 * t[1] as u32 / 255) as u8, (c[2] as u32 * t[2] as u32 / 255) as u8]
}

fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

pub fn region_data(world: &World, assets: &Assets, dim: Dim, rx: i32, rz: i32, seen: &HashSet<(i32, i32)>) -> RegionData {
    use rayon::prelude::*;
    let n = 512 * 512;
    let mut d = RegionData { heights: vec![i16::MIN; n], color: vec![[0, 0, 0, 0]; n], water: vec![0; n], leafy: vec![0; n] };
    let Some(reg) = world.region(dim, rx, rz) else { return d };
    let coords: Vec<(usize, usize)> = (0..32).flat_map(|lz| (0..32).map(move |lx| (lx, lz))).filter(|&(lx, lz)| seen.contains(&(rx * 32 + lx as i32, rz * 32 + lz as i32)) && reg.has(lx, lz)).collect();
    let cols: Vec<((usize, usize), Vec<(i16, [u8; 4], u8, u8)>)> = coords
        .par_iter()
        .filter_map(|&(lx, lz)| {
            let c = World::chunk_uncached(&reg, lx, lz)?;
            let mut out = Vec::with_capacity(256);
            let top_y = c.max_y();
            for z in 0..16usize {
                for x in 0..16usize {
                    let start = c.surface.as_ref().map(|s| s[z * 16 + x]).filter(|v| *v > -1000).unwrap_or(top_y).min(top_y);
                    let mut y = start;
                    if dim == Dim::Nether {
                        // look below the bedrock roof: skip down to the first air under it, then find the floor
                        y = start.min(118);
                        while y > 0 {
                            match c.block(x, y, z) {
                                Some(b) if !b.is_air() => y -= 1,
                                _ => break,
                            }
                        }
                    }
                    let mut water_depth = 0u8;
                    let mut water_tint = [0u8; 3];
                    let mut found: Option<(i32, [u8; 3], bool)> = None;
                    while y >= c.min_section * 16 {
                        let Some(b) = c.block(x, y, z) else {
                            y -= 1;
                            continue;
                        };
                        if b.is_air() {
                            y -= 1;
                            continue;
                        }
                        let st = assets.models.state(b);
                        let is_water = matches!(st.fluid, Some(mcassets::Fluid::Water { .. })) && (st.name == "minecraft:water" || st.map_top < 0.5);
                        if is_water {
                            if water_depth == 0 {
                                let biome = c.section(y >> 4).map(|s| s.biome_at(x, (y & 15) as usize, z).to_string()).unwrap_or_default();
                                water_tint = assets.colors.water(&biome);
                            }
                            water_depth = water_depth.saturating_add(1);
                            if water_depth > 24 {
                                found = Some((y, mul(st.map_color, water_tint), false));
                                break;
                            }
                            y -= 1;
                            continue;
                        }
                        let leaves = st.name.ends_with("_leaves");
                        if !(st.solid || leaves || st.fluid.is_some() || st.map_top >= 0.5) || st.map_alpha == Alpha::Translucent && !st.solid {
                            y -= 1;
                            continue;
                        }
                        let mut col = st.map_color;
                        if st.map_tinted {
                            let biome = c.section(y >> 4).map(|s| s.biome_at(x, (y & 15) as usize, z).to_string()).unwrap_or_default();
                            let wx = (c.x * 16 + x as i32) as i32;
                            let wz = (c.z * 16 + z as i32) as i32;
                            col = mul(col, assets.colors.tint(st.tint, &biome, wx, wz));
                        }
                        found = Some((y, col, leaves));
                        break;
                    }
                    let (h, col, leaves) = found.unwrap_or((c.min_section * 16, [20, 20, 20], false));
                    let mut rgb = [col[0] as f32, col[1] as f32, col[2] as f32];
                    if water_depth > 0 {
                        let wt = mul(assets.tex.peek_avg("block/water_still").map(|a| a.0).unwrap_or([60, 90, 200]), water_tint);
                        let w = [wt[0] as f32, wt[1] as f32, wt[2] as f32];
                        let t = (0.55 + water_depth as f32 * 0.035).min(0.93);
                        rgb = lerp3(rgb, w, t);
                    }
                    let surf = if water_depth > 0 { h + water_depth as i32 } else { h };
                    out.push((surf.clamp(-32000, 32000) as i16, [rgb[0] as u8, rgb[1] as u8, rgb[2] as u8, 255], water_depth, leaves as u8));
                }
            }
            Some(((lx, lz), out))
        })
        .collect();
    for ((lx, lz), cols) in cols {
        for z in 0..16 {
            for x in 0..16 {
                let (h, c, w, l) = cols[z * 16 + x];
                let i = (lz * 16 + z) * 512 + lx * 16 + x;
                d.heights[i] = h;
                d.color[i] = c;
                d.water[i] = w;
                d.leafy[i] = l;
            }
        }
    }
    d
}

/// Real-color tile with relief shading (like an in-game map, but smoother).
pub fn render_color(d: &RegionData) -> image::RgbaImage {
    let mut img = image::RgbaImage::new(512, 512);
    for z in 0..512usize {
        for x in 0..512usize {
            let i = z * 512 + x;
            let h = d.heights[i];
            if h == i16::MIN {
                continue;
            }
            let hn = if z > 0 && d.heights[i - 512] != i16::MIN { d.heights[i - 512] } else { h };
            let hw = if x > 0 && d.heights[i - 1] != i16::MIN { d.heights[i - 1] } else { h };
            let c = d.color[i];
            let shade = if d.water[i] > 0 {
                1.0
            } else {
                let diff = (h as f32 - hn as f32) * 0.7 + (h as f32 - hw as f32) * 0.35;
                (1.0 + diff.clamp(-5.0, 5.0) * 0.055).clamp(0.62, 1.25)
            };
            let px = image::Rgba([
                (c[0] as f32 * shade).clamp(0.0, 255.0) as u8,
                (c[1] as f32 * shade).clamp(0.0, 255.0) as u8,
                (c[2] as f32 * shade).clamp(0.0, 255.0) as u8,
                255,
            ]);
            img.put_pixel(x as u32, z as u32, px);
        }
    }
    img
}

fn hash2(x: i32, z: i32) -> f32 {
    let mut n = (x as u32).wrapping_mul(374761393) ^ (z as u32).wrapping_mul(668265263);
    n = (n ^ (n >> 13)).wrapping_mul(1274126177);
    ((n ^ (n >> 16)) & 0xffff) as f32 / 65535.0
}

/// Old-parchment survey style: ink contours every 8 blocks, hatched water, stippled woods.
pub fn render_parchment(d: &RegionData, rx: i32, rz: i32) -> image::RgbaImage {
    let mut img = image::RgbaImage::new(512, 512);
    let paper = [233.0, 219.0, 186.0];
    let ink = [74.0, 52.0, 34.0];
    let water_ink = [96.0, 112.0, 120.0];
    for z in 0..512usize {
        for x in 0..512usize {
            let i = z * 512 + x;
            let h = d.heights[i];
            if h == i16::MIN {
                continue;
            }
            let wx = rx * 512 + x as i32;
            let wz = rz * 512 + z as i32;
            let grain = hash2(wx, wz) * 0.06 - 0.03 + (hash2(wx / 7, wz / 7) - 0.5) * 0.05;
            let mut c = paper;
            // gentle relief wash
            let hn = if z > 0 && d.heights[i - 512] != i16::MIN { d.heights[i - 512] } else { h };
            let relief = ((h as f32 - hn as f32) * 0.04).clamp(-0.12, 0.12);
            let alt = ((h as f32 - 62.0) / 140.0).clamp(-0.3, 0.6);
            c = lerp3(c, [205.0, 182.0, 140.0], alt.max(0.0));
            if d.water[i] > 0 {
                c = lerp3(paper, [178.0, 190.0, 186.0], 0.55 + (d.water[i] as f32 * 0.02).min(0.3));
                // horizontal hatching
                if (wz.rem_euclid(4)) == 0 && hash2(wx / 3, wz) > 0.25 {
                    c = lerp3(c, water_ink, 0.45);
                }
                // shoreline
                let shore = [(1i32, 0i32), (-1, 0), (0, 1), (0, -1)].iter().any(|(dx, dz)| {
                    let (nx, nz) = (x as i32 + dx, z as i32 + dz);
                    if !(0..512).contains(&nx) || !(0..512).contains(&nz) {
                        return false;
                    }
                    let j = nz as usize * 512 + nx as usize;
                    d.heights[j] != i16::MIN && d.water[j] == 0
                });
                if shore {
                    c = lerp3(c, ink, 0.75);
                }
            } else {
                if d.leafy[i] == 1 && hash2(wx, wz) > 0.72 {
                    c = lerp3(c, [92.0, 98.0, 60.0], 0.55);
                }
                // contour lines
                let band = (h as i32).div_euclid(8);
                let edge = [(1i32, 0i32), (0, 1)].iter().any(|(dx, dz)| {
                    let (nx, nz) = (x as i32 + dx, z as i32 + dz);
                    if nx >= 512 || nz >= 512 {
                        return false;
                    }
                    let j = nz as usize * 512 + nx as usize;
                    d.heights[j] != i16::MIN && d.water[j] == 0 && (d.heights[j] as i32).div_euclid(8) != band
                });
                if edge {
                    let major = band.rem_euclid(4) == 0;
                    c = lerp3(c, ink, if major { 0.7 } else { 0.38 });
                }
            }
            let f = 1.0 + grain + relief;
            img.put_pixel(x as u32, z as u32, image::Rgba([(c[0] * f).clamp(0.0, 255.0) as u8, (c[1] * f).clamp(0.0, 255.0) as u8, (c[2] * f).clamp(0.0, 255.0) as u8, 255]));
        }
    }
    img
}

/// Coarse grid for distant terrain: 128x128 samples (every 4 blocks): i16 height then RGB.
pub fn lod_bytes(d: &RegionData) -> Vec<u8> {
    let mut out = Vec::with_capacity(128 * 128 * 5);
    for z in 0..128usize {
        for x in 0..128usize {
            // highest of the 4x4 block (keeps silhouettes), color averaged
            let mut h = i16::MIN;
            for dz in 0..4 {
                for dx in 0..4 {
                    h = h.max(d.heights[(z * 4 + dz) * 512 + x * 4 + dx]);
                }
            }
            out.extend_from_slice(&h.to_le_bytes());
        }
    }
    for z in 0..128usize {
        for x in 0..128usize {
            let mut acc = [0u32; 3];
            let mut n = 0;
            for dz in 0..4 {
                for dx in 0..4 {
                    let c = d.color[(z * 4 + dz) * 512 + x * 4 + dx];
                    if c[3] > 0 {
                        acc[0] += c[0] as u32;
                        acc[1] += c[1] as u32;
                        acc[2] += c[2] as u32;
                        n += 1;
                    }
                }
            }
            let n = n.max(1);
            out.extend_from_slice(&[(acc[0] / n) as u8, (acc[1] / n) as u8, (acc[2] / n) as u8]);
        }
    }
    out
}

pub fn png_bytes(img: &image::RgbaImage) -> Vec<u8> {
    let mut out = Vec::new();
    let _ = img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png);
    out
}
