use mcassets::*;
use std::collections::HashMap;

fn main() -> anyhow::Result<()> {
    let t = std::time::Instant::now();
    let a = Assets::discover("26.3")?;
    println!("loaded assets {} in {:?}", a.version, t.elapsed());
    let worlds = mcworld::world::discover();
    let w = worlds.iter().find(|w| w.folder == "Longevity (1)" && w.instance == "LongTerm").expect("world");
    let world = mcworld::World::open(&w.path)?;
    let mut counts: HashMap<blockdata::BlockState, usize> = HashMap::new();
    let t = std::time::Instant::now();
    for (rx, rz) in [(0, 0), (-4, -2), (-1, -1)] {
        if let Some(reg) = world.region(mcworld::Dim::Overworld, rx, rz) {
            for lz in 0..32 {
                for lx in 0..32 {
                    if let Some(c) = world.chunk(mcworld::Dim::Overworld, rx * 32 + lx, rz * 32 + lz) {
                        for s in c.sections.iter().flatten() {
                            for p in &s.palette {
                                *counts.entry(p.clone()).or_default() += 1;
                            }
                        }
                    }
                }
            }
            let _ = reg;
        }
    }
    println!("{} distinct states, scan {:?}", counts.len(), t.elapsed());
    let t = std::time::Instant::now();
    let mut invisible = vec![];
    let mut missing_tex = vec![];
    for st in counts.keys() {
        let b = a.models.state(st);
        if !b.visible && !st.is_air() {
            if invisible.len() < 3 { println!("DBG {:?}", st); }
            invisible.push(st.to_string());
        }
        for p in &b.parts {
            for q in &p[0].1.quads {
                if q.tex == 0 {
                    missing_tex.push(st.to_string());
                    break;
                }
            }
        }
    }
    invisible.sort();
    invisible.dedup();
    missing_tex.sort();
    missing_tex.dedup();
    println!("baked in {:?}; layers {}", t.elapsed(), a.tex.layer_count());
    println!("INVISIBLE ({}): {:?}", invisible.len(), &invisible[..invisible.len().min(60)]);
    println!("MISSING TEX ({}): {:?}", missing_tex.len(), &missing_tex[..missing_tex.len().min(40)]);
    let out = std::path::PathBuf::from(std::env::args().nth(1).unwrap_or(".".into()));
    std::fs::create_dir_all(&out)?;
    let mut sheet = image::RgbaImage::new(64 * 8, 64 * 3);
    for (i, id) in ["grass_block", "oak_stairs", "chest", "furnace", "diamond_sword", "oak_leaves", "torch", "white_shulker_box", "crafting_table", "glass", "oak_fence", "potion", "red_bed", "lantern", "water_bucket", "spyglass", "cobblestone_wall", "hopper", "oak_door", "anvil", "enchanting_table", "rail", "redstone", "bookshelf"].iter().enumerate() {
        match icons::item_icon(&a, id, 64) {
            Some(img) => image::imageops::overlay(&mut sheet, &img, (i as i64 % 8) * 64, (i as i64 / 8) * 64),
            None => println!("no icon for {id}"),
        }
    }
    sheet.save(out.join("icons.png"))?;
    println!("wrote icons");
    Ok(())
}
#[allow(dead_code)]
fn dbg_states() {}
