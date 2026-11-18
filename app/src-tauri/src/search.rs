//! Storage index: every container, item-holding entity and the player's own inventories,
//! limited to chunks the player has seen. Unopened loot (LootTable) is never indexed.

use mcworld::items::{items_of, Item};
use mcworld::nbt::{Value, V};
use mcworld::{Dim, World};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Serialize)]
pub struct Container {
    pub id: usize,
    /// block or entity id, e.g. "minecraft:chest", "minecraft:chest_minecart", "player:inventory"
    pub kind: String,
    pub dim: String,
    pub pos: [i32; 3],
    pub name: Option<String>,
    pub items: Vec<Item>,
}

#[derive(Default)]
pub struct Index {
    pub containers: Vec<Container>,
    pub built_ms: i64,
}

fn item_keys(be: &Value) -> Vec<Item> {
    let mut items = items_of(be.get_list("Items"));
    for single in ["item", "Book", "RecordItem", "Item"] {
        if let Some(v) = be.get(single) {
            if let Some(it) = mcworld::items::item_of(v) {
                items.push(it);
            }
        }
    }
    items
}

pub fn build(world: &World, seen: &HashMap<Dim, HashSet<(i32, i32)>>) -> Index {
    let mut containers: Vec<Container> = Vec::new();
    for dim in Dim::all() {
        let Some(seen) = seen.get(&dim) else { continue };
        let chunks: Vec<(i32, i32)> = seen.iter().copied().collect();
        let found: Vec<Container> = chunks
            .par_iter()
            .filter_map(|&(cx, cz)| {
                let reg = world.region(dim, cx >> 5, cz >> 5)?;
                let c = World::chunk_uncached(&reg, (cx & 31) as usize, (cz & 31) as usize)?;
                let mut out = Vec::new();
                for be in &c.block_entities {
                    if be.get("LootTable").is_some() {
                        continue;
                    }
                    let items = item_keys(be);
                    if items.is_empty() {
                        continue;
                    }
                    let id = be.get_str("id").unwrap_or("minecraft:container").to_string();
                    let pos = [be.get_i64("x").unwrap_or(0) as i32, be.get_i64("y").unwrap_or(0) as i32, be.get_i64("z").unwrap_or(0) as i32];
                    let name = be.get("CustomName").or_else(|| be.path(&["components", "minecraft:custom_name"])).map(mcworld::nbt::text_of).filter(|s| !s.is_empty());
                    out.push(Container { id: 0, kind: id, dim: dim.id().to_string(), pos, name, items });
                }
                Some(out)
            })
            .flatten()
            .collect();
        containers.extend(found);
        // entities that hold items: minecarts, chest boats, item frames, armor stands, chested pack animals
        let regions: HashSet<(i32, i32)> = seen.iter().map(|(x, z)| (x >> 5, z >> 5)).collect();
        let ents: Vec<Container> = regions
            .par_iter()
            .flat_map(|&(rx, rz)| {
                let mut out = Vec::new();
                for e in world.entities_in_region(dim, rx, rz) {
                    let pos = e.get_list("Pos");
                    if pos.len() != 3 {
                        continue;
                    }
                    let p = [pos[0].f64().unwrap_or(0.0), pos[1].f64().unwrap_or(0.0), pos[2].f64().unwrap_or(0.0)];
                    let ch = ((p[0].floor() as i32) >> 4, (p[2].floor() as i32) >> 4);
                    if !seen.contains(&ch) || e.get("LootTable").is_some() {
                        continue;
                    }
                    let mut items = item_keys(&e);
                    if let Some(eq) = e.get("equipment").and_then(|v| v.compound()) {
                        for v in eq.values() {
                            if let Some(it) = mcworld::items::item_of(v) {
                                items.push(it);
                            }
                        }
                    }
                    for k in ["HandItems", "ArmorItems"] {
                        items.extend(items_of(e.get_list(k)));
                    }
                    if items.is_empty() {
                        continue;
                    }
                    let kind = e.get_str("id").unwrap_or("minecraft:entity").to_string();
                    // only things that actually store or display items: not dropped items, arrows or mobs' gear
                    let short = kind.trim_start_matches("minecraft:");
                    let chested = e.get_i64("ChestedHorse").unwrap_or(0) != 0;
                    let storage = short.ends_with("_minecart")
                        || short.contains("chest_boat")
                        || short.contains("chest_raft")
                        || matches!(short, "item_frame" | "glow_item_frame" | "armor_stand")
                        || (chested && matches!(short, "donkey" | "mule" | "llama" | "trader_llama"));
                    if !storage {
                        continue;
                    }
                    let name = e.get("CustomName").map(mcworld::nbt::text_of).filter(|s| !s.is_empty());
                    out.push(Container { id: 0, kind, dim: dim.id().to_string(), pos: [p[0].floor() as i32, p[1].floor() as i32, p[2].floor() as i32], name, items });
                }
                out
            })
            .collect();
        containers.extend(ents);
    }
    // the player's own inventory and ender chest
    for (_uuid, p) in world.players() {
        let pos = p.get_list("Pos");
        let pp = if pos.len() == 3 { [pos[0].f64().unwrap_or(0.0) as i32, pos[1].f64().unwrap_or(0.0) as i32, pos[2].f64().unwrap_or(0.0) as i32] } else { [0, 0, 0] };
        let dim = p.get_str("Dimension").unwrap_or("minecraft:overworld").to_string();
        let mut inv = items_of(p.get_list("Inventory"));
        if let Some(eq) = p.get("equipment").and_then(|v| v.compound()) {
            for v in eq.values() {
                if let Some(it) = mcworld::items::item_of(v) {
                    inv.push(it);
                }
            }
        }
        if !inv.is_empty() {
            containers.push(Container { id: 0, kind: "player:inventory".into(), dim: dim.clone(), pos: pp, name: Some("Your inventory".into()), items: inv });
        }
        let ender = items_of(p.get_list("EnderItems"));
        if !ender.is_empty() {
            containers.push(Container { id: 0, kind: "player:ender_chest".into(), dim, pos: pp, name: Some("Your ender chest".into()), items: ender });
        }
    }
    for (i, c) in containers.iter_mut().enumerate() {
        c.id = i;
    }
    Index { containers, built_ms: atlascore::now_ms() }
}

#[derive(Serialize, Clone)]
pub struct Hit {
    pub container: usize,
    pub kind: String,
    pub dim: String,
    pub pos: [i32; 3],
    pub name: Option<String>,
    pub matches: Vec<(String, i64, Option<String>, Vec<String>, bool)>, // id, count, custom name, enchants, nested
    pub total: i64,
}

fn walk<'a>(items: &'a [Item], nested: bool, f: &mut dyn FnMut(&'a Item, bool)) {
    for it in items {
        f(it, nested);
        walk(&it.contents, true, f);
    }
}

pub fn search(idx: &Index, q: &str, names: &dyn Fn(&str) -> String, limit: usize) -> Vec<Hit> {
    let q = q.trim().to_lowercase();
    let mut hits = Vec::new();
    for c in &idx.containers {
        let mut matches = Vec::new();
        let mut total = 0;
        walk(&c.items, false, &mut |it, nested| {
            let ok = q.is_empty() || it.id.to_lowercase().contains(&q) || names(&it.id).to_lowercase().contains(&q) || it.name.as_deref().map(|n| n.to_lowercase().contains(&q)).unwrap_or(false) || it.enchants.iter().any(|e| e.to_lowercase().contains(&q));
            if ok {
                total += it.count;
                matches.push((it.id.clone(), it.count, it.name.clone(), it.enchants.clone(), nested));
            }
        });
        if !matches.is_empty() {
            hits.push(Hit { container: c.id, kind: c.kind.clone(), dim: c.dim.clone(), pos: c.pos, name: c.name.clone(), matches, total });
        }
    }
    hits.sort_by(|a, b| b.total.cmp(&a.total));
    hits.truncate(limit);
    hits
}

/// Total of every item across all storage.
pub fn totals(idx: &Index) -> Vec<(String, i64, usize)> {
    let mut m: HashMap<String, (i64, HashSet<usize>)> = HashMap::new();
    for c in &idx.containers {
        walk(&c.items, false, &mut |it, _| {
            let e = m.entry(it.id.clone()).or_default();
            e.0 += it.count;
            e.1.insert(c.id);
        });
    }
    let mut v: Vec<(String, i64, usize)> = m.into_iter().map(|(k, (n, s))| (k, n, s.len())).collect();
    v.sort_by(|a, b| b.1.cmp(&a.1));
    v
}
