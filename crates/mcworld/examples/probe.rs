use mcworld::*;
use mcworld::nbt::V;
fn main() {
    let worlds = world::discover();
    for w in worlds.iter().take(8) { println!("{} | {} | {} | {}", w.instance, w.name, w.version, w.path.display()); }
    let p = std::env::args().nth(1).expect("world path");
    let w = World::open(std::path::Path::new(&p)).unwrap();
    let lv = w.level().unwrap();
    println!("{:?}", lv);
    let regs = w.regions(Dim::Overworld);
    println!("overworld regions: {}", regs.len());
    let t = std::time::Instant::now();
    let (rx, rz, _) = regs.iter().find(|r| r.0 == 0 && r.1 == 0).cloned().unwrap_or(regs[0].clone());
    let r = w.region(Dim::Overworld, rx, rz).unwrap();
    let mut n = 0; let mut be = 0; let mut inh = 0i64; let mut st = Vec::new();
    for (lx, lz) in r.present().collect::<Vec<_>>() {
        if let Some(c) = World::chunk_uncached(&r, lx, lz) { n += 1; be += c.block_entities.len(); inh += c.inhabited_time; for s in &c.structures { st.push(s.id.clone()); } }
    }
    println!("region {rx},{rz}: {n} chunks, {be} block entities, inhabited {inh}, decode {:?}", t.elapsed());
    st.sort(); st.dedup(); println!("structures: {:?}", st);
    let c = w.chunk(Dim::Overworld, 0, 0).unwrap();
    println!("chunk 0,0 status {} min_section {} sections {} surface[0]={:?}", c.status, c.min_section, c.sections.len(), c.surface.as_ref().map(|s| s[0]));
    if let Some(s) = &c.surface { let y = s[0]; println!("top block at 0,{y},0 = {:?}", c.block(0, y, 0)); }
    for be in c.block_entities.iter().take(3) { println!("BE {:?}", be.get_str("id")); }
    for (uuid, p) in w.players() {
        println!("player {uuid}: pos {:?} dim {:?} keys {:?}", p.get("Pos"), p.get_str("Dimension"), p.compound().map(|m| { let mut k: Vec<_> = m.keys().cloned().collect(); k.sort(); k }));
        let inv = items::items_of(p.get_list("Inventory"));
        println!("inventory: {}", inv.iter().map(|i| format!("{}x{}", i.count, i.short_id())).collect::<Vec<_>>().join(", "));
    }
    println!("open in game: {}", w.is_open_in_game());
}
