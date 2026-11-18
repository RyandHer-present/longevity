//! Rare looks of ordinary mobs (pink sheep, brown pandas, jockeys...) for the Atlas Dex.

use crate::nbt::{Value, V};

/// (key, base mob id, display name, rarity), in Dex order.
pub const RARE_VARIANTS: &[(&str, &str, &str, &str)] = &[
    ("pink_sheep", "sheep", "Pink Sheep", "epic"),
    ("brown_panda", "panda", "Brown Panda", "epic"),
    ("blue_axolotl", "axolotl", "Blue Axolotl", "legendary"),
    ("brown_mooshroom", "mooshroom", "Brown Mooshroom", "epic"),
    ("charged_creeper", "creeper", "Charged Creeper", "epic"),
    ("chicken_jockey", "chicken", "Chicken Jockey", "legendary"),
    ("spider_jockey", "spider", "Spider Jockey", "epic"),
    ("skeleton_horseman", "skeleton_horse", "Skeleton Horseman", "epic"),
    ("strider_jockey", "strider", "Strider Jockey", "rare"),
    ("hoglin_jockey", "hoglin", "Hoglin Jockey", "epic"),
    ("snowy_wolf", "wolf", "Snowy Wolf", "rare"),
    ("black_cat", "cat", "Black Cat", "rare"),
    ("snow_fox", "fox", "Snow Fox", "uncommon"),
    ("patrol_captain", "pillager", "Patrol Captain", "uncommon"),
    ("trident_drowned", "drowned", "Trident Drowned", "rare"),
];

fn strip(s: &str) -> &str {
    s.trim_start_matches("minecraft:")
}

fn riders(en: &Value) -> impl Iterator<Item = &str> {
    en.get_list("Passengers").iter().filter_map(|p| p.get_str("id")).map(strip)
}

fn main_hand(en: &Value) -> Option<&str> {
    en.path(&["equipment", "mainhand", "id"])
        .and_then(|v| v.str())
        .or_else(|| en.get_list("HandItems").first().and_then(|i| i.get_str("id")))
        .map(strip)
}

/// The rare variant this saved entity is, if any.
pub fn rare_variant(en: &Value) -> Option<&'static str> {
    let id = strip(en.get_str("id")?);
    let var = en.get_str("variant").or_else(|| en.get_str("Variant")).map(strip);
    let flag = |k: &str| en.get_i64(k).map(|b| b != 0).unwrap_or(false);
    match id {
        "sheep" => (en.get_i64("Color") == Some(6)).then_some("pink_sheep"),
        "panda" => (en.get_str("MainGene") == Some("brown") && en.get_str("HiddenGene") == Some("brown")).then_some("brown_panda"),
        "axolotl" => (en.get_i64("Variant") == Some(4) || var == Some("blue")).then_some("blue_axolotl"),
        "mooshroom" => (en.get_str("Type").map(strip) == Some("brown") || var == Some("brown")).then_some("brown_mooshroom"),
        "creeper" => flag("powered").then_some("charged_creeper"),
        "chicken" => (flag("IsChickenJockey") || riders(en).any(|r| r.contains("zombie") || r == "husk" || r == "drowned" || r.contains("piglin"))).then_some("chicken_jockey"),
        "spider" | "cave_spider" => riders(en).any(|r| r.contains("skeleton") || r == "stray" || r == "bogged" || r == "parched").then_some("spider_jockey"),
        "skeleton_horse" => (flag("SkeletonTrap") || riders(en).any(|r| r == "skeleton")).then_some("skeleton_horseman"),
        "strider" => riders(en).any(|r| r == "zombified_piglin").then_some("strider_jockey"),
        "hoglin" => riders(en).any(|r| r == "piglin").then_some("hoglin_jockey"),
        "wolf" => (var == Some("snowy")).then_some("snowy_wolf"),
        "cat" => (var == Some("all_black") || en.get_i64("CatType") == Some(10)).then_some("black_cat"),
        "fox" => (en.get_str("Type") == Some("snow") || var == Some("snow")).then_some("snow_fox"),
        "pillager" | "vindicator" => flag("PatrolLeader").then_some("patrol_captain"),
        "drowned" => (main_hand(en) == Some("trident")).then_some("trident_drowned"),
        _ => None,
    }
}
