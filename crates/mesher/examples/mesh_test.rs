use blockdata::{BlockSource, Section};
use mcworld::{Chunk, Dim, World};
use std::collections::HashMap;
use std::sync::Arc;

struct View {
    chunks: HashMap<(i32, i32), Arc<Chunk>>,
}
impl BlockSource for View {
    fn section(&self, cx: i32, sy: i32, cz: i32) -> Option<&Section> {
        self.chunks.get(&(cx, cz))?.section(sy)
    }
    fn section_range(&self) -> (i32, i32) {
        (-4, 19)
    }
}
impl mesher::MeshSource for View {
    fn light(&self, cx: i32, sy: i32, cz: i32) -> (Option<&[u8]>, Option<&[u8]>) {
        match self.chunks.get(&(cx, cz)).and_then(|c| c.light(sy)) {
            Some(l) => (l.sky.as_deref(), l.block.as_deref()),
            None => (None, None),
        }
    }
}

fn main() -> anyhow::Result<()> {
    use rayon::prelude::*;
    let assets = mcassets::Assets::discover("26.3")?;
    let worlds = mcworld::world::discover();
    let w = worlds.iter().find(|w| w.folder == "Longevity (1)" && w.instance == "LongTerm").unwrap();
    let world = World::open(&w.path)?;
    let (pcx, pcz) = ((-2048i32) >> 4, (-831i32) >> 4);
    let r = 8;
    let t = std::time::Instant::now();
    let mut chunks = HashMap::new();
    for cz in pcz - r - 1..=pcz + r + 1 {
        for cx in pcx - r - 1..=pcx + r + 1 {
            if let Some(c) = world.chunk(Dim::Overworld, cx, cz) {
                chunks.insert((cx, cz), c);
            }
        }
    }
    println!("loaded {} chunks in {:?}", chunks.len(), t.elapsed());
    let c0 = chunks.get(&(pcx, pcz)).unwrap();
    let with_sky = c0.light.iter().filter(|l| l.sky.is_some()).count();
    println!("center chunk: {} sections, {} with skylight, min_section {}", c0.sections.len(), with_sky, c0.min_section);
    let view = View { chunks };
    for skip in [false, true] {
        let t = std::time::Instant::now();
        let opts = mesher::MeshOptions { skip_dark: skip, ..Default::default() };
        let coords: Vec<(i32, i32)> = (pcz - r..=pcz + r).flat_map(|z| (pcx - r..=pcx + r).map(move |x| (x, z))).collect();
        let meshes: Vec<mesher::ChunkMesh> = coords.par_iter().map(|&(x, z)| mesher::mesh_chunk(&view, &assets, x, z, &opts)).collect();
        let quads: usize = meshes.iter().map(|m| m.opaque.quads() + m.translucent.quads()).sum();
        let bytes: usize = meshes.iter().map(|m| m.to_bytes().len()).sum();
        println!("skip_dark={skip}: {} chunks, {} quads ({:.0}/chunk), {:.1} MB, {:?}", meshes.len(), quads, quads as f64 / meshes.len() as f64, bytes as f64 / 1e6, t.elapsed());
    }
    println!("texture layers now {}", assets.tex.layer_count());
    Ok(())
}
