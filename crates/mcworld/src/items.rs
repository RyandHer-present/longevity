//! Items inside containers, entities and players (26.x item format: id, count, components).

use crate::nbt::{V, Value, text_of};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct Item {
    pub id: String,
    pub count: i64,
    /// Custom name given on an anvil, if any.
    pub name: Option<String>,
    /// e.g. ["sharpness 5", "mending"]
    pub enchants: Vec<String>,
    pub damage: Option<i64>,
    /// Items stored inside this item (shulker box contents, bundle contents).
    pub contents: Vec<Item>,
    pub slot: Option<i64>,
    /// Armor trim: (pattern, material), e.g. ("minecraft:silence", "minecraft:netherite").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trim: Option<(String, String)>,
    /// Potion / tipped arrow contents, e.g. "minecraft:long_swiftness".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub potion: Option<String>,
    /// Anvil prior-work penalty (the repair_cost component).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repair_cost: Option<i64>,
    /// Enchantments with numeric levels (id, level), enchanted books included.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ench: Vec<(String, i64)>,
}

impl Item {
    pub fn short_id(&self) -> &str {
        self.id.strip_prefix("minecraft:").unwrap_or(&self.id)
    }
}

/// Parse one item compound. Accepts both the 1.20.5+ format (id/count/components) and older (id/Count/tag).
pub fn item_of(v: &Value) -> Option<Item> {
    let id = v.get_str("id")?.to_string();
    if id == "minecraft:air" {
        return None;
    }
    let count = v.get_i64("count").or_else(|| v.get_i64("Count")).unwrap_or(1);
    let slot = v.get_i64("Slot").or_else(|| v.get_i64("slot"));
    let mut item = Item { id, count, name: None, enchants: Vec::new(), damage: None, contents: Vec::new(), slot, trim: None, potion: None, repair_cost: None, ench: Vec::new() };
    if let Some(c) = v.get("components") {
        if let Some(n) = c.get("minecraft:custom_name") {
            let t = text_of(n);
            if !t.is_empty() {
                item.name = Some(t);
            }
        }
        item.damage = c.get_i64("minecraft:damage");
        item.repair_cost = c.get_i64("minecraft:repair_cost");
        if let Some(t) = c.get("minecraft:trim") {
            let pat = t.get_str("pattern").map(str::to_string);
            let mat = t.get_str("material").map(str::to_string);
            if let (Some(p), Some(m)) = (pat, mat) {
                item.trim = Some((p, m));
            }
        }
        if let Some(pc) = c.get("minecraft:potion_contents") {
            item.potion = pc.get_str("potion").map(str::to_string).or_else(|| pc.str().map(str::to_string));
        }
        for key in ["minecraft:enchantments", "minecraft:stored_enchantments"] {
            if let Some(e) = c.get(key) {
                let levels = e.get("levels").unwrap_or(e);
                if let Some(m) = levels.compound() {
                    for (k, lv) in m.iter() {
                        item.ench.push((k.clone(), lv.i64().unwrap_or(1)));
                    }
                    let mut list: Vec<String> = m
                        .iter()
                        .map(|(k, lv)| {
                            let k = k.strip_prefix("minecraft:").unwrap_or(k).replace('_', " ");
                            let l = lv.i64().unwrap_or(1);
                            if l > 1 { format!("{k} {l}") } else { k }
                        })
                        .collect();
                    list.sort();
                    item.enchants.extend(list);
                }
            }
        }
        // shulker boxes and other block items holding items
        for entry in c.get_list("minecraft:container") {
            if let Some(inner) = entry.get("item").and_then(item_of) {
                let mut inner = inner;
                inner.slot = entry.get_i64("slot");
                item.contents.push(inner);
            }
        }
        for entry in c.get_list("minecraft:bundle_contents") {
            if let Some(inner) = item_of(entry) {
                item.contents.push(inner);
            }
        }
    }
    // pre-1.20.5 shulker format
    if let Some(items) = v.path(&["tag", "BlockEntityTag", "Items"]).and_then(|l| l.list()) {
        item.contents.extend(items.iter().filter_map(item_of));
    }
    Some(item)
}

pub fn items_of(list: &[Value]) -> Vec<Item> {
    list.iter().filter_map(item_of).collect()
}

/// Every item including nested contents, flattened, with how deep it sits (0 = directly in the container).
pub fn flatten(items: &[Item]) -> Vec<(&Item, usize)> {
    let mut out = Vec::new();
    fn walk<'a>(items: &'a [Item], depth: usize, out: &mut Vec<(&'a Item, usize)>) {
        for it in items {
            out.push((it, depth));
            walk(&it.contents, depth + 1, out);
        }
    }
    walk(items, 0, &mut out);
    out
}
