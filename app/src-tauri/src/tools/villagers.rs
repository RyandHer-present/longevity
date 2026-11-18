//! Villager Roster: every villager (and zombie villager) in the parts of the world you've been to,
//! with their trades, the price YOU pay (reputation discounts), what curing would save, and a trade
//! history that grows each time Longevity looks.

use super::{now, read_json, write_json, R};
use crate::Ctx;
use mcassets::Assets;
use mcworld::items::item_of;
use mcworld::nbt::{uuid_from_ints, Value as Nbt, V};
use mcworld::Dim;
use rayon::prelude::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// Gossip weights (GossipType): major_negative -5, minor_negative -1, minor_positive 1,
/// major_positive 5, trading 1. Curing adds major_positive 20 (its max since 1.20.2) and
/// minor_positive 25 (its max), so a cure is worth 125 reputation and doesn't stack.
fn reputation(gossips: &[Nbt], player: &str) -> (i64, i64, i64) {
    let (mut rep, mut major_pos, mut trading) = (0i64, 0i64, 0i64);
    for g in gossips {
        let target = g.get("Target").and_then(uuid_from_ints).unwrap_or_default();
        if !target.eq_ignore_ascii_case(player) {
            continue;
        }
        let v = g.get_i64("Value").unwrap_or(0);
        let w = match g.get_str("Type").unwrap_or("") {
            "major_negative" => -5,
            "minor_negative" => -1,
            "minor_positive" => 1,
            "major_positive" => {
                major_pos = v;
                5
            }
            "trading" => {
                trading = v;
                1
            }
            _ => 0,
        };
        rep += v * w;
    }
    (rep, major_pos, trading)
}

fn stack(v: Option<&Nbt>) -> Option<(String, i64, Vec<String>)> {
    let it = item_of(v?)?;
    Some((it.id.clone(), it.count, it.enchants.clone()))
}

/// Vanilla MerchantOffer.getCostA with the player's reputation discount applied.
fn price(base: i64, demand: i64, mult: f64, special: i64, max_stack: i64) -> i64 {
    let demand_extra = ((base * demand) as f64 * mult).floor().max(0.0) as i64;
    (base + demand_extra + special).clamp(1, max_stack.max(1))
}

pub fn scan(ctx: &Ctx) -> Vec<Nbt> {
    let mut out = Vec::new();
    for dim in Dim::all() {
        let e = ctx.explored(dim);
        let regions: HashSet<(i32, i32)> = e.seen.iter().map(|(x, z)| (x >> 5, z >> 5)).collect();
        let found: Vec<Nbt> = regions
            .par_iter()
            .flat_map(|&(rx, rz)| {
                ctx.world
                    .entities_in_region(dim, rx, rz)
                    .into_iter()
                    .filter(|en| matches!(en.get_str("id"), Some("minecraft:villager" | "minecraft:zombie_villager" | "minecraft:wandering_trader")))
                    .map(|mut en| {
                        if let Some(m) = en_mut(&mut en) {
                            m.insert("__dim".into(), Nbt::String(dim.id().to_string()));
                        }
                        en
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        out.extend(found);
    }
    out
}

fn en_mut(v: &mut Nbt) -> Option<&mut HashMap<String, Nbt>> {
    match v {
        Nbt::Compound(m) => Some(m),
        _ => None,
    }
}

pub fn roster(ctx: &Ctx, assets: &Assets) -> Value {
    let player = ctx.player_uuid.clone().unwrap_or_default();
    let mut villagers = Vec::new();
    let mut names: HashMap<String, String> = HashMap::new();
    for en in scan(ctx) {
        let id = en.get_str("id").unwrap_or("").to_string();
        let pos = en.get_list("Pos");
        let p = if pos.len() == 3 { [pos[0].f64().unwrap_or(0.0), pos[1].f64().unwrap_or(0.0), pos[2].f64().unwrap_or(0.0)] } else { [0.0; 3] };
        let vd = en.get("VillagerData");
        let profession = vd.and_then(|v| v.get_str("profession")).unwrap_or("minecraft:none").trim_start_matches("minecraft:").to_string();
        let vtype = vd.and_then(|v| v.get_str("type")).unwrap_or("minecraft:plains").trim_start_matches("minecraft:").to_string();
        let level = vd.and_then(|v| v.get_i64("level")).unwrap_or(1);
        let uuid = en.get("UUID").and_then(uuid_from_ints).unwrap_or_default();
        let (rep, major_pos, _trading) = reputation(en.get_list("Gossips"), &player);
        let cured = major_pos > 0;
        // what a cure would bring reputation to (the cure's own gossip is capped; other gossip stays)
        let rep_after_cure = if cured { rep } else { rep + 5 * 20 + 25 };
        let mut offers = Vec::new();
        for o in en.get("Offers").map(|o| o.get_list("Recipes")).unwrap_or(&[]) {
            let Some(buy) = stack(o.get("buy")) else { continue };
            let buy_b = stack(o.get("buyB"));
            let Some(sell) = stack(o.get("sell")) else { continue };
            let mult = o.get_f64("priceMultiplier").unwrap_or(0.05);
            let demand = o.get_i64("demand").unwrap_or(0);
            let ms = super::max_stack(&buy.0);
            let base = buy.1;
            let now_price = price(base, demand, mult, -((rep as f64 * mult).floor() as i64), ms);
            let cured_price = price(base, demand, mult, -((rep_after_cure as f64 * mult).floor() as i64), ms);
            for s in [&buy.0, &sell.0] {
                names.entry(s.clone()).or_insert_with(|| assets.lang.name(s));
            }
            if let Some(b) = &buy_b {
                names.entry(b.0.clone()).or_insert_with(|| assets.lang.name(&b.0));
            }
            offers.push(json!({
                "buy": [buy.0, base],
                "buyB": buy_b.as_ref().map(|b| json!([b.0, b.1])),
                "sell": [sell.0, sell.1, sell.2],
                "uses": o.get_i64("uses").unwrap_or(0),
                "max": o.get_i64("maxUses").unwrap_or(0),
                "xp": o.get_i64("xp").unwrap_or(0),
                "mult": mult,
                "demand": demand,
                "price": now_price,
                "price_cured": cured_price,
            }));
        }
        let name = en.get("CustomName").map(mcworld::nbt::text_of).filter(|s| !s.is_empty());
        villagers.push(json!({
            "uuid": uuid,
            "kind": id.trim_start_matches("minecraft:"),
            "dim": en.get_str("__dim").unwrap_or("minecraft:overworld"),
            "pos": p,
            "profession": profession,
            "type": vtype,
            "level": level,
            "xp": en.get_i64("Xp").unwrap_or(0),
            "name": name,
            "baby": en.get_i64("Age").map(|a| a < 0).unwrap_or(false),
            "reputation": rep,
            "cured": cured,
            "converting": en.get_i64("ConversionTime").map(|t| t > 0).unwrap_or(false),
            "restocks_today": en.get_i64("RestocksToday").unwrap_or(0),
            "offers": offers,
        }));
    }
    let history = update_history(ctx, &villagers);
    json!({ "villagers": villagers, "names": names, "history": history, "player": player, "t": now() })
}

/// Keep a short history per villager: a new entry whenever their level or trades change.
fn update_history(ctx: &Ctx, villagers: &[Value]) -> Value {
    let p = ctx.dir.join("villagers-history.json");
    let mut h = read_json(&p).unwrap_or(json!({}));
    let day = ctx.world.level().map(|l| l.day()).unwrap_or(0);
    let mut changed = false;
    for v in villagers {
        let uuid = v["uuid"].as_str().unwrap_or("").to_string();
        if uuid.is_empty() || v["kind"] != "villager" {
            continue;
        }
        let sig: Vec<Value> = v["offers"].as_array().cloned().unwrap_or_default().iter().map(|o| json!([o["sell"][0], o["sell"][2], o["buy"][1], o["buyB"]])).collect();
        let entry = json!({ "t": now(), "day": day, "level": v["level"], "profession": v["profession"], "trades": sig });
        let list = h.as_object_mut().unwrap().entry(uuid).or_insert(json!([]));
        let arr = list.as_array_mut().unwrap();
        let same = arr.last().map(|l| l["level"] == entry["level"] && l["trades"] == entry["trades"] && l["profession"] == entry["profession"]).unwrap_or(false);
        if !same {
            arr.push(entry);
            if arr.len() > 40 {
                arr.remove(0);
            }
            changed = true;
        }
    }
    if changed {
        let _ = write_json(&p, &h);
    }
    h
}

/// longevity-villagers.json for the in-game quick panel.
pub fn write_for_game(ctx: &Ctx, assets: &Assets) -> R<()> {
    let r = roster(ctx, assets);
    let list: Vec<Value> = r["villagers"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|v| v["kind"] == "villager")
        .map(|v| {
            let offers: Vec<Value> = v["offers"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|o| json!({ "buy": [o["buy"][0], o["price"]], "buyB": o["buyB"], "sell": o["sell"], "uses": o["uses"], "max": o["max"] }))
                .collect();
            let pos = v["pos"].as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0).floor() as i64).collect::<Vec<_>>()).unwrap_or_default();
            json!({ "uuid": v["uuid"], "pos": pos, "dim": v["dim"], "profession": v["profession"], "level": v["level"], "name": v["name"], "offers": offers })
        })
        .collect();
    write_json(&ctx.dir.join("longevity-villagers.json"), &json!({ "t": now(), "names": r["names"], "villagers": list }))
}
