use mcworld::nbt::{self};
fn main() { for p in std::env::args().skip(1) { let v = nbt::read_file(std::path::Path::new(&p)).unwrap(); println!("{p}:\n{:?}\n", v); } }
