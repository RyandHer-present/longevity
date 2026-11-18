use mcworld::nbt::V;
use mcworld::{Dim, World};
use std::collections::HashMap;
fn main() {
    let w = mcworld::world::discover().into_iter().find(|w| w.folder == "Longevity (1)").expect("world");
    let world = World::open(&w.path).unwrap();
    let want = ["minecraft:sheep", "minecraft:panda", "minecraft:axolotl", "minecraft:mooshroom", "minecraft:creeper", "minecraft:drowned", "minecraft:wolf", "minecraft:cat", "minecraft:pillager", "minecraft:chicken", "minecraft:spider", "minecraft:skeleton_horse", "minecraft:zombie"];
    let mut shown: HashMap<String, usize> = HashMap::new();
    for d in Dim::all() {
        for (rx, rz, _) in world.entity_regions(d) {
            for e in world.entities_in_region(d, rx, rz) {
                let id = e.get_str("id").unwrap_or("?").to_string();
                if !want.contains(&id.as_str()) { continue; }
                let n = shown.entry(id.clone()).or_default();
                let pass = e.get_list("Passengers").len();
                if *n >= 2 && pass == 0 { continue; }
                *n += 1;
                let mut keys: Vec<String> = e.compound().map(|c| c.keys().cloned().collect()).unwrap_or_default();
                keys.sort();
                println!("{id} pass={pass} keys={:?}", keys);
                for k in ["Color", "MainGene", "HiddenGene", "Variant", "variant", "Type", "powered", "PatrolLeader", "CollarColor"] {
                    if let Some(v) = e.get(k) { println!("   {k} = {:?} {:?}", v.str(), v.i64()); }
                }
                if let Some(eq) = e.get("equipment") { println!("   equipment={:?}", eq.compound().map(|c| c.keys().cloned().collect::<Vec<_>>())); if let Some(m) = eq.get("mainhand") { println!("   mainhand={:?}", m.get_str("id")); } }
                for p in e.get_list("Passengers") { println!("   passenger {:?}", p.get_str("id")); }
            }
        }
    }
}
