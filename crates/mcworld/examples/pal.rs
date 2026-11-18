use mcworld::nbt::V;
fn main() {
    let worlds = mcworld::world::discover();
    let w = worlds.iter().find(|w| w.folder == "Longevity (1)" && w.instance == "LongTerm").unwrap();
    let dir = w.path.join("dimensions/minecraft/overworld/region");
    let reg = mcworld::region::Region::open(&dir.join("r.0.0.mca")).unwrap();
    for lz in 0..32 { for lx in 0..32 {
        let Ok(Some(b)) = reg.chunk_bytes(lx, lz) else { continue };
        let v = mcworld::nbt::parse(&b).unwrap();
        for s in v.get_list("sections") {
            for p in s.get("block_states").map(|b| b.get_list("palette")).unwrap_or(&[]) {
                let d = format!("{:?}", p);
                if d.contains("slab") || d.contains("log") { println!("{}", &d[..d.len().min(400)]); return; }
            }
        }
    }}
}
