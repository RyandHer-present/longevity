use mcworld::nbt::{self, V, Value};
fn show(v: &Value, pre: &str, depth: usize) {
    if let Some(m) = v.compound() { let mut ks: Vec<_> = m.keys().collect(); ks.sort(); for k in ks { let c = &m[k]; match c { Value::Compound(_) if depth < 3 => { println!("{pre}{k}:"); show(c, &format!("{pre}  "), depth+1) } Value::List(l) => println!("{pre}{k}: list[{}]", l.len()), Value::String(s) => println!("{pre}{k} = {:?}", s.chars().take(60).collect::<String>()), Value::Compound(_) => println!("{pre}{k}: {{..}}"), o => println!("{pre}{k} = {:?}", o) } } }
}
fn main() {
    let p = std::env::args().nth(1).unwrap();
    let v = nbt::read_file(std::path::Path::new(&p).join("level.dat").as_path()).unwrap();
    show(&v, "", 0);
    let w = mcworld::World::open(std::path::Path::new(&p)).unwrap();
    let c = w.chunk(mcworld::Dim::Overworld, 0, 0).unwrap();
    for y in (40..72).rev() { print!("{}:{} ", y, c.block(0, y, 0).map(|b| b.short().to_string()).unwrap_or("-".into())); }
    println!(); println!("surface {:?}", &c.surface.as_ref().unwrap()[..4]); println!("motion {:?}", &c.motion.as_ref().map(|m| m[..4].to_vec()));
}
