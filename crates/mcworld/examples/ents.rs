use mcworld::nbt::V;
use mcworld::{Dim, World};
use std::collections::HashMap;
fn main() {
    let w = mcworld::world::discover().into_iter().find(|w| w.folder == "Longevity (1)").expect("world");
    let world = World::open(&w.path).unwrap();
    for d in Dim::all() {
        let mut m: HashMap<String, usize> = HashMap::new();
        for (rx, rz, _) in world.regions(d) {
            for e in world.entities_in_region(d, rx, rz) {
                *m.entry(e.get_str("id").unwrap_or("?").to_string()).or_default() += 1;
            }
        }
        let mut v: Vec<_> = m.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1));
        println!("{:?}: {:?}", d, v);
    }
}
