//! Block entities without block-model geometry (chests, shulker boxes), built from the game's
//! own entity model definitions (ModelPart cubes, texture offsets and renderer transforms).

use crate::jar::Jar;
use crate::model::{BakedModel, Dir, Quad};
use crate::textures::{TexInfo, TextureArray};
use blockdata::BlockState;
use std::collections::HashMap;

type M3 = [[f32; 3]; 3];

#[derive(Clone, Copy)]
pub struct Affine {
    pub m: M3,
    pub t: [f32; 3],
}

impl Affine {
    pub const ID: Affine = Affine { m: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], t: [0.0; 3] };
    pub fn apply(&self, v: [f32; 3]) -> [f32; 3] {
        let m = &self.m;
        [
            m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2] + self.t[0],
            m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2] + self.t[1],
            m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2] + self.t[2],
        ]
    }
    /// self ∘ o (apply o first)
    pub fn then(&self, o: &Affine) -> Affine {
        let a = &self.m;
        let b = &o.m;
        let mut m = [[0.0; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                m[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
            }
        }
        let t = self.apply(o.t);
        Affine { m, t }
    }
    pub fn translate(x: f32, y: f32, z: f32) -> Affine {
        Affine { t: [x, y, z], ..Affine::ID }
    }
    pub fn scale(x: f32, y: f32, z: f32) -> Affine {
        Affine { m: [[x, 0.0, 0.0], [0.0, y, 0.0], [0.0, 0.0, z]], t: [0.0; 3] }
    }
    pub fn rot(axis: u8, rad: f32) -> Affine {
        let (s, c) = rad.sin_cos();
        let m = match axis {
            0 => [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]],
            1 => [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]],
            _ => [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]],
        };
        Affine { m, t: [0.0; 3] }
    }
    /// rotationZYX(z, y, x): X applied first.
    pub fn zyx(z: f32, y: f32, x: f32) -> Affine {
        Affine::rot(2, z).then(&Affine::rot(1, y)).then(&Affine::rot(0, x))
    }
    /// rotationXYZ(x, y, z): Z applied first.
    pub fn xyz(x: f32, y: f32, z: f32) -> Affine {
        Affine::rot(0, x).then(&Affine::rot(1, y)).then(&Affine::rot(2, z))
    }
}

#[derive(Clone)]
pub struct Cube {
    pub u: f32,
    pub v: f32,
    pub min: [f32; 3],
    pub size: [f32; 3],
    pub grow: f32,
    pub mirror: bool,
    /// Bits of `Dir` to leave out.
    pub hide: u8,
}

impl Cube {
    pub fn new(u: f32, v: f32, min: [f32; 3], size: [f32; 3]) -> Cube {
        Cube { u, v, min, size, grow: 0.0, mirror: false, hide: 0 }
    }
    pub fn hide(mut self, d: Dir) -> Cube {
        self.hide |= d.bit();
        self
    }
    pub fn grow(mut self, g: f32) -> Cube {
        self.grow = g;
        self
    }
    pub fn mirror(mut self) -> Cube {
        self.mirror = true;
        self
    }
}

#[derive(Clone)]
pub struct Part {
    pub offset: [f32; 3],
    /// radians (x, y, z)
    pub rot: [f32; 3],
    pub cubes: Vec<Cube>,
    pub children: Vec<Part>,
}

impl Part {
    pub fn new(offset: [f32; 3], cubes: Vec<Cube>) -> Part {
        Part { offset, rot: [0.0; 3], cubes, children: vec![] }
    }
    pub fn rot(mut self, x: f32, y: f32, z: f32) -> Part {
        self.rot = [x, y, z];
        self
    }
    pub fn child(mut self, c: Part) -> Part {
        self.children.push(c);
        self
    }
    fn pose(&self) -> Affine {
        let t = Affine::translate(self.offset[0] / 16.0, self.offset[1] / 16.0, self.offset[2] / 16.0);
        if self.rot == [0.0; 3] { t } else { t.then(&Affine::zyx(self.rot[2], self.rot[1], self.rot[0])) }
    }
}

/// A polygon of an entity model, in final (block-local, 0..1) coordinates with texture-pixel UVs.
pub struct Poly {
    pub pos: [[f32; 3]; 4],
    /// UV in texture pixels per vertex
    pub uv: [[f32; 2]; 4],
}

/// Walk a part tree and output polygons with the same vertex/UV layout as the game's ModelPart.Cube.
pub fn polys(part: &Part, parent: &Affine, out: &mut Vec<Poly>) {
    let pose = parent.then(&part.pose());
    for c in &part.cubes {
        let (mut x0, y0, z0) = (c.min[0] - c.grow, c.min[1] - c.grow, c.min[2] - c.grow);
        let (mut x1, y1, z1) = (c.min[0] + c.size[0] + c.grow, c.min[1] + c.size[1] + c.grow, c.min[2] + c.size[2] + c.grow);
        if c.mirror {
            std::mem::swap(&mut x0, &mut x1);
        }
        let t0 = [x0, y0, z0];
        let t1 = [x1, y0, z0];
        let t2 = [x1, y1, z0];
        let t3 = [x0, y1, z0];
        let l0 = [x0, y0, z1];
        let l1 = [x1, y0, z1];
        let l2 = [x1, y1, z1];
        let l3 = [x0, y1, z1];
        let (w, h, d) = (c.size[0], c.size[1], c.size[2]);
        let u0 = c.u;
        let u1 = c.u + d;
        let u2 = c.u + d + w;
        let u22 = c.u + d + w + w;
        let u3 = c.u + d + w + d;
        let u4 = c.u + d + w + d + w;
        let v0 = c.v;
        let v1 = c.v + d;
        let v2 = c.v + d + h;
        let faces: [(Dir, [[f32; 3]; 4], [f32; 4]); 6] = [
            (Dir::Down, [l1, l0, t0, t1], [u1, v0, u2, v1]),
            (Dir::Up, [t2, t3, l3, l2], [u2, v1, u22, v0]),
            (Dir::West, [t0, l0, l3, t3], [u0, v1, u1, v2]),
            (Dir::North, [t1, t0, t3, t2], [u1, v1, u2, v2]),
            (Dir::East, [l1, t1, t2, l2], [u2, v1, u3, v2]),
            (Dir::South, [l0, l1, l2, l3], [u3, v1, u4, v2]),
        ];
        for (dir, verts, [pu0, pv0, pu1, pv1]) in faces {
            if c.hide & dir.bit() != 0 {
                continue;
            }
            let mut uv = [[pu1, pv0], [pu0, pv0], [pu0, pv1], [pu1, pv1]];
            let mut pos = verts.map(|v| pose.apply([v[0] / 16.0, v[1] / 16.0, v[2] / 16.0]));
            if c.mirror {
                pos.reverse();
                uv.reverse();
            }
            out.push(Poly { pos, uv });
        }
    }
    for ch in &part.children {
        polys(ch, &pose, out);
    }
}

/// Turn polygons into quads. The texture rect of each polygon becomes its own 16x16 layer.
pub fn quads_from_polys(polys: &[Poly], tex_name: &str, img: &image::RgbaImage, tex_size: (f32, f32), block_tf: &Affine, tex: &TextureArray) -> Vec<Quad> {
    let sx = img.width() as f32 / tex_size.0;
    let sy = img.height() as f32 / tex_size.1;
    let mut out = Vec::new();
    for p in polys {
        let (mut umin, mut umax, mut vmin, mut vmax) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
        for uv in &p.uv {
            umin = umin.min(uv[0]);
            umax = umax.max(uv[0]);
            vmin = vmin.min(uv[1]);
            vmax = vmax.max(uv[1]);
        }
        if umax - umin < 1e-4 || vmax - vmin < 1e-4 {
            continue;
        }
        let rect = ((umin * sx).round() as u32, (vmin * sy).round() as u32, ((umax - umin) * sx).round().max(1.0) as u32, ((vmax - vmin) * sy).round().max(1.0) as u32);
        let key = format!("{tex_name}#{},{},{},{}", rect.0, rect.1, rect.2, rect.3);
        let info: TexInfo = tex.add_virtual(&key, img, rect, 0, false, false);
        let uv = p.uv.map(|u| [(u[0] - umin) / (umax - umin), (u[1] - vmin) / (vmax - vmin)]);
        let pos = p.pos.map(|v| block_tf.apply(v));
        if let Some(mut q) = crate::model::finish_quad(pos, uv, &info, -1, true) {
            if q.full {
                q.cull = Some(q.face);
            }
            out.push(q);
        }
    }
    out
}

pub struct EntityModels {
    textures: HashMap<String, image::RgbaImage>,
}

fn load(jar: &Jar, rel: &str) -> Option<image::RgbaImage> {
    image::load_from_memory(jar.get(rel)?).ok().map(|i| i.to_rgba8())
}

const COLORS: &[&str] = &[
    "white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black",
];

fn facing_yrot(f: &str) -> f32 {
    match f {
        "south" => 0.0,
        "west" => 90.0,
        "north" => 180.0,
        "east" => 270.0,
        _ => 0.0,
    }
}

impl EntityModels {
    pub fn new(jar: &Jar) -> EntityModels {
        let mut textures = HashMap::new();
        for name in jar.list("textures/entity/chest/").chain(jar.list("textures/entity/shulker/")).map(|s| s.to_string()).collect::<Vec<_>>() {
            if name.ends_with(".png") {
                if let Some(img) = load(jar, &name) {
                    textures.insert(name.trim_start_matches("textures/").trim_end_matches(".png").to_string(), img);
                }
            }
        }
        EntityModels { textures }
    }

    /// Whether this block is drawn by an entity renderer we know how to replicate.
    pub fn handles(name: &str) -> bool {
        let n = name.trim_start_matches("minecraft:");
        n == "chest" || n == "trapped_chest" || n == "ender_chest" || n.ends_with("copper_chest") || n.ends_with("shulker_box")
    }

    pub fn model_for(&self, st: &BlockState, tex: &TextureArray) -> Option<BakedModel> {
        let n = st.name.trim_start_matches("minecraft:");
        if !Self::handles(n) {
            return None;
        }
        if n.ends_with("shulker_box") {
            let color = n.trim_end_matches("shulker_box").trim_end_matches('_');
            let tname = if color.is_empty() { "entity/shulker/shulker".to_string() } else { format!("entity/shulker/shulker_{color}") };
            if !color.is_empty() && !COLORS.contains(&color) {
                return None;
            }
            let img = self.textures.get(&tname)?;
            let root = Part::new([0.0; 3], vec![])
                .child(Part::new([0.0, 24.0, 0.0], vec![Cube::new(0.0, 0.0, [-8.0, -16.0, -8.0], [16.0, 12.0, 16.0])]))
                .child(Part::new([0.0, 24.0, 0.0], vec![Cube::new(0.0, 28.0, [-8.0, -8.0, -8.0], [16.0, 8.0, 16.0])]));
            let mut ps = Vec::new();
            polys(&root, &Affine::ID, &mut ps);
            let half = std::f32::consts::FRAC_PI_2;
            let pi = std::f32::consts::PI;
            let rot = match st.prop("facing").unwrap_or("up") {
                "down" => Affine::rot(0, pi),
                "north" => Affine::xyz(half, 0.0, pi),
                "south" => Affine::rot(0, half),
                "west" => Affine::xyz(half, 0.0, half),
                "east" => Affine::xyz(half, 0.0, -half),
                _ => Affine::ID,
            };
            let tf = Affine::translate(0.5, 0.5, 0.5).then(&rot).then(&Affine::scale(1.0, -1.0, -1.0)).then(&Affine::translate(0.0, -1.0, 0.0));
            let quads = quads_from_polys(&ps, &tname, img, (64.0, 64.0), &tf, tex);
            return Some(BakedModel { quads, ao: true });
        }
        // chests
        let ty = st.prop("type").unwrap_or("single");
        let base = match n {
            "chest" => "normal",
            "trapped_chest" => "trapped",
            "ender_chest" => "ender",
            x if x.contains("copper_chest") => {
                let x = x.trim_start_matches("waxed_");
                match x {
                    "exposed_copper_chest" => "copper_exposed",
                    "weathered_copper_chest" => "copper_weathered",
                    "oxidized_copper_chest" => "copper_oxidized",
                    _ => "copper",
                }
            }
            _ => "normal",
        };
        let tname = match ty {
            "left" if base != "ender" => format!("entity/chest/{base}_left"),
            "right" if base != "ender" => format!("entity/chest/{base}_right"),
            _ => format!("entity/chest/{base}"),
        };
        let img = self.textures.get(&tname)?;
        let lid_off = [0.0, 9.0, 1.0];
        let root = match ty {
            "right" if base != "ender" => {
                let h = |c: Cube| c.hide(Dir::East);
                Part::new([0.0; 3], vec![h(Cube::new(0.0, 19.0, [1.0, 0.0, 1.0], [15.0, 10.0, 14.0]))])
                    .child(Part::new(lid_off, vec![h(Cube::new(0.0, 0.0, [1.0, 0.0, 0.0], [15.0, 5.0, 14.0]))]))
                    .child(Part::new(lid_off, vec![h(Cube::new(0.0, 0.0, [15.0, -2.0, 14.0], [1.0, 4.0, 1.0]))]))
            }
            "left" if base != "ender" => {
                let h = |c: Cube| c.hide(Dir::West);
                Part::new([0.0; 3], vec![h(Cube::new(0.0, 19.0, [0.0, 0.0, 1.0], [15.0, 10.0, 14.0]))])
                    .child(Part::new(lid_off, vec![h(Cube::new(0.0, 0.0, [0.0, 0.0, 0.0], [15.0, 5.0, 14.0]))]))
                    .child(Part::new(lid_off, vec![h(Cube::new(0.0, 0.0, [0.0, -2.0, 14.0], [1.0, 4.0, 1.0]))]))
            }
            _ => Part::new([0.0; 3], vec![Cube::new(0.0, 19.0, [1.0, 0.0, 1.0], [14.0, 10.0, 14.0])])
                .child(Part::new(lid_off, vec![Cube::new(0.0, 0.0, [1.0, 0.0, 0.0], [14.0, 5.0, 14.0])]))
                .child(Part::new(lid_off, vec![Cube::new(0.0, 0.0, [7.0, -2.0, 14.0], [2.0, 4.0, 1.0])])),
        };
        let mut ps = Vec::new();
        polys(&root, &Affine::ID, &mut ps);
        let yrot = facing_yrot(st.prop("facing").unwrap_or("north"));
        let tf = Affine::translate(0.5, 0.0, 0.5).then(&Affine::rot(1, (-yrot).to_radians())).then(&Affine::translate(-0.5, 0.0, -0.5));
        let quads = quads_from_polys(&ps, &tname, img, (64.0, 64.0), &tf, tex);
        Some(BakedModel { quads, ao: true })
    }

    pub fn texture(&self, name: &str) -> Option<&image::RgbaImage> {
        self.textures.get(name)
    }
}
