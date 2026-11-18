//! Blockstate + block model loading and baking into plain quads.
//!
//! Conventions match the game (checked against the 26.3 client source):
//! * element rotation is about the positive axis by `angle`, or Euler x/y/z applied X→Y→Z, optional rescale
//! * blockstate rotation applies X, then Y, then Z in 90° steps; Y90 turns north into east, X90 turns up into north
//! * faces are emitted as 4 corners TL, BL, BR, TR as seen from outside (counter-clockwise)

use crate::jar::Jar;
use crate::textures::{Alpha, TextureArray};
use blockdata::BlockState;
use parking_lot::RwLock;
use serde_json::Value as J;
use std::collections::HashMap;
use std::sync::Arc;

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, serde::Serialize)]
pub enum Dir {
    Down = 0,
    Up = 1,
    North = 2,
    South = 3,
    West = 4,
    East = 5,
}

impl Dir {
    pub const ALL: [Dir; 6] = [Dir::Down, Dir::Up, Dir::North, Dir::South, Dir::West, Dir::East];
    pub fn parse(s: &str) -> Option<Dir> {
        Some(match s {
            "down" | "bottom" => Dir::Down,
            "up" | "top" => Dir::Up,
            "north" => Dir::North,
            "south" => Dir::South,
            "west" => Dir::West,
            "east" => Dir::East,
            _ => return None,
        })
    }
    pub fn offset(self) -> [i32; 3] {
        match self {
            Dir::Down => [0, -1, 0],
            Dir::Up => [0, 1, 0],
            Dir::North => [0, 0, -1],
            Dir::South => [0, 0, 1],
            Dir::West => [-1, 0, 0],
            Dir::East => [1, 0, 0],
        }
    }
    pub fn opposite(self) -> Dir {
        match self {
            Dir::Down => Dir::Up,
            Dir::Up => Dir::Down,
            Dir::North => Dir::South,
            Dir::South => Dir::North,
            Dir::West => Dir::East,
            Dir::East => Dir::West,
        }
    }
    pub fn bit(self) -> u8 {
        1 << (self as u8)
    }
    pub fn from_vec(v: [f32; 3]) -> Dir {
        let (ax, ay, az) = (v[0].abs(), v[1].abs(), v[2].abs());
        if ay >= ax && ay >= az {
            if v[1] >= 0.0 { Dir::Up } else { Dir::Down }
        } else if ax >= az {
            if v[0] >= 0.0 { Dir::East } else { Dir::West }
        } else if v[2] >= 0.0 {
            Dir::South
        } else {
            Dir::North
        }
    }
    pub fn vecf(self) -> [f32; 3] {
        let o = self.offset();
        [o[0] as f32, o[1] as f32, o[2] as f32]
    }
}

#[derive(Clone, Debug)]
pub struct Quad {
    /// Block-local positions, 0..1 (may exceed slightly for some models).
    pub pos: [[f32; 3]; 4],
    /// Texture coordinates within the layer, 0..1.
    pub uv: [[f32; 2]; 4],
    pub tex: u16,
    pub tint: i8,
    pub cull: Option<Dir>,
    /// Closest axis of the face normal.
    pub face: Dir,
    pub normal: [f32; 3],
    pub shade: bool,
    pub alpha: Alpha,
    pub emissive: bool,
    /// Lies on the block boundary plane of `face` and covers it completely.
    pub full: bool,
    pub light_emission: u8,
}

#[derive(Debug, Default)]
pub struct BakedModel {
    pub quads: Vec<Quad>,
    pub ao: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum Tint {
    None,
    Grass,
    Foliage,
    DryFoliage,
    Water,
    Fixed([u8; 3]),
    Redstone(u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fluid {
    Water { level: u8 },
    Lava { level: u8 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Offset {
    None,
    XZ,
    XYZ,
}

pub struct BakedState {
    pub parts: Vec<Vec<(u32, Arc<BakedModel>)>>,
    /// Faces (bits of Dir) that are fully covered by opaque geometry.
    pub occludes: u8,
    pub fluid: Option<Fluid>,
    /// Hide faces between two blocks of the same kind (glass, ice...).
    pub cull_same: bool,
    pub offset: Offset,
    pub tint: Tint,
    pub is_air: bool,
    /// A full opaque cube: casts ambient occlusion and blocks the view.
    pub solid: bool,
    /// Interned block name id, for same-kind comparisons.
    pub kind: u32,
    /// Block id, e.g. "minecraft:oak_log".
    pub name: String,
    /// Color for maps: average of the top texture (before tint) and whether to apply the tint.
    pub map_color: [u8; 3],
    pub map_tinted: bool,
    pub map_alpha: Alpha,
    /// Has any geometry at all (or fluid).
    pub visible: bool,
    /// Area (0..1) of the block's top covered by upward faces; used to pick the block a map shows.
    pub map_top: f32,
    pub emissive: bool,
}

struct RawModel {
    parent: Option<String>,
    textures: Vec<(String, J)>,
    elements: Option<Arc<Vec<J>>>,
    ao: Option<bool>,
}

struct Flat {
    textures: HashMap<String, J>,
    elements: Arc<Vec<J>>,
    ao: bool,
    builtin: bool,
}

type BakeKey = (String, i32, i32, i32, bool);

pub struct Models {
    jar: Arc<Jar>,
    pub tex: Arc<TextureArray>,
    raw: RwLock<HashMap<String, Option<Arc<RawModel>>>>,
    baked: RwLock<HashMap<BakeKey, Arc<BakedModel>>>,
    states: RwLock<HashMap<BlockState, Arc<BakedState>>>,
    blockstates: RwLock<HashMap<String, Option<Arc<J>>>>,
    kinds: RwLock<HashMap<String, u32>>,
    pub extra: crate::entity_models::EntityModels,
}

fn norm_model(name: &str) -> String {
    let n = name.strip_prefix("minecraft:").unwrap_or(name);
    if n.contains(':') {
        return n.to_string();
    }
    n.to_string()
}

fn norm_tex(name: &str) -> String {
    let n = name.strip_prefix("minecraft:").unwrap_or(name);
    n.to_string()
}

fn f3(v: Option<&J>, d: [f32; 3]) -> [f32; 3] {
    match v.and_then(|v| v.as_array()) {
        Some(a) if a.len() == 3 => [a[0].as_f64().unwrap_or(0.0) as f32, a[1].as_f64().unwrap_or(0.0) as f32, a[2].as_f64().unwrap_or(0.0) as f32],
        _ => d,
    }
}

type M3 = [[f32; 3]; 3];
const IDENT: M3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

fn mul(a: &M3, b: &M3) -> M3 {
    let mut r = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    r
}

fn apply(m: &M3, v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

/// Right-handed rotation about a positive axis.
fn axis_rot(axis: u8, deg: f32) -> M3 {
    let (s, c) = deg.to_radians().sin_cos();
    match axis {
        0 => [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]],
        1 => [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]],
        _ => [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]],
    }
}

/// Blockstate rotation of a vector (already centered).
pub fn rot_state(v: [f32; 3], rx: i32, ry: i32, rz: i32) -> [f32; 3] {
    let [mut x, mut y, mut z] = v;
    for _ in 0..(rx.rem_euclid(360) / 90) {
        let (ny, nz) = (z, -y);
        y = ny;
        z = nz;
    }
    for _ in 0..(ry.rem_euclid(360) / 90) {
        let (nx, nz) = (-z, x);
        x = nx;
        z = nz;
    }
    for _ in 0..(rz.rem_euclid(360) / 90) {
        let (nx, ny) = (y, -x);
        x = nx;
        y = ny;
    }
    [x, y, z]
}

/// TL, BL, BR, TR corners (0..16 space) for a face of the box from..to.
pub fn face_corners(d: Dir, f: [f32; 3], t: [f32; 3]) -> [[f32; 3]; 4] {
    let (fx, fy, fz, tx, ty, tz) = (f[0], f[1], f[2], t[0], t[1], t[2]);
    match d {
        Dir::Up => [[fx, ty, fz], [fx, ty, tz], [tx, ty, tz], [tx, ty, fz]],
        Dir::Down => [[fx, fy, tz], [fx, fy, fz], [tx, fy, fz], [tx, fy, tz]],
        Dir::North => [[tx, ty, fz], [tx, fy, fz], [fx, fy, fz], [fx, ty, fz]],
        Dir::South => [[fx, ty, tz], [fx, fy, tz], [tx, fy, tz], [tx, ty, tz]],
        Dir::West => [[fx, ty, fz], [fx, fy, fz], [fx, fy, tz], [fx, ty, tz]],
        Dir::East => [[tx, ty, tz], [tx, fy, tz], [tx, fy, fz], [tx, ty, fz]],
    }
}

pub fn default_uv(d: Dir, f: [f32; 3], t: [f32; 3]) -> [f32; 4] {
    let (fx, fy, fz, tx, ty, tz) = (f[0], f[1], f[2], t[0], t[1], t[2]);
    match d {
        Dir::Up => [fx, fz, tx, tz],
        Dir::Down => [fx, 16.0 - tz, tx, 16.0 - fz],
        Dir::North => [16.0 - tx, 16.0 - ty, 16.0 - fx, 16.0 - fy],
        Dir::South => [fx, 16.0 - ty, tx, 16.0 - fy],
        Dir::West => [fz, 16.0 - ty, tz, 16.0 - fy],
        Dir::East => [16.0 - tz, 16.0 - ty, 16.0 - fz, 16.0 - fy],
    }
}

/// World-aligned UV of a point on a face (used for uvlock).
fn locked_uv(d: Dir, p: [f32; 3]) -> [f32; 2] {
    match d {
        Dir::Up => [p[0], p[2]],
        Dir::Down => [p[0], 16.0 - p[2]],
        Dir::North => [16.0 - p[0], 16.0 - p[1]],
        Dir::South => [p[0], 16.0 - p[1]],
        Dir::West => [p[2], 16.0 - p[1]],
        Dir::East => [16.0 - p[2], 16.0 - p[1]],
    }
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// Java's LCG (java.util.Random / LegacyRandomSource) for picking weighted variants exactly like the game.
pub struct JavaRandom(i64);
impl JavaRandom {
    pub fn new(seed: i64) -> Self {
        JavaRandom((seed ^ 0x5DEECE66D) & ((1i64 << 48) - 1))
    }
    fn next(&mut self, bits: u32) -> i32 {
        self.0 = (self.0.wrapping_mul(0x5DEECE66D).wrapping_add(0xB)) & ((1i64 << 48) - 1);
        (self.0 >> (48 - bits)) as i32
    }
    pub fn next_int(&mut self, bound: i32) -> i32 {
        if bound <= 0 {
            return 0;
        }
        if bound & (-bound) == bound {
            return ((bound as i64 * self.next(31) as i64) >> 31) as i32;
        }
        loop {
            let bits = self.next(31);
            let val = bits % bound;
            if bits.wrapping_sub(val).wrapping_add(bound - 1) >= 0 {
                return val;
            }
        }
    }
}

/// Mth.getSeed
pub fn pos_seed(x: i32, y: i32, z: i32) -> i64 {
    let mut seed = (x.wrapping_mul(3129871) as i64) ^ (z as i64).wrapping_mul(116129781) ^ (y as i64);
    seed = seed.wrapping_mul(seed).wrapping_mul(42317861).wrapping_add(seed.wrapping_mul(11));
    seed >> 16
}

/// Build a quad from block-local (0..1) corners TL, BL, BR, TR and per-corner UVs (0..1).
pub fn finish_quad(pos: [[f32; 3]; 4], uv: [[f32; 2]; 4], info: &crate::textures::TexInfo, tint: i8, shade: bool) -> Option<Quad> {
    let n = cross(sub(pos[1], pos[0]), sub(pos[3], pos[0]));
    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if len < 1e-9 {
        return None;
    }
    let normal = [n[0] / len, n[1] / len, n[2] / len];
    let face = Dir::from_vec(normal);
    let axis_aligned = normal[0].abs() > 0.999 || normal[1].abs() > 0.999 || normal[2].abs() > 0.999;
    let full = axis_aligned && {
        let (a, b, c, plane) = match face {
            Dir::Up => (0, 2, 1, 1.0),
            Dir::Down => (0, 2, 1, 0.0),
            Dir::North => (0, 1, 2, 0.0),
            Dir::South => (0, 1, 2, 1.0),
            Dir::West => (2, 1, 0, 0.0),
            Dir::East => (2, 1, 0, 1.0),
        };
        let on_plane = pos.iter().all(|p| (p[c] - plane).abs() < 1e-4);
        let (mut mina, mut maxa, mut minb, mut maxb) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
        for p in &pos {
            mina = mina.min(p[a]);
            maxa = maxa.max(p[a]);
            minb = minb.min(p[b]);
            maxb = maxb.max(p[b]);
        }
        on_plane && mina <= 1e-4 && minb <= 1e-4 && maxa >= 1.0 - 1e-4 && maxb >= 1.0 - 1e-4
    };
    Some(Quad { pos, uv, tex: info.layer, tint, cull: None, face, normal, shade, alpha: info.alpha, emissive: info.emissive, full, light_emission: 0 })
}

impl BakedState {
    /// Pick the models for a position, the same way the game does.
    pub fn models_at(&self, x: i32, y: i32, z: i32, out: &mut Vec<Arc<BakedModel>>) {
        out.clear();
        if self.parts.iter().all(|p| p.len() == 1) {
            for p in &self.parts {
                out.push(p[0].1.clone());
            }
            return;
        }
        let mut rng = JavaRandom::new(pos_seed(x, y, z));
        for p in &self.parts {
            if p.len() == 1 {
                out.push(p[0].1.clone());
                continue;
            }
            let total: u32 = p.iter().map(|v| v.0).sum();
            let mut r = rng.next_int(total.max(1) as i32) as u32;
            let mut chosen = &p[0].1;
            for (w, m) in p {
                if r < *w {
                    chosen = m;
                    break;
                }
                r -= w;
            }
            out.push(chosen.clone());
        }
    }

    /// Random XZ(Y) offset for plants, matching the game.
    pub fn offset_at(&self, x: i32, z: i32) -> [f32; 3] {
        if self.offset == Offset::None {
            return [0.0; 3];
        }
        let seed = pos_seed(x, 0, z);
        let ox = (((seed & 15) as f32 / 15.0) - 0.5) * 0.5;
        let oz = ((((seed >> 8) & 15) as f32 / 15.0) - 0.5) * 0.5;
        let oy = if self.offset == Offset::XYZ { (((seed >> 4) & 15) as f32 / 15.0 - 1.0) * 0.2 } else { 0.0 };
        [ox.clamp(-0.25, 0.25), oy, oz.clamp(-0.25, 0.25)]
    }
}


/// Default value of a block property, used when a save stores a block in its default state
/// (26.x writes a bare name for the default state).
fn default_prop(block: &str, prop: &str) -> Option<&'static str> {
    let b = block.trim_start_matches("minecraft:");
    let special = match (b, prop) {
        ("hopper", "facing") => Some("down"),
        ("hopper", "enabled") => Some("true"),
        ("redstone_torch" | "redstone_wall_torch" | "campfire" | "soul_campfire", "lit") => Some("true"),
        ("observer", "facing") => Some("south"),
        ("bubble_column", "drag") => Some("true"),
        ("repeater", "delay") => Some("1"),
        ("comparator", "mode") => Some("compare"),
        ("pointed_dripstone", "thickness") => Some("tip"),
        ("pointed_dripstone", "vertical_direction") => Some("up"),
        ("bell", "attachment") => Some("floor"),
        ("note_block", "instrument") => Some("harp"),
        ("crafter" | "jigsaw", "orientation") => Some("north_up"),
        (_, "facing") if b.ends_with("amethyst_cluster") || b.ends_with("amethyst_bud") || b == "end_rod" || b.ends_with("lightning_rod") || b.ends_with("shulker_box") => Some("up"),
        (_, "up") if b.ends_with("_wall") => Some("true"),
        (_, "distance") if b.ends_with("_leaves") || b == "scaffolding" => Some("7"),
        (_, "north" | "south" | "east" | "west") if b.ends_with("_wall") || b == "redstone_wire" => Some("none"),
        _ => None,
    };
    if special.is_some() {
        return special;
    }
    Some(match prop {
        "axis" => "y",
        "facing" => "north",
        "type" => if b.ends_with("chest") { "single" } else { "bottom" },
        "half" => if b.ends_with("_stairs") || b.ends_with("_trapdoor") { "bottom" } else { "lower" },
        "shape" => if b.contains("rail") { "north_south" } else { "straight" },
        "face" => "wall",
        "part" => "foot",
        "hinge" => "left",
        "attachment" => "floor",
        "tilt" => "none",
        "mode" => "save",
        "candles" | "pickles" | "layers" | "eggs" | "flower_amount" | "segment_amount" => "1",
        "age" | "level" | "power" | "rotation" | "moisture" | "stage" | "note" | "bites" | "hatch" | "dusted" | "honey_level" | "charges" | "delay" => "0",
        "trial_spawner_state" | "vault_state" | "sculk_sensor_phase" => "inactive",
        "orientation" => "north_up",
        "thickness" => "tip",
        "vertical_direction" => "up",
        "creaking_heart_state" => "uprooted",
        "side_chain" => "unconnected",
        "drag" => "true",
        "enabled" => "true",
        _ => "false",
    })
}

/// Property names a blockstate file refers to.
fn props_in(bs: &J) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(vars) = bs.get("variants").and_then(|v| v.as_object()) {
        for k in vars.keys() {
            for kv in k.split(',') {
                if let Some((p, _)) = kv.split_once('=') {
                    if !out.iter().any(|o| o == p) {
                        out.push(p.to_string());
                    }
                }
            }
        }
    }
    fn walk(w: &J, out: &mut Vec<String>) {
        if let Some(o) = w.as_object() {
            for (k, v) in o {
                if k == "OR" || k == "AND" {
                    if let Some(a) = v.as_array() {
                        for c in a {
                            walk(c, out);
                        }
                    }
                } else if !out.iter().any(|x| x == k) {
                    out.push(k.clone());
                }
            }
        }
    }
    if let Some(mp) = bs.get("multipart").and_then(|v| v.as_array()) {
        for part in mp {
            if let Some(w) = part.get("when") {
                walk(w, &mut out);
            }
        }
    }
    out
}

/// Fill in properties a state doesn't list with their default values.
pub fn with_defaults(st: &BlockState, bs: Option<&J>) -> BlockState {
    let mut names: Vec<String> = bs.map(props_in).unwrap_or_default();
    for extra in ["waterlogged", "facing", "type"] {
        if !names.iter().any(|n| n == extra) && (extra == "waterlogged") {
            names.push(extra.to_string());
        }
    }
    let mut out = st.clone();
    let mut changed = false;
    for n in names {
        if out.prop(&n).is_none() {
            if let Some(d) = default_prop(&st.name, &n) {
                out.props.push((n, d.to_string()));
                changed = true;
            }
        }
    }
    if changed {
        out.props.sort();
    }
    out
}

fn when_matches(w: &J, st: &BlockState) -> bool {
    let Some(obj) = w.as_object() else { return true };
    if let Some(or) = obj.get("OR").and_then(|v| v.as_array()) {
        return or.iter().any(|c| when_matches(c, st));
    }
    if let Some(and) = obj.get("AND").and_then(|v| v.as_array()) {
        return and.iter().all(|c| when_matches(c, st));
    }
    for (k, v) in obj {
        let want = match v {
            J::String(s) => s.clone(),
            other => other.to_string(),
        };
        let actual = st.prop(k).unwrap_or("");
        let (neg, want) = match want.strip_prefix('!') {
            Some(w) => (true, w.to_string()),
            None => (false, want),
        };
        let m = want.split('|').any(|a| a == actual);
        if m == neg {
            return false;
        }
    }
    true
}

fn variant_matches(key: &str, st: &BlockState) -> bool {
    if key.is_empty() || key == "normal" {
        return true;
    }
    key.split(',').all(|kv| match kv.split_once('=') {
        Some((k, v)) => st.prop(k) == Some(v),
        None => true,
    })
}

const OFFSET_XZ: &[&str] = &[
    "short_grass", "fern", "tall_grass", "large_fern", "dandelion", "poppy", "blue_orchid", "allium", "azure_bluet", "red_tulip",
    "orange_tulip", "white_tulip", "pink_tulip", "oxeye_daisy", "cornflower", "lily_of_the_valley", "wither_rose", "sunflower",
    "lilac", "rose_bush", "peony", "bamboo", "bamboo_sapling", "mangrove_propagule", "torchflower", "pitcher_plant", "warped_roots",
    "crimson_roots", "nether_sprouts", "hanging_roots", "pointed_dripstone", "small_dripleaf", "short_dry_grass", "tall_dry_grass",
    "bush", "open_eyeblossom", "closed_eyeblossom", "firefly_bush", "cactus_flower", "golden_dandelion",
];
const OFFSET_XYZ: &[&str] = &["small_dripleaf_x"];

fn tint_of(name: &str, st: &BlockState) -> Tint {
    let n = name.trim_start_matches("minecraft:");
    match n {
        "grass_block" | "short_grass" | "tall_grass" | "fern" | "large_fern" | "potted_fern" | "sugar_cane" | "bush" => Tint::Grass,
        "oak_leaves" | "jungle_leaves" | "acacia_leaves" | "dark_oak_leaves" | "mangrove_leaves" | "vine" => Tint::Foliage,
        "birch_leaves" => Tint::Fixed([0x80, 0xA7, 0x55]),
        "spruce_leaves" => Tint::Fixed([0x61, 0x99, 0x61]),
        "lily_pad" => Tint::Fixed([0x20, 0x80, 0x30]),
        "attached_melon_stem" | "attached_pumpkin_stem" => Tint::Fixed([0xE0, 0xC7, 0x1C]),
        "melon_stem" | "pumpkin_stem" => {
            let age: i32 = st.prop("age").and_then(|a| a.parse().ok()).unwrap_or(0);
            Tint::Fixed([(age * 32) as u8, (255 - age * 8) as u8, (age * 4) as u8])
        }
        "water" | "bubble_column" | "water_cauldron" => Tint::Water,
        "redstone_wire" => Tint::Redstone(st.prop("power").and_then(|p| p.parse().ok()).unwrap_or(0)),
        "leaf_litter" => Tint::DryFoliage,
        _ => Tint::None,
    }
}

fn cull_same(n: &str) -> bool {
    let n = n.trim_start_matches("minecraft:");
    (n.ends_with("glass") || n == "ice" || n == "slime_block" || n == "honey_block" || n == "powder_snow" || n.ends_with("_glass_pane") || n == "glass_pane")
        && n != "packed_ice"
}

impl Models {
    pub fn new(jar: Arc<Jar>, tex: Arc<TextureArray>) -> Models {
        let extra = crate::entity_models::EntityModels::new(&jar);
        Models {
            jar,
            tex,
            raw: RwLock::new(HashMap::new()),
            baked: RwLock::new(HashMap::new()),
            states: RwLock::new(HashMap::new()),
            blockstates: RwLock::new(HashMap::new()),
            kinds: RwLock::new(HashMap::new()),
            extra,
        }
    }

    pub fn jar(&self) -> &Jar {
        &self.jar
    }

    fn raw(&self, name: &str) -> Option<Arc<RawModel>> {
        if let Some(r) = self.raw.read().get(name) {
            return r.clone();
        }
        let path = format!("models/{name}.json");
        let parsed = self.jar.json(&path).map(|j| {
            let parent = j.get("parent").and_then(|p| p.as_str()).map(norm_model);
            let textures = j.get("textures").and_then(|t| t.as_object()).map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
            let elements = j.get("elements").and_then(|e| e.as_array()).map(|a| Arc::new(a.clone()));
            let ao = j.get("ambientocclusion").and_then(|a| a.as_bool());
            Arc::new(RawModel { parent, textures, elements, ao })
        });
        self.raw.write().insert(name.to_string(), parsed.clone());
        parsed
    }

    fn flatten(&self, name: &str) -> Option<Flat> {
        let mut textures = HashMap::new();
        let mut elements = None;
        let mut ao = None;
        let mut builtin = false;
        let mut cur = Some(norm_model(name));
        let mut depth = 0;
        let mut found_any = false;
        while let Some(n) = cur.take() {
            depth += 1;
            if depth > 24 {
                break;
            }
            if n.starts_with("builtin/") {
                builtin = true;
                break;
            }
            let Some(raw) = self.raw(&n) else { break };
            found_any = true;
            for (k, v) in &raw.textures {
                textures.entry(k.clone()).or_insert_with(|| v.clone());
            }
            if elements.is_none() {
                elements = raw.elements.clone();
            }
            if ao.is_none() {
                ao = raw.ao;
            }
            cur = raw.parent.clone();
        }
        if !found_any && !builtin {
            return None;
        }
        Some(Flat { textures, elements: elements.unwrap_or_default(), ao: ao.unwrap_or(true), builtin })
    }

    /// Resolve a "#ref" chain to a texture name. Returns (name, force_translucent).
    fn resolve_tex(textures: &HashMap<String, J>, r: &str) -> (String, bool) {
        let mut cur = r.to_string();
        let mut force = false;
        for _ in 0..12 {
            match cur.strip_prefix('#') {
                Some(k) => match textures.get(k) {
                    Some(J::String(s)) => cur = s.clone(),
                    Some(J::Object(o)) => {
                        force |= o.get("force_translucent").and_then(|f| f.as_bool()).unwrap_or(false);
                        cur = o.get("sprite").and_then(|s| s.as_str()).unwrap_or("missing").to_string();
                    }
                    _ => return ("missing".into(), false),
                },
                None => return (norm_tex(&cur), force),
            }
        }
        ("missing".into(), false)
    }

    pub fn bake_model(&self, model: &str, rx: i32, ry: i32, rz: i32, uvlock: bool) -> Arc<BakedModel> {
        let key: BakeKey = (model.to_string(), rx, ry, rz, uvlock);
        if let Some(m) = self.baked.read().get(&key) {
            return m.clone();
        }
        let baked = Arc::new(self.bake_uncached(model, rx, ry, rz, uvlock));
        self.baked.write().insert(key, baked.clone());
        baked
    }

    fn bake_uncached(&self, model: &str, rx: i32, ry: i32, rz: i32, uvlock: bool) -> BakedModel {
        let Some(flat) = self.flatten(model) else { return BakedModel::default() };
        let mut quads = Vec::new();
        for el in flat.elements.iter() {
            let from = f3(el.get("from"), [0.0; 3]);
            let to = f3(el.get("to"), [16.0; 3]);
            let shade = el.get("shade").and_then(|s| s.as_bool()).unwrap_or(true);
            let light_emission = el.get("light_emission").and_then(|s| s.as_u64()).unwrap_or(0).min(15) as u8;
            // element rotation
            let mut erot: Option<([f32; 3], M3)> = None;
            if let Some(r) = el.get("rotation") {
                let origin = f3(r.get("origin"), [8.0; 3]);
                let rescale = r.get("rescale").and_then(|v| v.as_bool()).unwrap_or(false);
                let m: M3 = if let (Some(axis), Some(angle)) = (r.get("axis").and_then(|a| a.as_str()), r.get("angle").and_then(|a| a.as_f64())) {
                    let ax = match axis {
                        "x" => 0,
                        "y" => 1,
                        _ => 2,
                    };
                    if angle == 0.0 { IDENT } else { axis_rot(ax, angle as f32) }
                } else {
                    let x = r.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
                    let y = r.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
                    let z = r.get("z").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
                    mul(&axis_rot(2, z), &mul(&axis_rot(1, y), &axis_rot(0, x)))
                };
                let m = if rescale && m != IDENT {
                    let mut s = [1.0f32; 3];
                    for (axis, sv) in s.iter_mut().enumerate() {
                        let mut e = [0.0f32; 3];
                        e[axis] = 1.0;
                        let t = apply(&m, e);
                        let mx = t[0].abs().max(t[1].abs()).max(t[2].abs());
                        *sv = if mx > 1e-6 { 1.0 / mx } else { 1.0 };
                    }
                    let sm: M3 = [[s[0], 0.0, 0.0], [0.0, s[1], 0.0], [0.0, 0.0, s[2]]];
                    mul(&m, &sm)
                } else {
                    m
                };
                if m != IDENT {
                    erot = Some((origin, m));
                }
            }
            let Some(faces) = el.get("faces").and_then(|f| f.as_object()) else { continue };
            for (fname, face) in faces {
                let Some(d) = Dir::parse(fname) else { continue };
                let uv = match face.get("uv").and_then(|u| u.as_array()) {
                    Some(a) if a.len() == 4 => [
                        a[0].as_f64().unwrap_or(0.0) as f32,
                        a[1].as_f64().unwrap_or(0.0) as f32,
                        a[2].as_f64().unwrap_or(16.0) as f32,
                        a[3].as_f64().unwrap_or(16.0) as f32,
                    ],
                    _ => default_uv(d, from, to),
                };
                let tref = face.get("texture").and_then(|t| t.as_str()).unwrap_or("#missing");
                let (tname, force_tl) = Self::resolve_tex(&flat.textures, tref);
                let info = self.tex.get(&tname);
                let cull = face.get("cullface").and_then(|c| c.as_str()).and_then(Dir::parse);
                let frot = face.get("rotation").and_then(|r| r.as_i64()).unwrap_or(0) as i32;
                let tint = face.get("tintindex").and_then(|t| t.as_i64()).unwrap_or(-1).clamp(-1, 100) as i8;

                let mut pos = face_corners(d, from, to);
                let base_uv = [[uv[0], uv[1]], [uv[0], uv[3]], [uv[2], uv[3]], [uv[2], uv[1]]];
                let k = (frot.rem_euclid(360) / 90) as usize;
                let mut uvs = [[0.0f32; 2]; 4];
                for i in 0..4 {
                    uvs[i] = base_uv[(i + k) % 4];
                }
                if let Some((o, m)) = &erot {
                    for p in pos.iter_mut() {
                        let r = apply(m, sub(*p, *o));
                        *p = [r[0] + o[0], r[1] + o[1], r[2] + o[2]];
                    }
                }
                if rx != 0 || ry != 0 || rz != 0 {
                    for p in pos.iter_mut() {
                        let r = rot_state([p[0] - 8.0, p[1] - 8.0, p[2] - 8.0], rx, ry, rz);
                        *p = [r[0] + 8.0, r[1] + 8.0, r[2] + 8.0];
                    }
                }
                let cull = cull.map(|c| Dir::from_vec(rot_state(c.vecf(), rx, ry, rz)));
                let pos01 = pos.map(|p| [p[0] / 16.0, p[1] / 16.0, p[2] / 16.0]);
                let Some(mut q) = finish_quad(pos01, uvs.map(|u| [u[0] / 16.0, u[1] / 16.0]), &info, tint, shade) else { continue };
                if uvlock && (rx != 0 || ry != 0 || rz != 0) {
                    for i in 0..4 {
                        let l = locked_uv(q.face, pos[i]);
                        q.uv[i] = [l[0] / 16.0, l[1] / 16.0];
                    }
                }
                q.cull = cull;
                if force_tl {
                    q.alpha = Alpha::Translucent;
                }
                q.light_emission = light_emission;
                q.emissive |= light_emission > 0;
                quads.push(q);
            }
        }
        let _ = flat.builtin;
        BakedModel { quads, ao: flat.ao }
    }

    fn blockstate(&self, name: &str) -> Option<Arc<J>> {
        if let Some(b) = self.blockstates.read().get(name) {
            return b.clone();
        }
        let short = name.trim_start_matches("minecraft:");
        let j = self.jar.json(&format!("blockstates/{short}.json")).map(Arc::new);
        self.blockstates.write().insert(name.to_string(), j.clone());
        j
    }

    fn kind_of(&self, name: &str) -> u32 {
        if let Some(k) = self.kinds.read().get(name) {
            return *k;
        }
        let mut w = self.kinds.write();
        let n = w.len() as u32 + 1;
        *w.entry(name.to_string()).or_insert(n)
    }

    fn variant_list(&self, entry: &J) -> Vec<(u32, Arc<BakedModel>)> {
        let one = |v: &J| -> Option<(u32, Arc<BakedModel>)> {
            let model = v.get("model")?.as_str()?;
            let rx = v.get("x").and_then(|x| x.as_i64()).unwrap_or(0) as i32;
            let ry = v.get("y").and_then(|x| x.as_i64()).unwrap_or(0) as i32;
            let rz = v.get("z").and_then(|x| x.as_i64()).unwrap_or(0) as i32;
            let uvlock = v.get("uvlock").and_then(|x| x.as_bool()).unwrap_or(false);
            let weight = v.get("weight").and_then(|x| x.as_u64()).unwrap_or(1).max(1) as u32;
            Some((weight, self.bake_model(&norm_model(model), rx, ry, rz, uvlock)))
        };
        match entry {
            J::Array(a) => a.iter().filter_map(one).collect(),
            other => one(other).into_iter().collect(),
        }
    }

    /// Bake (cached) everything needed to draw a block state.
    pub fn state(&self, st: &BlockState) -> Arc<BakedState> {
        if let Some(s) = self.states.read().get(st) {
            return s.clone();
        }
        let baked = Arc::new(self.state_uncached(st));
        self.states.write().insert(st.clone(), baked.clone());
        baked
    }

    fn state_uncached(&self, st_in: &BlockState) -> BakedState {
        let bs_json = if st_in.is_air() { None } else { self.blockstate(&st_in.name) };
        let st_full = with_defaults(st_in, bs_json.as_deref());
        let st = &st_full;
        let name = st.name.as_str();
        let short = name.trim_start_matches("minecraft:");
        let is_air = st.is_air();
        let mut parts: Vec<Vec<(u32, Arc<BakedModel>)>> = Vec::new();
        if !is_air {
            if let Some(m) = self.extra.model_for(st, &self.tex) {
                parts.push(vec![(1, Arc::new(m))]);
            } else if let Some(bs) = bs_json.clone() {
                if let Some(vars) = bs.get("variants").and_then(|v| v.as_object()) {
                    if let Some((_, entry)) = vars.iter().find(|(k, _)| variant_matches(k, st)) {
                        let l = self.variant_list(entry);
                        if !l.is_empty() {
                            parts.push(l);
                        }
                    }
                } else if let Some(mp) = bs.get("multipart").and_then(|v| v.as_array()) {
                    for part in mp {
                        let ok = part.get("when").map(|w| when_matches(w, st)).unwrap_or(true);
                        if ok {
                            if let Some(apply) = part.get("apply") {
                                let l = self.variant_list(apply);
                                if !l.is_empty() {
                                    parts.push(l);
                                }
                            }
                        }
                    }
                }
            }
        }
        // occlusion from the first variant of every part
        let mut occludes = 0u8;
        let mut emissive = false;
        let mut any_quads = false;
        for p in &parts {
            for q in &p[0].1.quads {
                any_quads = true;
                if q.full && q.alpha == Alpha::Opaque {
                    occludes |= q.face.bit();
                }
                emissive |= q.emissive;
            }
        }
        let waterlogged = st.prop("waterlogged") == Some("true")
            || matches!(short, "kelp" | "kelp_plant" | "seagrass" | "tall_seagrass" | "bubble_column");
        let fluid = match short {
            "water" => Some(Fluid::Water { level: st.prop("level").and_then(|l| l.parse().ok()).unwrap_or(0) }),
            "lava" => Some(Fluid::Lava { level: st.prop("level").and_then(|l| l.parse().ok()).unwrap_or(0) }),
            _ if waterlogged => Some(Fluid::Water { level: 0 }),
            _ => None,
        };
        // map color: top texture of the first model
        let (mut map_color, mut map_tinted, mut map_alpha) = ([0u8; 3], false, Alpha::Opaque);
        let mut best: Option<&Quad> = None;
        for p in &parts {
            for q in &p[0].1.quads {
                let better = match best {
                    None => true,
                    Some(b) => (q.face == Dir::Up && b.face != Dir::Up) || (q.face == Dir::Up && b.face == Dir::Up && q.pos[0][1] > b.pos[0][1]),
                };
                if better {
                    best = Some(q);
                }
            }
        }
        if let Some(q) = best {
            let info = self.tex.layer_info(q.tex);
            map_color = info.0;
            map_alpha = info.1;
            map_tinted = q.tint >= 0;
        }
        if let Some(Fluid::Water { .. }) = fluid {
            if !any_quads || short == "water" {
                map_color = self.tex.peek_avg("block/water_still").map(|a| a.0).unwrap_or([60, 90, 200]);
                map_tinted = true;
                map_alpha = Alpha::Translucent;
            }
        }
        if let Some(Fluid::Lava { .. }) = fluid {
            map_color = self.tex.peek_avg("block/lava_still").map(|a| a.0).unwrap_or([220, 90, 20]);
            map_alpha = Alpha::Opaque;
        }
        let tint = if short == "water" || (waterlogged && !any_quads) { Tint::Water } else { tint_of(name, st) };
        let offset = if OFFSET_XYZ.contains(&short) {
            Offset::XYZ
        } else if OFFSET_XZ.contains(&short) {
            Offset::XZ
        } else {
            Offset::None
        };
        let mut map_top = 0.0f32;
        for p in &parts {
            for q in &p[0].1.quads {
                if q.face == Dir::Up {
                    let (mut x0, mut x1, mut z0, mut z1) = (1.0f32, 0.0f32, 1.0f32, 0.0f32);
                    for v in &q.pos {
                        x0 = x0.min(v[0]);
                        x1 = x1.max(v[0]);
                        z0 = z0.min(v[2]);
                        z1 = z1.max(v[2]);
                    }
                    map_top = map_top.max(((x1 - x0) * (z1 - z0)).clamp(0.0, 1.0));
                }
            }
        }
        BakedState {
            map_top,
            solid: occludes == 0x3F,
            visible: any_quads || fluid.is_some(),
            parts,
            occludes,
            fluid,
            cull_same: cull_same(name),
            offset,
            tint,
            is_air,
            kind: self.kind_of(name),
            name: name.to_string(),
            map_color,
            map_tinted,
            map_alpha,
            emissive,
        }
    }

    /// Item model for an item id (from items/<id>.json), picking the plain fallback for dynamic items.
    pub fn item_model_name(&self, item: &str) -> Option<String> {
        let short = item.trim_start_matches("minecraft:");
        let def = self.jar.json(&format!("items/{short}.json"))?;
        fn find(v: &J) -> Option<String> {
            let t = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match t.trim_start_matches("minecraft:") {
                "model" => v.get("model").and_then(|m| m.as_str()).map(|s| s.to_string()),
                "special" => v.get("base").and_then(|m| m.as_str()).map(|s| format!("special:{s}")),
                "condition" => v.get("on_false").and_then(find).or_else(|| v.get("on_true").and_then(find)),
                "select" => v.get("fallback").and_then(find).or_else(|| v.get("cases").and_then(|c| c.as_array()).and_then(|a| a.first()).and_then(|c| c.get("model")).and_then(find)),
                "range_dispatch" => v.get("fallback").and_then(find).or_else(|| v.get("entries").and_then(|c| c.as_array()).and_then(|a| a.first()).and_then(|c| c.get("model")).and_then(find)),
                "composite" => v.get("models").and_then(|m| m.as_array()).and_then(|a| a.first()).and_then(find),
                "bundle/selected_item" | "empty" => None,
                _ => v.get("model").and_then(|m| m.as_str()).map(|s| s.to_string()),
            }
        }
        find(def.get("model")?)
    }

    /// For flat items: the layer textures of an item model ("item/diamond"). None if it's a 3D block-style model.
    pub fn item_layers(&self, model: &str) -> Option<Vec<String>> {
        let m = norm_model(model);
        let flat = self.flatten(&m)?;
        if !flat.elements.is_empty() {
            return None;
        }
        let mut out = Vec::new();
        for i in 0..5 {
            if let Some(J::String(s)) = flat.textures.get(&format!("layer{i}")) {
                out.push(norm_tex(s));
            }
        }
        if out.is_empty() { None } else { Some(out) }
    }

    pub fn model_has_elements(&self, model: &str) -> bool {
        self.flatten(&norm_model(model)).map(|f| !f.elements.is_empty()).unwrap_or(false)
    }
}
