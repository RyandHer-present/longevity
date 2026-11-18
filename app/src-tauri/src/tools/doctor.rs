//! Storage Doctor: messy chests, items split over many chests, stacks that could merge, shulker
//! boxes and what's in them, free space, and a step-by-step cleanup plan that the companion mod
//! can show in game with glowing chests.

use super::{max_stack, slots_of};
use crate::search::Container;
use crate::Ctx;
use mcassets::Assets;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

/// A rough family for an item, so "messy" means mixing unrelated things.
pub fn category(id: &str) -> &'static str {
    let s = id.trim_start_matches("minecraft:");
    let has = |k: &[&str]| k.iter().any(|x| s.contains(x));
    if has(&["sword", "pickaxe", "_axe", "shovel", "_hoe", "helmet", "chestplate", "leggings", "boots", "bow", "trident", "shield", "elytra", "mace", "spear", "fishing_rod", "shears", "flint_and_steel"]) {
        "gear"
    } else if has(&["enchanted_book", "potion", "totem", "golden_apple", "experience_bottle", "firework"]) {
        "special"
    } else if has(&["diamond", "emerald", "iron_", "gold_", "copper", "netherite", "lapis", "redstone_block", "coal", "quartz", "amethyst", "_ore", "raw_"]) {
        "ores"
    } else if has(&["redstone", "repeater", "comparator", "piston", "observer", "hopper", "dispenser", "dropper", "lever", "button", "pressure_plate", "rail", "tnt", "target", "daylight", "sculk_sensor", "crafter"]) {
        "redstone"
    } else if has(&["_log", "_wood", "planks", "_stem", "hyphae", "stick", "sapling", "leaves", "bamboo"]) {
        "wood"
    } else if has(&["wheat", "carrot", "potato", "beetroot", "melon", "pumpkin", "seeds", "bread", "beef", "pork", "chicken", "mutton", "rabbit", "cod", "salmon", "apple", "sugar", "cake", "cookie", "kelp", "berries", "egg", "honey", "stew", "soup"]) {
        "food"
    } else if has(&["rotten_flesh", "bone", "string", "spider_eye", "gunpowder", "ender_pearl", "slime", "blaze", "ghast", "leather", "feather", "ink_sac", "phantom", "magma_cream", "arrow", "rabbit_hide", "shulker_shell", "prismarine_shard", "prismarine_crystals", "nautilus", "scute", "breeze_rod"]) {
        "mob drops"
    } else if has(&["netherrack", "nether_", "soul_", "basalt", "blackstone", "crimson", "warped", "glowstone", "magma_block", "shroomlight"]) {
        "nether"
    } else if has(&["end_stone", "purpur", "chorus", "end_rod", "dragon"]) {
        "end"
    } else if has(&["wool", "carpet", "concrete", "terracotta", "glass", "dye", "banner", "candle", "bed"]) {
        "colours"
    } else if has(&["stone", "cobble", "deepslate", "granite", "diorite", "andesite", "tuff", "calcite", "dirt", "gravel", "sand", "clay", "brick", "mud", "snow", "ice", "obsidian", "flint"]) {
        "stone & earth"
    } else if has(&["flower", "tulip", "rose", "dandelion", "poppy", "orchid", "allium", "bluet", "daisy", "cornflower", "lily", "fern", "grass", "vine", "moss", "dripleaf", "azalea", "mushroom", "lichen", "petals"]) {
        "plants"
    } else {
        "misc"
    }
}

struct Logical<'a> {
    parts: Vec<&'a Container>,
}

impl<'a> Logical<'a> {
    fn kind(&self) -> &str {
        &self.parts[0].kind
    }
    fn pos(&self) -> [i32; 3] {
        self.parts[0].pos
    }
    fn slots(&self) -> i64 {
        self.parts.iter().map(|c| slots_of(&c.kind)).sum()
    }
    fn items(&self) -> impl Iterator<Item = &'a mcworld::items::Item> + '_ {
        self.parts.iter().flat_map(|c| c.items.iter())
    }
}

fn is_storage(kind: &str) -> bool {
    let s = kind.trim_start_matches("minecraft:");
    s == "chest" || s == "trapped_chest" || s == "barrel" || s.ends_with("shulker_box") || s.ends_with("chest_minecart") || s.contains("chest_boat")
}

/// Pair up the two halves of double chests (two chest blocks of the same kind side by side).
fn logical(containers: &[Container]) -> Vec<Logical<'_>> {
    let mut used = vec![false; containers.len()];
    let mut by_pos: HashMap<(String, [i32; 3]), usize> = HashMap::new();
    for (i, c) in containers.iter().enumerate() {
        by_pos.insert((c.dim.clone(), c.pos), i);
    }
    let mut out = Vec::new();
    for (i, c) in containers.iter().enumerate() {
        if used[i] || !is_storage(&c.kind) {
            continue;
        }
        used[i] = true;
        let mut parts = vec![c];
        if matches!(c.kind.as_str(), "minecraft:chest" | "minecraft:trapped_chest") {
            for d in [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] {
                let p = [c.pos[0] + d[0], c.pos[1], c.pos[2] + d[2]];
                if let Some(&j) = by_pos.get(&(c.dim.clone(), p)) {
                    if !used[j] && containers[j].kind == c.kind {
                        used[j] = true;
                        parts.push(&containers[j]);
                        break;
                    }
                }
            }
        }
        out.push(Logical { parts });
    }
    out
}

pub fn report(ctx: &Ctx, assets: &Assets) -> Value {
    let Some(idx) = ctx.index.read().clone() else { return json!({ "ready": false }) };
    let groups = logical(&idx.containers);
    let mut names: HashMap<String, String> = HashMap::new();
    let mut name = |id: &str| names.entry(id.to_string()).or_insert_with(|| assets.lang.name(id)).clone();

    let mut chests = Vec::new();
    let mut item_where: BTreeMap<String, Vec<(usize, i64, i64)>> = BTreeMap::new(); // item -> (group, count, stacks)
    let (mut total_slots, mut used_slots) = (0i64, 0i64);
    let mut shulkers = Vec::new();
    for (gi, g) in groups.iter().enumerate() {
        let slots = g.slots();
        let mut used = 0i64;
        let mut per: HashMap<String, (i64, i64)> = HashMap::new(); // id -> (count, stacks)
        let mut cats: HashMap<&'static str, i64> = HashMap::new();
        for it in g.items() {
            used += 1;
            let e = per.entry(it.id.clone()).or_default();
            e.0 += it.count;
            e.1 += 1;
            *cats.entry(category(&it.id)).or_default() += 1;
            if it.id.ends_with("shulker_box") {
                let filled = it.contents.len() as i64;
                let mut inner: HashMap<String, i64> = HashMap::new();
                for x in &it.contents {
                    *inner.entry(x.id.clone()).or_default() += x.count;
                }
                let mut inner_list: Vec<(String, i64)> = inner.into_iter().collect();
                inner_list.sort_by(|a, b| b.1.cmp(&a.1));
                let kinds = inner_list.len();
                shulkers.push(json!({
                    "id": it.id, "name": it.name, "in": g.pos(), "in_kind": g.kind(), "dim": g.parts[0].dim,
                    "slots_used": filled, "kinds": kinds,
                    "contents": inner_list.iter().map(|(id, n)| json!([id, n, name(id)])).collect::<Vec<_>>(),
                    "mixed": kinds > 3,
                }));
            }
        }
        // placed shulker boxes are containers themselves
        if g.kind().ends_with("shulker_box") {
            let mut inner_list: Vec<(String, i64)> = per.iter().map(|(k, v)| (k.clone(), v.0)).collect();
            inner_list.sort_by(|a, b| b.1.cmp(&a.1));
            shulkers.push(json!({
                "id": g.kind(), "name": g.parts[0].name, "in": g.pos(), "in_kind": "placed", "dim": g.parts[0].dim,
                "slots_used": used, "kinds": per.len(),
                "contents": inner_list.iter().map(|(id, n)| json!([id, n, name(id)])).collect::<Vec<_>>(),
                "mixed": per.len() > 3,
            }));
        }
        total_slots += slots;
        used_slots += used;
        // stacks that could merge inside this chest
        let mut mergeable = 0i64;
        for (id, (count, stacks)) in &per {
            let ms = max_stack(id);
            let need = (count + ms - 1) / ms;
            if *stacks > need {
                mergeable += stacks - need;
            }
            item_where.entry(id.clone()).or_default().push((gi, *count, *stacks));
        }
        let distinct = per.len();
        let families = cats.len();
        let mut top: Vec<(String, i64)> = per.iter().map(|(k, v)| (k.clone(), v.0)).collect();
        top.sort_by(|a, b| b.1.cmp(&a.1));
        let messy = distinct >= 8 && families >= 4;
        chests.push(json!({
            "group": gi,
            "kind": g.kind(),
            "double": g.parts.len() > 1,
            "pos": g.pos(),
            "dim": g.parts[0].dim,
            "name": g.parts[0].name,
            "ids": g.parts.iter().map(|c| c.id).collect::<Vec<_>>(),
            "slots": slots,
            "used": used,
            "distinct": distinct,
            "families": cats.keys().collect::<Vec<_>>(),
            "mergeable": mergeable,
            "messy": messy,
            "top": top.iter().take(6).map(|(id, n)| json!([id, n, name(id)])).collect::<Vec<_>>(),
        }));
    }

    // items spread over several chests, where they'd fit in fewer
    let mut split = Vec::new();
    for (id, list) in &item_where {
        if list.len() < 2 || id.ends_with("shulker_box") {
            continue;
        }
        let total: i64 = list.iter().map(|x| x.1).sum();
        let ms = max_stack(id);
        let stacks_needed = (total + ms - 1) / ms;
        // the chest that already holds the most becomes its home
        let mut sorted = list.clone();
        sorted.sort_by(|a, b| b.1.cmp(&a.1));
        let home = sorted[0].0;
        let home_free = groups[home].slots() - chests[home]["used"].as_i64().unwrap_or(0);
        let elsewhere: i64 = sorted[1..].iter().map(|x| x.1).sum();
        if elsewhere == 0 {
            continue;
        }
        split.push(json!({
            "id": id,
            "name": name(id),
            "total": total,
            "chests": list.len(),
            "stacks_needed": stacks_needed,
            "home": groups[home].pos(),
            "home_dim": groups[home].parts[0].dim,
            "home_free": home_free,
            "where": sorted.iter().map(|(g, n, s)| json!({ "pos": groups[*g].pos(), "dim": groups[*g].parts[0].dim, "count": n, "stacks": s, "group": g })).collect::<Vec<_>>(),
        }));
    }
    split.sort_by(|a, b| b["chests"].as_i64().cmp(&a["chests"].as_i64()).then(b["total"].as_i64().cmp(&a["total"].as_i64())));

    // the cleanup plan: move each split item's stragglers to its home chest (largest first),
    // only while the home has room, same dimension, at most 30 steps
    let mut steps = Vec::new();
    let mut room: HashMap<usize, i64> = HashMap::new();
    for s in &split {
        let id = s["id"].as_str().unwrap_or("");
        let ms = max_stack(id);
        let w = s["where"].as_array().cloned().unwrap_or_default();
        let home_g = w[0]["group"].as_u64().unwrap_or(0) as usize;
        let free = room.entry(home_g).or_insert_with(|| groups[home_g].slots() - chests[home_g]["used"].as_i64().unwrap_or(0));
        for x in w.iter().skip(1) {
            if x["dim"] != w[0]["dim"] {
                continue;
            }
            let count = x["count"].as_i64().unwrap_or(0);
            let stacks = (count + ms - 1) / ms;
            if *free < stacks {
                continue;
            }
            *free -= stacks;
            steps.push(json!({ "take": x["pos"], "put": w[0]["pos"], "item": id, "name": s["name"], "count": count, "dim": x["dim"] }));
            if steps.len() >= 30 {
                break;
            }
        }
        if steps.len() >= 30 {
            break;
        }
    }

    let messy_n = chests.iter().filter(|c| c["messy"].as_bool().unwrap_or(false)).count();
    let mergeable_n: i64 = chests.iter().map(|c| c["mergeable"].as_i64().unwrap_or(0)).sum();
    json!({
        "ready": true,
        "summary": {
            "containers": groups.len(),
            "slots": total_slots,
            "used": used_slots,
            "free": total_slots - used_slots,
            "messy": messy_n,
            "split": split.len(),
            "mergeable": mergeable_n,
            "shulkers": shulkers.len(),
        },
        "chests": chests,
        "split": split.into_iter().take(80).collect::<Vec<_>>(),
        "shulkers": shulkers,
        "plan": steps,
        "guide": super::bridge::guide_progress(ctx),
        "names": names,
    })
}
