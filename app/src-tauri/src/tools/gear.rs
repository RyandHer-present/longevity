//! Gear Check data: what you're wearing and holding, your hotbar/inventory/ender chest gear, the
//! gear sitting in your chests, and every enchanted book you own (for the Anvil Planner). The
//! "what's missing" analysis happens on the page, which knows the best sets.

use crate::Ctx;
use mcassets::Assets;
use mcworld::items::{item_of, items_of, Item};
use mcworld::nbt::V;
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn is_gear(id: &str) -> bool {
    let s = id.trim_start_matches("minecraft:");
    ["sword", "pickaxe", "_axe", "shovel", "_hoe", "helmet", "chestplate", "leggings", "boots", "bow", "crossbow", "trident", "shield", "elytra", "mace", "spear", "fishing_rod", "shears", "flint_and_steel", "brush", "turtle_shell", "wolf_armor", "horse_armor"]
        .iter()
        .any(|k| s.ends_with(k) || s == k.trim_start_matches('_'))
}

fn item_json(it: &Item, names: &mut HashMap<String, String>, assets: &Assets) -> Value {
    names.entry(it.id.clone()).or_insert_with(|| assets.lang.name(&it.id));
    json!({
        "id": it.id,
        "count": it.count,
        "name": it.name,
        "ench": it.ench,
        "damage": it.damage,
        "repair_cost": it.repair_cost,
        "trim": it.trim,
        "slot": it.slot,
    })
}

pub fn report(ctx: &Ctx, assets: &Assets) -> Value {
    let mut names = HashMap::new();
    let players = ctx.world.players();
    let Some((_, p)) = players.into_iter().next() else { return json!({ "ready": false }) };
    let mut equipped = serde_json::Map::new();
    if let Some(eq) = p.get("equipment").and_then(|v| v.compound()) {
        for (k, v) in eq {
            if let Some(it) = item_of(v) {
                equipped.insert(k.clone(), item_json(&it, &mut names, assets));
            }
        }
    }
    let inv = items_of(p.get_list("Inventory"));
    let selected = p.get_i64("SelectedItemSlot").unwrap_or(0);
    // older saves keep armor in Inventory slots 100-103 and offhand at -106
    for it in &inv {
        let key = match it.slot {
            Some(103) => "head",
            Some(102) => "chest",
            Some(101) => "legs",
            Some(100) => "feet",
            Some(-106) => "offhand",
            _ => continue,
        };
        equipped.entry(key.to_string()).or_insert_with(|| item_json(it, &mut names, assets));
    }
    if let Some(main) = inv.iter().find(|i| i.slot == Some(selected)) {
        equipped.insert("mainhand".into(), item_json(main, &mut names, assets));
    }
    let inventory: Vec<Value> = inv.iter().filter(|i| i.slot.map(|s| (0..36).contains(&s)).unwrap_or(false)).map(|i| item_json(i, &mut names, assets)).collect();
    let ender: Vec<Value> = items_of(p.get_list("EnderItems")).iter().map(|i| item_json(i, &mut names, assets)).collect();

    let mut stored = Vec::new();
    let mut books = Vec::new();
    if let Some(idx) = ctx.index.read().clone() {
        for c in &idx.containers {
            if c.kind.starts_with("player:") {
                continue;
            }
            for (it, depth) in mcworld::items::flatten(&c.items) {
                if is_gear(&it.id) {
                    let mut v = item_json(it, &mut names, assets);
                    v["where"] = json!({ "pos": c.pos, "dim": c.dim, "kind": c.kind, "nested": depth > 0 });
                    stored.push(v);
                } else if it.id == "minecraft:enchanted_book" && !it.ench.is_empty() {
                    books.push(json!({ "ench": it.ench, "count": it.count, "repair_cost": it.repair_cost, "where": { "pos": c.pos, "dim": c.dim, "kind": c.kind } }));
                }
            }
        }
    }
    for it in inv.iter().chain(items_of(p.get_list("EnderItems")).iter()) {
        if it.id == "minecraft:enchanted_book" && !it.ench.is_empty() {
            books.push(json!({ "ench": it.ench, "count": it.count, "repair_cost": it.repair_cost, "where": { "kind": "player" } }));
        }
    }
    json!({
        "ready": true,
        "player": ctx.player_name,
        "uuid": ctx.player_uuid,
        "xp_level": p.get_i64("XpLevel").unwrap_or(0),
        "equipped": equipped,
        "inventory": inventory,
        "selected": selected,
        "ender": ender,
        "stored": stored,
        "books": books,
        "names": names,
    })
}
