//! Chunk mesher: turns a chunk column (plus its neighbors) into compact vertex buffers.
//!
//! Vertex layout (per vertex, struct-of-arrays):
//! * pos    i16 x3  — x/z relative to the chunk origin, y absolute; units of 1/64 block
//! * uv     u16 x2  — 0..65535 within the texture layer
//! * layer  u16     — first texture-array layer (animation frames follow)
//! * color  u8 x4   — biome/block tint rgb + ambient occlusion (255 = none)
//! * extra  u8 x4   — flags, sky light (0..255), block light (0..255), reserved
//!
//! flags: bits 0-2 face (Dir), 3 no-shade, 4 emissive, 5 water, 6 plant sway, 7 leaf sway

use blockdata::{BlockSource, BlockState, Section};
use mcassets::{Alpha, Assets, BakedState, Dir, Fluid, Tint};
use std::collections::HashMap;
use std::sync::Arc;

pub const POS_SCALE: f32 = 64.0;

pub trait MeshSource: BlockSource {
    /// Sky and block light nibble arrays (2048 bytes) for a section, if the save has them.
    fn light(&self, _cx: i32, _sy: i32, _cz: i32) -> (Option<&[u8]>, Option<&[u8]>) {
        (None, None)
    }
}

#[derive(Default, Clone)]
pub struct MeshBuf {
    pub pos: Vec<i16>,
    pub uv: Vec<u16>,
    pub layer: Vec<u16>,
    pub color: Vec<u8>,
    pub extra: Vec<u8>,
}

impl MeshBuf {
    pub fn quads(&self) -> usize {
        self.layer.len() / 4
    }
    fn write(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&(self.quads() as u32).to_le_bytes());
        for v in &self.pos {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for v in &self.uv {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for v in &self.layer {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&self.color);
        out.extend_from_slice(&self.extra);
    }
}

#[derive(Default, Clone)]
pub struct ChunkMesh {
    pub cx: i32,
    pub cz: i32,
    pub opaque: MeshBuf,
    pub translucent: MeshBuf,
    pub min_y: i32,
    pub max_y: i32,
}

impl ChunkMesh {
    /// Binary form: "CMSH", cx, cz, minY, maxY (i32 LE), then the opaque and translucent buffers.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(32 + (self.opaque.quads() + self.translucent.quads()) * 4 * 20);
        out.extend_from_slice(b"CMSH");
        for v in [self.cx, self.cz, self.min_y, self.max_y] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        self.opaque.write(&mut out);
        self.translucent.write(&mut out);
        out
    }
    pub fn is_empty(&self) -> bool {
        self.opaque.quads() == 0 && self.translucent.quads() == 0
    }
}

#[derive(Clone, Copy, Debug)]
pub struct MeshOptions {
    /// Leave out faces that only touch completely dark air (caves you can't see from outside).
    pub skip_dark: bool,
    /// Lowest world Y to mesh (for cutaway views).
    pub min_y: i32,
    /// Highest world Y to mesh.
    pub max_y: i32,
}

impl Default for MeshOptions {
    fn default() -> Self {
        MeshOptions { skip_dark: false, min_y: -100000, max_y: 100000 }
    }
}

const P: i32 = 18; // padded width
const AIR: u16 = 0;

struct Cache<'a> {
    src: &'a dyn MeshSource,
    assets: &'a Assets,
    cx: i32,
    cz: i32,
    min_y: i32, // world y of cache row 1
    h: i32,
    ids: Vec<u16>,
    light: Vec<u8>, // sky<<4 | block
    states: Vec<Arc<BakedState>>,
    tints: HashMap<(i32, i32, i32, u8), [u8; 3]>,
}

impl<'a> Cache<'a> {
    #[inline]
    fn idx(&self, x: i32, y: i32, z: i32) -> Option<usize> {
        let yy = y - self.min_y + 1;
        if !(-1..=16).contains(&x) || !(-1..=16).contains(&z) || yy < 0 || yy >= self.h {
            return None;
        }
        Some(((yy * P + (z + 1)) * P + (x + 1)) as usize)
    }
    #[inline]
    fn state(&self, x: i32, y: i32, z: i32) -> &BakedState {
        match self.idx(x, y, z) {
            Some(i) => &self.states[self.ids[i] as usize],
            None => &self.states[0],
        }
    }
    #[inline]
    fn id(&self, x: i32, y: i32, z: i32) -> u16 {
        self.idx(x, y, z).map(|i| self.ids[i]).unwrap_or(AIR)
    }
    #[inline]
    fn light(&self, x: i32, y: i32, z: i32) -> (u8, u8) {
        match self.idx(x, y, z) {
            Some(i) => {
                let l = self.light[i];
                (l >> 4, l & 15)
            }
            None => (15, 0),
        }
    }

    fn build(src: &'a dyn MeshSource, assets: &'a Assets, cx: i32, cz: i32) -> Cache<'a> {
        let (smin, smax) = src.section_range();
        let min_y = smin * 16;
        let h = (smax - smin + 1) * 16 + 2;
        let n = (P * P * h) as usize;
        let mut c = Cache { src, assets, cx, cz, min_y, h, ids: vec![AIR; n], light: vec![0xF0; n], states: vec![assets.models.state(&BlockState::new("air"))], tints: HashMap::new() };
        let mut lookup: HashMap<BlockState, u16> = HashMap::new();
        let ns = (smax - smin + 1) as usize;
        let mut has_sky = vec![true; ns * 9];
        for dz in -1..=1 {
            for dx in -1..=1 {
                let (xs, xe) = match dx {
                    -1 => (15, 16),
                    0 => (0, 16),
                    _ => (0, 1),
                };
                let (zs, ze) = match dz {
                    -1 => (15, 16),
                    0 => (0, 16),
                    _ => (0, 1),
                };
                for sy in smin..=smax {
                    let Some(sec) = src.section(cx + dx, sy, cz + dz) else { continue };
                    let local: Vec<u16> = sec
                        .palette
                        .iter()
                        .map(|st| {
                            if let Some(id) = lookup.get(st) {
                                return *id;
                            }
                            let id = c.states.len() as u16;
                            c.states.push(assets.models.state(st));
                            lookup.insert(st.clone(), id);
                            id
                        })
                        .collect();
                    let (sky, blk) = src.light(cx + dx, sy, cz + dz);
                    if sky.map(|a| a.len() != 2048).unwrap_or(true) {
                        has_sky[((sy - smin) * 9 + (dz + 1) * 3 + (dx + 1)) as usize] = false;
                    }
                    for y in 0..16 {
                        for z in zs..ze {
                            for x in xs..xe {
                                let si = Section::index(x as usize, y as usize, z as usize);
                                let Some(ci) = c.idx(x + dx * 16, sy * 16 + y, z + dz * 16) else { continue };
                                c.ids[ci] = local[sec.data[si] as usize];
                                let s = match sky {
                                    Some(a) if a.len() == 2048 => {
                                        let b = a[si >> 1];
                                        if si & 1 == 0 { b & 15 } else { b >> 4 }
                                    }
                                    _ => 15,
                                };
                                let bl = match blk {
                                    Some(a) if a.len() == 2048 => {
                                        let b = a[si >> 1];
                                        if si & 1 == 0 { b & 15 } else { b >> 4 }
                                    }
                                    _ => 0,
                                };
                                c.light[ci] = (s << 4) | bl;
                            }
                        }
                    }
                }
            }
        }
        // Sections without saved sky light: derive it from the column (open sky above the top block).
        if has_sky.iter().any(|h| !h) {
            for z in -1..=16 {
                for x in -1..=16 {
                    let dx = if x < 0 { -1 } else if x > 15 { 1 } else { 0 };
                    let dz = if z < 0 { -1 } else if z > 15 { 1 } else { 0 };
                    let mut top = i32::MIN;
                    let mut y = min_y + h - 3;
                    while y >= min_y {
                        let st = c.state(x, y, z);
                        if st.solid || st.fluid.is_some() || (st.visible && !st.is_air && st.map_alpha != Alpha::Translucent && st.occludes != 0) {
                            top = y;
                            break;
                        }
                        y -= 1;
                    }
                    for sy in smin..=smax {
                        if has_sky[((sy - smin) * 9 + (dz + 1) * 3 + (dx + 1)) as usize] {
                            continue;
                        }
                        for yy in 0..16 {
                            let wy = sy * 16 + yy;
                            if let Some(ci) = c.idx(x, wy, z) {
                                let s = if wy > top { 15 } else if wy > top - 3 { 7 } else { 0 };
                                c.light[ci] = (s << 4) | (c.light[ci] & 15);
                            }
                        }
                    }
                }
            }
        }
        // emissive blocks light their own cell for faces that sample it
        for i in 0..c.ids.len() {
            if c.states[c.ids[i] as usize].emissive {
                c.light[i] = (c.light[i] & 0xF0) | 15;
            }
        }
        c
    }

    fn biome(&self, x: i32, y: i32, z: i32) -> String {
        let wx = self.cx * 16 + x;
        let wz = self.cz * 16 + z;
        match self.src.section(wx >> 4, y >> 4, wz >> 4) {
            Some(s) => s.biome_at((wx & 15) as usize, (y & 15) as usize, (wz & 15) as usize).to_string(),
            None => match self.src.section(self.cx, y >> 4, self.cz) {
                Some(s) => s.biome_at((x.clamp(0, 15)) as usize, (y & 15) as usize, (z.clamp(0, 15)) as usize).to_string(),
                None => "minecraft:plains".into(),
            },
        }
    }

    fn tint(&mut self, t: Tint, x: i32, y: i32, z: i32) -> [u8; 3] {
        let kind = match t {
            Tint::None => return [255, 255, 255],
            Tint::Fixed(c) => return c,
            Tint::Redstone(_) => return self.assets.colors.tint(t, "", 0, 0),
            Tint::Grass => 0u8,
            Tint::Foliage => 1,
            Tint::DryFoliage => 2,
            Tint::Water => 3,
        };
        let key = (x, z, y >> 2, kind);
        if let Some(c) = self.tints.get(&key) {
            return *c;
        }
        let mut acc = [0u32; 3];
        let mut n = 0;
        for dz in [-2, 0, 2] {
            for dx in [-2, 0, 2] {
                let b = self.biome(x + dx, y, z + dz);
                let c = self.assets.colors.tint(t, &b, self.cx * 16 + x + dx, self.cz * 16 + z + dz);
                acc[0] += c[0] as u32;
                acc[1] += c[1] as u32;
                acc[2] += c[2] as u32;
                n += 1;
            }
        }
        let c = [(acc[0] / n) as u8, (acc[1] / n) as u8, (acc[2] / n) as u8];
        self.tints.insert(key, c);
        c
    }
}

fn axis(d: Dir) -> usize {
    match d {
        Dir::Up | Dir::Down => 1,
        Dir::North | Dir::South => 2,
        Dir::West | Dir::East => 0,
    }
}

fn tangents(d: Dir) -> (usize, usize) {
    match axis(d) {
        1 => (0, 2),
        0 => (1, 2),
        _ => (0, 1),
    }
}

#[allow(clippy::too_many_arguments)]
fn emit(buf: &mut MeshBuf, pos: [[f32; 3]; 4], uv: [[f32; 2]; 4], layer: u16, tint: [u8; 3], ao: [u8; 4], flags: u8, sky: [u8; 4], blk: [u8; 4]) {
    for i in 0..4 {
        buf.pos.push((pos[i][0] * POS_SCALE).round() as i16);
        buf.pos.push((pos[i][1] * POS_SCALE).round().clamp(-32768.0, 32767.0) as i16);
        buf.pos.push((pos[i][2] * POS_SCALE).round() as i16);
        buf.uv.push((uv[i][0].clamp(0.0, 1.0) * 65535.0).round() as u16);
        buf.uv.push((uv[i][1].clamp(0.0, 1.0) * 65535.0).round() as u16);
        buf.layer.push(layer);
        buf.color.extend_from_slice(&[tint[0], tint[1], tint[2], ao[i]]);
        buf.extra.extend_from_slice(&[flags, sky[i], blk[i], 0]);
    }
}

const AO_CURVE: [u8; 4] = [115, 160, 208, 255];

pub fn is_leaves(name: &str) -> bool {
    name.ends_with("_leaves")
}

pub fn is_plant(name: &str) -> bool {
    let n = name.trim_start_matches("minecraft:");
    matches!(
        n,
        "short_grass" | "tall_grass" | "fern" | "large_fern" | "dandelion" | "poppy" | "blue_orchid" | "allium" | "azure_bluet" | "red_tulip" | "orange_tulip"
            | "white_tulip" | "pink_tulip" | "oxeye_daisy" | "cornflower" | "lily_of_the_valley" | "sunflower" | "lilac" | "rose_bush" | "peony"
            | "wheat" | "carrots" | "potatoes" | "beetroots" | "sugar_cane" | "sweet_berry_bush" | "seagrass" | "tall_seagrass" | "kelp" | "kelp_plant"
            | "bush" | "short_dry_grass" | "tall_dry_grass" | "firefly_bush" | "torchflower" | "pitcher_plant" | "dead_bush" | "vine" | "glow_lichen"
            | "hanging_roots" | "spore_blossom" | "cave_vines" | "cave_vines_plant" | "weeping_vines" | "twisting_vines" | "pink_petals" | "wildflowers"
    )
}

/// Mesh one chunk column. `src` must be able to return the 3x3 neighborhood of sections.
pub fn mesh_chunk(src: &dyn MeshSource, assets: &Assets, cx: i32, cz: i32, opts: &MeshOptions) -> ChunkMesh {
    let mut cache = Cache::build(src, assets, cx, cz);
    let (smin, smax) = src.section_range();
    let mut out = ChunkMesh { cx, cz, min_y: i32::MAX, max_y: i32::MIN, ..Default::default() };
    let mut models = Vec::new();
    let name_flags: Vec<u8> = cache.states.iter().map(|s| (if is_leaves(&s.name) { 1u8 << 7 } else { 0 }) | (if is_plant(&s.name) { 1u8 << 6 } else { 0 })).collect();
    for sy in smin..=smax {
        let Some(sec) = src.section(cx, sy, cz) else { continue };
        if sec.is_all_air() {
            continue;
        }
        let y0 = (sy * 16).max(opts.min_y);
        let y1 = (sy * 16 + 15).min(opts.max_y);
        for y in y0..=y1 {
            for z in 0..16 {
                for x in 0..16 {
                    let id = cache.id(x, y, z);
                    if id == AIR {
                        continue;
                    }
                    let b = cache.states[id as usize].clone();
                    if !b.visible {
                        continue;
                    }
                    let wx = cx * 16 + x;
                    let wz = cz * 16 + z;
                    let mut emitted = false;
                    if !b.parts.is_empty() {
                        b.models_at(wx, y, wz, &mut models);
                        let off = b.offset_at(wx, wz);
                        let nflags = name_flags[id as usize];
                        for m in models.iter() {
                            for q in &m.quads {
                                if let Some(d) = q.cull {
                                    let o = d.offset();
                                    let n = cache.state(x + o[0], y + o[1], z + o[2]);
                                    if n.occludes & d.opposite().bit() != 0 {
                                        continue;
                                    }
                                    if b.cull_same && n.kind == b.kind {
                                        continue;
                                    }
                                }
                                let axis_aligned = q.normal.iter().any(|c| c.abs() > 0.999);
                                let d = q.face;
                                let o = d.offset();
                                let ax = axis(d);
                                let on_boundary = axis_aligned && {
                                    let plane = if o[ax] > 0 { 1.0 } else { 0.0 };
                                    q.pos.iter().all(|p| (p[ax] - plane).abs() < 1e-3)
                                };
                                let base = if on_boundary { [x + o[0], y + o[1], z + o[2]] } else { [x, y, z] };
                                let (bs, bb) = cache.light(base[0], base[1], base[2]);
                                if opts.skip_dark && bs == 0 && bb == 0 && !q.emissive && (on_boundary || q.cull.is_some()) {
                                    continue;
                                }
                                let mut sky = [0u8; 4];
                                let mut blk = [0u8; 4];
                                let mut ao = [255u8; 4];
                                if axis_aligned {
                                    let (t1, t2) = tangents(d);
                                    for i in 0..4 {
                                        let v = q.pos[i];
                                        let s1 = if v[t1] > 0.5 { 1 } else { -1 };
                                        let s2 = if v[t2] > 0.5 { 1 } else { -1 };
                                        let mut e1 = [0i32; 3];
                                        e1[t1] = s1;
                                        let mut e2 = [0i32; 3];
                                        e2[t2] = s2;
                                        let p1 = [base[0] + e1[0], base[1] + e1[1], base[2] + e1[2]];
                                        let p2 = [base[0] + e2[0], base[1] + e2[1], base[2] + e2[2]];
                                        let pc = [p1[0] + e2[0], p1[1] + e2[1], p1[2] + e2[2]];
                                        let o1 = cache.state(p1[0], p1[1], p1[2]).solid;
                                        let o2 = cache.state(p2[0], p2[1], p2[2]).solid;
                                        let oc = cache.state(pc[0], pc[1], pc[2]).solid;
                                        let a = if o1 && o2 { 0 } else { 3 - (o1 as usize + o2 as usize + oc as usize) };
                                        ao[i] = if m.ao && q.shade { AO_CURVE[a] } else { 255 };
                                        let (mut ss, mut sb, mut n) = (bs as u32, bb as u32, 1u32);
                                        if !o1 {
                                            let l = cache.light(p1[0], p1[1], p1[2]);
                                            ss += l.0 as u32;
                                            sb += l.1 as u32;
                                            n += 1;
                                        }
                                        if !o2 {
                                            let l = cache.light(p2[0], p2[1], p2[2]);
                                            ss += l.0 as u32;
                                            sb += l.1 as u32;
                                            n += 1;
                                        }
                                        if !oc && !(o1 && o2) {
                                            let l = cache.light(pc[0], pc[1], pc[2]);
                                            ss += l.0 as u32;
                                            sb += l.1 as u32;
                                            n += 1;
                                        }
                                        sky[i] = ((ss * 17) / n) as u8;
                                        blk[i] = ((sb * 17) / n) as u8;
                                    }
                                } else {
                                    let (s, bl) = cache.light(x, y, z);
                                    let (s2, bl2) = cache.light(x, y + 1, z);
                                    sky = [s.max(s2) * 17; 4];
                                    blk = [bl.max(bl2) * 17; 4];
                                }
                                let tint = if q.tint >= 0 { cache.tint(b.tint, x, y, z) } else { [255, 255, 255] };
                                let mut flags = (d as u8) | nflags;
                                if !q.shade {
                                    flags |= 1 << 3;
                                }
                                if q.emissive {
                                    flags |= 1 << 4;
                                }
                                let pos = q.pos.map(|p| [p[0] + off[0] + x as f32, p[1] + off[1] + y as f32, p[2] + off[2] + z as f32]);
                                let buf = if q.alpha == Alpha::Translucent { &mut out.translucent } else { &mut out.opaque };
                                emit(buf, pos, q.uv, q.tex, tint, ao, flags, sky, blk);
                                emitted = true;
                            }
                        }
                    }
                    if let Some(f) = b.fluid {
                        emitted |= fluid(&mut cache, &mut out, f, x, y, z, opts);
                    }
                    if emitted {
                        out.min_y = out.min_y.min(y);
                        out.max_y = out.max_y.max(y + 1);
                    }
                }
            }
        }
    }
    if out.min_y > out.max_y {
        out.min_y = 0;
        out.max_y = 0;
    }
    out
}

fn same_fluid(f: Fluid, st: &BakedState) -> bool {
    matches!((f, st.fluid), (Fluid::Water { .. }, Some(Fluid::Water { .. })) | (Fluid::Lava { .. }, Some(Fluid::Lava { .. })))
}

fn own_height(f: Option<Fluid>) -> f32 {
    match f {
        Some(Fluid::Water { level }) | Some(Fluid::Lava { level }) => {
            if level >= 8 { 8.0 / 9.0 } else { (8 - level) as f32 / 9.0 }
        }
        None => 0.0,
    }
}

fn corner_height(cache: &Cache, f: Fluid, x: i32, y: i32, z: i32, cxo: i32, czo: i32) -> f32 {
    let mut sum = 0.0;
    let mut w = 0.0;
    for (dx, dz) in [(cxo - 1, czo - 1), (cxo, czo - 1), (cxo - 1, czo), (cxo, czo)] {
        let st = cache.state(x + dx, y, z + dz);
        if same_fluid(f, st) {
            if same_fluid(f, cache.state(x + dx, y + 1, z + dz)) {
                return 1.0;
            }
            let h = own_height(st.fluid);
            if h >= 0.8 {
                sum += h * 10.0;
                w += 10.0;
            } else {
                sum += h;
                w += 1.0;
            }
        } else if !st.solid {
            w += 1.0;
        }
    }
    if w == 0.0 { own_height(Some(f)) } else { sum / w }
}

fn fluid(cache: &mut Cache, out: &mut ChunkMesh, f: Fluid, x: i32, y: i32, z: i32, opts: &MeshOptions) -> bool {
    let water = matches!(f, Fluid::Water { .. });
    let layer = cache.assets.tex.get(if water { "block/water_still" } else { "block/lava_still" }).layer;
    let tint = if water { cache.tint(Tint::Water, x, y, z) } else { [255, 255, 255] };
    let flags_base = if water { 1u8 << 5 } else { 1u8 << 4 };
    let above_same = same_fluid(f, cache.state(x, y + 1, z));
    let (hnw, hsw, hse, hne) = if above_same {
        (1.0, 1.0, 1.0, 1.0)
    } else {
        (
            corner_height(cache, f, x, y, z, 0, 0),
            corner_height(cache, f, x, y, z, 0, 1),
            corner_height(cache, f, x, y, z, 1, 1),
            corner_height(cache, f, x, y, z, 1, 0),
        )
    };
    let (fx, fy, fz) = (x as f32, y as f32, z as f32);
    let mut any = false;
    let own = cache.light(x, y, z);
    let light_at = |c: &Cache, px: i32, py: i32, pz: i32| -> (u8, u8) {
        let a = c.light(px, py, pz);
        (a.0.max(own.0), a.1.max(own.1))
    };
    let target_translucent = water;
    // top
    if !above_same && !cache.state(x, y + 1, z).solid {
        let (s, b) = light_at(cache, x, y + 1, z);
        let e = 0.0015;
        let pos = [[fx, fy + hnw - e, fz], [fx, fy + hsw - e, fz + 1.0], [fx + 1.0, fy + hse - e, fz + 1.0], [fx + 1.0, fy + hne - e, fz]];
        let uv = [[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]];
        let buf = if target_translucent { &mut out.translucent } else { &mut out.opaque };
        emit(buf, pos, uv, layer, tint, [255; 4], flags_base | Dir::Up as u8, [s * 17; 4], [b * 17; 4]);
        if water {
            let rpos = [pos[0], pos[3], pos[2], pos[1]];
            let ruv = [uv[0], uv[3], uv[2], uv[1]];
            emit(&mut out.translucent, rpos, ruv, layer, tint, [255; 4], flags_base | Dir::Down as u8, [s * 17; 4], [b * 17; 4]);
        }
        any = true;
    }
    // sides
    for d in [Dir::North, Dir::South, Dir::West, Dir::East] {
        let o = d.offset();
        let n = cache.state(x + o[0], y, z + o[2]);
        if same_fluid(f, n) || n.occludes & d.opposite().bit() != 0 {
            continue;
        }
        let (s, b) = light_at(cache, x + o[0], y, z + o[2]);
        if opts.skip_dark && s == 0 && b == 0 {
            continue;
        }
        // TL, BL, BR, TR as seen from outside
        let (c, h): ([[f32; 2]; 4], [f32; 2]) = match d {
            Dir::North => ([[fx + 1.0, fz], [fx + 1.0, fz], [fx, fz], [fx, fz]], [hne, hnw]),
            Dir::South => ([[fx, fz + 1.0], [fx, fz + 1.0], [fx + 1.0, fz + 1.0], [fx + 1.0, fz + 1.0]], [hsw, hse]),
            Dir::West => ([[fx, fz], [fx, fz], [fx, fz + 1.0], [fx, fz + 1.0]], [hnw, hsw]),
            _ => ([[fx + 1.0, fz + 1.0], [fx + 1.0, fz + 1.0], [fx + 1.0, fz], [fx + 1.0, fz]], [hse, hne]),
        };
        let pos = [[c[0][0], fy + h[0], c[0][1]], [c[1][0], fy, c[1][1]], [c[2][0], fy, c[2][1]], [c[3][0], fy + h[1], c[3][1]]];
        let uv = [[0.0, 1.0 - h[0]], [0.0, 1.0], [1.0, 1.0], [1.0, 1.0 - h[1]]];
        let buf = if target_translucent { &mut out.translucent } else { &mut out.opaque };
        emit(buf, pos, uv, layer, tint, [255; 4], flags_base | d as u8, [s * 17; 4], [b * 17; 4]);
        any = true;
    }
    // bottom
    let below = cache.state(x, y - 1, z);
    if !same_fluid(f, below) && below.occludes & Dir::Up.bit() == 0 {
        let (s, b) = light_at(cache, x, y - 1, z);
        if !(opts.skip_dark && s == 0 && b == 0) {
            let pos = [[fx, fy, fz + 1.0], [fx, fy, fz], [fx + 1.0, fy, fz], [fx + 1.0, fy, fz + 1.0]];
            let uv = [[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]];
            let buf = if target_translucent { &mut out.translucent } else { &mut out.opaque };
            emit(buf, pos, uv, layer, tint, [255; 4], flags_base | Dir::Down as u8, [s * 17; 4], [b * 17; 4]);
            any = true;
        }
    }
    any
}
