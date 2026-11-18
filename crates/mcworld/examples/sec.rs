use mcworld::nbt::{self, V, Value};
fn main() {
    let p = std::env::args().nth(1).unwrap();
    let w = mcworld::World::open(std::path::Path::new(&p)).unwrap();
    let r = w.region(mcworld::Dim::Overworld, 0, 0).unwrap();
    let b = r.chunk_bytes(0, 0).unwrap().unwrap();
    let v = nbt::parse(&b).unwrap();
    println!("top keys {:?}", v.compound().unwrap().keys().collect::<Vec<_>>());
    println!("yPos {:?}", v.get("yPos"));
    for s in v.get_list("sections").iter().take(12) {
        let bs = s.get("block_states");
        let pal = bs.map(|b| b.get_list("palette").len());
        let first = bs.and_then(|b| b.get_list("palette").first().cloned());
        let data = bs.and_then(|b| b.get("data")).map(|d| match d { Value::LongArray(a) => format!("longs {}", a.len()), o => format!("other {:?}", std::mem::discriminant(o)) });
        println!("Y {:?} pal {:?} first {:?} data {:?} keys {:?}", s.get("Y"), pal, first, data, s.compound().map(|m| m.keys().cloned().collect::<Vec<_>>()));
    }
}
